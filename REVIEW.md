# Typewriter PR Review

This root `REVIEW.md` is the **authoritative gate policy**. Read it from the **latest PR HEAD** before every review; never read `AGENTS.md`, personal/global `MEMORY.md`, agent memories or implementation instructions while reviewing. Review the reported problem **and the validity of the approach**. Use the smallest sufficient evidence; correctness outranks speed.

## 1. Enter and select exactly one stage

1. Identify the current 40-hex PR HEAD, base, linked issue/acceptance criteria and owner decisions, **complete changed-path list**, earlier review markers/SHAs and unresolved blockers. Read this root file **at that HEAD**.
2. **Stage 1:** no valid same-HEAD `+1`; conduct a focused first review or verify **all** still-relevant earlier Stage 1/2 blockers on a new HEAD. **Stages 1 and 2 run independently of CI; Stage 3 alone validates CI before merging.**
3. **Stage 2:** recognizable, substantive same-HEAD Stage 1 PASS, but no valid `+2`; form a separate full technical judgment, then examine Stage 1 evidence. CI is outside Stage 2's review gate.
4. **Stage 3:** sequential independent, evidence-bearing same-HEAD `+1` and `+2`, the appropriate successful exact-HEAD CI gate and no unresolved blocker; verify every final gate and merge only when all pass.

A new commit makes earlier PASS markers **stale**, not previously verified reasoning: Stage 1 must review the new HEAD before Stage 2. Bare markers or evidence-free reviews do not count. The same GitHub account may perform stages only in **separate runs/contexts**; never submit `+1` and `+2` together.

## 2. Stage 1 — quick independent code/fix review

**Aim for 1–3 minutes on routine PRs, not a deadline.** Do not duplicate the exhaustive Stage 2 assessment, conceal a confirmed blocker or claim an unverified fix.

1. Initial review: check the issue, approach, material changed risk, obvious defects and the **producer → validator/enforcer → test → consumer/output** path; inspect bounded, file-scoped patches and relevant valid/invalid regressions.
2. Follow-up: enumerate **every outstanding previous Stage 1 and Stage 2 blocker**, compare the new HEAD to reviewed revisions, and independently check each root cause, complete fix, affected invariant and **shared** regression. A previous Stage 2 `-1` must be checked here before any new `+1`.
3. Expand scope only for a concrete doubt or blocker; avoid entire-diff rereads, unrelated history, full-file dumps, recurring scans or a sequence of duplicate findings. Verify that fixes address the shared cause, not only named examples.
4. **Never inspect, retrieve or wait for CI status/logs.** Pending, failed, missing or running CI must never delay a code-clean `+1`; incidentally visible CI must not affect the judgment. CI claims do not belong in Stage 1 evidence.
5. Submit `-1` for any confirmed new or unfixed earlier blocker (cause, impact, safer fix, shared regression); otherwise submit substantive `+1` immediately and flag uncertain risks for Stage 2. `+1` asserts only that this focused code/fix gate passed, **not CI or merge readiness**. Never merge.

## 3. Stage 2 — independent comprehensive technical gate

Stage 2 owns the **entire material approach and affected risk surface**, previous blocker closure and at least one adversarial challenge; it does not inspect CI or merge.

1. Confirm the same-HEAD Stage 1 PASS **marker/identity only** without first reading its conclusions. Independently inspect the requirement, approach, complete material diff/risk, producer/consumer paths, source and provenance boundaries, canonical/search fidelity, failure/valid paths, regressions and test adequacy. A clean Stage 1 does **not** narrow this scope.
2. Recheck all relevant Stage 1/2 blockers and fixes. **After forming your own technical judgment**, read Stage 1's substantive review and challenge its coverage, reasoning, regressions and verification of previous Stage 2 blockers. Do **not** inspect or penalize Stage 1's CI-tool usage or awareness; disregard its CI claims entirely.
3. **Never inspect, retrieve or wait for CI status, checks, workflow runs or logs.** Pending, missing, failed, stale or running CI must **never** delay or change a code-clean `+2`; incidentally visible CI is irrelevant. Assess the changed CI/validator/test *source and contracts* as part of the technical review, but leave CI execution evidence exclusively to Stage 3.
4. Perform **at least one targeted adversarial probe** (requirement → producer → shared validator/consumer → known-invalid case), checking positive/negative behavior, applicable existing/future records and test registration. One representative probe is the **minimum**, never proof that an entire defect class was audited.
5. **When a concrete systemic defect is demonstrated:** establish root cause and **demonstrably affected population** (matching records, relevant same-source peers, prior reverse links and shared production paths); inspect actual source and **bound target sense/contract** with positive and negative controls. A plausible creative association, broader synonym gloss or minor relevance difference is **not** evidence of a systemic defect. Consolidate genuine class-level findings with a safer fix and shared regression.
6. **On re-review of that demonstrated systemic defect:** independently verify the **identified affected class and resulting changes**, not only earlier examples or a producer's “all checked” assertion. Identify any unverified remainder. Scope work to demonstrated risk, **not a subjective near/association census or automatic repository-wide exhaustive audit on routine PRs**.
7. Submit substantive `+2` as soon as independent technical review, earlier blocker fixes, Stage 1's technical evidence and adversarial/scope validation pass, **regardless of CI state**. Submit `-1` only for a confirmed technical blocker, with cause, impact, safer shared fix and verification; pending or failed CI alone is **not** a Stage 2 `-1`. A Stage 2 `-1` returns to Stage 1 after the fix/new HEAD. `+2` certifies the technical gate only, **not CI or merge readiness**. Never merge or demand GitHub APPROVE.

## 4. Stage 3 — final gate and squash merge only

Stage 3 **exclusively owns CI verification**: verify the current PR/issue and **unchanged HEAD**, sequential independent evidence-bearing Stage 1 `+1` and Stage 2 `+2` for that HEAD, the correct successful **exact-HEAD** CI/skip gate under Section 7 and `docs/review-toolchain.md`, and no later unresolved `-1` or contradictory evidence. Consume Stage 1 PASS with Section 8's tolerance. Classify the complete changed-path list and validate the actual required tier/skip evidence; an unrelated green check is insufficient. If CI is pending, **do not merge**; recheck the CI gate when it is evaluated again, without asking Stage 2 to rerun or reissue `+2`. Failed, missing, stale or invalid CI/skip evidence **blocks merge**, not the technical `+2`; surface an actionable CI failure for correction, with a new HEAD requiring fresh Stage 1 and Stage 2 passes. An uncertain gate or stale review marker also blocks merge; route genuine technical blockers to the appropriate earlier stage.

If all gates hold, **squash-merge using the expected exact HEAD SHA**. No new deep technical review, adversarial probe, `+3`, GitHub APPROVE/REQUEST_CHANGES or post-merge master CI requirement.

## 5. Risk routing — load relevant guides, not every guide

- Lexical data, schema, senses, relations, editorial QA, canonical/admission: **read `docs/review-data.md`** and apply **`docs/relation-editorial-policy.md` as the current owner decision**. Dictionary `direct`/`antonym` demand lexical accuracy; writer-facing `near`/`mood`/`scene`/`sensory`/`action`/`association` are **preserve-first**, judged primarily on same-source/group relevance 1–9, not strict substitutability.
- Search, ranking, normalization, candidate eligibility and ordering: **read `docs/review-search.md`**.
- CI, validators, factory/build, SQLite, generated artifacts and test policy: **read `docs/review-toolchain.md`**.
- Extension, UI, Chrome APIs, MV3, storage and WASM: **read `docs/review-extension.md`** when touched.
- External sources, provenance, licensing or distribution: **read `docs/review-licensing.md`** when touched.

For a data pipeline touching multiple boundaries, trace **candidate → source-bound semantic QA → admission → canonical → direct search** and load each relevant guide. Keep current and historical evidence distinct; do not let producer self-check masquerade as independent/human QA. Apply existing owner decisions, but never infer third-party redistribution rights from public R&D visibility.

## 6. Non-negotiable blocker discipline

For a **shared defect**, demand a real failing example, correction at the common producer/validator/admission/consumer boundary, an **old-fails/new-passes shared regression** and enforcement for **all applicable existing records and future additions**. Reject example-only data patches and batch/word-specific regression memorization. Neither missing required validation nor false provenance/approval evidence can pass.

**Subjective lexical correctness is source-bound editorial judgment**, not an excuse to introduce blanket mechanical synonym validators; a valid entry with zero relations must remain eligible. A dictionary synonym does not require universal sentence substitutability. For exploratory relations, prioritize an intelligible creative path and compare **relevance against existing and proposed peers of the same source sense/UI group**; downrank marginal ideas instead of vetoing them. A subjective category preference or 4-vs-5 band difference is not a `-1`; demand a demonstrated material error or significant, evidenced rank inversion. Respect fail-closed holds/admission and source rights. For CI/canonical architecture changes, preserve one complete-revision context, the global semantic audit before SQLite, shared downstream reuse and the **exact-current-revision one-build invariant**; see the mandatory counters/guards in `docs/review-toolchain.md`.

## 7. Required exact-HEAD CI

- **Docs-only:** every path in `docs/**`, `README.md` or `REVIEW.md` → successful workflow check explicitly reporting the `ci:normal` skip. Any mixed/renamed/unclassifiable path must **not** get this skip.
- **Pure Stage 1 candidate artifacts:** only `data/candidates/C######/{manifest.json,candidates.jsonl}` paths → successful exact-HEAD `ci:candidates`, not SQLite/Normal. Check **all** changed paths; additions outside the allowlist go to Normal.
- **Ordinary PRs:** successful exact-HEAD `ci:normal` with its complete-revision/SQLite gate. A registered Deep dependency adds only its affected exact-HEAD Deep checks after Normal; CI-selection changes and unclassifiable paths use full `ci:all`. `ci:fast` is an internal Normal checkpoint, **not** the Stage 1 candidate gate; normal may not duplicate its audit or SQLite build.
- **New path / missing check:** use the repository's general extension rule in `docs/review-toolchain.md`: an unresolved path remains fail-closed; a verified append-only binding to an existing always-on Normal regression requires Normal only, while affected Deep dependencies require the selected Deep checks. When a contract lacks coverage, demand a shared regression and its real registry/dependency wiring; do not accept an unrelated `ci:all` pass as a substitute for fixing recurrent classification omissions. New registration may not remove or override existing Deep triggers. Check exact-HEAD proof in Stage 3 only.
- **Deep/historical:** use the tier ownership and exact-head triggers in `docs/review-toolchain.md`. A Deep-owned implementation/contract change requires successful **exact-HEAD evidence for each affected Deep check**; scheduled or skipped evidence cannot satisfy that gate. The existing `Validate and test Typewriter` PR check runs Normal plus the selected checks through `ci:pr`. CI runner/registry/workflow/classifier changes and unknown or unclassifiable paths fail closed to full `ci:all`. Registry `dependency_paths` select affected checks; `deep_input_paths` describe their data inputs and do not alone trigger every Deep check. Routine schema-valid lexical/relation data uses Normal and its source-bound validators. Docs-only and pure Stage 1 candidate gates remain unchanged. Historical replay stays separate and does not become weekly Deep by default.

**Stage 3 alone validates actual changed paths and successful exact-HEAD workflow/skip evidence**, not only a green badge; inspect passed CI logs when workflows/validators/fixtures/expected behavior change or code contradicts claimed coverage. Never claim unrun native, corpus or manual checks passed. **Stages 1 and 2 must not inspect, retrieve or wait for CI status/logs.** No post-merge `master` `ci:normal` is required.

## 8. Strict GitHub PR review record (Stages 1 and 2)

Write **exactly one final GitHub PR Review COMMENT** per run (`gh pr review --comment`, **not** `gh pr comment`); never APPROVE/REQUEST_CHANGES. Verify HEAD again before submitting; never PASS an unreviewed new commit.

**Mandatory submission prefix:** line 1 is **exactly** `+1`, `+2`, or `-1`; line 2 is **exactly** `HEAD: <40-character lowercase hex SHA>`. No heading, bullet, code fence, whitespace or empty line before/between these lines. All prose/evidence follows line 2 (a blank line afterward is allowed). A review without substantive evidence is never sufficient.

**Asymmetric Stage 1 PASS consumption:** Stage 2/3 must accept a malformed Stage 1 prefix **only if the same review unambiguously records PASS/`+1`, identifies the exact current 40-character HEAD somewhere, and contains substantive Stage 1 code/fix evidence**. Do not block or demand resubmission solely for formatting or Stage 1 having seen/mentioned CI; disregard those CI claims. Missing/contradictory evidence, ambiguous PASS or stale/wrong HEAD still fails. Producing reviewers (including Stage 2) must themselves use the **strict** prefix.

Both stages record stage, issue/scope, approach/boundaries, actual reviewed evidence, confirmed blockers (or none), uncertainties/unrun checks and SHA-bound conclusion. On `-1`, explain root cause/impact, safer correction and required regression. Stage 1 briefly accounts for **all** prior Stage 1/2 blockers on follow-up; Stage 2 records its independent full technical judgment, substantive Stage 1 critique, adversarial probe and regression adequacy **without CI claims**.
