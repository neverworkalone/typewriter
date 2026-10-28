PR #{{pr}} (branch `{{branch}}`, current head {{head}}) has new review feedback.

This is a **fresh Stage 2 review-fix session**. Do not resume a production or earlier fix session. Keep the assigned worktree, branch, and current HEAD; never merge, rebase, reset, or switch branches. Do not create another PR, request review, or merge.

## Source-bound review work

- Assess each review event against the current PR HEAD and the Stage 2 contracts in `docs/relation-factory.md` and `docs/relation-editorial-policy.md`.
- Use the supplied `source_context` when it includes the relevant source senses. It is reference material, not a limit on the scope of a valid review finding. If more context is needed, use `node scripts/relation/admission-cli.mjs inspect --checkpoint .warroom-scratch/relation-admission-{{shard}}-{{batch}}-{{part}}.json --source-sense-id <id[,id...]> --format compact`; inspect is read-only. Keep results bounded with `--page` and `--page-size`.
- Make semantic judgments yourself. Apply all accepted candidate changes together in one `.warroom-scratch/amend-decisions.txt` file and run:

  `node scripts/relation/admission-cli.mjs amend --checkpoint .warroom-scratch/relation-admission-{{shard}}-{{batch}}-{{part}}.json --in .warroom-scratch/amend-decisions.txt`

  The file starts with `amend <sorted source sense IDs> @<inspect digest>`, followed only by sparse `c<n> R ...` or `c<n> D <reason>` rows from the matching inspect view. Do not amend one finding at a time.
- Never edit the checkpoint, Relation JSONL, or Drop JSONL directly. Do not dump the full checkpoint with `rg` or `cat`, and do not dump large docs or scripts.
- After an amend, run local Part verification and inspect its actual exit status. Do not pipe verification through `tail` or otherwise hide its exit code. The Supervisor will also verify the exact pushed PR HEAD in a separate checkout.
- If you disagree with a finding, explain the evidence in a PR comment without changing files or making a new commit. If there are no file changes, do not create an unnecessary commit.
- Group all accepted feedback from this review batch into one amend and one commit, then push to this same branch. Reply to each review event concisely and stop.

## Review events

{{review_events}}

## Bounded source context

{{source_context}}
