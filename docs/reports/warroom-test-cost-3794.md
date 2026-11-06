# War Room 테스트 메서드별 비용 감사 — #3794

## 요약

이번 감사는 이슈의 8개 후보 파일만 조사했다. 현재 unittest discovery 모집단은 **306개 메서드**다. 각 메서드를 한 번 실행해 기능과 시간을 확인하고, 고유한 현재 불변식을 지키는 **301개 메서드는 유지**로 분류했다. 별도 상세 평가가 필요한 후보는 5개다.

첫 5개 상세 후보의 조치는 통합 2건, 경량화 2건, 제거 검토 1건이다. 제안한 작업이 모두 채택될 경우 한 번의 전체 War Room Python 실행에서 **약 1.9–2.4초**를 절감할 것으로 추정한다. 추가 #1555 보완 감사에서는 고유 assertion을 유지하는 fixture 재사용 3건(추가 0.23–0.30초)과 보류 중인 tick 경량화 가능성(0.10–0.19초 상한 추정)을 확인했다. 모든 수치는 전망이며 변경 전후 개선으로 측정하거나 주장하지 않는다.

이슈가 제공한 후보 스위트 합계 85.01초와 비교할 때 이번 checkout에서는 8개 스위트가 77.40초 걸렸다. 실행 환경과 현재 코드의 차이가 포함되므로 이 차이를 최적화 효과로 해석하지 않는다. 후보 파일 외부의 전체 Python suite는 실행하지 않았다. 이슈에 제공된 전체 228초 기준선은 프로세스 관련 6개 테스트가 실패한 상태이므로 녹색 기준선이 아니다.

## 범위와 실행 조건

- 기준: 최신 remote master와 일치한 HEAD **db30a5bbc93d9bdab572b347b35ef7a0d22c42e7**.
- 환경: macOS 26.6.2 arm64, Python 3.15.0, Node 24.19.0, Git 2.53.0. War Room 경로에서 python3는 /opt/homebrew/bin/python3로 해석되며 .local/venv는 없었다.
- 선택 방식: 작업 디렉터리 tools/warroom에서 Python unittest의 현재 모듈 discovery 순서를 유지한 직렬 실행. PYTHONDONTWRITEBYTECODE=1로 대상 8개 모듈을 한 Python 프로세스에서 실행했다. 이 디렉터리의 python3 선택은 run-tests.mjs와 같고, Python의 현재 작업 디렉터리에서 모듈을 import했다. 초기 계측에서 report body에 적힌 Python 3.11.10은 저장소 루트에서 별도로 확인한 값이라 잘못 표기됐고, 여기서 정정한다. 모든 테스트 계측은 War Room 경로의 Python 3.15.0으로 실행됐다. 시간은 startTest부터 stopTest까지 측정하여 메서드의 setUp, 본문, tearDown을 포함한다. 모듈 import와 클래스 단위 fixture 시간은 메서드 값에서 제외된다. 스위트 시간은 해당 모듈의 unittest suite 실행 구간이다.
- 반복: 306개 모집단은 1회 전체 측정했다. 상세 후보 5개와 대표적인 core 대조군 3개를 3회 더 실행했다. 총 330회 실행에서 실패와 오류는 없었다. 반복 후보의 표준편차 대신 최소/중앙/최대값을 기록한다.
- 저장소 변경: 코드, 테스트, CI는 수정하지 않았다. node tools/warroom/run-tests.mjs 전체 suite의 통과를 주장하지 않는다.

## 현재 모집단과 분류

| 파일 | 전체 메서드 | Core/유지 | 상세 후보 | 스위트 실행시간(s) | 결과 |
|---|---:|---:|---:|---:|---|
| test_issue_1555.py | 98 | 98 | 0 | 38.23 | 98 통과 |
| test_issue_2034_d.py | 48 | 48 | 0 | 9.26 | 48 통과 |
| test_lines.py | 36 | 35 | 1 | 6.55 | 36 통과 |
| test_issue_2033_c.py | 42 | 42 | 0 | 7.26 | 42 통과 |
| test_issue_1684.py | 36 | 35 | 1 | 5.80 | 36 통과 |
| test_reload.py | 10 | 7 | 3 | 2.84 | 10 통과 |
| test_issue_2092.py | 24 | 24 | 0 | 4.23 | 24 통과 |
| test_issue_3129.py | 12 | 12 | 0 | 3.24 | 12 통과 |
| **합계** | **306** | **301** | **5** | **77.40** | **306 통과** |

상세 후보 판정: 통합 2, 경량화 2, 제거 검토 1, 보류 0. 스위트 합계는 메서드 시간의 균등 배분값이 아니다. 상세 표의 각 메서드 값을 별도 계측했다.

## 메서드별 상세 평가

| 파일 / Class.test_method | 현재 기능과 기대 실패 | 실행시간(s; 반복/환경) | 시간 원인 | 평가 | 중복/대체 테스트의 정확한 이름과 assertion 근거 | 권장 조치·회귀 위험 | 예상 절감(s) 및 근거 |
|---|---|---:|---|---|---|---|---:|
| test_lines.py / ElapsedDisplay.test_maintainer_card_uses_the_same_elapsed_union | Maintainer 카드의 elapsed가 겹치는 실행 구간을 한 번만 계산하는지 확인한다. union 계산이 다르면 card.elapsed가 600초와 달라진다. | 0.0642 / **0.0664** / 0.0680 (n=3, 동일 환경) | World와 SQLite 준비, run interval 생성, 시간 고정 후 maintainer_card 호출. Git·Node subprocess·sleep 없음. | 통합 | test_lines.ElapsedDisplay.test_board_web_and_detail_share_batch_elapsed는 일반 producer의 status, board, web detail, usage가 같은 union 값을 쓰는지 확인한다. 현재 Maintainer assertion은 그 메서드에 없다. | 위 producer projection 메서드에 Maintainer row와 card.elapsed assertion을 옮기고 두 번째 World/DB 준비를 없앤다. Maintainer projection assertion은 반드시 보존한다. 다른 surface를 한 fixture에서 실행할 때 상태 오염이 없는지 확인할 필요가 있다. | **0.02–0.06**. 기존 메서드의 0.0664초 중앙값이 상한이며, 통합 후 실제 시간은 아직 측정하지 않았다. |
| test_issue_1684.py / StageTwoSelection.test_last_shard_short_batch_two_is_a_single_83_record_part | 583-record shard를 100-record legacy layout으로 가정해 5개 + 1개의 Part를 완료한다. 마지막 Part 뒤 추가 실행이 없어야 한다. | 0.2899 / **0.3017** / 0.3146 (n=3, 동일 환경) | 가짜 Stage 2 World, 선택·Part 완료 및 tick(2). 실제 Git 없음. 테스트는 583-record shard를 shard 001로 합성한다. | 제거 검토 | test_issue_1684.StageTwoPartLayout.test_last_shard_shape_is_three_parts_in_the_new_layout은 현재 250-record layout의 500+83 실제 tail과 마지막 Part 83을 확인한다. test_issue_1684.StageTwoPartLayout.test_legacy_shard_keeps_five_100_record_parts_and_never_gets_a_marker는 legacy layout의 현재 완전한 500-record 배치를 확인한다. test_issue_1684.StageTwoSelection.test_batch_and_shard_verify_close_the_last_part는 마지막 Part 이후 batch/shard 완료를 확인한다. | 현재 config는 shard 001–005만 100-record layout이고, 이 Canonical shard들은 각각 1000 records다. shard 428은 583 records이며 250-record layout을 쓴다. 따라서 shard 001에 583 records를 놓은 테스트는 현재 데이터/설정 경로에 없다. 이 메서드만 제거 후보로 삼고 일반 part_count 처리는 그대로 둔다. 위험은 이후 legacy shard의 실제 record 수가 바뀌는 경우다. | **0.29–0.31**. 메서드 중앙값은 0.3017초. 이번 변경 전후 실측은 하지 않았다. |
| test_reload.py / ReloadTable.test_valid_and_invalid_inputs | 18개 JSON 입력을 reload 경로에 차례로 넣어 성공 여부, 오류 문자열, 기존 config 보존을 확인한다. 잘못된 구조나 restart-only 변경이 수용되면 실패한다. | 0.5969 / **0.5994** / 0.6167 (n=3, 동일 환경) | World/SQLite 준비 후 18개 사례를 파일에 쓰고 각 사례마다 실제 reload tick. accepted 행은 config reset과 재 reload도 수행한다. Git·sleep 없음. | 경량화 | test_reload.ReloadTable.test_reload_problem_is_pure_and_covers_restart_keys는 RESTART_KEYS와 in-use adapter 변경을 reload_problem에서 직접 검사한다. test_reload.ReloadUnblocksAndRuns.test_unregistered_model_block_is_cleared_and_the_line_starts_after_reload는 새 모델 config를 실제 적용하고 다음 run에서 쓰는지 검사한다. test_reload.ReloadUnblocksAndRuns.test_rejected_reload_keeps_the_block_and_the_old_config는 거부된 reload가 기존 config와 block을 유지하는지 확인한다. | JSON parse/top-level 실패, accepted legacy config 한 건, fail-closed reload 한 건은 실제 reload 경로에 남긴다. 나머지 값 검증은 기존 config_problem/reload_problem 순수 검증 메서드에 옮긴다. 기존 오류 문자열 표 전체를 없애면 특정 진단 문구 회귀 감지가 줄 수 있으므로 핵심 문구 몇 개는 남긴다. | **0.40–0.55**. 현재 0.5994초에서 실제 reload 사례 2–3개와 오류 단언을 남기는 조건으로 추정한다. |
| test_reload.py / RuntimeValueTypes.test_table | 41개 숫자·타입 입력을 실제 reload에 적용한다. 잘못된 값은 이전 config를 바꾸지 않아야 하고 허용값은 새 config에 적용되어야 한다. | 1.0976 / **1.1590** / 1.2596 (n=3, 동일 환경) | World/SQLite와 초기 reload 이후 각 subTest가 config 파일을 쓰고 tick으로 실제 reload한다. 성공행은 원래 config를 복원하고 reload를 한 번 더 실행한다. Git·sleep 없음. | 경량화 | test_reload.RuntimeValueTypes.test_start_applies_the_same_check는 동일한 NUMERIC 41개 값에 대해 config_problem을 이미 검사한다. test_reload.ReloadUnblocksAndRuns.test_rejected_reload_keeps_the_block_and_the_old_config와 test_reload.RuntimeValueTypes.test_consumers_keep_working_after_a_rejected_reload는 실제 reload의 fail-closed/기존 소비자 동작을 검사한다. | 중복 41개 reload 적용은 없애고 이미 존재하는 순수 config_problem matrix를 사용한다. 별도 integrated example이 필요하면 기존의 거부·정상 적용 테스트만 유지한다. 값별 pure 검사 없이 삭제하면 type 회귀를 놓칠 수 있으므로 assertion은 반드시 남긴다. | **0.95–1.16**. 이미 같은 41개 값을 검증하는 순수 테스트가 있으므로 중복 reload 비용이 상한 근거다. |
| test_reload.py / RuntimeValueTypes.test_nested_producer_entries | 10개 producer 객체 안의 model, effort, label, adapter, models 형태를 reload로 검증하고 잘못된 값이 config를 교체하지 않는지 확인한다. | 0.2833 / **0.2843** / 0.3140 (n=3, 동일 환경) | World/SQLite 준비 후 config를 파일로 쓰고 reload tick을 각 사례에 수행한다. accepted 행은 원래 값을 복구하고 reload한다. Git·sleep 없음. | 통합 | test_reload.RuntimeValueTypes.test_start_applies_the_same_check는 같은 config_problem 입력을 pure하게 검사하는 현행 메서드다. test_reload.ReloadTable.test_valid_and_invalid_inputs와 test_reload.ReloadUnblocksAndRuns.test_rejected_reload_keeps_the_block_and_the_old_config가 실제 reload 경계의 대체 근거다. | producer-specific 행을 test_start_applies_the_same_check의 pure matrix에 합치고 이 별도 reload loop를 없앤다. nested producer 각각의 type assertion은 유지한다. | **0.22–0.28**. 현재 메서드 전체 시간이 상한이며, 합친 pure matrix의 실행시간은 아직 측정하지 않았다. |

## 우선순위와 결정

후보 5개는 실제 중앙 wall time 기준으로 다음 순서다. 5개 후보의 중앙값 합계는 2.411초지만 이 값은 현재 메서드 총 실행시간이지 순절감 예측값은 아니다.

| 순위 | 메서드 | 중앙값(s) | 추천 |
|---:|---|---:|---|
| 1 | RuntimeValueTypes.test_table | 1.1590 | 동일한 41개 값을 이미 검사하는 config_problem matrix로 대체. 회귀 위험이 가장 낮고 예상 절감이 가장 크다. |
| 2 | ReloadTable.test_valid_and_invalid_inputs | 0.5994 | pure config/reload 판정으로 입력표 이동; JSON parsing 및 fail-closed integrated case는 유지. |
| 3 | StageTwoSelection.test_last_shard_short_batch_two_is_a_single_83_record_part | 0.3017 | 현재 데이터/legacy layout에서 불가능한 합성 shard 입력 제거 검토. 현재 새 layout tail은 계속 검증. |
| 4 | RuntimeValueTypes.test_nested_producer_entries | 0.2843 | 기존 pure type matrix에 통합하고 nested type assertions 보존. |
| 5 | ElapsedDisplay.test_maintainer_card_uses_the_same_elapsed_union | 0.0664 | producer projection 테스트와 World 준비를 공유하되 Maintainer 카드 assertion 보존. |

현재 증거에 따른 우선 조치는 reload matrix 경량화다. 모든 권고를 후속 구현하면 약 1.9–2.4초/전체 War Room suite의 절감을 기대할 수 있다. 대략 77.40초의 이번 후보 suite 실행시간 중 2.5–3.1%다. 실제 절감은 후속 최적화 PR에서 녹색 상태와 함께 다시 측정해야 한다.

| 결정 경로 | 이번 감사의 판단 |
|---|---|
| 바로 제거 검토 가능 | StageTwoSelection의 100-record layout + 583-record shard 합성 사례 1개. 실제 current path와 대조 후 해당 메서드만 제거 검토. |
| assertion 이전 후 통합 | reload nested producer type matrix를 기존 pure config_problem matrix로 옮김; Maintainer elapsed assertion을 일반 elapsed projection 테스트에 옮김. |
| fixture/tick 경량화 | 동일 41개 숫자·타입 검사를 reload tick 대신 pure config_problem으로 수행; 18개 reload table에서 JSON parse/실제 적용/fail-closed 대표 경계만 실제 reload로 남김. |
| 운영 호환성 확인 전 보류 | legacy D baseline, C closed-PR history, C chunk-scope guard는 현행 production caller가 있으므로 제거 후보로 두지 않았다. #3129의 legacy 이름만 보고 지원 종료로 판단하지 않았다. |

## Core/유지로 제외한 근거

- test_issue_1555.py는 현재 98개 메서드다. #2995 당시 표의 46개 정의를 이번 모집단에 재사용하지 않았다. 상위 비용인 IncidentRecoveryProof.test_changed_or_unobserved_state_holds는 HEAD/remote/checkpoint/unknown-observation 네 가지 독립 재증명 실패를 확인하며 중앙값 1.3772초다. 이를 대체하는 같은 assertion이 없어 core로 남겼다.
- test_issue_2034_d.py의 legacy_missing_baseline 세 경로는 이름만 오래된 상태가 아니다. Supervisor._d_legacy_handoff_problem은 현재 supervisor 경로에서 호출되어 완료 chunk, SHA, run 종료, worktree/branch, 원격 ref를 다시 증명한다. restart/cleanup 중단 지점도 서로 다른 persisted state를 확인하므로 제거하지 않았다.
- test_issue_2033_c.py의 old closed PR 사례는 현재 _find_pr/_find_recovery_pr 호출에서 새 PR, merged PR, 같은 HEAD의 closed PR, mismatch를 구분하는 실행 경계다. closed history를 전부 정리 대상으로 단정하지 않았다.
- test_issue_1684.py는 config/stage2-part-layout.json의 고정 layout marker와 두 layout을 보호한다. legacy shard 001–005와 새 layout 006–428은 실제 운영 계약이므로 범위에 맞는 테스트를 유지한다. 상세 후보는 새 layout에 없는 합성 583/100 사례 하나다.
- test_issue_2092.py의 transient classifier, gh API classifier, git ls-remote 결과표는 서로 다른 호출 계약을 확인한다. 개별 표는 0.0001–0.0028초라 삭제해도 측정 가능한 절감이 없고 분류 경계를 약화한다.
- test_issue_3129.py의 legacy scope/stop guard는 cparallel.py의 auto_recover_legacy_scope_error와 Supervisor 재진입 경로에서 현재 사용된다. 기존 데이터나 CLI 상태의 지원을 끊지 않도록 12개 모두 유지했다.
- test_lines.py의 Drain/Stop/line isolation/공유 C-D queue, DB migration, tailing·secret redaction, elapsed union 및 producer UI surface는 각각 별도 caller·데이터 보존·표시 경계가 있다. 상세 후보는 두 번째 World 준비를 줄일 여지가 있는 Maintainer card 메서드 하나다.

## #2995와 다른 점

#2995는 과거 master의 39개 파일 전수 정리다. 이번 작업은 최신 HEAD에서 #3794가 지목한 8개 파일만 현재 메서드별로 다시 발견하고 실행했다. 예전 분류를 가져오지 않았고 이름에 issue 번호나 legacy가 있다는 이유만으로 제거하지 않았다. 이번 5개 후보 모두 실제 현재 호출자 또는 대체 assertion을 확인했다.

## 성능 효과와 CI 범위

이번 보고서의 추정 절감은 **한 번의 War Room Python suite 실행**에 한정된다. .github/workflows/ci.yml에서 War Room suite는 run_warroom_tests=true일 때만 실행되며, scripts/ci/changed-files.mjs의 War Room 분류 경로는 tools/warroom 및 War Room entrypoint다. 이 보고서 파일 경로는 그 경로가 아니므로 보고서 PR은 docs-only CI 분류가 예상된다. 따라서 이번 PR CI가 해당 Python suite를 통과시킨다고 표현하지 않는다.

후속 최적화 PR의 비교 방법: 같은 OS/Python/Node, 동일한 테스트 선택, 정상 종료 기준으로 8개 대상 스위트 합계를 기록하고, 전체 node tools/warroom/run-tests.mjs도 녹색인 조건에서 전체 시간과 수집 수를 비교한다. 각 후보의 동일 조건 n=3 중앙값과 CI exact-head 결과를 함께 보고한다. 분류 gate나 안전성 테스트 선택은 이번 보고서에서 변경하지 않았다.

## 테스트 메서드 모집단 목록

상세 후보 5개는 위 표에 기록했다. 아래 접기 영역에는 상세 심사를 제외한 core/유지 301개 메서드 전체를 파일·클래스별로 나열하여 이번 발견 모집단을 재현 가능하게 했다.


<details>
<summary>Core/유지 메서드 전체 목록 (301)</summary>

### tests.test_issue_1555 (98)
- AutonomousIncident.test_a_fabricated_blocker_does_not_release_the_slot
- AutonomousIncident.test_a_failing_report_keeps_the_error
- AutonomousIncident.test_any_error_without_structured_evidence_is_received_with_that_item_missing
- AutonomousIncident.test_approved_integration_error_keeps_its_evidence_and_is_received_by_the_sweep_once
- AutonomousIncident.test_classification_without_a_proven_blocker_keeps_the_maintainer_error
- AutonomousIncident.test_diagnosis_missing_or_with_a_commit_keeps_the_existing_error
- AutonomousIncident.test_diagnosis_retry_requires_undetermined_outcome_and_unchanged_incident_state
- AutonomousIncident.test_fix_to_supervisor_code_waits_until_the_running_process_has_it
- AutonomousIncident.test_noncritical_unknown_observation_does_not_prove_an_evidence_blocker
- AutonomousIncident.test_prior_attempt_marker_cannot_authorize_a_new_handoff
- AutonomousIncident.test_proven_evidence_blocker_hands_off_but_does_not_resolve_production
- AutonomousIncident.test_retry_diagnosis_does_not_accept_a_previous_attempt_marker
- AutonomousIncident.test_two_batches_are_two_issues_never_merged_by_class
- AutonomousIncident.test_undetermined_diagnosis_has_an_explicit_retry_that_only_relinks_the_paused_incident
- AutonomousIncidentReview.test_diagnosis_cleanup_survives_a_crash_before_the_state_transaction
- AutonomousIncidentReview.test_evidence_is_explicit_atomic_and_required
- AutonomousIncidentReview.test_evidence_write_failure_does_not_start_the_maintainer
- AutonomousIncidentReview.test_legacy_diagnosis_marker_does_not_bypass_the_new_handoff_proof
- AutonomousIncidentReview.test_outcomes_are_reported_once_per_phase
- AutonomousIncidentReview.test_unprovable_code_load_waits
- FailClosed.test_closed_batch_pr_holds
- FailClosed.test_closed_issue_without_a_fix_is_not_a_release
- FailClosed.test_configured_verification_commands_must_pass
- FailClosed.test_conflict_holds_the_batch_with_its_reason_and_never_retries
- FailClosed.test_failed_verification_holds
- FailClosed.test_pr_head_mismatch_holds
- FailClosed.test_transient_git_error_is_retried_not_held
- FailClosed.test_unmerged_close_of_the_maintainer_pr_never_releases
- FailClosed.test_verification_is_derived_from_the_fix_and_fails_closed
- FailClosed.test_wrong_head_branch_or_missing_merge_commit_holds_the_issue_task
- IdempotentIssue.test_failed_create_keeps_everything_then_a_crash_after_create_links_instead_of_duplicating
- IdempotentIssue.test_same_event_twice_and_restart_create_one_issue_and_one_defect
- IdempotentIssue.test_second_batch_of_the_same_class_joins_the_open_issue
- IdempotentIssue.test_unreachable_github_never_loses_the_report
- IncidentNumberAndIntake.test_a_b_maintainer_stop_and_clearing_are_never_received
- IncidentNumberAndIntake.test_a_live_process_or_task_run_defers_the_intake_and_a_conflicting_owner_blocks_it
- IncidentNumberAndIntake.test_a_prepare_error_without_a_worktree_is_received_with_missing_observations
- IncidentNumberAndIntake.test_an_unobservable_item_is_unknown_not_a_blocked_intake
- IncidentNumberAndIntake.test_batches_without_a_number_are_not_received_and_are_listed_once
- IncidentNumberAndIntake.test_credentials_in_an_error_never_reach_github_but_stay_in_the_local_record
- IncidentNumberAndIntake.test_defect_hold_and_stop_pin_each_block_and_an_emptied_hold_does_not
- IncidentNumberAndIntake.test_envelope_failure_keeps_the_error
- IncidentNumberAndIntake.test_error_evidence_of_an_event_keeps_its_first_record
- IncidentNumberAndIntake.test_one_sweep_receives_c_d_stage2_stage3_through_any_error_path
- IncidentNumberAndIntake.test_operator_clear_overrides_the_incident_and_the_maintainer_is_not_started
- IncidentNumberAndIntake.test_operator_controls_win_inside_the_pausing_transaction
- IncidentNumberAndIntake.test_repeated_ticks_other_events_and_other_batches
- IncidentNumberAndIntake.test_the_number_counts_transitions_and_keeps_the_first_values
- IncidentRecoveryProof.test_a_failed_held_reproof_waits_for_another_code_change
- IncidentRecoveryProof.test_a_failed_pre_run_guard_holds_and_leaves_the_first_head_and_chunks_alone
- IncidentRecoveryProof.test_a_held_incident_is_reproved_after_the_code_checkout_changes
- IncidentRecoveryProof.test_a_prepare_error_without_a_worktree_resumes_on_a_runtime_fix_only
- IncidentRecoveryProof.test_a_prompt_the_resumed_launch_does_not_render_holds
- IncidentRecoveryProof.test_a_run_kind_without_a_pre_runnable_guard_is_held_before_any_integration
- IncidentRecoveryProof.test_an_unmodelled_run_kind_cannot_prove_prompt_delivery
- IncidentRecoveryProof.test_changed_or_unobserved_state_holds
- IncidentRecoveryProof.test_parallel_d_integration_keeps_the_first_head_and_passes_both_guards
- IncidentRecoveryProof.test_parallel_d_retry_with_one_used_fix_predicts_and_launches_the_fix_prompt
- IncidentRecoveryProof.test_prompt_only_fix_resumes_without_restart_integration_or_line_flag_change
- IncidentRecoveryProof.test_python_fix_waits_for_the_loaded_code_then_resumes
- IncidentRecoveryProof.test_same_structured_evidence_after_the_fix_is_not_received_again_and_says_so_once
- IncidentRecoveryProof.test_serial_c_keeps_the_checkpoint_head_and_resumes_on_the_run_baseline
- IncidentRecoveryProof.test_serial_d_integration_moves_only_the_run_baseline_and_the_resume_guard_passes
- IncidentRecoveryProof.test_stage2_deterministic_finalize_does_not_claim_other_prompts
- IncidentRecoveryProof.test_stage2_deterministic_finalize_releases_for_repair_prompt_only
- IncidentRecoveryProof.test_stage2_links_use_their_own_baseline_key
- IncidentRecoveryProof.test_stage2_repair_exhausted_retry_budget_holds_prompt_fix
- IncidentRecoveryProof.test_stage2_repair_pending_answer_is_not_claimed_as_new_prompt
- IncidentRecoveryProof.test_stage2_repair_rejected_answer_can_render_repair_prompt
- IncidentRecoveryProof.test_the_prompt_must_be_in_the_main_checkout_and_clean
- IncidentRecoveryProof.test_waiting_review_resumes_on_an_open_owned_pr_and_holds_on_an_unmerged_close
- MaintainerConfig.test_a_started_task_keeps_its_producer_across_maintainer_target_change_and_restart
- MaintainerConfig.test_config_table
- MaintainerConfig.test_invalid_producer_entry_blocks_the_maintainer_never_another_model
- OperatorControls.test_stop_then_retry_is_an_explicit_override_and_blocks_the_automatic_release
- RealGitIntegration.test_conflict_is_aborted_and_leaves_the_worktree_untouched
- RealGitIntegration.test_diagnosis_cleanup_never_force_deletes_an_unmerged_branch
- RealGitIntegration.test_fix_is_merged_and_partial_output_and_commits_survive
- RealGitIntegration.test_only_commits_on_the_base_branch_foreign_or_unregistered_paths_are_accepted
- RealGitIntegration.test_supervisor_resumes_a_paused_batch_on_a_real_worktree_after_the_real_integration
- RealGitIntegration.test_uncommitted_change_in_a_file_the_fix_touches_is_refused_not_overwritten
- ReportEvidence.test_a_finished_ai_with_a_report_is_paused_not_reported_as_a_missing_pr
- ReportEvidence.test_a_report_being_written_is_not_acted_on_until_stable
- ReportEvidence.test_insufficient_evidence_holds_the_batch_without_an_issue_and_retry_resumes
- ReportEvidence.test_ordinary_failures_are_not_shared_defects
- ReportEvidence.test_valid_but_unusual_reports_are_accepted
- ResolvedReportResume.test_changed_report_is_not_archived_and_pauses_as_new_evidence
- ResolvedReportResume.test_exit_zero_without_pr_after_release_names_the_cause_and_never_restarts
- ResolvedReportResume.test_resolved_report_is_archived_and_the_resume_prompt_carries_the_evidence
- ResolvedReportResume.test_same_report_written_again_after_release_is_new_evidence
- ReviewEscalation.test_malformed_review_block_holds_without_an_issue
- ReviewEscalation.test_trusted_reviewer_block_pauses_instead_of_fixing_and_the_review_is_fixed_after_release
- SerialMaintainer.test_one_fix_releases_every_batch_of_its_issue_once_each
- SerialMaintainer.test_one_maintainer_at_a_time_in_issue_order
- SerialMaintainer.test_released_batch_resumes_in_its_original_phase_with_its_pr
- SharedDefectFlow.test_only_the_reporting_batch_pauses
- SharedDefectFlow.test_report_to_single_retry_after_merge_and_cleanup
- SharedDefectFlow.test_unconfigured_maintainer_keeps_report_issue_and_pause_but_runs_nothing

### tests.test_issue_2034_d (48)
- CommitRecovery.test_restart_between_commit_and_recording_resumes_but_arbitrary_head_does_not
- Finalization.test_failed_pr_creation_keeps_commit_and_push_and_retry_does_not_repeat_them
- Finalization.test_lost_pr_response_never_creates_a_second_pr
- Finalization.test_moved_remote_branch_is_an_error_without_force
- Finalization.test_occupied_batch_by_another_model_stops_instead_of_switching_batches
- Finalization.test_unintended_tracked_change_blocks_the_commit
- Finalization.test_validation_failure_is_an_error_without_commit_or_rewrite_session
- LegacyRejectionRepair.test_malformed_or_unsupported_rejection_files_block_retry_without_rewrite_or_launch
- LegacyRejectionRepair.test_old_stop_diagnostic_is_reissued_only_after_current_cli_proves_identical_local_errors
- LegacyRejectionRepair.test_search_failure_evidence_mismatch_and_head_drift_block_reissue_without_launch
- Prompts.test_d_chunk_prompt_requires_explicit_record_binding_on_each_sense_row
- Prompts.test_d_worker_prompts_keep_prepare_supervisor_only
- Prompts.test_d_worker_prompts_use_latest_search_state_over_the_prepare_snapshot
- Prompts.test_exactly_one_of_view_or_pages_and_the_card_binds_the_save_call
- Prompts.test_resume_delivers_verified_view_inline_or_as_pages
- RestartHandoff.test_last_chunk_restart_runs_idempotent_finalizer_once
- RestartHandoff.test_legacy_missing_baseline_recovers_only_with_complete_run_and_sha_evidence
- RestartHandoff.test_legacy_missing_baseline_rejects_an_owned_pr_before_any_new_run
- RestartHandoff.test_legacy_missing_baseline_rejects_unproven_or_ambiguous_state
- RestartHandoff.test_prepare_with_next_chunk_baseline_fails_closed_without_launch
- RestartHandoff.test_restart_after_cleanup_before_prepare_marker_uses_existing_baseline
- RestartHandoff.test_restart_after_old_baseline_deletion_starts_only_the_next_chunk
- RestartHandoff.test_restart_after_prepare_persisted_but_before_baseline_delete_is_idempotent
- SaveRejectedFix.test_completed_chunks_are_untouched_by_a_later_chunks_fix
- SaveRejectedFix.test_nonzero_exit_with_a_repairable_rejection_is_corrected_not_paused
- SaveRejectedFix.test_operator_retry_regrants_one_correction_before_the_local_fallback
- SaveRejectedFix.test_repairable_rejection_resumes_the_same_session_once_then_continues
- SaveRejectedFix.test_repeated_record_local_rejection_skips_only_that_record_and_continues
- SaveRejectedFix.test_unrepairable_or_stale_diagnostics_start_no_ai
- SerialChunks.test_all_zero_hit_chunk_is_saved_without_an_ai_session
- SerialChunks.test_cleanup_failure_blocks_next_chunk_and_preserves_saved_and_active_files
- SerialChunks.test_damaged_saved_chunk_is_never_cleaned_or_advanced
- SerialChunks.test_editing_a_saved_chunk_is_an_error
- SerialChunks.test_head_and_remote_changes_during_a_run_are_errors
- SerialChunks.test_new_session_per_chunk_inline_view_then_one_pr
- SerialChunks.test_oversize_view_falls_back_to_pages_for_that_chunk_only
- SerialChunks.test_restart_after_cleanup_finishes_handoff_without_resuming_the_old_session
- SerialChunks.test_saved_chunk_survives_an_unclean_exit_and_is_never_produced_again
- SerialChunks.test_search_failed_pauses_before_any_ai
- SerialChunks.test_verified_chunk_cleanup_is_scoped_and_the_next_chunk_starts_a_new_session
- SerialChunks.test_zero_exit_without_saved_chunk_gets_one_retry_and_operator_retry_restores_view
- VerifiedPrefix.test_anomalies_are_errors_not_a_shorter_prefix
- VerifiedPrefix.test_assemble_is_byte_exact_idempotent_and_never_overwrites
- VerifiedPrefix.test_assemble_needs_every_chunk
- VerifiedPrefix.test_explicit_active_chunks_coexist_and_publish_tmp_is_not_damage
- VerifiedPrefix.test_legacy_active_layout_is_preserved_and_blocked
- VerifiedPrefix.test_valid_prefixes
- VerifiedPrefix.test_verified_chunks_allows_gaps_and_waits_only_for_owned_tmp

### tests.test_lines (35)
- DrainAndStop.test_cancel_after_drain_all_changes_only_that_line_and_drain_all_rearms_it
- DrainAndStop.test_controls_landing_between_the_tick_read_and_batch_creation_win
- DrainAndStop.test_drain_all_after_completion_cancels_reservation_without_draining
- DrainAndStop.test_drain_all_allows_retry_of_current_batch
- DrainAndStop.test_drain_all_allows_retry_of_paused_batch_without_starting_another
- DrainAndStop.test_drain_all_and_completion_are_serialized_in_both_orders
- DrainAndStop.test_drain_all_cancels_pending_start_without_draining_empty_lines
- DrainAndStop.test_drain_all_cancels_reservation_and_survives_pause_and_restart
- DrainAndStop.test_drain_all_counts_only_active_nonclearing_production_lines
- DrainAndStop.test_drain_all_drains_only_unfinished_lines_and_preserves_existing_drain
- DrainAndStop.test_line_drain_takes_effect_after_complete_in_continuous_mode
- DrainAndStop.test_retry_waits_for_confirmed_exit_after_stop
- DrainAndStop.test_run_history
- DrainAndStop.test_start_cannot_bypass_line_drain
- DrainAndStop.test_stop_all
- DrainAndStop.test_stop_line_preserves_work_blocks_resume_and_spares_others
- DrainAndStop.test_stop_wins_over_queued_retry
- ElapsedDisplay.test_board_web_and_detail_share_batch_elapsed
- ElapsedDisplay.test_union_cases
- LineIsolation.test_lines_are_independent_and_unbounded
- LineIsolation.test_one_line_exception_does_not_stall_others
- LineIsolation.test_registry_duplicates_blocked
- LineIsolation.test_review_wait_does_not_block_another_line_and_states_do_not_mix
- LineIsolation.test_second_batch_on_occupied_line_is_refused_but_other_methods_start
- Migration.test_legacy_db_is_migrated_without_loss_and_idempotently
- Migration.test_migrated_pending_stop_is_executed_and_pid_kept_until_exit
- Migration.test_pending_legacy_controls_follow_the_unfinished_batch
- SharedCdQueue.test_conflicting_master_files_block_without_launch
- SharedCdQueue.test_every_unfinished_state_of_another_model_occupies_the_batch
- SharedCdQueue.test_other_models_work_occupies_c_d_but_not_a
- SharedCdQueue.test_rival_pr_and_unknown_file_list_fail_closed
- SharedCdQueue.test_same_batch_cannot_be_reserved_by_two_models_for_c_d_only
- TailTests.test_incremental_truncate_partial_and_missing
- TailTests.test_large_log_not_reread_from_start
- TailTests.test_secrets_redacted

### tests.test_issue_2033_c (42)
- CChunkCard.test_card_requires_the_runtime_context_count_placeholder
- CChunkCard.test_card_uses_runtime_context_count_and_groups_only_unseen_senses
- CommitRecovery.test_restart_between_commit_and_recording_resumes_but_arbitrary_head_does_not
- Finalization.test_candidate_repair_with_no_reduction_falls_back_to_empty_exact_sense
- Finalization.test_candidate_repairs_converge_across_more_than_three_distinct_senses
- Finalization.test_candidate_v1_rejection_reopens_only_the_named_senses
- Finalization.test_candidate_validation_without_exact_content_evidence_stops_without_empty_fallback
- Finalization.test_failed_pr_creation_keeps_commit_and_push_and_retry_does_not_repeat_them
- Finalization.test_lost_pr_response_never_creates_a_second_pr
- Finalization.test_moved_remote_branch_is_an_error_without_force
- Finalization.test_occupied_batch_stops_instead_of_switching_batches
- Finalization.test_old_closed_history_does_not_block_saved_chunk_or_new_pr
- Finalization.test_retry_preserves_a_closed_pr_matching_the_current_head_without_creating_another
- Finalization.test_unintended_tracked_change_blocks_the_commit
- PureHelpers.test_affected_senses
- PureHelpers.test_delivery_and_pages_are_lossless
- PureHelpers.test_parallel_header_and_numbered_active_chunks
- PureHelpers.test_view_ids_table
- RecoveryScope.test_other_methods_still_block_unmerged_closed_prs
- SerialChunks.test_c_recovery_keeps_merged_pr_eligible_beside_old_closed_history
- SerialChunks.test_c_recovery_preserves_attached_closed_pr_validation
- SerialChunks.test_changed_checkpoint_progress_unlocks_retry_and_keeps_completed_senses_out_of_resume
- SerialChunks.test_context_key_whitespace_is_repaired_by_normal_submit_before_ai_resubmit
- SerialChunks.test_exact_single_sense_submit_failure_skips_only_that_sense_after_two_resubmits
- SerialChunks.test_final_answer_stop_words_without_official_diagnostic_get_one_recovery
- SerialChunks.test_foreign_checkpoint_head_is_an_error_and_nothing_is_overwritten
- SerialChunks.test_fresh_no_submission_recovery_completes_active_chunk_without_repeating_view_query
- SerialChunks.test_legacy_no_submission_guard_allows_one_owner_retry_without_resetting_budget
- SerialChunks.test_missing_cli_diagnostic_gets_one_same_session_retry
- SerialChunks.test_missing_session_is_a_changed_recovery_condition_for_the_same_chunk
- SerialChunks.test_new_session_per_chunk_inline_view_then_one_pr
- SerialChunks.test_normal_no_submission_gets_one_fresh_session_and_then_fails_closed
- SerialChunks.test_official_stop_and_unknown_submit_evidence_fail_closed_with_distinct_reasons
- SerialChunks.test_only_a_repairable_cli_diagnostic_allows_an_automatic_resume
- SerialChunks.test_oversize_view_falls_back_to_pages_for_that_chunk_only
- SerialChunks.test_recovery_launch_intent_blocks_duplicate_after_crash_before_run_registration
- SerialChunks.test_rejected_submit_file_is_repaired_in_the_same_session_at_most_twice
- SerialChunks.test_repaired_submit_resets_the_budget_and_next_chunk_starts_new
- SerialChunks.test_restart_never_reinitializes_a_checkpoint
- SerialChunks.test_retry_after_partial_checkpoint_ignores_multiple_old_closed_prs_and_resumes_same_chunk
- SerialChunks.test_saved_submit_survives_an_unclean_exit
- SerialChunks.test_search_failed_stops_before_any_ai

### tests.test_issue_1684 (35)
- StageTwoExclusivity.test_only_claude_and_codex_may_run_stage_two
- StageTwoExclusivity.test_other_model_restart_does_not_steal_an_unfinished_part
- StageTwoExclusivity.test_reserved_names_cannot_be_stage_one_methods
- StageTwoExclusivity.test_second_stage_two_start_is_refused_atomically_whatever_the_model
- StageTwoExclusivity.test_stage_one_lines_run_beside_stage_two
- StageTwoExclusivity.test_supervisor_blocks_a_direct_deepseek_stage_two_reservation
- StageTwoLifecycle.test_a_rival_pr_on_the_same_shard_stops_before_review
- StageTwoLifecycle.test_clear_of_a_stage_two_part_closes_only_its_own_pr
- StageTwoLifecycle.test_clear_refuses_a_pr_that_touches_another_shard
- StageTwoLifecycle.test_drain_finishes_the_current_part_then_clears_without_starting_another
- StageTwoLifecycle.test_merge_commit_not_yet_on_master_waits
- StageTwoLifecycle.test_next_part_never_starts_before_merge_and_master_verify
- StageTwoLifecycle.test_stop_preserves_the_part_and_retry_resumes_the_same_batch_and_mode
- StageTwoPartLayout.test_last_shard_shape_is_three_parts_in_the_new_layout
- StageTwoPartLayout.test_legacy_shard_keeps_five_100_record_parts_and_never_gets_a_marker
- StageTwoPartLayout.test_marker_is_committed_with_the_first_part_only_and_a_failed_start_leaves_none
- StageTwoPartLayout.test_marker_with_a_wrong_value_stops_even_with_old_traces
- StageTwoPartLayout.test_new_shard_has_two_250_record_parts_per_batch_and_records_the_layout_marker
- StageTwoPartLayout.test_new_shard_without_marker_stops_on_any_earlier_trace_including_parts_one_and_two
- StageTwoPartLayout.test_unreadable_or_malformed_layout_fails_closed
- StageTwoPromptLoader.test_a_malformed_part_is_refused_by_the_loader
- StageTwoRealGit.test_a_non_detached_directory_is_not_moved
- StageTwoRealGit.test_contains_on_base_is_a_real_ancestry_check
- StageTwoRealGit.test_verify_runs_the_exact_scope_on_exactly_the_given_commit
- StageTwoSelection.test_batch_and_shard_verify_close_the_last_part
- StageTwoSelection.test_completed_part_reconciles_only_when_a_changed_relation_row_owns_its_shard
- StageTwoSelection.test_completed_parts_are_skipped_and_only_exact_verified_parts_count
- StageTwoSelection.test_continuous_goes_on_to_the_next_shard
- StageTwoSelection.test_first_part_names_its_shard_batch_part_and_pins_the_model
- StageTwoSelection.test_nothing_runnable_waits_and_rechecks_without_a_duplicate_run
- StageTwoSelection.test_open_stage_two_pr_in_the_shard_blocks_another_part
- StageTwoSelection.test_pin_is_stored_with_the_part_so_a_restart_stays_in_the_shard
- StageTwoSelection.test_unknown_open_pr_file_list_never_means_no_conflict
- StageTwoSelection.test_unready_inputs_wait_without_skipping_to_another_shard_in_single
- StageTwoSelection.test_unrelated_relation_change_carries_completed_part_without_reverifying_it

### tests.test_reload (7)
- ReloadTable.test_one_request_is_answered_once
- ReloadTable.test_reload_problem_is_pure_and_covers_restart_keys
- ReloadUnblocksAndRuns.test_rejected_reload_keeps_the_block_and_the_old_config
- ReloadUnblocksAndRuns.test_running_batch_uses_reloaded_model_and_effort_on_its_next_run
- ReloadUnblocksAndRuns.test_unregistered_model_block_is_cleared_and_the_line_starts_after_reload
- RuntimeValueTypes.test_consumers_keep_working_after_a_rejected_reload
- RuntimeValueTypes.test_start_applies_the_same_check

### tests.test_issue_2092 (24)
- ABRescue.test_complete_answer_survives_an_abnormal_exit
- ABRescue.test_only_an_exact_current_begin_marker_routes_malformed_nonzero_answers_to_existing_fix
- Classifier.test_gh_client_failures_are_transient_unless_local
- Classifier.test_gh_table_retries_every_api_or_network_failure_but_not_local_ones
- Classifier.test_table
- Cleanup.test_transient_lookup_keeps_cleanup_then_completes_once
- CreateWorktreeLsRemote.test_table
- ExitJudgement.test_clean_exit_with_unreachable_github_is_rejudged_not_failed
- ExitJudgement.test_failed_exit_with_unreachable_github_still_hands_off_the_pr
- ExitJudgement.test_local_gh_failure_remains_an_error
- ExitJudgement.test_stale_pending_evidence_fails_closed_without_launching
- KvIsolation.test_clear_removes_exactly_its_own_retry_keys
- KvIsolation.test_unconfirmed_pr_marker_survives_retry_and_error
- OperatorCommands.test_drain_keeps_the_current_batch_recovering_and_stop_discards_pending
- OperatorCommands.test_stop_wins_over_a_pending_reentry
- PrCreatedOnce.test_already_exists_is_diagnosed_through_the_owned_branch_lookup
- PrCreatedOnce.test_local_cli_failure_is_an_error_and_clears_the_marker
- PrCreatedOnce.test_lost_response_with_delayed_listing_creates_exactly_one_pr
- PrCreatedOnce.test_unknown_outcome_never_repeats_the_request_and_hands_off_when_listed
- Prepare.test_auth_api_answers_of_any_status_wait_instead_of_blocking
- Prepare.test_auth_transient_is_not_a_missing_login_but_a_definite_401_is
- Prepare.test_lookup_failures_keep_the_line_untouched_then_proceed
- Prepare.test_worktree_lookup_failure_stays_prepare_and_launches_once
- VerifiedFixExit.test_retry_of_a_verified_fix_goes_to_review_without_ai_commit_or_push

### tests.test_issue_3129 (12)
- Issue3129.test_context_only_state_change_gets_one_recovery_and_repeated_no_submit_blocks
- Issue3129.test_forms_or_submission_change_never_counts_as_shown_only_progress
- Issue3129.test_legacy_scope_error_needs_one_or_two_excluded_ids_and_no_other_checkpoint_command
- Issue3129.test_legacy_scope_error_recovers_after_same_chunk_reads_and_shown_only_progress
- Issue3129.test_legacy_scope_error_recovers_from_claude_tool_result_status
- Issue3129.test_legacy_scope_error_resumes_once_in_same_session_and_preserves_sibling_saves
- Issue3129.test_legacy_scope_error_with_missing_claude_status_stays_fail_closed
- Issue3129.test_legacy_text_stop_guard_unlocks_only_when_no_official_scope_stop_exists
- Issue3129.test_malformed_task_sense_fails_closed_in_retry_status
- Issue3129.test_old_checkpoint_changed_guard_exposes_one_owner_retry_for_the_exact_sample
- Issue3129.test_prompt_contract_covers_finite_sampling_for_new_and_resumed_chunks
- Issue3129.test_unsaved_legacy_scope_recovery_is_not_started_twice

</details>

## test_issue_1555.py 상위 비용 메서드 보완 감사

검토 요청에 따라 test_issue_1555.py를 따로 직렬 실행했다. 98/98 메서드 통과, suite wall time 35.977초였다. 상위 15개 메서드는 그 실행 1회와 isolated 재실행 3회로 n=4를 구성했다. 시간은 각 호출의 setup/body/teardown을 포함한다. 각 행은 제거 권고가 아니라 비용과 현재 assertion의 필요성을 검토한 결과다.

| 순위 / Class.test_method | 실행시간 n=4: 중앙값 [최소, 최대] (s) | 현재 불변식 / 구체적 확인 | 비용 원인, 중복 근거, 결정·절감 |
|---:|---|---|---|
| 1. IncidentRecoveryProof.test_changed_or_unobserved_state_holds | 1.2091 [1.1734, 1.5258] | HEAD 이동, remote ref 이동, checkpoint 변경, Git 관측 불능은 재개를 HELD/PAUSED로 막고 “재개 증명 불가”를 남긴다. | 네 증거 상태는 별도다. test_a_held_incident_is_reproved_after_the_code_checkout_changes는 반대 방향의 재증명만 다룬다. 계측된 setUp 5회/0.237초 중 첫 loop의 reset이 unittest의 초기 World를 버린다. 첫 case에 초기 fixture를 쓰고 세 번만 다시 만들면 assertion을 모두 보존해 약 0.04–0.05초 절감한다. 삭제 금지. |
| 2. AutonomousIncident.test_classification_without_a_proven_blocker_keeps_the_maintainer_error | 1.0160 [1.0030, 1.1839] | no_code_fix, external, undetermined, recurrence 모두 Maintainer ERROR/ACTIVE와 원 batch PAUSED 유지. | 네 diagnose lifecycle, setUp 4회/0.172초. test_a_fabricated_blocker_does_not_release_the_slot, test_noncritical_unknown_observation_does_not_prove_an_evidence_blocker, test_prior_attempt_marker_cannot_authorize_a_new_handoff는 서로 다른 위조·증거 경계다. 네 결과 분류를 직접 대체할 순수 함수가 없어 유지, 절감 0초. |
| 3. RealGitIntegration.test_supervisor_resumes_a_paused_batch_on_a_real_worktree_after_the_real_integration | 0.7539 [0.7496, 0.8253] | 실제 Git merge 후 Supervisor가 paused producer를 풀고 한 번 재시작하며 partial.jsonl과 integrated HEAD를 보존. | setup 11 Git 호출/0.34초, 본문 21/0.40초. SharedDefectFlow.test_report_to_single_retry_after_merge_and_cleanup은 fake Git, test_fix_is_merged_and_partial_output_and_commits_survive는 low-level Git 경계다. 둘 다 실제 Supervisor 진입점을 대체하지 못한다. 유지. |
| 4. FailClosed.test_wrong_head_branch_or_missing_merge_commit_holds_the_issue_task | 0.7774 [0.7551, 0.8482] | Maintainer PR의 다른 branch 또는 merge SHA 없음은 통합을 일으키지 않고 ACTIVE/HELD로 보류. | test_pr_head_mismatch_holds는 producer PR의 HEAD 검사라 다른 gate다. setUp에서 이미 report/World를 준비하지만 body가 같은 준비를 두 번 새로 한다. 첫 variant에 self.w/self.b를 재사용하면 나머지 variant assertion을 지키며 약 0.15–0.20초 절감 가능. |
| 5. RealGitIntegration.test_fix_is_merged_and_partial_output_and_commits_survive | 0.7508 [0.7234, 1.0549] | exact merge commit의 ancestry, 작업 파일, partial output, 추가 commit 부재를 확인. | setup 11 Git 호출/0.35초, 본문 27/0.52초. test_supervisor_resumes_a_paused_batch_on_a_real_worktree_after_the_real_integration도 partial 파일을 확인하지만 Git.integrate의 commit graph를 직접 검사하는 assertion은 고유하다. 유지; 공유 setup 절감은 격리 clone 비용을 재측정하기 전 0초로 계산. |
| 6. RealGitIntegration.test_only_commits_on_the_base_branch_foreign_or_unregistered_paths_are_accepted | 0.7621 [0.6903, 0.8690] | 허용된 base branch 변경만 적용하고 foreign/unregistered path는 거부. | setup 11 Git 호출/0.34초, 본문 15/0.52초. 다른 RealGit 사례는 이 path ownership assertion을 대신하지 않는다. 독립 clone/worktree를 유지한다. 예상 절감 0초. |
| 7. IncidentRecoveryProof.test_waiting_review_resumes_on_an_open_owned_pr_and_holds_on_an_unmerged_close | 0.6691 [0.6125, 0.7264] | WAITING_REVIEW에서 open owned PR은 release, merged=false closed PR은 HELD/PAUSED. | 두 경우를 모두 새 World로 실행하며 setUp 3회/0.145초. test_unmerged_close_of_the_maintainer_pr_never_releases는 Maintainer PR gate라 다르다. 초기 self.w를 첫 경우에 쓰고 두 번째만 재설정하면 양쪽 assertion을 지키며 약 0.04–0.05초 절감. |
| 8. AutonomousIncidentReview.test_outcomes_are_reported_once_per_phase | 0.6886 [0.6512, 0.8433] | review, complete, stopped-error outcome marker가 각 한 번만 게시됨. | 세 marker의 exact-once assertion을 대신하는 테스트는 없다. 한 profiling 실행에서 setup 후 23 logical tick, tick wall 0.895초였다. phase별 처리와 stable repeat를 유지한 채 각 tick(3)을 2회, 마지막 반복을 1회로 줄이면 약 0.10–0.19초 가능성이 있으나 idempotence gate 재검증 전에는 보류한다. |
| 9. RealGitIntegration.test_conflict_is_aborted_and_leaves_the_worktree_untouched | 0.6824 [0.6201, 0.7748] | merge conflict 뒤 HEAD, 파일 내용, dirty state, MERGE_HEAD 부재를 보존. | setup 11 Git 호출/0.34초, 본문 19/0.40초. test_uncommitted_change_in_a_file_the_fix_touches_is_refused_not_overwritten는 merge 전 dirty 파일 거부라 다른 시점이다. 둘 다 유지. |
| 10. AutonomousIncident.test_two_batches_are_two_issues_never_merged_by_class | 0.7175 [0.6565, 0.9182] | 같은 defect class의 두 batch가 두 Issue로 남고 Issue 수/서로 다른 class count를 확인. | World/SQLite 준비 약 0.041초, 두 producer batch를 같은 sweep으로 처리. SerialMaintainer.test_one_maintainer_at_a_time_in_issue_order는 다른 Issue queue 순서를 보지만 같은 class의 batch 분리를 검사하지 않는다. 유지, 절감 0초. |
| 11. AutonomousIncidentReview.test_diagnosis_cleanup_survives_a_crash_before_the_state_transaction | 0.6621 [0.6331, 0.8630] | diagnosis proof 저장과 cleanup 사이에 crash가 나도 재진입이 같은 diagnosis를 한 번 완료. | JSON/SQLite evidence 작성, crash injection 및 재진입 tick. test_evidence_write_failure_does_not_start_the_maintainer는 launch 전 failure, legacy marker test는 다른 persisted format이다. 유지, 절감 0초. |
| 12. SharedDefectFlow.test_report_to_single_retry_after_merge_and_cleanup | 0.6556 [0.6368, 0.7877] | report, hidden Maintainer, open/green 미해제, cleanup failure, merge 후 같은 producer session 한 번 재개. | 한 World/SQLite와 24 logical tick. SerialMaintainer.test_one_fix_releases_every_batch_of_its_issue_once_each는 다수 producer batch를 보지만 dirty cleanup blocker, open/green 미해제, same-session retry를 검사하지 않는다. 단계별 경계 때문에 유지. |
| 13. RealGitIntegration.test_uncommitted_change_in_a_file_the_fix_touches_is_refused_not_overwritten | 0.5911 [0.5561, 0.7705] | fix가 덮어쓸 파일에 기존 변경이 있으면 integration을 거부하고 HEAD와 내용을 보존. | setup 11 Git 호출/0.34초, 본문 15/0.29초. conflict test는 merge 도중 충돌이라 dirty-before-merge를 대체하지 않는다. 유지. |
| 14. AutonomousIncident.test_approved_integration_error_keeps_its_evidence_and_is_received_by_the_sweep_once | 0.6583 [0.5529, 0.7467] | approved integration BoundaryProblem의 receipt를 보존하고 sweep/restart 뒤 Issue를 한 번만 접수. | World/SQLite evidence 및 restart. IncidentNumberAndIntake.test_error_evidence_of_an_event_keeps_its_first_record는 duplicate write의 first receipt, test_one_sweep_receives_c_d_stage2_stage3_through_any_error_path는 method routing이다. 둘 다 source-bound approved integration 접수를 대신하지 않는다. 유지. |
| 15. SerialMaintainer.test_one_fix_releases_every_batch_of_its_issue_once_each | 0.6479 [0.5985, 0.7709] | 한 Issue에 속한 두 producer batch가 한 Maintainer fix 뒤 각각 한 번만 resume. | unittest setUp은 없고 body에서 World/SQLite, report 두 건, merge와 반복 tick 생성. test_one_maintainer_at_a_time_in_issue_order는 서로 다른 Issue의 queue라 grouping assertion이 다르다. 유지, 절감 0초. |

### #1555에서 얻은 결정

- 상위 15개는 모두 현재 기능·저장물·소유권·exact-once 또는 real Git 경계를 확인한다. 테스트 메서드 전체를 삭제할 안전한 후보는 0개다.
- fixture만 재사용할 수 있는 구체적 기회 3개는 test_changed_or_unobserved_state_holds의 첫 setUp, test_waiting_review_resumes...의 첫 setUp, FailClosed.test_wrong_head_branch...의 첫 case World다. 모든 scenario assertion을 유지하는 조건에서 약 **0.23–0.30초**를 예상한다.
- outcomes exact-once 메서드의 반복 tick 축소는 추가로 약 0.10–0.19초 가능성이 있지만 보류한다. 안정 반복 assertion을 남기고 후속 실행에서 확인해야 한다.
- 상위의 RealGitIntegration 5개는 매번 11 Git subprocess로 seed repo/worktree를 준비해 setup 0.28–0.35초를 쓴다. 다섯 fixture bootstrap 합계는 약 1.6–1.7초지만 gross setup 합계이지 순절감액이 아니다. body에서도 각기 15–27 Git 명령으로 고유 경계를 검증한다. class-level template를 공유하려면 disposable clone/worktree 격리와 clone 비용을 포함해 실제 비교해야 하므로 지금 절감액은 0초로 둔다.
- 기존 5개 후보의 판정과 계측은 그대로 유지한다. 위 fixture/tick 절감은 core assertion을 보존하는 추가 가능성이다. 이번 보완도 코드, 테스트, CI는 바꾸지 않았고 변경 전후 성능 개선을 주장하지 않는다.
