# Typewriter — Agent Guidelines

## Project purpose

This repository builds **Typewriter**, a writer-focused Korean lexical and imagery dictionary.

Typewriter is not a general Korean dictionary, a generic thesaurus, a linguistic ontology, or an AI writing assistant.

Its purpose is to help writers find another word, expression, image, mood, sensation, action, or association that preserves or deliberately shifts the texture of a sentence.

The product principle is:

> **Typewriter — 작가를 위한, 말의 결을 찾는 사전.**

The canonical dictionary data is a long-term product asset and must remain independent of any one client. The Chrome extension is the first consumer, not the data model itself.

## Core working principle

**Derive the lexical model from real writer-facing data and demonstrated product needs. Do not design a universal language model in advance.**

When working on schemas, relation types, ranking rules, validation, search, or documentation:

* add fields, relation types, controlled vocabularies, and abstractions only when justified by real Typewriter records, an explicit issue requirement, or a demonstrated near-term workflow;
* prefer the smallest model that preserves the distinction writers actually need;
* do not generalize merely because a hypothetical future word, language, client, or corpus could require it;
* when a plausible future requirement is not yet demonstrated, document or defer it instead of implementing it;
* allow the editorial model to evolve through the pilot data and real writing use.

A technically elegant lexical ontology is not automatically an improvement.

## Writer-facing editorial priorities

Typewriter is optimized for **usefulness in writing**, not for reproducing a traditional dictionary.

A relationship does not need to be a strict dictionary synonym to be useful, but its type must be represented honestly.

For example, a search may surface:

* `direct`: a word or expression that can directly replace the source in a relevant sense;
* `near`: close in meaning but not fully interchangeable;
* `mood`: similar emotional or tonal color;
* `scene`: evokes a related scene or situation;
* `sensory`: shares a sensory image;
* `action`: an action naturally associated with the source mood or situation;
* `association`: a broader writer-useful association.

These relation types are current working categories, not immutable ontology. Preserve, merge, rename, or split them only when pilot data demonstrates the need.

Prefer:

* writer usefulness over lexicographic completeness;
* explicit relation type over a flat undifferentiated synonym list;
* sense-aware relations when the distinction matters in actual use;
* concise, evocative records over encyclopedic definitions;
* high-quality common writing vocabulary over broad low-value coverage;
* human editorial judgment over automated confidence treated as truth.

Do not turn Typewriter into sentence generation. The writer writes the sentence; Typewriter helps the writer find words.

## Data source and licensing discipline

The repository stores **Typewriter's canonical curated data**, not external dictionary/API dumps.

External APIs, dictionaries, corpora, and LLMs may be used as reference, verification, or draft-generation tools only when their terms permit the intended use.

Unless an active issue explicitly establishes otherwise:

* do not commit raw API responses, scraped pages, copied dictionary entries, or bulk third-party datasets;
* do not copy restricted definitions, examples, rankings, or relationship lists into canonical data;
* do not assume that reformatting, combining, paraphrasing, or translating third-party data removes its license or terms;
* use reusable open data only under its applicable license and attribution requirements;
* record source-policy decisions in the repository's data/licensing documentation when they affect ongoing work.

The final relation, classification, ranking, and curation stored in Typewriter must be defensible as Typewriter data, not a disguised copy of a restricted source.

## Canonical data and generated artifacts

Canonical dictionary data must be reviewable in Git.

The intended architecture is:

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

Rules:

* canonical JSONL is the source of truth;
* generated SQLite is never the primary editable source;
* do not hand-edit generated database output to make a test pass;
* the same canonical revision and build inputs should reproduce the same logical database contents;
* dictionary schema version, dictionary version, and source revision should be traceable in generated output when the active milestone requires them;
* user data such as recent searches, favorites, and settings must remain separate from the read-only dictionary database.

## Scale discipline

Do not scale bad assumptions.

The planned progression is deliberately staged:

1. validate the lexical/editorial model on a small pilot set;
2. validate the JSONL → SQLite toolchain;
3. validate the end-to-end Chrome experience with the small dataset;
4. validate writer search UX in actual use;
5. only then expand to thousands of entries.

When working before the scale milestones:

* do not optimize architecture for 100,000+ entries without demonstrated need;
* do not bulk-generate thousands of records before the editorial model is validated;
* do not treat quantity of entries as a substitute for quality;
* when scale exposes a model or generation problem, fix the process before adding more data.

## Search and product priorities

Search should support a writer who is already in the middle of writing.

Prefer:

* fast local lookup;
* keyboard-first interaction;
* low-friction exploration from one word to another;
* clear separation between direct alternatives and wider imagery/association;
* stable, predictable ranking;
* offline behavior after installation;
* restrained UI that feels like a writing tool, not an AI chat product.

Do not add runtime dependency on an external dictionary or AI service unless an active issue explicitly changes the product architecture.

## Scope discipline

Work within the active issue and milestone.

Do not implement work belonging only to a later milestone merely because it is visible in the roadmap.

In particular:

* do not freeze a large lexical ontology before pilot data validates it;
* do not begin large-scale dictionary generation before the vertical slice has been used;
* do not add generalized NLP infrastructure, embeddings, vector databases, cloud services, collaborative editing, or multi-language architecture unless current product needs demonstrate them;
* do not expand Typewriter into a general Korean dictionary or AI writing assistant without an explicit product decision.

When current data and current requirements are fully represented by a simpler design, choose the simpler design.

## Starting a new issue

Unless the user explicitly requests another base, start every new issue implementation from the latest remote `master` head.

Fetch the remote before creating the issue branch. Do not base new issue work on a stale local `master`, a previous issue branch, or an existing PR branch.

Preserve unrelated local changes. Use a separate worktree when necessary.

This rule applies when starting a new issue, not when continuing an existing issue or addressing feedback on its PR.

## Validation

Run the validation appropriate to the changed surface.

For data changes, validation may include:

* JSON/JSONL schema checks;
* reference integrity;
* duplicate records or relations;
* self-reference;
* invalid or missing lemma/sense targets;
* part-of-speech conflicts;
* impossible or contradictory relation metadata;
* deterministic build checks;
* representative editorial regression cases.

For build/database changes, validation may include:

* canonical input → SQLite build;
* schema/index verification;
* metadata/version verification;
* representative lookup queries;
* reproducibility checks.

For Chrome-extension changes, validation may include:

* Manifest V3/CSP compatibility;
* packaged SQLite/WASM loading;
* local search correctness;
* keyboard interaction;
* startup/search latency;
* extension install/update behavior relevant to the issue.

Do not substitute broad unrelated testing for the validation that demonstrates the active issue is correct.

## Monitoring after PR creation

After creating and pushing the implementation PR, automatically begin monitoring that PR every 5 minutes when the execution environment supports it.

On each check:

1. Check whether the PR is still open. Stop monitoring when it is merged or closed.
2. Check for new or updated review submissions, inline review comments, and PR conversation comments. Track what has already been processed to avoid duplicate work.
3. Evaluate all new actionable feedback together against the current head, active issue, canonical data rules, and product requirements. Do not accept feedback blindly.
4. For accepted feedback, implement the appropriate fixes, run relevant validation, commit, and push to the same PR branch. Explain rejected or deferred feedback in the relevant thread.
5. If there is no new actionable feedback, make no changes and post no repetitive status comments.

Continue monitoring after each feedback batch until the PR is merged or closed, or the user asks you to stop.

Monitoring does not authorize requesting another review, posting `@codex review`, or merging the PR. Follow-up review initiation remains subject to `REVIEW.md`.

If the execution environment cannot sustain periodic monitoring, report that limitation explicitly rather than claiming monitoring is active.

## Pull-request reviews

When performing a pull-request review or evaluating review feedback, read and follow [`REVIEW.md`](REVIEW.md) before taking action.

`REVIEW.md` defines review scope, batching, blocker criteria, approach validation, stale-head handling, follow-up review limits, and convergence rules.

Reading those review rules does **not** itself authorize starting, requesting, or repeating a review. Review initiation remains a separate action.

## Documentation

`README.md` is the repository entry point.

Detailed rules should live in dedicated documents as they are introduced by the roadmap. Consult the applicable source of truth before changing an area, including, once present:

* editorial-model guidance;
* canonical data schema documentation;
* data-source/licensing policy;
* repository structure documentation;
* build/reproducibility documentation;
* `REVIEW.md` when reviewing a PR or evaluating review feedback.

Do not duplicate dedicated documents in `AGENTS.md`.

## Decision rule

When choosing between a more general design and a simpler design that fully represents the current Typewriter data and demonstrated writer workflow:

**choose the simpler design.**

Typewriter should become more sophisticated because real words, real relations, and real writing use demand it—not because the architecture can imagine it.
