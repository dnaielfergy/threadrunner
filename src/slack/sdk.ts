/**
 * The ONLY file that imports the Slack SDK packages. Everything else talks to the `SocketTransport`
 * and `SlackApi` interfaces, so tests inject fixtures and never touch the network.
 *
 * SDK hygiene: its loggers can print envelope payloads (message text) and connection URLs, so they
 * are replaced with a sink. For `chat.postMessage` its built-in retry and rate-limit queueing are
 * turned off so that the outbox owns every retry decision. The socket client keeps the SDK's default
 * retry policy: that is what absorbs a Wi-Fi drop or sleep/wake while it re-opens the connection
 * (`apps.connections.open` request errors are otherwise treated as unrecoverable and end reconnecting).
 */
import { LogLevel, SocketModeClient, type Logger } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { OutboxFailureReason } from "../store/index.js";
import type { Logger as BridgeLogger } from "./log.js";
import type { Envelope, PostMessageRequest, PostResult, SlackApi, SocketTransport } from "./transport.js";

const REQUEST_TIMEOUT_MS = 15_000;

/** Discards every message. */
const silentLogger: Logger = {
  debug: (..._msg: unknown[]): void => {},
  info: (..._msg: unknown[]): void => {},
  warn: (..._msg: unknown[]): void => {},
  error: (..._msg: unknown[]): void => {},
  setLevel: (): void => {},
  getLevel: () => LogLevel.ERROR,
  setName: (): void => {},
};

export function createWebClient(botToken: string): WebClient {
  return new WebClient(botToken, {
    logger: silentLogger,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout: REQUEST_TIMEOUT_MS,
  });
}

/** Seconds from a rate-limit error's numeric `retryAfter` field. Only that number is read, never any text. */
export function retryAfterSeconds(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, retryAfter } = error as { code?: unknown; retryAfter?: unknown };
  if (code !== "slack_webapi_rate_limited_error") return undefined;
  return typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
}

/** Map an SDK failure to a fixed reason code. Error text is never read, stored, or logged. */
export function failureReason(error: unknown): OutboxFailureReason {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  switch (code) {
    case "slack_webapi_rate_limited_error":
      return "rate_limited";
    case "slack_webapi_request_error":
    case "slack_webapi_http_error":
      return "network";
    case "slack_webapi_platform_error":
      return "slack_error";
    default:
      return "unknown";
  }
}

export function createSlackApi(botToken: string, client: WebClient = createWebClient(botToken)): SlackApi {
  return {
    async identify() {
      const auth = await client.auth.test();
      if (!auth.ok || typeof auth.team_id !== "string" || typeof auth.user_id !== "string") {
        throw new Error("auth.test returned an unusable response");
      }
      return { teamId: auth.team_id, botUserId: auth.user_id };
    },
    async postMessage(request: PostMessageRequest): Promise<PostResult> {
      try {
        const response = await client.chat.postMessage({ ...request });
        return response.ok ? { ok: true } : { ok: false, reason: "slack_error" };
      } catch (error) {
        return { ok: false, reason: failureReason(error), retryAfterSeconds: retryAfterSeconds(error) };
      }
    },
  };
}

/** Connection state changes, logged as fixed codes so a dead or flapping connection is visible. */
const SOCKET_STATES = [
  ["connected", "info", "socket_connected"],
  ["reconnecting", "warn", "socket_reconnecting"],
  ["disconnected", "warn", "socket_disconnected"],
  ["error", "error", "socket_error"],
] as const;

export function createSocketTransport(appToken: string, log: BridgeLogger): SocketTransport {
  const client = new SocketModeClient({
    appToken,
    logger: silentLogger,
    clientOptions: { timeout: REQUEST_TIMEOUT_MS },
  });
  return {
    async start(onEnvelope) {
      // Never pass the event payload or error to the log: only the fixed code.
      for (const [name, level, code] of SOCKET_STATES) client.on(name, () => log({ level, code }));
      // `slack_event` carries every envelope type, so unsupported ones can be acknowledged and dropped deliberately.
      client.on("slack_event", (raw: { type: string; body: unknown; ack: () => Promise<void> }) => {
        const envelope: Envelope = { type: raw.type, body: raw.body, ack: () => raw.ack() };
        void onEnvelope(envelope);
      });
      await client.start();
    },
    async stop() {
      await client.disconnect();
    },
  };
}
