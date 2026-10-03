import { PROVIDERS, MODEL_PROFILES } from "../domain/types.js";
import { RUN_STATES, TERMINAL_STATES } from "../domain/run-state.js";
import { MAX_OUTBOX_BODY_LENGTH } from "./validate.js";

export const MAX_OUTBOX_ATTEMPTS = 5;
/** A cancellation acknowledgement is the user's only signal that /cancel worked, so it gets more tries. */
export const MAX_CANCEL_ACK_ATTEMPTS = 20;

const list = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");

/**
 * Forward-only migrations. Entry `i` upgrades the database from version `i` to `i + 1`
 * and is applied inside a transaction together with the `PRAGMA user_version` bump.
 * Never edit a shipped migration; append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE runs (
    id              TEXT PRIMARY KEY CHECK (id GLOB 'run-*'),
    team_id         TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    channel_id      TEXT NOT NULL,
    root_thread_ts  TEXT NOT NULL,
    provider        TEXT NOT NULL CHECK (provider IN (${list(PROVIDERS)})),
    profile         TEXT NOT NULL CHECK (profile IN (${list(MODEL_PROFILES)})),
    prompt          TEXT NOT NULL,
    state           TEXT NOT NULL CHECK (state IN (${list(RUN_STATES)})),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    UNIQUE (team_id, channel_id, root_thread_ts)
  ) STRICT;

  CREATE TABLE inbound_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id     TEXT NOT NULL,
    event_id    TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    message_ts  TEXT NOT NULL,
    -- NULL only for an event that was rejected and therefore created no run.
    run_id      TEXT REFERENCES runs (id),
    outcome     TEXT NOT NULL CHECK (outcome IN ('created', 'rejected_thread_has_run')),
    received_at INTEGER NOT NULL,
    CHECK ((outcome = 'created') = (run_id IS NOT NULL)),
    UNIQUE (team_id, event_id),
    UNIQUE (team_id, channel_id, message_ts)
  ) STRICT;

  CREATE TABLE run_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL REFERENCES runs (id),
    type       TEXT NOT NULL CHECK (type IN ('created', 'transition', 'approval_recorded')),
    from_state TEXT CHECK (from_state IN (${list(RUN_STATES)})),
    to_state   TEXT CHECK (to_state IN (${list(RUN_STATES)})),
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE approvals (
    run_id               TEXT PRIMARY KEY REFERENCES runs (id),
    approved_by_user_id  TEXT NOT NULL,
    run_state            TEXT NOT NULL CHECK (run_state IN (${list(RUN_STATES)})),
    approved_at          INTEGER NOT NULL
  ) STRICT;

  -- No destination columns by design: the destination is always read from the run binding.
  CREATE TABLE outbox_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL REFERENCES runs (id),
    kind       TEXT NOT NULL CHECK (kind IN ('message', 'cancel_ack')),
    body       TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND ${MAX_OUTBOX_BODY_LENGTH}),
    status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND ${MAX_CANCEL_ACK_ATTEMPTS}),
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    sent_at    INTEGER
  ) STRICT;

  CREATE INDEX outbox_pending ON outbox_messages (status, id);
  CREATE UNIQUE INDEX outbox_one_cancel_ack ON outbox_messages (run_id) WHERE kind = 'cancel_ack';

  -- Binding and task columns can never change after creation (even to the same value).
  CREATE TRIGGER runs_immutable_columns
  BEFORE UPDATE OF id, team_id, user_id, channel_id, root_thread_ts, provider, profile, prompt, created_at ON runs
  BEGIN SELECT RAISE(ABORT, 'run binding and task columns are immutable'); END;

  CREATE TRIGGER runs_terminal_state_final
  BEFORE UPDATE OF state ON runs
  WHEN OLD.state IN (${list(TERMINAL_STATES)})
  BEGIN SELECT RAISE(ABORT, 'run is in a terminal state'); END;

  CREATE TRIGGER runs_no_delete BEFORE DELETE ON runs
  BEGIN SELECT RAISE(ABORT, 'runs cannot be deleted'); END;

  CREATE TRIGGER inbound_events_no_update BEFORE UPDATE ON inbound_events
  BEGIN SELECT RAISE(ABORT, 'inbound_events is append-only'); END;
  CREATE TRIGGER inbound_events_no_delete BEFORE DELETE ON inbound_events
  BEGIN SELECT RAISE(ABORT, 'inbound_events is append-only'); END;

  CREATE TRIGGER run_events_no_update BEFORE UPDATE ON run_events
  BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;
  CREATE TRIGGER run_events_no_delete BEFORE DELETE ON run_events
  BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;

  CREATE TRIGGER approvals_no_update BEFORE UPDATE ON approvals
  BEGIN SELECT RAISE(ABORT, 'approvals is append-only'); END;
  CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
  BEGIN SELECT RAISE(ABORT, 'approvals is append-only'); END;

  CREATE TRIGGER outbox_immutable_columns
  BEFORE UPDATE OF id, run_id, kind, body, created_at ON outbox_messages
  BEGIN SELECT RAISE(ABORT, 'outbox message content is immutable'); END;
  CREATE TRIGGER outbox_no_delete BEFORE DELETE ON outbox_messages
  BEGIN SELECT RAISE(ABORT, 'outbox_messages cannot be deleted'); END;

  -- Invariant 8, enforced in the database as well as in code.
  CREATE TRIGGER outbox_refuse_after_cancel
  BEFORE INSERT ON outbox_messages
  WHEN NEW.kind <> 'cancel_ack' AND (SELECT state FROM runs WHERE id = NEW.run_id) = 'cancelled'
  BEGIN SELECT RAISE(ABORT, 'run is cancelled'); END;

  CREATE TRIGGER outbox_ack_requires_cancel
  BEFORE INSERT ON outbox_messages
  WHEN NEW.kind = 'cancel_ack' AND (SELECT state FROM runs WHERE id = NEW.run_id) IS NOT 'cancelled'
  BEGIN SELECT RAISE(ABORT, 'cancel acknowledgement requires a cancelled run'); END;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
