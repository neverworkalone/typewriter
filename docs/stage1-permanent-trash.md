# Stage 1 permanent trash and bounded production

Issue #526 replaces repeated unresolved queues in candidate manifests. Trash is
permanent source observation history, not a lexical rejection list or a source
for automatic re-mining. Production excludes the **original extractor proposal**
of a failed observation before analysis. An analyzer's speculative alternative
lemma is never an exclusion. Resolved observations of a partly unresolved
proposal remain eligible for the current batch.

## Identity and preservation

An observation key is the JSON tuple `[source_snapshot, NFC(surface),
evidence.kind, evidence.ref, NFC(extractor_hint.lemma), extractor_hint.pos]`.
Only Unicode NFC is normalized; whitespace, case, source references and POS are
not folded. Different snapshots or paragraph references remain distinct even
when their observed forms are identical. The SHA-256 of this tuple is its ID.
The tuple is stored alongside the hash; a hash collision with a different tuple
fails closed. Missing original hints stay missing, rather than becoming a guessed
lemma.

`data/candidate-trash/T000001.jsonl` and subsequent numbered files contain at
most 500 unique observations each. Initial migration sorts observation IDs;
later production appends new IDs without moving existing observations. Repeated
observations update their existing file. Each row stores distinct original
analysis records (without their batch-local queue ID), hashed by content, with
sorted `(batch_id, queue_id)` occurrences. Original fields, reasons, verification,
provider traces and original spelling are preserved. Analysis variants are not
silently collapsed. Source/analyzer versions remain bound through each batch's
manifest. No corpus sentences or paragraphs are introduced.

## Compact manifests and historical audit

Candidate manifest v3 preserves candidate bytes and all source/producer metadata.
Unresolved observation payloads live only in permanent trash. Its occurrences
retain batch and queue IDs. Every existing and new batch keeps normal excluded
dispositions and full context decisions in its own
`data/candidates/C*/stage1-decisions.json`, without unresolved payloads or a
second copy of trash references. The compact manifest contains only counts,
digests and the decision file reference. Its context block has no decision array
or list of decision IDs. There is no separate candidate-history directory.
Review/admission `candidates_sha256` continues to bind **candidates.jsonl** bytes.
It is distinct from the manifest file SHA. The migration report records both
old and new manifest file SHA for every batch.

The migration command first validates every legacy batch, builds the global
deduplicated archive, reconstructs every legacy manifest, compares it exactly,
and verifies candidate bytes and existing review bindings. It emits a report
and fails before applying on loss, collision or invalid input. This is a manual,
one-time historical audit; it is not registered in Normal, Deep or weekly
Historical CI. Git retains the original manifest revision for rollback.

Normal validation checks current candidates and compact metadata. It validates
basic shape, IDs, bounds and provenance of new/modified trash files through the
existing factory validator. It does not replay all historical analysis records
or reconstruct old manifests on each batch. Current candidates and excluded
observations still pass the shared source-bound context-decision checks: lemma,
POS, surface, evidence, observation identity and trace must match, resolving
decisions must be used when the batch retains all candidate observations, and
retained dispositions must not overlap. Current
row trace summaries remain validated. With no unresolved queue, the original
full trace/category aggregate is also reproducible and checked. With a queue,
known candidate/excluded category counts cannot exceed the recorded totals;
queue-dependent aggregate and truth-unknown links remain part of the one-time
historical audit and the producer's full pre-compaction check. When trash files change, the common validator compares their IDs with existing
row IDs to reject cross-file duplicates. JSON keys are decoded before comparison,
including Unicode escapes; past analysis relationships are not revalidated. Unchanged runs skip all trash reads. The writer also enforces
global uniqueness, with a complete one-time migration proof.

## Production target

The artifact cap and production target are different: 500 is the final valid
distinct-lemma target; extraction pages are only bounded checkpoints. The
selector excludes produced lemmas and failed original proposals before analysis,
then continues through the pinned corpus order until the final target is met.
Fewer than 500 may be finalized only with an explicit exhausted-source proof.
Execution errors, interruption and time limits are not exhaustion and must not
create trash or publish a partial batch. Checkpoints bind source, exclusions,
provider configuration and progress; restart may reuse only identical inputs.
Candidates and trash are published as one recoverable transaction. Stage 2/3
editorial behavior and canonical data remain outside this change.

If a genuinely exhausted source produced zero new lemmas but did produce new
observations, publish a zero-row compact result with terminal Stage 1 status
`exhausted`. Its observation/analysis history still goes to permanent trash (or
the normal excluded ledger). Existing Stage 2 selection accepts only `created`
results, so this terminal result is not claimable. Exhaustion with no new source
observations publishes nothing.

## Operator commands and recovery

```bash
# Manual historical migration only; never a recurring CI registration.
node scripts/factory/migrate-candidate-history.mjs --dry-run
node scripts/factory/migrate-candidate-history.mjs --apply

# The evidence run contains its SHA-bound candidate-analysis.sqlite and selection.
pnpm run factory:stage1 -- --evidence runs/<run>/candidate-evidence.json --task-id T000000
```

Migration dry-run constructs the complete proposed changes without writing them.
Apply journals before/after artifacts under ignored `data/local/`, then validates
and publishes. Re-running apply recovers an interrupted journal. An already
completed migration refuses a second migration; its evidence is
`data/validation/stage1-history-migration.json` and the original Git revision.
Rollback the complete migration commit in Git, including its contract change;
do not restore only manifests or delete only trash.

Production checkpoints and publication journals live in the task's shared cache
run. Resume with the same evidence, task, source revision, canonical snapshot,
provider configuration and target. A mismatched binding fails closed. The
publication journal applies each artifact idempotently and restores all original
artifacts on a validation failure. After a process interruption, rerun the same
command to finish recovery before committing any candidate/trash changes. Only
successful complete publication clears the checkpoint. A failed selector or
provider leaves no partial candidate/trash publication.

Migration proof: 57 batches, 50,662 unresolved appearances, 46,480 unique
observations, 46,498 distinct analysis variants and all 50,662 batch occurrences
preserved in 93 chunks. Normal excluded dispositions (96) and context decisions
(2,493) are preserved in their own candidate batch decision files. Candidate bytes and existing review bindings are
unchanged; the report maps every old/new manifest SHA independently.

Stage 2/3 snapshots load each batch's manifest, candidates and decision artifact
through the existing snapshot loader and common validator. They fail closed
on missing or altered decision files. Trash payloads and their historical
observation relationships remain outside those snapshots. No new CI check or
validation layer is introduced.
