import { dirname, join } from "node:path";
import type { Launcher } from "./process.js";
import { supervise } from "./supervise.js";

/**
 * The ONLY place the bridge runs git. Git can execute programs named in repository configuration,
 * hooks, attributes and filesystem-monitor settings, and an edit run's sandboxed process can write
 * inside its worktree (including the `.git` pointer file there). So every call:
 *
 *  - goes through the injected `Launcher` (launcher.ts stays the only file that starts processes)
 *    with an argument array, an absolute `GIT_BIN`, and a scrubbed environment: no global or
 *    system configuration, no prompts, no inherited variables;
 *  - names the git directory explicitly (`--git-dir`, plus `--work-tree` for worktree commands),
 *    so a rewritten `.git` pointer file is never followed;
 *  - disables hooks (`core.hooksPath=/dev/null`) and the filesystem monitor, takes no optional locks;
 *  - reads attributes from the trusted base commit (`--attr-source`), and never runs external diff
 *    or textconv drivers.
 *
 * Verified by the spike (docs/design/approvals-and-worktrees.md, section 12) and by the hostile
 * repository tests in git.test.ts, which run the exact commands below against planted canaries.
 * Nothing in an argument comes from Slack or the provider except the run-ID-derived path and branch.
 */

const SAFE_ENV: Readonly<Record<string, string>> = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
};

const HARDENING_ARGS: readonly string[] = [
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
];

export const GIT_DEFAULT_TIMEOUT_MS = 120_000;
/** Most output read from one git command. Past this the command is stopped and the result marked truncated. */
export const GIT_MAX_OUTPUT_BYTES = 1_048_576;
/** Most changed files kept in a summary. Counts keep going past it. */
export const MAX_SUMMARY_FILES = 500;
const MAX_DISPLAY_PATH = 200;

export type GitFailure = "spawn_failed" | "timeout" | "output_limit" | "nonzero_exit" | "signalled" | "aborted";
export type GitResult = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly reason: GitFailure; readonly stdout: string };

export interface FileChange {
  /** Display-safe: control and bidirectional characters replaced, long names cut. */
  readonly path: string;
  readonly status: "modified" | "added" | "deleted" | "other";
  /** Null for a new untracked file (not counted: the bridge does not read file contents) or a binary file. */
  readonly added: number | null;
  readonly removed: number | null;
  readonly binary: boolean;
}

export interface ChangeSummary {
  /** At most `MAX_SUMMARY_FILES`, sorted by path. */
  readonly files: readonly FileChange[];
  readonly totalFiles: number;
  /** Counted from tracked, text files only. */
  readonly totalAdded: number;
  readonly totalRemoved: number;
  /** True if git's output was cut off, so the totals are a lower bound. */
  readonly incomplete: boolean;
}

export interface WorktreeLocation {
  /** The linked worktree's administrative directory inside the main repository's `.git`. */
  readonly gitDir: string;
  readonly path: string;
  readonly baseSha: string;
}

export interface Git {
  /** True only if `sha` names a commit that exists in the repository. */
  commitExists(repoRoot: string, sha: string): Promise<boolean>;
  addWorktree(repoRoot: string, input: { path: string; branch: string; baseSha: string }): Promise<GitResult>;
  /** Registered worktree paths of the repository, or null if git could not say. */
  listWorktrees(repoRoot: string): Promise<string[] | null>;
  /** Working-tree changes against the base commit, or null if git could not run. */
  summarizeChanges(location: WorktreeLocation): Promise<ChangeSummary | null>;
  removeWorktree(repoRoot: string, path: string): Promise<GitResult>;
  pruneWorktrees(repoRoot: string): Promise<GitResult>;
  deleteBranch(repoRoot: string, branch: string): Promise<GitResult>;
}

export interface GitOptions {
  readonly launcher: Launcher;
  /** Absolute path from configuration, never looked up through PATH. */
  readonly gitBin: string;
  /** Where every command starts: a trusted directory outside the repository and every worktree. */
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RUN_BRANCH = /^threadrunner\/run-[a-z0-9]{3,32}$/;

export function createGit(options: GitOptions): Git {
  const { launcher, gitBin, cwd } = options;
  const timeoutMs = options.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? GIT_MAX_OUTPUT_BYTES;

  async function run(args: readonly string[]): Promise<GitResult> {
    const outcome = await supervise({
      launcher,
      spec: { command: gitBin, args: [...HARDENING_ARGS, ...args], cwd, env: SAFE_ENV, stdin: "" },
      timeoutMs,
      maxOutputBytes,
      pollMs: 1_000,
      shouldCancel: () => false,
    });
    switch (outcome.kind) {
      case "exited":
        return outcome.exitCode === 0 ? { ok: true, stdout: outcome.output } : { ok: false, reason: "nonzero_exit", stdout: outcome.output };
      case "timeout":
      case "output_limit":
      case "signalled":
        return { ok: false, reason: outcome.kind, stdout: outcome.output };
      case "spawn_failed":
        return { ok: false, reason: "spawn_failed", stdout: "" };
      default:
        return { ok: false, reason: "aborted", stdout: "" };
    }
  }

  const repoGitDir = (repoRoot: string): string => `--git-dir=${join(repoRoot, ".git")}`;

  return {
    commitExists: async (repoRoot, sha) => {
      if (!SHA.test(sha)) return false;
      return (await run([repoGitDir(repoRoot), "cat-file", "-e", `${sha}^{commit}`])).ok;
    },

    addWorktree: (repoRoot, { path, branch, baseSha }) => {
      if (!RUN_BRANCH.test(branch) || !SHA.test(baseSha) || dirname(path) === path) return Promise.resolve({ ok: false, reason: "nonzero_exit", stdout: "" });
      return run([repoGitDir(repoRoot), "worktree", "add", "--quiet", "-b", branch, path, baseSha]);
    },

    listWorktrees: async (repoRoot) => {
      const result = await run([repoGitDir(repoRoot), "worktree", "list", "--porcelain", "-z"]);
      if (!result.ok) return null;
      return result.stdout
        .split("\0")
        .filter((field) => field.startsWith("worktree "))
        .map((field) => field.slice("worktree ".length));
    },

    summarizeChanges: async ({ gitDir, path, baseSha }) => {
      if (!SHA.test(baseSha)) return null;
      const scope = [`--git-dir=${gitDir}`, `--work-tree=${path}`, `--attr-source=${baseSha}`];
      const status = await run([...scope, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
      const numstat = await run([...scope, "diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", baseSha, "--"]);
      // A cut-off listing is still useful, but only if git ran at all.
      if ((!status.ok && status.reason !== "output_limit") || (!numstat.ok && numstat.reason !== "output_limit")) return null;
      return buildSummary(status.stdout, numstat.stdout, !status.ok || !numstat.ok);
    },

    removeWorktree: (repoRoot, path) => run([repoGitDir(repoRoot), "worktree", "remove", "--force", path]),
    pruneWorktrees: (repoRoot) => run([repoGitDir(repoRoot), "worktree", "prune"]),
    deleteBranch: (repoRoot, branch) => {
      if (!RUN_BRANCH.test(branch)) return Promise.resolve({ ok: false, reason: "nonzero_exit", stdout: "" });
      return run([repoGitDir(repoRoot), "branch", "-D", branch]);
    },
  };
}

/** File names come from the agent, so they are shown only after control and bidirectional characters are removed. */
export function displayPath(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g, "?");
  return cleaned.length > MAX_DISPLAY_PATH ? `${cleaned.slice(0, MAX_DISPLAY_PATH)}...` : cleaned;
}

function statusOf(code: string): FileChange["status"] {
  if (code === "??") return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  if (code.includes("M")) return "modified";
  return "other";
}

/** Exposed for tests. Inputs are git's NUL-separated `status --porcelain=v1 -z` and `diff --numstat -z` output. */
export function buildSummary(statusOutput: string, numstatOutput: string, incomplete: boolean): ChangeSummary {
  const counts = new Map<string, { added: number | null; removed: number | null }>();
  const numFields = numstatOutput.split("\0");
  // A cut-off listing can end mid-record; the last field is dropped in that case.
  if (incomplete) numFields.pop();
  for (const field of numFields) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(field);
    if (!match) continue;
    counts.set(match[3] as string, { added: match[1] === "-" ? null : Number(match[1]), removed: match[2] === "-" ? null : Number(match[2]) });
  }

  const statusFields = statusOutput.split("\0");
  if (incomplete) statusFields.pop();
  const all: FileChange[] = [];
  for (const field of statusFields) {
    if (field.length < 4 || field[2] !== " ") continue;
    const path = field.slice(3);
    const status = statusOf(field.slice(0, 2));
    const count = counts.get(path);
    all.push({
      path: displayPath(path),
      status,
      added: count ? count.added : null,
      removed: count ? count.removed : null,
      binary: count !== undefined && count.added === null,
    });
  }
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    files: all.slice(0, MAX_SUMMARY_FILES),
    totalFiles: all.length,
    totalAdded: all.reduce((sum, f) => sum + (f.added ?? 0), 0),
    totalRemoved: all.reduce((sum, f) => sum + (f.removed ?? 0), 0),
    incomplete,
  };
}
