import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_FILE_BYTES = 64 * 1024;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH_REF = /^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/;

function readSmallFile(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The commit the repository's checked-out branch points at, read straight from the files in `.git`.
 * No git program is run, so no hook, filter, or configured command can execute. Fails closed
 * (returns null) for anything unusual: `.git` as a file or symlink (a linked worktree or a
 * submodule), an unborn branch (no commits yet), an unusual ref name, or a malformed value.
 *
 * The approval request records this commit so the worktree is cut from exactly what the owner saw.
 */
export function readHeadCommit(repoRoot: string): string | null {
  const gitDir = join(repoRoot, ".git");
  try {
    if (!lstatSync(gitDir).isDirectory()) return null;
  } catch {
    return null;
  }

  const head = readSmallFile(join(gitDir, "HEAD"))?.trim();
  if (head === undefined) return null;
  if (SHA.test(head)) return head;

  const ref = /^ref: (\S+)$/.exec(head)?.[1];
  if (ref === undefined || !BRANCH_REF.test(ref) || ref.split("/").includes("..") || ref.endsWith("/") || ref.includes("//")) return null;

  const loose = readSmallFile(join(gitDir, ref))?.trim();
  if (loose !== undefined) return SHA.test(loose) ? loose : null;

  const packed = readSmallFile(join(gitDir, "packed-refs"));
  if (packed === null) return null;
  for (const line of packed.split("\n")) {
    const [sha, name] = line.split(" ");
    if (name === ref && sha !== undefined && SHA.test(sha)) return sha;
  }
  return null;
}
