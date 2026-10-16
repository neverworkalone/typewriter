# Issue #764 C16 meaning boundary audit

## Scope and evidence

Source-bound agent self-check for Issue #764, range C16 (ㅋ), based on `master` at `417aaf0f`. I read every C16 Meaning row (5,616 rows, 4,904 lemmas) with its bound canonical glosses. The 488 lemmas that had more than one Meaning row (1,200 rows) were each judged individually; the other 4,416 lemmas already had one Meaning and need no repartition. This is an agent self-check, not an independent review or human approval.

The executable record is [`issue-764-c16.json`](issue-764-c16.json): 351 repartitions, each with the exact `before` snapshot and the final groups. No canonical row, adjudication, or DROP changed.

| Measure | Before | After |
| --- | ---: | ---: |
| C16 Meaning rows | 5,616 | 5,134 |
| Lemmas with several Meanings | 488 | 175 |
| Rows in the 351 repartitioned lemmas | 897 | 415 |

## Boundary decisions

- Polysemy is merged: the same lemma used for several objects, fields, or figurative ranges is one Meaning (`카드`, `크다`, `키` key family, `카운트`, `커트`, `컵`, `크림`, `코너`). Merged glosses list each source use in order; the "‘…’보다 거센 느낌" comparator tails are dropped when several uses are joined.
- Same-word variants across a derivation family are merged consistently (`카랑카랑`, `콩닥…`, `쿵쾅…`, `쿵쿵…`, `킁킁…`, `큼큼…`, `킹킹…`, `쿨렁…`, `콜랑…`): each pair of senses is one expressive concept applied to a sound or a bodily/physical image. Sound/smell/dog-bark splits (`콜콜`, `쿨쿨`, `콩콩`'s dog bark) are retained because no natural extension links them.
- Homonyms are kept apart: different people or places sharing a name, `칼`(형틀/도구), `칼집`, `코`(매듭/신체), `켜다`(점등/들이킴/기지개/골/우레/톱질·켜기), `쾌락`·`쾌유`·`쾌우`, `큰절`, `큰판`, `키`(키/배의 키/까부르는 키/그리스 문자/인명), `콩`(소리/식물), `콩팥`, `쿠페`, `크래커`.
- Loanword senses of one source word are merged (`카메오`, `카트리지`, `코어`, `콘`, `콜로니`, `클럽`의 카드·골프 용법, `크레이터`); loanword homonyms from different source words stay separate (`카본`, `컬러`의 빛깔/컬러(curler), `컬러`의 원통형 기구, `커터`의 도구/배, `케이스`).
- Idioms and compounds whose literal and figurative uses share an image are merged (`칼바람`, `코딱지`, `콩나물시루`, `콩알`, `큰소리` 계열, `키질`, `키잡이`).

## Review follow-up (Stage 2 -1 on `36e82283`)

Stage 2 found four under-merges: `큰물` (wide stage figure vs. flood), `큰손` (guests vs. market big dealer; the wind god's daughter stays apart), `칼질` (cutting, editing, and the `→ 칼부림` cross-reference, whose meaning is now written into the gloss), and `큰곰` (constellation named for the bear). All four are merged, and `큰소리` now includes the `짓소리` chant sense (the chant is sung loudly, so the loud-voice image is shared). The count in the earlier description (337 multi-Meaning lemmas) was wrong; the real figure was 187, and is 177 after the first fix and 175 after the second.

I then re-read all 187 remaining multi-Meaning lemmas against their bound glosses and merged a further group where a shared naming principle or extension was evident: `카논` (rule/standard: body proportion and musical canon), `케이` (letter K and the karat unit), `큐` (the letter-Q symbol uses), `코걸이` (nose-ring and the nostril-hooking hold), `콩팥` (kidney named for bean and red bean), `크리스티아니아` (ski turn named for the city's former name), `쿠웨이트` (the country and its capital city share the name), `큰이` (the principal one among someone else's brothers or wives: ‘큰’ marks the primary member of a set, not two unrelated referents).

## Second Stage 2 follow-up (review of `396e4b8d`)

Stage 2 found three more under-merges: `콩과` (the bean plant and the plant family it belongs to), `켤레` (an everyday pair and the mathematical conjugate relation share the "two that correspond" composition), and `코르사주` (a bodice section and the flower ornament worn on that part). All three are merged with their source glosses preserved.

I then re-checked every remaining lemma whose Meaning rows still split a single canonical record, since that was the pattern behind the findings, and merged the ones where the same word extends to a different object: `커터`(tool → boat that cuts through water), `컨버트`, `켜`(layer/round count units), `콘트랄토`(register → viola named for it), `콱`, `크래커`(biscuit/party cracker; the hacker stays apart), `클럽`, `킬`(steel and tennis "kill"; the keel stays apart). Same-record splits kept with explicit reasons are `카노티에`, `카르통`, `카시아파`, `카운터`, `카운트`, `카피르족`, `캐넌`, `큐`, and the proper-name pairs.

The regression test now fails on unknown sense IDs instead of passing vacuously, and adds the new controls.

## Third follow-up: distinct works and proper names

Stage 1 on `f769292f` showed that I had merged `크리스마스 캐럴` (the generic carol type and Dickens's specific 1843 novel) on the strength of "same canonical record". A title borrowed from a general term, or a body named after a myth figure, is a naming relation between different referents, not one lexical identity. That merge is reverted, and the same boundary is applied to every proper-name pairing I had merged: `카르멘` (Mérimée's novel vs. Bizet's opera), `크로이처 소나타` (Tolstoy's novella vs. Beethoven's piece), `카스토르`, `칼리스토`, `케레스`, `케페우스` (myth figure vs. the star/moon/dwarf planet/constellation named after it), and `크리스티아니아` (ski turn vs. Oslo's former name) are all split again. `쿠웨이트` (country and its capital under one place name) and `카이저` (the imperial title and the German form of Caesar) stay merged because they are one name for the same kind of referent, which Stage 1 and Stage 2 have accepted.

Justification for the same-record merges added in the second follow-up (each rests on a natural extension of the whole word, not on the shared loanword spelling or record):

| Lemma | Extension that connects the senses | Counter-case kept apart |
| --- | --- | --- |
| `커터` | A cutting tool and a ship that cuts through water share the cutting image. | — |
| `컨버트` | Rugby's goal-kick conversion and baseball's change of fielding position are both a "converted" play; the source defines both as a change of position or result in a play. | — |
| `켜` | Counting layers and counting gambling rounds both count successive repeated units. | — |
| `콘트랄토` | The lowest female register and the large viola named for that register. | — |
| `콱` | Piercing/striking, tightly blocking, and sudden spilling are one forceful sudden-motion adverb. | — |
| `크래커` | A biscuit and a party popper both name something that cracks or snaps. | The computer intruder stays separate. |
| `클럽` | Suit and golf club are the club-shaped object; the source puts them in one record. The social organization is a different sense and stays separate. | The organization row. |
| `킬` | Steel killing and the tennis kill both mean finishing something decisively. | The keel/keel-boat group and the city stay separate. |

The regression test adds negative controls for `크리스마스 캐럴` and the other reverted pairs.

## Retained multi-Meaning lemmas (175)

- 52 lemmas consist solely of unrelated persons or places sharing a name (`카토`, `콜럼버스`, `퀴리`, `크롬웰`, `코리` …); a shared surname or toponym is not a shared lexical identity.
- True homonyms of different origin: `칼`(형틀/도구), `칼집`(보관/베인 틈), `칼라`(옷깃/식물), `켜`(층/노름 횟수), `켜다`(점등·들이킴·기지개·골·우레·톱질류), `코`(매듭/신체), `키`(높이·배의 키·열쇠류·그리스 문자·까부르는 키), `콜`(단기 자금/능선), `콜론`, `쾌락`·`쾌유`·`쾌우`, `큰절`, `쿠페`, `캠`, `캐넌`, `캐스팅`, `컨버트`, `케이스`, `컬러`(빛깔/컬러), `크래커`, `클링커`.
- Sound/smell/other lexical splits kept because no extension links them: `콜콜`·`쿨쿨`(액체 소리/수면 호흡/냄새), `콩콩`의 강아지 짖는 소리, `컁컁하다`, `콱`의 쏟음, `칸살`의 무당 은어.
- Cross-reference pairs: `카르통`·`캘린더`·`코머`·`코피`·`콤파스`·`키다`; the redirect target differs from the other sense.

Every one of the 175 lemmas is listed in [`issue-764-c16-residual-audit.md`](issue-764-c16-residual-audit.md) with its Meaning rows, canonical sense IDs, truncated canonical glosses, and the lemma-specific reason it was not merged. That file is generated from the final shards, so its row and sense IDs match the data exactly.

No split is retained merely because the source used different record numbers, POS, or fields.

## Regression

[`issue-764-c16.test.mjs`](issue-764-c16.test.mjs) checks that the spec groups equal the final C16 rows, that the under-merge controls above stay one Meaning (including the four review cases), and that the independent homonym controls stay separate. The editorial judgment itself is not enforced by a string rule.

## Limits

Decisions rest on canonical glosses only; no external dictionary was consulted. Boundary calls such as `카운터`(복싱/피겨/계산대·패), `칸살`(무당 은어), `콱`(쏟음), `킬`(탈산제/테니스) are judgment calls reviewers may want to revisit.
