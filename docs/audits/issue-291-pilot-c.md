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
