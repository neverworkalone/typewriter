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

- add fields, relation types, controlled vocabularies, and abstractions only when justified by real Typewriter records, an explicit issue requirement, or a demonstrated near-term workflow;
- prefer the smallest model that preserves the distinction writers actually need;
- do not generalize merely because a hypothetical future word, language, client, or corpus could require it;
- when a plausible future requirement is not yet demonstrated, document or defer it instead of implementing it;
- allow the editorial model to evolve through the pilot data and real writing use.

A technically elegant lexical ontology is not automatically an improvement.

## Writer-facing editorial priorities

Typewriter is optimized for **usefulness in writing**, not for reproducing a traditional dictionary.

A relationship does not need to be a strict dictionary synonym to be useful, but its type must be represented honestly.

For example, a search may surface:

- `direct`: a dictionary-grade lexical synonym of the bound sense, without requiring interchangeability in every sentence;
- `near`: writer-facing expressive nuance or word texture, not a weaker-synonym fallback or a strict substitution test;
- `mood`: an emotional or tonal color that enriches expression;
- `scene`: evokes a related scene or situation;
- `sensory`: shares a sensory image;
- `action`: an action naturally associated with the source mood or situation;
- `association`: a broader writer-useful association.

These relation types are current working categories, not immutable ontology. Preserve, merge, rename, or split them only when pilot data demonstrates the need.

Prefer:

- Writer usefulness, vividness, generality, and relation richness may guide enrichment or prioritization, but must never be used to admit, hold, reject, or exclude an otherwise valid in-scope lexical entry;
- explicit relation type over a flat undifferentiated synonym list;
- sense-aware relations when the distinction matters in actual use;
- concise, evocative records over encyclopedic definitions;
- prioritize enrichment of high-quality writing vocabulary without using writer usefulness as lexical-admission authority;
- human editorial judgment over automated confidence treated as truth.

Do not turn Typewriter into sentence generation. The writer writes the sentence; Typewriter helps the writer find words.

## Data source and licensing discipline

Typewriter's approved lexical sources are the National Institute of Korean
Language's **표준국어대사전 (STDICT)**, **한국어기초사전 (KRDICT)**, and
**우리말샘**. Selected, licensed headwords, definitions, and lexical links
from these dictionaries may enter canonical under **CC BY-SA 2.0 Korea**,
with attribution to the applicable source. Typewriter's original
**말의 결 / 연상** enrichment uses the same license. See `DATA-LICENSE.md`
and `docs/data-policy.md`.

- Do not commit raw downloaded dictionary JSON, bulk API responses, scraped
  pages, raw corpus passages, protected source-attributed examples or multimedia.
  Selected licensed canonical **projections** are distinct from raw source dumps.
- Do not copy restricted content from unrelated dictionaries or assume that
  transforming it removes licensing conditions.
- Maintain source IDs/provenance, attribution and license applicability.
- Typewriter-specific creative relation classifications, notes, and relevance
  remain authored/reviewed editorial decisions, not automatic dictionary judgments.

Other external APIs, dictionaries, corpora and LLMs remain subject to their
respective use conditions. No new blanket validator or old-data migration is
required by this license decision.

## Canonical and generated artifacts

The editable dictionary sources belong in Git. The current product pipeline is:

```text
approved lexical sources
          ↓
data/canonical/ (source-preserving lexical projection)
          ↓ generated: one record = one meaning (scripts/build/record-meanings.mjs)
artifacts/dictionary.sqlite (Full: source + meanings + provenance)
          ↓ verified product projection
dist/dictionary.sqlite (Lite: Extension dictionary)
          ↓
Chrome Extension
```

Rules:

- preserve licensed canonical source data and its sense/provenance evidence; there is no separate edited Meaning layer (Issue #822): one canonical record is one meaning, derived on every build;
- do not hand-edit generated SQLite to make tests pass;
- Full is the development/source-audit database; only Lite belongs in the Extension package;
- the same committed inputs and build contracts must reproduce the same logical database contents;
- preserve source revision, dictionary/schema versions, and source-bound integrity checks across generated outputs;
- keep user data (recent searches, favorites, settings) separate from the read-only dictionary.

## Current lexical editing and quality discipline

The former **lexical-production factory** (Discovery Stage 1 → Authoring/QA Stage 2 → Admission Stage 3) is retired. Do not start its candidate-batch loops, atomic claim/handoff workflow, stage-specific PR sequence, or autonomous downstream admission based on historical instructions. A future owner-issued task must explicitly define any new production workflow.

Work on the canonical layer according to the assigned issue. A search candidate is a canonical record; polysemy is the several glosses inside it and homonyms are separate records (see `docs/meaning-layer.md`). Do not reintroduce a separately edited Meaning or adjudication layer, and never rewrite canonical source data as a side effect.

Use two relation quality standards:

- `gloss`, `direct`, and `antonym` require dictionary-grade lexical accuracy and source-bound identity/sense/POS checks. A direct synonym need not substitute in every sentence; verify a plausible shared meaning axis. A contrasting situation, co-occurrence, or topical similarity alone is insufficient.
- `near`, `mood`, `scene`, `sensory`, `action`, and `association` support plausible writer-facing exploration. Keep intelligible relationships where possible; evaluate exploratory `relevance: 1..9` against peers of the same source Meaning/UI group rather than imposing synonym-level strictness or quotas.

Relation enrichment is independent of lexical admission. Follow [`docs/relation-editorial-policy.md`](docs/relation-editorial-policy.md) for details.

Source-bound semantic QA must be truthful: report evidence actually checked, unresolved judgments, and corrections. Agent self-check is **not** independent or human review; never invent reviewer identities or approval evidence. For lexical authoring or QA, the assigned primary agent must not delegate to other AI models, CLIs, subagents, or agent sessions. Deterministic local tools and source evidence remain available. Do not inspect unrelated agent account identities, authentication, subscription, or usage details.

Quality and coverage take precedence over throughput. For a recurring defect, fix the common editing, validation, or consumer rule across applicable existing entries and future additions; do not merely patch the example. Keep historical evidence unchanged instead of rewriting it to fit new decisions. PR review Stage 1/2/3 are **separate code-review roles**, defined only in `REVIEW.md`.

## Search and product priorities

Search should support a writer who is already in the middle of writing.

Prefer:

- fast local lookup;
- keyboard-first interaction;
- low-friction exploration from one word to another;
- clear separation between direct alternatives and wider imagery/association;
- stable, predictable ranking;
- offline behavior after installation;
- restrained UI that feels like a writing tool, not an AI chat product.

Do not add runtime dependency on an external dictionary or AI service unless an active issue explicitly changes the product architecture.

## Scope discipline

Work within the active issue and milestone.

Do not implement work belonging only to a later milestone merely because it is visible in the roadmap.

In particular:

- do not regenerate or bulk rewrite canonical data outside the active issue;
- do not freeze a large lexical ontology without demonstrated writer-facing need;
- do not add generalized NLP infrastructure, embeddings, vector databases, cloud services, collaborative editing, or multi-language architecture unless current product needs demonstrate them;
- do not expand Typewriter into a general Korean dictionary or AI writing assistant without an explicit product decision.

When current data and current requirements are fully represented by a simpler design, choose the simpler design.

## Starting a new issue

Unless the user explicitly requests another base, start every new issue implementation from the latest remote `master` head.

Check remote `master` with `git ls-remote`; run `git fetch` only if that commit is not available locally. Do not base new issue work on a stale local `master`, a previous issue branch, or an existing PR branch.

Preserve unrelated local changes. Use a separate worktree when necessary.

This rule applies when starting a new issue, not when continuing an existing issue or addressing feedback on its PR.

## Local worktree dependencies

For a newly created Codex worktree that does not already have the required
dependencies, run this from the repository root:

```sh
corepack pnpm install --offline --frozen-lockfile --ignore-scripts \
  --store-dir "$HOME/.cache/typewriter/pnpm-store"
```

The shared store is machine-local and already contains the current lockfile's
packages. Skip the install when the worktree already has the required
dependencies. Each worktree keeps its own `node_modules`; do not symlink another
worktree's directory. If a lockfile change causes an offline cache miss, report
the specific missing artifact. Only the owner or an explicitly authorized
one-time online frozen install may replenish the shared store; see the
[development setup](README.md#development) for its command.

### Generalize lexical validation

Lexical defects discovered in one word or data partition should normally become shared checks, not example-specific tests.

When a defect expresses a general rule:

- fix the common producer, validator, editorial audit, or consumer boundary;
- apply the rule to **all applicable existing canonical records**, and enforce it for future additions;
- verify actual behavior with a minimal failing fixture and an old-fails/new-passes regression;
- retain local checks only for genuinely local scope or requirements.

Do not encode a growing list of individual words as a substitute for a general invariant. Where a distinction is semantic rather than mechanically decidable, require source-bound editorial review instead of a brittle string heuristic.

## Shared lexical defects and PR priority

When a data or implementation PR uncovers a defect in a shared producer, validator, build, or consumer rather than in specific edited records:

1. Do not conceal the defect with a word-specific exception, misleading rejection, or weakened check.
2. Search current issues and PRs for an existing fix or dependency; avoid duplicates.
3. When a separate shared-code correction is necessary, make its scope and dependency explicit. Prove the fix through the **real production path** and a generalized regression; do not hide unrelated code changes in a data-only PR.
4. Keep a blocked PR and its evidence truthful until the dependency is resolved; do not bypass validation or silently move on.
5. Only the owner controls independent agent sessions and task parallelism. Implementation agents do not initiate reviews or merge their own PRs.

A PR that genuinely blocks ongoing work may use the `urgent` label. Do not use it for routine changes; it affects review priority, not review standards.

## Validation

Run the validation appropriate to the changed surface.

### CI registration and execution tiers

CI scope identifies the domain a check protects; execution tier identifies when
the check runs. Keep these separate in `scripts/ci/registry.mjs`. Register each
check with one domain owner, one protected contract, one tier (`candidate`,
`normal`, or `deep`), and one schedule (`always`, `affected`, or
`manual`). New checks default to `deep`; promote a check into `normal` only when
it protects a current-revision, admission, or product invariant that must block
the same PR. An `affected` check must list normalized repository-relative
dependency paths. Missing path evidence, an empty/unclassifiable diff, or an
unknown or renamed path must retain the Normal gate and a visible diagnostic; they do not justify Full Deep on a PR.
Before relying on that fallback for a newly encountered source path, identify
its protected contract and register the actual regression coverage. An existing
always-on Normal test may be bound to the exact path in
`scripts/ci/deep-gate-coverage.json` without running unrelated Deep checks;
that registry is append-only and independently checked against the PR base.
If existing Deep contracts are affected, connect all affected Deep dependency
paths; if a required check is missing, add a reusable old-fails/new-passes
Normal or Deep regression, not an exemption or batch-specific fixture.
Never remove/replace an earlier binding to lower the gate. Unresolved coverage must be corrected with actual regression ownership; it
never selects unrelated Full Deep as a PR gate. Classifier/runner/registry changes
still require Normal, plus any directly affected registered Deep checks. A registered
test file has exactly one registry owner; unregistered tests may be run directly.

The pull-request workflow routes only legacy pure candidate artifacts to
`ci:candidates`; mixed, unexpected, and unclassifiable changes run Normal.
Candidate validation uses the factory contracts without creating a canonical
session or SQLite database. `ci:fast` is an optional checkpoint inside Normal,
not the candidate-only gate.

`ci:normal` remains the required gate for ordinary code/data/mixed PRs and must
retain the complete current-canonical audit, applicable source/admission
protections, one current-revision SQLite build, direct-search and product
output checks. A normal run may expose the fast checkpoint inside the same
session. `ci:all` runs Normal then current-system Deep checks, and `ci:deep`
selects Deep checks across every domain scope. Completed-batch and one-off
checkpoint tests are Manual: they stay in the repository, are registered in no
CI level or workflow, and are run directly (`node --test <file>`). The existing `Validate and test Typewriter` PR check
always runs the applicable Normal gate and uses `ci:pr` to run only affected
Deep checks at the exact PR HEAD. `ci:all` retains full current-system Deep
coverage for weekly scheduled/manual audits, never automatic PR classification. The path
classifier is not a separate PR check.
Deep data inputs belong in each check's `deepInputs` registry metadata;
`dependency_paths` separately name changes that invalidate that check's
contract. A data file appearing in `deepInputs` does not alone select the
check. Routine canonical and reviewed relation changes must pass schema/shape
classification and the existing Normal source-bound validators.
Legacy `data/candidate-trash/T######.jsonl` files use the same principle:
strict changed-chunk JSONL and the shared permanent-trash contract must pass
before selecting Normal. Normal archive validation still checks changed and
historic archive identities and immutability; candidate+trash changes are not
candidate-only. New or malformed archive paths remain fail-closed. Docs-only
changes retain the exact-head Normal skip, and pure root candidate artifacts
retain `ci:candidates`. CI runner/registry/workflow/classifier edits, unresolved unknown
paths, missing/empty diff evidence and malformed data take Normal on PRs;
any independently matched Deep dependency adds only its affected checks.
Normal validators still reject invalid data. Verified append-only `deep-gate-coverage.json` additions are not
classified as runner or registry implementation changes. A skipped Deep check must be listed with its reason; it never counts as
completed Deep evidence.

### Local Normal CI preflight

Before local Normal CI (`ci:normal`, `pnpm test`, `ci:pr`/`ci:all`), require an empty `git status --porcelain=v1 --untracked-files=all`; otherwise commit intended changes first. Do not run dirty just to trigger `DIRTY_WORKTREE` and retry. `TYPEWRITER_ALLOW_DIRTY=true` is development-only, not PR gate evidence. If CI itself dirties the worktree, fix that producer; retain existing provenance guards.

For data changes, validation may include:

- JSON/JSONL schema checks;
- reference integrity;
- duplicate records or relations;
- self-reference;
- invalid or missing lemma/sense targets;
- part-of-speech conflicts;
- impossible or contradictory relation metadata;
- deterministic build checks;
- representative editorial regression cases.

For build/database changes, validation may include:

- canonical input → SQLite build;
- schema/index verification;
- metadata/version verification;
- representative lookup queries;
- reproducibility checks.

For Chrome-extension changes, validation may include:

- Manifest V3/CSP compatibility;
- packaged SQLite/WASM loading;
- local search correctness;
- keyboard interaction;
- startup/search latency;
- extension install/update behavior relevant to the issue.

Do not substitute broad unrelated testing for the validation that demonstrates the active issue is correct.

## Browser validation

Do not launch Chrome or Chrome for Testing by default.

Prefer deterministic Node, schema, SQLite, validator, and component-level
tests for Typewriter.

Use real Chrome validation only when the change specifically affects a
browser-only boundary, such as:

- extension manifest, permissions, or CSP;
- packaged WASM/SQLite loading in the extension runtime;
- Chrome extension APIs or storage behavior;
- keyboard/runtime behavior that cannot be validated reliably without Chrome.

Data, search, schema, validator, build-tooling, and ordinary UI implementation
changes do not require CFT merely for additional confidence.

Do not add or run browser automation when existing deterministic tests can
validate the affected behavior.

## PR label inheritance

Immediately before opening a PR, read the linked Issue's current labels
(`gh issue view <number> --json labels`) and copy them to the PR.
Explicit PR label instructions replace conflicting inherited labels (e.g.,
`urgent` instead of `batch`); retain unrelated labels.
Verify the PR's labels after creation. Never rely on labels remembered at issue start.
## Monitoring after PR creation

After creating and pushing the implementation PR, automatically begin monitoring that PR every 5 minutes when the execution environment supports it.

On each check:

1. Check whether the PR is still open. Stop monitoring when it is merged or closed.
2. Check for new or updated review submissions, inline review comments, and PR conversation comments. Track what has already been processed to avoid duplicate work.
3. Evaluate all new actionable feedback together against the current head, active issue, canonical data rules, and product requirements. Do not accept feedback blindly.
4. For accepted feedback, implement the appropriate fixes, run relevant validation, commit, and push to the same PR branch. Explain rejected or deferred feedback in the relevant thread.
5. If there is no new actionable feedback, make no changes and post no repetitive status comments.

**Resolve blocking reviews through dialogue:** respond to each new substantive `-1` in the PR conversation (or its relevant inline thread), not solely in a linked Issue or by silently editing PR metadata. Independently assess each finding against the current HEAD and requirements. If correct, fix it and point to the change/evidence; if incorrect or already resolved, explain the counterevidence and specifically ask for reconsideration through the ordinary PR discussion (do not invoke the reviewer yourself). A metadata-only correction may need no code change. Address the reviewer's next response in turn: acknowledge valid points, revise your own position where warranted, and narrow any remaining dispute to verifiable facts and an actionable next step. Neither blind compliance nor repeating the same rebuttal without engaging the reviewer's answer is sufficient.

**Dependency Wait:** When resolving a PR blocker depends on another issue or PR, wait for that dependency to complete. Do not post repetitive replies or status comments while waiting; respond only to a new independent issue or an explicit owner instruction.

**Do not abandon a blocked line:** distinguish a legitimate unresolved defect from a disagreement about evidence or requirements. If further exchanges offer no substantive progress, report the agreed facts, competing arguments, outstanding risk and decision needed to the owner; keep the PR/Issue status truthful and do not silently abandon the batch, declare completion or start unrelated downstream work. No fixed number of exchanges limits a productive discussion. This obligation does not authorize the author to perform, trigger or merge its own review.

Continue monitoring after each feedback batch until the PR is merged or closed, or the user asks you to stop.

Monitoring does not authorize starting, requesting, repeating, or performing a PR review, posting `@codex review`, or merging the PR.

If the execution environment cannot sustain periodic monitoring, report that limitation explicitly rather than claiming monitoring is active.

## Review boundary

Implementation agents do not initiate, perform, or repeat PR reviews unless the user explicitly requests review work.

PR review policy is defined exclusively by `REVIEW.md`.

Do not apply `AGENTS.md` as review guidance.

## Documentation

`README.md` is the repository entry point.

Detailed rules should live in dedicated documents as they are introduced by the roadmap. Consult the applicable source of truth before changing an area, including, once present:

- editorial-model guidance;
- canonical data schema documentation;
- data-source/licensing policy;
- repository structure documentation;
- build/reproducibility documentation.

Do not duplicate dedicated documents in `AGENTS.md`.

When reusing work from another branch, copy only needed changes; never replace a policy/contract file wholesale with an older version. **Only if that transfer changes a policy/contract file**, compare it once against current `master` and reconcile any regression. Ordinary pushes need no extra check.

## Decision rule

When choosing between a more general design and a simpler design that fully represents the current Typewriter data and demonstrated writer workflow:

**choose the simpler design.**

Typewriter should become more sophisticated because real words, real relations, and real writing use demand it—not because the architecture can imagine it.
