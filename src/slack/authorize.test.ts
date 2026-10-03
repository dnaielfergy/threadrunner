import { describe, expect, it } from "vitest";
import { authorize, REJECT_REASONS, type RejectReason } from "./authorize.js";
import { normalizeEventsApiBody } from "./event.js";
import { AUTH, CHANNEL, DM, OTHER_CHANNEL, TEAM, USER, dmMessage, mention } from "./test-fixtures.js";

type Json = Record<string, unknown>;

function decide(body: Json, config = AUTH) {
  const event = normalizeEventsApiBody(body);
  if (event === null) throw new Error("fixture did not normalize");
  return authorize(event, config);
}

const reason = (body: Json): RejectReason | "accepted" => {
  const result = decide(body);
  return result.ok ? "accepted" : result.reason;
};

describe("authorize: accepted shapes", () => {
  it("accepts an allowlisted DM message (message.im)", () => {
    const result = decide(dmMessage("/status"));
    expect(result.ok).toBe(true);
  });

  it("accepts an allowlisted channel app_mention", () => {
    expect(reason(mention("/status"))).toBe("accepted");
  });

  it("uses thread_ts as the root thread when present, else ts", () => {
    const top = decide(dmMessage("/status", { event: { ts: "1700000001.000100" } }));
    const reply = decide(dmMessage("/status", { event: { ts: "1700000002.000100", thread_ts: "1700000001.000100" } }));
    if (!top.ok || !reply.ok) throw new Error("expected accept");
    expect(top.message.binding).toEqual({ teamId: TEAM, userId: USER, channelId: DM, rootThreadTs: "1700000001.000100" });
    expect(reply.message.binding.rootThreadTs).toBe("1700000001.000100");
    expect(reply.message.messageTs).toBe("1700000002.000100");
  });
});

describe("authorize: rejection matrix", () => {
  const cases: [string, Json, RejectReason][] = [
    ["wrong team (envelope)", dmMessage("x", { top: { team_id: "T0ZZZZZZZ" } }), "wrong_team"],
    ["wrong user", dmMessage("x", { event: { user: "U0ZZZZZZZ" } }), "wrong_user"],
    ["wrong channel (not allowlisted)", mention("x", { event: { channel: OTHER_CHANNEL } }), "wrong_channel"],
    ["wrong DM (not allowlisted)", dmMessage("x", { event: { channel: "D0ZZZZZZZ" } }), "wrong_channel"],
    ["message.im from a non-DM channel ID", dmMessage("x", { event: { channel: CHANNEL } }), "wrong_channel"],
    ["bot message (bot_id)", dmMessage("x", { event: { bot_id: "B0AAAAAAA" } }), "bot_message"],
    ["bot message (bot_profile)", dmMessage("x", { event: { bot_profile: { id: "B0AAAAAAA" } } }), "bot_message"],
    ["bot message (app_id)", dmMessage("x", { event: { app_id: "A0AAAAAAA" } }), "bot_message"],
    ["subtype bot_message", dmMessage("x", { event: { subtype: "bot_message" } }), "unsupported_subtype"],
    ["subtype message_changed", dmMessage("x", { event: { subtype: "message_changed" } }), "unsupported_subtype"],
    ["subtype message_deleted", dmMessage("x", { event: { subtype: "message_deleted" } }), "unsupported_subtype"],
    ["subtype thread_broadcast", dmMessage("x", { event: { subtype: "thread_broadcast" } }), "unsupported_subtype"],
    ["subtype channel_join", mention("x", { event: { subtype: "channel_join" } }), "unsupported_subtype"],
    ["subtype of the wrong type", dmMessage("x", { event: { subtype: 7 } }), "unsupported_subtype"],
    ["file upload (subtype)", dmMessage("x", { event: { subtype: "file_share" } }), "unsupported_subtype"],
    ["file upload (files array)", dmMessage("x", { event: { files: [{ id: "F0AAAAAAA" }] } }), "file_upload"],
    ["shared channel", mention("x", { top: { is_ext_shared_channel: true } }), "shared_channel"],
    ["shared-channel flag absent", mention("x", { top: { is_ext_shared_channel: undefined } }), "missing_field"],
    ["shared-channel flag not a boolean", mention("x", { top: { is_ext_shared_channel: "false" } }), "missing_field"],
    ["external sender workspace", dmMessage("x", { event: { user_team: "T0ZZZZZZZ" } }), "external_user"],
    ["external message source", dmMessage("x", { event: { source_team: "T0ZZZZZZZ" } }), "external_user"],
    ["ambient channel message", mention("x", { event: { type: "message", channel_type: "channel", text: "/status" } }), "unsupported_event_type"],
    ["private-channel message event", mention("x", { event: { type: "message", channel_type: "group" } }), "unsupported_event_type"],
    ["message with no channel_type", dmMessage("x", { event: { channel_type: undefined } }), "unsupported_event_type"],
    ["message in mpim", dmMessage("x", { event: { channel_type: "mpim" } }), "unsupported_event_type"],
    ["reaction_added", dmMessage("x", { event: { type: "reaction_added" } }), "unsupported_event_type"],
    ["app_home_opened", dmMessage("x", { event: { type: "app_home_opened" } }), "unsupported_event_type"],
    ["event type missing", dmMessage("x", { event: { type: undefined } }), "unsupported_event_type"],
    ["missing event_id", dmMessage("x", { top: { event_id: undefined } }), "missing_field"],
    ["missing team_id", dmMessage("x", { top: { team_id: undefined } }), "missing_field"],
    ["missing user", dmMessage("x", { event: { user: undefined } }), "missing_field"],
    ["missing channel", dmMessage("x", { event: { channel: undefined } }), "missing_field"],
    ["missing ts", dmMessage("x", { event: { ts: undefined } }), "missing_field"],
    ["missing text", dmMessage("x", { event: { text: undefined } }), "missing_field"],
    ["user is not a string", dmMessage("x", { event: { user: 12345 } }), "missing_field"],
    ["malformed event_id", dmMessage("x", { top: { event_id: "not-an-event" } }), "malformed_id"],
    ["malformed team", dmMessage("x", { top: { team_id: "t0aaaaaaa" } }), "malformed_id"],
    ["malformed user", dmMessage("x", { event: { user: "alice" } }), "malformed_id"],
    ["malformed channel", dmMessage("x", { event: { channel: "general" } }), "malformed_id"],
    ["malformed ts", dmMessage("x", { event: { ts: "yesterday" } }), "malformed_id"],
    ["malformed thread_ts", dmMessage("x", { event: { thread_ts: "1700000000" } }), "malformed_id"],
    ["malformed user_team", dmMessage("x", { event: { user_team: "acme" } }), "malformed_id"],
    ["ID with trailing newline", dmMessage("x", { event: { user: `${USER}\n` } }), "malformed_id"],
  ];

  it.each(cases)("rejects %s", (_name, body, expected) => {
    expect(reason(body)).toBe(expected);
  });

  it("covers every reject reason at least once", () => {
    const covered = new Set(cases.map(([, , code]) => code));
    expect([...covered].sort()).toEqual([...REJECT_REASONS].sort());
  });

  it("an empty channel allowlist rejects everything", () => {
    const none = { ...AUTH, channelIds: new Set<string>() };
    expect(decide(dmMessage("x"), none)).toEqual({ ok: false, reason: "wrong_channel" });
  });

  it("is pure: the same input gives the same decision and mutates nothing", () => {
    const event = normalizeEventsApiBody(dmMessage("/status"));
    if (!event) throw new Error("fixture");
    const frozen = Object.freeze({ ...event });
    expect(authorize(frozen, AUTH)).toEqual(authorize(frozen, AUTH));
  });
});

describe("normalizeEventsApiBody", () => {
  it.each([null, undefined, "text", 7, [], {}, { type: "url_verification" }, { type: "event_callback" }, { type: "event_callback", event: "x" }])(
    "returns null for %j",
    (input) => {
      expect(normalizeEventsApiBody(input)).toBeNull();
    },
  );

  it("never throws on hostile shapes", () => {
    const hostile = { type: "event_callback", event: { type: "message", files: 1, user: { toString: () => "x" }, ts: ["1"] } };
    expect(() => normalizeEventsApiBody(hostile)).not.toThrow();
    expect(reason(hostile as Json)).not.toBe("accepted");
  });
});
