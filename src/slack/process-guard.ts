import type { Logger } from "./log.js";

export interface ProcessLike {
  on(event: "unhandledRejection" | "uncaughtException", listener: () => void): unknown;
}

/**
 * Log a fixed code and exit non-zero on a crash, so a supervisor (launchd, systemd) restarts the
 * bridge instead of leaving it up but deaf. The reason is deliberately not read: it could carry
 * message text, a URL, or a token.
 */
export function installCrashHandlers(proc: ProcessLike, log: Logger, exit: (code: number) => void): void {
  proc.on("unhandledRejection", () => {
    log({ level: "error", code: "unhandled_rejection" });
    exit(1);
  });
  proc.on("uncaughtException", () => {
    log({ level: "error", code: "uncaught_exception" });
    exit(1);
  });
}

export interface ShutdownOptions {
  readonly timeoutMs: number;
  readonly log: Logger;
  readonly exit: (code: number) => void;
}

/** Run `stop`, then exit 0. A rejection or a hang past the timeout exits 1 so a failed stop is never reported as clean. */
export async function shutdown(stop: () => Promise<void>, options: ShutdownOptions): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.timeoutMs);
  });
  try {
    const outcome = await Promise.race([stop().then(() => "stopped" as const), timeout]);
    if (outcome === "timeout") {
      options.log({ level: "error", code: "shutdown_timeout" });
      options.exit(1);
    } else {
      options.exit(0);
    }
  } catch {
    options.log({ level: "error", code: "shutdown_failed" });
    options.exit(1);
  } finally {
    clearTimeout(timer);
  }
}
