import { getRun, transitionRun, enqueueMessage, type Binding, type Store } from "../store/index.js";

const MAX_CANCEL_ATTEMPTS = 3;

/**
 * `/status`: queue a one-line reply for the run bound to exactly this team, user, channel and root
 * thread. Any mismatch, or no run, is a quiet no-op. The reply names the run ID and state only.
 */
export function applyStatus(store: Store, binding: Binding): string {
  const run = getRun(store, binding);
  if (!run) return "status_no_run";
  const queued = enqueueMessage(store, run.id, `Run ${run.id} is ${run.state}.`);
  return queued.ok ? "status_replied" : `status_noop:${queued.error}`;
}

/**
 * `/cancel`: cancel the run bound to exactly this binding. The store queues the single
 * cancellation acknowledgement itself, so no reply is enqueued here.
 *
 * A retried cancel finds the run already `cancelled` and `transitionRun` refuses, which is a quiet
 * no-op. A `stale_state` from a race (the run moved between read and write) is retried a few times
 * against the fresh state; a run that is already terminal is never "cancelled again".
 */
export function applyCancel(store: Store, binding: Binding): string {
  for (let attempt = 0; attempt < MAX_CANCEL_ATTEMPTS; attempt++) {
    const run = getRun(store, binding);
    if (!run) return "cancel_no_run";
    const result = transitionRun(store, binding, run.state, "cancelled");
    if (result.ok) return "cancelled";
    if (result.error !== "stale_state") return `cancel_noop:${result.error}`;
  }
  return "cancel_noop:stale_state";
}
