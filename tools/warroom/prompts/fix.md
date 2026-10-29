PR #{{pr}} (branch `{{branch}}`, current head {{head}}) has new review feedback.

Only an effective blocking `-1` review event calls for a producer response. **Never respond to `+1` or `+2` PASS reviews:** no PR or inline comments, acknowledgments, status messages, commits, or requests for another review. If only PASS events are presented, exit silently without touching files. For a `-1`, make accepted corrections or leave a concise evidence-based disagreement for the reviewer to assess on re-review.

This is a **fresh Stage 2 review-fix session**. Do not resume a production or earlier fix session. Keep the assigned worktree, branch, and current HEAD; never merge, rebase, reset, or switch branches. Do not create another PR, request review, or merge.

Run commands from the worktree root. Use `.warroom-scratch/...` as paths; do not `cd .warroom-scratch`. Create `.warroom-scratch/amend-decisions.txt` with the Write tool. `amend --help` is not implemented; use the command and arguments below.

## Source-bound review work

- **Shared judgment policy for this checkpoint:**

{{s2_policy_card}}

- Assess each review event against the current PR HEAD, the policy card above, and the supplied `source_context`. The context contains only candidate pairs explicitly selected by the review plus full-Sense fallbacks for clearly targeted but unidentifiable candidates; its Q rows are comparison context, not extra review targets.
- Use the supplied context first. If a concrete finding still lacks necessary source or target information, use one narrow read-only `inspect` for only the required Sense or candidate. Do not reread docs or scripts, and do not inspect each candidate separately.
- Make semantic judgments yourself. Apply all accepted candidate changes together in one `.warroom-scratch/amend-decisions.txt` file and run:

  `node scripts/relation/admission-cli.mjs amend --checkpoint .warroom-scratch/relation-admission-{{shard}}-{{batch}}-{{part}}.json --in .warroom-scratch/amend-decisions.txt`

  The file starts with `amend <sorted source sense IDs> @<inspect digest>`, followed only by sparse `c<n> R ...` or `c<n> D <reason>` rows from the matching inspect view. Use the exact target row form shown by the checkpoint policy. Do not amend one finding at a time.
- Obtain the amend header's digest and every `c<n>`/`T<n>` alias from **one inspect view that includes all Senses being amended**. If another Sense is needed, inspect the union of the original and added Senses again; never mix aliases or a digest from separate per-Sense views.
- Never edit the checkpoint, Relation JSONL, or Drop JSONL directly. Do not dump the full checkpoint with `rg` or `cat`, and do not dump large docs or scripts.
- After an amend, run local Part verification in the foreground with a tool timeout of at least 600000 ms when supported, then inspect the command's exit code directly. If the environment does not support that timeout, use its longest supported foreground timeout; do not switch to background execution, Monitor, or ScheduleWakeup. Use this exact command:

  `node scripts/relation/admission-cli.mjs verify --shard {{shard}} --batch {{batch}} --part {{part}} --json`

  Do not pipe verification through `tail` or hide its exit code. The Supervisor will also verify the exact pushed PR HEAD in a separate checkout.
- If you disagree with a finding, explain the evidence in a PR comment without changing files or making a new commit. If there are no file changes, do not create an unnecessary commit.
- Reply to review comments through the existing `gh` CLI authentication using the injected `GH_CONFIG_DIR`; do not use GitHub MCP for replies.
- Group all accepted feedback from this review batch into one amend and one commit, then push to this same branch. Keep the one Part `verify` above. After the push and concise replies that include the review event keys, stop; do not run unnecessary `gh pr checks` or re-fetch reviews with `gh api .../reviews`. The Supervisor separately verifies the exact pushed HEAD.

## Review events

{{review_events}}

## Bounded source context

{{source_context}}
