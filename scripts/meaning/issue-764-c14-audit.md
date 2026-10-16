# Issue #764 C14 meaning boundary audit

## Scope and evidence

This is the C14 (ㅉ) source-bound self-check for Issue #764, based on `origin/master` at `417aaf0f`. It re-judged every C14 lemma that had more than one #716 Meaning row (520 of 1,435 lemmas, 1,607 rows) against the lemma's full set of canonical records and senses and the current Meaning glosses. The executable decision record is [`issue-764-c14.json`](issue-764-c14.json): each of the 446 lemmas whose grouping changed carries an exact `before` snapshot and a complete `groups` partition. The other 74 multi-Meaning lemmas were re-read and deliberately retained. Single-Meaning lemmas cannot be split or merged and are untouched.

| Measure | Before | After |
| --- | ---: | ---: |
| C14 lemmas | 1,435 | 1,435 |
| C14 Meaning rows | 2,522 | 1,649 |
| Multi-Meaning lemmas re-judged | 520 | — |
| Lemmas whose Meaning count changed | — | 446 |
| Multi-Meaning lemmas retained as is | — | 74 |
| Repository adjudications | 117 | 117 |

Every canonical C14 sense stays in exactly one final group; no sense is dropped and no adjudication is added. Canonical JSONL is unchanged. `apply-edits` checks the exact current snapshot of each lemma and rejects missing, duplicated or foreign senses before writing.

## Boundary decisions

- The default unit is the **canonical record**: senses of one dictionary record are one Meaning unless the glosses show unrelated referents. Different records of the same lemma stay separate unless a natural extension links them (`짝자래나무`: two plants called by one tree name are one Meaning).
- Literal ↔ figurative and concrete ↔ abstract extensions are merged: `짜내다`, `짜깁기`, `짜들다`, `짭짤하다`, `찌푸리다`, `째푸리다`, `찌뿌둥하다`, `찍다`, `찌르다`, `찧다`, `찜 쪄 먹다`.
- Mimetic and onomatopoeic families keep parallel units across -거리다/-대다/-하다/-이다/reduplicated forms. Senses sharing one sound or movement image are merged (`짤가닥`, `짤끔`, `쩔거덕`, `쩝쩝`, `쪽`, `쭉`, `쫀득`, `쩡`, `쪼뼛`/`쭈뼛`), and abbreviation (준말) rows of the same base are one Meaning with the sense numbers combined in one gloss.
- Identical mimetic forms with unrelated actions are kept apart even inside one record: `짜긋`/`째긋`/`찌긋` families (squinting the eyes vs. tugging a sleeve), `쪼작` (toddling vs. pecking), `쪼록쪼록`/`쭈룩쭈룩` (running water vs. fine wrinkles), `쫄망쫄망`/`쭐멍쭐멍` (mixed small objects vs. bumpy surface), `쫘르르` (glossy sheen vs. pouring/sliding sounds), `짯짯`/`쩟쩟` (rough temper/texture vs. clear colour), `쩍`/`찡` (cracking sound vs. slag or emotional ache), `쪼르르`/`쭈르르` (flow, slide and quick steps vs. a row of small things), `짝`/`쩍쩍`/`짝짝` (tongue-clicking vs. splitting/gaping).
- Independent homonyms stay separate: `짜개` (split bean vs. fishing bait), `짜다` (squeeze, salty/stingy, assemble), `짝` (pair, `꼴` suffix, units, mimetic forms), `짬` (spare time vs. paper-trimming mark), `쪽` (hair knot, face, opium, plant, fragment, direction, page), `쪽박`, `쪽발이` (objects vs. the ethnic slur), `쫄쫄이` (person / garment / liquor slang), `쫍치다`, `쫑그리다`/`쭝그리다`, `짤짤이`, `짝짜꿍이` (conspiring vs. quarrelling), `찜` (food vs. compress), `찌그렁이`, `짝 잃은 원앙`.
- Cross-reference records (`→ …`, 본말/준말 pointers) remain bound to their own source senses and were not rewritten.
- Form identity alone did not justify a merge across records. Where the dictionary lists several manner uses of one adverb under one record (`쪽`, `쭉`, `쭉쭉`), they are one Meaning because the uses extend from a single movement image.

## Gloss checks

A merged Meaning's gloss lists each included source usage in full, in canonical sense order; identical sentences are not repeated, and 준말 rows of one base are combined (`‘짤가닥「1」·「2」·「3」·「4」’의 준말.`). No usage was rewritten or abstracted.

## Provenance and review status

Semantic decisions and this audit were prepared and checked in the primary agent context against the canonical source glosses and current Meaning bindings. This provenance is **agent self-check**. It is not an independent first or second review and does not claim human editorial approval. The independent reviews listed in Issue #764 remain pending; this audit supports a reviewable C14 PR and does not close the overall issue. Part-of-speech was not used to split or merge; boundary calls on mimetic words (above) are the areas a reviewer should scrutinise first.
