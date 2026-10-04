import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "../domain/types.js";
import { createRunFromEvent, transitionRun, type Run, type Store } from "../store/index.js";
import { tempDir } from "../store/test-utils.js";
import { DM, TEAM, USER, nextEventId, nextTs } from "../slack/test-fixtures.js";
import { createNodeLauncher } from "./launcher.js";
import type { ExitInfo, Launcher, LaunchSpec } from "./process.js";
import { supervise } from "./supervise.js";

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

export type FakeMode = "echo" | "env" | "argv" | "sleep" | "tree" | "flood" | "exit3" | "stderr" | "write" | "pointer";

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
if (marker && mode !== "pointer") fs.appendFileSync(marker, "invoked " + process.pid + "\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (mode === "echo") { process.stdout.write(${JSON.stringify(OUTPUT_CANARY)} + " stdin=" + input.length + "\\n"); process.exit(0); }
  if (mode === "env") { process.stdout.write(JSON.stringify(process.env)); process.exit(0); }
  if (mode === "argv") { process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), input })); process.exit(0); }
  if (mode === "write") { fs.writeFileSync("new-file.txt", "made by the agent\\n"); fs.appendFileSync("a.txt", "agent line\\n"); process.stdout.write("I added new-file.txt and edited a.txt. Tests pass.\\n"); process.exit(0); }
  if (mode === "pointer") { fs.writeFileSync(".git", "gitdir: " + marker + "\\n"); fs.appendFileSync("a.txt", "agent line\\n"); process.stdout.write("done\\n"); process.exit(0); }
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

// ---- Real git, for the worktree tests. Fixtures run plain, unhardened git on purpose: it is also the control
// that proves each planted canary really does run when git is not hardened. ----

export const GIT_BIN = "/usr/bin/git";
export const gitAvailable = existsSync(GIT_BIN);

/** Run git exactly as given (no hardening) and return stdout. Throws on a non-zero exit. */
export async function plainGit(cwd: string, args: readonly string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const outcome = await supervise({
    launcher: createNodeLauncher({ killGraceMs: 200 }),
    spec: {
      command: GIT_BIN,
      args,
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        LC_ALL: "C",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        ...extraEnv,
      },
      stdin: "",
    },
    timeoutMs: 30_000,
    maxOutputBytes: 1_000_000,
    pollMs: 1000,
    shouldCancel: () => false,
  });
  if (outcome.kind !== "exited" || outcome.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${outcome.kind}`);
  return outcome.output;
}

/** A repository with one commit (a.txt, b.txt, bin.dat) inside a fresh directory. */
export async function makeRepo(): Promise<{ base: string; repo: string; gitDir: string; sha: string }> {
  const base = realpathSync(tempDir());
  const repo = join(base, "repo");
  mkdirSync(repo);
  await plainGit(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "b.txt"), "bee\n");
  writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
  await plainGit(repo, ["add", "."]);
  await plainGit(repo, ["commit", "-q", "-m", "initial"]);
  const sha = (await plainGit(repo, ["rev-parse", "HEAD"])).trim();
  return { base, repo, gitDir: join(repo, ".git"), sha };
}

/** An executable shell script that appends a line to `marker` each time git runs it, then behaves like `body`. */
export function writeCanary(path: string, marker: string, body = "exit 0"): string {
  writeFileSync(path, `#!/bin/sh\necho ran >> '${marker}'\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
