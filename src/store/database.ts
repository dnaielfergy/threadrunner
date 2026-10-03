import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { StoreError } from "./errors.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

export type Row = Record<string, SQLOutputValue>;

export interface Store {
  readonly db: DatabaseSync;
  readonly now: () => number;
  /** Returns the random part of a run ID (the store prepends `run-`). */
  readonly randomId: () => string;
  close(): void;
}

export interface OpenStoreOptions {
  /** Absolute path to the database file. */
  readonly path: string;
  /** Epoch milliseconds. Injectable for tests. */
  readonly now?: () => number;
  /** Lowercase alphanumeric suffix for run IDs. Injectable for tests. Must be cryptographically random. */
  readonly randomId?: () => string;
  /** Permit a database location inside a git working tree. Off by default; intended for tests only. */
  readonly allowInRepo?: boolean;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const BUSY_TIMEOUT_MS = 5000;

const defaultRandomId = (): string => randomBytes(10).toString("hex");

function isInsideGitRepo(path: string): boolean {
  let probe = dirname(path);
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let dir = realpathSync(probe);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Create the directory (0700) and file (0600) if needed; refuse to use anything looser or unusual. Never loosens modes. */
function prepareLocation(path: string, allowInRepo: boolean): void {
  if (typeof path !== "string" || path.length === 0 || path.includes("\u0000") || !isAbsolute(path)) {
    throw new StoreError("invalid_path", "database path must be an absolute file path");
  }
  if (!allowInRepo && isInsideGitRepo(path)) {
    throw new StoreError("insecure_location", "database path is inside a git working tree; use a directory outside any repository");
  }
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });

  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    // Create with the final mode up front so the file never exists with umask-default permissions.
    closeSync(openSync(path, "wx", FILE_MODE));
    return;
  }
  if (!stat.isFile()) throw new StoreError("insecure_location", "database path is a symlink or not a regular file");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new StoreError("insecure_location", "database file is not owned by the current user");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new StoreError("insecure_location", "database file is accessible to other users; run chmod 600 on it");
  }
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get();
  const version = Number(row?.["user_version"] ?? 0);
  if (version > SCHEMA_VERSION) {
    throw new StoreError("schema_too_new", `database schema version ${version} is newer than supported version ${SCHEMA_VERSION}`);
  }
  if (version === 0) {
    const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
    if (Number(tables?.["n"] ?? 0) !== 0) {
      throw new StoreError("foreign_database", "database has tables but no ThreadRunner schema version; refusing to use it");
    }
  }
  for (let next = version + 1; next <= SCHEMA_VERSION; next++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[next - 1] as string);
      db.exec(`PRAGMA user_version = ${next}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function openStore(options: OpenStoreOptions): Store {
  prepareLocation(options.path, options.allowInRepo ?? false);
  const db = new DatabaseSync(options.path);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const mode = db.prepare("PRAGMA journal_mode = WAL").get();
    if (String(mode?.["journal_mode"]).toLowerCase() !== "wal") {
      throw new StoreError("unsupported_journal_mode", "could not enable WAL journal mode on this filesystem");
    }
    db.exec("PRAGMA synchronous = FULL");
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    db,
    now: options.now ?? Date.now,
    randomId: options.randomId ?? defaultRandomId,
    close: () => db.close(),
  };
}

/** Run `fn` in an immediate transaction: all writes commit together or not at all. */
export function inTransaction<T>(store: Store, fn: () => T): T {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    store.db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      store.db.exec("ROLLBACK");
    } catch {
      // The original error is the one worth reporting.
    }
    throw error;
  }
}

export function timestamp(store: Store): number {
  const value = store.now();
  if (!Number.isSafeInteger(value) || value < 0) throw new StoreError("bad_clock", "clock must return non-negative integer milliseconds");
  return value;
}

export function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new StoreError("corrupt_row", `expected text in column ${key}`);
  return value;
}

export function int(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new StoreError("corrupt_row", `expected integer in column ${key}`);
  return value;
}

export function nullableInt(row: Row, key: string): number | null {
  return row[key] === null ? null : int(row, key);
}
