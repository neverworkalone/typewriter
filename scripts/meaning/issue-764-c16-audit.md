# Issue #764 C16 meaning boundary audit

## Scope and evidence

Source-bound agent self-check for Issue #764, range C16 (ㅋ), based on `master` at `417aaf0f`. I read every C16 Meaning row (5,616 rows, 4,904 lemmas) with its bound canonical glosses. The 488 lemmas that had more than one Meaning row (1,200 rows) were each judged individually; the other 4,416 lemmas already had one Meaning and need no repartition. This is an agent self-check, not an independent review or human approval.

The executable record is [`issue-764-c16.json`](issue-764-c16.json): 341 repartitions, each with the exact `before` snapshot and the final groups. No canonical row, adjudication, or DROP changed.

| Measure | Before | After |
| --- | ---: | ---: |
| C16 Meaning rows | 5,616 | 5,152 |
| Lemmas with several Meanings | 488 | 337 |
| Rows in the 341 repartitioned lemmas | 871 | 407 |

## Boundary decisions

- Polysemy is merged: the same lemma used for several objects, fields, or figurative ranges is one Meaning (`카드`, `크다`, `키` key family, `카운트`, `커트`, `컵`, `크림`, `코너`). Merged glosses list each source use in order; the "‘…’보다 거센 느낌" comparator tails are dropped when several uses are joined.
- Same-word variants across a derivation family are merged consistently (`카랑카랑`, `콩닥…`, `쿵쾅…`, `쿵쿵…`, `킁킁…`, `큼큼…`, `킹킹…`, `쿨렁…`, `콜랑…`): each pair of senses is one expressive concept applied to a sound or a bodily/physical image. Sound/smell/dog-bark splits (`콜콜`, `쿨쿨`, `콩콩`'s dog bark) are retained because no natural extension links them.
- Homonyms are kept apart: different people or places sharing a name, `칼`(형틀/도구), `칼집`, `코`(매듭/신체), `켜다`(점등/들이킴/기지개/골/우레/톱질·켜기), `쾌락`·`쾌유`·`쾌우`, `큰절`, `큰판`, `키`(키/배의 키/까부르는 키/그리스 문자/인명), `콩`(소리/식물), `콩팥`, `쿠페`, `크래커`.
- Loanword senses of one source word are merged (`카메오`, `카트리지`, `코어`, `콘`, `콜로니`, `클럽`의 카드·골프 용법, `크레이터`); loanword homonyms from different source words stay separate (`카본`, `컬러`의 빛깔/컬러(curler), `컬러`의 원통형 기구, `커터`의 도구/배, `케이스`).
- Idioms and compounds whose literal and figurative uses share an image are merged (`칼바람`, `코딱지`, `콩나물시루`, `콩알`, `큰소리` 계열, `키질`, `키잡이`).

## Retained multi-Meaning lemmas needing explicit rationale

Remaining multi-Meaning lemmas are of three kinds: unrelated persons/places/works sharing a name; true homonyms listed above; and unit/term homonyms (`케이`, `큐`, `켤레`). I did not retain any split solely because the source used different record numbers or POS.

## Limits

Decisions rest on canonical glosses only; no external dictionary was consulted. Boundary calls such as `카운터`(복싱/피겨/계산대·패), `칸살`(무당 은어), `콱`(쏟음), `킬`(탈산제/테니스) are judgment calls reviewers may want to revisit.
