import { describe, expect, it } from "vitest";
import { MAX_EDIT_PROMPT_LENGTH } from "../parser/command.js";
import { MAX_OUTBOX_BODY_LENGTH } from "../store/index.js";
import { MAX_WORKTREE_ROOT_LENGTH } from "./config.js";
import { approvalRequestBody } from "./messages.js";
import { branchFor, worktreePathFor } from "./worktree-names.js";

const fields = (overrides = {}) => ({
  runId: "run-aaa1",
  provider: "codex",
  profile: "default",
  prompt: "fix the typo in README.md",
  worktreePath: "/home/me/wt/run-aaa1",
  branch: "threadrunner/run-aaa1",
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  expiresAt: Date.UTC(2026, 9, 4, 20, 0, 0),
  ...overrides,
});

describe("approvalRequestBody", () => {
  it("shows everything the approval covers, and the one command that approves it", () => {
    const body = approvalRequestBody(fields());
    for (const part of [
      "Run run-aaa1 wants to edit files. Nothing has changed yet.",
      "fix the typo in README.md",
      "Folder: /home/me/wt/run-aaa1",
      "Branch: threadrunner/run-aaa1",
      "Starting from commit: 0123456789abcdef0123456789abcdef01234567",
      "Uncommitted changes in your own checkout are not included.",
      "no commit, no push, no pull request, no deploy",
      "expires at 2026-10-04T20:00:00.000Z",
      "/approve run-aaa1",
    ]) {
      expect(body).toContain(part);
    }
  });

  it("fits in one outbox message at the largest prompt, longest worktree root, and longest run ID", () => {
    const runId = `run-${"a".repeat(32)}`;
    const root = "/" + "d".repeat(MAX_WORKTREE_ROOT_LENGTH - 1);
    const body = approvalRequestBody(
      fields({ runId, prompt: "x".repeat(MAX_EDIT_PROMPT_LENGTH), worktreePath: worktreePathFor(root, runId), branch: branchFor(runId), baseSha: "f".repeat(64) }),
    );
    expect(body.length).toBeLessThanOrEqual(MAX_OUTBOX_BODY_LENGTH);
  });
});

describe("worktree names", () => {
  it("derive only from a valid run ID", () => {
    expect(worktreePathFor("/w", "run-abc1")).toBe("/w/run-abc1");
    expect(branchFor("run-abc1")).toBe("threadrunner/run-abc1");
    for (const bad of ["", "run-", "../x", "run-../x", "run-ABC", "run-a/b", "x run-abc1", "run-abc1\n"]) {
      expect(() => worktreePathFor("/w", bad)).toThrow(RangeError);
      expect(() => branchFor(bad)).toThrow(RangeError);
    }
  });
});
