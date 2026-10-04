// The ONLY file in the project allowed to import child_process (see tripwire.test.ts).
import { spawn } from "node:child_process";
import { KILL_GRACE_MS } from "./limits.js";
import type { ExitInfo, Launcher } from "./process.js";

export interface NodeLauncherOptions {
  readonly killGraceMs?: number;
}

/**
 * Real launcher. `shell: false` and an argument array, so no argument is ever parsed as syntax.
 * The child leads its own process group (`detached`), so a kill reaches anything it started.
 * Standard error goes to the null device: nothing it writes can be buffered, logged or posted.
 */
export function createNodeLauncher(options: NodeLauncherOptions = {}): Launcher {
  const grace = options.killGraceMs ?? KILL_GRACE_MS;
  return (spec, onStdout) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env },
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });

    let finished = false;
    let settle: (info: ExitInfo) => void = () => {};
    const exited = new Promise<ExitInfo>((resolve) => {
      settle = (info) => {
        if (finished) return;
        finished = true;
        resolve(info);
      };
    });

    child.stdout.on("data", (chunk: Buffer) => onStdout(chunk));
    child.stdout.on("error", () => {});
    child.stdin.on("error", () => {}); // the child may exit before reading all of its input
    child.stdin.end(spec.stdin);
    child.once("error", () => settle({ code: null, signal: null, spawnFailed: true }));
    child.once("close", (code, signal) => settle({ code, signal }));

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (finished || child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    };

    let killing = false;
    return {
      exited,
      kill: () => {
        if (killing || finished) return;
        killing = true;
        signalGroup("SIGTERM");
        setTimeout(() => signalGroup("SIGKILL"), grace).unref();
        // If a descendant keeps the pipe open past SIGKILL, stop waiting for it.
        setTimeout(() => {
          child.stdout.destroy();
          settle({ code: null, signal: "SIGKILL" });
        }, grace + 1_000).unref();
      },
    };
  };
}
