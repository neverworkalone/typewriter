# Typewriter PR Review

Review the PR's actual problem, approach, implementation, and regression risk.
Inspect the smallest sufficient evidence, not the largest available diff.
Correctness takes precedence over token savings. This file is the review policy;
read it from the **current PR HEAD** before reviewing. Do not use `AGENTS.md`
for PR reviews.

## 1. Determine the review gate first

Read the active issue, PR metadata/current HEAD, complete changed-file **names**,
required exact-HEAD check status, and prior reviews' **markers/SHAs only**.
Stage 2 must not read Stage 1 conclusions before its independent analysis.
Then select one gate:

- **Stage 1:** no valid `+1` for this HEAD -> independently review the
  relevant change, using the focused follow-up route in Section 4 when
  applicable; record `+1` only if clean. Never merge.
- **Stage 2:** valid `+1`, no valid `+2` for this HEAD -> a **separate** independent
  full review; record `+2` only if clean. Never merge.
- **Stage 3:** valid, sequential, structured `+1` and `+2` for this HEAD ->
  review the reviews, perform one targeted adversarial probe, and squash-merge
  if all gates pass. Do **not** perform a third full review.

A new commit resets both gates to `0`. A review on another SHA, a bare marker,
or a review without adequate evidence is not a valid gate record. Never record
`+1` and `+2` in the same review run/context. The same GitHub account may
record them in separate runs; independence is about the reviewer process.
Do not request or wait for GitHub `APPROVE`.

### Stage 1 evidence budget (review method, not a time limit)

Aim for **3–5 minutes** for a routine Stage 1 review by removing redundant
reading and repeated exploration. This is a target, **not** a deadline or a
reason to skip a material risk, pass incomplete evidence, or weaken validation.
Large or unfamiliar changes may need longer.

1. **Route before reading code.** Decide first-pass versus **same-stage
   follow-up** using the previous reviewed HEAD and its outcome. A new commit
   invalidates the gate marker, **not all verified earlier analysis**.
   On a follow-up, start with `previous-reviewed-SHA..HEAD`, old blockers,
   their fixes and tests, and new/affected invariants. Widen only if an
   approach change or uncovered dependency warrants it. Stage 2 remains a
   separate independent assessment; Stage 1 conclusions must not narrow it.
2. **Bound the evidence.** Fetch changed **filenames** once; map each material
   risk to its producer/enforcer/test, then fetch targeted patches and bounded
   surrounding lines. **Never start with `gh pr diff <number>` without file
   scope.** For large data PRs, do not fetch all canonical rows or every
   generated artifact. Read a whole file only if a targeted excerpt cannot
   resolve the question. Do not reopen unchanged hunks already established.
3. **No unrelated context.** Do not consult personal or global `MEMORY.md`,
   agent-memory directories, past session notes, or `AGENTS.md` for PR review.
   Use current HEAD `REVIEW.md`, active issue, the relevant guides, targeted
   code and exact-HEAD validation. Do not reconstruct full commit history
   unless a concrete provenance question requires it.
4. **One proof per invariant.** Reuse passing exact-HEAD deterministic checks
   for the mechanical properties they truly cover. For a shared validator
   change, inspect valid and known-invalid regressions and their CI wiring;
   do not reread the same full tests or recalculate already validated
   mechanical datasets. Investigate contradictions or gaps, not possibilities
   already resolved by evidence.
5. **Stop promptly.** Once approach, affected invariants, material risks,
   applicable tests and exact-HEAD CI are resolved, submit the review without
   another exploratory pass. If a blocker is proven, give its common cause,
   correction and validation instead of hunting equivalent examples. If
   essential evidence remains unavailable, **do not issue `+1`**; state the
   specific uncertainty and what evidence is needed. Never assert success
   merely to meet the time target.

## 2. Full-review procedure (stages 1 and 2)

1. Establish the issue's requirements, boundaries, and whether the **approach**
   solves the real problem; do not limit review to whether the patch runs.
2. Classify all changed paths; load only applicable guides below. Inspect
   per-file patches for producer, validator, test, behavior, and architecture
   changes. Load neighboring source or upstream contracts only when necessary.
3. Trace material invariants across affected boundaries, especially how a bad
   input would be rejected. Inspect tests and verify their execution by the
   required exact-HEAD checks.
4. Review high-risk findings at their producing/enforcing layer. If a problem
   recurs, require a system-wide fix and regression, not a data-only patch.
5. Report blockers as exact-HEAD GitHub review `COMMENT`s (inline when useful),
   or submit the structured pass review for this stage only after required
   validation is confirmed and no blocker remains.

**Do not initially fetch** the complete PR diff, whole source files, successful
CI logs, all generated artifacts, unrelated docs, or historical discussion.
Do not read every line just because every changed file must be accounted for.
Expand context if evidence is missing; do not optimize away necessary review.

**Stage 2 independence:** check that `+1` exists, but independently assess the
whole relevant change before relying on the first review's reasoning. A clean
first review does not narrow second-review scope.

### Risk and data-volume routing

Inspect deeply: shared logic/architecture; canonical semantics; producer and
editorial approval paths; normalization/search/ranking; validators/CI;
persistence/permissions/packaging; external source terms or provenance.

For large lexical/data PRs, examine **producer -> authored semantic decision ->
admission -> shared validation -> output/search**. Inspect changed editorial
judgments and risk-directed samples (e.g., ambiguous senses, POS corrections,
HOLD decisions). Expand samples if they reveal a systematic failure. Use CI or
validators for all applicable mechanical invariants, **not** a manual reading
of every generated line. Mechanical validation is not proof of semantic truth.

A producer must not mint its own editorial approval (`gloss_judgment=fit`,
`status=pass`, etc.) **and call that independent review**. Under the owner's
2026-10-02 M10 operating decision, new lexical batches may use explicitly
labeled **AI producer self-check / semantic QA** with no subagents. Distinct
Claude contexts or reviewer labels do not prove substantive independence.
Review that the new shared producer/validator and generic regressions actually
check the source-bound lemma/POS/gloss/sense evidence, reject invalid or
unresolved cases, preserve honest review provenance and cannot mint *claims*
of independent or human approval. Require historical B05–B09 records to keep
their actual contracts and evidence. This M10 semantic QA rule does not change
the independent Stage 1/Stage 2 **PR code-review** gate. For reusable batch
producers, check stable IDs/order and metadata when rebuilding older batches
with newer batches present and when proceeding to later dates/batches.

### Guide routing (load only when applicable)

- Canonical/editorial/schema: `docs/review-data.md`
- Search/normalization/ranking: `docs/review-search.md`
- Validators/build/SQLite/CI: `docs/review-toolchain.md`
- Chrome/runtime/UI/storage: `docs/review-extension.md`
- External sources/licensing: `docs/review-licensing.md`

Follow impacts across categories when relevant. These guides supply detailed
checks; do not duplicate their checklists here.

## 3. Validation and system-first blockers

Trust a **passing exact-HEAD deterministic check only for the property it
actually tests**; never claim an unrun local/manual check passed. Do not rerun
passed mechanical checks without reason. Inspect success logs/details when a
validator, fixture, CI workflow, or expected outcome changed; the result
conflicts with code; or claimed coverage may be missing.

For validator changes, establish both valid-input success and known-invalid
failure. For recurring defects require:

1. the smallest reproducing fixture;
2. an invariant in the **shared** producer, validator, admission, or search
   system (not a batch/word-specific exception);
3. an automated regression that fails on old behavior and passes on the fix;
4. enforcement through preflight/CI for existing applicable canonical data
   **and future additions**.

An unresolved systemic defect, self-issued editorial approval, missing required
validation, or a data-only correction for a recurring defect is a **BLOCKER**.
Identify cause, impact, safer correction, and how to prove the correction.
Batch related findings; do not exhaustively enumerate equivalent symptoms.

### Canonical and CI architecture changes

When these paths change, verify the complete canonical revision feeds a shared
in-process context; global semantic audit precedes SQLite build; downstream
checks consume the same artifact; current-canonical gates and isolated tests
do not repeatedly parse, scan, build, or transport the entire context.
Check reported parse/full-scan/index/build counts against actual runner wiring.
Changed-only validation may give early feedback, not final coverage.

CI levels must remain nested: `ci:fast` (early), `ci:normal` (merge coverage),
`ci:all` (deep/manual or scheduled, including scale). A PR may expose fast
then continue normal **within one process/session**, not duplicate fresh
full-canonical work. Independent two-build reproducibility is deep/manual,
not a redundant normal gate. If Deep CI or a Deep regression changes, require
a successful **`Deep CI Gate` on this exact HEAD** (`deep-ci` runs `ci:all`);
ordinary PRs can use the passing skip gate.

## 4. Follow-up after a blocker

Compare the latest HEAD against the stage's previously reviewed HEAD. Read
previous blocker threads, the **delta**, fixing commits, regressions, and new
or affected code paths. Recheck the shared invariants reached by the fixes and
exact-HEAD validation; changed producers or contracts may require expanding to
their consumers and previously unaffected tests. **Do not perform another
whole-PR first-pass review solely because the SHA changed.** Old findings are
not automatically resolved; verify the fix rather than assuming it worked.
Even after fixes, issue a **new** structured `+1` or `+2` for the new HEAD.

## 5. Required review record (stages 1 and 2)

Submit a GitHub review **`COMMENT` anchored to the exact commit**, containing:

- `+1` or `+2`, HEAD SHA, issue/acceptance scope;
- what behavior, approach, system boundaries, and material risks were checked;
- blockers and evidence of fixes, or explicitly none;
- exact-HEAD CI/tests and any checks not run or remaining uncertainty;
- explicit conclusion that no blocker remains **for that HEAD**.

Prefer evidence paths (`producer -> semantic review -> admission -> regression`)
to filename inventories. A marker-only pass is invalid. If blocked, report
findings and **do not** mark the stage as passed.

## 6. Stage 3: review-of-reviews and merge

This section overrides the full-review procedure. Check the issue/acceptance
criteria, current HEAD and changed-file list, two **independent, sequential,
structured, same-HEAD** review records, relevant blocker/fix history, and
required exact-HEAD validation. Determine whether the two reviews actually
covered the approach, risks, system fixes, and tests; do not merely count
markers.

Perform **one targeted adversarial probe** of an important unverified shared
assumption, inspecting only the necessary source/test/evidence. For validators,
CI, or evidence, prefer:
`requirement -> evidence -> enforcement -> known-invalid regression`.
Ask whether required enforcement could fail while all reported checks stay
passing. Do not repeat full patches or the whole independent review.

If any gate is stale, incomplete, unsupported, or disproved, report a blocker;
**do not merge**. Otherwise **squash-merge this exact PR** using an expected
HEAD SHA and report the result. Do not create `+3` or `APPROVE`.

## 7. Stop condition

Stop gathering context once the issue and approach are understood, the changed
surface and relevant risks are accounted for, required checks are confirmed,
and remaining blockers are decided. If a material uncertainty remains, obtain
just enough additional evidence to resolve it; do not search unrelated areas.

A reviewer must not turn a previously settled owner decision into a recurring
blocker without new, concrete evidence.
