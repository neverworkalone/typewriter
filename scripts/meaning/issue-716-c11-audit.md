# Issue #716 c11 meaning audit

## Scope and result

- Baseline: `master` at `a0c6788101748665ba4f190e3eb37a673d36dbdb`.
- Reviewed all three c11 meaning shards: 2,725 initial meanings across 2,006 lemmas.
- The initial projection had 1,633 single-meaning lemmas and 373 lemmas with multiple meanings.
- Kept all 2,006 lemmas. Merged 53 same-lemma meaning groups covering 124 canonical senses, reducing the shard from 2,725 to 2,654 meanings. No DROP decisions or c11 adjudications were needed.
- `data/canonical/` was not changed.

## Editorial checks

The first source-bound pass considered every c11 lemma and all of its records and senses. Single-meaning lemmas remain KEEP unless a source gloss is an opaque cross-reference that needs a direct meaning-layer gloss. Multi-meaning decisions and authored glosses are preserved in [`issue-716-c11-edits.json`](issue-716-c11-edits.json). PR review found that `썰다`'s shortened `써리다02` sense was incorrectly merged with the cutting sense and the `씌다` gloss omitted its umbrella use. The two `썰다` meanings are now separate, and the `씌다` gloss names the umbrella use. A follow-up review confirmed those changes and noted that `m212148` still showed only the cross-reference; its gloss is now directly written as `써레질을 하다.` from the referenced canonical sense `w455663-s1`. A later source-bound review found that nine tilt-related merge glosses omitted their bound senses' transitive/causative use, and the `쌓다`/`쌓이다` glosses omitted `지식`, `불명예`, and `불신`. The edit spec preserves these same-lemma merge groups and now names those source meanings explicitly. The post-correction pass checked the 53 merged rows, this single-sense gloss edit, and all changed source senses; ambiguous distinctions remain separate.

Both editorial checks were performed by the assigned primary agent in this context. This is recorded as agent self-check, not independent review or human editorial approval. PR review is a separate gate; the reported source-bound findings are corrected in this revision.

## Validation

`node scripts/meaning/validate.mjs` passed after the corrections: 499,239 meanings and 1 repository-wide adjudication are valid. `git diff --check` also passed.
