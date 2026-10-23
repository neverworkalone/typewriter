# War Room

Typewriter's production supervisor. `./war` opens a terminal situation board (Textual) over a
persistent **Supervisor** that runs configured Claude, Codex or OpenCode producers, watches each PR
(review → fix → `merged=true`) and removes only the worktree and branch it owns afterwards.

```text
./war  ──tmux session "warroom"──▶ TUI (view + commands, writes SQLite only)
                                   tmux session "warroom-supervisor" ──▶ Supervisor loop
                                        ├─ AI producer subprocesses (detached, own process group)
                                        ├─ gh (isolated GH_CONFIG_DIR), git worktrees
                                        └─ SQLite state: tools/warroom/.local/warroom.db
```

The Supervisor reads `config.json` at start and again on **`r`** (Board): it re-runs `load_config`, and the new
config replaces the running one only if the whole config validates (JSON, the type and range of every runtime value such as
`poll_seconds` and `rate_limit_retries`, model/effort pins, duplicate IDs). Start runs the same check. A
rejected reload keeps the old config and shows the reason in the event log and on the Board. A reload that removes a
model with an unfinished batch, changes its CLI adapter, or changes `repo`, `*_bin`, `git_name` or `git_email` (wired once at start), is
rejected: restart the Supervisor for those. A successful reload clears `시작 차단:` messages (Start re-checks them).
Unfinished batches keep their recorded model + effort pin; a changed pin still stops them at relaunch. New columns
appear after reopening the TUI.

Closing the TUI or detaching tmux never stops the Supervisor or the AI. If tmux dies, `./war`
restarts the Supervisor, which resumes from SQLite + GitHub + git worktrees; it never
re-produces or opens a second PR when the situation is unclear (state `ERROR`, everything kept).

## Setup

1. `brew install tmux` and install the CLI(s) for the configured producers. `./war` creates `.local/venv` (Textual) on first run.
2. Log the producer account in **without touching your own gh/git setup**:
   `GH_CONFIG_DIR=tools/warroom/.local/gh gh auth login` (expected account `neverworkalone-agent`).
3. Optional `tools/warroom/.local/config.json` (see `config.example.json`): model IDs
   (`models.free`, `models.go`), git author for the producer, quota patterns, polling.
   `models.free` is **required**: Start is blocked unless it is installed (`opencode models`) and
   matches `free_model_pattern` (default `-free$`); OpenCode's implicit default model is never used.
   An empty `models.go` disables the Go switch (quota exhaustion then pauses).

`.local/` (config, DB, logs, auth, worktrees, venv) is git-ignored; never commit tokens/logs.

## Restarting after code updates

Updating files with `git pull` does not reload Python code already running in the Supervisor.
The Board's `r` key reloads `config.json` only; it does **not** restart the Supervisor.
After updating War Room's Python code, restart **both** tmux sessions from a separate,
ordinary terminal (not from inside either War Room tmux session).
Prefer a time when no producer is actively working; the Supervisor and TUI sessions are
replaced, but the persistent database, producer worktrees and PRs are not deleted.

```sh
tmux kill-session -t warroom-supervisor 2>/dev/null || true
tmux kill-session -t warroom 2>/dev/null || true
./war
```

`./war` creates or reattaches the TUI and starts a fresh Supervisor if none holds its lock.
The Supervisor recovers existing batches using the persisted state and running processes;
do not delete `tools/warroom/.local/`, manually reset worktrees or press Retry just to reload code.

## Factory Board · Production Lines

A **Line** = (logical model, method A/B/C/D). `Factory → Model → Line → Batch history → Run history`.
The model registry is config (`producers` in `config.json`, any number of models, see
`config.example.json`; without it the legacy `worker`/`models` is one entry). Each Line owns at most
**one** unfinished batch (`Store.create_batch` refuses a second one; Start on an occupied Line is
rejected). Lines are independent: batch/PR/HEAD/session/PID/worktree/runs/errors/retry/tier/drain are
per Line, and an exception or a long review wait in one Line never stalls another. Registering the same
logical model twice (duplicate id or shared endpoint ID) is blocked.

- **Board**: one column per registered model, fixed A/B/C/D slots (3-line fixed-size cards: `Method · batch`
  + phase icon / phase + observed `N/500` / `PR #n` + last activity; empty slots are dim grey, a finished (COMPLETE) batch leaves its slot EMPTY and stays in Batch/Run History). Clicking any card (even an empty slot) only opens its Batch Detail. New work starts only from the
  one-row top bar `[CLI] [Method] [Single|Continuous] [Start] [Drain All] [Stop All]` (Selects are sized to their longest label, the three buttons share one fixed width; narrow terminals wrap it into
  a grid). The CLI/Adapter list comes from the registry (Claude, Codex, OpenCode by label); the model Select appears
  only when one CLI hosts several logical models, so Start never guesses a model. **Single** = one batch
  then stop; **Continuous** = consecutive batches in the *same* Line (never parallel batches in one Line).
  The board shows no always-on Supervisor status; a stopped Supervisor, auth/model problems and Drain All stay visible.
- **Drain** (Line): stop assigning new batches; the current batch continues through review/merge/cleanup.
- **Drain All**: a one-shot request to the Lines running now. Each finishes its current batch (review/fix/merge/
  cleanup, kept across PAUSED/ERROR/Retry and Supervisor restarts), then ends its Continuous run; a reservation
  without a batch is cancelled. Other Lines can Start afterwards; Line drains are untouched.
- **Stop** / **Stop All**: red (Stop All is disabled while no Line has an unfinished batch or run flag), y/N modal (Enter/Esc = No). Stops the AI of the scope, preserves
  worktree/branch/PR, clears the run flag so nothing restarts; **Retry** (PAUSED/ERROR only) reuses
  the same batch.
- **Batch Detail**: short header (`OpenCode / A · 009_02`, phase, PR, observed progress, time); SHA, session,
  tier and worktree (a cleaned-up one is labelled as a past path) are under *Metadata / Details*. The Agent Log is
  a readable rendering of OpenCode JSON Lines (`logrender.py`, per line, so the incremental `tail -f` read by byte
  offset is kept; unknown events and non-JSON lines are shown as-is); **Raw Log** switches to the verbatim file.
  Secrets are redacted in both. Run History (`runs` table) and a separate Audit Log stay. **Auto-scroll**
  (default ON, off on manual scroll-up) is shown only for a still-running log. Esc returns to the board. `s` opens Settings.
- **SQLite**: per-Line controls, batch history, run history and audit events persist in
  `tools/warroom/.local/warroom.db`. Schema migrations are additive; existing batch and run records are preserved.

## Producer CLIs and pinned models

Each logical model (`producers` in `config.json`, see `config.example.json`) runs on one CLI adapter.
The Factory Board columns and the top CLI Select follow the adapter label, **Claude → Codex → OpenCode**,
then the model label; the order of `producers` in the file does not matter.

| Producer (example label) | Adapter (CLI) | Model | Effort |
|---|---|---|---|
| `claude` (Sonnet) | `claude` (Claude Code) | `model: sonnet` → `--model sonnet` | `effort: medium` → `--effort medium` |
| `codex` (Luna) | `codex` (Codex CLI) | `model: gpt-6-luna` → `-m gpt-6-luna` | `effort: xhigh` → `-c model_reasoning_effort=xhigh` |
| `deepseek` (DeepSeek) | `opencode` | `models.free` / `models.go` | `effort: high` → `--model <id>#high` |

Rules (fail closed):

- Every start, edit, recovery and resume passes the model and effort explicitly. Nothing falls back to a CLI default.
- A producer with an unset, flag-like (`--…`) or malformed model, or an effort its CLI does not accept, blocks
  Start with the reason shown in the Line's BLOCKED field.
- A CLI that is not wired into this build blocks Start. It is never redirected to another CLI.
- Every relaunch of a batch (resume, recovery after a lost session, fix) runs on the pin of its last recorded run.
  A changed effort stops the batch in ERROR, and so does any changed model, with no process started. The one exception
  is OpenCode's own Free → Go switch of its configured IDs. Another ID in the same tier, or a Go → Free change, stops
  the batch. To continue, restore the config, press `r` on the board (reload), then Retry.
- OpenCode's reasoning variant is the `#variant` suffix of `--model`. The installed CLI rejects `--variant`
  (`Unrecognized flag`). Before any batch or worktree exists, every model+variant pair (Free, and Go when configured)
  is proven by a short probe: one `opencode run` from an empty temporary directory outside the repository, without
  `--auto` and without tools, in the background. While a probe runs, the Line waits (it is not blocked and the other
  Lines keep moving). The probe denies every tool (`OPENCODE_CONFIG_CONTENT={"permission":{"*":"deny"}}`, run with
  `--standalone`, which was verified to stop a shell call on the installed CLI). `opencode models` is listed once per
  Supervisor life, also in the background; until it finishes Start waits. A variant the CLI refuses (`Variant
  unavailable`) blocks Start with that reason. Any provider answer, quota errors included, proves the variant. Silence,
  a timeout, or unreadable output does not, and blocks.
  A proven pair is kept for this Supervisor run. A refused pair stays refused until the Supervisor restarts. The probe
  may cost a few tokens and creates one session titled `WR preflight`. A variant refused later still stops the batch
  in ERROR, with nothing substituted. A DeepSeek entry without `effort` runs at `high`, the owner-fixed value
  (also the default when `effort` is omitted).
- Run History and the Audit Log record the model ID and effort each launch was pinned to.

### Claude Code (`claude`) setup

- Install Claude Code and log in with the operator's own account: `claude auth login`. `claude auth status`
  must report `loggedIn: true`; Start checks it. Unlike GitHub, this login is not isolated per War Room.
- Every run pins only the model and the reasoning effort: `claude -p <prompt> --model <model> --effort <effort>
  --output-format stream-json --verbose`. Resume uses `--resume <session id>` with the same pins.
- **Permissions are the operator's local Claude settings** (`~/.claude/settings.json`, project settings), applied by
  the CLI's own precedence. War Room passes no permission option: no allowlist, no `--permission-mode`, no bypass.
  A tool the local settings do not allow is denied by the CLI and listed in `permission_denials`; the run then stops
  in **PAUSED** with the denied tool named, and nothing is widened automatically. Worktree, PR and session are kept.
  To allow such a tool, the operator edits the local Claude settings directly and then retries.
- Start refuses when `ANTHROPIC_MODEL` or `CLAUDE_CODE_EFFORT_LEVEL` is set to anything other than the pin, because
  it would decide the effective value.
- A session that is not reported (absent, empty or not a string) stops the run, and so does a run that ends without
  any init event: a PR is accepted only with its own session.
- The stream reports the model it ran (`system/init`); a different model stops the batch. The CLI does not print the
  effort it used, so an unknown effort (the CLI's "ignoring it and using the default effort") is treated as a stop.

### Codex CLI (`codex`) setup

- Install the Codex CLI and log in with the operator's own account: `codex login`. `codex login status` must
  report `Logged in`; Start checks it. Like Claude, this login is not isolated per War Room.
- Codex runs under the operator's **local CLI policy** (`~/.codex/config.toml`, approval and execpolicy rules, project
  settings). The permission profile is configured per producer with `permission_profile` in `config.json`, like
  `model` and `effort`: `"permission_profile": "worktree"` passes `-c default_permissions=worktree` on every start and
  resume. Without it nothing is passed and the CLI default applies. The name must be a plain profile name
  (`[A-Za-z0-9_-]`) and is accepted only for Codex producers. The profile's rules live in the operator's own
  `[permissions.<name>]` table; War Room never defines them. War Room adds no legacy sandbox, approval, network or
  writable-root options and never uses `--ignore-user-config`, `--ignore-rules`, `--full-auto` or bypass flags.
- Every run pins the model, reasoning effort and (when configured) permission profile:
  `codex exec --json -m <model> -c model_reasoning_effort=<effort> [-c default_permissions=<profile>] <prompt>`.
  Resume is `codex exec resume <thread id>` with the same pins. `--worktree`, `--last` and `--all` are never used.
- Legacy `sandbox_mode` in any active config layer takes precedence over permission profiles. Do not combine
  `sandbox_mode` / `sandbox_workspace_write` with a configured `permission_profile`.
- Checked, not assumed: the `thread.started` thread id must equal the requested session, and the model and effort in
  the rollout's `turn_context` must equal the pins. A finished turn with no recorded context stops the batch.
- A command the local policy refuses (`Operation not permitted`, `Permission denied`, an approval request) stops the
  run in **PAUSED**. The worktree, branch, PR and session are kept and nothing is retried automatically. Permission
  is never raised by War Room; the operator changes the local CLI settings and then retries.
- Start refuses unless `codex exec --help` and `codex exec resume --help` list the required options.

## Prompts

What the AI is told lives in `tools/warroom/prompts/` (`a.md` `b.md` `c.md` `d.md` `fix.md` `recovery.md`), checked in and
resolved from the repository, not the cwd. Placeholders (`{{batch}}`, `{{branch}}`, and for `fix.md` `{{pr}}` `{{head}}`
`{{review_events}}` `{{session_note}}`) are filled once when a run starts, so editing a file never changes a running AI.
A missing/empty/unreadable file or an unknown/unfilled placeholder stops the batch in `ERROR` without starting any AI.

## State machine (one batch = one atomic unit)

`PREPARE → PRODUCING → WAITING_REVIEW ⇄ FIXING → MERGED → CLEANUP → COMPLETE`, plus
`PAUSED` (recoverable, operator Retry) and `ERROR` (safety stop; worktree/PR preserved).

- **Batch choice** (`batches.py`): A/B keep one queue per (method, model); **C/D share one queue per method across all models** (a Candidate file or open PR of any model completes/claims the batch; local unfinished batches of any model occupy it; two models' files for one C/D batch is an error, and `create_batch` refuses a second model's reservation inside one `BEGIN IMMEDIATE` transaction). Each Line selects its earliest batch whose Candidate file is absent on
  `origin/master`, not claimed by an open PR under its queue key and not owned by War Room.
  A master file with the wrong record count is reported, never skipped or regenerated.
- **Fix trigger** (`reviews.py`): only accounts in `trusted_reviewers` (default `genonfire`; empty = nothing
  triggers) can produce events — other users' text never reaches the AI. A `-1` review (or `-1` general comment) for the *current* HEAD
  (`HEAD: <sha>` marker, else the review's `commit_id`), not authored by the producer account.
  Inline comments anchored to the current HEAD ride along with such a `-1` but never trigger alone.
  Handled once per `(PR, HEAD, event id)`; a review of an older HEAD is ignored.
- **Live AI:** a PR is detected even while the AI is still running (e.g. waiting for merge) and
  review watching takes over; before a fix run the old process is stopped and its exit confirmed.
- **Effective verdict:** a `-1` blocks only until a later same-HEAD `+1`/`+2` (dismissed reviews ignored).
- **Merge** is only `merged=true` from the GitHub API (not `+1/+2`, CI or `closed`).
- **Cleanup** removes a worktree only if it is under `.local/worktrees`, registered to the recorded
  branch, clean (incl. untracked), the AI process is gone and local HEAD equals the merged PR HEAD.
  If local HEAD is merely behind (e.g. GitHub "Update branch" added commits), the merged PR HEAD is
  fetched and fast-forwarded (`merge --ff-only`) first; a non-ancestor HEAD or a dirty tree stays
  `ERROR` and preserved (never reset/rebase/force). Retry of such an `ERROR` resumes at CLEANUP, no AI rerun.
- **PR HEAD synchronization**: after a fix, a clean local HEAD that matches the remote branch but is ahead of
  GitHub's PR `head.sha` is treated as PR metadata lag rather than an unpushed change. The Supervisor rechecks
  at `poll_seconds` intervals without restarting the AI. If the lag exceeds `pr_head_lag_timeout_seconds`
  (default 1800 seconds), the batch stops with the reason and keeps its worktree; Retry rechecks without an AI run.
  A missing or divergent remote branch, wrong PR branch or failed lookup is not treated as metadata lag.
- **Merged error recovery**: for ERROR/PAUSED batches with an existing PR, the Supervisor checks `merged=true`
  at `poll_seconds` intervals (at least 60 seconds). A merged PR proceeds through MERGED → CLEANUP → COMPLETE
  without launching the AI. A cleanup safety failure preserves the worktree and requires operator attention;
  no unmerged PR is marked complete.
- **Model policy**: only a failure matching `quota_patterns` while on the free tier switches to the
  Go model. 429/network → backoff retry; auth → `PAUSED`; anything unrecognised → `PAUSED`
  (never a silent paid fallback).
- **Auth isolation** (`auth.py`): children get `GH_CONFIG_DIR`, scrubbed `GH_TOKEN`/`GITHUB_TOKEN`
  and env-scoped git config (`gh auth git-credential`, SSH→HTTPS). Start is blocked unless
  `gh api user` equals the expected account with push permission. No `gh auth switch`, no global git config.

## Tests

```sh
cd tools/warroom
PYTHONPATH=. .local/venv/bin/python -m unittest discover -s tests -t .
```

CI runs it as a Deep+affected check (`tools/warroom/run-tests.mjs`, paths `tools/warroom`, `war`).
Core tests use only the standard library (the TUI smoke test is skipped without Textual).
They fake GitHub/OpenCode/git and also exercise real `git worktree` and a real detached process.

