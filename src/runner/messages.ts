/**
 * Everything the runner says in Slack is built here. The only variable parts are the run ID
 * (bridge-generated) and the child's stdout, which is untrusted: it is stored verbatim and the
 * sender escapes it (store/outbox.ts, SECURITY note). The prompt and standard error never appear.
 */
export const FAILURE_REASONS = [
  "provider_unsupported",
  "not_authorized",
  "repo_root_changed",
  "invocation_invalid",
  "spawn_failed",
  "timeout",
  "output_limit",
  "nonzero_exit",
  "signalled",
  "shutdown",
  "restarted",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

const REASON_TEXT: Readonly<Record<FailureReason, string>> = {
  provider_unsupported: "only /codex runs are supported in this version. Start a new top-level message with /codex.",
  not_authorized: "this run is not authorized to execute.",
  repo_root_changed: "the configured repository folder changed after startup, so nothing was run.",
  invocation_invalid: "the provider command could not be built, so nothing was run.",
  spawn_failed: "the provider could not be started.",
  timeout: "it ran out of time and was stopped.",
  output_limit: "its output was too long and was cut off.",
  nonzero_exit: "the provider exited with an error.",
  signalled: "the provider was stopped unexpectedly.",
  shutdown: "the bridge shut down while it was running.",
  restarted: "the bridge restarted while it was running. It was not run again.",
};

/** Failures where whatever the child printed before it stopped is worth showing. */
const SHOWS_PARTIAL_OUTPUT: ReadonlySet<FailureReason> = new Set(["timeout", "output_limit", "nonzero_exit", "signalled"]);

export function completionBody(runId: string, output: string): string {
  const text = output.replaceAll("\u0000", "").trim();
  return text === "" ? `Run ${runId} completed with no output.` : `Run ${runId} completed.\n\n${text}`;
}

export function failureBody(runId: string, reason: FailureReason, partialOutput = ""): string {
  const head = `Run ${runId} failed: ${REASON_TEXT[reason]}`;
  const text = partialOutput.replaceAll("\u0000", "").trim();
  return SHOWS_PARTIAL_OUTPUT.has(reason) && text !== "" ? `${head}\n\nOutput before it stopped:\n${text}` : head;
}

// ---- Approval flow (edit tasks). Fixed templates: the only variable parts are bridge-derived fields and the user's own prompt. ----

export interface ApprovalRequestFields {
  readonly runId: string;
  readonly provider: string;
  readonly profile: string;
  readonly prompt: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly expiresAt: number;
}

/**
 * What the owner approves, in full: the run, the exact prompt, where edits will happen, the commit
 * they start from, what will not happen, when this expires, and the one command that approves it.
 * Plain text; the sender escapes it. The caller guarantees the prompt is at most 2,000 characters
 * (the parser's edit limit) and the worktree root at most 200, which keeps this under one message.
 */
export function approvalRequestBody(f: ApprovalRequestFields): string {
  return [
    `Run ${f.runId} wants to edit files. Nothing has changed yet.`,
    "",
    `Task (${f.provider}, ${f.profile}):`,
    f.prompt,
    "",
    "If you approve, edits happen only in a separate copy of the repository:",
    `Folder: ${f.worktreePath}`,
    `Branch: ${f.branch}`,
    `Starting from commit: ${f.baseSha}`,
    "Uncommitted changes in your own checkout are not included.",
    "",
    "Will not happen: no commit, no push, no pull request, no deploy.",
    `This request expires at ${new Date(f.expiresAt).toISOString()}.`,
    "",
    `To approve exactly this, reply in this thread: /approve ${f.runId}`,
    "To decline, reply /cancel or ignore this.",
  ].join("\n");
}

export const EDIT_REFUSALS = {
  disabled: "Edit tasks are not enabled on this bridge.",
  channel: "Edit tasks are not enabled in this channel.",
  provider: "Edit tasks are only supported with /codex. Start a new top-level message with /codex.",
  no_commit: "I could not read the repository's current commit (is it empty, or not a plain checkout?), so nothing was started.",
  request_failed: "I could not create the approval request, so nothing was started.",
} as const;
export type EditRefusal = keyof typeof EDIT_REFUSALS;

export const refusalBody = (runId: string, reason: EditRefusal): string => `Run ${runId} was not started: ${EDIT_REFUSALS[reason]}`;

/** Posted into the run's own thread, so they need no run ID. */
export const APPROVAL_EXPIRED_NOTICE = "The approval request expired and nothing was run. Start a new top-level message to try again.";
export const APPROVED_EXPIRED_NOTICE =
  "This was approved but did not start in time, so it was closed and nothing was run. Start a new top-level message to try again.";

export const approvedBody = (runId: string): string => `Approved ${runId}. It is queued. Reply /cancel to stop it.`;

/** Hints shown only to the authorized sender, in the run's own thread. */
export const APPROVE_HINTS = {
  run_mismatch: (shown: string) => `That is not this thread's run. This thread's run is ${shown}.`,
  not_awaiting_approval: (runId: string, state: string) => `Run ${runId} is not waiting for approval (it is ${state}).`,
  not_edit_mode: (runId: string) => `Run ${runId} is not an edit task, so there is nothing to approve.`,
  not_delivered: (runId: string) => `Run ${runId}: the approval request has not been shown in this thread yet. Try again once it appears.`,
  expired: (runId: string) => `Run ${runId}: the approval request has expired. Start a new top-level message to try again.`,
  already_approved: (runId: string) => `Run ${runId} was already approved.`,
  write_slot_busy: (runId: string) => `Run ${runId} could not be approved right now. Try again shortly.`,
  edit_disabled: (runId: string) => `Run ${runId}: edit tasks are not enabled here, so nothing can be approved.`,
} as const;
