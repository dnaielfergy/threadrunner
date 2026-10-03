import { claimMessage, listPendingMessages, markSent, recordFailedAttempt, type OutboxFailureReason, type OutboxMessage, type Store } from "../store/index.js";
import { buildPostRequest } from "./format.js";
import type { Logger } from "./log.js";
import type { PostResult, SlackApi } from "./transport.js";

export interface SenderDeps {
  readonly store: Store;
  readonly api: SlackApi;
  /** The only workspace this bot may post to. */
  readonly teamId: string;
  readonly log: Logger;
  /** Epoch milliseconds. Injected for tests. */
  readonly now: () => number;
  /** Largest escaped message to post. Defaults to Slack's plain-text limit. */
  readonly textLimit?: number;
}

export interface DrainResult {
  readonly sent: number;
  /** Failures that consumed a delivery attempt (or ended the message). */
  readonly failed: number;
  /** Network or rate-limit failures held back for a later try without consuming an attempt. */
  readonly deferred: number;
  readonly skipped: number;
}

export interface Sender {
  /** One pass over the outbox. Passes never overlap: a call during a pass waits for it, then runs again. */
  drain(): Promise<DrainResult>;
  start(intervalMs: number): void;
  /** Stop scheduling, finish the message being posted (including `markSent`), and resolve. Later drains do nothing. */
  stop(): Promise<void>;
}

const BATCH = 10;
const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 2000;
/** How long a message may keep failing for network or rate-limit reasons before those failures start counting as attempts. */
export const TRANSIENT_BUDGET_MS = 30 * 60_000;
const MAX_TRANSIENT_BACKOFF_MS = 5 * 60_000;
const MAX_RETRY_AFTER_MS = 15 * 60_000;
const PERMANENT_STEP_LIMIT = 100;

const EMPTY: DrainResult = { sent: 0, failed: 0, deferred: 0, skipped: 0 };

/**
 * Single-process outbox sender. For each deliverable message: `claimMessage` immediately before
 * the post, post, then `markSent`; on failure `recordFailedAttempt` with a fixed reason code.
 * The destination comes only from the claimed message (the run's stored binding).
 *
 * Failures are treated by cause. `network` and `rate_limited` mean "Slack is unreachable or busy",
 * not "this message is bad", so for up to `TRANSIENT_BUDGET_MS` they only delay the next try
 * (exponential, capped at 5 minutes, and at least Slack's `Retry-After`) and do not use up the
 * store's attempt limit. A laptop that sleeps or loses Wi-Fi therefore still delivers its
 * acknowledgement when it reconnects, even across a restart (the message stays pending). Other
 * failures use an attempt each. A message that can never succeed (wrong workspace, escaped body
 * too large) is failed immediately.
 *
 * Delivery is at-least-once: a crash between posting and `markSent` can post that message again
 * (see `claimMessage`).
 */
export function createSender(deps: SenderDeps): Sender {
  const { store, api, log } = deps;
  const notBefore = new Map<number, number>();
  const transient = new Map<number, { since: number; count: number }>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<DrainResult> | null = null;
  let rerun = false;
  let stopped = false;

  const forget = (messageId: number): void => {
    notBefore.delete(messageId);
    transient.delete(messageId);
  };

  /** Fail a message that can never succeed, now, using only the store's attempt counter. */
  const failPermanently = (messageId: number, reason: OutboxFailureReason): void => {
    for (let step = 0; step < PERMANENT_STEP_LIMIT; step++) {
      const outcome = recordFailedAttempt(store, messageId, reason);
      if (!outcome.ok || outcome.status === "failed") break;
    }
    forget(messageId);
    log({ level: "warn", code: `send_failed:${reason}`, messageId });
  };

  /** Returns "deferred" if the failure did not use an attempt, else "failed". */
  const handleFailure = (message: OutboxMessage, result: Extract<PostResult, { ok: false }>): "deferred" | "failed" => {
    const now = deps.now();
    const { reason } = result;
    if (reason === "network" || reason === "rate_limited") {
      const state = transient.get(message.id) ?? { since: now, count: 0 };
      if (now - state.since < TRANSIENT_BUDGET_MS) {
        const count = state.count + 1;
        let delay = Math.min(MAX_TRANSIENT_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (count - 1));
        if (reason === "rate_limited" && result.retryAfterSeconds !== undefined) {
          delay = Math.max(delay, Math.min(MAX_RETRY_AFTER_MS, result.retryAfterSeconds * 1000));
        }
        transient.set(message.id, { since: state.since, count });
        notBefore.set(message.id, now + delay);
        log({ level: "warn", code: `send_deferred:${reason}`, messageId: message.id });
        return "deferred";
      }
      transient.set(message.id, state); // budget spent: from here each failure uses an attempt
    }
    const outcome = recordFailedAttempt(store, message.id, reason);
    log({ level: "warn", code: `send_failed:${reason}`, messageId: message.id });
    if (outcome.ok && outcome.status === "pending") {
      notBefore.set(message.id, now + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (message.attempts + 1)));
    } else {
      forget(message.id);
    }
    return "failed";
  };

  async function pass(): Promise<DrainResult> {
    let sent = 0;
    let failed = 0;
    let deferred = 0;
    let skipped = 0;
    for (const listed of listPendingMessages(store, BATCH)) {
      if (stopped) break;
      if ((notBefore.get(listed.id) ?? 0) > deps.now()) {
        skipped++;
        continue;
      }
      // Listing is not permission to send: re-check immediately before posting.
      const claim = claimMessage(store, listed.id);
      if (!claim.ok) {
        log({ level: "info", code: `claim_refused:${claim.error}`, messageId: listed.id });
        forget(listed.id);
        skipped++;
        continue;
      }
      const { message } = claim;
      if (message.destination.teamId !== deps.teamId) {
        failPermanently(message.id, "unknown");
        failed++;
        continue;
      }
      const request = buildPostRequest(message.destination, message.body, deps.textLimit);
      if (request === null) {
        failPermanently(message.id, "unknown");
        failed++;
        continue;
      }
      let result: PostResult;
      try {
        result = await api.postMessage(request);
      } catch {
        result = { ok: false, reason: "unknown" };
      }
      if (result.ok) {
        if (!markSent(store, message.id).ok) log({ level: "error", code: "mark_sent_failed", messageId: message.id });
        forget(message.id);
        sent++;
      } else if (handleFailure(message, result) === "deferred") {
        deferred++;
      } else {
        failed++;
      }
    }
    return { sent, failed, deferred, skipped };
  }

  function drain(): Promise<DrainResult> {
    if (stopped) return Promise.resolve(EMPTY);
    if (inFlight) {
      rerun = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        let result = await pass();
        while (rerun && !stopped) {
          rerun = false;
          result = await pass();
        }
        return result;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  const safeDrain = (): void => {
    drain().catch(() => log({ level: "error", code: "drain_failed" }));
  };

  return {
    drain,
    start(intervalMs) {
      if (timer || stopped) return;
      timer = setInterval(safeDrain, intervalMs);
      timer.unref();
      safeDrain();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      try {
        await inFlight;
      } catch {
        // Already reported as drain_failed by whoever started that pass.
      }
    },
  };
}
