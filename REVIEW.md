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

CI must remain nested: `ci:fast` (early), `ci:normal` (full merge), `ci:all` (deep). A single normal run may include the fast checkpoint without a second full-canonical run; independent two-build reproducibility belongs in deep/manual. If a Deep CI or deep regression changes, require successful **`Deep CI Gate` on this exact HEAD** (`ci:all`); otherwise its passing skip gate is sufficient.

## 6. Review record — Stages 1 and 2

Post a GitHub **`COMMENT` on the exact commit SHA**, with: `+1` or `+2` (only when passing), issue/acceptance scope, checked approach and material boundaries, blocker/fix evidence or explicitly none, exact-HEAD tests/CI, unrun checks and uncertainty, and a clear conclusion for **this SHA**. Prefer evidence flows to filename inventories. A blocker means **no pass marker**; explain impact, safer correction and how to validate it. Never `APPROVE` just to mark review completion.

## 7. Stage 3 — reviews of reviews and merge

Check the active issue, changed-file names, same-HEAD sequential **independent, evidence-bearing** `+1`/`+2` reviews, blocker/fix history and exact-HEAD validation. Confirm both reviews covered the real approach and systemic risk, not just markers. Perform **one targeted adversarial probe** of a material unverified assumption (e.g. requirement → evidence → enforcement → known-invalid regression); do **not** perform a third full review.

If any gate is stale, incomplete or disproved: comment with the blocker, **do not merge**. Otherwise **squash-merge that exact PR using the expected HEAD SHA**. No `+3`, no `APPROVE`.
