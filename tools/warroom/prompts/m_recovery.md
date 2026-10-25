이전 Maintainer 실행이 중단되어 같은 worktree에서 이어서 진행한다 (Issue #{{issue}}, 브랜치 `{{branch}}`).
worktree의 상태와 기존 커밋·미커밋 변경, 이미 열린 PR이 있는지(`gh pr list --head {{branch}} --state all`)를 먼저 확인하라. 이미 있는 작업·PR을 버리거나 중복 PR을 만들지 말고 남은 작업만 완료한다.
범위·금지 사항은 처음 지시와 같다: Issue #{{issue}}의 공통 원인 수정과 공유 regression만, 배치 Candidate JSONL은 건드리지 않고, 리뷰 요청·승인·머지를 하지 않으며, 현재 브랜치를 merge/rebase/reset하지 않는다.
PR이 없으면 이 브랜치에서 `Closes #{{issue}}` 를 포함한 PR 하나를 만들고 Issue의 현재 라벨을 복사한다.
임시·스크래치 파일은 `.warroom-scratch/` 에만 만든다. 끝나면 종료한다.
