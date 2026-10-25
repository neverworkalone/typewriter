PR #{{pr}} (브랜치 `{{branch}}`, 현재 HEAD {{head}})에 새 리뷰가 달렸다.
아래 리뷰/코멘트를 현재 HEAD 기준으로 검토하고, 동의하는 지적은 수정·검증한 뒤 같은 브랜치에만 커밋·push한다.
기존 worktree와 HEAD를 유지하며, master가 갱신되어도 현재 브랜치를 merge/rebase/reset하지 않는다.
동의하지 않으면 근거를 PR 코멘트로 남긴다.
새 PR을 만들지 않고, 리뷰를 요청하거나 머지하지 않는다.
파일 변경이 필요 없는 경우 불필요한 커밋을 만들지 않고 PR에 답변만 남긴다.
끝나면 종료한다.
이전 실행이 중단되며 worktree에 미커밋 변경이 남아 있을 수 있으니 먼저 git status로 확인하라.
세부 생산 규칙은 해당 Method의 정본 이슈(A/B #860, C #1155, D #1156)와 AGENTS.md를 따른다.
임시·스크래치 파일(검증용 스크립트, 청크, probe 결과 등)은 worktree 안의 `.warroom-scratch/` 에만 만든다. 이 디렉터리는 git에서 무시되며 커밋하지 않는다.
산출물이 아닌 파일을 worktree의 다른 경로에 남기지 않는다.
공통 결함(반복 가능한 공유 계층 결함)을 확인하면 `tools/warroom/prompts/shared-defect.md` 형식으로 `.warroom-scratch/shared-defect.json` 에 보고하고 멈춘다.
{{session_note}}
{{review_events}}
