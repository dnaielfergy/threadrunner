import type { Destination } from "../store/index.js";
import type { PostMessageRequest } from "./transport.js";

/** Slack truncates plain `text` past 40,000 characters. */
export const SLACK_TEXT_LIMIT = 40_000;

/**
 * Neutralize Slack control markup: `&`, `<` and `>` are the only characters that start a mention
 * (`<!channel>`, `<@U123>`), a link (`<https://x|label>`) or an entity. `&` goes first so the
 * entities this adds are not escaped twice.
 */
export function escapeSlackText(raw: string): string {
  return raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Build the post for a claimed outbox message. The destination argument must be the one on the
 * claimed message (the run's stored binding); nothing else in the bridge supplies one.
 *
 * Bodies are split on raw text when they are enqueued, because escaping can grow text up to 5x
 * (`&` becomes `&amp;`). The escaped length is checked here: if it does not fit, this returns null
 * and the caller records a failure instead of posting a truncated message.
 */
export function buildPostRequest(destination: Destination, body: string, limit = SLACK_TEXT_LIMIT): PostMessageRequest | null {
  const text = escapeSlackText(body);
  if (text.length === 0 || text.length > limit) return null;
  return {
    channel: destination.channelId,
    thread_ts: destination.threadTs,
    text,
    parse: "none",
    link_names: false,
    unfurl_links: false,
    unfurl_media: false,
  };
}
