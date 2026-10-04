import { describe, expect, it } from "vitest";
import type { ExitInfo, Launcher, LaunchSpec } from "./process.js";
import { supervise } from "./supervise.js";
import { mockLauncher } from "./test-utils.js";

const SPEC: LaunchSpec = { command: "/bin/fake", args: [], cwd: "/", env: {}, stdin: "" };
const base = { spec: SPEC, timeoutMs: 5_000, maxOutputBytes: 100, shouldCancel: () => false, pollMs: 5 };

describe("supervise", () => {
  it("returns exit code and output", async () => {
    const { launcher } = mockLauncher({ output: "hello", exitCode: 0 });
    expect(await supervise({ ...base, launcher })).toEqual({ kind: "exited", exitCode: 0, output: "hello" });
    const failing = mockLauncher({ output: "partial", exitCode: 2 });
    expect(await supervise({ ...base, launcher: failing.launcher })).toEqual({ kind: "exited", exitCode: 2, output: "partial" });
  });

  it("keeps output exactly at the cap without calling it truncation", async () => {
    const { launcher, state } = mockLauncher({ output: "x".repeat(100) });
    expect(await supervise({ ...base, launcher })).toEqual({ kind: "exited", exitCode: 0, output: "x".repeat(100) });
    expect(state.kills).toBe(0);
  });

  it("stops at the first byte over the cap: kills the child and holds at most the cap", async () => {
    const { launcher, state } = mockLauncher({ output: "y".repeat(5_000_000) });
    const outcome = await supervise({ ...base, launcher });
    expect(outcome.kind).toBe("output_limit");
    expect(outcome.kind === "output_limit" && outcome.output).toBe("y".repeat(100));
    expect(state.kills).toBe(1);
  });

  it("ignores everything a child writes after the cap, across many chunks, without growing", async () => {
    let emit: (chunk: Uint8Array) => void = () => {};
    let resolveExit: (info: ExitInfo) => void = () => {};
    const exited = new Promise<ExitInfo>((r) => (resolveExit = r));
    const launcher: Launcher = (_spec, onStdout) => {
      emit = onStdout;
      return { exited, kill: () => resolveExit({ code: null, signal: "SIGTERM" }) };
    };
    const pending = supervise({ ...base, launcher, maxOutputBytes: 10 });
    for (let i = 0; i < 1_000; i++) emit(Buffer.from("zzzzzzzz"));
    const outcome = await pending;
    expect(outcome).toEqual({ kind: "output_limit", output: "zzzzzzzzzz" });
  });

  it("kills a child that outlives the timeout, keeping what it printed", async () => {
    let kills = 0;
    let resolveExit: (info: ExitInfo) => void = () => {};
    const launcher: Launcher = (_spec, onStdout) => {
      onStdout(Buffer.from("so far"));
      return {
        exited: new Promise<ExitInfo>((r) => (resolveExit = r)),
        kill: () => {
          kills++;
          resolveExit({ code: null, signal: "SIGTERM" });
        },
      };
    };
    expect(await supervise({ ...base, launcher, timeoutMs: 30 })).toEqual({ kind: "timeout", output: "so far" });
    expect(kills).toBe(1);
  });

  it("kills the child when cancellation is seen, and returns no output at all", async () => {
    let cancelled = false;
    const { launcher, state } = mockLauncher({ hold: new Promise(() => {}), output: "must not be returned" });
    const pending = supervise({ ...base, launcher, shouldCancel: () => cancelled });
    setTimeout(() => (cancelled = true), 20);
    expect(await pending).toEqual({ kind: "cancelled" });
    expect(state.kills).toBe(1);
  });

  it("kills the child on abort (shutdown), and an already-aborted signal kills it immediately", async () => {
    const controller = new AbortController();
    const first = mockLauncher({ hold: new Promise(() => {}) });
    const pending = supervise({ ...base, launcher: first.launcher, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    expect(await pending).toEqual({ kind: "aborted" });

    const second = mockLauncher({ hold: new Promise(() => {}) });
    expect(await supervise({ ...base, launcher: second.launcher, signal: controller.signal })).toEqual({ kind: "aborted" });
    expect(second.state.kills).toBe(1);
  });

  it("reports a launcher that throws, or a process that never started, as spawn_failed", async () => {
    const throwing: Launcher = () => {
      throw new Error("ENOENT /secret/path");
    };
    expect(await supervise({ ...base, launcher: throwing })).toEqual({ kind: "spawn_failed" });
    const failed: Launcher = () => ({ exited: Promise.resolve({ code: null, signal: null, spawnFailed: true }), kill: () => {} });
    expect(await supervise({ ...base, launcher: failed })).toEqual({ kind: "spawn_failed" });
  });

  it("reports a child that died by a signal it was not sent", async () => {
    const launcher: Launcher = (_s, onStdout) => {
      onStdout(Buffer.from("half"));
      return { exited: Promise.resolve({ code: null, signal: "SIGSEGV" }), kill: () => {} };
    };
    expect(await supervise({ ...base, launcher })).toEqual({ kind: "signalled", output: "half" });
  });
});
