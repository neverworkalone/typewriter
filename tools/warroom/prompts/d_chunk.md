#1156 D — 청크 하나 판독·발굴·저장

War Room이 지정한 배치 {{batch}}의 **청크 하나**(청크 {{chunk_no}}, 아래 view)만 처리한다. 현재 worktree와 브랜치 `{{branch}}`, 준비된 HEAD를 그대로 사용한다. 배치·브랜치·HEAD를 바꾸지 않는다.
{{session_note}}
이 실행은 구현 작업이 아니라 청크 판독이다. 필요한 계약은 모두 이 카드에 있다. `AGENTS.md`(`CLAUDE.md`가 읽으라고 안내하더라도 읽지 않는다), `docs/`, #1156 본문, 스크립트 소스, MEMORY.md, 캐시 루트 탐색(`rg --files`·`find`), `gh`, Git, `jq`, 웹 검색, 다른 모델·CLI·서브에이전트를 사용하지 않는다. 다음 청크 진행, 조립, 검증, commit, push, PR 생성은 War Room이 한다. 하지 않는다. 다른 청크·다른 모델·A/B/C의 후보나 이전 배치 산출물은 열람하지 않는다.

## 입력

{{chunk_input}}

view의 `## `마다 Canonical record 하나다: 표제어·검색형, 그 record로 이미 조회한 **공유 문맥**(상태 줄 `COMPLETE`/`LIMITED`/`ZERO_HITS`/`SEARCH_FAILED`와 `[키] 표제 저자` 다음 줄의 발췌), 그리고 아래에 `s1…sK`로 번호가 붙은 record의 모든 Sense(정확한 Sense ID·품사·전체 gloss)가 온다. 문맥은 record의 Sense들이 공유하지만 **source-sense 판정과 후보 발굴은 Sense마다 따로** 한다. 머리 줄의 `decide=`는 이번 청크에서 판정할 필수 Sense 전체이며, `auto_z`는 War Room이 기계적으로 완전 0건을 증명해 자동 저장하므로 판정 줄에 넣지 않는다.

운영자가 `prepare --hada-prefetch`를 명시한 경우 첫 `search:` 줄에는 Canonical 검색형과 함께 제한된 `-하다` 활용형 검색 결과가 들어 있을 수 있다. 이는 해당 record에 이미 기록된 일반 검색 증거다. 같은 검색형을 다시 조회하지 말고 상태와 문맥을 판독한다. 옵션은 기본 실행에서 꺼져 있다. 추가 활용형이 필요하면 아래 검색 도구로 별도 조회할 수 있다.

## 정확한 source-sense 판독 (#1156 PASS A)

- 문맥마다 **그 출발 Sense의 실제 용례인지** 판정한다: VERIFIED(정확한 그 Sense) / AMBIGUOUS / REJECTED. 표제어·검색형, 형태·품사, 동형이의어·다의어, 문자 경계를 확인한다. 동음이의어, 다른 품사, 부분 문자열 오탐, AMBIGUOUS/REJECTED는 VERIFIED가 아니다. **직접 VERIFIED 용례가 없는 Sense에서는 후보를 만들지 않는다.**
- `prepare`는 검색별 요청 예산 안에서 서로 다른 문단 문맥을 최대 4개까지 자동 수집한다. 실제 검색이 끝나기 전에 4개가 모이면 `LIMITED`와 이어 읽을 cursor를 보여 준다. 먼저 서로 다른 문맥 1–4개를 읽고, 필요하면 5–8 → 9–12 → 13–16으로 넓힌다. **Sense마다 실제로 판독하는 문맥은 최대 16개**이며 할당량이 아니다. 이미 받은 문맥을 일부러 다시 조회하거나 16개를 넘겨 판독하지 않는다. 16개를 읽었거나 `LIMITED`라는 이유만으로 미완료로 보지 않는다. 충분히 직접 읽고 합리적으로 탐색했다면 `N`을 선택할 수 있다.
- 여러 Sense에 추가 문맥이 필요하면, 먼저 필요한 검색을 모아 **아래 한 번의 셸/도구 호출**로 JSON을 stdin에 보낸다(승인 index 접근은 War Room이 설정해 두었다). JSON 배열의 각 `forms` 문자열은 공백·쉼표·따옴표를 보존한다:
  ```sh
  cat <<'JSON' | node scripts/relation/d-chunk-cli.mjs search-batch
  {"requests":[
    {"sense":"s2","forms":["검색형, 쉼표 포함","인용 \"포함\""],"boundary":"left","cursor":null,"contexts":4},
    {"sense":"s5","forms":["다른 검색형"],"boundary":"both","contexts":2},
    {"sense":"s6","forms":["이미 완료된 검색형"],"reread":true,"contexts":4}
  ]}
  JSON
  ```
  `forms`를 생략하면 해당 record의 Canonical 검색형을 쓴다. `boundary`·`cursor`·`contexts` 생략 시 각각 기본 경계·첫 페이지·4개 문맥을 쓴다. 검색 의도에 따라 요청을 다음처럼 구분한다:
  - `prepare`의 Canonical 기본 검색 이어 읽기: 해당 `search:` 행의 forms가 heading의 `search_forms`와 같은 경우에만 **`forms`와 `boundary`를 모두 생략**하고, 기록이 `LIMITED`일 때 `cursor:"next"`를 쓴다. `contexts`는 필요하면 바꿀 수 있다.
  - `prepare --hada-prefetch` 또는 띄어쓰기 변형처럼 추가 forms로 실행한 검색 이어 읽기: 해당 `search:` 행에 표시된 **실제 forms 전체를 같은 순서로 지정**한다. prepare 검색의 boundary는 기본값이므로 `boundary`는 생략한다. 행에서 forms를 정확하고 모호하지 않게 복원할 수 없으면 추측하지 말고 보고한다.
  - 새 활용형·표기 변형·경계 검색: 원하는 `forms`와 `boundary`를 지정하고 **cursor를 생략하거나 `null`**로 둔다. 단, 같은 record·forms 순서·boundary에 미완료 `LIMITED`가 기록되어 있으면 새 첫 검색을 시작하지 말고 그 검색을 이어 읽는다. `contexts`만 바꾸어도 검색 조건은 달라지지 않는다.
  - 수동 검색 이어 읽기: 직전 수동 요청과 **동일한 forms 목록·순서 및 boundary**를 지정하고, 아직 소비되지 않은 기록 `LIMITED` cursor가 있을 때만 `cursor:"next"`를 쓴다. 긴 Base64URL 토큰을 복사하거나 디코딩·조립·재인코딩하지 않는다.

  `COMPLETE`·`ZERO_HITS` 결과에는 `next`를 쓰지 않는다. `DEFERRED`는 검색되지 않은 결과라 자체 cursor가 없다. 응답의 `retry_requests`에 있는 원래 요청을 그대로 다시 보내며, 그 요청에 이미 유효한 cursor가 있으면 그대로 보존한다. `INVALID_CURSOR`가 나면 같은 요청을 맹목적으로 반복하지 않는다. 먼저 마지막 기록 상태와 forms 순서·boundary가 같은지 확인한다. 유효한 미완료 `LIMITED`가 없거나 기록이 충돌·손상·모호하면 cursor를 추측하거나 같은 조건을 첫 검색으로 재시작하지 말고 상태를 보존해 보고한다. 새로운 검색 조건이 실제로 필요할 때만 그 새 조건으로 cursor 없이 검색한다.

  검색형·경계·cursor·문맥 수 등 결과에 영향을 주는 옵션이 모두 같으면 **record ID가 달라도** 한 번만 검색하고 문맥을 한 번만 출력하며, `shared_by`에 연결된 record마다 증거를 한 번 기록한다. 같은 record의 여러 Sense는 해당 record 증거를 공유하지만, source-sense 판독과 후보 발굴은 각각 독립 수행한다. 다른 조건은 합치지 않는다. `search-batch`는 반드시 위처럼 JSON 객체를 stdin으로 전달한다.
  CLI는 요청별 문맥 수를 채우거나 검색 완료 또는 요청 스캔 한도에 도달할 때까지 내부 페이지를 이어 읽는다. 짧은 검색형은 실제 확인한 문단 범위를, 3자 이상 FTS 검색형은 결과가 0건이어도 페이지 예산을 사용하므로 검색형을 많이 보내도 한도를 우회하지 않는다. 검색 한도에 도달하면 실제 모은 문맥과 유효한 `next_cursor`를 `LIMITED`로 돌려준다. 한 번의 `search-batch`에는 별도 합산 스캔 한도가 있다. 상위 `PARTIAL`은 이 합산 한도 때문에 일부 요청을 시작하지 않았다는 뜻이다. 그 결과는 `DEFERRED`이며, 해당 결과의 `retry_requests`에 들어 있는 원래 요청을 모아 다음 호출의 `requests` 배열에 그대로 넣는다. 이 요청은 아직 검색되지 않았고 증거도 기록되지 않는다. 다른 완료·진행 결과는 함께 반환된다. 결과의 `requests[].status`로 각 요청 상태를 확인한다.
  완료가 cursor 증거 체인으로 증명된 동일 record·forms 순서·boundary를 다시 요청하면 `ALREADY_COMPLETE`가 반환된다: 재검색·증거 추가 없이 `recorded_status`와 `recorded_hits`만 제공하고 `contexts:[]`이다. `context_source`가 `view`이면 기존 view 문맥을 읽고, `search_response`이면 이전 검색 응답을 읽는다. 문맥을 실제로 잃었을 때만 해당 요청에 `reread:true`를 명시한다. 완료 증거를 확인한 뒤 처음부터 문맥만 다시 읽으며 어떤 검색 증거·누적 hit·cursor도 바꾸지 않는다. hit 수만으로 `V/N`을 고르지 않는다. 전체 응답이 48 KiB 제한을 넘으면 명시적 오류로 종료되고 해당 호출의 검색 증거는 기록되지 않는다. 요청 수를 나누거나 `contexts`를 낮춰 다시 보낸다. 결과 안의 `SEARCH_FAILED`도 0건 완료로 보지 말고 보고한다.
- 한 Sense만 추가 조회할 때는 기존 단일 검색을 계속 쓸 수 있다:
  `node scripts/relation/d-chunk-cli.mjs search <sN> [--forms 형태1,형태2] [--boundary left|none|both] [--cursor next] [--contexts 1..16] [--reread]`
  `--forms`를 생략하면 record의 Canonical 검색형을 쓴다. `prepare`에서 Canonical 기본 검색을 이어 읽을 때(해당 `search:` 행이 heading의 `search_forms`와 같을 때)만 `--forms`와 `--boundary`를 모두 생략하고, 기록이 `LIMITED`일 때 `--cursor next`를 쓴다. `--hada-prefetch`나 띄어쓰기 변형 등 추가 forms를 사용한 prepare 검색은 해당 `search:` 행의 실제 forms 전체와 순서를 그대로 `--forms`에 지정한다. prepare boundary는 기본값이므로 생략한다. 표시된 forms를 정확하게 복원할 수 없으면 추측하지 말고 보고한다. 새 활용형·표기 변형·경계 검색은 새 조건을 지정하고 `--cursor`를 생략한다. 단, 같은 record·forms 순서·boundary에 미완료 `LIMITED`가 있으면 contexts만 바꾸어 첫 검색을 다시 시작하지 말고 그 기록을 이어 읽는다. 수동 검색을 이어 읽을 때는 직전과 같은 forms 목록·순서와 boundary를 지정하고 유효한 미소비 `LIMITED` 기록이 있을 때만 `--cursor next`를 쓴다. 활용형·표면 변형·다른 승인 검색형으로 넓힐 수는 있으나 부분 문자열을 무차별로 늘려 허위 hit를 만들지 않는다. 1–2자 검색은 앞뒤 문자 경계와 조사 결합을 직접 확인한다. CLI는 같은 문단이 여러 검색형에 걸려도 한 번만 세고, 요청한 문맥 수에 도달하거나 실제 검색이 끝날 때까지 내부 페이지를 이어 읽는다. 요청 스캔 한도에 도달하면 지금까지 찾은 문맥과 검증된 `next_cursor`를 `LIMITED`로 돌려준다. 문맥이 있는 `LIMITED`는 ZERO_HITS도 sense 완료도 아니다. `COMPLETE`·`ZERO_HITS`에는 `next`를 쓰지 않는다. `INVALID_CURSOR`가 나오면 이번 검색과 증거 기록은 0건이다. 마지막 기록 상태와 조건을 확인하며 같은 `next`를 맹목적으로 반복하지 않는다. 미완료 cursor가 없거나 기록이 충돌·손상·모호하면 cursor를 만들거나 처음부터 같은 조건으로 재검색하지 말고 상태를 보존해 보고한다. 호출 횟수는 검색 완료 근거가 아니다.
- 증거 상태: `Z_ALLOWED`는 record의 모든 기록 검색 완료와 누적 0 hit를 뜻하고, `V_N_ALLOWED`는 적어도 한 기록 hit가 있음을 뜻한다. `SEARCH_MORE`는 hit 없는 미완료 검색이며, `SEARCH_FAILED`는 정상 판정 불가다. 화면·검색 응답의 `decision_state`와 save는 같은 기계적 허용 규칙을 쓴다. record마다 출발 Sense 판독은 독립이다. **`Z`**는 `Z_ALLOWED`와 더불어 이 Sense의 활용형·표기 변형이 더 필요하지 않다고 **내가 판단**해야 한다. 검색형 충분성은 CLI가 대신 판단하지 않는다. `-하다` 사전 수집 검색형이 충분하다면 같은 형을 반복 조회할 필요는 없지만, 용언·어근·짧은 표제어는 문맥과 검색형을 검토해 필요한 활용형을 더 조회한다. **`N`**은 문맥은 있으나 합리적인 추가 탐색 뒤에도 VERIFIED가 없음, **`V`**는 VERIFIED 문맥을 직접 읽음이다(후보가 없으면 정상 빈 후보 `[]`). 검색 hit만으로 Sense VERIFIED가 되지는 않는다. `SEARCH_FAILED`·미작업·읽지 않은 Sense를 `Z`/`N`/빈 `V`로 위장하지 않는다. view의 항목이 `SEARCH_FAILED`면 판정하지 말고 저장 없이 그 사실만 보고하고 종료.

## 발굴 (#1156 PASS B)

- **D의 목적:** 실제 문어 문맥에서 출발 Sense에 결속된 대상·역할·도구·행동·상황·인과·대비·감각 등 현실 세계의 어휘 연결을 독립적으로 발굴한다. 같은 문서에 우연히 함께 등장한 명사·주제어를 의미 근거 없이 복사하지 않는다. 직접적이지 않거나 일상적인 연상도 정확한 VERIFIED 용례에서 설명할 수 있으면 보존한다.
- **1회 통합 탐색:** VERIFIED 문맥에서 다섯 관점을 폭넓게 적용한다: ① 실제 어휘·공기 ② 행동·역할·도구·대상 ③ 상황·장면·시간·환경 ④ 원인·결과·대응 ⑤ 대비·감각·비유·연상. **먼저 명사·동사·형용사 등의 독립 단어를 폭넓게 발굴하고**, 그다음 단어로 대신하기 어려운 독립 가치가 있는 짧은 비서술적 이미지·구를 보충한다. **문맥을 몇 개의 묘사구로 요약하는 것으로 단어 발굴을 대신하지 않는다.**
- **선택적 추가 탐색:** 특정 장면·관점에 편중됐거나 역할·인과·대비 등 미탐색 관계가 남아 있거나 다른 문맥에서 유효 후보가 계속 발견될 때만 필요한 범위를 다시 살핀다. 출발 Sense의 실제 용례를 확인하고 다양한 연상 경로를 탐색했으며 새로운 발견이 정체되면 종료한다. **독립 2회 전수 탐색 의무는 없다.** 후보 수 할당량·0건 표·증명 장부는 만들지 않는다.
- 이 단계는 발굴만 한다. type·Tier·target·admission·Drop을 결정하지 않는다. 출력은 후보 문자열뿐이다.

{{method_contract}}

## 저장 (도구 호출 한 번)

모든 판정 대상 Sense를 마친 뒤, 아래 **한 번의 셸 호출**로 판정 파일 작성과 저장을 함께 한다. 작성이 실패하면 저장하지 않고 종료 코드 90으로 끝나며(`WRITE_FAILED`), 저장이 거부되면 저장 도구의 종료 코드와 진단이 그대로 나온다(`SAVE_FAILED`).

```sh
cat > .warroom-scratch/d-{{batch}}/decision-{{chunk_no}}.txt <<'DEC' || { echo WRITE_FAILED >&2; exit 90; }
s1 V 후보A|후보B|후보C
s2 V
s3 N
s4 Z
DEC
node scripts/relation/d-chunk-cli.mjs save --in .warroom-scratch/d-{{batch}}/decision-{{chunk_no}}.txt || { c=$?; echo "SAVE_FAILED exit=$c" >&2; exit "$c"; }
```

- 한 Sense 한 줄: `sN V 후보|후보` (VERIFIED + 후보), `sN V` (VERIFIED + 적격 후보 0), `sN N`, `sN Z`. `auto_z` Sense는 쓰지 않는다. 다른 모든 Sense를 정확히 한 번씩 쓴다.
- 저장은 청크 전체를 한 번에 검사하고 같은 유형의 오류를 모두 알려 준다. 거부되면 아무것도 저장되지 않는다. 지목된 줄만 고쳐 다시 한 번의 호출로 제출한다. 정상 저장(`SAVED`)되면 즉시 종료하며 다음 청크는 시작하지 않는다.
- 저장은 Candidate v1이 명백히 부적격으로 판정한 source lemma 반복·천 단위 쉼표 파편과 정규화 중복만 자동 제거하고 `removed_candidates`로 보고한다. 독립 합성어와 정상 후보는 보존하며 `V`의 후보가 모두 제거되어 빈 배열이 되어도 저장할 수 있다.
- `V`는 내가 VERIFIED 문맥을 읽었다는 뜻이다. 저장 도구는 문맥의 source-sense 진위를 기계적으로 검증했다고 주장하지 않으며, `N`·`Z`의 의미적 타당성은 나와 독립 리뷰의 책임이다.
- 셸 명령은 그 외에는 개별로 실행해 종료 코드와 출력을 확인한다.
