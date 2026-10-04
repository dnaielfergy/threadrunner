import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

export type RepoRootError = "malformed" | "not_absolute" | "not_found" | "not_directory" | "unsafe_root";

export type RepoRootResult = { readonly ok: true; readonly root: string } | { readonly ok: false; readonly error: RepoRootError };

/** True if `inner` is `outer` or lives below it. Both must already be absolute and normalized. */
export function isInside(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Best-effort canonical form of a path that may not exist yet (the database file): real parent plus the file name. */
export function canonicalPathOrResolved(path: string): string {
  try {
    return resolve(realpathSync(dirname(path)), basename(path));
  } catch {
    return resolve(path);
  }
}

/**
 * Turn the configured repository root into its canonical (symlink-free) absolute path, or refuse.
 * The value comes from configuration only; nothing from Slack ever reaches this function.
 *
 *  - must be a non-empty absolute path (no `~`, no relative paths: the environment file does not expand them)
 *  - must not contain `..` segments: a configured path is written out in full, so a traversal is a mistake or an attack
 *  - must exist and be a directory after `realpath`
 *  - must not be the filesystem root or the home directory itself (far too broad)
 *  - must not contain `forbidContaining` (the database file), or the child could read stored prompts
 */
export function canonicalizeRepoRoot(raw: string, options: { readonly forbidContaining?: string } = {}): RepoRootResult {
  if (typeof raw !== "string" || raw.trim() === "" || raw.includes("\u0000")) return { ok: false, error: "malformed" };
  const path = raw.trim();
  if (!isAbsolute(path)) return { ok: false, error: "not_absolute" };
  if (path.split(/[\\/]+/).includes("..")) return { ok: false, error: "malformed" };

  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { ok: false, error: "not_found" };
  }
  try {
    if (!statSync(real).isDirectory()) return { ok: false, error: "not_directory" };
  } catch {
    return { ok: false, error: "not_found" };
  }
  if (real === parse(real).root || real === safeRealpath(homedir())) return { ok: false, error: "unsafe_root" };
  if (options.forbidContaining !== undefined && isInside(real, canonicalPathOrResolved(options.forbidContaining))) {
    return { ok: false, error: "unsafe_root" };
  }
  return { ok: true, root: real };
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Re-check, immediately before a run, that the root is still the same real directory it was at
 * startup. A directory swapped for a symlink (or removed) after startup fails here, so the
 * provider is never started in a different place than the one that was approved.
 */
export function repoRootStillValid(canonical: string): boolean {
  try {
    return realpathSync(canonical) === canonical && statSync(canonical).isDirectory();
  } catch {
    return false;
  }
}
