import { claimMessage, listPendingMessages, markSent, recordFailedAttempt, type OutboxFailureReason, type Store } from "../store/index.js";
import { buildPostRequest } from "./format.js";
import type { Logger } from "./log.js";
import type { SlackApi } from "./transport.js";

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
  readonly failed: number;
  readonly skipped: number;
}

export interface Sender {
  /** One pass over the outbox. Passes never overlap: a call during a pass waits for it, then runs again. */
  drain(): Promise<DrainResult>;
  start(intervalMs: number): void;
  stop(): void;
}

const BATCH = 10;
const MAX_BACKOFF_MS = 60_000;

/**
 * Single-process outbox sender. For each deliverable message: `claimMessage` immediately before
 * the post, post, then `markSent`; on failure `recordFailedAttempt` with a fixed reason code.
 * The destination comes only from the claimed message (the run's stored binding).
 *
 * Delivery is at-least-once: a crash between posting and `markSent` can post that message again
 * (see `claimMessage`). A failed message waits out an in-memory backoff before its next attempt.
 */
export function createSender(deps: SenderDeps): Sender {
  const { store, api, log } = deps;
  const notBefore = new Map<number, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<DrainResult> | null = null;
  let rerun = false;

  const fail = (messageId: number, reason: OutboxFailureReason, attempts: number): void => {
    recordFailedAttempt(store, messageId, reason);
    notBefore.set(messageId, deps.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts));
    log({ level: "warn", code: `send_failed:${reason}`, messageId });
  };

  async function pass(): Promise<DrainResult> {
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (const listed of listPendingMessages(store, BATCH)) {
      if ((notBefore.get(listed.id) ?? 0) > deps.now()) {
        skipped++;
        continue;
      }
      // Listing is not permission to send: re-check immediately before posting.
      const claim = claimMessage(store, listed.id);
      if (!claim.ok) {
        log({ level: "info", code: `claim_refused:${claim.error}`, messageId: listed.id });
        skipped++;
        continue;
      }
      const { message } = claim;
      if (message.destination.teamId !== deps.teamId) {
        fail(message.id, "unknown", message.attempts + 1);
        failed++;
        continue;
      }
      const request = buildPostRequest(message.destination, message.body, deps.textLimit);
      if (request === null) {
        fail(message.id, "unknown", message.attempts + 1);
        failed++;
        continue;
      }
      let result;
      try {
        result = await api.postMessage(request);
      } catch {
        result = { ok: false, reason: "unknown" } as const;
      }
      if (result.ok) {
        if (!markSent(store, message.id).ok) log({ level: "error", code: "mark_sent_failed", messageId: message.id });
        notBefore.delete(message.id);
        sent++;
      } else {
        fail(message.id, result.reason, message.attempts + 1);
        failed++;
      }
    }
    return { sent, failed, skipped };
  }

  function drain(): Promise<DrainResult> {
    if (inFlight) {
      rerun = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        let result = await pass();
        while (rerun) {
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
      if (timer) return;
      timer = setInterval(safeDrain, intervalMs);
      timer.unref();
      safeDrain();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
