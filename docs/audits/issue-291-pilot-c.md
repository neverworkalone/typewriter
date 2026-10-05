# Pilot C — serial Stage 3 admission and rejection recovery (#291)

Acceptance issue: [#291](https://github.com/neverworkalone/typewriter/issues/291).
Program: [#258](https://github.com/neverworkalone/typewriter/issues/258).
All times below are UTC, 2026-10-05. This report is an execution checkpoint;
**pilot acceptance is incomplete and Phase 2 is not authorized**.

## Merged starting evidence

Starting master: `2313f3d745fb7bbd22b85d4e348c550b898651bd`.
Both candidate manifests are `complete`, both review manifests are `ready`,
attempt 1, with 12 candidate lemmas each. Each review includes 7 candidate
decisions, rejects 5, and has no candidate-level holds/deferred rows. Each
contains six new entries and one append-sense decision.

| Batch | Stage 2 issue / result PR | Result merged | Candidate byte digest | Semantic decision byte digest |
| --- | --- | --- | --- | --- |
| C000001 | [#295](https://github.com/neverworkalone/typewriter/issues/295) / [#298](https://github.com/neverworkalone/typewriter/pull/298) | 06:50:42; `59165c1e096820198c6d9e4b414f57598eb2965e` | `dc241ea4eea5178224891b93f36c5e8edf9437a03086eb7174befc69df4058a8` | `84e36754117172126d17c88eb21bcc3d7a412b6b5fdc826cd2d2035598914a1e` |
| C000002 | [#301](https://github.com/neverworkalone/typewriter/issues/301) / [#302](https://github.com/neverworkalone/typewriter/pull/302) | 08:17:17; `2313f3d745fb7bbd22b85d4e348c550b898651bd` | `facf0dca0537b38a559a433f65a02efd8049a08e9595ad5c5c99b783bf0feb31` | `8f493463c277f8a50e34761485d98ccdfad4f0795b6737e2c1a5ae71568f10df` |

Pilot B's [execution record](https://github.com/neverworkalone/typewriter/issues/290#issuecomment-5990803435)
records the second tracking issue at 07:30, after the first merge. It also
records the owner's merge of #302 despite a remaining Stage 1 `-1` about a
regression; **normal independent review-gate PASS is not claimed for that PR**.
The Pilot C report preserves that limitation.

Both Pilot A candidate manifests bind:

- Analyzer digest: `d39df7c9b0fc175ee2871640a312f38a2de4d356b36df593178c9597924f03cd`.
- Corpus identity: `corpus:50dd0c6c4ecb9250e75c11dde9e854e1b39de14e12d7a7087d2da041d75ef211:c3b2befa1480804bf6c005cb4a43eb7b2e82d6ad7d77790af4dc82b76f4bd1dd`.
- The original manifests and source-bound decisions remain immutable; C does
  not author new glosses, senses or editorial dispositions.

## C000001 attempt 1 — real runtime checkpoint

- Atomic singleton ref: `refs/heads/stage3-active`, initial lock commit
  `2076a1f3026ce528bba73b7266a6e64ca541924e`.
- Atomic attempt ref: `refs/heads/stage3-claims/C000001-a1`.
- Branch: `codex/stage3/C000001-a1`.
- Starter commit: `5775353650e22b8a8ad911b97ff8cde26eeb45b3`; only
  `data/reviews/C000001/attempt-a1.json`, ahead of the starting master.
- Real Draft [#303](https://github.com/neverworkalone/typewriter/pull/303)
  created at 08:43:56 **before** canonical preflight.
- First complete-canonical preflight stopped on an explicit missing
  open-vowel-past disposition for a newly allocated predicate sense. This
  was a **systemic tooling failure**, not a lexical rejection. No invalid
  canonical data was committed; the claim and Draft were preserved.
- Uncommitted preflight output was retained locally as a diagnostic checkpoint,
  then removed from the working tree before resuming the same real attempt.
- Shared repair covers rule-dictated inflection dispositions, retain-all
  surface collisions, immutable original promotion bindings for append-sense
  admissions, and source-bound inventory mappings without invented M5 axes.
- `--resume-batch C000001 --attempt 1` resumes #303 and the same claim;
  no second attempt or second entry allocation was started.

## Remaining acceptance evidence

| Gate | Current evidence |
| --- | --- |
| Two independently reviewed, merged Stage 3 admissions | NOT RUN to completion |
| Successful final search / SQLite fidelity / one-build invariant | Pending complete-canonical preflight and exact-HEAD CI |
| Real admission restart | Same claim / Draft resumed; final outcome pending |
| Controlled lexical/evidence failure before canonical writes | NOT RUN |
| Closed admission PR plus merged status-only `rejected_pr` | NOT RUN |
| Restart while rejection status pending | NOT RUN |
| Full Stage 2 rework using original Issue and distinct `-rK` branch | NOT RUN |
| Reworked batch successfully re-admitted | NOT RUN |
| Ending master SHA / throughput | Pending actual merges; zero confirmed C admissions at this checkpoint |

Synthetic shared regressions exercise fail-closed judgment gaps, no partial
writes, rule-dictated dispositions/collision updates, original promotion
binding preservation, rejected tampering, and digest-bound inventory creation.
These tests are **not real negative/rework lifecycle evidence**.

The resumed preflight passed the canonical/semantic/inventory gates and reached
the strict SQLite builder, which refused the uncommitted prospective tree.
This exposed a second systemic worker defect: CI ran before the admission
commit. The worker now pins a local admission checkpoint before CI, pushes only
a validated checkpoint, and preserves a local ahead-of-remote checkpoint on
restart. Recovery refuses dirty or divergent trees instead of resetting them.
No `allowDirty` build bypass is used.

The next normal run confirmed one parent / zero child current-revision SQLite
builds, then exposed an isolated M5-11 historical test source that retained
future factory events after removing their canonical records. Shared historical
snapshot reconstruction now restores hash-bound pre-admission review rows and
rejects snapshots that do not match the retained history. The same reconstruction
is used by the existing M5-13/14/15 historical base-source paths. The live
semantic source and historical batch artifacts remain unchanged by reconstruction.

A Stage 1 `+1` submitted at 08:58:44 on #303 explicitly applies only to the
starter SHA `5775353650e22b8a8ad911b97ff8cde26eeb45b3`; it is not consumed as
review approval for subsequent implementation/admission commits. The remote
CI failure on `667663c` was the still-present temporary starter's artifact-policy
classification; successful admission removes that starter as required.

The existing #211/#219/#220 frozen-payload checks now reconstruct the original
canonical view from validated factory events and reject any rewrite of the
original identity or sense prefix. Their historical semantic projections also
restore the preserved original review rows. #219/#220 keep all current lexical
admission gates enabled; a scoped copy of already-reviewed surface evidence
removes only candidates absent from the historical record set, with strict
collision matching still enforced. No replay/disposition bypass was added.

The #219/#220 report producers passed after refreshing their explicitly live
canonical/search/SQLite checkpoint fields. Their original authored decisions,
counts and source lineage remain intact. Stage 3 now invokes these existing
report producers so subsequent admissions do not leave stale live reports.
Standalone report reproduction remains separate from the normal CI shared
one-build gate; it is not reported as a real lifecycle or independent review.

Normal CI next reached portable #222 report regeneration, exposing its live
#210 recovery-inventory dependency: the stored count was 12,204 while the
prospective dictionary had 12,210. The existing #210 inventory and #222 report
producers regenerated these live fields successfully. Stage 3's refresh order
is now #210 inventory → #219 report → #220 report → #222 report; all eight
existing dependent outputs are included in its commit. Historical decisions,
source snapshots, original rejected/held evidence and historical admission
counts are preserved. The shared worker suite passes 33 tests at this checkpoint.

The following normal run passed portable #222 regeneration and reached the
surface-form suite. A pinned M6-3 case still expected the pre-factory sense set,
so the legitimate append-sense admission added an unexpected candidate to its
literal historical list. The test now retains strict full-current projection,
class and collision coverage, and checks the pinned cases on the hash-bound
pre-factory view. All 11 surface-form tests pass. This changes a historical
fixture boundary; it does not suppress a current dictionary candidate.

The subsequent full local normal run passed the batch and product gates but
failed the artifact-policy suite: the canonical decision source producer added
`factory_admissions` without extending the closed durable contract. The shared
policy now explicitly bounds admission events, mappings, changes and retained
pre-admission snapshots. Preserved semantic reviews reuse the same closed field
contract as current compact reviews; original record/sense/relation fields are
closed as canonical records. A synthetic regression rejects unknown fields at
every nesting level and invalid attempt types. Whole-source semantic audit still
checks event hashes and the current canonical binding separately.

Implementation commits were previously pushed before the complete local normal
run finished. This was a validation sequencing mistake. From this checkpoint,
subsequent implementation changes remain local until the complete `ci:normal`
passes on their committed revision; targeted passes do not authorize a push.

## C000001 actual admission merge

PR #303 merged at 10:01:54, merge commit
`3bcb59ab724765536e606d70783e3d57eb4a256b`. Exact head
`966044fbd639e9326f449caf8f5a748a52a27e56` passed full local normal CI
before push and GitHub run 37292094129; Stage 1 +1 at 09:54:31 and
Stage 2 +2 at 10:01:38 bind that same head. Master records C000001 complete,
with six new records and the reviewed existing-record sense append.

The actual post-merge CLI restart failed closed because recovery checked the
REST list's absent `merged` flag without its present `merged_at` timestamp.
The separate existing release function fetched PR #303's detailed merged state,
verified its branch/master and complete admission manifest, and safely removed
its own branch and both owned claim/lock refs. Local master fast-forwarded to
the merge. This was a systemic recovery defect, not a lexical rejection.
Shared recovery now recognizes either API merge marker for admission and
rejection status. A synthetic API-shape regression also keeps closed-unmerged
status PRs blocked. That regression is not reported as a real negative pilot.
C000002 has not been claimed while this repair is pending.

## C000002 controlled negative path and real rejection merge

The recovery repair [#304](https://github.com/neverworkalone/typewriter/pull/304)
merged at 10:20:19 as `8c710631e30c87011af8c9c4656859417da1a10d` after
exact-head Stage 1 +1, Stage 2 +2 and CI run 37294847236. Its monitor was deleted.

On that master, the real serial gate acquired
`refs/heads/stage3-claims/C000002-a1` and singleton lock
`cff16bf096c27fd0742d8066a89a81219d7e10e7`. Metadata-only starter
`e6b478701d551927f9e36729fa344829112ae0fa` opened real Draft
[#305](https://github.com/neverworkalone/typewriter/pull/305) at 10:21:47.
This is **bounded safe fault injection, not a genuine lexical defect**:
`STAGE3_PILOT_SAFE_FAULT_INJECTION` was thrown before the allocator or any
canonical write. #305 closed unmerged at 10:21:59. No invalid canonical record
was committed and its unmerged starter branch was removed.

The separate status-only [#306](https://github.com/neverworkalone/typewriter/pull/306)
opened at 10:26:50, after commit
`58aaf37b74d9da1c70802af6647ab0914986cff2` passed the entire local normal CI
and clean-checkout gate. Its only changed file was the C000002 review manifest:
ready → rejected, actual `rejected_pr=305`, history `{attempt:1,rejected_pr:305}`.
Candidate/review content digests and canonical were preserved. Exact-head
Stage 1 +1 at 10:32:22, Stage 2 +2 at 10:35:13 and CI run 37296638066 preceded
its actual merge at 10:35:40, commit
`ea97d4245e9a8e6ee772fde6cf23bd6b198e4034`. The rejection became authoritative
only at this merge; its monitor was deleted.

Actual pending restart checks:

- 10:21:56: recovery returned `resume-admission`, same #305; another claim
  returned null. Attempt 2 could not adopt attempt 1's live lock.
- 10:26:56: recovery returned `await-rejection`, same #306; another claim
  returned null. No duplicate attempt/PR or ID allocation occurred.
- Canonical tree stayed `1e7ee2f05e494674fd0758e6f44d19fe2e03f69b` throughout.
- 10:27:32: a **read-only API-response injection**, adding a hypothetical other
  orphan claim to the live query result, stopped with owner-directed ambiguity;
  actual remote refs and lock were unchanged. This is a bounded probe, not a
  real orphan ref creation or a real orphan-adoption lifecycle claim.
- 10:39: post-merge CLI restart returned `rejection-merged` using actual REST
  `merged_at`, verified master/rejected_pr305, and released both owned refs.
  This supplies real post-merge restart evidence for #304's repaired path.

## C000002 full Stage 2 rework checkpoint

At 10:40 the normal rejected-first Stage 2 worker acquired the exclusive
`refs/heads/stage2-claims/C000002` at master `ea97d424...` **before** reopening
original tracking [#301](https://github.com/neverworkalone/typewriter/issues/301)
at 10:40:28. It created `codex/stage2/301-C000002-r2`, attempt 2, and recorded
[the claim](https://github.com/neverworkalone/typewriter/issues/301#issuecomment-5992831306).
The `r2` suffix follows the worker's actual attempt numbering; no duplicate
tracking Issue was created.

The primary Codex context performed a new **agent self-check** of all 12 lemmas,
12 usage groups and all 32 observation references, including every recorded
ambiguity/lemma-mismatch hold. The permission-gated local index's input and
logical-row digests equal the Pilot A identities above. Each bound paragraph
and observed surface was read locally; the short affirmative observation for
맞다 also used its preceding/following dialogue to disambiguate the POS/sense.
Paragraphs/context logs remain private and are not tracked. New public reasons
are Typewriter-authored, text-free analysis; no new corpus quotations were added.

| Candidate suffix / lemma | Observation-level self-check and resulting disposition |
| --- | --- |
| 0001 만나다 | o01–o03 are verbal contact with people, all within w188-s1; reject a duplicate addition, retain separate search-coverage route. |
| 0002 만들다 | o02 supports caused action/state, distinct from production; include one append sense on w5362. o01/o03 stay w5362-s1 search coverage. |
| 0003 많다 | o01–o03 are quantity/frequency/degree in existing w5361-s1; no additional sense. |
| 0004 맞다 | o01/o02 affirm a proposition, including dialogue-confirmed o02; o03 evaluates fit with a preference. Preserve two distinct verb senses. |
| 0005 먹다 | o01–o03 ingest food in w11382-s1; reject duplicate lexical addition, retain coverage route. |
| 0006 모르다 | o01/o02 concern lack of awareness/knowledge; o03 supports possibility only in the -ㄹ지도 모르다 construction. Preserve the explicit construction-bound second sense and single-observation limitation. |
| 0007 모습 | Correct o01/o02 to existing w5351-s2 action/state aspect; o03 remains visible appearance w5351-s1. No new sense is needed. |
| 0008 보내다 | o01 causes spatial movement; o02/o03 concern passing time. Preserve two senses with separate observation binding. |
| 0009 보이다 | o01/o02 adjectival complements and o03 noun+으로 all express perceived quality/impression. Correct the old adjective-only boundary explanation; retain one sense. |
| 0010 볼 | o01's counted cooking vessel resolves noun identity; neither 보다's modifier form nor a body-part reading fits. |
| 0011 사다 | o01 is purchase of an object, resolving the competing occupation-noun reading. |
| 0012 사람 | o01–o03 are individual humans in w5360-s1; no new sense from origin or number. |

Counts stay 7 admitted candidates (6 new entries + 1 append-sense candidate),
5 duplicate/coverage-only lexical rejections, no candidate holds/deferred rows;
10 newly reviewed senses, no authored relations. Admission was not conditional
on commonness, writer usefulness or relation count. The lexical payloads and
glosses remain unchanged; source-bound reasons/mappings and reviewer provenance
were newly checked, not relabeled as an independent or human review. Attempt 1's
rejected_pr305 history remains immutable.

The real pinned Kiwi 0.24.0 hand-off was rebuilt through the shared factory
observation adapter. It reproduced analyzer digest
`7e2637cc1b03827f6fd4333672a2b3cac86b2ab434ca3f1f1b2a1ecf159d834e`
and byte-identical intake hand-off. Original Stage 1 ensemble data was not rerun
or rewritten. Shared per-candidate semantic/boundary/binding and factory
transition validators pass on the fresh current-canonical snapshot
`9b884315ab7912075bce399ff7ff09307ac3b12e536c4255d1ce59a2f2acdb92`.

At 10:48:24 a **non-mutating prospective check** built the complete 12,216-record
view, source-bound semantic authority and rule-dictated surface manifests in
memory, then passed complete dataset/semantic/surface validation. The pure
planner's required PR metadata used an explicit synthetic placeholder, never a
real admission claim/PR; projected final ids were not reserved or written.
The same factory ledger validates append-sense history; legacy 'corrected'
review changes are not fabricated for additive admission. Working-tree diff was
verified unchanged by the preview. This is deterministic validation, **not**
proof of the still-unrun successful C000002 admission/merge. Rework review/CI/
merge and final positive admission remain pending; Pilot PASS is not claimed.
