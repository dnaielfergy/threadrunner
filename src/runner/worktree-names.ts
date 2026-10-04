import { join } from "node:path";
import { RUN_ID_PATTERN } from "../parser/command.js";

/**
 * Where an edit run's worktree and branch will be. Both come only from the run ID, which the
 * bridge generated and which matches `RUN_ID_PATTERN` (lowercase letters, digits, one hyphen).
 * Nothing from Slack text or provider output ever reaches a path or a branch name.
 */
export function worktreePathFor(worktreeRoot: string, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new RangeError("not a run ID");
  return join(worktreeRoot, runId);
}

export function branchFor(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new RangeError("not a run ID");
  return `threadrunner/${runId}`;
}
