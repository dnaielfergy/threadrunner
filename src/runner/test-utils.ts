import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "../domain/types.js";
import { createRunFromEvent, transitionRun, type Run, type Store } from "../store/index.js";
import { tempDir } from "../store/test-utils.js";
import { DM, TEAM, USER, nextEventId, nextTs } from "../slack/test-fixtures.js";
import type { ExitInfo, Launcher, LaunchSpec } from "./process.js";

export const PROMPT_CANARY = "PROMPT-CANARY-5c1e deliver the quarterly summary";
export const OUTPUT_CANARY = "OUTPUT-CANARY-9d7b the answer is 42";

/** Create a run the way ingress does and walk it to `queued` through the state machine. */
export function queueRun(store: Store, overrides: { provider?: Provider; userId?: string; channelId?: string; teamId?: string; prompt?: string } = {}): Run {
  const ts = nextTs();
  const created = createRunFromEvent(store, {
    teamId: overrides.teamId ?? TEAM,
    userId: overrides.userId ?? USER,
    channelId: overrides.channelId ?? DM,
    rootThreadTs: ts,
    eventId: nextEventId(),
    messageTs: ts,
    provider: overrides.provider ?? "codex",
    profile: "default",
    prompt: overrides.prompt ?? PROMPT_CANARY,
  });
  if (created.status !== "created") throw new Error("could not create run");
  const run = created.run;
  if (!transitionRun(store, run, "received", "validated").ok || !transitionRun(store, run, "validated", "queued").ok) throw new Error("could not queue run");
  return { ...run, state: "queued" };
}

export interface MockLauncherOptions {
  readonly output?: string;
  readonly exitCode?: number;
  /** The process stays alive until this resolves (or it is killed). */
  readonly hold?: Promise<void>;
}

/** A launcher that never starts anything. Records every spec and the most processes alive at once. */
export function mockLauncher(options: MockLauncherOptions = {}) {
  const calls: LaunchSpec[] = [];
  let active = 0;
  const state = { maxActive: 0, kills: 0 };
  const launcher: Launcher = (spec, onStdout) => {
    calls.push(spec);
    active++;
    state.maxActive = Math.max(state.maxActive, active);
    let done = false;
    let killed = false;
    let resolveExit: (info: ExitInfo) => void = () => {};
    const exited = new Promise<ExitInfo>((resolve) => (resolveExit = resolve));
    const finish = (info: ExitInfo): void => {
      if (done) return;
      done = true;
      active--;
      resolveExit(info);
    };
    void (async () => {
      if (options.hold) await options.hold;
      if (killed) return;
      if (options.output !== undefined) onStdout(Buffer.from(options.output));
      finish({ code: options.exitCode ?? 0, signal: null });
    })();
    return {
      exited,
      kill: () => {
        killed = true;
        state.kills++;
        finish({ code: null, signal: "SIGTERM" });
      },
    };
  };
  return { launcher, calls, state };
}

export type FakeMode = "echo" | "env" | "argv" | "sleep" | "tree" | "flood" | "exit3" | "stderr";

/**
 * Write a fake provider executable. Behaviour is chosen by its first argument; the second is a file
 * it appends to when it starts (so a test can prove it was never invoked) or writes pids into.
 */
export function writeFakeCli(dir = tempDir()): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "fake-codex");
  const source = `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const [mode, marker] = process.argv.slice(2);
if (marker) fs.appendFileSync(marker, "invoked " + process.pid + "\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (mode === "echo") { process.stdout.write(${JSON.stringify(OUTPUT_CANARY)} + " stdin=" + input.length + "\\n"); process.exit(0); }
  if (mode === "env") { process.stdout.write(JSON.stringify(process.env)); process.exit(0); }
  if (mode === "argv") { process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), input })); process.exit(0); }
  if (mode === "exit3") { process.stdout.write("partial before failure\\n"); process.exit(3); }
  if (mode === "stderr") { process.stderr.write("STDERR-CANARY-77aa\\n"); process.stdout.write("ok\\n"); process.exit(0); }
  if (mode === "flood") { const chunk = "x".repeat(1000) + "\\n"; const t = setInterval(() => { for (let i = 0; i < 20; i++) process.stdout.write(chunk); }, 1); t.unref; return; }
  if (mode === "sleep" || mode === "tree") {
    process.on("SIGTERM", () => {}); // ignores the polite signal; only SIGKILL ends it
    if (mode === "tree") {
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
      fs.appendFileSync(marker + ".child", String(child.pid));
    }
    fs.appendFileSync(marker + ".pid", String(process.pid));
    setInterval(() => {}, 1000);
  }
});
`;
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const fileExists = existsSync;
