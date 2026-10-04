/**
 * Run lifecycle, mirroring docs/security-architecture.md:
 *
 *   received → validated → queued → running → completed
 *                  │
 *                  └→ awaiting_approval → queued_write → running_write → completed
 *
 * `cancelled` and `failed` are reachable from every non-terminal state.
 *
 * `validated → awaiting_approval` is for edit-mode tasks only. This pure module knows only states;
 * the mode rules are enforced by the store and by database triggers. `running → awaiting_approval`
 * is kept for a possible future plan mode.
 */
export const RUN_STATES = [
  "received",
  "validated",
  "queued",
  "running",
  "awaiting_approval",
  "queued_write",
  "running_write",
  "completed",
  "cancelled",
  "failed",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_STATES: readonly RunState[] = ["completed", "cancelled", "failed"];

const FORWARD: Readonly<Record<RunState, readonly RunState[]>> = {
  received: ["validated"],
  validated: ["queued", "awaiting_approval"],
  queued: ["running"],
  running: ["completed", "awaiting_approval"],
  awaiting_approval: ["queued_write"],
  queued_write: ["running_write"],
  running_write: ["completed"],
  completed: [],
  cancelled: [],
  failed: [],
};

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Every legal next state for `from`, including cancellation and failure. */
export function legalTransitions(from: RunState): readonly RunState[] {
  if (isTerminal(from)) return [];
  return [...FORWARD[from], "cancelled", "failed"];
}

export function canTransition(from: RunState, to: RunState): boolean {
  return legalTransitions(from).includes(to);
}

export type TransitionResult =
  | { readonly ok: true; readonly state: RunState }
  | { readonly ok: false; readonly error: string };

/** Pure transition: returns the new state, or an error. Never throws, never mutates. */
export function transition(from: RunState, to: RunState): TransitionResult {
  if (canTransition(from, to)) return { ok: true, state: to };
  return { ok: false, error: `illegal transition: ${from} -> ${to}` };
}
