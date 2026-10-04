import { lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isTerminal } from "../domain/run-state.js";
import {
  countRetainedWorktrees,
  getApproval,
  getEditRequest,
  getWorktree,
  invocationSha256,
  markWorktreeRemoved,
  recordWorktree,
  type Run,
  type Store,
} from "../store/index.js";
import { findRunById } from "../store/runs.js";
import type { ChangeSummary, Git } from "./git.js";
import { branchFor, worktreePathFor } from "./worktree-names.js";

export interface WorktreeDeps {
  readonly store: Store;
  readonly git: Git;
  /** Canonical repository root from configuration. */
  readonly repoRoot: string;
  /** Canonical, private directory that holds one worktree per edit run. */
  readonly worktreeRoot: string;
  readonly maxRetained: number;
}

export type CreateWorktreeError =
  | "not_edit_run"
  | "wrong_state"
  | "no_approval"
  | "approval_mismatch"
  | "cap_reached"
  | "root_changed"
  | "path_exists"
  | "base_missing"
  | "git_failed"
  | "verify_failed"
  | "record_failed";

export type CreateWorktreeOutcome =
  | { readonly ok: true; readonly path: string; readonly branch: string; readonly baseSha: string }
  | { readonly ok: false; readonly error: CreateWorktreeError };

const kind = (path: string): "dir" | "symlink" | "other" | "missing" => {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return "symlink";
    return stat.isDirectory() ? "dir" : "other";
  } catch {
    return "missing";
  }
};

const realOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/** The repository's own `.git` must be a plain directory, and the worktree root must still be what it was at startup. */
function environmentIsSane(deps: WorktreeDeps): boolean {
  return kind(join(deps.repoRoot, ".git")) === "dir" && kind(deps.worktreeRoot) === "dir" && realOrNull(deps.worktreeRoot) === deps.worktreeRoot;
}

/**
 * The linked worktree's administrative directory, if and only if the main repository's own records
 * agree it belongs to this path. That backlink lives in the main `.git`, which the sandboxed
 * process cannot write, so it is trusted where the `.git` pointer file inside the worktree is not.
 */
function trustedGitDir(deps: WorktreeDeps, runId: string, path: string): string | null {
  const admin = join(deps.repoRoot, ".git", "worktrees", runId);
  if (kind(admin) !== "dir") return null;
  try {
    return readFileSync(join(admin, "gitdir"), "utf8").trim() === join(path, ".git") ? admin : null;
  } catch {
    return null;
  }
}

/** The path must be exactly `<worktreeRoot>/<run-id>`: a real directory, not a link, not somewhere else. */
function pathIsExactlyOurs(deps: WorktreeDeps, runId: string, path: string): boolean {
  return path === worktreePathFor(deps.worktreeRoot, runId) && kind(path) === "dir" && realOrNull(path) === path;
}

/**
 * Create the disposable worktree for an approved edit run, cut from the base commit recorded with
 * the approval request. Refuses unless the run is `queued_write`, the approval is on record and
 * still matches the run, the retained-worktree cap allows it, and nothing exists at the path.
 * Nothing is reused: an existing path is an error. On any failure after git ran, the half-made
 * worktree is cleaned up. Nothing here starts Codex.
 */
export async function createWorktree(deps: WorktreeDeps, run: Run): Promise<CreateWorktreeOutcome> {
  const { store, git } = deps;
  const current = findRunById(store, run.id);
  if (!current || current.mode !== "edit") return { ok: false, error: "not_edit_run" };
  if (current.state !== "queued_write") return { ok: false, error: "wrong_state" };

  const request = getEditRequest(store, current);
  const approval = getApproval(store, current);
  if (!request || !approval || approval.invocationSha256 === null) return { ok: false, error: "no_approval" };
  const expected = invocationSha256({
    runId: current.id,
    provider: current.provider,
    profile: current.profile,
    mode: current.mode,
    prompt: current.prompt,
    baseSha: request.baseSha,
    repoRoot: deps.repoRoot,
  });
  if (expected !== approval.invocationSha256) return { ok: false, error: "approval_mismatch" };

  if (countRetainedWorktrees(store) >= deps.maxRetained) return { ok: false, error: "cap_reached" };
  if (!environmentIsSane(deps)) return { ok: false, error: "root_changed" };

  const path = worktreePathFor(deps.worktreeRoot, current.id);
  const branch = branchFor(current.id);
  if (kind(path) !== "missing") return { ok: false, error: "path_exists" };
  if (!(await git.commitExists(deps.repoRoot, request.baseSha))) return { ok: false, error: "base_missing" };

  const added = await git.addWorktree(deps.repoRoot, { path, branch, baseSha: request.baseSha });
  const undo = async (error: CreateWorktreeError): Promise<CreateWorktreeOutcome> => {
    await discard(deps, current.id, path, branch);
    return { ok: false, error };
  };
  if (!added.ok) return undo("git_failed");

  // What git made must be exactly what we asked for before anything is recorded or run in it.
  const pointer = kind(join(path, ".git"));
  if (!pathIsExactlyOurs(deps, current.id, path) || pointer === "dir" || pointer === "symlink" || pointer === "missing") return undo("verify_failed");
  if (trustedGitDir(deps, current.id, path) === null) return undo("verify_failed");

  if (!recordWorktree(store, current.id, { path, branch, baseSha: request.baseSha }).ok) return undo("record_failed");
  return { ok: true, path, branch, baseSha: request.baseSha };
}

/** Best-effort removal of something this module just made. Only ever touches the run-ID-derived path. */
async function discard(deps: WorktreeDeps, runId: string, path: string, branch: string): Promise<void> {
  if (path !== worktreePathFor(deps.worktreeRoot, runId) || kind(path) !== "dir" || realOrNull(path) !== path) {
    await deps.git.pruneWorktrees(deps.repoRoot);
    return;
  }
  const removed = await deps.git.removeWorktree(deps.repoRoot, path);
  if (!removed.ok) rmSync(path, { recursive: true, force: true });
  await deps.git.pruneWorktrees(deps.repoRoot);
  await deps.git.deleteBranch(deps.repoRoot, branch);
}

export type SummarizeOutcome =
  | { readonly ok: true; readonly summary: ChangeSummary }
  | { readonly ok: false; readonly error: "no_worktree" | "worktree_invalid" | "git_failed" };

/**
 * What changed in the run's worktree, computed by the bridge (names and counts only, never file
 * contents). The git directory comes from the main repository's own records, so a worktree whose
 * `.git` pointer file was rewritten cannot redirect it, and the commands are the hardened ones in git.ts.
 */
export async function summarizeWorktree(deps: WorktreeDeps, runId: string): Promise<SummarizeOutcome> {
  const row = getWorktree(deps.store, runId);
  if (!row || row.removedAt !== null) return { ok: false, error: "no_worktree" };
  if (!environmentIsSane(deps) || !pathIsExactlyOurs(deps, runId, row.path) || row.branch !== branchFor(runId)) return { ok: false, error: "worktree_invalid" };
  const gitDir = trustedGitDir(deps, runId, row.path);
  if (gitDir === null) return { ok: false, error: "worktree_invalid" };
  const summary = await deps.git.summarizeChanges({ gitDir, path: row.path, baseSha: row.baseSha });
  return summary ? { ok: true, summary } : { ok: false, error: "git_failed" };
}

export type RemoveWorktreeError = "no_worktree" | "run_not_finished" | "not_validated" | "remove_failed";
export type RemoveWorktreeOutcome =
  | { readonly ok: true; readonly alreadyGone: boolean; readonly branchDeleted: boolean }
  | { readonly ok: false; readonly error: RemoveWorktreeError };

/**
 * Remove a finished run's worktree and branch. It touches a directory only if all of these hold
 * (docs/design/approvals-and-worktrees.md, 6.7): the run is finished; the recorded path and branch
 * are exactly the ones derived from the run ID; the path is a real directory (not a symlink)
 * directly under the worktree root; the main repository's own records agree the worktree is
 * there; and git lists it as registered. Anything else is left alone and reported, never deleted.
 *
 * `git worktree remove` refuses a worktree whose `.git` file was overwritten. In that case, and only
 * after every check above passed, the validated directory is deleted by the bridge (links inside
 * are unlinked, never followed) and git's registration is pruned.
 */
export async function removeWorktree(deps: WorktreeDeps, runId: string): Promise<RemoveWorktreeOutcome> {
  const { store, git } = deps;
  const row = getWorktree(store, runId);
  const run = findRunById(store, runId);
  if (!row || !run) return { ok: false, error: "no_worktree" };
  if (row.removedAt !== null) return { ok: true, alreadyGone: true, branchDeleted: true };
  if (!isTerminal(run.state)) return { ok: false, error: "run_not_finished" };

  const path = worktreePathFor(deps.worktreeRoot, runId);
  const branch = branchFor(runId);
  if (row.path !== path || row.branch !== branch || !environmentIsSane(deps)) return { ok: false, error: "not_validated" };

  const present = kind(path);
  let alreadyGone = false;
  if (present === "missing") {
    alreadyGone = true;
  } else {
    if (!pathIsExactlyOurs(deps, runId, path) || trustedGitDir(deps, runId, path) === null) return { ok: false, error: "not_validated" };
    const listed = await git.listWorktrees(deps.repoRoot);
    if (listed === null || !listed.includes(path)) return { ok: false, error: "not_validated" };
    const removed = await git.removeWorktree(deps.repoRoot, path);
    if (!removed.ok) rmSync(path, { recursive: true, force: true });
  }

  await git.pruneWorktrees(deps.repoRoot);
  const after = await git.listWorktrees(deps.repoRoot);
  if (kind(path) !== "missing" || after === null || after.includes(path)) return { ok: false, error: "remove_failed" };

  const branchDeleted = (await git.deleteBranch(deps.repoRoot, branch)).ok;
  markWorktreeRemoved(store, runId);
  return { ok: true, alreadyGone, branchDeleted };
}
