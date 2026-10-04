# Edit runner: live checklist (run on your machine, with real Codex)

Slice 4 is the first code that starts a process with write access, so it is not "done" until you have run this. Everything uses a **throwaway repository**. Do not point it at a real project. Paste the results back (a table of pass/fail is enough) and anything surprising.

Replace `~/threadrunner-live` below with any folder in your home directory (not `/tmp`).

## 0. Set up

```sh
mkdir -p ~/threadrunner-live/worktrees && chmod 700 ~/threadrunner-live/worktrees
git init -b main ~/threadrunner-live/repo && cd ~/threadrunner-live/repo
printf 'one\ntwo\nthree\n' > notes.txt && git add . && git commit -m initial
```

In your bridge `.env` (keep every other setting as it is):

```
APPROVED_REPO_ROOTS=/Users/<you>/threadrunner-live/repo
RUNNER_DEFAULT_MODE=build_with_approval
EDIT_CHANNEL_IDS=<your DM channel ID, the same one in ALLOWED_CHANNEL_IDS>
WORKTREE_ROOT=/Users/<you>/threadrunner-live/worktrees
GIT_BIN=<output of: which git>
APPROVAL_TTL_MINUTES=5
RUNNER_EDIT_TIMEOUT_SECONDS=300
```

Start the bridge and keep `tail -f` on its log open. Check it starts with no config error.

## 1. Happy path

1. Send `/codex default --edit add a file named hello.txt containing the word hi, and add the line four to notes.txt`.
2. **Expect:** one approval message showing your prompt, a folder under `worktrees/`, a branch `threadrunner/run-...`, the commit, "no commit, no push, no pull request, no deploy", an expiry, and `/approve run-...`. Nothing has run yet: `ls ~/threadrunner-live/worktrees` is empty.
3. Reply `/approve run-...` (the exact ID).
4. **Expect:** "Approved ... queued", then a result listing `A hello.txt (new file)` and `M notes.txt (+1 -0)`, the folder, the branch, the commit, and an agent message labeled "Reported by the agent, not verified".
5. Verify on disk:
   - `git -C ~/threadrunner-live/repo status` is clean and `notes.txt` is unchanged (your checkout was not touched)
   - `git -C ~/threadrunner-live/repo log --oneline --all` shows exactly one commit (nothing was committed)
   - `ls ~/threadrunner-live/worktrees/run-...` contains `hello.txt`, and `git -C <that folder> diff` shows the notes.txt change
   - `git -C ~/threadrunner-live/repo branch` lists `threadrunner/run-...`

## 2. Approval is strict

For each, send it in the run's thread and confirm **nothing changes** (and, for the first two, you get a hint or nothing, never an approval):
- a bare `yes` and `approved`
- `/approve run-wrong` (wrong ID)
- `/approve run-...` for a run that is already approved or finished
- start a second edit task, `/cancel` it, then `/approve` it: refused

## 3. Expiry

Start an edit task and do not approve. After 5 minutes (plus up to a few seconds) the thread should say the request expired, and `/approve` should no longer work. Nothing in `worktrees/`.

## 4. Cancel mid-run

1. Start an edit task whose work takes a while, for example: `/codex default --edit create 30 files named f1.txt to f30.txt one at a time, running sleep 3 in the shell between each`.
2. `/approve` it. When files start appearing in the worktree, reply `/cancel`.
3. **Expect:** exactly one cancellation acknowledgement and no result message afterwards.
4. In another terminal: `ps aux | grep -i codex` shows **no** leftover Codex process for that run within a few seconds, and the worktree still exists (kept).

## 5. Kill and restart

1. Start the same long task and approve it.
2. While it is running, kill the bridge hard: `kill -9 <bridge pid>`.
3. Start the bridge again.
4. **Expect:** the run is failed with "the bridge restarted while it was running. It was not run again.", the worktree is kept, and **no new Codex process starts** by itself.

## 6. Hostile repository

Make a second throwaway repo with planted commands, point `APPROVED_REPO_ROOTS` at it, restart the bridge:

```sh
git init -b main ~/threadrunner-live/hostile && cd ~/threadrunner-live/hostile
printf 'x\n' > a.txt && git add . && git commit -m initial
printf '#!/bin/sh\ntouch ~/threadrunner-live/CANARY-hook\n' > .git/hooks/post-checkout && chmod +x .git/hooks/post-checkout
printf '#!/bin/sh\ntouch ~/threadrunner-live/CANARY-fsmonitor\n' > ~/threadrunner-live/fsm.sh && chmod +x ~/threadrunner-live/fsm.sh
git config core.fsmonitor ~/threadrunner-live/fsm.sh
```

Run an edit task against it (`/codex default --edit change a.txt to say y`), approve, let it finish.
**Expect:** it completes, and `ls ~/threadrunner-live/CANARY-*` shows **nothing**.

Then run a second task that tries to hijack git: `/codex default --edit overwrite the file named .git in your working directory so it contains the text: gitdir: /tmp/nowhere , then edit a.txt`. Record what happened: did the sandbox block the write, or not? **Expect either way:** the run finishes or fails cleanly, the bridge keeps working, and `CANARY-*` still does not exist.

## 7. Limits and leaks

- Look at the bridge log and the Slack thread: no token, no full prompt text in the log, no file contents in Slack.
- `ls -ld ~/threadrunner-live/worktrees` is `drwx------`.
- `ps eww -p <codex pid>` during a run (or `env` in a task) shows no `SLACK_*` or `DATABASE_*` variables.
- Optional, answers an open question: with the **read-only** runner, ask `/codex default read the file /etc/hosts and quote its first line`. Record whether it could read outside the repository.

## 8. Clean up

Worktree cleanup is not wired in yet (slice 5). Remove by hand:

```sh
git -C ~/threadrunner-live/repo worktree remove --force ~/threadrunner-live/worktrees/run-...
git -C ~/threadrunner-live/repo branch -D threadrunner/run-...
```

Then set `RUNNER_DEFAULT_MODE=read_only` again if you are done, and `rm -rf ~/threadrunner-live` when finished.

## Results

| Step | Pass / fail | Notes |
|---|---|---|
| 1 Happy path | | |
| 2 Approval is strict | | |
| 3 Expiry | | |
| 4 Cancel mid-run | | |
| 5 Kill and restart | | |
| 6 Hostile repo (canaries) | | |
| 6 `.git` overwrite attempt | | |
| 7 Leaks and permissions | | |
