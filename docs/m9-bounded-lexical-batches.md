# M9 bounded lexical recovery batches

M9 recovers writer-useful lexical starts from preserved Typewriter candidate material. The recovery inventory guides review order; its prior decisions do not grant admission. Each admitted row must pass fresh, source-bound semantic decisions through the shared candidate producer, complete canonical audit, and ordinary lexical admission path.

## Review order

1. Review high-confidence candidates that were previously marked included/fit and deferred only because an earlier batch reached its capacity. Confirm that their source identity still describes a valid Typewriter lexical unit and that the current canonical dictionary has no exact lemma or search-form owner.
2. Recover authored candidate content for legacy capacity-deferred rows whose source body is missing. Do not infer the missing lexical unit from a lemma alone.
3. Review other open candidates under the same source, POS, sense, canonical coverage, and search contract.
4. Keep held, ambiguous, duplicate, invalid-form, and collision rows out of admission batches until their candidate-specific evidence changes.

No category receives an admission quota. Commonness, broadness, low standalone vividness, and a zero relation count do not establish that a valid lexical entry is ineligible. A relation is added only when separately authored evidence supports it.

## Required batch evidence

Every batch binds the issue and parent, a pinned baseline canonical and inventory revision, candidate-source bytes, candidate identities, and separately authored semantic decisions. For every reviewed candidate, retain:

- historical inventory ID and canonical candidate ID;
- Typewriter source-unit ID, lemma, record type, and POS;
- current decision and any specific hold or rejection basis;
- exact baseline canonical/search ownership results;
- sense-boundary and relation decision evidence;
- final exact search result after admission;
- promotion-ledger binding to the decision source and canonical record digest.

The machine report records reviewed and admitted counts, holds, rejections, corrections, duplicates, search collisions, senses, relations, expressions, observed defect classes, validation status, and any measured review duration. Preserve `NOT_MEASURED` when a duration was not recorded; do not infer throughput from candidate count.

## Initial batch-size calibration

Issue #219 reviewed the first 20 rows in a coherent M5-15 axis C capacity-reserve cohort. All 20 passed fresh lexical, POS, sense, baseline-search, complete-audit, and ordinary admission checks. That result supports 20 as the initial M9 batch size for follow-up batches. Review duration was not measured, so 20 is a successful-slice calibration rather than a throughput estimate. Reassess it using later defect rates and review workload.

Batch size controls review scope only. It does not define how many candidates must be admitted, and M9-A does not advance the separate 6,000-start milestone or authorize corpus expansion.

## Validation boundary

`npm run batch:issue-219:check` validates the frozen selection evidence, shared producer output, semantic-source bindings, ordinary lexical admission, complete semantic audit, target inventory and promotion ledger, baseline/current exact search, deterministic SQLite logical contents, and machine report schema. The recorded logical-content digest excludes Git revision and working-tree provenance metadata, which change when the validation code is committed. The candidate and snapshot artifacts remain reviewable in Git; corpus/reference material stays outside this recovery path.
