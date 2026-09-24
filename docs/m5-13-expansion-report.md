# M5-13 +1,000 expansion report

Issue #99 completed the source-bound, agent-authored expansion from the passed
M5-12A base. This report records the final promoted outcome; the earlier
capacity-only HOLD was a pre-admission checkpoint and is retained in
[`m5-12-stage.json`](../data/batches/m5-12-stage.json).

## Fixed scope

| 항목 | 값 |
| --- | ---: |
| base canonical records | 2,042 |
| base canonical starts | 2,000 |
| target net start increase | 1,000 |
| cumulative start target | 3,000 |
| selection capacity | 1,100 |
| declared reserve | 100 |
| candidate identities | 1,100 |
| semantic decisions included | 1,054 |
| semantic decisions held | 46 |
| corrected / rejected / deferred decisions | 0 / 0 / 0 |
| selected from included decisions | 1,000 |
| eligible reserve retained by selector | 54 |
| imported starts | 1,000 |
| final canonical records / starts | 3,042 / 3,000 |
| final senses / relations / expression records | 3,301 / 487 / 309 |

The 1,100 identities and their authored candidate records are source-bound.
The semantic decision source records 1,054 included and 46 held. The shared
selector promoted 1,000 eligible starts and retained 54 eligible identities as
reserve. Those 54 remain semantic `included` outcomes in this stage's source;
they are not rewritten as manifest `deferred` decisions. No candidate was
counted twice to meet the target.

## Gate result

The final gate passed as `APPROVE AUTOMATED BOUNDED`. All 1,100 identities
received a bound semantic decision; 1,000 starts were imported, bringing
canonical to exactly 3,000 starts. The stage reports zero corrected, rejected,
or deferred dispositions, plus 46 held. The 54 eligible reserve identities
remain a selector reserve as described above.

The promotion added no relation tuples: the relation count remained 487.
Source policy records Typewriter-authored candidate identities and
decision-bound candidate bodies; raw external material was not adopted.
Generation and semantic verification use separate pass IDs. Human editorial
time is not required by this automated gate and is not represented as zero.

## Provenance

- predecessor: [M5-12A admission](../data/batches/m5-12a-admission.json),
  SHA-256 `33639ee2e0240703d0882fea6219d87ea0d912bc8453969e05e103faa780bba7`,
  gate `pass`, exact base `2,042 records / 2,000 starts`;
- retained base canonical digest:
  `690592c89c578096fc65585f24489f1095fc16d495cc02dee4da94de057d38df`;
- retained base inventory digest:
  `0d3058ecd005189ceb5f413d9e2422269d861af39ee7de00ddbb12abdbe95a66`;
- candidate identities: `scripts/batch/m5-13-candidate-source.mjs`,
  1,100 identities, SHA-256
  `2d4fdee385604a7b24a4adc1399cbd00dd1a0e6e3d23077dd71abce573b2bf`;
- semantic decisions: `data/batches/m5-13-semantic-decisions.json`,
  source `m5-13-authored-semantic-decisions-20260923-r6`, SHA-256
  `b3e238b8715c46ed813e4faacac442ad66333b206c245c202d72a00c08ad5bf1`;
- admission: [`m5-13-admission.json`](../data/batches/m5-13-admission.json),
  SHA-256 `ae131f70eea91fb8f4361773c25c15c7f589343d60b5539be72ed70c8e91c7a2`;
- stage: [`m5-13-stage.json`](../data/batches/m5-13-stage.json),
  SHA-256 `b5ea73989f2e3f08b69343c95203d1151f304bd3f62b0484973e3a528851a549`;
- predecessor checkpoint: M5-12A merge commit
  `a5d794a4e57070ad81285eb97ad0e0c68c9e1d3c`.

## Reproduction and validation

```sh
npm run batch:m5-13:check
npm run batch:m5-13:check-final
```
