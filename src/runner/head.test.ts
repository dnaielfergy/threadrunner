import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../store/test-utils.js";
import { readHeadCommit } from "./head.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";

function repo(files: Record<string, string>): string {
  const root = tempDir();
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, ".git", name, ".."), { recursive: true });
    writeFileSync(join(root, ".git", name), content);
  }
  return root;
}

describe("readHeadCommit (reads files only, never runs git)", () => {
  it("follows HEAD to a loose branch ref", () => {
    expect(readHeadCommit(repo({ HEAD: "ref: refs/heads/main\n", "refs/heads/main": `${SHA}\n` }))).toBe(SHA);
    expect(readHeadCommit(repo({ HEAD: "ref: refs/heads/feature/x-1\n", "refs/heads/feature/x-1": `${SHA}\n` }))).toBe(SHA);
  });

  it("reads a detached HEAD and a packed ref", () => {
    expect(readHeadCommit(repo({ HEAD: `${SHA}\n` }))).toBe(SHA);
    expect(readHeadCommit(repo({ HEAD: "ref: refs/heads/main\n", "packed-refs": `# pack-refs\n${SHA2} refs/heads/other\n${SHA} refs/heads/main\n` }))).toBe(SHA);
  });

  it("fails closed when there are no commits yet", () => {
    expect(readHeadCommit(repo({ HEAD: "ref: refs/heads/main\n" }))).toBeNull();
  });

  it.each([
    ["a ref outside refs/heads", "ref: refs/tags/v1\n"],
    ["a traversal", "ref: refs/heads/../../etc/passwd\n"],
    ["an absolute path", "ref: /etc/passwd\n"],
    ["a malformed value", "not a ref\n"],
    ["a short hash", "abc123\n"],
    ["an uppercase hash", `${SHA.toUpperCase()}\n`],
  ])("fails closed for %s", (_name, head) => {
    expect(readHeadCommit(repo({ HEAD: head, "refs/heads/main": `${SHA}\n` }))).toBeNull();
  });

  it("fails closed for a malformed ref value, and for a ref file that is a symlink", () => {
    expect(readHeadCommit(repo({ HEAD: "ref: refs/heads/main\n", "refs/heads/main": "garbage\n" }))).toBeNull();
    const root = repo({ HEAD: "ref: refs/heads/main\n", target: `${SHA}\n` });
    symlinkSync(join(root, ".git", "target"), join(root, ".git", "refs", "heads", "main"));
    expect(readHeadCommit(root)).toBeNull();
  });

  it("fails closed when .git is a file (a linked worktree or submodule), a symlink, or absent", () => {
    const file = tempDir();
    writeFileSync(join(file, ".git"), "gitdir: /somewhere/else\n");
    expect(readHeadCommit(file)).toBeNull();
    const real = repo({ HEAD: `${SHA}\n` });
    const link = tempDir();
    symlinkSync(join(real, ".git"), join(link, ".git"));
    expect(readHeadCommit(link)).toBeNull();
    expect(readHeadCommit(tempDir())).toBeNull();
  });

  it("ignores an oversized HEAD file", () => {
    expect(readHeadCommit(repo({ HEAD: `ref: refs/heads/${"a".repeat(70_000)}\n` }))).toBeNull();
  });
});
