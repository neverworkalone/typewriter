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

For `record_type: expression`, the shared authored semantic-decision validator requires an explicit candidate-bound lexical-unit judgment: `fixed-or-lexicalized-unit`, `compositional-phrase`, or `unresolved`. Every source with `parent_issue: 218` must declare this contract in review metadata, and the validator enforces it even when a batch caller omits a configuration option. A fixed or lexicalized judgment needs evidence that names the exact form. A compositional phrase cannot be included; it must be rejected as `not-a-lexical-unit` or held as `unresolved-lexical-unit`. An unresolved judgment must remain held. This separates fixedness from an atomic scene description and applies automatically to current and future M9 batches.

The machine report records reviewed and admitted counts, holds, rejections, corrections, duplicates, search collisions, senses, relations, expressions, observed defect classes, validation status, and any measured review duration. Preserve `NOT_MEASURED` when a duration was not recorded; do not infer throughput from candidate count.

## Historical pilot calibration

Issue #219 reviewed the first 20 rows in a coherent M5-15 axis C capacity-reserve cohort. All 20 were reviewed through fresh lexical, POS, sense, baseline-search, and complete-audit checks; 10 were held, 10 were rejected, and none was admitted while the only candidate-specific fixedness evidence remained under pending source terms. Review duration was not measured. This remains a historical pilot slice only; it does not establish a production batch size or a throughput estimate.

The 20-row slice and its findings remain historical pilot evidence. They do not set the post-5K production batch size or issue completion criteria.

## Post-5K production mode (Issue #229)

Start sustained corpus production at approximately 200 candidates per batch.
After consecutive clean batches introduce no new systemic defect and review
and CI burden remains acceptable, batches may grow toward 500. Decrease the
size temporarily when isolating a new defect. Candidate limits control the
review transaction, not the required admission count.

A bounded batch is a deterministic review unit, validation checkpoint, and
rollback/debugging boundary. It is not an issue-level stopping condition or a
reason to request renewed authorization after every clean slice. Continue with
the next ranked unseen candidates through clean batches until the issue's net
canonical-growth checkpoint is reached. Low yield preserves admission
standards and causes more candidates to be reviewed; it does not complete the
scale issue.

Pause only when a systemic defect requires a shared fix, the candidate source
is exhausted, or an explicit product/model/licensing blocker prevents safe
continuation. For a systemic defect, stop expansion, add a generalized
regression at the shared boundary, run the relevant validation, and then
resume. Do not work around a defect with batch-specific exceptions.

For each scale run, record the checkpoint target, canonical count at start and
now, net admissions, remaining records, batches processed, candidate
selection/admit/hold/reject counts, whether continuation is required, and the
stop reason. `npm run batch:m9:progress` produces the normalized deterministic
progress record from these inputs. A low-yield clean run below target reports
`continuation_required: true`; systemic defects, source exhaustion, product or
licensing blockers, and a reached checkpoint stop continuation.

## Validation boundary

`npm run batch:issue-219:check` validates the frozen selection evidence, shared producer output, semantic-source bindings, expression fixedness judgments, ordinary lexical admission, complete semantic audit, target inventory and promotion ledger, baseline/current exact search, deterministic SQLite logical contents, and machine report schema. The tracked logical-content digest excludes Git provenance plus Node and SQLite execution-environment metadata. The deterministic-build check still compares complete snapshots, including that metadata; only the content digest removes it. Candidate and snapshot artifacts remain reviewable in Git; corpus/reference material stays outside this recovery path.
