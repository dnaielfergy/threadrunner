# Local development guide

This covers what exists in the repository today: the Slack intake and the read-only Codex runner. Read [SECURITY.md](../SECURITY.md) first; it wins any conflict with this guide.

## Prerequisites and scripts

- Node 22.13 or newer (`engines` in `package.json`). That is the first 22.x where `node:sqlite` works without a flag.
- `npm install`

| Script | What it runs |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `vitest run` |
| `npm run check` | `npm run typecheck && npm run test` |
| `npm run build` | `tsc -p tsconfig.build.json`, output in `dist/` (git-ignored) |
| `npm start` | `npm run build && node --env-file-if-exists=.env dist/slack/main.js` |

`npm run check` is the gate before every commit. Also run `npm audit`; it should report 0 vulnerabilities.

## Code layout

| Path | Role |
|---|---|
| `src/domain` | Run states, transition rules and shared types. Pure logic, no I/O. |
| `src/parser` | Turns message text into a command (`/codex`, `/claude`, `/auto`, `/status`, `/cancel`, `/approve`). Pure. Anything else is rejected. |
| `src/store` | SQLite run store and outbox via `node:sqlite`. The only code that touches the database. |
| `src/slack` | Slack transport: config, authorization, ingress, the outbox sender, and `main.ts` (the entry point). The only code that imports the Slack SDKs (`sdk.ts`). |
| `src/runner` | The read-only Codex runner: config, repository root checks, argv, environment, the one launcher that starts a process, and supervision. |

Tests sit next to the code as `*.test.ts`. Shared helpers are `test-utils.ts` (store, runner) and `test-fixtures.ts` (Slack).

## How tests avoid real providers

No test starts Codex, opens a network connection, or uses a real Slack token. Test values are obvious canaries (for example `PROMPT-CANARY-...`).

- **`src/runner/test-utils.ts`**
  - `mockLauncher()` is a launcher that starts nothing. It records every launch spec and the most processes alive at once.
  - `writeFakeCli()` writes a small executable that stands in for Codex. Its first argument picks a behavior (`echo`, `env`, `argv`, `sleep`, `tree`, `flood`, `exit3`, `stderr`). Tests use it to check the allowlisted environment, argv, timeouts, output caps and killing a whole process group.
  - `queueRun()` creates a queued run through the state machine, the way ingress does.
- **`src/store/test-utils.ts`**: `tempDbPath()` and `open()` give each test a temporary database that is closed and deleted after the test. `fakeClock()` and `fakeIds()` make timestamps and run IDs deterministic.
- **Source tripwire tests** read the source files and fail if a forbidden pattern appears:
  - `src/slack/no-execution.test.ts`: no file under `src/slack` may use `child_process`, `worker_threads`, `node:vm`, `node:cluster`, raw network or listener modules (`node:http`, `net`, `tls`, and so on), `eval` or `new Function`, `.listen(`, or filesystem access. A second test drives a full task, status, cancel, approve and send cycle with `child_process` mocked to throw, and checks it was never called.
  - `src/runner/tripwire.test.ts`: `child_process` may appear only in `launcher.ts`. The launcher must use `shell: false` and `detached: true`, must not use `exec`, `execFile`, `spawnSync` or `fork`, and must not pass `process.env` through. No runner file may use `eval`, `.listen(`, network or `vm` modules, import `@slack/`, or read `process.env` (except `env.ts`). No runner file may mention a permission-bypass flag.

If your change trips one of these, change the change, not the test. Loosening a tripwire is a security decision and needs the Security impact section in the PR.

## Running the bridge locally against a sandbox repository

This needs a real Slack app and a real Codex install, so the Slack and Codex steps here are not exercised by the automated tests. Use a throwaway repository, never one you care about.

1. Create the sandbox repository somewhere outside the ThreadRunner checkout:

   ```bash
   mkdir -p ~/threadrunner-sandbox && cd ~/threadrunner-sandbox
   git init
   echo "hello" > README.md && git add . && git commit -m "init"
   ```

   The runner requires a Git repository.

2. Create the Slack app and tokens as described in the README ([Configuring the Slack app](../README.md#configuring-the-slack-app)). Copy `.env.example` to `.env` in the ThreadRunner checkout and fill in the tokens and IDs.

3. In `.env`, set:

   ```env
   APPROVED_REPO_ROOTS=/absolute/path/to/threadrunner-sandbox
   CODEX_BIN=/absolute/path/from/which-codex
   DATABASE_PATH=/home/you/.threadrunner/threadrunner.db
   ```

   - `APPROVED_REPO_ROOTS` takes exactly one absolute path. No `~`, no relative path, no comma-separated list.
   - `CODEX_BIN` is the output of `which codex`. It is not looked up through `PATH`.
   - **Do not point `APPROVED_REPO_ROOTS` at the ThreadRunner checkout.** The checkout holds `.env` with your Slack tokens, and a Codex run can read what its sandbox allows inside the repository. This is advice, not a startup check: startup refuses only the filesystem root, your home directory itself, and a directory that contains the database file.
   - **The sandbox must not contain the database file.** Startup refuses a root that contains `DATABASE_PATH`, because a run could read stored prompts. Keep the database in `~/.threadrunner/` or another directory outside any git repository.

4. Run `npm start`. Look for `socket_connected` and `bridge_started` on stderr. Then DM the bot, starting the message with the mention: `@ThreadRunner /codex fast list the files here`.

Stop the bridge with Ctrl+C. Deleting the sandbox directory and the database file resets everything.

## Troubleshooting startup

When configuration or startup is wrong the bridge prints one line to stderr and exits 1:

```
startup refused: config <VARIABLE>:<code> ...
startup refused: <code>
```

It never prints values. If you run `npm start 2>> file`, that line goes into the file and you see nothing on screen, so run plain `npm start` first when debugging.

Codes for `startup refused: config`, from `src/slack/config.ts` and `src/runner/config.ts`:

| Code | Variables | Meaning |
|---|---|---|
| `missing` | any required variable | Unset or blank. |
| `malformed` | `ALLOWED_TEAM_ID`, `ALLOWED_USER_IDS`, `ALLOWED_CHANNEL_IDS`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `DATABASE_PATH`, `APPROVED_REPO_ROOTS`, `RUNNER_TIMEOUT_SECONDS` | Wrong shape: a bad ID or token pattern, a relative database path, a repository root with `..` segments, or a timeout that is not a whole number from 10 to 3600. |
| `duplicate_entry` | `ALLOWED_USER_IDS`, `ALLOWED_CHANNEL_IDS` | The same ID listed twice. |
| `too_many_users` | `ALLOWED_USER_IDS` | More than one user ID. Exactly one is allowed. |
| `no_users` | `ALLOWED_USER_IDS` | No user ID left after parsing. |
| `too_many_roots` | `APPROVED_REPO_ROOTS` | More than one path. |
| `not_absolute` | `APPROVED_REPO_ROOTS`, `CODEX_BIN` | Relative path or `~`. |
| `not_found` | `APPROVED_REPO_ROOTS`, `CODEX_BIN` | Path does not exist. For `CODEX_BIN` this also covers a file you cannot execute. |
| `not_directory` | `APPROVED_REPO_ROOTS` | Path is a file. |
| `not_executable` | `CODEX_BIN` | Resolves to something that is not a regular file (for example a directory). |
| `inside_repo` | `CODEX_BIN` | The Codex binary is inside the approved repository. |
| `unsafe_root` | `APPROVED_REPO_ROOTS` | The filesystem root, your home directory itself, or a directory that contains the database file. |
| `unsupported` | `CODEX_FLAGS`, `RUNNER_CONCURRENCY`, `RUNNER_DEFAULT_MODE` | Set to anything other than empty, `1` and `read_only` respectively. |

Codes for `startup refused: <code>` with no variables, from `src/slack/app.ts`:

| Code | Meaning |
|---|---|
| `store` | The database could not be opened. A `store:<reason>` JSON line is logged just before it: `insecure_location` (inside a git repository, group or world accessible, a symlink, or not yours), `foreign_database`, `schema_too_new`, `invalid_path`, `unsupported_journal_mode`, `corrupt_row`, and others. |
| `slack_identity` | `auth.test` failed: bad or revoked bot token, or Slack was unreachable. |
| `workspace_mismatch` | The bot token belongs to a different workspace than `ALLOWED_TEAM_ID`. |
| `connect` | The Socket Mode connection failed to start. Check `SLACK_APP_TOKEN` and that Socket Mode is enabled. |

## Notes

- Node prints `ExperimentalWarning: SQLite is an experimental feature` on startup and during tests. It is harmless and is not suppressed.
- On macOS, temp directories are reached through `/var`, which is a link to `/private/var`. The repository root is resolved with `realpath`, so error output and test paths may show `/private/var/...` where you wrote `/var/...`.
- One store test (`refuses an existing directory owned by another user` in `src/store/database.test.ts`) only runs as root, because it needs to `chown`. It shows as skipped for a normal user. That is expected.
