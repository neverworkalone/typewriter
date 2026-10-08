# 관계 보강 파일럿 보고 (Issue #400)

완성된 관계 보강 경로(#396 relevance · #397 후보 검색 · #398 Stage 2 저작 · #399 역방향 amendment)를 실제 Stage 2 결과 위에서 한 번 끝까지 돌려 측정하고, 확대 여부를 결정한다. canonical은 바꾸지 않았다.

- 기준: master `8ac9e885`, canonical revision `27469aa9…`(12,620 senses). 이 revision에서만 재현된다.
- 기록: [`relation-pilot-issue-400.json`](relation-pilot-issue-400.json) · 재현: `node scripts/relation/pilot-run.mjs`(후보 검색 재실행 → 계약 검증 → 실제 Stage 3 planner 시뮬레이션 → 지표 출력).
- 출처 표기: 관계 판단은 **agent self-check(Claude)** 이며 독립 검토나 사람의 결정이 아니다. 관계 수는 품질 증거가 아니다.

## 코호트(결과를 보기 전에 고정)

`ready` 상태인 Stage 2 결과 4개(C000007, C000010, C000012, C000013)에서 sense id의 `sha256("relation-pilot-400:" + id)` 순으로 배치당 10개를 취했다. 단어 난이도·관계 밀도는 선택에 관여하지 않는다(`selectCohortSenses`, 순서 불변 테스트 있음). 후보 검색은 배치의 모든 reviewed sense(334개)를 원천으로 돌려 같은 배치 대상도 후보가 되게 했고(운영과 동일), 검토는 코호트 40개의 상위 10개 후보로 제한했다.

| 구성 | 수 |
| --- | --- |
| 검토 sense | 40 (새 엔트리 24 · 기존 엔트리의 새 뜻 16) |
| 기계 후보/sense | 합 924, 최소 8 · 중앙 23.5 · 최대 46 |
| Stage 2가 실제로 본 후보 | 398 |
| 채택 관계 | 108 (검토 후보 대비 27.1%), sense당 0–5, 중앙 3 |
| 관계 0개 sense | 3 (공통되다, 서방, 전후) |

## 유형·relevance

- 유형: near 59 · association 38 · direct 5 · sensory 3 · mood 2 · action 1. antonym 0.
- relevance(탐색형 103개): 1→1, 2→21, 3→39, 4→24, 5→15, 6→2, 7→1. 8·9는 쓰지 않았다. 후보가 상위에서 이미 필터링된 탓에 낮은 순위(느슨한 연상)가 거의 안 나온 분포다. 채택된 관계의 대부분이 2–4에 몰려 있어 1–9 척도의 뒤쪽은 이 코호트로는 검증되지 않았다.
- 방향: 새→기존 104 · 같은 배치 4 · 기존→새 amendment 12(direct 4, near 8).

## Stage 3 amendment 경로(실제 planner `planStage3Admission`, 메모리 내)

| 시나리오 | 결과 |
| --- | --- |
| 저작 그대로 | 4개 배치 모두 통과, amendment 12 `appended`, 새 sense 쪽 관계 108 |
| 이미 반영된 source로 재실행 | 12 모두 `already_present`, `append_relations` 변경 0 (idempotent) |
| source 뜻풀이 digest 변조 | 4개 배치 모두 `STAGE3_STALE_RELATION_SOURCE`로 fail-closed |

stale·idempotent 경로가 계약대로 동작함을 확인했다. 병합 충돌(`STAGE3_RELATION_CONFLICT` 등)은 #399 회귀가 이미 다룬다.

## 비용

- 관계 색인 구축 122 ms(12,620 senses, 배치 공통 1회). 배치 검색: C000007 120원천 229 ms · C000010 68 82 ms · C000012 35 37 ms · C000013 111 120 ms. 원천당 약 1–2 ms. 런타임 비용은 무시할 수준이다.
- **Stage 2 토큰·시간 부담은 측정하지 못했다.** 이 환경에는 enrichment에 귀속되는 토큰/시계 계측이 없다. 대리 지표는 후보 398개를 한 번에 검토했다는 사실뿐이며, 이를 근거로 "저렴하다"고 주장하지 않는다. 운영 전환 시 Stage 2 worker의 timing 기록에 enrichment 구간을 따로 남길 필요가 있다(후속).

## 후보 품질 진단

shortlist 순위별 채택 수(순위 1→10): 27, 15, 12, 8, 8, 10, 8, 6, 6, 8.

- 1위 채택률 68%(27/40)로 상위는 쓸 만하다.
- **6–10위에서 채택의 35%(38/108)가 나왔다.** 10위 이후를 보지 않았으므로 회수율은 모른다. 운영 기본값(검토 깊이)을 10으로 두면 관계를 놓칠 수 있다.
- shortlist 슬롯 19개(약 5%)가 이미 보인 엔트리의 다른 뜻(예: `쓰다` 4개 뜻)으로 채워졌다.
- "하다", "사람", "자기", "상대" 같은 기능어성 일반어가 문자 2-gram 겹침으로 반복 등장한다.

## 품질 표본(채택 108 + amendment 12 전수 자기 점검)

기준은 유형 정직성, sense 결속, 방향, 필자 유용성이다. 점검 중 고친 것:

- `영문`(일의 까닭) ↔ 까닭·연유를 direct로 두었다가 near(relevance 2)로 낮췄다. 영문은 "영문을 모르다"처럼 굳은 쓰임에 좁아 바꿔 쓸 수 있다는 direct를 정직하게 지지하지 못한다.
- 동음 동형어의 무관한 다른 뜻 연결(`서방`→서방, `전후`→전후)은 필자에게 쓸모가 없어 뺐다. 두 sense는 관계 0개가 되었다. 은유·본뜻 확장(`틈새`, `불태우다`, `떨구다`, `산맥`)은 근거가 있어 association/near로 유지했다.

남은 한계(오해 소지/과도한 범위 후보):

- `일정하다`→시계추(association 7): 이미지 연상일 뿐 증거가 약하다. 그래도 relevance 7로 뒤쪽에 두었다.
- `빠뜨리다`↔`빠트리다`(direct): 사실상 표기 변이로 canonical에 별 엔트리가 존재하는 것이 더 큰 문제다. 관계가 아니라 별개 사안이며, 관계 보강은 이를 숨기지 않는다.
- 이웃 어휘(`콤플렉스`→자의식 6, `뗏목`→나무 5)는 호출 맥락이 넓어 relevance 하단으로 두었다.
- 문학 근거(#391/#392) 문맥은 이 파일럿에서 검색에 제공하지 않았다(`literature: not_provided`). 문학 신호 효과는 이번 측정 범위 밖이다.

## 말의 결 / 연상 · Top-100 검증

- 현재 canonical에서 말의 결 그룹 170개·연상 그룹 196개 모두 최대 3개 이하이며, 20개 초과 0개, 100개 초과 0개다. **이 데이터로는 100개 경계를 만날 일이 아직 없다.**
- 그래서 경계 동작은 실제 Stage 3 `append_relations`와 실제 런타임 투영·페이징으로 합성 검증했다(`tests/relation-enrichment-top100.test.mjs`):
  - 100개 위에 relevance 1을 추가하면 저장 101개, 화면 노출 100개이며 새 관계가 맨 앞으로 온다.
  - relevance 9 추가분은 101번째로 저장은 되지만 노출 창 밖에 남는다. 삭제·재정렬·재작성이 없다.
  - 100개 미만에서는 아무것도 잘리지 않는다.
  - 같은 relevance는 canonical 원 순서로 안정 정렬되며, 뒤에 추가한 동률은 뒤로 간다.
  - 말의 결/연상만 20개씩 최대 100개까지 펼치고 유의어·반의어는 페이징하지 않는다.
- 기존 `tests/relation-paging.test.js`, `tests/relation-relevance.test.mjs`(SQLite가 105개 이상을 보존)와 함께 전부 통과한다.

## 확대 결정

**기본값으로 켠다(향후 Stage 2 운영에 후보 검색 + 관계 검토 + amendment 적용). 단, 아래 조건을 붙인다.**

근거: 계약 경로(검색 → 튜플 검증 → relevance → amendment → idempotent/stale)가 실제 배치 4개에서 끝까지 동작했고, 런타임 비용은 무시할 수 있으며, 관계 0개도 정직한 결과로 3건 나왔고, 공유 계약이 필요한 결함(과도한 direct, 무관한 동음이의)은 판단 단계에서 걸러졌다. 관계 밀도는 목표가 아니므로 지표로 쓰지 않는다.

조건/주의:

1. 이 파일럿은 **어휘 품질이 개선되었음을 증명하지 않는다.** 측정한 것은 경로의 건전성과 후보의 유용성(채택률)뿐이다.
2. 검토 깊이는 10으로 고정하지 말고 상위 20 이상을 기본으로 한다(6–10위에서 채택 35%). 후속 파일럿에서 11–20위 회수를 측정한다.
3. 공유 retriever 후속(차단 아님): 같은 엔트리의 다른 뜻이 shortlist를 점유하지 않게 하는 다양성 제한, 기능어성 일반어 감쇠. 변경 시 파일럿 재실행.
4. Stage 2 enrichment 구간의 토큰/시간 계측 추가(이번에 측정하지 못함).
5. 이 경로는 self-check 표기이며 독립 검토/사람 승인이 아님을 계속 표기한다.

## 백필 준비(착수하지 않음)

`scripts/relation/backfill-queue.mjs` + `backfill-queue-cli.mjs`.

- 인벤토리: canonical 12,620 sense. 관계 없음 12,283 — 이는 결함이 아니다. 수요 신호(다른 sense가 가리키는 수)가 있는 sense는 184개뿐이라 현재 정렬(수요 ↓, 기존 외향 탐색형 관계 수 ↑, id)은 사실상 안정적 id 순이다. 실제 우선순위(검색 로그·빈도 등)는 오너가 신호를 제공할 때 `demand`를 교체한다. 지어낸 빈도로 채우지 않았다.
- 큐: 상태는 repo 밖(`~/.cache/typewriter/relation-backfill/state.json`)에 두고, `next --limit N`(≤200)·`record`로 재개 가능하게 쪼갠다. 완료 기록은 검토한 후보 근거 전체(대상 id·엔트리·POS·검색 신호·문학 위치 digest와 후보 간 상대 순위)에 묶인다. 뜻풀이 digest가 바뀌었거나, canonical 변경으로 새 후보가 나타나거나 기존 후보의 근거·순위가 달라진 sense는 자동으로 다시 큐에 들어오고(현재 후보를 계산하지 못하면 fail-closed), `status`도 오래된 완료를 세지 않는다.
- 승인 보존·검증: `record`는 승인된 각 관계의 `target_sense`가 실제 canonical sense이고 `target`이 그 sense의 엔트리이며, 해당 패킷 검색이 실제로 제시한 후보(shortlist)에 있는지 확인한다(없거나 후보 밖이거나 엔트리가 어긋나면 거부, 상태는 쓰지 않는다). 승인 결과는 개수가 아니라 관계 튜플·rationale·relation id·검색 snapshot digest·검토한 후보 근거와 함께 상태에 그대로 보존되고, 다시 읽을 때 id가 튜플과 일치하지 않으면 완료로 인정하지 않는다. 완료의 유효성은 승인된 각 대상이 현재 canonical에 같은 엔트리 소유로 남아 있는지도 확인한다(대상이 삭제·이전되면 재큐잉, 관계가 반영되어 후보에서만 빠진 경우는 완료 유지). 상태 파일은 없을 때만 새로 시작하고, 손상되거나 읽을 수 없으면 덮어쓰지 않고 중단하며, 기록은 임시 파일 + rename으로 원자적으로 쓴다. CLI `record`는 패킷 파일의 후보를 믿지 않고 현재 canonical에서 다시 검색해 대조하며, 패킷이 발급된 revision과 다르면 거부한다.
- 같은 경로: 후보는 `retrieveRelationCandidates`·`validateRelationCandidateArtifact`, 결과 검증은 Stage 3의 `relationAmendmentErrors`(유형·relevance·sense 결속 rationale·gloss digest)를 그대로 쓴다. 백필 전용 의미 규칙은 없다.
- **미해결(오너 결정 필요, 대규모 백필 착수 전):** 새 뜻이 없는 순수 백필 amendment를 canonical에 적용하는 운반체(Stage 3의 결정 행에 묶이지 않는 경로)는 아직 없다. 이 이슈 범위에서 만들지 않았다.
- 전체 canonical 백필은 시작하지 않았다.
