import type { ModelProfile } from "../domain/types.js";
import type { AuthConfig } from "../slack/config.js";
import type { Logger } from "../slack/log.js";
import { enqueueMessageParts, getRun, listRunsByState, transitionRun, type Run, type Store } from "../store/index.js";
import { buildChildEnv } from "./env.js";
import { CANCEL_POLL_MS, MAX_OUTPUT_BYTES } from "./limits.js";
import { completionBody, failureBody, type FailureReason } from "./messages.js";
import type { Launcher, LaunchSpec } from "./process.js";
import { repoRootStillValid } from "./repo-root.js";
import { supervise, type Outcome } from "./supervise.js";

/** What the provider-specific module decides: the arguments and what goes to standard input. */
export interface Invocation {
  readonly args: readonly string[];
  readonly stdin: string;
}
export type BuildInvocation = (input: { readonly prompt: string; readonly profile: ModelProfile; readonly repoRoot: string }) => Invocation;

export interface RunnerDeps {
  readonly store: Store;
  /** The same allowlist ingress used. A stored run is re-checked against it before anything starts. */
  readonly auth: AuthConfig;
  readonly repoRoot: string;
  readonly codexBin: string;
  readonly timeoutMs: number;
  readonly launcher: Launcher;
  readonly buildInvocation: BuildInvocation;
  readonly log: Logger;
  /** The bridge's own environment. Only an allowlisted subset ever reaches a child. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** Called after something was added to the outbox, so the sender can run promptly. */
  readonly onEnqueued?: () => void;
  readonly maxOutputBytes?: number;
  readonly pollMs?: number;
}

export type TickResult = "idle" | "busy" | "stopped" | "ran";

export interface Runner {
  /** Process queued runs, one at a time. A call while a pass is running returns "busy" and starts nothing. */
  tick(): Promise<TickResult>;
  /**
   * Fail every run left in `running` by a previous process, with a fixed reason. They are never
   * re-executed: a half-finished provider run cannot be resumed safely. Call once, before the first tick.
   */
  recoverStale(): number;
  start(intervalMs: number): void;
  /** Kill the running child (if any), fail its run, and wait for it. Later ticks do nothing. */
  stop(): Promise<void>;
}

/**
 * Single-slot worker for read-only Codex runs.
 *
 * Every state change goes through `transitionRun` with the state the runner believes the run is in,
 * so a run that was cancelled (or anything else) in the meantime is never overwritten, and a run
 * that is not `queued` is never started. Authorization is not re-decided here, but a stored run
 * whose binding is not on the configured allowlist is failed without starting anything and without
 * sending any message.
 *
 * Output ordering: the result is queued in the outbox first and the state moved second. If a cancel
 * lands between the two, the store has already failed the pending result and queued the single
 * cancellation acknowledgement, so nothing else is sent (invariant 8).
 *
 * Logs carry fixed codes and run IDs only. The prompt, the child's output and any error text are
 * never logged, and run events record states only.
 */
export function createRunner(deps: RunnerDeps): Runner {
  const { store, log } = deps;
  const maxOutputBytes = deps.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const pollMs = deps.pollMs ?? CANCEL_POLL_MS;
  const abort = new AbortController();
  let inFlight: Promise<TickResult> | null = null;
  /** True from the start of a pass until the instant it returns, with nothing awaited in between. */
  let busy = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const note = (code: string, runId?: string, level: "info" | "warn" | "error" = "info"): void => log({ level, code, runId });

  const authorized = (run: Run): boolean =>
    run.teamId === deps.auth.teamId && run.userId === deps.auth.userId && deps.auth.channelIds.has(run.channelId);

  /** Queue a message for the run's own bound thread. Returns false if the store refused (for example, cancelled). */
  const say = (run: Run, body: string): boolean => {
    const result = enqueueMessageParts(store, run.id, body);
    if (result.ok) deps.onEnqueued?.();
    return result.ok;
  };

  const fail = (run: Run, from: "queued" | "running", reason: FailureReason, partial = ""): void => {
    if (authorized(run)) {
      // A body the outbox cannot take is replaced by the fixed text alone, so a failure is always reported.
      if (!say(run, failureBody(run.id, reason, partial))) say(run, failureBody(run.id, reason));
    }
    const moved = transitionRun(store, run, from, "failed");
    note(moved.ok ? `run_failed:${reason}` : `run_fail_refused:${moved.error}`, run.id, moved.ok ? "info" : "warn");
  };

  const complete = (run: Run, output: string): void => {
    if (!say(run, completionBody(run.id, output)) && getRun(store, run)?.state === "running") {
      say(run, failureBody(run.id, "output_limit")); // delivery refused for a reason other than cancellation
    }
    const moved = transitionRun(store, run, "running", "completed");
    note(moved.ok ? "run_completed" : `run_complete_refused:${moved.error}`, run.id, moved.ok ? "info" : "warn");
  };

  const finish = (run: Run, outcome: Outcome): void => {
    switch (outcome.kind) {
      case "exited":
        if (outcome.exitCode === 0) complete(run, outcome.output);
        else fail(run, "running", "nonzero_exit", outcome.output);
        return;
      case "timeout":
        return fail(run, "running", "timeout", outcome.output);
      case "output_limit":
        return fail(run, "running", "output_limit", outcome.output);
      case "signalled":
        return fail(run, "running", "signalled", outcome.output);
      case "spawn_failed":
        return fail(run, "running", "spawn_failed");
      case "aborted":
        return fail(run, "running", "shutdown");
      case "cancelled":
        // The store already moved the run to `cancelled` and queued the one acknowledgement.
        note("run_killed_cancelled", run.id);
        return;
    }
  };

  async function execute(run: Run): Promise<void> {
    if (!authorized(run)) return fail(run, "queued", "not_authorized");
    if (run.provider !== "codex") return fail(run, "queued", "provider_unsupported");
    if (!repoRootStillValid(deps.repoRoot)) return fail(run, "queued", "repo_root_changed");

    let invocation: Invocation;
    try {
      invocation = deps.buildInvocation({ prompt: run.prompt, profile: run.profile, repoRoot: deps.repoRoot });
    } catch {
      return fail(run, "queued", "invocation_invalid");
    }

    const started = transitionRun(store, run, "queued", "running");
    if (!started.ok) {
      note(`run_start_refused:${started.error}`, run.id);
      return;
    }
    // A cancel recorded between the transition and the launch must win.
    if (getRun(store, run)?.state !== "running") {
      note("run_killed_cancelled", run.id);
      return;
    }
    note("run_started", run.id);

    const spec: LaunchSpec = {
      command: deps.codexBin,
      args: invocation.args,
      cwd: deps.repoRoot,
      env: buildChildEnv(deps.parentEnv),
      stdin: invocation.stdin,
    };
    const outcome = await supervise({
      launcher: deps.launcher,
      spec,
      timeoutMs: deps.timeoutMs,
      maxOutputBytes,
      pollMs,
      shouldCancel: () => getRun(store, run)?.state !== "running",
      signal: abort.signal,
    });
    finish(run, outcome);
  }

  async function pass(): Promise<TickResult> {
    let ran = false;
    // Each run is attempted at most once per pass, so one that stays queued cannot spin the loop.
    const attempted = new Set<string>();
    try {
      for (;;) {
        if (stopped) return ran ? "ran" : "stopped";
        const next = listRunsByState(store, "queued", 100).find((run) => !attempted.has(run.id));
        if (!next) return ran ? "ran" : "idle";
        attempted.add(next.id);
        try {
          await execute(next);
        } catch {
          note("runner_error", next.id, "error");
        }
        ran = true;
      }
    } finally {
      // Runs synchronously with the final "nothing queued" check above, so a tick requested at any
      // later moment starts a new pass instead of being told "busy" and lost.
      busy = false;
    }
  }

  return {
    tick: () => runPass(),

    recoverStale: () => {
      let recovered = 0;
      for (const run of listRunsByState(store, "running", 100)) {
        if (authorized(run)) say(run, failureBody(run.id, "restarted"));
        if (transitionRun(store, run, "running", "failed").ok) {
          recovered++;
          note("run_failed:restarted", run.id);
        }
      }
      return recovered;
    },

    start: (intervalMs) => {
      if (timer || stopped) return;
      timer = setInterval(() => {
        runPass().catch(() => note("runner_tick_failed", undefined, "error"));
      }, intervalMs);
      timer.unref();
    },

    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      abort.abort();
      await inFlight?.catch(() => {});
    },
  };

  function runPass(): Promise<TickResult> {
    if (stopped) return Promise.resolve("stopped");
    if (busy) return Promise.resolve("busy");
    busy = true;
    inFlight = pass();
    return inFlight;
  }
}
