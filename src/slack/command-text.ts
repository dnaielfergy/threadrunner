/**
 * Turn Slack message text into the string handed to `parseCommand`.
 *
 * Slack HTML-escapes `&`, `<` and `>` in inbound text, so they are restored (ampersand last, so
 * `&amp;lt;` becomes `&lt;`, not `<`). For `app_mention`, a single leading mention of this bot is
 * removed; any other mention is left in place and will fail to parse as a command.
 */
export function commandText(text: string, botUserId: string, eventType: "message" | "app_mention"): string {
  let body = text;
  if (eventType === "app_mention") {
    const mention = `<@${botUserId}>`;
    const trimmed = body.trimStart();
    if (trimmed.startsWith(mention)) body = trimmed.slice(mention.length);
  }
  return body.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
