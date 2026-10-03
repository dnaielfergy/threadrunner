import type { AuthConfig } from "./config.js";
import type { Envelope, PostMessageRequest, PostResult, SlackApi } from "./transport.js";
import type { Logger, LogEntry } from "./log.js";

export const TEAM = "T0AAAAAAA";
export const USER = "U0AAAAAAA";
export const BOT_USER = "U0BOTBOTB";
export const DM = "D0AAAAAAA";
export const CHANNEL = "C0AAAAAAA";
export const OTHER_CHANNEL = "C0BBBBBBB";

export const AUTH: AuthConfig = { teamId: TEAM, userId: USER, channelIds: new Set([DM, CHANNEL]) };

/** Distinct, shape-valid Slack timestamps. */
let tsCounter = 0;
export const nextTs = (): string => `17000${String(++tsCounter).padStart(5, "0")}.000100`;
let idCounter = 0;
export const nextEventId = (): string => `Ev0FIXTURE${++idCounter}`;

type Json = Record<string, unknown>;

/** A valid `message.im` Events API payload. `event` and `top` override fields; `undefined` deletes one. */
export function dmMessage(text: string, overrides: { event?: Json; top?: Json } = {}): Json {
  return build({ type: "message", channel_type: "im", channel: DM, user: USER, text, ts: nextTs() }, overrides);
}

/** A valid `app_mention` payload in the allowlisted channel, with the bot mention Slack puts in front. */
export function mention(text: string, overrides: { event?: Json; top?: Json } = {}): Json {
  return build({ type: "app_mention", channel: CHANNEL, user: USER, text: `<@${BOT_USER}> ${text}`, ts: nextTs() }, overrides);
}

function build(event: Json, overrides: { event?: Json; top?: Json }): Json {
  const body: Json = {
    type: "event_callback",
    event_id: nextEventId(),
    team_id: TEAM,
    is_ext_shared_channel: false,
    event: { ...event, ...overrides.event },
    ...overrides.top,
  };
  for (const target of [body, body["event"] as Json]) {
    for (const key of Object.keys(target)) if (target[key] === undefined) delete target[key];
  }
  return body;
}

export const eventOf = (body: Json): Json => body["event"] as Json;

export function capturingLogger(): { log: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { log: (entry) => void entries.push(entry), entries };
}

/** An envelope that records when (and whether) it was acknowledged. */
export function fakeEnvelope(body: unknown, type = "events_api", onAck: () => void = () => {}): Envelope & { acked: number } {
  const envelope = {
    type,
    body,
    acked: 0,
    ack: async () => {
      envelope.acked++;
      onAck();
    },
  };
  return envelope;
}

export function fakeSlackApi(result: PostResult | (() => PostResult | Promise<PostResult>) = { ok: true }) {
  const posts: PostMessageRequest[] = [];
  const api: SlackApi & { posts: PostMessageRequest[] } = {
    posts,
    identify: async () => ({ teamId: TEAM, botUserId: BOT_USER }),
    postMessage: async (request) => {
      posts.push(request);
      return typeof result === "function" ? result() : result;
    },
  };
  return api;
}
