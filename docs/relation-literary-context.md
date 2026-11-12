# C literary context tooling

Issue #1750 added the read-only reader and checkpoint CLI for the approved local
public-domain literature index used by Relation Factory method C. Issue #1761
bound it to the actual schema v1 contract. Issue #1774 slimmed the repeated
production path: read a chunk once, submit a chunk once, validate once. The
tool never builds, updates, or redistributes the index and is not used by the
product build or runtime.

## Approved index schema v1

The reader supports one schema: `source_files`, `works`, `text_units`,
`unit_fts`, and key/value `index_metadata`. It rejects retired
`documents`/`paragraphs`/`paragraph_fts` tables and incomplete or mixed schemas.

- `source_files.file_id` is the file key. `works.file_id` is unique and
  references that key; `text_units.file_id` references the same key.
- A work exposes `work_id`, `genre`, `title`, `author`, and `metadata_origin`.
  Work identity and unit order come from the index, not from inferred paths.
- `text_units` stores physical source lines: `unit_rowid`, `file_id`, `ordinal`,
  `kind`, `block_ordinal`, exact `text`, and exact `eol`. `(file_id, ordinal)`
  is unique and ordinals are zero-based and contiguous within each file.
- `unit_fts` is FTS5 over external content `text_units`, with
  `content_rowid='unit_rowid'` and `tokenize='trigram'`.
- `index_metadata` declares schema and builder version `1`, a full build,
  literal FTS/instr search semantics, format-valid input-manifest and
  logical-row SHA-256 digests, and file/work/unit counts matching the index.

Preflight opens SQLite read-only with `query_only` enabled. It checks the
schema, foreign keys, file/work/unit connections, metadata versions and counts
format, FTS configuration, and that a literal FTS probe runs. The approved index
is **not** hashed byte-for-byte and its FTS index is **not** rebuilt or compared
posting by posting on a normal run. Those deep checks (`preflight --deep`: whole-file
SHA-256 with a `.warroom-scratch/` digest cache, temporary FTS rebuild and posting
comparison) are for first approval of an index or a suspected change only. The
checkpoint binds the private DB path, stat fingerprint and the metadata
manifest/logical-row digests; the index is never regenerated. CLI diagnostics
report bounded schema/version/count/status fields and suppress local paths, raw
manifests, source lists, environment values, and credentials.
Checkpoint contract v3 binds that identity, the Canonical shard digest, the tool
procedure digest, and the Git HEAD. A v2 checkpoint stays readable, resumable
(`chunk`), reportable and exportable; v1 (retired paragraph schema) is rejected.

## Typical C run

Run the CLI from the repository root with the batch assigned to the current C
producer. The normal path is: **init once, then `chunk` → `submit` per chunk, then
`export` once.** There is no per-context, per-candidate or per-sense command.

War Room Method C runs receive the approved database as
`TYPEWRITER_APPROVED_LITERARY_DB`, sourced from the local
`literary_index_path` setting in `tools/warroom/.local/config.json`. The
Supervisor checks that it is an absolute readable file before selecting a
batch and passes it only to C producer runs, including review fixes. Pass that value with `--db` to
`preflight`, `init`, `chunk`, and `submit`. The `report`, `add-form`, `export`,
and `validate` commands do not accept `--db`. An unset or unreadable path is a
setup error, not a reason to search the cache or guess another index. The
absolute path stays in local settings and the process environment, not in Git,
PR text, or Candidate output.

`init` runs the same lean read-only index check once itself, so a separate
`preflight` is **not** a per-batch step; run `preflight` (or `preflight --deep`)
only for explicit diagnosis, first approval of an index, or a suspected change.

```sh
node scripts/relation/literary-context-cli.mjs init \
  --canonical data/canonical/stdict-0001.jsonl \
  --shard 001 --batch 01 --model codex \
  --db "$TYPEWRITER_APPROVED_LITERARY_DB" \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json
node scripts/relation/literary-context-cli.mjs chunk \
  --db "$TYPEWRITER_APPROVED_LITERARY_DB" \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json
# read the chunk, judge and search, write .warroom-scratch/chunk-01.json, then:
node scripts/relation/literary-context-cli.mjs submit \
  --db "$TYPEWRITER_APPROVED_LITERARY_DB" \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json \
  --input .warroom-scratch/chunk-01.json
# repeat chunk/submit until `chunk` returns no items, then:
node scripts/relation/literary-context-cli.mjs export \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json \
  --canonical data/canonical/stdict-0001.jsonl \
  --output data/relation-candidates/001/001_01_c_codex.jsonl
```

`chunk` opens the read-only index once and returns the next senses that are not
yet submitted (default 12 senses, 8 contexts each, bounded to ~36k characters).
Each item carries the sense id, lemma, POS, gloss, `total_hits`, `unseen_hits`
and the contexts with a short key `k`, a work/author label `src` and the excerpt
`x` (≤700 characters, two adjacent physical units on each side of the hit).
Results interleave works by hit ordinal before a second context from one work.
Senses with **zero hits** are recorded as `ZERO_HITS` in the same single
checkpoint write and are not shown; a failed or unsearchable sense is reported as
`SEARCH_FAILED`/`UNSEARCHABLE` and is never a normal empty result. Senses with
hits are written only when you submit them. Options: `--limit`, `--contexts`
(1–16; 16 is the ceiling per sense), `--snippet-chars`, and `--sense-ids a,b` to
re-read specific senses (for example with `--contexts 16` when the first sample
is not enough). One- and two-character forms use a literal `instr()` scan;
longer forms use an FTS5 trigram literal query re-checked with `instr()`; a form
split by a hard-wrapped line is not a hit. Canonical lemma and `search_forms`
are searched; add reviewed inflections before reading the sense:

```sh
node scripts/relation/literary-context-cli.mjs add-form \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json \
  --sense-id SENSE_ID --form INFLECTED_FORM --basis 'reviewed irregular form'
```

### Reading a chunk without noisy output

Use the paths, settings and checkpoint you were given; do not list the cache root
(`rg --files`, `find`) to locate them. The database path must come from
`TYPEWRITER_APPROVED_LITERARY_DB`; if it is absent, stop and report a setup error
instead of searching or guessing. For other unknown paths, narrow any necessary
inspection by directory and filename pattern. Use `report` for checkpoint status;
otherwise query only the fields or counts you need, never the whole checkpoint or
ledger. Normal literary excerpts and sense-reading contexts are never trimmed.

Save the `chunk` response once, then format every returned sense and its full
contexts in one `jq` call. Items with only `sense_id` and `status`, such as
`SEARCH_FAILED`, remain visible in the same output:

Checkpoint writes (`init`, `chunk`, `submit`, `add-form`, `export`, `clear-candidates`, Supervisor technical skip) run
under `<checkpoint>.lock`, so several workers of one batch may overlap on different Senses. `chunk` applies ZERO_HITS
and `shown` only to Senses unchanged since its lookup and lists only those; `submit` is refused as a whole with
`checkpoint_sense_changed` if a Sense it saves changed meanwhile. The Supervisor-only `chunk --exclude-sense-ids a,b`
leaves reserved Senses out of the selection and adds ` excluded_pending=N` to the text header when N > 0; worker
commands accept an optional `--chunk NNN` that confines them to `c-active-NNN.json`.

```sh
node scripts/relation/literary-context-cli.mjs chunk --db "$TYPEWRITER_APPROVED_LITERARY_DB" --checkpoint CP > .warroom-scratch/chunk-01.read.json
jq -r '
  "batch=\(.batch.shard)_\(.batch.batch) done=\(.done_senses)/\(.total_senses) zero_hit=\(.zero_hit_recorded) not_yet_read=\(.not_yet_read)\n\n" +
  ([.items[] |
    if has("contexts") then
      "## \(.sense_id) — \(.lemma) [\(.pos)]\n\(.gloss)\n" +
      (if ((.forms // []) | length) > 0 then "forms: \((.forms // []) | join(", "))\n" else "" end) +
      "hits=\(.total_hits) unseen=\(.unseen_hits)\n" +
      ([.contexts[] | "[\(.k)] \(.src)\n\(.x)"] | join("\n\n"))
    else
      "## \(.sense_id) — \(.status)"
    end
  ] | join("\n\n"))
' .warroom-scratch/chunk-01.read.json
```

### Lossless text view and per-sense status

`chunk --format text` prints exactly what the `jq` command above formats (progress header, each sense's
id/lemma/POS/gloss/forms/hits/unseen, every returned context's key, source label and full excerpt,
and `SEARCH_FAILED` / `UNSEARCHABLE` items) without the intermediate JSON file. The default JSON output is
unchanged. The text is never trimmed: if it would exceed the output budget the command fails closed instead
of dropping senses or excerpts.

`report --sense-ids a,b` answers, for exactly those senses, `{sense_id, status, done}` plus `all_done`, with
`done` meaning the existing `senseDone` set (`ZERO_HITS`, `SUBMITTED`, `NO_VERIFIED`, `SAMPLED_NO_VERIFIED`,
`DISCOVERED`, `TECHNICAL_SKIPPED`, `PROPER_NOUN_SKIPPED`). Unknown or repeated ids and a damaged checkpoint structure (batch binding, duplicate ids,
malformed submission or search state) fail closed. It exposes no path, source text or private locator.

### Under the War Room Supervisor

For War Room-assigned C batches the Supervisor, not a long AI session, drives the batch:

1. It runs `init` once (never over an existing checkpoint; a restart validates the batch/model binding and the
   checkpoint's HEAD, allowing only its own Candidate commit as a later HEAD).
2. For each chunk it runs `chunk --limit 12 --contexts 8 --format text`, stores the view and an active-chunk
   record under `.warroom-scratch/`, and starts a **new** AI session whose initial prompt contains the whole
   view (only a view too large for one argument falls back to Stage 2-style 36,000 byte / 28,000 char pages).
   The session reads, discovers and submits that chunk once; it does not export, commit, push or open a PR.
3. A chunk is complete only when `report --sense-ids` says every one of its senses is done. An exit code alone
   is never completion, and a stored submit is never regenerated. An incomplete chunk is resumed in its own
   session with only the open sense ids.
4. After the last sense the Supervisor exports (reusing a current valid output), commits only the intended
   Candidate file, pushes without force, re-checks the common C claim, and opens the one `[C/<Model>] SSS_BB`
   PR, re-deriving each step from file, Git and GitHub facts so an interruption never repeats work.

**Eight parallel chunks (#3076).** A War Room C batch (mode key `c_mode_<id>`, persisted before the checkpoint
exists) runs its chunks as up to eight concurrent tasks inside the one batch, as approved by the owner. After a
Supervisor restart with the new code, an already active parallel C batch also uses the eight-run ceiling on its next
slot refill; existing sessions are not terminated. The checkpoint format is unchanged and every change is applied
to the latest checkpoint under its lock (see the CLI notes above). A task owns exactly the Senses of its `c-active-NNN.json`; each new chunk is rendered with
`--exclude-sense-ids` for every Sense an active chunk already reserves, and an empty view whose header reports
`excluded_pending > 0` is a normal wait, not an error. Workers pass `--chunk NNN` to `chunk --sense-ids`, `add-form`
and `submit`, so a request outside the task's Senses is rejected. A slot is returned only after the run's process is
confirmed gone; a stored Sense never frees it earlier. Each task has its own correction budget (two automatic
same-session corrections, plus one chance per operator Retry), at most one fresh-session no-submission recovery, and
its own technical-skip authority (two completed automatic corrections of that task, each with a recorded official
submit). The batch keeps one approved runtime baseline (`c_run_start_<id>`); the checkpoint's original
`git_head`/`canonical_revision` identity is never rewritten. A batch without the mode key that is already in progress
finishes serially, and a Candidate v1 repair keeps the existing serial singleton path. Workers have no authority to
start other AI, CLI or subagent runs.

The manual path in this document remains valid for hand-run batches.

## What you do for an eligible sense with hits

A Sense naming a specific person, place, institution, organization or work is a
**proper-noun editorial skip (#5745)**. Decide from its exact Canonical Sense/gloss
rather than spelling alone (`인촌¹` is a person's art name, `인촌²` means "neighboring village").
For a proper-noun Sense in the active chunk, do not inspect its contexts or run
sweeps; submit `"skip":"proper_noun"` with empty `verified` and `candidates`.
The initial chunk lookup has already run, and `submit` still checks the approved
index; a real `SEARCH_FAILED` or index error cannot be turned into a skip.
This editorial skip is not the Supervisor-only technical skip or a claim of zero
hits/no VERIFIED contexts. Exclude proper nouns discovered as candidates of an
ordinary source Sense as well.

For other Senses, the semantic work is unchanged: compare each context with the exact Canonical
source sense, decide which contexts are genuinely that sense (`VERIFIED`), and
search each VERIFIED literary context twice, independently, through the seven
lenses (image, action, emotion, sensation, scene/situation, causality,
metaphor/contrast), then edit the discoveries into final candidates under the
shared Stage 1 form rules. If the sample is not enough, read more with
`--sense-ids`, up to 16 contexts. **Nothing about this work is recorded per
lens, per context or per discarded candidate**: no empty lens arrays, no
KEEP/REMOVE ledger, no per-context receipt. Ineligible discoveries simply are
not listed.

`chunk` records which units it showed for each sense (unit row ids and the hit
count, no text). `submit` re-resolves exactly those units by row id, recomputes
each locator key from the live index row and requires the unit to still contain a
search form, instead of repeating the full hit COUNT, ranking and excerpt search.
Keys must identify exactly one shown context. A sense never read by `chunk`, a
legacy checkpoint, or a sense whose forms changed falls back to the full search.

`submit` takes one JSON file under `.warroom-scratch/` for the whole chunk and
saves it in one checkpoint write:

```json
{"senses": [
  {"sense_id": "SENSE_ID", "verified": ["KEY12CHARS", "KEY12CHARS"], "candidates": ["서리", "겨울 아침"]},
  {"sense_id": "OTHER_SENSE_ID", "verified": [], "candidates": []},
  {"sense_id": "PROPER_NOUN_SENSE_ID", "verified": [], "candidates": [], "skip": "proper_noun"}
]}
```

`verified` lists the short keys of contexts you judged to be the source sense
(empty when none of the read contexts is); `candidates` is the final candidate
list. A sense with hits must be listed explicitly; omission is not an empty
result. The tool re-resolves each key against the index, so only real contexts
of that sense can be cited, and rejects candidates without a VERIFIED context,
unknown, ambiguous or duplicate keys and malformed entries. The whole submission
is validated first and nothing is written on failure. The checkpoint keeps only
what resumes a run: per sense the total hit count, the cited contexts' source
locators and digests, and the final candidates. It does not store excerpt text.
Ordinary resubmissions retain the existing correction behavior. A proper-noun
skip requires both arrays to be empty, records `PROPER_NOUN_SKIPPED` in the
checkpoint, and is rejected with `already_submitted` if that Sense has any saved
submission. The final Candidate
v1 export still contains only the normal record/Sense IDs and `candidates: []`.

On a rejected submission, `submit` writes a bounded JSON diagnostic to stderr.
`submit_validation` keeps the fixed `reason`, `affected.sense_id`, `field`, and
`repair_scope` fields, and adds `affected.entry_number`: the 1-based position in
the submitted `senses[]` array (not the JSON file's line number), or `null` when
the error is at the top level. For ID and entry-schema errors, `issues` lists up
to 16 `{entry_number, reason, field}` items; `issues_truncated: true` means more
items were found. Unknown Sense IDs are not echoed. These diagnostics never
include the submitted key, source excerpt, locator, local path, or stack.

For a rejected submission, match each reported array position to that entry in
the original JSON file and correct only the reported item or field. Compare an
`unknown_sense` entry with the active chunk's exact Sense IDs to determine
whether it is an extra entry or a mistyped ID. Do not delete it automatically
or infer a replacement from a missing ID alone; correct a typo only when the
entry's source-sense evidence identifies the intended ID. Before resubmitting,
check that the active chunk's expected senses are covered exactly once. A
rejected submit does not partially update the checkpoint, and saved senses from
an earlier resume remain intact.

Before requesting a same-session repair, the War Room Supervisor can re-run the
unchanged submission through the normal CLI when the exact failed verified key
has only surrounding whitespace; the CLI trims it and still requires the same
unique context-key match. It never guesses a different key.

After the existing two same-session resubmits are exhausted, the War Room
Supervisor may invoke its internal fallback only when the latest diagnostic
names one active, known Sense and one matching submission-array entry. The
producer-facing CLI has no technical-skip command. The Supervisor verifies the
unchanged submit-file digest and active view, submits the other pending entries
through the ordinary `submit` validator, then records that exact Sense as
`TECHNICAL_SKIPPED` with its Record/Sense IDs, diagnostic, reason, field,
chunk/head binding, and retry count. Its candidate list is `[]`; its search
state and VERIFIED evidence are left untouched. Multiple, stale, unbound, or
system-level failures remain stopped for the operator. The retry count comes
from the Supervisor's own state before it invokes the internal implementation;
no repository selected by producer code grants fallback authority. `report`
includes exact technical exclusions so export and the production PR can
disclose them.

The Supervisor runs C CLI commands from its own current source checkout while
keeping the assigned batch worktree as the command's working directory. This
lets an older assigned worktree use the same supported checkpoint reader,
submit validator, report, and export implementation as the Supervisor. Before
the internal technical-skip transition, it requires the checkpoint HEAD,
active-chunk HEAD, actual worktree HEAD, and a recomputed procedure digest from
the clean worktree to agree. The current submit command revalidates the exact
unchanged bytes against the checkpoint-bound, read-only approved index and
refreshes the diagnostic with that input digest. The internal transition then
checks the single-Sense diagnostic, active view, exhausted same-session retry
budget from the fixed Supervisor Store, and saved state of every unaffected
Sense. The Store binding must identify the current idle batch, its finished C
chunk run, and the same session; a caller-provided retry count is never
accepted. It records both the source and current procedure digests. Any stale
input, changed worktree, missing capability, or identity mismatch remains an
explicit error; the Supervisor does not rewrite or reinitialize the
checkpoint. Producers use the CLI path provided in each C chunk card, so later
chunks and export keep using the same current implementation.

Index access, identity, schema, metadata, and search failures use an index
diagnostic with `repair_scope: stop_and_report`; stop the batch and report those
instead of changing producer input or retrying the same chunk. An unexpected
failure remains the generic `operation` diagnostic.

## Export, final validation, and fixes

`export` requires every Sense to be complete under `senseDone`, including
`ZERO_HITS`, ordinary `SUBMITTED`, editorial `PROPER_NOUN_SKIPPED`, or the
Supervisor-only `TECHNICAL_SKIPPED` (plus supported legacy completion states).
It preserves Canonical record/sense order,
writes only Candidate v1 fields and runs the shared
Candidate v1 batch validator **once** over the whole batch before creating the
output. Do not run a second `validate` on the same file. A validator failure
names the affected row; resubmit only that sense, then export again (the
checkpoint's own previous output is overwritten). `validate` remains only for a
hand-edited file. All checkpoints, submissions and digest caches stay under the
ignored `.warroom-scratch/` directory; only the validated Candidate JSONL belongs
in the PR. `report` prints bounded totals.

## `chunk --skip` view labeling

A `chunk --skip N --contexts M` read returns only contexts N+1..M. Its per-Sense header is
`hits=H unseen=U shown=N+1-M (...)` (JSON: `shown_range: [N+1, M]`); `unseen` is `H` minus all `M` sampled contexts,
so it equals the value of a full `--contexts M` read, not of the initial 8-context view. Initial views carry no
`shown=` marker.
