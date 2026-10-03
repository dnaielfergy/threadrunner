import { beforeEach, describe, expect, it, vi } from "vitest";

// The SDK packages are replaced wholesale: these tests never open a socket or make a request.
const webClients: { token: string; options: Record<string, unknown>; postMessage: ReturnType<typeof vi.fn>; authTest: ReturnType<typeof vi.fn> }[] = [];
const socketClients: { options: Record<string, unknown>; listeners: Map<string, (arg: unknown) => void>; start: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];

vi.mock("@slack/web-api", () => ({
  WebClient: class {
    readonly chat: { postMessage: ReturnType<typeof vi.fn> };
    readonly auth: { test: ReturnType<typeof vi.fn> };
    constructor(token: string, options: Record<string, unknown>) {
      const postMessage = vi.fn(async () => ({ ok: true }));
      const authTest = vi.fn(async () => ({ ok: true, team_id: "T0AAAAAAA", user_id: "U0BOTBOTB" }));
      this.chat = { postMessage };
      this.auth = { test: authTest };
      webClients.push({ token, options, postMessage, authTest });
    }
  },
}));

vi.mock("@slack/socket-mode", () => ({
  LogLevel: { ERROR: "error" },
  SocketModeClient: class {
    constructor(options: Record<string, unknown>) {
      const listeners = new Map<string, (arg: unknown) => void>();
      const start = vi.fn(async () => ({}));
      const disconnect = vi.fn(async () => {});
      socketClients.push({ options, listeners, start, disconnect });
      Object.assign(this, { on: (name: string, fn: (arg: unknown) => void) => void listeners.set(name, fn), start, disconnect });
    }
  },
}));

const { createSlackApi, createSocketTransport, createWebClient, failureReason, retryAfterSeconds } = await import("./sdk.js");
const { capturingLogger } = await import("./test-fixtures.js");

const request = {
  channel: "D0AAAAAAA",
  thread_ts: "1700000000.000100",
  text: "hi",
  parse: "none",
  link_names: false,
  unfurl_links: false,
  unfurl_media: false,
} as const;

beforeEach(() => {
  webClients.length = 0;
  socketClients.length = 0;
});

describe("web client", () => {
  it("turns off the SDK's own retries and rate-limit queueing, sets a timeout, and silences its logger", () => {
    createWebClient("xoxb-test-token-0123456789");
    const [client] = webClients;
    expect(client?.token).toBe("xoxb-test-token-0123456789");
    expect(client?.options).toMatchObject({ retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 15000 });
    const logger = client?.options["logger"] as { error: (...a: unknown[]) => unknown; getLevel: () => string };
    expect(logger.error("xoxb-secret in a message")).toBeUndefined();
    expect(logger.getLevel()).toBe("error");
  });

  it("posts exactly the request it was given, nothing added", async () => {
    const api = createSlackApi("xoxb-test-token-0123456789");
    expect(await api.postMessage(request)).toEqual({ ok: true });
    expect(webClients[0]?.postMessage).toHaveBeenCalledWith({ ...request });
  });

  it.each([
    ["slack_webapi_rate_limited_error", "rate_limited"],
    ["slack_webapi_request_error", "network"],
    ["slack_webapi_http_error", "network"],
    ["slack_webapi_platform_error", "slack_error"],
    ["something_else", "unknown"],
  ] as const)("maps SDK error %s to reason %s without exposing its text", async (code, reason) => {
    const api = createSlackApi("xoxb-test-token-0123456789");
    webClients[0]?.postMessage.mockRejectedValueOnce(Object.assign(new Error("xoxb-LEAK in message"), { code }));
    const result = await api.postMessage(request);
    expect(result).toEqual({ ok: false, reason });
    expect(JSON.stringify(result)).not.toContain("LEAK");
  });

  it("treats ok:false and non-error throws as failures", async () => {
    const api = createSlackApi("xoxb-test-token-0123456789");
    webClients[0]?.postMessage.mockResolvedValueOnce({ ok: false });
    expect(await api.postMessage(request)).toEqual({ ok: false, reason: "slack_error" });
    webClients[0]?.postMessage.mockRejectedValueOnce("boom");
    expect(await api.postMessage(request)).toEqual({ ok: false, reason: "unknown" });
    expect(failureReason(null)).toBe("unknown");
  });

  it("identify returns the workspace and bot user, and refuses an unusable response", async () => {
    const api = createSlackApi("xoxb-test-token-0123456789");
    expect(await api.identify()).toEqual({ teamId: "T0AAAAAAA", botUserId: "U0BOTBOTB" });
    webClients[0]?.authTest.mockResolvedValueOnce({ ok: true });
    await expect(api.identify()).rejects.toThrow();
  });
});

describe("socket transport", () => {
  it("connects with the app token and a silent logger, keeping the SDK's default retry policy so reconnects survive a network blip", async () => {
    const transport = createSocketTransport("xapp-1-test-token-0123456789", capturingLogger().log);
    await transport.start(async () => {});
    const [client] = socketClients;
    expect(client?.options).toMatchObject({ appToken: "xapp-1-test-token-0123456789", clientOptions: { timeout: 15000 } });
    // Setting retries to 0 here would make a single failed apps.connections.open end the reconnect loop.
    expect(client?.options["clientOptions"]).not.toHaveProperty("retryConfig");
    expect(client?.start).toHaveBeenCalledOnce();
    expect(client?.listeners.has("slack_event")).toBe(true);
  });

  it.each([
    ["connected", "info", "socket_connected"],
    ["reconnecting", "warn", "socket_reconnecting"],
    ["disconnected", "warn", "socket_disconnected"],
    ["error", "error", "socket_error"],
  ])("logs a %s state change as the fixed code %s, never the payload", async (name, level, code) => {
    const { log, entries } = capturingLogger();
    const transport = createSocketTransport("xapp-1-test-token-0123456789", log);
    await transport.start(async () => {});
    socketClients[0]?.listeners.get(name)?.(new Error("wss://wss-primary.slack.com/?ticket=SECRET-CANARY"));
    expect(entries).toEqual([{ level, code }]);
    expect(JSON.stringify(entries)).not.toContain("CANARY");
  });

  it("hands every envelope to the handler with a working ack", async () => {
    const transport = createSocketTransport("xapp-1-test-token-0123456789", capturingLogger().log);
    const received: { type: string; body: unknown }[] = [];
    let ackedWith: unknown;
    await transport.start(async (envelope) => {
      received.push({ type: envelope.type, body: envelope.body });
      await envelope.ack();
    });
    const ack = vi.fn(async () => void (ackedWith = "acked"));
    socketClients[0]?.listeners.get("slack_event")?.({ type: "slash_commands", body: { command: "/x" }, ack });
    await vi.waitFor(() => expect(ack).toHaveBeenCalledOnce());
    expect(received).toEqual([{ type: "slash_commands", body: { command: "/x" } }]);
    expect(ackedWith).toBe("acked");
  });

  it("stop disconnects", async () => {
    const transport = createSocketTransport("xapp-1-test-token-0123456789", capturingLogger().log);
    await transport.start(async () => {});
    await transport.stop();
    expect(socketClients[0]?.disconnect).toHaveBeenCalledOnce();
  });
});

describe("retryAfterSeconds", () => {
  const limited = (retryAfter: unknown) => Object.assign(new Error("ratelimited"), { code: "slack_webapi_rate_limited_error", retryAfter });

  it("reads only a positive finite number from a rate-limit error", () => {
    expect(retryAfterSeconds(limited(30))).toBe(30);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "30", undefined, null]) expect(retryAfterSeconds(limited(bad))).toBeUndefined();
  });

  it("ignores other error kinds and non-errors", () => {
    expect(retryAfterSeconds(Object.assign(new Error("x"), { code: "slack_webapi_http_error", retryAfter: 30 }))).toBeUndefined();
    expect(retryAfterSeconds("boom")).toBeUndefined();
    expect(retryAfterSeconds(null)).toBeUndefined();
  });

  it("is passed through the failed post result", async () => {
    const api = createSlackApi("xoxb-test-token-0123456789");
    webClients[0]?.postMessage.mockRejectedValueOnce(limited(42));
    expect(await api.postMessage(request)).toEqual({ ok: false, reason: "rate_limited", retryAfterSeconds: 42 });
  });
});
