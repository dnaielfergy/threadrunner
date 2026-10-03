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

Requires Node 20+.

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run check       # both
```

The current code is pure domain logic only (command parser, model profiles, run-state transitions). It performs no I/O, and has no Slack, provider, or network dependencies.

Command grammar: `/codex|/claude|/auto <fast|default|deep> <prompt>`, `/status`, `/cancel`, `/approve run-<id>`. Anything else is rejected.
