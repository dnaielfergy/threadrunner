import { isModelProfile, isProvider, type ModelProfile, type Provider } from "../domain/types.js";
import { RUN_STATES, type RunState } from "../domain/run-state.js";
import { MAX_PROMPT_LENGTH, RUN_ID_PATTERN } from "../parser/command.js";

// Slack identifiers are bridge-validated before they reach the store, but the store re-checks
// shape and length so a malformed value can never be persisted or used as a lookup key.
export const TEAM_ID_PATTERN = /^[TE][A-Z0-9]{2,31}$/;
export const USER_ID_PATTERN = /^[UW][A-Z0-9]{2,31}$/;
export const CHANNEL_ID_PATTERN = /^[CDG][A-Z0-9]{2,31}$/;
export const EVENT_ID_PATTERN = /^Ev[A-Za-z0-9]{2,62}$/;
/** Slack message timestamps: epoch seconds, a dot, then six digits. */
export const SLACK_TS_PATTERN = /^[0-9]{10}\.[0-9]{6}$/;

export const MAX_OUTBOX_BODY_LENGTH = 3000;
export const MAX_ERROR_LENGTH = 200;

/** The four fields that permanently identify who and where a run belongs to. */
export interface Binding {
  readonly teamId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
}

export interface NewRunInput extends Binding {
  readonly eventId: string;
  /** Timestamp of the message that triggered the run (may differ from the root thread). */
  readonly messageTs: string;
  readonly provider: Provider;
  readonly profile: ModelProfile;
  readonly prompt: string;
}

const matches = (pattern: RegExp, value: unknown): boolean => typeof value === "string" && pattern.test(value);

/** Returns the name of the first invalid field, or null when the binding is well formed. */
export function invalidBindingField(binding: Binding): keyof Binding | null {
  if (!matches(TEAM_ID_PATTERN, binding.teamId)) return "teamId";
  if (!matches(USER_ID_PATTERN, binding.userId)) return "userId";
  if (!matches(CHANNEL_ID_PATTERN, binding.channelId)) return "channelId";
  if (!matches(SLACK_TS_PATTERN, binding.rootThreadTs)) return "rootThreadTs";
  return null;
}

export function invalidNewRunField(input: NewRunInput): string | null {
  const binding = invalidBindingField(input);
  if (binding) return binding;
  if (!matches(EVENT_ID_PATTERN, input.eventId)) return "eventId";
  if (!matches(SLACK_TS_PATTERN, input.messageTs)) return "messageTs";
  if (typeof input.provider !== "string" || !isProvider(input.provider)) return "provider";
  if (typeof input.profile !== "string" || !isModelProfile(input.profile)) return "profile";
  if (typeof input.prompt !== "string" || input.prompt.length === 0 || input.prompt.length > MAX_PROMPT_LENGTH) return "prompt";
  // SQLite text is not NUL-safe in every code path; refuse rather than risk truncation.
  if (input.prompt.includes("\u0000")) return "prompt";
  return null;
}

export const isRunId = (value: unknown): value is string => matches(RUN_ID_PATTERN, value);

export const isRunState = (value: unknown): value is RunState =>
  typeof value === "string" && (RUN_STATES as readonly string[]).includes(value);
