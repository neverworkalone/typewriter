#927 Stage 2 진행 — chunk 단계

War Room이 지정한 Part (Shard {{shard}} · Batch {{batch}} · Part {{part}})의 **청크 하나**를 판정한다.
현재 worktree와 브랜치 `{{branch}}`, 준비된 HEAD를 그대로 사용한다. Part·브랜치·HEAD를 바꾸지 않는다.
현재 저장 상태: {{checkpoint}}
{{session_note}}
War Room이 이미 checkpoint를 준비하고 이번 청크를 `.warroom-scratch/active-chunk.txt`에 손실 없이 렌더링했다. 이 실행은 구현 작업이 아니라 청크 판정이다. 판정에 필요한 계약은 아래 카드에 있으므로 AGENTS.md·`docs/`·이슈·스크립트 소스를 읽지 않는다. web search, `gh`, Git, 다른 모델·CLI·서브에이전트도 사용하지 않는다.

## 판정 카드 (요약 — 권위 원문: #927 §2, `docs/relation-editorial-policy.md`)

- 새 후보를 발굴하지 않는다. 각 `c<n>`마다 해당 `S` 줄의 **정확한 출발 sense와 전체 gloss**를 기준으로 Relation 또는 Drop을 정한다.
- **Drop**은 누가 봐도 출발 의미와 무관한 후보에만 쓴다. 독특하거나 간접적인 연상, AI가 선호하지 않는 표현은 Drop하지 않는다. 불확실하면 보존하고 낮은 Tier를 준다.
- **Type을 먼저 정한다.** 주된 관계 하나를 실제로 판별한다. `association`을 기본값으로 쓰지 않고, `scene`·`sensory`→`association`, `mood`→`near`로 흡수하지 않는다.
  - `near` 출발 의미와 가까운 어휘적 이웃·뉘앙스 · `mood` 출발 의미가 불러오는 정서·분위기·어조
  - `scene` 자연스럽게 펼쳐지는 상황·장소·장면 · `sensory` 감각·지각·소리·냄새 체험 · `action` 이어지는 행위·동작
  - `association` 위의 구체 관계보다 넓은 개념·사물·주제 연상. 사물이 장면을 떠올린다는 이유만으로 `scene`을 강제하지 않는다. `direct`/`antonym`은 쓰지 않는다.
- **Tier(relevance 1..9)**: 같은 출발 sense·같은 UI 그룹(말의 결=near/mood, 연상=scene/sensory/action/association) 안에서 `P`(기존 승인)·`Q`(앞 청크 저장)·이번 판정과 비교한 상대 표시 우선순위다. 1=유의어로 놓아도 될 정도, 3=상당히 근접, 5=적당한 관계, 7=약한 관계, 9=버리기 아까운 주변적 연결. 짝수는 인접한 홀수 사이다. **연상 Tier 1**은 작가가 비공식 유의어로 여길 실제 대체 표현에만 준다(나그네→방랑자 O, 나그네→봇짐 X). 할당량이나 일괄 부여는 없다.
- **Target 결속**: 후보 줄의 모든 `T<k>` 전체 gloss를 대조한다. 의도한 의미와 **정확히 일치하는** sense가 있으면 그 `T<k>`로 ID 결속한다(동음이의어 오결속 금지, 첫 문자열 일치 선택 금지). 이때 target 의미를 출발점으로 한 **역방향 type/tier**를 따로 정한다. 일치하는 sense가 없으면 text-only로 두고, 그 후보의 target 별칭을 **전부** 나열한다. target이 `-`이면 target 필드 없이 판정한다.

## 실행 절차 (정확히 이 순서로, 각 1회)

1. `cat .warroom-scratch/active-chunk.txt`로 청크 전체를 한 번 읽는다. sense별 재덤프나 JSON 조회를 하지 않는다. `# complete`만 있으면 판정할 청크가 없는 것이므로 종료한다.
2. 모든 `c<n>`의 판정을 `.warroom-scratch/decisions.txt`에 한 번에 쓴다. 첫 줄은 `chunk <청크 ID>`이고, 한 줄에 후보 하나씩 공백으로 구분한다:
   - `c3 R near 2 T5 mood 4` — exact ID 결속(T5), 역방향 mood/4
   - `c4 R scene 6 none T7,T8` — text-only, c4의 target 별칭 전부 확인
   - `c5 R sensory 5` — target이 `-`인 후보
   - `c6 D 출발 의미와 무관한 이유` — Drop
3. `node scripts/relation/admission-cli.mjs save-chunk --checkpoint .warroom-scratch/relation-admission-{{shard}}-{{batch}}-{{part}}.json --in .warroom-scratch/decisions.txt --format compact`를 실행한다. 도구가 거부하면 오류가 가리킨 줄만 고쳐 다시 저장한다. 저장에 성공하면 즉시 종료한다.

다음 청크 읽기, optional links, merge, verify, commit, push, PR은 처리하지 않는다. 저장 실패나 중단 때는 checkpoint와 decision 파일을 보존한다. 임시 파일은 `.warroom-scratch/`에만 둔다.
공통 결함을 확인하면 `tools/warroom/prompts/shared-defect.md` 형식으로 `.warroom-scratch/shared-defect.json`에 보고하고 멈춘다.
