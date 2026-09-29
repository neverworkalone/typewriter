# M9 corpus-backed lexical production

## Boundary

Corpus analysis is a local reference step. It may establish that a surface and analyzer proposal occur in the approved snapshot; it does not establish lexical admission, writer usefulness, sense boundaries, or relations. Every admitted record remains Typewriter-authored and passes the same source-bound semantic decision and shared lexical admission path used by historical recovery. Empty relation lists are valid.

The local full-corpus index, analysis SQLite database, selection JSON, and paragraph-bearing inventory stay under ignored `data/reference/`. The runner also writes a bounded `candidate-evidence.json` that retains morphology, aggregate counts, and at most three source/document/paragraph identifiers per candidate while omitting paragraph text. Only that text-free metadata and authored decisions may be considered for tracked review artifacts. Never copy contexts or paragraph forms into Git, product output, or a public report. The currently reviewed Written Corpus permission covers local reference use; publication or redistribution remains a separate owner decision.

## Produce a bounded batch

Run the permission-gated, local/manual command from the repository root:

```sh
npm run reference:corpus:candidates -- \
  --python /path/to/kiwipiepy-0.24.0-venv/bin/python \
  --batch-id m9-d-batch-01-YYYYMMDD \
  --candidate-limit 20 \
  --output-directory data/reference/production/m9-d/batch-01 \
  --exclude-lemma-source data/inventory/m5-target-seed.json \
  --exclude-lemma-source data/batches/prior-corpus-candidate-review.json
```

Use an approved local index and a Python environment pinned to `kiwipiepy==0.24.0` and its matching model. The command checks the documented permission record before opening the corpus index. Exclusion sources are byte-hashed and their distinct NFC lemmas are unioned and ordered deterministically. Supported sources include the M5 target seed, Issue #204 review ledger, an M9 corpus candidate review, and authored candidate-record sources. Pass the target seed and every prior batch disposition so unresolved or previously reviewed candidates are not silently reintroduced.

The extractor reads only one sampled paragraph batch at a time; it does not load the multi-gigabyte source or index into memory. It samples every twentieth paragraph in stable source/document order, applies the pinned Kiwi one-best analysis, maps `NNG`/`VV`/`VA` to noun/verb/adjective, adds citation `다` to verb/adjective morphemes, and retains the observed surface and analyzed morpheme span separately. The current minimum proposal shape is two precomposed Hangul syllables. These are extraction rules, not proof of a correct lemma or POS.

Candidate ordering uses distinct source count, distinct document count, analyzed-morpheme observations, then Unicode-binary lemma order. This is a bounded review-priority rule only. It does not rank writer usefulness or authorize admission. Selection is capped at 200; use small review batches until defects and editorial workload are measured.

## Coverage and review

Before selecting an uncovered candidate, the extractor checks exact canonical lemmas, curated search forms, and generated surface forms against the current product dictionary. Exact lemma matches remain in aggregate yield measurements but do not re-enter the candidate list. Search-form and generated-surface collisions remain explicit held yield. Prior target-seed and review-ledger lemmas are excluded by a digest-bound manifest. The result records total exact coverage, collision, ambiguity, OOV, exclusion, and selected counts so future batches can see both candidate yield and suppressions.

The ignored `candidate-inventory.json` contains up to three bounded paragraph contexts per selected candidate for local review. The sibling `candidate-evidence.json` removes the context field and retains only bounded provenance identifiers, observed surface/morpheme forms, counts, coverage status, and digests. Review the local contexts when identity, POS, lexical boundary, or sense is unclear; never resolve ambiguity from counts alone. Record each selected proposal as included, held, or rejected with a Typewriter-authored rationale and a closed lexical disposition basis. Admit a verified in-scope lexical identity even when its generality, vividness, writer usefulness, or relation count is unmeasured or low. Hold only source-supported identity/POS uncertainty, concrete unresolved sense boundaries, or canonical search collisions; reject only a demonstrated duplicate, nonlexical unit, or out-of-scope identity. Bind sense holds to distinct use directions and paragraph IDs from the bounded reviewed evidence. Writer-use notes and relation richness can guide enrichment or review priority, never lexical eligibility.

The tracked candidate-review source binds the exact corpus input manifest digest, index logical-row digest, permission-record digest, canonical surface revision, Python/Node/SQLite/Kiwi/model versions, extractor and orchestrator source hashes, candidate limit, sampling policy, deterministic order, prior-source hashes, selection digest, and bounded candidate evidence. It contains no paragraph text. Every M9 candidate review runs the reusable `validateCorpusCandidateReviewDispositions` contract, either through the batch validator or `npm run validate:corpus-candidate-review -- <review.json>`. Candidate records that clear lexical identity/sense review then receive Typewriter-authored senses and use the shared semantic decision source, direct-search, and lexical production validators. Only included/corrected reviewed records enter canonical JSONL.

## Issue #221 batch 01

The first repeatability run used the pinned 2025 Written Corpus snapshot: 3,410 sources/documents and 4,988,970 indexed paragraphs. Stable one-in-twenty sampling analyzed 251,086 paragraphs (5.0328%) without loading the full corpus. The extractor found 55,580 distinct lemma proposals before exact coverage filtering; 2,022 had an exact canonical lemma, 41 had curated/generated surface collisions, 930 had analyzer ambiguity, and 22,845 were OOV proposals. These are extraction-yield counts, not frequency rankings or editorial quality scores. The batch excluded 1,551 prior target/review lemmas and selected 20 candidates with at most three paragraph identifiers each (60 paragraph rows total). Eight short-form literal fallback queries are separately labeled as substring counts, not lemma frequencies.

The authored review included 11 of 20 candidates and held 9 for unresolved morphology or concrete sense-boundary evidence; it rejected none. The formerly held `상태` and `이번` entries were admitted after confirming their noun identity and bounded lexical meanings. Breadth, commonness, missing writer-use evidence, and missing distinctive routes are not lexical blockers. The 11 canonical entries have zero relations because this slice did not author candidate-specific relation evidence. Their Typewriter-authored diagnostic sentence frames and route labels are consistency/enrichment metadata, not corpus quotations or writer-outcome measurements. Only the reviewed candidate/evidence metadata, semantic source, promotion rows, and canonical JSONL are tracked. Local paragraph contexts, index, candidate inventory, selection, and text-free local evidence remain ignored under `data/reference/`.

Candidate inventory IDs `m5-5426` through `m5-5445` were allocated after the existing promotion ledger's highest ID (`m5-5425`), including all held rows so later review cannot reuse their identities. The 11 admitted IDs have canonical promotion rows; the M5 target seed remains a historical snapshot and is not rewritten for this corpus batch.

The validation binds the tracked review ledger to the byte hashes of the ignored selection and text-free evidence artifacts, checks their exact morphology/coverage/provenance fields, then runs shared source-bound semantic admission and complete canonical coverage. Reproducing the exact candidate set requires the same approved corpus snapshot, exclusion sources, canonical surface revision, candidate limit, and pinned Kiwi/Node/SQLite tools.

## Validate and reuse

Run the corpus/index extraction regressions locally; they require the reference workflow and remain outside normal CI and product builds:

```sh
node --test scripts/reference/run-corpus-lemma-pilot.test.mjs
python3 scripts/reference/test-corpus-lemma-pilot.py
```

The text-free corpus candidate-disposition contract and its synthetic regressions do not require corpus or index access. `ci:normal` runs the regression suite and discovers every `m9-corpus-candidate-review-v1` JSON artifact under `data/batches`, regardless of issue or batch ID.

Run the issue batch validator, full relevant canonical/search validation, and normal CI after an admitted batch has been authored:

```sh
npm run batch:issue-221:check
npm run validate:search
npm run ci:normal
```

The batch validator binds the reviewed candidate/evidence artifacts, authored semantic decisions, and canonical import; it then invokes `validateLexicalProduction` on the full selected candidate pool, checks direct exact-lemma search, validates complete canonical semantic coverage, and compares two deterministic SQLite builds by logical contents. Keep corpus/index access and synthetic corpus-extraction fixtures out of `ci:normal`; the text-free candidate-disposition regressions and artifact gate run there.

M9-D/E can reuse the same runner and validation contracts with a new batch ID, output directory, pinned source/index and tool metadata, bounded candidate limit, and exclusion sources for the current target seed and all prior corpus reviews. Run the generic candidate-disposition validator for each review file, then bind it to that batch's source evidence and semantic decisions. Do not increase the batch size to compensate for low editorial yield. No corpus-to-canonical automation or publication authorization is implied by this workflow.
