# M5-11A +500 admission report

Issue #97의 M5-11A 실행 결과는 자동 editorial/verification gate를 통과했고,
canonical에 정확히 500개 start를 promotion했다. 이 결과는 최신 owner policy가
허용한 `agent-generated` 경로이며, 사람의 editorial review·timing·independent
audit 완료를 주장하지 않는다.

## Result

| 항목 | 결과 |
| --- | ---: |
| base canonical | 778 starts / 820 records |
| candidate pool | 550 |
| included | 488 |
| corrected | 12 |
| held / rejected | 8 / 7 |
| deferred reserve | 35 |
| processed starts | 515 |
| imported starts | 500 |
| final canonical | 1,278 starts / 1,320 records |

`processed_start_count = included + corrected + held + rejected`이고,
`processed_start_count + deferred = 550`이다. reserve 50개 중 held/rejected 15개는
processed 분모에 들어가고, deferred 35개는 canonical과
processed 분모에 포함되지 않는다. Promotion 시 imported record ID는
candidate-local ID에서 catalog 순서 기준 `w779`~`w1278`로 deterministic rebasing됐다.

최종 canonical 요약은 다음과 같다.

- records: 1,320
- starts: 1,278
- reference-only: 42
- senses: 1,590
- relations: 487
- expressions: 73

## Automated gate

Gate decision은 `APPROVE AUTOMATED BOUNDED`이다. 기존 count/arithmetic gate에
더해 후보 550건 전체의 semantic review를 source-bound로 검증했다. 모든
검수 행에는 sense boundary·POS·expression 분류·per-sense relation 결정과
verification/coverage 기반 selection rank가 있다. verification artifact에도
550개 후보별 finding이 `74ade404bb9b5a10ac31fcc9960bfa0906722d4bb74dfa7ae2ac9f8a0cb93256`
digest로 source-bound 되어 있다. broad gloss connector는
`0`, split record은 `140`, relation candidate는 `14`, expression-unit은
`10`건이며 E/Q/S/C/A/O/X 축 coverage와 8건 이상 expression coverage가 모두
통과했다.

relation quota는 적용하지 않으며, 선택된 6개 relation-bearing 축에는 실제
검증된 relation tuple이 있다. correction rate는 `0.0233009709`, relation
noise rate는 `0`, schema/integrity 및 relation-target blocker도 `0`이다.
Human timing과 external audit는 이 정책에서 필수 항목이 아니므로 durable
evidence에 `not-required`로 기록했다.

검증 pass는 생성 pass와 분리되어 있다.

- generation pass: `m5-11a-generation-20260914`
- verification pass: `m5-11a-verification-20260914`
- generator: `codex`
- generator version: `m5-11a-agent-editorial-v2`
- `human_editorial_review_complete`: `false`

## Source and output binding

Raw proposal, editorial decision, verification, relation diff, and reviewed
import inputs remain outside the repository. Git에는 compact summary와
digest-bound manifest/promotion evidence만 둔다.

| source | SHA-256 |
| --- | --- |
| proposal | `5131dfc9ac17ea0519b8d19a6d3ebfe8c91240931e665265356e4a15459ef0ad` |
| editorial | `e08ff61b5802f252a17ade1085665c1ad54a6197afb43d4dc67f4d620d3c5237` |
| relation diff | `8cafe8b3ad3b2013c43d43ce42dbd32da1cdd62e29e167c30f8c48178bcd74cf` |
| verification | `3ce52a79b081116f4e0f1ad4f68ddacdb9d05e2fe746399953db455b01cd8145` |
| reviewed import | `12d9498adb5bf0eba24574b4253f7b2ac1100a71c2dc109bf03b242a0877d691` |
| #115 authorization | `339779479ed262e8b9330637e6b944424cc3cdf1245c0861364d3ea8006753e3` |
| base inventory | `2d6ec1f03ce4c52bb16509354e501d2e1e10dc684bc068b995b9cead1f4eb947` |

Committed evidence:

- [`data/batches/m5-11-admission.json`](../data/batches/m5-11-admission.json)
- [`data/batches/m5-11-promotion.json`](../data/batches/m5-11-promotion.json)
- [`data/batches/m5-11-review.json`](../data/batches/m5-11-review.json)
- [`data/canonical/m5-11-expansion.jsonl`](../data/canonical/m5-11-expansion.jsonl)

`data/batches/m5-11-promotion.json` records the final canonical directory,
seed, and inventory digests. `npm run batch:m5-11:check` validates these outputs
from a clean checkout without access to the external raw inputs.

## Validation

The issue-specific check is:

```sh
npm run batch:m5-11:check
```

The final PR additionally runs the repository test, canonical/inventory/search
validation, dictionary build, extension build, both packages, and package
validation. Chrome for Testing is not needed for this data/validator-only
change because no browser-only boundary changed.
