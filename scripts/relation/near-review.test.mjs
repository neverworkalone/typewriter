import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCanonicalContext } from '../validate/canonical-context.mjs';
import { buildRelationIndex } from './candidate-retrieval.mjs';
import { nearReviewEvidence, renderNearReview, tuplesFromPacket } from './near-review.mjs';

// The evidence is read from the real canonical, because it only helps if it shows what a reviewer would have needed to see.

const index = buildRelationIndex(await loadCanonicalContext());
const near = (source, target) => ({ source_sense_id: source, target_sense: target, type: 'near', note: '시험용 note' });

test('a near tuple shows the bound target gloss, the opposite link and the other links of the same source', () => {
  // 소리 → 음향: 음향 is "소리의 울림", and 소리 already links the narrower 울림 as an association.
  const [item] = nearReviewEvidence(index, [near('w086-s1', 'w11333-s1')]);
  assert.equal(item.source.lemma, '소리');
  assert.equal(item.target.lemma, '음향');
  assert.match(item.target.gloss, /울림/u);
  const resonance = item.siblings.find((sibling) => sibling.sense_id === 'w087-s1');
  assert.ok(resonance, 'the same-source sibling 울림 is shown');
  assert.equal(resonance.type, 'association');
  assert.ok(resonance.gloss.length > 0 && resonance.note, 'a sibling carries its bound gloss and its authored note');
});

test('the opposite link is shown with its type, so a one-sided near is visible', () => {
  // 음향 ↔ 울림 is a genuine near pair: both directions agree.
  const [positive] = nearReviewEvidence(index, [near('w087-s1', 'w11333-s1')]);
  assert.equal(positive.reverse?.type, 'near');
  // A pair with no authored opposite link says so instead of guessing one.
  const unrelated = index.senses.find((entry) => entry.sense_id !== 'w087-s1' && !entry.relations.some((relation) => relation.target_sense === 'w087-s1'));
  const [absent] = nearReviewEvidence(index, [near('w087-s1', unrelated.sense_id)]);
  assert.equal(absent.reverse, null);
});

test('only near tuples are presented, and other tuples of the input count as siblings before they are applied', () => {
  const evidence = nearReviewEvidence(index, [
    near('w086-s1', 'w11333-s1'),
    { source_sense_id: 'w086-s1', target_sense: 'w087-s1', type: 'association', note: '입력 안의 형제' },
    { source_sense_id: 'w087-s1', target_sense: 'w086-s1', type: 'association', note: '관계 없는 유형' },
  ]);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].siblings.find((sibling) => sibling.sense_id === 'w087-s1').note, '입력 안의 형제');
});

test('a packet is read as tuples and rendered as text without any verdict', () => {
  const tuples = tuplesFromPacket({ relation_amendments: [{ source_sense_id: 'w086-s1', relation: { target_sense: 'w11333-s1', type: 'near', note: 'n' } }] });
  assert.deepEqual(tuples, [{ source_sense_id: 'w086-s1', target_sense: 'w11333-s1', type: 'near', note: 'n' }]);
  const text = renderNearReview(nearReviewEvidence(index, tuples));
  assert.match(text, /w086-s1 → w11333-s1/u);
  assert.match(text, /sibling: association → w087-s1/u);
  assert.doesNotMatch(text, /오류|위반|invalid/u);
});
