이전 Maintainer 실행이 중단되어 같은 Issue·worktree·branch·session에서 이어서 진행한다 (Issue #{{issue}}, branch {{branch}}).
새 Issue, 배치, task, branch를 선택하지 않는다. .warroom-scratch/incident-diagnosis-request.json을 읽어 현재 attempt·round·event·원본 batch·task scope·source HEAD·evidence SHA를 확인하고, .warroom-scratch/incident/<defect_id>.json 및 기존 작업물을 보존한다.

먼저 최신 worktree 상태와 이미 열린 PR을 확인한다. 기존 PR이 있으면 현재 Issue의 구현과 리뷰 수정을 이어가고 같은 PR만 유지한다. PR이 아직 없으면 기존 run log, 조사 메모와 uncommitted 작업을 버리지 말고 실제 원인을 계속 조사한다. 코드 수정이 필요하면 공통 원인을 고쳐 하나의 PR을 만든다. 원인이 원 task의 입력·저장 판정 실수이면 그 정확한 task와 chunk만 지목해 근거를 대조한다. C/D/Stage 2/Stage 3 task의 저장·checkpoint·session 경계를 임의로 바꾸지 않는다.

이전 round가 investigate였으면 댓글의 concrete next action부터 수행한다. 같은 세션에서 더 조사할 단계가 남았을 때만 새 structured result를 제출한다. PR 생성 실패, 인증 실패, AI의 정상 종료는 no-code 결과가 아니다. 조사 미완료를 같은 결과로 반복하지 말고, 새로 확인된 사실과 다음 차이를 기록한다.

현재 PR이 없고 원인과 복구가 확정되면 .warroom-scratch/incident-diagnosis.json에 새 structured result를 원자적으로 쓴다. 요청 파일 값과 정확히 같은 issue, attempt, round, defect_id, event_key, batch_id, source_head, evidence_sha256를 넣고, scope에는 exact task와 chunk를 넣는다. outcome은 no_code_resume, investigate, external, undetermined 중 하나다. no_code_resume은 evidence의 `task_report`가 지정한 자동 보고 task에 recovery.type=resume_report_task와 동일 task/chunk를, 그 외 검증된 FAILED task에 resume_failed_task와 동일 task/chunk를, legacy serial에 resume_same_session와 같은 활성 chunk를 사용한다. investigate는 recovery.type=continue_same_session과 concrete action을 사용한다. external은 recovery.type=external_prerequisite와 dependency를 구체화한다. undetermined는 Supervisor가 재검증 가능한 구체적 증거 blocker가 있을 때만 쓴다.

같은 Issue에 summary·cause·action·next action·evidence SHA를 댓글로 남기고 마지막 줄에 정확한 marker <!-- warroom-defect-event:incident-recovery-{{issue}}-attempt-<attempt>-round-<round> --> 하나만 둔다. 이전 attempt 또는 round의 marker를 복사하지 않는다. no-code·external·undetermined handoff는 Maintainer worktree를 clean하게 유지한다. production DB, 원 batch worktree/checkpoint, 다른 task의 결과는 직접 수정하지 않는다.

코드 수정이 필요하면 이 branch에서 commit·push하고 Closes #{{issue}} PR 하나를 만든다. 현재 Issue labels를 PR에 복사한다. 리뷰 요청·승인·merge는 하지 않는다. PR 준비 후 불필요한 상태 조회 없이 종료한다. PR 없는 structured 결과가 완료되더라도 원 batch가 해결됐다고 주장하지 않는다. no-code resume 후 원 task의 official SAVED 진전은 Supervisor만 확인한다.
