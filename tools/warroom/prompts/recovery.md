이전 AI 실행이 중단되어 같은 worktree에서 이어서 진행한다 (배치 {{batch}}, 브랜치 `{{branch}}`).
worktree의 현재 상태와 기존 산출물을 확인하고, 이미 있는 산출물·PR을 버리거나 중복 PR을 만들지 말고 남은 작업만 완료하라.
기존 worktree와 HEAD를 유지하며, master가 갱신되어도 현재 브랜치를 merge/rebase/reset하지 않는다.
기존 산출물과 미커밋 변경을 보존하며 남은 작업을 완료한다. 기존 PR이 있으면 재사용하고, 없으면 현재 브랜치에서 최초 PR 하나를 생성한다.
생산 규칙은 해당 Method의 정본 이슈(A/B #860, C #1155, D #1156)와 AGENTS.md를 따른다.

Method C 복구 시 `ps`·`pgrep`에 의존하지 말고, 작업의 실행 결과와 기존 기록으로 상태를 확인한다.

임시·스크래치 파일(검증용 스크립트, 청크, probe 결과 등)은 worktree 안의 `.warroom-scratch/` 에만 만든다. 이 디렉터리는 git에서 무시되며 커밋하지 않는다.
산출물이 아닌 파일을 worktree의 다른 경로에 남기지 않는다.

공통 결함(반복 가능한 공유 계층 결함)을 확인하면 `tools/warroom/prompts/shared-defect.md` 형식으로 `.warroom-scratch/shared-defect.json` 에 보고하고 멈춘다.
