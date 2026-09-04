# Typewriter Data Policy

## Purpose

Typewriter's repository contains Typewriter's curated lexical data, not a dump of an
external dictionary, API, corpus, or model output. External material may support
research, verification, or draft generation only when its applicable terms permit
the intended use. Runtime lookup remains local to the packaged dictionary database.

## Material roles

External material can have one of these limited roles:

- **Reference:** helps an editor investigate a word or usage.
- **Verification:** helps check a Typewriter-authored decision.
- **Draft generation:** helps produce a candidate for later human review.

These roles do not make the external material canonical. Raw responses, scraped
pages, copied entries, unreviewed drafts, and bulk third-party datasets do not belong
in `data/canonical/` or in a generated product database. Reformatting, combining,
paraphrasing, or translating restricted material does not by itself remove its
license or contractual limits.

## External-material review record

Create one record for each external source that materially informs editorial or data
work. This is a review log, not a blanket legal approval. Do not mark a source as
reviewed or adopted when the relevant terms have not actually been checked. Unknown
or unresolved terms mean the source remains pending and its material stays outside
the repository.

Copy this template into the appropriate private editorial notes or issue when a
source is actually reviewed. Do not fill it with invented approvals.

```markdown
## External material review: <short source name>

- Source / provider:
- Source URL:
- License or terms URL:
- Checked on: YYYY-MM-DD
- Reviewer:
- Intended role: reference | verification | draft generation
- Permission basis for that role:
- Allowed storage:
- Allowed processing or transformation:
- Distribution or embedding restrictions:
- Required attribution or notices:
- Decision: permitted for stated role | pending | not permitted
- Typewriter data decision: no adoption | Typewriter-authored result may be considered after review
- Notes and limitations:
```

The record must answer the following before a source is used for the stated role:

1. What source was checked, and when?
2. What use is permitted by its license or terms?
3. May the material be stored, processed, redistributed, or embedded?
4. What attribution or notice is required?
5. Was the source permitted, left pending, or rejected for the intended role?

## Canonical-data rules

Canonical records must be Typewriter's own reviewed data and must remain traceable
to an editorial decision. Before a record enters `data/canonical/`:

- the editor has reviewed the relevant source conditions when external material was
  involved;
- the record is not a raw response, scrape, copied entry, or unreviewed draft;
- any required notice or attribution is recorded in the appropriate project
  documentation;
- unresolved source restrictions are treated as a reason to hold the record out of
  the canonical dataset.

The final relation type, sense distinction, ranking, and wording are Typewriter
editorial decisions. A source, model, or automated confidence value may inform a
decision but does not replace review or become editorial truth automatically.

## Storage and build boundary

Keep raw external material and unreviewed drafts in a temporary workspace outside
the repository. The canonical input is limited to reviewed Typewriter JSONL. The
deterministic build reads canonical input and produces generated SQLite; it must not
silently pull from external services or temporary research material.

See [`repository-structure.md`](repository-structure.md) for the directory and
artifact boundaries.
