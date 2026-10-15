# Issue #716 c11 meaning audit

## Scope and result

- Baseline: `master` at `a0c6788101748665ba4f190e3eb37a673d36dbdb`.
- Reviewed all three c11 meaning shards: 2,725 initial meanings across 2,006 lemmas.
- The initial projection had 1,633 single-meaning lemmas and 373 lemmas with multiple meanings.
- Kept all 2,006 lemmas. Merged 53 same-lemma meaning groups covering 124 canonical senses, reducing the shard from 2,725 to 2,654 meanings. No DROP decisions or c11 adjudications were needed.
- `data/canonical/` was not changed.

## Editorial checks

The first source-bound pass considered every c11 lemma and all of its records and senses. Single-meaning lemmas remain KEEP. For multi-meaning lemmas, the decisions and representative glosses are preserved in [`issue-716-c11-edits.json`](issue-716-c11-edits.json). The first follow-up pass checked all 54 merged output rows against their bound source senses, but the PR review found two omissions: `썰다`'s shortened `써리다02` sense was incorrectly merged with the cutting sense, and the `씌다` gloss omitted its umbrella use. The edit spec now keeps the two `썰다` meanings separate and names the umbrella use in the `씌다` gloss. A post-correction source-bound pass checked all 53 remaining merged rows and their source glosses; ambiguous distinctions remain separate.

Both editorial checks were performed by the assigned primary agent in this context. This is recorded as agent self-check, not independent review or human editorial approval. PR review is a separate gate; the two reported findings are corrected in this revision.

## Validation

`node scripts/meaning/validate.mjs` passed after the corrections: 499,239 meanings and 1 repository-wide adjudication are valid. `git diff --check` also passed.
