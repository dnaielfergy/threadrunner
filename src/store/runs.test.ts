import { describe, expect, it } from "vitest";
import { RUN_STATES, type RunState } from "../domain/run-state.js";
import { RUN_ID_PATTERN } from "../parser/command.js";
import { createRunFromEvent, getApproval, getRun, listRunEvents, recordApproval, transitionRun, type Binding } from "./index.js";
import { BINDING, SECRET_PROMPT, fakeClock, fakeIds, newRun, open, tempDbPath } from "./test-utils.js";

const count = (store: ReturnType<typeof open>, table: string): number =>
  Number(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);

/** Drive a freshly created run to `awaiting_approval` through legal transitions. */
function toAwaitingApproval(s: ReturnType<typeof open>): void {
  for (const [from, to] of [["received", "validated"], ["validated", "queued"], ["queued", "running"], ["running", "awaiting_approval"]] as const) {
    expect(transitionRun(s, BINDING, from, to).ok).toBe(true);
  }
}

function store() {
  return open(tempDbPath(), { now: fakeClock(), randomId: fakeIds() });
}

describe("run creation and idempotency", () => {
  it("creates a run bound to team, user, channel and root thread", () => {
    const s = store();
    const result = createRunFromEvent(s, newRun());
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.run).toMatchObject({ ...BINDING, state: "received", provider: "claude", profile: "default" });
    expect(result.run.id).toBe("run-aaa1");
    expect(RUN_ID_PATTERN.test(result.run.id)).toBe(true);
    expect(getRun(s, BINDING)).toEqual(result.run);
  });

  it("generates run IDs matching RUN_ID_PATTERN from the default random source", () => {
    const s = open(tempDbPath());
    const result = createRunFromEvent(s, newRun());
    expect(result.status === "created" && RUN_ID_PATTERN.test(result.run.id)).toBe(true);
  });

  it("retries on a run ID collision", () => {
    const ids = ["same1", "same1", "other"];
    const s = open(tempDbPath(), { randomId: () => ids.shift() ?? "zzzz" });
    const a = createRunFromEvent(s, newRun());
    const b = createRunFromEvent(s, newRun({ eventId: "Ev0AAAAAAA2", messageTs: "1700000001.000100", rootThreadTs: "1700000001.000100" }));
    expect(a.status === "created" && a.run.id).toBe("run-same1");
    expect(b.status === "created" && b.run.id).toBe("run-other");
  });

  it("fails and leaves nothing behind if the ID generator keeps colliding or is malformed", () => {
    const s = open(tempDbPath(), { randomId: () => "same1" });
    createRunFromEvent(s, newRun());
    expect(() => createRunFromEvent(s, newRun({ eventId: "Ev0AAAAAAA2", messageTs: "1700000001.000100", rootThreadTs: "1700000001.000100" }))).toThrow();
    expect(count(s, "runs")).toBe(1);

    const bad = open(tempDbPath(), { randomId: () => "BAD ID!" });
    expect(() => createRunFromEvent(bad, newRun())).toThrow();
    expect(count(bad, "runs")).toBe(0);
  });

  it("returns 'duplicate' (not an error, no second run) for a repeated event ID", () => {
    const s = store();
    expect(createRunFromEvent(s, newRun()).status).toBe("created");
    expect(createRunFromEvent(s, newRun())).toEqual({ status: "duplicate" });
    expect(createRunFromEvent(s, newRun({ prompt: "different prompt", messageTs: "1700000009.000100", rootThreadTs: "1700000009.000100" }))).toEqual({ status: "duplicate" });
    expect(count(s, "runs")).toBe(1);
    expect(count(s, "inbound_events")).toBe(1);
  });

  it("creates one run for two events with different event_ids but the same (channel, message_ts)", () => {
    const s = store();
    expect(createRunFromEvent(s, newRun({ eventId: "Ev0MESSAGE1" })).status).toBe("created");
    expect(createRunFromEvent(s, newRun({ eventId: "Ev0MENTION1" })).status).toBe("duplicate");
    expect(count(s, "runs")).toBe(1);
  });

  it("allows the same event_id in a different team (key is team-scoped)", () => {
    const s = store();
    expect(createRunFromEvent(s, newRun()).status).toBe("created");
    expect(createRunFromEvent(s, newRun({ teamId: "T0BBBBBBB" })).status).toBe("created");
  });

  it("rejects a different message that tries to start a second run in the same root thread, without revealing the first", () => {
    const s = store();
    createRunFromEvent(s, newRun());
    const second = createRunFromEvent(s, newRun({ eventId: "Ev0AAAAAAA2", messageTs: "1700000005.000100" }));
    expect(second).toEqual({ status: "rejected", reason: "thread_already_has_run" });
    expect(count(s, "runs")).toBe(1);
    expect(count(s, "inbound_events")).toBe(1);
  });

  it.each([
    ["teamId", { teamId: "t0aaaaaaa" }],
    ["userId", { userId: "X0AAAAAAA" }],
    ["channelId", { channelId: "C0AAAAAAA; DROP TABLE runs" }],
    ["rootThreadTs", { rootThreadTs: "not-a-ts" }],
    ["messageTs", { messageTs: "1700000000.0001" }],
    ["eventId", { eventId: "" }],
    ["eventId", { eventId: "Ev" + "A".repeat(200) }],
    ["provider", { provider: "gpt" as never }],
    ["profile", { profile: "gpt-5-turbo" as never }],
    ["prompt", { prompt: "" }],
    ["prompt", { prompt: "x".repeat(4001) }],
    ["prompt", { prompt: "has\u0000nul" }],
  ])("rejects malformed %s without storing anything", (field, override) => {
    const s = store();
    expect(createRunFromEvent(s, newRun(override))).toEqual({ status: "invalid", field });
    expect(count(s, "runs")).toBe(0);
    expect(count(s, "inbound_events")).toBe(0);
  });

  it("rejects non-string input at runtime", () => {
    const s = store();
    expect(createRunFromEvent(s, newRun({ teamId: { toString: () => "T0AAAAAAA" } as never })).status).toBe("invalid");
  });
});

describe("transactions", () => {
  it("leaves no run when the inbound event insert fails mid-transaction", () => {
    const s = store();
    s.db.exec("CREATE TRIGGER boom BEFORE INSERT ON inbound_events BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => createRunFromEvent(s, newRun())).toThrow(/boom/);
    expect(count(s, "runs")).toBe(0);
    expect(count(s, "inbound_events")).toBe(0);
    expect(count(s, "run_events")).toBe(0);
  });

  it("leaves no run or event when the audit-event insert fails mid-transaction", () => {
    const s = store();
    s.db.exec("CREATE TRIGGER boom BEFORE INSERT ON run_events BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => createRunFromEvent(s, newRun())).toThrow(/boom/);
    expect(count(s, "runs")).toBe(0);
    expect(count(s, "inbound_events")).toBe(0);
    // The connection is still usable and the event is not poisoned as "seen".
    s.db.exec("DROP TRIGGER boom");
    expect(createRunFromEvent(s, newRun()).status).toBe("created");
  });

  it("rolls back the state change when a transition's audit insert fails", () => {
    const s = store();
    createRunFromEvent(s, newRun());
    s.db.exec("CREATE TRIGGER boom BEFORE INSERT ON run_events WHEN NEW.type = 'transition' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => transitionRun(s, BINDING, "received", "validated")).toThrow(/boom/);
    expect(getRun(s, BINDING)?.state).toBe("received");
  });

  it("rejects a bad clock without writing", () => {
    const s = open(tempDbPath(), { now: () => Number.NaN });
    expect(() => createRunFromEvent(s, newRun())).toThrow();
    expect(count(s, "runs")).toBe(0);
  });
});

const MISMATCHES: [string, Partial<Binding>][] = [
  ["team", { teamId: "T0BBBBBBB" }],
  ["user", { userId: "U0BBBBBBB" }],
  ["channel", { channelId: "C0BBBBBBB" }],
  ["root thread", { rootThreadTs: "1700000099.000100" }],
];

describe("binding enforcement (cross-thread / cross-user rejection)", () => {
  it.each(MISMATCHES)("a %s mismatch cannot read, transition, or approve, and changes nothing", (_name, override) => {
    const s = store();
    const created = createRunFromEvent(s, newRun());
    const runId = created.status === "created" ? created.run.id : "";
    // A second, unrelated run sits at the mismatched coordinates for the cases where it could match.
    const wrong: Binding = { ...BINDING, ...override };

    expect(getRun(s, wrong)).toBeNull();
    expect(transitionRun(s, wrong, "received", "validated")).toEqual({ ok: false, error: "not_found" });
    expect(transitionRun(s, wrong, "received", "cancelled")).toEqual({ ok: false, error: "not_found" });
    expect(recordApproval(s, wrong, runId)).toEqual({ ok: false, error: "not_found" });
    expect(listRunEvents(s, wrong)).toEqual([]);

    const run = getRun(s, BINDING);
    expect(run?.state).toBe("received");
    expect(count(s, "approvals")).toBe(0);
    expect(count(s, "outbox_messages")).toBe(0);
    expect(count(s, "run_events")).toBe(1);
  });

  it("returns the same answer for a mismatch as for a run that does not exist (no information leak)", () => {
    const s = store();
    createRunFromEvent(s, newRun());
    const mismatch = transitionRun(s, { ...BINDING, userId: "U0BBBBBBB" }, "received", "validated");
    const absent = transitionRun(s, { ...BINDING, rootThreadTs: "1700000099.000100", userId: "U0BBBBBBB" }, "received", "validated");
    expect(mismatch).toEqual(absent);
  });

  it("does not let a run in another thread be used to approve this one", () => {
    const s = store();
    const a = createRunFromEvent(s, newRun());
    const other = { ...BINDING, rootThreadTs: "1700000050.000100" };
    const b = createRunFromEvent(s, newRun({ eventId: "Ev0AAAAAAA2", messageTs: other.rootThreadTs, rootThreadTs: other.rootThreadTs }));
    expect(a.status === "created" && b.status === "created").toBe(true);
    if (a.status !== "created" || b.status !== "created") return;
    expect(recordApproval(s, BINDING, b.run.id)).toEqual({ ok: false, error: "not_found" });
    expect(count(s, "approvals")).toBe(0);
  });

  it("rejects malformed bindings as invalid input", () => {
    const s = store();
    createRunFromEvent(s, newRun());
    expect(transitionRun(s, { ...BINDING, teamId: "x" }, "received", "validated")).toEqual({ ok: false, error: "invalid_input" });
    expect(getRun(s, { ...BINDING, channelId: "%" })).toBeNull();
  });
});

describe("immutable columns and append-only tables", () => {
  it.each([
    ["team_id", "T0BBBBBBB"],
    ["user_id", "U0BBBBBBB"],
    ["channel_id", "C0BBBBBBB"],
    ["root_thread_ts", "1700000099.000100"],
    ["id", "run-hacked"],
    ["prompt", "changed"],
    ["provider", "codex"],
    ["profile", "deep"],
    ["created_at", 1],
  ])("rejects an UPDATE to runs.%s", (column, value) => {
    const s = store();
    createRunFromEvent(s, newRun());
    expect(() => s.db.prepare(`UPDATE runs SET ${column} = ?`).run(value)).toThrow(/immutable/);
    expect(getRun(s, BINDING)).toMatchObject(BINDING);
  });

  it("rejects an UPDATE of a bound column even to its current value", () => {
    const s = store();
    createRunFromEvent(s, newRun());
    expect(() => s.db.prepare("UPDATE runs SET team_id = team_id").run()).toThrow(/immutable/);
  });

  it("rejects deleting a run, which would free its thread and event keys", () => {
    const s = store();
    createRunFromEvent(s, newRun());
    expect(() => s.db.exec("DELETE FROM runs")).toThrow(/cannot be deleted/);
  });

  it.each(["run_events", "inbound_events"])("%s is append-only", (table) => {
    const s = store();
    createRunFromEvent(s, newRun());
    expect(() => s.db.exec(`UPDATE ${table} SET run_id = run_id`)).toThrow(/append-only/);
    expect(() => s.db.exec(`DELETE FROM ${table}`)).toThrow(/append-only/);
    expect(count(s, table)).toBe(1);
  });

  it("run events cannot be rewritten after a transition either", () => {
    const s = store();
    createRunFromEvent(s, newRun());
    transitionRun(s, BINDING, "received", "validated");
    expect(() => s.db.exec("UPDATE run_events SET to_state = 'completed'")).toThrow(/append-only/);
    expect(() => s.db.exec("DELETE FROM run_events WHERE id = 1")).toThrow(/append-only/);
  });

  it("the database refuses to leave a terminal state even if code is bypassed", () => {
    const s = store();
    createRunFromEvent(s, newRun());
    transitionRun(s, BINDING, "received", "cancelled");
    expect(() => s.db.exec("UPDATE runs SET state = 'running'")).toThrow(/terminal/);
  });

  it("the database rejects unknown states", () => {
    const s = store();
    createRunFromEvent(s, newRun());
    expect(() => s.db.exec("UPDATE runs SET state = 'bogus'")).toThrow();
  });
});

describe("state transitions", () => {
  it("walks the legal path and records one event per step", () => {
    const s = store();
    createRunFromEvent(s, newRun());
    const path: RunState[] = ["validated", "queued", "running", "completed"];
    let from: RunState = "received";
    for (const to of path) {
      const result = transitionRun(s, BINDING, from, to);
      expect(result.ok && result.run.state).toBe(to);
      from = to;
    }
    expect(listRunEvents(s, BINDING).map((e) => [e.type, e.fromState, e.toState])).toEqual([
      ["created", null, "received"],
      ["transition", "received", "validated"],
      ["transition", "validated", "queued"],
      ["transition", "queued", "running"],
      ["transition", "running", "completed"],
    ]);
  });

  it("rejects every illegal transition and leaves the run unchanged", () => {
    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        // Build a fresh run for each pair and drive it to `from` via legal moves only.
        const s = store();
        createRunFromEvent(s, newRun());
        const route: Record<RunState, RunState[]> = {
          received: [],
          validated: ["validated"],
          queued: ["validated", "queued"],
          running: ["validated", "queued", "running"],
          awaiting_approval: ["validated", "queued", "running", "awaiting_approval"],
          queued_write: ["validated", "queued", "running", "awaiting_approval", "queued_write"],
          running_write: ["validated", "queued", "running", "awaiting_approval", "queued_write", "running_write"],
          completed: ["validated", "queued", "running", "completed"],
          cancelled: ["cancelled"],
          failed: ["failed"],
        };
        let cur: RunState = "received";
        for (const step of route[from]) {
          expect(transitionRun(s, BINDING, cur, step).ok).toBe(true);
          cur = step;
        }
        const before = getRun(s, BINDING);
        const events = count(s, "run_events");
        const result = transitionRun(s, BINDING, from, to);
        if (!result.ok) {
          expect(result.error).toBe("illegal_transition");
          expect(getRun(s, BINDING)).toEqual(before);
          expect(count(s, "run_events")).toBe(events);
        }
        s.close();
      }
    }
  });

  it("rejects a stale expected state (compare-and-swap) and leaves the run unchanged", () => {
    const s = store();
    createRunFromEvent(s, newRun());
    transitionRun(s, BINDING, "received", "validated");
    transitionRun(s, BINDING, "validated", "queued");
    // A racing caller still believes the run is 'received'; its legal-looking move must not apply.
    expect(transitionRun(s, BINDING, "received", "validated")).toEqual({ ok: false, error: "stale_state" });
    // A racing caller that thinks it is 'validated' cannot skip ahead to 'running' either.
    expect(transitionRun(s, BINDING, "validated", "queued")).toEqual({ ok: false, error: "stale_state" });
    expect(getRun(s, BINDING)?.state).toBe("queued");
    expect(count(s, "run_events")).toBe(3);
  });

  it("cannot skip the approval gate", () => {
    const s = store();
    createRunFromEvent(s, newRun());
    for (const [from, to] of [["received", "validated"], ["validated", "queued"], ["queued", "running"]] as const) transitionRun(s, BINDING, from, to);
    expect(transitionRun(s, BINDING, "running", "queued_write")).toEqual({ ok: false, error: "illegal_transition" });
    expect(transitionRun(s, BINDING, "running", "running_write")).toEqual({ ok: false, error: "illegal_transition" });
    expect(getRun(s, BINDING)?.state).toBe("running");
  });

  it("rejects unknown state names", () => {
    const s = store();
    createRunFromEvent(s, newRun());
    expect(transitionRun(s, BINDING, "received", "bogus" as never)).toEqual({ ok: false, error: "invalid_input" });
  });

  it("terminal states are final", () => {
    const s = store();
    createRunFromEvent(s, newRun());
    transitionRun(s, BINDING, "received", "failed");
    expect(transitionRun(s, BINDING, "failed", "queued")).toEqual({ ok: false, error: "illegal_transition" });
  });
});

describe("approvals table", () => {
  it("records one approval with the approving user and the state at approval time", () => {
    const s = store();
    const created = createRunFromEvent(s, newRun());
    if (created.status !== "created") throw new Error("setup");
    toAwaitingApproval(s);
    const result = recordApproval(s, BINDING, created.run.id);
    expect(result).toMatchObject({ ok: true, approval: { runId: created.run.id, approvedByUserId: BINDING.userId, runState: "awaiting_approval" } });
    expect(getApproval(s, BINDING)).toMatchObject({ runId: created.run.id, runState: "awaiting_approval" });
  });

  it("allows at most one approval per run", () => {
    const s = store();
    const created = createRunFromEvent(s, newRun());
    if (created.status !== "created") throw new Error("setup");
    toAwaitingApproval(s);
    expect(recordApproval(s, BINDING, created.run.id).ok).toBe(true);
    expect(recordApproval(s, BINDING, created.run.id)).toEqual({ ok: false, error: "already_approved" });
    expect(count(s, "approvals")).toBe(1);
    expect(() => s.db.exec("DELETE FROM approvals")).toThrow(/append-only/);
  });

  it.each([
    ["received", []],
    ["validated", ["validated"]],
    ["queued", ["validated", "queued"]],
    ["running", ["validated", "queued", "running"]],
    ["completed", ["validated", "queued", "running", "completed"]],
    ["cancelled", ["cancelled"]],
    ["failed", ["failed"]],
  ] as [RunState, RunState[]][])("refuses an approval while the run is %s, leaving no row and no event", (state, route) => {
    const s = store();
    const created = createRunFromEvent(s, newRun());
    if (created.status !== "created") throw new Error("setup");
    let cur: RunState = "received";
    for (const step of route) {
      expect(transitionRun(s, BINDING, cur, step).ok).toBe(true);
      cur = step;
    }
    const events = count(s, "run_events");
    expect(recordApproval(s, BINDING, created.run.id)).toEqual({ ok: false, error: "not_awaiting_approval" });
    expect(count(s, "approvals")).toBe(0);
    expect(count(s, "run_events")).toBe(events);
    expect(getRun(s, BINDING)?.state).toBe(state);
  });

  it("a premature approval attempt does not block the real one", () => {
    const s = store();
    const created = createRunFromEvent(s, newRun());
    if (created.status !== "created") throw new Error("setup");
    expect(recordApproval(s, BINDING, created.run.id).ok).toBe(false);
    toAwaitingApproval(s);
    expect(recordApproval(s, BINDING, created.run.id).ok).toBe(true);
  });

  it("recording an approval does not change the run state (no approval logic here)", () => {
    const s = store();
    const created = createRunFromEvent(s, newRun());
    if (created.status !== "created") throw new Error("setup");
    toAwaitingApproval(s);
    recordApproval(s, BINDING, created.run.id);
    expect(getRun(s, BINDING)?.state).toBe("awaiting_approval");
  });

  it("rejects a malformed run ID", () => {
    const s = store();
    createRunFromEvent(s, newRun());
    expect(recordApproval(s, BINDING, "yes")).toEqual({ ok: false, error: "invalid_input" });
  });
});

describe("prompt handling", () => {
  it("stores the prompt once, on the run, and nowhere else", () => {
    const s = store();
    const created = createRunFromEvent(s, newRun());
    if (created.status !== "created") throw new Error("setup");
    toAwaitingApproval(s);
    recordApproval(s, BINDING, created.run.id);
    transitionRun(s, BINDING, "awaiting_approval", "cancelled");

    const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    for (const { name } of tables) {
      const rows = JSON.stringify(s.db.prepare(`SELECT * FROM ${String(name)}`).all());
      expect(rows.includes(SECRET_PROMPT), String(name)).toBe(name === "runs");
    }
  });
});
