# M5-6 relation precision and review-cost process

Issue: #88<br>
Scope: process and regression controls only; no canonical import

## Decision

M5-5's seven removed relation events are retained as editorial regression cases,
not as a new gate measurement. The next draft contract is
[`m5-draft-template-v2.md`](m5-draft-template-v2.md): a sense starts with an
empty relation list, has no relation quota, and requires a concrete writer-facing
reason before a human editor considers a candidate.

The regression fixture is linked to the original event ledger by event ID and
tuple. It does not copy a raw draft or external source text.

| M5-5 event | Source sense | Candidate | Human handling | Category |
| --- | --- | --- | --- | --- |
| `event-0001` | `w359-s1` | `w034-s1` / `near` | omit | `broad-common-category` |
| `event-0002` | `w360-s1` | `w171-s1` / `scene` | omit | `arbitrary-modifier-or-place` |
| `event-0003` | `w360-s1` | `w123-s1` / `association` | omit | `incidental-co-occurrence` |
| `event-0004` | `w361-s1` | `w026-s1` / `association` | omit | `sense-target-type-error` |
| `event-0007` | `w374-s1` | `w124-s1` / `scene` | omit | `broad-common-category` |
| `event-0008` | `w381-s1` | `w125-s1` / `mood` | omit | `generic-result-or-reaction` |
| `event-0009` | `w387-s1` | `w126-s1` / `scene` | omit | `arbitrary-modifier-or-place` |

The separate `event-0006` retarget is a correction regression, not one of the
seven removed errors. Its old cross-sensory target must not be admitted; a
retarget is allowed only after human review confirms the corrected target and
the writer-facing sensory evidence. The fixture also keeps this case so all six
known admission failure categories remain covered.

## Review boundary

The admission checklist is intentionally a human decision record. Automated
checks validate shape, IDs, source event binding, and reproducibility; they do
not decide whether a relation is meaningful, generate a replacement, or delete
an edge. A zero-relation sense passes the structural workflow without penalty.

## Measurement workflow

The existing manifest timing IDs remain stable and are interpreted as follows.
When reviewer feedback produces more than one follow-up, each audit/fix pair is
recorded with a one-based cycle number so no later pass replaces an earlier one:

| Work segment | Manifest pass | Requirement |
| --- | --- | --- |
| target preparation | `target-preparation` | Record actual selection and supplementation time. |
| draft/sense/relation review | `initial-review` | Include the full first editorial pass. |
| sense/relation corrections | `feedback-fixes` | Measure edits, not only the moment a decision is written. |
| independent audit | `final-audit` | Start and stop around the independent audit itself. |
| held/rejected decisions | `held-rejected` | Keep excluded targets in the measured denominator. |
| review follow-up audit | `post-review-audit` | Add when feedback arrives after the initial five passes. |
| review follow-up fixes | `post-review-fixes` | Add and measure the actual correction work; never backfill it. |

When a follow-up occurs, `post-review-audit` and `post-review-fixes` are paired
ledger entries with the same `cycle` and `feedback_received_at`. Repeated entries
are keyed in derived metrics as `post-review-audit#2` and
`post-review-fixes#2`. If either entry is unmeasured, the derived artifact remains
`incomplete`, exposes measured wall-clock/editor seconds as a lower bound, and
does not claim a complete total. A follow-up timestamp before the recorded
feedback or a missing cycle pair is invalid. When a pass is later measured, the
existing metrics derivation includes it deterministically. The fixed expansion
gate and its thresholds are unchanged.

The manifest's relation-diff path and SHA-256 digest bind the event ledger to
the metrics run. Derived decision counts, relation counts, timing totals, and
canonical import counts are regenerated from the manifest, relation diff, and
canonical records; hand-edited reported values fail the drift check.

## Canonical boundary

This issue adds no record, start, reference-only row, sense, relation, or
expression. The snapshot remains 432 records, 390 starts, 42 reference-only
records, 514 senses, 442 relations, and 20 expressions. The invariant is also
covered by `tests/relation-admission.test.mjs`.

## Reproducible checks

```sh
npm run batch:admission:check
npm test
```

The full repository validation, deterministic build, package checks, and M4
search regressions remain required before the PR is opened. Chrome for Testing
is not needed for this documentation, fixture, and batch-tooling change.
