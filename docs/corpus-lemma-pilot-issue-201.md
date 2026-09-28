# Corpus lemma pilot (#201)

This is a local/manual workflow for a single 100-candidate pilot. It is not a
bulk-import job and is not part of normal CI, the product build, Pages, or
extension packaging.

## Run locally

The local Written Corpus index must already exist at
`data/reference/indexes/written-corpus-2025.sqlite`, and the permission gate in
`docs/external-material-review-written-corpus-2025.md` must permit the stated
reference use.

Install the morphology tool in an ignored local environment. The pilot records
both package versions in its inventory and does not add them to the product or
repository dependency graph:

```sh
python3 -m venv data/reference/pilots/issue-201/venv
data/reference/pilots/issue-201/venv/bin/python -m pip install 'kiwipiepy==0.24.0'
node scripts/reference/run-corpus-lemma-pilot.mjs \
  --python data/reference/pilots/issue-201/venv/bin/python
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
  whitespace normalization.
- Exactly 100 uncovered lemma strings are selected in deterministic order by
  source spread, document spread, analyzer occurrences, then lemma. These are
  review candidates, not an admission quota or quality ranking.
- For each candidate, the dominant observed surface is passed to
  `countCorpusMatches()` for a complete SQL literal paragraph-match count and
  to `searchCorpusIndex()` for at most three representative paragraphs. The
  literal count is for that observed surface; it is not a lemma or token
  frequency. Search rows are limited in SQL before reaching JavaScript.

## Local outputs and publication gate

The run writes only under ignored `data/reference/pilots/issue-201/`:

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
