import { transition, type RunState } from "../domain/run-state.js";
import type { ModelProfile, Provider, RunMode } from "../domain/types.js";
import { RUN_ID_PATTERN } from "../parser/command.js";
import { inTransaction, int, text, timestamp, type Row, type Store } from "./database.js";
import { StoreError } from "./errors.js";
import { invocationSha256 } from "./invocation.js";
import { MAX_OUTBOX_BODY_LENGTH } from "./validate.js";
import { CANCEL_ACK_BODY, failPendingMessages, insertCancelAck, insertMessage } from "./outbox.js";
import { invalidBindingField, invalidNewRunField, isCommitSha, isRunId, isRunState, type Binding, type NewRunInput } from "./validate.js";

export interface Run extends Binding {
  readonly id: string;
  readonly provider: Provider;
  readonly profile: ModelProfile;
  /** Stored once, for the runner. Never copied into run events, outbox messages, or logs. */
  readonly prompt: string;
  /** What the task asked for. Immutable. */
  readonly mode: RunMode;
  readonly state: RunState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RunEvent {
  readonly id: number;
  readonly runId: string;
  readonly type: "created" | "transition" | "approval_recorded";
  readonly fromState: RunState | null;
  readonly toState: RunState | null;
  readonly createdAt: number;
}

export interface Approval {
  readonly runId: string;
  readonly approvedByUserId: string;
  /** Run state at the moment the approval was recorded. */
  readonly runState: RunState;
  readonly approvedAt: number;
  /** Hash of exactly what was approved. Null only for a row written before schema version 2. */
  readonly invocationSha256: string | null;
}

/** What the approval request showed, recorded when the run entered `awaiting_approval`. */
export interface EditRequest {
  readonly runId: string;
  readonly baseSha: string;
  readonly requestedAt: number;
  readonly expiresAt: number;
  readonly requestMessageId: number;
}

export type CreateRunResult =
  | { readonly status: "created"; readonly run: Run }
  /** The inbound event or message was already seen. Callers should ignore it quietly. */
  | { readonly status: "duplicate" }
  /** A different message tried to start a run in a thread that already has one. Recorded, so a retry of the same event is a `duplicate`. */
  | { readonly status: "rejected"; readonly reason: "thread_already_has_run" }
  | { readonly status: "invalid"; readonly field: string };

/**
 * `not_found` deliberately covers both "no such run" and "binding mismatch on any field",
 * so a caller learns nothing about runs it does not own.
 */
export type RunError = "invalid_input" | "not_found";
export type TransitionError = RunError | "stale_state" | "illegal_transition" | "write_slot_busy";
export type TransitionOutcome = { readonly ok: true; readonly run: Run } | { readonly ok: false; readonly error: TransitionError };
export type ApprovalOutcome =
  | { readonly ok: true; readonly approval: Approval }
  | { readonly ok: false; readonly error: RunError | "not_awaiting_approval" | "already_approved" };

export type RequestApprovalOutcome =
  | { readonly ok: true; readonly run: Run; readonly request: EditRequest }
  | { readonly ok: false; readonly error: RunError | "not_validated" | "not_edit_mode" | "invalid_body" | "stale_state" };

export type ApproveRunOutcome =
  | { readonly ok: true; readonly run: Run; readonly approval: Approval }
  | {
      readonly ok: false;
      readonly error:
        | RunError
        | "not_awaiting_approval"
        | "not_edit_mode"
        | "no_request"
        | "already_approved"
        | "not_delivered"
        | "expired"
        | "write_slot_busy";
    };

const MAX_RUN_ID_ATTEMPTS = 5;

const stateOf = (value: string): RunState => {
  if (!isRunState(value)) throw new StoreError("corrupt_row", "unknown run state in database");
  return value;
};

function rowToRun(row: Row): Run {
  return {
    id: text(row, "id"),
    teamId: text(row, "team_id"),
    userId: text(row, "user_id"),
    channelId: text(row, "channel_id"),
    rootThreadTs: text(row, "root_thread_ts"),
    provider: text(row, "provider") as Provider, // constrained by a CHECK in the schema
    profile: text(row, "profile") as ModelProfile, // constrained by a CHECK in the schema
    prompt: text(row, "prompt"),
    mode: text(row, "mode") as RunMode, // constrained by a CHECK in the schema
    state: stateOf(text(row, "state")),
    createdAt: int(row, "created_at"),
    updatedAt: int(row, "updated_at"),
  };
}

/** Exact match on all four binding fields; any mismatch is indistinguishable from "no such run". */
function findByBinding(store: Store, b: Binding): Run | null {
  const row = store.db
    .prepare("SELECT * FROM runs WHERE team_id = ? AND user_id = ? AND channel_id = ? AND root_thread_ts = ?")
    .get(b.teamId, b.userId, b.channelId, b.rootThreadTs);
  return row ? rowToRun(row) : null;
}

export function findRunById(store: Store, runId: string): Run | null {
  if (!isRunId(runId)) return null;
  const row = store.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  return row ? rowToRun(row) : null;
}

/**
 * Runs currently in `state`, oldest first (by insertion order), at most `limit` (1 to 100).
 * Read-only: the runner uses it to find work and must still change state through `transitionRun`.
 */
export function listRunsByState(store: Store, state: RunState, limit = 10): Run[] {
  if (!isRunState(state)) return [];
  const bounded = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 10;
  return store.db.prepare("SELECT * FROM runs WHERE state = ? ORDER BY rowid LIMIT ?").all(state, bounded).map(rowToRun);
}

/** Look up a run by its full binding. Returns null for malformed input, no match, or any partial match. */
export function getRun(store: Store, binding: Binding): Run | null {
  if (invalidBindingField(binding)) return null;
  return findByBinding(store, binding);
}

function allocateRunId(store: Store): string {
  for (let attempt = 0; attempt < MAX_RUN_ID_ATTEMPTS; attempt++) {
    const id = `run-${store.randomId()}`;
    if (!RUN_ID_PATTERN.test(id)) throw new StoreError("bad_run_id", "random ID generator produced a malformed run ID");
    if (!store.db.prepare("SELECT 1 AS x FROM runs WHERE id = ?").get(id)) return id;
  }
  throw new StoreError("run_id_exhausted", "could not allocate a unique run ID");
}

function insertEvent(store: Store, runId: string, type: RunEvent["type"], from: RunState | null, to: RunState | null, at: number): void {
  store.db
    .prepare("INSERT INTO run_events (run_id, type, from_state, to_state, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(runId, type, from, to, at);
}

/**
 * Record an inbound event and create its run in one transaction. A duplicate event ID, or a
 * second event for the same (team, channel, message_ts), yields `duplicate` and writes nothing.
 *
 * An event rejected because its thread already has a run is recorded too (with no run), so a Slack
 * retry of that same event returns `duplicate` and the caller does not repeat the rejection reply.
 * Malformed input is never recorded.
 */
export function createRunFromEvent(store: Store, input: NewRunInput): CreateRunResult {
  const invalid = invalidNewRunField(input);
  if (invalid) return { status: "invalid", field: invalid };

  return inTransaction(store, (): CreateRunResult => {
    const seen = store.db
      .prepare("SELECT 1 AS x FROM inbound_events WHERE team_id = ? AND (event_id = ? OR (channel_id = ? AND message_ts = ?))")
      .get(input.teamId, input.eventId, input.channelId, input.messageTs);
    if (seen) return { status: "duplicate" };

    const threadTaken = store.db
      .prepare("SELECT 1 AS x FROM runs WHERE team_id = ? AND channel_id = ? AND root_thread_ts = ?")
      .get(input.teamId, input.channelId, input.rootThreadTs);
    if (threadTaken) {
      store.db
        .prepare(
          `INSERT INTO inbound_events (team_id, event_id, channel_id, message_ts, run_id, outcome, received_at)
           VALUES (?, ?, ?, ?, NULL, 'rejected_thread_has_run', ?)`,
        )
        .run(input.teamId, input.eventId, input.channelId, input.messageTs, timestamp(store));
      return { status: "rejected", reason: "thread_already_has_run" };
    }

    const id = allocateRunId(store);
    const now = timestamp(store);
    const state: RunState = "received";
    const mode: RunMode = input.mode ?? "read";
    store.db
      .prepare(
        `INSERT INTO runs (id, team_id, user_id, channel_id, root_thread_ts, provider, profile, prompt, mode, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.teamId, input.userId, input.channelId, input.rootThreadTs, input.provider, input.profile, input.prompt, mode, state, now, now);
    store.db
      .prepare("INSERT INTO inbound_events (team_id, event_id, channel_id, message_ts, run_id, outcome, received_at) VALUES (?, ?, ?, ?, ?, 'created', ?)")
      .run(input.teamId, input.eventId, input.channelId, input.messageTs, id, now);
    insertEvent(store, id, "created", null, state, now);

    return {
      status: "created",
      run: {
        id,
        teamId: input.teamId,
        userId: input.userId,
        channelId: input.channelId,
        rootThreadTs: input.rootThreadTs,
        provider: input.provider,
        profile: input.profile,
        prompt: input.prompt,
        mode,
        state,
        createdAt: now,
        updatedAt: now,
      },
    };
  });
}

/**
 * Mode rules, on top of the pure state graph. `queued_write` is reachable only through `approveRun`,
 * which records the approval in the same transaction. The database triggers repeat these rules.
 */
function modeForbids(run: Run, to: RunState, viaApproval: boolean): boolean {
  if (to === "queued_write") return !viaApproval;
  if (run.mode === "edit") return to === "queued" || to === "running";
  return to === "running_write" || (run.state === "validated" && to === "awaiting_approval");
}

/** Must run inside a transaction. Moves the run with a compare-and-swap and writes the audit event. */
function applyTransition(store: Store, run: Run, to: RunState, now: number, viaApproval = false): TransitionOutcome {
  if (!transition(run.state, to).ok || modeForbids(run, to, viaApproval)) return { ok: false, error: "illegal_transition" };

  try {
    const result = store.db.prepare("UPDATE runs SET state = ?, updated_at = ? WHERE id = ? AND state = ?").run(to, now, run.id, run.state);
    if (result.changes !== 1) return { ok: false, error: "stale_state" };
  } catch (error) {
    // The partial unique index on running_write: another write run is operating.
    if (to === "running_write" && error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      return { ok: false, error: "write_slot_busy" };
    }
    throw error;
  }
  insertEvent(store, run.id, "transition", run.state, to, now);
  if (to === "cancelled") {
    failPendingMessages(store, run.id, "run cancelled", now);
    insertCancelAck(store, run.id, CANCEL_ACK_BODY, now);
  }
  return { ok: true, run: { ...run, state: to, updatedAt: now } };
}

/**
 * The only way to change a run's state (with `approveRun` and `expireStaleApprovals`, which
 * share its internals). The caller presents the full binding and the state it believes the run is
 * in; the update applies only if the run is still in that state (compare-and-swap) and
 * `transition()` allows the move. Cancelling also queues the single cancellation acknowledgement
 * and fails any other pending outbound messages, atomically.
 */
export function transitionRun(store: Store, binding: Binding, expected: RunState, to: RunState): TransitionOutcome {
  if (invalidBindingField(binding) || !isRunState(expected) || !isRunState(to)) return { ok: false, error: "invalid_input" };

  return inTransaction(store, (): TransitionOutcome => {
    const run = findByBinding(store, binding);
    if (!run) return { ok: false, error: "not_found" };
    if (run.state !== expected) return { ok: false, error: "stale_state" };
    return applyTransition(store, run, to, timestamp(store));
  });
}

const MIN_APPROVAL_TTL_MS = 60_000;
const MAX_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Move an edit-mode run from `validated` to `awaiting_approval` and queue the approval request
 * message, atomically: either the thread has a request and the run is waiting on it, or neither.
 * `body` is the fixed-template request text built by the caller (it must show what will be approved).
 * Nothing here runs anything or unlocks anything.
 */
export function requestApproval(
  store: Store,
  binding: Binding,
  runId: string,
  request: { readonly baseSha: string; readonly body: string; readonly ttlMs: number },
): RequestApprovalOutcome {
  if (invalidBindingField(binding) || !isRunId(runId) || !isCommitSha(request.baseSha)) return { ok: false, error: "invalid_input" };
  if (!Number.isSafeInteger(request.ttlMs) || request.ttlMs < MIN_APPROVAL_TTL_MS || request.ttlMs > MAX_APPROVAL_TTL_MS) {
    return { ok: false, error: "invalid_input" };
  }
  if (typeof request.body !== "string" || request.body.length === 0 || request.body.length > MAX_OUTBOX_BODY_LENGTH || request.body.includes("\u0000")) {
    return { ok: false, error: "invalid_body" };
  }

  return inTransaction(store, (): RequestApprovalOutcome => {
    const run = findByBinding(store, binding);
    if (!run || run.id !== runId) return { ok: false, error: "not_found" };
    if (run.mode !== "edit") return { ok: false, error: "not_edit_mode" };
    if (run.state !== "validated") return { ok: false, error: "not_validated" };

    const now = timestamp(store);
    const moved = applyTransition(store, run, "awaiting_approval", now);
    if (!moved.ok) return { ok: false, error: moved.error === "stale_state" ? "stale_state" : "not_validated" };

    const messageId = insertMessage(store, run.id, request.body, now);
    const expiresAt = now + request.ttlMs;
    store.db
      .prepare("INSERT INTO edit_requests (run_id, base_sha, requested_at, expires_at, request_message_id) VALUES (?, ?, ?, ?, ?)")
      .run(run.id, request.baseSha, now, expiresAt, messageId);
    return { ok: true, run: moved.run, request: { runId: run.id, baseSha: request.baseSha, requestedAt: now, expiresAt, requestMessageId: messageId } };
  });
}

/**
 * Approve exactly what the request showed. In one transaction it checks every precondition that
 * lives in the store (binding, run ID, state, mode, request exists, no earlier approval, request
 * was delivered to Slack, not expired), inserts the approval with its invocation hash, and moves
 * `awaiting_approval -> queued_write`. All of it commits or none of it does, and `/cancel` racing
 * this call is a compare-and-swap on the same row, so exactly one wins.
 *
 * Whether edit mode is enabled (configuration, per-channel) is the caller's check, made first.
 */
export function approveRun(store: Store, binding: Binding, runId: string, options: { readonly repoRoot: string }): ApproveRunOutcome {
  if (invalidBindingField(binding) || !isRunId(runId) || typeof options.repoRoot !== "string" || options.repoRoot.length === 0) {
    return { ok: false, error: "invalid_input" };
  }

  return inTransaction(store, (): ApproveRunOutcome => {
    const run = findByBinding(store, binding);
    if (!run || run.id !== runId) return { ok: false, error: "not_found" };
    if (run.state !== "awaiting_approval") return { ok: false, error: "not_awaiting_approval" };
    if (run.mode !== "edit") return { ok: false, error: "not_edit_mode" };
    const request = readEditRequest(store, run.id);
    if (!request) return { ok: false, error: "no_request" };
    if (store.db.prepare("SELECT 1 AS x FROM approvals WHERE run_id = ?").get(run.id)) return { ok: false, error: "already_approved" };
    // An outbox message can fail after its retries; approving something the user never saw must be impossible.
    const message = store.db.prepare("SELECT status FROM outbox_messages WHERE id = ?").get(request.requestMessageId);
    if (message?.["status"] !== "sent") return { ok: false, error: "not_delivered" };
    const now = timestamp(store);
    if (now >= request.expiresAt) return { ok: false, error: "expired" };

    const hash = invocationSha256({
      runId: run.id,
      provider: run.provider,
      profile: run.profile,
      mode: run.mode,
      prompt: run.prompt,
      baseSha: request.baseSha,
      repoRoot: options.repoRoot,
    });
    store.db
      .prepare("INSERT INTO approvals (run_id, approved_by_user_id, run_state, approved_at, invocation_sha256) VALUES (?, ?, ?, ?, ?)")
      .run(run.id, binding.userId, run.state, now, hash);
    insertEvent(store, run.id, "approval_recorded", run.state, run.state, now);
    const moved = applyTransition(store, run, "queued_write", now, true);
    if (!moved.ok) throw new StoreError("corrupt_row", "an awaiting_approval edit run could not move to queued_write");
    return {
      ok: true,
      run: moved.run,
      approval: { runId: run.id, approvedByUserId: binding.userId, runState: run.state, approvedAt: now, invocationSha256: hash },
    };
  });
}

function readEditRequest(store: Store, runId: string): EditRequest | null {
  const row = store.db.prepare("SELECT * FROM edit_requests WHERE run_id = ?").get(runId);
  if (!row) return null;
  return {
    runId: text(row, "run_id"),
    baseSha: text(row, "base_sha"),
    requestedAt: int(row, "requested_at"),
    expiresAt: int(row, "expires_at"),
    requestMessageId: int(row, "request_message_id"),
  };
}

/** The recorded approval request for a run. Null for malformed input, any binding mismatch, or no request. */
export function getEditRequest(store: Store, binding: Binding): EditRequest | null {
  const run = getRun(store, binding);
  return run ? readEditRequest(store, run.id) : null;
}

export interface ExpireOptions {
  /** How long an approved run may wait in `queued_write`, measured from the approval. */
  readonly queuedWriteTtlMs: number;
  /** Fixed notices posted to the thread. Never include prompt text or free-form detail. */
  readonly notices: { readonly awaitingApproval: string; readonly queuedWrite: string };
}

/**
 * Fail runs whose approval window has passed: `awaiting_approval` past the request's expiry, and
 * `queued_write` older than `queuedWriteTtlMs` since the approval. An expired run cannot be revived.
 * Each failure also fails the run's still-pending messages (an undelivered request must not appear
 * after the run is dead) and queues one fixed notice, atomically. Safe to call repeatedly; at most
 * 100 runs per call. Returns the runs that were failed.
 */
export function expireStaleApprovals(store: Store, options: ExpireOptions): Run[] {
  const { queuedWriteTtlMs, notices } = options;
  if (!Number.isSafeInteger(queuedWriteTtlMs) || queuedWriteTtlMs < 1) throw new RangeError("queuedWriteTtlMs must be a positive integer");
  for (const notice of [notices.awaitingApproval, notices.queuedWrite]) {
    if (notice.length === 0 || notice.length > MAX_OUTBOX_BODY_LENGTH) throw new RangeError("expiry notices must be 1 to 3000 characters");
  }

  return inTransaction(store, (): Run[] => {
    const now = timestamp(store);
    const due = store.db
      .prepare(
        `SELECT r.*, 'a' AS why FROM runs r JOIN edit_requests e ON e.run_id = r.id
           WHERE r.state = 'awaiting_approval' AND e.expires_at <= ?1
         UNION ALL
         SELECT r.*, 'q' AS why FROM runs r JOIN approvals a ON a.run_id = r.id
           WHERE r.state = 'queued_write' AND a.approved_at + ?2 <= ?1
         ORDER BY created_at, id LIMIT 100`,
      )
      .all(now, queuedWriteTtlMs);
    const failed: Run[] = [];
    for (const row of due) {
      const run = rowToRun(row);
      const moved = applyTransition(store, run, "failed", now);
      if (!moved.ok) continue;
      failPendingMessages(store, run.id, "approval expired", now);
      insertMessage(store, run.id, row["why"] === "a" ? notices.awaitingApproval : notices.queuedWrite, now);
      failed.push(moved.run);
    }
    return failed;
  });
}

/**
 * Record that the bound user approved this run, once, and only while it is `awaiting_approval`.
 * A premature approval would otherwise be stored and then block the real one. This only stores
 * the fact: it does not move the run to `queued_write` or unlock anything (that is a later issue).
 */
export function recordApproval(store: Store, binding: Binding, runId: string): ApprovalOutcome {
  if (invalidBindingField(binding) || !isRunId(runId)) return { ok: false, error: "invalid_input" };

  return inTransaction(store, (): ApprovalOutcome => {
    const run = findByBinding(store, binding);
    if (!run || run.id !== runId) return { ok: false, error: "not_found" };
    if (run.state !== "awaiting_approval") return { ok: false, error: "not_awaiting_approval" };
    if (store.db.prepare("SELECT 1 AS x FROM approvals WHERE run_id = ?").get(run.id)) return { ok: false, error: "already_approved" };

    const now = timestamp(store);
    store.db
      .prepare("INSERT INTO approvals (run_id, approved_by_user_id, run_state, approved_at) VALUES (?, ?, ?, ?)")
      .run(run.id, binding.userId, run.state, now);
    insertEvent(store, run.id, "approval_recorded", run.state, run.state, now);
    return { ok: true, approval: { runId: run.id, approvedByUserId: binding.userId, runState: run.state, approvedAt: now, invocationSha256: null } };
  });
}

export function getApproval(store: Store, binding: Binding): Approval | null {
  const run = getRun(store, binding);
  if (!run) return null;
  const row = store.db.prepare("SELECT * FROM approvals WHERE run_id = ?").get(run.id);
  if (!row) return null;
  return {
    runId: text(row, "run_id"),
    approvedByUserId: text(row, "approved_by_user_id"),
    runState: stateOf(text(row, "run_state")),
    approvedAt: int(row, "approved_at"),
    invocationSha256: row["invocation_sha256"] === null ? null : text(row, "invocation_sha256"),
  };
}

/** Audit trail for a run, oldest first. Empty for malformed input or any binding mismatch. */
export function listRunEvents(store: Store, binding: Binding): RunEvent[] {
  const run = getRun(store, binding);
  if (!run) return [];
  return store.db
    .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY id")
    .all(run.id)
    .map((row) => ({
      id: int(row, "id"),
      runId: text(row, "run_id"),
      type: text(row, "type") as RunEvent["type"], // constrained by a CHECK in the schema
      fromState: row["from_state"] === null ? null : stateOf(text(row, "from_state")),
      toState: row["to_state"] === null ? null : stateOf(text(row, "to_state")),
      createdAt: int(row, "created_at"),
    }));
}

