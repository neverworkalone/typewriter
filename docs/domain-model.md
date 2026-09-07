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
보존한다. 검색 후보에 `match` provenance가 있으면 record projection에도
그대로 전달한다.

검색 후보의 tier ranking은 runtime query contract에서 끝난다. projection은
이미 결정된 record 순서를 소비할 뿐이며, 한 record 내부의 sense/relation
source order나 canonical relation type을 재분류하지 않는다. 우선순위와 동점
규칙은 [`docs/search-candidates.md`](search-candidates.md)에 고정한다.

`reference-only` target은 검색 결과 projection에서 출발어로 승격되지 않는다.
관계 항목의 `action.type = "open-relation-target"`와 target ID를 사용해 별도의
ID 탐색을 시작할 수 있다. relation에 `target_sense`가 있으면 해당 sense도
함께 전달되어 다의어 target에서 지정된 뜻만 표시한다.

## Search state

`SearchSession`은 runtime adapter를 주입받는 UI-independent service다.

- `searchExact(term)`는 `runtime.search()`의 구조화된 응답을 보존한 뒤 각
  candidate record를 ID로 읽어 exact 검색 결과를 만든다. 상태의 `queryMeta`에는
  raw query, normalized query, 적용 규칙, no-match/unsupported reason, match
  provenance가 남는다.
- `openRelationTarget(target)`는 `runtime.getRecord(targetId)`만 호출한다.
  자유 입력 exact search와 관계 target 탐색은 서로 다른 `mode`와 `action`이다.
- `emptyReason`은 `no-exact-match`, 승인된 unsupported reason, 또는
  `relation-target-not-found`를 보존한다. Product shell은 이를 각각 미수록,
  정책상 미지원, 관계 대상 없음으로 구분해 표시하며, load/query runtime
  failure는 typed `error.kind`로 별도 표시한다.
- `back()`과 `forward()`는 이미 읽은 snapshot을 복원하며 새 DB query를 만들지
  않는다. 진행 중인 요청은 먼저 취소하고 history에 loading snapshot을 남기지
  않는다.
- `searchExact()`가 준비되면 첫 번째 record와 그 record의 첫 번째 sense를
  각각 `selectedRecordId`, `selectedSenseId`로 선택한다.
  `selectCandidate(recordId, senseId)`는 현재 exact `ready` 결과의 record/sense를 검증해 두 선택값을
  현재 history snapshot에만 기록한다. 따라서 동음이의어를 바꿔도 history
  항목이나 `← 뒤로`가 생기지 않는다. 관계 target 탐색은 후보 선택 UI와 상태를
  초기화하고, `back()`은 이전 record/sense 선택을 함께 복원한다.
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
자동 수정, user storage를 구현하지 않는다. 입력 정규화는
[`src/runtime/search-query.js`](../src/runtime/search-query.js)의 NFC와 앞뒤
공백 제거 규칙만 사용하며 내부 공백을 재작성하지 않는다.

## Product UI

`src/components/DictionaryPanel.vue`는 popup과 Settings 미리보기에서 함께
사용하는 검색 표면이다. `DictionaryResult.vue`는 `projectRecord()`가 만든
sense/group projection만 렌더링하며, `definition`, `synonyms`, `antonyms`,
`texture`, `association` 설정이 false인 group과 item이 없는 group은
표시하지 않는다. 따라서 Settings 미리보기는 별도 markup으로 결과를 복제하지
않고 동일한 projection과 결과 renderer를 사용한다.

표시 설정은 `src/ui/settings.js`의 다섯 group 키와 하나의 background preset으로
제한한다. 기본값은 Figma의 미리보기와 맞춰 뜻풀이·유의어·말의 결은 켜고
반의어·연상은 끈다.
`createSettingsStore()`는 확장 프로그램의 `chrome.storage.local`에 설정만
저장하며, 읽기 전용 dictionary SQLite와 섞지 않는다. Options의 토글은 먼저
미리보기와 draft 상태만 갱신하고, 명시적인 저장 버튼이 현재 draft를
영속화한다. 설정을 불러오거나 저장하는 동안에는 토글을 잠가 순서가 뒤섞이지
않게 한다.
