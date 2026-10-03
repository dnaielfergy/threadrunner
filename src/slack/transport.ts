import type { OutboxFailureReason } from "../store/index.js";

/**
 * The only surface the rest of the bridge sees of Slack. Production code implements it with the
 * official SDK packages (`sdk.ts`); tests implement it with fixtures, so nothing here touches a network.
 */

/** One Socket Mode envelope. `ack` tells Slack it was received; call it only once the event is handled. */
export interface Envelope {
  /** Envelope type, e.g. `events_api`, `slash_commands`, `interactive`. */
  readonly type: string;
  /** The raw, untrusted payload. */
  readonly body: unknown;
  ack(): Promise<void>;
}

export interface SocketTransport {
  /** Connect and deliver every envelope to `onEnvelope`. Resolves once connected. */
  start(onEnvelope: (envelope: Envelope) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

/**
 * A fully specified `chat.postMessage` call. The literal types make the safety flags impossible to
 * weaken: no mention parsing, no `@name` linking, no link or media previews.
 */
export interface PostMessageRequest {
  readonly channel: string;
  readonly thread_ts: string;
  readonly text: string;
  readonly parse: "none";
  readonly link_names: false;
  readonly unfurl_links: false;
  readonly unfurl_media: false;
}

export type PostResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: OutboxFailureReason;
      /** Seconds Slack asked us to wait (rate limits only). A number read from the SDK error; never its text. */
      readonly retryAfterSeconds?: number | undefined;
    };

export interface SlackApi {
  /** Who the bot token belongs to. Used once at startup to check the workspace. */
  identify(): Promise<{ readonly teamId: string; readonly botUserId: string }>;
  /** Never throws: failures come back as a fixed reason code, with no Slack error text. */
  postMessage(request: PostMessageRequest): Promise<PostResult>;
}
