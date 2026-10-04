# Typewriter Lexical Production Factory (design specification, issue #257)

**Status: design only.** Nothing in this document is implemented. No dispatch
refs, candidate directories, review directories, schemas or validators described
here exist yet. Section 12 lists what an implementation issue must still verify.
The document records the agreed operating policy so that an implementation agent
can follow it without chat history.

> **Terminology.** *Factory Stage 1/2/3* are production stages. They are **not**
> the Stage 1/2/3 PR reviewer gates of root [`REVIEW.md`](../REVIEW.md), which
> still apply unchanged to every PR the factory opens.

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

- A task targets **10,000 distinguishable lexical candidate occurrences / usage
  possibilities**, not 10,000 unique input strings. A typical batch is about 500
  candidates and is flexible. One issue/task, serial batch PRs. Stage 1 never
  waits for Stage 2 or 3.
- Stage 1 detects (a) lemmas missing from canonical, (b) a new POS for an
  existing lemma, (c) a possible new sense of an existing lemma/POS, and (d)
  uncertain distinguishable uses. It must **not prematurely reject** a possible
  new sense. Repeated usage that is true repetition of the same evidence is
  deduplicated; a distinguishable use is not.
- Stage 1 reuses the existing Kiwi-based corpus extractor to discover headwords
  and POS candidates (the `reference:corpus:candidates` extractor of
  [`docs/m9-corpus-production.md`](m9-corpus-production.md), pinned
  `kiwipiepy==0.24.0`, and the shared intake in `scripts/intake/`). Inflected
  forms are restored to the base form where possible (`observedForms` keeps the
  surface forms). When the morphological analysis is uncertain or admits several
  readings, Stage 1 records that as `holds` (e.g. `analysis_ambiguous`,
  `lemma_mismatch`, `pos_mismatch`) together with the candidate rather than
  guessing. Kiwi output is only a candidate proposal; the final semantic and POS
  judgment belongs to Stage 2.
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

### 2.1 Illustrative candidate manifest (v1)

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

### 2.2 Illustrative candidate record (v1)

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
  sense**. Two candidates for the same lemma/POS have two different ids.
- `usage_hint` is a provisional distinguishing note for Stage 2. It is **not** an
  accepted gloss and must never be copied into canonical data unreviewed.
- `evidence` is bounded, text-free, at most five references (the existing
  `MAX_EVIDENCE_REFERENCES` bound).
- `holds` uses the existing reasons in `HOLD_REASONS`
  (`scripts/intake/candidate-contract.mjs`); a hold is fail-closed information
  for Stage 2, not a Stage 1 rejection of a sense.

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
| 1 | worker | Select batch `C…` from `master` manifests (`created`, or `rejected` rework). | Selection is recomputed each attempt. |
| 2 | worker | Create ref `stage2-claims/C…` pointing at a **claim-record commit** (empty commit on current `master` whose message records `owner`, `claim_seq: 1`, base SHA, and for rework the rejected PR). 422 ⇒ lost; choose another batch. | Re-running after success finds its own ref (owner matches): step 3. |
| 3 | worker | Find or create the issue for the claim. The **ref head commit is the durable ownership record**; the issue is derived history. The issue body begins with the machine marker `stage2-claim: C… seq=N`, and the owner searches that marker before creating (idempotent). | Only the current owner (the one named in the ref head record) may create or adopt the issue; a non-owner never creates one. A crash between steps 2 and 3 is resumed by the owner or taken over via the exclusive transfer below. |
| 4 | worker | Work on branch `stage2/C…` (or `stage2/C…-rN` for rework). | Branch is derived from the claim, so a restart resumes it. |
| 5 | worker | Open the Stage 2 result PR (§5). Issue links the PR. | Existing PR for the branch is reused. |
| 6 | merge | On merge the claim ref is deleted by the merger; the issue is closed with the PR. | Orphan cleanup below. |

**Recovery rules (policy):**

- *Single-owner invariant.* At any instant the owner of a batch is the `owner`
  in the **head commit of `stage2-claims/C…`**. Only that owner creates the
  issue, branch or result PR. An observer that merely sees a claim never creates
  the issue.
- *Exclusive transfer (the only way to adopt a stale or orphan claim).* A worker
  W that finds a claim past the stale threshold (below) takes over by creating a
  new claim-record commit **whose parent is the observed ref head**
  (`claim_seq` + 1, `owner: W`, `previous_owner`, observed head SHA) and updating
  the ref **without force** (`PATCH /git/refs/…` with `force: false`). The update
  succeeds only as a fast-forward from the observed head. Two simultaneous
  adopters build sibling commits on the same parent; GitHub accepts exactly one
  and rejects the other with 422 (non-fast-forward). The loser re-reads the ref,
  sees the new owner and a fresh (non-stale) record, and **defers to another
  batch**. The winner then finds or creates the issue by the marker
  `stage2-claim: C… seq=N`, so even a retry after a crash creates no duplicate.
  This is a compare-and-swap on the ref, not a policy on issue titles.
- *Alternative for non-automatic cases.* If the stale threshold is not
  met, or a PR is open, takeover is not automatic: it is an owner-directed
  transfer, recorded by the same claim-record commit made by or on behalf of the
  owner of the repository.
- *Ref created, issue creation failed:* the owner (by the head record) retries
  step 3. Others wait out the stale threshold, then use the exclusive transfer.
- *Interrupted run:* the replacement uses the exclusive transfer, keeps the same
  branch, and continues. The issue gets a comment with the transfer.
- *Stale claim:* a claim is stale when the ref head, the branch, the PR and the
  issue all show no activity for a threshold set by the owner (to be fixed at
  implementation). A stale claim with an open PR is transferred (never silently
  deleted); the new owner continues that PR.
- *Orphan ref:* a ref whose batch is already `complete` on `master` (or whose
  issue is closed and no PR is open) may be deleted by any worker.
- *Rework claim:* for a `rejected` review batch the ref is `stage2-claims/C…`
  again with `claim_seq` continuing the history; the existing issue is reused
  and extended rather than duplicated. If a prior ref still exists it is the
  claim and only the exclusive transfer can change its owner.
- *Cleanup:* refs are removed after merge of the result PR (success) or on
  abandonment recorded in the issue.

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

- **Attempt claim ref** `stage3-claims/C…-aN`, `N` = the review manifest's
  `attempt` on `master`. Created atomically (422 ⇒ another invocation owns that
  attempt). Its head commit records `owner`, base SHA and the PR number once known.
- **Step 0: the admission PR is opened first, as a draft**, immediately after the
  claim, before preflight. The draft PR number is the attempt's traceable
  identifier and is what `rejected_pr` will always cite — including when preflight
  fails before any canonical change is produced (the draft then carries no
  canonical diff and is closed, not merged). This is why `rejected_pr` is always
  populatable.
- **Selection rule.** Stage 3 skips a `ready` batch if `stage3-claims/C…-aN`
  exists for the current `attempt`, or if any open PR (admission or
  rejection status-only) references that batch.
- **Resume rule on restart** (the same invocation or a new one, resolved *before*
  any fresh admission): (a) open admission PR ⇒ continue it; (b) admission PR
  closed and a rejection status-only PR open ⇒ continue/await that PR, do not
  re-admit; (c) admission PR closed and no rejection PR ⇒ create the rejection
  status-only PR citing it; (d) claim ref but no PR ⇒ the owner re-creates the
  draft PR (looked up first by the branch name `stage3/C…-aN`), then resumes.
  Takeover of a stale Stage 3 claim uses the same non-force CAS as §3.1.
- **Release.** The claim ref is deleted when the admission PR merges
  (`complete`) or when the rejection status-only PR merges (`rejected`; the next
  attempt number gets a new ref).

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
| 2 | Worker creates the ref, crashes before the issue; two other workers later both see the stale issue-less ref. | The ref head record names the crashed owner, so nobody else may create the issue. Both attempt the exclusive transfer (non-force fast-forward from the same observed head); exactly one wins and creates the issue by marker, the other gets 422 and defers. No duplicate issue or work. |
| 3 | Stage 3 opens an admission PR for `C000003`; reviewer finds a gloss/sense defect. | Lexical block: close the admission PR, dispose of its branch, open status-only PR with `rejected`/`rejected_pr`. Stage 3 proceeds to `C000004` without waiting for that PR. While it is open the batch is still `ready`; it joins the queue only after it merges. |
| 4 | A second admission (`C000002`) merges while `C000003`'s PR is in flight. | Stage 3 rebases to latest `master`, reallocates ids, re-runs gates. Pure id/order drift is fixed mechanically; a new lemma collision is a lexical block. |
| 5 | Stage 2 result PR fails CI or digest binding. | Not merged ⇒ manifests unchanged (`created`); the claim persists and the owner fixes the same PR. No state change is needed because nothing was committed to `master`. |
| 6 | Rejection status PR is open when a Stage 2 agent looks for rework or when Stage 3 is restarted. | The batch is still `ready` on `master`, so it is not rework yet; Stage 2 takes other work. Stage 3 skips it (claim ref / open PR) and, if its own attempt was interrupted, resumes per §6.0. |
| 6a | Stage 3 restarts after opening the admission PR; or preflight fails before any canonical change. | The claim ref and the draft PR identify one attempt; the restart resumes it (no duplicate admission). A preflight failure closes the draft and cites its number in `rejected_pr`. |
| 7 | The admission allocator emits colliding ids for several batches. | Systemic: halt, fix allocator, add a regression, resume the unchanged batches (§6.3). |
| 8 | Assignee leaves. | Transfer by comment, keep ref/branch; stale rules in §3.1. |

## 10. Current repository mapping and verified mismatches

Verified against `master` (3a7c452) rather than assumed.

| Factory concept | Current repository state |
| --- | --- |
| Candidate contract | `scripts/intake/candidate-contract.mjs`, v1: fields `input`, `pos`, `observedForms`, `evidence` (≤5), `holds`, `key`. No `candidate_id`, no `usage_hint`. |
| Identity | `candidateKey({input,pos}) = input + "\0" + (pos ?? "")`. |
| De-duplication | `dedupeCandidates` **merges everything with the same key**, unioning forms/evidence/adapters. |
| Coverage | `scripts/intake/pipeline.mjs`: `runIntake({coveredLemmas})` treats **exact lemma** membership as `covered` (decision `covered`, never analyzed or handed off). |
| Hand-off | `production-handoff.mjs` writes one text-free `*-intake-handoff.json` per batch; entries keyed by `candidateKey`. Mandatory from corpus batch 16 (`INTAKE_HANDOFF_FIRST_BATCH`). |
| Batch builder | `scripts/batch/build-issue-223-corpus-batch.mjs` is the only declared canonical writer (`production-entrypoints.mjs`); ids are `issue-223-m9-e-corpus-batch-NN-YYYYMMDD`; internal review-row ids `${batchId}-candidate-NNNN`; canonical ids `w` + next number. |
| Tracked batch artifacts | `data/batches/<batch>-candidate-review.json`, `-semantic-decisions.json` (`lexical-semantic-decision-source-v4`), `-semantic-review-input.json`, plus `data/canonical/<batch>.jsonl`. |
| Canonical gate | `data/validation/canonical-non-batch-baseline.json` + `CANONICAL_RECORD_OUTSIDE_REVIEWED_BATCH` in `validate-issue-223.mjs`; entrypoint tripwire test. |
| Canonical `candidate_id` | Present on canonical entries and equals the entry `id` (`w12144`). Uniqueness enforced in `scripts/validate/canonical-context.mjs`. |

### 10.1 Collisions the implementation must design around

1. **`candidateKey` collapses distinct usages.** Two candidates with the same
   `input` and `pos` but different usages share a key and `dedupeCandidates`
   merges them into one. The factory treats them as separate identities
   (`C…-0001`, `C…-0002`). A safe route is needed: either an adapter that keeps
   `candidate_id` as the unit and uses `candidateKey` only to look up shared
   analysis, or a new factory identity layered on top. The shared contract must
   not be silently changed for B05–B16 history.
2. **Exact-lemma coverage hides new POS and new senses.** A candidate whose lemma
   is already canonical becomes `covered` and is dropped. The factory needs the
   opposite for "new POS on an existing lemma" and "new sense of an existing
   lemma/POS". Coverage must become POS/sense-aware for factory candidates (the
   key `lemma+POS`, then a sense-level decision made in Stage 2) without turning
   genuine duplicates into admissions.
3. **`C…` vs `w…` vs `candidate_id`.** Three id spaces exist: factory
   `C000001-0001`, canonical `w…` ids and the canonical `candidate_id` field.
   They must stay separate (§7.4).

A **third open point**: the current canonical import expresses new *entries*
(`record_type: "entry"`, one lemma per record). Whether the existing import,
validators and build can add a sense (or POS) to an already-canonical entry
without rewriting or breaking baseline/digest gates is unverified.

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

## 12. Verification still needed and implementation test plan

This is the input to a **later implementation issue**; none of it is done here.

**Open compatibility checks**

1. Can `buildIssue223CorpusBatch` / `lexical-production` consume factory
   candidates (`candidate_id`-keyed) without the `candidateKey` merge, and how
   are its fixed `issue-223-m9-e-corpus-batch-NN-DATE` ids replaced by `C…` batch
   ids? Adapter boundary or generalized contract?
2. How does a `new_sense_on_existing_entry` / `new_pos_on_existing_lemma`
   disposition appear in the canonical import, in `canonical-batch-baseline`,
   in `validateLexicalAddition`, and in the build?
3. Which existing tracked artifacts become `data/reviews/C…/` files and which
   stay under `data/batches/`; the digest and baseline gates that key on file
   names must be re-examined.
4. Where `source_candidate_id` lives in canonical or in a side ledger without
   reusing `candidate_id`; effect on the build's metadata and search output.
5. Atomic ref creation and stale-claim thresholds via the GitHub API from the
   agents' actual tooling.
6. How `production-entrypoints.mjs` and the non-batch baseline account for a
   Stage 3 writer.

**Test and validation plan (implementation issue)**

- Identity regression: two same-lemma/POS different-usage candidates stay two
  decisions, and a candidate for a new sense of an already-canonical lemma is not
  dropped as `covered` but routed to Stage 2 and admitted only with a sense-level
  decision.
- Manifest state-machine validator: all legal transitions in §7 pass; every
  other (`created→ready`, `complete→rejected`, `rejected` without `rejected_pr`,
  digest drift in immutable files, status mutation changing a content digest)
  fails.
- Claim protocol with a fake GitHub: concurrent creation (exactly one winner);
  **race/fault injection with one orphan ref and two simultaneous adopters:
  exactly one proceeds, the other defers, one issue, no duplicate work**;
  ref-without-issue recovery; stale and orphan handling; rework reuse.
- Stage 3 in-flight guard with fault injection: restart after the admission PR
  is opened; restart while the rejection status-only PR is pending; failure at
  preflight before any canonical change. Each yields exactly one traceable
  attempt, no duplicate admission, and a populated `rejected_pr`.
- Stage 2 equivalence: a fixture batch produced through the factory yields the
  same canonical records and validator results as the current builder.
- Stage 3: success path; stale-master id reassignment; lexical conflict →
  `rejected` with `rejected_pr`; allocator collision → halt, not rejection.
- Coverage: no dropped or phantom candidate between candidates → decisions →
  canonical; `ci:fast` / `ci:normal` stay green with one complete-revision
  context; the entrypoint tripwire accepts only the declared writers.

## Related documents

- [`docs/intake-pipeline-issue-249.md`](intake-pipeline-issue-249.md) — source-agnostic intake and hand-off
- [`docs/lexical-quality-pipeline.md`](lexical-quality-pipeline.md) — shared admission pipeline
- [`docs/m9-corpus-production.md`](m9-corpus-production.md) — corpus-backed batches
- [`docs/editorial-model.md`](editorial-model.md) — editorial contract
- [`REVIEW.md`](../REVIEW.md) — PR review gates (distinct from factory stages)
