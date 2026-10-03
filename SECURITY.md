# Security Model

ThreadRunner is a personal tool that bridges Slack to local coding agents. It is designed to make remote agent execution **explicit, auditable, and safe by default**.

This document is the security boundary. If a feature or configuration contradicts what is written here, the document wins.

---

## Trust boundaries

| Boundary | Trusted? | Notes |
|---|---|---|
| Slack workspace | No | Treat as untrusted transport. Workspace admins may have impersonation or recovery powers. |
| Slack user identity | Only allowlisted IDs | Names, emails, and handles are not authorization. |
| Slack channel | Only allowlisted channel IDs | Not channel names. Immutable IDs only. |
| Repository content | No | Issues, PRs, READMEs, test fixtures, and web pages may contain adversarial instructions. |
| Local runner | Privileged relative to Slack | Has filesystem, network, and credential access under the local OS user. |
| Provider output | No | Model-generated text is not a security policy. |

## Required controls

### Authorization

- **Immutable Slack workspace/user/channel ID allowlists.** Not names, not roles, not "workspace admin."
- **One authorized user** in the initial release. No collaborator mode.
- **Bot messages, shared/external channels, and unknown threads are rejected.**
- **Explicit invocation required:** DM, `@mention`, or slash command. Ambient messages do not create runs.
- **Slack event-ID deduplication.** Retries do not become duplicate agent runs.

### Execution

- **No public HTTP listener.** Socket Mode only. The loopback control port (if any) must never be exposed through a proxy, tunnel, or SSH forward.
- **Approved local repository roots only.** Paths are canonicalized before execution. No `../../` escapes, no symlink traversal.
- **Git worktree isolation for all writes.** Writes never touch the active branch.
- **Concurrency limit of one run** in the initial release.
- **No arbitrary shell-command interface.** The bridge launches known provider CLIs with configured flags.
- **No permission-bypass defaults.** Do not use `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, or `--yolo`.

### Approvals

- **Read-only is the default mode.** Investigation, planning, and review do not require approval.
- **File edits require explicit approval** in the originating Slack thread.
- **Commits, pushes, PRs, and deploys require separate named confirmations.** No single message does everything.
- **Approvals are state transitions**, not natural-language interpretation. A bare "yes" is not accepted.

### Secrets

- Slack tokens and provider credentials stored in `.env`, outside Git.
- Restrictive file permissions on config directories.
- Secrets excluded from logs, error output, and thread replies.
- Token rotation instructions documented.

## What this project does NOT do

- It is **not a general remote shell.**
- It is **not a multi-tenant agent service.**
- It is **not a Slack workspace monitoring bot.**
- It does **not perform automatic production deployment.**
- It does **not share or proxy provider subscriptions** between users.
- It does **not expose a local control port** outside loopback.

## Honest limitations

This project reduces accidental and unauthorized invocation. It does **not** eliminate:

- Risk from a compromised Slack account or session.
- Risk from a compromised local macOS account.
- Prompt injection from repository content, issue text, web pages, or files.
- Vulnerabilities in provider CLIs, dependencies, or the bridge itself.
- An agent making incorrect changes even with valid authorization.

If your threat model requires eliminating these risks, use a dedicated, isolated execution environment: a separate OS user, a disposable VM, a container with no access to personal credentials, SSH keys, browser profiles, or cloud auth.

## Recommended deployment posture

For personal use:

```
- One private Slack workspace with only you as a member.
- One bot DM or one private control channel.
- One authorized Slack user ID.
- One local machine you control.
- Your existing Claude/Codex accounts and local repos.
- No customer/team access.
- No production deploys or database mutation from Slack.
- Strong MFA/passkey on your Slack account.
- Dedicated OS user (not your primary login) if feasible.
- No automatic updates without reviewing diffs/releases.
```

## Private vulnerability disclosure

If you believe you have found a security vulnerability in ThreadRunner:

1. **Do not open a public GitHub issue.**
2. Email the repository owner directly through GitHub's security advisory feature, or use GitHub's private vulnerability reporting:
   - Go to the repository's Security tab → "Report a vulnerability"
3. Include:
   - A description of the issue and its potential impact.
   - Steps to reproduce (if applicable).
   - Any suggested mitigation.
4. You will receive a response within 72 hours. Please allow up to 2 weeks for assessment before public disclosure.

We support coordinated disclosure and will credit reporters (with permission) in release notes.

## Security-related configuration reference

```yaml
slack:
  allowed_team_ids:
    - T_PRIVATE_WORKSPACE

  allowed_user_ids:
    - U_YOUR_ACCOUNT

  allowed_channels:
    D_BOT_DM:
      allow_new_runs: true
      max_privilege: read_only
    C_AGENT_CONTROL:
      allow_new_runs: true
      max_privilege: build_with_approval

  allow_events:
    - app_mention
    - message.im

  reject:
    bot_messages: true
    message_subtypes: true
    file_uploads: true
    shared_channels: true
    external_users: true
    unknown_threads: true

runner:
  concurrency: 1
  approved_repos:
    - ~/Code/your-project
  default_mode: read_only
  worktree_required_for_write: true
  dangerous_provider_flags: false
  network_access: disabled_or_limited
  deploys_from_slack: false
```
