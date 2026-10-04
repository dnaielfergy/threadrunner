import { buildCodexInvocation, buildCodexWriteInvocation } from "../runner/argv.js";
import { createGit } from "../runner/git.js";
import { loadRunnerConfig } from "../runner/config.js";
import { readHeadCommit } from "../runner/head.js";
import type { Launcher } from "../runner/process.js";
import { createRunner } from "../runner/runner.js";
import { openStore, StoreError, type Store } from "../store/index.js";
import { loadConfig, type ConfigError } from "./config.js";
import type { EnvCheckResult, EnvFileCode } from "./env-check.js";
import { createEnvelopeHandler } from "./ingress.js";
import type { Logger } from "./log.js";
import { createSender } from "./sender.js";
import type { SlackApi, SocketTransport } from "./transport.js";

export interface AppDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: Logger;
  readonly now?: () => number;
  readonly randomId?: () => string;
  /** Build the Slack connections from validated tokens. Production passes the SDK adapters. */
  readonly connect: (tokens: { botToken: string; appToken: string }) => { api: SlackApi; transport: SocketTransport };
  readonly senderIntervalMs?: number;
  /** Starts provider processes. Production passes the real launcher; tests pass a fake that starts nothing. */
  readonly launcher: Launcher;
  readonly runnerIntervalMs?: number;
  /** Checks the `.env` file's permissions. Required so startup order can be tested; production passes `createEnvFileCheck()`. */
  readonly checkEnvFile: () => EnvCheckResult;
}

export type StartupFailure =
  | { readonly code: "env_file"; readonly reason: EnvFileCode; readonly path: string }
  | { readonly code: "config"; readonly errors: readonly ConfigError[] }
  | { readonly code: "store" | "slack_identity" | "workspace_mismatch" | "connect" };

export type StartResult =
  | { readonly ok: true; readonly stop: () => Promise<void>; readonly store: Store }
  | { readonly ok: false; readonly failure: StartupFailure };

/**
 * Compose the bridge. Fails closed, in order, with a code and no detail: bad config, an unusable
 * database, a bot token that belongs to a different workspace than ALLOWED_TEAM_ID, or a failed
 * connection. Nothing is listening for events until every check has passed.
 */
export async function startBridge(deps: AppDeps): Promise<StartResult> {
  // First, before the config is acted on: a `.env` other users can read has already exposed the tokens.
  const envCheck = deps.checkEnvFile();
  if (!envCheck.ok) return { ok: false, failure: { code: "env_file", reason: envCheck.code, path: envCheck.path } };

  const loaded = loadConfig(deps.env);
  if (!loaded.ok) return { ok: false, failure: { code: "config", errors: loaded.errors } };
  const { config } = loaded;

  // The runner is configured before anything is opened or connected, and fails closed the same way.
  const runnerLoaded = loadRunnerConfig(deps.env, { databasePath: config.databasePath, allowedChannelIds: config.auth.channelIds });
  if (!runnerLoaded.ok) return { ok: false, failure: { code: "config", errors: runnerLoaded.errors } };
  const runnerConfig = runnerLoaded.config;

  let store: Store;
  try {
    store = openStore({
      path: config.databasePath,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.randomId ? { randomId: deps.randomId } : {}),
    });
  } catch (error) {
    // StoreError messages are written to be safe (no row data); anything else is reported as a bare code.
    if (error instanceof StoreError) deps.log({ level: "error", code: `store:${error.code}` });
    return { ok: false, failure: { code: "store" } };
  }

  const fail = (failure: StartupFailure): StartResult => {
    store.close();
    return { ok: false, failure };
  };

  const { api, transport } = deps.connect({ botToken: config.botToken, appToken: config.appToken });

  let identity;
  try {
    identity = await api.identify();
  } catch {
    return fail({ code: "slack_identity" });
  }
  if (identity.teamId !== config.auth.teamId) return fail({ code: "workspace_mismatch" });

  const now = deps.now ?? Date.now;
  const sender = createSender({ store, api, teamId: config.auth.teamId, log: deps.log, now });
  const pokeSender = (): void => {
    sender.drain().catch(() => deps.log({ level: "error", code: "drain_failed" }));
  };
  const runner = createRunner({
    store,
    auth: config.auth,
    repoRoot: runnerConfig.repoRoot,
    codexBin: runnerConfig.codexBin,
    timeoutMs: runnerConfig.timeoutMs,
    launcher: deps.launcher,
    buildInvocation: buildCodexInvocation,
    log: deps.log,
    parentEnv: deps.env,
    onEnqueued: pokeSender,
    ...(runnerConfig.edit
      ? {
          approvalTtlMs: runnerConfig.edit.approvalTtlMs,
          edit: {
            git: createGit({ launcher: deps.launcher, gitBin: runnerConfig.edit.gitBin, cwd: runnerConfig.edit.worktreeRoot }),
            worktreeRoot: runnerConfig.edit.worktreeRoot,
            maxRetained: runnerConfig.edit.maxRetained,
            timeoutMs: runnerConfig.edit.editTimeoutMs,
            channelIds: runnerConfig.edit.channelIds,
            buildInvocation: buildCodexWriteInvocation,
          },
        }
      : {}),
  });
  const pokeRunner = (): void => {
    runner.tick().catch(() => deps.log({ level: "error", code: "runner_tick_failed" }));
  };
  // Runs a previous process left in `running` are failed, never re-executed, before anything new can start.
  runner.recoverStale();
  const handler = createEnvelopeHandler({
    store,
    auth: config.auth,
    botUserId: identity.botUserId,
    log: deps.log,
    onEnqueued: () => {
      pokeSender();
      pokeRunner();
    },
    ...(runnerConfig.edit ? { edit: { config: runnerConfig.edit, repoRoot: runnerConfig.repoRoot, readBaseSha: readHeadCommit } } : {}),
  });

  try {
    await transport.start(handler);
  } catch {
    return fail({ code: "connect" });
  }
  sender.start(deps.senderIntervalMs ?? 2000);
  runner.start(deps.runnerIntervalMs ?? 2000);
  pokeRunner();

  return {
    ok: true,
    store,
    // Order matters. Stop new envelopes first. Then let the message being posted finish and be
    // marked sent, and stop sending: a run killed below leaves its failure notice pending in the
    // outbox, delivered at the next start, so shutdown never posts a second message. Then kill the
    // running child and record its failure. Only then close the store: closing earlier would lose
    // the `markSent` and re-post, or lose the failure.
    stop: async () => {
      try {
        await transport.stop();
      } finally {
        try {
          await sender.stop();
        } finally {
          try {
            await runner.stop();
          } finally {
            store.close();
          }
        }
      }
    },
  };
}
