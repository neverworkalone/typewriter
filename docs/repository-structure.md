# Typewriter Repository Structure

## Purpose

This document defines where Typewriter materials belong and, more importantly, where
they do not belong. The repository is intentionally small while the editorial model
is being validated. A directory is added when a current workflow needs it; future
work areas are documented here without creating empty scaffolding.

## Source-of-truth boundaries

| Material | Responsibility | Location | Repository rule |
| --- | --- | --- | --- |
| Canonical dictionary data | Typewriter-authored and editorially reviewed words, senses, expressions, and relations | `data/canonical/*.jsonl` | Tracked in Git. This is the editable source of truth. |
| M5 target inventory | Non-canonical target selection, classification, and review-state decisions | `data/inventory/m5-target-seed.json` plus the on-demand projection builder | The authored seed is tracked; the deterministic inventory projection is rebuilt in memory and is never a canonical or product build input. |
| M5 batch manifest and measurements | Review metadata, generator identity, decisions, event-level relation diffs, timing passes, and derived calibration measurements; no raw draft body | `data/batches/*.json` when a real batch is committed | Tracked only as an audit record; staging records, raw drafts, and external source text remain outside the repository. |
| Raw unreviewed draft | LLM output, editor scratch work, or other material that has not passed Typewriter review | A temporary workspace outside this repository | Never a canonical input and never committed. |
| External raw/reference material | API responses, scraped pages, downloaded source files, or other source material held for research | A temporary workspace outside this repository | Never committed. Keep only the review decision and permitted Typewriter-authored result when appropriate. |
| Generated dictionary database | SQLite built deterministically from canonical input | Build output such as `dist/` or `artifacts/` | Generated, not hand-edited, and ignored as local output. |
| User data | Recent searches, favorites, settings, and other runtime state | Browser-managed extension storage | Never stored in the read-only dictionary database or repository. |
| Application, documentation, and brand assets | Source code, policy documents, and approved Typewriter assets | Repository paths such as `src/`, `docs/`, and `public/` | Tracked unless a file-specific rule says otherwise. Existing `public/` assets remain intact. |

Canonical JSONL is the only editable dictionary source. SQLite is a derived delivery
artifact and must be regenerated from canonical input. User data is owned by the
runtime, not by the dictionary build.

## Current and next-needed directories

The current repository contains `public/` for product manifest and brand assets,
`src/popup/` and `src/options/` for the product Vue entrypoints, and `src/domain/`
for UI-independent search state and Editorial Model v1 projection. The root
`popup.html` and `options.html` files are the product HTML entrypoints; Vite writes
their generated assets to ignored `dist/`. The canonical input location used by
the M2 toolchain is:

```text
data/canonical/*.jsonl
```

Only reviewed Typewriter records belong there. The generated SQLite and packaged
extension are built into ignored `artifacts/` or `dist/` output and are never edited
as canonical data.

The following locations are deliberately not created as part of the foundation:

- `data/draft/` and `data/reference/` are outside-repository temporary work areas;
- generated database and package output belongs in ignored build output such as
  `dist/` or `artifacts/`;
- user data has no repository directory because it belongs to browser storage.

`data/inventory/` is an M5 exception: it contains reviewable target-selection
artifacts, not lexical records. The validator joins its current snapshot to
`data/canonical/` and rejects drift. The dictionary builder does not discover or
read this directory.

`data/batches/` is a second M5 exception used for reviewable manifests, relation
diff ledgers, and derived calibration measurements. A manifest records the target
inventory revision, generator/model/prompt identity, review status, record
decisions, final canonical IDs, required timing passes (five editorial passes
for the baseline contract plus any batch-specific pass such as A2's distinct
post-freeze audit), any post-review follow-up passes and their measurement
status, and the relation-diff artifact digest. A metrics file is generated from
those sources and canonical records; it
may record counts, rates, timing totals or measured lower bounds, audit findings,
and validation outcomes, but neither file may contain raw model responses, draft
text, confidence scores, secrets, or local staging paths.
The M5-8 expansion plan and stage-report schema are also process metadata: they
define the fixed phase/ladder contract and source-bound per-stage results. A
stage result binds its manifest, derived metrics, relation diff, canonical
directory, verification artifact, and (after the first stage) previous passed
stage report by path and digest; it does not contain a candidate batch or
canonical import rows.
The M5-9A relation-screen and repair-authorization artifacts are also audit
metadata. The screen separates source-bound relation proposals, tuple/semantic
pre-screen decisions, and human admission without storing raw drafts. The same
screen contract is reused by the M5-10 Wave A relation-screen artifact, which is
bound to its Wave A relation diff and stage report by path and SHA-256. The
authorization binds the failed M5-9 report and its regression result by SHA-256
and permits only the first #96 validation wave; it never changes canonical data.
The M5-10A process-correction and repair-authorization artifacts extend that audit
boundary after the failed Wave A result. They bind the six sense-preflight
boundaries, record-level evidence checkpoints, the noncanonical 20-case
candidate-generation calibration, historical relation pre-screen denominator,
separate audit input and derived admission/noise metrics, timing contract,
and machine verification results by path and SHA-256. The builder requires the
audit input as a separate source and never treats its own generated output as an
independent editorial review. The authorization was limited to #96 Wave A2 (+50
from 578 to 628); the completed A2 execution imported only the zero-blocker
reviewed result, and its corrected chronological timing gate passed, including
the measured post-freeze audit. The subsequent #96 Wave B execution has its own
authorization and stage artifacts. It imported exactly +150 reviewed starts, so
the M5-10 Wave B snapshot was 778 starts; its Wave B report binds the A2 report,
authorization, canonical-directory digest, external proposal digest, reviewed
staging digest, separate decision artifacts, and independent post-freeze audit.
The A2 stage is ready to create a next task, but the builder keeps the task
creation and authorization flags false until a real, separately authorized task
exists.
The A2 and Wave B structured editorial and audit metadata may be tracked in this directory
when it contains only target selection, proposal identity/decision state,
the external proposal artifact digest, structured review state, separate
decision-artifact bindings, and any measured correction plan; it must not carry
candidate record bodies, raw draft text, or external source text. An explicitly
unverified/incomplete input cannot produce a completed import claim. A completed
input additionally requires a provenance artifact that binds its actor, UUID
session, subject digest, completion time, and artifact digest. Decision artifacts
also bind a `finalized_at` timestamp into their complete-file digest; editorial
finalization must follow the last editorial timing stop and precede completion.
Wave A2 additionally binds a separate post-freeze audit timing artifact from
audit start through a stop before audit decision finalization. The actor may be
human or Codex; a separate audit session and artifact establish independence
even when the actor is the same Codex. Candidate record bodies and the reviewed
canonical JSONL passed to the import gate stay in a temporary workspace outside
the repository.

When a later batch advances `data/canonical/`, a historical canonical directory
may be retained under `data/batches/` when a source-bound stage report still
needs to reproduce the earlier gate. Such a snapshot is immutable process
evidence, not a second editable dictionary source.

Issue #97's M5-11A work is promoted through the owner-authorized automated
editorial path. The tracked `data/batches/m5-11-base-canonical/` and
`data/batches/m5-11-base-inventory.json` files freeze the 778-start input used
by the #115 authorization and earlier M5 contracts. The candidate catalog
records 550 selection IDs, while candidate bodies and raw external review
inputs remain outside the repository. The compact review summary plus
`m5-11-admission.json` and `m5-11-promotion.json` bind those external inputs by
digest and record the automated generation/verification pass separation. The
promotion adds exactly 500 starts, reaches 1,278 starts, and records 50
deferred rows in the seed; `data/canonical/*.jsonl` remains the only editable
dictionary source. The historical stage snapshot may remain as process
evidence for the pre-admission 778-start boundary.

Issue #98's historical M5-12 pre-admission boundary is represented by
`data/batches/m5-12-stage.json`, `data/batches/m5-12-review.json`, the immutable
`data/batches/m5-12-base-canonical/` snapshot, and the metadata-only
`scripts/batch/m5-12-catalog.mjs`. The catalog declares 802 selection slots for
the +722 target and 80-row reserve; it does not claim 802 selected inventory
targets. It contains no candidate identity, lemma, POS, gloss, relation, or
candidate record body. The stage remains a retained historical `HOLD PROCESS`
artifact; it is not the current canonical gate after issue #138.

Issue #138's M5-12A promotion is recorded by
`data/batches/m5-12a-admission.json`, `data/batches/m5-12a-promotion.json`,
`data/canonical/m5-12a-expansion.jsonl`, the current target seed, and the
current semantic decision source. `scripts/batch/m5-12a-pipeline.mjs` binds 802
Typewriter-authored candidate identities to deterministic slots, runs the
shared live lexical producer and complete semantic audit, and admits exactly
722 imported starts. The current authored source records 700 included plus 22
corrected starts; its held, rejected, and deferred rows remain visible in the
seed. Admission enforces the 722-import, 80-row reserve, deferred-denominator,
and correction-rate contracts without requiring those current sub-counts.
The artifacts truthfully identify the work as `agent-generated`, keep
generation and verification pass IDs separate, make no human-review claim,
and record issue #7's 2,000-start checkpoint. Candidate bodies and temporary
proposal/review projections remain outside the repository.

Self-authored regression fixtures for batch tooling live under
`tests/fixtures/`. They may bind to a tracked manifest or relation-diff event
for reproducibility, but they do not contain raw drafts, external source text,
or canonical import rows.

This keeps the repository structure proportional to the workflows that exist today.

## Data flow

```text
reference material / unreviewed draft (outside repository)
        ↓ editorial review and Typewriter curation
data/canonical/*.jsonl
        ↓ normalize · validate · deterministic build
generated SQLite (dist/ or artifacts/)
        ↓ package read-only dictionary
Chrome extension
```

External material and unreviewed drafts are inputs to editorial work, not inputs to
the product build. A source may inform a Typewriter record only after its applicable
terms have been reviewed and the final record is independently curated. The review
record format is defined in [`data-policy.md`](data-policy.md).

## Ignore and safety boundary

`.gitignore` excludes common generated databases, local drafts, external references,
local configuration, and credential files so they are less likely to be added by
mistake. Ignore rules are a repository convenience, not a security guarantee:
secrets and restricted source material must be kept outside the repository, checked
before commits, and handled according to their applicable terms.

Canonical data and required application or brand assets must not be hidden by these
ignore rules. When a new generated or local path is introduced, classify it first as
canonical, generated, user-owned, or temporary material and update this document if
the boundary changes.
