# Issue #219 — M9-A bounded recovery

## Contract and first batch

M9 recovery selects historical candidates from a pinned source inventory, but every admitted record receives a new source-bound Issue #219 semantic decision and passes the ordinary shared lexical producer, semantic audit, and admission path. Historical fit and capacity-reserve status select candidates for review; they do not authorize canonical admission.

The recovery contract prioritizes high-confidence capacity-deferred source candidates, then source-recoverable legacy deferred candidates and open M5 candidates. Holds and known collisions stay outside a batch until their specific evidence is resolved. Every row records inventory and canonical identity, lemma, POS, source unit, decision, relation outcome, base search ownership, and final exact search result. There is no commonness, usefulness, vividness, or relation quota.

The first slice is the first 20 numeric identities in the 32-row M5-15 axis C reserve cohort, selected from the exact Issue #210 baseline. All 20 were included/fit and deferred only by M5-15 capacity, remained `admit-candidate`, and had no canonical lemma or search match in the baseline. They were separately reviewed under #219 before admission.

## Outcome

| Measure | Result |
| --- | ---: |
| Reviewed | 20 |
| Admitted | 20 |
| Held / rejected / corrected | 0 / 0 / 0 |
| Duplicate / search collision | 0 / 0 |
| New senses / relations / expressions | 20 / 0 / 20 |
| Admitted with zero relations | 20 |
| Observed defect classes | none |
| Review duration | NOT_MEASURED |

Every candidate kept one supported expression sense with its Typewriter-authored gloss. The shared selector admitted all 20 after independent current review. No relation was added because the evidence did not support a separately authored relation; zero relations do not block search admission.

## Candidate and search results

| Order | Inventory | Canonical | Lemma | POS | Decision | Relations | Exact search result IDs |
| ---: | --- | --- | --- | --- | --- | ---: | --- |
| 1 | m5-4619 | w4699 | 택배물류 허브 | expression | included | 0 | w4699 |
| 2 | m5-4620 | w4700 | 화물터미널 야적장 | expression | included | 0 | w4700 |
| 3 | m5-4621 | w4701 | 컨테이너 야드 | expression | included | 0 | w4701 |
| 4 | m5-4622 | w4702 | 철도 화물역 | expression | included | 0 | w4702 |
| 5 | m5-4623 | w4703 | 철도 차량기지 | expression | included | 0 | w4703 |
| 6 | m5-4624 | w4704 | 지하철 유치선 | expression | included | 0 | w4704 |
| 7 | m5-4625 | w4705 | 전철 종착역 승강장 | expression | included | 0 | w4705 |
| 8 | m5-4626 | w4706 | 역무실 옆 계단 | expression | included | 0 | w4706 |
| 9 | m5-4627 | w4707 | 역 구내 지하도 | expression | included | 0 | w4707 |
| 10 | m5-4628 | w4708 | 철도 건널목 경비실 | expression | included | 0 | w4708 |
| 11 | m5-4629 | w4709 | 버스 환승센터 대기실 | expression | included | 0 | w4709 |
| 12 | m5-4630 | w4710 | 시외버스터미널 승차장 | expression | included | 0 | w4710 |
| 13 | m5-4631 | w4711 | 고속버스 화물칸 앞 | expression | included | 0 | w4711 |
| 14 | m5-4632 | w4712 | 공항 리무진 정류장 | expression | included | 0 | w4712 |
| 15 | m5-4633 | w4713 | 택시 대기열 맨끝 | expression | included | 0 | w4713 |
| 16 | m5-4634 | w4714 | 승객 없는 정류장 | expression | included | 0 | w4714 |
| 17 | m5-4635 | w4715 | 종점 회차공간 | expression | included | 0 | w4715 |
| 18 | m5-4636 | w4716 | 도로공사 우회구간 | expression | included | 0 | w4716 |
| 19 | m5-4637 | w4717 | 임시 보행자통로 | expression | included | 0 | w4717 |
| 20 | m5-4638 | w4718 | 차량 통제선 안쪽 | expression | included | 0 | w4718 |

The frozen baseline dictionary produced no exact canonical or generated-surface result for any candidate. The current dictionary returns each lemma as exactly its own `ready` exact-lemma result. The 20 records are canonical starts and remain relation-empty.

## Batch-size calibration

Use 20 records as the initial M9 review batch size: this coherent 20-record slice completed with no identity, POS, sense, duplicate, search-collision, or relation-evidence defects and passed the shared admission contract. Review duration was not measured, so this is a successful-slice calibration, not a throughput estimate. Reassess the size from later defect and workload observations; the size is not a quota.

The batch added 20 searchable starts and brought the canonical start count from 5034 to 5054. This issue does not target 6,000 starts or corpus expansion.

## Reproduction and boundaries

Run `npm run batch:issue-219:check` to validate the pinned #210/#219 inputs, M5-15 reserve selection, candidate and semantic source bindings, ordinary lexical admission, target promotion ledger, exact product search, deterministic SQLite output, machine report schema, and current semantic audit. Run `npm run batch:issue-219:report` after an authorized report input change to refresh both reports.

The snapshot copies under `data/batches/issue-219-m9-a-base-*` preserve the pre-admission canonical set, seed, and Issue #210 inventory needed for historical replay. They contain Typewriter-authored project data and do not include corpus text or external dictionary material.
