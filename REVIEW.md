# Typewriter PR Review

Read this root `REVIEW.md` from the **current PR HEAD** before reviewing. Do not read `AGENTS.md`, personal/global `MEMORY.md`, or agent/session memories. Review the **reported problem, approach, implementation, and regressions**. Use the smallest sufficient evidence; correctness overrides speed.

## 1. Select the gate before code inspection

Read: active issue and relevant parent owner decisions; PR HEAD/base; complete **changed filenames**; exact-HEAD CI status; prior reviews' **markers and SHAs** (not their reasoning for Stage 2).

- **Stage 1:** no valid same-HEAD `+1` → follow Section 2; submit `+1` only if clean. **Never merge.**
- **Stage 2:** valid same-HEAD `+1`, no valid `+2` → independent review under Section 3; submit `+2` only if clean. **Never merge.**
- **Stage 3:** sequential, independent, structured same-HEAD `+1` and `+2` → Section 7; merge only if clean. No `+3`.

A new commit invalidates both gate markers, **not previously verified analysis**. Each stage must submit a new review on the changed HEAD. Bare markers or reviews without evidence are invalid. A shared GitHub account is acceptable only for **separate review runs/contexts**. Never submit `+1` and `+2` together or require GitHub `APPROVE`.

## 2. Stage 1 — focused evidence sequence

**Target 3–5 minutes for routine reviews, not a deadline.** Never trade away a required check, ignore an unresolved risk, or award `+1` to meet the target.

1. **Route once:** determine **initial** vs **follow-up** from the prior Stage 1 reviewed SHA/outcome. Initial = independently assess the full relevant changed surface. Follow-up = compare `previous-reviewed-SHA..HEAD`; inspect previous blockers, fixes, regressions, newly changed paths and their affected invariants. Expand only for a new approach, dependency or unexamined risk; **do not restart a full review merely because HEAD changed**.
2. **Map risk:** classify changed filenames once. Identify the material **producer → enforcer/validator → test → consumer/output** paths; check whether the approach solves the issue. Account for all changed categories, **not every generated line**.
3. **Inspect narrowly:** fetch file-scoped patches and bounded neighboring lines. Read only applicable guides in Section 4. For large lexical/data diffs inspect risk-directed examples (ambiguous senses, POS, holds) and shared admission gates; rely on deterministic validators for mechanical coverage.
4. **Prove or reject:** trace a likely invalid input through the shared enforcement path. For a changed validator confirm **valid-input success + known-invalid failure** and test registration. Confirm required exact-HEAD checks; do not rerun checks that already prove the relevant property.
5. **Decide and stop:** once approach, affected risks, checks and blockers are resolved, submit the review immediately. For a confirmed systemic blocker, report the common cause, fix and regression rather than hunting equivalent cases. If essential evidence is missing, say what is missing and **withhold `+1`**.

**Avoid:** unscoped `gh pr diff <number>`, repeated base-to-head diffs, whole-file dumps, complete CI success logs, repeated generated-artifact scans, unrelated docs/history, duplicate code reads, or exploratory memory lookups. Expand only to resolve a **specific** uncertainty. If a local base commit is missing, use GitHub's comparison/file patch API instead of retrying impossible local diffs.

## 3. Stage 2 — independent full review

Verify the same-HEAD `+1` marker **without reading Stage 1 conclusions first**. In a separate context, independently assess the issue, approach, changed risk surface, shared contracts, regressions and exact-HEAD checks using Sections 4–5. A clean Stage 1 **does not narrow** this assessment. On a Stage 2 follow-up, revisit that stage's prior blocker/fix delta and impacted invariants; do not assume fixes pass. Only after forming your own assessment may you inspect Stage 1 findings for unresolved disagreements. Stage 2 never merges.

## 4. Risk routing (load only relevant guides)

- Lexical/schema/canonical: `docs/review-data.md`; check accurate gloss/POS/sense, honest `direct` versus exploratory relations; relation enrichment must not gate valid lexical admission.
- Search/ranking/normalization: `docs/review-search.md`; retain meaning, coverage, precedence, deterministic ties and regression behavior.
- Builder/SQLite/validators/CI: `docs/review-toolchain.md`; shared canonical → generated fidelity, deterministic output and common regressions.
- Extension/UI/storage: `docs/review-extension.md` only on relevant changes.
- External source/provenance/licensing: `docs/review-licensing.md`; ensure permitted source use and no copied raw corpus/API material. Respect the owner's public **R&D** workflow decision (#239), but do not treat it as third-party rights clearance or corpus-informed **product distribution** approval. Do not repeat a settled visibility concern as a blocker without **new, concrete** exposure evidence.

For large data batches trace **candidate → source-bound semantic QA → admission → canonical → direct search**. Never let a producer claim its own decisions were independently/human reviewed. M10 B11+ may use **honestly labeled AI producer self-check** without subagents: check lemma/POS/gloss/sense evidence, fail-closed holds, digest/provenance bindings, and shared regressions. Preserve B05–B09 historical contracts/evidence; do not rewrite history. New/rebuilt batches must keep stable IDs/order and correct metadata.

## 5. Validation and blockers

A **passing exact-HEAD check proves only its tested properties**; do not claim unrun manual/local checks. Read passed logs only if workflow, validator, fixture or expected behavior changed, or observed code contradicts claimed coverage.

For systemic defects demand **minimal failing fixture → shared producer/validator/admission/search fix → old-fails/new-passes regression → enforcement on existing applicable records and future additions**. A recurring data-only patch, invalid self-issued editorial approval, unresolved shared defect or missing required validation is a **BLOCKER**.

When canonical or CI architecture changes, verify: one shared complete-revision context; global semantic audit before SQLite; downstream checks reuse the context; no redundant whole-corpus parsing/building. Compare claimed parse/scan/build counts to actual wiring.

### PR CI execution and skip policy

- The CI workflow runs on `pull_request` only; a post-merge push to `master` does not rerun `ci:normal`.
- When **every** changed path is under `docs/**` or is exactly `README.md` or `REVIEW.md`, the PR is documentation-only and may skip `ci:normal`.
- Any other path, any mixture of documentation and non-documentation changes, or an empty/unclassifiable change set requires the full `ci:normal`. Check renamed files on both sides; never classify a moved source file as documentation-only.
- The workflow must still complete the usual `Validate and test Typewriter` check successfully for a documentation-only skip, and report explicitly that `ci:normal` was **skipped**, not run.
- Reviewers independently confirm the complete changed-file list matches the skip decision. For a non-documentation PR, require a successful `ci:normal` for the reviewed HEAD; a skip is not valid evidence.
- All existing fast/normal/deep gates, coverage and one-build invariants remain unchanged **when the normal test actually runs**. A documentation-only skip does not claim those tests or the SQLite build occurred.
CI must remain nested: `ci:fast` (early), `ci:normal` (full merge), `ci:all` (deep). A single normal run may include the fast checkpoint without a second full-canonical run; independent two-build reproducibility belongs in deep/manual. If a Deep CI or deep regression changes, require successful **`Deep CI Gate` on this exact HEAD** (`ci:all`); otherwise its passing skip gate is sufficient.

**One-build invariant (BLOCKER if broken):** every successful `ci:normal` builds SQLite for the exact current canonical revision **exactly once** across parent, subprocesses and nested validators (`parent_current_revision_sqlite_build_count=1`, `child_current_revision_sqlite_build_count=0`, `current_revision_sqlite_build_count=1`), enforced by `scripts/ci/run-category.mjs` at the fast checkpoint, normal-phase completion and final exit, regardless of changed files. Block any PR that adds a second exact-current-revision build in normal, weakens/bypasses/falsifies the guard or its fail-closed ledger (omitted hook, malformed/missing ledger, trusting a caller-supplied revision label), or adds a batch-specific full-canonical replay instead of reusing the shared context/artifact (`scripts/ci/current-revision-database.mjs`). Fixture/other-revision builds are counted separately; independent two-build proofs are allowed only in the deep phase (`independentCurrentRevisionBuilds`).

## 6. Review record — Stages 1 and 2

### Mandatory review format

Every GitHub PR review MUST begin with exactly two lines:

Line 1: Review result
- +1 : Stage 1 PASS
- +2 : Stage 2 PASS
- -1 : FAIL (blocker found)

Line 2: Reviewed commit
- HEAD: <full 40-character SHA>

Rules:
- The result marker MUST occupy the entire first line.
- No text, whitespace, or blank lines before the result marker.
- Use exactly one result marker per review.
- The HEAD line MUST immediately follow the result marker.
- The HEAD must identify the exact commit actually reviewed.
- Do not wrap either line in Markdown or a code block.
- Write review details after these two lines.
- Submit exactly one final result per review run.

### Review submission

- Submit the final result as a GitHub pull request
  review using COMMENT (`gh pr review --comment`).
- Never use `gh pr comment` for the final review.
- Never submit APPROVE or REQUEST_CHANGES.
- Verify the PR HEAD before submission.
- If HEAD changed during review, do not issue a PASS
  for the unreviewed commit.

### Required review evidence

After the mandatory two-line header, document:

- Review stage and issue/acceptance scope.
- Checked approach, implementation, and material boundaries.
- Blockers and supporting evidence, or explicitly none.
- For each blocker: cause, impact, safer correction,
  and required regression validation.
- Exact-HEAD tests and CI results.
- Checks not performed and remaining uncertainties.
- A clear conclusion for the reviewed HEAD.

### Result rules

- Stage 1 submits +1 only when its review passes.
- Stage 2 submits +2 only when its independent review passes.
- Either stage submits -1 when a blocker is confirmed.
- Never issue a passing marker while blockers remain.
- If required checks are still running, wait for their results
  before submitting the final review.
- If required validation remains missing or cannot be
  established, withhold PASS and report the missing
  evidence as a blocker.
- A new commit invalidates previous passing markers.
  Review the updated HEAD before issuing a new result.
- A failed review never authorizes merging.
  
## 7. Stage 3 — reviews of reviews and merge

Check the active issue, changed-file names, same-HEAD sequential **independent, evidence-bearing** `+1`/`+2` reviews, blocker/fix history and exact-HEAD validation. For the reviewed HEAD, accept a successful documentation-only skip gate only after verifying **every** changed path is eligible; otherwise require a successful full `ci:normal`. Do not treat a skipped normal run as passed tests. No post-merge `master` CI run is required. Confirm both reviews covered the real approach and systemic risk, not just markers. Perform **one targeted adversarial probe** of a material unverified assumption (e.g. requirement → evidence → enforcement → known-invalid regression); do **not** perform a third full review.

If any gate is stale, incomplete or disproved: comment with the blocker, **do not merge**. Otherwise **squash-merge that exact PR using the expected HEAD SHA**. No `+3`, no `APPROVE`.
