# Contributing to ThreadRunner

Thank you for your interest in ThreadRunner. This project is small by design — contributions should preserve that.

## Before you start

Read [SECURITY.md](./SECURITY.md) first. Every contribution is evaluated against the security model described there. If your change widens remote control, adds an inbound event type, introduces a new CLI tool or file/network capability, or persists/transmits sensitive data, it **must** include a security impact assessment in your pull request.

## What we're looking for

- Bug fixes for existing functionality.
- Improvements to documentation clarity.
- Provider runner implementations that match the existing interface.
- Tests for authorization, deduplication, and run lifecycle.
- Hardening: tighter defaults, better error handling, clearer audit trails.

## What we're not looking for (yet)

- Multi-user or multi-tenant support.
- Persistent autonomous sessions or tmux lifecycle management.
- Multi-node remote execution.
- Slack file ingestion or artifact upload capabilities.
- Arbitrary shell command execution from Slack.
- Features that bypass the approval workflow.

If you have an idea in one of these areas, open a discussion issue first so we can talk through the threat model before you write code.

## Development setup

```bash
# Clone
git clone https://github.com/dnaielfergy/threadrunner.git
cd threadrunner

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Fill in your Slack tokens and allowlisted IDs

# Run in development mode
npm run dev
```

## Pull request process

1. Create a branch from `main` (e.g., `feature/add-claude-runner`).
2. Keep changes focused — one logical change per PR.
3. Include or update tests for any authorization, routing, or run-state logic.
4. Fill out the pull request template, including the **Security impact** section.
5. Ensure CI passes (when available).
6. Request review.

### PR template

Every PR must answer these questions:

```markdown
## Summary
What does this change do and why?

## Security impact
- [ ] Does this add a new inbound event type?
- [ ] Does this add or widen an authorization path?
- [ ] Does this introduce a new CLI/tool/file/network capability?
- [ ] Does it persist or transmit sensitive data?
- [ ] What is the default-deny behavior when validation fails?

If any box is checked, explain the mitigation in detail.
```

## Code style

- TypeScript with strict mode.
- No `any` types without an inline justification comment.
- Functions that handle authorization or run-state transitions should be pure and testable.
- Error messages should be specific and actionable, not generic.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(runner): add Claude Code provider runner
fix(auth): reject events from shared channels
docs(security): clarify worktree isolation requirements
test(dedup): add event-ID idempotency tests
```

## Reporting issues

- **Bugs:** Use the bug report issue template. Include reproduction steps, expected vs. actual behavior, and your configuration (redact secrets).
- **Security vulnerabilities:** Do not open a public issue. See [SECURITY.md](./SECURITY.md) for private disclosure.
- **Feature requests:** Open a discussion issue with the use case and a security consideration. Proposals that require widening the trust boundary need a written threat-model section.

## Code of conduct

Be kind. Be specific. Be honest about what you don't know. Disagreements about security tradeoffs are welcome — personal attacks are not.
