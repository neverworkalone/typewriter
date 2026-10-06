# 문학 TXT 전수 로컬 DB 빌드 보고 (#334)

원문·발췌·파일명·SQLite·로컬 매니페스트는 Git에 포함하지 않는다. 이 문서는 텍스트 없는 집계와 digest만 담는다. 이용 범위는 [외부 자료 검토](external-material-review-public-domain-literature.md)(#332에서 확정, 본 이슈에서 재개하지 않음)를 따른다. 파일럿 계약은 [#332 보고](literature-index-pilot-report-issue-332.md).

## 도구

- `npm run reference:literature:full-build` / `full-verify` (`scripts/reference/build-literature-index.mjs`), 검색은 `reference:literature:search`(기본 대상이 전수 DB; 파일럿 DB는 `--index`).
- 출력(Git 제외): `data/reference/indexes/public-domain-literature.sqlite`, `public-domain-literature.manifest.json`. `written-corpus-2025.sqlite`와 파일럿 DB는 건드리지 않는다. 스키마는 #332 v1 그대로(`source_files`/`works`/`text_units`/`unit_fts`/`index_metadata`), `index_metadata.build_kind = full`만 추가.
- 빌드는 파일 하나씩 디코드·삽입·즉시 DB 재구성 비교하고 본문을 누적하지 않는다. 임시 디렉터리에 스테이징 후 quick_check/FK/FTS integrity-check, 입력 파일 집합(추가·삭제)과 SHA-256 재확인, 논리 digest 재계산을 모두 통과해야 DB와 매니페스트를 `rename`으로 교체한다. 어느 단계든 실패하면 이전 DB/매니페스트는 그대로다.
- `error` 파일(빈 파일·PUA·해독 불가·U+FFFD 등)은 DB에서 제외하되 매니페스트에 사유와 SHA-256으로 남긴다. 디코더는 완화하지 않았다.
- `full-verify`: 매니페스트↔DB 결합(digest), 디스크의 TXT 집합·바이트 변경, 포함 작품 전부의 정확 재구성, 제외 파일의 DB 부재, SQLite/FTS 무결성, 논리 행 digest를 확인한다(FTS integrity-check가 INSERT 명령이라 연결은 쓰기 가능하나 트랜잭션을 항상 롤백한다).
- 검색 결과에 작품 식별(work_id, 파일명 유래 **미검증** 제목/저자), 히트 단위의 정확한 행·종결자, 블록 번호, 그리고 파일 경계를 넘지 않는 ±N(0–3, 기본 2) 물리 행 문맥(`context`, 원래 순서, `is_hit`)을 담는다. 문단 복원은 하지 않는다.

## 전수 빌드 결과 (2026-10-06, 로컬 컬렉션)

| 장르 | ok | warning | error | 포함 | 제외 |
|---|---:|---:|---:|---:|---:|
| poem | 3,678 | 3,042 | 1,629 | 6,720 | 1,629 |
| novel | 417 | 639 | 84 | 1,056 | 84 |
| essay | 1,222 | 1,472 | 169 | 2,694 | 169 |
| 합계 | 5,317 | 5,153 | 1,882 | **10,470** | **1,882** |

#332 기준선(12,352 / 10,470 / 1,882; 장르별 수치 포함)과 **차이 없음**.

- 제외 사유: PUA 1,114, 빈 파일 758, 바이트 해독 불가 9, U+FFFD 1.
- 원문 바이트: 전체 90,367,092 / 포함분 73,060,641. DB 250,417,152 bytes(포함분 대비 3.43배).
- 물리 행(text_units): 864,774.
- 빌드 28.9–30.7s(두 번 실행), 피크 RSS 195–215MB; 검증 10.2s, 피크 RSS 191MB.
- 입력 매니페스트 digest `b71366f2e48dea0cf05b03f6051b459b0d5cb71027dd116793d369ceff7d4097`, 논리 행 digest `bbb19a0b3535eca20f11431cf2c786bb399377356147b1224c3515b8bb9752fe`. 같은 소스에 대한 두 번째 빌드가 두 digest 모두 동일.
- 검증: 포함 10,470편 모두 DB 단위에서 재구성한 텍스트가 디코드된 TXT와 정확히 일치, 제외 1,882편 모두 DB에 없음, 문제 0건.

## 한계와 후속 권고

- 소설·수필의 하드랩으로 어구가 물리 행 경계에서 갈라지면 literal 검색에 잡히지 않는다(문맥 창으로 읽을 수는 있음). 가역적 문단/행 경계 횡단 검색은 별도 파생 계층 후속 이슈.
- 호환 한자(NFC 아님 4,663개 파일) 등 파생 정규화 검색은 충실 계층과 분리해 후속으로.
- 제외 1,882편(PUA·빈 파일 등) 복구는 본 이슈 범위 밖. 제목/저자는 파일명 유래 미검증 값이다.
- 리터럴 히트는 텍스트 출현 증거일 뿐 표제어·품사·빈도 증거가 아니다.
