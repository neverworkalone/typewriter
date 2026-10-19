# C Procedure (V6) — 감각별 문맥 공급, 7관점 전수 발굴, 실행 완전성 검사

Issue #1061 / #1109, method C (문학 SQLite의 실제 문맥). 이 문서는 특정 배치의
단어 목록이 아니라 **C 생산 절차**를 정의한다. 다른 C 배치에도 같은 순서로
적용할 수 있어야 하며, 단어별 예외 목록을 두지 않는다. 원문·발췌문·SQLite·
검색 로그는 이 문서와 Git에 넣지 않는다.

## 0. V5에서 무엇을 바꾸는가

V5는 `record`를 검색·판독 단위로 삼아 hit record마다 표본 문맥 하나를 읽고,
217개 hit sense 중 4개만 추가 창으로 확장했다. 그 결과 65개 후보는 “문맥을
충분히 읽은 결과”가 아니었다.

V6의 단위는 **sense**다.

1. hit sense마다 자기 창(window)을 따로 갖는다. 한 record의 첫 문맥을 여러
   sense의 증거로 재사용하지 않는다.
2. 서로 다른 작품·화자·장르를 우선한 문맥을 최대 16개까지 공급하고, **공급된
   문맥은 전부 실제로 판독**한다. 16은 탐색 예산 상한이지 후보 목표가 아니다.
3. VERIFIED 문맥마다 7관점을 각각 방문하고, 발굴과 편집 감사를 분리한다.
4. 이전 생산물(같은 방식·모델의 같은 배치)은 자동 KEEP하지 않고 동일 기준으로
   다시 판정한다.
5. 최종 파일을 쓰기 전에 실행 완전성을 **기계적으로** 검사한다.

## 1. PRE-FLIGHT — 동결과 상태 생성

1. Canonical 배치를 읽어 `record_id, sense_id, lemma, pos, gloss,
   search_forms`를 Canonical 순서로 동결한다. 배치 크기와 sense 수를 기록한다.
2. Canonical 파일과 문학 인덱스의 SHA-256, 인덱스의 작품/단위 수, 검색 계층
   (FTS5 trigram, 2자 `instr()` 스캔, 경계 재확인)을 기록한다.
3. sense마다 `PENDING` 상태와 다음 체크포인트를 만든다:
   `search → windows_read[] → bindings[] → pool[] → audit[] → final`.
   미처리 sense를 빈 후보로 미리 확정하지 않는다.
4. 이전 생산물이 있으면 **감사 대상**으로만 등록한다(`PENDING_AUDIT`).
   다른 생산자·다른 방식의 후보는 읽지 않는다.
5. 검색·판독·확대·종료 기준을 파일럿 전에 고정한다. 파일럿에서 드러난 **공통
   실행 오류**만 수정하고, 본 실행 중에는 단어별 규칙을 바꾸지 않는다.

## 2. PASS A — sense별 검색과 문맥 공급

### 2.1 검색 형태(probe)의 일반 규칙

- Canonical `search_forms`를 기본으로 쓴다. 띄어쓴 표현은 붙여쓴 변형도 넣는다.
- 용언/형용사는 `-다`를 떼어낸 어간을 추가한다. 어간이 2자 이상이면 그
  어간으로 활용형을 포괄 검색한다.
- 불규칙 활용은 어간의 끝 자모를 일반 규칙으로 변환해 추가한다(ㅂ/ㄷ/ㅅ/ㅎ/ㄹ
  불규칙, `르`·`우` 불규칙). 특정 단어를 위한 예외를 만들지 않는다.
- 어간이 1자인 용언은 `-은/는/어/아/게/고/지/던/어서/으면` 등 일반 어미를
  붙인 형태로만 검색한다.
- 1자 표제어처럼 신뢰할 경계 검증 경로가 없는 항목은 `UNSEARCHABLE`로
  기록한다. **탐색하지 않은 것을 “용례 없음”으로 보고하지 않는다.**
- 3자 이상 probe는 FTS5 trigram, 2자 probe는 `instr()` 스캔을 쓰고, 두 경우
  모두 실제 문자열 포함과 **단어 시작 경계**(앞 문자가 한글/영숫자가 아님)를
  재확인한다.

### 2.2 문맥 추출

- 짧은 단위(시행·대사 등)는 앞뒤 단위를 붙여 장면을 복원한다. 긴 단위는
  일치 지점 주변의 문장 창을 쓴다.
- 같은 작품의 연속·유사 문맥을 먼저 제거한다. 작품당 최대 2개로 제한한다.
- 결정적 다양성 순위를 쓴다: 새 작가 > 새 장르 > 새 작품 > 텍스트 길이.
  서로 다른 작품·화자·장면·장르를 우선한다.
- 창은 4개 단위(`1–4`, `5–8`, `9–12`, `13–16`)로 공급한다.
- sense별 검색 상태를 구분한다: `HITS`, `ZERO_HITS`, `UNSEARCHABLE`,
  `SEARCH_FAILED`. 검색 오류를 정상 빈 후보로 속이지 않는다.

## 3. PASS B — Evidence-first sense binding

판독한 **모든** 문맥에 대해 후보 생성 이전에 기록한다.

- `context_locator`(로컬 문서/단위/오프셋, 인용 없이)
- `source_surface`(원문에 나타난 형태)
- Canonical `sense_id`
- 그 의미를 뒷받침하는 원문 단서와 문맥 속 역할
- `VERIFIED / AMBIGUOUS / REJECTED`와 이유

`VERIFIED`는 출발 sense가 실제로 등장하고 그 역할이 원문에서 확인된 경우만
인정한다. `AMBIGUOUS`·`REJECTED`에서는 후보를 만들지 않는다. 배경지식이나
정의를 지어내 `VERIFIED`로 승격하지 않는다.

`inspected_context_count`는 실제 읽은 수, `verified_context_count`는 그중
올바른 sense로 확인한 수다. 예산 4/8/12/16을 verified 수로 저장하지 않는다.

## 4. PASS C — VERIFIED 문맥의 7관점 전수 발굴

VERIFIED 문맥 하나마다 아래 관점을 **각각** 방문한다.

1. **Image** — 시각적 이미지·형상·빛·색
2. **Action** — 행동·몸짓·반응·대상
3. **Emotion** — 인물의 감정과 정서 변화
4. **Sensation** — 소리·촉감·온도·냄새·맛·신체 감각
5. **Situation/Scene** — 특징적 상황과 서사적 장면
6. **Causality** — 원인과 결과
7. **Metaphor/Contrast** — 비유·상징·대비

각 관점의 강제 동작:

- (a) 해당 관점의 원문 증거를 확인한다.
- (b) 출발 sense와의 의미 연결을 확인한다.
- (c) 독립 관계 후보를 **전부** 임시 pool에 넣는다.
- (d) 같은 관점의 다른 관계를 다시 확인한다.
- (e) 없으면 빈 결과를 기록한다(`found: 0`).

발굴 중에는 KEEP/DROP을 결정하지 않는다. pool은 감사보다 넓어야 한다.
후보 하나에는 로컬 전용 기록을 붙인다:
`SOURCE / CONTEXT / EVIDENCE / ROLE / RELATION / CANDIDATE / DERIVATION /
JUSTIFICATION`. 구절과 의미 연결의 근거가 없으면 최종 후보가 아니다.

- 1~3개를 찾았다고 발굴을 끝내지 않는다.
- 동의 표현 나열, 문장 주변의 장소·물건·인물만 긁어오기, 파편 문자열은 금지.
- 문학적 장면·비유·정서 관계는 사전적 치환이 아니라는 이유로 배제하지 않는다.
- 고정 관용구·표현 가치는 출발 표제어가 포함돼도 무조건 배제하지 않는다.

## 5. PASS D — 다른 작품으로의 적응적 확대

모든 search-hit sense에 적용한다.

1. `1–4`를 읽은 뒤 다른 작품의 문맥이 남아 있으면 `5–8`을 **반드시** 읽는다.
   첫 창의 후보 수(0/2/4/다수)와 무관하다.
2. `5–8`에서 새 독립 관계를 하나라도 얻으면, 다른 문맥이 남아 있는 한
   `9–12`를 **반드시** 읽는다.
3. `9–12`에서도 새 관계를 얻으면, 남은 문맥이 있는 한 `13–16`을 읽는다.
4. 아직 VERIFIED가 0개면 다른 형태·작품·의미 구별 경로를 재시도하고, 16 상한
   또는 실질적 검색 결과 소진까지 계속한다. “새 관계가 없다”만으로 4문맥에서
   멈추지 않는다.
5. VERIFIED는 있으나 독립 관계가 없으면 다른 장르·장면을 우선하고, 이후에도
   새 관계가 없을 때 객관적 기록과 함께 종료한다.
6. 정상 종료 사유는 다음으로 제한한다:
   `NO_MORE_DISTINCT_CONTEXTS`, `NO_NEW_RELATIONS_AFTER_WINDOW`,
   `INSPECTED_16`, `NO_VERIFIED_AFTER_EXHAUSTION`, `NO_VALID_RELATION`.
7. `ONLY_ONE_SAMPLE`, `SECOND_SAMPLE_NOT_AVAILABLE_IN_THIS_RUN`,
   `INSPECTED_4`, `INSPECTED_8`은 종료 사유가 아니다. 실행이 멈추면
   체크포인트를 저장하고 `INCOMPLETE`로 남긴다.

**운영 원칙:** 창 전이는 위 조건을 만족해야 하지만, 조건을 만족한 뒤에도
문맥이 남아 있으면 더 읽는 것은 허용된다. V6 실행은 모든 hit sense에서 공급
가능한 문맥(최대 16)을 끝까지 읽었고, 그 결과 `NO_NEW_RELATIONS_AFTER_WINDOW`
없이 `NO_MORE_DISTINCT_CONTEXTS`/`INSPECTED_16`/`NO_VERIFIED_AFTER_EXHAUSTION`/
`NO_VALID_RELATION`으로 종료했다. 이는 최소 조건보다 엄격한 실행이다.

## 6. PASS E — 독립적 편집 감사

이전 생산물과 이번 pool을 **하나의 임시 pool**로 합치고, 출처 예외 없이 모두
재평가한다.

- **Sense** — 정확한 sense에 묶였는가?
- **Evidence** — 그 문맥이 후보와 출발어의 의미 연결을 뒷받침하는가?
- **Writer value** — 작가가 표현·장면·정서·비유를 확장하는 데 쓸 만한가?
- **Independence** — 다른 후보가 같은 관계를 이미 충분히 대표하지 않는가?
- **Counterargument** — 틀렸다면 가장 강한 이유는 무엇이며, 실제 문맥으로
  반박되는가?

판정은 `KEEP / REWORK / DROP / UNCERTAIN`. 다음 오류를 명시적으로 확인한다:
단순 공출현, 어의 혼입, 근거 없는 작품 외부 지식, 원문에 없는 감정·비유,
부정된 범주를 긍정 관계로 추출, 파편 문자열, 의미 중복, 정의의 반복,
출발 표제어를 넣은 비관용 문장 확장.

- 느슨한 문학적 연상은 허용하지만 모든 인접 단어를 연상이라 부르지 않는다.
- 이전 후보를 자동 KEEP하지 않는다. 근거를 찾지 못하면 `UNCERTAIN` 또는
  `DROP`이며, `UNCERTAIN`을 최종 후보로 조용히 승격하지 않는다.
- 동일 sense 안의 중복은 대표 하나만 남긴다.

## 7. PASS F — 오류 교정과 재발굴

`REWORK / DROP / UNCERTAIN`이 나오면 원인을 분류하고 **같은 VERIFIED 문맥**을
다시 읽는다.

- 다른 sense라면 그 문맥의 후보를 재검증하고, 진짜 sense를 지원하는 문맥을
  찾는다.
- 공출현·배경 장면이라면 출발 sense와 직접 연결되는 동작·정서·인과·비유를
  재탐색한다.
- 의미 중복이면 새 표현을 억지로 채우지 않고 가장 유용한 후보만 남긴다.
- 새 근거를 확보한 수정 후보도 PASS E의 다섯 기준을 다시 통과시킨다.
- 더 찾을 수 없으면 `DROP/UNCERTAIN`으로 끝내고 미검증 결과를 KEEP으로
  승격하지 않는다.
- 교정은 특정 어휘 예외가 아니라 **C 생산 과정에 공통 적용되는 규칙**의
  수정으로 이어져야 한다.

## 8. PASS G — 실행 완전성 기계 검사

최종 파일을 쓰기 전에 로컬 상태 검사로 아래를 확인한다.

- [ ] Canonical 배치의 모든 record/sense를 정확한 ID·순서로 방문했다.
- [ ] hit sense마다 실제 판독 창과 종료 사유가 있다.
- [ ] hit sense가 후보 0개라는 이유로 PASS D를 건너뛴 경우가 없다.
- [ ] 첫 4문맥만 읽고 멈춘 sense는 문맥 소진/16 상한/검증 가능한 종료 사유가
      있을 때만 완료다.
- [ ] `5–8`에서 새 후보를 얻고 `9–12`를 생략한 sense가 없다(문맥 소진 제외).
- [ ] `VERIFIED` 수가 실제 binding 판정 합계와 일치한다.
- [ ] 이전 후보 전량이 `KEEP/REWORK/DROP/UNCERTAIN`로 귀속됐다.
- [ ] 최종 후보가 개별 evidence 기록과 연결되고, `UNCERTAIN`이 조용히
      채택되지 않았다.
- [ ] 같은 sense 안에 중복 후보가 없고, 후보가 source lemma와 같지 않다.
- [ ] Candidate v1 계약 검증을 통과한다.
- [ ] 검색 장애/미완료가 있으면 정상 빈 결과로 가장하지 않고 실패/미완료로
      종료한다.

검사 실패 시 완료를 선언하지 않는다. 체크포인트에서 누락 sense를 이어서
처리한다. 비용을 아끼려 다음 record를 `[]`로 채우지 않는다.

## 9. 상태 기계와 체크포인트

sense별 상태(로컬 전용):

```
sense_id, status(PENDING|ACTIVE|COMPLETE|UNSEARCHABLE),
probes[], search_status, raw_matches, unit_matches, works,
contexts[](locator, work, genre, author, surface, text),
windows{ w: {read, verified, ambiguous, rejected, new_candidates, stop} },
bindings[](window, rank, verdict, surface, why),
pool[](context, lens, candidate, evidence, role, derivation, justification),
audit[](candidate, source, verdict, note),
final_candidates[]
```

- 25~35 record마다 체크포인트를 저장한다.
- 적용 스크립트는 다음을 검사한다: 창별 read 수, 종료 사유 유효성, 창 1에서
  문맥이 남았는데 종료했는지, VERIFIED 0인데 종료했는지, 새 관계가 있는데
  종료했는지, 마지막 창의 종료 사유.
- 컨텍스트 압축·재시작 후에는 체크포인트에서 이어서 처리한다.

## 10. 출력 계약과 통제

- Candidate v1: `record_id`, `senses[].sense_id`, `senses[].candidates: string[]`
  만 기록한다. type/tier/target/confidence/admission은 기록하지 않는다.
- 파일 경로는 `data/relation-candidates/<SSS>/<SSS>_<BB>_<method>_<model>.jsonl`
  (이 실험은 `experiments/1061/v6/013_01_c_deepseek.jsonl`).
- 원문·발췌문·SQLite·검색 로그·evidence 상세는 로컬 전용이며 Git에 넣지 않는다.
- Canonical, 정식 Candidate/Relations, #860 커서, V1~V5 산출물은 불변이다.
- 다른 생산자·모델·서브에이전트의 결과를 읽거나 호출하지 않는다.
- 후보 수 목표를 두지 않는다. `candidates: []`는 정당한 결과다.

## 11. 금지 패턴

- record당 문맥 하나만 읽고 모든 sense를 완료 처리하기.
- hit sense의 일부만 PASS 2(추가 창)를 수행하기.
- 7관점을 “한 번에 훑었다”고 기록하고 관점별 방문 기록을 남기지 않기.
- 공출현한 사물·인물·장소를 관계로 올리기.
- 정의를 그대로 옮긴 후보, 출발어를 넣은 평범한 문장, 파편 문자열.
- 이전 후보를 검증 없이 KEEP하기.
- 검색 실패·미완료를 빈 결과로 보고하기.
