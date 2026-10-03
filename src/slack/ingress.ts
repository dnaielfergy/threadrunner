import { parseCommand } from "../parser/command.js";
import type { RunState } from "../domain/run-state.js";
import { createRunFromEvent, enqueueMessage, getRun, transitionRun, type Binding, type Run, type Store } from "../store/index.js";
import { authorize } from "./authorize.js";
import { commandText } from "./command-text.js";
import type { AuthConfig } from "./config.js";
import { applyCancel, applyStatus } from "./control.js";
import { normalizeEventsApiBody } from "./event.js";
import { safeEventId, type Logger } from "./log.js";
import type { Envelope } from "./transport.js";

export interface IngressDeps {
  readonly store: Store;
  readonly auth: AuthConfig;
  /** This bot's own user ID, from `auth.test` at startup. Used only to strip a leading @mention. */
  readonly botUserId: string;
  readonly log: Logger;
  /** Called after something was added to the outbox, so the sender can run promptly. */
  readonly onEnqueued?: () => void;
}

export const THREAD_HAS_RUN_REPLY = "This thread already has a run. Start a new top-level message for a new task.";

/** Bounded memory of recently handled events, for commands the store does not deduplicate (/status). */
export class RecentEvents {
  private readonly keys = new Set<string>();
  constructor(private readonly capacity = 1000) {}
  has(keys: readonly string[]): boolean {
    return keys.some((key) => this.keys.has(key));
  }
  add(keys: readonly string[]): void {
    for (const key of keys) {
      this.keys.delete(key);
      this.keys.add(key);
    }
    while (this.keys.size > this.capacity) {
      const oldest = this.keys.values().next().value;
      if (oldest === undefined) break;
      this.keys.delete(oldest);
    }
  }
}

/** Move a run to `queued` through the state machine, one legal step at a time. */
function queueRun(store: Store, binding: Binding, from: RunState): boolean {
  let state = from;
  if (state === "received") {
    if (!transitionRun(store, binding, "received", "validated").ok) return false;
    state = "validated";
  }
  if (state === "validated") {
    if (!transitionRun(store, binding, "validated", "queued").ok) return false;
  }
  return true;
}

const queuedReply = (run: Run): string => `Queued as ${run.id}. Reply in this thread with /status or /cancel.`;

/**
 * Handle one `events_api` payload synchronously: normalize, authorize, parse, persist. Returns a
 * code describing what happened. Throws only if persistence itself fails, in which case the caller
 * must NOT acknowledge the envelope.
 *
 * Unauthorized, invalid and duplicate input produces no outbox message and no reply of any kind.
 * Nothing here starts a provider, a process, or any I/O other than the local database.
 */
export function handleEventsApi(deps: IngressDeps, body: unknown, recent: RecentEvents): string {
  const { store, log } = deps;
  const event = normalizeEventsApiBody(body);
  if (event === null) return emit(log, "drop:malformed_envelope");

  const decision = authorize(event, deps.auth);
  const eventId = safeEventId(event.eventId);
  if (!decision.ok) return emit(log, `reject:${decision.reason}`, eventId);

  const { message } = decision;
  const parsed = parseCommand(commandText(message.text, deps.botUserId, message.eventType));
  if (!parsed.ok) return emit(log, `parse:${parsed.error}`, eventId);

  const { binding } = message;
  const command = parsed.command;

  if (command.kind === "task") {
    const created = createRunFromEvent(store, {
      ...binding,
      eventId: message.eventId,
      messageTs: message.messageTs,
      provider: command.provider,
      profile: command.profile,
      prompt: command.prompt,
    });
    switch (created.status) {
      case "created": {
        if (!queueRun(store, binding, created.run.state)) return emit(log, "run_queue_failed", eventId, created.run.id);
        enqueueMessage(store, created.run.id, queuedReply(created.run));
        deps.onEnqueued?.();
        return emit(log, "run_queued", eventId, created.run.id);
      }
      case "duplicate": {
        // A crash between create and queue would strand the run in `received`/`validated`: finish it.
        const existing = getRun(store, binding);
        if (existing && (existing.state === "received" || existing.state === "validated") && queueRun(store, binding, existing.state)) {
          enqueueMessage(store, existing.id, queuedReply(existing));
          deps.onEnqueued?.();
          return emit(log, "run_resumed", eventId, existing.id);
        }
        return emit(log, "duplicate", eventId);
      }
      case "rejected": {
        // Recorded by the store, so a retry of this event is a quiet `duplicate`.
        const existing = getRun(store, binding);
        if (existing && enqueueMessage(store, existing.id, THREAD_HAS_RUN_REPLY).ok) deps.onEnqueued?.();
        return emit(log, `rejected:${created.reason}`, eventId);
      }
      case "invalid":
        return emit(log, `invalid:${created.field}`, eventId);
    }
  }

  // The store cannot deduplicate these, so remember them. /cancel is also idempotent by state.
  const keys = [`e:${message.eventId}`, `m:${binding.channelId}:${message.messageTs}`];
  if (recent.has(keys)) return emit(log, "duplicate", eventId);

  let code: string;
  switch (command.kind) {
    case "status":
      code = applyStatus(store, binding);
      break;
    case "cancel":
      code = applyCancel(store, binding);
      break;
    case "approve":
      // Parsed but inert until the approval work: no state change, no reply.
      code = "approve_ignored";
      break;
  }
  recent.add(keys);
  if (code === "status_replied") deps.onEnqueued?.();
  return emit(log, code, eventId);
}

function emit(log: Logger, code: string, eventId?: string, runId?: string): string {
  log({ level: "info", code, eventId, runId });
  return code;
}

/**
 * Build the Socket Mode handler. The envelope is acknowledged only after the event has been
 * persisted or deliberately dropped. If persistence throws, it is left unacknowledged so Slack
 * redelivers it, and the error text is never logged (it could echo database content).
 */
export function createEnvelopeHandler(deps: IngressDeps): (envelope: Envelope) => Promise<void> {
  const recent = new RecentEvents();
  return async (envelope) => {
    if (envelope.type !== "events_api") {
      // Slash commands and interactive payloads are not an accepted input; drop them and tell Slack we got them.
      deps.log({ level: "info", code: "drop:unsupported_envelope" });
    } else {
      try {
        handleEventsApi(deps, envelope.body, recent);
      } catch {
        deps.log({ level: "error", code: "persist_failed", eventId: safeEventId(eventIdOf(envelope.body)) });
        return;
      }
    }
    try {
      await envelope.ack();
    } catch {
      deps.log({ level: "error", code: "ack_failed" });
    }
  };
}

function eventIdOf(body: unknown): unknown {
  return typeof body === "object" && body !== null ? (body as { event_id?: unknown }).event_id : undefined;
}
