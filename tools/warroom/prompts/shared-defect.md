# 공통 결함(Shared defect) 보고 형식 — War Room이 생산 프롬프트에서 가리키는 문서

해당 조건: 작업 중 **공유 계층(생산 프롬프트·검증기·빌드·프로세스)의 결함**을 실제로 재현했을 때 보고한다.
보고는 가볍게 한다: **실제로 재현되는 사례 1건 이상 + 재현 방법 + 의심되는 공유 계층**만 필수다.
원인 분석·수정안·적용 범위·회귀 검증 설계는 Maintainer의 일이므로 모르면 생략한다(알고 있으면 적어도 된다).
후보 한 건의 오류·논쟁(재현 가능한 공유 계층 실패가 아닌 것), 일반 CLI/인증/네트워크 문제는 보고 대상이 아니다.

보고 방법: 아래 JSON을 worktree의 `.warroom-scratch/shared-defect.json` 에 쓰고 **즉시 작업을 멈춘다**.
War Room이 이 배치만 PAUSED 로 두고(작업물·브랜치·세션 보존) urgent Issue를 등록한 뒤, 수정이 머지되고 반영되면 같은 배치를 자동으로 재개한다.
이 보고는 Method A/B/C/D 규칙과 Candidate 계약을 바꾸지 않는다.

```json
{"version": 1, "defect_class": "소문자-하이픈-slug",
 "summary": "한 문장 증상",
 "failing_cases": ["실제로 실패한 사례 (record/sense/후보 등)"],
 "reproduction": "재현 명령 또는 절차",
 "suspected_layer": "의심되는 공유 계층(파일·검증기·프롬프트 등)"}
```

선택 필드(`root_cause`, `scope`, `proposed_fix`, `regression`)는 알고 있을 때만 넣는다. 넣었다면 비어 있으면 안 된다.

PR 리뷰어는 같은 JSON을 리뷰 본문의 ```` ```warroom-shared-defect ```` 코드 블록으로 남겨 에스컬레이션할 수 있다(신뢰된 리뷰어의 `-1` 만 유효).
