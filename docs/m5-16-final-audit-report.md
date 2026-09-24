# M5-16 final 5K audit and M6 handoff

## Decision

The final M5 canonical snapshot reaches exactly 5,000 search-start records. The
latest expansion, M5-15 / issue #101, passed its source-bound automated bounded
gate and was merged in PR #161. This audit finds no open editorial blocker in
the retained semantic-audit evidence or the focused writer-facing benchmark.
The recommendation is to close M5 after this report is accepted and hand the
5K snapshot to M6 planning. This does not authorize a new batch size or begin
M6 implementation.

The exact #101 PR head was `67e40b496124dc5e10d749c49e100a23638b40ad`;
the merge commit on `master` is
`9627f88f7bfeff8fafe2a8d39f07e3b716afbe51`. The final inventory and
canonical state described here are from that merged state.

## Final counts

| Measure | Final count | Counting rule |
| --- | ---: | --- |
| Canonical records | 5,042 | All record types and roles |
| Search starts | 5,000 | Canonical records with role `start`; entries and expressions both count |
| Reference-only records | 42 | Relation targets; excluded from start count |
| Senses | 5,301 | All canonical senses |
| Directed relations | 487 | Sense-bound tuples; no quota was used |
| Expression records | 1,154 | Subset of the 5,000 starts, not an additional start count |

M5 begins from the M4 base of 300 starts and adds 4,700. The stage sequence
reconciles to 5,000: 352 after M5-3, 390 after M5-5, 428 after M5-7, 528 after
M5-9, 578 after M5-9A, 628 after M5-10A2, 778 after Wave B, 1,278 after
M5-11, then 2,000, 3,000, 4,000, and 5,000 after M5-12A through M5-15.

Expression records are included in each stage's start count. The record, sense,
relation, and expression measures are separate dimensions and must not be
summed together.

## Stage decisions, quality, and cost

Decision columns are `included / corrected / held / rejected / deferred`.
Correction rates use the stage's documented processed-start denominator;
deferred rows are excluded where the admission contract says so. A reserve is
reported separately when the selector retains eligible candidates without
calling them deferred.

| Stage | Start delta (cumulative) | Candidate / processed | Decisions I/C/H/R/D | Correction rate | Relation noise | Editor time | Final gate |
| --- | ---: | ---: | --- | ---: | --- | --- | --- |
| M5-3 calibration | +52 (352) | 60 / 60 | 11 / 41 / 4 / 4 / 0 | 41/60 = 68.33% | 51/139 pre-existing relation events removed during baseline audit; this is not a candidate-noise rate | Not measured; 603s is a partial wall-clock window | HOLD PROCESS |
| M5-5 recalibration | +38 (390) | 40 / 40 | 27 / 11 / 1 / 1 / 0 | 11/40 = 27.50% | 7/20 = 35% | 643s recorded; follow-up fix pass unmeasured | HOLD PROCESS |
| M5-7 recalibration | +38 (428) | 40 / 40 | 23 / 15 / 1 / 1 / 0 | 15/40 = 37.50% | 3/10 = 30% | 782s complete; 19.55s/processed start | HOLD PROCESS |
| M5-9 expansion | +100 (528) | 112 / 107 | 82 / 18 / 4 / 3 / 5 | 18/107 = 16.82% | 12/25 = 48% | At least 1,090s; later review passes unmeasured | HOLD PROCESS |
| M5-9A Wave A | +50 (578) | 58 / 56 | 28 / 22 / 3 / 3 / 2 | 22/56 = 39.29% | 3/8 = 37.50% | 2,251.026s complete; 40.20s/processed start | HOLD PROCESS |
| M5-10A Wave A2 | +50 (628) | 58 / 56 | 34 / 16 / 3 / 3 / 2 | 16/56 = 28.57% | 0/6 = 0% | 649.344s complete; 11.60s/processed start | APPROVE BOUNDED |
| M5-10 Wave B | +150 (778) | 170 / 160 | 144 / 6 / 10 / 0 / 10 | 6/160 = 3.75% | No relation candidate; rate N/A | 10.15s producer time; editor time unmeasured | Initially HOLD PROCESS; process recovery recorded at M5-10D |
| M5-11 expansion | +500 (1,278) | 550 / 515 | 488 / 12 / 8 / 7 / 35 | 12/515 = 2.33% | 0/14 = 0% | Agent-generated gate: human editor time not required, not zero | APPROVE AUTOMATED BOUNDED |
| M5-12 pre-admission | +0 (1,278) | 802 slots / 0 identities | 0 / 0 / 0 / 0 / 0; 802 slots unresolved | N/A | N/A | No editorial timing; no candidate identities | HOLD PROCESS; no mutation |
| M5-12A expansion | +722 (2,000) | 802 identities / 772 processed | 722 / 0 / 30 / 20 / 30 | 0/772 = 0% | No tuple added; N/A | Agent-generated gate: human editor time not required, not zero | APPROVE AUTOMATED BOUNDED |
| M5-13 expansion | +1,000 (3,000) | 1,100 / 1,100 | 1,054 / 0 / 46 / 0 / 0 | 0/1,100 = 0% | No tuple added; relation count remains 487 | Agent-generated gate: human editor time not required, not zero | APPROVE AUTOMATED BOUNDED |
| M5-14 expansion | +1,000 (4,000) | 1,100 identities / 1,000 processed | 1,000 / 0 / 0 / 0 / 100 | 0/1,000 = 0% | No tuple added; relation count remains 487 | Agent-generated gate: human editor time not required, not zero | APPROVE AUTOMATED BOUNDED |
| M5-15 expansion | +1,000 (5,000) | 1,100 identities / 1,000 processed | 1,000 / 0 / 0 / 0 / 100 | 0/1,000 = 0% | No tuple added; relation count remains 487 | Agent-generated gate: human editor time not required, not zero | APPROVE AUTOMATED BOUNDED |

For M5-13, 1,054 candidate decisions were semantically included and 46 were
held. The selector imported 1,000 eligible starts; the other 54 eligible
decisions remained reserve. M5-13 records no manifest-deferred decisions.
M5-14 and M5-15 record 100 deferred capacity decisions each. In all three
stages, source-decision totals and selected/imported counts are different
boundaries.

Summed across the 12 start-expansion cohorts, the retained decision fields
contain 141 corrected, 110 held, 42 rejected, and 284 deferred outcomes. The
arithmetic correction aggregate is 141/4,906 = 2.87%. This mixes calibration
and production gates with different review policies, so per-stage rates above
remain the meaningful gate evidence; the aggregate is descriptive only.
M5-13's 54 eligible reserve identities are not included in the deferred total.

The sum of available measured editor-time components is 6,199.055 seconds.
This is a partial lower bound, not the total cost of M5: M5-3 only has a
partial wall-clock window; M5-5 and M5-9 have unmeasured follow-up work; Wave B
records producer throughput rather than editor time; and M5-11 through M5-15
use an explicitly authorized automated gate with human timing marked
`not-required`.

Three M5-10 repair calibrations did not change canonical data. M5-10A reviewed
20 cases, independently accepted all 9 generated relation proposals, recorded
0 corrections and 0/9 noise, and measured 66.211 editor seconds. M5-10C
reviewed 20 cases (11 included, 5 corrected, 4 held), measured 529.741 editor
seconds, and found 1 noise event among 8 relation proposals; its recovery gate
held. M5-10D reviewed 20 cases (20 included, 0 corrected), measured 187.733
editor seconds, and found 2 noise events among 9 proposals. Its independent
audit had zero open blockers and the recovery gate passed, authorizing M5-11.
These calibration decisions are not added to the start-expansion totals.

Noise rates have distinct stage-specific candidate denominators and must not be
collapsed into one M5 rate. M5-3's 51 removals are an audit of an existing
relation snapshot, while the later figures count proposed relation tuples.
From M5-12A through M5-15, no relation tuple was admitted.

## Provenance and digest chain

The audit checked stage-to-stage predecessor references, source paths, and
SHA-256 bindings in the committed stage/admission artifacts. The final
authority artifacts are:

| Stage | Authority artifact | SHA-256 |
| --- | --- | --- |
| M5-3 | `data/batches/m5-3-calibration.json` | `24a829940621e5aafd9d72e272a61b3e36233f99446399e9dd856fe433810253` |
| M5-5 | `data/batches/m5-5-recalibration.json` | `1c49096d4e7b6a20279b2ac98b3787e7a66ad6a9a32be26e49f98607c0eec726` |
| M5-7 | `data/batches/m5-7-recalibration.json` | `b58317f22cb18a79f5fdc05108ed158cff8f2aa0fa9d44e3f81fa8c6deaa2b3d` |
| M5-9 | `data/batches/m5-8-stage-01-plus-100.json` | `1b82e3efb6986ede8b2fb1490c57ec136b18bbad2647ed44154f668d2e8622e7` |
| M5-9A | `data/batches/m5-9a-wave-a-plus-50.json` | `7fbaa5df9c402f184e2e28be39ef54787de51fcf2dd1c1c17708ebc14da82b90` |
| M5-10A2 | `data/batches/m5-10a-wave-a2.json` | `c3a43787e8d36760a4caf90ac36e61b25c3973efdedd2b70fe5878d9ac7021f2` |
| M5-10 Wave B | `data/batches/m5-10-wave-b-stage.json` | `e132414cbd0d18f8096ea8009e8bdd1d7f41b621b396990b8e53a1c505dae4bf` |
| M5-10C recovery | `data/batches/m5-10c-recovery.json` | `7722b6c1196060976a0e6a169f3dad03c0d1437de4be0b5e3771c5055fe371cc` |
| M5-10D recovery | `data/batches/m5-10d-recovery.json` | `d9c6a5d2063f6cdd68e757fe57ffcc3dd55473ac09f6730f4872789f074c4a99` |
| M5-11 | `data/batches/m5-11-admission.json` | `330a1d453f01d1116a8f9fd305364b6bff154ec38c8300413753c8fb58406a6c` |
| M5-12 pre-admission | `data/batches/m5-12-stage.json` | `2bfa5d5db58b3c2af5268346f108031d7ac9e4bcc451d1fb6ddd456f0807ecc0` |
| M5-12A | `data/batches/m5-12a-admission.json` | `33639ee2e0240703d0882fea6219d87ea0d912bc8453969e05e103faa780bba7` |
| M5-13 | `data/batches/m5-13-admission.json` | `ae131f70eea91fb8f4361773c25c15c7f589343d60b5539be72ed70c8e91c7a2` |
| M5-14 | `data/batches/m5-14-admission.json` | `3c8de414434fe7bd570ae1acd1e75cc026f1720c6f4bdde80c7983874eb2debd` |
| M5-15 | `data/batches/m5-15-admission.json` | `80eb475720b65f425587635cb3e00fa07f4e1d609ea2c5e18a3604f8d92dd0ff` |

For M5-13, M5-14, and M5-15, the candidate identity and semantic-decision
sources are separately bound in the admission manifests. Their candidate
identity sources are Typewriter-authored; generation and verification pass
IDs are distinct; semantic audit covers every current record and sense. The
M5-15 admission binds semantic-audit SHA-256
`4a7ba8f0086313cb03f7b8e915bdf7807837e05490fd48dc0671845893360f7c`.

## Representative editorial benchmark

Focused reading of nine canonical cases found zero open blockers. Sense and
relation targets below are explicit; relation type and direction are preserved.

| Check | Canonical evidence | Result |
| --- | --- | --- |
| POS and homonymous senses | `고소하다`: two adjective senses for toasted flavor and malicious delight, plus a verb sense for filing a complaint | POS and sense boundaries remain distinct |
| Polysemy | `갈림길`: a physical fork in a road vs. a decision point | Both senses remain in one searchable record |
| Direct replacement | `감추다` (`w1073-s1`, verb) → `숨기다` (`w190-s1`, verb) | Matching concealment sense; direct is defensible |
| Near relation | `붙잡다` (`w215-s1`) → `잡다` (`w194-s1`) | Close but narrower overlap remains `near` |
| Mood | `빈방` (`w152-s1`) → `외로움` (`w007-s1`) | Tonal association is labeled `mood`, not direct |
| Scene | `창문` (`w172-s1`) → `창가` (`w147-s1`) | A nearby place is labeled `scene` |
| Sensory | `듣다` (`w201-s1`) → `소리` (`w086-s1`) | Perception and sound are connected as `sensory` |
| Action | `열쇠` (`w178-s1`) → `열다` (`w192-s1`) | An associated action is labeled `action` |
| Association and direction | `건네다` (`w196-s1`) → `받다` (`w197-s1`) | Transfer/receipt association keeps its authored direction |

This is a focused sample, not a claim that every canonical row received a new
human review in M5-16. Full current-canonical semantic coverage and the
zero-blocker count come from the bound M5-15 gate evidence and global
semantic-audit path.

## Source policy, integrity, and product boundary

- Canonical JSONL remains the data source of truth; SQLite and extension
  packages are reproducible outputs.
- The final agent-authored stages state that raw external material was not
  adopted. Earlier stages preserve decision/evidence digests and reviewed
  snapshots rather than raw third-party responses or unreviewed draft prose.
- The repository artifact policy rejects unregistered durable evidence and
  prohibited derived/raw projections. The clean artifact-policy check and
  package validation are part of the validation below.
- Package validation derives corpus-count expectations from the canonical JSONL
  used for that package build. This also supports historical staged preflight
  packages whose input is a temporary prospective canonical directory.
- The final semantic audit covers all current records and senses; the fixed
  M5-15 decision source, inventory promotion ledger, and canonical totals agree
  at the 5K boundary.
- No change was made to canonical data, inventory decisions, or generated
  SQLite. This issue corrects two stale reports, aligns package metadata
  validation to its canonical build input, and adds this audit/handoff.

## M4 acceptance and parent #7 cross-check

| Parent #7 acceptance | Evidence in this audit |
| --- | --- |
| Exactly 5K reviewed search starts, with separate counts | Final counts table and M5-15 admission |
| Inventory and all batch decisions traceable | Stage decision table and digest chain |
| No raw external material or unreviewed drafts in product | Artifact-policy clean check and regular/minified package validation |
| Direct accuracy, honest relation type, and writer usefulness assessed | Nine-case focused editorial benchmark; M5 relation-noise table |
| Canonical integrity and deterministic SQLite | Normal CI, canonical/build validation, and reproducibility validation |
| Existing M4 search and package behavior retained | Search regression corpus, homonym, keyboard, failure-state, and package checks |
| Stop after failed quality/cost gate; repair process first | HOLD checkpoints retained; M5-10D recovery precedes M5-11; no HOLD is carried by M5-15 |
| Basis for M6 or more repair retained | Recommendation above; incomplete editor-time rollup is disclosed |

M4 acceptance remains deliberately conservative: exact lemma/search forms,
NFC and surrounding-space normalization, no general morphology, sense-level
homonym selection, keyboard navigation, and distinct no-data, unsupported,
editorial-gap, relation-target, and runtime-failure states.

## M6 handoff

The accepted M5 outcome is a 5K canonical dictionary with complete current
semantic-audit coverage and no open blockers in the sampled writer-facing
checks. M6 planning can start from the exact M5-15 revision after this report
is accepted. Keep the existing relation and source policies, preserve the
shared audit/selector path, and measure any new human editorial workload that
M6 introduces. This is a handoff recommendation only; M6 implementation,
additional expansion, 10K work, and the deferred 4GB corpus index remain
outside issue #102.

## Validation

Validation on the final audit checkout:

- `npm run ci:normal` passed. The canonical audit reports 5,042 records,
  5,000 starts, complete semantic coverage, and zero lexical blocking findings;
  artifact policy reports a clean working tree and no unclassified artifacts.
- `npm run ci:category -- historical` passed, including the replayable M5-10A2
  and Wave B stage checks.
- `node --test tests/reproducibility.test.mjs` passed (4/4).
- `npm run batch:m5-15:check-final` passed at the 5K boundary with 5,301 senses,
  487 relations, complete audit coverage, and canonical digest
  `8dad0cd312a7fb8c2073c3aaf8cd2c96e70875a035877e83e9292c6c74d359b9`.
- `npm run package` and `npm run package:minify` passed. Each ZIP contains 23
  files and validates against the 5,042-record, 5,301-sense, 487-relation
  dictionary metadata.
- `git diff --check` passed. No Chrome for Testing run was needed: this audit
  changes reports and package validation, while deterministic search, product,
  build, and package checks cover those contracts.

Historical replay limitation: `batch:m5-13:check-final` and
`batch:m5-14:check-final` currently compare the live canonical tree to their
stage-time 3,000- and 4,000-start summaries, so they fail when run against the
later 5K tree. The M5-12 pre-admission checker similarly expects inventory
revision `m5-11`, while the active revision is `m5-15`; the M5-12A replay
reconstructs its old 2K seed from the current M5-15 seed and ends with
`FINAL_DIGEST_MISMATCH`. These are historical checkers bound to their original
stage snapshots, not the current 5K gate. Their source and admission digests
remain recorded above; the current M5-15 final check, historical CI category,
and clean-checkout normal CI pass. Replaying every intermediate final gate from
the latest checkout remains unsupported.
