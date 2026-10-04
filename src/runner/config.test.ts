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
    expect(result).toEqual({ ok: true, config: { repoRoot: repo, codexBin: bin, timeoutMs: 600_000 } });
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
    const errors = errorsFor({ ...env, CODEX_FLAGS: "--dangerously-bypass-approvals-and-sandbox", RUNNER_CONCURRENCY: "4", RUNNER_DEFAULT_MODE: "build_with_approval" }, databasePath);
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
