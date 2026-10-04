import { inTransaction, int, nullableInt, text, timestamp, type Row, type Store } from "./database.js";
import { findRunById } from "./runs.js";
import { isCommitSha, isRunId } from "./validate.js";

export interface Worktree {
  readonly runId: string;
  readonly path: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly createdAt: number;
  /** Null while the worktree is retained. Set once, when the cleanup removed it. */
  readonly removedAt: number | null;
}

export type RecordWorktreeOutcome =
  | { readonly ok: true; readonly worktree: Worktree }
  | { readonly ok: false; readonly error: "invalid_input" | "not_found" | "not_edit_run" | "wrong_state" | "already_recorded" };

function rowToWorktree(row: Row): Worktree {
  return {
    runId: text(row, "run_id"),
    path: text(row, "path"),
    branch: text(row, "branch"),
    baseSha: text(row, "base_sha"),
    createdAt: int(row, "created_at"),
    removedAt: nullableInt(row, "removed_at"),
  };
}

/**
 * Record the worktree made for an approved edit run. Only an edit run that is `queued_write` or
 * `running_write` can have one, and the database additionally refuses it without a recorded
 * approval. The path and branch are stored as given: the caller derives them from the run ID.
 */
export function recordWorktree(store: Store, runId: string, input: { path: string; branch: string; baseSha: string }): RecordWorktreeOutcome {
  if (!isRunId(runId) || !isCommitSha(input.baseSha) || input.path.length === 0 || input.branch.length === 0) return { ok: false, error: "invalid_input" };
  return inTransaction(store, (): RecordWorktreeOutcome => {
    const run = findRunById(store, runId);
    if (!run) return { ok: false, error: "not_found" };
    if (run.mode !== "edit") return { ok: false, error: "not_edit_run" };
    if (run.state !== "queued_write" && run.state !== "running_write") return { ok: false, error: "wrong_state" };
    if (store.db.prepare("SELECT 1 AS x FROM worktrees WHERE run_id = ?").get(runId)) return { ok: false, error: "already_recorded" };
    const now = timestamp(store);
    store.db
      .prepare("INSERT INTO worktrees (run_id, path, branch, base_sha, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, input.path, input.branch, input.baseSha, now);
    return { ok: true, worktree: { runId, ...input, createdAt: now, removedAt: null } };
  });
}

export function getWorktree(store: Store, runId: string): Worktree | null {
  if (!isRunId(runId)) return null;
  const row = store.db.prepare("SELECT * FROM worktrees WHERE run_id = ?").get(runId);
  return row ? rowToWorktree(row) : null;
}

/** Worktrees that still exist on disk (as far as the database knows), oldest first. */
export function listRetainedWorktrees(store: Store, limit = 100): Worktree[] {
  const bounded = Number.isInteger(limit) && limit >= 1 && limit <= 1000 ? limit : 100;
  return store.db.prepare("SELECT * FROM worktrees WHERE removed_at IS NULL ORDER BY created_at, run_id LIMIT ?").all(bounded).map(rowToWorktree);
}

export function countRetainedWorktrees(store: Store): number {
  return Number(store.db.prepare("SELECT count(*) AS n FROM worktrees WHERE removed_at IS NULL").get()?.["n"] ?? 0);
}

/** Idempotent. The database allows the removal time to be set once. */
export function markWorktreeRemoved(store: Store, runId: string): boolean {
  if (!isRunId(runId)) return false;
  return inTransaction(store, () => {
    const row = store.db.prepare("SELECT removed_at FROM worktrees WHERE run_id = ?").get(runId);
    if (!row) return false;
    if (row["removed_at"] !== null) return true;
    store.db.prepare("UPDATE worktrees SET removed_at = ? WHERE run_id = ?").run(timestamp(store), runId);
    return true;
  });
}
