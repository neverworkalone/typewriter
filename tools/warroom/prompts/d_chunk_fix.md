#1156 D — 청크 {{chunk_no}} 저장 거부, 지목된 판정만 수정

방금 `save`가 아래 이유로 청크 {{chunk_no}}를 거부했고 아무것도 저장하지 않았다. 청크 view와 카드는 이 세션에 이미 있으므로 다시 읽지 않는다. 이번 실행에서 Supervisor가 제공한 `TYPEWRITER_D_CHUNK_CLI`, `TYPEWRITER_D_SCRATCH`, `TYPEWRITER_D_CANONICAL_ROOT`가 최신 승인 CLI와 이 배치 worktree의 경계다. 과거 카드의 상대경로 `scripts/relation/d-chunk-cli.mjs`는 사용하지 말고, 검색·저장은 이 변수의 경로와 `--chunk {{chunk_no}} --dir "$TYPEWRITER_D_SCRATCH" --canonical-root "$TYPEWRITER_D_CANONICAL_ROOT"`를 사용한다. `prepare`는 Supervisor 전용이며 작업자 세션에서는 호출하지 않는다. 전달된 view를 사용하고, 필요한 경우 카드에 명시된 `search`/`search-batch`와 `save`만 실행한다. view가 없거나 불완전하면 `prepare`를 시도하지 말고 그 사실을 보고한다. **Supervisor의 환경과 명령을 사전에 재검증하거나 재설정하지 않는다.** 기존 판정을 보존한 채 제공된 저장 명령을 실행하고, 공식 명령의 실제 오류가 있을 때에만 그 진단을 근거로 필요한 국소 수정을 한다. 추측만으로 작업을 중단하지 않는다. 카드의 규칙 그대로, 아래에 지목된 Sense만 다시 판정한다. `decision_state=V_N_ALLOWED`인 `Z` 오류는 기록된 hit 수만으로 `V`나 `N`을 고르지 않는다. 해당 검색의 실제 hit 문맥을 읽고, `LIMITED`이면 카드의 forms·boundary·cursor 계약을 따라 필요한 범위만 이어 읽는다. 문맥을 잃었으면 완료된 동일 검색을 `reread:true`로 읽어 증거를 추가하지 않는다. `V`는 VERIFIED 문맥을 직접 읽은 경우에만 선택하고, `N`은 문맥을 직접 검토하고 검색형을 충분히 살핀 뒤에 선택한다. `decision_state=Z_ALLOWED`인 `V`/`N` 오류는 모든 검색이 완료되고 hit가 0인지 확인한 뒤에만 `Z`로 바꾼다. `SEARCH_FAILED`나 검색 증거 무결성 오류는 재판정하지 말고 보고한다. 이미 기록된 검색 증거는 지우거나 숨기지 않고, 증거가 뒷받침하지 않는 판정을 바꿔 넘기지 않는다.

**검색 상태 스냅샷:** 기존 `view`는 `prepare` 당시 상태라 이후 검색으로 갱신되지 않는다. 거부 진단과 그 뒤 실행한 검색 응답 중 가장 최근 `decision_state`를 현재 상태로 사용하고, 예전 view의 `ZERO_HITS`/`COMPLETE`로 덮어쓰지 않는다. `Z`는 현재 상태가 `Z_ALLOWED`일 때만 가능하다. 동일 조건이 `LIMITED`이면 cursor 없는 재요청 대신 `cursor:"next"`로 이어 읽는다. 상태·hit 수만으로 source Sense 판독이나 `V`/`N`을 대신하지 않는다.

`{{decisions}}`에 이미 있는 판정은 그대로 두고 지목된 줄만 고치거나 추가한 뒤, 카드의 `save` 명령을 **한 번** 다시 실행한다. 저장은 모든 판정 대상 Sense가 한 파일에 있어야 통과하므로 파일 전체가 유지돼야 한다. 정상 저장되면 즉시 종료한다. 증거상 안전하게 저장할 수 없으면 저장하지 말고 그 사실을 보고한 뒤 종료한다. `AGENTS.md`, `docs/`, Git, `gh`, 다음 청크 진행, 조립, commit, push, PR 생성은 하지 않는다.

`line N` 같은 순수 출력 형식 오류라면 기존 판정 의미를 보존하고 지목된 줄의 형식만 바로잡는다.

{{problem}}
