# Typewriter Lexical Production Factory (design specification, issue #257)

**Status: design only.** Nothing in this document is implemented. No dispatch
refs, candidate directories, review directories, schemas or validators described
here exist yet. Section 12 lists what an implementation issue must still verify.
The document records the agreed operating policy so that an implementation agent
can follow it without chat history.

> **Terminology.** *Factory Stage 1/2/3* are production stages. They are **not**
> the Stage 1/2/3 PR reviewer gates of root [`REVIEW.md`](../REVIEW.md), which
> still apply unchanged to every PR the factory opens.

> **Amendment (issue #275, owner decision).** A dictionary word/candidate is always a
> **citation-form lemma (표제어)**. Observed inflected forms belong to that lemma as
> evidence and search-form opportunities; they are not independent lexical candidates
> merely because they occurred in another paragraph. A Stage 1 batch therefore targets
> **~500 distinct headwords, not 500 usage rows**: **"500" counts unique lemmas, not
> usages.** §2 below is normative for the lemma-centered (v2) contract; the per-usage
> (v1) shapes in §2.1/§2.2 are **historical** and remain valid only for already-created
> batches such as the historical, **unmerged** C000001 500-usage benchmark cohort (PR #270; not an accepted production batch).

The three parts of this document are kept separate:

| Label | Meaning | Where |
| --- | --- | --- |
| **Policy** | Agreed operating rules. Binding once implemented. | Sections 1–8 (normative text) |
| **Illustrative** | Proposed data shapes. Field names may change; the fields marked *existing* are real. | Sections 3, 5, 6, 9 examples |
| **Verification needed** | Compatibility facts that were checked against the repository, and gaps still open. | Sections 10–12 |

## 1. Why a factory

The current loop is serial: produce lexical records → fix semantic/data errors →
validate → PR review → repeat. Authoring and QA is the expensive, retry-heavy
part. The factory parallelizes only that part (Stage 2) and keeps discovery
(Stage 1) and mechanical canonical admission (Stage 3) simple and serial.

```text
Stage 1  Discovery          (one agent, serial)
   │  data/candidates/C000001/{manifest.json,candidates.jsonl}   candidate status: created
   ▼
 GitHub claim ref + issue   (exclusive, per batch)
   ▼
Stage 2  Authoring / QA     (many agents, parallel, one batch each)
   │  result PR:  candidates manifest → complete
   │              data/reviews/C000001/*   review status: ready
   ▼
Stage 3  Admission          (one agent, serial, "Stage 3 등록해")
   ├─ success ─▶ single admission PR: canonical JSONL + review status: complete ─▶ merge
   └─ lexical block ─▶ close admission PR, status-only PR: review status: rejected, rejected_pr: N
                          │
                          ▼
        priority rework queue ─▶ Stage 2 (same full process) ─▶ review status: ready (new result PR)
```

A systemic Stage 3 defect (allocator, reference remapping, pipeline wiring) is
**not** a rejection; see §8.

Nothing here changes lexical admission, the editorial model, or the canonical
schema. The factory is a work-organization layer around the existing contracts.

## 2. Stage 1 — Discovery (one agent, serial)

**Policy**

- A task targets **10,000 distinct citation-form lemmas (표제어)**, produced in
  serial batches of about **500 distinct headwords** (flexible; hard maximum 1,000).
  Neither source hits, usage rows, observed inflected forms nor POS hypotheses count
  toward that number: a lemma is counted once however many inflections, contexts
  or POS possibilities it has. If fewer than 500 defensible lemmas exist, the batch
  reports the actual count (or source exhaustion); there is no filler, no
  unverified lemma guess and no artificial split. One issue/task, serial batch PRs.
  Stage 1 never waits for Stage 2 or 3.
- **Primary candidate identity is one normalized citation-form lemma**
  (`C<batch>-<NNNN>` is independent of the lemma's spelling but is allocated once per
  lemma). Under it are nested, individually referenceable: the lemma's **POS
  hypotheses**, **observed forms** (e.g. 가는, 가서, 갈 are forms *of* 가다),
  prospective **usage groups** (sense opportunities) and individual
  **observations** (bounded, text-free source references with their own analysis
  record and holds). Homographs, POS alternatives and independently evidenced
  meaning directions are never collapsed merely because their spelling is the same.
- Stage 1 detects (a) lemmas missing from canonical, (b) a new POS for an existing
  lemma, (c) a possible new sense of an existing lemma/POS, and (d) uncertain
  observations. It must **not prematurely reject** a possible new sense, and
  grouping observations under a lemma never discards a different contextual
  meaning: each evidence-backed usage group is carried to Stage 2 for independent
  adjudication. Identical repeated source evidence is deduplicated; a different
  reference of the same form is a separate observation.
- **Canonical comparison before the Stage 2 queue** (per lemma, per POS hypothesis):
  1. new lemma → lexical candidate;
  2. existing lemma with an evidence-backed possible new POS or sense → lexical
     candidate, never automatically `covered` from lemma/POS equality;
  3. existing meaning whose observed form is not supported by the generated-surface /
     exact / search-form mapping → the **search/morphology coverage improvement**
     route (`unsupported_forms`), never a fabricated lexical entry; supported forms
     are not added redundantly;
  4. **proven** same lemma/POS/sense with supported search forms and no new
     evidence-backed possibility → excluded as a duplicate with an auditable reason.
     Stage 1 holds no meaning data and **never asserts semantic identity from
     spelling, POS or morphology**; this exclusion is the validated Stage 2
     group disposition `covered` (§5.1), which must cite an existing canonical sense
     and is checked against the canonical snapshot and the search-form projection;
  5. unresolved lemma/POS analysis → **fail closed**: the observation is preserved
     (reference and holds) in the manifest's `unresolved_observations` for
     verification, is not attached to a guessed headword and is not counted among the
     resolved headwords.
- **Holds are per observation.** One ambiguous surface never holds the clear
  surfaces of the same lemma and never invalidates the lemma. An initial
  `analysis_ambiguous` is a request for further verification, not a final
  editorial rejection. Morphological analysis is consumed through the pinned
  analyzer boundary; the candidate shape does not depend on any provider's result
  structure, N-best confidence or capabilities (provider comparison belongs to
  #272–#274).
- Stage 1 reuses the existing Kiwi-based corpus extractor to discover headwords
  and POS candidates (the `reference:corpus:candidates` extractor of
  [`docs/m9-corpus-production.md`](m9-corpus-production.md), pinned
  `kiwipiepy==0.24.0`, and the shared intake in `scripts/intake/`). Inflected
  forms are restored to the base form where possible (the lemma candidate keeps
  every observed surface form, `forms`, and its per-observation evidence). When the morphological analysis is uncertain or admits several
  readings, Stage 1 records that as `holds` (e.g. `analysis_ambiguous`,
  `lemma_mismatch`, `pos_mismatch`) together with the candidate rather than
  guessing. Kiwi output is only a candidate proposal; the final semantic and POS
  judgment belongs to Stage 2.
- When text-free corpus evidence records `selection.exclusion_sha256` and
  `selection.exclusion_source_artifacts`, the Stage 1 CLI reads the sibling
  `reviewed-lemma-exclusions.json` in the same cache run directory and verifies
  its content digest and source-artifact bindings against that evidence. Its
  normalized lemmas are combined with prior candidate-file lemmas before final
  row selection, so a provider alternative or contextual fallback cannot
  reintroduce an excluded lemma. Keep this sidecar in the cache beside
  `candidate-evidence.json`; it contains no corpus text.
- Candidate and evidence content follows the existing source discipline: bounded
  text-free provenance only; never copyrighted paragraph text or a corpus
  snapshot in Git ([`DATA-LICENSE.md`](../DATA-LICENSE.md),
  [`docs/data-policy.md`](data-policy.md), [`docs/m9-corpus-production.md`](m9-corpus-production.md)).
- Each batch is committed independently:

  ```text
  data/candidates/C000001/manifest.json
  data/candidates/C000001/candidates.jsonl
  ```

- `candidates.jsonl` and the source/evidence provenance are **immutable once
  merged**. Only the explicitly declared operational `status` field of the
  manifest may change afterwards (§7).

### 2.1 Candidate manifest, per-usage v1 (historical)

> Historical (superseded by §2.3 for new batches): kept to describe the v1 shape, e.g.
> the unmerged C000001 benchmark cohort. v1 rows are one per usage possibility.
> They are **not** the active candidate unit.


```json
{
  "contract": "lexical-factory-candidate-manifest-v1",
  "task_id": "T000001",
  "batch_id": "C000001",
  "candidate_count": 500,
  "source_adapter": "corpus-adapter",
  "source_snapshot": "<snapshot id + digest, no text>",
  "canonical_snapshot_digest": "<digest of the complete canonical revision Stage 1 compared against>",
  "extractor_version": "<version>",
  "candidates_sha256": "<digest of candidates.jsonl bytes>",
  "status": "created"
}
```

`candidates_sha256` covers only `candidates.jsonl`. `status` is excluded from
every content digest, so changing `created → complete` never invalidates it.

### 2.2 Candidate record, per-usage v1 (historical)

```json
{
  "candidate_id": "C000001-0001",
  "input": "짠하다",
  "pos": "adjective",
  "usage_hint": "provisional: pitying ache toward someone",
  "observedForms": ["짠한", "짠해서"],
  "evidence": [{"kind": "corpus-paragraph", "ref": "<source/document/paragraph id>"}],
  "holds": []
}
```

- `candidate_id` is `C<batch>-<ordinal>` and **independent of lemma, POS and
  sense**. In v1 two candidates for the same lemma/POS have two different ids (in v2
  there is exactly one candidate per lemma).
- `usage_hint` is a provisional distinguishing note for Stage 2. It is **not** an
  accepted gloss and must never be copied into canonical data unreviewed.
- `evidence` is bounded, text-free, at most five references (the existing
  `MAX_EVIDENCE_REFERENCES` bound).
- `holds` uses the existing reasons in `HOLD_REASONS`
  (`scripts/intake/candidate-contract.mjs`); a hold is fail-closed information
  for Stage 2, not a Stage 1 rejection of a sense.

### 2.3 Candidate contract, lemma-centered v2 (active, issue #275)

`data/candidates/C…/{manifest.json,candidates.jsonl}` only. Manifest
`contract: lexical-factory-candidate-manifest-v2`, `lemma_policy:
distinct-citation-lemma-v1`; the v1 manifest fields are kept (`task_id`, `batch_id`,
`source_*`, `canonical_snapshot_digest`, `analyzer_*`, `proposal_contract`,
`source_evidence_sha256`, `candidates_sha256`, `status`) with these differences:

- Git-based producer runs include `producer_revision`, the full commit SHA for
  the producer source. All Stage 1 runtime sources must be clean; the exact source
  scope is listed in `docs/lexical-factory-contracts.md`. Legacy v2 manifests
  without this field remain valid.
- `candidate_count` = **distinct lemmas** = rows; `observation_count` = total
  distinct observations behind them;
- `selection: {bound, eligible_lemma_count, deferred_lemma_count}` — the bound is a
  lemma count, deterministic lemma order, `eligible = candidates + deferred`;
- `unresolved_observations: [{surface, evidence, holds}]` — observations with no
  reliable lemma/POS (`analysis_missing|stale|error|unsupported`), preserved for
  verification and not counted as headwords.

**Before (v1, 3 candidates for one lemma) → after (v2, 1 candidate):**

```json
{"candidate_id":"C000001-0007","input":"가다","pos":"verb","usage_hint":"…","observedForms":["가는"],"evidence":[{"kind":"corpus-paragraph","ref":"d1#p1"}],"holds":[]}
{"candidate_id":"C000001-0008","input":"가다","pos":"verb","usage_hint":"…","observedForms":["가서"],"evidence":[{"kind":"corpus-paragraph","ref":"d2#p4"}],"holds":["analysis_ambiguous"]}
{"candidate_id":"C000001-0009","input":"가다","pos":"verb","usage_hint":"…","observedForms":["갈"],"evidence":[{"kind":"corpus-paragraph","ref":"d3#p9"}],"holds":[]}
```

```json
{
  "candidate_id": "C000002-0001",
  "input": "가다",
  "pos_hypotheses": ["verb"],
  "forms": [
    {"form_id": "C000002-0001.f01", "surface": "가는"},
    {"form_id": "C000002-0001.f02", "surface": "가서"},
    {"form_id": "C000002-0001.f03", "surface": "갈"}
  ],
  "usage_groups": [{"group_id": "C000002-0001.g01", "pos": "verb", "basis": "pos-default"}],
  "observations": [
    {"observation_id": "C000002-0001.o01", "form_id": "C000002-0001.f01", "group_id": "C000002-0001.g01", "pos": "verb",
     "evidence": {"kind": "corpus-paragraph", "ref": "d1#p1"}, "analysis": {"status": "ok", "input_digest": "<sha256 of the analyzed surface>"}, "holds": []},
    {"observation_id": "C000002-0001.o02", "form_id": "C000002-0001.f02", "group_id": "C000002-0001.g01", "pos": "verb",
     "evidence": {"kind": "corpus-paragraph", "ref": "d2#p4"}, "analysis": {"status": "ok", "input_digest": "…"}, "holds": ["analysis_ambiguous"]},
    {"observation_id": "C000002-0001.o03", "form_id": "C000002-0001.f03", "group_id": "C000002-0001.g01", "pos": "verb",
     "evidence": {"kind": "corpus-paragraph", "ref": "d3#p9"}, "analysis": {"status": "ok", "input_digest": "…"}, "holds": []}
  ],
  "observation_total": 3,
  "observation_digest": "<sha256 of the sorted full observation keys>"
}
```

Rules: rows are ordered by lemma and a lemma appears once per batch **and never again in
any later batch** (v1 headwords included); every observed form and every usage group
keeps at least one observation; observations are capped at 64 per lemma by a
deterministic selection that first covers every form and group (a lemma that cannot be
covered within the cap fails the run), and `observation_total` + `observation_digest`
bind the omitted remainder to the locally recoverable, text-free evidence; an optional
text-free `usage_group` token on an extractor hit opens a separate usage group
(`basis: corpus-hint`). **The current extractor (`safeEvidenceHit`) emits no such token**, so
real runs yield one default group per POS and Stage 1 gives no sense signal; independently
evidenced sense directions are therefore adjudicated by Stage 2, which may split a group by
observation (§5.1) instead of relying on Stage 1 to guess them.

**Operator note: "500" now counts unique lemmas, not usages.** The run summary reports
separately: unique lemmas, observed forms, POS hypotheses, usage groups, observations
(total/retained), held observations and lemmas, holds by reason, unresolved
observations, deferred lemmas and lemmas skipped as already produced.

**Compatibility.** v1 manifests/rows, their IDs and digests are validated unchanged and
a merged batch may not change contract (an unauthorized v1 → v2 migration fails). The
PR #270 / `C000001` 500-usage cohort stays the immutable comparison input of #274. v2
applies to batches created after this contract; nothing is migrated.

## 3. Work claiming and dispatch (GitHub only)

**Policy**

- Before assigning a Stage 2 batch the dispatching agent inspects the committed
  candidate manifests on `master`, the rework queue (§8) and outstanding claim
  refs. Preference order: **(1) rejected review batches, (2) oldest eligible
  `created` batch.** Order among eligible batches is not a correctness
  constraint.
- A GitHub Issue records ownership and work history, but issue title or search
  gives **no exclusivity**. Exclusivity comes from a **unique Git ref** created
  atomically *before* the issue:

  ```text
  refs/heads/stage2-claims/C000001
  ```

  `POST /repos/{o}/{r}/git/refs` fails with 422 if the ref exists, so exactly one
  concurrent worker wins; losers pick another batch. No central mutable progress
  file and no dispatch service are used. Stage 2 never depends on Stage 3.
- The ref and its issue remain the claim for the whole life of the batch,
  including while a status-change PR is open.

### 3.1 Claim protocol

| Step | Actor | Action | Idempotent recovery |
| --- | --- | --- | --- |
| 1 | agent | Select batch `C…` from `master` manifests (`created`, or `rejected` rework). | Selection is recomputed each attempt. |
| 2 | agent | Atomically create ref `stage2-claims/C…` at current `master` head. 422 ⇒ lost; choose another batch. The ref is the **only** batch lock. | A session that created the ref continues in its own context. |
| 3 | agent | The successful claimant creates the tracking Issue; its GitHub-generated number `N` is unique in the repository. The issue body names the ref, base SHA and, for rework, the rejected PR. | If the ref exists without an issue, see *interrupted claim* below. |
| 4 | agent | Work on branch `<agent>/stage2/<N>-C…` (rework: `<agent>/stage2/<N>-C…-rK`), e.g. `claude/stage2/260-C000001`, `codex/stage2/261-C000002`. `<agent>` is `claude` or `codex` (the only supported agents today). | The branch name is a label, never a lock. |
| 5 | agent | Open the Stage 2 result PR (§5). Issue links the PR. | Existing PR for the branch is reused. |
| 6 | agent | After the PR is merged and confirmed on `master`, the agent deletes the claim ref; the issue closes with the PR. The agent never merges. | Orphan cleanup below. |

The owner launches as many agents as the token budget allows. Each agent follows
this same queue and does not inspect, coordinate with or count other agents, and
agent-generated worker identifiers are not used. The Git ref is the only
exclusivity mechanism: not issue titles, not branch names, not the GitHub login
(which is shared across sessions) and not the `<agent>` prefix.

**Recovery rules (policy):** deliberately simple and owner-driven.

- *Interrupted claim (ref exists, issue creation did not happen or is unknown).*
  The ref is preserved. No other agent infers ownership, creates an issue, or
  starts the batch: an issue number does not exist yet, so branch naming cannot
  resolve this case. The claimant that created the ref (still running) creates the
  issue. In a new session, an agent that finds an issue-less claim ref **leaves it
  alone and selects another batch**.
- *Ambiguous orphan or stale claim* (no issue, or an issue with no recent branch,
  PR or comment activity, and the claimant is gone): resolved by **owner-directed
  manual action**: the owner either deletes the ref, or comments on the issue
  naming the agent that should continue. A continuing agent keeps the same ref and
  issue and reuses the existing branch. There is no automatic adoption, so there
  is no race to prove.
- *Optional later automation.* If automatic adoption is ever added, it must be an
  exclusive Git-ref update (non-force fast-forward from the observed head, so that
  only one of several simultaneous adopters wins) with race-safety proven by the
  fault-injection test in §12, and must not weaken duplicate-batch exclusion. It is
  not part of this design.
- *Duplicate prevention.* Before creating an issue the claimant searches for an
  existing one that cites the claim ref in its body (a non-authoritative
  convenience check); the ref, not the search, is the lock.
- *Orphan ref:* a ref whose batch is already `complete` on `master` (or whose
  issue is closed and no PR is open) may be deleted by any agent.
- *Rework claim:* for a `rejected` review batch the ref is `stage2-claims/C…`
  again; the existing issue is reused and extended rather than duplicated.
- *Cleanup:* the agent removes its ref after it confirms the result PR merged, or
  on owner-recorded abandonment.

## 4. Stage 2 — Full lexical authoring/QA (many agents, parallel)

**Acceptance standard (policy):** the Stage 2 result must have **exactly the
quality and completeness of the existing Typewriter lexical production output
immediately before its normal canonical-addition PR is submitted.** This is the
expensive, retry-heavy stage, not a shallow accepted/rejected screen.

One agent owns an entire Stage 1 batch from claim to readiness and iterates on
fixes, tests and its own self-checks without blocking other agents.

### 4.1 PR-equivalence acceptance gate

A Stage 2 result is acceptable if and only if everything that a current
`build-issue-223-corpus-batch.mjs` batch must satisfy before its PR holds, with
the sole exception that canonical JSONL is not yet written. Concretely it
**reuses, without weakening**:

| Concern | Existing module (verified) |
| --- | --- |
| Source-neutral candidate contract, normalization, holds | `scripts/intake/candidate-contract.mjs` |
| Bounded, pinned Kiwi analysis (`kiwipiepy==0.24.0`), stable-output retry | `scripts/intake/kiwi_service.py`, `kiwi-client.mjs` |
| Shared intake stages and coverage | `scripts/intake/pipeline.mjs` |
| Source-bound hand-off and bindings | `scripts/intake/production-handoff.mjs`, `production-handoff-cli.mjs`, `scripts/batch/intake-handoff-boundary.mjs` |
| Frame validity rule | `frameUsesLemma` in `scripts/batch/semantic-self-check.mjs`, `scripts/intake/frame-analysis.mjs` |
| Semantic decisions, agent self-check provenance | `scripts/batch/issue-223-semantic-qa.mjs`, `scripts/batch/authored-semantic-decision-source.mjs`, `scripts/validate/semantic-audit.mjs` |
| Sense-boundary QA | `scripts/validate/sense-boundary.mjs`, `scripts/validate/lexical-quality.mjs` |
| Candidate production/selection/disposition | `scripts/batch/lexical-production.mjs`, `lexical-selection.mjs`, `lexical-production-state.mjs` |
| Shared admission validators | `scripts/batch/lexical-admission.mjs` (`validateLexicalAddition`) |
| Prospective complete-canonical audit | `scripts/validate/dataset-integrity.mjs`, `canonical-context.mjs` |
| Regression tests and CI invariants | `ci:fast` / `ci:normal` categories; one complete-revision context |

Rules carried over unchanged:

- Preserve real provenance and honest labeling. New batches use the owner's
  **agent self-check** label (AGENTS.md, 2026-10-02); no subagents, no other-model
  CLIs, no fabricated independent or human review, no invented reviewer
  identities.
- Preserve every hold, reject and defer reason; no dropped or phantom candidates.
- Zero relations are allowed where the current process allows them; relation
  enrichment never gates lexical admission.
- Relation enrichment is a non-blocking sub-pass after the sense meaning is
  fixed. Search is required; creation is not. Each reviewed sense carries either
  `relation_decision: 'no-relations'` (with a sense-bound `no_relation_rationale`
  after the enrichment attempt) or `'relations-reviewed'`, where
  `relation_count`/`relation_ids` equal the exact `reviewed_record.senses[].relations`
  tuples (`relation_ids` come from `reviewedRelationId`, covering source sense,
  target, target sense, type, note and `relevance`) and a sense-bound
  `relation_rationale` is present. Exploratory types need `relevance` 1–9;
  `direct`/`antonym` carry none. Targets are existing canonical ids or same-batch
  candidate ids; Stage 3 only remaps and validates them (it never invents
  types, relevance or notes), and canonical integrity rejects missing targets,
  self-references and duplicates. A relation defect is a shared-contract fix,
  never a reason to hold or reject a valid lexical sense.
- Stage 2 may not introduce a weaker parallel rule set. A rule discovered here
  becomes a shared rule, not a Stage 2 exception (AGENTS.md, *Generalize lexical
  validation*).

### 4.2 What Stage 2 must produce

Everything a PR-ready production run would have produced **except canonical
JSONL**: the final reviewed lexical records, the intake hand-off, the authored
semantic decision source, and per-candidate dispositions. Stage 3 must **not** be
asked to author glosses, resolve POS or sense boundaries, repair relations, or do
human-style semantic review.

Stage 2 runs a **non-mutating admission/preflight** against an exact canonical
snapshot (digest recorded), using temporary/resolved ids where final `w…` ids
are not yet allocated, and binds the evidence and snapshot digests to the result.
Final ids are allocated by Stage 3.

### 4.3 One invocation is a serial series of batches (session loop)

The operator starts an independently launched Claude or Codex primary agent once
with an instruction such as **"Stage 2 진행해"**. Unlike Stage 1 and Stage 3, which
the owner may scope with an execution Issue, Stage 2 **creates its own tracking
Issue for each batch it claims** and repeats the Issue → branch → PR cycle without
another operator instruction.

**A single Stage 2 agent has exactly one active batch and one open result PR at a
time.** Parallelism exists only *between* separately owner-launched agents, never
between batches inside one agent.

Loop inside one session:

1. **Read the merged `master` queue now** (never a cached list): prefer a review
   manifest `rejected` (rework), otherwise an unclaimed candidate manifest
   `created`.
2. **Claim first:** atomically create the batch ref `stage2-claims/C…` before any
   Issue. If another agent won, select another batch; no coordination with, or
   awareness of, other workers.
3. **New batch:** create a fresh tracking Issue, then a fresh branch
   `<agent>/stage2/<issue>-<batch>` (`claude` or `codex`, the actual agent).
   **Rework:** reuse or reopen the existing Issue and history (no duplicate issue)
   and use a distinct later branch `…-rK`.
4. **Do the whole batch:** the full PR-ready authoring and QA of §4.1, then submit
   one result PR carrying candidate `created → complete` and review `ready` (or
   `rejected → ready` for rework) together (§5.2). No canonical JSONL.
5. **Wait for that PR to merge.** Opening the PR or marking it ready for review
   does **not** permit starting another batch. While pending, the agent handles CI
   and reviewer feedback, pushing fixes to the **same branch**. It never reviews or
   merges its own PR. A PR that is blocked or closed unmerged is **not silently
   bypassed**: the agent resolves the blocker or reports an irrecoverable stop and
   does not take a new batch.
6. **Only after confirming the merge on `master`:** delete the prior claim ref
   (§3.1), refresh `master` and return to step 1. Every batch has its own Issue,
   branch and merged result PR. The agent does **not** wait for Stage 3 admission
   of the batch it just completed, only for its own Stage 2 PR.
7. **Stop** when no eligible work remains (report; no busy polling), the owner
   stops the session, or a systemic/irrecoverable error prevents safe progress.

The owner chooses how many agents to launch from the token budget; none needs
worker-count awareness, tokens, orchestration or helper agents, and the atomic
claim keeps concurrent agents on different batches. Stage 1 keeps filling the
queue and Stage 3 admits ready batches serially.

**Worked example (one agent session; Issue and PR numbers are illustrative):**

```text
refresh master → claim stage2-claims/C000001 → Issue #260 → claude/stage2/260-C000001
  → full Stage 2 → result PR #270 → CI/review feedback fixed on the same branch
  → #270 MERGED, confirmed on master → delete claim ref C000001
refresh master → claim stage2-claims/C000002 → Issue #261 → claude/stage2/261-C000002
  → result PR #271 → feedback on the same branch → #271 MERGED, confirmed
refresh master → claim stage2-claims/C000003 → Issue #262 → claude/stage2/262-C000003
  → result PR #272 → … → merged → queue empty ⇒ report and stop
```

At no point is `C000002` claimed while #270 is open. If a claim attempt loses, the
agent selects another batch from the refreshed queue. If Stage 3 later rejects
`C000001` (`rejected_pr` set), the next iteration of any Stage 2 agent picks it
first: Issue #260 is reused, branch `claude/stage2/260-C000001-r2`, and a new
result PR returns the review to `ready`.

## 5. Stage 2 result PR

### 5.1 Illustrative output

Adapt to the **existing** tracked contracts; do not invent a second semantic
schema. Existing batches already track a candidate review, a semantic decision
source, a semantic review input and (from B16) a hand-off under `data/batches/`.
The factory only regroups and addresses them per factory batch:

```text
data/reviews/C000001/manifest.json            # review status: "ready"
data/reviews/C000001/decisions.jsonl           # candidate → disposition / intended entry or sense / reviewed payload
data/reviews/C000001/semantic-decisions.json   # the existing semantic-decision-source (lexical-semantic-decision-source-v4), or its equivalent(s)
data/reviews/C000001/intake-handoff.json       # the existing text-free hand-off (when produced)
```

Illustrative review manifest:

```json
{
  "contract": "lexical-factory-review-manifest-v1",
  "batch_id": "C000001",
  "candidates_sha256": "<same digest as the candidate manifest>",
  "canonical_snapshot_digest": "<exact revision the preflight ran against>",
  "decisions_sha256": "<digest>",
  "semantic_decisions_sha256": "<digest>",
  "handoff_sha256": "<digest>",
  "attempt": 1,
  "status": "ready"
}
```

Illustrative decision row (one per candidate, no omissions):

```json
{
  "source_candidate_id": "C000001-0001",
  "disposition": "included",
  "target": {"kind": "new_entry"},
  "reviewed_record": {"lemma": "짠하다", "senses": [{"pos": "adjective", "gloss": "…"}]},
  "provisional_ref": "tmp-0001"
}
```

For lemma-centered (v2) candidates the row also carries `group_decisions`: exactly one
entry per usage group, in order, with a candidate-specific `reason`, so no sense
opportunity disappears silently. A group is `included` (with `sense_indexes` naming the
reviewed senses of the same POS; every reviewed sense must be claimed; a
`hold_resolution` is required exactly when that group's own observations carry holds),
`covered` (proof of an existing canonical sense of the same lemma/POS **and** every
observed form already a supported search form), `search_coverage` (meaning already
canonical, `forms` = exactly the unsupported observed forms; the search/morphology
route, not a lexical entry), `rejected` or `deferred`. An admitted candidate needs at
least one included group; a rejected/held/deferred one none.

A group may be **split**: several entries with the same `group_id`, each naming the
`observation_ids` it judges. The entries of a group must partition its observations
exactly, so every distinguishable evidence-backed sense opportunity inside a group gets
its own disposition, reason, `hold_resolution` / sense claims and (for `covered` /
`search_coverage`) its own search-form proof. A group with a single entry and no
`observation_ids` covers all of its observations.

**Observation fit of `covered`/`search_coverage` (C000008 onward, #366).** The structural proof
does not show that each observation's meaning lies inside the existing gloss. From C000008 on, the
`reason` of a `covered`/`search_coverage` entry must name every observation it judges (`o01`); that
mechanical provenance check is a hard rule. Whether the meaning fits stays a source-bound semantic
judgment: an observation outside the existing gloss is split off by `observation_ids` and deferred, or
authored as its own sense. A reason that mentions 비유·빗대·은유·상징·관용·몸짓 is only reported as a
non-blocking advisory (the word can be literal, e.g. the lemma 상징, or describe a sense the canonical
entry already holds). Merged earlier batches stay as recorded.

**Gloss scope (source-bound, lemma-centered reviews).** An admitted gloss may only describe the
observations its included groups claim, so a deferred, rejected or already-covered meaning
cannot leak into it. Every `sense_reviews[i]` of a pending (not yet Stage 3 `complete`) review
carries `scope_declaration: {admitted_observation_ids, excluded_observation_ids, excluded_terms}`.
Both id lists must equal what the decision's `group_decisions` derive for that sense; while
observations are excluded, `excluded_terms` must name the excluded meaning, each term must occur
in the authored `reason` of an entry that judges an excluded observation, and no term may occur
in the gloss. A term must denote the excluded meaning, not merely occur in a reason: a generic placeholder
(쓰임, 뜻, 의미, …) or an observed surface form / the lemma (with or without a particle) is refused. Whether a
gloss otherwise stays within its evidence remains a source-bound semantic
judgment; the contract makes the scope explicit and refuses the mechanically detectable widening
(`scripts/factory/scope-declaration.mjs`, enforced by `validate.mjs` and the shared review artifact
validator). Reviews already `complete` predate the field and are not rewritten.

**Surface-form (inflection class) judgments.** An admitted predicate sense whose final coda cannot be
classified by a mechanical rule (for example a ㅂ-final adjective, regular or irregular) needs an explicit
Stage 2 judgment, because Stage 3 never guesses it. The decision row of an `included`/`corrected` candidate
carries `surface_form_judgments: [{sense_index, class_id, reason}]`: `sense_index` is the 0-based index in
`reviewed_record.senses`, `class_id` is any M6-2/M6-3 class that the shared surface-form rule accepts for that
exact sense (an irregular exception class, the regular risk-coda class, or the predicate exclusion) and `reason`
is authored, candidate-specific text citing the candidate id. A judgment is allowed only for a sense that has an
open judgment gap, and a sense with an open gap needs one; unknown or mismatched classes, duplicates and
judgments for senses that need none are rejected by the shared validator
(`scripts/factory/surface-form-judgments.mjs`, enforced by `validate.mjs` and `validateReviewArtifacts` for every
new or changed review). Stage 3 re-checks the same judgments with `resolveSurfaceFormJudgments`
(`scripts/inflection/surface-form-projection.mjs`) under the allocated canonical ids and records them in the
M6-2/M6-3 manifests it already owns; no word or suffix is special-cased. A merged review that predates the field
is not rewritten: if its sense needs a judgment, Stage 3 fails closed (`STAGE3_SURFACE_FORM_JUDGMENT`) and returns
it through the rejection process for a Stage 2 rework.

**Pairwise evidence against existing same-POS senses.** A `new_sense_on_existing_entry` decision adds senses to a
canonical entry. If that entry already has two or more senses of the same POS as a reviewed sense, the semantic
decision row of the candidate must carry `existing_sense_pairs`, one entry per (existing same-POS sense × reviewed
sense of that POS), each exactly once: `{existing_sense_id, new_sense_id, relationship: 'distinct', decision: 'retain',
existing_gloss_sha256, new_gloss_sha256, evidence_basis, distinguishing_feature, rationale}` (texts cite the candidate id).
The validator (`scripts/factory/existing-sense-pairs.mjs`, via `validateReviewArtifacts` and `validate.mjs`) computes
the required set from the canonical target entry and rejects missing, duplicated, nonexistent, foreign-entry,
wrong-POS or digest-unbound pairs; Stage 3 (`semantic-authority.mjs`) re-validates them against the latest canonical
record and writes exactly that Stage 2 evidence as the pairwise boundary review. A single existing same-POS sense keeps
working with `context_sense_id` alone. Merged historical reviews are not rewritten: the requirement applies to new or
changed reviews, and an older review that needs pairs still fails closed in Stage 3 (`STAGE3_BOUNDARY_CONTEXT_MISSING`).

`disposition` takes the existing meanings: included / corrected / held /
rejected / deferred. `target.kind` is `new_entry`, `new_pos_on_existing_lemma`
or `new_sense_on_existing_entry` (the last two carry the existing canonical `id`
and, for a sense, the existing sense context). Whether the current canonical
import can express the last two is open (§10, §12).

### 5.2 One PR, two manifests

The Stage 2 result PR changes **both** `data/candidates/C000001/manifest.json`
(`status: "complete"`) and `data/reviews/C000001/manifest.json`
(`status: "ready"`) plus the review files. States become authoritative **on
merge**. There is no `claimed` state and therefore no second commit to record a
claim.

> The review manifest `ready` is a durable merged state. It is unrelated to
> GitHub's pull-request "ready for review" flag.

## 6. Stage 3 — Mechanical admission (one agent, serial)

The operator may simply say **"Stage 3 등록해"**. The agent lists committed
`data/reviews/*/manifest.json` with `status: "ready"` on `master` and processes
them one at a time, in any order — **but only those without a live Stage 3
attempt (§6.0)**.

### 6.0 Stage 3 in-flight guard

A merged `ready` manifest stays `ready` while an admission PR is open and also
while a `rejected` status-only PR is open, so `ready` alone cannot tell a fresh
batch from one being worked on. Each Stage 3 attempt therefore has a durable,
crash-safe record:

- **Global lock and attempt claim.** Before selecting any batch, a worker checks
  for `stage3-active`, any `stage3-claims/C…-aN` ref, or any open Stage 3 PR. It
  stops if any exists. To start work, it atomically creates the singleton ref
  `stage3-active`, pointing to a unique Git commit whose message records the
  batch, attempt, master SHA and random owner token; it then creates the
  per-attempt ref `stage3-claims/C…-aN`. A competing invocation that loses the
  singleton-ref race stops without falling through to another ready batch. The
  PR is linked to the per-attempt ref by name (below).
- **Step 0: the admission PR is opened first, as a draft**, immediately after the
  claim, before preflight. GitHub cannot create a PR whose head has no commit
  ahead of base, so the branch `<agent>/stage3/C…-aN` (`claude` or `codex`) is created from `master` with one
  **starter commit** that adds only the metadata file
  `data/reviews/C…/attempt-aN.json` (`{batch_id, attempt, claim_ref}`; no canonical data, no invalid records). The draft PR opens on
  that diff. The marker is reversible: a successful admission PR removes it
  before it is marked ready for review; a closed attempt discards it with the
  branch. An *empty* commit is not assumed to work (reported as "No commits
  between" by GitHub tooling); using it instead requires the real-GitHub
  integration test in §12 to show it is accepted. The draft PR number is the
  attempt's traceable identifier and is what `rejected_pr` always cites,
  including when preflight fails before any canonical change exists (the draft is
  then closed, never merged).
- **Selection rule.** Stage 3 starts no batch while the global lock, any
  per-attempt claim ref, or any open admission or rejection status PR exists.
  A claim collision or concurrent global-lock winner ends that invocation;
  it never advances to another batch. This makes serial admission global across
  separate worker processes, not just sequential within one session.
- **Idempotent recovery of an interrupted attempt** (resolved *before* any fresh
  admission; usernames never distinguish sessions, so state is read from the
  claim ref, the branch and PRs, never from "who am I"): (a) open admission PR
  ⇒ continue it; (b) admission PR closed and a rejection status-only PR open ⇒
  await that PR, do not re-admit; (c) admission PR closed and no rejection PR ⇒
  create the rejection status-only PR citing it; (d) claim ref but no PR ⇒ look
  for a branch `*/stage3/C…-aN` and its PR, else recreate the draft from the
  starter commit. A second session that finds a live global lock does nothing.
  Recovery requires the explicit batch and attempt and the matching lock owner;
  a lock without its attempt ref can recreate that ref under the same lock. A
  lock for another attempt, a second claim, or an unrelated open Stage 3 PR fails
  closed. Duplicate admission is prevented by the singleton ref plus the PR
  linkage, not by session identity.
- **Owner-directed retry after a false rejection.** Only when the owner identifies
  an unmerged status-only rejection as the result of a shared defect that is now
  fixed, an operator may run the explicit
  `--resume-batch C… --attempt N --supersede-rejection-pr <PR>` path. The worker
  verifies the exact lock and claim, the still-ready master review and digests,
  the linked closed lexical-rejection Draft, the open unmerged status PR, and its
  manifest-only diff. The all-state PR inventory must contain exactly one
  admission Draft and one status PR for that batch and attempt; any additional
  same-attempt admission or status PR fails closed regardless of its state, while
  unrelated closed historical PRs for other attempts are ignored. It binds the
  retry to the original rejection code and the actual owner branch recorded by
  the linked PR. It restores the Draft head from the PR ref, closes the
  superseded status PR, and reopens that same Draft.
  `--dry-run` validates these preconditions without changing PRs or refs. If the
  retry reaches the same Stage 2-repairable evidence gap, the worker reopens the
  existing status PR only when its branch still contains the exact expected
  rejected manifest and the rejection code is unchanged; it never creates a
  duplicate PR or edits Stage 2 evidence. A changed rejection code or any other
  mismatch preserves the attempt refs and stops for owner recovery.
- **Release.** Only after the admission PR merges (`complete`) or the rejection
  status-only PR merges (`rejected`) and that exact state is verified on current
  `master`, delete the attempt claim and then the matching global lock. If the
  process crashes between those deletions, the remaining lock identifies the
  merged attempt so explicit recovery can finish cleanup. The next attempt gets
  a new per-attempt ref.

### 6.1 Successful path

1. Take the attempt claim and open the draft PR (§6.0), then load the complete Stage 2 output and verify every digest binding.
2. Against the **latest `master`**: recheck collisions and the full common
   admission and semantic gates; deterministically allocate final canonical ids
   and references; assemble the complete prospective canonical revision; run the
   existing CI, reproducibility and regression requirements.
3. Push the canonical changes and the review manifest `status: "complete"` to
   the **single admission PR** (the draft is marked ready for GitHub review).
4. Apply the PR reviewer gates of `REVIEW.md` (the implementation agent does not
   review or merge). The manifest becomes complete only after merge.

No existing validation is weakened to hit a throughput target.

### 6.2 Blocked path — lexical / content / evidence / stale-snapshot problem

1. Stage 3 performs **no substantive lexical correction**. It stops that batch,
   closes/abandons the unmerged admission PR (including the draft when preflight
   blocked before any canonical change) and disposes of its branch and
   worktree. This is a rollback of unmerged work, not a revert of `master`.
2. A small **separate status-only PR** sets the review manifest to
   `status: "rejected"` and records the blocked PR in a **separate field**:

   ```json
   { "status": "rejected", "rejected_pr": 275, "attempt": 1 }
   ```

   (not a free-text `rejected(#275)`). The status is effective only after that
   PR merges; until then the claim ref keeps the batch out of Stage 3 selection.
3. Stage 3 moves on to the next ready review; the serial agent is never blocked.
4. A Stage 2 agent takes rejected work first (§3), reads the cited PR, reviews
   and blockers, claims or reuses the issue, fixes **all** content/QA/provenance
   problems with the same full Stage 2 process, and submits a new result PR that
   returns the review to `status: "ready"` with `attempt` incremented. The
   rejection and attempt history stays auditable in Git, PR and issue.

### 6.3 Systemic Stage 3 defect is not a rejection

An allocator error, reference remapping bug, pipeline wiring fault or broken
automation is a shared-component defect. Stage 3 **halts**, repairs the shared
component with a **reusable regression**, and resumes. It must not bounce
unchanged batches to Stage 2.

Routing rule: if the same unmodified batch would be admitted by a correct Stage 3,
it is systemic; if the batch content, evidence, snapshot, or a lexical gate
itself is the cause, it is lexical.

## 7. Two state machines and sources of truth

Durable states exist only in merged manifests. GitHub refs, issues and open PRs
are **work in progress**, never state.

### 7.1 Candidate manifest (Stage 1 artifact; changed by the Stage 2 result PR)

| From | To | Trigger / PR | Owner |
| --- | --- | --- | --- |
| *(new)* | `created` | Stage 1 batch PR merged | Stage 1 agent |
| `created` | `complete` | Stage 2 result PR merged (together with review `ready`) | Stage 2 agent |
| `created` / `complete` | `held` | **Exceptional** administrative case only; never a routine intermediate state | owner-directed |

Meaning: `created` — discovered, not yet reviewed in a merged result;
`complete` — a fully reviewed Stage 2 result exists on `master` (it does not mean
admitted to canonical).

### 7.2 Review manifest (Stage 2 artifact)

| From | To | Trigger / PR | Owner |
| --- | --- | --- | --- |
| *(new)* | `ready` | Stage 2 result PR merged | Stage 2 agent |
| `ready` | `complete` | Stage 3 admission PR merged | Stage 3 agent |
| `ready` | `rejected` | status-only PR merged citing `rejected_pr` | Stage 3 agent |
| `rejected` | `ready` | new Stage 2 result PR merged (`attempt`+1) | Stage 2 agent |
| `ready` | *(exceptional hold)* | only with explicit written justification | owner-directed |

`complete` is terminal. The two manifests have **different** vocabularies on
purpose: the candidate one tracks "has Stage 2 produced an accepted result", the
review one tracks "has that result entered canonical".

### 7.3 Immutability

- Immutable after merge: `candidates.jsonl`, source/evidence provenance, and the
  authored semantic evidence of a given attempt.
- Mutable: `status`, `rejected_pr`, `attempt`. These are excluded from all
  content digests so changing them never invalidates candidate-content hashes or
  semantic-source bindings.
- A rework attempt does not rewrite the previous attempt; it adds a new result
  whose history is in Git.

### 7.4 Identity

- `source_candidate_id=C…` is preserved end to end, independent of canonical
  `w…` ids, including for **a new sense on an existing lemma**, where no new
  entry id exists.
- The existing canonical `candidate_id` field (e.g. `"candidate_id":"w12144"` in
  `data/canonical/*.jsonl`, and the id-uniqueness check in
  `scripts/validate/canonical-context.mjs`) must **not** be reinterpreted as a
  `C…` id without an explicit migration. The factory carries its id in a
  separate field (provisionally `source_candidate_id`), subject to §12.
- Final `w…` ids are allocated by Stage 3 from the latest revision (the current
  builder allocates `w` plus the next canonical number; see §10).

### 7.5 Stale base

When later admissions change `master` between Stage 2 QA and Stage 3 admission,
Stage 3 revalidates against the latest complete canonical revision:

- routine id reassignment, ordering and digest refresh → mechanical Stage 3 work;
- a **real lexical conflict** (the lemma/POS/sense is now covered, a gloss now
  duplicates another sense, a relation target moved) → blocked path (§6.2).

## 8. Rework queue

Priority queue = `data/reviews/*` with `status: "rejected"`, oldest first, ahead
of any untouched `created` candidate batch. Each is claimed exclusively through
its `stage2-claims/C…` ref (§3). Systemic rejections do not enter the queue.

## 9. Race and recovery scenarios

| # | Scenario | Expected outcome |
| --- | --- | --- |
| 1 | Two workers pick `C000007` simultaneously. | Both try to create `stage2-claims/C000007`; GitHub returns 422 to one. The loser selects another batch. Only the winner creates the issue and branch. |
| 2 | Agent creates the claim ref and crashes before the issue; other agents later see the issue-less ref. | The ref is preserved. No other agent creates an issue or starts the batch; they select other batches. The owner either deletes the ref or names the agent to continue. No duplicate issue or work. |
| 3 | Stage 3 opens an admission PR for `C000003`; reviewer finds a gloss/sense defect. | Lexical block: close the admission PR, dispose of its branch, open status-only PR with `rejected`/`rejected_pr`. Stage 3 proceeds to `C000004` without waiting for that PR. While it is open the batch is still `ready`; it joins the queue only after it merges. |
| 4 | A second admission (`C000002`) merges while `C000003`'s PR is in flight. | Stage 3 rebases to latest `master`, reallocates ids, re-runs gates. Pure id/order drift is fixed mechanically; a new lemma collision is a lexical block. |
| 5 | Stage 2 result PR fails CI or digest binding. | Not merged ⇒ manifests unchanged (`created`); the claim persists and the owner fixes the same PR. No state change is needed because nothing was committed to `master`. |
| 6 | Rejection status PR is open when a Stage 2 agent looks for rework or when Stage 3 is restarted. | The batch is still `ready` on `master`, so it is not rework yet; Stage 2 takes other work. Stage 3 skips it (claim ref / open PR) and, if its own attempt was interrupted, resumes per §6.0. |
| 6a | Stage 3 restarts after opening the admission PR; or preflight fails before any canonical change. | The claim ref and the draft PR identify one attempt; the restart resumes it (no duplicate admission). A preflight failure closes the draft and cites its number in `rejected_pr`. |
| 6b | Owner authorizes retrying an unmerged status-only rejection after its shared defect is fixed. | Run the explicit `--supersede-rejection-pr` recovery after its dry-run. It verifies the exact status manifest and lock, closes only that status PR, and reopens the linked Draft. If the same valid Stage 2 evidence gap remains, reopen the unchanged status PR; otherwise continue the same attempt. |
| 7 | The admission allocator emits colliding ids for several batches. | Systemic: halt, fix allocator, add a regression, resume the unchanged batches (§6.3). |
| 8 | Assignee leaves. | Transfer by comment, keep ref/branch; stale rules in §3.1. |

## 10. Current repository mapping and compatibility decisions

The factory has two candidate contracts: historical v1 usage rows remain
immutable, while new v2 batches group a lemma's forms, observations and usage
groups under one `C…-NNNN` candidate. Stage 3 consumes either version through
the shared review decisions and hand-off.

| Factory concept | Current implementation |
| --- | --- |
| Candidate identity and producer | `scripts/factory/stage1.mjs`; v2 candidates are lemma-centered and carry text-free usage groups and observations. Historical v1 batches stay valid. |
| Stage 2 review contract | `scripts/factory/contract.mjs`, `artifacts.mjs`, `lemma-decisions.mjs`, `handoff.mjs` and `stage2-worker.mjs`; review digests bind candidate, decisions, semantic decisions and hand-off. |
| Stage 3 allocator and writer | `scripts/factory/admission.mjs`; deterministic `w…`/sense IDs, reference remapping, new entries, and append-only new POS/sense support for existing records. Canonical `candidate_id` remains the `w…` record id. |
| Attempt protocol | `scripts/factory/stage3-worker.mjs`, `github-client.mjs` and `run-stage3-worker.mjs`; singleton global lock, atomic per-attempt ref, metadata starter commit, Draft PR before preflight, serial wait, explicit attempt recovery and merge-gated ref release. |
| Complete semantic authority | `scripts/factory/semantic-authority.mjs` extends `canonical-semantic-decision-source.json` only from the source-bound Stage 2 decision digest; its admission ledger binds each canonical and compact semantic-review change. |
| Admission baseline and search/build gates | `scripts/batch/validate-issue-223.mjs`, `canonical-batch-baseline.mjs`, `production-entrypoints.mjs` and the registered Stage 3 CI test. Stage 3-created records remain subject to the complete-canonical audit, baseline and one-build check. |

Resolved compatibility choices:

1. Historical `candidateKey` and corpus-batch behavior are unchanged. New v2
   candidates preserve a lemma's usage groups instead of collapsing them into
   separate candidate identities.
2. Stage 1 routes existing lemmas to explicit new-POS or new-sense decisions;
   Stage 3 appends reviewed senses without changing existing canonical identity.
3. `source_candidate_id` stays in the review admission mapping. Canonical
   `candidate_id` remains the `w…` record id.

## 11. Compliance constraints

- Canonical JSONL stays the source of truth; SQLite is generated; the one-build
  CI invariant and the common complete-revision audit remain. Stage 2 and
  Stage 3 add no batch-only quality gates.
- No raw source paragraphs in Git or shipped outputs. Factory admission does not
  grant publication or redistribution rights (`DATA-LICENSE.md`,
  [`docs/publication-boundary.md`](publication-boundary.md)).
- Subagents, other-model CLIs and account probing are prohibited for authoring and
  QA (AGENTS.md). A "parallel Stage 2 agent" is a separate primary agent session
  assigned by the owner, not a subagent spawned by another.
- Implementation agents do not initiate PR review or merge.
- Worker count is chosen manually by the owner. No agent decides, requests,
  monitors or limits the number of other agents; correctness comes from claim
  exclusivity (§3, §6.0) and must hold identically with one, two or ten Stage 2
  agents. Root [`AGENTS.md`](../AGENTS.md) carries the short role-boundary entry point.

## 12. Stage 3 implementation checks

Issue #266 implements the Stage 3 lifecycle and synthetic fault tests. The
registered suite covers deterministic allocation and relation remapping, new
entry/POS/sense writes, latest-master lexical conflicts, global lock races
across different ready batches, fail-closed claim/open-PR blocking, no fallback
after a claim collision, the actual-number rejection payload, starter removal
before the ready transition, interrupted-attempt recovery, serial merge gating
and merge-gated attempt/global-lock release.

The complete repository checks remain authoritative: one `ci:normal` execution
includes the `ci:fast` checkpoint and validates the shared lexical/semantic
contract, canonical baseline and writer allowlist, complete factory transitions,
reproducible SQLite build, exact direct search and the one-current-revision-build
invariant. Stage 3 does not alter Deep CI.

Owner override for Issue #266 (2026-10-04): validate the real GitHub claim/ref →
starter push → Draft → lexical rejection → status-PR merge lifecycle later in
an actual pilot. This lifecycle validation is **TBD for this implementation
PR**; it was not executed, and no passing integration result is claimed. Do not
replace it with fake or mocked tests. Synthetic tests may cover local behavior,
but they do not establish real GitHub control-plane lifecycle evidence. The
current master queue's empty dry-run result is operational context only.
Recovery is explicitly invoked with `--resume-batch C000001 --attempt 1`; the
worker never adopts an ambiguous live claim based on a login or token identity.

## Related documents

- [`docs/intake-pipeline-issue-249.md`](intake-pipeline-issue-249.md) — source-agnostic intake and hand-off
- [`docs/lexical-quality-pipeline.md`](lexical-quality-pipeline.md) — shared admission pipeline
- [`docs/m9-corpus-production.md`](m9-corpus-production.md) — corpus-backed batches
- [`docs/editorial-model.md`](editorial-model.md) — editorial contract
- [`REVIEW.md`](../REVIEW.md) — PR review gates (distinct from factory stages)
