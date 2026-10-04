# Design: explicit approvals and isolated worktrees (#6)

**Status:** draft for owner review. No code is changed by this document.
**Authority:** [SECURITY.md](../../SECURITY.md) and [security-architecture.md](../security-architecture.md) win any conflict. Where this design needs those documents to change, the change is listed under [Required amendments](#required-amendments) and needs the owner's explicit approval before it is made.

## 1. Goal and non-goals

ThreadRunner's main purpose is to start CLI agents that already exist on the owner's machine from Slack. Edit capability is an opt-in addition to that, not the center of the product.

**Goal.** Let an authorized task, after an explicit approval in its own Slack thread, run a Codex agent with write access confined to a disposable Git worktree. Nothing leaves the machine: no commit, push, pull request, deploy, or external write.

**Non-goals for this change:**
- A plan-first phase (see decision 1). The state machine keeps the edge for it.
- Commit, push, PR, or deploy actions (later, with their own named confirmations).
- Bridge-run test commands (decision 3).
- More than one repository (needs named aliases, a schema change, and per-repo locks; separate design).
- A Claude write runner (#7). The design is provider-neutral, the first implementation is Codex only.
- Showing diff hunks in Slack. The summary lists file names and counts only.
- Selecting a named agent. See open question 2.

## 2. Decisions already made by the owner

| # | Question | Decision |
|---|---|---|
| 1 | What does `/approve` authorize? | **The prompt.** No plan phase. The approval request shows the full invocation, and `/approve` authorizes exactly that. Reason: the intended agents are already bounded, so a plan step is redundant. |
| 2 | How does a task ask for edit mode? | **`--edit` token** right after the profile: `/codex default --edit <prompt>`. |
| 3 | Where do test results come from? | **Agent-reported and labeled.** The bridge computes changed files and diff counts itself. |
| 4 | Where do worktrees live? | **A separate `WORKTREE_ROOT`** outside the repository. Needs an amendment to invariant 6. |

## 3. Flow and state machine

```text
/codex default --edit <prompt>
  received -> validated
  validated -> awaiting_approval     (edit tasks only; the approval request is queued in the same transaction)
  /approve run-xxxx                  (same user, channel, root thread; request delivered; not expired)
  awaiting_approval -> queued_write  (recorded and moved in ONE atomic step)
  queued_write -> running_write      (worktree created from the recorded base commit; fresh Codex process)
  running_write -> completed         (bridge-computed file list and counts, agent-reported tests)
  cancelled / failed reachable from every non-terminal state, as today
```

Read-only tasks (no `--edit`) are unchanged: `validated -> queued -> running -> completed`.

**New edge.** `validated -> awaiting_approval` does not exist in the current diagram, which only allows `running -> awaiting_approval`. The alternative, running a no-op read-only phase just to satisfy the diagram, would record a state that did not happen, so it is rejected. The existing `running -> awaiting_approval` edge stays for a possible future plan mode.

**Mode is data.** A new immutable `mode` column on `runs` (`read` or `edit`) records what the task asked for. The pure `transition()` function keeps knowing only states; the mode rules are enforced in the store and again by database triggers (section 8).

## 4. Approval semantics

### 4.1 The approval request

When an edit task is validated, the bridge queues one fixed-template message in the run's own thread. The only variable parts are fields of the run row:

- run ID, provider, profile, mode
- the prompt, in full (it is at most 4,000 characters; the sender escapes it)
- where edits will happen: the worktree path and branch name (derived from the run ID, section 6.1)
- the base commit the worktree will be cut from
- what will not happen: no commit, no push, no pull request, no deploy
- the expiry time
- the exact command to reply with: `/approve run-xxxx`

### 4.2 `/approve run-xxxx` is accepted only if all of these hold

1. Sent by the allowlisted user, in the original team, channel, and root thread (the existing binding lookup; a top-level message or another thread finds no run).
2. The run ID in the command equals the run bound to that thread.
3. The run is in `awaiting_approval` and has `mode = edit`.
4. The approval request message has been **delivered** (status `sent`), not merely queued. An outbox message can fail after its retries; approving something never shown must be impossible.
5. The request has not expired (section 4.4).
6. No approval was already recorded for the run.
7. Edit mode is enabled in configuration and in this channel (`RUNNER_DEFAULT_MODE=build_with_approval` and the channel is in `EDIT_CHANNEL_IDS`).

Anything else changes nothing. Replies for failures follow the decision recorded on #23: a fixed hint for the authorized sender, silence for anyone else.

### 4.3 Atomicity

Today `recordApproval` and `transitionRun` each open their own transaction, and the current `recordApproval` only stores the fact. Approval needs one function, `approveRun`, that in a single `BEGIN IMMEDIATE` transaction checks the preconditions, inserts the approval row, and moves `awaiting_approval -> queued_write` with a compare-and-swap. Implementation note: `transitionRun` uses its own `inTransaction`, so the shared logic needs an internal variant that does not nest.

`/approve` racing `/cancel`: both are compare-and-swaps on the run state, so exactly one wins. If cancel wins, the approval is refused (state is no longer `awaiting_approval`). If approve wins, a later `/cancel` goes through the existing path: before `running_write` no worktree exists and nothing starts; during `running_write` the existing process-group kill applies (invariant 8).

### 4.4 Expiry

- `awaiting_approval` longer than `APPROVAL_TTL_MINUTES` (default 60, allowed 5 to 1440) becomes `failed` with a fixed notice. It cannot be revived; the user starts a new thread.
- `queued_write` older than the same TTL, measured from the approval, becomes `failed` too. This covers a bridge that was down between approval and start.
- Expiry is checked when `/approve` arrives, on every runner pass, and at startup.

### 4.5 Audit

The approval row records the approving user, the time, and `invocation_sha256`: a SHA-256 over canonical JSON of `{run_id, provider, profile, mode, prompt, base_sha, repo_root}`. The runner recomputes it from the run row before starting the write phase and refuses on mismatch. Honest scope: the run's own columns are already immutable (database triggers), so the hash is defense in depth and an audit anchor, not the main control.

## 5. The write run

- **Fresh process**, separate from any read-only run (security-architecture, Runner).
- **Arguments** (a separate pure builder next to the read-only one; the read-only builder is unchanged):

```text
codex exec --sandbox workspace-write --cd <worktree> --ephemeral --ignore-user-config --ignore-rules --color never -
```

  `--sandbox workspace-write` and `--cd` are documented flags (`codex exec --help`, codex-cli 0.160.0). Still forbidden, with tests: any bypass flag, `danger-full-access`, `--add-dir`, `--approve-for-me`, `--worktree`, `-c`, and `--oss`. The prompt goes on standard input, exactly as today.
- **Environment:** the same allowlist as the read-only run. No git credentials, no `SSH_AUTH_SOCK`, no tokens.
- **Limits:** the same supervisor (timeout, output cap, process-group cancellation). The edit timeout is separately configurable (`RUNNER_EDIT_TIMEOUT_SECONDS`, default 1800, bounded).
- **Summary** posted to the run's thread when it finishes:
  - changed files and diff counts: **computed by the bridge** from the worktree (names capped at 50 with "and N more"; per-file added and removed counts; totals)
  - the branch name and worktree path (local information, the thread is the owner's)
  - the agent's final message, capped, labeled **"Reported by the agent, not verified"**, including any test result it states
  - no file contents and no diff hunks
- **Failure** (non-zero exit, timeout, output cap): fixed reason plus the changed-file count so far. The worktree is kept for inspection.

## 6. Worktrees and the bridge's own git use

Bridge-run git is the largest new attack surface in this design. Git can execute programs named in repository configuration, hooks, attributes, and filesystem-monitor settings, and the sandboxed write process can write inside the worktree.

### 6.1 Naming and paths
- Path: `<WORKTREE_ROOT>/<run-id>`. Branch: `threadrunner/<run-id>`. Both come only from the run ID (which matches `RUN_ID_PATTERN`), never from Slack text or provider output.
- `WORKTREE_ROOT` is validated at startup like the repo root: absolute, canonical, exists, owned by the current user, mode `0700`, not group or world writable, not inside the repository, not containing the repository, not containing the database.

### 6.2 Base commit
`base_sha` is the repository's `HEAD` when the approval request is created, stored with the request and shown to the user. The worktree is cut from exactly that commit, so a repository that moved afterward does not change what is built. Uncommitted changes in the owner's checkout are not included; the request text says so. A repository with no commits is refused.

### 6.3 One hardened git helper
All bridge-run git goes through a single module, using the existing `Launcher` interface so `launcher.ts` remains the only file that imports `child_process` and the source tripwire stays intact.

- `GIT_BIN` is an absolute path from configuration, not inside the repository.
- A fixed set of subcommands, built as argument arrays: `rev-parse`, `worktree add`, `status`, `diff --numstat`, `worktree remove`, `branch -D`. Nothing in an argument comes from Slack or the provider except the run-ID-derived path and branch.
- A scrubbed environment that disables global and system configuration and terminal prompts.
- **Operations on the worktree name the git directory explicitly** (`--git-dir` and `--work-tree`) so the `.git` pointer file inside the worktree, which the sandboxed process can overwrite, is never followed.
- **Candidate hardening to verify against the installed Git** (the spike, section 12; each is a requirement to confirm, not a claim): disable `core.fsmonitor`; set `core.hooksPath` to an empty location, because `git worktree add` runs the `post-checkout` hook; `--no-ext-diff` and `--no-textconv`; read attributes from the trusted base tree instead of the worktree if the installed Git supports it; no optional locks.
- Acceptance tests use a deliberately hostile repository (section 11): a canary command planted as a hook, as `core.fsmonitor`, as a filter driver, and via an overwritten `.git` pointer must never run.

### 6.4 Confinement
The write sandbox's writable area is expected to be the worktree only, so the main repository's `.git` (hooks, config, objects) is outside it and the process cannot commit or alter repository configuration. This is an expectation to verify, not an assumption. If the spike shows the common git directory is writable from the sandbox, or that git cannot work inside a linked worktree under the sandbox, the fallback in 6.5 applies.

### 6.5 Fallback: isolated clone instead of a linked worktree
A local clone in `WORKTREE_ROOT` has its own `.git`, so nothing the sandbox writes can reach the owner's repository, and git works fully inside the sandbox. Costs: a copy of the objects, and a later commit/PR phase must fetch from the clone. Branch naming and the rest of the design are unchanged. Chosen after the spike.

### 6.6 One write run per repository
Invariant 7 is enforced in the database, not only in code: a partial unique index over `running_write`, so two runs can never be operating on the repository at once. `queued_write` is deliberately not in the index: a second approved run waits there (still subject to expiry) until the first finishes. With a single configured repository the key is a constant; it becomes `repo_id` when multiple repositories exist.

### 6.7 Lifecycle and cleanup
- **Retention:** a terminal run's worktree is kept for `WORKTREE_RETENTION_DAYS` (default 7) so the owner can review it, then removed by a sweep at startup and daily.
- **The sweep removes an entry only if all of these hold:** its real path is a direct child of `WORKTREE_ROOT`; the name matches `RUN_ID_PATTERN`; it is not a symlink; the run exists in the database, is terminal, and is older than the retention; git reports it as a registered worktree of the configured repository. Removal uses `git worktree remove` (forced only here, after retention), then `branch -D` for the matching branch. The sweep never runs `rm -rf` on an unvalidated path and leaves unknown entries alone, logging a fixed code.
- **Cap:** at most `WORKTREE_MAX_RETAINED` (default 20). At the cap, new approvals are refused with a fixed notice until the sweep frees space.
- **Crash recovery:** a run in `running_write` at startup is failed and its worktree kept; it is never resumed or re-run. `queued_write` past its TTL is failed; otherwise it proceeds normally.
- A `/discard` command is not part of this change (open question 3).

## 7. Configuration

All validation fails closed at startup, naming the variable and never the value, like the rest of the configuration.

| Variable | Meaning |
|---|---|
| `RUNNER_DEFAULT_MODE` | `read_only` (default) or `build_with_approval`. Only the latter makes `--edit` do anything. With `read_only`, an `--edit` task gets a fixed refusal. |
| `EDIT_CHANNEL_IDS` | Subset of `ALLOWED_CHANNEL_IDS` where edit tasks are allowed. Default empty, meaning nowhere. This is SECURITY.md's per-channel `max_privilege`. |
| `WORKTREE_ROOT` | See 6.1. Required when edit mode is enabled. |
| `GIT_BIN` | Absolute path to git. Required when edit mode is enabled. |
| `APPROVAL_TTL_MINUTES` | Default 60, 5 to 1440. |
| `WORKTREE_RETENTION_DAYS` | Default 7. |
| `WORKTREE_MAX_RETAINED` | Default 20. |
| `RUNNER_EDIT_TIMEOUT_SECONDS` | Default 1800, bounded. |

`CODEX_FLAGS` stays refused. There is no setting that adds a provider flag.

## 8. Data model (one migration)

- `runs`: add `mode TEXT NOT NULL DEFAULT 'read' CHECK (mode IN ('read','edit'))`. The immutability trigger is recreated to include `mode`.
- New append-only `edit_requests`: `run_id` primary key, `base_sha`, `requested_at`, `expires_at`, `request_message_id`. The delivery check for 4.2(4) joins this to the outbox message. Linking by message ID means **the outbox table does not need to change**; adding a new message `kind` would force a table rebuild.
- `approvals`: add `invocation_sha256`.
- New `worktrees`: `run_id` primary key, `path`, `branch`, `base_sha`, `created_at`, `removed_at` (the only mutable column).
- Defense in depth, as invariant 8 already is:
  - a trigger that refuses any change of `runs.state` to `queued_write` unless an `approvals` row exists for the run
  - a trigger that refuses `awaiting_approval` from `validated` unless `mode = 'edit'`
  - the partial unique index on `running_write` from 6.6
- Migration discipline: schema changes from #23 and the durable outbox work in #8 are serialized with this one. Whoever lands second takes the next version number.

## 9. Code layout

- `src/runner/git.ts`: the hardened helper (6.3).
- `src/runner/worktree.ts`: path derivation, creation, lifecycle, sweep.
- `src/runner/argv.ts`: add the write builder; extend the forbidden-flag tests.
- `src/store/approvals.ts`: `requestApproval` and the atomic `approveRun`.
- `src/parser/command.ts`: the `--edit` token (section 10).
- `src/slack/ingress.ts`: create the approval request for edit tasks; wire `/approve`. The parser stays pure.
- `src/runner/runner.ts`: the write phase; startup recovery covers `queued_write` and `running_write`.
- `src/runner/messages.ts`: the fixed templates.

## 10. Parser

Grammar becomes `/codex|/claude|/auto <fast|default|deep> [--edit] <prompt>`. `--edit` must be the exact, case-sensitive token immediately after the profile, followed by whitespace and a non-empty prompt. It is parsed into `mode: edit` and is never passed to any CLI. A prompt that genuinely begins with the word `--edit` must be rephrased; that is the accepted cost of an unambiguous token. `/approve` is unchanged: the exact `/approve <run-id>`, and a bare "yes" is never approval.

## 11. Threat model

| # | Threat | Mitigation | Test |
|---|---|---|---|
| T1 | Forged, ambiguous, or wrong-thread approval | Exact command, binding lookup, run ID match, state check | Wrong user, channel, thread, "yes", stale ID |
| T2 | Stale approval (time or repository moved) | TTL; worktree cut from the recorded base commit | Expired approval refused; repo advanced after request |
| T3 | Approving a request never shown | Approval requires the request message to be `sent` | Failed-delivery request cannot be approved |
| T4 | Reaching write states without approval | Store checks plus a database trigger | Raw SQL attempt to set `queued_write` fails |
| T5 | Approve/cancel race | Single compare-and-swap transaction | Both orders, one winner |
| T6 | Write run touches the user's checkout or `.git` | Worktree-only writable area; sandbox expectation verified in the spike; clone fallback | Spike results; run in a hostile repo |
| T7 | Bridge git executes repository or worktree configuration | One hardened helper; explicit git dir; disabled hooks and fsmonitor; fixed argument lists | Hostile-repository canary tests |
| T8 | Cleanup deletes the wrong directory | Strict validation list in 6.7; no `rm -rf` on unvalidated paths | Foreign directory, symlink, non-terminal run all survive the sweep |
| T9 | Path or branch injection | Derived only from the run ID | Property test on derivation |
| T10 | Two writers in one repository | Database partial unique index on `running_write` | Two approved runs: one runs, one waits in `queued_write`; raw SQL for a second `running_write` fails |
| T11 | Secrets or large content in Slack | Names and counts only; capped lists; no hunks; escaping by the existing sender | Large diff, hostile file names |
| T12 | Disk exhaustion | Retention and a retained-worktree cap | Cap refusal test |
| T13 | Residual: write process reads credentials under `HOME` | No network expected in the sandbox (verify); no credentials in the environment; documented, same class as the read-only runner | Spike |

## 12. Spike before implementation (needs the owner's machine and real Codex)

Everything below uses a throwaway repository and a throwaway worktree root. None of it touches a real project.

1. Under `--sandbox workspace-write --cd <linked worktree>`: can the process write inside the worktree, can it write anywhere in the main repository's `.git`, can it create a commit, does `git status` run inside the sandbox?
2. Is network access disabled by default in `workspace-write` with `--ignore-user-config`?
3. Does `git worktree add` run a `post-checkout` hook, and do the hardening switches in 6.3 stop it on the installed Git version?
4. Does the installed Git support reading attributes from a given tree?
5. Repeat 1 against a standalone clone, to decide between 6.4 and 6.5.

## 13. Implementation slices

Each slice is a separate PR, none enables writing until slice 4, and edit mode stays off unless `RUNNER_DEFAULT_MODE=build_with_approval`.

1. **Schema and store:** migration, triggers, `requestApproval`, atomic `approveRun`, expiry. No behavior change.
2. **Parser and ingress:** `--edit`, the approval request, and `/approve` gated end to end. A run ends in `queued_write`, which nothing yet consumes.
3. **Git helper and worktree lifecycle** with the hostile-repository tests. Nothing runs Codex.
4. **Write runner and summary.** This is the first slice that starts a process with write access, so the #22-style live checklist applies before it merges: a live edit in a throwaway repo, cancel mid-run, kill-and-restart, and a hostile-repository run.
5. **Sweep, recovery, caps, and configuration validation.**

## Required amendments

These change documents that outrank this one. None is made by this document; each needs the owner's approval.

1. **security-architecture.md, run state model:** add `validated -> awaiting_approval` for edit-mode tasks.
2. **security-architecture.md, invariant 6:** "dedicated worktree rooted under a configured repository path" becomes "under a configured worktree root".
3. **Issue #6, first acceptance criterion:** "Read-only runs can enter `awaiting_approval`" becomes "edit-mode tasks enter `awaiting_approval` directly; the read-only to approval edge is kept for a future plan mode".
4. **ROADMAP.md and README disagree** on order: ROADMAP.md puts approvals and worktrees in v0.2 and the Claude runner in v0.3; the README table puts the Claude runner in v0.2. One should be corrected.
5. **SECURITY.md:** `EDIT_CHANNEL_IDS` is the concrete form of the per-channel `max_privilege` in its configuration reference. No text change is required unless the owner wants it spelled out.

## Open questions

1. **Worktree or clone?** Decided by the spike (6.4 vs 6.5).
2. **What is an "existing agent"?** The product goal is starting agents that already exist (a QA agent, a project-manager agent). The repository has no such concept yet. It could be a Codex configuration profile, a Claude subagent file, a prompt file, or a role in `AGENTS.md`. How the user names one in Slack, and who defines the allowlist, affects the approval request text and `invocation_sha256`, because the agent becomes part of the invocation. The design is built around a full invocation record so an agent field can be added without redesign.
3. **Cleanup command:** is a `/discard run-xxxx` command wanted, or is retention plus manual `git worktree remove` enough?
4. **Dirty checkout:** the current choice is to proceed and state that uncommitted changes are not included. The alternative is to refuse edit tasks when the checkout is dirty.
