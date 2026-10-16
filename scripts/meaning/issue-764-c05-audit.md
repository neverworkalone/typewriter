# Issue #764 C05 Meaning boundary audit

## Scope and evidence

This is the source-bound self-check for C05 (`ㄸ`) on the exact `origin/master` base `417aaf0fd718c6b1695b177b685348cdd6205729`. I read the complete set of canonical C05 records and senses together with the existing Meaning rows for each lemma. The executable decision record is [`issue-764-c05.json`](issue-764-c05.json): it contains an exact `before` snapshot and a complete, non-overlapping final sense partition for every C05 lemma, including unchanged one-sense lemmas.

| Measure | Before | After |
| --- | ---: | ---: |
| C05 canonical records (STDICT) | 2,505 | 2,505 |
| C05 lemmas | 2,317 | 2,317 |
| C05 canonical senses | 3,505 | 3,505 |
| C05 Meaning rows | 3,347 | 2,530 |
| Lemmas with more than one Meaning | 465 | 142 |
| Lemmas whose final partition changed | — | 400 |

The source-bound boundary review covered all 465 lemmas that had multiple Meaning rows and all 77 lemmas that had multiple canonical senses grouped under one Meaning (542 lemmas total). The other 1,775 C05 lemmas each had one canonical sense and one Meaning and retain that binding. The complete spec has 2,317 repartitions; all 3,505 canonical senses remain assigned exactly once. There are no drops and no adjudication changes. The net Meaning reduction is 817 rows.

The representative gloss was rewritten for each newly combined Meaning group; existing glosses were retained when a final group exactly matched its recorded `before` row. Canonical JSONL is unchanged. Applying the complete spec to a clean archive of the exact base completed with 494,308 total repository meanings and 117 adjudications. The resulting SHA-256 values of `c05_001.jsonl` through `c05_004.jsonl` match the current worktree exactly.

This is an **agent self-check in the primary context**, not an independent review. Issue #764 still requires independent first- and second-pass reviews; those remain pending for the PR. This audit does not claim completion of Issue #764.

## Boundary decisions

- `ㄸ` (`w95817-s1`, `w95817-s2`) is one Meaning for the written jamo and its consonant sound.
- `따뜻하다` and related forms group physical warmth with warmth or heat in a person's face, feelings, and attitude. The source glosses use the same warmth concept across literal and figurative uses.
- `따다` groups picking, detaching, and obtaining or winning uses under the shared act of taking something out or securing it. The cross-reference to `뜨다` remains separate.
- `딱` and `딱딱` keep impact sounds apart from adverbial uses describing an exact, abrupt, firm, or decisive state or action. `딱지` groups coverings and crusts separately from labels, slips, cards, documents, and figurative stigma, whose source uses center on an attached identifying or covering mark.
- `떠받다` separates supporting from below (`w97926-s1`) from striking with the head or horns (`w418746-s1`): the direction and action have no natural shared lexical core. `떨다` separates removing or disposing (`w99670-s1..s6`) from shaking or trembling (`w418961-s1..s6`); `떨치다` separates shaking something off or abandoning it (`w99732-s1..s2`) from spreading fame or reputation (`w419908-s1`).
- `떼꺽`, `떼꺽떼꺽`, and `떼꺽하다` keep the impact/cracking sound apart from doing something readily or without hesitation. Matching sound-symbolic form alone does not establish one lexical identity. The same sound-versus-state boundary is retained for `뚝` and `뚝뚝`.
- `떡` groups the food, fishing bait, and older bread use that share a rice-based food meaning. The shape adverb and unrelated colloquial senses remain separate.
- The 27 senses of `떨어지다` (`w98003-s1..s27`) remain one lexical identity: the source uses extend falling or separation to decreases, distance, loss, ending, assignment, and residual results. The gloss leads with movement away or downward and covers those conventional extensions; the row is not split only because its senses have different objects or sentence patterns.
- `떼다` keeps the main removal/separation lexeme and its conventional extensions together (`w418583-s1..s17`), while the independent “not repay borrowed money” use (`w97665-s1`) remains separate.
- `뛰다` (`w99271-s1`, `w99383-s1..s6`, `w414830-s1..s8`) groups rapid movement and leaping with their conventional applications to activity, escape, heartbeat, rising prices, force, and bouncing or swinging motion. These uses preserve the same vigorous movement or upward-motion identity.
- `뜨다` retains separate Meaning families for fermentation, leaving, opening the eyes or attending to sound, stitching or marking, scooping or cutting a portion, floating or appearing, making a print or pattern, slowness or bluntness, and spatial or temporal distance. Only senses with a source-supported lexical extension are grouped within each family.

## Validation and limits

- `node scripts/meaning/apply-edits.mjs scripts/meaning/issue-764-c05.json` replayed from a clean archive of the recorded base. All four output shard hashes matched the edited worktree.
- `node scripts/meaning/validate.mjs` passed: 494,308 meanings and 117 adjudications.
- The independent review gates in Issue #764 remain outstanding and must be completed through ordinary PR discussion before merge.
