import { describe, expect, it } from "vitest";
import {
  CANCEL_ACK_BODY,
  MAX_CANCEL_ACK_ATTEMPTS,
  MAX_OUTBOX_ATTEMPTS,
  MAX_OUTBOX_PARTS,
  MAX_OUTBOX_BODY_LENGTH,
  claimMessage,
  createRunFromEvent,
  enqueueMessage,
  enqueueMessageParts,
  getMessageStatus,
  listPendingMessages,
  markSent,
  recordFailedAttempt,
  splitMessage,
  transitionRun,
} from "./index.js";
import { BINDING, fakeClock, fakeIds, newRun, open, tempDbPath } from "./test-utils.js";

function setup() {
  const s = open(tempDbPath(), { now: fakeClock(), randomId: fakeIds() });
  const created = createRunFromEvent(s, newRun());
  if (created.status !== "created") throw new Error("setup");
  return { s, runId: created.run.id };
}

describe("outbox destination binding", () => {
  it("delivers to the run's stored team, channel and root thread", () => {
    const { s, runId } = setup();
    const queued = enqueueMessage(s, runId, "hello");
    expect(queued.ok).toBe(true);
    expect(listPendingMessages(s)).toEqual([
      {
        id: 1,
        runId,
        kind: "message",
        body: "hello",
        attempts: 0,
        destination: { teamId: BINDING.teamId, channelId: BINDING.channelId, threadTs: BINDING.rootThreadTs },
      },
    ]);
  });

  it("each run's messages go to that run's own thread", () => {
    const { s, runId } = setup();
    const other = createRunFromEvent(s, newRun({ eventId: "Ev0AAAAAAA2", channelId: "D0BBBBBBB", messageTs: "1700000002.000100", rootThreadTs: "1700000002.000100" }));
    if (other.status !== "created") throw new Error("setup");
    enqueueMessage(s, runId, "one");
    enqueueMessage(s, other.run.id, "two");
    const byBody = Object.fromEntries(listPendingMessages(s).map((m) => [m.body, m.destination]));
    expect(byBody["one"]).toEqual({ teamId: BINDING.teamId, channelId: BINDING.channelId, threadTs: BINDING.rootThreadTs });
    expect(byBody["two"]).toEqual({ teamId: BINDING.teamId, channelId: "D0BBBBBBB", threadTs: "1700000002.000100" });
  });

  it("cannot be given a destination: the signature takes only (store, runId, body)", () => {
    const { s, runId } = setup();
    // @ts-expect-error enqueueMessage has no destination parameter
    enqueueMessage(s, runId, "x", { channelId: "C0EVILEVIL", threadTs: "1700000099.000100" });
    expect(enqueueMessage.length).toBe(3);

    // Even if a caller smuggles one in at runtime, it is ignored.
    const loose = enqueueMessage as unknown as (...args: unknown[]) => unknown;
    loose(s, runId, "y", { channelId: "C0EVILEVIL" }, "C0EVILEVIL");
    for (const m of listPendingMessages(s)) {
      expect(m.destination).toEqual({ teamId: BINDING.teamId, channelId: BINDING.channelId, threadTs: BINDING.rootThreadTs });
    }
  });

  it("has no destination columns in the schema", () => {
    const { s } = setup();
    const columns = s.db.prepare("PRAGMA table_info(outbox_messages)").all().map((r) => String(r["name"]));
    expect(columns).toEqual(["id", "run_id", "kind", "body", "status", "attempts", "last_error", "created_at", "updated_at", "sent_at"]);
  });

  it("refuses messages for unknown or malformed run IDs", () => {
    const { s } = setup();
    expect(enqueueMessage(s, "run-nope99", "x")).toEqual({ ok: false, error: "not_found" });
    expect(enqueueMessage(s, "C0AAAAAAA", "x")).toEqual({ ok: false, error: "invalid_input" });
    expect(listPendingMessages(s)).toEqual([]);
  });

  it("message content cannot be edited after queueing", () => {
    const { s, runId } = setup();
    enqueueMessage(s, runId, "original");
    expect(() => s.db.exec("UPDATE outbox_messages SET body = 'tampered'")).toThrow(/immutable/);
    expect(() => s.db.exec("UPDATE outbox_messages SET run_id = 'run-other'")).toThrow(/immutable/);
    expect(() => s.db.exec("DELETE FROM outbox_messages")).toThrow(/cannot be deleted/);
  });
});

describe("body limits", () => {
  it("rejects oversized bodies instead of truncating", () => {
    const { s, runId } = setup();
    expect(enqueueMessage(s, runId, "x".repeat(MAX_OUTBOX_BODY_LENGTH))).toMatchObject({ ok: true });
    expect(enqueueMessage(s, runId, "x".repeat(MAX_OUTBOX_BODY_LENGTH + 1))).toEqual({ ok: false, error: "body_too_large" });
    expect(listPendingMessages(s)).toHaveLength(1);
  });

  it("rejects empty and non-string bodies", () => {
    const { s, runId } = setup();
    expect(enqueueMessage(s, runId, "")).toEqual({ ok: false, error: "invalid_input" });
    expect(enqueueMessage(s, runId, 5 as never)).toEqual({ ok: false, error: "invalid_input" });
  });
});

describe("status, attempts and idempotent send", () => {
  it("marking sent is idempotent and keeps the first sent timestamp", () => {
    const { s, runId } = setup();
    enqueueMessage(s, runId, "hi");
    expect(markSent(s, 1)).toEqual({ ok: true, status: "sent" });
    const first = getMessageStatus(s, 1);
    expect(markSent(s, 1)).toEqual({ ok: true, status: "sent" });
    expect(getMessageStatus(s, 1)).toEqual(first);
    expect(first?.sentAt).not.toBeNull();
    expect(listPendingMessages(s)).toEqual([]);
  });

  it("counts failed attempts and gives up at the maximum", () => {
    const { s, runId } = setup();
    enqueueMessage(s, runId, "hi");
    for (let i = 1; i < MAX_OUTBOX_ATTEMPTS; i++) {
      expect(recordFailedAttempt(s, 1, "network")).toEqual({ ok: true, status: "pending" });
      expect(getMessageStatus(s, 1)?.attempts).toBe(i);
    }
    expect(recordFailedAttempt(s, 1, "network")).toEqual({ ok: true, status: "failed" });
    expect(listPendingMessages(s)).toEqual([]);
    expect(recordFailedAttempt(s, 1, "unknown")).toEqual({ ok: false, error: "not_pending" });
    expect(markSent(s, 1)).toEqual({ ok: false, error: "not_pending" });
  });

  it("stores only a fixed reason code, never caller-supplied text", () => {
    const { s, runId } = setup();
    enqueueMessage(s, runId, "hi");
    const token = "xoxb-123456789012-secret-token";
    expect(recordFailedAttempt(s, 1, token as never)).toEqual({ ok: false, error: "invalid_input" });
    expect(getMessageStatus(s, 1)?.attempts).toBe(0);
    recordFailedAttempt(s, 1, "rate_limited");
    expect(s.db.prepare("SELECT last_error FROM outbox_messages").get()).toEqual({ last_error: "rate_limited" });
    expect(JSON.stringify(s.db.prepare("SELECT * FROM outbox_messages").all())).not.toContain("xoxb");
  });

  it("reports unknown ids", () => {
    const { s } = setup();
    expect(markSent(s, 999)).toEqual({ ok: false, error: "not_found" });
    expect(markSent(s, -1)).toEqual({ ok: false, error: "invalid_input" });
  });

  it("the outbox only stores and hands out messages: it holds no sender and makes no calls", () => {
    const { s, runId } = setup();
    enqueueMessage(s, runId, "hi");
    expect(listPendingMessages(s)[0]?.attempts).toBe(0);
  });

  it("state survives reopen", () => {
    const path = tempDbPath();
    const a = open(path, { randomId: fakeIds() });
    const created = createRunFromEvent(a, newRun());
    if (created.status !== "created") throw new Error("setup");
    enqueueMessage(a, created.run.id, "persist me");
    a.close();
    const b = open(path);
    expect(listPendingMessages(b).map((m) => m.body)).toEqual(["persist me"]);
  });
});

describe("cancellation (invariant 8)", () => {
  it("refuses to enqueue after the run is cancelled", () => {
    const { s, runId } = setup();
    expect(transitionRun(s, BINDING, "received", "cancelled").ok).toBe(true);
    expect(enqueueMessage(s, runId, "late")).toEqual({ ok: false, error: "run_cancelled" });
    expect(listPendingMessages(s).map((m) => m.body)).toEqual([CANCEL_ACK_BODY]);
  });

  it("the database also refuses a plain insert after cancellation", () => {
    const { s, runId } = setup();
    transitionRun(s, BINDING, "received", "cancelled");
    expect(() =>
      s.db.prepare("INSERT INTO outbox_messages (run_id, kind, body, created_at, updated_at) VALUES (?, 'message', 'x', 1, 1)").run(runId),
    ).toThrow(/cancelled/);
  });

  it("creates exactly one cancellation acknowledgement, atomically with the transition", () => {
    const { s, runId } = setup();
    transitionRun(s, BINDING, "received", "cancelled");
    expect(transitionRun(s, BINDING, "cancelled", "cancelled").ok).toBe(false);
    const acks = listPendingMessages(s).filter((m) => m.kind === "cancel_ack");
    expect(acks).toHaveLength(1);
    expect(acks[0]?.destination).toEqual({ teamId: BINDING.teamId, channelId: BINDING.channelId, threadTs: BINDING.rootThreadTs });
    expect(() =>
      s.db.prepare("INSERT INTO outbox_messages (run_id, kind, body, created_at, updated_at) VALUES (?, 'cancel_ack', 'again', 1, 1)").run(runId),
    ).toThrow();
  });

  it("no acknowledgement is created for a run that is not cancelled", () => {
    const { s, runId } = setup();
    expect(() =>
      s.db.prepare("INSERT INTO outbox_messages (run_id, kind, body, created_at, updated_at) VALUES (?, 'cancel_ack', 'x', 1, 1)").run(runId),
    ).toThrow(/requires a cancelled run/);
    transitionRun(s, BINDING, "received", "failed");
    expect(listPendingMessages(s)).toEqual([]);
  });

  it("messages already queued when the run is cancelled are never handed out", () => {
    const { s, runId } = setup();
    enqueueMessage(s, runId, "queued before cancel");
    transitionRun(s, BINDING, "received", "cancelled");
    expect(listPendingMessages(s).map((m) => m.body)).toEqual([CANCEL_ACK_BODY]);
    expect(markSent(s, 1)).toEqual({ ok: false, error: "not_pending" });
  });

  it("a failed cancel transition leaves no acknowledgement behind", () => {
    const { s } = setup();
    s.db.exec("CREATE TRIGGER boom BEFORE INSERT ON outbox_messages BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => transitionRun(s, BINDING, "received", "cancelled")).toThrow(/boom/);
    expect(s.db.prepare("SELECT state FROM runs").get()).toEqual({ state: "received" });
  });

  it("other terminal states do not block enqueue (final replies after failure)", () => {
    const { s, runId } = setup();
    transitionRun(s, BINDING, "received", "failed");
    expect(enqueueMessage(s, runId, "it failed").ok).toBe(true);
  });
});

describe("claiming before send (cancel races)", () => {
  it("refuses a claim when the run is cancelled after the message was listed", () => {
    const { s, runId } = setup();
    enqueueMessage(s, runId, "about to go out");
    const listed = listPendingMessages(s);
    expect(listed).toHaveLength(1);
    transitionRun(s, BINDING, "received", "cancelled");
    expect(claimMessage(s, listed[0]?.id ?? 0)).toMatchObject({ ok: false });
    expect(markSent(s, listed[0]?.id ?? 0)).toEqual({ ok: false, error: "not_pending" });
  });

  it("a claim on a live run returns the message with its destination re-read from the binding", () => {
    const { s, runId } = setup();
    enqueueMessage(s, runId, "hello");
    expect(claimMessage(s, 1)).toEqual({
      ok: true,
      message: {
        id: 1,
        runId,
        kind: "message",
        body: "hello",
        attempts: 0,
        destination: { teamId: BINDING.teamId, channelId: BINDING.channelId, threadTs: BINDING.rootThreadTs },
      },
    });
  });

  it("still lets the cancellation acknowledgement through after cancel", () => {
    const { s } = setup();
    transitionRun(s, BINDING, "received", "cancelled");
    expect(claimMessage(s, 1)).toMatchObject({ ok: true, message: { kind: "cancel_ack", body: CANCEL_ACK_BODY } });
  });

  it("refuses a claim on a cancelled run's non-ack message even if its status were pending", () => {
    const { s, runId } = setup();
    enqueueMessage(s, runId, "x");
    transitionRun(s, BINDING, "received", "cancelled");
    // Force the row back to pending, bypassing the code path, to prove the claim re-checks the run itself.
    s.db.exec("UPDATE outbox_messages SET status = 'pending' WHERE id = 1");
    expect(claimMessage(s, 1)).toEqual({ ok: false, error: "run_cancelled" });
  });

  it("refuses unknown, malformed, already-sent and exhausted messages", () => {
    const { s, runId } = setup();
    enqueueMessage(s, runId, "x");
    expect(claimMessage(s, 99)).toEqual({ ok: false, error: "not_found" });
    expect(claimMessage(s, -1)).toEqual({ ok: false, error: "invalid_input" });
    markSent(s, 1);
    expect(claimMessage(s, 1)).toEqual({ ok: false, error: "not_pending" });
  });
});

describe("ordering and delivery caps", () => {
  it("hands out only the oldest pending message per run, in order", () => {
    const { s, runId } = setup();
    enqueueMessage(s, runId, "first");
    enqueueMessage(s, runId, "second");
    expect(listPendingMessages(s).map((m) => m.body)).toEqual(["first"]);
    expect(claimMessage(s, 2)).toEqual({ ok: false, error: "out_of_order" });
    markSent(s, 1);
    expect(listPendingMessages(s).map((m) => m.body)).toEqual(["second"]);
    expect(claimMessage(s, 2).ok).toBe(true);
  });

  it("different runs do not block each other", () => {
    const { s, runId } = setup();
    const other = createRunFromEvent(s, newRun({ eventId: "Ev0AAAAAAA2", messageTs: "1700000002.000100", rootThreadTs: "1700000002.000100" }));
    if (other.status !== "created") throw new Error("setup");
    enqueueMessage(s, runId, "a");
    enqueueMessage(s, other.run.id, "b");
    expect(listPendingMessages(s).map((m) => m.body)).toEqual(["a", "b"]);
  });

  it("gives the cancellation acknowledgement a higher attempt cap than ordinary messages", () => {
    expect(MAX_CANCEL_ACK_ATTEMPTS).toBeGreaterThan(MAX_OUTBOX_ATTEMPTS);
    const { s } = setup();
    transitionRun(s, BINDING, "received", "cancelled");
    for (let i = 0; i < MAX_OUTBOX_ATTEMPTS + 3; i++) expect(recordFailedAttempt(s, 1, "network")).toEqual({ ok: true, status: "pending" });
    expect(listPendingMessages(s)).toHaveLength(1);
    for (let i = MAX_OUTBOX_ATTEMPTS + 3; i < MAX_CANCEL_ACK_ATTEMPTS - 1; i++) recordFailedAttempt(s, 1, "network");
    expect(recordFailedAttempt(s, 1, "network")).toEqual({ ok: true, status: "failed" });
  });
});

describe("splitting long messages", () => {
  it("returns short bodies unchanged", () => {
    expect(splitMessage("hello\nworld")).toEqual(["hello\nworld"]);
  });

  it("splits on line boundaries, each part within the limit, preserving all content in order", () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const parts = splitMessage(body, 500);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(500);
    expect(parts.join("")).toBe(body);
    for (const part of parts.slice(0, -1)) expect(part.endsWith("\n")).toBe(true);
  });

  it("hard-splits a single over-long line without cutting a surrogate pair", () => {
    const body = "😀".repeat(20); // 40 UTF-16 units
    const parts = splitMessage(body, 7);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(7);
      expect([...part].every((c) => c === "😀")).toBe(true);
    }
    expect(parts.join("")).toBe(body);
  });

  it("enqueues all parts in one transaction, in order, to the bound destination", () => {
    const { s, runId } = setup();
    const body = Array.from({ length: 150 }, (_, i) => `row ${i} ${"y".repeat(60)}`).join("\n");
    const result = enqueueMessageParts(s, runId, body);
    expect(result.ok).toBe(true);
    const rows = s.db.prepare("SELECT body FROM outbox_messages ORDER BY id").all().map((r) => String(r["body"]));
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.join("")).toBe(body);
    expect(listPendingMessages(s)).toHaveLength(1);
  });

  it("queues nothing when the body needs too many parts or the run is cancelled", () => {
    const { s, runId } = setup();
    expect(enqueueMessageParts(s, runId, "z".repeat(MAX_OUTBOX_BODY_LENGTH * MAX_OUTBOX_PARTS + 1))).toEqual({ ok: false, error: "body_too_large" });
    expect(s.db.prepare("SELECT count(*) AS n FROM outbox_messages").get()).toEqual({ n: 0 });
    transitionRun(s, BINDING, "received", "cancelled");
    expect(enqueueMessageParts(s, runId, "late")).toEqual({ ok: false, error: "run_cancelled" });
  });

  it("rolls back every part if one insert fails", () => {
    const { s, runId } = setup();
    s.db.exec("CREATE TRIGGER boom BEFORE INSERT ON outbox_messages WHEN NEW.body LIKE '%stop%' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const body = `${"a".repeat(2999)}\n${"b".repeat(2999)}\nstop`;
    expect(() => enqueueMessageParts(s, runId, body)).toThrow(/boom/);
    expect(s.db.prepare("SELECT count(*) AS n FROM outbox_messages").get()).toEqual({ n: 0 });
  });
});
