import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const BOT = "xoxb-CANARY-bot-token-1234567890";
const APP = "xapp-1-CANARY-app-token-1234567890";
const good = {
  ALLOWED_TEAM_ID: "T0AAAAAAA",
  ALLOWED_USER_IDS: "U0AAAAAAA",
  ALLOWED_CHANNEL_IDS: "D0AAAAAAA,C0AAAAAAA",
  DATABASE_PATH: "/home/me/.threadrunner/threadrunner.db",
  SLACK_BOT_TOKEN: BOT,
  SLACK_APP_TOKEN: APP,
};

const errorsFor = (env: Record<string, string | undefined>) => {
  const result = loadConfig(env);
  if (result.ok) throw new Error("expected failure");
  return result.errors;
};

describe("loadConfig", () => {
  it("accepts a complete, well-formed environment", () => {
    const result = loadConfig(good);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.config.auth).toEqual({ teamId: "T0AAAAAAA", userId: "U0AAAAAAA", channelIds: new Set(["D0AAAAAAA", "C0AAAAAAA"]) });
    expect(result.config.databasePath).toBe(good.DATABASE_PATH);
  });

  it("ignores unrelated variables such as the runner settings in .env.example", () => {
    expect(loadConfig({ ...good, RUNNER_CONCURRENCY: "1", PORT: "8877" }).ok).toBe(true);
  });

  it.each(Object.keys(good))("fails closed when %s is missing or blank", (variable) => {
    expect(errorsFor({ ...good, [variable]: undefined })).toContainEqual({ variable, code: "missing" });
    expect(errorsFor({ ...good, [variable]: "   " })).toContainEqual({ variable, code: "missing" });
  });

  it("rejects zero authorized users", () => {
    expect(errorsFor({ ...good, ALLOWED_USER_IDS: "," })).toContainEqual({ variable: "ALLOWED_USER_IDS", code: "malformed" });
    expect(errorsFor({ ...good, ALLOWED_USER_IDS: "" })).toContainEqual({ variable: "ALLOWED_USER_IDS", code: "missing" });
  });

  it("rejects more than one authorized user", () => {
    expect(errorsFor({ ...good, ALLOWED_USER_IDS: "U0AAAAAAA,U0BBBBBBB" })).toContainEqual({ variable: "ALLOWED_USER_IDS", code: "too_many_users" });
  });

  it("rejects a repeated user rather than collapsing it", () => {
    expect(errorsFor({ ...good, ALLOWED_USER_IDS: "U0AAAAAAA,U0AAAAAAA" })).toContainEqual({ variable: "ALLOWED_USER_IDS", code: "duplicate_entry" });
  });

  it.each([
    ["ALLOWED_TEAM_ID", "acme"],
    ["ALLOWED_USER_IDS", "alice"],
    ["ALLOWED_USER_IDS", "U0AAAAAAA,"],
    ["ALLOWED_CHANNEL_IDS", "general"],
    ["ALLOWED_CHANNEL_IDS", "C0AAAAAAA,#random"],
    ["ALLOWED_CHANNEL_IDS", "C0AAAAAAA,,D0AAAAAAA"],
    ["DATABASE_PATH", "relative/threadrunner.db"],
    ["SLACK_BOT_TOKEN", "xapp-1-wrong-kind-of-token-123"],
    ["SLACK_APP_TOKEN", "xoxb-wrong-kind-of-token-12345"],
    ["SLACK_BOT_TOKEN", "xoxb-short"],
  ])("rejects malformed %s = %s", (variable, value) => {
    expect(errorsFor({ ...good, [variable]: value })).toContainEqual({ variable, code: "malformed" });
  });

  it("rejects a repeated channel", () => {
    expect(errorsFor({ ...good, ALLOWED_CHANNEL_IDS: "C0AAAAAAA,C0AAAAAAA" })).toContainEqual({ variable: "ALLOWED_CHANNEL_IDS", code: "duplicate_entry" });
  });

  it("reports every problem at once, and never includes a value, so tokens cannot leak", () => {
    const errors = errorsFor({ ...good, SLACK_BOT_TOKEN: "xoxb-CANARY!bad", SLACK_APP_TOKEN: "CANARY-also-bad", ALLOWED_TEAM_ID: undefined });
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(errors)).not.toContain("CANARY");
  });
});
