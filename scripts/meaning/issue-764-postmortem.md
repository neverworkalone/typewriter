# #764 포스트모텀 기초자료 — 통합 목차 (#814)

> C01~C19의 **현재 병합/분리 상태를 기록한 읽기 전용 목록**의 목차다. 아래 건수는 구조 집계이며 과병합·과분리 확정 집계나 편집 규칙 제안이 아니다.

- 기준 master SHA: `cf73dd4a946af4c0de40c39f62add08ceb6924a2`
- 데이터 다이제스트: `7b521c8c6e4e111bb8c9552fb7c557748c07b24f167303fbf57d1946578b7e27`
- canonical: 428 shard / 427,583 record, Meaning 444,400행, adjudication 133행, 공통 validator 오류 0건
- 재생성: `node scripts/meaning/postmortem.mjs --input-sha <SHA>`; 일치 검증: `node scripts/meaning/postmortem.mjs --check`

| 초성 | 보고서 | 상세 목록 | Meaning | A: 2+ sense Meaning | B: 2+ Meaning lemma | 검토 lemma (A∪B) | A·B 양쪽 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| c01 (ㄱ) | [md](issue-764-c01-postmortem.md) | [jsonl](issue-764-c01-postmortem.jsonl) | 59,741 | 6,951 | 5,015 | 9,039 | 2,103 |
| c02 (ㄲ) | [md](issue-764-c02-postmortem.md) | [jsonl](issue-764-c02-postmortem.jsonl) | 3,744 | 879 | 144 | 938 | 72 |
| c03 (ㄴ) | [md](issue-764-c03-postmortem.md) | [jsonl](issue-764-c03-postmortem.jsonl) | 15,681 | 1,929 | 1,219 | 2,552 | 502 |
| c04 (ㄷ) | [md](issue-764-c04-postmortem.md) | [jsonl](issue-764-c04-postmortem.jsonl) | 25,121 | 3,082 | 1,885 | 3,880 | 788 |
| c05 (ㄸ) | [md](issue-764-c05-postmortem.md) | [jsonl](issue-764-c05-postmortem.jsonl) | 2,483 | 527 | 117 | 542 | 75 |
| c06 (ㄹ) | [md](issue-764-c06-postmortem.md) | [jsonl](issue-764-c06-postmortem.jsonl) | 2,917 | 139 | 150 | 254 | 30 |
| c07 (ㅁ) | [md](issue-764-c07-postmortem.md) | [jsonl](issue-764-c07-postmortem.jsonl) | 25,356 | 2,420 | 1,978 | 3,588 | 623 |
| c08 (ㅂ) | [md](issue-764-c08-postmortem.md) | [jsonl](issue-764-c08-postmortem.jsonl) | 36,492 | 4,346 | 3,123 | 5,982 | 1,138 |
| c09 (ㅃ) | [md](issue-764-c09-postmortem.md) | [jsonl](issue-764-c09-postmortem.jsonl) | 1,913 | 598 | 55 | 617 | 26 |
| c10 (ㅅ) | [md](issue-764-c10-postmortem.md) | [jsonl](issue-764-c10-postmortem.jsonl) | 56,889 | 3,103 | 5,986 | 7,525 | 1,141 |
| c11 (ㅆ) | [md](issue-764-c11-postmortem.md) | [jsonl](issue-764-c11-postmortem.jsonl) | 2,116 | 346 | 78 | 373 | 29 |
| c12 (ㅇ) | [md](issue-764-c12-postmortem.md) | [jsonl](issue-764-c12-postmortem.jsonl) | 79,627 | 286 | 10,329 | 10,533 | 53 |
| c13 (ㅈ) | [md](issue-764-c13-postmortem.md) | [jsonl](issue-764-c13-postmortem.jsonl) | 50,309 | 6,213 | 4,425 | 7,787 | 2,001 |
| c14 (ㅉ) | [md](issue-764-c14-postmortem.md) | [jsonl](issue-764-c14-postmortem.jsonl) | 1,614 | 512 | 131 | 532 | 78 |
| c15 (ㅊ) | [md](issue-764-c15-postmortem.md) | [jsonl](issue-764-c15-postmortem.jsonl) | 20,907 | 2,715 | 2,061 | 3,723 | 802 |
| c16 (ㅋ) | [md](issue-764-c16-postmortem.md) | [jsonl](issue-764-c16-postmortem.jsonl) | 5,140 | 433 | 179 | 559 | 43 |
| c17 (ㅌ) | [md](issue-764-c17-postmortem.md) | [jsonl](issue-764-c17-postmortem.jsonl) | 10,316 | 1,069 | 867 | 1,607 | 258 |
| c18 (ㅍ) | [md](issue-764-c18-postmortem.md) | [jsonl](issue-764-c18-postmortem.jsonl) | 14,776 | 514 | 1,835 | 2,166 | 138 |
| c19 (ㅎ) | [md](issue-764-c19-postmortem.md) | [jsonl](issue-764-c19-postmortem.jsonl) | 29,258 | 3,155 | 2,654 | 4,825 | 816 |
| 합계 | | | 444,400 | 39,217 | 42,231 | 67,022 | 10,716 |

A·B 양쪽 열은 검토 lemma 중 두 집합에 모두 속한 수이며, 합계 검토 lemma는 중복을 한 번만 센다. `c20`(한글 초성이 아닌 표제어)은 이슈 범위(C01~C19) 밖이라 포함하지 않는다.

