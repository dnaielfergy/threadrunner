import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getMessageStatus, getRun } from "../store/index.js";
import { fakeClock, fakeIds, open, tempDbPath } from "../store/test-utils.js";
import { startBridge, type AppDeps } from "./app.js";
import type { Envelope, SlackApi, SocketTransport } from "./transport.js";
import { BOT_USER, DM, TEAM, USER, capturingLogger, dmMessage, eventOf, fakeEnvelope, fakeSlackApi } from "./test-fixtures.js";

const TOKENS = { SLACK_BOT_TOKEN: "xoxb-CANARY-0123456789", SLACK_APP_TOKEN: "xapp-1-CANARY-0123456789" };

function setup(envOverrides: Record<string, string | undefined> = {}, apiOverrides: Partial<SlackApi> = {}) {
  const dbPath = tempDbPath();
  const env = {
    ALLOWED_TEAM_ID: TEAM,
    ALLOWED_USER_IDS: USER,
    ALLOWED_CHANNEL_IDS: DM,
    DATABASE_PATH: dbPath,
    ...TOKENS,
    ...envOverrides,
  };
  const api = Object.assign(fakeSlackApi(), apiOverrides);
  let handler: ((e: Envelope) => Promise<void>) | undefined;
  const transport: SocketTransport = {
    start: vi.fn(async (h) => void (handler = h)),
    stop: vi.fn(async () => {}),
  };
  const connect = vi.fn(() => ({ api, transport }));
  const { log, entries } = capturingLogger();
  const deps: AppDeps = { env, log, connect, now: fakeClock(), randomId: fakeIds(), senderIntervalMs: 3_600_000 };
  return { deps, api, transport, connect, entries, dbPath, handler: () => handler };
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

describe("startBridge", () => {
  it("wires ingress to the outbox: a DM task is stored, acknowledged, and answered in its own thread", async () => {
    const ctx = setup();
    const result = await startBridge(ctx.deps);
    if (!result.ok) throw new Error("expected start");
    const handle = ctx.handler();
    if (!handle) throw new Error("transport never started");

    const body = dmMessage("/claude default investigate the failing build");
    const envelope = fakeEnvelope(body);
    await handle(envelope);
    expect(envelope.acked).toBe(1);
    const ts = String(eventOf(body)["ts"]);
    expect(getRun(result.store, { teamId: TEAM, userId: USER, channelId: DM, rootThreadTs: ts })?.state).toBe("queued");

    await vi.waitFor(() => expect(ctx.api.posts).toHaveLength(1));
    expect(ctx.api.posts[0]).toMatchObject({ channel: DM, thread_ts: ts, parse: "none" });
    await result.stop();
    expect(ctx.transport.stop).toHaveBeenCalledOnce();
  });

  it("shuts down in order: transport first, then the in-flight post is finished and marked sent, then the store closes", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ctx = setup({}, {});
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
    await handle(fakeEnvelope(dmMessage("/claude default investigate the failing build")));
    await vi.waitFor(() => expect(order).toContain("post_started"));

    let stopped = false;
    const stopping = result.stop().then(() => void (stopped = true));
    await vi.waitFor(() => expect(order).toContain("transport_stopped"));
    expect(stopped).toBe(false); // waiting for the post

    release();
    await stopping;
    expect(order).toEqual(["post_started", "transport_stopped", "post_done"]);
    expect(ctx.api.posts).toHaveLength(1);

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
