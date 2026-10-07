# Stage 2 claim and session worker

The Stage 2 command implements the GitHub claim and tracking portion of the
factory. The active primary agent performs the full lexical authoring and
source-bound semantic QA in its own context, then opens one result PR. It does
not start a second batch until that PR is merged.

## Claim one batch

After this worker has merged to master, start from a clean Typewriter checkout
with origin/master available and run it in an interactive session with stdin
left open:

    npm run factory:stage2 -- --agent codex

The agent flag defaults to codex; claude is also supported. The repository is
inferred from the origin GitHub remote. Set GH_TOKEN or GITHUB_TOKEN, or
authenticate the GitHub CLI for github.com. The token needs permission to
create and delete repository Git refs and to create or update Issues.

The command runs the whole serial session until the queue has no unclaimed
batches. It fetches master, confirms the local commit matches GitHub's current
master, and validates all candidate and review artifacts at that commit using
the shared factory validators. For each batch it:

1. selects rejected review batches in ascending batch ID order, followed by
   created candidate batches in ascending batch ID order;
2. skips existing claim refs and atomically creates
   refs/heads/stage2-claims/C… at the observed master SHA;
3. reuses the unique prior tracking Issue for a rejected batch, or creates a
   new Issue for a created batch;
4. creates codex/stage2/<issue>-<batch> (or -rK for rework) from that SHA;
5. hands the branch to the active primary context for full authoring and QA.

The command prints an AUTHOR_STAGE2_RESULT JSON event and waits for the active
primary context to finish authoring, push the result branch, and create its
result PR. Reply on stdin with one JSON line containing the created PR number,
or an action of stop. While the PR is open, each immediate/five-minute check
hands the current head, reviews, inline and conversation comments, and CI to
the primary context. After it handles accepted feedback on the same branch, it
replies with action continue. The runner waits five minutes before its next
check, confirms the merged result on current master, deletes that claim, and
starts the next queue iteration.

A closed unmerged PR stops the session and leaves the claim in place. An empty
queue reports and stops without polling. Use --dry-run to validate and print
the next batch without creating a ref, Issue, or branch.

## Complete the batch in the same primary context

For the claimed batch, reuse the existing intake, semantic decision,
self-check, sense-boundary, hand-off, canonical preflight, and shared admission
contracts listed in §4.1 of lexical-production-factory.md. Preserve all
candidate dispositions and source bindings. Record agent self-check honestly;
do not add human or independent-review claims. Do not modify canonical JSONL or
allocate final w… IDs.

Before it submits, the agent also compares every newly authored gloss (new entries and new senses on existing entries) with the canonical entries of close-form headwords (spelling, voice and one-jamo variants such as 쫓다/좇다, 부딪치다/부딪히다, 잃다/잊다). When an observation is a nonstandard spelling of another canonical headword, its meaning stays under that headword and the observation is rejected with that reasoning; it is never admitted as a new sense of the observed spelling. `scripts/validate/lexical-quality.mjs` (`CONFUSABLE_LEMMA_RULES`) tripwires the unambiguous gloss vocabulary of known pairs for canonical data, admission and Stage 2 decisions; the comparison itself remains a source-bound semantic judgment.

The result PR must update the candidate manifest to complete together with a
ready review manifest, include the complete review artifacts, pass the factory
validator and exact-head CI, and close the tracking Issue when merged. Rework
uses the existing Issue, preserves its history, and advances the review attempt.

The library entry points runStage2Session, waitForPullRequestMerge, and
releaseClaimAfterMerge enforce the serial merge gate and cleanup check. The
GitHub client gathers the PR head, review submissions, inline comments,
conversation comments, combined status, and check runs for each poll. JSON
hand-offs connect these operations to the active primary context; the command
never launches another agent or model.

## Recovery

An existing claim ref is never adopted based on GitHub login, branch prefix,
Issue title, or elapsed time. A claim ref without its Issue stays untouched.
Only a genuine Stage 2 tracking Issue (exact `[Stage 2] C… lexical authoring and QA` title and
the generated body's first line and `Claim ref:` line, see `stage2-issue.mjs`) counts as a prior Issue;
a bare mention of a claim ref in any other Issue, such as an example in a design document, is ignored.
If a newly acquired ref finds a genuine older Issue for a fresh batch, or a
rework batch does not resolve to exactly one prior Issue, the command stops and
preserves the claim for owner-directed recovery. Failures after claim creation
also preserve the ref. Claim cleanup is allowed only after the matching Stage 2
PR is merged to master and that master contains the expected complete/ready
manifests for the claimed attempt.
