/**
 * The bridge's own view of an inbound Slack message, free of SDK types. Every field is optional
 * and unvalidated: `normalizeEventsApiBody` only copies out values of the expected JS type, and
 * `authorize` decides whether what is left is acceptable.
 */
export interface InboundMessage {
  /** Envelope-level event ID (`Ev...`). */
  readonly eventId: string | undefined;
  /** Envelope-level workspace ID. */
  readonly teamId: string | undefined;
  /** `message`, `app_mention`, or whatever else Slack sent. */
  readonly eventType: string | undefined;
  /** `im` for a DM; channels and groups carry other values. */
  readonly channelType: string | undefined;
  readonly userId: string | undefined;
  readonly channelId: string | undefined;
  readonly ts: string | undefined;
  readonly threadTs: string | undefined;
  readonly text: string | undefined;
  readonly subtype: string | undefined;
  /** True if Slack marks the sender as a bot or app in any way. */
  readonly fromBot: boolean;
  /** True if the message carries file attachments. */
  readonly hasFiles: boolean;
  /** Slack Connect / shared channel flag from the envelope. `undefined` when absent. */
  readonly sharedChannel: boolean | undefined;
  /** Workspace of the sending user and of the message source, when Slack provides them (external users differ). */
  readonly userTeamId: string | undefined;
  readonly sourceTeamId: string | undefined;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Project an Events API payload (the `body` of a Socket Mode `events_api` envelope) into an
 * `InboundMessage`. Returns null if the payload is not an `event_callback` with an event object.
 * Never throws and never interprets values.
 */
export function normalizeEventsApiBody(body: unknown): InboundMessage | null {
  if (!isRecord(body) || body["type"] !== "event_callback") return null;
  const event = body["event"];
  if (!isRecord(event)) return null;
  const files = event["files"];
  return {
    eventId: str(body["event_id"]),
    teamId: str(body["team_id"]),
    eventType: str(event["type"]),
    channelType: str(event["channel_type"]),
    userId: str(event["user"]),
    channelId: str(event["channel"]),
    ts: str(event["ts"]),
    threadTs: str(event["thread_ts"]),
    text: str(event["text"]),
    // Present but not a string is still a subtype: fail closed rather than read it as "no subtype".
    subtype: event["subtype"] === undefined ? undefined : (str(event["subtype"]) ?? "invalid"),
    fromBot: event["bot_id"] !== undefined || event["bot_profile"] !== undefined || event["app_id"] !== undefined,
    hasFiles: Array.isArray(files) ? files.length > 0 : files !== undefined,
    sharedChannel: bool(body["is_ext_shared_channel"]),
    userTeamId: str(event["user_team"]),
    sourceTeamId: str(event["source_team"]),
  };
}
