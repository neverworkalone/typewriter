#1156 D 진행해

War Room이 지정한 배치 {{batch}}를 생산한다.
현재 worktree와 브랜치 {{branch}}를 그대로 사용한다.
배치를 다시 선정하거나 브랜치를 변경하지 않는다.
War Room이 준비한 HEAD를 기준으로 작업하며, 
생산 도중 master가 갱신되어도 현재 브랜치를 merge/rebase/reset하지 않는다.

Issue #1156의 D 생산 계약을 읽고 준수한다.

D는 전용 CLI·전수 사전 `scan`·문맥/후보별 영수증 없이 #1156의 간단한 경로로 생산한다. 25-record 청크마다 승인 문어 SQLite를 read-only로 직접 검색하고(필요한 검색어만 요구 시 조회), 읽은 문맥을 직접 판독해 후보를 만들고, 청크 단위 scratch(`.warroom-scratch/`)에 중간 결과만 남겨 재개한다. 청크 하나를 끝내면 그 청크의 Candidate 행(`{"record_id","senses":[{"sense_id","candidates"}]}`, 청크의 모든 record를 Canonical 순서대로 정확히 한 번씩, 25개 또는 마지막 청크의 잔여 개수)을 `.warroom-scratch/d-{{batch}}/chunk-NNN.jsonl`(NNN은 1부터 3자리)로 저장한다. 먼저 같은 폴더의 `chunk-NNN.jsonl.tmp`에 완전히 쓴 뒤 `mv`로 이름을 바꿔, 완성된 청크만 해당 이름으로 나타나게 한다(War Room이 이 파일 수로 진행 막대를 그린다). 조회만 끝났거나 미완성인 청크는 이 이름으로 두지 않는다. 마지막에 Candidate JSONL을 조립해 `scripts/relation/candidate-contract.mjs` 검증만 실행한다.

## 청크 반복 경로 (25-record 청크마다)

War Room이 고정한 `(method,model,shard,batch)`/worktree/branch/HEAD는 재선정·재검증하지 않는다. 시작 시 한 번만 계약·승인 SQLite 접근·실제 인덱스 스키마(`paragraph_fts` trigram 등)·Canonical 청크를 확인하고, 메모리·지침 파일을 반복 조회하지 않는다.

청크 하나는 **조회 → 정확 문맥 판독 → 즉시 후보 편집 → 완성 청크를 `.warroom-scratch/`에 한 번 저장**으로 끝낸다. 검색어 목록을 한 번에 모아 하나의 스크립트로 질의하고, 임시 `jq`/Python 필터·JSON 재출력·사후 통계 집계·`progress` 원장은 만들지 않는다. dict 키·따옴표 오류를 피하려면 청크 입력(Canonical record/sense/`search_forms`)과 출력(`{sense_id: [후보]}`)을 파일 하나씩의 단순 JSON으로 두고, 인용이 복잡한 값은 셸 인자가 아닌 파일로 전달한다.

각 source sense는 실제 문어 용례를 확인하고, VERIFIED 문맥에서 대상·행동·도구·상황·인과·대비·감각·연상 등 다양한 어휘를 한 번의 통합 탐색으로 충분히 발굴한다.

최초 조회는 보통 3~4개 문맥, 문맥당 180~240자로 시작한다. 정확한 의미 확인과 어휘 발굴에 충분하면 종료하고, 부족하면 해당 sense의 문맥을 추가 조회한다. 조회 건수는 할당량이 아니다.

발췌 문맥만으로 source sense를 판별하기 어려울 때는 해당 문맥의 필요한 범위만 추가 확인한다. 의미를 추측해 후보를 생성하지 않는다.

**검색은 `scripts/relation/corpus-utility.mjs`를 import해 쓴다**(재사용 권장, 강제 아님; 특수 경로가 필요하면 조합·확장). 매 배치 `probe-*.mjs`/`followup.mjs`를 다시 구현하지 않는다.

```js
import { openReadonlyDb, createSearchContextReuse, renderContexts, saveChunk } from '<worktree>/scripts/relation/corpus-utility.mjs';
const db = openReadonlyDb('<승인 문어 SQLite 경로>');            // read-only
const search = createSearchContextReuse(db);                    // 25-record 청크마다 한 번 생성
let page = search(['김구'], { maxSamples: 8 });                 // 표본·문자 상한, 짧은 형태는 boundary: 'left'|'none' 조정
if (!page.reused) console.log(renderContexts(page.result));    // 같은 요청은 재사용하고 stdout에 한 번만 출력
if (page.result.next_cursor) {
  page = search(['김구'], { cursor: page.result.next_cursor }); // 다음 페이지는 새 요청; 더 없으면 cursor가 null
  if (!page.reused) console.log(renderContexts(page.result));
}
await saveChunk('.warroom-scratch/d-{{batch}}', 3, rows, chunk);  // chunk = [{record_id, sense_ids}] Canonical 순서; 하나라도 빠지면 쓰지 않고 실패
```

같은 청크에서 다른 sense가 **검색형 순서·boundary·모든 검색 상한·페이지 cursor까지 같은 요청**을 하면 `search`가 메모리 결과를 재사용하고 `reused: true`를 반환한다. 출력은 다시 하지 않아도 되지만, 해당 문맥을 각 source sense에 대조해 VERIFIED 여부와 후보 발굴은 **sense마다 독립적으로** 수행한다. 재사용은 이 `db` 연결과 청크 안에서만 유지되며 `SEARCH_FAILED`는 캐시하지 않는다.

상태: `ZERO_HITS`(완전 탐색 후 없음) / `COMPLETE` / `LIMITED`(상한에서 멈춤, `next_cursor`로 계속) / `SEARCH_FAILED`. 이 도구는 검색·출력 상한만 담당하며 source sense 판독(VERIFIED)과 후보 편집은 AI가 직접 한다. `LIMITED` 표본에 출발 sense가 없다고 `ZERO_HITS`/`NO_VERIFIED`로 확정하지 않고, 필요하면 `next_cursor`나 다른 승인 검색형으로 더 조회한다.

**Sense·배치 완료 판정:** `LIMITED`는 한 번의 검색 호출이 출력 한도에 도달했다는 뜻이지 그 Sense의 미완료나 검색 실패를 뜻하지 않는다. 실제 반환된 문맥을 출발 sense에 대조하고 필요한 추가 문맥·승인 검색형을 합리적으로 확인했지만 맞는 VERIFIED 용례가 없다면 `NO_VERIFIED`로 판정하여 `candidates: []`로 완료할 수 있다. `next_cursor`가 남았다는 이유만으로 전체 말뭉치 또는 해당 검색의 모든 페이지를 소진할 필요는 없으며, 이것만으로 청크나 PR을 보류하지 않는다. 반대로 미검색·실제 `SEARCH_FAILED`·필요한 판독이 아직 끝나지 않은 Sense는 정상 빈 후보로 완료하지 않고, VERIFIED 용례 없이 후보를 생성하지 않는다. 미완료가 없다면 최종 Candidate v1 검증 후 기존 지침대로 PR을 제출한다.

검색 규칙:
- 3글자 이상은 `paragraph_fts`(trigram) 등 승인 인덱스의 실제 스키마가 지원하는 경로를 쓴다. 1~2글자는 trigram이 지원되지 않으므로 필요한 sense에 한해 제한된 literal 검색을 쓰되, **앞뒤 양쪽 문자 경계**(예: `기현`에 `기현상`·`이기현`이 섞이지 않도록)와 활용형·동음이의어를 직접 확인한다.
- `LIMIT` 표본에서 정확 문맥이 없다고 전체 corpus의 ZERO_HITS로 보고하지 않는다. ZERO_HITS / NO_VERIFIED / SEARCH_FAILED / 미작업을 구분하고, 부족하면 승인된 다른 검색형·활용형·다른 문맥으로 필요한 만큼만 확장한다. 전수 선행 스캔은 하지 않는다.

후보를 쓰면서 **자기 표제어 반복을 그 자리에서 제거한다**: 청크에서 이미 읽은 `lemma`·`search_forms`와 비교해, 정확히 같거나 괄호 주석만 붙었거나 공백·하이픈만 다른 표기(`기회비용`↔`기회 비용`, `기업공개`↔`기업 공개`)는 쓰지 않는다. 단 그 표기가 **다른 Canonical 표제어**이거나 lemma를 포함한 독립 합성어(`건축 → 건축가`)는 보존한다. 청크마다 Candidate v1 전체 검사를 돌리지 않는다.

최종 조립 후 `candidate-contract.mjs` 검증은 **1회**. 실패하면 오류 메시지가 해당 유형의 모든 항목(`Candidate:행:sense`)을 한꺼번에 나열하므로, 관련 청크의 항목을 한 번에 모두 고치고 재검증한다. 한 건씩 고쳐 재실행하지 않는다.

셸 명령은 개별로 실행해 각 종료 코드와 출력을 확인한다. `gh api` 경로에 `?` 또는 `&`가 있으면 경로 인수 전체를 작은따옴표로 감싼다. 예: `gh api 'repos/neverworkalone/typewriter/contents/data/relation-candidates/031?ref=master'`, `gh api 'repos/neverworkalone/typewriter/pulls?state=open&per_page=100' --jq 'length'`.

Candidate v1 검증 후 커밋·push하고 `batch` 라벨의 PR을 제출한다. PR 생성 직전 다른 모델을 포함한 동일 D 배치의 중복 점유를 확인한다. PR 본문에서 #1156을 참조하거나 닫지 않는다.

PR 제출 후 종료한다. 리뷰·머지 감시와 다음 배치 실행은 War Room이 담당한다. 다른 모델·CLI·서브에이전트를 실행하지 않는다.

임시·스크래치 파일(검증용 스크립트, 청크, probe 결과 등)은 worktree 안의 `.warroom-scratch/` 에만 만든다. 이 디렉터리는 git에서 무시되며 커밋하지 않는다.
산출물이 아닌 파일을 worktree의 다른 경로에 남기지 않는다.

공통 결함(반복 가능한 공유 계층 결함)을 확인하면 `tools/warroom/prompts/shared-defect.md` 형식으로 `.warroom-scratch/shared-defect.json` 에 보고하고 멈춘다.
