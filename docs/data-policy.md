# Typewriter Data Policy

## Purpose

Typewriter's **new** canonical dictionary baseline will be a curated,
product-needed projection of the **국립국어원 표준국어대사전 (STDICT)** under
[CC BY-SA 2.0 Korea](https://creativecommons.org/licenses/by-sa/2.0/kr/),
with Typewriter-authored 말의 결 and 연상 enrichment licensed on the same terms.
It is **not** a wholesale raw dictionary/API dump. The reset and import are
separate implementation tasks; this policy does not claim that import is complete.

The NIKL [STDICT copyright policy](https://stdict.korean.go.kr/join/copyrightPolicy.do)
permits reuse of material not separately marked otherwise, subject to attribution
and ShareAlike. Source-attributed example passages and multimedia have separate
rights and are not adopted through this exception. Other external material may
support research, verification, or drafting only within its own terms.
Runtime lookup remains local to the packaged dictionary database.

## Material roles

External material generally has one of these roles:

- **Approved STDICT baseline source:** licensed headwords, POS, senses,
  definitions, and permitted lexical links selected and converted to canonical
  under CC BY-SA 2.0 KR; provenance and required attribution retained.
- **Reference:** helps an editor investigate a word or usage.
- **Verification:** helps check a Typewriter-authored decision.
- **Draft generation:** helps produce a candidate for later editorial review.

Only the specifically approved STDICT **selected projection**, not its entire raw
download, is authorized as external dictionary source content in canonical.
Raw API responses, scraped pages, copied entries from other unapproved sources,
unreviewed drafts, and protected third-party datasets do not belong in product
data. Reformatting or paraphrasing restricted material does not erase its terms.

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
- Intended role: approved STDICT baseline | reference | verification | draft generation
- Permission basis for that role:
- Allowed storage:
- Allowed processing or transformation:
- Distribution or embedding restrictions:
- Required attribution or notices:
- Decision: permitted for stated role | pending | not permitted
- Typewriter data decision: no adoption | licensed STDICT baseline projection | Typewriter-authored result may be considered after review
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

The **STDICT baseline** may enter canonical through a deterministic mapping of
the licensed, eligible source fields, without putting hundreds of thousands of
existing dictionary meanings through Stage 1→2→3 again. Preserve source identity
for each imported entry/sense and its lexical links, and publish the source
attribution and license with the covered dataset. Do not import source-attributed
example passages, multimedia, or content with incompatible individual rights.

**Typewriter-authored enrichment** (말의 결 and 연상), new senses, and
independently authored records remain subject to the existing editorial
production, review and admission requirements. Reusing STDICT's licensed
definitions or official lexical links is not a claim that Typewriter independently
authored them. Other unapproved third-party materials remain excluded.

## Storage and build boundary

Keep raw downloaded reference/dictionary files under the permitted external
workspace (including `~/.cache/typewriter/`) **outside Git**. A licensed,
selected, deterministically generated STDICT canonical JSONL projection is the
approved exception to the former "third-party content never canonical" rule;
the raw JSON source is not a tracked input or distributable artifact. Keep
unreviewed authored drafts outside the repository. The dictionary builder reads
canonical JSONL and produces SQLite reproducibly: it must never silently fetch
external services, local source downloads, or temporary research files during a
product build. See [the shared cache contract](local-reference-cache.md).

M5 target-selection files under `data/inventory/` are tracked editorial planning
artifacts, not canonical input. They may record a candidate, classification, hold,
duplicate, or inflected-form decision, but they must not contain raw external
responses or unreviewed drafts. The inventory validator checks its current snapshot
against canonical data; the dictionary builder ignores the directory.

M5 batch manifests under `data/batches/` are also metadata only. They may record
generator identity, prompt/template version, timestamps, review decisions, correction
fields, and final canonical IDs. They must not store raw responses, draft text,
confidence scores, secrets, or paths into a local workspace. Reviewed canonical rows
are staged outside the repository and pass the batch import gate before an editor
copies them into `data/canonical/`.

See [`repository-structure.md`](repository-structure.md) for the directory and
artifact boundaries.
