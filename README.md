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

> **Status:** This project is in early development. The repository currently contains design documentation, security model, and contribution guidelines. Code is coming soon.

When v0.1 is ready, the setup will look like:

1. Create a private Slack workspace with only you as a member.
2. Create a Slack app with Socket Mode enabled and minimal bot scopes.
3. Clone this repo and configure your `.env`:

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ALLOWED_TEAM_ID=T...
ALLOWED_USER_ID=U...
ALLOWED_CHANNEL_IDS=C...,...
```

4. Start the bridge:

```bash
npm start
```

5. DM your bot or mention it in your control channel:

```
/run investigate why invite acceptance fails after login
```

## Roadmap

| Stage | Capability | Safety posture |
|---|---|---|
| v0.1 | Slack Socket Mode, one authorized user, bot DM, local Codex runner, final thread reply | Read-only task execution |
| v0.2 | Claude runner, `/auto`, SQLite run log, cancellation, deduplication | One active run, explicit provider selection |
| v0.3 | Approval-gated edits, disposable Git worktrees, diff/test summaries | No commits/pushes/deploys |
| v0.4 | Commit/PR actions with named confirmations, multiple repos | Per-repo locks and branch protections |
| v0.5 | Pluggable runners and portable deployment to Linux/WSL | Dedicated runner account/machine |
| Later | Optional schedules, web UI, richer artifact handling | Separate threat-model review per feature |

## Security

ThreadRunner is not a remote shell and does not treat Slack membership as execution authority.

See [SECURITY.md](./SECURITY.md) for the full trust model, required controls, and non-goals.

If you believe you have found a security vulnerability, please **do not open a public issue**. See [SECURITY.md](./SECURITY.md) for private disclosure instructions.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Every pull request that adds or widens an inbound event type, authorization path, CLI tool, file access, or network capability must include a security impact assessment.

## License

[MIT](./LICENSE)

## Development

Requires Node 22+.

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run check       # both
```

The current code is pure domain logic only (command parser, model profiles, run-state transitions). It performs no I/O, and has no Slack, provider, or network dependencies.

Command grammar: `/codex|/claude|/auto <fast|default|deep> <prompt>`, `/status`, `/cancel`, `/approve run-<id>`. Anything else is rejected.

## Database

Runs, inbound-event IDs, run events, approvals, and the outbound message queue live in a local SQLite file (`src/store/`). It uses Node's built-in `node:sqlite`, so there is no native build and no new dependency. Node currently prints an `ExperimentalWarning` for it; the warning is not suppressed.

- **Location:** set `DATABASE_PATH` to an absolute path outside any git repository (see `.env.example`).
- **Permissions:** the directory is created `0700` and the file `0600`. Existing stricter modes are never loosened. The store refuses an existing file that is group/world-accessible, a symlink, or inside a git working tree.
- **Sensitive data:** each run stores its prompt once, in `runs.prompt`, because the runner needs it. Run events, outbox messages, and errors never copy it. No secrets are written to the database. `*.db`, `*.db-wal`, and `*.db-shm` are git-ignored.
- **Journal mode:** WAL, with `foreign_keys = ON`, `busy_timeout = 5000`, and `synchronous = FULL`. Opening fails if WAL cannot be enabled.
- **Schema versioning:** tracked with `PRAGMA user_version` and forward-only migrations in `src/store/schema.ts`. A database with a newer version than the code supports is refused.
- **Guarantees enforced in the schema:** unique `(team, event_id)` and `(team, channel, message_ts)`; one run per `(team, channel, root thread)`; immutable binding columns; append-only events, approvals, and inbound events; no outbox destination columns.

Run the store tests (they use temporary database files) with `npm test`, or `npx vitest run src/store`.
