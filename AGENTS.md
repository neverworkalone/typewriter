# Typewriter — Agent Guidelines

This file contains **current operating instructions**, not a project history. Read the active issue, the relevant current contracts, and the latest repository state before acting. A completed migration, pilot, reset, archived decision, or historical issue comment is **context, not a command to repeat**. The history remains in Git and GitHub Issues/PRs; do not carry one-time instructions forward.

## 1. Purpose and operating principles

Typewriter is an **offline-first Korean dictionary for writers**: "작가를 위한, 말의 결을 찾는 사전." Help writers discover lexical alternatives, imagery, mood, sensation, action and associations, not automatically write sentences. The Chrome extension is a consumer of the data, not the canonical source.

- Work **only within the owner's active issue** and current product decisions. Do not implement later roadmap work or change scope because an obsolete document says to.
- Prefer the smallest design justified by real lexical records, the current writer workflow, or a demonstrated failure. Avoid speculative universal ontologies, generalized NLP infrastructure, new runtime services and premature schema expansion.
- Never delegate lexical authoring/QA to another AI, CLI, subagent or session without the owner's authorization. An authorized War Room job follows its assigned model/adapter and worker boundaries. Do not self-initiate PR reviews or merges.
- Distinguish observed evidence from inference. Report actual validation, unresolved risks and errors; never claim unrun checks, fabricated source verification, human approval or independent QA.
- For a recurring defect, correct the **shared** producer, validator, admission or consumer boundary for applicable existing and future records; do not patch only an example word.
- Preserve unrelated work, current policies, canonical provenance and accepted data. Neither a reviewer comment nor an agent hypothesis automatically authorizes broad deletion.

## 2. Authoritative references

Follow the **current** scoped contract, not a historical implementation narrative:

| Surface | Source of truth |
| --- | --- |
| Stage 1 Candidate factory and per-method queue | [Issue #860](https://github.com/neverworkalone/typewriter/issues/860), `docs/relation-factory.md` |
| C literary production | [Issue #1155](https://github.com/neverworkalone/typewriter/issues/1155) |
| D corpus production | [Issue #1156](https://github.com/neverworkalone/typewriter/issues/1156) |
| Stage 2 Relation Admission / Part selection | [Issue #927](https://github.com/neverworkalone/typewriter/issues/927), `docs/relation-factory.md` |
| Meaning and Relation editorial policy | `docs/relation-editorial-policy.md`, `docs/meaning-layer.md` |
| Licensing and source policy | `DATA-LICENSE.md`, `docs/data-policy.md` |
| CI / tests / build gates | `docs/review-toolchain.md`, `scripts/ci/registry.mjs` |
| PR reviewer duties (independent of this file) | `REVIEW.md` |

These links define ongoing contracts. Historical "restart", "reset", "after implementation", pilot, or superseded instructions are **not actionable** merely because they appear in an issue, an old PR, or Git history. When documents conflict, check the latest applicable owner decision and current code/data; surface a real conflict rather than guessing.

## 3. Lexical data and source boundaries

- Approved lexical sources: **STDICT (표준국어대사전), KRDICT (한국어기초사전), 우리말샘**. Follow applicable **CC BY-SA 2.0 Korea**, source attribution and provenance under the licensing documents. External corpora, APIs, dictionaries and LLM outputs require their own usage-right checks.
- Commit only authorized **selected canonical projections**, not raw downloaded dictionary dumps, bulk API responses, scraped pages, restricted corpus passages/examples or multimedia. Never infer redistribution permission from public research access.
- `data/canonical/` is the source-preserving lexical projection. One canonical record contains its senses; generated one-meaning records are built from that data. Do **not** introduce a separately hand-edited Meaning or adjudication layer.
- Do not rewrite Canonical as a side effect of Relation enrichment. STDICT-provided `direct`/`antonym` and authorized projections remain source-bound; Typewriter does **not** invent new dictionary-grade `direct`/`antonym` pairs.
- Canonical and approved authored Relation/Drop JSONL are Git-owned. Generated `artifacts/dictionary.sqlite` (Full) and `dist/dictionary.sqlite` (Lite) are reproducible products, **never hand-edited inputs**. Only Lite is packaged with the extension; recent searches/settings are separate from the read-only dictionary.
- Typewriter-authored `near`, `mood`, `scene`, `sensory`, `action` and `association` represent writer-facing exploration. These need plausible source-sense paths, not strict synonym substitutability. Assess `relevance: 1..9` relative to peers of the same source sense/UI group; no admission quota. Relation admission cannot determine whether a lexical entry itself exists.
- Preserve headword/homograph/sense identity. An authored ID target must bind the exact existing sense and obey bidirectional relation semantics; text-only targets have no invented ID, reverse link or click action.

## 4. Relation Factory Stage 1 — Candidate Generation

**Stage 1 produces candidates, not editorial judgments.** These are *factory stages*, not the Stage 1/2/3 independent **PR review roles** in `REVIEW.md`.

### Units and methods

- Canonical has **428 shards**, two **500-record batches** per shard (last shard Batch 02: **83 records**), **856 batches** total.
- **A:** from each exact Canonical source sense, explore directly related words, then **return to the original source sense** and independently explore a second semantic direction; do not merely expand from first-pass candidates.
- **B:** explore **two substantially different imagined scenes/perspectives**, independently source-sense-bound; combine their word discoveries. Do not force filler from a scene that yields no new suitable word.
- **C:** use the verified literary-context and independent **seven-lens/two-sweep** procedure in #1155. A coincidental co-occurrence is not sufficient.
- **D:** use the verified corpus procedure in #1156. A coincidental co-occurrence is not sufficient.
- A/B have separate progress queues per **(method, model)** (Claude, Codex and owner-assigned DeepSeek). C/D each have **one shared queue per method**, irrespective of producer model; a C or D batch has one actual producer and one formal output file.
- Methods remain independent. Do not feed other producers' candidates into Stage 1 discovery or make one method wait for another method unless the current contract expressly requires it.

### Output and quality

Formal output is exactly `data/relation-candidates/<SSS>/<SSS>_<BB>_<method>_<model>.jsonl`. One JSONL row per source record, including **all** its senses, in Canonical order; `candidates: []` is valid. The Candidate v1 payload contains `record_id`, `senses[].sense_id`, `senses[].candidates: string[]` only: **no type, relevance/Tier, target ID, admission/Drop, gloss quotation or explanation metadata**. Validate count, identity, order, duplicates and structure.

- Preserve intelligible, sense-bound **independent words** and concise associations/images/sensations/emotions/actions, even when indirect, ordinary, cross-POS, unfamiliar or weak. Stage 1 has **no fixed/minimum/maximum candidate quota** and must not prejudge Stage 2 merit.
- Reject **sentences, predicative clauses, narrated actions/events/procedures, disguised nominalizations, mechanical gloss paraphrases and bare source-lemma repetitions**. Removing spaces or punctuation does not legitimize a disguised clause.
- Words/compounds **containing** the source lemma are not automatically invalid (`건축 → 건축가` may be a distinct word); mere inflection, annotation or mechanical modifier+lemma (`걸음걸이 → 느린 걸음걸이`) is not an independent discovery. Assess the exact sense and lexical contribution.
- Keep compact meaningful expressions (`산뜩 → 가슴 철렁`) where they open a scene/image, not simply restate the gloss (`가는소금 → 하얀 소금`). Inspect **every final string for forbidden forms**; preserve borderline but plausible writer-facing associations for Stage 2 instead of imposing subjective exclusions.
- On a blocker fix, compare the pre-fix and new `(record_id, sense_id, candidate)` sets, preserve eligible discoveries, and remove only actual Stage 1-ineligible items. Do not silently purge whole word classes or regenerate unrelated already accepted data.

### Next batch and PR

1. Start from the **latest remote master**. Inspect the exact formal Candidate paths on that ref and currently open PRs; do **not** use a directory count or a past reset instruction as a progress cursor.
2. Scan from `001_01` onward **to find the first unfinished and unclaimed batch**. For A/B, completion/claim is scoped by **(method, model, shard, batch)**; for C/D by **(method, shard, batch)** across all model suffixes. The scan starting at `001_01` does **not** instruct rewriting completed files.
3. A valid master file with the expected records/senses is complete; a corrupt/partial file is an error to resolve, not something to skip. A same-key open PR is occupied. A closed-unmerged PR is neither completed nor reserved.
4. Verify the selected batch and recheck PR ownership before submission. Commit the **one full formal batch** in its proper path, then open a PR with correct method/model/shard/batch. Preserve immutable accepted Candidate history; never silently overwrite already merged batches.
5. On review feedback, reuse the same branch/PR, evaluate the reviewer evidence, and address confirmed defects rather than blindly deleting candidates.

## 5. Relation Factory Stage 2 — Admission

**Stage 2 evaluates completed Stage 1 candidates; it does not run new Candidate discovery.** Follow #927 and the current editorial policy.

- Keep Stage 1's **500-record batches** intact. Stage 2 divides each into **100-record Parts**: **5 Parts per Batch / 10 Parts per shard**; final shard 428 has **6 Parts** (Batch 02 Part 01 = 83 records).
- **One Part = one editing session = one PR**. Invoke `prepare/verify --shard SSS --batch BB --part PP` using the actual Stage 2 commands documented in `docs/relation-factory.md`/#927. The six required Stage 1 Candidate inputs for the parent Batch must be integrated and verified; admission edits/accounting are scoped to the selected Part.
- Select the earliest Canonical-order Part with **all required Stage 1 inputs merged on latest master** and **no successful exact-Part verification on master**. Existing active Stage 2 PRs in the same shard block another Part there. Never equate PR creation, worktree contents or a partial report with completion.
- In source-sense context, deduplicate appropriately and decide admission vs. actual Drop, the allowed relation `type`, relative `relevance: 1..9`, and **exact target sense ID** vs. text-only. Preserve writer-useful indirect links where justified, distinguish source-grade `direct/antonym` from authored exploratory types, and respect each direction of an ID↔ID link.
- Add to the existing per-shard `data/relations/relation-<SSS>.jsonl` and `data/relation-drops/drop-<SSS>.jsonl` without overwriting prior admitted Parts. Preserve canonical/STDICT relations.
- **Do not start the next Part until the preceding PR is actually merged and the exact Part is verified on updated master**. Then perform Batch-wide verification after all valid Parts, and shard-wide verification after the entire shard. A missing/failed prerequisite, open conflicting PR or verification failure must hold work, not be bypassed.
- When resuming after a failure/restart, reconcile existing PR, branch, Part evidence and latest master before doing any new work. Never create duplicate Part PRs or run two Stage 2 editors concurrently.

## 6. Implementation and PR workflow

1. **New issues:** start from current remote `master` (`git ls-remote`, then fetch as needed), not a stale local checkout or previous PR branch. Continuing/review-fixing an existing PR uses its current branch and HEAD. Protect unrelated changes and worktrees.
2. **Worktree dependencies:** when required packages are missing, use the project-local frozen/offline install in [README development setup](README.md#development). Do not link another worktree's `node_modules`; report cache misses rather than silently making online/install-script changes.
3. **Preflight:** verify the affected production path, run relevant shared validators/tests, and only add a test for a plausible regression on a supported path. Prefer one general **old-fails/new-passes** regression to word/batch-specific memorization. Don't invent unreachable corruptions just to enlarge test coverage.
4. **CI ownership:** `scripts/ci/registry.mjs` and `docs/review-toolchain.md` define Normal/Deep/affected/manual registration, exact-HEAD gates, the zero-current-Canonical-SQLite-build invariant, and the separate SQL schema gate. Normal is required for ordinary code/data; selected affected Deep checks for owned dependencies; full Deep is scheduled/manual. Keep automatic CI database-free except the explicitly separate schema-owner gate. Do not weaken registration/coverage to make a PR green.
5. **Local Normal CI:** commit intended work and require clean `git status --porcelain=v1 --untracked-files=all` before `ci:normal`, `ci:pr`, `ci:all` or `pnpm test`. Do not use a dirty-worktree override as PR evidence.
6. **Browser:** do not launch Chrome/CFT by default. Use it only for a genuinely Chrome-specific MV3/CSP, packaged WASM/SQLite, API/storage or untestable browser-keyboard boundary; otherwise prefer deterministic tests.
7. **Labels:** just before creating a PR, read the linked issue's **current** labels, apply those appropriate to the PR, honor explicit overrides (e.g. `urgent` instead of `batch`), and verify applied labels. **Documentation-only process/policy PRs carry `no-review`.**
8. **After PR creation:** monitor review/inline/issue comments when the environment supports periodic checks (5-minute cadence). Never claim unsupported background monitoring. Fix confirmed problems on the **same PR** after validation; rebut erroneous blockers with concrete evidence and request reconsideration. Do not initiate a review, merge, or abandon a blocked PR because of a disagreement; escalate unresolved evidence conflicts to the owner. Do not post repetitive status updates.
9. **Reviewer separation:** reviewers use the root `REVIEW.md`, **not these implementer instructions**. An implementation agent does not perform its own independent Stage 1/2 review or merge unless the owner explicitly assigns that distinct role.

## 7. Keep instructions operational

Keep this file and `REVIEW.md` focused on **present-tense invariants and actionable procedures**. Preserve experiment outcomes, one-time resets, migrations, archived branches, old implementation status, and rationale in the original issues/PRs, not as live commands. Add a current rule here only if agents must repeatedly apply it; otherwise link the dedicated contract. When borrowing changes from a different branch, reconcile policy files against the latest master rather than replacing them with older text.

