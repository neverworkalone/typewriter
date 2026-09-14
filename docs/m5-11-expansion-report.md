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
| included | 500 |
| corrected | 0 |
| held / rejected | 0 / 0 |
| deferred reserve | 50 |
| processed starts | 500 |
| imported starts | 500 |
| final canonical | 1,278 starts / 1,320 records |

`processed_start_count = included + corrected + held + rejected`이고,
`processed_start_count + deferred = 550`이다. `deferred` 50개는 canonical과
processed 분모에 포함되지 않는다. Promotion 시 imported record ID는
candidate-local ID에서 `w779`~`w1278`로 deterministic rebasing됐다.

최종 canonical 요약은 다음과 같다.

- records: 1,320
- starts: 1,278
- reference-only: 42
- senses: 1,466
- relations: 473
- expressions: 63

## Automated gate

Gate decision은 `APPROVE AUTOMATED BOUNDED`이다. candidate pool/count,
reserve arithmetic, canonical/candidate lexical collision, placeholder gloss,
correction rate, relation noise, schema/integrity, relation targets, canonical
integrity, deterministic SQLite, M4 search/product regression, exact net start
increase, cumulative target를 모두 자동 검증했다.

관계 변경은 없으므로 relation diff는 비어 있으며, relation quota를 적용하지
않는다. correction rate와 relation noise rate는 모두 `0`; schema/integrity 및
relation-target blocker도 `0`이다. Human timing과 external audit는 이 정책에서
필수 항목이 아니므로 durable evidence에 `not-required`로 기록했다.

검증 pass는 생성 pass와 분리되어 있다.

- generation pass: `m5-11a-generation-20260913`
- verification pass: `m5-11a-verification-20260913`
- generator: `codex`
- generator version: `m5-11a-agent-editorial-v1`
- `human_editorial_review_complete`: `false`

## Source and output binding

Raw proposal, editorial decision, verification, relation diff, and reviewed
import inputs remain outside the repository. Git에는 compact summary와
digest-bound manifest/promotion evidence만 둔다.

| source | SHA-256 |
| --- | --- |
| proposal | `1d6ae58bfbb8386af45bb485f2c45683b647cd3c237ee8a6efd48c1287276b6c` |
| editorial | `9308c991de24e506f6ee15f7550d9f0d8552470609f1a1894b6c38e1ddc623a0` |
| relation diff | `d64eb4d7864aa46f536b239f7cb20929a2e831f7523113c0ae0787135bca0587` |
| verification | `041a4a15df582bef376559d85ad0cd48dbf367efbe58db674c542f42e9654a47` |
| reviewed import | `e23eb43655c426e3dc79d771f70dcd216ebf48bf28ddb7633127827fb84578fb` |
| #115 authorization | `944d86adad9ad3c340aa57ea88b9ed6cc21a9379e4473edc2cd2213b33ff7d88` |
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
