# Issue #211 — Bounded lexical recovery

Issue #211 re-reviewed all 25 Issue #204 rejected candidates with the shared v4 semantic decision source and ordinary lexical admission pipeline. The prior generality, commonness, low-texture, and relation-count rationales were not used as exclusion grounds.

## Disposition and admission counts

| Measure | Count |
| --- | ---: |
| Candidates reviewed | 25 |
| Admitted | 24 |
| Held | 1 |
| Duplicate | 0 |
| Invalid lemma or wrong POS | 0 |
| Needs sense split | 1 |
| Search collision | 0 |
| Unsupported lexical scope | 0 |
| New canonical starts | 24 |
| New senses | 24 |
| New relations | 0 |
| New expressions | 0 |
| Admitted entries with zero relations | 24 |

Every candidate received a separate lemma, POS, lexical-scope, sense-boundary, canonical-coverage, and exact-search review. “내다” is held because its proposed single gloss folds several distinct uses into one sense; the record will need a source-bound sense split before admission. “사람” and “인간” remain separate lemmas with different writer-facing scope. The remaining admitted rows use one bounded primary reading each.

## Candidate decisions

| Prior #204 ID | New inventory ID | Canonical ID | Lemma | POS | New disposition | Exact search result |
| --- | --- | --- | --- | --- | --- | --- |
| m5-5304 | m5-5401 | w5359 | 없다 | adjective | admitted | w5359 |
| m5-5306 | m5-5402 | w5360 | 사람 | noun | admitted | w5360 |
| m5-5315 | m5-5403 | w5361 | 많다 | adjective | admitted | w5361 |
| m5-5324 | m5-5404 | w5362 | 만들다 | verb | admitted | w5362 |
| m5-5334 | m5-5405 | w5363 | 동안 | noun | admitted | w5363 |
| m5-5335 | m5-5406 | w5364 | 내다 | verb | held · needs-sense-split | not indexed while held |
| m5-5338 | m5-5407 | w5365 | 필요 | noun | admitted | w5365 |
| m5-5339 | m5-5408 | w5366 | 처음 | noun | admitted | w5366 |
| m5-5344 | m5-5409 | w5367 | 다음 | noun | admitted | w5367 |
| m5-5346 | m5-5410 | w5368 | 지금 | noun | admitted | w5368 |
| m5-5352 | m5-5411 | w5369 | 친구 | noun | admitted | w5369 |
| m5-5360 | m5-5412 | w5370 | 그때 | noun | admitted | w5370 |
| m5-5370 | m5-5413 | w5371 | 오늘 | noun | admitted | w5371 |
| m5-5372 | m5-5414 | w5372 | 여자 | noun | admitted | w5372 |
| m5-5373 | m5-5415 | w5373 | 이해 | noun | admitted | w5373 |
| m5-5375 | m5-5416 | w5374 | 인간 | noun | admitted | w5374 |
| m5-5376 | m5-5417 | w5375 | 남자 | noun | admitted | w5375 |
| m5-5380 | m5-5418 | w5376 | 준비 | noun | admitted | w5376 |
| m5-5381 | m5-5419 | w5377 | 중요 | noun | admitted | w5377 |
| m5-5384 | m5-5420 | w5378 | 넣다 | verb | admitted | w5378 |
| m5-5387 | m5-5421 | w5379 | 가능 | noun | admitted | w5379 |
| m5-5388 | m5-5422 | w5380 | 마지막 | noun | admitted | w5380 |
| m5-5390 | m5-5423 | w5381 | 아버지 | noun | admitted | w5381 |
| m5-5397 | m5-5424 | w5382 | 아래 | noun | admitted | w5382 |
| m5-5399 | m5-5425 | w5383 | 조금 | noun | admitted | w5383 |

## Exact product search

The base dictionary returned no exact lemma or generated-surface result for any of the 25 candidate queries. After admission, each of the 24 canonical starts returns exactly its own record with exact-lemma precedence. The workflow checks for “사람” and “없다” also resolve directly with zero relations; no relation was invented to fill a quota.

| Query | Expected record | Exact result IDs |
| --- | --- | --- |
| 없다 | w5359 | w5359 |
| 사람 | w5360 | w5360 |
| 많다 | w5361 | w5361 |
| 만들다 | w5362 | w5362 |
| 동안 | w5363 | w5363 |
| 필요 | w5365 | w5365 |
| 처음 | w5366 | w5366 |
| 다음 | w5367 | w5367 |
| 지금 | w5368 | w5368 |
| 친구 | w5369 | w5369 |
| 그때 | w5370 | w5370 |
| 오늘 | w5371 | w5371 |
| 여자 | w5372 | w5372 |
| 이해 | w5373 | w5373 |
| 인간 | w5374 | w5374 |
| 남자 | w5375 | w5375 |
| 준비 | w5376 | w5376 |
| 중요 | w5377 | w5377 |
| 넣다 | w5378 | w5378 |
| 가능 | w5379 | w5379 |
| 마지막 | w5380 | w5380 |
| 아버지 | w5381 | w5381 |
| 아래 | w5382 | w5382 |
| 조금 | w5383 | w5383 |

## Source and validation boundary

The candidate source is data/batches/issue-211-lexical-unit-source.json; independent semantic decisions and row bindings are in data/batches/issue-211-semantic-decisions.json. Admitted canonical records are in data/canonical/issue-211-bounded-recovery.jsonl. The old Issue #204 rows remain historical rejects under their original inventory IDs. The held “내다” decision is recorded under a new inventory identity.

Validation reconstructs candidate identities through the shared producer, validates the source-bound v4 semantic decisions, runs live shared lexical admission and the complete canonical semantic audit, validates the target inventory and promotion ledger, and builds SQLite dictionaries from both the pre-import and current canonical sets.
