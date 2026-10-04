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
- Selecting a named agent. Input recorded in section 14; not yet designed.

## 2. Decisions made by the owner

| # | Question | Decision |
|---|---|---|
| 1 | What does `/approve` authorize? | **The prompt.** No plan phase. The approval request shows the full invocation, and `/approve` authorizes exactly that. Reason: the intended agents are already bounded, so a plan step is redundant. |
| 2 | How does a task ask for edit mode? | **`--edit` token** right after the profile: `/codex default --edit <prompt>`. |
| 3 | Where do test results come from? | **Agent-reported and labeled.** The bridge computes changed files and diff counts itself. |
| 4 | Where do worktrees live? | **A separate `WORKTREE_ROOT`** outside the repository. Needs an amendment to invariant 6. |
| 5 | Cleanup | **Automatic retention plus manual removal.** No `/discard` command. |
| 6 | Dirty checkout | **Proceed**, and the approval request says uncommitted changes are not included. |
| 7 | What is an agent? | **Standard agent structures: Markdown files in an agent folder, each with a goal, skills, and tools.** See section 14. |
| 8 | Linked worktree or standalone clone? | **Linked worktree**, decided by the spike (section 12): the sandbox protected `.git` and blocked commits in both, so the clone adds nothing observed. |

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
Observed in the spike (section 12; codex-cli 0.160.0, macOS, `--ignore-user-config`): under `--sandbox workspace-write --cd <linked worktree>` the process could write inside the worktree, could not write into the main repository's `.git` ("permission denied"), could not create a commit (git exited 128), and could run `git status`. The sandbox is therefore the control that prevents commits and changes to the repository's git directory, and the design relies on it as observed, with the bridge-side hardening in 6.3 as defense in depth. Not tested: whether the sandbox also protects an overwritten `.git` pointer file inside the worktree. The bridge does not depend on that, because it names the git directory explicitly.

### 6.5 Fallback: isolated clone instead of a linked worktree
A local clone in `WORKTREE_ROOT` has its own `.git`. The spike showed the same sandbox behavior for a clone (`.git` protected, commit blocked), so it adds no observed protection and costs a copy of the objects. Not used. Kept as the fallback if a later Codex version changes how `workspace-write` treats `.git` in a linked worktree; re-run Part B after Codex upgrades.

### 6.6 One write run per repository
Invariant 7 is enforced in the database, not only in code: a partial unique index over `running_write`, so two runs can never be operating on the repository at once. `queued_write` is deliberately not in the index: a second approved run waits there (still subject to expiry) until the first finishes. With a single configured repository the key is a constant; it becomes `repo_id` when multiple repositories exist.

### 6.7 Lifecycle and cleanup
- **Retention:** a terminal run's worktree is kept for `WORKTREE_RETENTION_DAYS` (default 7) so the owner can review it, then removed by a sweep at startup and daily.
- **The sweep removes an entry only if all of these hold:** its real path is a direct child of `WORKTREE_ROOT`; the name matches `RUN_ID_PATTERN`; it is not a symlink; the run exists in the database, is terminal, and is older than the retention; git reports it as a registered worktree of the configured repository. Removal uses `git worktree remove` (forced only here, after retention), then `branch -D` for the matching branch. The sweep never runs `rm -rf` on an unvalidated path and leaves unknown entries alone, logging a fixed code.
- **Cap:** at most `WORKTREE_MAX_RETAINED` (default 20). At the cap, new approvals are refused with a fixed notice until the sweep frees space.
- **Crash recovery:** a run in `running_write` at startup is failed and its worktree kept; it is never resumed or re-run. `queued_write` past its TTL is failed; otherwise it proceeds normally.
- There is no `/discard` command (decision 5): automatic retention plus manual `git worktree remove`.

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
| `AGENT_DIRS` | Ordered list of agent folders: repository-relative or absolute (no `~`). Default empty (no agents). See section 14. |
| `ALLOWED_AGENTS` | Agent names that may be started. Default empty. |

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

Grammar becomes `/codex|/claude|/auto <fast|default|deep> [--edit] <prompt>`. `--edit` must be the exact, case-sensitive token immediately after the profile, followed by whitespace and a non-empty prompt. It is parsed into `mode: edit` and is never passed to any CLI. A prompt that genuinely begins with the word `--edit` must be rephrased; that is the accepted cost of an unambiguous token. When agents are added (section 14), an optional `--agent <name>` token may precede `--edit`, in that fixed order; the name must match the agent-name pattern. `/approve` is unchanged: the exact `/approve <run-id>`, and a bare "yes" is never approval.

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
| T13 | **Read access outside the working directory (confirmed in the spike).** The write sandbox let Codex read a file outside its directory, so injected text could make it print that content in a reply that is posted to Slack. | **Accepted by the owner.** The tool's premise is that only the authenticated owner can use it, and it runs as the owner's own login. Recommended, not required: apply any read restriction the CLI itself offers (limiting it to one folder). Codex 0.160.0 exposes sandbox modes for writes and no read restriction was found in `codex exec --help`, so this is unverified. A dedicated OS user and a best-effort reply scrubber remain optional extra layers. No credentials are placed in the child's environment; network appeared disabled (DNS failed) | Spike Part B (done); replies stay bounded and escaped (existing) |

## 12. Spike before implementation (needs the owner's machine and real Codex)

Everything below uses a throwaway repository and a throwaway worktree root. None of it touches a real project.

1. Under `--sandbox workspace-write --cd <linked worktree>`: can the process write inside the worktree, can it write anywhere in the main repository's `.git`, can it create a commit, does `git status` run inside the sandbox?
2. Is network access disabled by default in `workspace-write` with `--ignore-user-config`?
3. Does `git worktree add` run a `post-checkout` hook, and do the hardening switches in 6.3 stop it on the installed Git version?
4. Does the installed Git support reading attributes from a given tree?
5. Repeat 1 against a standalone clone, to decide between 6.4 and 6.5.

### Running the spike and results so far

`docs/design/spikes/approvals-worktrees-spike.sh` runs everything below in a throwaway directory in `$HOME` (never under `/tmp`, `/var`, or `$TMPDIR`, where the sandbox may allow writes and the result would mean nothing). `PART=A` is git only and uses no Codex; `PART=B` uses real Codex. It reports evidence from the filesystem, not what the agent says it did.

**Part A, run on Linux with Git 2.43.0.** Each case is a planted command that proves it ran by creating a file. The macOS result is still needed, because Git versions differ.

| Case | Plain git | With hardening |
|---|---|---|
| `post-checkout` hook, run by `git worktree add` | **runs** | stopped by `-c core.hooksPath=/dev/null` |
| `core.fsmonitor` in repository config, run by `git status` | **runs** | stopped by `-c core.fsmonitor=false` |
| `.git` pointer file in the worktree overwritten to point at a hostile git directory | **runs the hostile directory's `core.fsmonitor`** | stopped by explicit `--git-dir` and `--work-tree` plus `-c core.fsmonitor=false` |
| Filter driver named by an in-worktree `.gitattributes`, defined in the repository's own config (as a git-lfs setup is) | **runs, via `git diff --numstat`** | stopped by `--attr-source=HEAD` |
| `textconv` driver named by an in-worktree `.gitattributes` | **runs, via patch-style `git diff`** | stopped by `--no-ext-diff --no-textconv` |

What this confirms and changes:
- The pointer-file attack is real, not theoretical: a process that can only write inside the worktree can make the bridge's own `git status` run a command of its choosing. Explicit `--git-dir` and `--work-tree` on every bridge git call is therefore a requirement, not a nicety.
- `git status` did not run the filter driver for a file whose size had changed; `git diff --numstat` did. Which command the summary uses decides which mechanisms are reachable, so the hostile-repository tests must use the exact commands the bridge runs, not only the obvious ones.
- `--numstat` did not run `textconv`; the patch form did. The bridge never needs the patch form, so it should not run it.
- The user's global git configuration can define filters too (this machine had git-lfs). The bridge's git environment disables global and system configuration.

**Part A on macOS** (Git 2.50.1, Apple Git-155) gave results identical to the Linux table above: every planted command ran under plain git and every hardening switch stopped it.

**Part B (real Codex, codex-cli 0.160.0, macOS, `--sandbox workspace-write --ignore-user-config`).** Evidence comes from the filesystem, not from what the agent reported.

| Probe | Linked worktree | Standalone clone |
|---|---|---|
| Write inside the working directory | works | works |
| Write into the repository's `.git` | denied | denied (the clone's own `.git`, inside the working directory) |
| `git status` | works (exit 0) | works (exit 0) |
| `git commit` | fails (exit 128), no new commit | fails (exit 128), no new commit |
| Network (`curl https://example.com`) | `Could not resolve host` | `Could not resolve host` |
| Read a file outside the working directory | **succeeded** | **succeeded** |

Conclusions:
- Use the linked worktree (decision 8). The sandbox protects `.git` and blocks commits in both layouts.
- Network looks disabled by default: DNS resolution failed. A direct connection by IP address was not tested, so "disabled" is not yet proven.
- **Reads are not confined.** The sandbox restricted writes only. See T13. This probably applies to the read-only runner too (not tested; the quick check is in the PR discussion).
- Not tested: overwriting the worktree's `.git` pointer file from inside the sandbox; the structured final message option `--output-schema`.

## 13. Implementation slices

Each slice is a separate PR, none enables writing until slice 4, and edit mode stays off unless `RUNNER_DEFAULT_MODE=build_with_approval`.

1. **Schema and store:** migration, triggers, `requestApproval`, atomic `approveRun`, expiry. No behavior change.
2. **Parser and ingress:** `--edit`, the approval request, and `/approve` gated end to end. A run ends in `queued_write`, which nothing yet consumes.
3. **Git helper and worktree lifecycle** with the hostile-repository tests. Nothing runs Codex.
4. **Write runner and summary.** This is the first slice that starts a process with write access, so the #22-style live checklist applies before it merges: a live edit in a throwaway repo, cancel mid-run, kill-and-restart, and a hostile-repository run.
5. **Sweep, recovery, caps, and configuration validation.**

## 14. Agents (input recorded, mechanism not yet designed)

The owner's input: agents are standard agent definitions, Markdown files in an agent folder, each defining a goal, skills, and tools. The owner has no agent file yet and asked to follow the existing agent standards. An illustrative example in the Claude Code subagent style (field names written from memory and **not verified against current documentation**; the design below deliberately does not depend on them):

```markdown
---
name: qa-reviewer
description: Reviews a change for missing tests and risky edge cases.
tools: Read, Grep, Glob
---
You are a QA reviewer. Your goal is to find missing test coverage and risky edge cases in the
code you are pointed at. Do not modify files. Report findings as a short, prioritized list.
```

Design rules that hold whatever the exact format turns out to be:

1. **The bridge treats an agent file as opaque text.** It never parses the front matter and never interprets `tools`, `skills`, or `model`. It reads the file, enforces a size cap, hashes it, and passes it along. This keeps the format an implementation detail of the CLI.
2. **Where agent files live (owner's input).** In the target repository (for example `.claude/agents/`, `.codex/agents/`, or `agents/`) or in a global folder (for example `~/.claude/agents/`). There is no single standard, so the locations are configuration, not a guess: `AGENT_DIRS`, an ordered list. A repository-relative entry (such as `.claude/agents`) is resolved under the canonical repository root; a global entry must be an absolute path (no `~`, like every other path setting). The first directory containing `<name>.md` wins. Whether Codex itself reads `.codex/agents/` is unverified and this design does not rely on it.
   - **Names are allowlisted locally.** `ALLOWED_AGENTS` lists the agent names that may be started (default empty: no agents). A name must match `^[a-z0-9][a-z0-9-]{0,63}$`, so it can never contain a path. A task names an agent; Slack text never supplies a path, and nothing is discovered from Slack. A new file appearing in a repository cannot be started until its name is added.
   - **The file must be safe to read.** A regular file, not a symlink, whose real path is inside the resolved directory, within the size cap. Anything else is refused with a fixed reason.
   - **Repository content stays untrusted.** An agent file in the target repository can be changed by anyone who can change the repository, so the protection is the name allowlist plus rules 4 and 5 below, not the location.
3. **`tools` and `skills` are requests, not grants.** The bridge grants nothing beyond the sandbox mode and its own configuration. It never enables external MCP tools, network access, or shell access because an agent file asks for it. Whether a CLI acts on such fields by itself is a separate verification, to be done when the second provider is designed (#7), and the sandbox limits observed in the spike (writes confined, commits blocked, no network) still apply.
4. **The agent is part of the invocation.** The invocation record and `invocation_sha256` include the agent name and the SHA-256 of the file's contents when the approval request is created. The runner refuses to start if the file changed after approval, so you approve exactly the instructions that run.
5. **The approval request shows the agent.** Its name, a short hash, its size, and its first lines (capped and escaped) appear in the request, plus a notice when the content differs from the last time that agent was run, so a changed file is visible at the moment of approval.
6. **How an agent reaches Codex is not specified.** `codex exec --help` (0.160.0) lists no agent-file option. The likely mechanism is that the bridge places the file's text ahead of the prompt on standard input, within the same prompt size limit; this needs its own check. For Claude Code a native mechanism may exist; that is for #7.
7. **Proposed syntax, needs the owner's confirmation:** `/codex default --agent qa-reviewer --edit <prompt>`. `--agent <name>` is an optional token before `--edit`; tokens are in that fixed order. It is parsed into a name only and never passed to a CLI as an argument.

## Required amendments

These change documents that outrank this one. None is made by this document; each needs the owner's approval.

1. **security-architecture.md, run state model:** add `validated -> awaiting_approval` for edit-mode tasks.
2. **security-architecture.md, invariant 6:** "dedicated worktree rooted under a configured repository path" becomes "under a configured worktree root".
3. **Issue #6, first acceptance criterion:** "Read-only runs can enter `awaiting_approval`" becomes "edit-mode tasks enter `awaiting_approval` directly; the read-only to approval edge is kept for a future plan mode".
4. **ROADMAP.md and README disagree** on order: ROADMAP.md puts approvals and worktrees in v0.2 and the Claude runner in v0.3; the README table puts the Claude runner in v0.2. One should be corrected.
5. **SECURITY.md:** `EDIT_CHANNEL_IDS` is the concrete form of the per-channel `max_privilege` in its configuration reference. No text change is required unless the owner wants it spelled out.

## Open questions

1. **Agent folders (section 14):** confirm the proposed `AGENT_DIRS` default and the `--agent` syntax.
2. **Codex agent locations:** whether Codex reads agent files at all (`.codex/agents/`) is unverified; section 14 does not depend on it.

Resolved by the owner: read confinement is an accepted risk (T13); no `/discard`; proceed on a dirty checkout; linked worktree.
