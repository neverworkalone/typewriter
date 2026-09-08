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
| M5 target inventory | Non-canonical target selection, classification, and review-state decisions | `data/inventory/` | Tracked for review, but never a canonical input and never a product build input. |
| M5 batch manifest and measurements | Review metadata, generator identity, decisions, event-level relation diffs, timing passes, and derived calibration measurements; no raw draft body | `data/batches/*.json` when a real batch is committed | Tracked only as an audit record; staging records, raw drafts, and external source text remain outside the repository. |
| Unreviewed draft | LLM output, editor scratch work, or other material that has not passed Typewriter review | A temporary workspace outside this repository | Never a canonical input and never committed. |
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
decisions, final canonical IDs, five required timing passes, any post-review
follow-up passes and their measurement status, and the relation-diff artifact
digest. A metrics file is generated from those sources and canonical records; it
may record counts, rates, timing totals or measured lower bounds, audit findings,
and validation outcomes, but neither file may contain raw model responses, draft
text, confidence scores, secrets, or local staging paths.
The M5-8 expansion plan and stage-report schema are also process metadata: they
define the fixed phase/ladder contract and source-bound per-stage results. A
stage result binds its manifest, derived metrics, relation diff, canonical
directory, verification artifact, and (after the first stage) previous passed
stage report by path and digest; it does not contain a candidate batch or
canonical import rows.
The reviewed canonical JSONL passed to the import gate stays in a temporary
workspace outside the repository.

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
