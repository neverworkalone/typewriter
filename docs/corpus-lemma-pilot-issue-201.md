# Corpus lemma pilot (#201)

This is a local/manual workflow for a single 100-candidate pilot. It is not a
bulk-import job and is not part of normal CI, the product build, Pages, or
extension packaging.

## Run locally

The shared Written Corpus index must already exist at
`~/.cache/typewriter/indexes/written-corpus-2025.sqlite`, and the permission gate in
`docs/external-material-review-written-corpus-2025.md` must permit the stated
reference use.

Use the per-machine Python environment. The pilot records both package versions
in its inventory and does not add them to the product or repository dependency
graph:

```sh
node scripts/python/bootstrap.mjs
node scripts/reference/run-corpus-lemma-pilot.mjs \
```

The run rebuilds the Typewriter SQLite surface from canonical JSONL, then scans
paragraphs at a fixed interval: paragraph ordinals divisible by 20 within each
source-ordered document. Rows are read with `fetchmany(32)`. This deterministic
sample includes the first paragraph of each document, processes no more than
about five percent of the paragraph rows, and keeps only one document/source
aggregate in memory at a time. The 3.67 GiB corpus index is opened read-only;
the database file is never loaded into a JavaScript or Python buffer.

## Candidate and evidence rules

- Kiwi's one-best `NNG`, `VV`, and `VA` analyses produce noun, verb, and
  adjective proposals. `VV`/`VA` stems receive `다`; nouns retain the analyzed
  form. Candidates must contain at least two precomposed Hangul syllables.
- The proposal inventory keeps the whitespace-delimited observed surface,
  exact analyzer morpheme span, proposed lemma, POS, analyzer tag, sample
  counts, document/source spread, index digest, and tool versions separate.
  Confidence is uncalibrated. OOV tokens, competing POS analyses, and observed
  morpheme spans mapped to multiple lemmas remain held for review.
- Before selection, candidates are checked against every canonical lemma,
  curated search form, and generated surface form from the current product
  projection. The comparison uses the runtime's Unicode NFC and surrounding
  whitespace normalization and retains each match kind, record ID, canonical
  lemma, and generated sense/POS/rule provenance.
- An exact canonical lemma match is covered. A curated search-form or generated
  surface collision remains in the inventory as a held candidate; it is not
  silently discarded as an existing lemma. Exactly 100 candidates without an
  exact canonical lemma are selected in deterministic order by source spread,
  document spread, analyzer occurrences, then lemma. These are review
  candidates, not an admission quota or quality ranking.
- For each candidate, the dominant observed surface is passed to
  `countCorpusMatches()` for a complete SQL literal paragraph-match count and
  to `searchCorpusIndex()` for at most three representative paragraphs. The
  literal count is for that observed surface; it is not a lemma or token
  frequency. Search rows are limited in SQL before reaching JavaScript.

## Future corpus expansion handoff (Issue #212)

Corpus frequency can help identify words for later relation-enrichment work; it
does not determine whether a valid, in-scope lexical record may be admitted.
Do not exclude an otherwise valid entry because it is common, general, has low
standalone writer usefulness, or has no relations. An admitted record may keep
an empty relation list until bounded editorial evidence supports enrichment.

Before proposing admission, keep the approved source and permitted use, source
or index digest, observed surface, analyzed morpheme span, proposed lemma and
POS, ambiguity, and bounded evidence provenance traceable. Check lexical-unit
identity, supported POS and sense boundaries, exact canonical lemma coverage,
curated search-form coverage, supported generated-surface collisions, and
cross-record duplicates. Resolve uncertain identity, sense, or collisions
before admission. Do not commit raw corpus text or evidence excerpts.

Pass cleared records through the ordinary shared lexical producer, admission,
canonical validator, and direct-search contract. Historical `start` and
`reference-only` roles do not alter eligibility. Keep relation enrichment as a
separate evidence-bound editorial decision. This handoff defines how a future
bounded batch should work; it does not authorize a larger corpus batch in Issue
#212.

## Local outputs and publication gate

The default run writes only under `~/.cache/typewriter/runs/issue-201-pilot/`:

- `candidate-analysis.sqlite` stores aggregated sample counts without corpus
  paragraphs;
- `candidate-selection.json` records the 100 selected candidate proposals;
- `pilot-inventory.json` adds bounded local paragraph evidence for review.

Do not add these files, corpus paragraphs, or evidence excerpts to Git. The
tracked pilot report contains aggregate workflow measurements only. No
corpus-derived canonical record is admitted or published by this tool. Any
future admission must use the ordinary lexical production and canonical
validation workflow, and public merge/package exposure remains held until the
owner confirms the applicable result-publication permission.

Kiwi references: [project API and usage](https://github.com/bab2min/kiwipiepy),
[release history](https://pypi.org/project/kiwipiepy/).
