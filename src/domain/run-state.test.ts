import { describe, expect, it } from "vitest";
import { RUN_STATES, canTransition, isTerminal, legalTransitions, transition, type RunState } from "./run-state.js";

const LEGAL: [RunState, RunState][] = [
  ["received", "validated"],
  ["validated", "queued"],
  ["queued", "running"],
  ["running", "completed"],
  ["running", "awaiting_approval"],
  ["awaiting_approval", "queued_write"],
  ["queued_write", "running_write"],
  ["running_write", "completed"],
];
const CANCELLABLE: RunState[] = ["received", "validated", "queued", "running", "awaiting_approval", "queued_write", "running_write"];
const TERMINAL: RunState[] = ["completed", "cancelled", "failed"];

describe("run-state transitions", () => {
  it.each(LEGAL)("allows %s -> %s", (from, to) => {
    expect(transition(from, to)).toEqual({ ok: true, state: to });
  });

  it.each(CANCELLABLE)("allows %s -> cancelled and failed", (from) => {
    expect(canTransition(from, "cancelled")).toBe(true);
    expect(canTransition(from, "failed")).toBe(true);
  });

  it.each(TERMINAL)("%s is terminal with no outgoing transitions", (from) => {
    expect(isTerminal(from)).toBe(true);
    expect(legalTransitions(from)).toEqual([]);
  });

  it("rejects every transition not explicitly listed", () => {
    const allowed = new Set<string>([
      ...LEGAL.map(([a, b]) => `${a}>${b}`),
      ...CANCELLABLE.flatMap((s) => [`${s}>cancelled`, `${s}>failed`]),
    ]);
    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it("cannot reach a write state without approval", () => {
    expect(canTransition("running", "queued_write")).toBe(false);
    expect(canTransition("queued", "running_write")).toBe(false);
    expect(canTransition("awaiting_approval", "running_write")).toBe(false);
    expect(canTransition("awaiting_approval", "completed")).toBe(false);
  });

  it("returns an error result instead of throwing", () => {
    expect(transition("completed", "running")).toEqual({ ok: false, error: "illegal transition: completed -> running" });
  });
});
