import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installCrashHandlers, shutdown } from "./process-guard.js";
import { capturingLogger } from "./test-fixtures.js";

describe("installCrashHandlers", () => {
  it.each([
    ["unhandledRejection", "unhandled_rejection"],
    ["uncaughtException", "uncaught_exception"],
  ])("%s logs the fixed code %s and exits non-zero, without reading the reason", (event, code) => {
    const proc = new EventEmitter();
    const { log, entries } = capturingLogger();
    const exit = vi.fn();
    installCrashHandlers(proc, log, exit);
    proc.emit(event, new Error("xoxb-SECRET-CANARY in a stack"));
    expect(entries).toEqual([{ level: "error", code }]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(JSON.stringify(entries)).not.toContain("CANARY");
  });
});

describe("shutdown", () => {
  const options = () => {
    const { log, entries } = capturingLogger();
    const exit = vi.fn();
    return { opts: { timeoutMs: 20, log, exit }, entries, exit };
  };

  it("exits 0 after a clean stop", async () => {
    const { opts, exit, entries } = options();
    await shutdown(async () => {}, opts);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(entries).toEqual([]);
  });

  it("exits non-zero when stop rejects, so a failed stop is not reported as clean", async () => {
    const { opts, exit, entries } = options();
    await shutdown(() => Promise.reject(new Error("store closed")), opts);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(entries).toEqual([{ level: "error", code: "shutdown_failed" }]);
  });

  it("exits non-zero rather than hang when stop never finishes", async () => {
    const { opts, exit, entries } = options();
    await shutdown(() => new Promise<void>(() => {}), opts);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(entries).toEqual([{ level: "error", code: "shutdown_timeout" }]);
  });
});
