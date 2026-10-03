import type { Binding } from "../store/index.js";
import {
  CHANNEL_ID_PATTERN,
  EVENT_ID_PATTERN,
  SLACK_TS_PATTERN,
  TEAM_ID_PATTERN,
  USER_ID_PATTERN,
} from "../store/validate.js";
import type { AuthConfig } from "./config.js";
import type { InboundMessage } from "./event.js";

/** Why an event was refused. Logged as a code, never shown to the sender. */
export const REJECT_REASONS = [
  "unsupported_event_type",
  "bot_message",
  "unsupported_subtype",
  "file_upload",
  "missing_field",
  "malformed_id",
  "wrong_team",
  "external_user",
  "shared_channel",
  "wrong_user",
  "wrong_channel",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** An event that passed every check. All identifiers are shape-validated and equal the configured allowlist. */
export interface AuthorizedMessage {
  readonly eventId: string;
  readonly eventType: "message" | "app_mention";
  readonly binding: Binding;
  /** The ts of the message itself (differs from the root thread for replies). */
  readonly messageTs: string;
  readonly text: string;
}

export type AuthDecision =
  | { readonly ok: true; readonly message: AuthorizedMessage }
  | { readonly ok: false; readonly reason: RejectReason };

const reject = (reason: RejectReason): AuthDecision => ({ ok: false, reason });

/**
 * Pure and total: (normalized event, config) -> accept, or one reject reason. Default deny; an
 * event is accepted only if every check passes. Checks run in a fixed order so the reason is stable.
 *
 * Accepted shapes (SECURITY.md `allow_events`):
 *   - `message` with `channel_type: "im"` (message.im), in an allowlisted DM
 *   - `app_mention`, in an allowlisted channel
 * Everything else, including ambient channel `message` events, is `unsupported_event_type`.
 *
 * Root thread: `thread_ts` if present, else the message's own `ts`.
 */
export function authorize(event: InboundMessage, config: AuthConfig): AuthDecision {
  const { eventType } = event;
  if (eventType !== "message" && eventType !== "app_mention") return reject("unsupported_event_type");
  if (eventType === "message" && event.channelType !== "im") return reject("unsupported_event_type");

  if (event.fromBot) return reject("bot_message");
  if (event.subtype !== undefined) return reject("unsupported_subtype");
  if (event.hasFiles) return reject("file_upload");

  const { eventId, teamId, userId, channelId, ts, text } = event;
  if (
    eventId === undefined ||
    teamId === undefined ||
    userId === undefined ||
    channelId === undefined ||
    ts === undefined ||
    text === undefined ||
    event.sharedChannel === undefined
  ) {
    return reject("missing_field");
  }

  const optionalIds: [string | undefined, RegExp][] = [
    [event.userTeamId, TEAM_ID_PATTERN],
    [event.sourceTeamId, TEAM_ID_PATTERN],
    [event.threadTs, SLACK_TS_PATTERN],
  ];
  const malformed =
    !EVENT_ID_PATTERN.test(eventId) ||
    !TEAM_ID_PATTERN.test(teamId) ||
    !USER_ID_PATTERN.test(userId) ||
    !CHANNEL_ID_PATTERN.test(channelId) ||
    !SLACK_TS_PATTERN.test(ts) ||
    optionalIds.some(([value, pattern]) => value !== undefined && !pattern.test(value));
  if (malformed) return reject("malformed_id");

  if (teamId !== config.teamId) return reject("wrong_team");
  // An external (Slack Connect) sender or source carries a different workspace than ours.
  if ((event.userTeamId ?? teamId) !== config.teamId || (event.sourceTeamId ?? teamId) !== config.teamId) return reject("external_user");
  if (event.sharedChannel) return reject("shared_channel");
  if (userId !== config.userId) return reject("wrong_user");
  if (!config.channelIds.has(channelId)) return reject("wrong_channel");
  // message.im must come from a DM channel ID; do not trust the channel_type label alone.
  if (eventType === "message" && !channelId.startsWith("D")) return reject("wrong_channel");

  return {
    ok: true,
    message: {
      eventId,
      eventType,
      binding: { teamId, userId, channelId, rootThreadTs: event.threadTs ?? ts },
      messageTs: ts,
      text,
    },
  };
}
