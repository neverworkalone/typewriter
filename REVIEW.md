# Typewriter PR Review

Read this root `REVIEW.md` from the **current PR HEAD** before reviewing. Do not read `AGENTS.md`, personal/global `MEMORY.md`, or agent/session memories. Review the **reported problem, approach, implementation, and regressions**. Use the smallest sufficient evidence; correctness overrides speed.

## 1. Select the gate before code inspection

**Stage 1 AI and CI are two independent, parallel first-level reviewers.** Neither waits for the other. Stage 2 independently reviews the implementation, evaluates the **substantive Stage 1 review result**, and independently evaluates CI as the other first-level result; Stage 3 handles the final gate and merge, not another deep code review.

Before selecting the stage, identify the active issue/owner decisions, PR HEAD/base, complete changed filenames, and existing review result markers/SHAs. **Stage 1 must not inspect CI status or logs.** Stage 1 follow-ups additionally inspect every still-relevant earlier blocker from **either Stage 1 or Stage 2**. Stage 2 may check the same-HEAD `+1` marker but must form its independent technical assessment before reading Stage 1's reasoning. **Distinguish review submission from review consumption:** Stage 1 is required to submit the exact Section 6 prefix, but Stage 2/3 do not reject a substantively valid Stage 1 PASS merely because the submitting reviewer formatted that prefix incorrectly.

- **Stage 1:** no valid same-HEAD `+1` → Section 2. Pass `+1` when the focused code/fix review has no outstanding confirmed blocker, **regardless of CI status**. Never merge.
- **Stage 2:** recognizable same-HEAD Stage 1 PASS, no valid `+2` → Section 3. Pass `+2` only after comprehensive independent review **and** verification of substantive Stage 1 evidence and the exact-HEAD CI gate. Stage 2 does **not** audit whether Stage 1 viewed, mentioned or knew CI status/logs; disregard Stage 1 CI claims and evaluate CI independently. For gate consumption, accept a malformed Stage 1 prefix when the review still unambiguously records PASS/`+1`, identifies the exact current 40-character HEAD SHA somewhere in the same review, and contains the required Stage 1 evidence. Never merge.
- **Stage 3:** sequential independent, evidence-bearing same-HEAD `+1` and `+2` plus required CI gate → Section 7. No `+3`.

A new commit invalidates both gate markers, **not previously verified reasoning**; Stage 1 then Stage 2 must review the new HEAD. Bare markers or reviews without evidence are invalid. A shared GitHub account is permitted only for separate review runs/contexts. Never submit `+1` and `+2` together or require GitHub APPROVE.

## 2. Stage 1 — fast code review and all-prior-blocker verification

**Aim for 1–3 minutes on routine PRs, not a deadline. Do not spend ten minutes duplicating Stage 2.** Speed does not justify overlooking a known blocker or claiming an unverified fix.

**NEVER HOLD FOR CI:** Stage 1 must never delay, defer, withhold, or omit `+1` because CI is queued, pending, running, missing, or failed. If the Stage 1 code/fix review has no outstanding confirmed blocker, submit `+1` immediately. Stage 1 must not inspect CI to make this decision; even if CI status is incidentally visible, it must not affect the Stage 1 result. CI success, failure, waiting, and exact-HEAD gate evaluation belong exclusively to Stage 2.

1. **Route once:** initial review = promptly inspect the issue/approach, changed risk surface and obvious structural or potential defects. Follow-up = collect **all still-relevant prior Stage 1 AND Stage 2 blockers**; compare changed HEAD with earlier reviewed commit(s), then check **each blocker** against its root cause, fix, impacted invariants and appropriate shared regression. A Stage 2 `-1` must be verified by Stage 1 on the next HEAD **before any new `+1`**.
2. **Map risk:** identify the material **producer → enforcer/validator → test → consumer/output** boundaries, the most likely failure modes, and any new risk caused by a fix; do not redo an exhaustive whole-PR assessment after every push.
3. **Inspect narrowly:** use file-scoped patches, bounded context, applicable Section 4 guidance, and representative risky lexical/data cases. Confirm that previous blockers were fixed generally rather than by patching only an example.
4. **Quick code/test evidence:** inspect applicable good/bad regression cases and shared test registration; trace a likely invalid input when it materially resolves doubt. **Do not retrieve, inspect or wait for CI status/logs** and do not require `ci:normal` for `+1`. CI runs independently in parallel and is evaluated by Stage 2.
5. **Respond immediately:** confirmed new blocker or any unfixed prior Stage 1/2 blocker → `-1`, with impact, correction and regression requirement; otherwise `+1` and briefly flag plausible but unconfirmed risks for Stage 2. `+1` means only **Stage 1's AI code/fix review** passed; it makes no assertion about CI or overall readiness.

**Avoid:** unscoped whole-PR diffs, repeated complete reviews after small fixes, unrelated docs/history, whole-file dumps, CI logs, recurring scans and repeated equivalent failures. Expand only to address concrete uncertainty or an outstanding blocker.

## 3. Stage 2 — independent comprehensive quality owner

Stage 2 is the **most demanding reviewer**, incorporating the substantive work previously assigned to Stage 3. It independently evaluates the full implementation, challenges Stage 1's **technical reasoning and coverage**, evaluates CI as a second independent first-level reviewer and owns the final technical confidence needed before merging.

1. Verify a recognizable Stage 1 PASS for this exact HEAD, **without first reading Stage 1 conclusions**. Stage 1 was required to emit the exact `+1`/`HEAD:` prefix from Section 6, but that is a submission requirement, not a consumption requirement. If the actual review clearly says PASS/`+1`, identifies the exact current 40-character HEAD SHA somewhere in that same review, and contains substantive Stage 1 evidence, treat it as the Stage 1 PASS even when spacing, blank lines, Markdown, or prefix placement are wrong. In a separate context independently review the problem, approach, complete material change surface, shared contracts, canonical/provenance boundaries, potential regressions, failure behavior and testing adequacy. A clean Stage 1 must not narrow this assessment.
2. Revisit earlier Stage 1 and Stage 2 blockers and their fixes. **Verify that Stage 1 checked every outstanding blocker, including all previous Stage 2 `-1` findings.** After forming the independent assessment, read Stage 1's evidence; challenge missed risks, insufficient fixes and unwarranted confidence. **Review Stage 1 for substantive technical evidence, not for compliance with Stage 1's internal CI-access procedure. Do not investigate, infer or penalize whether Stage 1 viewed CI status/logs. If Stage 1 mentions CI, ignore that CI evidence when evaluating the Stage 1 gate and evaluate CI independently under item 3. A Stage 1 PASS is invalid only when required substantive code/fix review evidence is missing, stale, contradictory or replaced by CI evidence—not merely because the reviewer also saw or mentioned CI.**
3. Evaluate the **independent CI result**: non-documentation or mixed PRs require a successful exact-HEAD `ci:normal`; documentation-only PRs need the successful documented skip gate plus verification of the complete path list. Inspect test coverage and claims, not only the green indicator. A failing, pending, missing or stale required gate blocks `+2`. Only Stage 2 waits for CI if still running.
4. Perform **at least one targeted adversarial probe** of an important assumption (requirement → producer → shared validator/consumer → known-invalid regression). Verify valid/invalid paths, regression registration, future-data applicability, canonical fidelity, and deep/manual evidence when mandated. This adversarial check **moves from Stage 3 to Stage 2**. Do not claim that unrun native/corpus/manual tests passed.
5. Submit `+2` **only** if independent technical review, previous blocker fixes, Stage 1's substantive technical evidence, CI adequacy and adversarial probe are satisfactory. Otherwise submit `-1`, identify the systemic cause, safer fix and generic verification. After a Stage 2 `-1`, the committer fixes it and **Stage 1 must verify that fix on the new HEAD before Stage 2 independently follows up**. Stage 2 never merges.

## 4. Risk routing (load only relevant guides)

- Lexical/schema/canonical: `docs/review-data.md`; check accurate gloss/POS/sense, honest `direct` versus exploratory relations; relation enrichment must not gate valid lexical admission.
- Search/ranking/normalization: `docs/review-search.md`; retain meaning, coverage, precedence, deterministic ties and regression behavior.
- Builder/SQLite/validators/CI: `docs/review-toolchain.md`; shared canonical → generated fidelity, deterministic output and common regressions.
- Extension/UI/storage: `docs/review-extension.md` only on relevant changes.
- External source/provenance/licensing: `docs/review-licensing.md`; ensure permitted source use and no copied raw corpus/API material. Respect the owner's public **R&D** workflow decision (#239), but do not treat it as third-party rights clearance or corpus-informed **product distribution** approval. Do not repeat a settled visibility concern as a blocker without **new, concrete** exposure evidence.

For large data batches trace **candidate → source-bound semantic QA → admission → canonical → direct search**. Never let a producer claim its own decisions were independently/human reviewed. M10 B11+ may use **honestly labeled AI producer self-check** without subagents: check lemma/POS/gloss/sense evidence, fail-closed holds, digest/provenance bindings, and shared regressions. Preserve B05–B09 historical contracts/evidence; do not rewrite history. New/rebuilt batches must keep stable IDs/order and correct metadata.

## 5. Validation and blockers

**Stage 1 AI and CI operate independently in parallel. Stage 1 must not check or wait for CI; it may submit `+1` even if CI is pending or failing. Only Stage 2 checks CI and Stage 1's substantive technical evidence before issuing `+2`; Stage 2 does not audit whether Stage 1 accessed or mentioned CI. Stage 3 checks final gate validity, not technical depth.**

A **passing exact-HEAD CI check proves only its tested properties**; Stage 2 must not claim unrun manual/local checks. Stage 2 reads passed logs only if the workflow, validator, fixture or expected behavior changed, or observed code contradicts claimed coverage.

Do not require deterministic validators to prove subjective semantic correctness. Generalize only demonstrably machine-checkable invariants; handle semantic judgment through source-bound editorial QA.

For systemic defects demand **minimal failing fixture → shared producer/validator/admission/search fix → old-fails/new-passes regression → enforcement on existing applicable records and future additions**. A recurring data-only patch, invalid self-issued editorial approval, unresolved shared defect or missing required validation is a **BLOCKER**.

When canonical or CI architecture changes, verify: one shared complete-revision context; global semantic audit before SQLite; downstream checks reuse the context; no redundant whole-corpus parsing/building. Compare claimed parse/scan/build counts to actual wiring.

### PR CI execution and skip policy

- The CI workflow runs on `pull_request` only; a post-merge push to `master` does not rerun `ci:normal`.
- When **every** changed path is under `docs/**` or is exactly `README.md` or `REVIEW.md`, the PR is documentation-only and may skip `ci:normal`.
- Any other path, any mixture of documentation and non-documentation changes, or an empty/unclassifiable change set requires the full `ci:normal`. Check renamed files on both sides; never classify a moved source file as documentation-only.
- The workflow must still complete the usual `Validate and test Typewriter` check successfully for a documentation-only skip, and report explicitly that `ci:normal` was **skipped**, not run.
- **Stage 2** independently confirms the full changed-file list matches the skip decision and requires successful exact-HEAD `ci:normal` for any non-documentation PR. A skip is not valid evidence for those PRs. **Stage 1 does not inspect this result; Stage 3 checks its validity only.**
- All existing fast/normal/deep gates, coverage and one-build invariants remain unchanged **when the normal test actually runs**. A documentation-only skip does not claim those tests or the SQLite build occurred.

CI checks have separate domain ownership and execution policy. Every check must
name its owner, protected contract, one tier (`candidate`, `normal`, `deep`, or
`historical`), and one schedule (`always`, `affected`, or `manual`). New checks
default to Deep. Use Normal only for a current-revision, admission, or product
invariant whose failure must block the same PR. An affected check needs an
explicit repository-relative dependency map; missing or unclassifiable change
paths, empty diffs, renames, and unknown paths must route to the full applicable
gate. Every test file has exactly one owner.

The Issue #464 workflow routes pure Stage 1 artifact PRs through
`ci:candidates` (factory contracts, no canonical SQLite build), ordinary
code/data/mixed PRs through `ci:normal`, and scheduled Deep validation through
`ci:all` (Normal plus current-system Deep, without historical replay). `ci:deep`
selects Deep checks across all domain scopes. A single normal run may expose
the fast checkpoint within the same canonical session; it must not repeat the
audit or SQLite build. PR 3 adds bounded `ci:historical` replay and the
exact-HEAD `Deep CI Gate`. If Deep CI or a Deep contract changes, require a
successful exact-HEAD Deep run; a skipped or scheduled workflow does not
satisfy it.

**One-build invariant (BLOCKER if broken):** every successful `ci:normal` builds SQLite for the exact current canonical revision **exactly once** across parent, subprocesses and nested validators (`parent_current_revision_sqlite_build_count=1`, `child_current_revision_sqlite_build_count=0`, `current_revision_sqlite_build_count=1`), enforced by `scripts/ci/run-category.mjs` at the fast checkpoint, normal-phase completion and final exit, regardless of changed files. Block any PR that adds a second exact-current-revision build in normal, weakens/bypasses/falsifies the guard or its fail-closed ledger (omitted hook, malformed/missing ledger, trusting a caller-supplied revision label), or adds a batch-specific full-canonical replay instead of reusing the shared context/artifact (`scripts/ci/current-revision-database.mjs`). Fixture/other-revision builds are counted separately; current-revision independent reproducibility belongs in Deep, while completed-issue checkpoint replays belong in Historical.

## 6. Review record — Stages 1 and 2

### Mandatory review submission format — strict machine-readable prefix

This section defines what **Stages 1 and 2 MUST WRITE when submitting a GitHub PR Review COMMENT**. The exact two-line prefix is mandatory for the reviewer producing the review; it is not optional guidance.

Stage 1 PASS:
```text
+1
HEAD: <40-character HEAD SHA>
```

Stage 2 PASS:
```text
+2
HEAD: <40-character HEAD SHA>
```

Stage 1 or Stage 2 BLOCKER:
```text
-1
HEAD: <40-character HEAD SHA>
```

**Submission rules — mandatory:**
- The entire first line **MUST** be exactly `+1`, `+2`, or `-1` and nothing else.
- The entire second line **MUST** be `HEAD: ` followed immediately by the full 40-character lowercase hexadecimal SHA.
- There **MUST NOT** be a leading Markdown bullet, title, fenced code block, whitespace, or empty line before the marker.
- There **MUST NOT** be a blank line between the marker and `HEAD:`.
- Put all human-language descriptions, evidence, CI results, blockers and conclusions after the second line. A blank line after the HEAD is allowed.
- Submit exactly one final review result per run.

**Gate-consumption rule — tolerant only for Stage 1 PASS:** Stage 2 and Stage 3 inspect what was actually submitted; they do **not** turn a formatting mistake by the Stage 1 reviewer into a technical blocker. If a Stage 1 review violates the mandatory submission format but the same review still (1) unambiguously communicates PASS or `+1`, (2) identifies the exact current 40-character HEAD SHA somewhere in the review, and (3) contains substantive Stage 1 review evidence, treat that review as the Stage 1 PASS and continue the next gate. Likewise, Stage 2 must not invalidate an otherwise substantive Stage 1 PASS merely because that review mentions or appears aware of CI; ignore Stage 1 CI claims and evaluate CI independently. Do not issue `-1`, request code changes, or demand a Stage 1 resubmission for formatting or CI awareness alone.

This tolerance is deliberately asymmetric: **the producing reviewer must obey the format; later reviewers must tolerate a recognizable Stage 1 PASS when it did not.** Ambiguous intent, missing or stale HEAD identity, missing substantive evidence, or a review tied to another commit is still invalid. Stage 2's own `+2` submission format remains mandatory, and Stage 3 should expect it in canonical form.

**Meanings (documentation only, NEVER part of the first line):** Stage 1 PASS means a fast AI code/fix review passed independently of CI; Stage 2 PASS means a comprehensive independent code review and Stage 1/CI evidence passed; BLOCKER means a failed review.

### Review submission

- Submit the final result as a GitHub pull request review using COMMENT (`gh pr review --comment`).
- Never use `gh pr comment` for the final review.
- Never submit APPROVE or REQUEST_CHANGES.
- Verify the PR HEAD before submission.
- If HEAD changed during review, do not issue a PASS for the unreviewed commit.

### Required review evidence

Both stages: give review stage, issue/acceptance scope, checked approach and boundaries, confirmed blockers and evidence or explicitly none, for blockers their cause/impact/safer fix/required regression, unrun checks/uncertainty and a conclusion bound to this SHA.

- **Stage 1:** briefly record inspected risks, and on follow-up account for every still-relevant earlier **Stage 1/Stage 2 blocker** and its fix. Flag potential issues for Stage 2. **Do not inspect, wait for or claim CI evidence.**
- **Stage 2:** record independent full technical assessment, critique of Stage 1's **technical reasoning and coverage** (including its verification of earlier Stage 2 findings), required exact-HEAD CI success or justified docs-only skip, targeted adversarial probe, regression adequacy and relevant unrun native/manual checks. Do not critique Stage 1's tool usage or whether it accessed CI.

### Result rules

- Stage 1 may issue `+1` as soon as its focused code review and all required earlier blocker-fix checks pass, **whatever CI status is**.
- Stage 2 may issue `+2` only after independent technical PASS, satisfactory **substantive Stage 1 review evidence** and successful required exact-HEAD CI/skip gate. **Submission-format mistakes or Stage 1's access to, mention of, or awareness of CI are not blockers when the Stage 1 PASS is otherwise recognizable and substantive under Section 6's consumption rule.** Stage 2 ignores Stage 1 CI claims and evaluates CI independently. Do not issue `-1` or demand resubmission for formatting or CI awareness alone.
- Either stage issues `-1` for a confirmed blocker. A Stage 2 blocker must be checked by Stage 1 on the next HEAD.
- A Stage 1 PASS must never conceal a known unresolved code/blocker-fix issue; a CI failure alone does not invalidate the independent Stage 1 judgment on that HEAD.
- Only Stage 2 waits for pending required CI. A failed or missing required CI is a Stage 2 blocker, not a reason for Stage 1 to delay.
- A new commit invalidates both passing markers. The new HEAD goes through Stage 1 then Stage 2 again.
- A failed review never authorizes merging.

## 7. Stage 3 — lightweight final gate and merge

Stage 3 is the **merge operator**, not another deep code reviewer. Stage 2 already owns comprehensive review, scrutiny of Stage 1/CI and the adversarial probe. Do not repeat this work.

Verify the active PR/issue and exact current HEAD, sequential independent evidence-bearing Stage 1 PASS and **`+2`** tied to that HEAD, and no later unresolved `-1` or visibly invalid gate. When consuming Stage 1, apply Section 6's tolerant consumption rule: a recognizable exact-HEAD PASS remains valid despite submission-format mistakes. Prefix formatting alone is not a Stage 3 blocker. Check the required CI result remains successful for this HEAD: full `ci:normal` for any non-documentation/mixed PR, or successful authorized skip for an entirely documentation-only PR. Never treat a skipped normal run as executed or passed tests. No post-merge `master` CI run is required.

If a gate is missing, pending, stale, contradictory or failed, **do not merge**; identify the gate to be resolved by the earlier responsible stage. Otherwise **squash-merge this exact PR using the expected HEAD SHA**. No fresh technical review, adversarial probe, `+3` or GitHub `APPROVE`.
