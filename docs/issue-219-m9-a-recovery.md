# Issue #219 — M9-A bounded recovery

## Contract and first batch

M9 recovery selects historical candidates from a pinned source inventory, but every admitted record receives a new source-bound Issue #219 semantic decision and passes the ordinary shared lexical producer, semantic audit, and admission path. Historical fit and capacity-reserve status select candidates for review; they do not authorize canonical admission.

The recovery contract prioritizes high-confidence capacity-deferred source candidates, then source-recoverable legacy deferred candidates and open M5 candidates. For every `expression`, the shared semantic decision contract separately records whether the exact phrase is fixed or lexicalized, compositional, or unresolved. A compositional phrase cannot be admitted; it must be held for an unresolved lexical question or rejected as not a lexical unit. A fixedness admission needs candidate-specific evidence. Every row records inventory and candidate identity, lemma, POS, source unit, lexical-unit judgment, disposition, relation outcome, baseline search ownership, and final exact search result. There is no commonness, usefulness, vividness, or relation quota.

The first slice is the first 20 numeric identities in the 32-row M5-15 axis C reserve cohort, selected from the exact Issue #210 baseline. All 20 were separately reviewed under #219; their previous M5-15 fit status only selected them for review. The fresh review classified the exact phrase as fixed/lexicalized for 0, compositional for 10, and unresolved for 10.

## Outcome

| Measure | Result |
| --- | ---: |
| Reviewed | 20 |
| Admitted | 0 |
| Held / rejected / corrected | 10 / 10 / 0 |
| Duplicate / search collision | 0 / 0 |
| New senses / relations / expressions | 0 / 0 / 0 |
| Admitted with zero relations | 0 |
| Observed defect classes | expression-lexical-unit-fixedness, external-material-terms-pending |
| Review duration | NOT_MEASURED |

The Customs glossary used during the initial fixedness review has no confirmed permission for this verification role. Its external-material review is pending in [the source review record](external-material-review-customs-terminology.md); `m5-4621` remains held outside canonical data until the terms are resolved.

Only candidates marked `included` or `corrected` enter the canonical import. Held and rejected rows remain visible in the recovery seed with their source-bound decisions. Admitted records retain their Typewriter-authored senses and do not gain unsupported relations; zero relations do not block search admission.

## Candidate and search results

| Order | Inventory | Canonical | Lemma | Lexical-unit judgment | Decision | Relations | Exact search result IDs |
| ---: | --- | --- | --- | --- | --- | ---: | --- |
| 1 | m5-4619 | — | 택배물류 허브 | unresolved | held | 0 | — |
| 2 | m5-4620 | — | 화물터미널 야적장 | unresolved | held | 0 | — |
| 3 | m5-4621 | — | 컨테이너 야드 | unresolved | held | 0 | — |
| 4 | m5-4622 | — | 철도 화물역 | unresolved | held | 0 | — |
| 5 | m5-4623 | — | 철도 차량기지 | unresolved | held | 0 | — |
| 6 | m5-4624 | — | 지하철 유치선 | unresolved | held | 0 | — |
| 7 | m5-4625 | — | 전철 종착역 승강장 | compositional-phrase | rejected | 0 | — |
| 8 | m5-4626 | — | 역무실 옆 계단 | compositional-phrase | rejected | 0 | — |
| 9 | m5-4627 | — | 역 구내 지하도 | unresolved | held | 0 | — |
| 10 | m5-4628 | — | 철도 건널목 경비실 | compositional-phrase | rejected | 0 | — |
| 11 | m5-4629 | — | 버스 환승센터 대기실 | compositional-phrase | rejected | 0 | — |
| 12 | m5-4630 | — | 시외버스터미널 승차장 | compositional-phrase | rejected | 0 | — |
| 13 | m5-4631 | — | 고속버스 화물칸 앞 | compositional-phrase | rejected | 0 | — |
| 14 | m5-4632 | — | 공항 리무진 정류장 | unresolved | held | 0 | — |
| 15 | m5-4633 | — | 택시 대기열 맨끝 | compositional-phrase | rejected | 0 | — |
| 16 | m5-4634 | — | 승객 없는 정류장 | compositional-phrase | rejected | 0 | — |
| 17 | m5-4635 | — | 종점 회차공간 | unresolved | held | 0 | — |
| 18 | m5-4636 | — | 도로공사 우회구간 | compositional-phrase | rejected | 0 | — |
| 19 | m5-4637 | — | 임시 보행자통로 | unresolved | held | 0 | — |
| 20 | m5-4638 | — | 차량 통제선 안쪽 | compositional-phrase | rejected | 0 | — |

The frozen baseline dictionary produced no exact canonical or generated-surface result for any candidate. No candidate was admitted, so all 20 proposals have no current search result.

## Batch-size calibration

Use 20 candidates as the initial M9 review-slice size: this coherent slice completed candidate-by-candidate fixedness review, shared admission validation, and exact-search validation after the generalized expression rule was added. Review duration was not measured, so 20 is a slice-size calibration, not a throughput estimate. Reassess the size from later defect and workload observations; the size is not an admission quota.

The reviewed batch added 0 searchable starts. The current canonical dataset contains 11000 searchable starts. Issue #219 did not target 6,000 starts or corpus expansion.

## Reproduction and boundaries

Run `npm run batch:issue-219:check` to validate the pinned #210/#219 inputs, M5-15 reserve selection, candidate and semantic source bindings, ordinary lexical admission, target promotion ledger, exact product search, deterministic SQLite output, machine report schema, and current semantic audit. Run `npm run batch:issue-219:report` after an authorized report input change to refresh both reports.

The snapshot copies under `data/batches/issue-219-m9-a-base-*` preserve the pre-admission canonical set, seed, and Issue #210 inventory needed for historical replay. They contain Typewriter-authored project data and do not include corpus text or external dictionary material.
