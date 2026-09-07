# Typewriter PR Review

Review with the minimum context needed to reach a reliable decision.

Do not reconstruct the implementation process. Review the resulting change.

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
