import { constants, lstatSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Startup check for the `.env` file `npm start` loads. It holds the Slack tokens, so it must not be
 * reachable by other local users. This is the only module under src/slack allowed to touch the
 * filesystem (see no-execution.test.ts, which pins its single import). It performs one `lstat` and
 * never opens or reads the file, so no content can reach a log, an error, or a return value.
 */

export type EnvFileCode = "env_symlink" | "env_not_regular" | "env_wrong_owner" | "env_group_access" | "env_other_access" | "env_unreadable";

export type EnvCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: EnvFileCode; readonly path: string };

/** The only fields of a stat result the check looks at. */
export interface EnvStat {
  readonly mode: number;
  readonly uid: number;
}

export interface EnvCheckOptions {
  readonly path: string;
  /** Must not follow symlinks. Throws with `code: "ENOENT"` when the file is absent. */
  readonly lstat: (path: string) => EnvStat;
  /** Owner the file must have. May be `undefined` only on Windows, where the check is skipped. */
  readonly uid: number | undefined;
  readonly platform: NodeJS.Platform;
}

export function checkEnvFile(options: EnvCheckOptions): EnvCheckResult {
  const { path } = options;
  const refuse = (code: EnvFileCode): EnvCheckResult => ({ ok: false, code, path });

  // POSIX mode bits do not mean the same thing on Windows, so the check is skipped there (see README).
  if (options.platform === "win32") return { ok: true };

  let stat: EnvStat;
  try {
    stat = options.lstat(path);
  } catch (error) {
    // No file: variables come from the shell or a supervisor, so there is nothing to protect here.
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return { ok: true };
    return refuse("env_unreadable");
  }

  // A missing uid on a POSIX platform means ownership cannot be verified, so fail closed.
  if (options.uid === undefined) return refuse("env_unreadable");

  const type = stat.mode & constants.S_IFMT;
  if (type === constants.S_IFLNK) return refuse("env_symlink");
  if (type !== constants.S_IFREG) return refuse("env_not_regular");
  if (stat.uid !== options.uid) return refuse("env_wrong_owner");
  if (stat.mode & 0o007) return refuse("env_other_access");
  if (stat.mode & 0o070) return refuse("env_group_access");
  return { ok: true };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The instruction printed with a refusal. Pure string formatting, the path is shell-quoted for copy and paste. */
export function envFileRemedy(code: EnvFileCode, path: string): string {
  const quoted = shellQuote(path);
  switch (code) {
    case "env_group_access":
    case "env_other_access":
      return `chmod 600 ${quoted}`;
    case "env_symlink":
      return `replace ${quoted} with a regular file that you own (chmod follows a symlink and does not fix it), then run: chmod 600 ${quoted}`;
    case "env_not_regular":
      return `replace ${quoted} with a regular file that you own, then run: chmod 600 ${quoted}`;
    case "env_wrong_owner":
      return `recreate ${quoted} as your own user, or have its owner or root run chown on it, then run: chmod 600 ${quoted}`;
    case "env_unreadable":
      return `check that ${quoted} and the directory containing it can be inspected by your user, then run: chmod 600 ${quoted}`;
  }
}

/** The production check: `.env` in the working directory (or `cwd`), using the real `lstat`. */
export function createEnvFileCheck(cwd: string = process.cwd()): () => EnvCheckResult {
  return () =>
    checkEnvFile({
      path: resolve(cwd, ".env"),
      lstat: lstatSync,
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
      platform: process.platform,
    });
}
