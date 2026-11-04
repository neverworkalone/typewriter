#1156 D — 같은 청크 이어서

중단된 청크 {{chunk_no}}를 이 세션에서 이어간다. 청크 view와 카드는 이 세션에 이미 있으므로 다시 읽거나 요청하지 않는다. 이번 실행에서 Supervisor가 제공한 `TYPEWRITER_D_CHUNK_CLI`, `TYPEWRITER_D_SCRATCH`, `TYPEWRITER_D_CANONICAL_ROOT`가 최신 승인 CLI와 이 배치 worktree의 데이터 경계다. 과거 카드에 있는 상대경로 `scripts/relation/d-chunk-cli.mjs`를 사용하지 않는다. **Supervisor가 제공한 환경과 공식 명령을 신뢰해 그대로 사용한다.** `prepare`는 Supervisor 전용이며 작업자 세션에서는 호출하지 않는다. 전달된 view를 사용하고, 필요한 경우 카드에 명시된 `search`/`search-batch`와 `save`만 실행한다. view가 없거나 불완전하면 `prepare`를 시도하지 말고 그 사실을 보고한다. 정상 실행 전에 변수값 조회·경로 탐색·재설정을 하지 않으며, 공식 명령이 실제 실패했을 때만 해당 진단을 근거로 국소 확인한다. 추측만으로 작업을 중단하지 않는다. 카드의 규칙 그대로, 아직 `{{decisions}}`를 저장하지 못한 Sense를 마저 판독해 카드의 **한 번의 셸 호출**(판정 파일 작성 + `save`)로 저장한다. `save`에는 `--chunk {{chunk_no}} --dir "$TYPEWRITER_D_SCRATCH" --canonical-root "$TYPEWRITER_D_CANONICAL_ROOT"`를 준다. 저장은 거부되면 아무것도 저장하지 않으므로 청크의 모든 판정 대상 Sense를 다시 한 번씩 넣는다. 정상 저장되면 즉시 종료한다. `AGENTS.md`, `docs/`, Git, `gh`, 다음 청크 진행, 조립, commit, push, PR 생성은 하지 않는다.

이미 `{{decisions}}`가 있지만 save/진단이 없다면 새 검색이나 재판정부터 하지 않는다. 파일과 실행 명령 상태를 확인하고, 필요한 경우 기존 판정 의미를 보존해 출력 형식만 국소 수정한 뒤 save를 실행한다. `{{searches}}`의 증거는 보존한다. 실제 미저장이고 현재 세션이 안전하게 이어질 때만 bounded 재개한다.

완료 검색을 다시 요청해 `ALREADY_COMPLETE`가 나오면 문맥이 현재 view에 있는지 먼저 확인한다. 실제로 문맥이 유실된 경우에만 완료 조건의 `reread`를 명시해 재열람하며, 이 호출로 검색 증거·hit·cursor를 변경하지 않는다.
