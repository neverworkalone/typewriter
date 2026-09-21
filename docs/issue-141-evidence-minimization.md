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
| canonical semantic decision source | 3,601,987 / 63,535 | -9,018,457 bytes / -160,970 lines |
| active seed | 621,487 / 26,095 | -425,969 bytes / -15,956 lines |
| append-only promotion ledger | 478,965 / 722 | new historical event source |
| compact admission manifest | 8,102 / 201 | -12,475 bytes / -335 lines |
| compact promotion manifest | 5,713 / 135 | -13,809 bytes / -374 lines |

Across these evidence artifacts, including the new ledger, the tracked surface
falls from 19,531,107 bytes / 380,024 lines to 6,846,533 bytes / 125,308
lines. The canonical import is unchanged by this representation change. The
line reduction is intentionally larger than the byte reduction because the
durable JSON remains pretty-printed and reviewable.

The current M5-12A semantic decision source itself is split into approximately
306,299 bytes of candidate bodies, 1,510,609 bytes of compact decision rows,
and a 2,466-byte envelope. The 722 canonical batch bindings average 601 bytes
each. The 722 promotion ledger events average 663 bytes each and contain no
candidate or canonical body.

The canonical source compaction is measured separately against the exact
pre-compaction source at `ed276b0`: 11,935,192 bytes / 217,285 lines became
3,601,987 bytes / 63,535 lines, a reduction of 8,333,205 bytes and 153,750
lines (69.82% of bytes and 70.76% of lines). The per-record cost fell from
5,844.85 to 1,763.95 bytes and the per-sense cost fell from 5,186.96 to
1,565.40 bytes.

`npm run validate:evidence` also emits machine-readable accounting for the
semantic payload and the complete tracked footprint. The semantic submetric
treats each candidate, decision row, canonical review record (with its batch
binding removed), canonical batch binding, and promotion event as one semantic
payload unit, hashes the canonical JSON for each unit, and counts exact digest
repeats only after their first occurrence:

| accounting class | units | bytes | definition |
| --- | ---: | ---: | --- |
| unique semantic payload | 5,090 | 5,068,474 | one byte count for each distinct semantic-unit digest |
| duplicated payload | 0 | 0 | exact semantic-unit bytes repeated after the first digest occurrence |
| current-corpus-dependent | 2,042 | 2,341,955 | canonical review units, whose count follows the current canonical corpus |
| batch-size-dependent | 3,048 | 2,726,519 | 802 candidate bodies, 802 decisions, 722 bindings, and 722 promotion events |

The two dependency classes partition the unique semantic payload bytes, but this
is a semantic submetric rather than a claim that every byte in the tracked files
is semantic payload. Exact whole-unit duplicate bytes are a lower bound: the
same fact can occur in different object envelopes or under different field
names. The report therefore also compares known repeated facts across the
decision-to-binding and binding-to-ledger boundaries. All 7,220 compared field
groups currently match, with 350,666 bytes of known secondary field/value
copies. This overlap is explanatory and is not subtracted from the ownership
accounting below.

| known repeated field group | matched fields | secondary-copy bytes |
| --- | ---: | ---: |
| semantic decision → canonical binding | 3,610 | 139,842 |
| canonical binding → promotion ledger | 3,610 | 210,824 |
| **total** | **7,220** | **350,666** |

The full tracked footprint is assigned exactly once to mutually exclusive
ownership buckets, so wrappers and active-state bytes are not left unclassified:

| ownership bucket | bytes | tracked artifacts |
| --- | ---: | --- |
| current-corpus authority | 3,601,987 | canonical semantic decision source |
| batch-size authority | 2,623,059 | semantic decisions, promotion ledger, admission and promotion manifests |
| active inventory state | 621,487 | active target seed |
| **tracked total** | **6,846,533** | **bucket sum matches tracked bytes** |

The semantic payload numbers and the ownership buckets answer different
questions: the former exposes exact-unit and known-field repetition, while the
latter proves that every tracked byte belongs to one durable artifact owner.

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

## Canonical authority field-family audit

`data/validation/canonical-semantic-decision-source.json` now uses the
registered `lexical-semantic-canonical-decision-source-v2` contract. Its
durable payload stores authored judgments and immutable bindings only. The
producer materializes the old review shape in memory for validation, then
strips the projections before writing the source again.

| field family | durable decision and necessity | active or historical consumer | action |
| --- | --- | --- | --- |
| record binding | `record_id` and `record_sha256` join the review to immutable canonical content; both are required integrity bindings | semantic audit and target-inventory validators | Keep |
| canonical authored batch binding | source/artifact/row digests, candidate identity, decision, rank/score, and reviewed-record digest bind M5-12A lineage | admission, inventory, promotion-ledger, and final reconciliation validators | Keep |
| boundary authored judgment | record classification, pairwise relationship/decision, evidence basis, and rationale are independent editorial decisions | semantic audit and correction replay | Keep |
| sense authored judgment | per-sense boundary/semantic/no-relation rationale and exceptional topic analyses are not derivable from the canonical gloss alone | semantic audit and correction replay | Keep compact judgment only |
| review provenance and correction history | source contract binding plus historical correction rows establish what was reviewed and preserve past repairs | semantic audit and correction replay | Keep |
| boundary envelope, gloss digests, source IDs | status/method/independence/reviewed IDs and repeated evidence digests are regenerated from canonical content and one source-level binding | semantic-audit validation only | Remove; materialize in memory |
| POS, expression, relation, domain, connector, and review-basis observations | observed values, counts, fingerprints, gloss digests, and pass/rationale envelopes are deterministic projections of canonical content and retained judgments | semantic-audit validation only | Remove; materialize in memory |
| repeated review counts and pass fields | record/sense counts, open findings, and correction counts are recomputable from canonical records and retained correction history | semantic-audit validation only | Remove from durable source |

The machine-readable accounting reports the same families and their exact
before/after compact-JSON costs. The removed projections account for
1,189,842 bytes of boundary envelope, 3,916,763 bytes of sense/content and
relation projection, 126 bytes of repeated counts, and 1,112,348 bytes of
repeated decision-source IDs in the pre-compaction source. The closed artifact
policy rejects reintroduction of fields such as `pos`, `expression`, relation
fingerprints, `review_basis.gloss_sha256`, and repeated per-row source IDs.

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

The representation change is guarded at four boundaries:

1. `materializeSemanticReviewArtifact()` expands the compact durable source
   into the full in-memory review contract. A replay regression compares the
   authored boundary, per-sense outcome, topic, and correction decisions before
   and after compaction; it does not require derived digests or pass envelopes
   to remain durable.
2. `tests/m5-12a.test.mjs` expands the compact rows with the old derived
   envelope fields, serializes them through the v2 normalizer, and asserts the
   same serialized decisions, counts, and promotion-row bindings.
3. `buildM512A()` still runs candidate binding, shared lexical production,
   per-sense semantic validation, full prospective audit, deterministic
   inventory generation, and the exact +722 gate. The only changed inputs are
   the representation of evidence and the split of promoted history.
4. `validateM512AFinal()` recomputes the final canonical summary, canonical
   directory digest, seed digest, the M5-12A promotion-ledger prefix digest,
   decision-source digest, complete audit coverage, and compact preflight
   bindings before accepting the durable manifests. The current full ledger
   digest remains reporting state; it is not the immutable identity of an
   already recorded M5-12A segment.

The v2 artifact policy requires both a registered durable path role and its
registered contract version. Admission and promotion manifests, their nested
durable containers, the admission gate and gate evidence, decision-source rows
and sense reviews, canonical batch bindings, and promotion-ledger rows all use
typed closed schemas. A new durable JSON or JSONL file under a governed path
cannot opt in merely by copying a known `contract_version`: an unregistered
root, alternate envelope, or markerless promotion-ledger stream is rejected.
The canonical semantic decision source now has its own exact path role and
compact closed contract, so an unregistered version or any removed derived
field is rejected at the same boundary.
Explicitly enumerated legacy paths are the only exception, preserving
historical pre-M5-12A evidence without making future artifacts untyped. The
policy rejects v2
gate artifacts that reintroduce metrics, timing matrices, full audit payloads,
SQLite/package summaries, or temporary output paths. It also rejects decision
rows with derived gloss/POS/domain/connector copies, canonical batch bindings
with extra narrative fields, and promotion-ledger rows containing candidate
bodies under an alternate key. Synthetic fixtures cover a future promotion
preflight, an alternate ledger body key, and an alternate decision-row
envelope, so a new batch filename cannot bypass the machine policy. The schemas
also retain normal future authored shapes such as corrected decision records,
multi-sense boundary pairs, and candidate sense relations, while rejecting an
object or full-record payload hidden inside an allowed scalar field.

The append-only promotion ledger is bound locally to the historical segment
that a manifest records. M5-12A stores the previous-ledger digest, append start
and count, appended-segment digest, prefix event count, and immutable prefix
digest. A later event may extend the ledger without invalidating the M5-12A
evidence, while changing any event inside that prefix fails validation. The
shared inventory validator additionally binds each event's canonical-record
digest and decision-source ID, artifact digest, and decision-row digest to the
canonical record and the authoritative `authored_batch_decision`; well-formed
but fabricated digests or source IDs therefore cannot satisfy the common
consumer path.

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
