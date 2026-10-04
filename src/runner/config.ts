import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ConfigError } from "../slack/config.js";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from "./limits.js";
import { CHANNEL_ID_PATTERN } from "../store/validate.js";
import { canonicalizeRepoRoot, isInside } from "./repo-root.js";

export interface RunnerConfig {
  /** Canonical (realpath) repository root. The only directory a provider may be started in. */
  readonly repoRoot: string;
  /** Absolute path to the Codex executable. Never looked up through PATH. */
  readonly codexBin: string;
  readonly timeoutMs: number;
  /** Null unless `RUNNER_DEFAULT_MODE=build_with_approval`. Edit tasks are refused everywhere when null. */
  readonly edit: EditConfig | null;
}

export interface EditConfig {
  /** Channels where `--edit` is allowed. Always a subset of the authorized channels. */
  readonly channelIds: ReadonlySet<string>;
  /** Canonical, private directory that holds one worktree per edit run. Outside the repository. */
  readonly worktreeRoot: string;
  readonly approvalTtlMs: number;
  /** Absolute path to git. Used only by the worktree code, through the launcher. */
  readonly gitBin: string;
  /** A finished run's worktree is kept this long for review, then removed. */
  readonly retentionDays: number;
  /** Most worktrees kept at once. At the cap, new approvals wait for cleanup. */
  readonly maxRetained: number;
}

export const DEFAULT_APPROVAL_TTL_MINUTES = 60;
export const MIN_APPROVAL_TTL_MINUTES = 5;
export const MAX_APPROVAL_TTL_MINUTES = 1440;
/** Keeps the approval request, which shows the folder, inside one Slack message. */
export const MAX_WORKTREE_ROOT_LENGTH = 200;
export const DEFAULT_WORKTREE_RETENTION_DAYS = 7;
export const MAX_WORKTREE_RETENTION_DAYS = 365;
export const DEFAULT_WORKTREE_MAX_RETAINED = 20;
export const MAX_WORKTREE_MAX_RETAINED = 200;

export type RunnerConfigResult =
  | { readonly ok: true; readonly config: RunnerConfig }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Reads only the `env` it is given, plus the filesystem to canonicalize paths. Fails closed with
 * variable names and codes (never values). Exactly ONE repository root is accepted for now, and
 * it is taken from configuration only.
 *
 * Settings that would widen what the runner may do are refused rather than ignored:
 * `CODEX_FLAGS` (extra provider flags could carry a bypass flag), `RUNNER_CONCURRENCY` other than 1,
 * and `RUNNER_DEFAULT_MODE` other than `read_only` or `build_with_approval`. The latter enables
 * edit tasks and then requires `EDIT_CHANNEL_IDS` and `WORKTREE_ROOT`.
 */
export function loadRunnerConfig(
  env: Env,
  options: { readonly databasePath: string; readonly allowedChannelIds?: ReadonlySet<string> },
): RunnerConfigResult {
  const errors: ConfigError[] = [];

  let repoRoot: string | null = null;
  const rootsRaw = env["APPROVED_REPO_ROOTS"];
  if (rootsRaw === undefined || rootsRaw.trim() === "") {
    errors.push({ variable: "APPROVED_REPO_ROOTS", code: "missing" });
  } else {
    const entries = rootsRaw.split(",").map((entry) => entry.trim());
    if (entries.length > 1) {
      errors.push({ variable: "APPROVED_REPO_ROOTS", code: "too_many_roots" });
    } else {
      const result = canonicalizeRepoRoot(entries[0] ?? "", { forbidContaining: options.databasePath });
      if (result.ok) repoRoot = result.root;
      else errors.push({ variable: "APPROVED_REPO_ROOTS", code: result.error });
    }
  }

  let codexBin: string | null = null;
  const binRaw = env["CODEX_BIN"]?.trim();
  if (binRaw === undefined || binRaw === "") {
    errors.push({ variable: "CODEX_BIN", code: "missing" });
  } else if (!isAbsolute(binRaw) || binRaw.includes("\u0000")) {
    errors.push({ variable: "CODEX_BIN", code: "not_absolute" });
  } else {
    try {
      const real = realpathSync(binRaw);
      if (!statSync(real).isFile()) {
        errors.push({ variable: "CODEX_BIN", code: "not_executable" });
      } else {
        accessSync(real, constants.X_OK);
        // A provider binary inside the repository would be repository content, which is untrusted.
        if (repoRoot !== null && isInside(repoRoot, real)) errors.push({ variable: "CODEX_BIN", code: "inside_repo" });
        else codexBin = binRaw;
      }
    } catch {
      errors.push({ variable: "CODEX_BIN", code: "not_found" });
    }
  }

  const flags = env["CODEX_FLAGS"];
  if (flags !== undefined && flags.trim() !== "") errors.push({ variable: "CODEX_FLAGS", code: "unsupported" });
  const concurrency = env["RUNNER_CONCURRENCY"];
  if (concurrency !== undefined && concurrency.trim() !== "" && concurrency.trim() !== "1") {
    errors.push({ variable: "RUNNER_CONCURRENCY", code: "unsupported" });
  }
  const mode = env["RUNNER_DEFAULT_MODE"]?.trim() ?? "";
  if (mode !== "" && mode !== "read_only" && mode !== "build_with_approval") errors.push({ variable: "RUNNER_DEFAULT_MODE", code: "unsupported" });

  let edit: EditConfig | null = null;
  if (mode === "build_with_approval") edit = loadEditConfig(env, { repoRoot, databasePath: options.databasePath, allowed: options.allowedChannelIds }, errors);

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const timeoutRaw = env["RUNNER_TIMEOUT_SECONDS"]?.trim();
  if (timeoutRaw !== undefined && timeoutRaw !== "") {
    const seconds = /^[0-9]{1,5}$/.test(timeoutRaw) ? Number(timeoutRaw) : Number.NaN;
    if (!Number.isInteger(seconds) || seconds * 1000 < MIN_TIMEOUT_MS || seconds * 1000 > MAX_TIMEOUT_MS) {
      errors.push({ variable: "RUNNER_TIMEOUT_SECONDS", code: "malformed" });
    } else {
      timeoutMs = seconds * 1000;
    }
  }

  if (errors.length > 0 || repoRoot === null || codexBin === null) return { ok: false, errors };
  // An enabled edit mode that failed validation has already added errors above.
  if (mode === "build_with_approval" && edit === null) return { ok: false, errors };
  return { ok: true, config: { repoRoot, codexBin, timeoutMs, edit } };
}

function loadEditConfig(
  env: Env,
  context: { readonly repoRoot: string | null; readonly databasePath: string; readonly allowed: ReadonlySet<string> | undefined },
  errors: ConfigError[],
): EditConfig | null {
  const before = errors.length;

  const channelsRaw = env["EDIT_CHANNEL_IDS"]?.trim() ?? "";
  const channelIds = new Set<string>();
  if (channelsRaw === "") {
    errors.push({ variable: "EDIT_CHANNEL_IDS", code: "missing" });
  } else {
    const entries = channelsRaw.split(",").map((entry) => entry.trim());
    if (entries.some((entry) => !CHANNEL_ID_PATTERN.test(entry))) errors.push({ variable: "EDIT_CHANNEL_IDS", code: "malformed" });
    else if (new Set(entries).size !== entries.length) errors.push({ variable: "EDIT_CHANNEL_IDS", code: "duplicate_entry" });
    else if (context.allowed === undefined || entries.some((entry) => !context.allowed?.has(entry))) {
      errors.push({ variable: "EDIT_CHANNEL_IDS", code: "not_in_allowlist" });
    } else for (const entry of entries) channelIds.add(entry);
  }

  let worktreeRoot: string | null = null;
  const rootRaw = env["WORKTREE_ROOT"]?.trim() ?? "";
  if (rootRaw === "") {
    errors.push({ variable: "WORKTREE_ROOT", code: "missing" });
  } else {
    const result = canonicalizeRepoRoot(rootRaw, { forbidContaining: context.databasePath });
    if (!result.ok) errors.push({ variable: "WORKTREE_ROOT", code: result.error });
    else if (result.root.length > MAX_WORKTREE_ROOT_LENGTH) errors.push({ variable: "WORKTREE_ROOT", code: "malformed" });
    else if (context.repoRoot !== null && (isInside(context.repoRoot, result.root) || isInside(result.root, context.repoRoot))) {
      errors.push({ variable: "WORKTREE_ROOT", code: "overlaps_repo" });
    } else {
      const stat = statSync(result.root);
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) errors.push({ variable: "WORKTREE_ROOT", code: "not_owner" });
      else if ((stat.mode & 0o077) !== 0) errors.push({ variable: "WORKTREE_ROOT", code: "unsafe_permissions" });
      else worktreeRoot = result.root;
    }
  }

  let approvalTtlMs = DEFAULT_APPROVAL_TTL_MINUTES * 60_000;
  const ttlRaw = env["APPROVAL_TTL_MINUTES"]?.trim() ?? "";
  if (ttlRaw !== "") {
    const minutes = /^[0-9]{1,4}$/.test(ttlRaw) ? Number(ttlRaw) : Number.NaN;
    if (!Number.isInteger(minutes) || minutes < MIN_APPROVAL_TTL_MINUTES || minutes > MAX_APPROVAL_TTL_MINUTES) {
      errors.push({ variable: "APPROVAL_TTL_MINUTES", code: "malformed" });
    } else {
      approvalTtlMs = minutes * 60_000;
    }
  }

  let gitBin: string | null = null;
  const gitRaw = env["GIT_BIN"]?.trim() ?? "";
  if (gitRaw === "") {
    errors.push({ variable: "GIT_BIN", code: "missing" });
  } else if (!isAbsolute(gitRaw) || gitRaw.includes("\u0000")) {
    errors.push({ variable: "GIT_BIN", code: "not_absolute" });
  } else {
    try {
      const real = realpathSync(gitRaw);
      if (!statSync(real).isFile()) {
        errors.push({ variable: "GIT_BIN", code: "not_executable" });
      } else {
        accessSync(real, constants.X_OK);
        // Git inside the repository would be repository content, which is untrusted.
        if (context.repoRoot !== null && isInside(context.repoRoot, real)) errors.push({ variable: "GIT_BIN", code: "inside_repo" });
        else gitBin = gitRaw;
      }
    } catch {
      errors.push({ variable: "GIT_BIN", code: "not_found" });
    }
  }

  const bounded = (variable: string, fallback: number, max: number): number => {
    const raw = env[variable]?.trim() ?? "";
    if (raw === "") return fallback;
    const value = /^[0-9]{1,4}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(value) || value < 1 || value > max) {
      errors.push({ variable, code: "malformed" });
      return fallback;
    }
    return value;
  };
  const retentionDays = bounded("WORKTREE_RETENTION_DAYS", DEFAULT_WORKTREE_RETENTION_DAYS, MAX_WORKTREE_RETENTION_DAYS);
  const maxRetained = bounded("WORKTREE_MAX_RETAINED", DEFAULT_WORKTREE_MAX_RETAINED, MAX_WORKTREE_MAX_RETAINED);

  if (errors.length > before || worktreeRoot === null || gitBin === null) return null;
  return { channelIds, worktreeRoot, approvalTtlMs, gitBin, retentionDays, maxRetained };
}
