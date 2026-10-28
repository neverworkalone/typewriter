#1155 C — 같은 청크 이어서

중단된 청크 {{chunk_no}}를 이 세션에서 이어간다. 청크 본문과 카드는 이 세션에 이미 있으므로 다시 읽거나 요청하지 않는다. 일반 중단에서는 이미 저장된 Sense를 다시 만들지 않는다. session note가 Candidate v1 복구를 지목하면 그 note에 포함된 Sense만 수정한다.
{{session_note}}
{{remaining}}
직전 제출 결과가 `submit_validation`/`candidate_validation` 거부라면 `.warroom-scratch/c-chunk-{{chunk_no}}.submit.json`에 `submit`을 다시 실행해 진단을 확인하고, 진단된 위치만 국소 수정해 재제출한다. 진단이 `repair_scope: stop_and_report`이면 재제출하지 말고 중단해 보고한다.
기존 `.submit.json`이 있는데 제출 CLI 응답이나 `.diag.json`이 없다면 셸 heredoc·명령 조합이 실행되지 않았을 수 있다. 파일의 유효한 source-sense 근거와 후보를 그대로 보존하고, 명령문이 파일에 붙은 등 제출 형식만 잘못된 경우 그 부분만 바로잡아 같은 파일을 다시 제출한다. 후보를 다시 발굴하거나 이미 저장된 Sense를 덮어쓰지 않는다.
남은 Sense만 같은 카드 규칙(정확한 출발 Sense 판독, 모든 VERIFIED 문맥의 일곱 관점 × 독립 2회 발굴, 최종 후보 전수 점검)으로 처리해, 카드의 한 번의 셸 호출 형식(제출 파일 작성 + submit)으로 제출한다. 제출 파일은 `.warroom-scratch/c-chunk-{{chunk_no}}.submit.json`이고 `senses`에는 아래 남은 Sense만 한 번씩 넣는다. 진단의 `entry_number`는 제출 배열의 1-based 순번이며 파일 줄 번호가 아니다. `submit_validation` 거부 시 `affected.entry_number`와 모든 `issues[].entry_number`를 원본 제출 파일에서 대조해 해당 항목·필드만 고치고, 다른 올바른 후보와 VERIFIED 문맥은 보존한다. `unknown_sense`를 무조건 삭제하지 말고, 해당 위치를 이 세션의 남은 Sense ID 목록과 대조해 실제 추가분인지 ID 오기인지 판별한다. 미지 ID와 누락 ID가 각각 하나뿐이라는 사실만으로 서로 대응한다고 추측하지 않는다. 문제 항목의 기존 source-sense 근거로 원래 ID를 확정할 수 있을 때만 바로잡고, 그렇지 않으면 중단해 보고한다. checkpoint에 이미 저장된 Sense는 보존하며 다시 제출하거나 재판독하지 않는다. 거부된 제출은 부분 저장되지 않는다. 수정 후 `senses`에 남은 Sense가 정확히 한 번씩 모두 있고 미지 ID가 없는지 확인한다. 성공하면 즉시 종료한다. `AGENTS.md`, `docs/`, Git, `gh`, `jq`, 다음 청크 진행, export, commit, push, PR 생성은 하지 않는다. 체크포인트: `{{checkpoint}}`
