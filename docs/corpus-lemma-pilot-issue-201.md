# Corpus lemma pilot (#201)

> **Historical pilot record.** Issue #823 retired corpus ingestion, the local
> indexer, and this pilot workflow. The entrypoints named below are absent from
> the current checkout. The SQLite path records the retained reference data
> location only; the commands are historical and are not runnable here.

Issue #201 documented a local/manual pilot for 100 candidates. It was not a
bulk-import job and was not part of normal CI, the product build, Pages, or
extension packaging.

## Historical replay procedure (retired by #823)

At the time of the pilot, the shared Written Corpus index had to exist at
`~/.cache/typewriter/reference/corpus/indexes/written-corpus-2025.sqlite`, and the permission gate in
`docs/external-material-review-written-corpus-2025.md` had to permit the
stated reference use. This path is retained to identify the input location,
not to imply that a replay tool remains available.

The pilot used the per-machine Python environment and recorded both package
versions in its inventory without adding them to the product or repository
dependency graph. Its historical command was:

```sh
node scripts/python/bootstrap.mjs
node scripts/reference/run-corpus-lemma-pilot.mjs \
```

The historical run rebuilt the Typewriter SQLite surface from canonical JSONL,
then scanned paragraphs at a fixed interval: paragraph ordinals divisible by
20 within each source-ordered document. Rows were read with `fetchmany(32)`.
This deterministic sample included the first paragraph of each document,
processed no more than about five percent of the paragraph rows, and kept only
one document/source aggregate in memory at a time. The 3.67 GiB corpus index
was opened read-only; the database file was never loaded into a JavaScript or
Python buffer.

## Historical candidate and evidence contract

- Kiwi's one-best `NNG`, `VV`, and `VA` analyses produced noun, verb, and
  adjective proposals. `VV`/`VA` stems received `다`; nouns retained the
  analyzed form. Candidates had to contain at least two precomposed Hangul
  syllables.
- The proposal inventory kept the whitespace-delimited observed surface,
  exact analyzer morpheme span, proposed lemma, POS, analyzer tag, sample
  counts, document/source spread, index digest, and tool versions separate.
  Confidence was uncalibrated. OOV tokens, competing POS analyses, and observed
  morpheme spans mapped to multiple lemmas were held for review.
- Before selection, candidates were checked against every canonical lemma,
  curated search form, and generated surface form from the current product
  projection. The comparison used the runtime's Unicode NFC and surrounding
  whitespace normalization and retained each match kind, record ID, canonical
  lemma, and generated sense/POS/rule provenance.
- An exact canonical lemma match was covered. A curated search-form or
  generated surface collision remained in the inventory as a held candidate;
  it was not silently discarded as an existing lemma. Exactly 100 candidates
  without an exact canonical lemma were selected in deterministic order by
  source spread, document spread, analyzer occurrences, then lemma. These were
  review candidates, not an admission quota or quality ranking.
- For each candidate, the historical runner passed the dominant observed
  surface to `countCorpusMatches()` for a complete SQL literal paragraph-match
  count and to `searchCorpusIndex()` for at most three representative
  paragraphs. The literal count was for that observed surface, not a lemma or
  token frequency. Search rows were limited in SQL before reaching JavaScript.

## Historical Issue #212 handoff proposal (retired by #823)

The proposal treated corpus frequency as a way to identify words for later
relation-enrichment work, not as admission authority. It did not exclude an
otherwise valid entry for being common, general, having low standalone writer
usefulness, or having no relations. An admitted record could keep an empty
relation list until bounded editorial evidence supported enrichment.

The proposed admission evidence included the approved source and permitted
use, source or index digest, observed surface, analyzed morpheme span, proposed
lemma and POS, ambiguity, and bounded evidence provenance. The proposed checks
covered lexical-unit identity, supported POS and sense boundaries, exact
canonical lemma coverage, curated search-form coverage, supported
generated-surface collisions, and cross-record duplicates. Uncertain identity,
sense, or collisions were to be resolved before admission; raw corpus text and
evidence excerpts were not to be committed.

The proposal routed cleared records through the then-existing shared lexical
producer, admission, canonical validator, and direct-search contract. It kept
relation enrichment as a separate evidence-bound editorial decision. This was
a historical handoff proposal, not authorization for a larger corpus batch or
a current workflow.

## Publication gate

Raw corpus paragraphs and evidence excerpts remain excluded from Git. The
tracked pilot report contains aggregate workflow measurements only. The
historical pilot admitted or published no corpus-derived canonical record.
The owner confirmed on 2026-10-12 that NIKL approved the
result-publication application for the submitted Chrome Web Store result and
authorized distribution of independently authored Typewriter output under the
project data license. This removes the former blanket publication hold; it does
not admit a candidate or replace lexical validation, exact-revision, deterministic
build, package-content, license/notice, or applicable Store/Pages checks. Raw
corpus text and specifically identified copied or restricted third-party content
remain excluded (`DATA-LICENSE.md`, `docs/publication-boundary.md`).

Kiwi references: [project API and usage](https://github.com/bab2min/kiwipiepy),
[release history](https://pypi.org/project/kiwipiepy/).
