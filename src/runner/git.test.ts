import { describe, expect, it } from "vitest";
import { MAX_SUMMARY_FILES, buildSummary, createGit, displayPath } from "./git.js";
import { mockLauncher } from "./test-utils.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("how git is invoked", () => {
  const setup = (output = "") => {
    const mock = mockLauncher({ output });
    const git = createGit({ launcher: mock.launcher, gitBin: "/opt/git/bin/git", cwd: "/work" });
    return { mock, git };
  };

  it("uses the configured binary, an argument array, a fixed scrubbed environment, and the trusted directory", async () => {
    const { mock, git } = setup();
    await git.commitExists("/repo", SHA);
    const spec = mock.calls[0];
    expect(spec?.command).toBe("/opt/git/bin/git");
    expect(spec?.cwd).toBe("/work");
    expect(spec?.stdin).toBe("");
    expect(Object.keys(spec?.env ?? {}).sort()).toEqual(
      ["GIT_ATTR_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_NO_REPLACE_OBJECTS", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "LC_ALL", "PATH"].sort(),
    );
    expect(spec?.env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
    expect(spec?.args).toEqual([
      "--no-optional-locks",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.attributesFile=/dev/null",
      "--git-dir=/repo/.git",
      "cat-file",
      "-e",
      `${SHA}^{commit}`,
    ]);
  });

  it("every worktree command names the git directory and work tree itself and reads attributes from the base commit", async () => {
    const { mock, git } = setup();
    await git.summarizeChanges({ gitDir: "/repo/.git/worktrees/run-abc1", path: "/wt/run-abc1", baseSha: SHA });
    expect(mock.calls).toHaveLength(2);
    for (const call of mock.calls) {
      expect(call.args).toEqual(expect.arrayContaining(["--git-dir=/repo/.git/worktrees/run-abc1", "--work-tree=/wt/run-abc1", `--attr-source=${SHA}`]));
    }
    const diff = mock.calls[1]?.args ?? [];
    expect(diff).toEqual(expect.arrayContaining(["diff", "--numstat", "--no-ext-diff", "--no-textconv", "--no-renames"]));
    expect(diff).not.toContain("-p");
    expect(diff.at(-1)).toBe("--");
  });

  it("refuses a malformed commit, branch, or root path before starting anything", async () => {
    const { mock, git } = setup();
    expect(await git.commitExists("/repo", "HEAD")).toBe(false);
    expect(await git.commitExists("/repo", `${SHA}; touch x`)).toBe(false);
    for (const branch of ["main", "threadrunner/../main", "threadrunner/run-ABC", "-D", "threadrunner/run-abc1 x"]) {
      expect((await git.addWorktree("/repo", { path: "/wt/run-abc1", branch, baseSha: SHA })).ok).toBe(false);
      expect((await git.deleteBranch("/repo", branch)).ok).toBe(false);
    }
    expect((await git.addWorktree("/repo", { path: "/wt/run-abc1", branch: "threadrunner/run-abc1", baseSha: "main" })).ok).toBe(false);
    expect((await git.summarizeChanges({ gitDir: "/g", path: "/p", baseSha: "main" }))).toBeNull();
    expect(mock.calls).toHaveLength(0);
  });

  it("reports registered worktrees from NUL-separated output", async () => {
    const { git } = setup("worktree /repo\0HEAD abc\0branch refs/heads/main\0\0worktree /wt/run-abc1\0HEAD abc\0detached\0\0");
    expect(await git.listWorktrees("/repo")).toEqual(["/repo", "/wt/run-abc1"]);
  });

  it("a failing git is a failure value, never an exception", async () => {
    const mock = mockLauncher({ exitCode: 128 });
    const git = createGit({ launcher: mock.launcher, gitBin: "/g", cwd: "/w" });
    expect(await git.listWorktrees("/repo")).toBeNull();
    expect(await git.summarizeChanges({ gitDir: "/g", path: "/p", baseSha: SHA })).toBeNull();
    expect(await git.removeWorktree("/repo", "/wt/run-abc1")).toMatchObject({ ok: false, reason: "nonzero_exit" });
  });
});

describe("buildSummary", () => {
  it("combines status (names, kinds) with numstat (counts)", () => {
    const status = " M a.txt\0 D b.txt\0?? c.txt\0 M bin.dat\0";
    const numstat = "1\t0\ta.txt\0" + "0\t1\tb.txt\0" + "-\t-\tbin.dat\0";
    expect(buildSummary(status, numstat, false)).toEqual({
      files: [
        { path: "a.txt", status: "modified", added: 1, removed: 0, binary: false },
        { path: "b.txt", status: "deleted", added: 0, removed: 1, binary: false },
        { path: "bin.dat", status: "modified", added: null, removed: null, binary: true },
        { path: "c.txt", status: "added", added: null, removed: null, binary: false },
      ],
      totalFiles: 4,
      totalAdded: 1,
      totalRemoved: 1,
      incomplete: false,
    });
  });

  it("keeps counting past the file-name cap", () => {
    const status = Array.from({ length: MAX_SUMMARY_FILES + 25 }, (_v, i) => `?? f${String(i).padStart(4, "0")}.txt\0`).join("");
    const summary = buildSummary(status, "", false);
    expect(summary.files).toHaveLength(MAX_SUMMARY_FILES);
    expect(summary.totalFiles).toBe(MAX_SUMMARY_FILES + 25);
  });

  it("drops a record cut off mid-way when the output was truncated", () => {
    const summary = buildSummary("?? a.txt\0?? b.t", "", true);
    expect(summary.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(summary.incomplete).toBe(true);
  });

  it("ignores lines that are not records", () => {
    expect(buildSummary("\0x\0 M\0", "garbage\0", false).totalFiles).toBe(0);
  });
});

describe("displayPath", () => {
  it("neutralizes control and bidirectional characters, which file names can carry", () => {
    expect(displayPath("a\nb\tc")).toBe("a?b?c");
    expect(displayPath("evil‮txt.exe")).toBe("evil?txt.exe");
    expect(displayPath("x⁦y‎z؜")).toBe("x?y?z?");
    expect(displayPath("nul\u0000byte\u007F")).toBe("nul?byte?");
  });

  it("cuts very long names", () => {
    const shown = displayPath("a".repeat(500));
    expect(shown.length).toBeLessThan(210);
    expect(shown.endsWith("...")).toBe(true);
  });
});
