# Typewriter PR Review

This root `REVIEW.md` is the **authoritative policy for independent PR reviewers**. Read it from the **exact latest PR HEAD** on each review. Do **not** read `AGENTS.md`, agent memories, global/personal `MEMORY.md` or implementer instructions as review authority. Read the active issue, current relevant editorial/technical contracts, actual changes and objective evidence. **Historical migrations, one-time resets, old experiments and archived progress are not instructions to rerun work.**

**Name collision:** *Relation Factory Stage 1 (Candidate Generation) / Stage 2 (Admission)* are **production phases**. *PR Review Stage 1 / 2 / 3* below are **independent review gates**. Do not conflate them.

## 1. Review entry, evidence and gate selection

Before deciding, identify: exact 40-hex PR HEAD; base SHA; changed-path list; active issue/acceptance criteria; current owner decisions; existing PR reviews by stage/SHA; open blockers; and substantive author comments and inline replies.

1. **Review Stage 1** when no effective, evidence-bearing same-HEAD `+1` exists (including when a later `-1` reopened the gate). Perform focused code/data and blocker review.
2. **Review Stage 2** only after an effective same-HEAD `+1` and before an effective subsequent `+2`. Form an independent technical judgment **before reading Stage 1's conclusions**, then challenge its coverage.
3. **Review Stage 3** only after sequential, independent, evidence-bearing same-HEAD `+1` and `+2`. Check exact-HEAD CI/skip and unresolved blockers, then merge using the expected exact SHA if all gates pass.

A new commit stales earlier PASS **markers**, not all earlier evidence; revalidate what changed and every still-relevant blocker. The same GitHub account may serve different stages **only in distinct runs/contexts**, never `+1` and `+2` together. Stages 1/2 do **not retrieve, inspect, rely on or wait for CI statuses/logs**; CI is Stage 3's responsibility. No review stage may fabricate evidence.

### Evidence before a blocker

A `-1` requires a **confirmed, current, material contract violation** with (a) exact source/commit/record or supported failure case, (b) cause and impact, (c) safe correction and (d) appropriate shared regression/check. A hypothesis, unverified file absence, difference in editorial taste, a missing PR-body summary or old project history is not a confirmed blocker.

**Production-queue allegation (A/B/C/D):** Before calling a batch out of order, read the current #860 queue rule; identify whether the queue is A/B **(method, model)** or C/D **method-wide**; and check **actual tracked candidate file paths** and open-PR claims on the exact PR base/current master as appropriate. To assert that an earlier batch is missing, identify the **first missing (shard, batch) and its exact expected path(s)** and verify absence via `git ls-tree`/equivalent tree evidence. Distinguish a directory count from a file count, and do not treat a completed one-time reset or a past `start at 001_01` instruction as evidence that later merged batches disappeared. If facts contradict a previous PASS, show the newly verified path-level evidence; otherwise do not reverse it. Raise uncertainty without `-1` when the claim cannot be verified.

**PR-body reporting is non-blocking:** A missing, incomplete or inconsistent summary/count/source declaration does **not** by itself justify `-1`, withholding `+1/+2` or requesting a dummy commit, even when the method issue calls reporting mandatory. Ask for a focused description correction while issuing the technically warranted PASS. A polished description does not prove performance; independently demonstrated omitted production, fake VERIFIED evidence, source-bound failure or invalid output **can** block.

**Re-review and author replies:** Read author conversation and inline thread replies since the previous review. Address each actual rebuttal against current source/data. Withdraw a disproven `-1` with an evidence-bearing PASS **even without new commits**; do not require a dummy HEAD. For retained blockers explain the remaining concrete failure. Converge through evidence and escalate persistent unresolved conflicts to the owner instead of repeating claims. Do not PASS a demonstrated unresolved blocker.

## 2. Review Stage 1 — focused independent gate

Target **1–3 minutes for routine PRs**, not a deadline. Review active requirements, approach, all changed paths and targeted risk, plus the **producer → validator/enforcer → test → consumer/output** path. Verify visible valid/invalid cases and the relevant source-sense boundary.

On follow-up, enumerate every outstanding Stage 1/2 blocker, compare the new HEAD to previously reviewed evidence, test the actual fix, check the shared invariant and any new regressions. Do not repeatedly reread unrelated files or expand to unbounded repository audits without a concrete suspicion. Review Stage 1 cannot merge. Issue substantive `+1` when no confirmed blocker remains, otherwise targeted `-1`; uncertainties go to Stage 2.

### Relation Factory Stage 1 Candidate PRs (A/B/C/D)

Form/schema correctness and 500-record/sense coverage **alone are insufficient**. The production contract in #860 (C: #1155, D: #1156) requires actual source-sense alignment and eligible candidate forms. Use `docs/review-data.md` and `docs/relation-editorial-policy.md`.

- **Keep:** intelligible sense-bound independent words, compounds and compact scene/image/sensory/emotion/action expressions even when indirect, plain, cross-POS or of uncertain final usefulness. There is no arbitrary quota, phrase-length cutoff, minimum frequency or Stage 2 relevance threshold.
- **Reject:** exact source-lemma repetitions, annotation-only variants, mechanical gloss repackaging, arbitrary modifier+lemma constructions, sentences, disguised predicative clauses, narrated events/procedures and their nominalized disguises. A single demonstrably forbidden sentence or self-repetition is a `-1`; repeated mechanical paraphrases are a shared form defect.
- **Judge individually:** a word containing its source lemma (`건축 → 건축가`) may be a distinct valid compound; the same spelling as a substring is not automatic rejection. A compact related expression (`산뜩 → 가슴 철렁`) is not wrong because it is ordinary; `가는소금 → 하얀 소금` is a mechanical gloss restatement. Treat genuinely debatable artistic merit as Stage 2 Admission, not a recurring Stage 1 `-1`.
- **Sample risks first:** (1) sentence/verb patterns, (2) lemma-containing expressions, (3) multiword/gloss-like expressions, (4) independent words as positive controls. Inspect actual lemma/gloss/bound sense. State sampling limits; a schema-only pass or small sample is not an exhaustive semantic census.
- **C/D execution:** require real source-sense VERIFIED contexts and the actual independent exploration specified by #1155/#1156. False attribution, fabricated evidence, demonstrated missing required sweep or invalid Candidate is a `-1`; an imperfect PR description, absent private ledger or inability to inspect every private source is **not** proof of omission.

**Deletion / blocker-fix audit:** compare the last substantively reviewed pre-fix Candidate set (and initial set if multiple commits intervened) to the new HEAD by `(record_id, sense_id, candidate)`. Count additions, deletions and replacements; inspect **removed candidates** by alleged defect class and source sense, with invalid examples *and* valid independent-word/image controls. A valid Candidate v1 output does not prove legitimate words were preserved. Require restoration or concrete evidence if a valid candidate was lost. No blanket gloss-token/word-length/sub-string/headword-membership filter and no mass deletions based on future Stage 2 Tier. Keep the fix bounded to the identified class and its shared future prevention.

### Relation Factory Stage 2 Admission PRs

One PR = **one 100-record Part** of a 500-record Stage 1 Batch (shard 428 has six valid Parts total). Check the **exact Part's** source senses, all actual Drop decisions, relation type, relevance relative to peers, correct existing target ID vs. text-only, both directions of authored ID↔ID links and preservation of previously admitted Parts in the shard.

Require matching `verify --shard SSS --batch BB --part PP` evidence and preservation of whole-shard Relation/Drop schema and reverse-link/conflict invariants. **Do not require incomplete sibling Parts to satisfy Batch/shard accounting in the same PR**. After all valid Parts of a Batch are merged and verified, require Batch verification; after the whole shard, shard verification. PR creation, an old verification or a partial accounting report never equals admission completion.

## 3. Review Stage 2 — independent comprehensive gate

1. Confirm only the **same-HEAD Stage 1 PASS identity/marker** first. Independently assess the issue and approach, **whole material diff/risk surface**, source/provenance boundaries, producer/consumer flow, affected old/current/future records, failure and valid behavior, test registration and possible regression. A clean Stage 1 does not reduce responsibility.
2. Perform **at least one targeted, production-grounded adversarial probe** (requirement → producer → shared validator/consumer → plausible invalid case). Unsupported mutations of correctly generated read-only data are not substitute failure paths. One probe is a minimum, not a claim of census.
3. Independently recheck outstanding blocker classes and fixes. Then read Stage 1's findings and challenge missing risks or evidence, while ignoring its CI claims. For a demonstrated systemic defect identify actual affected population, root cause, positive/negative controls and appropriate common boundary; do not extrapolate from one questionable word.
4. For Candidate fixes, independently challenge any broad negative diff/deletions and check restored valid words/compact associations, not only surviving records.
5. **Do not inspect CI**. If the technical and shared regression assessment passes, issue `+2` even if CI is pending/failed; CI failures belong to Stage 3. Issue `-1` only for demonstrated technical failure. Never merge or submit GitHub APPROVE/REQUEST_CHANGES.

## 4. Lexical, source and test blocker boundaries

Use risk-specific guides, not the entire repository:

- Lexical, canonical, Stage 1/2 data, senses and relations → **`docs/review-data.md`** and **`docs/relation-editorial-policy.md`**. STDICT `direct/antonym` require plausible recurring source-sense semantic similarity/opposition, not universal word substitution or perfect short-gloss overlap. A topical, causal or contrastive scene alone is not dictionary synonym/antonym evidence. For authored exploratory `near/mood/scene/sensory/action/association`, preserve an intelligible creative path; assess relative `relevance: 1..9` within its source/UI group. Minor category taste or 4-vs-5 disagreement is not a blocker absent a material demonstrated rank inversion or wrong target sense.
- Typewriter 말의 결/연상 (`docs/relation-editorial-policy.md`): confirm exact homograph/sense target, per-direction authored ID↔ID relevance, text-only nonclickable/no reverse/no invented ID, and current implementation support when an authored relation depends on it. Informal synonym-like candidates may legitimately remain exploratory rather than becoming official `direct`. `data/headword-candidates/pr-<PR>.jsonl` needs only current schema/source identity and clear junk/duplicate-same-meaning screening, not deep promotion-worth QA.
- CI, validators, schema, generated SQLite and build → **`docs/review-toolchain.md`**. A new test is justified by a plausible **supported-path** regression or explicit security, license or trust boundary. Favor a shared old-fails/new-passes check for all applicable existing/future data; reject example-only word/batch memorization and artificial unreachable-corruption tests. Consider recurring CI/review/maintenance cost. No weakening of real gates or falsification of provenance.
- Search/ranking → `docs/review-search.md`. Extension/runtime/UI/Chrome/WASM → `docs/review-extension.md`. Licensing and third-party redistribution → `docs/review-licensing.md` / `DATA-LICENSE.md`.

No blanket regex, string-count, dictionary-membership or subjective lexical filter may replace exact source-sense editorial judgment. Do not promote weaker evidence into a confident systemic blocker. Trace each *demonstrated* shared defect through producer, validator/admission, consumer and general regression.

## 5. Review Stage 3 — exact-HEAD CI and merge gate

Only Stage 3 validates **actual changed paths** and successful workflow evidence for the **unchanged exact HEAD**, plus sequential substantive `+1`/`+2` without later unresolved `-1`. Use `docs/review-toolchain.md` for routing:

- **Docs-only:** qualifying documentation paths must have explicit exact-HEAD `ci:normal` skip proof; mixed/unclassifiable changes do not inherit it. `AGENTS.md` and any other path outside the CI classifier's docs-only allowlist must be handled by the **actual classifier**, never assumed skipped because it is Markdown.
- **Normal:** ordinary code, Candidate, Relation and Canonical changes take exact-HEAD `ci:normal` with current-revision checks and zero current-Canonical Full/Lite SQLite builds.
- **Affected Deep:** only Deep checks triggered by registered dependency paths require extra exact-HEAD passing evidence; full Deep / `ci:all` is scheduled/manual, not a substitute PR gate. Unknown/new paths, runner/registry/classifier changes and incomplete diff evidence remain fail-closed under Normal with actionable diagnostics.
- **Schema:** exact base..head SQL-owner classification controls the **separate** Full/Lite SQLite schema gate. The normal automatic pipeline stays database-free.

A green unrelated check, skipped Deep test, stale SHA, or green-looking badge without required evidence is not sufficient. Stage 3 may inspect CI logs when the workflow/check itself changed or claims contradict code. If CI fails or is pending, **do not merge**; report the actionable gate. Do not ask Stage 1/2 to rerun because of CI state alone. If code changes, restart the needed review gates on the new HEAD.

When all gates pass, **squash-merge with expected exact HEAD SHA**. No GitHub APPROVE, REQUEST_CHANGES, `+3`, or required post-merge master Normal run. Explicitly exempted `no-review` documentation PRs follow their applicable project automation/label policy rather than manufacturing fake `+1/+2` reviews.

## 6. Submission format and scope of authority

Each Review Stage 1/2 run posts **exactly one final GitHub PR Review COMMENT** (`gh pr review --comment`, not `gh pr comment`); never APPROVE or REQUEST_CHANGES. Recheck HEAD before submission.

Mandatory first two lines, without prefix whitespace/headings/blank lines:

`+1` / `+2` / `-1` (exactly one marker)
`HEAD: <40-character lowercase hex SHA>`

Then document issue/scope, method/approach, **evidence actually checked**, confirmed blockers (or none), remaining uncertainty and SHA-bound conclusion. On `-1` state cause, consequence, safe fix and regression. On re-review account for author replies and every earlier blocker. Stage 2 also records independent assessment, critique of Stage 1 evidence and adversarial probe.

**PASS tolerance for Stage 1 consumers only:** if the first reviewer used a malformed header, Stage 2/3 may still accept it **only** when the same review unambiguously contains a substantive `+1`, exact same 40-hex HEAD and sufficient technical evidence; never demand a dummy resubmission solely for formatting or Stage 1's incidental CI comment. Producing reviewers, including Stage 2, must use the strict prefix.

Reviewers inspect and comment; they do not implement fixes on behalf of authors, start other agents, bypass CI or self-merge outside the narrowly authorized Stage 3 gate.

