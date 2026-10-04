import { transition, type RunState } from "../domain/run-state.js";
import type { ModelProfile, Provider } from "../domain/types.js";
import { RUN_ID_PATTERN } from "../parser/command.js";
import { inTransaction, int, text, timestamp, type Row, type Store } from "./database.js";
import { StoreError } from "./errors.js";
import { CANCEL_ACK_BODY, failPendingMessages, insertCancelAck } from "./outbox.js";
import { invalidBindingField, invalidNewRunField, isRunId, isRunState, type Binding, type NewRunInput } from "./validate.js";

export interface Run extends Binding {
  readonly id: string;
  readonly provider: Provider;
  readonly profile: ModelProfile;
  /** Stored once, for the runner. Never copied into run events, outbox messages, or logs. */
  readonly prompt: string;
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
export type TransitionError = RunError | "stale_state" | "illegal_transition";
export type TransitionOutcome = { readonly ok: true; readonly run: Run } | { readonly ok: false; readonly error: TransitionError };
export type ApprovalOutcome =
  | { readonly ok: true; readonly approval: Approval }
  | { readonly ok: false; readonly error: RunError | "not_awaiting_approval" | "already_approved" };

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
    store.db
      .prepare(
        `INSERT INTO runs (id, team_id, user_id, channel_id, root_thread_ts, provider, profile, prompt, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.teamId, input.userId, input.channelId, input.rootThreadTs, input.provider, input.profile, input.prompt, state, now, now);
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
        state,
        createdAt: now,
        updatedAt: now,
      },
    };
  });
}

/**
 * The only way to change a run's state. The caller presents the full binding and the state it
 * believes the run is in; the update applies only if the run is still in that state
 * (compare-and-swap) and `transition()` allows the move. Cancelling also queues the single
 * cancellation acknowledgement and fails any other pending outbound messages, atomically.
 */
export function transitionRun(store: Store, binding: Binding, expected: RunState, to: RunState): TransitionOutcome {
  if (invalidBindingField(binding) || !isRunState(expected) || !isRunState(to)) return { ok: false, error: "invalid_input" };

  return inTransaction(store, (): TransitionOutcome => {
    const run = findByBinding(store, binding);
    if (!run) return { ok: false, error: "not_found" };
    if (run.state !== expected) return { ok: false, error: "stale_state" };
    if (!transition(expected, to).ok) return { ok: false, error: "illegal_transition" };

    const now = timestamp(store);
    const result = store.db.prepare("UPDATE runs SET state = ?, updated_at = ? WHERE id = ? AND state = ?").run(to, now, run.id, expected);
    if (result.changes !== 1) return { ok: false, error: "stale_state" };
    insertEvent(store, run.id, "transition", expected, to, now);
    if (to === "cancelled") {
      failPendingMessages(store, run.id, "run cancelled", now);
      insertCancelAck(store, run.id, CANCEL_ACK_BODY, now);
    }
    return { ok: true, run: { ...run, state: to, updatedAt: now } };
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
    return { ok: true, approval: { runId: run.id, approvedByUserId: binding.userId, runState: run.state, approvedAt: now } };
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

