# Typewriter PR Review

Review with the minimum context needed to reach a reliable decision.

Do not reconstruct the entire implementation process. Review the resulting
change and inspect the minimal upstream producer/validation path when needed
to determine whether the defect can recur.

## Context-efficient review flow

Use this order:

1. Read PR metadata, current head SHA, and the active issue.
2. Inspect the complete changed-file list.
3. Classify the changed surface and read only the applicable review guide(s).
4. Inspect per-file patches, starting with behavior- or architecture-relevant files.
5. Load surrounding source only when a patch cannot be understood safely by itself.
6. Check CI status for the exact reviewed head.
7. Open detailed CI output, additional files, or broader repository context only when needed.

Do not begin by fetching:

- the full PR diff when per-file patches are sufficient;
- complete source files when a patch plus a small surrounding region is sufficient;
- successful CI logs;
- generated artifacts already validated by CI;
- unrelated repository documents;
- complete historical PR discussion.

Expand context only when the current evidence is insufficient.

## Review guide routing

- canonical/editorial/schema → `docs/review-data.md`
- search/normalization/ranking → `docs/review-search.md`
- validators/build/SQLite/CI → `docs/review-toolchain.md`
- Chrome/runtime/UI/storage → `docs/review-extension.md`
- external sources/licensing → `docs/review-licensing.md`

Read multiple guides only when the actual behavioral impact requires them.

If a change affects behavior outside its apparent file category, load the
additional guide or source of truth needed for that impact.

## Depth by risk

Do not review every changed file at equal depth.

Review deeply when a change affects:

- architecture or shared behavior;
- canonical data semantics;
- search semantics or ranking;
- validators or CI correctness;
- persistence, permissions, packaging, or runtime boundaries;
- licensing or external data provenance.

Use lighter inspection for mechanical edits, generated output, fixtures,
documentation, or repetitive data when automated validation covers their
relevant properties.

## Automated validation

Trust deterministic CI for the property it validates on the exact reviewed
head.

Do not manually repeat passed mechanical checks.

For large data changes, review:

- the rule or generation logic;
- changed editorial decisions;
- representative samples where semantic judgment is needed.

Do not manually inspect the complete dataset when validators cover mechanical
integrity.

Inspect successful CI details only when:

- the validator, fixture, expected result, or CI workflow changed;
- the result conflicts with the implementation;
- the check may not cover the claimed property.

When a repeated manual finding is scriptable, move it into a validator or
regression test so future reviews do not repeat that work.

## Findings

When several failures appear to share one cause, identify and review the root
cause instead of exhaustively collecting every equivalent symptom.

Batch related findings in one review pass.

Prefer a generalized regression or validator for the defect class over many
redundant case-specific checks.

## System-first resolution

A review finding is not resolved merely because the current output was patched.

When a defect can recur, identify the upstream system that produced or
allowed it: producer, builder, validator, fixture, prompt, workflow, or CI
integration. Inspect only the upstream path needed to determine recurrence;
do not reconstruct the entire implementation history.

A recurring or deterministic defect is a blocker if the PR changes only the
current output without changing the responsible system or adding a regression
guard.

Every resolved blocker of this kind must include:

- the smallest fixture that reproduces the defect;
- a generalized invariant or validator rule;
- an automated regression test that fails for the old behavior and passes for
  the fixed behavior;
- execution through the repository preflight or CI path before PR submission.

For generated or staged data, verify the producer and admission boundary, not
only the generated result. A builder that silently converts every proposal
into `admitted/clean`, for example, is a system defect; correcting the affected
records alone is insufficient.

Do not declare the work complete while the new regression is absent,
unexecuted, or disconnected from the preflight/CI gate.

For lexical rules, verify that a generalized invariant applies to all relevant
existing canonical data and automatically to future additions.

Do not accept batch-, record-, or word-specific regression logic when the
defect represents a dictionary-wide or admission-wide rule.

## Follow-up review

Use the previously reviewed head as the baseline.

Inspect:

1. previous blockers;
2. changes from the previously reviewed head to the current head;
3. regressions caused by those changes;
4. newly added changed-file areas.

Do not reread unchanged hunks.

Do not reload the complete historical discussion. Read only previous blocker
threads and review activity needed to understand the current state.

If the current head has not materially changed outside the fixes, do not
restart a full first-pass review.

## Two-reviewer approval gate

Every PR requires two independent reviews on the exact same HEAD.

- Approval state is bound to the HEAD SHA. Any new commit resets it to `0`.
- The first reviewer reviews normally. If no blocker remains and required
  validation passes, record `+1` and do not merge.
- The second reviewer reviews the same HEAD independently. If no blocker
  remains and required validation passes, record `+2` and merge.
- If either reviewer finds a blocker, do not approve or merge. After a fix
  creates a new commit, review restarts from `0`.
- Both reviewers use the same scope and standards. Do not divide review
  responsibility or assume another reviewer already covered an area.

Required sequence: `0 -> +1 -> +2 -> Squash merge`.

## Stop condition

Stop expanding review context once:

- the active issue is understood;
- the complete changed surface has been accounted for;
- the applicable approach has been evaluated;
- no unresolved blocker remains;
- required validation is confirmed.

Do not continue searching unchanged or unrelated areas merely to find
additional minor issues.

When uncertain whether the current context is sufficient to judge correctness
or cross-file impact, expand the context rather than optimizing for token use.
