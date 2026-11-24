# Relation Factory v1

Typewriter 관계 제작은 **후보 발굴 → Stage 2 최종 편집·승인 → Stage 3 독립 감사·교정 → DB 빌드**로 분리한다. STDICT Canonical JSONL처럼 생성한 **Candidate JSONL을 영구 보관**하고, 이후 원본 문학·말뭉치 DB를 다시 검색하지 않고 Relations를 편집한다. 편집 기준은 [relation-editorial-policy.md](relation-editorial-policy.md)를 따른다.

**1회성 전체 초기화(#1154):** 영구 보관 원칙의 유일한 예외로 구형 Candidate·승인 Relation·Drop을 `candidate` 브랜치(2af4d21a)에 보관한 뒤 삭제하고 `001_01`부터 다시 생산했다. 그 이후 머지된 Candidate는 영구 보관한다.

```text
Stage 1 — Candidate Generation (완료, 856배치): A / B / C / D 독립 병렬 생산
    → data/relation-candidates/<shard>/<shard>_<batch>_<method>_<model>.jsonl
Stage 2 — Relation Admission: 후보 통합 → 채택/제외 → 타입/Tier/대상 확정
    → 승인 Relations / Drops JSONL (샤드 단위)
Stage 3 — Relation Editorial Refinement (#2455, 구현됨): 독립 감사 / Drop / Link Repair
    → 기존 Relation / Drop JSONL을 직접 수정 (추가 edit 파일 없음)
Polish (#8777, #8784): 단어별 승인 Relation 직접 Add/Drop/Set — Stage 진행과 독립
    → 같은 Relation / Drop JSONL을 관계 키 단위로 수정
pnpm run build: Canonical + 최종 Relations → Full / Lite SQLite
```

**A/B/C/D는 생성 방법의 이름이며 Stage 번호가 아니다.** Stage 1 후보에는 타입·Tier·승인 상태·대상 ID가 없고, Stage 2는 새로운 후보를 탐색하지 않는다.

## 1. 범위와 파일

기존 `data/canonical/stdict-0001.jsonl` ~ `stdict-0428.jsonl`의 **428개 샤드, 427,583레코드**를 그대로 사용한다. 샤드마다 Canonical **500레코드(행)씩** 배치로 분할한다. sense 500개 단위가 아니다. 동음이의어 record는 구분하고, 한 record의 모든 sense는 함께 처리한다.

- 샤드 001~427: 각각 1,000레코드 → 배치 `01`(Canonical 1~500행), `02`(501~1000행).
- 샤드 428: 583레코드 → 배치 `01`(500레코드), `02`(마지막 83레코드).
- 총 **856개 배치**. 순서는 샤드 번호 → 샤드 내 Canonical 행 위치다. record ID가 연속된다는 가정은 하지 않는다.

```text
data/relation-candidates/
  001/
    001_01_a_codex.jsonl
    001_01_a_claude.jsonl
    001_01_b_codex.jsonl
    001_01_b_claude.jsonl
    001_01_c_codex.jsonl
    001_01_d_codex.jsonl
    001_01_a_deepseek.jsonl
    001_01_b_deepseek.jsonl
    001_02_a_codex.jsonl
    ...
  002/
    ...
  428/
    ...
```

경로 계약: `data/relation-candidates/<SSS>/<SSS>_<BB>_<method>_<model>.jsonl`. 샤드 3자리, 배치 2자리(`01`/`02`), method는 `a|b|c|d`, model은 실행한 모델 이름의 소문자 식별자. **A/B는 500레코드 배치·방식·모델당 하나의 파일**, **C/D는 모델을 가리지 않고 500레코드 배치·방식당 하나의 파일**을 허용한다. 실제 생산 모델은 파일명에 남긴다. 배치별 하위 폴더는 만들지 않는다. Stage 2는 `(shard, batch, part)`마다 PR 하나를 제출한다. Part 안의 primary 판정은 War Room Supervisor가 오너 설정(`stage2_chunk_candidates` 기본 250, `stage2_max_parallel` 기본 16) 범위에서 고정 task로 나누어 병렬 실행할 수 있으며(#3047), checkpoint 저장은 Supervisor의 단일 경로가 `save-chunk --task`로 맡는다. 판정 기준·검증·리뷰 게이트와 Part당 PR 계약은 바뀌지 않는다. 이는 기존 파일 형식이나 별도 수정 PR의 범위를 바꾸지 않는다.

## 2. Stage 1 — Candidate Generation (완료)

856개 배치의 Candidate가 모두 master에 머지되었다. A/B는 모델별(Codex·Claude·DeepSeek) 파일, C/D는 방식당 한 파일이다. 이 파일들은 Stage 2 입력으로 **영구 보관**하며, 오너의 새 결정 없이 생산·재생성·수정하지 않는다. 생산 절차(A/B Workbench, C [#1155](https://github.com/neverworkalone/typewriter/issues/1155), D [#1156](https://github.com/neverworkalone/typewriter/issues/1156), `#860` 다음 배치 선택, 후보 표현 단위 생산 계약)는 이 문서에서 제거했고 해당 이슈와 Git 이력에 남아 있다.

| 방식 | 후보 발굴 방법 |
| --- | --- |
| **A** | 정확한 Canonical sense/뜻풀이에서 직접 생성 |
| **B** | 출발 sense에 맞는 가상 장면을 구성하고 후보 추출 |
| **C** | 문학 SQLite의 실제 문맥 참조 |
| **D** | 문어 말뭉치 SQLite의 실제 문맥 참조 |

### 고유명사 양방향 제외 (#5745)

인물(본명·호·필명)·지명·기관·단체·작품/저작 제목처럼 **특정 대상을 지칭하는 고유명사 Sense**는 Typewriter-authored 말의 결·연상의 출발점에도 후보·대상에도 등장하지 않는다. 관계가 사실이라는 이유로 예외를 두지 않는다. 판정은 AI가 Canonical의 정확한 Sense/gloss로 하며 철자·품사·표면 패턴으로 일괄 제외하지 않는다. 예: `w265063-s1` 인촌¹(김성수의 호)은 고유명사, `w265064-s1` 인촌²(이웃 마을)는 일반 어휘; 사람·도시·학교·소설·영화·작가 같은 분류 개념은 허용한다. STDICT `direct/antonym`과 사전 검색은 바뀌지 않는다.

- **Stage 2:** 고유명사 출발 Sense의 모든 후보와 고유명사 뜻의 후보는 `D e`로 Drop한다. ID·text-only·역방향·다른 Sense/표기 relink로 승인하지 않는다. 동철 후보는 고유명사 Sense로의 결속만 차단한다. 이미 승인된 관계로 커버되어 신규 판정 대상이 아니면 Stage 3에 맡긴다.
- **Stage 3:** 출발 Sense나 대상(ID target Sense, text-only 지칭)이 고유명사인 Relation은 Keep·Link Repair 없이 `D`로 삭제한다. 고아 후보 `z`와 cross-shard reconcile은 기존 경로를 따른다. Stage 3 view는 모든 ID 대상의 POS·gloss를 표시한다(단일 Sense 표제어도 `인성론`처럼 작품명일 수 있음).
- Stage 1 후보는 고유명사 출발 Sense를 `candidates: []`로, 고유명사 후보는 넣지 않는 기준으로 생산되었다. 진행 중 checkpoint·완료 데이터는 소급 변경하지 않는다.

### Candidate JSONL v1

**레코드 하나 = JSONL 한 줄.** Canonical에 있는 모든 source record/sense를 보존하고, 의미별 관계 후보를 **문자열 배열**에 기록한다.

```jsonl
{"record_id":"w001","senses":[{"sense_id":"w001-s1","candidates":["농지","쟁기","흙냄새"]}]}
{"record_id":"w002","senses":[{"sense_id":"w002-s1","candidates":[]},{"sense_id":"w002-s2","candidates":["덧셈","합계"]}]}
```

*후보 문자열은 스키마 예시이며 관계 승인 결과가 아니다.*

| 필드 | 형식 | 의미 |
| --- | --- | --- |
| `record_id` | string | 출발 Canonical record ID |
| `senses` | array | 해당 record의 전체 source sense |
| `sense_id` | string | 출발 Canonical sense ID |
| `candidates` | string[] | 후보 표현 문자열. 빈 배열 허용 |

**Candidate에 포함하지 않음:** `type`, `tier`/`relevance`, 대상 ID, 채택 여부, 평가/확신도, 원본 인용. `lemma`/`gloss`는 Canonical에서 읽고, method/model은 파일명으로 구별한다.

**검증:** 공통 validator는 `scripts/relation/candidate-contract.mjs <canonical> <candidate>`다. JSONL 파싱·허용 필드, Canonical 배치의 record 행 수·순서·ID와 모든 sense의 정확한 일치, 비어 있지 않은 후보 문자열, 같은 source sense 안의 중복, source lemma와 후보의 양방향 정규화 포함을 확인한다. 후보가 없는 sense는 `candidates: []`이며, 행 누락이나 미완료 파일을 빈 후보로 취급하지 않는다. PR의 Normal 검사는 추가·수정된 Candidate 파일에 이 strict 계약을 적용한다. Stage 2가 이미 머지된 Candidate를 읽을 때는 과거 계약을 유지하고 새 포함 규칙을 소급 적용하지 않는다. 역사적 Candidate를 자동으로 수정하거나 재검증하지 않는다.

## 3. Stage 2 — Relation Admission

**입력:** 해당 샤드의 필수 Stage 1 후보 파일 전체(2배치 × 기본 생산자 6개)와 해당 배치에 오너가 지정한 선택적 파일, Canonical, 기존 승인 Relations. **새 후보 생성이나 문학·말뭉치 재검색을 하지 않는다.**

샤드 내부에서는 출발 source sense별로 작업할 수 있으나 승인/기록은 **샤드 단위로 직렬** 수행한다.

1. A/B/C/D의 후보를 모아 문자열·의미 중복을 검토한다.
2. **새 Stage 2 Part의 승인 기준은 (a) 출발 sense와의 실제 연결 및 (b) 작가에게 주는 독립적인 표현 가치** 두 가지다(#2544). 후보를 출발 sense 전체 gloss와 기존 승인·이번 Part 동료 관계에 비추어 판정한다. 명백히 무관한 후보뿐 아니라 단순 어미 변이·명사화·반복, 별도 표현 가치가 없는 유의어·직업인 파생, 우연한 문맥 사물·근거 없는 다단계 연상도 Drop한다. Stage 1(#2545)이 명백한 네 유형을 사전 차단하므로 Stage 2는 실제로 넘어온 잔여 후보만 판단하고 동일 필터를 새로 만들지 않는다. **낯선 연상·낮은 Tier 자체는 Drop 근거가 아니다**. `어정대다→낙타`처럼 애매한 경우는 자동 삭제하지 않고 원 Sense에 관한 실제 연상 가치를 판단하며, 유익한 저우선순위 관계는 보존한다. 승인 여부를 정한 뒤 Type/Tier를 부여한다. 신규 Relation이 0건인 Part도 중복·기승인·정당한 Drop 등으로 회계를 맞추어 `verify`에 성공하면 정상이다. 승인·Drop 수 할당량은 없고 Stage 1 원본을 수정하지 않는다.
3. 채택 후보만 말의 결(`near`, `mood`) 또는 연상(`scene`, `sensory`, `action`, `association`)으로 분류한다. 새 STDICT `direct/antonym`은 작성하지 않는다.
4. 동일 출발 sense/동일 UI 그룹의 기존·신규 관계를 비교해 **Tier = relevance 1~9**를 부여한다(1이 최우선, 동순위 허용). 연상 Tier 1은 비공식 유의어 후보급에 한정한다.
5. 정확한 Canonical target record/sense가 확인되면 ID 링크, 아니면 text-only로 확정한다. 같은 이름의 다른 의미에 연결하지 않는다.
6. Typewriter-authored ID↔ID는 양방향 탐색을 제공한다. **출발 sense의 Type/Tier를 한 번 판정하고 제품의 양방향 링크에 같은 값을 쓴다.** marker 없는 checkpoint는 종전 독립 역방향 판단을 읽을 수 있지만, 서로 다른 값이 남은 Part는 저장 경계에서 중단한다. 기존 승인 데이터의 비대칭 역방향 값은 #2446 전환에서 source 값으로 정규화하며 다른 후보 판정은 다시 하지 않는다. text-only는 역방향이 없다.

**출력:** 승인된 Relations JSONL(샤드당 한 파일). 재실행 때 중복 관계를 누적하거나 기존 결정을 임의로 삭제하지 않는다.

### Persisted Relations / Drops JSONL (Issue #2446)

한 줄 = 관계 하나. persisted field 매핑은 `scripts/relation/persisted-jsonl.mjs`가 한 번 정의하고, `scripts/relation/admission.mjs`는 descriptive in-memory 행을 검증한다.

```jsonl
# data/relations/relation-001.jsonl — ID 링크(양방향 한 행)
{"id":"w1","sid":"w1-s1","tid":"w9","tsid":"w9-s1","tp":"near","rv":2,"ver":1,"fm":["표적 표기"],"rfm":["출발 표기"]}
# text-only (reverse 없음, 클릭 불가)
{"id":"w1","sid":"w1-s1","tt":"새 말","tp":"scene","rv":4}
# data/relation-drops/drop-001.jsonl — 실제 Drop만 (없으면 빈 파일/부재 허용)
{"id":"w2","sid":"w2-s1","cd":"버릴말","by":"x"}
```

- Polish 직접 편집의 `by:"p"` Relation과 Drop 파일 안의 제외 문맥 `p` 행은 §5-A를 따른다.
- 파일에 저장하는 필드만 축약한다. Relation ID 행은 `id`/`sid`/`tid`/`tsid`/`tp`/`rv`와 선택적 `ver`/`fm`/`rfm`, text-only 행은 `id`/`sid`/`tt`/`tp`/`rv`, Drop 행은 `id`/`sid`/`cd`/`by`를 사용한다. JS 내부 객체와 checkpoint는 기존의 descriptive 필드명을 유지할 수 있다. 저장기는 compact 필드만 쓰고, 저장 파일을 읽는 Stage 2 및 제품 빌드 로더는 이전 verbose 키와 혼합된 키를 거부한다.
- `tp`와 `rv`는 ID 링크의 유일한 관계 타입과 relevance다. 제품 역방향 링크도 같은 `tp`/`rv`를 사용하며 역방향 필드를 JSONL에 저장하지 않는다. 새 ID 판단에서 source 방향 값을 한 번만 판단하고 양방향에 적용한다. 이전 형식의 checkpoint에 서로 다른 역방향 판단이 남아 있으면 저장 결과가 달라지므로 해당 Part의 `merge`는 거부하며, 최신 스키마로 Part 경계를 다시 시작해야 한다. 이전 형식의 premerge snapshot은 내용과 hash를 보존하고 자동 변환하거나 다시 캡처하지 않는다.
- `ver`/`fm`/`rfm`은 후보 귀속 근거이며 값과 의미를 보존한다. `ver`가 없는 legacy 행, `ver:0`, `ver:1`은 서로 다르다. 새로 선택한 ID 행은 `ver:1`과 두 배열을 저장한다. 여러 후보형이 같은 source/target sense 쌍으로 병합되면 각 방향에서 처리한 정확한 후보 표기를 합쳐 보존한다. 후보별 relevance가 다를 때는 가장 우선순위가 높은 값(숫자가 가장 작은 relevance)을 저장한다. type 판단이 다르면 임의 선택하지 않고 merge를 거부한다. spacing/hyphen 표기 변형은 별도 규칙으로, 판단이 다를 때 Canonical headword spelling의 판단을 우선한다. 기존 version-less 행에 새 반대 방향 후보 귀속을 합치면 `ver:0`으로 기록한다. 이때 `fm`은 기존 정방향 추론 표기, `rfm`은 새 반대 방향에서 처리된 정확한 후보 표기다. 이 정보는 accounting/restart용이며 제품 링크의 target을 바꾸지 않는다.
- ID 링크의 target은 후보 문자열과 철자가 정확히 같은 Canonical record의 실제 sense여야 한다. Stage 2 Part의 `read-chunk` 입력은 같은 표기의 모든 target record, lemma, sense ID, POS, 전체 gloss를 제공한다. 동철 이의어·다의어는 출발 sense와 각 target sense를 비교해 선택하며 첫 항목을 자동 선택하지 않는다. text-only로 남길 때도 제공된 target sense ID를 전부 검토하고 `no_exact_match`로 명시한다. 일치하는 target이 없으면 text-only이며 가짜 ID를 쓰지 않는다.
- 소유 샤드 = 출발(source) sense가 속한 샤드. 한 쌍(A↔B)은 한 행에만 저장하며, 다른 샤드에 이미 같은 쌍(정·역 모두)이나 같은 text-only가 있으면 거부한다. 새 Part의 각 방향은 source 기준으로 한 번 판단하고 동일한 반대 값을 저장한다. 양쪽 출발 sense의 Candidate가 같은 쌍을 동시에 만들면 기존 방향 충돌 검사가 두 source 판단의 일치 여부를 확인하며, 서로 다르면 한쪽을 임의 선택하지 않고 #2307 preflight/국소 재판정으로 해결한다. 빌드는 ID 행마다 같은 Type/Tier의 양방향 탐색 행 2개를 만든다.
- 모든 고유 후보는 **신규 관계 / Drop / 정확한 중복 병합 / 기존 승인 관계 제외**로 설명되어야 한다. 같은 후보 표기에 ID 관계가 여러 개 있으면 실제 target sense가 서로 다를 때 허용하며, 동일 source/target sense 쌍은 한 번만 저장한다. 여러 후보형이 같은 쌍을 공유하면 위의 type/relevance 병합 규칙을 적용한다. 같은 후보에 대한 text-only 관계나 Drop은 다른 처리와 중복할 수 없다.
- **Stage 2 editorial Drop**은 (1) 실제 출발 sense와 관계가 없는 후보 또는 (2) 의미가 연결되더라도 작가에게 독립적인 표현 가치를 주지 않는 후보에만 쓴다(#2544). `by:"x"`는 무관·오결속 후보, `by:"e"`는 연결은 되지만 독립적인 표현 가치가 없는 후보를 뜻한다. 모델의 일반 compact 입력은 `x/e`만 허용하며 자유형 설명, `editorial:`, `edit`, `z`, `f`를 거부한다. **뜻풀이에 직접 등장하는 후보에 대한 `findGlossNamedDrops` 반례 검사는 `x`에 적용하고, `e`는 면제**한다. `z`는 Stage 3 전용 회계 코드다. 같은 sense의 기존 승인 peer와 모순되는 Drop, 잘못된 후보 회계·중복·샤드 소유는 여전히 금지다.
- Canonical 밖의 STDICT 어근을 가리키는 `→` 참조는 원본 sense-code가 어근과 Canonical 파생어 sense를 모두 정확히 연결할 때만 `data/provenance/stage2-root-references.json`의 원문과 파생어 뜻을 판정 문맥으로 제공한다. 이는 어근과 파생어를 동일한 품사나 의미로 단정하지 않는다. 원본 인벤토리로 `node scripts/stdict/stage2-root-references.mjs <source-dir> --verify`를 실행해 투영을 재현하며, 연결이나 Canonical 뜻이 달라지면 기존 의미 없는 gloss 차단을 유지한다.
- **Stage 2 technical failure Drop (`f`, issue #2874):** Supervisor가 공식 `save-chunk`의 전체 진단을 현재 chunk의 단일 alias와 source record/sense/candidate에 결속하고, 기존 세션의 수정 1회가 끝난 뒤에도 그 후보가 같은 `save-chunk` 오류로 남았음을 확인한 경우에만 별도 restricted CLI 경로로 저장한다. `f`는 자동화 실패 표식이며 의미·표현 가치 판단을 뜻하지 않는다. 일반 모델 입력 `D f`와 다른 모든 누락·다중 후보·비국소 검증 오류의 자동 `f` 전환은 금지한다. **Repair 경로(#3055)**의 `f`는 (1) 결정적 정규화(예: 제공된 exact target 쌍에 대한 `target_resolution:"exact"` 완성)로 해결되지 않았고, (2) 그 문제 `(field_path, condition)`을 요청한 correction run이 완료됐음이 증명되며(요청 집합·종료·응답 hash), (3) 공식 CLI `repair --check` 재검증에서 그 문제가 잔존하거나 재발했을 때(요청한 행이 다시 누락된 경우 포함)만 ordinary 후보에 한해 저장한다. 증거가 하나라도 부족하면 fail-closed한다. `f`는 gloss-name 반례 검사에서 면제하고 editorial Drop 통계와 분리한다. Persisted Drop JSONL의 기존 `{id,sid,cd,by}` 축약 계약은 그대로이며 `by:"f"`는 향후 재심사를 위해 남긴다.

**도구** (`pnpm run relation:admission -- <command>`, 샤드 번호만 바꿔 재사용):

```sh
node scripts/relation/admission-cli.mjs prepare --shard 001 --out <scratch>/p001.json  # 비-Part 전체 입력 보기
node scripts/relation/admission-cli.mjs verify  --shard 001                           # 전체 스키마·ID 결속·귀속 완전성
node scripts/relation/admission-cli.mjs prepare --shard 003 --batch 01 --part 01      # 기본 checkpoint: .warroom-scratch/relation-admission-003-01-01.json
node scripts/relation/admission-cli.mjs read-chunk --checkpoint .warroom-scratch/relation-admission-003-01-01.json --out .warroom-scratch/active-chunk.json
node scripts/relation/admission-cli.mjs save-chunk --checkpoint .warroom-scratch/relation-admission-003-01-01.json --in .warroom-scratch/decisions.json
# War Room 청크 실행: 같은 청크의 compact 뷰와 compact 판정(아래 설명)
node scripts/relation/admission-cli.mjs read-chunk --checkpoint .warroom-scratch/relation-admission-003-01-01.json --format compact --out .warroom-scratch/active-chunk.txt
node scripts/relation/admission-cli.mjs save-chunk --checkpoint .warroom-scratch/relation-admission-003-01-01.json --in .warroom-scratch/decisions.txt --format compact
node scripts/relation/admission-cli.mjs merge --checkpoint .warroom-scratch/relation-admission-003-01-01.json
node scripts/relation/admission-cli.mjs verify --shard 003 --batch 01 --part 01
```

`--batch 01|02`를 주면 해당 500레코드 배치의 필수 Stage 1 파일 6개·Canonical 행·행 귀속만 대상으로 한다(같은 샤드 파일 `relation-<SSS>.jsonl`에 배치별로 나눠 누적할 때 사용). 다른 배치의 행은 그 실행의 귀속 검사에서 제외되며, 샤드 전체가 끝났는지는 `--batch` 없는 `verify`가 판단한다.

`--part`는 반드시 `--batch`와 함께 사용하며, 선택한 Stage 1 배치 안에서 Stage 2의 Canonical 순서 Part 크기만큼만 편집·통계·귀속 검사한다. Part 크기는 `config/stage2-part-layout.json`(#3385)이 정한다: **Shard 001–005(이미 Stage 2가 시작된 legacy)는 100개씩 `--part 01..05`** — Batch 01의 Part 01–05는 shard record 1–100, 101–200, 201–300, 301–400, 401–500이고 Batch 02는 501–600, 601–700, 701–800, 801–900, 901–1000이다. **Shard 006부터는 250개씩 `--part 01|02`** — Batch 01은 record 1–250, 251–500, Batch 02는 501–750, 751–1000이며 Batch당 2 Part, Shard당 4 Part다. 이미 시작된 Shard의 Part 크기는 바꾸지 않으며, 신규 Shard의 `prepare`는 checkpoint에 `part_size`를 기록하고 checkpoint를 읽는 모든 명령이 이를 검증한다. 마지막 샤드의 Batch 02는 83개이므로 어느 layout에서도 Part 01만 유효하다. 비어 있는 Part와 `--part` 단독 지정은 실패한다. Part별 `prepare` 항목과 `raw`, `unique`, `merged_duplicates`, `skipped_existing`, `skipped_dropped`, `to_edit`, `relation`, `drop`, `reverse_covered`, `missing` 통계는 모두 해당 Part의 source senses만 센다.

Part 모드는 선택한 Stage 1 Batch의 필수 후보 파일 6개를 기존 v1 계약대로 한 번 검증·통합하고, Part checkpoint에 source sense, 후보 provenance, 같은 표기의 모든 target sense/gloss, 같은 출발 sense의 기존 승인 동료, 후보별 판정 상태를 보존한다. 후보 accounting은 `(source sense, candidate)` 단위이므로 기존 ID 링크가 하나라도 있으면 새 필수 판정은 생략한다. 단, 일부 target sense만 연결된 후보는 checkpoint에서 `already_accounted`로 표시하고 나머지 sense 링크를 선택적으로 추가할 수 있다. `prepare --part`를 재실행하면 기존 checkpoint를 이어간다. `read-chunk`는 Canonical이나 승인 관계를 다시 읽지 않고 미판정 후보를 한 번에 보여 준다. 필수 후보 편집이 끝나면 `read-chunk --optional --format compact`가 남은 정확한 target sense/gloss를 부작용 없이 보여 준다. 미연결 링크가 없으면 `complete-optional`을 실행해 완료 증거를 저장하고, 링크가 있으면 `save-optional`로 후보마다 skip 또는 여러 exact target을 한 번에 기록한다. 예전 활성 revision이 남아 있으면 `cancel-revision --chunk-id <exact>`는 해당 미병합 revision ID에만 사용할 수 있다. 기본 250개 후보를 기준으로 여러 완전한 source sense를 묶으며, 하나의 sense가 그보다 크면 정확한 candidate 시작·끝 offset을 표시해 이어서 처리한다. source sense는 이 초과 경우에만 청크 사이에서 이어진다.

`--format compact`는 primary와 `read-chunk --optional`을 모두 손실 없이 렌더링한다. primary 뷰는 target sense 전체 gloss, 출발 sense(`S`), 기존 승인 동료(`P`), 같은 sense의 앞 청크 판정(`Q`)을 싣는다. 새 marker-bearing checkpoint의 exact ID 입력은 `c<n> R <type> <tier> T<k>`이며 CLI가 reverse 값을 파생한다. marker 없는 legacy checkpoint는 `c<n> R <type> <tier> T<k> <reverse_type> <reverse_tier>` 입력을 재개할 수 있지만, source와 reverse 판단이 다르면 compact 저장 형식으로 merge하지 않는다. text-only·target 없는 후보·Drop 문법은 두 정책에서 같다. Optional도 동일 정책을 따르며 여러 target의 관계를 한 번에 기록할 수 있다. CLI는 alias를 exact record/sense ID로 펼친 뒤 source-bound 검증을 거친다. 각 view가 출력 상한을 넘으면 페이지 번호와 크기를 지정해 손실 없는 페이지로 나눈다.

각 후보는 한 번의 통합 판단으로 `relation` 또는 실제 `drop`을 선택한다. Relation은 후보별 `type`과 상대 Tier `1..9`를 가진다. 같은 표기의 target sense가 있으면 `target_resolution`을 명시한다. 정확한 대상은 `exact`와 제공된 record/sense ID를 저장한다. 새 정책에서는 CLI가 reverse type/Tier를 source 값에서 파생하고, legacy checkpoint의 입력은 정·역방향 값을 모두 요구한다. text-only는 `no_exact_match`와 제공된 target sense ID 전체를 `checked_target_sense_ids`에 적는다. 같은 표기의 target이 없으면 target 판정 필드는 생략한다. checkpoint에 필요한 비교 상태만 남기며 의미적 정답을 자동 판정하지 않는다. `save-chunk`는 청크의 누락·중복·범위 밖 decision 및 잘못된 target 결속을 저장 전에 거부한다. Drop은 후보별 근거를 가진다. Type/Tier 기본값이나 별도 ID/Tier 패스는 없다.

모든 primary 청크와 optional review를 저장한 뒤 최초 `merge`는 원본 Relation/Drop 바이트(파일 부재와 빈 파일을 구분)를 scratch snapshot으로 고정하고, 같은 순수 materialize 계산으로 승인·충돌·Candidate accounting을 검증한 뒤에만 Relation→Drop→checkpoint 순으로 쓴다. `inspect --source-sense-id <id[,id...]> --format compact`는 checkpoint와 산출물을 변경하지 않고, 현재 판정 및 optional 상태에 묶인 digest를 출력한다. merged Part의 검토 수정은 그 digest를 가진 `amend` 입력으로 sparse `R`/`D` 행을 한 번에 제출한다. 기존 승인 관계로 이미 커버된 후보(optional 링크만 가진 후보)에는 `D`를 쓸 수 없고(#6962), 추가한 optional 링크를 모두 지우려면 `c<n> skip`, 바꾸려면 `c<n> R <type> <tier> T<k>`를 제출한다. 기존 승인 관계와 후보 할당은 그대로 보존되며, `inspect` 머리글에도 이 문법이 표시된다. CLI는 premerge snapshot과 기존 checkpoint에서 전체 결과를 재계산하며 여러 파일 저장 중 중단된 네 가지 상태만 같은 요청으로 복구한다. snapshot이 없는 과거 merged checkpoint는 amend할 수 없다. `verify --shard S --batch B --part P --checkpoint <file> --json`은 로컬 merged checkpoint와 실제 Relation/Drop 바이트를 함께 검사하며, 최신 PR HEAD 검증은 checkpoint가 없는 별도 checkout에서 실행한다. Batch 또는 shard가 끝날 때는 범위를 넓혀 별도로 검증하고, `--part` 없는 기존 호출의 의미는 유지한다. Part `verify`·`preflight`·`merge`·`amend`는 다른 샤드의 Relation/Drop 가운데 **이 샤드 Sense를 출발·대상으로 갖는 행만** 읽는다(#6555). 이 명령들이 다른 샤드 행을 조회하는 키는 모두 이 샤드 Sense로 시작하므로 결과·오류·복구 판정은 전체 행을 읽을 때와 같다. 이 샤드와 무관한 다른 샤드 행 자체의 형식·무결성은 그 샤드의 검증과, 변경된 Relation 샤드마다 전체 파일을 읽는 CI `verify --relations-only`가 맡는다.

큰 inspect 문맥은 같은 digest를 가진 여러 페이지로 전달되므로 `total_pages`까지 모두 읽는다. JSON의 큰 문맥은 각 페이지의 `json_fragment`를 순서대로 이어 붙여 JSON으로 파싱한다. Compact 문맥의 S/P/T/Q와 후보 행도 모든 페이지를 함께 읽는다. 단일 행이 페이지보다 크면 `F` 행의 같은 row-id에 대해 JSON 문자열을 디코딩하고 part 순서대로 이어 원래 행을 복원한다. 다른 scope 또는 snapshot의 digest와 별칭은 섞지 않는다.

`--batch` 없이 실행하면 필수 Stage 1 파일(2배치 × A-Codex/A-Claude/B-Codex/B-Claude/C/D 12개)이 하나라도 없을 때 실패한다. `--batch BB`는 **해당 배치의 필수 생산자 6개만** 요구하므로 다른 배치 입력이 없어도 착수·검증할 수 있다(다른 배치의 Candidate 파일은 목록 검사·파싱 대상이 아니므로 충돌하거나 미완성이어도 이 실행을 막지 않는다). 다른 배치나 샤드의 ID 관계는 `prepare`와 `verify`에서 실제 target sense별로 계산한다. Stage 2 accounting 단위는 `(source sense, candidate)`다. 후보가 고유 표제어의 한 sense에 이미 ID로 연결됐으면 이 후보는 기존 승인 관계로 처리되어 새 필수 판정을 요구하지 않는다. Part 모드에서는 나머지 target sense의 추가 ID 링크를 `read-chunk --optional`로 검토한다. 링크 후보가 있으면 `save-optional`에서 후보마다 skip 또는 여러 exact target을 한 번에 선택하고, 0개면 `complete-optional`이 AI 실행 없이 완료 증거를 기록한다. 신규 ID 판정에서는 같은 표기의 모든 target sense/gloss를 비교하고 실제로 일치하는 sense를 선택한다. text-only로 남기는 경우에만 모든 sense ID를 확인한다. text-only 승인 관계도 후보 전체를 처리한 것으로 본다. `--allow-partial`은 도구 점검 전용이며 샤드 완료 증거가 아니다. 불완전 Stage 1 입력으로 만든 Part checkpoint는 `merge`가 거부한다. 다른 샤드의 승인 Relations(정·역방향)와 동철 이의어는 위 규칙대로 처리하며, 동철 이의어 철자는 기존 관계로 간주하지 않는다.

**Stage 2 다음 작업 선택(#927):** 완료 단위는 `(shard, batch, part)`다. 순서는 샤드 001부터 Batch 01→02, 각 Batch 안에서 Part 01→05(legacy 001–005) 또는 01→02(006+)의 Canonical 순서다. **War Room은 마지막으로 머지된 Stage 2 생산 PR(`[S2/<Model>] SSS_BB Part PP`)의 바로 다음 Part를 고르고**, 그 Part의 필수 Stage 1 파일 6개가 최신 master에 없으면 실행을 멈춘다. 진행 중인 작업만 Store의 완료·진행 기록으로 복구한다. War Room 밖에서 Part를 지정하지 않고 직접 호출할 때만, 같은 순서에서 필수 Stage 1 파일이 최신 master에 있고 그 master의 정확한 `verify --shard <SSS> --batch <BB> --part <PP>`가 아직 성공하지 못한 가장 이른 Part를 고른다. 이 `verify`는 다음 작업을 찾는 수단이지, 이미 머지된 Part의 완료를 다시 판정하는 검사가 아니다. **완료된 Part는 이후 Polish·Stage 3 등으로 파일이 바뀌어도 완료로 남는다**(§5 배치 완료 불변식). 해당 Part의 편집 세션 하나가 PR 하나다. 같은 샤드의 열린 Stage 2 또는 Stage 3 PR이 있으면 누적 `relation-<SSS>.jsonl`/`drop-<SSS>.jsonl`의 충돌을 막기 위해 다음 Part를 시작하지 않는다. 정식 Polish 데이터 PR은 이 점유에서 제외한다(§5). PR 머지 후 최신 master를 기준으로 다음 Part를 준비한다. 각 Batch의 **모든 유효 Part**가 성공적으로 검증된 뒤 `verify --shard <SSS> --batch <BB>`를 실행하고, 해당 샤드의 **모든 유효 Part**가 끝난 뒤 `verify --shard <SSS>`를 실행한다(legacy 샤드는 Batch당 5 Part·샤드당 10 Part, 006+ 샤드는 Batch당 2 Part·샤드당 4 Part이며, 샤드 428은 Batch 02의 Part 01만 유효하므로 신규 layout에서 총 3개 Part). 후보가 없거나 전부 다른 승인 관계로 처리된 범위도 `verify` 성공으로 완료될 수 있다. #927은 이 순차 생산·검증 계약을 계속 소유하며, 구현 이슈 #1665만 구현 완료 후 닫는다.

## 4. Stage 3 — Relation Editorial Refinement (#2455)

> **구현 상태:** [#2450](https://github.com/neverworkalone/typewriter/issues/2450)의 구현 작업은 종료되었으며 Stage 3 CLI(`scripts/relation/edit-cli.mjs`), War Room `s3` 실행(`tools/warroom/warroom/stage3.py`) 및 Stage 2 연계 reconcile 경로가 마련되어 있다. 실제 샤드 작업은 [#2455](https://github.com/neverworkalone/typewriter/issues/2455)의 선행 조건·검증·점유 규칙을 따른다. 구현 완료는 특정 샤드의 파일럿/생산 완료를 의미하지 않는다. 이 Factory 생산 단계는 REVIEW.md의 *PR review Stage 1(기술 검토) / Stage 2(최종 HEAD·CI 확인 및 merge)*와는 별개다.

**목적:** Stage 3는 **Stage 2 최종 편집 품질을 독립적으로 감사**한다(#2544). Stage 2와 동일한 작가 관점의 표현 가치 기준으로 잘못 승인된 관계·Sense·Link Repair 필요성을 확인하고 필요한 교정을 수행하되, 대량 편집을 정상 운영의 전제로 삼지 않는다. 과거 preserve-first 기준으로 생산된 샤드를 소급 재편집하거나 당시 Stage 2를 지침 위반으로 평가하지 않는다. Stage 3의 삭제 비율은 원인 진단 지표일 뿐 목표/쿼터가 아니며, 독창적이고 유용한 연상은 보호한다. 기존 Drop·Link Repair 교정 능력은 유지한다.

**허용:** (1) 승인 Relation **한 행 전체를 삭제**하는 Drop, (2) 기존 **text-only 관계를 정확한 Canonical target record/sense의 ID 관계로 전환**하는 Link Repair. Repair는 기존 `tp/rv`를 보존한다. ID 행 삭제는 **해당 행이 만든 정·역방향 투영**을 제거한다. 다른 살아 있는 Relation이 같은 meaning-level 관계를 만들면 제품 화면의 링크는 남을 수 있다. 표제어·Sense·후보·새 관계 추가, 대상어 바꿔치기, Type/Tier 재판정, STDICT direct/antonym 편집은 금지한다.

Stage 3의 사후 국소 Link Repair는 `edit-cli`에 `--batch BB --part PP`를 함께 지정한다. 이 경로는 정식 Stage 2 `partScope`와 같은 Canonical 순서로 source record/sense 집합을 만들고, 그 범위에서 현재 text-only 행만 준비한다. scoped checkpoint는 샤드 전체 Stage 3 checkpoint와 분리하며 `save-chunk`는 `L <row> T<target>` 또는 `none`만 허용한다. `apply`는 exact target, source/target gloss와 동철 선택지, 충돌, 양방향 후보 회계를 기존 Stage 3 검증기로 확인하고 Relation 파일만 갱신한다. 대상 표제어가 없거나 의미가 확실하지 않으면 text-only 상태로 둔다. 사용 예:

```sh
node scripts/relation/edit-cli.mjs prepare --shard 002 --batch 02 --part 02
node scripts/relation/edit-cli.mjs read-chunk --shard 002 --batch 02 --part 02
node scripts/relation/edit-cli.mjs save-chunk --shard 002 --batch 02 --part 02 --in .warroom-scratch/decisions.txt
node scripts/relation/edit-cli.mjs apply --shard 002 --batch 02 --part 02
```

`edit-cli`의 `prepare`·`refresh-pending`·`apply`도 다른 샤드 Relation 가운데 **이 샤드 Sense를 출발·대상으로 갖는 행만** 읽는다(#6555). ID pair 충돌, reverse 후보형, 고아·text Drop, 행 검증과 accounting은 모두 이 샤드 Sense로 시작하는 키로만 다른 샤드 행을 조회하고, 다른 파일의 Drop 중 이 샤드 Sense를 출발로 갖는 행은 전체 로딩에서도 제외되므로 결과는 전체 행을 읽을 때와 같다.

**Refinement Engine (#6555):** `edit-cli`는 정제 단계(S3 이후) 공통 코어 `scripts/relation/refine/core.mjs`와 Stage 3 규칙 `scripts/relation/refine/rules/s3.mjs`로 이루어진다. 코어는 projection 문맥, Sense 그룹 chunk, prepared view와 digest, checkpoint, 원자적 두 파일 apply, 고아 후보 `z` 회계와 기존 검증기를 맡는다. 규칙은 chunk view, 결정 문법, 결정에 따른 행 변환, Git diff에서 결정을 역산하는 방법만 정한다. 정제 PR의 리뷰 수정은 같은 계산을 다시 쓴다.

- `decisions --shard SSS --base <sha>`: PR base..HEAD diff에서 PR의 결정(base Relation 파일의 1부터 시작하는 행 번호)을 복원한다. 별도 원장 없이 PR 자체가 상태다. base 이후 이 샤드의 두 파일 밖을 바꾼 PR, 행을 추가하거나 순서를 바꾼 PR, base Drop 행을 바꾼 PR은 거부한다.
- `amend --shard SSS --base <sha> --in <delta>`: `amend` 다음 줄에 `D <row...>`(삭제), `L <row> <target_sense_id>`(Link Repair), `K <row...>`(base 행 유지)를 쓴다. 복원한 결정에 delta를 적용하고 apply와 같은 계산으로 base 파일에서 두 파일을 다시 만든다. 같은 입력이면 같은 bytes가 나오므로 중단 뒤에는 같은 요청을 다시 실행한다. 영수증의 `outputs`는 각 파일의 sha256이다.
- 입력 자체가 거부되면(문법, 없는 행, 같은 표기가 아닌 target) exit 2와 `{"version":1,"ok":false,"family":"input","error":…}` 한 줄을 출력하고 아무것도 쓰지 않는다. 그 밖의 실패는 exit 1이다.

**정제 PR 리뷰 수정 (#6555):** War Room의 Stage 3 FIXING에서 AI는 판정만 제출한다. 리뷰가 지적한 Sense의 base 행과 현재 결정을 `decisions --senses`로 받고, `.warroom-scratch/s3-fix-response.json`에 `{event_keys, amend, reply}`를 쓴다. Supervisor의 Review FIXING Coordinator(`tools/warroom/warroom/fixcoord.py`)는 그 amend를 PR base에서 실행하고, amend가 바꾼 샤드 파일만 commit한다. 정확한 commit을 `verify --shard`로 한 번 검증한 뒤 push하고, 답글을 한 번만 게시한다. 완료는 기존 Stage 3 범위·답글 게이트가 판정한다. 입력 거부는 같은 세션에 사유와 함께 정해진 횟수까지 돌려보내고, 실행 실패는 같은 입력으로 한 번 다시 실행한 뒤 보존하고 멈춘다.

**정제 단계 추가 절차 (#6555):** S3 이후 정제 단계(S4~S10)는 War Room의 같은 정제 라인(`s3` method)에서 차례로 실행한다. 한 단계는 앞 단계의 전체 샤드가 끝난 뒤 시작한다. 각 샤드는 Stage 3가 Stage 2에 묶이듯 앞 단계의 그 샤드 완료(`<앞 단계 id>_ok_SSS`)에 묶인다. 병렬 chunk, finalize, merge 후 verify, Review FIXING Coordinator, Maintainer 처리는 모든 단계가 공유하고, batch의 `batch` 값(`spec.tag`, Stage 3는 `all`)으로 단계를 구분한다. 새 단계를 추가할 때 필요한 것은 다음이다.

1. **JS 규칙:** `scripts/relation/refine/rules/sN.mjs`에 허용 결정, chunk view, 결정 문법, 행 변환, diff 역산, amend delta를 정하고, `createRefineCli`로 그 단계의 CLI 진입점을 만든다.
2. **프롬프트:** `tools/warroom/prompts/`에 chunk, fix, 정책 카드 프롬프트를 둔다(placeholder는 Stage 3와 같다).
3. **War Room spec:** 단계의 답변 규칙(`decision_text`, `decision_context`, `validate_prompt_view`, `normalize_decisions`)과 `refine.register(refine.RefineSpec(...))` 항목 하나를 둔다. 항목에는 id/tag/label/PR 제목/이슈/CLI/scratch/프롬프트 이름/앞 단계 게이트/`fixcoord.FixSpec`이 들어간다. 편집 범위는 `RefineSpec.scope()`가 정의하고, 다른 샤드 관계를 편집하는 단계는 `cross_shard`, PR 없는 무변경 완료는 `no_change_complete`로 선언한다(Stage 4 §4-E). 규칙이 키 기반이면 JS 규칙에 `keyed`/`crossShard`를 둔다.
4. **테스트:** 규칙 전용 테스트를 둔다.

### 4-A. 파일·후보 회계

- **기존 파일만 사용:** `data/relations/relation-SSS.jsonl`에서 Drop 관계를 삭제하고 text-only를 ID 관계로 고친다. `data/relation-drops/drop-SSS.jsonl`에는 **삭제 후 어떤 Relation/역방향 커버도 처리하지 않는 후보 키**만 기존 `{id,sid,cd,by:"z"}`로 추가한다. 같은 후보에 다른 유효 target Sense 관계가 남았다면 Drop하지 않는다. 여러 `fm`, legacy/`ver:0` 추론, `rfm`은 Stage 2의 동일한 후보 귀속 규칙으로 계산한다.
- **Drop 소유:** `drop-SSS`의 `sid`는 항상 SSS의 Canonical source sense에 속한다. 다른 샤드 sense를 넣는 foreign tombstone이나 별도 `edit-SSS.jsonl` 원장은 금지한다. 다른 샤드의 역방향 고아 후보는 **그 샤드 자체 Stage 2 흐름에서** 원인에 따라 처리한다.
- **Stage 3 Drop은 출발 의미와 무관해야 한다는 뜻이 아니다.** 후보가 의미상 유효해도 단순 활용형, 어미 변이, 명사화, 반복·중복, 효용 없는 유의어, 가치 없는 연상 또는 잘못 결속된 Sense면 Relation 삭제 후 고아 후보 Drop이 될 수 있다. 이는 **Stage 2가 먼저 걸러야 할 유형을 감사하며 놓친 사례를 교정**하는 것이지 Stage 3 전용으로 분리된 느슨한 승인 기준이 아니다. Stage 3는 고아 후보의 회계 코드로 `by:"z"`를 만들며, 이 값은 Stage 2 `x`와 달리 출발 sense와 무관하다는 뜻이 아니므로 gloss-name 반례 검사에서 면제한다. Stage 2 편집자는 `x/e`만 판단하며, Supervisor 기술 실패는 위 #2874 계약을 충족할 때만 `f`를 사용한다.
- **Link Repair:** 동일 표기 Canonical의 **모든 target Sense 및 전체 뜻풀이**를 비교해 정확한 하나를 선택한 경우에만 `{id,sid,tid,tsid,tp,rv,ver:1,fm:[tt],rfm:[…]}`로 교체한다. Stage 2 신규 ID 링크와 Stage 3 Link Repair는 **이미 처리된 target Sense 후보형을 `rfm`에서 제외하는 공유 필터**를 사용한다. target 소유 샤드의 기존 Relation/Drop(`by:"z"` 포함)·역방향 커버로 이미 결정된 형태는 `rfm`에서 제외한다. 아직 판정 전인 실제 후보형은 기존 계약대로 유지한다. 불명확하면 text-only 유지. 중복 ID 쌍·역방향 중복은 금지한다.
- 최종 빌드는 계속 **`pnpm run build`**. 빌더나 persisted JSONL 스키마를 변경하지 않는다. SQLite의 meaning-level 병합/중복 출처가 있을 수 있으므로 관계 삭제의 최종 표시 효과는 실제 provenance를 고려한다.

### 4-B. 실행·토큰·PR 경계

1. **Stage 2 샤드 전체 완료 후 시작.** 최근 master에 머지된 Stage 3 생산 PR의 바로 다음 샤드를 선택하고, 해당 샤드의 Stage 2 완료 기록이 없으면 실행을 종료한다. Stage 2 Part 완료만으로 Stage 3를 시작하지 않는다. 같은 샤드 Relation/Drop을 수정하는 열린 Stage 2/3 PR이나 활성 작업이 있으면 대기한다. 정식 Polish 데이터 PR은 대기 사유가 아니다(§5).
2. **AI 청크: 관계 350~500행 목표**, 출발 Sense의 관계 목록은 **분할하지 않는다**. 한 청크에 여러 Sense를 묶을 수 있다. Source Sense별 전체 gloss를 한 번 제공하고, target 의미 구분에 필요한 경우 ID Sense 뜻풀이를 제공한다. Link Repair 대상은 동일 표기 전체 Sense·전체 gloss를 제공한다.
3. **최소 출력:** `chunk NN` 뒤에 `D 1 5 9`, `L 4 T1`, 또는 `none`만 출력. Keep은 별도 출력하지 않고 기존 Relation을 유지한다. 청크마다 새 AI 세션을 사용하고 이미 검토한 청크 전체를 반복해서 읽지 않는다. 재개용 로컬 checkpoint는 청크 완료 여부와 결정만 저장한다.
4. **Shard당 Stage 3 데이터 PR 한 개.** 모든 청크 완료 후 Relation/Drop에 한꺼번에 반영하고 기존 `validateRelationRows`/`verifyAccounting` 및 실제 DB 결과를 확인한다. 생산 PR은 **해당 샤드의 Relation/Drop 두 파일만** 변경한다. Stage 2와 Stage 3의 같은 샤드 작업 경합은 금지한다.
   - **청크 병렬 판정(#3149):** War Room Supervisor는 새로 시작하는 샤드의 `edit-cli` 청크를 오너 설정 `stage3_max_parallel`(기본 16) 범위에서 독립 answer-only 세션으로 동시에 판정할 수 있다. checkpoint 저장은 Supervisor의 단일 경로가 `save-chunk --chunk NNN --expect-view-sha256`(view digest 결속, 동일 입력 재저장은 `already_saved`, `decisions[]`는 행 순서 정렬)로 맡으며 완료 순서는 결과에 영향을 주지 않는다. worker는 다른 AI/CLI를 시작할 수 없고, 모델·effort·정책 카드·청크 크기·`apply → verify → PR` 흐름과 샤드당 PR 하나는 그대로다. 진행 중인 직렬 샤드와 `--batch/--part` 국소 Link Repair는 바뀌지 않는다.
5. **리뷰:** Repair는 전건 정확한 source/target Sense 및 gloss 확인, Drop은 실제 PR diff에서 위험도 기준 표본 검토. 4만여 관계를 리뷰 AI가 다시 전수 편집하지 않는다. 잘못된 ID·고아 후보 회계·유익한 연상의 체계적 부당 삭제는 blocker; 취향 차이는 blocker가 아니다. 문서·지침 변경은 **별도 `no-review` PR**로 분리한다.

### 4-C. Cross-shard와 기존 Stage 2 보호

- 샤드 S의 Stage 3 ID Relation 삭제로 다른 샤드 T의 역방향 후보 커버가 사라질 수 있다. **모든 `missing`을 자동 Drop하는 것은 금지.** 이미 준비되었거나 완료한 T의 실제 Stage 1 후보이고, **실제 머지된 Stage 3 데이터 PR의 변경 파일/삭제 ID 행을 확인하고 삭제 전후 후보 커버리지를 비교해 그 관계로 인해 커버가 사라졌음이 입증**되고, 현재 다른 처리 관계/Drop도 없을 때만 T 자신의 `drop-TTT`에 `by:"z"`를 추가하는 결정적 reconcile을 허용한다.
- **삭제 근거의 범위:** 실제 머지된 Stage 3 데이터 PR과 그 삭제 행을 기준으로 한 번에 계산한다. 정방향 `by:"z"` Drop이 있으면 보조 근거로 사용할 수 있지만 **필수 조건으로 삼지 않는다**. 정방향 후보가 다른 Relation에 계속 커버되어 Drop이 없더라도 삭제된 행 때문에 **역방향** 후보는 고아가 될 수 있기 때문이다. 일반 Stage 2 `amend`의 삭제는 Stage 3 PR 삭제가 아니므로 자동 reconcile에 포함하지 않는다. 후보마다 반복해 GitHub를 검색하거나 별도 영수증을 쌓지 않는다.
- **C-3 / 역방향 후보 충돌 방지:** 기존 Stage 2 신규 ID 행의 `rfm` 전체 자동 채움은 금지한다. 신규 Stage 2 ID 링크와 Stage 3 Link Repair 모두 **target 소유 Sense에서 이미 Relation/Drop/역방향 커버로 결정된 후보형을 제외**하는 동일 공유 함수를 사용한다. 특히 Stage 3가 S에 기록한 `by:"z"` Drop을 다른 샤드 T가 신규 링크의 `rfm`으로 다시 claim해 S의 verify를 깨뜨리지 않아야 한다. 다만 동일 ID 쌍을 T가 나중에 재승인할 수 있는 것은 별개 문제이며 T의 Stage 3에서 편집한다.
- 아직 Stage 2 준비 전인 T의 후보는 **미리 Drop하지 않는다**. T가 동철 다른 Sense와 연결할 가능성을 기존 Stage 2 판정에 남긴다. 같은 ID 쌍이 나중에 다시 승인되면 그 소유 샤드의 Stage 3에서 판단한다.
- 진행 중인 Stage 2 Part가 오래된 Relations를 기준으로 최종화하지 않게 **AI 판정이 끝난 후, materialize/premerge 전에 최신 master를 안전하게 반영**한다. 기존 AI 판단과 checkpoint를 보존하며 안전한 병합 불가 시 작업을 보존하고 명시적으로 정지한다. Stage 3 변경만으로 AI를 전수 재실행하지 않는다.
- 영향 샤드 확인은 실제 변경된 Relation의 **양 끝 Sense 소유 샤드** 중심으로 하고, 자기 Drop/Candidate·공유 검증 코드·Canonical 등 기존 입력 변화는 계속 감지한다. 불명확한 경우 안전하게 verify한다. 재검증을 위한 새 SHA 영수증, 정책 digest, 전체 Sense 감사 원장, 범용 stale 시스템은 만들지 않는다.
- Stage 3 순차 위치는 최근 머지된 생산 PR을 확인해 정하며, Store에서는 진행 중인 작업만 기존 절차로 복구한다. 실제 머지 후 해당 샤드의 검증과 완료 처리는 유지한다.

### 4-D. 편집 판단

- **Drop:** 활용형/같은 어근의 단순 어미 변이 (`깜빡대다→깜빡이다`, `어정대다→어정거리다`), 형식만 바뀐 명사화 (`조퇴하다→조퇴`), 반복 (`팔딱하다→팔딱팔딱`), 가치 없는 같은 뜻 되풀이, 잘못 결속된 Sense 및 **작가가 활용할 수 있는 연상 경로가 없는** 관계. `팔딱하다 s1→심장`, `어정대다→낙타`는 정확한 출발 Sense와 표현 가치를 개별 검토하며, 단지 멀거나 낯설다는 이유로 자동 Drop하지 않는다.
- **Keep:** 실제 문장/장면/감각의 새로운 선택지를 여는 `깜빡대다→가물가물`(기억 Sense), `→점멸/명멸`(빛 Sense) 등. 낯설거나 Tier가 높다는 이유만으로 일괄 삭제하지 않는다.
- **판정 시야:** 출발 Sense의 해당 샤드 소유 Relation 전체를 함께 보고 중복과 선택지를 비교한다. ID 삭제가 역방향에도 미치는 영향을 감안한다. 형태 패턴을 정규식으로 자동 Drop하지 않는다.

**프롬프트 등록(완료):** `tools/warroom/warroom/prompts.py`의 `prompts.ALLOWED`에 `s3_policy_card`와 `s3_chunk`가 등록되어 있으며 War Room은 해당 템플릿을 사용한다.

**구현 이력·파일럿:** [#2450](https://github.com/neverworkalone/typewriter/issues/2450)은 정책·Stage 2 회계/최신 master/reconcile·Stage 3 CLI·War Room 연계의 구현 계획이었다. 파일럿 및 각 샤드의 실제 완료 여부는 [#2455](https://github.com/neverworkalone/typewriter/issues/2455)의 실행 결과와 **머지된 Stage 3 데이터 PR·검증 상태**로 판단하며, 계획 이슈의 종료만으로 완료 처리하지 않는다. 삭제율 목표는 없다.

### 4-E. Stage 4 — 선별적 Polish (#9928, #9929)

**목적:** Stage 3 전체 완료 뒤 샤드마다 작가가 직접 검색할 Sense를 골라 #8777과 같은 기준으로 Add/Drop/Set/재결속을 하고, 나머지 Sense는 Skip한다. 편집 기준은 [relation-editorial-policy.md](relation-editorial-policy.md)의 *Polish and Stage 4* 절, 생산 지시는 [#9929](https://github.com/neverworkalone/typewriter/issues/9929)다.

- **CLI:** `scripts/relation/s4-cli.mjs`(`pnpm run relation:s4`). Refinement 코어(`createRefineCli`)와 keyed 규칙 `scripts/relation/refine/rules/s4.mjs`로 이루어진다. 결정은 base 행 번호가 아니라 **관계 키**에 묶인다. 데이터 변경은 모두 Polish 쓰기 경로(§5, `polish-cli.mjs apply`)를 거친다. 따라서 `by:"p"`, 실제 고아에만 `z`, 제외 문맥 `p`, 재승인 정산과 영향 샤드 공통 검증이 그대로 적용된다.
- **청크:** 샤드의 모든 Canonical record를 Sense 단위로 보여 준다. 관계 없는 Sense도 포함한다. 각 Sense 아래에는 자기 정방향·text 관계와, 어느 샤드에 저장되었든 그 Sense를 target으로 갖는 역방향 ID 관계를 둔다. record는 나누지 않고, 관계 수(빈 Sense는 1) 350~500 기준으로 청크를 만든다. 같은 샤드 두 Sense 사이 관계는 양쪽에 모두 보인다.
- **판정 문법:** `skip <j...>`, `D <n...>`, `C <n> <type> <tier>`, `A <j> <sense_id|"text"> <type> <tier>`, `B <n> <sense_id|"text"> [<type> <tier>]`(상대 끝 재결속), `M <n> <j>`(같은 표제어의 다른 Sense로 이동), 또는 `none`. 정확한 Canonical 대상은 청크당 한 번 묶어 실행하는 `lookup --text a,b`로 찾는다. Add가 없는 청크에는 실행하지 않는다.
- **save-chunk:** 문법은 맞지만 적용할 수 없는 줄은 그 줄만 폐기하고 보고한다. 해당하는 경우는 모르는 번호·Sense ID, 이미 있는 관계, 자기 record 대상, action 대상 POS, Skip한 Sense를 검토하며 낸 편집이다. 유효한 판단이 하나도 남지 않은 응답은 저장을 거부한다(`none`을 대신 만들지 않는다).
- **apply:** 모든 청크의 결정을 키 단위로 해결한 뒤 HEAD 기준으로 Polish 계획을 한 번 세우고 바뀐 파일을 원자적으로 쓴다.
  - 같은 편집은 한 번만 적용한다.
  - 같은 키(기존 키와 재결속·Add가 새로 만드는 키 포함)를 다투는 결정은, 저장 source Sense를 검토한 청크의 결정 → 낮은 청크 번호 → 고정 내용 순으로 하나만 남긴다.
  - 재결속(Drop+Add)은 통째로 이기거나 진다. 저장·AI 종료 순서는 결과에 영향을 주지 않는다.
  - 같은 checkpoint로 다시 실행하면 `already-applied`다. 바뀐 것이 없으면 `no-change`다.
- **편집 범위:** 모든 편집은 생산 샤드의 Sense를 한쪽 끝으로 갖는 관계와 그에 따른 회계 행뿐이다. 이 검사는 apply/amend 공통 함수 하나(`assertScope`)가 맡는다. 역방향만 고쳐 생산 샤드 파일이 바뀌지 않는 PR도 정상이다. Polish 회계 검사는 편집된 Sense를 가진 record로 범위를 좁힌다. 그 밖의 record는 바뀌지 않기 때문이다.
- **PR·리뷰 수정:** PR 제목 `[S4/<Model>] SSS`, 본문 `Refs #9929`. `decisions --base`는 base..HEAD의 관계 키 차이에서 PR의 Add/Drop/Set을 복원한다(원장 없음). `amend`는 `A|C <source> <target|"text"> <type> <tier>`, `D|K <source> <target|"text">` delta를 적용해 PR base에서 같은 Polish 계산을 다시 한다. 관계·Drop 조회, 계획, 회계, 검증은 모두 같은 Git base에 결속된다. 같은 논리 편집이면 apply와 같은 bytes가 나온다.
- **검증:** `verify --shard SSS --base <merge-base>`는 PR 편집이 닿는 샤드(편집된 Sense의 소유 샤드와 생산 샤드)를 계산한다. 그 샤드들에 공식 `admission-cli verify --shard A,B,...`를 한 번의 실행으로 돌린다(Canonical 1회 로드). War Room은 최종화·리뷰 수정·replay 뒤 이 명령을 쓴다. 머지 후 완료 표식 `s4_ok_SSS`는 생산 샤드에만 남긴다.
- **무변경 완료:** 모든 청크가 정상 판정·저장되고 apply가 `no-change`이면, War Room은 그 HEAD를 위 verify로 확인한다. 그다음 `s4_nochange_SSS`를 기록하고 commit·PR 없이 worktree를 정리한다. 다음 샤드 선택은 마지막 머지 PR 뒤의 연속된 무변경 완료를 이어서 건너뛴다.
- **실패와 Skip은 다르다:** 정책 거부는 Keep-all로 저장하지 않고(`refusal_keep_all=False`) 일반 실패 경로로 보낸다. 판단이 없는 응답은 응답 누락 경로로 보낸다.
- **실행:** Stage 3 전체 완료 뒤 War Room 정제 라인이 샤드 001부터 차례로 실행한다(운영 설정은 `tools/warroom/README.md`의 *Stage 4 운영 설정*). 완료한 샤드는 이후 단건 Polish나 다른 샤드의 역방향 편집으로 파일이 바뀌어도 다시 열지 않는다. 첫 샤드 파일럿의 Skip/Polish Sense 수, Add/Drop/Set 수, 처리 시간, 토큰은 PR 본문·무변경 완료 로그의 기존 집계로 확인한다.

## 5. Polish — 직접 Relation 편집과 동시 변경 (#8784, #8777)

**Polish**는 오너가 지정한 단어의 현재 승인 Relation을 직접 Add/Drop/Set하는 상시 작업이다([#8777](https://github.com/neverworkalone/typewriter/issues/8777), `#8777 <단어> 진행해`). 새 Candidate를 만들거나 Stage 1/2를 다시 실행하지 않는다. 해당 단어·샤드의 Stage/배치가 미시작이든 진행 중이든 완료든 관계없이 실행한다. 편집 기준은 [relation-editorial-policy.md](relation-editorial-policy.md)와 같다. 공식 `direct/antonym`, Canonical, 생성 SQLite는 수정하지 않는다.

### 5-A. 저장 형식

```jsonl
# data/relations/relation-SSS.jsonl — Polish Relation (ID / text-only)
{"id":"wA","sid":"wA-s1","tid":"wB","tsid":"wB-s1","tp":"near","rv":3,"by":"p"}
{"id":"wA","sid":"wA-s1","tt":"짧은 표현","tp":"scene","rv":5,"by":"p"}
# data/relation-drops/drop-SSS.jsonl — Polish 제외 문맥 p (ID 쌍 / source Sense + text)
{"id":"wA","sid":"wA-s1","tid":"wB","tsid":"wB-s1","by":"p"}
{"id":"wA","sid":"wA-s1","tt":"제외한 표현","by":"p"}
```

- **Polish Relation `by:"p"`**는 출처 표식이다. Candidate 할당 버전 `ver`/`fm`/`rfm`과 함께 쓸 수 없다. Polish가 존재하지 않는 Candidate 귀속을 주장하지 않는다는 뜻이다. 빌드는 미표식 행과 같은 제품 관계로 투영한다. ID 행은 한 행에서 정·역방향에 같은 `tp/rv`를 쓰고, text-only는 역방향이 없다. 기존 legacy·`ver:0`·`ver:1` 행의 해석과 바이트는 바뀌지 않는다.
- **후보 회계:** `by:"p"` 행은 Stage 1 claim을 만들지 않는다. source Sense의 Stage 1 후보와 대상 표기(정서법·큐레이션 검색형)가 **정확히 같을 때만** 그 후보를 기존 승인 관계처럼 cover한다. 같은 샤드, 다른 샤드, 역방향 모두 같다. cover되지 않은 후보의 `missing`, 이미 cover된 후보에 대한 별도 Drop 같은 이중 처리, 중복·역중복 ID 쌍은 계속 차단한다.
- **`z`와 `p`는 다르다.** Polish Drop이 실제 Stage 1 후보의 마지막 cover를 지우면, 그 후보의 소유 샤드(다른 샤드 `drop-TTT` 포함)에 기존 형식 `by:"z"`를 추가한다. 다른 Relation·역방향 cover·Drop이 남아 있으면 추가하지 않는다. 이와 별도로 `p`는 "Polish가 이 정확한 Sense 쌍/text 연결을 제외했다"는 편집 이력이다. 후보가 아직 없는 범위에도 기록하고, Candidate 회계에는 들어가지 않는다. Stage 2 `prepare`/compact 뷰는 해당 후보 아래 `X` 행으로 이 문맥을 보여 주지만 승인을 하드 거부하지 않는다. 같은 쌍·text를 다시 승인하면 공통 쓰기 경로가 그 `p`를 지운다. 새 관계가 실제로 cover하는 후보의 기존 Drop(`z` 포함)도 함께 지운다. 영구 블랙리스트는 없다.

### 5-B. 공식 도구 — `pnpm run relation:polish`

```sh
node scripts/relation/polish-cli.mjs show --word 고요하다 [--json]      # 또는 --record <id> / --sense <id>
node scripts/relation/polish-cli.mjs apply --input edits.json [--dry-run]
```

- `show`는 Sense마다 다음을 양방향으로 한 번에 보여 준다.
  - 승인 관계와 상대 Sense의 POS·뜻풀이
  - Type/Tier, 저장 파일:줄, relation key, 출처(`p`/`ver:N`/`legacy`)
  - STDICT `direct/antonym`(정·역), 이전 `p`
  - 행 번호는 조회 보조 정보이고, 편집은 relation key로 식별한다.
- `apply` 입력은 `{"edits":[{op, source_sense_id, target_sense_id|text, type, relevance, reason}]}`이다(`drop`은 `type/relevance` 없음).
  - `add`는 source 소유 샤드에 `by:"p"`로 쓴다.
  - `set`은 Type/Tier만 바꾸고 기존 출처를 보존한다.
  - `drop`은 저장된 방향 그대로 `p`를 남긴다.
  - 저장 전 확인 사항
    - 영향받는 모든 샤드에 공통 `validateRelationRows`
    - 편집 전후 Candidate 회계 비교: **새 문제가 하나도 없어야** 한다. 원래 있던 미완성 shard의 `missing`은 막지 않는다.
    - action 대상 POS
  - 변경 파일은 한꺼번에 원자적으로 저장한다. 같은 입력의 재실행은 no-op이다.
- AI는 Drop/Add/Set과 이유만 판단한다. 조회·회계·다른 샤드 영향·저장·검증은 CLI가 맡는다. 원격 파일 반복 다운로드, 다중 모델 탐색, 과거 batch 전체 재검사는 하지 않는다. 정본은 현재 JSONL이다.
- **지원 없는 JSONL 손편집이나 `verify --relations-only`만 통과한 변경은 정식 성공이 아니다.**

### 5-C. 관계 키 단위 동시 변경

배치(Stage 2 Part, Stage 3/정제 PR)와 Polish는 같은 shard 파일을 동시에 바꿀 수 있다. 반영은 행 번호나 파일 전체가 아니라 **관계 키**로 한다(`scripts/relation/relation-delta.mjs`).

- **키**
  - Relation: ID 링크는 방향 무관 정확한 Sense 쌍, text-only는 source Sense + 정규화 `tt`
  - Candidate Drop: source Sense + 정규화 후보
  - Polish 제외 `p`: 자기 쌍/text
  - Type/Tier는 키가 아니라 편집 가능한 값이다.
- **3-way 규칙:** 한 PR의 delta는 자기 기준선(merge base, Stage 2 premerge snapshot)에서 PR 결과까지의 키별 변경이다. 적용 시점의 최신 승인 데이터와 **그 키만** 비교한다.
  - 최신 값이 기준선과 같으면 PR 변경을 적용한다.
  - 기준선 이후 최신 쪽이 같은 키를 추가·수정·삭제했으면 **최신 값을 유지**하고, 그 키를 충돌로 간결하게 보고한다.
  - 무관한 키의 변경은 양쪽 모두 보존한다.
  - 밀려난 변경에서 파생된 기록도 함께 빠진다. PR이 지운 관계를 최신 쪽이 유지했으면 그 `p`가 빠지고, 최신 데이터가 이미 답한 후보의 PR 측 Candidate Drop(다른 샤드 역방향 `z` 포함)도 빠진다.
  - 결정적으로 풀 수 없는 경우(관계끼리의 claim 충돌, PR 소유 밖 데이터 파일 충돌)는 그 관계만 보고하고 아무것도 쓰지 않는다.
- **Git 텍스트 충돌(JSONL append/EOF 등)의 정식 해법은 최신 master 위 replay다.** 과거 기준 파일 전체 교체, 의미 판단 재생산, 광범위 재검증은 하지 않는다.
  - **배치 PR:** `pnpm run relation:replay -- --base <merge-base> --ours <PR HEAD> --theirs <최신 master>`
    - PR이 바꾼 모든 shard 데이터 파일을 다시 만든다.
    - 영향 shard의 공통 검증과 "새 Candidate 회계 문제 없음"을 확인한 뒤에만 쓴다.
    - Stage 3 PR은 이후 `decisions/amend --base <새 master>`로 같은 행 기반 결정을 계속 다룬다.
  - **Stage 2 Part:** `node scripts/relation/admission-cli.mjs replay --checkpoint <cp> --theirs <최신 master>`
    - 최신 데이터를 checkpoint `premerge.replay` 스냅숏으로 한 번 기록한다.
    - 이후 merge·checkpoint verify·amend의 기대값은 `premerge → materialize(checkpoint) → replay`의 3-way다.
  - **Polish PR:** Polish 결정은 명시적이므로, 최신 master에서 **같은 Polish 입력으로 `relation:polish apply`를 다시 실행**한다. 이미 반영된 편집은 no-op이다. 최신 데이터와 맞지 않는 편집이 있으면 입력 전체가 쓰기 전에 거부되므로, 그 관계만 다시 판단해 입력을 고친다.
  - 이 규칙은 동시 실행 중인 낡은 배치 판정이 Polish를 덮어쓰지 않게 하는 것이다. 미래의 새 Stage가 새 근거로 같은 관계를 다시 편집하는 것을 금지하지 않는다.
- **정식 Polish 데이터 PR**은 제목 `[Polish] <단어> 관계 정제`, 본문 `Refs #8777`이며 shard Relation/Drop 파일만 바꾼다. `Closes/Fixes/Resolves #8777`은 쓰지 않는다.
  - War Room의 shard 점유 판단(`batches.pr_stage2_shards`)은 이 모양의 PR만 점유에서 제외한다.
  - 본문·변경 파일 조건을 하나라도 벗어나면 제목만으로 예외가 되지 않는다.
  - Stage 2↔Stage 2, Stage 2↔Stage 3 점유는 그대로 유지한다.
- War Room은 리뷰 대기 중인 자기 Stage 2/3 PR이 기준과 텍스트 충돌(`mergeable:false`)하면 다음 순서로 처리한다.
  - 조건: AI 실행이 없고 처리할 리뷰 이벤트도 없을 것. (PR HEAD, base)당 한 번 실행한다.
  - 순서: `git merge --no-commit` → 충돌이 PR 소유 shard 데이터뿐인지 확인 → 위 공식 replay → merge commit → verify → 일반 push
  - 실패하면 merge를 중단하고 worktree·PR을 보존한 채 멈춘다.
  - Git이 깨끗하게 합친 변경은 PR CI와 리뷰가 확인하고, 문제가 있으면 같은 replay를 쓴다.
- **배치 완료 불변식:** War Room은 Stage와 배치/샤드의 완료 사실을 완료 기록과 마지막 머지된 생산 PR로 유지한다.
  - Polish 이후 파일의 SHA·mtime·바이트·snapshot이 바뀌었다는 이유로 완료를 무효화하거나 재실행·차단하지 않는다.
  - 완료 파일을 감시하거나 원래 내용으로 되돌리지 않는다.
  - 지금 반영할 변경의 키별 3-way 확인은 필수다. 그러나 이것은 과거 완료의 재검사와 다르다.
  - 다음 Stage는 Polish가 반영된 **현재 승인 Relations**를 입력으로 읽는다.

## 6. Build와 검증 경계

`pnpm run build`는 **Canonical JSONL + 승인된 Relations JSONL**을 읽어 Full/Lite SQLite를 결정적으로 생성한다. **Candidate 파일을 직접 읽어 DB를 만들지 않는다.** STDICT 원본 및 공식 `direct/antonym`은 보존하고, text-only/양방향 관계/방향별 Tier/UI 그룹·정렬을 공통 검증한다.

**현재 상태 (Issue #928):** 승인 Relations JSONL(`data/relations/relation-<SSS>.jsonl`)은 공식 Canonical 빌드에서 자동으로 읽힌다(고정 입력 디렉터리, 픽스처는 `relationsDirectory` 옵션). Candidate와 Drop은 빌드 입력이 아니다.

- ID 행 하나 → `meaning_relations` 두 행: 정방향과 역방향 모두 같은 저장 `tp`/`rv`를 사용한다. 둘 다 기존 `source_meaning_id` 조회·정렬 경로와 `idx_meaning_relations_target`를 그대로 쓰며, 같은 한 쌍은 한 행에서만 만들어져 중복 투영되지 않는다. 같은 두 meaning·같은 type에 여러 sense가 닿으면 가장 앞선 Tier 하나만 남긴다.
- text-only 행 → `meaning_text_relations`(Full/Lite 공통). 결과에는 텍스트로만 나오고 target이 없어 클릭·역방향이 생기지 않는다.
- authored 행은 STDICT `note` 대신 빈 note를 가지며 `direct/antonym`을 쓸 수 없다. 기존 STDICT 관계와 같은 쌍·type이면 조용히 병합하지 않고 빌드가 실패한다.
- Full에는 승인 파일 샤드·행 번호와 Canonical sense를 묶는 `meaning_relation_authored_sources`가 있고 Lite에는 싣지 않는다. 빌드 검증이 쌍 존재, 출처 존재, sense→meaning 결속을 확인한다. SQLite 스키마 버전 11.

**PR CI (#5807):** 순수 Stage 1 Candidate PR과 Stage 2/3 Relation/Drop PR은 변경 파일의 저장 계약과 변경 범위만 경량 검사한다([development.md](development.md#continuous-integration) 참고). 정확한 Sense 결속, 교차 샤드 충돌, 후보 accounting은 생산 CLI가 저장 전에 지키고, 독립 리뷰와 Deep CI 전수 감사가 확인한다.

은퇴한 Lexical Factory와 별도의 Meaning 편집 계층을 되살리지 않는다.
