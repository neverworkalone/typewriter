# Issue #764 C14 meaning boundary audit

## Scope and evidence

This is the C14 (ㅉ) source-bound self-check for Issue #764, based on `origin/master` at `417aaf0f`. It re-judged every C14 lemma that had more than one #716 Meaning row (520 of 1,435 lemmas, 1,607 rows) against the lemma's full set of canonical records and senses and the current Meaning glosses. The executable decision record is [`issue-764-c14.json`](issue-764-c14.json): each of the 467 lemmas whose grouping changed carries an exact `before` snapshot and a complete `groups` partition. The other 53 multi-Meaning lemmas were re-read and deliberately retained. Single-Meaning lemmas cannot be split or merged and are untouched.

| Measure | Before | After |
| --- | ---: | ---: |
| C14 lemmas | 1,435 | 1,435 |
| C14 Meaning rows | 2,522 | 1,614 |
| Multi-Meaning lemmas re-judged | 520 | — |
| Lemmas whose Meaning count changed | — | 467 |
| Multi-Meaning lemmas retained as is | — | 53 |
| Repository adjudications | 117 | 117 |

Every canonical C14 sense stays in exactly one final group; no sense is dropped and no adjudication is added. Canonical JSONL is unchanged. `apply-edits` checks the exact current snapshot of each lemma and rejects missing, duplicated or foreign senses before writing.

## Boundary decisions

- The default unit is the **canonical record**: senses of one dictionary record are one Meaning unless the glosses show unrelated referents. Different records of the same lemma stay separate unless a natural extension links them (`짝자래나무`: two plants called by one tree name are one Meaning).
- Literal ↔ figurative and concrete ↔ abstract extensions are merged: `짜내다`, `짜깁기`, `짜들다`, `짭짤하다`, `찌푸리다`, `째푸리다`, `찌뿌둥하다`, `찍다`, `찌르다`, `찧다`, `찜 쪄 먹다`.
- Mimetic and onomatopoeic families keep parallel units across -거리다/-대다/-하다/-이다/reduplicated forms. Senses sharing one sound or movement image are merged (`짤가닥`, `짤끔`, `쩔거덕`, `쩝쩝`, `쪽`, `쭉`, `쫀득`, `쩡`, `쪼뼛`/`쭈뼛`), and abbreviation (준말) rows of the same base are one Meaning with the sense numbers combined in one gloss.
- Identical mimetic forms with unrelated actions are kept apart even inside one record: `짜긋`/`째긋`/`찌긋` families (squinting the eyes vs. tugging a sleeve), `쪼작` (toddling vs. pecking), `짯짯`/`쩟쩟` (rough temper/texture vs. clear colour); in `짝`/`짝짝`/`쩍`/`쩍쩍` only the `꼴`/cross-reference record stays apart.
- Independent homonyms stay separate: `짜개` (split bean vs. fishing bait), `짜다` (squeeze, salty/stingy, assemble), `짝` (pair, `꼴` suffix, units, mimetic forms), `짬` (spare time vs. paper-trimming mark), `쪽` (hair knot, face, opium, plant, fragment, direction, page), `쪽박`, `쫄쫄이` (person / garment / liquor slang), `쫍치다`, `쫑그리다`/`쭝그리다`, `짤짤이`, `찌그렁이`.
- Review of PR #776 showed that splitting a record only because the sensory modality differs is under-merge when the senses share one image: `쫘르르` (pouring, sliding, and the sheen that "flows"), `쪼르르`/`쭈르르` (flowing, sliding, quick steps, a line of small things) and `쫄망쫄망`/`쭐멍쭐멍` (uneven mixed objects and bumpy surface) are therefore one Meaning each. The same cause was checked across the other same-record mimetic splits; those kept apart (`짜긋` family, `쪼작`, `쪼록쪼록`, `짯짯`, `쩍`, `찡`) pair actions or referents with no shared image.
- Stage 2 review of PR #776 found the same under-merge cause in unchanged same-record splits. Re-judged as one Meaning each: `짝 잃은 원앙` (one image applied to a person and to a plight), `쪼록쪼록`/`쭈룩쭈룩` and their `-하다` forms (running water and evenly lined wrinkles share a linear, continuous image), `쪽발이` (the source gloss derives the slur from the split-toe shoe, the same split-foot naming principle as the objects), `짭짭하다` (mouth-smacking and the appetite it expresses), `짝짜꿍이`/`짝짜꿍이하다`, `쩍` (slag and flaking crust as residue), and the mouth-smack / gaping uses of `짝`/`짝짝`/`쩍`/`쩍쩍`. The leak-and-give uses of `짤름`/`찔름` forms are joined as the dictionary already does for `짤끔`/`찔끔`. All same-record splits (and cross-record candidates) were re-read for this cause; the splits that remain pair referents with no shared image or naming principle (`짜긋`/`째긋`/`찌긋` families and `쪼작`, accepted by both reviewers; `짯짯`/`쩟쩟`, `짤짤이`, `쫄쫄이`, `쪽박`, `짬`, `찌그렁이`, `쫍치다`, `쫑그리다`, `찜`).
- Second Stage 2 review: `쪼르르` is one Meaning across records (water, sliding, quick steps, a line of small things and fast, linked speech all extend the continuous-line image), `찜` is one Meaning (steamed food and the heated compress/sweat treatment share the steaming-heat image), and `찡`/`찡하다` join the sharp crack and the aching chest the way `쩡` already does. Negative contrasts remain `짜긋`/`쪼작`-type pairs of unrelated actions and the separate `찜` record for a flaw in a target (`w319684`). Other cross-record keeps (`짤똑짤똑`, `쨍`, `찍개`, `쪼다`) were re-read for the same two causes (continuous-line image across records, use/purpose change inside one record) and share no image or naming principle in the source.
- Cross-reference records (`→ …`, 본말/준말 pointers) remain bound to their own source senses and were not rewritten.
- Form identity alone did not justify a merge across records. Where the dictionary lists several manner uses of one adverb under one record (`쪽`, `쭉`, `쭉쭉`), they are one Meaning because the uses extend from a single movement image.

## Gloss checks

A merged Meaning's gloss lists each included source usage in full, in canonical sense order; identical sentences are not repeated, and 준말 rows of one base are combined (`‘짤가닥「1」·「2」·「3」·「4」’의 준말.`). No usage was rewritten or abstracted.

## Provenance and review status

Semantic decisions and this audit were prepared and checked in the primary agent context against the canonical source glosses and current Meaning bindings. This provenance is **agent self-check**. It is not an independent first or second review and does not claim human editorial approval. The independent reviews listed in Issue #764 remain pending; this audit supports a reviewable C14 PR and does not close the overall issue. Part-of-speech was not used to split or merge; boundary calls on mimetic words (above) are the areas a reviewer should scrutinise first.
