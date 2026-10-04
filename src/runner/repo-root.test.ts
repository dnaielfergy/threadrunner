import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tempDir } from "../store/test-utils.js";
import { canonicalizeRepoRoot, isInside, repoRootStillValid } from "./repo-root.js";

function layout() {
  const base = realpathSync(tempDir());
  const repo = join(base, "repo");
  const outside = join(base, "outside");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE-CANARY");
  return { base, repo, outside };
}

describe("canonicalizeRepoRoot", () => {
  it("accepts an absolute directory and returns its realpath", () => {
    const { repo } = layout();
    expect(canonicalizeRepoRoot(repo)).toEqual({ ok: true, root: repo });
  });

  it("resolves a symlinked root to the real directory, so the symlink path is never used", () => {
    const { base, repo } = layout();
    const link = join(base, "link-to-repo");
    symlinkSync(repo, link);
    expect(canonicalizeRepoRoot(link)).toEqual({ ok: true, root: repo });
  });

  it("resolves a symlinked parent component too", () => {
    const { base, repo } = layout();
    const link = join(base, "parent-link");
    symlinkSync(base, link);
    expect(canonicalizeRepoRoot(join(link, "repo"))).toEqual({ ok: true, root: repo });
  });

  it.each([
    ["", "malformed"],
    ["   ", "malformed"],
    ["relative/path", "not_absolute"],
    ["./repo", "not_absolute"],
    ["~/code/project", "not_absolute"],
    ["repo\u0000/x", "malformed"],
  ])("refuses %j", (raw, error) => {
    expect(canonicalizeRepoRoot(raw)).toEqual({ ok: false, error });
  });

  it("refuses a traversal even when it would land on a real directory", () => {
    const { repo, outside } = layout();
    expect(canonicalizeRepoRoot(`${repo}/src/../../outside`)).toEqual({ ok: false, error: "malformed" });
    expect(canonicalizeRepoRoot(`${outside}/..`)).toEqual({ ok: false, error: "malformed" });
    expect(canonicalizeRepoRoot(`${repo}/..`)).toEqual({ ok: false, error: "malformed" });
  });

  it("refuses a missing path, a file, and a dangling symlink", () => {
    const { base, repo } = layout();
    expect(canonicalizeRepoRoot(join(base, "nope"))).toEqual({ ok: false, error: "not_found" });
    const file = join(repo, "README.md");
    writeFileSync(file, "x");
    expect(canonicalizeRepoRoot(file)).toEqual({ ok: false, error: "not_directory" });
    const dangling = join(base, "dangling");
    symlinkSync(join(base, "gone"), dangling);
    expect(canonicalizeRepoRoot(dangling)).toEqual({ ok: false, error: "not_found" });
  });

  it("refuses the filesystem root and the home directory", () => {
    expect(canonicalizeRepoRoot("/")).toEqual({ ok: false, error: "unsafe_root" });
    expect(canonicalizeRepoRoot(homedir())).toEqual({ ok: false, error: "unsafe_root" });
  });

  it("refuses a root that contains the database, so the provider cannot read stored prompts", () => {
    const { base, repo } = layout();
    expect(canonicalizeRepoRoot(repo, { forbidContaining: join(repo, "data", "threadrunner.db") })).toEqual({ ok: false, error: "unsafe_root" });
    expect(canonicalizeRepoRoot(base, { forbidContaining: join(repo, "data", "threadrunner.db") })).toEqual({ ok: false, error: "unsafe_root" });
    expect(canonicalizeRepoRoot(repo, { forbidContaining: join(base, "elsewhere", "threadrunner.db") }).ok).toBe(true);
  });
});

describe("repoRootStillValid", () => {
  it("is true for the unchanged directory", () => {
    const { repo } = layout();
    expect(repoRootStillValid(repo)).toBe(true);
  });

  it("is false after the directory is replaced by a symlink to somewhere else (symlink escape after startup)", () => {
    const { repo, outside } = layout();
    rmSync(repo, { recursive: true });
    symlinkSync(outside, repo);
    expect(repoRootStillValid(repo)).toBe(false);
  });

  it("is false after the directory is removed", () => {
    const { repo } = layout();
    rmSync(repo, { recursive: true });
    expect(repoRootStillValid(repo)).toBe(false);
  });
});

describe("isInside", () => {
  it("is exact about prefixes", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c/d")).toBe(true);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
    expect(isInside("/a/b", "/x/y")).toBe(false);
  });
});
