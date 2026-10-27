#1155 C — 같은 청크 이어서

중단된 청크 {{chunk_no}}를 이 세션에서 이어간다. 청크 본문과 카드는 이 세션에 이미 있으므로 다시 읽거나 요청하지 않는다. 이미 저장된 Sense는 다시 만들지 않는다.
{{remaining}}
남은 Sense만 같은 카드 규칙(정확한 출발 Sense 판독, 모든 VERIFIED 문맥의 일곱 관점 × 독립 2회 발굴, 최종 후보 전수 점검)으로 처리해, 카드의 한 번의 셸 호출 형식(제출 파일 작성 + submit)으로 제출한다. 제출 파일은 `.warroom-scratch/c-chunk-{{chunk_no}}.submit.json`이고 `senses`에는 남은 Sense만 넣는다. 거부되면 오류가 가리킨 Sense·필드만 고친다. 성공하면 즉시 종료한다. `AGENTS.md`, `docs/`, Git, `gh`, `jq`, 다음 청크 진행, export, commit, push, PR 생성은 하지 않는다. 체크포인트: `{{checkpoint}}`
