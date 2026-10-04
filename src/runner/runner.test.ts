import { mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCancel } from "../slack/control.js";
import { AUTH, DM, TEAM, USER, capturingLogger } from "../slack/test-fixtures.js";
import { getRun, listPendingMessages, listRunEvents, listRunsByState, transitionRun, type Run, type Store } from "../store/index.js";
import { fakeClock, fakeIds, open, tempDbPath, tempDir } from "../store/test-utils.js";
import { createRunner, type BuildInvocation } from "./runner.js";
import { createNodeLauncher } from "./launcher.js";
import { MAX_OUTPUT_BYTES } from "./limits.js";
import type { Launcher } from "./process.js";
import { OUTPUT_CANARY, PROMPT_CANARY, alive, fileExists, mockLauncher, queueRun, writeFakeCli, type MockLauncherOptions } from "./test-utils.js";

const PARENT_ENV = {
  PATH: "/usr/bin",
  HOME: "/home/me",
  SLACK_BOT_TOKEN: "xoxb-CANARY-parent",
  SLACK_APP_TOKEN: "xapp-CANARY-parent",
  DATABASE_PATH: "/CANARY/db",
};

const buildInvocation: BuildInvocation = ({ prompt }) => ({ args: ["--fake-flag"], stdin: prompt });

function setup(options: { launcher?: MockLauncherOptions; timeoutMs?: number; maxOutputBytes?: number; real?: boolean; mode?: string } = {}) {
  const store = open(tempDbPath(), { now: fakeClock(), randomId: fakeIds() });
  const repoRoot = realpathSync(tempDir());
  const { log, entries } = capturingLogger();
  const mock = mockLauncher(options.launcher);
  const dir = tempDir();
  const marker = join(dir, "marker");
  const cli = options.real ? writeFakeCli(join(dir, "bin")) : "/fake/codex";
  const launcher: Launcher = options.real ? createNodeLauncher({ killGraceMs: 150 }) : mock.launcher;
  const builder: BuildInvocation = options.real ? ({ prompt }) => ({ args: [options.mode ?? "echo", marker], stdin: prompt }) : buildInvocation;
  const runner = createRunner({
    store,
    auth: AUTH,
    repoRoot,
    codexBin: cli,
    timeoutMs: options.timeoutMs ?? 10_000,
    launcher,
    buildInvocation: builder,
    log,
    parentEnv: PARENT_ENV,
    pollMs: 5,
    ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
  });
  return { store, repoRoot, entries, mock, runner, marker, dir };
}

const outbox = (store: Store, runId: string) =>
  store.db.prepare("SELECT kind, body, status FROM outbox_messages WHERE run_id = ? ORDER BY id").all(runId) as { kind: string; body: string; status: string }[];
const states = (store: Store, run: Run): string[] => listRunEvents(store, run).map((e) => `${e.fromState}>${e.toState}`);

describe("a successful run", () => {
  it("moves queued > running > completed through the state machine and posts the output to the run's own thread", async () => {
    const { store, runner, mock, repoRoot } = setup({ launcher: { output: `${OUTPUT_CANARY}\n` } });
    const run = queueRun(store);
    expect(await runner.tick()).toBe("ran");

    expect(getRun(store, run)?.state).toBe("completed");
    expect(states(store, run)).toEqual(["null>received", "received>validated", "validated>queued", "queued>running", "running>completed"]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toMatchObject({ command: "/fake/codex", args: ["--fake-flag"], cwd: repoRoot, stdin: PROMPT_CANARY });

    const pending = listPendingMessages(store);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.body).toBe(`Run ${run.id} completed.\n\n${OUTPUT_CANARY}`);
    expect(pending[0]?.destination).toEqual({ teamId: TEAM, channelId: DM, threadTs: run.rootThreadTs });
  });

  it("gives the child a scrubbed environment even when the parent holds secrets", async () => {
    const { store, runner, mock } = setup();
    queueRun(store);
    await runner.tick();
    expect(mock.calls[0]?.env).toEqual({ PATH: "/usr/bin", HOME: "/home/me" });
  });

  it("reports an empty result plainly", async () => {
    const { store, runner } = setup({ launcher: { output: "  \n" } });
    const run = queueRun(store);
    await runner.tick();
    expect(outbox(store, run.id)[0]?.body).toBe(`Run ${run.id} completed with no output.`);
  });
});

describe("failures", () => {
  it("a non-zero exit fails the run with a fixed reason and the partial output", async () => {
    const { store, runner } = setup({ launcher: { output: "partial\n", exitCode: 1 } });
    const run = queueRun(store);
    await runner.tick();
    expect(getRun(store, run)?.state).toBe("failed");
    expect(outbox(store, run.id)[0]?.body).toBe(`Run ${run.id} failed: the provider exited with an error.\n\nOutput before it stopped:\npartial`);
  });

  it("a timeout kills the child and fails the run", async () => {
    const { store, runner, mock } = setup({ launcher: { hold: new Promise(() => {}) }, timeoutMs: 30 });
    const run = queueRun(store);
    await runner.tick();
    expect(mock.state.kills).toBe(1);
    expect(getRun(store, run)?.state).toBe("failed");
    expect(outbox(store, run.id)[0]?.body).toContain("it ran out of time");
  });

  it("an output flood is cut at the cap, the child is killed, and the partial result still fits the outbox", async () => {
    const line = `${"a".repeat(1500)}\n`; // the packing worst case: one line per outbox part
    const { store, runner, mock } = setup({ launcher: { output: line.repeat(200) } });
    const run = queueRun(store);
    await runner.tick();
    expect(mock.state.kills).toBe(1);
    expect(getRun(store, run)?.state).toBe("failed");
    const messages = outbox(store, run.id);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.length).toBeLessThanOrEqual(20);
    expect(messages[0]?.body).toContain("its output was too long and was cut off");
    const total = messages.reduce((sum, m) => sum + m.body.length, 0);
    expect(total).toBeLessThan(MAX_OUTPUT_BYTES + 200);
  });

  it("a launcher that throws fails the run without leaking the error text", async () => {
    const store = open(tempDbPath(), { now: fakeClock(), randomId: fakeIds() });
    const { log, entries } = capturingLogger();
    const runner = createRunner({
      store, auth: AUTH, repoRoot: realpathSync(tempDir()), codexBin: "/fake/codex", timeoutMs: 1000,
      launcher: () => { throw new Error("ENOENT /Users/me/SECRET-PATH-CANARY"); },
      buildInvocation, log, parentEnv: PARENT_ENV, pollMs: 5,
    });
    const run = queueRun(store);
    await runner.tick();
    expect(getRun(store, run)?.state).toBe("failed");
    expect(outbox(store, run.id)[0]?.body).toBe(`Run ${run.id} failed: the provider could not be started.`);
    expect(JSON.stringify(entries) + JSON.stringify(outbox(store, run.id))).not.toContain("CANARY");
  });

  it("an invocation that cannot be built fails the run before anything starts", async () => {
    const store = open(tempDbPath(), { now: fakeClock(), randomId: fakeIds() });
    const mock = mockLauncher();
    const { log } = capturingLogger();
    const runner = createRunner({
      store, auth: AUTH, repoRoot: realpathSync(tempDir()), codexBin: "/fake/codex", timeoutMs: 1000, launcher: mock.launcher,
      buildInvocation: () => { throw new Error("bad"); }, log, parentEnv: PARENT_ENV, pollMs: 5,
    });
    const run = queueRun(store);
    await runner.tick();
    expect(mock.calls).toHaveLength(0);
    expect(getRun(store, run)?.state).toBe("failed");
  });
});

describe("the provider is never started", () => {
  it.each([
    ["a different user", { userId: "U0BBBBBBB" }],
    ["a different workspace", { teamId: "T0BBBBBBB" }],
    ["a channel that is not allowlisted", { channelId: "C0ZZZZZZZ" }],
  ])("for a stored run from %s: failed with no message sent", async (_name, overrides) => {
    const { store, runner, mock } = setup({ launcher: { output: "x" } });
    const run = queueRun(store, overrides);
    await runner.tick();
    expect(mock.calls).toHaveLength(0);
    expect(getRun(store, run)?.state).toBe("failed");
    expect(outbox(store, run.id)).toEqual([]);
  });

  it.each(["claude", "auto"] as const)("for a /%s run: refused with a fixed reason, never routed", async (provider) => {
    const { store, runner, mock } = setup();
    const run = queueRun(store, { provider });
    await runner.tick();
    expect(mock.calls).toHaveLength(0);
    expect(getRun(store, run)?.state).toBe("failed");
    expect(outbox(store, run.id)[0]?.body).toBe(
      `Run ${run.id} failed: only /codex runs are supported in this version. Start a new top-level message with /codex.`,
    );
  });

  it("for runs that are not queued (received, validated, running, cancelled, completed, failed, awaiting approval)", async () => {
    const { store, runner, mock } = setup();
    const make = (steps: ("validated" | "queued" | "running" | "cancelled" | "completed" | "failed" | "awaiting_approval")[]): Run => {
      const run = queueRun(store);
      // queueRun leaves it queued; build the other states from a fresh queued run by walking onward.
      let from: Run["state"] = "queued";
      for (const to of steps) {
        expect(transitionRun(store, run, from, to).ok).toBe(true);
        from = to;
      }
      return run;
    };
    const runs = [make(["running"]), make(["cancelled"]), make(["running", "completed"]), make(["failed"]), make(["running", "awaiting_approval"])];
    // received and validated runs: create without queueing.
    const early = queueRun(store);
    expect(transitionRun(store, early, "queued", "cancelled").ok).toBe(true);
    expect(await runner.tick()).toBe("idle");
    expect(mock.calls).toHaveLength(0);
    expect(runs.map((r) => getRun(store, r)?.state)).toEqual(["running", "cancelled", "completed", "failed", "awaiting_approval"]);
  });

  it("when the run is cancelled between being picked and being started (compare-and-swap loses)", async () => {
    const store = open(tempDbPath(), { now: fakeClock(), randomId: fakeIds() });
    const mock = mockLauncher({ output: "x" });
    const { log, entries } = capturingLogger();
    const run = queueRun(store);
    const runner = createRunner({
      store, auth: AUTH, repoRoot: realpathSync(tempDir()), codexBin: "/fake/codex", timeoutMs: 1000, launcher: mock.launcher,
      buildInvocation: (input) => {
        applyCancel(store, run); // lands after the runner chose this run, before it moves it to running
        return buildInvocation(input);
      },
      log, parentEnv: PARENT_ENV, pollMs: 5,
    });
    await runner.tick();
    expect(mock.calls).toHaveLength(0);
    expect(getRun(store, run)?.state).toBe("cancelled");
    expect(entries.map((e) => e.code)).toContain("run_start_refused:stale_state");
    expect(outbox(store, run.id).map((m) => m.kind)).toEqual(["cancel_ack"]);
  });

  it("when the repository root was swapped for something else after startup", async () => {
    const { store, runner, mock, repoRoot } = setup();
    const run = queueRun(store);
    rmSync(repoRoot, { recursive: true });
    await runner.tick();
    expect(mock.calls).toHaveLength(0);
    expect(getRun(store, run)?.state).toBe("failed");
    expect(outbox(store, run.id)[0]?.body).toContain("repository folder changed");
  });
});

describe("one run at a time", () => {
  it("a second tick while one is running starts nothing, and queued runs execute strictly in order", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { store, runner, mock } = setup({ launcher: { hold, output: "done" } });
    const first = queueRun(store);
    const second = queueRun(store);
    const third = queueRun(store);

    const running = runner.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(await runner.tick()).toBe("busy");
    expect(await runner.tick()).toBe("busy");
    expect(mock.calls).toHaveLength(1);
    expect(getRun(store, first)?.state).toBe("running");
    expect(getRun(store, second)?.state).toBe("queued");

    release();
    await running;
    expect(mock.state.maxActive).toBe(1);
    expect(mock.calls).toHaveLength(3);
    expect([first, second, third].map((r) => getRun(store, r)?.state)).toEqual(["completed", "completed", "completed"]);
  });
});

describe("overlapping tick requests", () => {
  it("every run queued while ticks overlap is processed, with no further poke", async () => {
    const { store, runner } = setup({ launcher: { output: "ok" } });
    const results: Promise<string>[] = [];
    for (let i = 0; i < 40; i++) {
      queueRun(store);
      results.push(runner.tick());
      for (let step = 0; step < i % 7; step++) await Promise.resolve(); // stagger against the microtask boundaries of a pass
    }
    await Promise.all(results);
    expect(listRunsByState(store, "queued")).toEqual([]);
    expect(listRunsByState(store, "completed", 100).length).toBeGreaterThan(0);
  });
});

describe("cancellation (invariant 8)", () => {
  it("a /cancel while the child runs kills it, and nothing but the one acknowledgement is ever queued", async () => {
    const { store, runner, mock, entries } = setup({ launcher: { hold: new Promise(() => {}), output: OUTPUT_CANARY } });
    const run = queueRun(store);
    const running = runner.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(getRun(store, run)?.state).toBe("running");

    expect(applyCancel(store, run)).toBe("cancelled");
    await running;

    expect(mock.state.kills).toBe(1);
    expect(getRun(store, run)?.state).toBe("cancelled");
    expect(outbox(store, run.id).map((m) => [m.kind, m.status])).toEqual([["cancel_ack", "pending"]]);
    expect(entries.map((e) => e.code)).toContain("run_killed_cancelled");

    // Later work for this run is refused by the store, and a further tick does nothing.
    expect(await runner.tick()).toBe("idle");
    expect(listPendingMessages(store).map((m) => m.kind)).toEqual(["cancel_ack"]);
  });

  it("a result that was already queued when the cancel lands is failed by the store, never delivered", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { store, runner } = setup({ launcher: { hold, output: OUTPUT_CANARY } });
    const run = queueRun(store);
    const running = runner.tick();
    await new Promise((r) => setTimeout(r, 20));
    release(); // the child finishes...
    applyCancel(store, run); // ...and the cancel is recorded in the same moment
    await running;
    const kinds = outbox(store, run.id).filter((m) => m.status === "pending").map((m) => m.kind);
    expect(kinds).toEqual(["cancel_ack"]);
    expect(["cancelled", "completed"]).toContain(getRun(store, run)?.state);
  });

  it("stop() kills the child and fails the run as a shutdown", async () => {
    const { store, runner, mock } = setup({ launcher: { hold: new Promise(() => {}) } });
    const run = queueRun(store);
    const running = runner.tick();
    await new Promise((r) => setTimeout(r, 20));
    await runner.stop();
    await running;
    expect(mock.state.kills).toBe(1);
    expect(getRun(store, run)?.state).toBe("failed");
    expect(outbox(store, run.id)[0]?.body).toContain("shut down");
    expect(await runner.tick()).toBe("stopped");
  });
});

describe("crash recovery", () => {
  it("a run left in `running` by a previous process is failed, never re-executed", async () => {
    const { store, runner, mock } = setup({ launcher: { output: "should not run" } });
    const run = queueRun(store);
    expect(transitionRun(store, run, "queued", "running").ok).toBe(true);

    expect(runner.recoverStale()).toBe(1);
    expect(await runner.tick()).toBe("idle");

    expect(mock.calls).toHaveLength(0);
    expect(getRun(store, run)?.state).toBe("failed");
    expect(outbox(store, run.id)[0]?.body).toBe(`Run ${run.id} failed: the bridge restarted while it was running. It was not run again.`);
    expect(runner.recoverStale()).toBe(0);
  });

  it("a stale run that is not on the allowlist is failed silently", async () => {
    const { store, runner } = setup();
    const run = queueRun(store, { userId: "U0BBBBBBB" });
    transitionRun(store, run, "queued", "running");
    expect(runner.recoverStale()).toBe(1);
    expect(outbox(store, run.id)).toEqual([]);
  });
});

describe("redaction", () => {
  it("the prompt and the child's output appear in no log entry and no run event; the prompt is never sent to Slack", async () => {
    const { store, runner, entries } = setup({ launcher: { output: OUTPUT_CANARY, exitCode: 0 } });
    const ok = queueRun(store);
    const failing = setup({ launcher: { output: OUTPUT_CANARY, exitCode: 9 } });
    const bad = queueRun(failing.store);
    await runner.tick();
    await failing.runner.tick();

    for (const [s, r, e] of [[store, ok, entries], [failing.store, bad, failing.entries]] as const) {
      const logs = JSON.stringify(e);
      const events = JSON.stringify(s.db.prepare("SELECT * FROM run_events").all());
      const messages = JSON.stringify(outbox(s, r.id));
      for (const secret of [PROMPT_CANARY, OUTPUT_CANARY, "CANARY-parent", "xoxb-", "xapp-"]) {
        expect(logs).not.toContain(secret);
        expect(events).not.toContain(secret);
      }
      expect(messages).not.toContain(PROMPT_CANARY);
      expect(messages).toContain(OUTPUT_CANARY); // the result is meant to reach the thread
      expect(e.every((entry) => /^[a-z_]+(:[a-z_]+)?$/.test(entry.code))).toBe(true);
    }
  });
});

describe("with the real launcher and a fake CLI", () => {
  it("runs end to end: stdin in, output posted, completed", async () => {
    const { store, runner, marker } = setup({ real: true, mode: "echo" });
    const run = queueRun(store);
    await runner.tick();
    expect(getRun(store, run)?.state).toBe("completed");
    expect(outbox(store, run.id)[0]?.body).toContain(`${OUTPUT_CANARY} stdin=${PROMPT_CANARY.length}`);
    expect(readFileSync(marker, "utf8").match(/invoked/g)).toHaveLength(1);
  });

  it("/cancel terminates the real process group and nothing further is posted", async () => {
    const { store, runner, marker } = setup({ real: true, mode: "tree" });
    const run = queueRun(store);
    const running = runner.tick();
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (fileExists(`${marker}.child`)) { clearInterval(poll); resolve(); }
        else if (Date.now() - started > 5_000) { clearInterval(poll); reject(new Error("child never started")); }
      }, 10);
    });
    const parent = Number(readFileSync(`${marker}.pid`, "utf8"));
    const grandchild = Number(readFileSync(`${marker}.child`, "utf8"));
    expect(alive(parent) && alive(grandchild)).toBe(true);

    applyCancel(store, run);
    await running;
    await new Promise((r) => setTimeout(r, 400));
    expect(alive(parent)).toBe(false);
    expect(alive(grandchild)).toBe(false);
    expect(getRun(store, run)?.state).toBe("cancelled");
    expect(outbox(store, run.id).map((m) => m.kind)).toEqual(["cancel_ack"]);
  });
});

// Sanity: the helper used above really starts from `queued` in the configured binding.
describe("test helpers", () => {
  it("queueRun binds to the allowlisted user and DM by default", () => {
    const store = open(tempDbPath(), { now: fakeClock(), randomId: fakeIds() });
    const run = queueRun(store);
    expect([run.teamId, run.userId, run.channelId, run.state]).toEqual([TEAM, USER, DM, "queued"]);
    mkdirSync(tempDir(), { recursive: true });
  });
});
