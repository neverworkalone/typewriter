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

The repository stores **Typewriter's canonical curated data**, not external dictionary/API dumps.

External APIs, dictionaries, corpora, and LLMs may be used as reference, verification, or draft-generation tools only when their terms permit the intended use.

Unless an active issue explicitly establishes otherwise:

- do not commit raw API responses, scraped pages, copied dictionary entries, or bulk third-party datasets;
- do not copy restricted definitions, examples, rankings, or relationship lists into canonical data;
- do not assume that reformatting, combining, paraphrasing, or translating third-party data removes its license or terms;
- use reusable open data only under its applicable license and attribution requirements;
- record source-policy decisions in the repository's data/licensing documentation when they affect ongoing work.

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

- canonical JSONL is the source of truth;
- generated SQLite is never the primary editable source;
- do not hand-edit generated database output to make a test pass;
- the same canonical revision and build inputs should reproduce the same logical database contents;
- dictionary schema version, dictionary version, and source revision should be traceable in generated output when the active milestone requires them;
- user data such as recent searches, favorites, and settings must remain separate from the read-only dictionary database.

## Scale discipline

Do not scale bad assumptions.

The planned progression is deliberately staged:

1. validate the lexical/editorial model on a small pilot set;
2. validate the JSONL → SQLite toolchain;
3. validate the end-to-end Chrome experience with the small dataset;
4. validate writer search UX in actual use;
5. only then expand to thousands of entries.

### Post-5K production scale mode

Once lexical admission, search, deterministic builds, and recurring-defect
regressions are validated, production throughput should rise. Bounded batches
are reviewable safety and transaction checkpoints, not a cap on issue-level
progress. Start corpus production around 200 candidates per batch and allow
growth toward 500 after consecutive clean batches. Continue through clean,
low-yield batches until the issue checkpoint is reached; pause only for a new
systemic defect, exhausted candidate sources, or an explicit product/model/
licensing blocker. Fix systemic defects in shared rules and resume afterward.

Use two editorial review modes: gloss, `direct`, and `antonym` require
**dictionary-grade lexical accuracy**, while `near`, `mood`, `scene`,
`sensory`, `action`, and `association` prioritize **plausible writer-facing
exploration**. Preserve the latter unless a link is plainly incoherent or
wrongly bound; compare exploratory `relevance: 1..9` against the **same
source sense's existing and proposed peers in the same UI group** and
adjust display priority instead of reflexively deleting a useful idea.
A lexical synonym need not substitute in every sentence. Apply this to
**new Stage 2 and Stage D backfill** production alike; no relation quotas.
Relation enrichment remains independent of lexical admission. Current
contract: [`docs/relation-editorial-policy.md`](docs/relation-editorial-policy.md).

#### No external model delegation for lexical QA — Codex and Claude (owner directive, 2026-10-02)

**Applies to all implementation agents, including Codex and Claude, and to M9
retrospective B01–B04 as well as new M10 batches.** Perform candidate authoring,
semantic checks, and historical validation **in the currently assigned primary
agent context**. Do not start Claude CLI, Codex CLI, another AI model/API,
subagents, or a separate agent session to author, verify, review, or endorse
lexical records. Do not invoke a different LLM to satisfy a historical
`reviewer` label or an obsolete independent-review gate. Existing source
files and deterministic local validators/tests may be read/run normally.

Do not inspect `claude auth status` or other agent account identity, email,
subscription, authentication, or usage details to troubleshoot lexical review.
If a tool reports rate/usage limits, treat the reported execution failure as
sufficient; do not probe account state. Use only owner-authorized, task-relevant
diagnostics.

For B01–B04's 1,206 historical records, perform a **new source-bound semantic
quality audit in the primary Codex context**, recording accurate `AI self-check`
provenance, candidate-specific findings, unresolved evidence, and necessary
corrections. Do not relabel it as an independent audit or invent another agent's
review. A gap in the historical independent-review record must remain labeled as
such; the owner has explicitly replaced the retrospective requirement with
source-bound quality assurance. If a legacy validator blocks this truthful
workflow, adjust the **shared contract and generalized regressions** without
relaxing semantic admission, and preserve original B05–B09 evidence as-is.

#### Editorial semantic QA and review provenance (owner decision, 2026-10-02)

Typewriter requires **source-bound semantic quality assurance**, not a number
of Claude instances. A different Claude subagent/context or a distinct
self-assigned reviewer label does **not** establish substantively independent
judgment or authenticated human editorial approval. Do not spawn subagents
for dictionary candidate authoring, semantic QA, or M10 optimization.

For new M10 lexical batches, the main implementation agent may both author
and check candidate decisions using the bounded source evidence. Record that
provenance honestly as **agent self-check**, not "independent review", a
separately authored judgment, or a human decision. Never fabricate historical
reviews, separate-run outputs, or identities to satisfy a validator.

Keep explicit identity, POS, gloss-fit and sense-boundary checks, candidate-
specific reasons and evidence, legitimate fail-closed holds, shared admission,
canonical integrity, and generalized regressions. Implement the contract
change in the **shared producer/validator/tests** before accepting batches
under the new self-check label. Historical B05–B09 review artifacts remain
historical facts; do not rewrite or relabel them. The PR review process's
Stage 1/2 independence is a **separate code-review rule** in `REVIEW.md`.

This owner decision prioritizes measured token-efficient operation. Do not
reinstate subagents to meet an obsolete independence label; obtain a new owner
decision only if changing the underlying trust model beyond this authorization.

When working before the scale milestones:

- do not optimize architecture for 100,000+ entries without demonstrated need;
- do not bulk-generate thousands of records before the editorial model is validated;
- do not treat quantity of entries as a substitute for quality;
- when scale exposes a model or generation problem, fix the process before adding more data.

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

- do not freeze a large lexical ontology before pilot data validates it;
- do not begin large-scale dictionary generation before the vertical slice has been used;
- do not add generalized NLP infrastructure, embeddings, vector databases, cloud services, collaborative editing, or multi-language architecture unless current product needs demonstrate them;
- do not expand Typewriter into a general Korean dictionary or AI writing assistant without an explicit product decision.

When current data and current requirements are fully represented by a simpler design, choose the simpler design.

## Starting a new issue

Unless the user explicitly requests another base, start every new issue implementation from the latest remote `master` head.

Check remote `master` with `git ls-remote`; run `git fetch` only if that commit is not available locally. Do not base new issue work on a stale local `master`, a previous issue branch, or an existing PR branch.

Preserve unrelated local changes. Use a separate worktree when necessary.

This rule applies when starting a new issue, not when continuing an existing issue or addressing feedback on its PR.

### Generalize lexical validation

Lexical quality rules discovered while working on one batch or word should
normally become shared validation, not batch-specific checks.

When a defect represents a general lexical rule:

- implement the rule in the common producer, validator, audit, or admission
  layer;
- apply it to the complete existing canonical dataset where applicable;
- ensure every future lexical addition passes the same rule automatically;
- use minimal synthetic fixtures to prove the rule rather than encoding only
  the current affected words;
- keep batch-specific validation only for genuinely batch-specific properties
  such as scope, counts, ID allocation, timing, or authorization.

Do not fix a recurring lexical defect by adding another batch- or word-specific
test when a repository-wide invariant can express the rule.

## Lexical production factory — agent role boundaries

The factory design is specified only in
[`docs/lexical-production-factory.md`](docs/lexical-production-factory.md)
(state machines, claim/recovery, rejection, validation). It is a design until
implemented; follow it for the stage the owner assigns. *Factory Stage 1/2/3*
are distinct from the PR-review gates in `REVIEW.md`.

- **Stage 1 — Discovery (serial):** use the existing pinned Kiwi/corpus
  extraction to propose dictionary-form lemmas and POS; preserve observed forms,
  provenance and ambiguity; submit candidate batches as separate PRs, independent
  of downstream stages. Do not finalize senses/glosses, do Stage 2 authoring, or
  change canonical JSONL.
  - Use **one execution Issue per assigned Stage 1 run**, not one per batch.
    Reuse an Issue supplied by the owner; otherwise create one when starting
    the run, and link each batch PR to it.
  - **Finish the Issue without another owner instruction:** after all planned
    batch PRs have merged and are confirmed on `master`, post a final result
    comment (batch/PR list, per-batch and total candidate/observation counts,
    unresolved/held work, relevant validation/CI outcomes and deviations),
    then close the Issue as `completed`.
  - If the run stops early or a PR is blocked/unmerged, record completed work,
    blockers and remaining batches in the Issue and **leave it open**. Never
    claim completion merely because a PR was opened or local processing ended.
- **Stage 2 — Authoring and QA (serial series of batches per agent):** on an
  instruction such as "Stage 2 진행해", loop without further operator input, with
  exactly one active batch/PR at a time: re-read merged `master` (rejected reviews
  first, then `created`), claim one batch via its atomic Git ref *before* creating
  a tracking Issue (select another if lost), create the Issue and a branch
  `<claude|codex>/stage2/<issue>-<batch>` (rework reuses the Issue with a later
  branch), perform the full existing PR-ready lexical authoring, source-bound
  semantic QA, validation and regression process, and submit the result PR. **Then
  wait for that PR to merge** (fix CI and reviewer feedback on the same branch;
  never review or merge it yourself; do not bypass a blocked or closed PR). Only
  after the merge is confirmed on `master`, release the claim and start the next batch;
  do not wait for Stage 3 admission. Stop when no eligible work remains,
  the owner stops you, or a systemic failure blocks progress. Do not edit
  canonical JSONL or turn Stage 3 into an editorial repair pass. Parallelism comes
  only from separate owner-launched agents.
- **Stage 3 — Admission (serial):** take a committed `ready` review that has no
  live Stage 3 attempt; check against current master, allocate IDs
  deterministically, open the canonical admission PR, and send lexical/content/
  evidence blockers back through the documented rejection process. Fix systemic
  factory defects in the shared pipeline instead of rejecting unchanged batches.
  Do not write or repair glosses or sense boundaries.
- **Only the assigned stage:** never silently take over another stage. Do not
  initiate reviews or merge your own PRs.
- **Concurrency is owner-controlled.** The owner decides how many independent
  primary-agent sessions to launch. No agent decides, requests, monitors,
  coordinates or limits the number of other agents or waits for them. Each Stage 2
  agent follows the same selection and atomic-claim protocol on its own batch;
  claim exclusivity, not agent awareness, provides parallel safety.
- **No delegation remains:** a Stage 2 agent works in its own assigned context and
  must not launch subagents, other-model CLIs or additional primary-agent
  sessions for lexical authoring or QA. The owner manually launching several
  independent Stage 2 agents is not prohibited.

### Shared defects found while working a batch

When a batch is blocked by a defect in shared factory, validator or Stage 3 code
rather than by the batch data:

1. Do not work around it in the batch data: no deferring or rejecting valid
   records, no per-word exceptions, no weakening of validation.
2. Do not put shared-code changes into the batch result PR. Record only the
   dependency there and keep that PR waiting.
3. Before writing anything, search open issues and PRs for the same defect. If
   a fix already exists, link it and wait for it; do not open a duplicate.
4. Otherwise open a separate issue and a separate PR from the latest remote
   `master` (new worktree) that fixes the shared pipeline with a general
   regression (no word-specific code), run the issue's CI locally, bind the PR
   and enable auto-fix. Never merge it yourself. This shared-fix PR is not a
   second batch: the one-active-batch/one-result-PR rule above is unchanged, and
   the batch result PR simply waits on it.
5. A regression for a shared contract must exercise the real production path
   (real-shaped canonical data and the real validators), not only synthetic
   inputs that omit the new field.
6. After the owner merges it, bring the batch PR up to date with `master`, add
   the data the new contract requires and re-run the prospective Stage 3
   preflight.
7. If a tool or the permission layer denies the shared-code change, stop and
   report; do not retry another way.

### Prioritize PRs that unblock an active Stage

If active Stage 1/2/3 work is blocked until a shared rule, contract, validator,
or pipeline fix PR merges, label that PR `urgent` (including an existing PR).
Use `urgent` only for actual blockers, not routine changes or Stage result PRs.
It prioritizes the next review selection; normal review and merge rules
still apply.

## Validation

Run the validation appropriate to the changed surface.

### CI registration and execution tiers

CI scope identifies the domain a check protects; execution tier identifies when
the check runs. Keep these separate in `scripts/ci/registry.mjs`. Register each
check with one domain owner, one protected contract, one tier (`candidate`,
`normal`, `deep`, or `historical`), and one schedule (`always`, `affected`, or
`manual`). New checks default to `deep`; promote a check into `normal` only when
it protects a current-revision, admission, or product invariant that must block
the same PR. An `affected` check must list normalized repository-relative
dependency paths. Missing path evidence, an empty/unclassifiable diff, or an
unknown or renamed path must fail closed to the full applicable gate. A test
file has exactly one registry owner.

The pull-request workflow routes only pure Stage 1 candidate artifacts to
`ci:candidates`; mixed, unexpected, and unclassifiable changes run Normal.
Candidate validation uses the factory contracts without creating a canonical
session or SQLite database. `ci:fast` is an optional checkpoint inside Normal,
not the candidate-only gate.

`ci:normal` remains the required gate for ordinary code/data/mixed PRs and must
retain the complete current-canonical audit, active factory/admission
protections, one current-revision SQLite build, direct-search and product
output checks. A normal run may expose the fast checkpoint inside the same
session. `ci:all` runs Normal then current-system Deep checks, and `ci:deep`
selects Deep checks across every domain scope. Completed-batch replays stay out
of both levels and the weekly **Deep** workflow. The separate **Historical**
workflow runs weekly and via `workflow_dispatch`, selecting registered scopes
individually. `ci:historical` still requires exactly one registered `--scope`
and runs only checks tagged for that scope; it has no all-history CLI default. The existing `Validate and test Typewriter` PR check
always runs the applicable Normal gate and uses `ci:pr` to run only affected
Deep checks at the exact PR HEAD. `ci:all` retains full current-system Deep
coverage for scheduled/manual runs and fail-closed classification. The path
classifier is not a separate PR check.
Deep data inputs belong in each check's `deepInputs` registry metadata;
`dependency_paths` separately name changes that invalidate that check's
contract. A data file appearing in `deepInputs` does not alone select the
check. Routine canonical and reviewed relation changes must pass schema/shape
classification and the existing Normal source-bound validators. Docs-only
changes retain the exact-head Normal skip, and pure root candidate artifacts
retain `ci:candidates`. CI runner/registry/workflow/classifier edits, unknown
paths, missing/empty diff evidence and malformed data fail closed to full
Deep. A skipped Deep check must be listed with its reason; it never counts as
completed Deep evidence.

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

## Monitoring after PR creation

After creating and pushing the implementation PR, automatically begin monitoring that PR every 5 minutes when the execution environment supports it.

On each check:

1. Check whether the PR is still open. Stop monitoring when it is merged or closed.
2. Check for new or updated review submissions, inline review comments, and PR conversation comments. Track what has already been processed to avoid duplicate work.
3. Evaluate all new actionable feedback together against the current head, active issue, canonical data rules, and product requirements. Do not accept feedback blindly.
4. For accepted feedback, implement the appropriate fixes, run relevant validation, commit, and push to the same PR branch. Explain rejected or deferred feedback in the relevant thread.
5. If there is no new actionable feedback, make no changes and post no repetitive status comments.

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

## Decision rule

When choosing between a more general design and a simpler design that fully represents the current Typewriter data and demonstrated writer workflow:

**choose the simpler design.**

Typewriter should become more sophisticated because real words, real relations, and real writing use demand it—not because the architecture can imagine it.
