import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "../store/test-utils.js";
import { buildChildEnv } from "./env.js";
import { createNodeLauncher } from "./launcher.js";
import type { LaunchSpec } from "./process.js";
import { supervise } from "./supervise.js";
import { alive, fileExists, writeFakeCli } from "./test-utils.js";

// The real launcher, driven only against the fake CLI written below. No provider is ever started.
const launcher = createNodeLauncher({ killGraceMs: 150 });
let dir: string;
let cli: string;
beforeEach(() => {
  dir = tempDir();
  cli = writeFakeCli(join(dir, "bin"));
});
afterEach(() => vi.unstubAllEnvs());

const spec = (mode: string, extra: Partial<LaunchSpec> = {}): LaunchSpec => ({
  command: cli,
  args: [mode, join(dir, "marker")],
  cwd: dir,
  env: buildChildEnv(process.env),
  stdin: "",
  ...extra,
});
const options = { launcher, timeoutMs: 10_000, maxOutputBytes: 4_000, shouldCancel: () => false, pollMs: 20 };

describe("createNodeLauncher", () => {
  it("delivers stdin and returns stdout and the exit code", async () => {
    const outcome = await supervise({ ...options, spec: spec("echo", { stdin: "hello there" }) });
    expect(outcome).toMatchObject({ kind: "exited", exitCode: 0 });
    expect(outcome.kind === "exited" && outcome.output).toContain("stdin=11");
  });

  it("gives the child ONLY the allowlisted environment: canary secrets in the parent never arrive", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-CANARY-must-not-leak");
    vi.stubEnv("SLACK_APP_TOKEN", "xapp-CANARY-must-not-leak");
    vi.stubEnv("DATABASE_PATH", "/CANARY/db");
    vi.stubEnv("OPENAI_API_KEY", "sk-CANARY-must-not-leak");
    vi.stubEnv("SOME_OTHER_SECRET", "CANARY-other");
    const outcome = await supervise({ ...options, spec: spec("env") });
    const raw = outcome.kind === "exited" ? outcome.output : "";
    expect(raw).not.toContain("CANARY");
    const seen = Object.keys(JSON.parse(raw) as Record<string, string>);
    expect(seen).not.toEqual(expect.arrayContaining(["SLACK_BOT_TOKEN"]));
    // The operating system or Node adds a few variables to every process (macOS adds __CF_USER_TEXT_ENCODING,
    // a shell adds PWD and friends). They do not come from the parent's environment, which the canary checks above cover.
    const allowed = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"]);
    const addedByTheSystem = ["PWD", "SHLVL", "_", "OLDPWD", "__CF_USER_TEXT_ENCODING"];
    const unexpected = seen.filter((name) => !allowed.has(name) && !addedByTheSystem.includes(name));
    expect(unexpected).toEqual([]);
  });

  it("passes arguments as plain data: shell syntax in an argument is never interpreted", async () => {
    const hostile = ["; touch " + join(dir, "pwned"), "$(touch " + join(dir, "pwned2") + ")", "`touch " + join(dir, "pwned3") + "`", "a b", "--", "-rf"];
    const outcome = await supervise({ ...options, spec: { ...spec("argv"), args: ["argv", join(dir, "marker"), ...hostile] } });
    const seen = JSON.parse(outcome.kind === "exited" ? outcome.output : "{}") as { argv: string[] };
    expect(seen.argv.slice(2)).toEqual(hostile);
    for (const name of ["pwned", "pwned2", "pwned3"]) expect(fileExists(join(dir, name))).toBe(false);
  });

  it("starts the child in the given working directory", async () => {
    const outcome = await supervise({ ...options, spec: spec("argv") });
    const seen = JSON.parse(outcome.kind === "exited" ? outcome.output : "{}") as { cwd: string };
    // A process reports its real directory; on macOS the temp directory is reached through a /var -> /private/var symlink.
    expect(realpathSync(seen.cwd)).toBe(realpathSync(dir));
  });

  it("discards standard error: it never reaches the output", async () => {
    const outcome = await supervise({ ...options, spec: spec("stderr") });
    expect(outcome).toEqual({ kind: "exited", exitCode: 0, output: "ok\n" });
  });

  it("reports a non-zero exit with its partial output", async () => {
    expect(await supervise({ ...options, spec: spec("exit3") })).toEqual({ kind: "exited", exitCode: 3, output: "partial before failure\n" });
  });

  it("reports a missing executable as spawn_failed without throwing", async () => {
    expect(await supervise({ ...options, spec: spec("echo", { command: join(dir, "does-not-exist") }) })).toEqual({ kind: "spawn_failed" });
  });

  it("enforces the output cap on a real flood and kills the producer", async () => {
    const outcome = await supervise({ ...options, maxOutputBytes: 3_000, spec: spec("flood") });
    expect(outcome.kind).toBe("output_limit");
    expect(outcome.kind === "output_limit" && Buffer.byteLength(outcome.output)).toBe(3_000);
  });

  it("enforces the timeout on a child that ignores SIGTERM, and leaves no process behind", async () => {
    const outcome = await supervise({ ...options, timeoutMs: 300, spec: spec("sleep") });
    expect(outcome.kind).toBe("timeout");
    const pid = Number(readFileSync(join(dir, "marker.pid"), "utf8"));
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3_000 });
  });

  it("cancellation kills the whole process group: the child and a grandchild both die", async () => {
    let cancel = false;
    const pending = supervise({ ...options, shouldCancel: () => cancel, spec: spec("tree") });
    await vi.waitFor(() => expect(fileExists(join(dir, "marker.child"))).toBe(true), { timeout: 5_000 });
    const parent = Number(readFileSync(join(dir, "marker.pid"), "utf8"));
    const grandchild = Number(readFileSync(join(dir, "marker.child"), "utf8"));
    expect(alive(parent) && alive(grandchild)).toBe(true);

    cancel = true;
    expect(await pending).toEqual({ kind: "cancelled" });
    await vi.waitFor(() => expect(alive(parent) || alive(grandchild)).toBe(false), { timeout: 3_000 });
  });
});
