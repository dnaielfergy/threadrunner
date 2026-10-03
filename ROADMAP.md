# Roadmap

ThreadRunner will start as a narrow, local-first Slack bridge for a single trusted operator. The roadmap prioritizes explicit authorization, durable task state, and safe execution boundaries over autonomous breadth.

This roadmap describes intent, not a delivery promise. Features that widen authority or introduce a new trust boundary require a security-design review before implementation.

## v0.1 — Trusted local task loop

- Slack Socket Mode transport; no public inbound webhook
- One explicitly allowlisted Slack workspace, user, and bot DM or control channel
- Root Slack thread mapped to one durable task run
- Local SQLite storage for inbound events, runs, run events, and outbound replies
- One approved repository root
- One active run at a time
- Local Codex CLI runner
- Read-only investigation, planning, and review mode by default
- Structured final summary posted only to the originating Slack thread
- Event deduplication, cancellation, timeouts, and basic audit logging

## v0.2 — Safe write workflow

- Explicit, stateful approval command in the originating thread
- Disposable Git worktree and task branch for every write-capable run
- Canonical repository-root and path validation
- Diff, changed-file, and test summaries
- Per-repository write lock
- No automatic commits, pushes, pull requests, deployments, or external writes

## v0.3 — Provider abstraction

- Claude Code runner alongside Codex CLI
- Explicit `/codex`, `/claude`, and `/auto` task selection
- Small, auditable routing rules based on task mode and local provider-health observations
- No credential scraping, subscription pooling, or undocumented provider-usage APIs
- Provider-independent run records and result format

## v0.4 — Practical local operation

- Multiple configured repository roots
- Optional repository-specific `AGENTS.md` and skill discovery
- Safer artifact handling with source-thread-bound output destinations
- Portable runner configuration for macOS, Linux, and Windows with WSL
- Optional local status view and retained run history

## Before any broader automation

The project will require an explicit threat-model review before adding any of the following:

- Slack file ingestion
- Browser automation or arbitrary web retrieval
- GitHub write access
- Credentialed third-party tools or MCP servers
- Scheduling, cron execution, or webhook-triggered runs
- Persistent provider sessions
- Multi-user, collaborator, organization, or multi-node operation
- Commit, push, pull-request, deployment, email, purchase, or production-data actions

## Explicit non-goals

ThreadRunner is not intended to become:

- A general remote shell or arbitrary-command endpoint
- A hosted, multi-tenant agent service
- A mechanism for sharing, pooling, proxying, or reselling provider subscriptions
- A passive Slack-monitoring or workspace-surveillance bot
- An automatic production deployment or database-mutation system
- A guarantee against prompt injection, compromised accounts, malicious dependencies, or incorrect agent behavior
