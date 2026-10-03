import { openStore, StoreError, type Store } from "../store/index.js";
import { loadConfig, type ConfigError } from "./config.js";
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
}

export type StartupFailure =
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
  const loaded = loadConfig(deps.env);
  if (!loaded.ok) return { ok: false, failure: { code: "config", errors: loaded.errors } };
  const { config } = loaded;

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
  const handler = createEnvelopeHandler({
    store,
    auth: config.auth,
    botUserId: identity.botUserId,
    log: deps.log,
    onEnqueued: () => {
      sender.drain().catch(() => deps.log({ level: "error", code: "drain_failed" }));
    },
  });

  try {
    await transport.start(handler);
  } catch {
    return fail({ code: "connect" });
  }
  sender.start(deps.senderIntervalMs ?? 2000);

  return {
    ok: true,
    store,
    // Order matters: stop new envelopes first, then let the message being posted finish and be
    // marked sent, and only then close the store. Closing first would lose the `markSent` and re-post it.
    stop: async () => {
      try {
        await transport.stop();
      } finally {
        try {
          await sender.stop();
        } finally {
          store.close();
        }
      }
    },
  };
}
