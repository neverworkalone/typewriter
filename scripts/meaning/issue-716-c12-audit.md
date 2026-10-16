# Issue #716 C12 first-pass audit (ㅇ)

## Scope and result

The C12 source projection spans 80 shards (`c12_001`–`c12_080`), with 79,935 initial meanings/sense references across 57,820 lemmas. At baseline, 10,533 lemmas had multiple meanings (32,648 sense references). This pass applies 286 merges covering 573 source senses and records 21 `duplicate` drops. The C12 projection now has 79,627 meanings; 79,914 source senses remain referenced and the other 21 are recorded in `data/adjudication/c12_001.jsonl`.

The edit specification is `scripts/meaning/issue-716-c12-edits.json`. It applies only to the C12 meaning shards and adjudication ledger. `data/canonical/` is unchanged.

## Decisions in this pass

- **247 noun/determiner merges:** same-record source glosses were compared after removing only the final nominalizer `것` or attributive ending `의` from the determiner gloss. The remaining definitions match exactly. The noun gloss is kept as the meaning gloss.
- **27 noun/adverb meaning groups:** temporal, quantitative, and manner definitions were compared source by source. The edit spec keeps one source gloss per group; `언제` combines three senses.
- **12 redirect groups:** both senses point to the corresponding noun/adverb or noun/determiner forms of one target lemma. The target senses are themselves represented as one meaning in the same edit set, so the target's canonical gloss is used. The original redirects remain untouched in canonical.
- **21 duplicate drops:** each pair has the same lemma, part of speech, and verbatim canonical gloss across records. The earlier sense ID is retained as `duplicate_of`; all drops are written to adjudication. Canonical direct-synonym links corroborate 20 pairs; one pair is supported by the identical same-lemma source gloss and part of speech alone.

All other C12 rows remain unchanged. In particular, a plausible relation or shared topic was not enough to merge distinct glosses. Redirects whose targets point to different meaning axes, including the separate action/state senses of `아니하다` and the food/sound senses of `얌냠`, remain separate.

## Review provenance and remaining work

The source-bound author check and follow-up check were performed in this primary agent context. This is **agent self-check**, not independent first/second review or human editorial approval. The PR review process remains separate. This pass does not complete C12: the untouched multiple-meaning groups still need editorial review, followed by the two review stages required by Issue #716. Keep Issue #716 open and do not check C12 complete until that work is done.
