# Pilot C — serial admission and rejection recovery (#291)

Acceptance issue: [#291](https://github.com/neverworkalone/typewriter/issues/291).
Program: [#258](https://github.com/neverworkalone/typewriter/issues/258).
All timestamps are UTC on 2026-10-05.

**pilot PASS under the owner-resolved review-operation interpretation.** Actual
admission, negative/recovery and full rework paths passed. #307/#308 Stage 1
records explicitly relied on CI, contrary to the Stage 1 operation rule; this
observed process deviation remains recorded. The owner explicitly confirmed in the primary #291 implementation chat on
2026-10-05: “적용: PASS, 절차상 한계 보존.” This resolves it as
non-blocking for downstream independent Stage 2 technical review and exact-head
CI, rather than a Pilot C functional failure. This does not fabricate a clean
CI-independent Stage 1 run or change the general review rule. Phase 2 was not
started in this issue. This agent did not review, request review, approve or
merge its own changes.

Starting master: `2313f3d745fb7bbd22b85d4e348c550b898651bd`.
Ending admission master: `daa86b9111dacfec039ca4ffd8fd21a9627c4621`.
The ending SHA excludes this documentation-only audit PR.

## Acceptance results

| Required path | Result and actual evidence |
| --- | --- |
| Two serial, mechanically faithful admissions, actual merges | PASS: #303 and #308; both review manifests are complete, mapped to their real PRs. |
| Draft before preflight, real claim / attempt linkage | PASS: #303, #305 and #308 metadata starters and real Drafts precede their preflight. |
| Bounded negative path before canonical writes | PASS: honestly labeled safe fault injection on #305, not a genuine lexical defect. |
| Closed unmerged admission / separate merged rejected status | PASS: #305 closed, #306 changed only C000002 review manifest and merged before rework. |
| Pending admission and rejection-status restart, no duplicate allocation | PASS: same #305/#306 returned; second claim returned null and wrong attempt could not adopt lock. |
| Ambiguous orphan remains owner-directed | PASS for bounded read-only API-response injection; actual orphan-ref creation/adoption lifecycle NOT RUN. |
| Full normal Stage 2 rework / original tracking Issue reused | PASS: #301 reopened only after exclusive claim, -r2 branch, all source observations checked in primary context, #307 merged. |
| Reworked batch successfully re-admitted and owned refs released | PASS: #308 merged, actual post-merge CLI verified complete master and released its refs. |
| Full semantic/canonical/search/SQLite gates, exact-head CI | PASS on both final admission heads; current-revision SQLite parent 1 / child 0. No post-merge CI run is implied. |
| Review gates under owner resolution | PASS: same-head substantive +1/+2 and exact-head CI; #307/#308 CI-dependent Stage 1 operation remains an observed non-blocking deviation. |
| New native browser / independent deep two-build run | NOT RUN in Pilot C; no browser-only or Deep CI changes required it. Normal CI is not a deep/manual execution claim. |

## Input lineage and Pilot B ordering

Both Pilot A candidate manifests are complete, originally merged Pilot B
reviews ready at attempt 1. Each contains 12 lemmas: 7 included decisions
(six new entries, one append-sense decision), 5 lexical rejections, zero
candidate holds/deferred rows. Rejections comprise nine duplicate/coverage-only outcomes and one unresolved
lemma-mismatch exclusion (C000001 듣다),
not commonness, writer usefulness or relation-count admission policy.

| Batch | Stage 2 Issue / branch / result PR | Merged starting evidence | Candidate bytes SHA-256 | Original semantic bytes SHA-256 |
| --- | --- | --- | --- | --- |
| C000001 | [#295](https://github.com/neverworkalone/typewriter/issues/295), `claude/stage2/295-C000001`, [#298](https://github.com/neverworkalone/typewriter/pull/298) | 06:50:42; `59165c1e096820198c6d9e4b414f57598eb2965e` | `dc241ea4eea5178224891b93f36c5e8edf9437a03086eb7174befc69df4058a8` | `84e36754117172126d17c88eb21bcc3d7a412b6b5fdc826cd2d2035598914a1e` |
| C000002 | [#301](https://github.com/neverworkalone/typewriter/issues/301), `claude/stage2/301-C000002`, [#302](https://github.com/neverworkalone/typewriter/pull/302) | 08:17:17; `2313f3d745fb7bbd22b85d4e348c550b898651bd` | `facf0dca0537b38a559a433f65a02efd8049a08e9595ad5c5c99b783bf0feb31` | `8f493463c277f8a50e34761485d98ccdfad4f0795b6737e2c1a5ae71568f10df` |

[Pilot B's execution record](https://github.com/neverworkalone/typewriter/issues/290#issuecomment-5990803435)
places the second claim/Issue at 07:30, after PR1's 06:50:42 merge and claim
release. It records the owner's #302 merge despite a remaining Stage 1 -1;
this historical limitation is preserved, not retroactively declared clean.

- Analyzer identity from A: `d39df7c9b0fc175ee2871640a312f38a2de4d356b36df593178c9597924f03cd`.
- Corpus identity: `corpus:50dd0c6c4ecb9250e75c11dde9e854e1b39de14e12d7a7087d2da041d75ef211:c3b2befa1480804bf6c005cb4a43eb7b2e82d6ad7d77790af4dc82b76f4bd1dd`.
- Candidate bytes remain immutable. Stage 3 never rewrote gloss/POS/sense decisions.
  Rework used honest primary-agent self-check, not independent or human lexical QA.
  Permission-gated corpus paragraphs stayed in private local context logs; no raw
  corpus/API text was newly committed. Product-distribution rights are not inferred.

## Actual lifecycle and review / CI evidence

| PR / branch | Runtime sequence | Exact final head / merge | Review and CI |
| --- | --- | --- | --- |
| [#303](https://github.com/neverworkalone/typewriter/pull/303), `codex/stage3/C000001-a1` | Claim C000001-a1 and singleton lock; metadata starter; Draft 08:43:56; same-attempt recovery; admission merge 10:01:54 | head `966044fbd639e9326f449caf8f5a748a52a27e56`; merge `3bcb59ab724765536e606d70783e3d57eb4a256b` | Same-head +1 09:54:31, +2 10:01:38; [CI 37292094129](https://github.com/neverworkalone/typewriter/actions/runs/37292094129) PASS; full local normal before final push. |
| [#304](https://github.com/neverworkalone/typewriter/pull/304), shared recovery repair | Real post-merge REST recovery defect fixed before next attempt; merged 10:20:19 | head `deabb5fbd16009a5954bf357369eb92507eb1662`; merge `8c710631e30c87011af8c9c4656859417da1a10d` | Same-head +1/+2; [CI 37294847236](https://github.com/neverworkalone/typewriter/actions/runs/37294847236) PASS; full local normal before push. |
| [#305](https://github.com/neverworkalone/typewriter/pull/305), `codex/stage3/C000002-a1` | Real claim, starter, Draft 10:21:47; safe injection before allocator/canonical writes; closed unmerged 10:21:59 | starter `e6b478701d551927f9e36729fa344829112ae0fa`; no admission merge | Deliberate non-merging lifecycle, not a lexical quality failure or final CI PASS. |
| [#306](https://github.com/neverworkalone/typewriter/pull/306), `codex/stage3-status/C000002-a1` | Status-only PR 10:26:50; merged 10:35:40; then actual recovery CLI at 10:39 | head `58aaf37b74d9da1c70802af6647ab0914986cff2`; merge `ea97d4245e9a8e6ee772fde6cf23bd6b198e4034` | +1 10:32:22, +2 10:35:13; [CI 37296638066](https://github.com/neverworkalone/typewriter/actions/runs/37296638066) PASS; full local normal before push. |
| [#307](https://github.com/neverworkalone/typewriter/pull/307), `codex/stage2/301-C000002-r2` | Stage 2 claim before #301 reopen 10:40:28; full rework; merged 11:17:52; shared release verified master ready/attempt2 | head `9d2d756b3b6fb72f58682ab57c688548af0b2827`; merge `fd8f3e8c45d8e698643fdf7d36dbb156bccb2786` | +1 11:06:42 explicitly relied on CI; procedural -1 11:11:47 withdrawn with +2 11:17:31, without a new Stage 1 run; [CI 37299685264](https://github.com/neverworkalone/typewriter/actions/runs/37299685264) PASS; full local normal before push. |
| [#308](https://github.com/neverworkalone/typewriter/pull/308), `codex/stage3/C000002-a2` | Claim after #307 merge; metadata Draft 11:19:12 before preflight; same PR final admission; merged 11:41:54; actual post-merge worker released owned refs | head `9252532937b7f2ca435af39bd9567fac0f7b77ec`; merge `daa86b9111dacfec039ca4ffd8fd21a9627c4621` | +1 11:37:11 explicitly relied on CI; +2 11:41:07 acknowledged operation caveat; [CI 37303173525](https://github.com/neverworkalone/typewriter/actions/runs/37303173525) PASS; full local normal/clean checkout before push. |

C000001 initial lock `2076a1f3026ce528bba73b7266a6e64ca541924e`, attempt
`refs/heads/stage3-claims/C000001-a1`, starter
`5775353650e22b8a8ad911b97ff8cde26eeb45b3`. Its release used detailed merged
PR/master verification after the original recovery CLI failed closed.
C000002 attempt1 lock `cff16bf096c27fd0742d8066a89a81219d7e10e7`, attempt2
lock `4ecc73eaa86eb75ecb8f527220f1151b8d860993`; each had its own atomic
`refs/heads/stage3-claims/C000002-aN`. Actual REST `merged_at` recovery released
attempt1 only after #306 and attempt2 only after #308. Rework's exclusive
`refs/heads/stage2-claims/C000002` was based on ea97d424 before
[the #301 claim comment](https://github.com/neverworkalone/typewriter/issues/301#issuecomment-5992831306).
Final remote inspection found no remaining stage claim/lock refs. Completed
branches were safely cleaned and monitors deleted; no next production batch began.

Starter-only +1/-1 on #308 bound `df6efe374ce3ba37032a5ec06b22621282bf46a6`.
The -1 identified missing final admission and temporary-marker CI failure,
not a lexical defect. It became stale when the same PR received actual admission;
its final same-head +2 explicitly confirmed resolution. Starter CI failures
are not final-admission gate evidence.

## Negative / restart evidence

`STAGE3_PILOT_SAFE_FAULT_INJECTION` was explicitly labeled and thrown before
allocator/canonical writes. #306 changed only the review manifest to rejected,
`rejected_pr=305`, history `{attempt:1,rejected_pr:305}`. It became authoritative
only at merge; no invalid canonical data or reserved IDs were discarded.

- 10:21:56 actual pending recovery: `resume-admission`, same #305; second claim
  null; attempt2 could not adopt attempt1's live lock.
- 10:26:56 actual pending status recovery: `await-rejection`, same #306; second
  claim null. No second PR/attempt/ID allocation.
- Canonical tree stayed `1e7ee2f05e494674fd0758e6f44d19fe2e03f69b` throughout.
- 10:27:32 read-only API-response injection added a hypothetical orphan claim
  to the query result. Recovery required owner intervention; real refs/lock were
  unchanged. This is not real orphan creation or adoption evidence.
- Post-merge CLI returned `rejection-merged` on #306 and `admission-merged` on
  #308, verified current master and released only owned refs.

Local negative and prospective evidence is retained in private temporary files;
public PR #306 and this report preserve the bounded outcomes. Synthetic unit
regressions are not substituted for these real GitHub lifecycle paths.

## Full source-bound Stage 2 rework

Primary Codex re-read all 12 lemmas, 12 usage groups and 32 observation references
using the permission-gated local index with the original input/logical-row
identities. All ambiguity/lemma-mismatch observations were checked. Public
reasons are original text-free analysis. Original lexical payloads were retained;
reasons and observation mapping were checked anew, with `codex-agent-self-check`
provenance. Rejected attempt1 history remains intact at attempt2 complete.

| Lemma | Observation checks / disposition |
| --- | --- |
| 만나다 | o01–o03 verbal contact with people, existing w188-s1; duplicate rejection with separate coverage route. |
| 만들다 | o02 caused action/state distinct from production: append sense; o01/o03 existing w5362-s1 coverage. |
| 많다 | o01–o03 quantity/frequency/degree in w5361-s1; no new sense. |
| 맞다 | o01/o02 proposition affirmation, o02 checked with neighboring dialogue; o03 preference fit; two senses. |
| 먹다 | o01–o03 food ingestion in w11382-s1; duplicate rejection, coverage retained. |
| 모르다 | o01/o02 lack of knowledge; o03 possibility explicitly bounded to -ㄹ지도 모르다; single-observation limitation retained. |
| 모습 | Correct o01/o02 to action/state aspect w5351-s2; o03 appearance w5351-s1; no new sense. |
| 보내다 | o01 spatial movement; o02/o03 passage of time; two senses with separate binding. |
| 보이다 | o01/o02 adjective and o03 noun+으로 support perceived impression; corrected adjective-only rationale, one sense. |
| 볼 | o01 counted cooking vessel resolves noun, excludes 보다 modifier/body-part reading. |
| 사다 | o01 object purchase resolves competing occupation-noun reading. |
| 사람 | o01–o03 individual humans w5360-s1; no additional sense for origin/number. |

Pinned Kiwi 0.24.0 hand-off was actually rebuilt byte-identically, digest
`7e2637cc1b03827f6fd4333672a2b3cac86b2ab434ca3f1f1b2a1ecf159d834e`.
Original Stage 1 ensemble was not rewritten. Fresh semantic decision bytes:
`aae95f5a8ffac4f710c6997821bf22b4d942acb76aa6c21499eee1d2aa1c7c91`.
At 10:48:24 a pure prospective complete-12,216-record validation passed in memory
with explicit synthetic required PR metadata; it reserved/wrote no final IDs.
That preview alone was not real successful admission; #308 later supplied it.

## Systemic failures and shared fixes

Sound lexical decisions were not rejected to work around tooling failures.
#303 repaired shared rule-dictated inflection dispositions and retain-all
collisions, fail-closed judgment gaps, append-sense promotion bindings,
source-bound inventory creation, hash-bound pre-factory historical views,
closed nested durable admission artifacts and dependent live-report refresh.
Historical payload/promotion-prefix checks and full-current semantic/surface
validation remain enforced. Existing report order is #210 inventory → #219 →
#220 → #222; original source snapshots/rejections are preserved.

The strict SQLite builder exposed CI-before-commit sequencing. Shared workers
now commit locally, run full normal CI, then push, preserving a clean local
checkpoint across recovery and refusing dirty/divergent overwrite. Earlier
implementation revisions were pushed before full local CI completed: an actual
sequencing mistake, not erased by later success. From final #303 onward every
implementation push had full local normal PASS first.

#304 fixed actual REST list recovery (`merged_at`, not only `merged`) with a
generalized admission/status regression retaining closed-unmerged blocking.
#308's first local admission `60bff39...` failed the remaining #211 frozen import
comparison after a legal w5362 append. It was not pushed. Shared hash-bound
pre-factory restoration now also supplies that import view; exact historical
ID/payload checks and current ledger validation are retained. Final `9252532...`
passed the complete normal/clean-checkout gates before push. Synthetic tamper,
unknown-field and judgment-gap regressions supplement, not replace, runtime
paths. No semantic admission bypass or invented historical review was added.

## Ending fidelity and throughput

Post-merge comparison against starting master confirmed unique record IDs,
unchanged existing payloads except the two permitted append operations,
unchanged original sense prefixes, and unique source-candidate/sense mappings.

| Metric | C000001 | C000002 final | Total |
| --- | --- | --- | --- |
| Original candidates | 12 | 12 | 24 |
| Included candidate mappings | 7 | 7 | 14 |
| Lexical rejections | 5 (4 coverage, 1 lemma mismatch) | 5 coverage | 10 |
| Candidate holds / deferred | 0 / 0 | 0 / 0 | 0 / 0 |
| New entries / existing-entry appends | 6 / 1 | 6 / 1 | 12 / 2 |
| Added senses / authored relations | 10 / 0 | 10 / 0 | 20 / 0 |

Canonical records: **12,204 → 12,216**. New IDs w12541–w12552 do not overlap;
existing append IDs are w2797-s2 and w5362-s2. C2 reuses the seven reviewed
source mappings without duplicate negative-attempt allocation. Successful
admission snapshots chain starting → C1 → C2, ending at
`43269c02940ba52619da19cadbcee63268ada4217a5320213fc4c915f047dd73`
(review-manifest canonical snapshot digest; distinct from CI's context digest).
Exact-head normal CI validated complete canonical, semantic/reference integrity,
search coverage, generated projection and SQLite output. Final local log records
one current-revision parent build and zero child builds; other-revision fixtures
are counted separately. No post-merge full-CI repetition is claimed.

First real Draft to last admission merge: 08:43:56–11:41:54, **2h57m58s**,
including repairs, QA and review/owner wait. Gross elapsed throughput is about
4.0 new entries/hour (6.7 added senses/hour); this small acceptance exercise is
not a production-throughput forecast. Final documentation publication/review is
outside that interval. Functional paths have concrete PASS evidence. Overall **pilot PASS** uses the
owner resolution above, while preserving the Stage 1 process deviation. No
Phase 2 execution was initiated in this issue.
