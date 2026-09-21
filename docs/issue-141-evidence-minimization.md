# Issue #141: M5-12A durable evidence minimization

Issue #141 re-audits the evidence added by PR #139. The goal is not to hide a
validation result or to make JSON smaller by minifying it. The goal is to keep
only the information that is an authored decision, an immutable binding, an
authorization/event, or a fact that cannot be reconstructed from those inputs.

## Baseline and result

The reproducible baseline is the merge commit `a5d794a` (PR #139) and its
first parent. Run `npm run validate:evidence` to print the same baseline
diff and the current field-level measurements.

The merge introduced 217,625 lines and removed 276 lines across 36 files. The
large data additions were:

| artifact | PR #139 additions | baseline bytes / lines |
| --- | ---: | ---: |
| `data/batches/m5-12a-semantic-decisions.json` | 112,423 | 5,823,108 / 112,423 |
| `data/validation/canonical-semantic-decision-source.json` | 80,214 | 12,620,444 / 224,505 |
| `data/inventory/m5-target-seed.json` | 17,647 | 1,047,456 / 42,051 |
| `data/batches/m5-12a-admission.json` | 536 | 20,577 / 536 |
| `data/batches/m5-12a-promotion.json` | 509 | 19,522 / 509 |
| `data/canonical/m5-12a-expansion.jsonl` | 722 | retained canonical records |

The new representation keeps the 802 candidate bodies, 802 authored decision
rows, 722 promotion events, and the canonical records, but removes repeated
derived envelopes:

| durable artifact | new bytes / lines | change from the baseline |
| --- | ---: | ---: |
| M5-12A semantic decisions | 2,130,279 / 34,620 | -3,692,829 bytes / -77,803 lines |
| canonical semantic decision source | 11,935,192 / 217,285 | -685,252 bytes / -7,220 lines |
| active seed | 621,487 / 26,095 | -425,969 bytes / -15,956 lines |
| append-only promotion ledger | 478,965 / 722 | new historical event source |
| compact admission manifest | 6,904 / 177 | -13,673 bytes / -359 lines |
| compact promotion manifest | 3,497 / 92 | -16,025 bytes / -417 lines |

Across these evidence artifacts, including the new ledger, the tracked surface
falls from 19,531,107 bytes / 380,024 lines to 15,176,324 bytes / 278,991
lines. The canonical import is unchanged by this representation change. The
line reduction is intentionally larger than the byte reduction because the
durable JSON remains pretty-printed and reviewable.

The current semantic decision source itself is split into approximately
306,299 bytes of candidate bodies, 1,510,609 bytes of compact decision rows,
and a 2,466-byte envelope. The 722 canonical batch bindings average 601 bytes
each. The 722 promotion ledger events average 663 bytes each and contain no
candidate or canonical body.

## Field-level authority map

| field / artifact | producer | active consumers | authority and historical need | action |
| --- | --- | --- | --- | --- |
| candidate identity and candidate body | authored M5-12A decision source | candidate-source validator, shared production, admission | The body is not reconstructible for held/rejected/deferred candidates; it is the durable authored input. | Keep full candidate body. |
| decision, rank, score, decision rationale | authored decision source | decision-source validator, selection, promotion ledger | Independent candidate-level decisions and selection boundary are not derived from canonical data. | Keep one compact row. |
| per-sense semantic rationale | authored decision source | source validator and canonical review builder | Independent semantic judgment is irreducible; gloss/POS/domain observations are not. | Keep rationale only. |
| boundary decision and rationale | authored decision source | sense-boundary validator and canonical audit builder | Explicit boundary judgment is authority; gloss digests and pair identity bind it. | Keep decision, rationale, and necessary pair evidence. |
| relation/no-relation outcome | authored decision source | relation validator and audit builder | The outcome is an independent admission decision; relation count/IDs are checked against the candidate. | Keep outcome/rationale, recompute count/IDs. |
| domain/connector/POS/gloss observations | shared validators | producer and audit | Deterministically derived from the authored gloss and typed canonical record. | Recompute; policy forbids durable copies. |
| `authored_batch_decision` in canonical authority | canonical review builder | canonical authority validator | The canonical review needs an immutable source binding, not a second decision narrative. | Keep IDs, digests, decision, rank/score, and reviewed-record digest only. |
| active non-promoted seed rows | batch producer | target inventory and planning validators | Current held/rejected/deferred planning state is needed for future work. | Keep in the active seed. |
| promoted target history | batch producer | target inventory, promotion transaction, final audit | Historical inventory-to-canonical decisions must survive removal from the active queue. | Move to append-only `m5-target-promotions.jsonl`. |
| admission gate | admission producer | promotion transaction and final validator | The authorization decision and input binding are historical events; pass matrices are recomputable. | Keep compact gate/event manifest. |
| promotion event and output digests | atomic promotion transaction | reconcile and final validator | Proves what mutated and binds resulting files to the admitted state. | Keep compact promotion manifest. |
| SQLite/package/search/build summaries and temporary paths | preflight runner | only the run that produced them | They are execution output and can be regenerated from the prospective canonical directory. | Keep in memory; do not persist. |
| complete audit coverage and pass booleans | semantic/preflight validators | current pipeline | Reconstructible from canonical data plus authored authority. | Keep compact digest/count summary where it binds a historical gate; recompute details. |

## Duplicate graph and boundary decisions

The main duplication was not the 722 canonical JSONL records. It was the same
fact being wrapped several times:

```text
authored candidate gloss
  ├─> derived POS/domain/connector/gloss digest observations
  ├─> batch semantic decision envelope
  ├─> canonical semantic review envelope
  └─> admission/promotion summaries

authored decision row
  ├─> canonical authored_batch_decision binding
  ├─> seed promoted metadata
  └─> promotion output summary
```

The producer now has one explicit boundary for each edge:

- The batch source owns candidate bodies and independent decisions.
- The canonical source owns the complete canonical semantic authority and
  references the batch decision by stable ID/digest.
- The seed owns only active non-promoted planning rows.
- The promotion ledger owns promoted inventory events and their decision-row
  bindings.
- Admission owns the decision to permit the transaction; promotion owns the
  mutation event and output digests.

This means a canonical record body is not copied into the decision ledger, a
promoted target is not retained in both the active seed and the ledger, and a
preflight's filesystem path is not treated as historical authority.

## Necessity and replay checks

The representation change is guarded at three boundaries:

1. `tests/m5-12a.test.mjs` expands the compact rows with the old derived
   envelope fields, serializes them through the v2 normalizer, and asserts the
   same serialized decisions, counts, and promotion-row bindings.
2. `buildM512A()` still runs candidate binding, shared lexical production,
   per-sense semantic validation, full prospective audit, deterministic
   inventory generation, and the exact +722 gate. The only changed inputs are
   the representation of evidence and the split of promoted history.
3. `validateM512AFinal()` recomputes the final canonical summary, canonical
   directory digest, seed digest, promotion-ledger digest, decision-source
   digest, complete audit coverage, and compact preflight bindings before
   accepting the durable manifests.

The v2 artifact policy adds a shape-based check, independent of filename. It
rejects v2 gate artifacts that reintroduce metrics, timing matrices, full audit
payloads, SQLite/package summaries, or temporary output paths. It also rejects
decision rows with derived gloss/POS/domain/connector copies, canonical batch
bindings with extra narrative fields, and promotion-ledger rows containing
candidate bodies. A new batch filename cannot bypass these checks when it uses
the same durable contract.

## Irreducible evidence

After minimization, the following evidence is deliberately retained:

- authored candidate bodies and stable candidate/inventory identities;
- included/corrected/held/rejected/deferred decisions, ranks, scores, and
  genuinely independent rationales;
- per-sense semantic, boundary, relation, and no-relation decisions required
  to reproduce the admission boundary;
- correction payloads and reviewed-record digests when a correction exists;
- decision-source ID/digest and candidate/record digests;
- append-only promoted inventory events;
- owner authorization, generation/verification separation, and truthful
  agent provenance;
- admission decision, source/input digests, atomic mutation event, resulting
  output digests, and final audit binding.

Everything else is either canonical content already stored in its authority,
or an in-memory projection of those inputs. No validation rule, semantic gate,
relation integrity check, count/reserve rule, clean-checkout check, or
promotion rollback guarantee is weakened.
