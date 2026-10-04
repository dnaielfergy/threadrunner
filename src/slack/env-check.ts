import { constants, lstatSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Startup check for the `.env` file `npm start` loads. It holds the Slack tokens, so it must not be
 * reachable by other local users. This is the only module under src/slack allowed to import node:fs
 * (see no-execution.test.ts). It performs one `lstat` and never opens or reads the file, so no
 * content can reach a log, an error, or a return value.
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
  /** Owner the file must have. `undefined` where the platform has no uid. */
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

  const type = stat.mode & constants.S_IFMT;
  if (type === constants.S_IFLNK) return refuse("env_symlink");
  if (type !== constants.S_IFREG) return refuse("env_not_regular");
  if (options.uid !== undefined && stat.uid !== options.uid) return refuse("env_wrong_owner");
  if (stat.mode & 0o007) return refuse("env_other_access");
  if (stat.mode & 0o070) return refuse("env_group_access");
  return { ok: true };
}

/** The production check: `./.env` relative to the working directory, using the real `lstat`. */
export function createEnvFileCheck(): () => EnvCheckResult {
  return () =>
    checkEnvFile({
      path: resolve(".env"),
      lstat: lstatSync,
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
      platform: process.platform,
    });
}
