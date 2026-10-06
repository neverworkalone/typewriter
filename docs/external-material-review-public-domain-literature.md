# 외부 자료 검토: 공유 저작물(퍼블릭 도메인) 문학 TXT 컬렉션

## 자료 정보

- 자료명: 소유자가 로컬에 보관한 한국 근현대 시·소설·수필 TXT 컬렉션 (`data/reference/public-domain/{poem,novel,essay}/`)
- 제공 기관: 공유마당(https://gongu.copyright.or.kr) — 소유자가 승인받아 다운로드한 자료. (소유자 진술, 2026-10-06)
- 형식: TXT만 원천 형식으로 사용한다. 동일 작품의 HWP/PDF 사본은 소유자가 제거했으며 이 저장소는 HWP/PDF를 파싱·변환·OCR하지 않는다.
- 근거 이슈: #332
- 검토 주체: Typewriter 프로젝트 (에이전트 기록, 소유자 진술 기반)

## 이용 목적

문학 작품 원문의 문자열 출현을 로컬에서 검색·대조하는 **참고(reference) 목적**의 SQLite 파일럿 DB(`scripts/reference/literature-index.mjs`)를 만든다. 형태소·표제어·품사·빈도 분석 결과를 산출한다고 간주하지 않으며, 정식 어휘 후보나 canonical 항목을 직접 만들지 않는다.

## 확인된 것과 확인되지 않은 것

- 소유자는 모든 작품이 저작권이 만료된 저작물이며 공유마당에서 승인받아 다운로드한 퍼블릭 도메인 자료라고 진술했다(#332 및 후속 확인). 에이전트는 개별 작품의 저작권 만료 여부와 공유마당 이용 조건 원문을 독립적으로 검증하지 않았다.
- 작품의 퍼블릭 도메인 지위와 특정 판본·배포 패키지의 이용 조건은 자동으로 같지 않다. 이 기록은 로컬 보관·색인·참고 검색 범위만 다루며 재배포는 승인하지 않는다.
- 파일명(`<id>_<저자>-<제목>-<번호>.txt`)에서 얻은 저자·제목은 검증되지 않은 메타데이터로 저장한다.

## 공개 및 배포 경계

- 원문 TXT, 문단·행 발췌, 로컬 SQLite 인덱스와 파일럿 매니페스트는 Git 저장소와 제품 패키지에 포함하지 않는다(`data/reference/`는 Git 제외).
- 테스트 fixture는 프로젝트가 직접 작성한 합성 텍스트만 사용한다.
- 원문의 재배포, 확장 프로그램 탑재, 제품 DB 반영은 승인되지 않았다.
- 소스 TXT 삭제·재작성은 이 파일럿의 범위가 아니며 별도의 소유자 확인을 요구한다.

## Machine-readable permission gate

> 아래 필드명과 값은 `scripts/reference/literature-index.mjs`의 permission gate가 읽으므로 번역하거나 형식을 변경하지 않는다.

- Intended role: reference
- Public-domain status recorded: owner-asserted
- Allowed local storage: permitted
- Allowed SQLite/FTS indexing: permitted
- Allowed lexical-reference use: permitted
- Redistribution/embedding: not authorized
- Decision: permitted for stated role
