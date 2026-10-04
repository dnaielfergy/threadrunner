# ThreadRunner

A local-first Slack bridge for Claude Code and Codex CLI.

Send a task from Slack. Run it on your own machine.
Every Slack thread becomes one explicit, auditable agent run.

## Why

Most Slack-to-agent tools optimize for autonomy. ThreadRunner optimizes for **intentionality** — the idea that agent convenience should not require ambient authority.

You already use Claude Code and Codex CLI locally. ThreadRunner lets you launch those same tools from Slack — your phone, another room, another device — without turning your laptop into an always-on remote shell that anyone in a workspace can poke.

## Design principles

- **Slack is a transport, not an authorization system.** Your local bridge decides what a Slack message can do.
- **Read-only by default.** Investigation and planning don't require write access.
- **Approvals are state transitions, not natural-language guesses.** A bare "yes" is never enough.
- **Writes happen in isolated Git worktrees**, never on your active branch.
- **One run per thread.** No persistent autonomous sessions, no ambient context bleed.
- **No public endpoints.** Slack Socket Mode keeps the local machine behind NAT/firewall.

## How it works

```
Slack Socket Mode
      │
      ▼
Authorization / Deduplication
      │
      ▼
SQLite Run Store
      │
      ▼
Router  (  /codex  ·  /claude  ·  /auto  )
      │
      ▼
Local Provider Runner
  Codex CLI  |  Claude Code
      │
      ▼
Git Worktree + Structured Events
      │
      ▼
Slack Thread Outbox
```

## Quick start

> **Status:** early development. The Slack intake (Socket Mode ingress, authorization, run queue, and thread replies) is implemented, and a **read-only Codex runner** executes `/codex` tasks in one configured repository. `/claude` and `/auto` are not connected yet: those runs are refused with a fixed reason. The runner starts a local process from a Slack message, so do not enable it until the live Slack smoke test (issue #22) is complete.

1. Create a private Slack workspace with only you as a member.
2. Create the Slack app as described in [Configuring the Slack app](#configuring-the-slack-app).
3. Copy `.env.example` to `.env` and set the Slack tokens and allowlist (see below). Startup refuses to proceed if anything is missing or malformed.
4. Build and start the bridge:

```bash
npm install
npm start   # builds to dist/, then runs dist/slack/main.js with .env loaded
```

5. DM the bot, or mention it in the allowlisted control channel:

```
/claude default investigate why invite acceptance fails after login
@ThreadRunner /codex fast list the failing tests
```

Usage: `/claude|/codex|/auto <fast|default|deep> <prompt>`. The model profile is required.

- **Silence means it did not parse.** Anything that is not exactly a command (a missing profile, a typo, plain chat) is ignored with no reply, by design, so a typo looks the same as an outage. Check the format first, then the bridge's stderr (it logs a `parse:<code>` reason, never your text).
- **The Slack client may intercept a leading `/` in a DM.** If it says the command is not valid, choose the **send as message** option it offers, or mention the bot first (`@ThreadRunner /claude default ...`), which works everywhere.

Then reply **in that thread** with `/status` or `/cancel`. `/approve run-<id>` is recognized but does nothing yet.

`/codex` tasks run read-only against the configured repository and the result is posted in the same thread (see [The Codex runner](#the-codex-runner)).

### Running it

Run the bridge under a supervisor (launchd, systemd) that restarts it on a non-zero exit. The bridge logs one JSON line per event on stderr, with fixed codes only:

- `socket_connected`, `socket_reconnecting`, `socket_disconnected`, `socket_error`: connection state. Wi-Fi drops and sleep/wake are retried by the Slack SDK. Missing `socket_connected` after start means the bridge is not receiving.
- `unhandled_rejection`, `uncaught_exception`: the bridge exits 1 so the supervisor restarts it.
- `send_deferred:network` / `send_deferred:rate_limited`: Slack was unreachable or busy. The reply stays queued and is retried (up to about 30 minutes of trouble, honoring `Retry-After`) without using up its attempts, including across a restart.
- `reject:<reason>`, `parse:<code>`: why an incoming event was dropped.

On SIGINT or SIGTERM it stops receiving, finishes the reply being posted, closes the database, and exits (non-zero if that fails, and forced within 20 seconds).

## The Codex runner

A `/codex <fast|default|deep> <prompt>` task is picked up from the queue and run by the Codex CLI on your machine, in **one** repository you configure. It is read-only, bounded, and cancellable.

### Configuration

Add these to `.env` (see `.env.example`). Startup refuses to proceed, naming the variable and never the value, if any of them is wrong.

| Variable | Meaning |
|---|---|
| `APPROVED_REPO_ROOTS` | **Exactly one** absolute directory. Resolved with `realpath` at startup. Refused: zero, several, relative or `~` paths, `..` segments, a path that does not exist or is not a directory, the filesystem root, your home directory itself, and any directory that contains the database file. It comes from here only, never from Slack text. |
| `CODEX_BIN` | Absolute path to the Codex CLI (`which codex`). Not looked up through `PATH`. Refused if it is inside the repository, which is untrusted content. |
| `RUNNER_TIMEOUT_SECONDS` | Optional. Wall-clock limit per run, 10 to 3600. Default 600. |
| `CODEX_FLAGS` | Must be empty. Extra provider flags are not configurable, so a bypass flag cannot be added here. |
| `RUNNER_CONCURRENCY`, `RUNNER_DEFAULT_MODE` | If set, only `1` and `read_only` are accepted. |

Codex signs in with your own ChatGPT login (`codex login`), stored under your home directory. No API key is read or passed.

### What it does

For each queued `/codex` run, one at a time, it runs (verified against `codex exec --help` for codex-cli 0.160.0):

```
codex exec --sandbox read-only --cd <repo> --ephemeral --ignore-user-config --ignore-rules --color never -
```

- **Read-only is enforced by Codex's own sandbox** (`--sandbox read-only`), not by the prompt.
- **The prompt goes on standard input** (the trailing `-`). It is never an argument and never reaches a shell.
- `--ephemeral` keeps the prompt out of Codex's session files. `--ignore-user-config` stops your `~/.codex/config.toml` (extra tool servers, a looser sandbox) from widening a run. `--ignore-rules` skips execution-policy rule files.
- The process starts with an **allowlisted environment** (`PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TMPDIR`). The Slack tokens, the database path and everything else in the bridge's environment are not inherited.
- It is stopped after the time limit, or when more than 28,000 bytes of output arrive (it is killed at the first byte over the cap and the partial output is posted with a fixed reason).
- **`/cancel` terminates the process and everything it started** (the whole process group). After a cancel is recorded, nothing else is posted for that run except the single acknowledgement.
- The result, or a failure with a **fixed reason**, is posted in the run's own thread through the outbox. Output is untrusted and is escaped by the sender. Standard error is discarded.
- Logs and run events carry fixed codes and run IDs only: never the prompt, the output, or error text.

### What it cannot do

No edits, commits, pushes, worktrees, approvals (`/approve` stays inert), other repositories, paths from Slack, Claude runs or `/auto` routing (refused with a fixed reason), more than one run at a time, or a different Slack destination than the run's own thread.

### Limits to know about

- **The child runs as your OS user.** ThreadRunner does not restrict what it can *read*; Codex's sandbox decides that. Use a dedicated OS user or a disposable environment if that matters (see SECURITY.md).
- Repository content is untrusted and can contain prompt injection. The sandbox limits what an injected prompt can *do*, not what it can say in the thread.
- A run left `running` by a crash or restart is **failed with a fixed reason and never re-executed**. Durable retry and full stale-run recovery are tracked in #8. The failure notice is delivered at the next start.
- The repository must be a Git repository (the runner does not pass `--skip-git-repo-check`).

## Roadmap

| Stage | Capability | Safety posture |
|---|---|---|
| v0.1 | Slack Socket Mode, one authorized user, bot DM, local Codex runner, final thread reply | Read-only task execution |
| v0.2 | Claude runner, `/auto`, SQLite run log, cancellation, deduplication | One active run, explicit provider selection |
| v0.3 | Approval-gated edits, disposable Git worktrees, diff/test summaries | No commits/pushes/deploys |
| v0.4 | Commit/PR actions with named confirmations, multiple repos | Per-repo locks and branch protections |
| v0.5 | Pluggable runners and portable deployment to Linux/WSL | Dedicated runner account/machine |
| Later | Optional schedules, web UI, richer artifact handling | Separate threat-model review per feature |

## Configuring the Slack app

ThreadRunner connects out to Slack over Socket Mode (a WebSocket the bridge opens). It never listens on a port, so there is no request URL, no tunnel, and no public endpoint to configure.

### 1. Create the app

At <https://api.slack.com/apps> choose **Create New App > From a manifest**, pick your private workspace, and paste:

```yaml
display_information:
  name: ThreadRunner
features:
  bot_user:
    display_name: ThreadRunner
    always_online: false
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - im:history
      - chat:write
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

Minimal scopes, and why each is there:

| Scope | Needed for |
|---|---|
| `app_mentions:read` | the `app_mention` event (an explicit `@ThreadRunner` in a channel) |
| `im:history` | the `message.im` event (a message in your DM with the bot) |
| `chat:write` | thread replies posted by the outbox sender |

Do **not** add other scopes, other event subscriptions, or **slash commands**. The bridge subscribes only to `message.im` and `app_mention`, and acknowledges then discards any other envelope type it receives. Do not enable interactivity, and do not install the app in a Slack Connect or shared channel.

### 2. Create the tokens

1. **Install to Workspace** (OAuth & Permissions). Copy the **Bot User OAuth Token** (`xoxb-...`) into `SLACK_BOT_TOKEN`.
2. Under **Basic Information > App-Level Tokens**, generate a token with only the `connections:write` scope. Copy it (`xapp-...`) into `SLACK_APP_TOKEN`.
3. Put both in `.env`, which is git-ignored. Never commit them, paste them into Slack, or pass them on a command line. The bridge never logs them, and configuration errors name the variable, never the value.
4. Run `chmod 600 .env`. At startup, before the config is used, the bridge checks `./.env` (the file `npm start` loads) and refuses to start (exit 1, code `env_file`, with the path and the fix) if it is a symlink or not a regular file, is not owned by you, or has any group or other permission bit. It only reads the file's metadata, never its contents. If `./.env` does not exist (variables come from your shell or a supervisor), the check is skipped. POSIX only (macOS and Linux); skipped on Windows. It does not protect tokens set in a launchd plist, a systemd unit, or shell history, and does not detect a compromised local account.

### 3. Set the allowlist (immutable IDs, not names)

```env
ALLOWED_TEAM_ID=T0123456789       # workspace ID
ALLOWED_USER_IDS=U01YOURUSERID    # exactly ONE user ID; zero or several refuse to start
ALLOWED_CHANNEL_IDS=D01BOTDM,C01PRIVATECONTROL
DATABASE_PATH=/home/you/.threadrunner/threadrunner.db
```

Find the IDs in Slack: your member ID under your profile > **Copy member ID**; the workspace ID in the URL of the web client (`app.slack.com/client/T.../...`); a channel ID at the bottom of the channel details; the bot DM's ID (`D...`) in the same URL while that DM is open. At startup the bridge calls `auth.test` and refuses to run if the bot token belongs to a different workspace than `ALLOWED_TEAM_ID`.

### 4. What is accepted

Only `message.im` (a DM) and `app_mention`, from the one allowlisted user, in an allowlisted channel, in the allowlisted workspace. Bot and system messages, message subtypes (edits, deletes, joins), file uploads, shared or Slack Connect channels, external users, and ambient channel messages are dropped with no reply. Dropped events log a reason code and the event ID, never message text.

**Commands are text, not Slack slash commands.** The text `/claude default ...` is parsed by the bridge. Registered Slack slash commands arrive as a different envelope type with no thread and no event ID, which cannot be bound to a run, so they are deliberately unsupported. Because the Slack client also treats a leading `/` as a slash command, Slack may complain that the command is not valid when you type it as the first character of a DM: choose the **send as message** option it offers, or mention the bot first (`@ThreadRunner /claude default ...`), which the bridge strips.

### 5. Rotating tokens

Rotate on a schedule you choose, and immediately if a token may have leaked (a pasted log, a shared screen, a backup of `.env`).

1. **App-level token:** Basic Information > App-Level Tokens: generate a new `connections:write` token, put it in `.env`, restart the bridge, confirm it connects, then delete the old token in Slack.
2. **Bot token:** OAuth & Permissions: use the rotate/regenerate control or reinstall the app to issue a new `xoxb-` token, update `.env`, restart, then confirm the old token is revoked (reinstalling revokes it).
3. Restart with `npm start`. A bad or revoked token fails the startup identity check and the bridge exits without handling events.

Slack's optional *token rotation* feature (short-lived `xoxe` tokens with refresh tokens) is not supported and is not enabled in the manifest above; the bridge only accepts `xoxb-` and `xapp-` tokens.

## Security

ThreadRunner is not a remote shell and does not treat Slack membership as execution authority.

See [SECURITY.md](./SECURITY.md) for the full trust model, required controls, and non-goals.

If you believe you have found a security vulnerability, please **do not open a public issue**. See [SECURITY.md](./SECURITY.md) for private disclosure instructions.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Every pull request that adds or widens an inbound event type, authorization path, CLI tool, file access, or network capability must include a security impact assessment.

## License

[MIT](./LICENSE)

## Development

Requires Node 22.13+ (the first 22.x where `node:sqlite` works without a flag).

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run check       # both
```

`src/domain` and `src/parser` are pure logic with no I/O. `src/store` is the only code that touches the database. `src/slack` is the Slack transport: it is the only code with a network dependency (`@slack/socket-mode` and `@slack/web-api`, both imported only by `src/slack/sdk.ts`), and it starts no provider and no subprocess. Tests inject fixtures in place of the SDK and never use the network.

`npm run build` compiles to `dist/` (git-ignored); `npm start` builds and runs the bridge.

Command grammar: `/codex|/claude|/auto <fast|default|deep> <prompt>`, `/status`, `/cancel`, `/approve run-<id>`. Anything else is rejected.

## Database

Runs, inbound-event IDs, run events, approvals, and the outbound message queue live in a local SQLite file (`src/store/`). It uses Node's built-in `node:sqlite`, so there is no native build and no new dependency. Node currently prints an `ExperimentalWarning` for it; the warning is not suppressed.

- **Location:** set `DATABASE_PATH` to an absolute path outside any git repository (see `.env.example`).
- **Permissions:** the directory is created `0700` and the file `0600`. Existing modes are verified, never changed: the store refuses an existing file that is group/world-accessible, a symlink, or not yours; an existing directory that is not yours or is writable by group or others (including sticky directories such as `/tmp`); and any location inside a git working tree (this includes `~/.threadrunner` if your home directory is a dotfiles repo). POSIX only (macOS/Linux); Windows mode bits are not supported.
- **Sensitive data:** each run stores its prompt once, in `runs.prompt`, because the runner needs it. Run events, outbox messages, and errors never copy it. No secrets are written to the database. `*.db`, `*.db-wal`, and `*.db-shm` are git-ignored.
- **Outbox:** messages are stored, not sent. A sender lists deliverable messages (oldest pending per run), then must call `claimMessage` immediately before posting; it refuses if the run was cancelled in the meantime. Long bodies go through `enqueueMessageParts`. Failures are recorded as fixed reason codes, never free text. Bodies may contain provider output: the sender must escape Slack markup (see the doc comment on `enqueueMessage`).
- **Journal mode:** WAL, with `foreign_keys = ON`, `busy_timeout = 5000`, and `synchronous = FULL`. Opening fails if WAL cannot be enabled.
- **Schema versioning:** tracked with `PRAGMA user_version` and forward-only migrations in `src/store/schema.ts`. A database with a newer version than the code supports is refused.
- **Guarantees enforced in the schema:** unique `(team, event_id)` and `(team, channel, message_ts)` (events rejected for an occupied thread are recorded too, so retries are quiet duplicates); one run per `(team, channel, root thread)`; immutable binding columns; append-only events, approvals, and inbound events; no outbox destination columns.

Run the store tests (they use temporary database files) with `npm test`, or `npx vitest run src/store`.
