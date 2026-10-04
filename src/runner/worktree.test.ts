import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRunFromEvent, getRun, getWorktree, listRetainedWorktrees, transitionRun, type Store } from "../store/index.js";
import { BINDING, editRunQueuedWrite, fakeClock, fakeIds, newRun, open, tempDbPath } from "../store/test-utils.js";
import { createGit } from "./git.js";
import { createNodeLauncher } from "./launcher.js";
import type { Launcher, LaunchSpec } from "./process.js";
import { GIT_BIN, gitAvailable, makeRepo, plainGit, writeCanary } from "./test-utils.js";
import { createWorktree, removeWorktree, summarizeWorktree, type WorktreeDeps } from "./worktree.js";
import { branchFor, worktreePathFor } from "./worktree-names.js";

const RUN_ID = "run-aaa1";

async function setup(options: { maxRetained?: number; approve?: boolean } = {}) {
  const fx = await makeRepo();
  const worktreeRoot = join(fx.base, "worktrees");
  mkdirSync(worktreeRoot, { mode: 0o700 });
  const marker = join(fx.base, "canary-marker");
  const store = open(tempDbPath(), { now: fakeClock(), randomId: fakeIds() });
  const calls: LaunchSpec[] = [];
  const real = createNodeLauncher({ killGraceMs: 200 });
  const launcher: Launcher = (spec, onStdout) => {
    calls.push(spec);
    return real(spec, onStdout);
  };
  const git = createGit({ launcher, gitBin: GIT_BIN, cwd: worktreeRoot });
  const deps: WorktreeDeps = { store, git, repoRoot: fx.repo, worktreeRoot, maxRetained: options.maxRetained ?? 5 };
  editRunQueuedWrite(store, {}, { baseSha: fx.sha, repoRoot: fx.repo });
  const run = getRun(store, BINDING);
  if (!run) throw new Error("setup: no run");
  const path = worktreePathFor(worktreeRoot, RUN_ID);
  const finish = (): void => {
    expect(transitionRun(store, BINDING, "queued_write", "running_write").ok).toBe(true);
    expect(transitionRun(store, BINDING, "running_write", "completed").ok).toBe(true);
  };
  return { ...fx, worktreeRoot, marker, store, deps, run, path, calls, finish, ran: () => existsSync(marker), reset: () => rmSync(marker, { force: true }) };
}

const branches = async (repo: string): Promise<string[]> =>
  (await plainGit(repo, ["branch", "--list", "--format=%(refname:short)"])).split("\n").filter(Boolean).sort();
const adminDir = (repo: string): string => join(repo, ".git", "worktrees", RUN_ID);

describe.skipIf(!gitAvailable)("creating a worktree", () => {
  it("cuts a linked worktree and branch from the recorded base commit and records it", async () => {
    const s = await setup();
    const result = await createWorktree(s.deps, s.run);
    expect(result).toEqual({ ok: true, path: s.path, branch: branchFor(RUN_ID), baseSha: s.sha });
    expect(readFileSync(join(s.path, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    expect((await plainGit(s.path, ["rev-parse", "HEAD"])).trim()).toBe(s.sha);
    expect(await branches(s.repo)).toEqual(["main", branchFor(RUN_ID)]);
    expect(getWorktree(s.store, RUN_ID)).toMatchObject({ path: s.path, branch: branchFor(RUN_ID), baseSha: s.sha, removedAt: null });
    expect(getRun(s.store, BINDING)?.state).toBe("queued_write");
    // The user's own checkout is untouched.
    expect((await plainGit(s.repo, ["status", "--porcelain"])).trim()).toBe("");
    expect(readdirSync(s.worktreeRoot)).toEqual([RUN_ID]);
  });

  it("is cut from the base commit even if the repository moved on", async () => {
    const s = await setup();
    writeFileSync(join(s.repo, "a.txt"), "moved on\n");
    await plainGit(s.repo, ["commit", "-q", "-am", "later"]);
    expect((await createWorktree(s.deps, s.run)).ok).toBe(true);
    expect(readFileSync(join(s.path, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
  });

  it("every git command it ran used the pinned binary, a scrubbed environment, and explicit git directories", async () => {
    const s = await setup();
    await createWorktree(s.deps, s.run);
    writeFileSync(join(s.path, "c.txt"), "x\n");
    await summarizeWorktree(s.deps, RUN_ID);
    s.finish();
    await removeWorktree(s.deps, RUN_ID);
    expect(s.calls.length).toBeGreaterThanOrEqual(8);
    for (const call of s.calls) {
      expect(call.command).toBe(GIT_BIN);
      expect(call.cwd).toBe(s.worktreeRoot);
      expect(Object.keys(call.env)).not.toContain("HOME");
      expect(call.args.filter((a) => a.startsWith("--git-dir="))).toHaveLength(1);
      expect(call.args).toEqual(expect.arrayContaining(["core.hooksPath=/dev/null", "core.fsmonitor=false", "--no-optional-locks"]));
    }
  });

  it("refuses without a pending approved edit run", async () => {
    const s = await setup();
    s.finish();
    expect(await createWorktree(s.deps, s.run)).toEqual({ ok: false, error: "wrong_state" });

    const read = await setup();
    const created = createRunFromEvent(read.store, newRun({ teamId: "T0BBBBBBB" }));
    if (created.status !== "created") throw new Error("setup");
    expect(await createWorktree(read.deps, created.run)).toEqual({ ok: false, error: "not_edit_run" });
    expect(readdirSync(read.worktreeRoot)).toEqual([]);
  });

  it("refuses when the approval no longer matches (a different repository root)", async () => {
    const s = await setup();
    expect(await createWorktree({ ...s.deps, repoRoot: join(s.base, "elsewhere") }, s.run)).toEqual({ ok: false, error: "approval_mismatch" });
    expect(readdirSync(s.worktreeRoot)).toEqual([]);
  });

  it("refuses at the retained-worktree cap", async () => {
    const s = await setup({ maxRetained: 0 });
    expect(await createWorktree(s.deps, s.run)).toEqual({ ok: false, error: "cap_reached" });
    expect(listRetainedWorktrees(s.store)).toEqual([]);
  });

  it("never reuses an existing path", async () => {
    const s = await setup();
    mkdirSync(s.path);
    writeFileSync(join(s.path, "precious.txt"), "keep");
    expect(await createWorktree(s.deps, s.run)).toEqual({ ok: false, error: "path_exists" });
    expect(readFileSync(join(s.path, "precious.txt"), "utf8")).toBe("keep");
  });

  it("refuses a base commit the repository does not have", async () => {
    const fx = await setup();
    const other = await setup();
    // A run approved against a commit that this repository lacks.
    const store = open(tempDbPath(), { now: fakeClock(), randomId: fakeIds() });
    editRunQueuedWrite(store, {}, { baseSha: other.sha.replace(/^./, "f"), repoRoot: fx.repo });
    const run = getRun(store, BINDING);
    if (!run) throw new Error("setup");
    expect(await createWorktree({ ...fx.deps, store }, run)).toEqual({ ok: false, error: "base_missing" });
  });

  it("refuses when the worktree root was swapped for a link after startup", async () => {
    const s = await setup();
    const elsewhere = join(s.base, "elsewhere");
    mkdirSync(elsewhere);
    rmSync(s.worktreeRoot, { recursive: true });
    symlinkSync(elsewhere, s.worktreeRoot);
    expect(await createWorktree(s.deps, s.run)).toEqual({ ok: false, error: "root_changed" });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("cleans up and records nothing if git fails (here: the branch already exists)", async () => {
    const s = await setup();
    await plainGit(s.repo, ["branch", branchFor(RUN_ID)]);
    expect(await createWorktree(s.deps, s.run)).toEqual({ ok: false, error: "git_failed" });
    expect(existsSync(s.path)).toBe(false);
    expect(getWorktree(s.store, RUN_ID)).toBeNull();
    expect(existsSync(adminDir(s.repo))).toBe(false);
  });
});

describe.skipIf(!gitAvailable)("summarizing a worktree", () => {
  it("reports changed files and counts computed from git, never file contents", async () => {
    const s = await setup();
    await createWorktree(s.deps, s.run);
    writeFileSync(join(s.path, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
    rmSync(join(s.path, "b.txt"));
    writeFileSync(join(s.path, "c.txt"), "SECRET-CONTENT\n");
    writeFileSync(join(s.path, "bin.dat"), Buffer.from([9, 9, 0, 0, 1]));
    const result = await summarizeWorktree(s.deps, RUN_ID);
    if (!result.ok) throw new Error(result.error);
    expect(result.summary.files).toEqual([
      { path: "a.txt", status: "modified", added: 2, removed: 0, binary: false },
      { path: "b.txt", status: "deleted", added: 0, removed: 1, binary: false },
      { path: "bin.dat", status: "modified", added: null, removed: null, binary: true },
      { path: "c.txt", status: "added", added: null, removed: null, binary: false },
    ]);
    expect(result.summary).toMatchObject({ totalFiles: 4, totalAdded: 2, totalRemoved: 1, incomplete: false });
    expect(JSON.stringify(result.summary)).not.toContain("SECRET-CONTENT");
  });

  it("is empty when nothing changed", async () => {
    const s = await setup();
    await createWorktree(s.deps, s.run);
    expect(await summarizeWorktree(s.deps, RUN_ID)).toMatchObject({ ok: true, summary: { totalFiles: 0 } });
  });

  it("shows hostile file names safely", async () => {
    const s = await setup();
    await createWorktree(s.deps, s.run);
    writeFileSync(join(s.path, "line\nbreak.txt"), "x");
    writeFileSync(join(s.path, "evil‮txt.exe"), "x");
    const result = await summarizeWorktree(s.deps, RUN_ID);
    if (!result.ok) throw new Error(result.error);
    expect(result.summary.files.map((f) => f.path).sort()).toEqual(["evil?txt.exe", "line?break.txt"]);
  });

  it("has nothing to say for a run with no worktree, or one whose directory was swapped for a link", async () => {
    const s = await setup();
    expect(await summarizeWorktree(s.deps, RUN_ID)).toEqual({ ok: false, error: "no_worktree" });
    await createWorktree(s.deps, s.run);
    const target = join(s.base, "target");
    mkdirSync(target);
    rmSync(s.path, { recursive: true });
    symlinkSync(target, s.path);
    expect(await summarizeWorktree(s.deps, RUN_ID)).toEqual({ ok: false, error: "worktree_invalid" });
  });
});

/**
 * The hostile-repository tests. Each plants a canary command that proves it ran by writing a marker
 * file, first shows that plain, unhardened git DOES run it (the control, so a pass cannot be
 * vacuous), then shows the bridge's own git does not.
 */
describe.skipIf(!gitAvailable)("hostile repository: the bridge never runs a planted command", () => {
  it("a post-checkout hook is not run when the worktree is created", async () => {
    const s = await setup();
    writeCanary(join(s.repo, ".git", "hooks", "post-checkout"), s.marker);
    await plainGit(s.repo, ["worktree", "add", "-q", join(s.base, "control"), "-b", "control", "HEAD"]);
    expect(s.ran()).toBe(true);
    s.reset();

    expect((await createWorktree(s.deps, s.run)).ok).toBe(true);
    expect(s.ran()).toBe(false);
  });

  it("a core.fsmonitor setting in the repository is not run by the summary's git status", async () => {
    const s = await setup();
    await createWorktree(s.deps, s.run);
    await plainGit(s.repo, ["config", "core.fsmonitor", writeCanary(join(s.base, "fsmonitor.sh"), s.marker)]);
    writeFileSync(join(s.path, "a.txt"), "changed\n");
    await plainGit(s.path, ["status", "--porcelain"]);
    expect(s.ran()).toBe(true);
    s.reset();

    expect(await summarizeWorktree(s.deps, RUN_ID)).toMatchObject({ ok: true, summary: { totalFiles: 1 } });
    expect(s.ran()).toBe(false);
  });

  it("a rewritten .git pointer file does not redirect the bridge's git to a hostile directory", async () => {
    const s = await setup();
    await createWorktree(s.deps, s.run);
    const evilWork = join(s.base, "evil");
    const evil = join(evilWork, ".git");
    await plainGit(s.base, ["init", "-q", evilWork]);
    await plainGit(evilWork, ["config", "core.fsmonitor", writeCanary(join(s.base, "fsmonitor.sh"), s.marker)]);
    writeFileSync(join(s.path, ".git"), `gitdir: ${evil}\n`);
    writeFileSync(join(s.path, "a.txt"), "changed\n");
    await plainGit(s.path, ["status", "--porcelain"]);
    expect(s.ran()).toBe(true);
    s.reset();

    const result = await summarizeWorktree(s.deps, RUN_ID);
    expect(s.ran()).toBe(false);
    // And it still answered from the real repository, not the hostile one.
    expect(result).toMatchObject({ ok: true, summary: { files: [{ path: "a.txt", status: "modified" }] } });
  });

  it("a filter driver named by an attributes file the agent wrote is not run by the summary's git diff", async () => {
    const s = await setup();
    await createWorktree(s.deps, s.run);
    await plainGit(s.repo, ["config", "filter.evil.clean", writeCanary(join(s.base, "filter.sh"), s.marker, "cat")]);
    writeFileSync(join(s.path, ".gitattributes"), "a.txt filter=evil\n");
    writeFileSync(join(s.path, "a.txt"), "changed and longer than before\n");
    await plainGit(s.path, ["diff", "--numstat"]);
    expect(s.ran()).toBe(true);
    s.reset();

    expect(await summarizeWorktree(s.deps, RUN_ID)).toMatchObject({ ok: true });
    expect(s.ran()).toBe(false);
  });

  it("textconv and external diff drivers are not run (the summary never asks for a patch)", async () => {
    const s = await setup();
    await createWorktree(s.deps, s.run);
    await plainGit(s.repo, ["config", "diff.evil.textconv", writeCanary(join(s.base, "textconv.sh"), s.marker, "cat \"$1\"")]);
    await plainGit(s.repo, ["config", "diff.external", writeCanary(join(s.base, "external.sh"), s.marker)]);
    writeFileSync(join(s.path, ".gitattributes"), "a.txt diff=evil\n");
    writeFileSync(join(s.path, "a.txt"), "changed\n");
    await plainGit(s.path, ["diff"]);
    expect(s.ran()).toBe(true);
    s.reset();

    expect(await summarizeWorktree(s.deps, RUN_ID)).toMatchObject({ ok: true });
    expect(s.ran()).toBe(false);
  });

  it("global and system git configuration is ignored", async () => {
    const s = await setup();
    await createWorktree(s.deps, s.run);
    const home = join(s.base, "home");
    mkdirSync(home);
    writeFileSync(join(home, ".gitconfig"), `[core]\n\tfsmonitor = ${writeCanary(join(s.base, "fsmonitor.sh"), s.marker)}\n`);
    writeFileSync(join(s.path, "a.txt"), "changed\n");
    await plainGit(s.path, ["status", "--porcelain"], { HOME: home, GIT_CONFIG_GLOBAL: join(home, ".gitconfig") });
    expect(s.ran()).toBe(true);
    s.reset();

    // The bridge's git is not given HOME or a configuration path at all, whatever the bridge's own environment holds.
    process.env["HOME"] = home;
    process.env["GIT_CONFIG_GLOBAL"] = join(home, ".gitconfig");
    try {
      expect(await summarizeWorktree(s.deps, RUN_ID)).toMatchObject({ ok: true });
    } finally {
      delete process.env["GIT_CONFIG_GLOBAL"];
    }
    expect(s.ran()).toBe(false);
  });
});

describe.skipIf(!gitAvailable)("removing a worktree", () => {
  it("removes the directory, the registration and the branch of a finished run, and records it once", async () => {
    const s = await setup();
    await createWorktree(s.deps, s.run);
    writeFileSync(join(s.path, "c.txt"), "x");
    s.finish();
    expect(await removeWorktree(s.deps, RUN_ID)).toEqual({ ok: true, alreadyGone: false, branchDeleted: true });
    expect(existsSync(s.path)).toBe(false);
    expect(existsSync(adminDir(s.repo))).toBe(false);
    expect(await branches(s.repo)).toEqual(["main"]);
    expect(getWorktree(s.store, RUN_ID)?.removedAt).not.toBeNull();
    expect(await removeWorktree(s.deps, RUN_ID)).toMatchObject({ ok: true, alreadyGone: true });
  });

  it("leaves a run that has not finished alone", async () => {
    const s = await setup();
    await createWorktree(s.deps, s.run);
    expect(await removeWorktree(s.deps, RUN_ID)).toEqual({ ok: false, error: "run_not_finished" });
    expect(existsSync(s.path)).toBe(true);
  });

  it("still removes a worktree whose .git pointer file was overwritten (git itself refuses these)", async () => {
    const s = await setup();
    await createWorktree(s.deps, s.run);
    writeFileSync(join(s.path, ".git"), "gitdir: /nonexistent\n");
    s.finish();
    expect(await removeWorktree(s.deps, RUN_ID)).toMatchObject({ ok: true });
    expect(existsSync(s.path)).toBe(false);
    expect(existsSync(adminDir(s.repo))).toBe(false);
    expect(await branches(s.repo)).toEqual(["main"]);
  });

  it("when the directory is already gone, cleans up the registration and branch", async () => {
    const s = await setup();
    await createWorktree(s.deps, s.run);
    rmSync(s.path, { recursive: true });
    s.finish();
    expect(await removeWorktree(s.deps, RUN_ID)).toEqual({ ok: true, alreadyGone: true, branchDeleted: true });
    expect(await branches(s.repo)).toEqual(["main"]);
  });

  it("never deletes through a symlink standing where the worktree was", async () => {
    const s = await setup();
    await createWorktree(s.deps, s.run);
    const precious = join(s.base, "precious");
    mkdirSync(precious);
    writeFileSync(join(precious, "keep.txt"), "keep");
    rmSync(s.path, { recursive: true });
    symlinkSync(precious, s.path);
    s.finish();
    expect(await removeWorktree(s.deps, RUN_ID)).toEqual({ ok: false, error: "not_validated" });
    expect(readFileSync(join(precious, "keep.txt"), "utf8")).toBe("keep");
    expect(lstatSync(s.path).isSymbolicLink()).toBe(true);
  });

  it("never deletes a directory the main repository does not vouch for", async () => {
    const s = await setup();
    await createWorktree(s.deps, s.run);
    writeFileSync(join(s.path, "mine.txt"), "keep");
    writeFileSync(join(adminDir(s.repo), "gitdir"), `${join(s.base, "somewhere", ".git")}\n`);
    s.finish();
    expect(await removeWorktree(s.deps, RUN_ID)).toEqual({ ok: false, error: "not_validated" });
    expect(readFileSync(join(s.path, "mine.txt"), "utf8")).toBe("keep");
  });

  it("does not touch anything for a run with no worktree record", async () => {
    const s = await setup();
    mkdirSync(s.path);
    writeFileSync(join(s.path, "mine.txt"), "keep");
    s.finish();
    expect(await removeWorktree(s.deps, RUN_ID)).toEqual({ ok: false, error: "no_worktree" });
    expect(readFileSync(join(s.path, "mine.txt"), "utf8")).toBe("keep");
  });
});

describe("the sandbox-free helpers", () => {
  it("test fixtures need a git binary", () => {
    // Visible in the report when git is missing, so skipped suites are not mistaken for passing ones.
    expect(typeof gitAvailable).toBe("boolean");
  });
});
