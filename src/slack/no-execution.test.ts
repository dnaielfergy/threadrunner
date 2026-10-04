import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Any module in the ingress path that touches child_process lands here and is recorded.
const calls: string[] = [];
vi.mock("node:child_process", () => {
  const trap = (name: string) => () => {
    calls.push(name);
    throw new Error(`child_process.${name} must never be called`);
  };
  return Object.fromEntries(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"].map((n) => [n, trap(n)]));
});

const { createEnvelopeHandler } = await import("./ingress.js");
const { createSender } = await import("./sender.js");
const { fakeClock, fakeIds, open, tempDbPath } = await import("../store/test-utils.js");
const fixtures = await import("./test-fixtures.js");

// The only allowed filesystem reference is this single import, and no call that reads or opens a file.
const ENV_CHECK_IMPORT = 'import { constants, lstatSync } from "node:fs";';
function envCheckFsViolations(text: string): string[] {
  const violations: string[] = [];
  if ((text.match(/node:fs|from "fs"|require\(|import\(/g) ?? []).length !== 1) violations.push("more or fewer than one filesystem reference");
  if (!text.includes(ENV_CHECK_IMPORT)) violations.push("the fixed import is missing");
  if (/node:fs\/|import\s+\*\s+as|import\s+(?!type\b)\w+\s*(,|from)/.test(text)) violations.push("namespace, default, or subpath import");
  if (/readFile|readdir|opendir|openSync|createReadStream|writeFile|\bstatSync\b|\bfstat|\bread\s*\(/.test(text)) violations.push("a read, open, or other stat call");
  return violations;
}

describe("no provider, subprocess, or listener", () => {
  it("a full task / status / cancel / approve / send cycle never calls child_process", async () => {
    const store = open(tempDbPath(), { now: fakeClock(), randomId: fakeIds() });
    const { log } = fixtures.capturingLogger();
    const handle = createEnvelopeHandler({ store, auth: fixtures.AUTH, botUserId: fixtures.BOT_USER, log });
    const api = fixtures.fakeSlackApi();
    const sender = createSender({ store, api, teamId: fixtures.TEAM, log, now: () => 0 });

    const root = fixtures.nextTs();
    await handle(fixtures.fakeEnvelope(fixtures.dmMessage("/codex deep run the whole test suite and deploy", { event: { ts: root } })));
    for (const text of ["/status", "/approve run-aaa1", "/cancel"]) {
      await handle(fixtures.fakeEnvelope(fixtures.dmMessage(text, { event: { thread_ts: root } })));
    }
    await sender.drain();
    await sender.drain();

    expect(api.posts.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
    // The run stops at queued/cancelled: nothing ever moves it to running.
    const states = store.db.prepare("SELECT DISTINCT to_state FROM run_events WHERE to_state IS NOT NULL").all().map((r) => r["to_state"]);
    expect(states).not.toContain("running");
  });

  describe("source tripwire", () => {
    const dir = new URL(".", import.meta.url).pathname;
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "test-fixtures.ts")
      .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);

    it("finds the source files it is meant to scan", () => {
      expect(sources.map(([f]) => f)).toEqual(expect.arrayContaining(["ingress.ts", "sender.ts", "sdk.ts", "authorize.ts"]));
    });

    // The one narrow allowance: the .env permission check does a single lstat and nothing else.
    const FS_ALLOWED = ["env-check.ts"];

    it.each([
      ["child_process / worker / vm / cluster", /child_process|worker_threads|node:vm|node:cluster/],
      ["raw network or listener modules", /node:(http|https|http2|net|tls|dgram)\b/],
      ["dynamic code", /\beval\s*\(|new Function\s*\(/],
      ["a listening server", /\.listen\s*\(/],
    ])("no source file under src/slack uses %s", (_name, pattern) => {
      const offenders = sources.filter(([, text]) => pattern.test(text)).map(([f]) => f);
      expect(offenders).toEqual([]);
    });

    it("no source file under src/slack uses filesystem access, except the env check", () => {
      const offenders = sources.filter(([f, text]) => /node:fs|from "fs"/.test(text) && !FS_ALLOWED.includes(f)).map(([f]) => f);
      expect(offenders).toEqual([]);
    });

    it("the filesystem allowance covers env-check.ts only, as one fixed import and no read calls", () => {
      expect(FS_ALLOWED).toEqual(["env-check.ts"]);
      const text = sources.find(([f]) => f === "env-check.ts")?.[1] ?? "";
      expect(text).not.toBe("");
      expect(envCheckFsViolations(text)).toEqual([]);
    });

    it("the allowance guard rejects every way of reaching more of the filesystem", () => {
      const ok = 'import { constants, lstatSync } from "node:fs";\nexport const x = 1;\n';
      expect(envCheckFsViolations(ok)).toEqual([]);
      for (const bad of [
        ok + 'import * as fsx from "node:fs";\nexport const leak = (p: string) => fsx.readFileSync(p, "utf8");\n',
        ok + 'import fs from "node:fs";\n',
        ok + 'import { readFileSync } from "node:fs";\n',
        ok + 'import { readFile } from "node:fs/promises";\n',
        ok + 'const m = await import("node:fs");\n',
        ok + 'const m = require("fs");\n',
        ok + 'export const r = (p: string) => readdirSync(p);\n',
        ok + 'export const s = (p: string) => statSync(p);\n',
        ok + 'export const o = (p: string) => openSync(p, "r");\n',
        'import { constants, lstatSync, readFileSync } from "node:fs";\n',
        'import { lstatSync } from "node:fs";\n',
      ]) {
        expect(envCheckFsViolations(bad), bad).not.toEqual([]);
      }
    });

    it("only sdk.ts imports the Slack SDK packages", () => {
      const importers = sources.filter(([, text]) => /from "@slack\//.test(text)).map(([f]) => f);
      expect(importers).toEqual(["sdk.ts"]);
    });
  });
});
