import { describe, expect, it } from "vitest";
import { BASE_CHILD_ENV_ALLOWLIST, buildChildEnv, isForbiddenPassthrough } from "./env.js";

const parent = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/me",
  LANG: "en_US.UTF-8",
  SLACK_BOT_TOKEN: "xoxb-CANARY-bot",
  SLACK_APP_TOKEN: "xapp-CANARY-app",
  DATABASE_PATH: "/home/me/.threadrunner/threadrunner.db",
  ALLOWED_USER_IDS: "U0AAAAAAA",
  OPENAI_API_KEY: "sk-CANARY-openai",
  AWS_SECRET_ACCESS_KEY: "CANARY-aws",
  GITHUB_TOKEN: "ghp_CANARY",
};

describe("buildChildEnv", () => {
  it("passes the base allowlist and nothing else", () => {
    const env = buildChildEnv(parent);
    expect(env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/me", LANG: "en_US.UTF-8" });
    expect(JSON.stringify(env)).not.toContain("CANARY");
  });

  it("does not inherit unlisted variables, including credentials for other services", () => {
    const names = Object.keys(buildChildEnv(parent));
    expect(names.every((name) => (BASE_CHILD_ENV_ALLOWLIST as readonly string[]).includes(name))).toBe(true);
  });

  it("passes an explicitly approved extra variable, and only that one", () => {
    expect(buildChildEnv(parent, ["OPENAI_API_KEY"])).toMatchObject({ OPENAI_API_KEY: "sk-CANARY-openai" });
    expect(buildChildEnv(parent, ["OPENAI_API_KEY"])).not.toHaveProperty("GITHUB_TOKEN");
  });

  it.each(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_ANYTHING", "DATABASE_PATH", "ALLOWED_USER_IDS", "APPROVED_REPO_ROOTS", "RUNNER_TIMEOUT_SECONDS", "CODEX_BIN"])(
    "refuses to pass %s even if asked",
    (name) => {
      expect(isForbiddenPassthrough(name)).toBe(true);
      expect(() => buildChildEnv(parent, [name])).toThrow(RangeError);
    },
  );

  it.each(["lowercase", "HAS SPACE", "A=B", "", "1LEADING"])("rejects a malformed extra name %j", (name) => {
    expect(() => buildChildEnv(parent, [name])).toThrow(RangeError);
  });

  it("drops empty values and values containing NUL, and never mutates the parent", () => {
    const snapshot = { ...parent, TZ: "", TMPDIR: "/tmp\u0000x" };
    const copy = { ...snapshot };
    expect(buildChildEnv(snapshot)).not.toHaveProperty("TZ");
    expect(buildChildEnv(snapshot)).not.toHaveProperty("TMPDIR");
    expect(snapshot).toEqual(copy);
  });
});
