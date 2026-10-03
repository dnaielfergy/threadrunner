import { EVENT_ID_PATTERN } from "../store/validate.js";

/**
 * A log entry is a fixed code plus identifiers, by construction: there is no field for message
 * text, prompts, tokens, or error messages. `eventId` is only ever a shape-valid Slack event ID.
 */
export interface LogEntry {
  readonly level: "info" | "warn" | "error";
  readonly code: string;
  readonly eventId?: string | undefined;
  readonly runId?: string | undefined;
  readonly messageId?: number | undefined;
}

export type Logger = (entry: LogEntry) => void;

/** One JSON line per entry on stderr. Undefined fields are omitted by JSON.stringify. */
export const stderrLogger: Logger = (entry) => {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
};

/** An event ID from an untrusted payload is logged only if it has the shape of a real one. */
export const safeEventId = (value: unknown): string | undefined =>
  typeof value === "string" && EVENT_ID_PATTERN.test(value) ? value : undefined;
