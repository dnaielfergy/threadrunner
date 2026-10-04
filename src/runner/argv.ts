import { isAbsolute } from "node:path";
import { MAX_EDIT_PROMPT_LENGTH, MAX_PROMPT_LENGTH } from "../parser/command.js";
import type { Invocation } from "./runner.js";

/**
 * The complete Codex argument list, verified against `codex exec --help` for codex-cli 0.160.0.
 * Every entry is deliberate; adding one is a security decision (see runner/README section in README.md).
 *
 *   exec                          non-interactive mode
 *   --sandbox read-only           the CLI's own sandbox: model-run commands cannot write
 *   --cd <root>                   working root = the canonical configured repository
 *   --ephemeral                   do not persist session files (they would contain the prompt)
 *   --ignore-user-config          do not load ~/.codex/config.toml (no extra MCP servers, no looser sandbox)
 *   --ignore-rules                do not load execpolicy .rules files from the user or the repository
 *   --color never                 no terminal escape codes in text that goes to Slack
 *   -                             read the prompt from standard input (never from argv)
 *
 * Deliberately absent: every permission-bypass flag (SECURITY.md; argv.test.ts lists them), the
 * automatic-approval mode, worktrees, extra writable directories, config overrides, alternative
 * providers, image input, model and profile selection, and any other sandbox mode.
 */
export const CODEX_FIXED_ARGS = [
  "exec",
  "--sandbox",
  "read-only",
  "--cd",
  "{repoRoot}",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--color",
  "never",
  "-",
] as const;

/**
 * Pure: the argument list and standard input for one read-only Codex run.
 *
 * The prompt is only ever the standard input. It is never an argument, so it cannot be read as an
 * option and never reaches a shell. `repoRoot` comes from configuration (already canonical and
 * absolute, so it cannot look like an option either) and is checked again here.
 * The model profile is not mapped to a model yet: Codex uses its own default.
 */
export function buildCodexInvocation(input: { readonly prompt: string; readonly repoRoot: string; readonly profile?: string }): Invocation {
  const { prompt, repoRoot } = input;
  if (typeof prompt !== "string" || prompt.trim() === "" || prompt.length > MAX_PROMPT_LENGTH || prompt.includes("\u0000")) {
    throw new RangeError("invalid prompt");
  }
  if (typeof repoRoot !== "string" || !isAbsolute(repoRoot) || repoRoot.includes("\u0000")) throw new RangeError("invalid repository root");
  return {
    args: CODEX_FIXED_ARGS.map((arg) => (arg === "{repoRoot}" ? repoRoot : arg)),
    stdin: prompt,
  };
}

/**
 * The write run: the same flags as above with the CLI's own `workspace-write` sandbox and the
 * working root set to the run's disposable worktree (never the owner's checkout). The spike
 * (docs/design/approvals-and-worktrees.md, section 12) showed this sandbox lets the process write
 * inside the worktree, blocks writes to the repository's `.git` and so blocks commits, and has no
 * network. Still absent: every bypass flag, `danger-full-access`, `--add-dir`, `--approve-for-me`,
 * `--worktree`, config overrides and `--oss`.
 */
export const CODEX_WRITE_FIXED_ARGS = [
  "exec",
  "--sandbox",
  "workspace-write",
  "--cd",
  "{worktree}",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--color",
  "never",
  "-",
] as const;

/** Pure: the arguments and standard input for one write run inside `worktree`. The prompt is only ever standard input. */
export function buildCodexWriteInvocation(input: { readonly prompt: string; readonly worktree: string }): Invocation {
  const { prompt, worktree } = input;
  if (typeof prompt !== "string" || prompt.trim() === "" || prompt.length > MAX_EDIT_PROMPT_LENGTH || prompt.includes("\u0000")) {
    throw new RangeError("invalid prompt");
  }
  if (typeof worktree !== "string" || !isAbsolute(worktree) || worktree.includes("\u0000")) throw new RangeError("invalid worktree");
  return {
    args: CODEX_WRITE_FIXED_ARGS.map((arg) => (arg === "{worktree}" ? worktree : arg)),
    stdin: prompt,
  };
}
