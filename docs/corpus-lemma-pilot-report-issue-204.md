# Corpus lemma pilot report (#204)

Run date: 2026-09-28. This follow-up reviews the exact 100-candidate selection
from #203 and admits a bounded first canonical batch through the shared lexical
production path.

## Source and review boundary

The candidate selection SHA-256 is
bf5f4fc2185f572a3950b81a794d26b65084cb1b8d2b3b182f9f558a36a5c6fe; the
ignored local pilot-inventory SHA-256 is
b318d7caa1edb05179a6e805864692ece922f434ccf29b4db73f4d89e9928be9.
The selection binds to the #203 canonical revision
8dad0cd312a7fb8c2073c3aaf8cd2c96e70875a035877e83e9292c6c74d359b9.

The tracked decision ledger at
[issue-204-pilot-decisions.json](../data/batches/issue-204-pilot-decisions.json)
stores candidate ordinal, proposed lemma/POS, aggregate sample counts, morphology
flags, editorial disposition, and rationale. It contains no paragraph excerpts
or raw corpus rows. The source-bound admission decisions and authored glosses are
in [issue-204-semantic-decisions.json](../data/batches/issue-204-semantic-decisions.json).
Both artifacts identify this as an agent-authored decision pass; no human review
is claimed.

Corpus counts establish broad local usage only. They do not establish lemma
correctness, sense boundaries, or writer usefulness. The ten admitted candidates
had 2,414–8,534 aggregate hits among sampled paragraphs; each occurred across
1,584–2,873 distinct source documents. The median largest-source share was
0.915% and the maximum was 2.81%. These are candidate-surface observations, not
lemma/token frequencies or editorial scores.

## Disposition

| Disposition | Candidates |
| --- | ---: |
| Admit | 10 |
| Hold for ambiguous analyzer readings | 39 |
| Needs sense split | 25 |
| Reject for this pilot | 25 |
| Search-surface collision | 1 |
| Already covered | 0 |
| Invalid lemma | 0 |
| Wrong POS | 0 |
| **Reviewed** | **100** |

No lemma or POS was corrected before admission. Twenty-five candidates were
deferred because their proposed lemma covers distinct senses that need
usage-bound editorial boundaries. The held morphology class contains 39
single-surface proposals with multiple analyzer interpretations; the inventory
also contains one existing search-surface collision. No recurrence was found
that justified changing the shared extractor or validator.

The 25 rejections fall into five writer-use classes: general property (6), broad
human category (6), deictic or frame word (8), generic action (3), and low
texture common word (2). Frequency did not raise these candidates into the
admission batch.

## Canonical yield and validation

Ten new searchable start records contain 13 senses. The three polysemous
records have explicit pairwise boundary evidence. All relations and
reference-only additions remain empty. Every gloss is Typewriter-authored; no
corpus sentence or source wording was copied.

Admitted record provenance is bound through the pilot ordinal, inventory ID,
proposed lemma/POS, decision-source artifact and row digests, promotion ledger,
and local candidate-selection digest. The ordinary live lexical-production path
validated candidate intake, semantic review, selection, complete prospective
canonical audit, and admission across all 5,052 records. The final canonical
record digest is
9e327b68b6faf664ecd623639a872c269958d3c63fa09df9503217db0cf90c1a.

Exact lemma queries reach the intended record for all ten starts. The supported
향하는 and 향했다 generated forms resolve to 향하다; the regression is in
[issue-204-search.test.mjs](../tests/issue-204-search.test.mjs). The complete
canonical semantic audit reports 5,052 covered records and 5,314 covered senses
with no blocking finding. Target inventory, generated-surface coverage,
deterministic SQLite build, and normal CI are also part of the validation path.

## Pilot outcome

| Measurement | Result |
| --- | --- |
| Reviewed / admitted | 100 / 10 |
| Lemma / POS corrections | 0 / 0 |
| Sense-split deferrals | 25 |
| New starts / senses | 10 / 13 |
| Reference-only / relations / expressions | 0 / 0 / 0 |
| Writer trial | NOT_MEASURED |
| Editorial elapsed time and per-row workload | NOT_MEASURED |
| Human editorial review | NOT_PERFORMED |
| Publication gate | PENDING_OWNER_CONFIRMATION |

The extraction, local evidence counts, provenance ledger, and shared admission
boundary now form a reproducible bounded workflow. Writer outcomes and human
editorial cost remain unmeasured, so this pilot does not support scaling to a
larger corpus-derived batch yet. The canonical-mutating PR must remain unmerged
until the owner confirms the result-publication gate.
