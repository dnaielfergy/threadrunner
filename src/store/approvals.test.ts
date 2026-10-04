import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RUN_STATES } from "../domain/run-state.js";
import { migrate } from "./database.js";
import {
  approveRun,
  createRunFromEvent,
  enqueueMessage,
  expireStaleApprovals,
  getApproval,
  getEditRequest,
  getRun,
  invocationSha256,
  listPendingMessages,
  listRunEvents,
  markSent,
  recordApproval,
  recordFailedAttempt,
  requestApproval,
  SCHEMA_VERSION,
  transitionRun,
  type Binding,
} from "./index.js";
import { MIGRATIONS } from "./schema.js";
import { APPROVAL_TTL_MS, BASE_SHA, BINDING, REPO_ROOT, editRunAwaitingApproval, editRunQueuedWrite, fakeIds, newRun, open, tempDbPath } from "./test-utils.js";

const OTHER_THREAD = { rootThreadTs: "1700000050.000100" };
const NOTICES = { awaitingApproval: "Approval expired.", queuedWrite: "Approved run expired before it started." };

/** A clock the test can move. */
function clock(start = 1_700_000_000_000) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms: number) => void (state.t += ms) };
}

function store(c = clock()) {
  return { s: open(tempDbPath(), { now: c.now, randomId: fakeIds() }), c };
}

const count = (s: ReturnType<typeof open>, sql: string): number => Number(s.db.prepare(sql).get()?.["n"]);

describe("requestApproval", () => {
  it("moves an edit run validated -> awaiting_approval and queues the request in one step", () => {
    const { s } = store();
    createRunFromEvent(s, newRun({ mode: "edit" }));
    transitionRun(s, BINDING, "received", "validated");
    const result = requestApproval(s, BINDING, "run-aaa1", { baseSha: BASE_SHA, body: "Approve run-aaa1?", ttlMs: APPROVAL_TTL_MS });
    expect(result.ok).toBe(true);
    expect(getRun(s, BINDING)?.state).toBe("awaiting_approval");
    const request = getEditRequest(s, BINDING);
    expect(request).toMatchObject({ runId: "run-aaa1", baseSha: BASE_SHA });
    expect(request && request.expiresAt - request.requestedAt).toBe(APPROVAL_TTL_MS);
    expect(listPendingMessages(s).map((m) => [m.id, m.body])).toEqual([[request?.requestMessageId, "Approve run-aaa1?"]]);
  });

  it("refuses a read-mode run and leaves nothing behind", () => {
    const { s } = store();
    createRunFromEvent(s, newRun());
    transitionRun(s, BINDING, "received", "validated");
    expect(requestApproval(s, BINDING, "run-aaa1", { baseSha: BASE_SHA, body: "x", ttlMs: APPROVAL_TTL_MS })).toEqual({ ok: false, error: "not_edit_mode" });
    expect(getRun(s, BINDING)?.state).toBe("validated");
    expect(count(s, "SELECT count(*) AS n FROM outbox_messages")).toBe(0);
  });

  it("refuses a wrong state, wrong binding, wrong run ID, bad SHA, bad TTL, and bad body", () => {
    const { s } = store();
    createRunFromEvent(s, newRun({ mode: "edit" }));
    const ok = { baseSha: BASE_SHA, body: "x", ttlMs: APPROVAL_TTL_MS };
    expect(requestApproval(s, BINDING, "run-aaa1", ok)).toEqual({ ok: false, error: "not_validated" });
    transitionRun(s, BINDING, "received", "validated");
    const wrong: Binding = { ...BINDING, userId: "U0BBBBBBB" };
    expect(requestApproval(s, wrong, "run-aaa1", ok)).toEqual({ ok: false, error: "not_found" });
    expect(requestApproval(s, BINDING, "run-zzzz", ok)).toEqual({ ok: false, error: "not_found" });
    expect(requestApproval(s, BINDING, "run-aaa1", { ...ok, baseSha: "HEAD" })).toEqual({ ok: false, error: "invalid_input" });
    expect(requestApproval(s, BINDING, "run-aaa1", { ...ok, baseSha: BASE_SHA.toUpperCase() })).toEqual({ ok: false, error: "invalid_input" });
    expect(requestApproval(s, BINDING, "run-aaa1", { ...ok, ttlMs: 1000 })).toEqual({ ok: false, error: "invalid_input" });
    expect(requestApproval(s, BINDING, "run-aaa1", { ...ok, ttlMs: 25 * 60 * 60 * 1000 })).toEqual({ ok: false, error: "invalid_input" });
    expect(requestApproval(s, BINDING, "run-aaa1", { ...ok, body: "" })).toEqual({ ok: false, error: "invalid_body" });
    expect(requestApproval(s, BINDING, "run-aaa1", { ...ok, body: "a".repeat(3001) })).toEqual({ ok: false, error: "invalid_body" });
    expect(getRun(s, BINDING)?.state).toBe("validated");
  });

  it("a second request for the same run is refused", () => {
    const { s } = store();
    editRunAwaitingApproval(s);
    expect(requestApproval(s, BINDING, "run-aaa1", { baseSha: BASE_SHA, body: "x", ttlMs: APPROVAL_TTL_MS })).toEqual({ ok: false, error: "not_validated" });
    expect(count(s, "SELECT count(*) AS n FROM edit_requests")).toBe(1);
  });
});

describe("approveRun", () => {
  it("records the approval with its hash and moves to queued_write in one step", () => {
    const { s } = store();
    const { runId, messageId } = editRunAwaitingApproval(s);
    markSent(s, messageId);
    const result = approveRun(s, BINDING, runId, { repoRoot: REPO_ROOT });
    expect(result.ok).toBe(true);
    expect(getRun(s, BINDING)?.state).toBe("queued_write");
    const expected = invocationSha256({ runId, provider: "claude", profile: "default", mode: "edit", prompt: newRun().prompt, baseSha: BASE_SHA, repoRoot: REPO_ROOT });
    expect(getApproval(s, BINDING)).toMatchObject({ runId, approvedByUserId: BINDING.userId, runState: "awaiting_approval", invocationSha256: expected });
    expect(listRunEvents(s, BINDING).map((e) => [e.type, e.fromState, e.toState]).slice(-2)).toEqual([
      ["approval_recorded", "awaiting_approval", "awaiting_approval"],
      ["transition", "awaiting_approval", "queued_write"],
    ]);
  });

  it("the hash changes with any approved field", () => {
    const base = { runId: "run-aaa1", provider: "codex", profile: "default", mode: "edit", prompt: "p", baseSha: BASE_SHA, repoRoot: "/r" } as const;
    const hashes = new Set([
      invocationSha256(base),
      invocationSha256({ ...base, runId: "run-aaa2" }),
      invocationSha256({ ...base, provider: "claude" }),
      invocationSha256({ ...base, profile: "deep" }),
      invocationSha256({ ...base, mode: "read" }),
      invocationSha256({ ...base, prompt: "q" }),
      invocationSha256({ ...base, baseSha: "f".repeat(40) }),
      invocationSha256({ ...base, repoRoot: "/other" }),
    ]);
    expect(hashes.size).toBe(8);
    expect(invocationSha256(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses until the request message has been delivered", () => {
    const { s } = store();
    const { runId, messageId } = editRunAwaitingApproval(s);
    expect(approveRun(s, BINDING, runId, { repoRoot: REPO_ROOT })).toEqual({ ok: false, error: "not_delivered" });
    // A message that failed all its retries was never shown.
    for (let i = 0; i < 5; i++) recordFailedAttempt(s, messageId, "network");
    expect(approveRun(s, BINDING, runId, { repoRoot: REPO_ROOT })).toEqual({ ok: false, error: "not_delivered" });
    expect(getRun(s, BINDING)?.state).toBe("awaiting_approval");
    expect(getApproval(s, BINDING)).toBeNull();
  });

  it("refuses the wrong user, channel, thread, team, and run ID without revealing which", () => {
    const { s } = store();
    const { runId, messageId } = editRunAwaitingApproval(s);
    markSent(s, messageId);
    for (const wrong of [
      { ...BINDING, userId: "U0BBBBBBB" },
      { ...BINDING, channelId: "C0BBBBBBB" },
      { ...BINDING, teamId: "T0BBBBBBB" },
      { ...BINDING, ...OTHER_THREAD },
    ]) {
      expect(approveRun(s, wrong, runId, { repoRoot: REPO_ROOT })).toEqual({ ok: false, error: "not_found" });
    }
    expect(approveRun(s, BINDING, "run-zzzz", { repoRoot: REPO_ROOT })).toEqual({ ok: false, error: "not_found" });
    expect(approveRun(s, BINDING, "yes", { repoRoot: REPO_ROOT })).toEqual({ ok: false, error: "invalid_input" });
    expect(approveRun(s, BINDING, runId, { repoRoot: "" })).toEqual({ ok: false, error: "invalid_input" });
    expect(getRun(s, BINDING)?.state).toBe("awaiting_approval");
    expect(count(s, "SELECT count(*) AS n FROM approvals")).toBe(0);
  });

  it("refuses a second approval and an approval in any other state", () => {
    const { s } = store();
    const runId = editRunQueuedWrite(s);
    expect(approveRun(s, BINDING, runId, { repoRoot: REPO_ROOT })).toEqual({ ok: false, error: "not_awaiting_approval" });
    expect(count(s, "SELECT count(*) AS n FROM approvals")).toBe(1);
  });

  it("refuses a read-mode run even if it is awaiting approval (future plan mode)", () => {
    const { s } = store();
    createRunFromEvent(s, newRun());
    for (const [from, to] of [["received", "validated"], ["validated", "queued"], ["queued", "running"], ["running", "awaiting_approval"]] as const) {
      transitionRun(s, BINDING, from, to);
    }
    expect(approveRun(s, BINDING, "run-aaa1", { repoRoot: REPO_ROOT })).toEqual({ ok: false, error: "not_edit_mode" });
    expect(getRun(s, BINDING)?.state).toBe("awaiting_approval");
  });

  it("refuses at and after the expiry time, and accepts just before", () => {
    const { s, c } = store();
    const { runId, messageId } = editRunAwaitingApproval(s);
    markSent(s, messageId);
    c.advance(APPROVAL_TTL_MS - 1);
    // Still valid one millisecond before expiry; use a fresh run to check both edges.
    const { s: s2, c: c2 } = store();
    const second = editRunAwaitingApproval(s2);
    markSent(s2, second.messageId);
    c2.advance(APPROVAL_TTL_MS - 1);
    expect(approveRun(s2, BINDING, second.runId, { repoRoot: REPO_ROOT }).ok).toBe(true);
    c.advance(1);
    expect(approveRun(s, BINDING, runId, { repoRoot: REPO_ROOT })).toEqual({ ok: false, error: "expired" });
    expect(getRun(s, BINDING)?.state).toBe("awaiting_approval");
  });

  it("a cancel that wins the race means the approval is refused, and an approval that wins means cancel still works", () => {
    const first = store().s;
    const a = editRunAwaitingApproval(first);
    markSent(first, a.messageId);
    expect(transitionRun(first, BINDING, "awaiting_approval", "cancelled").ok).toBe(true);
    expect(approveRun(first, BINDING, a.runId, { repoRoot: REPO_ROOT })).toEqual({ ok: false, error: "not_awaiting_approval" });
    expect(count(first, "SELECT count(*) AS n FROM approvals")).toBe(0);

    const second = store().s;
    const runId = editRunQueuedWrite(second);
    expect(transitionRun(second, BINDING, "queued_write", "cancelled").ok).toBe(true);
    expect(getRun(second, BINDING)?.state).toBe("cancelled");
    expect(runId).toBe("run-aaa1");
  });

  it("the legacy recordApproval cannot unlock a write", () => {
    const { s } = store();
    const { runId, messageId } = editRunAwaitingApproval(s);
    markSent(s, messageId);
    expect(recordApproval(s, BINDING, runId).ok).toBe(true);
    expect(getApproval(s, BINDING)?.invocationSha256).toBeNull();
    expect(approveRun(s, BINDING, runId, { repoRoot: REPO_ROOT })).toEqual({ ok: false, error: "already_approved" });
    expect(() => s.db.prepare("UPDATE runs SET state = 'queued_write' WHERE id = ?").run(runId)).toThrow(/recorded approval/);
  });
});

describe("transitionRun and mode", () => {
  it("never reaches queued_write on its own", () => {
    const { s } = store();
    const { messageId } = editRunAwaitingApproval(s);
    markSent(s, messageId);
    expect(transitionRun(s, BINDING, "awaiting_approval", "queued_write")).toEqual({ ok: false, error: "illegal_transition" });
  });

  it("keeps read-mode runs off the approval and write path, and edit-mode runs off the read-only path", () => {
    const { s } = store();
    createRunFromEvent(s, newRun());
    transitionRun(s, BINDING, "received", "validated");
    expect(transitionRun(s, BINDING, "validated", "awaiting_approval")).toEqual({ ok: false, error: "illegal_transition" });

    const e = store().s;
    createRunFromEvent(e, newRun({ mode: "edit" }));
    transitionRun(e, BINDING, "received", "validated");
    expect(transitionRun(e, BINDING, "validated", "queued")).toEqual({ ok: false, error: "illegal_transition" });
    expect(getRun(e, BINDING)?.state).toBe("validated");
  });

  it("allows only one running_write at a time and reports it as a busy slot", () => {
    const { s } = store();
    editRunQueuedWrite(s);
    const second = { ...BINDING, ...OTHER_THREAD };
    createRunFromEvent(s, newRun({ ...OTHER_THREAD, eventId: "Ev0AAAAAAA2", messageTs: OTHER_THREAD.rootThreadTs, mode: "edit" }));
    transitionRun(s, second, "received", "validated");
    const req = requestApproval(s, second, "run-aaa2", { baseSha: BASE_SHA, body: "x", ttlMs: APPROVAL_TTL_MS });
    expect(req.ok).toBe(true);
    markSent(s, req.ok ? req.request.requestMessageId : 0);
    expect(approveRun(s, second, "run-aaa2", { repoRoot: REPO_ROOT }).ok).toBe(true);

    expect(transitionRun(s, BINDING, "queued_write", "running_write").ok).toBe(true);
    expect(transitionRun(s, second, "queued_write", "running_write")).toEqual({ ok: false, error: "write_slot_busy" });
    expect(getRun(s, second)?.state).toBe("queued_write");
    // Finishing the first frees the slot.
    expect(transitionRun(s, BINDING, "running_write", "completed").ok).toBe(true);
    expect(transitionRun(s, second, "queued_write", "running_write").ok).toBe(true);
  });
});

describe("expireStaleApprovals", () => {
  it("fails an unapproved request past its expiry, kills its pending request, and queues one notice", () => {
    const { s, c } = store();
    editRunAwaitingApproval(s);
    c.advance(APPROVAL_TTL_MS - 1);
    expect(expireStaleApprovals(s, { queuedWriteTtlMs: APPROVAL_TTL_MS, notices: NOTICES })).toEqual([]);
    c.advance(1);
    const failed = expireStaleApprovals(s, { queuedWriteTtlMs: APPROVAL_TTL_MS, notices: NOTICES });
    expect(failed.map((r) => [r.id, r.state])).toEqual([["run-aaa1", "failed"]]);
    expect(listPendingMessages(s).map((m) => m.body)).toEqual([NOTICES.awaitingApproval]);
    // Idempotent, and the run cannot be revived.
    expect(expireStaleApprovals(s, { queuedWriteTtlMs: APPROVAL_TTL_MS, notices: NOTICES })).toEqual([]);
    expect(transitionRun(s, BINDING, "failed", "queued").ok).toBe(false);
  });

  it("fails an approved run that waited too long in queued_write, measured from the approval", () => {
    const { s, c } = store();
    const { messageId } = editRunAwaitingApproval(s);
    markSent(s, messageId);
    c.advance(APPROVAL_TTL_MS / 2);
    approveRun(s, BINDING, "run-aaa1", { repoRoot: REPO_ROOT });
    c.advance(APPROVAL_TTL_MS - 1);
    expect(expireStaleApprovals(s, { queuedWriteTtlMs: APPROVAL_TTL_MS, notices: NOTICES })).toEqual([]);
    c.advance(1);
    const failed = expireStaleApprovals(s, { queuedWriteTtlMs: APPROVAL_TTL_MS, notices: NOTICES });
    expect(failed.map((r) => r.state)).toEqual(["failed"]);
    expect(listPendingMessages(s).map((m) => m.body)).toEqual([NOTICES.queuedWrite]);
  });

  it("leaves running_write and runs without a request alone", () => {
    const { s, c } = store();
    editRunQueuedWrite(s);
    transitionRun(s, BINDING, "queued_write", "running_write");
    c.advance(10 * APPROVAL_TTL_MS);
    expect(expireStaleApprovals(s, { queuedWriteTtlMs: APPROVAL_TTL_MS, notices: NOTICES })).toEqual([]);
    expect(getRun(s, BINDING)?.state).toBe("running_write");
  });

  it("rejects unusable options", () => {
    const { s } = store();
    expect(() => expireStaleApprovals(s, { queuedWriteTtlMs: 0, notices: NOTICES })).toThrow(RangeError);
    expect(() => expireStaleApprovals(s, { queuedWriteTtlMs: 1, notices: { ...NOTICES, queuedWrite: "" } })).toThrow(RangeError);
  });
});

describe("database triggers (defense in depth, bypassing the store functions)", () => {
  const sql = (s: ReturnType<typeof open>, text: string): void => void s.db.exec(text);

  it("refuse queued_write without an approval row, even for an edit run", () => {
    const { s } = store();
    const { runId } = editRunAwaitingApproval(s);
    expect(() => sql(s, `UPDATE runs SET state = 'queued_write' WHERE id = '${runId}'`)).toThrow(/recorded approval/);
  });

  it("refuse queued_write for a read-mode run even with an approval row", () => {
    const { s } = store();
    createRunFromEvent(s, newRun());
    for (const [from, to] of [["received", "validated"], ["validated", "queued"], ["queued", "running"], ["running", "awaiting_approval"]] as const) {
      transitionRun(s, BINDING, from, to);
    }
    sql(s, `INSERT INTO approvals (run_id, approved_by_user_id, run_state, approved_at, invocation_sha256) VALUES ('run-aaa1', 'U0AAAAAAA', 'awaiting_approval', 1, '${"a".repeat(64)}')`);
    expect(() => sql(s, "UPDATE runs SET state = 'queued_write' WHERE id = 'run-aaa1'")).toThrow(/edit run/);
  });

  it("refuse running_write unless the run was queued_write", () => {
    const { s } = store();
    editRunAwaitingApproval(s);
    expect(() => sql(s, "UPDATE runs SET state = 'running_write' WHERE id = 'run-aaa1'")).toThrow(/follows queued_write/);
  });

  it("refuse awaiting_approval from validated for a read-mode run, and the read-only path for an edit run", () => {
    const { s } = store();
    createRunFromEvent(s, newRun());
    transitionRun(s, BINDING, "received", "validated");
    expect(() => sql(s, "UPDATE runs SET state = 'awaiting_approval' WHERE id = 'run-aaa1'")).toThrow(/only edit-mode/);

    const e = store().s;
    createRunFromEvent(e, newRun({ mode: "edit" }));
    transitionRun(e, BINDING, "received", "validated");
    expect(() => sql(e, "UPDATE runs SET state = 'queued' WHERE id = 'run-aaa1'")).toThrow(/never take the read-only path/);
  });

  it("make mode immutable and the new tables append-only", () => {
    const { s } = store();
    const { runId } = editRunAwaitingApproval(s);
    expect(() => sql(s, `UPDATE runs SET mode = 'read' WHERE id = '${runId}'`)).toThrow(/immutable/);
    expect(() => sql(s, `UPDATE edit_requests SET base_sha = '${"b".repeat(40)}'`)).toThrow(/append-only/);
    expect(() => sql(s, "DELETE FROM edit_requests")).toThrow(/append-only/);
  });

  it("refuse an edit request for a read run or a run that is not awaiting approval", () => {
    const { s } = store();
    createRunFromEvent(s, newRun());
    const insert = `INSERT INTO edit_requests (run_id, base_sha, requested_at, expires_at, request_message_id) VALUES ('run-aaa1', '${BASE_SHA}', 1, 2, `;
    const message = enqueueMessage(s, "run-aaa1", "x");
    const id = message.ok ? message.messageId : 0;
    expect(() => sql(s, `${insert}${id})`)).toThrow(/edit request needs/);
  });

  it("guard the worktrees table: needs an approval, never rewritten, removal recorded once, never deleted", () => {
    const { s } = store();
    const runId = editRunQueuedWrite(s);
    const insert = (id: string) => `INSERT INTO worktrees (run_id, path, branch, base_sha, created_at) VALUES ('${id}', '/w/${id}', 'b-${id}', '${BASE_SHA}', 1)`;
    sql(s, insert(runId));
    expect(() => sql(s, `UPDATE worktrees SET path = '/elsewhere'`)).toThrow(/immutable/);
    sql(s, "UPDATE worktrees SET removed_at = 5");
    expect(() => sql(s, "UPDATE worktrees SET removed_at = 6")).toThrow(/once/);
    expect(() => sql(s, "DELETE FROM worktrees")).toThrow(/cannot be deleted/);

    const other = store().s;
    editRunAwaitingApproval(other);
    expect(() => sql(other, insert("run-aaa1"))).toThrow(/recorded approval/);
  });

  it("keep every state value valid (the CHECK constraint is unchanged)", () => {
    const { s } = store();
    createRunFromEvent(s, newRun());
    expect(() => sql(s, "UPDATE runs SET state = 'bogus'")).toThrow();
    expect(RUN_STATES).toContain("queued_write");
  });
});

describe("upgrading a version 1 database", () => {
  it("keeps existing runs as read mode and old approvals without a hash", () => {
    const path = tempDbPath();
    mkdirSync(dirname(path), { recursive: true });
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(MIGRATIONS[0] as string);
    raw.exec("PRAGMA user_version = 1");
    raw.exec(`INSERT INTO runs (id, team_id, user_id, channel_id, root_thread_ts, provider, profile, prompt, state, created_at, updated_at)
              VALUES ('run-old1', 'T0AAAAAAA', 'U0AAAAAAA', 'C0AAAAAAA', '1700000000.000100', 'codex', 'default', 'old prompt', 'awaiting_approval', 1, 1)`);
    raw.exec("INSERT INTO approvals (run_id, approved_by_user_id, run_state, approved_at) VALUES ('run-old1', 'U0AAAAAAA', 'awaiting_approval', 2)");
    expect(() => migrate(raw)).not.toThrow();
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(raw.prepare("SELECT mode FROM runs WHERE id = 'run-old1'").get()).toEqual({ mode: "read" });
    expect(raw.prepare("SELECT invocation_sha256 AS h FROM approvals").get()).toEqual({ h: null });
    // The old approval cannot be used to unlock a write.
    expect(() => raw.exec("UPDATE runs SET state = 'queued_write' WHERE id = 'run-old1'")).toThrow();
    raw.close();
  });
});
