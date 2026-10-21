# War Room

Typewriter production supervisor MVP (Issue #1338). `./war` at the repository root opens a
terminal situation board (Textual) over a persistent **Supervisor** that runs an AI producer
(OpenCode / DeepSeek / #860 **A**), watches its PR (review → fix → `merged=true`) and removes
only the worktree and branch it owns afterwards.

```text
./war  ──tmux session "warroom"──▶ TUI (view + commands, writes SQLite only)
                                   tmux session "warroom-supervisor" ──▶ Supervisor loop
                                        ├─ OpenCode subprocess (detached, own process group)
                                        ├─ gh (isolated GH_CONFIG_DIR), git worktrees
                                        └─ SQLite state: tools/warroom/.local/warroom.db
```

Closing the TUI or detaching tmux never stops the Supervisor or the AI. If tmux dies, `./war`
restarts the Supervisor, which resumes from SQLite + GitHub + git worktrees; it never
re-produces or opens a second PR when the situation is unclear (state `ERROR`, everything kept).

## Setup

1. `brew install tmux` and have `opencode` installed. `./war` creates `.local/venv` (Textual) on first run.
2. Log the producer account in **without touching your own gh/git setup**:
   `GH_CONFIG_DIR=tools/warroom/.local/gh gh auth login` (expected account `neverworkalone-agent`).
3. Optional `tools/warroom/.local/config.json` (see `config.example.json`): model IDs
   (`models.free`, `models.go`), git author for the producer, quota patterns, polling.
   `models.free` is **required**: Start is blocked unless it is installed (`opencode models`) and
   matches `free_model_pattern` (default `-free$`); OpenCode's implicit default model is never used.
   An empty `models.go` disables the Go switch (quota exhaustion then pauses).

`.local/` (config, DB, logs, auth, worktrees, venv) is git-ignored; never commit tokens/logs.

## Factory Board · Production Lines (Issue #1353)

A **Line** = (logical model, method A/B/C/D). `Factory → Model → Line → Batch history → Run history`.
The model registry is config (`producers` in `config.json`, any number of models, see
`config.example.json`; without it the legacy `worker`/`models` is one entry). Each Line owns at most
**one** unfinished batch (`Store.create_batch` refuses a second one; Start on an occupied Line is
rejected). Lines are independent: batch/PR/HEAD/session/PID/worktree/runs/errors/retry/tier/drain are
per Line, and an exception or a long review wait in one Line never stalls another. Registering the same
logical model twice (duplicate id or shared endpoint ID) is blocked.

- **Board**: one column per registered model, fixed A/B/C/D slots (3-line fixed-size cards: `Method · batch`
  + phase icon / phase + observed `N/500` / `PR #n` + last activity; empty slots are dim grey, COMPLETE cards
  stay). Clicking any card (even an empty slot) only opens its Batch Detail. New work starts only from the
  one-row top bar `[CLI] [Method] [Single|Continuous] [Start] [Drain All] [Stop All]` (Selects are sized to their longest label, the three buttons share one fixed width; narrow terminals wrap it into
  a grid). The CLI/Adapter list comes from the registry (Codex, Claude, OpenCode first); the model Select appears
  only when one CLI hosts several logical models, so Start never guesses a model. **Single** = one batch
  then stop; **Continuous** = consecutive batches in the *same* Line (never parallel batches in one Line).
  The board shows no always-on Supervisor status; a stopped Supervisor, auth/model problems and Drain All stay visible.
- **Drain** (Line) / **Drain All** (Factory): stop assigning new batches, the current batch continues
  through review/merge/cleanup. Either one blocks a Line; Cancel Drain (All) leaves Line drains alone.
- **Stop** / **Stop All**: red (Stop All is disabled while no Line has an unfinished batch or run flag), y/N modal (Enter/Esc = No). Stops the AI of the scope, preserves
  worktree/branch/PR, clears the run flag so nothing restarts; **Retry** (PAUSED/ERROR only) reuses
  the same batch.
- **Batch Detail**: short header (`OpenCode / A · 009_02`, phase, PR, observed progress, time); SHA, session,
  tier and worktree (a cleaned-up one is labelled as a past path) are under *Metadata / Details*. The Agent Log is
  a readable rendering of OpenCode JSON Lines (`logrender.py`, per line, so the incremental `tail -f` read by byte
  offset is kept; unknown events and non-JSON lines are shown as-is); **Raw Log** switches to the verbatim file.
  Secrets are redacted in both. Run History (`runs` table) and a separate Audit Log stay. **Auto-scroll**
  (default ON, off on manual scroll-up) is shown only for a still-running log. Esc returns to the board. `s` opens Settings.
- **SQLite**: additive migration (`PRAGMA user_version=2`) adds `lines`, `runs`, `events.line`; the
  legacy single-worker `kv` controls become the controls of that Line and old `batch-<id>-<ts>.log`
  files are imported as runs. No row or log is deleted or rewritten.

## State machine (one batch = one atomic unit)

`PREPARE → PRODUCING → WAITING_REVIEW ⇄ FIXING → MERGED → CLEANUP → COMPLETE`, plus
`PAUSED` (recoverable, operator Retry) and `ERROR` (safety stop; worktree/PR preserved).

- **Batch choice** (`batches.py`): earliest A/DeepSeek batch whose Candidate file is absent on
  `origin/master`, not claimed by an open PR (same method+model) and not owned by War Room. A
  master file with the wrong record count is reported, never skipped or regenerated.
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
