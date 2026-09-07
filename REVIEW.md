# Typewriter — Pull Request Review

This file is the entry point for pull-request reviews.

Its purpose is to route the reviewer to only the review guidance relevant to
the current PR.

Do not read or apply `AGENTS.md` when performing a PR review.
`AGENTS.md` defines implementation-agent workflow, not review policy.

## Review basis

Review the PR against, in this order:

1. the user's current request;
2. the active issue and its acceptance criteria;
3. the review guides applicable to the actual changed surface;
4. the repository sources of truth referenced by those guides;
5. the current PR implementation and validation results.

Do not review against speculative future requirements.

## Before reviewing

For every requested PR review:

1. identify the current PR head SHA;
2. inspect the complete changed-file list;
3. read the active issue;
4. select only the review guides applicable to the changed surface;
5. inspect the current implementation changes;
6. confirm validation for the exact reviewed head.

Select guides from the actual changed files and behavior, not merely from the
PR title or description.

A PR may require more than one guide.

Do not read unrelated review guides.

## Context efficiency

Minimize review context without reducing review coverage.

Prefer this inspection order:

1. PR metadata and current head SHA;
2. complete changed-file list;
3. applicable review guides;
4. per-file patches for the changed implementation;
5. surrounding source or repository documents only when needed to understand
   or validate those changes.

Do not fetch broad repository context, the complete PR diff, full CI logs, or
unrelated files preemptively when narrower evidence is sufficient.

Inspect the complete changed surface, but load detailed content incrementally
by changed file rather than pulling unrelated or already-understood material
into review context.

## Review guide routing

Read [`docs/review-data.md`](docs/review-data.md) when the PR changes:

- canonical dictionary data;
- lexical or editorial schema;
- senses or relations;
- editorial classification, grouping, or ranking semantics.

Read [`docs/review-search.md`](docs/review-search.md) when the PR changes:

- search normalization;
- candidate generation;
- search ranking or ordering;
- homonym or sense-selection behavior;
- search state or search regression behavior.

Read [`docs/review-toolchain.md`](docs/review-toolchain.md) when the PR changes:

- validators;
- import or normalization scripts;
- canonical-data build tooling;
- SQLite generation;
- generated artifacts;
- CI validation itself.

Read [`docs/review-extension.md`](docs/review-extension.md) when the PR changes:

- Chrome extension runtime behavior;
- popup or Settings implementation;
- keyboard interaction;
- packaged SQLite/WASM loading;
- storage, permissions, Manifest V3, or CSP behavior.

Read [`docs/review-licensing.md`](docs/review-licensing.md) when the PR changes:

- external dictionaries, APIs, corpora, or datasets;
- source provenance;
- import-source policy;
- licensing or attribution;
- handling of raw third-party material.

Documentation-only changes require only the guide whose policy or behavior
the documentation describes. If no specialized behavior is affected, this
file is sufficient.

## What every review must determine

Every review must determine both:

1. whether the reported or intended problem is actually solved; and
2. whether the overall approach is valid for the current Typewriter product,
   issue, and architecture.

Do not approve a patch merely because one test or example passes if the
underlying approach creates a broader current failure.

When the approach is flawed:

- explain the root problem;
- explain why the current approach is unsafe, misleading, brittle, or
  inconsistent with current Typewriter requirements;
- recommend a bounded safer direction;
- define how that direction should be validated.

Do not require speculative or unnecessarily general architecture.

## CI and automated validation

Prefer deterministic automated validation over manual re-checking.

When a deterministic CI check covers a property and has passed on the exact
PR head being reviewed, treat that result as sufficient evidence for that
property.

Do not manually repeat the same full-dataset or mechanical validation.

Do not open successful raw CI logs unless:

- the validator or CI check itself changed;
- the result is inconsistent with the reviewed implementation;
- representative semantic review reveals a contradiction; or
- the active issue explicitly requires inspection of detailed output.

A failing check is a blocker when it validates behavior required by the
current issue or applicable review guide.

## First review

The first review of a PR must inspect the complete current changed surface.

Find related instances of the same root cause before submitting findings and
report them together whenever practical.

Do not intentionally use a one-finding → one-fix → one-review loop.

The goal is to minimize review/fix cycles.

## Follow-up review

A follow-up review occurs only when the user explicitly requests another
review.

Use the previously reviewed head as the baseline.

Review:

1. whether previously accepted blockers were resolved;
2. all material changes between the previously reviewed head and current head;
3. regressions or contradictions introduced by those changes;
4. whether the complete current changed-file surface contains new areas that
   were not part of the previous review.

Do not re-read unchanged hunks merely because they remain part of the PR.

For follow-up reviews, inspect the previously reported blocker threads and
review activity added or changed since the previous reviewed head.

Do not reload the complete historical PR discussion unless needed to resolve
current context.

Do not restart an unrestricted search for minor issues in unchanged material
that was already available during the first comprehensive review.

A newly discovered serious current defect may still be reported when it
materially violates the issue, corrupts data, breaks the product or build, or
creates a real licensing failure.

Normal review should converge within the initial review plus one requested
follow-up review. Additional rounds should be exceptional.

## Stale findings

Before repeating an existing finding, confirm that it still exists on the
current head.

Do not report or reimplement a finding that applies only to an older head.

## Regression principle

When a reproducible defect is fixed and the behavior can be usefully checked
by script, add or update automated regression coverage when proportionate.

Do not create brittle or expensive automation merely to replace direct human
evaluation where automation adds little value.

Repeated mechanical review findings should migrate into validators or
regression tests rather than remain permanent manual review work.

## Blockers

A blocker is a current defect that can produce an incorrect, misleading,
unreproducible, legally risky, materially incomplete, or unusable result for
the active issue or current Typewriter product.

Do not treat hypothetical future requirements as blockers.

Separate required fixes from optional future improvements.

## Merge authorization

When the user explicitly asks to review a specific PR, that request also
authorizes merging that exact PR if and only if:

- the current head has been reviewed;
- no blockers remain;
- required validation for the changed surface passes on that head;
- the PR is mergeable into the intended base branch; and
- the user has not explicitly prohibited merging.

Do not request separate merge confirmation once those conditions are met.

If any condition is not satisfied, do not merge.

## Review completion

A review is complete when:

- the requested current scope has been examined;
- the reported problem and the overall approach have both been evaluated;
- current blockers found in that pass have been reported together;
- optional future concerns are separated from blockers;
- the reviewed head is identified;
- required validation is confirmed; and
- no finding is being intentionally withheld to create another review cycle.
