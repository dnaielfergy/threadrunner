/**
 * The child gets only what it needs to find its own installation and behave sanely. Everything
 * else in the bridge's environment (Slack tokens, database path, allowlists) stays behind.
 * An allowlist, not a denylist: a variable added to the parent later is not inherited by accident.
 */
export const BASE_CHILD_ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"] as const;

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Names that can never be passed to a child, even if someone adds them to an extra allowlist. */
const FORBIDDEN_PASSTHROUGH = /^(SLACK_|ALLOWED_|DATABASE_|APPROVED_|RUNNER_|CODEX_BIN$)/;

export const isForbiddenPassthrough = (name: string): boolean => FORBIDDEN_PASSTHROUGH.test(name);

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Pure: build the child's environment from `parent`. `extraAllow` is for provider settings the
 * operator has explicitly approved; a name that is malformed or on the forbidden list throws,
 * because that is a programming or configuration error, never something to skip quietly.
 * Values that are empty or contain NUL are dropped.
 */
export function buildChildEnv(parent: Env, extraAllow: readonly string[] = []): Record<string, string> {
  for (const name of extraAllow) {
    if (!NAME_PATTERN.test(name) || isForbiddenPassthrough(name)) throw new RangeError("environment variable cannot be passed to the provider");
  }
  const child: Record<string, string> = {};
  for (const name of [...BASE_CHILD_ENV_ALLOWLIST, ...extraAllow]) {
    const value = parent[name];
    if (typeof value === "string" && value !== "" && !value.includes("\u0000")) child[name] = value;
  }
  return child;
}
