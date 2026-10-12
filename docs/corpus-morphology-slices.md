# Resumable local corpus morphology (#550 → #549)

This is an independent morphology cache, with no dictionary, candidate-selection,
Stage 1/2/3 or canonical-data dependency. #550 implements the tool and synthetic
regressions. **The real Written Corpus run belongs to #549.** No real remaining
slice is run by implementation tests or the commands used to validate #550.

## Operator commands

Use the existing index and the verified shared Python environment. Do not rebuild
the index or create a worktree-local venv. The pinned packages are Kiwi 0.24.0 and
kiwipiepy_model 0.24.0; the existing corpus permission record must still permit
reference analysis. Python's SQLite must support `temp_store_directory` (checked
before processing), and the runner uses POSIX `flock` on macOS/Linux.

```bash
node scripts/python/run.mjs --print
# #549: identify the historical aggregate; explicitly reanalyse original slice 0 once.
pnpm reference:corpus:morphology run-next \
  --legacy-analysis ~/.cache/typewriter/runs/issue-201-pilot/candidate-analysis.sqlite \
  --reanalyse-slice-zero

# Incremental verification and JSON status; does not tokenize any paragraphs.
pnpm reference:corpus:morphology status

# Explicit full input/store audit, including interrupted commit/seal recovery.
pnpm reference:corpus:morphology audit

# #549: run the next slice, or resume the same incomplete slice, then EXIT.
pnpm reference:corpus:morphology run-next
```

If the historical DB is elsewhere in the shared runs cache, pass its actual
path. If it is unavailable, a fresh `run-next` records that historical aggregates were
not imported and reanalyses slice 0. Preserve the historical file. Once migration
is recorded, omit the migration arguments when resuming; repeating them requires
the exact same legacy digest and explicit acknowledgement.

`--index` and `--store` may select other paths below the shared `indexes/` and
`runs/` cache areas; symlink escapes are rejected. `TYPEWRITER_CACHE_ROOT` follows
the existing machine-local cache contract (synthetic tests use isolated temporary
roots). Corpus-derived data, including SQLite sort files, stays exclusively in
that cache. `--checkpoint-paragraphs 128` is the default and accepts 1–4096.
Every `run-next` invocation processes at most one slice and exits; there is no
multi-slice option. Interrupt with Ctrl-C and explicitly rerun `run-next`: the same
incomplete slice resumes, only its current uncommitted chunk is repeated, and the
runner exits after publishing that slice without starting another. After all 20
slices are complete, `run-next` reports `no-op` and makes no new DB contributions.

### Required #549 completion record

Each successful `run-next` prints one concise JSON completion summary on stdout.
Checkpoint progress goes to stderr. The summary includes `completed_slice`,
actual slice paragraph count/percentage, cumulative verified paragraphs/coverage,
new and cumulative unique lemmas, `validation: "passed"`, publication `digest`,
analysis identity digest, committed analysis `elapsed_seconds`, local store path,
disk bytes/free space and the completion bitmap. It reports `result: "no-op"`
with a null completed slice/digest when no work remains.

**The #549 operator must post one result comment for every verified completed
slice before explicitly invoking the next slice.** Copy the completion JSON into
that comment; no per-slice Git branch, commit or PR is needed. The runner has no
GitHub integration or credentials and does not deliver comments itself. If stdout
is lost or interruption happens just after publication, use `status` to recover
the completed slice's persisted counts, lemma counts, publication digest and time
before posting its comment. Do not report a partial slice as completed.

## Persisted contract

Default directory: `~/.cache/typewriter/runs/written-corpus-morphology-v1/`.

| File / table | Role |
| --- | --- |
| `analysis.sqlite` → `manifest` | Authoritative versioned JSON manifest and checksum: complete index byte digest and producer metadata, permission/source digests, Python executable/version, installed Kiwi/model file digests, morphology algorithm and schema identity, migration provenance, routing checksum. |
| `sources`, `documents` | Original metadata with named fields and stable source/document identities, independently readable without product data. |
| `route` | One paragraph ID → one document and residue `ordinal % 20`; covering `(slice, paragraph)` index. No paragraph text. |
| `slices` | Actual expected counts, completion bitmap, new and cumulative distinct lemma counts, publication checksum. |
| `chunks` | Transactional checkpoint ranges/counts, fact row counts, all-token/eligible/accepted/rejected counts (lemma shape and span separately), elapsed analysis time and checksums. |
| `facts` | Slice/chunk/document contributions for lemma/POS (`kind=0`), morpheme surface (`1`) and punctuation-trimmed eojeol (`2`), with token/OOV/paragraph-hit counts. No paragraph text or token-position archive. |
| `lemmas`, `slice_summaries` | Indexed first-seen lemma catalogue and atomic completed-slice summaries; ordinary progress/status does not scan previous completed facts or chunks. |
| `seal.json` | Fsynced external mutation witness for the analysis DB device/inode/size/mtime/ctime, with its own checksum. |
| `initializing.sqlite` | Unpublished initial routing DB; safely rebuilt after interrupted initialization. |
| `writer.lock` | OS-managed single-writer lock; a leftover file is harmless after process death. |
| `error.json` | Last failed attempt and recovery instruction; cleared only after a successful resume. A full disk may prevent this file being written; stderr and nonzero exit remain authoritative. |

The contract preserves the pilot's eligible NNG/VV/VA tags, NFC Korean lemma
shape, predicate dictionary forms, observed spans and eojeol boundaries. Ambiguity
is observed distinct lemma/POS interpretations of a morpheme surface and distinct
POS of a lemma, not a claim of independently verified lexical correctness. OOV
counts remain available separately. Changing dictionary coverage or exclusions
does not change this dataset: no such input or result is read or bound. The reused
pilot morphology function and constants are hashed separately from its product
selection implementation.

The old `candidate-analysis.sqlite` has already collapsed document/source
identities into counts, and cannot prove exact distinct counts or source maxima
when later slices share those identities. It is **never summed or silently
imported**. Identified migration records its byte digest and aggregate row counts,
imports zero rows, and performs one source-bound reanalysis of residue 0 in the
new store. Restart reuses completed checkpoints, including those of slice 0.

## Read-only Stage 1 consumer (#566)

New Stage 1 selections use the completed morphology store by default. Before the
first page, the selector verifies the existing seal and runs the complete audit
against the current index, permission record, pinned runtime, analyzer/schema
identity, all 20 publication checksums and exact corpus totals. This consumer
does not take the writer lock, repair a journal, or renew the store seal. The
Run `python scripts/reference/corpus_morphology_readonly.py` for the same check
without selecting candidates.

The selector stores only its bounded candidate projection under
`~/.cache/typewriter/runs/written-corpus-morphology-selection-v1/<source-digest>/`:
eligible lemma/POS counts and the top five observed surface and eojeol forms.
The projection manifest binds the complete audit evidence, source snapshot and
projection code identity. Each refill page rechecks the store seal and current
source identity, then checks the full-audit proof and projection binding before
using them. It reads the candidate aggregate as SQLite read-only, applies current
canonical coverage and reviewed exclusions in temporary tables, and never copies
the 12 GB morphology database per page. Candidate evidence remains text-free;
representative corpus hits are collected through the existing bounded reader.

`run-corpus-lemma-pilot.mjs` selects from this verified full-corpus source by
default. `--reuse-analysis-from` remains an explicit historical cache mode, and
`--scan-corpus` explicitly requests the earlier direct extraction path.

## Exact cumulative use

Only completed slices enter `completed_facts`. `document_totals` first combines
all slice/chunk contributions for each document; `source_totals` then combines
documents of the same source. `morphology_totals` reports exact token/OOV counts,
paragraph hits, distinct documents/sources and maximum per-source token count.
`surface_interpretations` and `lemma_statistics` compute ambiguity from the
completed union, including interpretations first observed in later slices.
Views are deterministic cumulative projections: no repeated full database copies
or separately crash-prone merge step. Per-slice contributions remain independently
queryable with `WHERE slice=N` on `facts`/`chunks`.

After running `status` successfully, local consumers can open `analysis.sqlite`
read-only and query, for example:

```sql
SELECT * FROM lemma_statistics ORDER BY lemma, pos;
SELECT * FROM morphology_totals WHERE kind=1 ORDER BY lemma, pos, form;
SELECT * FROM source_totals WHERE kind=0 ORDER BY lemma, pos, source;
SELECT * FROM slices ORDER BY slice;
```

Status returns exact expected/processed/verified paragraph counts, actual
percentages, current slice, completion bitmap, per-slice token and accepted counts,
new/cumulative unique lemmas, committed analysis seconds, disk bytes and last error.
`processed_paragraphs` may include durable chunks of a partial slice;
`verified_paragraphs` and coverage include **completed slices only**. Timing counts
committed analysis chunks, not initialization, verification or lost crash work.

## Integrity, restart and resource bounds

Initialization performs the full index byte hash, integrity/count checks and
routing audit once. Each subsequent invocation checks the bound input file's
device/inode/size/mtime/ctime, permission and tool/model identity without reading
all index paragraphs or bytes again. A covering route index selects only the
current residue and paragraph primary-key probes fetch its texts. Resume validates
only that incomplete slice's committed checkpoints; publication validates only
the new slice. Previously verified contributions are reused. An indexed lemma
catalogue and persisted slice summaries avoid rescanning earlier facts/chunks to
produce completion/status counts. Full cumulative view queries are explicit
consumer reads, outside the slice-generation path.

The source index stays under a shared SQLite read lock until publication. All
initialization connections close before acquiring that lock: on Linux, closing
another descriptor for the same inode releases process-wide POSIX locks. The
analysis writer retains an exclusive SQLite lock across its checkpoints. Live
source WAL journal mode (even without sidecars), live WAL/journals and a changed
source file stamp stop progress. The common full/incremental input gate checks
the persisted SQLite WAL header before opening the index, then
`PRAGMA journal_mode`, including on the actual held source connection. The header
guard also works when read-only SQLite cannot create missing WAL sidecars. A rollback
read lock prevents a writer from switching modes during the run; WAL is rejected
before initialization or paragraph processing. Do not modify
the index while the runner is active.

Memory streams one paragraph at a time and holds only that paragraph's token
counters. SQLite page cache is 8 MiB; sorts spill into the local store.
Disk usage is one compact routing map plus append-only chunk/document contribution
rows, indexes and the current rollback journal, not 20 cumulative snapshots.
Actual output size depends on observed form/document diversity; status reports
it. A 64 MiB free-space headroom check precedes each slice. SQLite disk-full/I/O
errors roll back the current transaction, preserve earlier published data, and
exit nonzero; free space and resume. Headroom is not a prediction of total size.

`synchronous=FULL`, rollback journaling and deferred foreign keys bind fact writes,
checkpoint cursor/counts/checksum in one transaction. Completion is committed only
after checkpoint verification and exact input-count agreement. The bitmap and
cumulative visibility switch atomically in the same DB transaction. Initialization
publication uses rename plus directory fsync. Status uses a read snapshot; another
writer cannot race publication into its persisted-data checks.

Ordinary resume/status checks the external mutation witness before trusting
previous publications, then validates schema/manifest/identity and current
checkpoint checksums/ranges/accounting. Any ordinary write, replacement or
truncation of the analysis DB changes its stamp and blocks progress, including
modifications to previous completed facts/routing. A current checkpoint checksum
is also checked independently of the witness. The witness is renewed with fsync
only after the runner's own initialization, committed checkpoint, publication or
completed rollback; it does not authorize changed data.

`audit` explicitly rehashes the source, checks the entire schema/manifest/routing,
all checkpoint contributions, publication ordering/counts, lemma catalogue and
persisted summaries. Only a successful audit renews a stale witness. It never
rewrites contributions, stored checksums, or manifests. Source identity changes
remain blocked. Treat the cache and its witness as one local integrity unit;
do not edit either to bypass verification. Filesystem stamps detect filesystem
mutations, while a full audit detects silent storage corruption that does not
update those stamps; such corruption of the current slice is also detected by
ordinary checkpoint validation.

Ctrl-C and ordinary exceptions roll back and resume from the last committed
checkpoint. Hard termination before DB writes, or after a sealed commit, also
resumes directly. Power loss/process death during a write or between the SQLite
commit and witness fsync may leave a hot journal or a stale witness. Progress then
fails closed with an explicit `audit` instruction. Run `audit` to let SQLite
recover its transaction and verify all preserved contributions, then invoke
`run-next` to resume the same incomplete slice. A failed audit leaves progress
blocked; restore the original compatible backup rather than editing the witness.
There is no automatic full rescan in ordinary `run-next`, including its failure
path, and no destructive repair or historical DB overwrite.

## Implementation validation

```bash
node --test tests/corpus-morphology-python.test.mjs
pnpm ci:normal
# Registry edits conservatively select full current-system Deep as well.
pnpm ci:deep
```

The stdlib-only synthetic suite covers irregular 20-way partitioning, exact
single-pass union statistics (including surface/POS ambiguities), historical
reanalysis, checkpoint and publication failures, actual process death, disk-full
errors, bad identities/schema/checkpoints, single-writer exclusion, status and
20 successive separate invocations followed by idempotent no-op. It proves that
each invocation touches at most one slice. SQL/digest instrumentation over 20
separate calls proves that input/routing audits occur once and no earlier
completed facts are scanned for ordinary progress. Corrupt partial checkpoints
block both incremental execution and explicit audit. A forced process exit in
the commit/witness gap proves fail-closed recovery through `audit`. An interrupted invocation resumes
its current slice without starting another. It neither opens the real corpus
nor requires model execution. Real full-corpus timings and disk totals belong to
#549 and are not inferred from these fixtures.
