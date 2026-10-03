import { isModelProfile, type ModelProfile, type Provider } from "../domain/types.js";

export type Command =
  | {
      readonly kind: "task";
      readonly provider: Provider;
      readonly profile: ModelProfile;
      readonly prompt: string;
    }
  | { readonly kind: "status" }
  | { readonly kind: "cancel" }
  | { readonly kind: "approve"; readonly runId: string };

export type ParseErrorCode =
  | "not_a_command"
  | "unknown_command"
  | "unknown_profile"
  | "missing_prompt"
  | "unexpected_arguments"
  | "malformed_approval";

export type ParseResult =
  | { readonly ok: true; readonly command: Command }
  | { readonly ok: false; readonly error: ParseErrorCode; readonly message: string };

/** Run IDs are bridge-generated: `run-` plus 3 to 32 lowercase alphanumerics. Plain words like "yes" never match. */
export const RUN_ID_PATTERN = /^run-[a-z0-9]{3,32}$/;

const TASK_COMMANDS = {
  "/codex": "codex",
  "/claude": "claude",
  "/auto": "auto",
} as const satisfies Record<string, Provider>;

// Anything that is not printable text plus ordinary whitespace (e.g. NUL or other control chars).
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const fail = (error: ParseErrorCode, message: string): ParseResult => ({ ok: false, error, message });

/**
 * Parse a message into an explicit command. Pure and fail-closed: anything that is
 * not an exact, recognised command yields an error and must not be acted on.
 *
 * Grammar (command must be the first token; matching is case-sensitive):
 *   /codex|/claude|/auto <fast|default|deep> <prompt>
 *   /status
 *   /cancel
 *   /approve <run-id>
 *
 * The profile is mandatory and must be an alias; arbitrary provider model IDs,
 * flags, and a missing profile are all rejected. Prompts are opaque text: never
 * tokenised, expanded, or interpreted as shell.
 */
export function parseCommand(input: string): ParseResult {
  if (DISALLOWED_CONTROL.test(input)) {
    return fail("not_a_command", "message contains control characters");
  }

  const text = input.trim();
  if (!text.startsWith("/")) return fail("not_a_command", "message is not a command");

  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const name = match?.[1] ?? "";
  const rest = (match?.[2] ?? "").trim();

  if (name === "/status" || name === "/cancel") {
    if (rest !== "") return fail("unexpected_arguments", `${name} takes no arguments`);
    return { ok: true, command: { kind: name === "/status" ? "status" : "cancel" } };
  }

  if (name === "/approve") {
    if (!RUN_ID_PATTERN.test(rest)) {
      return fail("malformed_approval", "usage: /approve <run-id>");
    }
    return { ok: true, command: { kind: "approve", runId: rest } };
  }

  if (Object.hasOwn(TASK_COMMANDS, name)) {
    const provider = TASK_COMMANDS[name as keyof typeof TASK_COMMANDS];
    return parseTask(provider, name, rest);
  }

  return fail("unknown_command", `unknown command: ${name.slice(0, 32)}`);
}

function parseTask(provider: Provider, name: string, rest: string): ParseResult {
  const usage = `usage: ${name} <fast|default|deep> <prompt>`;
  if (rest === "") return fail("missing_prompt", usage);

  const first = rest.split(/\s+/, 1)[0] ?? "";
  if (!isModelProfile(first)) {
    return fail("unknown_profile", "model profile must be one of: fast, default, deep");
  }

  const prompt = rest.slice(first.length).trim();
  if (prompt === "") return fail("missing_prompt", usage);
  return { ok: true, command: { kind: "task", provider, profile: first, prompt } };
}
