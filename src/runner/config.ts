import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ConfigError } from "../slack/config.js";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from "./limits.js";
import { canonicalizeRepoRoot, isInside } from "./repo-root.js";

export interface RunnerConfig {
  /** Canonical (realpath) repository root. The only directory a provider may be started in. */
  readonly repoRoot: string;
  /** Absolute path to the Codex executable. Never looked up through PATH. */
  readonly codexBin: string;
  readonly timeoutMs: number;
}

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
 * and `RUNNER_DEFAULT_MODE` other than `read_only`.
 */
export function loadRunnerConfig(env: Env, options: { readonly databasePath: string }): RunnerConfigResult {
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
  const mode = env["RUNNER_DEFAULT_MODE"];
  if (mode !== undefined && mode.trim() !== "" && mode.trim() !== "read_only") errors.push({ variable: "RUNNER_DEFAULT_MODE", code: "unsupported" });

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
  return { ok: true, config: { repoRoot, codexBin, timeoutMs } };
}
