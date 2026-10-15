# Issue #716 c11 meaning audit

## Scope and result

- Baseline: `master` at `a0c6788101748665ba4f190e3eb37a673d36dbdb`.
- Reviewed all three c11 meaning shards: 2,725 initial meanings across 2,006 lemmas.
- The initial projection had 1,633 single-meaning lemmas and 373 lemmas with multiple meanings.
- Kept all 2,006 lemmas. Merged 51 same-lemma meaning groups covering 116 canonical senses, reducing the shard from 2,725 to 2,660 meanings. No DROP decisions or c11 adjudications were needed.
- `data/canonical/` was not changed.

## Editorial checks

The first source-bound pass considered every c11 lemma and all of its records and senses. Single-meaning lemmas remain KEEP unless a source gloss is an opaque cross-reference that needs a direct meaning-layer gloss. Multi-meaning decisions and authored glosses are preserved in [`issue-716-c11-edits.json`](issue-716-c11-edits.json).

PR review found that `썰다`'s shortened `써리다02` sense was incorrectly merged with the cutting sense and the `씌다` gloss omitted its umbrella use. The two `썰다` meanings are now separate, and the `씌다` gloss names the umbrella use. A follow-up review confirmed those changes and noted that `m212148` still showed only the cross-reference; its gloss is now directly written as `써레질을 하다.` from the referenced canonical sense `w455663-s1`.

A later source-bound review found that nine tilt-related merge glosses omitted their bound senses' transitive/causative use, and the `쌓다`/`쌓이다` glosses omitted `지식`, `불명예`, and `불신`. The edit spec preserves those same-lemma merge groups and now names the source meanings explicitly.

A subsequent source-bound review found five merges that combined causative and passive event roles: two pairs for `쓸리다`, the writing senses of `쓰이다`, `씹히다`, and `씻기다`. The two `쓸리다` pairs, `씹히다`, and `씻기다` now keep causative and passive senses separate. `쓰이다` is split by event role, retaining merges only within its causative and passive groups.

A follow-up review traced shortened `씌다` senses to their actual referents. `w455026-s1/s2` refer to the causative writing senses `w212752-s1/s2`, while `w455026-s3/s4` refer to passive document-writing and musical-score senses `w454301-s3/s4`; these groups now remain separate with role-matched glosses. `w455027-s1..s4` refer to the four causative `씌우다` senses `w455038-s1..s4`, and their gloss now preserves the caused action in each use, including having someone raise an umbrella or parasol. The other merged shortened forms checked in c11 do not mix event roles: `w210842-s1/s2` both refer to passive covering senses, and `w212706-s1` matches the direct `w454514-s1` meaning.

The final primary-agent self-check rechecked the 51 retained merge groups, all five event-role boundaries, the shortened-form referents above, the single-sense gloss edit, and the previous corrections. Ambiguous distinctions remain separate.

These source-bound editorial checks were performed by the assigned primary agent in this context. They are recorded as agent self-check, not independent review or human editorial approval. PR review is a separate gate; the reported source-bound findings are corrected in this revision.

## Validation

The current edit spec replayed from the recorded baseline with the actual `applyEdits` function matches the stored output by meaning ID: 499,245 meanings and 1 adjudication, with no missing, extra, or changed rows. The five reviewed event-role boundaries are separate while the same-role `쓰이다` groups remain merged. `node --test scripts/meaning/apply-edits.test.mjs` passed 9/9, `node scripts/meaning/validate.mjs` passed for all 499,245 meanings and 1 repository-wide adjudication, and `git diff --check` passed.
