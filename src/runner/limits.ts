/** Wall-clock limit for one run, unless `RUNNER_TIMEOUT_SECONDS` says otherwise (10 to 3600 seconds). */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const MIN_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 60 * 60_000;

/**
 * Most stdout bytes kept per run. Reading stops here: the child is killed and the output is marked
 * truncated. Sized so the result always fits the outbox: `splitMessage` packs lines greedily, so
 * two neighbouring parts always exceed the part limit together, which bounds a body of L characters
 * to at most 2L/3000 + 1 parts. 28,000 gives at most 19, under `MAX_OUTBOX_PARTS` (20). One byte is
 * never fewer than one character, so the byte cap also caps the character count.
 */
export const MAX_OUTPUT_BYTES = 28_000;

/** How often a running child is checked against its run's state, so /cancel reaches the process. */
export const CANCEL_POLL_MS = 500;

/** After SIGTERM to the process group, how long before SIGKILL. */
export const KILL_GRACE_MS = 2_000;
