import type { EditConfig } from "../runner/config.js";
import { APPROVE_HINTS, approvalRequestBody, approvedBody, refusalBody, type EditRefusal } from "../runner/messages.js";
import { branchFor, worktreePathFor } from "../runner/worktree-names.js";
import { approveRun, enqueueMessage, getRun, requestApproval, transitionRun, type Binding, type Run, type Store } from "../store/index.js";

/** What ingress needs to take part in the edit flow. Absent means edit tasks are refused everywhere. */
export interface EditIngress {
  readonly config: EditConfig;
  readonly repoRoot: string;
  /** The commit an edit run will start from. Null if it cannot be read safely. */
  readonly readBaseSha: (repoRoot: string) => string | null;
}

const editAllowedIn = (edit: EditIngress | undefined, channelId: string): edit is EditIngress => edit !== undefined && edit.config.channelIds.has(channelId);

/**
 * Take an edit-mode run from `received` or `validated` to `awaiting_approval` with its approval
 * request queued (one atomic step), or refuse it with a fixed reason and fail it. Safe to call again
 * for a redelivered event: a run already past `validated` is left alone. Nothing here runs anything.
 */
export function startEditRun(store: Store, edit: EditIngress | undefined, run: Run): string {
  let state = run.state;
  if (state === "received") {
    if (!transitionRun(store, run, "received", "validated").ok) return "edit_noop";
    state = "validated";
  }
  if (state !== "validated") return "edit_noop";

  const refuse = (reason: EditRefusal): string => {
    if (transitionRun(store, run, "validated", "failed").ok) enqueueMessage(store, run.id, refusalBody(run.id, reason));
    return `edit_refused:${reason}`;
  };

  if (edit === undefined) return refuse("disabled");
  if (!editAllowedIn(edit, run.channelId)) return refuse("channel");
  if (run.provider !== "codex") return refuse("provider");
  const baseSha = edit.readBaseSha(edit.repoRoot);
  if (baseSha === null) return refuse("no_commit");

  const requested = requestApproval(store, run, run.id, {
    baseSha,
    ttlMs: edit.config.approvalTtlMs,
    body: (expiresAt) =>
      approvalRequestBody({
        runId: run.id,
        provider: run.provider,
        profile: run.profile,
        prompt: run.prompt,
        worktreePath: worktreePathFor(edit.config.worktreeRoot, run.id),
        branch: branchFor(run.id),
        baseSha,
        expiresAt,
      }),
  });
  return requested.ok ? "edit_requested" : refuse("request_failed");
}

/**
 * `/approve <run-id>`. Only the bound sender can get here (ingress authorizes first), so a failure
 * is explained with a fixed hint in the run's own thread. A thread with no run gets no reply: the
 * outbox can only speak for a run.
 */
export function applyApprove(store: Store, edit: EditIngress | undefined, binding: Binding, runId: string): string {
  const run = getRun(store, binding);
  if (!run) return "approve_no_run";
  const say = (text: string): void => void enqueueMessage(store, run.id, text);

  if (run.id !== runId) {
    say(APPROVE_HINTS.run_mismatch(run.id));
    return "approve_refused:run_mismatch";
  }
  if (!editAllowedIn(edit, run.channelId)) {
    say(APPROVE_HINTS.edit_disabled(run.id));
    return "approve_refused:edit_disabled";
  }

  const result = approveRun(store, binding, runId, { repoRoot: edit.repoRoot });
  if (result.ok) {
    say(approvedBody(run.id));
    return "approved";
  }
  switch (result.error) {
    case "not_awaiting_approval":
      say(APPROVE_HINTS.not_awaiting_approval(run.id, run.state));
      break;
    case "not_edit_mode":
    case "no_request":
      say(APPROVE_HINTS.not_edit_mode(run.id));
      break;
    case "not_delivered":
      say(APPROVE_HINTS.not_delivered(run.id));
      break;
    case "expired":
      say(APPROVE_HINTS.expired(run.id));
      break;
    case "already_approved":
      say(APPROVE_HINTS.already_approved(run.id));
      break;
    case "write_slot_busy":
      say(APPROVE_HINTS.write_slot_busy(run.id));
      break;
    default:
      return `approve_refused:${result.error}`; // invalid_input / not_found: nothing sensible to say
  }
  return `approve_refused:${result.error}`;
}
