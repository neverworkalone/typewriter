# Typewriter — Pull Request Review Guidelines

## Purpose

This document defines how pull-request reviews should be performed and how review feedback should be evaluated in this repository.

The purpose of review is to determine whether the current PR safely and coherently advances Typewriter as a writer-focused lexical and imagery dictionary.

It is not to turn the current milestone into a universal Korean lexical system, generic NLP platform, or speculative future architecture.

These rules apply only after a PR review has been explicitly requested. Reading this file does **not** authorize starting, requesting, or repeating a review.

## Review basis

Review the PR against, in this order:

1. the user's current request;
2. the active issue and its acceptance criteria;
3. `AGENTS.md` and the relevant Typewriter policies;
4. current canonical data, pilot records, regression cases, and demonstrated writer workflow;
5. actual data-integrity, editorial-quality, licensing, reproducibility, search, performance, Chrome-extension, or implementation risks.

Do not review against an imagined future version of Typewriter.

A technically possible edge case is not automatically a current defect.

## Review the reported defect and the overall approach

A review must evaluate both:

1. whether the reported or intended problem is actually solved; and
2. whether the overall approach is valid for Typewriter.

Do not approve a patch merely because it makes one test or example pass when the underlying design creates a broader current failure.

When the approach is flawed:

* explain the root problem;
* explain why the current approach is unsafe, brittle, misleading, or inconsistent with Typewriter's data model or writer workflow;
* recommend a safer, bounded design direction;
* define how that direction should be validated.

Do not require a large redesign when a smaller approach correctly solves the demonstrated problem.

## Review the complete current head

Before posting findings:

* identify the current PR head SHA;
* read the complete current diff, not only the latest incremental commit;
* inspect existing review threads so already-fixed or already-discussed findings are not repeated;
* read the active issue and repository guidance relevant to the changed files;
* inspect representative canonical records when data/model behavior is involved;
* run or inspect the validation relevant to the changed surface.

If the PR head changes while the review is in progress, re-check the current head before posting findings.

Do not report a finding as current when it exists only on an outdated head.

## Supplementary Codex review

When the user asks for a pull-request review, the primary reviewer may request an additional GitHub Codex review when the PR is large, cross-cutting, data-model sensitive, licensing sensitive, or otherwise benefits from an independent second pass.

When using a supplementary review:

* comment `@codex review` at most once for the current head;
* do not request another review when one is already pending or available for that head;
* wait for the Codex review and evaluate its findings rather than forwarding them automatically;
* compare its findings with the primary review, remove duplicates, reject unsupported findings, and present one integrated review;
* confirm that every reported finding still exists at the current head.

A supplementary Codex review is normally unnecessary for a narrowly scoped follow-up review, simple documentation-only correction, or mechanical data cleanup.

The user's review request authorizes this supplementary review request when the primary reviewer judges it useful.

This does not authorize an implementation agent to request a new review automatically after addressing feedback. Follow-up review initiation remains subject to the rules below.

## First review: comprehensive and batched

The first review pass should be comprehensive.

Do not intentionally report one small finding, wait for a fix, and then continue searching the same unchanged material for equivalent findings.

Before submitting the review, inspect the full changed surface for related instances of the same root cause.

Examples:

* if one relation points to a missing lemma or sense, inspect equivalent relation references;
* if one generated record is not deterministic, inspect equivalent ordering/build paths;
* if one relation type is flattened or mislabeled, inspect equivalent mappings;
* if one restricted external source can enter canonical data, inspect equivalent import paths;
* if one normalization rule breaks a common Korean form, inspect equivalent search/normalization paths;
* if one generated artifact is being edited directly, inspect whether the source-of-truth boundary is violated elsewhere in the PR.

Group related findings by root cause and report the affected locations together whenever practical.

The goal is to minimize review/fix cycles, not maximize the number of review comments.

## Finding quality

Before posting a finding, verify that:

* the problem is present in the current head;
* it is relevant to the active issue, current canonical data, or demonstrated writer workflow;
* it is not already resolved elsewhere in the current implementation;
* the premise is supported by the repository, applicable source/license terms, actual Typewriter data, or reproducible behavior;
* the proposed remedy does not unnecessarily broaden the architecture.

A useful finding should explain:

1. what is wrong;
2. why it matters for current Typewriter data, writer use, or product requirements;
3. the root cause when identifiable;
4. a bounded correction or design direction;
5. how the correction can be validated when that is not obvious.

Do not require a specific implementation when several simpler valid solutions exist.

## Blockers and scope

Treat a finding as a blocker when it can produce an incorrect, misleading, unreproducible, legally risky, materially incomplete, or unusable result for current project requirements.

Examples include:

* canonical JSONL that violates the current schema or loses current data;
* relations that silently point to the wrong lemma/sense or misrepresent the current editorial model;
* direct synonyms being mixed with broader imagery/association in a way that misleads the writer;
* raw or restricted third-party dictionary/API data being committed into canonical data contrary to repository policy;
* a licensing path that permits prohibited source material into Typewriter data;
* generated SQLite contents that do not faithfully represent canonical data;
* non-deterministic build behavior where the active milestone requires reproducibility;
* editing generated SQLite or derived output instead of canonical data;
* search/normalization behavior that fails demonstrated core writer queries;
* packaged SQLite/WASM behavior that breaks the supported Chrome extension flow;
* a documented rule that contradicts another current source of truth;
* a change that prematurely scales data generation while the active milestone is still validating the model.

Do **not** treat a hypothetical future consistency problem as a blocker unless it affects:

* current Typewriter data;
* an explicit issue requirement; or
* a demonstrated near-term writer workflow.

Do not demand a universal ontology, embeddings, vector search, cloud backend, multi-language architecture, collaborative editing, generalized NLP infrastructure, or 100K+ scale solely because a future product might benefit from it.

## Editorial and data review

When a PR changes canonical dictionary data or editorial rules, review the data as product behavior, not merely as structured text.

Check as applicable:

* whether the relation type matches the writer-facing meaning;
* whether a supposed direct alternative is actually substitutable in the relevant sense;
* whether a wider association is useful without being presented as equivalence;
* whether sense distinctions are justified by real usage rather than speculative taxonomy;
* whether the ranking or grouping would help a writer find a better word;
* whether noisy or overly distant relations crowd out useful ones;
* whether a change improves representative records without breaking related records;
* whether generated draft/confidence metadata is being mistaken for editorial truth.

The standard is not academic exhaustiveness. The standard is a useful, honest Typewriter result.

## Generated database and toolchain review

When a PR changes the data toolchain:

* verify that canonical JSONL remains the editable source of truth;
* verify schema/reference/integrity checks relevant to the change;
* verify the SQLite build from clean canonical input;
* verify representative queries against the built DB;
* verify ordering or build steps required for deterministic output;
* verify metadata/version behavior when in scope;
* verify that the PR does not require hand-editing generated output.

Do not approve a toolchain change solely because a committed SQLite file appears to work.

## Chrome-extension review

When a PR changes the Chrome product:

* verify the behavior in the supported Manifest V3 environment when practical;
* check CSP/WASM/package-path assumptions when relevant;
* verify that dictionary lookup remains local unless the issue explicitly changes that architecture;
* verify representative search flows and keyboard interaction;
* check startup/search latency when the change can affect performance;
* verify that user data remains separate from the read-only dictionary DB when applicable;
* review permissions and persistent storage changes proportionately to the issue.

Do not import Translight's DOM-complexity assumptions into Typewriter. Review the actual Typewriter runtime surface.

## Evaluate feedback; do not automatically accept it

Review feedback is a proposal, not an instruction that must automatically be implemented.

When evaluating a finding:

* accept it when its premise is correct, it affects the current scope, and the proposed direction is proportionate;
* adapt it when the problem is real but a simpler correction satisfies the current requirement;
* reject it when the premise is false or the current head already resolves it;
* defer it when it concerns only an undemonstrated future requirement.

When rejecting or deferring a finding, leave a concise explanation grounded in the active issue, current data, writer workflow, or repository guidance.

## Address one review batch before requesting another

When a requested review produces multiple comments, collect and evaluate the full review batch before modifying the branch whenever practical.

Address related accepted findings together rather than using a one-comment → one-fix → one-review loop.

After the accepted findings are fixed:

* run the appropriate validation;
* respond to or summarize the disposition of the review findings;
* stop after reporting the result.

Updating the PR does **not** authorize or require another review request.

## Follow-up reviews must converge

A follow-up review occurs only when a new review has been explicitly requested.

The follow-up review should focus on:

1. whether previously accepted blockers were actually resolved;
2. regressions or contradictions introduced by those fixes;
3. material changes added since the previous reviewed head.

Do not restart an unrestricted search for new P2/P3 edge cases in unchanged material that was already available to the first comprehensive review.

A newly discovered serious current defect may still be reported if it materially violates the active issue, corrupts canonical data, breaks the current build/product, or creates a real licensing failure.

Otherwise, record later-discovered improvements as follow-up work rather than prolonging the PR.

Normal review should converge within the initial review plus one explicitly requested follow-up review. Additional rounds should be exceptional and justified by newly introduced regressions or genuinely unresolved blockers.

## Stale findings and concurrent review activity

Do not create overlapping review cycles intentionally.

If a review comment was produced against an older head:

* first check whether the current head already resolves it;
* do not reimplement a fix that is already present;
* reply that it is stale or already addressed when appropriate;
* evaluate only the remaining current problem, if any.

Do not broaden the PR merely to make an outdated review comment structurally impossible in hypothetical future states.

## Merge authorization after an explicit review request

When the user explicitly asks to review a specific PR, that request also authorizes merging **that exact PR** if and only if all of the following are true:

* the complete current PR head has been reviewed;
* no blockers remain;
* all required validation for the changed surface has been confirmed;
* the PR is mergeable into the intended base branch;
* the user has not explicitly prohibited merging.

Do not request separate merge confirmation once those conditions are satisfied.

If blockers remain, required validation is missing, the PR head changed and has not been re-checked, or the user explicitly says not to merge, do not merge.

This authorization applies only to the specific PR the user requested to review. It does not authorize merging unrelated PRs, automatically merging future PRs, or merging merely because another reviewer approved the change.

## Review completion

A review is complete when:

* the complete requested scope has been examined;
* the reported defect and the overall approach have both been evaluated;
* all current blockers found in that pass have been reported together as far as practical;
* non-blocking future concerns are clearly separated from required fixes;
* the review identifies the head it evaluated;
* required validation for approval is confirmed;
* no further finding is being withheld merely to create another review iteration.

The purpose of review is to determine whether the current PR satisfies the current Typewriter requirements safely, coherently, and usefully for writers.

It is **not** to prove that no conceivable future lexical edge case can ever exist.
