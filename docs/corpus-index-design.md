# NIKL written-corpus local index design

## Decision

Treat the NIKL sample and any derived index as local reference evidence. Keep the raw JSON and generated SQLite under the already ignored data/reference/ work area. Add a future command under scripts/reference/; keep it separate from scripts/build/, which builds the canonical product dictionary.

Use SQLite for source, document, and paragraph records. Build an FTS5 trigram index over paragraph text for literal substring lookup, then join hits back to source and document metadata. This is a text-evidence index, not a Korean tokenizer: it cannot claim lemma frequency, word-token frequency, POS counts, or writer usefulness. A hit must never create or admit a Typewriter candidate automatically.

This issue is the design pilot only. No production indexer, full-corpus import, canonical data change, or product-package input is added here.

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
| documents | source_path, document_id composite primary key; title; author; publisher; document_date; foreign key to source_files | Preserve the document-level source metadata. |
| paragraphs | integer paragraph_rowid primary key; source_path; document_id; paragraph_id; ordinal; form; unique (source_path, paragraph_id) and (source_path, document_id, ordinal); composite foreign key to documents | Preserve raw paragraph text, source IDs, and source order. |
| paragraph_fts | FTS5 external-content table on paragraphs.form, keyed by paragraph_rowid, using tokenize='trigram' | Find literal substrings of at least three Unicode characters without requiring Korean word segmentation. The external-content form avoids storing a second copy of paragraph text. |
| index_metadata | schema/builder version, SQLite version, sorted input-manifest digest, source/document/paragraph counts | Identify the logical build inputs and index contract. Do not store a volatile build timestamp in the reproducibility digest. |

Use B-tree indexes for (source_path, document_id, ordinal), source category/year, and document fields only where the first indexer demonstrates those filters. Keep the initial set small. The main query is candidate substring → matching paragraph rowids → paragraphs → document metadata → source category/path. A second query groups matching paragraphs by category or year. Results should be ordered by source path, document ID, and paragraph ordinal, not by an inferred relevance score.

FTS5 trigram search is character-substring search, not Korean morphological analysis. SQLite documents that trigram full-text searches do not match strings shorter than three Unicode characters. The local Node 24.19.0 / SQLite 3.53.3 runtime successfully created an FTS5 trigram table; a two-character query returned no rows. The repository's declared Node minimum is 22.13.0, so the implementation must feature-check FTS5 trigram on its supported runtime. For one- and two-character queries, use a correct literal scan fallback initially and measure it. If short queries are too slow in actual use, evaluate a separate short-string index from observed query demand. Do not silently drop those searches. See the [SQLite trigram tokenizer documentation](https://www.sqlite.org/fts5.html#the_trigram_tokenizer).

## Repository and data boundary

- Raw source stays in the ignored local area data/reference/corpus/ (or another approved temporary workspace). It is not added to Git.
- The proposed generated database path is data/reference/indexes/nikl-written-2025.sqlite. The existing .gitignore excludes all of data/reference/; no new ignore rule is needed.
- The proposed tracked CLI is scripts/reference/build-nikl-index.mjs. It is research/reference tooling, separate from the canonical-to-product build in scripts/build/.
- The derived index is not canonical JSONL, an inventory projection, a batch manifest, or product output. It must not be read by npm run build, Pages, or package commands.
- Do not commit corpus text, generated SQLite, candidate dumps, or context snippets. Existing lexical workflows may use source evidence only after its use is authorized; any resulting target decision remains Typewriter-authored and follows the existing inventory, reviewed-batch, validation, and canonical import gates.

The official [corpus overview](https://kli.korean.go.kr/introduce/corpusIntroduce.do) distinguishes raw corpora from corpora with language-analysis annotations. The [usage FAQ](https://kli.korean.go.kr/m/boards/faqList.do) says use is limited to an approved purpose in Korean-language or language-information-processing research and development; public results must not contain source text and require prior approval. The [2025 corpus listing](https://kli.korean.go.kr/corpus/request/corpusRegist.do) describes the written corpus, but that description is not an individual user's usage agreement. Before a real index build, verify the downloaded file's agreement and that Typewriter's intended local lexical-evidence use is an approved purpose. The issue-start design does not establish that permission, or permission to publish corpus-derived results.

## Full-corpus implications

The current local data/reference/corpus/ directory contains 3,410 .json files totaling 1,906,201,772 bytes (about 1.775 GiB); the largest file is 4,143,019 bytes (about 3.95 MiB). This is a measurement of this checkout, not an official complete-corpus size claim. Only the issue's 280 KB pilot file was schema-inspected.

- **Parsing:** enumerate relative paths in stable lexical order, parse one JSON file at a time, insert its documents and paragraphs with prepared statements, then discard the parsed object before opening the next file. Current file granularity bounds working memory to one file plus SQLite buffers rather than the 1.775 GiB corpus. First scan all files for schema compatibility; fail with the file path and field path on an unsupported shape instead of silently omitting data.
- **Rebuild/update:** start with a full rebuild into a temporary SQLite file. Record each file's SHA-256, validate row counts, foreign keys, FTS integrity, and PRAGMA quick_check, then atomically replace the local index only after success. Hashes make input changes and deletions visible. Add per-file incremental replacement only if a measured full rebuild is too slow; no incremental protocol is needed to answer the current pilot.
- **Reproducibility:** sort file paths, preserve each source's document/paragraph order, use deterministic schema and insert order, and bind the sorted file-path/hash manifest in index_metadata. This promises stable logical rows for the same inputs and builder contract. Byte-identical SQLite files across different SQLite versions are not claimed; record the SQLite version and compare a canonical sorted row digest if exact logical verification is needed.
- **Storage:** paragraph text is the dominant base-table payload. Trigram postings, SQLite pages, and indexes on metadata are the likely additional size drivers; the FTS external-content table avoids another stored text copy. FTS build size, build time, and lookup latency have not been benchmarked. Check free disk space before a staged build because the source, current index, and temporary replacement can coexist.
- **Update cadence:** the corpus is a local reference snapshot, not product runtime data. Rebuild when an authorized source snapshot changes. A file-hash based incremental path is a later optimization, justified only by observed rebuild cost and source update cadence.

Known blockers for the first implementation are full-folder schema variation, the exact terms attached to the local download, the FTS5 feature on the minimum supported Node runtime, short-query latency, and actual FTS storage cost. None is answered by the one-file pilot.

## Follow-up implementation plan

Create a separate indexer task with this bounded sequence:

1. Verify the downloaded corpus agreement and approved Typewriter use before reading the full directory for index generation. Inventory and schema-check every input file; record path, size, and digest, and fail closed on unsupported structure.
2. Implement scripts/reference/build-nikl-index.mjs with Node's existing node:sqlite platform, a streaming-across-files loop (one parsed JSON source file at a time), stable source IDs, the tables above, and a temporary-output/atomic-replacement lifecycle.
3. Feature-check FTS5 trigram on the minimum supported Node version. Add substring queries for 3+ Unicode characters and a correct scan fallback for 1–2 characters. Return paragraph hits with local source IDs and metadata; never label results lemma/POS frequency.
4. Add small self-authored JSON fixtures under tests/fixtures/ for positive and negative substring matches, paragraph/source grouping, duplicate IDs scoped to different paths, malformed input rejection, and a rebuild that produces the same sorted logical rows. Do not place real corpus text in fixtures.
5. Build the local full index only after the permission gate passes. Measure peak memory, total build time, database/FTS size, and representative short/long lookup latency. Use those measurements to decide whether per-file incremental updates or a short-query index is warranted.
6. Confirm the generated file remains ignored and absent from canonical validators, extension/Web builds, and release packages. Keep all corpus evidence outside the canonical admission path.

## Pilot acceptance summary

- Actual pilot schema and present-versus-absent fields: documented above.
- Useful lookup boundaries and exact-vs-derived information: documented above.
- SQLite tables, indexes, query paths, artifact boundaries, and rebuild plan: specified above.
- Full-corpus measurements and unresolved uncertainties: recorded without claiming a performance benchmark or rights clearance.
- Production indexer, corpus-wide schema validation, full-corpus build, and canonical changes: deferred to the follow-up task.
