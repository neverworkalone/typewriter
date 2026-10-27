#1155 C — 청크 하나 판독·발굴·제출

War Room이 지정한 배치 {{batch}}의 **청크 하나**(청크 {{chunk_no}}, 아래 Sense 목록)만 처리한다. 현재 worktree와 브랜치 `{{branch}}`, 준비된 HEAD를 그대로 사용한다. 배치·브랜치·HEAD를 바꾸지 않는다.
{{session_note}}
이 실행은 구현 작업이 아니라 청크 판독이다. 필요한 계약은 모두 이 카드에 있다. `AGENTS.md`(`CLAUDE.md`가 읽으라고 안내하더라도 읽지 않는다), `docs/`, #1155 본문, MEMORY.md, 캐시 루트 탐색(`rg --files`·`find`), `gh`, Git, `jq`, 웹 검색, 다른 모델·CLI·서브에이전트를 사용하지 않는다. 다음 청크 진행, export, commit, push, PR 생성은 War Room이 한다. 하지 않는다.

## 입력

{{chunk_input}}

## 정확한 source-sense 판독

- 각 `##` 항목은 Canonical의 **정확한 출발 Sense**(Sense ID, 표제어, 품사, gloss, 검색 형태)와 그 Sense의 후보 문학 문맥이다. 문맥마다 `[키] 출처` 다음 줄부터 원문 발췌가 이어진다. 발췌는 잘라서 읽지 않는다.
- 문맥마다 **그 출발 Sense의 실제 용례인지** 판정한다: `VERIFIED`(정확한 그 Sense) / `AMBIGUOUS` / `REJECTED`. 동음이의어, 다른 품사, 부분 문자열 오탐은 VERIFIED가 아니다. AMBIGUOUS는 같은 Sense에 한해 `chunk --db "$TYPEWRITER_APPROVED_LITERARY_DB" --checkpoint {{checkpoint}} --sense-ids <id> --contexts 16 --format text`로 추가 문맥을 읽어 정한다. 추가 조회는 1–4 → 5–8 → 9–12 → 13–16 순으로 필요한 만큼만 넓히고, 16은 상한이다. 읽지 않은 문맥을 판독한 것으로 간주하지 않는다.
- 작품·작가·장르·화자·장면이 다양하도록 VERIFIED를 고르고, 한 작품에서는 최대 2개 문맥을 선호한다.
- 항목이 `SEARCH_FAILED`면 판독하지 말고 제출 없이 그 사실만 보고하고 종료한다. `UNSEARCHABLE`이면 그 Sense에 한해 검토된 활용형을 `add-form --checkpoint {{checkpoint}} --sense-id <id> --form <활용형> --basis '<근거>'`로 추가한 뒤 `chunk --sense-ids <id>`로 다시 읽는다. 해결할 수 없으면 후보를 비워 제출하지 말고 보고하고 종료한다.
- 검색 결과가 없거나(`ZERO_HITS`) 아직 읽지 않은 Sense를 정상적인 빈 결과로 위장하지 않는다. VERIFIED가 하나도 없으면 후보도 없다: `"verified": []`, `"candidates": []`로 제출한다. 후보가 있는 Sense는 반드시 실제 VERIFIED 근거가 있어야 한다.

## 발굴 (모든 VERIFIED 문맥)

- **모든 VERIFIED 문맥**에서 일곱 관점 각각을 실제로 탐색한다: Image, Action, Emotion, Sensation, Scene/Situation, Causality, Metaphor/Contrast.
- **Sweep 1 / Sweep 2:** 모든 VERIFIED 문맥을 일곱 관점에서 **독립적으로 두 차례** 탐색한다. Sweep 1에서 발굴하고, Sweep 2에서는 같은 문맥을 다시 읽어 **놓친 독립 단어·연상 경로를 새로 찾는다**. 기존 후보 재분류·중복 제거·묘사구 바꿔 쓰기는 Sweep 2가 아니다. 관점별 빈 장부나 KEEP/REMOVE 장부는 만들지 않는다.
- **두 Sweep 모두 발굴 순서는 독립 단어 먼저, 짧은 이미지·구는 그다음이다.** 정확한 source sense의 VERIFIED 문맥에서 사물·몸짓·행동·정서·감각·장소·상황·인과·비유·대비를 따라 명사·동사·형용사 등 독립 어휘를 폭넓게 발굴한다. 원문에 문자 그대로 등장하지 않아도 그 문맥에서 자연스럽게 연상되는 단어는 가능하며, 간접적·느슨한 관계나 일상적인 단어라는 이유만으로 버리지 않는다. **문맥을 몇 개의 묘사구로 압축하는 것으로 단어 발굴을 대체하지 않는다.**
- **짧은 구는 보충한다.** 단어 하나로 바꾸기 어렵고 독립적인 이미지·표현 가치가 있는 짧은 **비서술적 구**만 선별한다. 상투적 관용구·뜻풀이 복제·기계적인 `표제어 + 수식어` 결합은 우대하지 않는다. 단어 비율이나 후보 개수 할당량을 만들지 않고, 실제 근거가 있는 독립 어휘와 적격 짧은 구를 함께 보존해 Stage 2에 넘긴다.
- **금지:** 완결문장, 서술절, 사건·과정 설명을 명사구로 위장한 표현, 정확한 source 표제어 반복(괄호만 다른 변형 포함), 중복. 제출 전에 **최종 후보 문자열을 하나씩 전수 점검**한다. 낮은 Tier가 예상된다는 이유만으로 지우지 않는다. 후보 수를 채우려고 억지로 늘리거나 후보를 줄이려고 적격 후보를 지우지 않는다.
- 이 단계는 발굴만 한다. type·Tier·target·admission을 결정하지 않고, A/B/다른 C 결과를 열람하거나 맞추지 않는다. 제출 필드는 `sense_id`, `verified`, `candidates`(문자열 배열)뿐이다.
- 문학 원문·발췌·로컬 locator·SQLite·검색 로그를 파일(제출 JSON 제외)·Git·PR·후보에 넣지 않는다.

## 제출 (도구 호출 한 번)

모든 Sense를 판독·발굴한 뒤, 아래 한 번의 셸 호출로 제출 파일 작성과 제출을 함께 한다. 작성이 실패하면 제출하지 않고 종료 코드 90으로 끝나며, 제출이 거부되면 제출 도구의 종료 코드와 진단이 그대로 나온다. 둘은 `WRITE_FAILED` / `SUBMIT_FAILED`로 구분된다.

```sh
cat > .warroom-scratch/c-chunk-{{chunk_no}}.submit.json <<'JSON' || { echo WRITE_FAILED >&2; exit 90; }
{"senses":[{"sense_id":"<Sense ID>","verified":["<VERIFIED 문맥 키>"],"candidates":["<후보>"]}]}
JSON
node scripts/relation/literary-context-cli.mjs submit --db "$TYPEWRITER_APPROVED_LITERARY_DB" --checkpoint {{checkpoint}} --input .warroom-scratch/c-chunk-{{chunk_no}}.submit.json || { c=$?; echo "SUBMIT_FAILED exit=$c" >&2; exit "$c"; }
```

- `senses`에는 이 활성 청크의 **모든 제출 가능 Sense ID**를 한 번씩 넣는다. `entry_number`는 이 배열의 1부터 시작하는 순번이며 파일의 줄 번호가 아니다.
- `submit_validation`이 거부되면 `affected.entry_number`와 `issues[].entry_number`를 제출 파일의 같은 배열 항목과 대조한다. 진단된 항목·필드만 고치고 나머지 올바른 VERIFIED 문맥과 후보는 그대로 보존한다. 최상위 오류처럼 위치가 `null`이면 진단된 최상위 모양만 고친다. JSON 문법 오류는 `json_syntax`의 `line`/`column`(제출 파일 기준)이 가리키는 곳의 괄호·쉼표만 고친다.
- `unknown_sense`는 해당 항목을 무조건 삭제하지 않는다. 그 위치의 ID를 활성 청크에 표시된 정확한 Sense ID 목록과 대조해 추가 항목인지, 의도한 ID의 오기인지 판별한다. 기대 ID가 제출에 없고 문제 항목이 추가분인 것이 확인되면 그 추가 항목만 제외한다. 누락 ID와 미지 ID가 각각 하나뿐이라는 사실만으로 서로 대응한다고 추측하지 않는다. 문제 항목의 기존 source-sense 근거로 원래 ID를 확정할 수 있을 때만 교정하며, 대응을 확정할 수 없으면 중단해 보고한다.
- 수정 후 제출 배열이 이 활성 청크의 제출 가능 Sense를 각각 한 번씩 모두 담고, 다른 청크 항목이나 미지 ID를 포함하지 않는지 확인한다. 제출 거부는 checkpoint에 부분 저장되지 않는다. 성공(`SAVED`)하면 즉시 종료하고 다음 청크는 시작하지 않는다. 이미 checkpoint에 저장된 Sense와 지난 청크 결과는 다시 만들거나 덮어쓰지 않는다.
- 셸 명령은 그 외에는 개별로 실행해 종료 코드와 출력을 확인한다. 임시 파일은 worktree의 `.warroom-scratch/`에만 둔다.
