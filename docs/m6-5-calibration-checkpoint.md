# M6-5 calibration checkpoint

## Decision

**HOLD pending an owner decision on the exact-key/generated-form collision
contract.** No canonical relation, sense, or authored order change is supported
by the M6-4 evidence. The only reproduced finding is a conflict between the
frozen M6-1 v2 exact-key gate and the M6-2/M6-3 generated-candidate contract.

The exact selected-case dispositions and source digests are recorded in
[`data/validation/m6-5-correction-calibration.json`](../data/validation/m6-5-correction-calibration.json).

The M6-4 owner comment moved quality evaluation and correction prioritization
based on actual writer judgments to non-goals. No new writer study or editorial
judgment collection was started for M6-5. The frozen quality dimensions that
require those outcomes remain **NOT MEASURED**, rather than treated as passes.

## Evidence binding

This checkpoint was derived from `origin/master` at
`e04f4e5b3a913b769896cfea1e3b518adfe5b9f8` with canonical revision
`8dad0cd312a7fb8c2073c3aaf8cd2c96e70875a035877e83e9292c6c74d359b9`.
It is a frozen historical checkpoint: it records issue-start results and does
not claim to recalculate them against a later working tree.

| Input | SHA-256 |
| --- | --- |
| [`docs/m6-1-quality-baseline.json`](m6-1-quality-baseline.json) | `4eb83fd3d19c8ff0b522300430e4107f002850907161f2bdcd97ba3872195209` |
| [`docs/m6-4-quality-audit-sample.json`](m6-4-quality-audit-sample.json) | `afe42789a95fb5c06cf77ec36bc7904231d889da772c6348bd25adb8d625e9b8` |
| [`docs/m6-4-quality-audit-report.md`](m6-4-quality-audit-report.md) | `19af2343f2eb4e1b44f565e9c1f60edaaf805782fd9373904c6333ea00d6e5ca` |
| [`data/validation/m6-3-surface-form-review.json`](../data/validation/m6-3-surface-form-review.json) | `380e67ce30af6376906bca75f4c703da565dad59c27e094ec049629e861b5e22` |

The calibration manifest also pins the complete issue-start runtime source set:
the M6-1 baseline validator, SQLite query adapter, shared search response
adapter, exact candidate expansion helper, and M6-3 surface-form projection.
Normal CI validates the manifest's closed shape, full byte digest, and pinned
source identity. It does not compare those historical inputs with current files
or rewrite the frozen decision artifact; a changed manifest byte or identity
fails validation.

## Bounded findings and dispositions

| Finding | Observed result | M6-5 disposition |
| --- | --- | --- |
| Exact key `끈` | Expected `w2969`; runtime returns `w2969` followed by generated `w1081` (`w1081-s1`, `verb-past-adnominal-eun`). | **Held.** M6-3 explicitly reviewed and retained this generated candidate. |
| Exact key `열` | Expected `w110`; runtime returns `w110` followed by generated `w192` (`w192-s1`, `predicate-future-adnominal-eul`). | **Held.** M6-3 explicitly reviewed and retained this generated candidate. |
| M6-4 relation sample | 162 relation tuples; 0 of 324 required independent judgments recorded. | **Held, not rejected or corrected.** Relation correctness, direct substitutability, and noise remain unmeasured. |
| M6-4 relation-gap sample | 80 empty-relation records; 0 of 160 required independent judgments recorded. | **Held.** No density target is applied and no relation is added to fill a gap. |
| M6-4 ranking sample | 40 ambiguous queries; 0 writer-choice outcomes recorded, below the 20-task minimum for a ranking change. | **Held.** No ranking or authored-order change is supported. |
| Writer-task coverage | 0 of 100 planned outcomes from 10 writers are present. | Vocabulary coverage remains unestablished; no expansion is recommended or authorized. |

The two exact-key additions are present in the M6-3 collision manifest with the
reason that the exact candidate keeps precedence while the generated candidate
remains available. The M6-2 contract requires current lemma/search-form results
first, then preserves distinct generated candidates. Existing search tests
exercise the same behavior for `먹었다` and `바라보는`. Suppressing only the
`끈`/`열` generated candidates would contradict those shared rules and make the
collision handling word-specific.

With the current M6-1 v2 evaluator, `npm run baseline:m6-1` fails its fixed
zero-unexpected-results threshold on exactly `끈` and `열`. Treating those
reviewed generated candidates as allowed would change the v2 gate's meaning.
The runtime contract and the frozen gate therefore cannot both be reported as
passing without an owner-approved policy change.

## Relation generation and workload

No relation proposal was generated from the M6-4 sample: its records have no
editorial judgments authorizing proposal work, and the report identifies no
proven relation defect. Consequently proposal, admission, and noise rates for
this calibration set are **not measured**; zero is not presented as a
zero-noise result. Relation lists remain default-empty and no quota is used.

The frozen M6-1 protocol requires 484 independent relation/gap judgments across
242 canonical cases. None were recorded, so actual editor workload is zero and
the required workload remains outstanding. The ranking protocol has 0 of 40
writer-choice outcomes recorded and requires at least 20 before a ranking
change. These are evidence gaps, not inferred editorial decisions.

## Recommendation

Keep the M6-2/M6-3 candidate behavior and, if approved by the owner, define a
versioned successor to M6-1 that checks exact-key reachability separately from
the reviewed generated-candidate set. Keep M6-1 v2 immutable and rerun the
benchmark under the successor before collecting any new quality outcomes.
Until that decision is made, the exact-search dimension remains **HOLD**.

The current evidence does not establish that the 5K corpus meets the 1.0
quality target, does not support relation filling, and does not demonstrate a
vocabulary coverage deficit. No 10K or other lexical expansion is recommended.

## Validation on the issue-start checkout

- `npm run audit:m6-4` — passed frozen sample verification; 242 canonical cases,
  0/484 required independent judgments, and 0/20 minimum ranking tasks.
- `npm run baseline:m6-1` — failed as recorded above on exactly two unexpected
  generated candidates.
- `npm run ci:normal` — passed all canonical, lexical, toolchain, batch,
  product, and artifact categories. M6-3 projection coverage passed for all
  967 eligible senses and 3,264 generated surface forms.
- No browser-only boundary was changed; Chrome for Testing was not run.
