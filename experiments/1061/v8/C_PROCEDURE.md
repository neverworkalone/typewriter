# C Procedure (V8) — recall-first 문학 후보 생산 레시피

Issue #1061 / #1109, method C(승인된 문학 SQLite의 실제 문맥). 이 문서는 특정 배치의
단어 답안이 아니라 **다른 C 배치에도 그대로 적용할 수 있는 생산 절차**다. 원문·발췌문·
SQLite·검색 로그·후보별 근거 상세는 Git에 넣지 않고 로컬 상태에만 둔다.

V8의 목표는 **Stage 2가 되살릴 수 없는 발굴을 최대한 넓히는 것**이다. 출발 sense의
실제 용례 확인은 엄격하게 하되, 그 용례에서 파생하는 관계의 강도·직접성·창작적
유용성은 보수적으로 재단하지 않는다. 후보 수 목표는 없고 `candidates: []`는 정당하다.

## 0. 최상위 원칙

1. **Stage 1은 발굴, Stage 2는 편집.** type·Tier·채택·target ID는 만들지 않고,
   KEEP/DROP/Tier를 흉내 내는 Gate로 후보를 대량 삭제하지 않는다.
2. **Hard technical 오류만 교정한다.** 잘못된 record/sense 결속, 다른 단어·다른 sense,
   부분 문자열 오탐, 실제 용례 없음, 출처·검색 날조, 정확 중복, 빈/깨진/형식 위반,
   설명 가능한 연결이 전혀 없는 임의 문자열. 이 외의 약함·느슨함·중복 뉘앙스는 보존한다.
3. **Recall은 유효하거나 잠재적으로 유효한 고유 관계의 폭으로 판단**하며, 문자열 수나
   균등 분포로 판단하지 않는다. 좋은 후보를 줄여 precision을 올리는 것은 역행이다.
4. 같은 (method) 작업을 중복 실행하지 않고, 다른 방식·모델의 후보는 읽지 않는다.

## 1. PRE-FLIGHT — 동결과 상태

1. Canonical 배치(500레코드)를 읽어 `record_id, sense_id, lemma, pos, gloss,
   search_forms`를 Canonical 순서로 동결하고 record/sense 수, 첫·마지막 ID를 기록한다.
2. Canonical 파일과 문학 인덱스의 SHA-256, 인덱스 계층(FTS5 trigram ≥3자, 2자
   `instr()` 스캔, 실제 포함+단어 시작 경계 재확인)을 기록한다.
3. sense별 상태를 로컬 ledger에 둔다:
   `PENDING → SEARCHED → INSPECTED → BOUND → DISCOVERED → RECOVERED → OUTPUT`,
   실패는 `ZERO_HITS / UNSEARCHABLE / SEARCH_FAILED / NO_VERIFIED / INCOMPLETE`로 구분한다.
4. 25–35 record마다 체크포인트를 저장한다. 미수행 sense를 빈 후보로 미리 확정하지 않는다.
5. 작은 결정적 파일럿(검색 가능·불가·다의어·이전 후보 포함)으로 도구 오류만 보정하고,
   본 실행 중에는 특정 단어에 맞춰 규칙을 바꾸지 않는다.

## 2. PASS A — sense별 실제 문학 문맥 탐색

- Canonical `search_forms`를 기본으로 하고, 용언/형용사는 `-다`를 뗀 어간과 불규칙
  활용형(ㅂ/ㄷ/ㅅ/ㅎ/ㄹ, `르`·`우`)을 규칙 기반으로 추가한다. 1자 어간은 일반 어미를
  붙인 형태로만 검색한다.
- **2차 활용형 보강(선택):** 1차 검색에서 VERIFIED가 0인 용언·형용사에 한해 마지막
  음절에 받침 ㄴ/ㄹ/ㅁ을 결합한 관형사형(`검누르다→검누런`, `게시하다→게시한`,
  `거세차다→거세찬`)과 `-는/-면/-고/-지/-서/-니/-던`을 추가 검색한다. 관형사형은
  원형 어간 검색이 놓치기 쉬운 실제 용례를 회수한다.
- 창 전개: sense마다 1–4를 실제로 읽고, 다른 문맥이 남으면 5–8, 유용하거나
  **잠재적으로 유용한** 새 관계가 나오면 9–12, 또 나오면 13–16으로 확대한다.
  문맥을 읽지 않고 숫자만 `inspected`로 세지 않는다. 16문맥 상한과 검색 경로의
  한계는 RUN에 명시한다.
- 다양성: 작품·작가·장르를 중복 없이 고르고 작품당 최대 2문맥을 선호한다. 한 record의
  첫 hit를 여러 sense의 증거로 재사용하지 않는다.
- **출발 sense 결속은 엄격하게:** `VERIFIED`는 실제 텍스트에서 그 Canonical sense의
  사용을 확인한 경우, `AMBIGUOUS`는 다른 작품·문맥으로 재확인 시도, `REJECTED`(다른
  sense/단어/부분 문자열)는 이 출발 sense 후보의 증거가 될 수 없다. 동음이의어·다른
  품사·다른 뜻은 사유와 함께 로컬에 남긴다.

## 3. PASS B — 7관점 OPEN DISCOVERY, 2회 sweep

실제 VERIFIED 문맥마다 다음 7관점을 적용한다(이 단계에서는 가치 판정을 하지 않는다).

1. **Image** 색·모양·빛·대상·시각적 변화
2. **Action** 동작·몸짓·행동·반응
3. **Emotion** 정서·태도·심리 변화
4. **Sensation** 소리·촉감·냄새·맛·온도·신체감각
5. **Scene/Situation** 장면·서사·시공간·사건
6. **Causality** 원인·결과·변화의 파급
7. **Metaphor/Contrast** 비유·상징·대조, 느슨하거나 예상 밖의 연상

관점마다 (a) 문맥 읽기 → (b) 명시·간접·느슨한 이미지·대비까지 탐색 → (c) 후보 풀에
저장 → (d) 다른 가능성 한 번 더 탐색 → (e) 없으면 0 기록. 첫 후보에서 멈추지 않는다.

- **원문 표현, 활용형, 문맥에서 자연스럽게 떠오르는 작가의 선택지**를 균형 있게 모은다.
  한 작품에서만 나온 비유·의외의 감정·느슨한 연결도 의미적 가능성이 있으면 보존한다.
  `source + 동사/수식어`를 기계적으로 덧붙여 개수를 채우지 않는다.
- **다양한 연결을 1개로 축약하지 않는다.** 같은 장면의 시각·색·몸짓·정서·결과가 각각
  작가의 선택지면 각각 남긴다. 시점·어조·강도·이미지가 다른 유사 표현도 보존한다.
- 후보마다 로컬에 `sense_id, context_locator, textual_anchor, lens, candidate,
  derivation(exact|inflected|inferred), connection_hint, discovery_pass`를 남긴다.
  `connection_hint`는 설명용이며 완전한 인과 증명서가 아니다. 강한 설명을 쓰기 어렵다는
  이유로 후보를 버리지 않는다.
- **두 번째 독립 sweep을 반드시 수행한다.** 전체 VERIFIED 문맥에 7관점을 다시 적용하되
  1차 결과를 답안으로 고정하지 않고 누락된 새 관계·대비·이미지를 찾는다.

## 4. PASS C — 이전 버전에서 잃은 후보 회복

- 자신의 V5/V6/V7 후보 문자열을 `sense_id + 정규화 candidate`로 합쳐 복원한다.
  특히 이전 버전의 편집상 DROP/REWORK는 Stage 2의 최종 판정이 아니므로 되돌린다.
- 완전히 잘못된 source sense, 읽지 않은 문맥에 의한 오탐, 글자 부분 일치, 지어낸 원문
  같은 **기술적 결함만** 제거한다.
- 실제 VERIFIED 문맥이 있고 의미 연결이 가능하면 약하거나 DROP 가능성이 높아도 유지한다.
  근거 로그가 없으면 문맥을 재조회·재발굴한다. 끝내 해당 sense의 실제 용례를 확보하지
  못한 항목은 출력에서 빼고 `STILL_UNVERIFIED_SOURCE`로 보고한다(편집상 품질 DROP이 아님).

## 5. PASS D — 최소 Stage 1 hygiene

- **수정/제외 가능(하드):** 정확한 record/sense 결속, 다른 단어·다른 sense, 부분 문자열
  오탐, 존재하지 않는 원문·locator 날조, 출발 lemma와 정확히 같은 후보, 동일 sense 내
  정규화 정확 중복, 빈/깨진/허용 불가 형식, Candidate v1 위반, 설명 가능한 연결이 전혀
  없는 임의 문자열.
- **삭제 금지(소프트):** 느슨한 이미지·정서·비유, 좁고 개인적인 문맥, 원문/유도 중
  어느 쪽이 더 좋은지, 의미가 가까운 후보 여러 개(정확 중복 제외), 표제어를 포함한
  실제 문학 표현, 흥미로운 배경 장면·간접 대비, Stage 2가 낮은 Tier로 보낼 약한 후보.
- 상태는 로컬 ledger에만 기록하고 Candidate JSONL에는 confidence/quality/tier/state를
  넣지 않는다.

## 6. PASS E — 실행 완전성과 출력

1. Canonical 배치 500레코드/전체 sense의 순서·ID·모든 sense 보존, 후보 배열 구조 계약.
2. 검색 실패·미완료를 정상 `[]`로 위장하지 않았는지, VERIFIED·inspected 계수가 맞는지,
   창 전이와 7관점 1·2차 sweep을 실제로 했는지 확인한다.
3. 이전 후보 전량의 lineage를 `RECOVERED / STILL_UNVERIFIED_SOURCE /
   TECHNICAL_EXCLUDED / EXACT_DUPLICATE`로 귀속하고, 실질 후보를 없앤 이유가 기술
   오류에 한정되는지 개수 정합성을 확인한다.
4. 원문/유도/활용형 후보 수, 관계 관점 다양성, sense 활성 분포를 기록한다. 총 후보 수나
   균등 분포는 합격 조건이 아니다.
5. `node scripts/relation/candidate-contract.mjs`의 `validateCandidateBatch` 계약을
   통과해야 한다(캘리브레이션 산출물처럼 실험 경로에 둘 때는 경로 검사 대신 batch 검증
   함수를 직접 호출하고 그 사실을 RUN에 밝힌다).
6. 상세 evidence 로그는 로컬만. PR에는 원문·DB·검색 로그를 넣지 않는다.

## 7. 산출물

- `experiments/<issue>/v<version>/<SSS>_<BB>_c_<model>.jsonl` — Candidate v1 전체 배치.
- `C_PROCEDURE.md` — 이 레시피(다른 배치에 그대로 적용 가능).
- `C_RUN.md` — digest, 검색·판독·VERIFIED 계수, 7관점 2회 sweep, 창/정지 사유,
  이전 버전 회복 통계, 기술적 제외 사유, Stage 2에 남긴 사례, 한계·비용.
- PR은 `no-review`, `Refs #<issue>`(이슈 재사용 시 `Closes` 금지). 오너/ChatGPT의
  독립 평가 전에는 FREEZE·배치 생산을 시작하지 않는다.

## 8. 사용자-facing 생산 프롬프트(짧게)

> 승인된 문학 SQLite의 실제 문맥에서, 정확한 출발 sense가 쓰인 용례를 엄격히 확인한 뒤,
> 7관점(이미지·행동·정서·감각·장면·인과·비유/대비)으로 작가에게 유용한 표현·이미지·
> 연상을 **가능한 폭넓게** 모아라. 2회 sweep으로 누락을 찾고, 이전 버전에서 잃은 후보를
> 기술적 결함이 아닌 한 복원하라. 관계의 강도·Tier·Drop은 판단하지 말고 Stage 2에
> 넘겨라. type/target/admission은 쓰지 말고 `record_id, sense_id, candidates`만 남겨라.
> 같은 문장·문단에 같이 있었다는 사실만으로 후보를 만들지 말고, 설명 가능한 연결이
> 있으면 약하거나 느슨해도 보존하라. 실제 용례가 없으면 빈 배열로 두라.
