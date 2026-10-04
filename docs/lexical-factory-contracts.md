# Lexical factory shared contracts (issue #263, Impl 1/4)

Implements the shared foundation of [`lexical-production-factory.md`](lexical-production-factory.md).
It is a library plus a repository validator; it creates no batches, claims or agents.

| Module | Role |
| --- | --- |
| `scripts/factory/contract.mjs` | `data/candidates/C…` and `data/reviews/C…` manifests, `candidates.jsonl` rows, per-usage `C…-NNNN` ids, digests, decision-row coverage |
| `scripts/factory/transitions.mjs` | Both state machines and the linked Stage 2 / Stage 3 transitions on manifests of merged `master` vs. a merge result |
| `scripts/factory/identity-adapter.mjs` | Keeps one decision per `C…` id on top of the legacy `input+POS` intake; routes to `new_entry`, `new_pos_on_existing_lemma`, `new_sense_on_existing_entry` |
| `scripts/factory/handoff.mjs` | Typed decision rows and canonical-compatibility checks; writer-support partition |
| `scripts/factory/validate.mjs` | Repository validator (`ci:fast`); `FACTORY_BASE_REF=<ref>` also checks transitions against that ref |

## Adjustments to the design's illustrative shapes

- Review manifest adds `history` (`[{attempt, rejected_pr}]`, one entry per rejected attempt). `rejected_pr` is valid only while `status` is `rejected` and equals the last history entry; rework (`rejected → ready`) advances `attempt` by one and may not alter history.
- Candidate manifest adds `analyzer_version` (pinned `kiwipiepy==X.Y.Z`). Candidate rows require `usage_hint`; evidence is text-free (`kind`, `ref`) and capped at five.
- `status`, `rejected_pr`, `attempt`, `history` are the only mutable manifest fields and are excluded from `manifestContentDigest`; `candidates.jsonl` and review artifacts are covered by separate byte digests, so a status-only change never changes them.
- Candidate transitions: `created → complete` only together with a new `ready` review in the same change; `rejected → ready` (rework) and Stage 3's `ready → complete|rejected` leave the candidate manifest unchanged.

## Compatibility findings (design §10, §12)

- `candidateKey(input+POS)` / `dedupeCandidates` / `coveredLemmas` are **unchanged** (B05–B16 history). The adapter feeds the legacy intake one representative per input+POS only to share Kiwi analysis, never passes `coveredLemmas`, and fans results back to every `C…` id, so same-lemma/POS usages stay separate and already-canonical lemmas reach review instead of `covered`.
- The current canonical writer only creates new `entry` records. `new_pos_on_existing_lemma` and `new_sense_on_existing_entry` are valid Stage 2 decisions, but **cannot be written today**; `partitionByWriterSupport` marks them `stage3-writer-required`. Stage 3 (#266) must supply the compatible writer behind the entrypoint tripwire and non-batch baseline.
- `source_candidate_id` (`C…`) is never stored in the canonical `candidate_id` field; where it is persisted in canonical output is deferred to #266.
