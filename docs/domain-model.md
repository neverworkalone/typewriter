# Typewriter domain model

M3-3의 domain layer는 SQLite query 결과와 화면 사이의 의미 변환을 담당한다.
Vue component나 Figma markup에 의존하지 않으므로 popup과 options preview가 같은
projection을 재사용할 수 있다.

## Projection

[`src/domain/projection.js`](../src/domain/projection.js)의
`projectSense()`는 source sense 단위의 `gloss`와 relation을 보존한다. relation은
다음 순서와 그룹으로만 표시용 분류를 얻는다.

| Canonical type | UI group | Label |
| --- | --- | --- |
| `gloss` | `definition` | 뜻풀이 |
| `direct` | `synonyms` | 유의어 |
| `antonym` | `antonyms` | 반의어 |
| `near`, `mood` | `texture` | 말의 결 |
| `scene`, `sensory`, `action`, `association` | `association` | 연상 |

`canonicalType`, `targetSenseId`, `sourcePosition`, `targetId`, `note`는 각
projected relation에 남는다. 따라서 UI group은 표시 위치일 뿐 relation 의미를
바꾸지 않는다. relation이 없는 sense는 `definition` group만 가지며, 비어 있는
relation group은 생성하지 않는다. `projectSearchResults()`는 입력 배열을
정렬하거나 ranking하지 않고 query adapter가 반환한 SQLite/ID 순서를 그대로
보존한다.

`reference-only` target은 검색 결과 projection에서 출발어로 승격되지 않는다.
관계 항목의 `action.type = "open-relation-target"`와 target ID를 사용해 별도의
ID 탐색을 시작할 수 있다.

## Search state

`SearchSession`은 runtime adapter를 주입받는 UI-independent service다.

- `searchExact(term)`는 `runtime.search()` 후 각 record를 ID로 읽어 exact 검색
  결과를 만든다.
- `openRelationTarget(target)`는 `runtime.getRecord(targetId)`만 호출한다.
  자유 입력 exact search와 관계 target 탐색은 서로 다른 `mode`와 `action`이다.
- `back()`과 `forward()`는 이미 읽은 snapshot을 복원하며 새 DB query를 만들지
  않는다. 진행 중인 요청은 먼저 취소하고 history에 loading snapshot을 남기지
  않는다.
- `searchExact()` 또는 `openRelationTarget()`을 back 이후 실행하면 forward
  history branch를 버리고 새 항목을 추가한다.

상태의 `status`는 다음 다섯 값 중 하나다.

| Status | Meaning |
| --- | --- |
| `idle` | 아직 검색하지 않음 |
| `loading` | 현재 exact 또는 relation target을 읽는 중 |
| `ready` | 하나 이상의 projected record가 있음 |
| `empty` | exact match 또는 relation target이 없음 |
| `error` | `error.kind`가 `load` 또는 `query`인 실패 |

각 요청의 이전 결과가 늦게 도착해도 request token이 현재 요청과 다르면 상태를
덮어쓰지 않는다. 이 레이어는 ranking, fuzzy/prefix search, morphology, relation
자동 수정, user storage를 구현하지 않는다.
