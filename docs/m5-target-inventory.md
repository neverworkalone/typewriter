# M5 target inventory and batch quality gate

## Purpose and boundary

M5 expands Typewriter in reviewable stages. The inventory is a selection and
measurement input, not dictionary data. Its count unit is a **search start**: one
surface-level entry a writer can intentionally search for. A sense, relation,
expression attached to another record, `reference-only` record, inflected form, or
duplicate does not increase the start count.

The reviewable inventory is [`data/inventory/m5-target-inventory.json`](../data/inventory/m5-target-inventory.json).
It contains a current snapshot of the canonical records plus non-canonical M5
decisions. The new and held decisions are authored in
[`data/inventory/m5-target-seed.json`](../data/inventory/m5-target-seed.json) and
are combined with the current canonical snapshot by
[`scripts/inventory/generate-target-inventory.mjs`](../scripts/inventory/generate-target-inventory.mjs).
The generated inventory is never read by the dictionary builder.

The current inventory is an initial M5 tranche, not a claim that 5,000 words have
already been selected. It gives the workflow a representative next batch while
leaving later target selection open to actual calibration results.

## Status and counting contract

| Status | Source | Intended role | Counts as a start? | Meaning |
| --- | --- | ---: | ---: | --- |
| `current` | canonical | `start` or `reference-only` | only `start` | An already reviewed canonical record, copied into the inventory for drift checks. |
| `candidate` | editorial | `start` | yes | A new target that may enter a future reviewed batch. |
| `held` | editorial | `start` | no | A target kept visible while a schema, sense, or editorial question is resolved. |
| `duplicate` | editorial | none | no | A proposed target already represented by a canonical lemma or search form. |
| `inflected-form` | editorial | none | no | A surface form that must be counted with its base lemma. |

The validator reports current starts, current references, candidate starts, planned
starts, held rows, duplicates, and inflected forms independently. `planned starts`
means `current start + candidate start`; held, duplicate, and inflected rows are
never silently folded into that number.

The first M5 snapshot (`m5-1`, before the calibration import) contains:

| Count | Value |
| --- | ---: |
| Current start | 300 |
| Current `reference-only` | 26 |
| New candidate start | 60 |
| Planned start after candidate review | 360 |
| Held | 3 |
| Duplicate | 2 |
| Inflected form | 2 |

The 60 candidates are deliberately balanced across the writer-facing selection
codes. They are not a commitment to include all 60 in the calibration batch.

## Selection axes

The axes describe why a target is useful to a writer and what the editor must
check. They are classification aids, not a new lexical ontology.

| Code | Axis | Editorial question |
| --- | --- | --- |
| `E` | emotion / inner state | Does the word expose a useful direction, intensity, or duration of feeling? |
| `Q` | quality / attitude / state | Does it change a sentence's temperature, texture, stance, or degree? |
| `S` | sensory image | Can it supply a distinct sound, light, smell, taste, touch, or bodily image? |
| `C` | scene / time / nature / space | Does it give an abstract sentence a concrete place, time, or atmosphere? |
| `A` | action / relation / change | Does it provide a meaningful movement, direction, or interpersonal action? |
| `O` | object / body / writing material | Does it anchor imagery in a concrete thing or material? |
| `X` | abstract / expression / boundary | Does it test polysemy, part-of-speech boundaries, or an independent expression unit? |

Each start candidate also records its expected part of speech, a provisional
`single` / `polysemy` / `boundary` / `expression` profile, and flags such as
`direct-boundary`, `sensory-transfer`, `scene-expansion`, and
`action-direction`. These fields guide review; they do not approve a relation or
replace sense-level editorial judgment.

## Current/reference separation

Current rows are copied from `data/canonical/` and must match by canonical ID,
lemma, search forms, record type, parts of speech, and sense profile. The validator
requires every canonical record to appear exactly once in the inventory snapshot.
This makes an accidental promotion of a `reference-only` record visible without
making the inventory a second canonical data source.

New candidates have inventory IDs such as `m5-001`, not canonical record IDs. A
later reviewed batch assigns canonical IDs only at the import boundary. This keeps
selection work separate from canonical identity and avoids counting a proposed ID
as a reviewed record.

### Candidate promotion transition

When a reviewed candidate enters canonical, its seed row is not deleted. The editor
changes that row to `status: promoted` and records the assigned `canonical_id`, for
example:

```json
{
  "inventory_id": "m5-001",
  "status": "promoted",
  "planned_role": "start",
  "canonical_id": "w301"
}
```

`inventory:generate` then joins the canonical `w301` row to the existing `m5-001`
selection metadata, emits one `source: canonical` / `status: current` inventory row,
and removes the old editorial candidate row from the generated snapshot. The
stable inventory ID, reason codes, selection flags, and decision note remain attached
to the promoted record. Canonical-derived `pos`, `sense_profile`, and structural
flags are recalculated from the reviewed canonical record, so provisional seed
classification cannot survive a canonical correction. A new canonical start without
this mapping is rejected instead of receiving a reason code inferred from its numeric
ID. The transition is covered by a fixture that verifies generate → validate, no
duplicate search form, canonical classification refresh, and metadata preservation.

## External material policy

The M5-1 inventory is Typewriter-authored selection work; it does not contain raw
dictionary/API/corpus material and no external source was used to populate the
committed candidate rows. This statement is a scope record, not a blanket approval
for future sources.

If an external source informs a later candidate list, the editor must complete the
review record in [`docs/data-policy.md`](data-policy.md) before that source is used
for the stated role. Raw responses, scraped pages, unreviewed drafts, and source
examples remain outside the repository. Only the resulting Typewriter-authored
selection and the permitted source-policy decision may be tracked here.

## Calibration measurements and gate

The first reviewed batch must report the same measurements for every batch:

| Measurement | Unit / definition |
| --- | --- |
| Target preparation time | elapsed editor time from candidate selection to review-ready draft, excluding raw source handling |
| Record correction rate | records whose reviewed canonical content differs from the draft in at least one reviewed field |
| Sense correction rate | senses added, removed, split, merged, or materially rewritten during review |
| Relation correction rate | relations added, removed, retargeted, retyped, or rewritten during review |
| Direct replacement error | `direct` relations that fail a real sentence-slot substitution check |
| Over-broad relation rate | `near`, `mood`, `scene`, `sensory`, `action`, or `association` decisions that were pulled upward as if direct |
| Reference closure error | missing, wrong, or wrong-sense targets found before canonical import |
| Held / rejected rate | records not included in the reviewed canonical batch, with the reason recorded |
| Review time | editor time per included record and, separately, per held/rejected decision |

No numeric pass line is guessed in M5-1. #78 records the calibration baseline,
actual review cost, and failure types first. Only then is a numeric gate proposed
for #7. If the measured quality or cost is outside the approved gate, the next
batch stops and the selection, draft, or review process is corrected before more
targets are added.

## M5-3 calibration result

The first calibration batch imported 52 of the 60 selected starts and 12
reference-only closure records. It recorded 29 corrected starts, 4 held starts,
and 4 rejected starts. The complete decision, relation-type, timing, and
post-import inventory measurements are in
[`docs/m5-3-calibration-report.md`](m5-3-calibration-report.md).

The import advanced the seed and generated inventory from `m5-1` to `m5-2`:
352 current starts, 38 current reference-only records, 4 remaining candidates,
and 7 held rows. This is a calibration baseline only; it does not authorize a
later bulk batch until the issue #7 gate is explicitly updated.

## M5-5 recalibration result

The recalibration selected 40 new starts (`m5-061`–`m5-100`) outside the M5-3
selection. It imported 38 starts and four reference-only closure records after
reviewing every candidate, sense, and relation. The batch covered all seven
selection axes, polysemy, expression units, and reference closure. Its fixed-gate
measurements and decision are recorded in
[`docs/m5-5-recalibration-report.md`](m5-5-recalibration-report.md).

The import advanced the seed and generated inventory from `m5-2` to `m5-3`:
390 current starts, 42 current reference-only records, 4 remaining candidates,
and 9 held rows. The fixed gate result is `HOLD PROCESS` because the
relation-noise rate is 35%, above the unchanged 25% ceiling, and the measured
editor-cost lower bound is 16.075 seconds per selected start after the
post-review audit; timing remains incomplete because the reviewer-fix edit time
was not measured, and the lower bound already exceeds the fixed 12-second
ceiling. No further bounded expansion or 5K bulk generation is authorized until
the process backlog is repaired and re-audited.

## M5-7 expansion result

M5-7 added 36 Typewriter-authored candidates to the four remaining unreviewed
rows and selected 40 new starts across all seven axes. It imported 38 starts,
held one expression, and rejected one expression after complete review. A PR
follow-up re-audited all 38 imported records, corrected five sense/POS issues,
and removed two additional relation-noise candidates. The selection, source-
bound relation diff, measured follow-up passes, and fixed-gate decision are
recorded in
[`docs/m5-7-expansion-report.md`](m5-7-expansion-report.md).

The post-import inventory is revision `m5-5`: 428 current starts, 42 current
reference-only records, and no remaining candidates. After the re-audit it has
557 senses and 449 relations. The fixed gate is `HOLD PROCESS`: relation noise
is 30%, measured editor time is 19.55 seconds per selected start, and both
exceed their unchanged ceilings. This is not a 5K bulk-generation or
M5-complete decision.

## M5-9 expansion result

M5-9 selected 100 new Typewriter-authored starts plus a declared maximum reserve
pool of 12. The revision-m5-5 selection snapshot is preserved in
data/batches/m5-9-preimport-inventory.json. After sense/POS review and optional
relation admission, 82 starts were included, 18 corrected, 4 held, and 3 rejected.
A follow-up audit split 13 importable records into separate literal/figurative or
expression senses and scoped the other 87 to one sense.
The five unused reserve slots remain candidate rows and are recorded as deferred;
they are excluded from both canonical import and the processed-start denominator.

The final inventory advances to revision m5-6: 528 current starts, 42 current
reference-only records, and 5 remaining candidates. The canonical snapshot is
570 records / 670 senses / 462 relations, with 37 expression records. The four
held and three rejected M5-9 reserve decisions add to the existing held rows for
18 held rows total. The source-bound stage report and fixed-gate result are
recorded in docs/m5-9-expansion-report.md: relation candidate noise is 12/25 =
48%, and three post-review feedback cycles have six unmeasured follow-up passes.
Timing is therefore incomplete; the measured required-pass editor time is 1,090
seconds but no complete per-start cost is claimed. The result is HOLD PROCESS.
No next stage is authorized until relation admission and timing measurement are
repaired and re-audited.

## Validation commands

Regenerate the reviewable snapshot after changing canonical input or the seed:

```sh
npm run inventory:generate
```

Validate the inventory and print its independent counts:

```sh
npm run validate:inventory
node scripts/validate/target-inventory.mjs --json
```

The ordinary canonical and SQLite commands still read only
`data/canonical/*.jsonl`. A successful inventory validation does not make a
candidate canonical, and a successful canonical build does not approve a
candidate.
