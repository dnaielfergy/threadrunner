import { inTransaction, int, nullableInt, text, timestamp, type Row, type Store } from "./database.js";
import { MAX_CANCEL_ACK_ATTEMPTS, MAX_OUTBOX_ATTEMPTS } from "./schema.js";
import {
  MAX_OUTBOX_BODY_LENGTH,
  MAX_OUTBOX_PARTS,
  OUTBOX_FAILURE_REASONS,
  isRunId,
  type OutboxFailureReason,
} from "./validate.js";

export const CANCEL_ACK_BODY = "Run cancelled.";

/** Where a message goes, read from the run's stored binding. Never supplied by a caller or provider. */
export interface Destination {
  readonly teamId: string;
  readonly channelId: string;
  readonly threadTs: string;
}

export interface OutboxMessage {
  readonly id: number;
  readonly runId: string;
  readonly kind: "message" | "cancel_ack";
  readonly body: string;
  readonly attempts: number;
  readonly destination: Destination;
}

export type EnqueueOutcome =
  | { readonly ok: true; readonly messageId: number }
  | { readonly ok: false; readonly error: "invalid_input" | "body_too_large" | "not_found" | "run_cancelled" };

export type EnqueuePartsOutcome =
  | { readonly ok: true; readonly messageIds: readonly number[] }
  | { readonly ok: false; readonly error: "invalid_input" | "body_too_large" | "not_found" | "run_cancelled" };

export type MessageOutcome =
  | { readonly ok: true; readonly status: "sent" | "pending" | "failed" }
  | { readonly ok: false; readonly error: "invalid_input" | "not_found" | "not_pending" };

export type ClaimOutcome =
  | { readonly ok: true; readonly message: OutboxMessage }
  | { readonly ok: false; readonly error: "invalid_input" | "not_found" | "not_pending" | "run_cancelled" | "out_of_order" };

const validBody = (body: unknown): body is string => typeof body === "string" && body.length > 0 && !body.includes("\u0000");

/**
 * Split a body into parts of at most `MAX_OUTBOX_BODY_LENGTH` characters, preferring line boundaries.
 * A single line longer than the limit is cut at the limit (never inside a surrogate pair). Pure.
 */
export function splitMessage(body: string, max = MAX_OUTBOX_BODY_LENGTH): string[] {
  // A limit below 2 cannot hold a surrogate pair, so the hard-split below could never advance.
  if (!Number.isInteger(max) || max < 2) throw new RangeError("max must be an integer of at least 2");
  const parts: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.length > 0) parts.push(current);
    current = "";
  };
  for (let line of body.split(/(?<=\n)/)) {
    while (line.length > max) {
      flush();
      let cut = max;
      const code = line.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
      parts.push(line.slice(0, cut));
      line = line.slice(cut);
    }
    if (current.length + line.length > max) flush();
    current += line;
  }
  flush();
  return parts.filter((part) => part.trim().length > 0);
}

/** Internal: also used by approval requests and expiry notices, inside their own transaction. */
export function insertMessage(store: Store, runId: string, body: string, now: number): number {
  const result = store.db
    .prepare("INSERT INTO outbox_messages (run_id, kind, body, created_at, updated_at) VALUES (?, 'message', ?, ?, ?)")
    .run(runId, body, now, now);
  return Number(result.lastInsertRowid);
}

/**
 * Queue a message for a run. There is intentionally no channel or thread parameter: the
 * destination is always the run's stored binding. Nothing is sent here; delivery is a later concern.
 *
 * Bodies over `MAX_OUTBOX_BODY_LENGTH` are rejected, not truncated; use `enqueueMessageParts` for long text.
 *
 * SECURITY (for the sender in #4): `body` may contain provider output influenced by prompt injection.
 * It is stored verbatim and is NOT safe to post as-is. At send time the sender must escape `&`, `<`
 * and `>`, and disable `parse`, `link_names`, and link/media unfurling, or `<!channel>` pings and
 * `<https://evil|Click here>` links will go through. Escaping inflates text (`&` becomes `&amp;`, `<`
 * becomes `&lt;`), so split on the raw text first, then check the escaped length against Slack's
 * limits (3000 per section block, 40000 for plain `text`).
 */
export function enqueueMessage(store: Store, runId: string, body: string): EnqueueOutcome {
  if (!isRunId(runId) || !validBody(body)) return { ok: false, error: "invalid_input" };
  if (body.length > MAX_OUTBOX_BODY_LENGTH) return { ok: false, error: "body_too_large" };

  return inTransaction(store, (): EnqueueOutcome => {
    const run = store.db.prepare("SELECT state FROM runs WHERE id = ?").get(runId);
    if (!run) return { ok: false, error: "not_found" };
    if (run["state"] === "cancelled") return { ok: false, error: "run_cancelled" };
    return { ok: true, messageId: insertMessage(store, runId, body, timestamp(store)) };
  });
}

/**
 * Like `enqueueMessage`, but splits a long body (see `splitMessage`) into ordered parts and queues
 * them in one transaction: all parts or none. Same destination rules and same security note.
 * Refuses bodies that would need more than `MAX_OUTBOX_PARTS` parts.
 */
export function enqueueMessageParts(store: Store, runId: string, body: string): EnqueuePartsOutcome {
  if (!isRunId(runId) || !validBody(body)) return { ok: false, error: "invalid_input" };
  const parts = splitMessage(body);
  if (parts.length === 0) return { ok: false, error: "invalid_input" };
  if (parts.length > MAX_OUTBOX_PARTS) return { ok: false, error: "body_too_large" };

  return inTransaction(store, (): EnqueuePartsOutcome => {
    const run = store.db.prepare("SELECT state FROM runs WHERE id = ?").get(runId);
    if (!run) return { ok: false, error: "not_found" };
    if (run["state"] === "cancelled") return { ok: false, error: "run_cancelled" };
    const now = timestamp(store);
    return { ok: true, messageIds: parts.map((part) => insertMessage(store, runId, part, now)) };
  });
}

/** Internal: called by the cancel transition inside its transaction. */
export function insertCancelAck(store: Store, runId: string, body: string, now: number): void {
  store.db
    .prepare("INSERT INTO outbox_messages (run_id, kind, body, created_at, updated_at) VALUES (?, 'cancel_ack', ?, ?, ?)")
    .run(runId, body, now, now);
}

/** Internal: called by the cancel transition inside its transaction. */
export function failPendingMessages(store: Store, runId: string, reason: string, now: number): void {
  store.db
    .prepare("UPDATE outbox_messages SET status = 'failed', last_error = ?, updated_at = ? WHERE run_id = ? AND status = 'pending'")
    .run(reason, now, runId);
}

const SELECT_DELIVERABLE = `
  SELECT m.id, m.run_id, m.kind, m.body, m.status, m.attempts, r.team_id, r.channel_id, r.root_thread_ts
  FROM outbox_messages m JOIN runs r ON r.id = m.run_id`;

function rowToMessage(row: Row): OutboxMessage {
  return {
    id: int(row, "id"),
    runId: text(row, "run_id"),
    kind: text(row, "kind") as OutboxMessage["kind"], // constrained by a CHECK in the schema
    body: text(row, "body"),
    attempts: int(row, "attempts"),
    destination: { teamId: text(row, "team_id"), channelId: text(row, "channel_id"), threadTs: text(row, "root_thread_ts") },
  };
}

/**
 * Read-only view of what is deliverable: at most the oldest pending message per run (so a thread
 * is never delivered out of order), excluding messages of cancelled runs except the acknowledgement.
 *
 * Listing is NOT permission to send. Call `claimMessage` immediately before posting.
 */
export function listPendingMessages(store: Store, limit = 10): OutboxMessage[] {
  const bounded = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 10;
  return store.db
    .prepare(
      `${SELECT_DELIVERABLE}
       WHERE m.status = 'pending'
         AND m.attempts < CASE m.kind WHEN 'cancel_ack' THEN ? ELSE ? END
         AND (r.state <> 'cancelled' OR m.kind = 'cancel_ack')
         AND m.id = (SELECT min(o.id) FROM outbox_messages o WHERE o.run_id = m.run_id AND o.status = 'pending')
       ORDER BY m.id LIMIT ?`,
    )
    .all(MAX_CANCEL_ACK_ATTEMPTS, MAX_OUTBOX_ATTEMPTS, bounded)
    .map(rowToMessage);
}

/**
 * The sender MUST call this immediately before posting, and post only if it returns ok. In one
 * transaction it re-checks that the message is still pending, is the oldest pending message of its
 * run, and that its run has not been cancelled (the cancellation acknowledgement is exempt), then
 * returns the message with its destination re-read from the run binding.
 *
 * This is a re-check, not an exclusive lock: it writes nothing. Delivery is at-least-once, and one
 * sender process is assumed. Two senders, or a sender that crashes between posting and `markSent`,
 * can post the same message twice. A leased `sending` state belongs with the retry work in #8.
 *
 * Residual window: a cancel recorded after this call returns but before the network request
 * completes cannot recall that one message. See SECURITY.md.
 */
export function claimMessage(store: Store, messageId: number): ClaimOutcome {
  if (!Number.isSafeInteger(messageId) || messageId < 1) return { ok: false, error: "invalid_input" };
  return inTransaction(store, (): ClaimOutcome => {
    const row = store.db.prepare(`${SELECT_DELIVERABLE} WHERE m.id = ?`).get(messageId);
    if (!row) return { ok: false, error: "not_found" };
    if (row["status"] !== "pending") return { ok: false, error: "not_pending" };
    const message = rowToMessage(row);
    const run = store.db.prepare("SELECT state FROM runs WHERE id = ?").get(message.runId);
    if (message.kind !== "cancel_ack" && run?.["state"] === "cancelled") return { ok: false, error: "run_cancelled" };
    const cap = message.kind === "cancel_ack" ? MAX_CANCEL_ACK_ATTEMPTS : MAX_OUTBOX_ATTEMPTS;
    if (message.attempts >= cap) return { ok: false, error: "not_pending" };
    const oldest = store.db
      .prepare("SELECT min(id) AS id FROM outbox_messages WHERE run_id = ? AND status = 'pending'")
      .get(message.runId);
    if (oldest?.["id"] !== message.id) return { ok: false, error: "out_of_order" };
    return { ok: true, message };
  });
}

/** Idempotent: marking an already-sent message sent again succeeds and changes nothing. */
export function markSent(store: Store, messageId: number): MessageOutcome {
  if (!Number.isSafeInteger(messageId) || messageId < 1) return { ok: false, error: "invalid_input" };
  return inTransaction(store, (): MessageOutcome => {
    const row = store.db.prepare("SELECT status FROM outbox_messages WHERE id = ?").get(messageId);
    if (!row) return { ok: false, error: "not_found" };
    if (row["status"] === "sent") return { ok: true, status: "sent" };
    if (row["status"] !== "pending") return { ok: false, error: "not_pending" };
    const now = timestamp(store);
    store.db.prepare("UPDATE outbox_messages SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?").run(now, now, messageId);
    return { ok: true, status: "sent" };
  });
}

/**
 * Count a failed delivery attempt. Only a fixed reason code is stored, never caller text.
 * The message becomes `failed` at the attempt limit (a higher limit applies to the cancellation acknowledgement).
 */
export function recordFailedAttempt(store: Store, messageId: number, reason: OutboxFailureReason): MessageOutcome {
  if (!Number.isSafeInteger(messageId) || messageId < 1 || !(OUTBOX_FAILURE_REASONS as readonly string[]).includes(reason)) {
    return { ok: false, error: "invalid_input" };
  }
  return inTransaction(store, (): MessageOutcome => {
    const row = store.db.prepare("SELECT status, kind, attempts FROM outbox_messages WHERE id = ?").get(messageId);
    if (!row) return { ok: false, error: "not_found" };
    if (row["status"] !== "pending") return { ok: false, error: "not_pending" };
    const attempts = int(row, "attempts") + 1;
    const cap = row["kind"] === "cancel_ack" ? MAX_CANCEL_ACK_ATTEMPTS : MAX_OUTBOX_ATTEMPTS;
    const status = attempts >= cap ? "failed" : "pending";
    store.db
      .prepare("UPDATE outbox_messages SET attempts = ?, status = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(attempts, status, reason, timestamp(store), messageId);
    return { ok: true, status };
  });
}

export function getMessageStatus(store: Store, messageId: number): { status: string; attempts: number; sentAt: number | null } | null {
  const row = store.db.prepare("SELECT status, attempts, sent_at FROM outbox_messages WHERE id = ?").get(messageId);
  return row ? { status: text(row, "status"), attempts: int(row, "attempts"), sentAt: nullableInt(row, "sent_at") } : null;
}
