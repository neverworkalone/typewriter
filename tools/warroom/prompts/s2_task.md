#927 Stage 2 진행 — 병렬 primary 작업 (task)

War Room이 한 Part의 primary 판정을 고정된 작업(task)으로 나눠 이 세션에 **작업 하나**를 맡겼다. 이 실행은 구현 작업이 아니라 판정이다. 판정 계약은 아래 카드와 task 뷰에 들어 있다. AGENTS.md·`docs/`·이슈·스크립트 소스를 읽지 않는다. **일반적인 판정에서는 도구와 파일을 사용하지 않는다.** Git·web·`gh`·다른 모델·CLI·서브에이전트도 쓰지 않는다. War Room이 마지막 답변을 파일에 기록하고 저장·검증한다. 현재 worktree·브랜치·HEAD·Part를 바꾸지 않는다. 다른 task의 후보나 checkpoint를 판단하지 않는다. 단, 실제 공통 결함을 발견한 경우에는 기존 규약에 따라 `tools/warroom/prompts/shared-defect.md` 형식으로 아래 「이번 task」에 지정된 보고 경로에 작성하고 중단한다.

{{s2_policy_card}}

compact 응답은 task 뷰의 `# decision` grammar를 따른다. CLI가 판정 형식을 자동 복구하도록 역방향 필드를 임의로 추가하거나 생략하지 않는다.

## 답변 형식 (정확히 이 순서로, 마지막 답변 하나)

첫 줄은 정확히 이번 task의 `chunk <task ID>`이고, 이어서 **모든** `c<n>` 판정을 각각 줄바꿈으로 구분되는 별도 행에 쓴다. 한 행 안의 필드만 공백으로 구분한다. 진행 안내·설명·코드 펜스를 덧붙이지 않는다. `# complete`만 있는 뷰면 판정할 후보가 없으므로 그렇게만 답한다.

- exact ID 결속은 task 뷰가 표시한 형식으로 쓴다.
- `c4 R scene 6 none T7,T8` — text-only, c4의 target 별칭 전부 확인
- `c5 R sensory 5` — target이 `-`인 후보
- `c6 D e` — 출발 Sense와 연결되지만 독립적인 표현 가치가 없는 Drop
- `c7 D x` — 출발 Sense와 무관하거나 잘못 결속된 Drop

## 이번 task

- Part: Shard {{shard}} · Batch {{batch}} · Part {{part}} (브랜치 `{{branch}}`)
- task ID(= 답변 첫 줄의 chunk ID): `{{chunk_id}}`
- 공통 결함 보고 경로: `{{defect_path}}`
{{session_note}}
{{chunk_input}}
