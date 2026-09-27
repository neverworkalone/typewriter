# 외부 자료 검토: 문어 말뭉치 2025(1.0)

## 자료 정보

- 자료명: 국립국어원 「문어 말뭉치 2025(1.0)」
- 제공 기관: 국립국어원 모두의 말뭉치
- 자료 URL: https://kli.korean.go.kr/corpus
- 이용 관련 안내: https://kli.korean.go.kr/corpus/request/faqInfo.do?lang=en
- 확인일: 2026-09-27
- 검토 주체: Typewriter 프로젝트
- 출처 표기: 국립국어원 문어말뭉치 2025(1.0). 국립국어원 모두의 말뭉치 (https://kli.korean.go.kr/corpus).

## Typewriter에서의 이용 목적

Typewriter는 크롬 브라우저 확장 프로그램 형태의 작가용 한국어 유의어·연관어 사전이다.

사전에 추가할 어휘 후보를 선정하고 실제 문어 사용례를 참고하기 위해 국립국어원 「문어 말뭉치 2025(1.0)」의 문학 분야 자료를 활용했다. 다운로드한 말뭉치는 어휘 후보를 찾는 분석 과정에서 AI 보조 자료로 사용했으며, 문어에서 자주 사용되는 어휘 후보를 추출하고 별도의 검토 과정을 거쳐 Typewriter 사전에 반영하는 방식으로 사용했다.

말뭉치 원문은 어휘 후보를 찾기 위한 분석 과정에서만 참고한다. 공개되는 결과물, 배포용 DB 및 소스 코드에는 말뭉치의 문장·문단 원문을 포함하지 않는다. 공개 결과물에는 선정한 단어와 Typewriter에서 자체 작성한 뜻풀이 및 단어 간 관계 정보만 사용한다.

이 문서에서 말하는 AI 보조 어휘 후보 분석과 `scripts/reference/`의 로컬 말뭉치 인덱서는 서로 다른 단계다. 현재 로컬 인덱서는 문단의 문자열 출현을 검색하기 위한 참고 도구이며, 형태소·품사·표제어 단위의 정확한 빈도 분석 결과를 산출한다고 간주하지 않는다.

## 공개 및 배포 경계

- 말뭉치 원문 파일은 Git 저장소에 포함하지 않는다.
- 말뭉치의 문장·문단 원문은 공개 결과물이나 배포용 사전 DB에 포함하지 않는다.
- 말뭉치에서 생성한 로컬 검색용 SQLite/FTS 인덱스는 공개하거나 제품에 포함하지 않는다.
- 공개 결과물에는 선정한 단어와 Typewriter에서 자체 작성한 뜻풀이, 단어 간 관계 정보만 포함한다.
- 말뭉치 자료 자체의 재배포와 Typewriter가 작성한 결과물의 공개를 구분한다.
- README의 「Licenses and reuse」에 말뭉치 출처를 명시한다.

## Machine-readable permission gate

> 아래 필드명과 값은 `scripts/reference/`의 permission gate가 읽으므로 번역하거나 형식을 변경하지 않는다.

- Intended role: reference
- Allowed local storage: permitted
- Allowed schema scanning and processing: permitted
- Allowed SQLite/FTS indexing: permitted
- Allowed lexical-reference use: permitted
- Distribution/embedding terms reviewed: complete
- Attribution/notice terms reviewed: complete
- Decision: permitted for stated role

## 추가 확인 사항

- 이용 근거: 국립국어원 모두의 말뭉치 이용 신청 승인 및 이용 약정 체결 후 「문어 말뭉치 2025(1.0)」을 다운로드하여 사용했다. 2026-09-27 소유자는 국립국어원 사이트에서 승인 상태가 `permitted`로 확인되었으며, #197의 로컬 참고 목적(전체 스키마 검사·처리, SQLite/FTS 색인, 어휘 참고 검색)을 포함한다고 확인했다.
- 공개 및 배포: 말뭉치 원문, 문장·문단 발췌 및 로컬 분석용 인덱스는 공개하거나 제품에 포함하지 않는다. 공개 결과물에는 선정한 단어와 Typewriter에서 자체 작성한 뜻풀이 및 단어 간 관계 정보만 포함한다.
- 출처 표기: README의 「Licenses and reuse」에 다음과 같이 출처를 명시한다.  
  `국립국어원 문어말뭉치 2025(1.0). 국립국어원 모두의 말뭉치 (https://kli.korean.go.kr/corpus).`
