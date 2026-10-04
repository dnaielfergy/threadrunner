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
