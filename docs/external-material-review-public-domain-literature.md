# 외부 자료 검토: 공유마당 만료저작물 문학 TXT 컬렉션

## 자료 정보

- 자료명: 공유마당 만료저작물 중 한국 근현대 시·소설·수필 TXT 컬렉션 (`~/.cache/typewriter/literature/{poem,novel,essay}/`)
- 제공 기관: 공유마당 (https://gongu.copyright.or.kr)
- 이용조건: 만료
- 형식: TXT만 원천 형식으로 사용한다. 이 저장소는 HWP/PDF를 파싱·변환·OCR하지 않는다.
- 근거 이슈: #332
- 확인일: 2026-10-06

## 공유마당 만료저작물 이용조건 확인 (2026-10-06)

- 확인 페이지: https://gongu.copyright.or.kr/gongu/main/contents.do?menuNo=200091
- 만료저작물은 저작자 사망 후 70년이 지난 저작물이며, 복제·배포·상업적 이용·2차적저작물 작성이 별도 이용허락 없이 가능하고 명시적 출처표시 의무는 기재되어 있지 않다.
- 컬렉션에 동봉된 `poem.xls`/`novel.xls`/`essay.xls` 일람의 모든 행이 `출처: 공유마당`, `이용조건: 만료`이다. 일람의 TXT 파일명(8,349 / 1,140 / 2,863)은 로컬 TXT와 정확히 일치한다.

## 이용 목적

문학 작품 원문의 문자열 출현을 로컬에서 검색·대조하는 참고(reference) 목적의 SQLite DB(`scripts/reference/literature-index.mjs`)를 만든다. 표제어·품사·빈도 분석 결과를 산출하지 않으며, 어휘 후보나 canonical 항목을 직접 만들지 않는다.

## 저장소 정책

원문 TXT, 발췌, 로컬 SQLite 인덱스와 파일럿 매니페스트는 Git과 제품 패키지에 넣지 않고 `~/.cache/typewriter/`에만 둔다. 테스트 fixture는 프로젝트가 직접 작성한 합성 텍스트만 사용한다. 워크트리 간 공유 경로와 명시적 이관 절차는 [`local-reference-cache.md`](local-reference-cache.md)를 따른다.

## Machine-readable permission gate

> 아래 필드명과 값은 `scripts/reference/literature-index.mjs`의 permission gate가 읽으므로 번역하거나 형식을 변경하지 않는다.

- Intended role: reference
- Source terms: 공유마당 expired work
- Allowed local storage: permitted
- Allowed SQLite/FTS indexing: permitted
- Allowed lexical-reference use: permitted
- Distribution/embedding terms reviewed: complete
- Decision: permitted for stated role
