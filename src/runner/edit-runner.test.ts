import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTH, capturingLogger } from "../slack/test-fixtures.js";
import { getRun, getWorktree, listRunEvents, transitionRun, type Store } from "../store/index.js";
import { BINDING, editRunQueuedWrite, fakeClock, fakeIds, open, tempDbPath } from "../store/test-utils.js";
import { buildCodexInvocation, buildCodexWriteInvocation } from "./argv.js";
import { createGit } from "./git.js";
import { createNodeLauncher } from "./launcher.js";
import type { Launcher } from "./process.js";
import { createRunner, type BuildWriteInvocation, type RunnerEditDeps } from "./runner.js";
import { GIT_BIN, alive, gitAvailable, makeRepo, mockLauncher, plainGit, queueRun, writeCanary, writeFakeCli } from "./test-utils.js";
import { createWorktree } from "./worktree.js";
import { worktreePathFor } from "./worktree-names.js";

const RUN_ID = "run-aaa1";
const PARENT_ENV = { PATH: "/usr/bin", HOME: "/home/me", SLACK_BOT_TOKEN: "xoxb-CANARY-parent", DATABASE_PATH: "/CANARY/db" };

type Codex = { kind: "mock"; output?: string; exitCode?: number; hold?: Promise<void> } | { kind: "real"; mode: string };

async function setup(codex: Codex = { kind: "mock", output: "I fixed the typo.\n" }, options: { timeoutMs?: number; channelIds?: string[]; edit?: boolean; approve?: boolean; arg?: (base: string) => string } = {}) {
  const fx = await makeRepo();
  const worktreeRoot = join(fx.base, "worktrees");
  mkdirSync(worktreeRoot, { mode: 0o700 });
  const marker = join(fx.base, "marker");
  const store = open(tempDbPath(), { now: fakeClock(), randomId: fakeIds() });
  const realLauncher = createNodeLauncher({ killGraceMs: 150 });
  const codexMock = mockLauncher(codex.kind === "mock" ? codex : {});
  const codexBin = codex.kind === "real" ? writeFakeCli(join(fx.base, "bin")) : "/fake/codex";
  // git always runs for real; the provider is either a mock (to inspect how it was started) or a real fake CLI.
  const launcher: Launcher = (spec, onStdout) => (spec.command === GIT_BIN || codex.kind === "real" ? realLauncher(spec, onStdout) : codexMock.launcher(spec, onStdout));
  const buildInvocation: BuildWriteInvocation = codex.kind === "real" ? ({ prompt }) => ({ args: [codex.mode, options.arg ? options.arg(fx.base) : marker], stdin: prompt }) : buildCodexWriteInvocation;
  const edit: RunnerEditDeps = {
    git: createGit({ launcher: realLauncher, gitBin: GIT_BIN, cwd: worktreeRoot }),
    worktreeRoot,
    maxRetained: 5,
    timeoutMs: options.timeoutMs ?? 20_000,
    channelIds: new Set(options.channelIds ?? [BINDING.channelId]),
    buildInvocation,
  };
  const { log, entries } = capturingLogger();
  const runner = createRunner({
    store, auth: AUTH, repoRoot: fx.repo, codexBin, timeoutMs: 10_000, launcher, buildInvocation: buildCodexInvocation,
    log, parentEnv: PARENT_ENV, pollMs: 10, ...(options.edit === false ? {} : { edit }),
  });
  if (options.approve !== false) editRunQueuedWrite(store, { provider: "codex" }, { baseSha: fx.sha, repoRoot: fx.repo });
  const path = worktreePathFor(worktreeRoot, RUN_ID);
  return { ...fx, worktreeRoot, store, runner, codexMock, codexBin, marker, path, entries, launcher };
}

const messages = (store: Store, runId = RUN_ID): string[] =>
  store.db.prepare("SELECT body FROM outbox_messages WHERE run_id = ? ORDER BY id").all(runId).map((r) => String(r["body"])).filter((b) => b !== "approval request");
const states = (store: Store): string[] => listRunEvents(store, BINDING).map((e) => `${e.fromState}>${e.toState}`);
const stateOf = (store: Store) => getRun(store, BINDING)?.state;

describe.skipIf(!gitAvailable)("an approved edit run", () => {
  it("runs a fresh Codex in its own worktree with the workspace-write sandbox, then posts a bridge-computed summary", async () => {
    const s = await setup({ kind: "real", mode: "write" });
    expect(await s.runner.tick()).toBe("ran");

    expect(stateOf(s.store)).toBe("completed");
    expect(states(s.store).slice(-2)).toEqual(["queued_write>running_write", "running_write>completed"]);
    // The agent's edits are in the worktree, and the owner's own checkout is untouched.
    expect(readFileSync(join(s.path, "new-file.txt"), "utf8")).toBe("made by the agent\n");
    expect((await plainGit(s.repo, ["status", "--porcelain"])).trim()).toBe("");
    expect(readFileSync(join(s.repo, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");

    const [body] = messages(s.store);
    expect(body).toContain(`Run ${RUN_ID} finished. Nothing was committed or pushed.`);
    expect(body).toContain("M a.txt (+1 -0)");
    expect(body).toContain("A new-file.txt (new file)");
    expect(body).toContain("2 file(s), +1 -0");
    expect(body).toContain(`Folder: ${s.path}`);
    expect(body).toContain(`Branch: threadrunner/${RUN_ID}`);
    expect(body).toContain(`Started from commit: ${s.sha}`);
    expect(body).toContain("Reported by the agent, not verified:\nI added new-file.txt and edited a.txt. Tests pass.");
    // No contents or hunks.
    expect(body).not.toContain("made by the agent");
    expect(body).not.toContain("agent line");
    // Nothing was committed.
    expect((await plainGit(s.repo, ["log", "--all", "--oneline"])).trim().split("\n")).toHaveLength(1);
  });

  it("starts the provider exactly as designed: sandbox, working root, prompt on stdin, scrubbed environment", async () => {
    const s = await setup();
    await s.runner.tick();
    expect(s.codexMock.calls).toHaveLength(1);
    const call = s.codexMock.calls[0];
    expect(call).toMatchObject({
      command: "/fake/codex",
      cwd: s.path,
      args: ["exec", "--sandbox", "workspace-write", "--cd", s.path, "--ephemeral", "--ignore-user-config", "--ignore-rules", "--color", "never", "-"],
      env: { PATH: "/usr/bin", HOME: "/home/me" },
    });
    expect(call?.stdin).toContain("PROMPT-CANARY");
    expect(getWorktree(s.store, RUN_ID)).toMatchObject({ path: s.path, baseSha: s.sha });
    expect(stateOf(s.store)).toBe("completed");
  });

  it("reports the agent's message as unverified, capped, and with no markup the sender would not escape", async () => {
    const s = await setup({ kind: "mock", output: `<!channel> all tests pass ${"x".repeat(9000)}` });
    await s.runner.tick();
    const body = messages(s.store).join("");
    expect(body).toContain("<!channel> all tests pass");
    expect(body).toContain("...(cut off)");
    expect(body?.length ?? 0).toBeLessThan(9500);
  });

  it("a failing agent fails the run with a fixed reason and the number of files already changed; the worktree is kept", async () => {
    const s = await setup({ kind: "real", mode: "exit3" });
    await s.runner.tick();
    expect(stateOf(s.store)).toBe("failed");
    expect(messages(s.store)).toEqual([`Run ${RUN_ID} failed: the provider exited with an error.\n0 file(s) had changed when it stopped.\nThe worktree was kept for inspection: ${s.path}`]);
    expect(existsSync(s.path)).toBe(true);
  });

  it("a timeout kills the agent and fails the run", async () => {
    const s = await setup({ kind: "real", mode: "sleep" }, { timeoutMs: 300 });
    await s.runner.tick();
    expect(stateOf(s.store)).toBe("failed");
    expect(messages(s.store)[0]).toContain("it ran out of time");
    expect(existsSync(s.path)).toBe(true);
  });

  it("/cancel mid-run kills the agent's whole process group, keeps the worktree, and only the acknowledgement follows", async () => {
    const s = await setup({ kind: "real", mode: "tree" });
    const done = s.runner.tick();
    const pidFile = `${s.marker}.pid`;
    const childFile = `${s.marker}.child`;
    for (let i = 0; i < 300 && !(existsSync(pidFile) && existsSync(childFile)); i++) await new Promise((r) => setTimeout(r, 20));
    const pid = Number(readFileSync(pidFile, "utf8"));
    const child = Number(readFileSync(childFile, "utf8"));
    expect(alive(pid) && alive(child)).toBe(true);
    expect(transitionRun(s.store, BINDING, "running_write", "cancelled").ok).toBe(true);
    await done;
    for (let i = 0; i < 100 && (alive(pid) || alive(child)); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid) || alive(child)).toBe(false);
    expect(stateOf(s.store)).toBe("cancelled");
    expect(s.store.db.prepare("SELECT kind FROM outbox_messages WHERE body <> 'approval request'").all().map((r) => r["kind"])).toEqual(["cancel_ack"]);
    expect(existsSync(s.path)).toBe(true);
  });

  it("an agent that rewrites the worktree's .git pointer cannot redirect the bridge's git, and the summary is still right", async () => {
    const s = await setup({ kind: "real", mode: "pointer" }, { arg: (base) => join(base, "evil", ".git") });
    const evilWork = join(s.base, "evil");
    const fsmonitorMarker = join(s.base, "fsmonitor-ran");
    await plainGit(s.base, ["init", "-q", evilWork]);
    await plainGit(evilWork, ["config", "core.fsmonitor", writeCanary(join(s.base, "fsmonitor.sh"), fsmonitorMarker)]);
    await s.runner.tick();
    expect(readFileSync(join(s.path, ".git"), "utf8")).toBe(`gitdir: ${join(evilWork, ".git")}\n`);
    // Control: plain git in the worktree now follows the pointer and runs the planted command.
    await plainGit(s.path, ["status", "--porcelain"]);
    expect(existsSync(fsmonitorMarker)).toBe(true);
    rmSync(fsmonitorMarker);
    // The bridge's own summary does not, and still describes the real repository.
    expect(stateOf(s.store)).toBe("completed");
    expect(messages(s.store)[0]).toContain("M a.txt (+1 -0)");
    expect(existsSync(fsmonitorMarker)).toBe(false);
  });
});

describe.skipIf(!gitAvailable)("an approved edit run that must not start", () => {
  it("is failed, not started, when edit mode is not enabled in this process", async () => {
    const s = await setup({ kind: "mock" }, { edit: false });
    expect(s.runner.recoverStale()).toBe(1);
    expect(stateOf(s.store)).toBe("failed");
    expect(await s.runner.tick()).toBe("idle");
    expect(s.codexMock.calls).toHaveLength(0);
    expect(existsSync(s.path)).toBe(false);
    expect(messages(s.store)[0]).toContain("edit tasks are not enabled here any more");
  });

  it("is failed without a message when its channel is not an edit channel", async () => {
    const s = await setup({ kind: "mock" }, { channelIds: ["C0ZZZZZZZ"] });
    await s.runner.tick();
    expect(stateOf(s.store)).toBe("failed");
    expect(s.codexMock.calls).toHaveLength(0);
    expect(existsSync(s.path)).toBe(false);
  });

  it("is failed when the worktree cannot be made, and the agent is never started", async () => {
    const s = await setup({ kind: "mock" });
    await plainGit(s.repo, ["branch", `threadrunner/${RUN_ID}`]);
    await s.runner.tick();
    expect(stateOf(s.store)).toBe("failed");
    expect(s.codexMock.calls).toHaveLength(0);
    expect(messages(s.store)[0]).toContain("separate copy of the repository could not be created");
    expect(readdirSync(s.worktreeRoot)).toEqual([]);
  });

  it("is failed with a cap notice when too many worktrees are kept", async () => {
    const s = await setup({ kind: "mock" });
    const capped = createRunner({
      store: s.store, auth: AUTH, repoRoot: s.repo, codexBin: "/fake/codex", timeoutMs: 10_000, launcher: s.launcher, buildInvocation: buildCodexInvocation,
      log: capturingLogger().log, parentEnv: PARENT_ENV, pollMs: 10,
      edit: { git: createGit({ launcher: s.launcher, gitBin: GIT_BIN, cwd: s.worktreeRoot }), worktreeRoot: s.worktreeRoot, maxRetained: 0, timeoutMs: 1000, channelIds: new Set([BINDING.channelId]), buildInvocation: buildCodexWriteInvocation },
    });
    await capped.tick();
    expect(stateOf(s.store)).toBe("failed");
    expect(messages(s.store)[0]).toContain("too many finished worktrees are being kept");
    expect(s.codexMock.calls).toHaveLength(0);
  });

  it("a cancel before it starts means nothing is made and nothing runs", async () => {
    const s = await setup({ kind: "mock" });
    expect(transitionRun(s.store, BINDING, "queued_write", "cancelled").ok).toBe(true);
    await s.runner.tick();
    expect(s.codexMock.calls).toHaveLength(0);
    expect(existsSync(s.path)).toBe(false);
  });
});

describe.skipIf(!gitAvailable)("one run at a time, and restarts", () => {
  it("a read-only run and an approved edit run never overlap, oldest first", async () => {
    const s = await setup({ kind: "mock", output: "ok\n" });
    queueRun(s.store, { channelId: BINDING.channelId });
    await s.runner.tick();
    expect(s.codexMock.state.maxActive).toBe(1);
    expect(s.codexMock.calls).toHaveLength(2);
    // The edit run was approved first, so it ran first (cwd = worktree), then the read-only run (cwd = repository).
    expect(s.codexMock.calls.map((c) => c.cwd)).toEqual([s.path, s.repo]);
  });

  it("a run left in running_write by a previous process is failed, never re-executed, and its worktree is kept", async () => {
    // Simulate the crash: the worktree was made and the run moved to running_write, then the process died.
    const s2 = await setup({ kind: "mock" });
    const run = getRun(s2.store, BINDING);
    if (!run) throw new Error("setup");
    const created = await createWorktree({ store: s2.store, git: createGit({ launcher: s2.launcher, gitBin: GIT_BIN, cwd: s2.worktreeRoot }), repoRoot: s2.repo, worktreeRoot: s2.worktreeRoot, maxRetained: 5 }, run);
    expect(created.ok).toBe(true);
    expect(transitionRun(s2.store, BINDING, "queued_write", "running_write").ok).toBe(true);
    expect(s2.runner.recoverStale()).toBe(1);
    expect(stateOf(s2.store)).toBe("failed");
    expect(await s2.runner.tick()).toBe("idle");
    expect(s2.codexMock.calls).toHaveLength(0);
    expect(existsSync(s2.path)).toBe(true);
    expect(messages(s2.store)[0]).toContain("the bridge restarted while it was running. It was not run again.");
    expect(messages(s2.store)[0]).toContain(`The worktree was kept for inspection: ${s2.path}`);
  });
});

describe("the write argument list", () => {
  it("is exactly the designed command", () => {
    expect(buildCodexWriteInvocation({ prompt: "fix it", worktree: "/wt/run-abc1" })).toEqual({
      args: ["exec", "--sandbox", "workspace-write", "--cd", "/wt/run-abc1", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--color", "never", "-"],
      stdin: "fix it",
    });
  });
});
