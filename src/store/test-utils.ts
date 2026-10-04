import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { approveRun, createRunFromEvent, markSent, openStore, requestApproval, transitionRun, type NewRunInput, type OpenStoreOptions, type Store } from "./index.js";

export const BINDING = { teamId: "T0AAAAAAA", userId: "U0AAAAAAA", channelId: "C0AAAAAAA", rootThreadTs: "1700000000.000100" } as const;

export const SECRET_PROMPT = "PROMPT-CANARY-8f3a investigate the login bug";

export function newRun(overrides: Partial<NewRunInput> = {}): NewRunInput {
  return {
    ...BINDING,
    eventId: "Ev0AAAAAAA1",
    messageTs: BINDING.rootThreadTs,
    provider: "claude",
    profile: "default",
    prompt: SECRET_PROMPT,
    ...overrides,
  };
}

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "threadrunner-test-"));
  dirs.push(dir);
  return dir;
}

export function tempDbPath(dir = tempDir()): string {
  return join(dir, "data", "threadrunner.db");
}

export function open(path: string, options: Partial<OpenStoreOptions> = {}): Store {
  const store = openStore({ path, ...options });
  stores.push(store);
  return store;
}

/** A deterministic clock that advances 1ms per call. */
export function fakeClock(start = 1_700_000_000_000): () => number {
  let t = start;
  return () => t++;
}

/** Sequential, pattern-valid run ID suffixes: aaa1, aaa2, ... */
export function fakeIds(): () => string {
  let n = 0;
  return () => `aaa${++n}`;
}

export const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
export const REPO_ROOT = "/srv/sandbox-repo";
export const APPROVAL_TTL_MS = 60 * 60 * 1000;

/** Create an edit-mode run and bring it to `awaiting_approval` through the real store functions. */
export function editRunAwaitingApproval(
  store: Store,
  overrides: Partial<NewRunInput> = {},
  baseSha: string = BASE_SHA,
): { runId: string; messageId: number } {
  const created = createRunFromEvent(store, newRun({ mode: "edit", ...overrides }));
  if (created.status !== "created") throw new Error("test setup: run was not created");
  if (!transitionRun(store, BINDING, "received", "validated").ok) throw new Error("test setup: validate failed");
  const requested = requestApproval(store, BINDING, created.run.id, { baseSha, body: "approval request", ttlMs: APPROVAL_TTL_MS });
  if (!requested.ok) throw new Error(`test setup: request failed: ${requested.error}`);
  return { runId: created.run.id, messageId: requested.request.requestMessageId };
}

/** Like `editRunAwaitingApproval`, then deliver the request and approve it, ending in `queued_write`. */
export function editRunQueuedWrite(
  store: Store,
  overrides: Partial<NewRunInput> = {},
  real: { baseSha: string; repoRoot: string } = { baseSha: BASE_SHA, repoRoot: REPO_ROOT },
): string {
  const { runId, messageId } = editRunAwaitingApproval(store, overrides, real.baseSha);
  markSent(store, messageId);
  const approved = approveRun(store, BINDING, runId, { repoRoot: real.repoRoot });
  if (!approved.ok) throw new Error(`test setup: approve failed: ${approved.error}`);
  return runId;
}
