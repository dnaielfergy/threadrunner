import { isAbsolute } from "node:path";
import { CHANNEL_ID_PATTERN, TEAM_ID_PATTERN, USER_ID_PATTERN } from "../store/validate.js";

/** What authorization needs, and nothing else: no tokens, no paths. */
export interface AuthConfig {
  readonly teamId: string;
  /** Exactly one in the initial release (SECURITY.md: no collaborator mode). */
  readonly userId: string;
  readonly channelIds: ReadonlySet<string>;
}

export interface BridgeConfig {
  readonly auth: AuthConfig;
  readonly databasePath: string;
  readonly botToken: string;
  readonly appToken: string;
}

export type ConfigErrorCode =
  | "missing"
  | "malformed"
  | "no_users"
  | "too_many_users"
  | "duplicate_entry"
  // Runner settings (src/runner/config.ts), reported through the same startup path.
  | "too_many_roots"
  | "not_absolute"
  | "not_found"
  | "not_directory"
  | "not_executable"
  | "inside_repo"
  | "unsafe_root"
  | "unsupported";

/** Names the variable and the problem. Never carries a value, so a bad token cannot leak through an error. */
export interface ConfigError {
  readonly variable: string;
  readonly code: ConfigErrorCode;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: BridgeConfig }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

export const BOT_TOKEN_PATTERN = /^xoxb-[A-Za-z0-9-]{10,200}$/;
export const APP_TOKEN_PATTERN = /^xapp-[A-Za-z0-9-]{10,200}$/;

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, variable: string, errors: ConfigError[]): string | null {
  const value = env[variable];
  if (value === undefined || value.trim() === "") {
    errors.push({ variable, code: "missing" });
    return null;
  }
  return value.trim();
}

/** Comma-separated list. Empty entries (a trailing comma) and duplicates are errors, not silently repaired. */
function idList(env: Env, variable: string, pattern: RegExp, errors: ConfigError[]): string[] | null {
  const raw = required(env, variable, errors);
  if (raw === null) return null;
  const entries = raw.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !pattern.test(entry))) {
    errors.push({ variable, code: "malformed" });
    return null;
  }
  if (new Set(entries).size !== entries.length) {
    errors.push({ variable, code: "duplicate_entry" });
    return null;
  }
  return entries;
}

/**
 * Pure: reads only the `env` it is given. Fails closed: any missing or malformed value, zero or
 * several authorized users, or a relative database path yields errors and no config at all.
 */
export function loadConfig(env: Env): ConfigResult {
  const errors: ConfigError[] = [];

  const teamRaw = required(env, "ALLOWED_TEAM_ID", errors);
  if (teamRaw !== null && !TEAM_ID_PATTERN.test(teamRaw)) errors.push({ variable: "ALLOWED_TEAM_ID", code: "malformed" });

  const users = idList(env, "ALLOWED_USER_IDS", USER_ID_PATTERN, errors);
  if (users !== null && users.length > 1) errors.push({ variable: "ALLOWED_USER_IDS", code: "too_many_users" });

  const channels = idList(env, "ALLOWED_CHANNEL_IDS", CHANNEL_ID_PATTERN, errors);

  const databasePath = required(env, "DATABASE_PATH", errors);
  if (databasePath !== null && (!isAbsolute(databasePath) || databasePath.includes("\u0000"))) {
    errors.push({ variable: "DATABASE_PATH", code: "malformed" });
  }

  const botToken = required(env, "SLACK_BOT_TOKEN", errors);
  if (botToken !== null && !BOT_TOKEN_PATTERN.test(botToken)) errors.push({ variable: "SLACK_BOT_TOKEN", code: "malformed" });
  const appToken = required(env, "SLACK_APP_TOKEN", errors);
  if (appToken !== null && !APP_TOKEN_PATTERN.test(appToken)) errors.push({ variable: "SLACK_APP_TOKEN", code: "malformed" });

  if (errors.length > 0 || teamRaw === null || users === null || channels === null || databasePath === null || botToken === null || appToken === null) {
    return { ok: false, errors };
  }
  const userId = users[0];
  if (users.length !== 1 || userId === undefined) return { ok: false, errors: [{ variable: "ALLOWED_USER_IDS", code: "no_users" }] };

  return {
    ok: true,
    config: { auth: { teamId: teamRaw, userId, channelIds: new Set(channels) }, databasePath, botToken, appToken },
  };
}
