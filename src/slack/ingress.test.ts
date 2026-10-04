import { describe, expect, it } from "vitest";
import { createRunFromEvent, getRun, listPendingMessages, listRunEvents, type Binding, type Store } from "../store/index.js";
import { fakeClock, fakeIds, open, tempDbPath } from "../store/test-utils.js";
import { createEnvelopeHandler, THREAD_HAS_RUN_REPLY } from "./ingress.js";
import {
  AUTH,
  BOT_USER,
  CHANNEL,
  DM,
  TEAM,
  USER,
  capturingLogger,
  dmMessage,
  eventOf,
  fakeEnvelope,
  mention,
  nextEventId,
  nextTs,
} from "./test-fixtures.js";

const PROMPT = "PROMPT-CANARY-77 investigate the login bug";

function setup() {
  const store = open(tempDbPath(), { now: fakeClock(), randomId: fakeIds() });
  const { log, entries } = capturingLogger();
  let enqueued = 0;
  const handle = createEnvelopeHandler({ store, auth: AUTH, botUserId: BOT_USER, log, onEnqueued: () => void enqueued++ });
  const send = async (body: unknown, type = "events_api") => {
    const envelope = fakeEnvelope(body, type);
    await handle(envelope);
    return envelope;
  };
  return { store, entries, send, enqueuedCount: () => enqueued, handle };
}

const outbox = (store: Store) =>
  store.db
    .prepare("SELECT id, run_id, kind, body, status FROM outbox_messages ORDER BY id")
    .all()
    .map((row) => ({ id: row["id"], runId: row["run_id"], kind: row["kind"], body: String(row["body"]), status: row["status"] }));
const runCount = (store: Store): number => Number(store.db.prepare("SELECT count(*) AS n FROM runs").get()?.["n"]);
const codes = (entries: { code: string }[]) => entries.map((e) => e.code);

/** Create a queued run from a DM task and return its binding. */
async function startRun(ctx: ReturnType<typeof setup>, text = `/claude default ${PROMPT}`) {
  const body = dmMessage(text);
  await ctx.send(body);
  const ts = String(eventOf(body)["ts"]);
  const binding: Binding = { teamId: TEAM, userId: USER, channelId: DM, rootThreadTs: ts };
  const run = getRun(ctx.store, binding);
  if (!run) throw new Error("run not created");
  return { binding, run, ts };
}

/** A reply in the run's thread (a different message ts, thread_ts = root). */
const reply = (text: string, root: string, overrides: { event?: Record<string, unknown>; top?: Record<string, unknown> } = {}) =>
  dmMessage(text, { ...overrides, event: { thread_ts: root, ...overrides.event } });

describe("a valid explicit command", () => {
  it("creates a run, moves it received -> validated -> queued, and acknowledges the envelope", async () => {
    const ctx = setup();
    const { binding, run } = await startRun(ctx);
    expect(run).toMatchObject({ state: "queued", provider: "claude", profile: "default", prompt: PROMPT });
    expect(listRunEvents(ctx.store, binding).map((e) => `${e.fromState}>${e.toState}`)).toEqual(["null>received", "received>validated", "validated>queued"]);
  });

  it("acknowledges the Slack envelope only after the run is persisted and queued", async () => {
    const ctx = setup();
    const body = dmMessage("/codex fast look at the tests");
    const binding = { teamId: TEAM, userId: USER, channelId: DM, rootThreadTs: String(eventOf(body)["ts"]) };
    let stateAtAck: string | undefined;
    const envelope = fakeEnvelope(body, "events_api", () => {
      stateAtAck = getRun(ctx.store, binding)?.state;
    });
    await ctx.handle(envelope);
    expect(envelope.acked).toBe(1);
    expect(stateAtAck).toBe("queued");
  });

  it("posts a thread-bound acknowledgement to the stored channel and root thread, without the prompt", async () => {
    const ctx = setup();
    const { run, ts } = await startRun(ctx);
    const [message] = listPendingMessages(ctx.store);
    expect(message?.destination).toEqual({ teamId: TEAM, channelId: DM, threadTs: ts });
    expect(message?.body).toBe(`Queued as ${run.id}. Reply in this thread with /status or /cancel.`);
    expect(message?.body).not.toContain("CANARY");
    expect(ctx.enqueuedCount()).toBe(1);
  });

  it("works through an @mention in an allowlisted channel, and replies to that channel's thread", async () => {
    const ctx = setup();
    const body = mention("/auto deep map the module boundaries");
    await ctx.send(body);
    const ts = String(eventOf(body)["ts"]);
    const run = getRun(ctx.store, { teamId: TEAM, userId: USER, channelId: CHANNEL, rootThreadTs: ts });
    expect(run).toMatchObject({ state: "queued", provider: "auto", profile: "deep", prompt: "map the module boundaries" });
    expect(listPendingMessages(ctx.store)[0]?.destination).toEqual({ teamId: TEAM, channelId: CHANNEL, threadTs: ts });
  });

  it("roots the run at thread_ts when the command is sent inside an existing thread", async () => {
    const ctx = setup();
    const root = nextTs();
    await ctx.send(dmMessage("/claude default look at this", { event: { thread_ts: root } }));
    const run = getRun(ctx.store, { teamId: TEAM, userId: USER, channelId: DM, rootThreadTs: root });
    expect(run?.state).toBe("queued");
    expect(listPendingMessages(ctx.store)[0]?.destination.threadTs).toBe(root);
  });

  it("restores Slack's HTML escaping in the stored prompt", async () => {
    const ctx = setup();
    const { run } = await startRun(ctx, "/claude default is a &lt; b &amp;&amp; c &gt; d?");
    expect(run.prompt).toBe("is a < b && c > d?");
  });
});

describe("unauthorized and invalid events", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["wrong user", dmMessage("/claude default x", { event: { user: "U0ZZZZZZZ" } })],
    ["wrong team", dmMessage("/claude default x", { top: { team_id: "T0ZZZZZZZ" } })],
    ["wrong channel", mention("/claude default x", { event: { channel: "C0ZZZZZZZ" } })],
    ["bot message", dmMessage("/claude default x", { event: { bot_id: "B0AAAAAAA" } })],
    ["subtype", dmMessage("/claude default x", { event: { subtype: "message_changed" } })],
    ["shared channel", mention("/claude default x", { top: { is_ext_shared_channel: true } })],
    ["ambient channel message", mention("/claude default x", { event: { type: "message", channel_type: "channel", text: "/claude default x" } })],
    ["malformed id", dmMessage("/claude default x", { event: { user: "alice" } })],
  ];

  it.each(bad)("%s: no run, no reply, envelope still acknowledged, only a reason code logged", async (_name, body) => {
    const ctx = setup();
    const envelope = await ctx.send(body);
    expect(runCount(ctx.store)).toBe(0);
    expect(outbox(ctx.store)).toEqual([]);
    expect(envelope.acked).toBe(1);
    expect(ctx.entries).toHaveLength(1);
    expect(ctx.entries[0]?.code).toMatch(/^reject:[a-z_]+$/);
    expect(JSON.stringify(ctx.entries)).not.toContain("claude default");
    expect(ctx.enqueuedCount()).toBe(0);
  });

  it.each([
    ["ambient chat", "hey, can you look at the login bug?"],
    ["no model profile", "/claude investigate the login bug"],
    ["unknown profile", "/claude turbo investigate"],
    ["unknown command", "/deploy production"],
    ["profile without prompt", "/claude fast"],
    ["status with arguments", "/status please"],
    ["prompt too long", `/claude fast ${"x".repeat(5000)}`],
    ["control characters", "/claude fast do\u0000this"],
  ])("explicit-invocation failure (%s): silent, no run, no reply", async (_name, text) => {
    const ctx = setup();
    const envelope = await ctx.send(dmMessage(text));
    expect(runCount(ctx.store)).toBe(0);
    expect(outbox(ctx.store)).toEqual([]);
    expect(envelope.acked).toBe(1);
    expect(ctx.entries[0]?.code).toMatch(/^parse:[a-z_]+$/);
  });

  it("drops non-event envelopes (slash commands, interactive) with an ack and no side effects", async () => {
    const ctx = setup();
    for (const type of ["slash_commands", "interactive"]) {
      const envelope = await ctx.send({ command: "/claude", text: "default x", user_id: USER, channel_id: DM, team_id: TEAM }, type);
      expect(envelope.acked).toBe(1);
    }
    expect(runCount(ctx.store)).toBe(0);
    expect(outbox(ctx.store)).toEqual([]);
    expect(codes(ctx.entries)).toEqual(["drop:unsupported_envelope", "drop:unsupported_envelope"]);
  });

  it("drops a malformed events_api payload", async () => {
    const ctx = setup();
    const envelope = await ctx.send({ type: "something_else" });
    expect(envelope.acked).toBe(1);
    expect(codes(ctx.entries)).toEqual(["drop:malformed_envelope"]);
  });

  it("logs an event ID only when it has the shape of a real one", async () => {
    const ctx = setup();
    await ctx.send(dmMessage("hi", { top: { event_id: "injected\nfake log line" } }));
    await ctx.send(dmMessage("hi", { event: { user: "U0ZZZZZZZ" } }));
    expect(ctx.entries[0]?.eventId).toBeUndefined();
    expect(ctx.entries[1]?.eventId).toMatch(/^Ev/);
  });

  it("never logs message text, the prompt, or the sender's words, on any path", async () => {
    const ctx = setup();
    const { ts } = await startRun(ctx);
    await ctx.send(dmMessage(`/claude default ${PROMPT} second`, { event: { thread_ts: ts } }));
    await ctx.send(dmMessage("PROMPT-CANARY-77 ambient"));
    await ctx.send(reply("/status", ts));
    await ctx.send(dmMessage(`/claude default ${PROMPT}`, { event: { user: "U0ZZZZZZZ" } }));
    expect(JSON.stringify(ctx.entries)).not.toContain("CANARY");
  });
});

describe("deduplication across Slack retries", () => {
  it("a redelivered envelope does not create a second run or a second acknowledgement", async () => {
    const ctx = setup();
    const body = dmMessage(`/claude default ${PROMPT}`);
    await ctx.send(body);
    const again = await ctx.send(body);
    expect(runCount(ctx.store)).toBe(1);
    expect(outbox(ctx.store)).toHaveLength(1);
    expect(again.acked).toBe(1);
    expect(ctx.entries.at(-1)?.code).toBe("duplicate");
  });

  it("a retry carrying a new event ID for the same message is still a duplicate", async () => {
    const ctx = setup();
    const body = dmMessage(`/claude default ${PROMPT}`);
    await ctx.send(body);
    await ctx.send({ ...body, event_id: nextEventId() });
    expect(runCount(ctx.store)).toBe(1);
    expect(outbox(ctx.store)).toHaveLength(1);
  });

  it.each([
    ["message.im then app_mention", ["message", "app_mention"]],
    ["app_mention then message.im", ["app_mention", "message"]],
  ] as const)("one DM message arriving as both events (%s) creates exactly one run", async (_name, order) => {
    const ctx = setup();
    const ts = nextTs();
    const text = `/claude default ${PROMPT}`;
    const variants = {
      message: dmMessage(text, { event: { ts } }),
      app_mention: dmMessage(`<@${BOT_USER}> ${text}`, { event: { ts, type: "app_mention", channel_type: undefined } }),
    };
    for (const kind of order) await ctx.send(variants[kind]);
    expect(runCount(ctx.store)).toBe(1);
    expect(outbox(ctx.store)).toHaveLength(1);
    expect(codes(ctx.entries).filter((c) => c === "duplicate")).toHaveLength(1);
  });

  it("in a channel, only the app_mention counts; the paired ambient message event is rejected", async () => {
    const ctx = setup();
    const ts = nextTs();
    const text = `<@${BOT_USER}> /claude default ${PROMPT}`;
    await ctx.send(mention("x", { event: { type: "message", channel_type: "channel", text, ts } }));
    await ctx.send(mention("/claude default " + PROMPT, { event: { ts } }));
    expect(runCount(ctx.store)).toBe(1);
    expect(codes(ctx.entries)).toEqual(["reject:unsupported_event_type", "run_queued"]);
  });

  it("a second task in a thread that already has a run gets one reply, and a retry of it gets none", async () => {
    const ctx = setup();
    const { ts, run } = await startRun(ctx);
    const second = reply("/claude default another task", ts);
    await ctx.send(second);
    await ctx.send(second);
    await ctx.send({ ...second, event_id: nextEventId() });
    expect(runCount(ctx.store)).toBe(1);
    expect(outbox(ctx.store).filter((m) => m.body === THREAD_HAS_RUN_REPLY)).toHaveLength(1);
    expect(getRun(ctx.store, { teamId: TEAM, userId: USER, channelId: DM, rootThreadTs: ts })?.id).toBe(run.id);
    expect(codes(ctx.entries).slice(-3)).toEqual(["rejected:thread_already_has_run", "duplicate", "duplicate"]);
  });

  it("a retried /status does not produce a second reply", async () => {
    const ctx = setup();
    const { ts } = await startRun(ctx);
    const status = reply("/status", ts);
    await ctx.send(status);
    await ctx.send(status);
    await ctx.send({ ...status, event_id: nextEventId() });
    expect(outbox(ctx.store).filter((m) => m.body.endsWith("is queued."))).toHaveLength(1);
  });

  it("finishes a run stranded in `received` by a crash, instead of ignoring the retry", async () => {
    const ctx = setup();
    const body = dmMessage(`/claude default ${PROMPT}`);
    const ev = eventOf(body);
    const binding = { teamId: TEAM, userId: USER, channelId: DM, rootThreadTs: String(ev["ts"]) };
    const stranded = createRunFromEvent(ctx.store, {
      ...binding,
      eventId: String(body["event_id"]),
      messageTs: String(ev["ts"]),
      provider: "claude",
      profile: "default",
      prompt: PROMPT,
    });
    expect(stranded.status).toBe("created");
    await ctx.send(body);
    expect(getRun(ctx.store, binding)?.state).toBe("queued");
    expect(codes(ctx.entries)).toEqual(["run_resumed"]);
    expect(outbox(ctx.store)).toHaveLength(1);
    await ctx.send(body);
    expect(outbox(ctx.store)).toHaveLength(1);
  });
});

describe("/status, /cancel and /approve", () => {
  it("/status in the thread replies with the run state to that thread", async () => {
    const ctx = setup();
    const { ts, run } = await startRun(ctx);
    await ctx.send(reply("/status", ts));
    const status = outbox(ctx.store).find((m) => m.body.startsWith("Run "));
    expect(status?.body).toBe(`Run ${run.id} is queued.`);
  });

  it("/status as a new top-level message is not bound to any run: quiet", async () => {
    const ctx = setup();
    await startRun(ctx);
    const before = outbox(ctx.store).length;
    const envelope = await ctx.send(dmMessage("/status"));
    expect(outbox(ctx.store)).toHaveLength(before);
    expect(envelope.acked).toBe(1);
    expect(codes(ctx.entries).at(-1)).toBe("status_no_run");
  });

  it("/status via @mention works too (the leading bot mention is stripped)", async () => {
    const ctx = setup();
    const root = nextTs();
    await ctx.send(mention("/claude fast hello", { event: { ts: root } }));
    await ctx.send(mention("/status", { event: { thread_ts: root } }));
    expect(outbox(ctx.store).map((m) => m.body)).toHaveLength(2);
  });

  it("/cancel in the thread cancels that run and queues a single acknowledgement", async () => {
    const ctx = setup();
    const { ts, binding } = await startRun(ctx);
    await ctx.send(reply("/cancel", ts));
    expect(getRun(ctx.store, binding)?.state).toBe("cancelled");
    expect(outbox(ctx.store).filter((m) => m.kind === "cancel_ack")).toHaveLength(1);
  });

  it("retried /cancel (same event, or a new event ID) is a quiet no-op after a successful cancel", async () => {
    const ctx = setup();
    const { ts } = await startRun(ctx);
    const cancel = reply("/cancel", ts);
    await ctx.send(cancel);
    const envelope = await ctx.send(cancel);
    await ctx.send(reply("/cancel", ts));
    expect(envelope.acked).toBe(1);
    expect(outbox(ctx.store).filter((m) => m.kind === "cancel_ack")).toHaveLength(1);
    expect(codes(ctx.entries).slice(-2)).toEqual(["duplicate", "cancel_noop:illegal_transition"]);
  });

  it("/cancel from a different allowlisted channel cannot reach a run in another channel", async () => {
    const ctx = setup();
    const { ts, binding } = await startRun(ctx);
    await ctx.send(mention("/cancel", { event: { thread_ts: ts } }));
    expect(getRun(ctx.store, binding)?.state).toBe("queued");
    expect(codes(ctx.entries).at(-1)).toBe("cancel_no_run");
  });

  it("/approve on a read-only run changes nothing and says why (edit flow: edit-flow.test.ts)", async () => {
    const ctx = setup();
    const { ts, run, binding } = await startRun(ctx);
    const events = listRunEvents(ctx.store, binding).length;
    const envelope = await ctx.send(reply(`/approve ${run.id}`, ts));
    expect(envelope.acked).toBe(1);
    expect(getRun(ctx.store, binding)?.state).toBe("queued");
    expect(listRunEvents(ctx.store, binding)).toHaveLength(events);
    expect(Number(ctx.store.db.prepare("SELECT count(*) AS n FROM approvals").get()?.["n"])).toBe(0);
    expect(codes(ctx.entries).at(-1)).toBe("approve_refused:edit_disabled");
  });

  it("a bare 'yes' is not a command at all", async () => {
    const ctx = setup();
    const { ts } = await startRun(ctx);
    await ctx.send(reply("yes", ts));
    expect(codes(ctx.entries).at(-1)).toBe("parse:not_a_command");
  });
});

describe("persistence failure", () => {
  it("leaves the envelope unacknowledged so Slack redelivers it, and logs no text", async () => {
    const ctx = setup();
    ctx.store.close();
    const envelope = await ctx.send(dmMessage(`/claude default ${PROMPT}`));
    expect(envelope.acked).toBe(0);
    expect(codes(ctx.entries)).toEqual(["persist_failed"]);
    expect(JSON.stringify(ctx.entries)).not.toContain("CANARY");
  });

  it("an ack that fails is logged but does not throw", async () => {
    const ctx = setup();
    const envelope = { type: "events_api", body: dmMessage("hello"), ack: async () => Promise.reject(new Error("socket closed")) };
    await expect(ctx.handle(envelope)).resolves.toBeUndefined();
    expect(codes(ctx.entries)).toContain("ack_failed");
  });
});
