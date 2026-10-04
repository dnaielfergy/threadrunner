import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = new URL(".", import.meta.url).pathname;
const sources = readdirSync(dir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "test-utils.ts")
  .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);

const offenders = (pattern: RegExp, except: readonly string[] = []): string[] =>
  sources.filter(([f, text]) => !except.includes(f) && pattern.test(text)).map(([f]) => f);

describe("src/runner source tripwire", () => {
  it("finds the source files it is meant to scan", () => {
    expect(sources.map(([f]) => f)).toEqual(expect.arrayContaining(["launcher.ts", "runner.ts", "supervise.ts", "env.ts", "repo-root.ts", "config.ts"]));
  });

  it("child_process is imported by launcher.ts and nothing else", () => {
    expect(offenders(/child_process/)).toEqual(["launcher.ts"]);
  });

  it("the launcher never uses a shell, runs the child as a group leader, and starts it with spawn only", () => {
    const launcher = sources.find(([f]) => f === "launcher.ts")?.[1] ?? "";
    expect(launcher).toMatch(/shell:\s*false/);
    expect(launcher).toMatch(/detached:\s*true/);
    expect(launcher).not.toMatch(/shell:\s*(true|["'`])/);
    expect(launcher).not.toMatch(/\b(exec|execSync|execFile|execFileSync|spawnSync|fork)\s*\(/);
    expect(launcher).not.toMatch(/\.\.\.\s*process\.env|env:\s*process\.env/);
  });

  it("no source file builds a command line, uses dynamic code, opens a listener, or reaches the network or Slack", () => {
    expect(offenders(/\beval\s*\(|new Function\s*\(/)).toEqual([]);
    expect(offenders(/\.listen\s*\(/)).toEqual([]);
    expect(offenders(/node:(http|https|http2|net|tls|dgram|vm|cluster|worker_threads)\b/)).toEqual([]);
    expect(offenders(/from "@slack\//)).toEqual([]);
    expect(offenders(/process\.env/, ["env.ts"])).toEqual([]); // only a caller-supplied environment object is ever read
  });

  it("no source file mentions a permission-bypass flag (SECURITY.md)", () => {
    expect(offenders(/dangerously|--yolo|bypass-approvals|bypass_approvals/i)).toEqual([]);
  });
});
