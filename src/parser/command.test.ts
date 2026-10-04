import { describe, expect, it } from "vitest";
import { MAX_EDIT_PROMPT_LENGTH, parseCommand, type ParseErrorCode } from "./command.js";

describe("parseCommand: valid commands", () => {
  const cases: [string, unknown][] = [
    ["/codex fast fix the failing test", { kind: "task", provider: "codex", profile: "fast", prompt: "fix the failing test", mode: "read" }],
    ["/claude default summarize the repo", { kind: "task", provider: "claude", profile: "default", prompt: "summarize the repo", mode: "read" }],
    ["/auto deep review the auth flow", { kind: "task", provider: "auto", profile: "deep", prompt: "review the auth flow", mode: "read" }],
    ["  /codex fast   padded   prompt  ", { kind: "task", provider: "codex", profile: "fast", prompt: "padded   prompt", mode: "read" }],
    ["/codex fast line one\nline two", { kind: "task", provider: "codex", profile: "fast", prompt: "line one\nline two", mode: "read" }],
    ["/codex fast run `rm -rf /` ; echo $(id)", { kind: "task", provider: "codex", profile: "fast", prompt: "run `rm -rf /` ; echo $(id)", mode: "read" }],
    ["/codex fast " + "x".repeat(4000), { kind: "task", provider: "codex", profile: "fast", prompt: "x".repeat(4000), mode: "read" }],
    ["/approve run-abc\n", { kind: "approve", runId: "run-abc" }],
    ["/status", { kind: "status" }],
    ["/cancel", { kind: "cancel" }],
    ["/approve run-123", { kind: "approve", runId: "run-123" }],
    ["/approve run-a1b2c3", { kind: "approve", runId: "run-a1b2c3" }],
  ];
  it.each(cases)("%j", (input, command) => {
    expect(parseCommand(input)).toEqual({ ok: true, command });
  });
});

describe("parseCommand: fails closed", () => {
  const cases: [string, ParseErrorCode][] = [
    ["hello there", "not_a_command"],
    ["yes", "not_a_command"],
    ["", "not_a_command"],
    ["codex fast do it", "not_a_command"],
    ["please /codex fast do it", "not_a_command"],
    ["/codex fast do\u0000it", "not_a_command"],
    ["/", "unknown_command"],
    ["/run fast do it", "unknown_command"],
    ["/Codex fast do it", "unknown_command"],
    ["/CODEX fast do it", "unknown_command"],
    ["/codex-fast do it", "unknown_command"],
    ["/__proto__ fast do it", "unknown_command"],
    ["/constructor", "unknown_command"],
    ["/codex", "missing_prompt"],
    ["/codex   ", "missing_prompt"],
    ["/codex fast", "missing_prompt"],
    ["/claude default   ", "missing_prompt"],
    ["/auto deep", "missing_prompt"],
    ["/codex gpt-5 do it", "unknown_profile"],
    ["/claude claude-opus-4-1 do it", "unknown_profile"],
    ["/codex --model gpt-5 do it", "unknown_profile"],
    ["/codex model=o3 do it", "unknown_profile"],
    ["/codex turbo do it", "unknown_profile"],
    ["/codex FAST do it", "unknown_profile"],
    ["/codex do the thing", "unknown_profile"],
    ["/auto ; rm -rf / fast", "unknown_profile"],
    ["/codex $(whoami) fast do it", "unknown_profile"],
    ["/status now", "unexpected_arguments"],
    ["/cancel run-123", "unexpected_arguments"],
    ["/approve", "malformed_approval"],
    ["/approve yes", "malformed_approval"],
    ["/approve approved", "malformed_approval"],
    ["/approve run-", "malformed_approval"],
    ["/approve run-123 extra", "malformed_approval"],
    ["/approve RUN-123", "malformed_approval"],
    ["/approve\nrun-abc", "malformed_approval"],
    ["/approve\trun-abc", "malformed_approval"],
    ["/approve run-abc\nrun-def", "malformed_approval"],
    ["/approvexrun-abc", "unknown_command"],
    ["/approve\u00a0run-abc", "malformed_approval"],
    ["/codex fast hi\u202Eevil", "not_a_command"],
    ["/codex fast hi\u2066x", "not_a_command"],
    ["/codex fast " + "x".repeat(4001), "prompt_too_long"],
    ["/approve ../etc", "malformed_approval"],
    ["/approve run;id", "malformed_approval"],
    ["/approve -x", "malformed_approval"],
    ["/approve " + "run-" + "a".repeat(33), "malformed_approval"],
  ];
  it.each(cases)("%j -> %s", (input, error) => {
    const result = parseCommand(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(error);
  });
});

describe("parseCommand: the --edit token", () => {
  const task = (text: string) => {
    const result = parseCommand(text);
    return result.ok && result.command.kind === "task" ? result.command : null;
  };

  it("sets edit mode only for the exact token right after the profile", () => {
    expect(task("/codex default --edit fix the typo")).toEqual({ kind: "task", provider: "codex", profile: "default", prompt: "fix the typo", mode: "edit" });
    expect(task("/codex default --edit\nfix the typo")?.mode).toBe("edit");
    expect(task("/codex default   --edit    padded")).toMatchObject({ mode: "edit", prompt: "padded" });
    expect(task("/codex default fix the typo")?.mode).toBe("read");
  });

  it.each([
    ["--EDIT x"],
    ["--Edit x"],
    ["-edit x"],
    ["--editor x"],
    ["--edit=true x"],
    ["--edits x"],
    ["—edit x"],
  ])("%j is read-only prompt text, not the token", (rest) => {
    const command = task(`/codex default ${rest}`);
    expect(command?.mode).toBe("read");
    expect(command?.prompt).toBe(rest);
  });

  it("does not look for --edit anywhere but right after the profile", () => {
    expect(task("/codex default please --edit this")).toMatchObject({ mode: "read", prompt: "please --edit this" });
    expect(task("/codex --edit default fix")).toBeNull();
  });

  it("needs a prompt after the token", () => {
    for (const text of ["/codex default --edit", "/codex default --edit   ", "/codex default --edit\n"]) {
      const result = parseCommand(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("missing_prompt");
    }
  });

  it("limits an edit prompt to what fits in one approval request", () => {
    expect(task(`/codex default --edit ${"x".repeat(MAX_EDIT_PROMPT_LENGTH)}`)?.mode).toBe("edit");
    const long = parseCommand(`/codex default --edit ${"x".repeat(MAX_EDIT_PROMPT_LENGTH + 1)}`);
    expect(long.ok).toBe(false);
    // The read-only limit is unchanged.
    expect(task(`/codex default ${"x".repeat(MAX_EDIT_PROMPT_LENGTH + 1)}`)?.mode).toBe("read");
  });
});
