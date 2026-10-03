import { describe, expect, it } from "vitest";
import { parseCommand, type ParseErrorCode } from "./command.js";

describe("parseCommand: valid commands", () => {
  const cases: [string, unknown][] = [
    ["/codex fast fix the failing test", { kind: "task", provider: "codex", profile: "fast", prompt: "fix the failing test" }],
    ["/claude default summarize the repo", { kind: "task", provider: "claude", profile: "default", prompt: "summarize the repo" }],
    ["/auto deep review the auth flow", { kind: "task", provider: "auto", profile: "deep", prompt: "review the auth flow" }],
    ["  /codex fast   padded   prompt  ", { kind: "task", provider: "codex", profile: "fast", prompt: "padded   prompt" }],
    ["/codex fast line one\nline two", { kind: "task", provider: "codex", profile: "fast", prompt: "line one\nline two" }],
    ["/codex fast run `rm -rf /` ; echo $(id)", { kind: "task", provider: "codex", profile: "fast", prompt: "run `rm -rf /` ; echo $(id)" }],
    ["/codex fast " + "x".repeat(4000), { kind: "task", provider: "codex", profile: "fast", prompt: "x".repeat(4000) }],
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
