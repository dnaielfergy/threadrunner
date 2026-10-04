import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tempDir } from "../store/test-utils.js";
import { loadRunnerConfig } from "./config.js";
import { writeFakeCli } from "./test-utils.js";

function setup() {
  const base = realpathSync(tempDir());
  const repo = join(base, "repo");
  mkdirSync(repo);
  const bin = writeFakeCli(join(base, "bin"));
  const databasePath = join(base, "state", "threadrunner.db");
  const env = { APPROVED_REPO_ROOTS: repo, CODEX_BIN: bin };
  return { base, repo, bin, databasePath, env };
}

const errorsFor = (env: Record<string, string | undefined>, databasePath: string) => {
  const result = loadRunnerConfig(env, { databasePath });
  if (result.ok) throw new Error("expected failure");
  return result.errors;
};

describe("loadRunnerConfig", () => {
  it("accepts exactly one existing root and an absolute executable, canonicalized", () => {
    const { env, repo, bin, databasePath } = setup();
    const result = loadRunnerConfig(env, { databasePath });
    expect(result).toEqual({ ok: true, config: { repoRoot: repo, codexBin: bin, timeoutMs: 600_000, edit: null } });
  });

  it("ignores the unused runner settings from .env.example when they hold their only safe value", () => {
    const { env, databasePath } = setup();
    expect(loadRunnerConfig({ ...env, RUNNER_CONCURRENCY: "1", RUNNER_DEFAULT_MODE: "read_only", CODEX_FLAGS: "", PORT: "8877" }, { databasePath }).ok).toBe(true);
  });

  it("fails closed on zero roots", () => {
    const { env, databasePath } = setup();
    expect(errorsFor({ ...env, APPROVED_REPO_ROOTS: undefined }, databasePath)).toContainEqual({ variable: "APPROVED_REPO_ROOTS", code: "missing" });
    expect(errorsFor({ ...env, APPROVED_REPO_ROOTS: "  " }, databasePath)).toContainEqual({ variable: "APPROVED_REPO_ROOTS", code: "missing" });
  });

  it("fails closed on several roots, and on a trailing comma", () => {
    const { env, repo, base, databasePath } = setup();
    mkdirSync(join(base, "repo2"));
    expect(errorsFor({ ...env, APPROVED_REPO_ROOTS: `${repo},${join(base, "repo2")}` }, databasePath)).toContainEqual({ variable: "APPROVED_REPO_ROOTS", code: "too_many_roots" });
    expect(errorsFor({ ...env, APPROVED_REPO_ROOTS: `${repo},` }, databasePath)).toContainEqual({ variable: "APPROVED_REPO_ROOTS", code: "too_many_roots" });
  });

  it.each([
    ["relative", "code/project", "not_absolute"],
    ["tilde", "~/code/project", "not_absolute"],
    ["traversal", "/tmp/../etc", "malformed"],
  ])("fails closed on a %s root", (_name, value, code) => {
    const { env, databasePath } = setup();
    expect(errorsFor({ ...env, APPROVED_REPO_ROOTS: value }, databasePath)).toContainEqual({ variable: "APPROVED_REPO_ROOTS", code });
  });

  it("fails closed on a missing root and on a file", () => {
    const { env, base, bin, databasePath } = setup();
    expect(errorsFor({ ...env, APPROVED_REPO_ROOTS: join(base, "nope") }, databasePath)).toContainEqual({ variable: "APPROVED_REPO_ROOTS", code: "not_found" });
    expect(errorsFor({ ...env, APPROVED_REPO_ROOTS: bin }, databasePath)).toContainEqual({ variable: "APPROVED_REPO_ROOTS", code: "not_directory" });
  });

  it("canonicalizes a symlinked root, so the child's working directory is the real one", () => {
    const { env, base, repo, databasePath } = setup();
    const link = join(base, "link");
    symlinkSync(repo, link);
    const result = loadRunnerConfig({ ...env, APPROVED_REPO_ROOTS: link }, { databasePath });
    expect(result.ok && result.config.repoRoot).toBe(repo);
  });

  it("fails closed when the root would contain the database", () => {
    const { env, repo } = setup();
    expect(errorsFor(env, join(repo, "data", "threadrunner.db"))).toContainEqual({ variable: "APPROVED_REPO_ROOTS", code: "unsafe_root" });
  });

  it("requires CODEX_BIN to be an absolute path to an executable file, found without PATH", () => {
    const { env, base, repo, databasePath } = setup();
    expect(errorsFor({ ...env, CODEX_BIN: undefined }, databasePath)).toContainEqual({ variable: "CODEX_BIN", code: "missing" });
    expect(errorsFor({ ...env, CODEX_BIN: "codex" }, databasePath)).toContainEqual({ variable: "CODEX_BIN", code: "not_absolute" });
    expect(errorsFor({ ...env, CODEX_BIN: join(base, "nope") }, databasePath)).toContainEqual({ variable: "CODEX_BIN", code: "not_found" });
    expect(errorsFor({ ...env, CODEX_BIN: repo }, databasePath)).toContainEqual({ variable: "CODEX_BIN", code: "not_executable" });
    const plain = join(base, "plain");
    writeFileSync(plain, "x");
    chmodSync(plain, 0o644);
    expect(errorsFor({ ...env, CODEX_BIN: plain }, databasePath)).toContainEqual({ variable: "CODEX_BIN", code: "not_found" });
  });

  it("refuses a provider executable that lives inside the repository (repository content is untrusted)", () => {
    const { env, repo, databasePath } = setup();
    const inside = writeFakeCli(join(repo, "node_modules", ".bin"));
    expect(errorsFor({ ...env, CODEX_BIN: inside }, databasePath)).toContainEqual({ variable: "CODEX_BIN", code: "inside_repo" });
  });

  it("refuses settings that would widen the runner, and names the variable only", () => {
    const { env, databasePath } = setup();
    const errors = errorsFor({ ...env, CODEX_FLAGS: "--dangerously-bypass-approvals-and-sandbox", RUNNER_CONCURRENCY: "4", RUNNER_DEFAULT_MODE: "yolo" }, databasePath);
    expect(errors).toEqual(
      expect.arrayContaining([
        { variable: "CODEX_FLAGS", code: "unsupported" },
        { variable: "RUNNER_CONCURRENCY", code: "unsupported" },
        { variable: "RUNNER_DEFAULT_MODE", code: "unsupported" },
      ]),
    );
    expect(JSON.stringify(errors)).not.toContain("dangerously");
  });

  it("bounds the timeout", () => {
    const { env, databasePath } = setup();
    const ok = loadRunnerConfig({ ...env, RUNNER_TIMEOUT_SECONDS: "120" }, { databasePath });
    expect(ok.ok && ok.config.timeoutMs).toBe(120_000);
    for (const bad of ["0", "5", "3601", "-1", "1.5", "ten", "99999999"]) {
      expect(errorsFor({ ...env, RUNNER_TIMEOUT_SECONDS: bad }, databasePath)).toContainEqual({ variable: "RUNNER_TIMEOUT_SECONDS", code: "malformed" });
    }
  });
});

describe("loadRunnerConfig: edit mode", () => {
  const CHANNELS = new Set(["C0AAAAAAA", "D0AAAAAAA"]);
  function editSetup() {
    const s = setup();
    const worktrees = join(s.base, "worktrees");
    mkdirSync(worktrees, { mode: 0o700 });
    chmodSync(worktrees, 0o700);
    const env = { ...s.env, RUNNER_DEFAULT_MODE: "build_with_approval", EDIT_CHANNEL_IDS: "C0AAAAAAA", WORKTREE_ROOT: worktrees, GIT_BIN: s.bin };
    const load = (e: Record<string, string | undefined>) => loadRunnerConfig(e, { databasePath: s.databasePath, allowedChannelIds: CHANNELS });
    const errors = (e: Record<string, string | undefined>) => {
      const r = load(e);
      if (r.ok) throw new Error("expected failure");
      return r.errors;
    };
    return { ...s, worktrees, env, load, errors };
  }

  it("is off by default and when the mode is read_only, even if the edit settings are present", () => {
    const { env, load } = editSetup();
    expect(load({ ...env, RUNNER_DEFAULT_MODE: undefined })).toMatchObject({ ok: true, config: { edit: null } });
    expect(load({ ...env, RUNNER_DEFAULT_MODE: "read_only" })).toMatchObject({ ok: true, config: { edit: null } });
  });

  it("enables edit mode with channels, a private worktree root, and a default 60 minute window", () => {
    const { env, load, worktrees } = editSetup();
    const result = load(env);
    expect(result.ok && result.config.edit).toEqual({
      channelIds: new Set(["C0AAAAAAA"]),
      worktreeRoot: realpathSync(worktrees),
      approvalTtlMs: 3_600_000,
      gitBin: env.GIT_BIN,
      retentionDays: 7,
      maxRetained: 20,
      editTimeoutMs: 1_800_000,
    });
  });

  it("requires the channel list and the worktree root, naming only the variable", () => {
    const { env, errors } = editSetup();
    expect(errors({ ...env, EDIT_CHANNEL_IDS: undefined, WORKTREE_ROOT: undefined })).toEqual(
      expect.arrayContaining([
        { variable: "EDIT_CHANNEL_IDS", code: "missing" },
        { variable: "WORKTREE_ROOT", code: "missing" },
      ]),
    );
  });

  it("allows edits only in channels that are already authorized", () => {
    const { env, errors } = editSetup();
    expect(errors({ ...env, EDIT_CHANNEL_IDS: "C0ZZZZZZZ" })).toContainEqual({ variable: "EDIT_CHANNEL_IDS", code: "not_in_allowlist" });
    expect(errors({ ...env, EDIT_CHANNEL_IDS: "C0AAAAAAA,C0AAAAAAA" })).toContainEqual({ variable: "EDIT_CHANNEL_IDS", code: "duplicate_entry" });
    expect(errors({ ...env, EDIT_CHANNEL_IDS: "general" })).toContainEqual({ variable: "EDIT_CHANNEL_IDS", code: "malformed" });
  });

  it("refuses a worktree root that overlaps the repository, is open to others, or is missing", () => {
    const { env, errors, repo, base } = editSetup();
    expect(errors({ ...env, WORKTREE_ROOT: repo })).toContainEqual({ variable: "WORKTREE_ROOT", code: "overlaps_repo" });
    const inside = join(repo, "wt");
    mkdirSync(inside, { mode: 0o700 });
    expect(errors({ ...env, WORKTREE_ROOT: inside })).toContainEqual({ variable: "WORKTREE_ROOT", code: "overlaps_repo" });
    // base holds both the repository and the database, so it is refused either way.
    expect(errors({ ...env, WORKTREE_ROOT: base })).toHaveLength(1);
    const open = join(base, "open");
    mkdirSync(open);
    chmodSync(open, 0o770);
    expect(errors({ ...env, WORKTREE_ROOT: open })).toContainEqual({ variable: "WORKTREE_ROOT", code: "unsafe_permissions" });
    expect(errors({ ...env, WORKTREE_ROOT: join(base, "nope") })).toContainEqual({ variable: "WORKTREE_ROOT", code: "not_found" });
    expect(errors({ ...env, WORKTREE_ROOT: "relative/dir" })).toContainEqual({ variable: "WORKTREE_ROOT", code: "not_absolute" });
  });

  it("requires an absolute git executable outside the repository", () => {
    const { env, errors, repo, base } = editSetup();
    expect(errors({ ...env, GIT_BIN: undefined })).toContainEqual({ variable: "GIT_BIN", code: "missing" });
    expect(errors({ ...env, GIT_BIN: "git" })).toContainEqual({ variable: "GIT_BIN", code: "not_absolute" });
    expect(errors({ ...env, GIT_BIN: join(base, "nope") })).toContainEqual({ variable: "GIT_BIN", code: "not_found" });
    expect(errors({ ...env, GIT_BIN: base })).toContainEqual({ variable: "GIT_BIN", code: "not_executable" });
    const inside = writeFakeCli(join(repo, "bin"));
    expect(errors({ ...env, GIT_BIN: inside })).toContainEqual({ variable: "GIT_BIN", code: "inside_repo" });
  });

  it("bounds retention (1..365 days) and the retained-worktree cap (1..200)", () => {
    const { env, load, errors } = editSetup();
    const ok = load({ ...env, WORKTREE_RETENTION_DAYS: "30", WORKTREE_MAX_RETAINED: "5" });
    expect(ok.ok && [ok.config.edit?.retentionDays, ok.config.edit?.maxRetained]).toEqual([30, 5]);
    for (const bad of ["0", "-1", "366", "1.5", "week"]) {
      expect(errors({ ...env, WORKTREE_RETENTION_DAYS: bad })).toContainEqual({ variable: "WORKTREE_RETENTION_DAYS", code: "malformed" });
    }
    for (const bad of ["0", "201", "many"]) {
      expect(errors({ ...env, WORKTREE_MAX_RETAINED: bad })).toContainEqual({ variable: "WORKTREE_MAX_RETAINED", code: "malformed" });
    }
  });

  it("bounds the edit run time limit to 60..7200 seconds", () => {
    const { env, load, errors } = editSetup();
    const ok = load({ ...env, RUNNER_EDIT_TIMEOUT_SECONDS: "3600" });
    expect(ok.ok && ok.config.edit?.editTimeoutMs).toBe(3_600_000);
    for (const bad of ["59", "7201", "0", "-1", "1.5", "long"]) {
      expect(errors({ ...env, RUNNER_EDIT_TIMEOUT_SECONDS: bad })).toContainEqual({ variable: "RUNNER_EDIT_TIMEOUT_SECONDS", code: "malformed" });
    }
  });

  it("bounds the approval window to 5..1440 minutes", () => {
    const { env, load, errors } = editSetup();
    const ok = load({ ...env, APPROVAL_TTL_MINUTES: "5" });
    expect(ok.ok && ok.config.edit?.approvalTtlMs).toBe(300_000);
    for (const bad of ["4", "1441", "0", "-5", "1.5", "an hour"]) {
      expect(errors({ ...env, APPROVAL_TTL_MINUTES: bad })).toContainEqual({ variable: "APPROVAL_TTL_MINUTES", code: "malformed" });
    }
  });
});
