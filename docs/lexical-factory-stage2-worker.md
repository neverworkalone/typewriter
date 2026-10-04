# Stage 2 claim and session worker

The Stage 2 command implements the GitHub claim and tracking portion of the
factory. The active primary agent performs the full lexical authoring and
source-bound semantic QA in its own context, then opens one result PR. It does
not start a second batch until that PR is merged.

## Claim one batch

After this worker has merged to master, start from a clean Typewriter checkout
with origin/master available and run:

    npm run factory:stage2 -- --agent codex

The agent flag defaults to codex; claude is also supported. The repository is
inferred from the origin GitHub remote. Set GH_TOKEN or GITHUB_TOKEN, or
authenticate the GitHub CLI for github.com. The token needs permission to
create and delete repository Git refs and to create or update Issues.

The command fetches master, confirms the local commit matches GitHub's current
master, and validates all candidate and review artifacts at that commit using
the shared factory validators. It then:

1. selects rejected review batches in ascending batch ID order, followed by
   created candidate batches in ascending batch ID order;
2. skips existing claim refs and atomically creates
   refs/heads/stage2-claims/C… at the observed master SHA;
3. reuses the unique prior tracking Issue for a rejected batch, or creates a
   new Issue for a created batch;
4. creates codex/stage2/<issue>-<batch> (or -rK for rework) from that SHA.

An empty result means no unclaimed Stage 2 work is available. The command does
not poll for future work. Use --dry-run to validate and print the next batch
without creating a ref, Issue, or branch.

## Complete the batch in the same primary context

For the claimed batch, reuse the existing intake, semantic decision,
self-check, sense-boundary, hand-off, canonical preflight, and shared admission
contracts listed in §4.1 of lexical-production-factory.md. Preserve all
candidate dispositions and source bindings. Record agent self-check honestly;
do not add human or independent-review claims. Do not modify canonical JSONL or
allocate final w… IDs.

The result PR must update the candidate manifest to complete together with a
ready review manifest, include the complete review artifacts, pass the factory
validator and exact-head CI, and close the tracking Issue when merged. Rework
uses the existing Issue, preserves its history, and advances the review attempt.

While the result PR is open, inspect its state, head, reviews, inline comments,
conversation comments, and CI at five-minute intervals. Apply accepted findings
to that same branch. A closed unmerged PR stops the session. After confirming a
merge on master, run the merge-gated claim cleanup helper, refresh master,
and continue to the next batch. If no unclaimed batch remains, report and stop
without polling.

The library entry points runStage2Session, waitForPullRequestMerge, and
releaseClaimAfterMerge enforce the serial merge gate and cleanup check. The
GitHub client gathers the PR head, review submissions, inline comments,
conversation comments, combined status, and check runs for each poll. The
session runner receives callbacks from the active primary agent for full QA,
accepted feedback, and repository operations; it never launches another agent
or model.

## Recovery

An existing claim ref is never adopted based on GitHub login, branch prefix,
Issue title, or elapsed time. A claim ref without its Issue stays untouched.
Likewise, if a newly acquired ref finds an older Issue for a fresh batch, or a
rework batch does not resolve to exactly one prior Issue, the command stops and
preserves the claim for owner-directed recovery. Failures after claim creation
also preserve the ref. Claim cleanup is allowed only after the matching Stage 2
PR is merged to master and that master contains the expected complete/ready
manifests for the claimed attempt.
