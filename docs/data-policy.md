# Typewriter Data Policy

## Purpose

Typewriter's canonical dictionary policy covers selected, licensed lexical data
from three National Institute of Korean Language dictionaries:
**표준국어대사전 (STDICT)**, **한국어기초사전 (KRDICT)**, and **우리말샘**.
The data and original Typewriter 말의 결/연상 enrichment are made available
under [CC BY-SA 2.0 Korea](https://creativecommons.org/licenses/by-sa/2.0/kr/).
Canonical contains curated, product-needed dictionary projections, not raw
dictionary/API dumps.

Each source's official copyright policy governs eligibility and attribution
(see [DATA-LICENSE.md](../DATA-LICENSE.md)). Source-attributed examples
and multimedia may have separate rights; do not treat them as licensed by
the general dictionary-text terms. Unrelated external material remains
subject to its own restrictions. Runtime lookup remains local to the
packaged dictionary database.

## Material roles

External material generally has one of these roles:

- **Approved NIKL dictionary sources:** eligible headwords, POS, senses,
  definitions, and lexical links from STDICT, KRDICT, and 우리말샘 may be selected
  and converted to canonical under CC BY-SA 2.0 KR with provenance and attribution.
- **Reference:** helps an editor investigate a word or usage.
- **Verification:** helps check a Typewriter-authored decision.
- **Draft generation:** helps produce a candidate for later editorial review.

Only selected, licensed **projections** of these three dictionaries, not their
raw downloads, are authorized as external dictionary source content in
canonical. Raw API responses, scraped pages, copied entries from unapproved
sources, unreviewed drafts, and protected third-party datasets do not belong
in product data. Reformatting restricted material does not erase its terms.

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
- Intended role: approved NIKL dictionary source | reference | verification | draft generation
- Permission basis for that role:
- Allowed storage:
- Allowed processing or transformation:
- Distribution or embedding restrictions:
- Required attribution or notices:
- Decision: permitted for stated role | pending | not permitted
- Typewriter data decision: no adoption | licensed NIKL dictionary projection | Typewriter-authored result may be considered after review
- Notes and limitations:
```

The record must answer the following before a source is used for the stated role:

1. What source was checked, and when?
2. What use is permitted by its license or terms?
3. May the material be stored, processed, redistributed, or embedded?
4. What attribution or notice is required?
5. Was the source permitted, left pending, or rejected for the intended role?

When a local tool gates access from a review record, it must check the specific
operation scopes and terms reviews required for that tool. A permitted decision
and intended-role label alone do not authorize operations whose individual scope
fields are missing or pending. Distribution restrictions and attribution terms
must also be explicitly reviewed, even when the tool keeps all material local.

## Canonical-data rules

Licensed dictionary data from **STDICT, KRDICT, and 우리말샘** may enter
canonical through source-specific deterministic mappings.
Preserve each source's identity for imported entries, senses and lexical links,
and distribute the required attribution and license with the selected data.
Do not import source-attributed example passages, multimedia, or materials
with incompatible individual rights.

**Typewriter-authored enrichment** (말의 결 and 연상), independently authored
new senses, and other original records remain authored editorial decisions
with source-bound evidence. This policy does not define a general candidate
production or admission workflow. Reusing licensed dictionary definitions or
official links is not a claim of Typewriter authorship.
Other unapproved third-party materials remain excluded.

## Storage and build boundary

Keep raw downloaded reference/dictionary files under the permitted external
workspace (including `~/.cache/typewriter/reference/`) **outside Git**. Licensed,
selected, deterministically generated canonical JSONL projections of STDICT,
KRDICT, and 우리말샘 are approved source content; their raw downloads are
not tracked or distributed. Keep unreviewed authored drafts outside the
repository. The dictionary builder reads canonical JSONL and produces
SQLite reproducibly: it must never silently fetch external services,
local source downloads, or temporary research files during a product build.
Before using a source, check its terms and the applicable source-specific policy
above. Local research files are not product inputs.

See [`repository-structure.md`](repository-structure.md) for the directory and
artifact boundaries.
