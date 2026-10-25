# 공통 결함(Shared defect) 보고 형식 — War Room이 생산 프롬프트에서 가리키는 문서

해당 조건: 작업 중 **반복 가능한 공통 결함**을 확인했을 때만 보고한다. 생산 프롬프트·검증기·빌드·프로세스 같은 공유 계층의 오류로,
서로 다른 실제 실패 사례가 둘 이상 있어야 한다. 후보 한 건의 오류·논쟁, 일반 CLI/인증/네트워크 문제는 보고 대상이 아니다.
확실한 근거가 없으면 보고하지 말고 평소대로 진행한다.

보고 방법: 아래 JSON을 worktree의 `.warroom-scratch/shared-defect.json` 에 쓰고 **즉시 작업을 멈춘다**.
War Room이 이 배치만 PAUSED 로 두고(작업물·브랜치·세션 보존) urgent Issue를 등록한 뒤, 수정이 머지되고 반영되면 같은 배치를 자동으로 재개한다.
이 보고는 Method A/B/C/D 규칙과 Candidate 계약을 바꾸지 않는다.

```json
{"version": 1, "defect_class": "소문자-하이픈-slug",
 "summary": "한 문장 요약",
 "failing_cases": ["실제 실패 사례 1", "실제 실패 사례 2"],
 "reproduction": "재현 방법",
 "root_cause": "공통 계층과 원인",
 "scope": "기존 및 향후 배치 적용 범위",
 "proposed_fix": "제안 수정",
 "regression": "새로 필요한 공유 회귀 검증"}
```

PR 리뷰어는 같은 JSON을 리뷰 본문의 ```` ```warroom-shared-defect ```` 코드 블록으로 남겨 에스컬레이션할 수 있다(신뢰된 리뷰어의 `-1` 만 유효).
