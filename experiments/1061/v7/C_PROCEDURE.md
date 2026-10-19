# C Procedure (V7) — 역할 기반 문학 관계 감사와 재발굴

Issue #1061 / #1109, method C (승인된 문학 SQLite의 실제 문맥). 이 문서는 특정
배치의 단어 답안이 아니라 **다른 C 배치에도 그대로 적용할 수 있는 생산 절차**다.
원문·발췌문·SQLite·검색 로그·후보별 근거 상세는 이 문서와 Git에 넣지 않는다.

V7은 V6의 sense별 문맥 공급과 7관점 발굴을 유지하되, **장면의 배경과 출발 sense의
역할을 분리**하고 **문맥에 결속된 관계만 남기는** 감사 단계를 강화한다. 후보 수
목표는 없다. `candidates: []`는 정당한 결과다.

## 0. V6에서 V7로 바뀌는 것

1. **역할 우선.** 후보가 문맥에 함께 나왔다는 이유만으로 관계가 되지 않는다.
   출발 sense가 그 문맥에서 실제로 하는 역할(동작·상태·정서·이미지·상징·대비·
   원인·결과)을 먼저 지정하고, 후보가 그 역할과 맺는 경로를 한 문장으로 쓴다.
2. **네 개의 Gate.** 모든 후보에 `Gate A`(source-dependence/role),
   `Gate B`(contrastive sense), `Gate C`(relationship cluster/complete
   expression), `Gate D`(independent textual grounding)를 적용한다.
3. **감사와 재발굴의 분리.** 발굴 중에는 KEEP/DROP을 정하지 않는다. 발굴이 끝난
   뒤 다섯 질문으로 감사하고, `REWORK`/`DROP`/`UNCERTAIN`은 같은 VERIFIED
   문맥을 다시 읽어 더 나은 독립 관계로 재발굴한다.
4. **장부 정합성.** 기존 후보 전량의 판정 합계, 문자열 변경, 중복 제거, 최종
   pair 수를 하나의 수식으로 맞춘다. 구조 검사를 의미 정확성의 증거로 쓰지 않는다.
5. **이전 후보 자동 KEEP 금지.** 같은 생산자의 이전 후보는 감사 대상일 뿐이며,
   V7 Gate를 처음부터 다시 통과해야 한다.

## 1. PRE-FLIGHT — 동결과 상태 생성

1. Canonical 배치를 읽어 `record_id, sense_id, lemma, pos, gloss, search_forms`를
   Canonical 순서로 동결한다. record 수, sense 수, 다의어 record 수, 최대 sense
   수, 첫/마지막 record ID를 기록한다.
2. Canonical 파일과 문학 인덱스의 SHA-256, 인덱스 규모(작품/단위), 검색 계층
   (FTS5 trigram, 2자 `instr()` 스캔, 단어 시작 경계 재확인)을 기록한다.
3. sense마다 상태를 만든다:
   `PENDING → SEARCHED → INSPECTED → BOUND → DISCOVERED → AUDITED → REPAIRED → FINALIZED`.
   검색·판독·7관점 방문·후보·감사 판단·수정 이력을 별도 로컬 로그에 둔다.
   미처리 sense를 빈 후보로 미리 확정하지 않는다.
4. 이전 생산물(같은 방식·모델의 같은 배치)은 `PENDING_AUDIT`로 등록한다.
   다른 생산자·다른 방식의 후보는 읽지 않는다.
5. 25–35 record 간격으로 체크포인트를 저장한다. 컨텍스트 압축·재시작 뒤에는
   체크포인트에서 이어서 처리한다.
6. 결정적 파일럿(원본 순서 앞부분, 다의어·검색 가능·검색 불가·이전 후보 포함)으로
   검색·판독·sense 구별·ledger 검사 실패를 찾는다. 파일럿에서 드러난 **공통 실행
   오류**만 보완하고, 본 실행 중에는 특정 단어/후보 숫자에 맞춰 규칙을 바꾸지 않는다.

## 2. PASS 1 — sense-aware 문학 검색과 다작품 문맥 확보

### 2.1 검색 형태

- Canonical `search_forms`를 기본으로 쓴다. 띄어쓴 표현은 붙여쓴 변형도 넣는다.
- 용언/형용사는 `-다`를 떼어낸 어간을 추가한다. 어간이 2자 이상이면 그 어간으로
  활용형을 포괄 검색한다.
- 불규칙 활용은 어간 끝 자모를 일반 규칙으로 변환해 추가한다(ㅂ/ㄷ/ㅅ/ㅎ/ㄹ
  불규칙, `르`·`우` 불규칙). 특정 단어 예외를 만들지 않는다.
- 어간이 1자인 용언은 `-은/는/어/아/게/고/지/던/어서/으면` 등 일반 어미를 붙인
  형태로만 검색한다.
- 1자 표제어처럼 신뢰할 경계 검증 경로가 없는 항목은 `UNSEARCHABLE`로 기록한다.
  탐색하지 않은 것을 "용례 없음"으로 보고하지 않는다.
- 3자 이상 probe는 FTS5 trigram, 2자 probe는 `instr()` 스캔을 쓰고, 두 경우 모두
  실제 문자열 포함과 **단어 시작 경계**(앞 문자가 한글/영숫자가 아님)를 재확인한다.

### 2.2 문맥 추출과 공급

- 짧은 단위(시행·대사 등)는 앞뒤 단위를 붙여 장면을 복원한다. 긴 단위는 일치
  지점 주변의 문장 창을 쓴다.
- 같은 작품의 연속·유사 문맥을 먼저 제거하고, 작품당 최대 2문맥으로 제한한다.
- 결정적 다양성 순위: 새 작가 > 새 장르 > 새 작품 > 텍스트 길이. 서로 다른
  작품·화자·장면·장르를 우선하되, 검증 가능성이 높은 문맥을 적절히 포함한다.
- sense별 서로 다른 문맥 최대 16개를 공급하고 **공급한 문맥은 실제로 판독**한다.
  창은 `1–4`, `5–8`, `9–12`, `13–16`으로 넘긴다. 1–4를 읽고 문맥이 있으면
  5–8을, 5–8에서 신규 독립 관계가 나오면 9–12를, 9–12에서도 나오면 13–16을
  읽는다. 가용 문맥을 16까지 모두 읽는 것도 허용한다.
- 검색 상태를 구분한다: `HITS`, `ZERO_HITS`, `UNSEARCHABLE`, `SEARCH_FAILED`.
  `VERIFIED`는 검색 hit 수나 문맥 예산이 아니라, 실제 그 sense의 문맥으로 확인된
  문맥 수다.
- 정상 종료 사유만 인정한다: `NO_MORE_DISTINCT_CONTEXTS`, `INSPECTED_16`,
  `NO_NEW_RELATIONS_AFTER_WINDOW`(창과 신규 독립 관계 수 필수),
  `NO_VERIFIED_AFTER_EXHAUSTION`, `NO_VALID_RELATION`. 자원 부족·미실행은
  `INCOMPLETE`이며 성공·빈 후보로 가장하지 않는다.

## 3. PASS 2 — evidence-first exact sense binding

문맥을 실제로 읽은 뒤, 그 문맥의 source에 대해 기록한다.

- `context_locator`(로컬 문서/단위/오프셋, 인용 없이), `work_id/author/genre`,
  `source_surface`, `record_id`, `sense_id`, 원문 단서 위치, 문법적·서사적 역할.
- 해당 lemma의 대안 sense/다른 단어 해석이 더 타당한지 검토한다. 다의어·동음
  이의어·한자 독음·고어·관용구의 일부·문자 부분 일치·비유적 의미를 구분한다.
- `VERIFIED / AMBIGUOUS / REJECTED`와 근거를 기록한다. `VERIFIED`에는 원문에서
  드러난 의미 역할을 반드시 연결한다. 짐작·작품 배경지식·동음 이외 표현 대입으로
  `VERIFIED`로 승격하지 않는다.
- 긴 문맥·번역체·고어에서 정확한 역할이 애매하면 `AMBIGUOUS`, 분명히 다른 sense면
  `REJECTED`다. 둘 다 후보 생성에 사용하지 않는다.
- 원문이 특이한 비유라서 gloss와 문장 전체가 문자 그대로 같을 필요는 없다.
  그래도 출발 sense의 기능·비유적 전용 경로를 원문에 기대어 설명할 수 있어야 한다.

## 4. PASS 3 — VERIFIED 문맥의 7관점 독립 발굴

VERIFIED 문맥 하나마다 아래 관점을 **각각** 방문하고, 관점별 발견 수 또는 0을
로컬 ledger에 기록한다.

1. **Image** — 색, 빛, 모양, 사물의 구체적 영상.
2. **Action** — 동작, 몸짓, 동작의 대상·주체.
3. **Emotion** — 그 단어 사용과 연결된 감정, 변화, 반응.
4. **Sensation** — 청각·촉각·냄새·맛·온도·신체감각.
5. **Scene/Situation** — 출발어가 핵심인 서사적 상황과 장면.
6. **Causality** — 인과, 결과, 변화와 출발어의 기능.
7. **Metaphor/Contrast** — 원문에서 확인되는 비유·상징·대조.

관점마다 반드시:

1. 해당 관점의 원문 증거를 확인한다.
2. 출발 sense의 역할을 지정한다.
3. source→candidate의 관계 경로를 한 문장으로 쓴다.
4. 독립 관계 후보를 전부 임시 pool에 넣는다.
5. 같은 관점의 다른 관계를 다시 확인한다.
6. 없으면 `found: 0`을 기록한다.

원문에 나온 후보를 그대로 인용할 필요는 없다. 문맥이 지지하는 함축·정서·이미지를
간결하게 재구성할 수 있다. 다만 배경 사물·인물·저자의 별개 주제를 출발어와
연결되지 않은 채 관계로 등록하면 안 된다. 숫자 할당량은 없으며, 발굴 중
KEEP/DROP을 결정하지 않는다.

로컬 기록 스키마:

`source_record_id, source_sense_id, lemma, context_locator, source_surface,
textual_evidence_locator, actual_role, relation_path, literary_lens, candidate,
derivation(exact|inflected|inferred), discovery_window, discovery_pass`

원문 구절·근거 문맥은 로컬만 보관하고, RUN.md에는 원문 없이 통계·판단 근거
메타데이터만 기록한다.

## 5. PASS 4 — 네 개의 Gate

후보 **각각** 아래를 통과해야 한다.

### Gate A — Source-dependence / Role test

- 이 후보가 출발 source의 동작·상태·정서·이미지·상징·대비·원인·결과 중
  **무엇**을 나타내는가?
- 같은 문단에서 출발어가 빠지거나 다른 무관 단어로 바뀌어도 아무 설명 없이
  똑같이 성립하는 단순 배경 요소인가? 그렇다면 `CO_OCCURRENCE` 위험으로 표시하고
  더 강한 텍스트 경로를 찾는다.
- 이것은 자동 DROP 조건이 아닌 **반증 보조 질문**이다. 장면 전체에 걸친 간접
  비유와 멀리 이어지는 인과관계도 근거가 있으면 유효하다. 다만 "같은 문장에
  있었다"만으로는 통과하지 못한다.

### Gate B — Contrastive sense

- 문맥에서 같은 표기의 다른 뜻이 아니라 **그 Canonical sense**임을 입증한다.
- 다른 뜻에서 생성된 이미지·연상은 그 sense의 후보로 KEEP하지 않는다.
- 표면형은 같고 sense가 다른 경우, 한자 독음, 고어, 관용구의 일부, 문자 부분
  일치, 비유적 전용을 구분한다.

### Gate C — Relationship cluster / complete expression

- 같은 sense 안에서 같은 의미 관계를 단순한 표현 차이로 중복했는지 검토한다.
  같은 장면에서 나왔더라도 색/동작/정서/대비가 실제로 다른 창작 경로라면 각각
  보존한다.
- 문장 중간을 잘라 의미가 파손된 표현, 일반적 접속 어구, 단순 gloss 반복,
  배경지식만 반영한 표현은 재작업한다.
- 원문이 지지하는 관용적/시적/고어 표현은 어색하다는 주관적 이유만으로 제거하지
  않는다.
- 표제어 포함은 자동 탈락이 아니다. 고정 관용구·실제 문학 표현의 개별 가치를
  검사한다. 다만 source lemma와 **정확히 같은 문자열**은 후보로 쓰지 않는다.

### Gate D — Independent textual grounding

- 후보 의미 경로를 지원하는 실제 **VERIFIED 문맥의 locator**가 있어야 한다.
  gloss만 읽고 생성한 그럴듯한 후보는 C 방식에서 KEEP할 수 없다.
- 원문 증거가 없는 후보는 `UNCERTAIN`, 검토한 원문이 명백히 관계를 부정하면
  `DROP`이다. 빈틈을 생성자 설명으로 메우지 않는다.

Gate A~D는 기존 후보와 신규 후보에 똑같이 적용한다. 이전 KEEP 판정은 증거가 아니다.

## 6. PASS 5 — 편집 감사와 오류 반송/재발굴

발굴이 끝난 뒤 전체 candidate pool에 아래 다섯 질문을 독립 기록한다.

1. 정확한 source sense인가?
2. 해당 VERIFIED 문맥의 어떤 단서가 후보와 실제로 연결되는가?
3. 작가에게 어떤 구체적 표현·이미지·정서·행동·대조의 선택지를 제공하는가?
4. 다른 후보와 어떤 **독립 관계**인가(또는 어떤 cluster의 같은 관계인가)?
5. 틀렸다는 가장 강한 반론(다른 sense / 공출현 / 독립 관계 없음 / 과도한 비유 /
   파편)은 무엇이며 실제 원문으로 반박 가능한가?

판정은 `KEEP / REWORK / DROP / UNCERTAIN`과 사유 코드
`WRONG_SENSE, CO_OCCURRENCE, LACKS_ROLE, INFERRED_WITHOUT_EVIDENCE,
SAME_RELATION, FRAGMENT, TRIVIAL_PARAPHRASE, AMBIGUOUS, OTHER`로 기록한다.

- 새로운 후보가 유명한 작품·인물·사물을 가리켜도 source의 역할이 없으면 KEEP할
  수 없다.
- 희귀한 비유나 감각적 이미지라도 원문이 지지하면 KEEP할 수 있다.
- `REWORK / DROP / UNCERTAIN` sense는 VERIFIED 문맥을 다시 보고, 필요하면 가용
  다른 작품을 검색·판독한다. 기존 관계를 보존하려는 합리화 대신 더 좋은 독립
  관계를 다시 발굴한다.
- 재발굴 후보도 Gate A~D를 다시 통과한다. 신규 관계·근거가 없거나 가용 문맥이
  소진되면 종료하고, 억지로 채우지 않는다.
- `REWORK`는 (a) 기존 후보 문자열을 더 나은 표현으로 바꾼 것인지, (b) 문자열은
  유지하고 근거만 보강한 것인지 명시한다. `UNCERTAIN`을 최종 후보로 조용히
  승격하지 않는다.

교정 목표는 특정 단어 결과물이 아니라 **모든 C 배치의 일반 생산 규칙**이다.
단어별 예외·blacklist·수치 할당량을 만들지 않는다.

## 7. PASS 6 — 실행 완전성과 감사 정합성 검사

별도 평가 시스템 없이 단순한 로컬 상태·계약 검사만 한다. 아래는 fail-closed다.

- [ ] Canonical record/sense를 정확한 ID·순서로 모두 방문했다.
- [ ] Candidate v1 구조·원래 순서·전체 record/sense를 유지했다.
- [ ] 공급한 모든 실제 문맥이 판독되었고, 창 전이/stop 사유에 근거가 있다.
- [ ] 검색 실패·미완료를 `[]`로 대체하지 않았다.
- [ ] 모든 VERIFIED 문맥에 7관점 개별 방문 결과가 있다.
- [ ] 최종 후보에 `sense + evidence locator + 역할 + relation path`가 있다.
- [ ] 최종 후보가 Gate A~D와 PASS 5를 통과했고, 미해결 `UNCERTAIN`이 KEEP되지
      않았다.
- [ ] 같은 `sense_id + normalizeCandidate(candidate)` pair 중복과 source lemma
      exact 동일이 없다.
- [ ] 기존 후보 전량의 `KEEP/REWORK/DROP/UNCERTAIN` 합이 기존 후보 수와 같다.
- [ ] 기존 후보→최종 pair 계보에 중복 제거를 적용한 수와 최종 Candidate 수가
      정확히 일치한다.
- [ ] `validateCandidateBatch`의 공통 내용 검사(실험 경로는 경로 가드를 우회하지
      않고 내용 검증 함수를 직접 사용)를 통과한다.

상태/결과가 맞지 않으면 **실행 미완료**로 보고하고 체크포인트에서 재개한다.
구조 검사만으로 독립 의미 정확성을 보증하지 않는다.

## 8. 상태 기계와 체크포인트

sense별 로컬 상태:

```
sense_id, status(PENDING|SEARCHED|INSPECTED|BOUND|DISCOVERED|AUDITED|REPAIRED|FINALIZED|INCOMPLETE),
probes[], search_status, raw_matches, unit_matches, works,
contexts[](locator, work, genre, author, surface, text),
windows{ w: {read, verified, ambiguous, rejected, new_candidates, stop} },
bindings[](window, rank, verdict, surface, why),
pool[](context, lens, candidate, evidence, role, derivation, justification),
audit[](candidate, source, verdict, reason, note),
final_candidates[]
```

25–35 record마다 체크포인트를 저장한다. 적용 스크립트는 창별 read 수, 종료 사유
유효성, 1창에서 문맥이 남았는데 종료했는지, `VERIFIED 0`인데 종료했는지, 새 관계가
있는데 종료했는지, 마지막 창의 종료 사유를 검사한다.

## 9. 출력 계약과 통제

- Candidate v1: `record_id`, `senses[].sense_id`, `senses[].candidates: string[]`
  만 기록한다. type/tier/target/confidence/admission은 기록하지 않는다.
- 실험 경로는 `experiments/1061/v7/013_01_c_deepseek.jsonl`; 정식 경로는
  `data/relation-candidates/<SSS>/<SSS>_<BB>_<method>_<model>.jsonl`이다.
- 원문·발췌문·SQLite·검색 로그·evidence 상세는 로컬 전용이며 Git에 넣지 않는다.
- Canonical, 정식 Candidate/Relations, #860 커서, 이전 버전 산출물은 불변이다.
- 다른 생산자·모델·서브에이전트의 결과를 읽거나 호출하지 않는다.
- 후보 수 목표를 두지 않는다. `candidates: []`는 정당한 결과다.

## 10. 금지 패턴

- record당 문맥 하나만 읽고 모든 sense를 완료 처리하기.
- hit sense의 일부만 PASS 2(추가 창)를 수행하기.
- 7관점을 "한 번에 훑었다"고 기록하고 관점별 방문 기록을 남기지 않기.
- 같은 문장·문단에 함께 나온 사물·인물·장소를 관계로 올리기.
- 배경지식으로 작품·인물·사물을 설명하고 원문 역할을 대체하기.
- 정의를 그대로 옮긴 후보, 출발어를 넣은 평범한 문장, 파편 문자열.
- 이전 후보를 검증 없이 KEEP하기.
- 검색 실패·미완료를 빈 결과로 보고하기.
- 특정 단어의 답안을 외워 규칙처럼 적용하기.
