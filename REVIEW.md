# Typewriter PR Review

Review with the minimum context needed to reach a reliable decision.

Do not reconstruct the entire implementation process. Review the resulting
change and inspect the minimal upstream producer/validation path when needed
to determine whether the defect can recur.

## Context-efficient review flow

This flow is the default for the first and second full-review stages. The third
reviewer uses the dedicated review-of-reviews flow below and descends into
patches or source only when the prior reviews leave a material question.

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

For canonical validation and CI architecture changes, verify that the shared
context is built from the complete canonical revision, that the global audit
still runs before SQLite build, and that downstream checks consume the same
artifact. Verify that current-canonical production gates share the same
in-process context and that isolated fixture tests do not repeatedly transport
the full context. Treat reported parse/full-scan/index/build and context
transport counts as evidence to check against the runner wiring, not as a
substitute for correctness checks. Independent two-build reproducibility is a
deep/manual validation path, not a duplicate normal gate. The public CI levels
must remain nested: `ci:fast` for early feedback, `ci:normal` for the full
merge-coverage continuation, and `ci:all` for scheduled/manual deep checks
including the scale benchmark. A pull-request workflow may expose the fast
checkpoint and continue normal validation in the same process/session; it must
not run fast and normal as separate fresh processes that duplicate canonical
parse/index/build work. Changed-only validation may accelerate failure
feedback but must not become the final correctness gate.

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

## Three-stage review gate

Every PR passes through two independent full reviews followed by a final
review-of-reviews merge gate.

The valid progression is:

`0 -> +1 -> +2 -> Squash merge`

`+1` and `+2` are sequential gate records, not different review depths and
not GitHub approval states. Both full-review stages use the same review scope
and standards.

### Review independence

Independence is a review-process property, not a GitHub-account property.

- The first and second reviews must run as separate reviewer stages, runs, or
  contexts.
- The same GitHub account may record both stages, but one review pass must not
  produce both `+1` and `+2`.
- The second reviewer may confirm that a valid `+1` exists for the current
  HEAD before starting, but must not use the first review's conclusions to
  reduce scope or substitute for its own analysis.
- The second reviewer should complete its independent analysis before using the
  first review record for comparison or follow-up context.

### Required review record

A clean first or second review must leave a structured GitHub review
`COMMENT` anchored to the exact reviewed HEAD.

The record is evidence for the third reviewer, not merely a pass marker. Keep
it concise, but include enough information to show what was actually reviewed:

- gate marker: `+1` or `+2`;
- exact HEAD SHA;
- active issue or requirement reviewed;
- review coverage: the behavioral areas, data paths, system boundaries, or
  invariants actually checked;
- approach assessment: whether the implementation addresses the real problem
  with an appropriate design rather than only patching symptoms;
- key risks or possible blind spots explicitly checked;
- blockers found during the review and how their fixes were verified, or an
  explicit statement that none were found;
- exact-head tests, CI, or other required validation relied on;
- review boundaries or remaining uncertainty, including properties trusted to
  deterministic validation rather than manually repeated;
- final statement that no blocker remains for that exact HEAD.

Prefer review coverage such as
`producer -> semantic review -> selection -> admission -> regression wiring`
over a long list of filenames. The record should explain which risks and
reasoning were checked, not merely which files were opened.

A marker-only comment such as `+1 — No blockers remain` is not a valid gate
record because it does not provide enough evidence for review-of-reviews.

Do not use, request, require, or wait for GitHub `APPROVE`. Do not treat the
inability to self-approve as a reason to stop the review flow.

### First reviewer — independent full review

- Perform a complete review under this `REVIEW.md`.
- Review the reported problem, the validity of the overall approach, the full
  relevant change, regression risk, tests, validation, and systemic causes of
  defects.
- If blockers remain, report them and do not record `+1`.
- When no blocker remains and required validation passes for the current exact
  PR HEAD, leave the structured exact-head review `COMMENT` described above
  with gate marker `+1`.
- Do not merge.

### Second reviewer — independent full review

- Begin only when the current exact PR HEAD has a valid `+1` record.
- Perform another complete independent review under this `REVIEW.md`.
- Do not reduce review scope because the first reviewer recorded `+1`.
  Independently review the problem, approach, implementation, regression risk,
  tests, validation, and systemic causes of defects.
- If blockers remain, report them and do not record `+2`.
- When no blocker remains and required validation passes for the same exact PR
  HEAD, leave the structured exact-head review `COMMENT` described above
  with gate marker `+2`.
- Do not merge.

### Third reviewer — review of reviews and merge gate

The third reviewer does not repeat a full diff review by default. This section
takes precedence over the full-review flow above for the third stage.

Start with:

1. the active issue and acceptance criteria;
2. the current exact HEAD and complete changed-file surface;
3. the structured `+1` and `+2` review records for that same HEAD;
4. blocker threads and fix history relevant to those records;
5. required exact-head CI or validation status.

Review the reviews before reviewing the code.

Determine whether the two independent reviews:

- identified the real problem and evaluated the chosen approach rather than
  only the reported symptom;
- covered the material behavioral and architectural risks of the changed
  surface;
- forced systemic fixes and regression guards where recurrence was possible;
- independently checked plausible blind spots instead of sharing the same
  unsupported assumption;
- verified blocker resolution and required exact-head validation.

If the records are missing, marker-only, materially ambiguous, inconsistent, or
show a coverage gap, inspect the necessary patch, source, data, tests, or
artifacts directly. Expand only far enough to resolve the questionable review
direction or uncovered risk. Report blockers and do not merge while a material
question remains.

If the review direction is sound and the records provide sufficient evidence,
do not reread the complete diff merely to duplicate the first two reviews.
Verify that the final implementation and validation correspond to the reviewed
direction, that all blockers are resolved, and that required validation passed
for the exact HEAD.

When the merge gate is satisfied, squash-merge the PR directly. The third
reviewer does not create an approval record.

### Exact-head gate semantics

Both `+1` and `+2` must refer to the same exact PR HEAD and must be recorded
in that order.

Any new commit makes previous `+1` and `+2` records stale and returns the
gate state to `0`.

Resetting the gate does not require rereading unchanged hunks. For a follow-up
review after fixes, each reviewer may use its own previously reviewed HEAD as
the baseline and apply the `Follow-up review` rules above, while still
producing a new structured gate record bound to the new exact HEAD.

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
