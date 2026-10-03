import { describe, expect, it } from "vitest";
import { createRunFromEvent, getRun, listPendingMessages, listRunEvents, transitionRun, type Binding } from "../store/index.js";
import { BINDING, fakeClock, fakeIds, newRun, open, tempDbPath } from "../store/test-utils.js";
import { applyCancel, applyStatus } from "./control.js";

function setup() {
  const store = open(tempDbPath(), { now: fakeClock(), randomId: fakeIds() });
  const created = createRunFromEvent(store, newRun());
  if (created.status !== "created") throw new Error("setup");
  for (const [from, to] of [["received", "validated"], ["validated", "queued"]] as const) transitionRun(store, BINDING, from, to);
  return { store, runId: created.run.id };
}

const mismatches: [string, Binding][] = [
  ["team", { ...BINDING, teamId: "T0ZZZZZZZ" }],
  ["user", { ...BINDING, userId: "U0ZZZZZZZ" }],
  ["channel", { ...BINDING, channelId: "C0ZZZZZZZ" }],
  ["root thread", { ...BINDING, rootThreadTs: "1700000099.000100" }],
];

describe.each(mismatches)("binding mismatch on %s", (_field, binding) => {
  it("/status is a quiet no-op: no reply is queued", () => {
    const { store } = setup();
    expect(applyStatus(store, binding)).toBe("status_no_run");
    expect(listPendingMessages(store)).toEqual([]);
  });

  it("/cancel is a quiet no-op: the run is untouched and nothing is queued", () => {
    const { store } = setup();
    const before = listRunEvents(store, BINDING).length;
    expect(applyCancel(store, binding)).toBe("cancel_no_run");
    expect(getRun(store, BINDING)?.state).toBe("queued");
    expect(listRunEvents(store, BINDING)).toHaveLength(before);
    expect(listPendingMessages(store)).toEqual([]);
  });
});

describe("matching binding", () => {
  it("/status replies with the run ID and state only, to the stored thread", () => {
    const { store, runId } = setup();
    expect(applyStatus(store, BINDING)).toBe("status_replied");
    const [message] = listPendingMessages(store);
    expect(message?.body).toBe(`Run ${runId} is queued.`);
    expect(message?.destination).toEqual({ teamId: BINDING.teamId, channelId: BINDING.channelId, threadTs: BINDING.rootThreadTs });
  });

  it("/cancel cancels the run and the store queues exactly one acknowledgement", () => {
    const { store } = setup();
    expect(applyCancel(store, BINDING)).toBe("cancelled");
    expect(getRun(store, BINDING)?.state).toBe("cancelled");
    expect(listPendingMessages(store).map((m) => m.kind)).toEqual(["cancel_ack"]);
  });

  it("a retried /cancel is a quiet no-op: no second acknowledgement", () => {
    const { store } = setup();
    applyCancel(store, BINDING);
    expect(applyCancel(store, BINDING)).toBe("cancel_noop:illegal_transition");
    expect(listPendingMessages(store)).toHaveLength(1);
    expect(listRunEvents(store, BINDING).filter((e) => e.toState === "cancelled")).toHaveLength(1);
  });

  it("/status on a cancelled run is quiet (the store refuses new messages for it)", () => {
    const { store } = setup();
    applyCancel(store, BINDING);
    expect(applyStatus(store, BINDING)).toBe("status_noop:run_cancelled");
    expect(listPendingMessages(store)).toHaveLength(1);
  });

  it("malformed binding fields are a no-op, not an error", () => {
    const { store } = setup();
    expect(applyCancel(store, { ...BINDING, userId: "alice" })).toBe("cancel_no_run");
    expect(applyStatus(store, { ...BINDING, rootThreadTs: "" })).toBe("status_no_run");
  });
});
