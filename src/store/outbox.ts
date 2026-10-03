import { inTransaction, int, nullableInt, text, timestamp, type Store } from "./database.js";
import { MAX_OUTBOX_ATTEMPTS } from "./schema.js";
import { MAX_ERROR_LENGTH, MAX_OUTBOX_BODY_LENGTH, isRunId } from "./validate.js";

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

export type MessageOutcome =
  | { readonly ok: true; readonly status: "sent" | "pending" | "failed" }
  | { readonly ok: false; readonly error: "invalid_input" | "not_found" | "not_pending" };

/**
 * Queue a message for a run. There is intentionally no channel or thread parameter: the
 * destination is always the run's stored binding. Nothing is sent here; delivery is a later concern.
 */
export function enqueueMessage(store: Store, runId: string, body: string): EnqueueOutcome {
  if (!isRunId(runId) || typeof body !== "string" || body.length === 0 || body.includes("\u0000")) return { ok: false, error: "invalid_input" };
  if (body.length > MAX_OUTBOX_BODY_LENGTH) return { ok: false, error: "body_too_large" };

  return inTransaction(store, (): EnqueueOutcome => {
    const run = store.db.prepare("SELECT state FROM runs WHERE id = ?").get(runId);
    if (!run) return { ok: false, error: "not_found" };
    if (run["state"] === "cancelled") return { ok: false, error: "run_cancelled" };
    const now = timestamp(store);
    const result = store.db
      .prepare("INSERT INTO outbox_messages (run_id, kind, body, created_at, updated_at) VALUES (?, 'message', ?, ?, ?)")
      .run(runId, body, now, now);
    return { ok: true, messageId: Number(result.lastInsertRowid) };
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

/** Oldest-first messages that are still deliverable. Messages of cancelled runs are excluded, except the acknowledgement. */
export function listPendingMessages(store: Store, limit = 10): OutboxMessage[] {
  const bounded = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 10;
  return store.db
    .prepare(
      `SELECT m.id, m.run_id, m.kind, m.body, m.attempts, r.team_id, r.channel_id, r.root_thread_ts
       FROM outbox_messages m JOIN runs r ON r.id = m.run_id
       WHERE m.status = 'pending' AND m.attempts < ? AND (r.state <> 'cancelled' OR m.kind = 'cancel_ack')
       ORDER BY m.id LIMIT ?`,
    )
    .all(MAX_OUTBOX_ATTEMPTS, bounded)
    .map((row) => ({
      id: int(row, "id"),
      runId: text(row, "run_id"),
      kind: text(row, "kind") as OutboxMessage["kind"], // constrained by a CHECK in the schema
      body: text(row, "body"),
      attempts: int(row, "attempts"),
      destination: { teamId: text(row, "team_id"), channelId: text(row, "channel_id"), threadTs: text(row, "root_thread_ts") },
    }));
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

/** Count a failed delivery attempt. The message becomes `failed` once the attempt limit is reached. */
export function recordFailedAttempt(store: Store, messageId: number, error: string): MessageOutcome {
  if (!Number.isSafeInteger(messageId) || messageId < 1 || typeof error !== "string") return { ok: false, error: "invalid_input" };
  return inTransaction(store, (): MessageOutcome => {
    const row = store.db.prepare("SELECT status, attempts FROM outbox_messages WHERE id = ?").get(messageId);
    if (!row) return { ok: false, error: "not_found" };
    if (row["status"] !== "pending") return { ok: false, error: "not_pending" };
    const attempts = int(row, "attempts") + 1;
    const status = attempts >= MAX_OUTBOX_ATTEMPTS ? "failed" : "pending";
    store.db
      .prepare("UPDATE outbox_messages SET attempts = ?, status = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(attempts, status, error.slice(0, MAX_ERROR_LENGTH), timestamp(store), messageId);
    return { ok: true, status };
  });
}

export function getMessageStatus(store: Store, messageId: number): { status: string; attempts: number; sentAt: number | null } | null {
  const row = store.db.prepare("SELECT status, attempts, sent_at FROM outbox_messages WHERE id = ?").get(messageId);
  return row ? { status: text(row, "status"), attempts: int(row, "attempts"), sentAt: nullableInt(row, "sent_at") } : null;
}
