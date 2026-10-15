# Issue #716 c11 meaning audit

## Scope and result

- Baseline: `master` at `a0c6788101748665ba4f190e3eb37a673d36dbdb`.
- Reviewed all three c11 meaning shards: 2,725 initial meanings across 2,006 lemmas.
- The initial projection had 1,633 single-meaning lemmas and 373 lemmas with multiple meanings.
- Kept all 2,006 lemmas. Merged 54 same-lemma meaning groups covering 126 canonical senses, reducing the shard from 2,725 to 2,653 meanings. No DROP decisions or c11 adjudications were needed.
- `data/canonical/` was not changed.

## Editorial checks

The first source-bound pass considered every c11 lemma and all of its records and senses. Single-meaning lemmas remain KEEP. For multi-meaning lemmas, the decisions and representative glosses are preserved in [`issue-716-c11-edits.json`](issue-716-c11-edits.json). The follow-up pass checked all 54 merged output rows against their bound source senses; ambiguous distinctions were kept separate.

Both editorial checks were performed by the assigned primary agent in this context. This is recorded as agent self-check, not independent review or human editorial approval. The PR review remains a separate pending gate.

## Validation

`node scripts/meaning/validate.mjs` passed after the edits: 499,238 meanings and 1 repository-wide adjudication are valid. `git diff --check` also passed.
