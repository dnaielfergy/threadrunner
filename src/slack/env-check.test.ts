import { chmodSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "../store/test-utils.js";
import { checkEnvFile, createEnvFileCheck, envFileRemedy, type EnvFileCode, type EnvStat } from "./env-check.js";

const CANARY = "xoxb-CANARY-env-check-0123456789";
const UID = process.getuid?.() ?? 1000;

function envFile(mode: number): string {
  const path = join(tempDir(), ".env");
  writeFileSync(path, `SLACK_BOT_TOKEN=${CANARY}\n`);
  chmodSync(path, mode);
  return path;
}

function check(path: string, overrides: { uid?: number | undefined; platform?: NodeJS.Platform } = {}) {
  const lstat = vi.fn((p: string) => lstatSync(p));
  const result = checkEnvFile({ path, lstat, uid: "uid" in overrides ? overrides.uid : UID, platform: overrides.platform ?? "linux" });
  return { result, lstat };
}

describe("checkEnvFile on real temporary files", () => {
  it("passes a 0600 file owned by the current user", () => {
    expect(check(envFile(0o600)).result).toEqual({ ok: true });
  });

  it("passes a 0400 file", () => {
    expect(check(envFile(0o400)).result).toEqual({ ok: true });
  });

  it("skips a missing file", () => {
    expect(check(join(tempDir(), ".env")).result).toEqual({ ok: true });
  });

  it.each([
    ["group-readable", 0o640, "env_group_access"],
    ["group-writable", 0o620, "env_group_access"],
    ["world-readable", 0o604, "env_other_access"],
    ["world-writable", 0o602, "env_other_access"],
    ["the default 0644", 0o644, "env_other_access"],
  ])("refuses a %s file", (_name, mode, code) => {
    const path = envFile(mode);
    expect(check(path).result).toEqual({ ok: false, code, path });
  });

  it("refuses a file owned by someone else", () => {
    const path = envFile(0o600);
    expect(check(path, { uid: UID + 1 }).result).toEqual({ ok: false, code: "env_wrong_owner", path });
  });

  it("refuses a symlink, even to a 0600 file", () => {
    const target = envFile(0o600);
    const link = join(tempDir(), ".env");
    symlinkSync(target, link);
    expect(check(link).result).toEqual({ ok: false, code: "env_symlink", path: link });
  });

  it("refuses a directory in place of the file", () => {
    const path = join(tempDir(), ".env");
    mkdirSync(path, { mode: 0o700 });
    expect(check(path).result).toEqual({ ok: false, code: "env_not_regular", path });
  });
});

describe("checkEnvFile with an injected stat", () => {
  const regular = (mode: number, uid = UID): EnvStat => ({ mode: 0o100000 | mode, uid });
  const run = (stat: EnvStat, platform: NodeJS.Platform = "linux") => checkEnvFile({ path: "/fake/.env", lstat: () => stat, uid: UID, platform });

  it("accepts and refuses from the stat alone", () => {
    expect(run(regular(0o600))).toEqual({ ok: true });
    expect(run(regular(0o660))).toMatchObject({ ok: false, code: "env_group_access" });
    expect(run(regular(0o600, UID + 1))).toMatchObject({ ok: false, code: "env_wrong_owner" });
    expect(run({ mode: 0o120777, uid: UID })).toMatchObject({ ok: false, code: "env_symlink" });
    expect(run({ mode: 0o040700, uid: UID })).toMatchObject({ ok: false, code: "env_not_regular" });
  });

  it("reports the other-user code first when group and other bits are both set", () => {
    expect(run(regular(0o666))).toMatchObject({ code: "env_other_access" });
  });

  it("fails closed when lstat fails for a reason other than a missing file", () => {
    const lstat = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(checkEnvFile({ path: "/fake/.env", lstat, uid: UID, platform: "linux" })).toEqual({ ok: false, code: "env_unreadable", path: "/fake/.env" });
  });

  it("fails closed when the uid is unavailable on a POSIX platform", () => {
    const lstat = () => regular(0o600);
    expect(checkEnvFile({ path: "/fake/.env", lstat, uid: undefined, platform: "linux" })).toEqual({ ok: false, code: "env_unreadable", path: "/fake/.env" });
  });

  it("skips on Windows without calling lstat", () => {
    const lstat = vi.fn(() => regular(0o666));
    expect(checkEnvFile({ path: "/fake/.env", lstat, uid: undefined, platform: "win32" })).toEqual({ ok: true });
    expect(lstat).not.toHaveBeenCalled();
  });
});

describe("what the check touches", () => {
  it("makes exactly one lstat call and its result never contains the file's contents", () => {
    const path = envFile(0o644);
    const { result, lstat } = check(path);
    expect(lstat).toHaveBeenCalledTimes(1);
    expect(lstat).toHaveBeenCalledWith(path);
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(JSON.stringify(result)).not.toContain("SLACK_BOT_TOKEN");
  });

  it("a passing result carries nothing from the file either", () => {
    expect(JSON.stringify(check(envFile(0o600)).result)).not.toContain(CANARY);
  });

  it("the production factory resolves .env in the given directory and applies the check", () => {
    const dir = tempDir();
    const path = join(dir, ".env");
    expect(createEnvFileCheck(dir)()).toEqual({ ok: true });
    writeFileSync(path, `SLACK_BOT_TOKEN=${CANARY}\n`);
    chmodSync(path, 0o600);
    expect(createEnvFileCheck(dir)()).toEqual({ ok: true });
    chmodSync(path, 0o644);
    expect(createEnvFileCheck(dir)()).toEqual({ ok: false, code: "env_other_access", path });
  });
});

describe("envFileRemedy", () => {
  const codes: EnvFileCode[] = ["env_group_access", "env_other_access", "env_wrong_owner", "env_symlink", "env_not_regular", "env_unreadable"];

  it("gives a chmod for the mode refusals and a different instruction for the others", () => {
    expect(envFileRemedy("env_group_access", "/h/.env")).toBe("chmod 600 '/h/.env'");
    expect(envFileRemedy("env_other_access", "/h/.env")).toBe("chmod 600 '/h/.env'");
    for (const code of ["env_symlink", "env_not_regular", "env_wrong_owner", "env_unreadable"] as const) {
      expect(envFileRemedy(code, "/h/.env")).not.toBe("chmod 600 '/h/.env'");
    }
    expect(envFileRemedy("env_symlink", "/h/.env")).toContain("regular file");
    expect(envFileRemedy("env_wrong_owner", "/h/.env")).toContain("chown");
  });

  it.each(codes)("shell-quotes a path with a space and a quote for %s", (code) => {
    const text = envFileRemedy(code, "/my dir/it's/.env");
    expect(text).toContain(`'/my dir/it'\\''s/.env'`);
    expect(text).not.toContain(" /my dir/");
  });
});
