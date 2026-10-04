import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mockLauncher, writeFakeCli, type MockLauncherOptions } from "../runner/test-utils.js";
import { getMessageStatus, getRun, transitionRun } from "../store/index.js";
import { fakeClock, fakeIds, open, tempDbPath, tempDir } from "../store/test-utils.js";
import { startBridge, type AppDeps } from "./app.js";
import type { Envelope, SlackApi, SocketTransport } from "./transport.js";
import { BOT_USER, DM, TEAM, USER, capturingLogger, dmMessage, eventOf, fakeEnvelope, fakeSlackApi } from "./test-fixtures.js";

const TOKENS = { SLACK_BOT_TOKEN: "xoxb-CANARY-0123456789", SLACK_APP_TOKEN: "xapp-1-CANARY-0123456789" };

function setup(envOverrides: Record<string, string | undefined> = {}, apiOverrides: Partial<SlackApi> = {}, launcherOptions: MockLauncherOptions = {}) {
  const dbPath = tempDbPath();
  const repoRoot = realpathSync(tempDir());
  const env = {
    ALLOWED_TEAM_ID: TEAM,
    ALLOWED_USER_IDS: USER,
    ALLOWED_CHANNEL_IDS: DM,
    DATABASE_PATH: dbPath,
    APPROVED_REPO_ROOTS: repoRoot,
    CODEX_BIN: writeFakeCli(join(tempDir(), "bin")),
    ...TOKENS,
    ...envOverrides,
  };
  const mock = mockLauncher(launcherOptions);
  const api = Object.assign(fakeSlackApi(), apiOverrides);
  let handler: ((e: Envelope) => Promise<void>) | undefined;
  const transport: SocketTransport = {
    start: vi.fn(async (h) => void (handler = h)),
    stop: vi.fn(async () => {}),
  };
  const connect = vi.fn(() => ({ api, transport }));
  const { log, entries } = capturingLogger();
  const deps: AppDeps = {
    env, log, connect, now: fakeClock(), randomId: fakeIds(), senderIntervalMs: 3_600_000, runnerIntervalMs: 3_600_000, launcher: mock.launcher,
    checkEnvFile: () => ({ ok: true }),
  };
  return { deps, api, transport, connect, entries, dbPath, repoRoot, mock, handler: () => handler };
}

describe("startBridge fails closed", () => {
  it("on bad config: reports variable names only, opens nothing, connects to nothing", async () => {
    const ctx = setup({ ALLOWED_USER_IDS: "U0AAAAAAA,U0BBBBBBB", SLACK_BOT_TOKEN: "xoxb-CANARY!" });
    const result = await startBridge(ctx.deps);
    if (result.ok || result.failure.code !== "config") throw new Error("expected config failure");
    expect(result.failure.errors).toContainEqual({ variable: "ALLOWED_USER_IDS", code: "too_many_users" });
    expect(JSON.stringify(result)).not.toContain("CANARY");
    expect(ctx.connect).not.toHaveBeenCalled();
    expect(existsSync(ctx.dbPath)).toBe(false);
  });

  it("when the database location is insecure: never starts listening", async () => {
    const ctx = setup();
    mkdirSync(dirname(ctx.dbPath), { recursive: true, mode: 0o700 });
    writeFileSync(ctx.dbPath, "");
    chmodSync(ctx.dbPath, 0o644);
    const result = await startBridge(ctx.deps);
    expect(result).toEqual({ ok: false, failure: { code: "store" } });
    expect(ctx.entries.map((e) => e.code)).toEqual(["store:insecure_location"]);
    expect(ctx.transport.start).not.toHaveBeenCalled();
  });

  it("when the bot token belongs to a different workspace", async () => {
    const ctx = setup({}, { identify: async () => ({ teamId: "T0OTHEROO", botUserId: BOT_USER }) });
    const result = await startBridge(ctx.deps);
    expect(result).toEqual({ ok: false, failure: { code: "workspace_mismatch" } });
    expect(ctx.transport.start).not.toHaveBeenCalled();
  });

  it("when the bot identity cannot be established", async () => {
    const ctx = setup({}, { identify: async () => Promise.reject(new Error("invalid_auth xoxb-CANARY")) });
    const result = await startBridge(ctx.deps);
    expect(result).toEqual({ ok: false, failure: { code: "slack_identity" } });
    expect(JSON.stringify(result)).not.toContain("CANARY");
    expect(ctx.transport.start).not.toHaveBeenCalled();
  });

  it("when the socket cannot connect", async () => {
    const ctx = setup();
    vi.mocked(ctx.transport.start).mockRejectedValueOnce(new Error("wss://CANARY"));
    expect(await startBridge(ctx.deps)).toEqual({ ok: false, failure: { code: "connect" } });
  });
});

describe("startBridge env file check", () => {
  it("refuses before the config is read, the database is opened, or Slack is contacted", async () => {
    const ctx = setup({ ALLOWED_USER_IDS: "not-valid" });
    const refusal = { ok: false, code: "env_other_access", path: "/canary/.env" } as const;
    const check = vi.fn(() => refusal);
    const result = await startBridge({ ...ctx.deps, checkEnvFile: check });
    // A config failure would have been reported instead if the config had been loaded first.
    expect(result).toEqual({ ok: false, failure: { code: "env_file", reason: "env_other_access", path: "/canary/.env" } });
    expect(check).toHaveBeenCalledTimes(1);
    expect(existsSync(ctx.dbPath)).toBe(false);
    expect(ctx.connect).not.toHaveBeenCalled();
    expect(ctx.transport.start).not.toHaveBeenCalled();
  });

  it("runs the check before the store is opened and before connecting when it passes", async () => {
    const ctx = setup();
    const order: string[] = [];
    const check = vi.fn(() => {
      order.push(existsSync(ctx.dbPath) ? "check:db_exists" : "check");
      return { ok: true } as const;
    });
    ctx.connect.mockImplementationOnce(() => {
      order.push("connect");
      return { api: ctx.api, transport: ctx.transport };
    });
    const result = await startBridge({ ...ctx.deps, checkEnvFile: check });
    if (!result.ok) throw new Error("expected start");
    expect(order).toEqual(["check", "connect"]);
    await result.stop();
  });
});

describe("startBridge", () => {
  it("wires ingress to the outbox: a DM task is stored, acknowledged, and answered in its own thread", async () => {
    const ctx = setup({}, {}, { hold: new Promise(() => {}) });
    const result = await startBridge(ctx.deps);
    if (!result.ok) throw new Error("expected start");
    const handle = ctx.handler();
    if (!handle) throw new Error("transport never started");

    const body = dmMessage("/codex default investigate the failing build");
    const envelope = fakeEnvelope(body);
    await handle(envelope);
    expect(envelope.acked).toBe(1);
    const ts = String(eventOf(body)["ts"]);
    // The fake child never finishes, so the run is picked up and stays running.
    expect(getRun(result.store, { teamId: TEAM, userId: USER, channelId: DM, rootThreadTs: ts })?.state).toBe("running");

    await vi.waitFor(() => expect(ctx.api.posts.length).toBeGreaterThanOrEqual(1));
    expect(ctx.api.posts[0]).toMatchObject({ channel: DM, thread_ts: ts, parse: "none" });
    expect(String(ctx.api.posts[0]?.text)).toContain("Queued as run-");
    await result.stop();
    expect(ctx.transport.stop).toHaveBeenCalledOnce();
  });

  it("shuts down in order: transport first, then the in-flight post is finished and marked sent, then the store closes", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ctx = setup({}, {}, { hold: new Promise(() => {}) });
    const order: string[] = [];
    ctx.api.postMessage = async (request) => {
      ctx.api.posts.push(request);
      order.push("post_started");
      await gate;
      order.push("post_done");
      return { ok: true };
    };
    vi.mocked(ctx.transport.stop).mockImplementation(async () => void order.push("transport_stopped"));

    const result = await startBridge(ctx.deps);
    if (!result.ok) throw new Error("expected start");
    const handle = ctx.handler();
    if (!handle) throw new Error("transport never started");
    await handle(fakeEnvelope(dmMessage("/codex default investigate the failing build")));
    await vi.waitFor(() => expect(order).toContain("post_started"));

    let stopped = false;
    const stopping = result.stop().then(() => void (stopped = true));
    await vi.waitFor(() => expect(order).toContain("transport_stopped"));
    expect(stopped).toBe(false); // waiting for the post

    release();
    await stopping;
    expect(order).toEqual(["post_started", "transport_stopped", "post_done"]);
    expect(ctx.api.posts).toHaveLength(1);
    // The running child was killed and its run failed, but the failure notice was left pending, not posted during shutdown.
    expect(ctx.mock.state.kills).toBe(1);

    // The store was still open when the post finished: a fresh connection sees it marked sent.
    const reopened = open(ctx.dbPath);
    expect(getMessageStatus(reopened, 1)?.status).toBe("sent");
  });

  it("closes the store even if the transport fails to stop, and reports the failure", async () => {
    const ctx = setup();
    const result = await startBridge(ctx.deps);
    if (!result.ok) throw new Error("expected start");
    vi.mocked(ctx.transport.stop).mockRejectedValueOnce(new Error("socket hung"));
    await expect(result.stop()).rejects.toThrow();
    expect(() => result.store.db.prepare("SELECT 1").get()).toThrow();
  });
});

describe("startBridge with the runner", () => {
  const bridge = async (ctx: ReturnType<typeof setup>) => {
    const result = await startBridge(ctx.deps);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const handle = ctx.handler();
    if (!handle) throw new Error("transport never started");
    return { result, handle };
  };

  it.each([
    ["no repository root", { APPROVED_REPO_ROOTS: undefined }, { variable: "APPROVED_REPO_ROOTS", code: "missing" }],
    ["several repository roots", { APPROVED_REPO_ROOTS: "/a,/b" }, { variable: "APPROVED_REPO_ROOTS", code: "too_many_roots" }],
    ["a relative root", { APPROVED_REPO_ROOTS: "code/project" }, { variable: "APPROVED_REPO_ROOTS", code: "not_absolute" }],
    ["a missing provider binary", { CODEX_BIN: undefined }, { variable: "CODEX_BIN", code: "missing" }],
    ["extra provider flags", { CODEX_FLAGS: "--anything" }, { variable: "CODEX_FLAGS", code: "unsupported" }],
  ])("fails closed at startup with %s: opens nothing, connects to nothing", async (_name, override, expected) => {
    const ctx = setup(override);
    const result = await startBridge(ctx.deps);
    if (result.ok || result.failure.code !== "config") throw new Error("expected config failure");
    expect(result.failure.errors).toContainEqual(expected);
    expect(ctx.connect).not.toHaveBeenCalled();
    expect(existsSync(ctx.dbPath)).toBe(false);
    expect(ctx.mock.calls).toHaveLength(0);
  });

  it("runs a /codex task end to end and posts the result in the same thread", async () => {
    const ctx = setup({}, {}, { output: "the answer\n" });
    const { result, handle } = await bridge(ctx);
    const body = dmMessage("/codex fast what does this repo do");
    await handle(fakeEnvelope(body));
    const ts = String(eventOf(body)["ts"]);
    await vi.waitFor(() => expect(ctx.api.posts.length).toBeGreaterThanOrEqual(2));
    expect(ctx.api.posts.map((p) => p.thread_ts)).toEqual([ts, ts]);
    expect(String(ctx.api.posts[1]?.text)).toContain("the answer");
    expect(getRun(result.store, { teamId: TEAM, userId: USER, channelId: DM, rootThreadTs: ts })?.state).toBe("completed");
    expect(ctx.mock.calls).toHaveLength(1);
    expect(ctx.mock.calls[0]?.cwd).toBe(ctx.repoRoot);
    expect(ctx.mock.calls[0]?.args).toContain("read-only");
    await result.stop();
  });

  it("refuses /claude and /auto runs with a fixed reason and never starts a process", async () => {
    const ctx = setup({}, {}, { output: "must not run" });
    const { result, handle } = await bridge(ctx);
    for (const command of ["/claude default hello", "/auto default hello"]) await handle(fakeEnvelope(dmMessage(command)));
    await vi.waitFor(() => expect(ctx.api.posts.length).toBeGreaterThanOrEqual(4));
    expect(ctx.mock.calls).toHaveLength(0);
    expect(ctx.api.posts.filter((p) => String(p.text).includes("only /codex runs are supported"))).toHaveLength(2);
    await result.stop();
  });

  it("a /cancel in the thread stops the running child, and only the acknowledgement follows", async () => {
    const ctx = setup({}, {}, { hold: new Promise(() => {}), output: "late output" });
    ctx.deps = { ...ctx.deps, senderIntervalMs: 30 }; // the cancellation acknowledgement is delivered by the sender's timer
    const { result, handle } = await bridge(ctx);
    const root = dmMessage("/codex default long task");
    await handle(fakeEnvelope(root));
    const ts = String(eventOf(root)["ts"]);
    await vi.waitFor(() => expect(ctx.mock.calls).toHaveLength(1));
    await handle(fakeEnvelope(dmMessage("/cancel", { event: { thread_ts: ts } })));
    await vi.waitFor(() => expect(ctx.mock.state.kills).toBe(1));
    await vi.waitFor(() => expect(ctx.api.posts.map((p) => String(p.text))).toContain("Run cancelled."));
    expect(ctx.api.posts.map((p) => String(p.text)).join("\n")).not.toContain("late output");
    await result.stop();
  });

  it("a run left in `running` by a previous process is failed at startup and never re-executed", async () => {
    const ctx = setup({}, {}, { output: "must not run" });
    // Simulate the crashed process: the same database already holds a running run.
    const seed = open(ctx.dbPath, { now: fakeClock(), randomId: fakeIds() });
    const { queueRun } = await import("../runner/test-utils.js");
    const stale = queueRun(seed);
    transitionRun(seed, stale, "queued", "running");
    seed.close();

    const { result } = await bridge(ctx);
    expect(getRun(result.store, stale)?.state).toBe("failed");
    expect(ctx.entries.map((e) => e.code)).toContain("run_failed:restarted");
    expect(ctx.mock.calls).toHaveLength(0);
    await result.stop();
  });

  describe("edit mode (build_with_approval)", () => {
    const SHA = "0123456789abcdef0123456789abcdef01234567";
    function editSetup() {
      const gitBin = writeFakeCli(join(tempDir(), "gitbin"));
      const wt = join(realpathSync(tempDir()), "worktrees");
      mkdirSync(wt, { mode: 0o700 });
      chmodSync(wt, 0o700);
      const ctx = setup({ RUNNER_DEFAULT_MODE: "build_with_approval", EDIT_CHANNEL_IDS: DM, WORKTREE_ROOT: wt, GIT_BIN: gitBin }, {}, { output: "must not run" });
      mkdirSync(join(ctx.repoRoot, ".git", "refs", "heads"), { recursive: true });
      writeFileSync(join(ctx.repoRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(ctx.repoRoot, ".git", "refs", "heads", "main"), `${SHA}\n`);
      return ctx;
    }

    it("refuses to start when edit mode is on but its settings are missing or wrong", async () => {
      const ctx = setup({ RUNNER_DEFAULT_MODE: "build_with_approval" });
      const result = await startBridge(ctx.deps);
      if (result.ok || result.failure.code !== "config") throw new Error("expected config failure");
      expect(result.failure.errors).toEqual(
        expect.arrayContaining([
          { variable: "EDIT_CHANNEL_IDS", code: "missing" },
          { variable: "WORKTREE_ROOT", code: "missing" },
        ]),
      );
      expect(ctx.connect).not.toHaveBeenCalled();
    });

    it("an edit task asks for approval, and /approve starts only git first: the agent never starts if no worktree can be made", async () => {
      const ctx = editSetup();
      const { result, handle } = await bridge(ctx);
      const body = dmMessage("/codex default --edit fix the typo in the README");
      await handle(fakeEnvelope(body));
      const ts = String(eventOf(body)["ts"]);
      const binding = { teamId: TEAM, userId: USER, channelId: DM, rootThreadTs: ts };
      expect(getRun(result.store, binding)?.state).toBe("awaiting_approval");
      await vi.waitFor(() => expect(ctx.api.posts.length).toBe(1));
      const request = String(ctx.api.posts[0]?.text);
      expect(request).toContain("fix the typo in the README");
      expect(request).toContain(SHA);
      expect(ctx.mock.calls).toHaveLength(0);

      const run = getRun(result.store, binding);
      await handle(fakeEnvelope(dmMessage(`/approve ${run?.id}`, { event: { thread_ts: ts } })));
      // This fake launcher cannot really create a worktree, so the run must fail before any agent starts.
      await vi.waitFor(() => expect(getRun(result.store, binding)?.state).toBe("failed"));
      expect(ctx.mock.calls.length).toBeGreaterThan(0);
      expect(ctx.mock.calls.every((call) => call.command === ctx.deps.env["GIT_BIN"])).toBe(true);
      expect(ctx.mock.calls.some((call) => call.args.includes("workspace-write"))).toBe(false);
      await vi.waitFor(() => expect(ctx.api.posts.map((p) => String(p.text)).join("\n")).toContain("could not be created"));
      await result.stop();
    });

    it("without edit mode, an --edit task is refused with a reason", async () => {
      const ctx = setup();
      const { result, handle } = await bridge(ctx);
      const body = dmMessage("/codex default --edit fix it");
      await handle(fakeEnvelope(body));
      const ts = String(eventOf(body)["ts"]);
      expect(getRun(result.store, { teamId: TEAM, userId: USER, channelId: DM, rootThreadTs: ts })?.state).toBe("failed");
      await vi.waitFor(() => expect(ctx.api.posts.length).toBe(1));
      expect(String(ctx.api.posts[0]?.text)).toContain("not enabled");
      expect(ctx.mock.calls).toHaveLength(0);
      await result.stop();
    });
  });
});
