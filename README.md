# Typewriter
[![CI](https://github.com/neverworkalone/typewriter/actions/workflows/ci.yml/badge.svg)](https://github.com/neverworkalone/typewriter/actions/workflows/ci.yml)

> **작가를 위한, 말의 결을 찾는 사전.**

Typewriter is a writer-focused Korean lexical and imagery dictionary.

It is designed for moments when a writer wants to:

- replace a repeated word without flattening the sentence;
- find another word with a similar tone, texture, or emotional color;
- move from a word to a related image, scene, sensation, action, or association;
- explore nearby expressions without asking an AI to rewrite the sentence.

Typewriter is not a general Korean dictionary, a generic thesaurus, or an AI writing assistant.

The writer writes the sentence. Typewriter helps the writer find words.

## Product direction

A conventional dictionary asks:

> What does this word mean?

A thesaurus asks:

> What words have a similar meaning?

Typewriter asks:

> What might a writer who reached for this word want to find next?

That can include strict alternatives as well as wider writer-useful relationships.

Current working relation categories include:

- `direct` — directly substitutable alternatives in a relevant sense
- `near` — close in meaning, but not fully interchangeable
- `mood` — similar emotional or tonal color
- `scene` — related scene or situation
- `sensory` — related sensory image
- `action` — action associated with the source mood or situation
- `association` — broader writer-useful association

These categories are intentionally provisional. They will be refined through real pilot data and actual writing use.

## Architecture

Typewriter separates canonical dictionary data from application-specific database output.

```text
reference material / LLM draft
        ↓
normalization · validation · curation
        ↓
canonical JSONL
        ↓
deterministic build
        ↓
dictionary.sqlite
        ↓
Chrome Extension
```

Principles:

- canonical JSONL is the source of truth;
- SQLite is a generated artifact;
- the Chrome extension uses the packaged dictionary database read-only;
- recent searches, favorites, settings, and other user data stay separate from the dictionary database;
- runtime lookup should not depend on external dictionary or AI services.

The UI-independent search state and Editorial Model v1 projection are documented in
[`docs/domain-model.md`](docs/domain-model.md).

The M4 input support boundary and shared search regression corpus are documented in
[`docs/search-regressions.md`](docs/search-regressions.md).

The deterministic candidate tiers and tie rules are documented in
[`docs/search-candidates.md`](docs/search-candidates.md).

The M4 failure-state contract and M5 handoff are documented in
[`docs/m4-handoff.md`](docs/m4-handoff.md).

The M5 target inventory, start-count contract, selection axes, and calibration
quality gate are documented in [`docs/m5-target-inventory.md`](docs/m5-target-inventory.md).

The M5 reviewed batch workflow, external staging boundary, manifest contract, and
canonical import gate are documented in
[`docs/m5-batch-workflow.md`](docs/m5-batch-workflow.md).

The M3 product UI reuses that projection in the popup and the Settings preview.
Display choices are user data stored under the extension's local `storage` area;
they never enter the read-only dictionary database.

## Data policy

External APIs, dictionaries, corpora, and LLMs may be used as reference, verification, or draft-generation tools when their terms permit the intended use.

The repository should contain Typewriter's curated canonical data, not raw third-party dumps.

Do not commit:

- raw API responses;
- scraped dictionary pages;
- copied restricted dictionary entries;
- bulk third-party datasets without an explicit compatible license.

Reformatting, combining, paraphrasing, or translating third-party material does not automatically remove its original license or terms.

For the detailed storage boundaries and external-material review record, see [`docs/repository-structure.md`](docs/repository-structure.md) and [`docs/data-policy.md`](docs/data-policy.md).

## Development strategy

Typewriter is intentionally developed in stages.

1. **Project Foundation**  
   Establish repository, policy, validation, and development rules.

2. **Lexical Model Pilot**  
   Use a small set of representative writer-facing vocabulary to validate the editorial model.

3. **Dictionary Toolchain**  
   Build and validate the canonical JSONL → SQLite pipeline.

4. **Vertical Slice**  
   Build a usable Chrome extension with the small pilot dictionary.

5. **Writer Search UX**  
   Refine search, ranking, keyboard-first interaction, and exploration flow through real use.

6. **Core Dictionary Scale-up**  
   Expand only after the model and product behavior have been validated.

7. **Quality, hardening, and release**  
   Improve data quality, database performance, packaging, and Chrome Web Store readiness.

Do not scale an unvalidated lexical model.

## Repository policy

This repository is private and proprietary.

The source code, canonical dictionary data, lexical relations, classifications, rankings, tags, curated associations, and generated database are not open source unless a specific file or subdirectory explicitly states otherwise.

See [`LICENSE.md`](LICENSE.md).

## Development and review

Implementation work must follow [`AGENTS.md`](AGENTS.md).

Pull-request reviews must follow [`REVIEW.md`](REVIEW.md).

Local validation commands and the CI workflow are documented in [`docs/development.md`](docs/development.md).

## Status

Typewriter is in early development.

The product direction, data architecture, and repository policy are established. The lexical model and implementation are still being validated.

---

Copyright © 2026 Never Work Alone. All rights reserved.
