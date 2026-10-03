# Security Architecture

This document defines the intended security boundaries and invariants for ThreadRunner before executable code exists. It is a design contract: implementations should fail closed when these guarantees cannot be established.

For vulnerability reporting and operational guidance, see [SECURITY.md](../SECURITY.md).

## Design goal

ThreadRunner is a local-first dispatcher, not a remote shell. An authorized Slack request may create a constrained task run; it must not grant ambient authority over the operator's computer, repositories, credentials, or Slack workspace.

## Trust boundaries

### Slack transport

Slack messages are transport input, not execution authority by themselves. Before creating or continuing a run, the bridge must validate:

- Expected Slack workspace/team ID
- Explicitly allowlisted immutable Slack user ID
- Explicitly allowlisted immutable bot-DM or channel ID
- Supported event type and explicit invocation form
- Non-bot, non-system, non-shared/external source policy
- Unique Slack event ID / idempotency key
- Thread ownership and run-state compatibility for follow-up actions

Display names, handles, email addresses, channel names, and natural-language identity claims are not authorization controls.

### Router

The router converts a validated message into structured task intent. It may select only configured providers, task modes, repositories, and skills. It must not:

- Interpret Slack text as an arbitrary shell command
- Select a filesystem path supplied by a message
- Widen Slack authorization or runner permissions
- Change the source thread or output destination
- Treat an ambiguous message as approval for a state-changing action

### Runner

The local runner has more authority than Slack and is therefore the primary enforcement point. It must:

- Run only within canonicalized, configured repository roots
- Reject traversal, symlink escapes, and unknown repositories
- Use a fresh process for each task in the initial design
- Create a dedicated Git worktree and branch before any write-capable execution
- Enforce bounded execution time and concurrency
- Avoid dangerous permission-bypass modes by default
- Keep secrets and unrelated home-directory content outside the task's declared scope

### Provider

A coding-agent provider may interpret task and repository content, including content that could be malicious or misleading. Provider output is never authority to:

- Alter authorization configuration
- Choose arbitrary Slack destinations
- Start a new task independently
- Escape configured repository boundaries
- Bypass approval state transitions
- Commit, push, open a pull request, deploy, send messages, or mutate external systems without a separately implemented and explicitly approved capability

### Outbox

Slack output must be produced by a bridge-owned outbox, not directly by a provider. Every outbound message must be bound to the task's recorded workspace, channel, and root thread timestamp. A provider must not choose arbitrary Slack destinations.

## Run state model

A root Slack thread maps to one durable task run. Each run records its initiating workspace, user, channel, root thread timestamp, repository, task mode, provider, and state.

Initial states:

```text
received → validated → queued → running → completed
                              ├→ awaiting_approval → queued_write → running_write → completed
                              ├→ cancelled
                              └→ failed
```

A transition is valid only when it is made by the allowed user, inside the original channel and root thread, and is compatible with the current state. A plain-language acknowledgement such as “yes” is not an approval command.

## Security invariants

The implementation must preserve these invariants:

1. An inbound Slack event cannot create more than one task run.
2. An unallowlisted workspace, user, channel, event type, or bot/system event cannot create or continue a run.
3. A message cannot affect a run owned by another workspace, user, channel, or root thread.
4. A provider cannot select an arbitrary command, repository path, credential, or Slack destination.
5. Write-capable work requires an explicit, unambiguous approval state transition in the originating thread.
6. Each write-capable run uses a dedicated worktree rooted under a configured repository path.
7. At most one write-capable run may operate on a repository at a time unless a future design explicitly and safely changes that rule.
8. A cancellation prevents future work and outbound side effects for that run after cancellation is recorded.
9. Unknown, malformed, stale, duplicate, or ambiguous inputs fail closed.
10. Secrets must not be placed in repository files, prompts, run logs, Slack messages, or artifacts.

## Threats not eliminated

These controls reduce accidental and unauthorized invocation; they do not eliminate all risk. Operators must still account for:

- Compromise of the Slack account, Slack workspace, local machine, or provider account
- Prompt injection in repository files, tickets, web content, dependencies, or pasted text
- Incorrect, incomplete, or malicious provider output
- Vulnerable dependencies and supply-chain compromise
- Secrets exposed through the local operating-system account or overly broad provider/tool permissions
- Provider usage limits, policy changes, or authentication changes

The initial deployment model assumes one trusted operator, one private Slack workspace, and one local machine. Multi-user, shared-workspace, remote-node, scheduled, credentialed-tool, or production-action capabilities require a separate design and threat-model review.
