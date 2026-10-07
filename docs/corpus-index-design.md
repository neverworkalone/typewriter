# Written corpus local index design

## Decision

Treat the corpus sample and any derived index as local reference evidence. Keep the raw JSON and generated SQLite under the already ignored data/reference/ work area. The #194 implementation lives under scripts/reference/ and is separate from scripts/build/, which builds the canonical product dictionary.

Use SQLite for source, document, and paragraph records. Build an FTS5 trigram index over paragraph text for literal substring lookup, then join hits back to source and document metadata. This is a text-evidence index, not a Korean tokenizer: it cannot claim lemma frequency, word-token frequency, POS counts, or writer usefulness. A hit must never create or admit a Typewriter candidate automatically.

Issue #192 was the design pilot. Issue #194 implements the local indexer without adding corpus-derived canonical data or product-package inputs.

## Pilot file inspected

The authoritative pilot, data/reference/corpus/WARW2500000880.json, is about 280 KB. It is a JSON object with three top-level fields: id, metadata, and document.

| Level | Fields present in this file | Observed contents |
| --- | --- | --- |
| Corpus file | id, metadata, document | One corpus ID; one document in the document array. |
| Corpus metadata | title, creator, distributor, year, category, annotation_level, sampling | Source/provider and classification metadata. In this file, category is 문어 > 책-상상 > 문학, annotation_level is ["원시"], and sampling is 본문 전체. year is a string. |
| Document | id, metadata, paragraph | One document ID; metadata keys are title, author, publisher, and date. date is a string (YYYYMMDD in this example). |
| Paragraph | id, form | 465 paragraphs. form is the paragraph's raw text. Paragraph IDs are unique in this sample and look hierarchical; keep source IDs opaque. |

The 465 paragraph forms contain 94,342 Unicode code points in total (median 214; range 5–518). These are paragraph records, not sentence records. The file contains no token or word array, lemma/base form, POS or morphological analysis, per-token IDs, or per-sentence metadata. A value in annotation_level describes this file as raw; it does not supply hidden token annotations.

These are findings about the requested file only. The shape of every other corpus file has not been audited and must not be inferred from this one sample.

## What the data can support

| Need | Pilot support | Honest interpretation |
| --- | --- | --- |
| Word or lemma frequency | No | A raw paragraph string has no word boundary, lemma, or inflection mapping. Do not produce a word-frequency field without a separately authorized, reviewed analysis step. |
| Surface-form frequency | Limited | Literal substring occurrence and paragraph-hit counts can be derived. Label them substring_occurrences or paragraph_hits; they are not counts of standalone word tokens. Specify overlap behavior if occurrence totals are added. |
| POS-aware counts | No | No POS tags or token analyses are present. Do not add an analyzer to this pilot. |
| Representative contexts | Yes, at paragraph level | Return the containing paragraph and its source IDs. Sentence excerpts would have to be derived and are not part of the first index. |
| Source or genre distribution | Yes | Group paragraph hits by corpus category, year, and available document metadata. category is source-level classification, not a paragraph-level register label. |
| Candidate to corpus evidence | Yes, as text lookup | Search a candidate string against paragraph text and return matching source, document, paragraph ID, and local context. This establishes an occurrence, not a lexical relation or candidate ranking. |

The first version should expose literal matches and paragraph-level contexts. It should not silently normalize away source distinctions, split paragraphs into guessed sentences, assign POS, or call raw substring counts “lemma frequency.”

## Local SQLite design

Keep one row per source file, document, and paragraph. Source paths scope the source-provided IDs, so a repeated corpus or paragraph ID in another file cannot overwrite evidence.

| Table | Important columns and keys | Purpose |
| --- | --- | --- |
| source_files | source_path primary key; corpus_id; title; creator; distributor; year; category; annotation_level_json; sampling; source_sha256; source_bytes | Preserve queryable source metadata and bind each indexed file to its exact input bytes. |
| documents | integer document_rowid primary key; source_path; document_id; document_ordinal; title; author; publisher; document_date; unique (source_path, document_ordinal); foreign key to source_files | Preserve document metadata and source order. document_id is an opaque, non-unique source attribute. |
| paragraphs | integer paragraph_rowid primary key; document_rowid; paragraph_id; ordinal; form; unique (document_rowid, ordinal); foreign key to documents | Preserve raw paragraph text, source IDs, and source order. paragraph_id is an opaque, non-unique source attribute, not a row key. |
| paragraph_fts | FTS5 external-content table on paragraphs.form, keyed by paragraph_rowid, using tokenize='trigram' | Find literal substrings of at least three Unicode characters without requiring Korean word segmentation. The external-content form avoids storing a second copy of paragraph text. |
| index_metadata | schema/builder version, SQLite version, sorted input-manifest digest, source/document/paragraph counts | Identify the logical build inputs and index contract. Do not store a volatile build timestamp in the reproducibility digest. |

Use B-tree indexes for (document_rowid, ordinal), a non-unique (document_rowid, paragraph_id) lookup, source category/year, and document fields only where the first indexer demonstrates those filters. Keep the initial set small. The main query is candidate substring → matching paragraph rowids → paragraphs → document metadata → source category/path. A second query groups matching paragraphs by category or year. Results should be ordered by source path, document ordinal, and paragraph ordinal, not by an inferred relevance score. Surrogate row keys and array ordinals preserve separate rows even if source-provided corpus, document, or paragraph IDs repeat.

FTS5 trigram search is character-substring search, not Korean morphological analysis. SQLite documents that trigram full-text searches do not match strings shorter than three Unicode characters. The local Node 24.19.0 / SQLite 3.53.3 runtime successfully created an FTS5 trigram table; a two-character query returned no rows. The repository's declared Node minimum is 24.19.0 (Node 24 LTS), whose SQLite provides FTS5 trigram; FTS5 trigram is therefore a required capability of the supported runtime and the implementation fails with a clear capability error instead of branching or skipping when it is unavailable. For one- and two-character queries, use a correct literal scan fallback initially and measure it. If short queries are too slow in actual use, evaluate a separate short-string index from observed query demand. Do not silently drop those searches. See the [SQLite trigram tokenizer documentation](https://www.sqlite.org/fts5.html#the_trigram_tokenizer).

## Repository and data boundary

- Raw source stays in the ignored local area data/reference/corpus/ (or another approved temporary workspace). It is not added to Git.
- The proposed generated database path is data/reference/indexes/written-corpus-2025.sqlite. The existing .gitignore excludes all of data/reference/; no new ignore rule is needed.
- The tracked CLI is scripts/reference/build-corpus-index.mjs. It is research/reference tooling, separate from the canonical-to-product build in scripts/build/.
- The derived index is not canonical JSONL, an inventory projection, a batch manifest, or product output. It must not be read by npm run build, Pages, or package commands.
- Do not commit corpus text, generated SQLite, candidate dumps, or context snippets. Existing lexical workflows may use source evidence only after its use is authorized; any resulting target decision remains Typewriter-authored and follows the existing inventory, reviewed-batch, validation, and canonical import gates.

The official [corpus overview](https://kli.korean.go.kr/introduce/corpusIntroduce.do) distinguishes raw corpora from corpora with language-analysis annotations. The [request help](https://kli.korean.go.kr/corpus/request/faqInfo.do?lang=en) says a request is reviewed and approved, after which the user signs a corpus license agreement before downloading. The [2025 corpus listing](https://kli.korean.go.kr/corpus/request/corpusRegist.do) describes the written corpus, but that description is not an individual user's usage agreement. Before a real index build, verify the downloaded file's agreement and that Typewriter's intended local lexical-evidence use is an approved purpose. For issue #197, the owner confirmed the NIKL site showed `permitted` for the requested local reference use; the machine-readable scopes and review date are recorded in [external-material-review-written-corpus-2025.md](external-material-review-written-corpus-2025.md). This approval does not authorize publishing or embedding corpus text or the local index.

## Full-corpus implications

The local `data/reference/corpus/` snapshot used for issue #197 contained 3,410 `.json` files totaling 1,906,201,772 bytes (about 1.775 GiB); the largest file was 4,143,019 bytes (about 3.95 MiB). This is a measurement of that checkout, not an official complete-corpus size claim. The full-folder schema result and build measurements are recorded below.

- **Parsing:** enumerate relative paths in stable lexical order, parse one JSON file at a time, insert its documents and paragraphs with prepared statements, then discard the parsed object before opening the next file. Current file granularity bounds working memory to one file plus SQLite buffers rather than the 1.775 GiB corpus. First scan all files for schema compatibility; fail with the file path and field path on an unsupported shape instead of silently omitting data.
- **Rebuild/update:** start with a full rebuild into a temporary SQLite file. Record each file's SHA-256, validate row counts, foreign keys, FTS integrity, and PRAGMA quick_check, then atomically replace the local index only after success. Hashes make input changes and deletions visible. Add per-file incremental replacement only if a measured full rebuild is too slow; no incremental protocol is needed to answer the current pilot.
- **Reproducibility:** sort file paths, preserve each source's document/paragraph order, use deterministic schema and insert order, and bind the sorted file-path/hash manifest in index_metadata. This promises stable logical rows for the same inputs and builder contract. Byte-identical SQLite files across different SQLite versions are not claimed; record the SQLite version and compare a canonical sorted row digest if exact logical verification is needed.
- **Storage:** paragraph text is the dominant base-table payload. Trigram postings, SQLite pages, and indexes on metadata are the likely additional size drivers; the FTS external-content table avoids another stored text copy. Issue #197 measured the FTS shadow tables, total index size, full rebuild time, and representative lookup latency below. Check free disk space before a staged build because the source, current index, and temporary replacement can coexist.
- **Update cadence:** the corpus is a local reference snapshot, not product runtime data. Rebuild when an authorized source snapshot changes. A file-hash based incremental path is a later optimization, justified only by observed rebuild cost and source update cadence.

The full-folder schema and FTS storage uncertainties from the pilot were measured in issue #197. The one-character literal fallback is materially slower than the trigram path; keep it correct and measure actual query demand before adding a separate short-query index. The builder still probes FTS5 trigram as a fail-closed check: the supported Node 24.19.0 baseline must provide it, so the probe only catches an unexpected runtime regression with a clear error rather than selecting an alternate path.

## Bounded search and future corpus tooling

Every paragraph-returning `searchCorpusIndex()` lookup is limited in SQL before rows are materialized in Node.js. Omitting `limit` returns at most 50 rows; callers may request 1–200 rows, and larger or invalid values fail. The same contract applies to FTS5 trigram and one-/two-character literal fallback searches. There is no unlimited row-returning mode. The CLI accepts the same bounded `--limit` range and does not provide an unlimited option.

Use the corpus APIs according to the amount of evidence needed:

- Use bounded `searchCorpusIndex()` results when actual paragraph evidence is needed.
- Use `countCorpusMatches()` or the CLI's `--count` mode for exhaustive match counts; both run `COUNT(*)` inside SQLite and return only the aggregate value.
- Process candidate words incrementally. Handle one query and its bounded result batch at a time, then release those results before continuing; do not collect arrays for many broad queries into one large in-memory structure.
- Do not read the SQLite index into a `Buffer` or copy the whole database into application memory.
- Keep corpus/index access out of product runtime, Pages, extension builds, and normal CI. The synthetic corpus reference suite remains local/manual and is not a normal-CI dependency.

## Full-corpus build measurements (#197)

The owner confirmed the site permission status as `permitted` for this issue's local reference task. The full-corpus preflight and build ran on 2026-09-27 against the local snapshot only. No corpus text or search result excerpts were added to Git.

| Measurement | Result |
| --- | ---: |
| Source JSON files | 3,410 |
| Total source bytes | 1,906,201,772 (about 1.775 GiB) |
| Documents | 3,410 |
| Paragraphs | 4,988,970 |
| Unsupported or differing structural schemas | 0; all files had the same source, metadata, document, and paragraph key sets; `annotation_level` was an array in all 3,410 files |
| Full build wall time | 485.68 seconds (8 min 5.68 sec) |
| Peak memory | Not captured; `/usr/bin/time -l` could not collect resource statistics because `sysctl kern.clockrate` was denied |
| SQLite version | 3.53.3 |
| Final SQLite size | 3,940,503,552 bytes (about 3.67 GiB) |
| FTS5 shadow-table size | 2,051,674,112 bytes (about 1.91 GiB; 52.07% of database pages) |
| 4-character FTS query `사람들은` | 10-row limited lookup; median 2,078 ms over 5 calls |
| 1-character literal query `빛` | 10-row limited lookup; median 4,787 ms over 5 calls |

The audit and build agreed on source/document/paragraph counts and the sorted input-manifest digest `50dd0c6c4ecb9250e75c11dde9e854e1b39de14e12d7a7087d2da041d75ef211`. The completed index has logical-row digest `c3b2befa1480804bf6c005cb4a43eb7b2e82d6ad7d77790af4dc82b76f4bd1dd`. Foreign keys, FTS integrity, SQLite `quick_check`, read-only reopen, and deterministic source/document/paragraph ordering passed.

A full rebuild is operationally acceptable for this one-time local snapshot, so the measurements do not justify a separate incremental-index task. Revisit that decision if the authorized snapshot changes frequently or repeated 8-minute rebuilds become a real operational burden. The short-query fallback remains correct but is slower; defer a specialized short-string index until actual query demand justifies it.

## Pilot acceptance summary (#192 design)

- Actual pilot schema and present-versus-absent fields: documented above.
- Useful lookup boundaries and exact-vs-derived information: documented above.
- SQLite tables, indexes, query paths, artifact boundaries, and rebuild plan: specified above.
- Full-corpus measurements and unresolved uncertainties: recorded without claiming a performance benchmark or rights clearance.
- Production indexer, corpus-wide schema validation, and full-corpus build were deferred to #194; canonical changes remain out of scope.

## Implementation status (#194 and #197)

- The local builder, reusable literal lookup, and permission check are implemented under scripts/reference/. Deterministic fixture tests are retained at scripts/reference/corpus-index.test.mjs and run manually with `node --test scripts/reference/corpus-index.test.mjs` on an FTS5-capable local runtime.
- Every build runs the same fail-closed schema validation in a sorted preflight and again while inserting one JSON file at a time. Temporary SQLite output is validated before replacing the active local index.
- The build and lookup CLIs require a permitted reference decision, explicit permission for local storage, schema scanning and processing, SQLite/FTS indexing, and lexical-reference use, plus completed reviews of distribution/embedding and attribution/notice terms. Missing or pending fields block real-corpus operations. Issue #197 records the owner's site permission confirmation and completed the full-corpus preflight and build.
- The builder fixes repository-local output to the ignored `data/reference/indexes/` directory. The fixture suite is retained for local/manual use and is not wired into normal CI.
- The issue #197 snapshot is summarized in the measurements above. The generated index remains local; no corpus-derived lexical records were admitted.
- The index remains ignored local reference data. Product build, package, Pages, release, and canonical admission paths do not reference scripts/reference/ or data/reference/.
