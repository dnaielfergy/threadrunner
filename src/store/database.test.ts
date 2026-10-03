import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createRunFromEvent, getRun, openStore, SCHEMA_VERSION, StoreError } from "./index.js";
import { BINDING, newRun, open, tempDbPath, tempDir } from "./test-utils.js";

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("opening the database", () => {
  it("enables foreign keys, WAL, a busy timeout, and sets the schema version", () => {
    const store = open(tempDbPath());
    const pragma = (name: string): unknown => Object.values(store.db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
    expect(pragma("foreign_keys")).toBe(1);
    expect(pragma("journal_mode")).toBe("wal");
    expect(pragma("busy_timeout")).toBe(5000);
    expect(pragma("user_version")).toBe(SCHEMA_VERSION);
  });

  it("fails closed when the database has a newer schema version", () => {
    const path = tempDbPath();
    open(path).close();
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => openStore({ path, allowInRepo: true })).toThrowError(expect.objectContaining({ code: "schema_too_new" }));
  });

  it("refuses an existing database that is not a ThreadRunner database", () => {
    const path = tempDbPath();
    mkdirSync(join(path, ".."), { recursive: true });
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE something_else (x)");
    raw.close();
    chmodSync(path, 0o600);
    expect(() => openStore({ path })).toThrowError(expect.objectContaining({ code: "foreign_database" }));
  });

  it("does not re-run migrations on reopen", () => {
    const path = tempDbPath();
    open(path).close();
    expect(() => open(path)).not.toThrow();
  });
});

describe("file and directory permissions", () => {
  it("creates the directory as 0700 and the database file as 0600", () => {
    const dir = tempDir();
    const path = join(dir, "a", "b", "threadrunner.db");
    const store = open(path);
    createRunFromEvent(store, newRun()); // force WAL sidecar files into existence
    expect(mode(join(dir, "a"))).toBe(0o700);
    expect(mode(join(dir, "a", "b"))).toBe(0o700);
    expect(mode(path)).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(path + suffix)) expect(mode(path + suffix) & 0o077).toBe(0);
    }
  });

  it("does not loosen an existing stricter directory or file", () => {
    const dir = tempDir();
    const path = join(dir, "threadrunner.db");
    open(path).close();
    chmodSync(path, 0o400);
    chmodSync(dir, 0o500);
    try {
      // 0400 file is not writable, so this may fail to open; either way modes must be unchanged.
      try {
        open(path).close();
      } catch {
        // acceptable
      }
      expect(mode(path)).toBe(0o400);
      expect(mode(dir)).toBe(0o500);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("refuses an existing database file that is group- or world-accessible", () => {
    const path = tempDbPath();
    open(path).close();
    chmodSync(path, 0o644);
    expect(() => openStore({ path, allowInRepo: true })).toThrowError(expect.objectContaining({ code: "insecure_location" }));
    expect(mode(path)).toBe(0o644);
  });

  it("refuses a symlinked database path", () => {
    const dir = tempDir();
    const target = join(dir, "real.db");
    writeFileSync(target, "", { mode: 0o600 });
    const link = join(dir, "link.db");
    symlinkSync(target, link);
    expect(() => openStore({ path: link, allowInRepo: true })).toThrowError(expect.objectContaining({ code: "insecure_location" }));
  });

  it("refuses relative paths, empty paths, and file: URIs", () => {
    for (const path of ["data/x.db", "", "file:/tmp/x.db", ":memory:"]) {
      expect(() => openStore({ path }), path).toThrowError(expect.objectContaining({ code: "invalid_path" }));
    }
  });

  it("refuses a location inside a git working tree unless explicitly allowed", () => {
    const repo = tempDir();
    mkdirSync(join(repo, ".git"));
    const path = join(repo, "data", "threadrunner.db");
    expect(() => openStore({ path })).toThrowError(expect.objectContaining({ code: "insecure_location" }));
    expect(existsSync(path)).toBe(false);
    expect(() => open(path, { allowInRepo: true })).not.toThrow();
  });

  it("is a StoreError so callers can distinguish it", () => {
    expect(() => openStore({ path: "relative.db" })).toThrow(StoreError);
  });
});

describe("persistence after reopen", () => {
  it("retains runs, idempotency state, and bindings across a close and reopen", () => {
    const path = tempDbPath();
    const first = open(path);
    const created = createRunFromEvent(first, newRun());
    expect(created.status).toBe("created");
    first.close();

    const second = open(path);
    const run = getRun(second, BINDING);
    expect(run?.state).toBe("received");
    expect(run?.prompt).toBe(newRun().prompt);
    // The same event after a restart is still a duplicate.
    expect(createRunFromEvent(second, newRun()).status).toBe("duplicate");
    expect(second.db.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 1 });
  });
});
