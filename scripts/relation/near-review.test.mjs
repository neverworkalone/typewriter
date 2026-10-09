import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCanonicalContext } from '../validate/canonical-context.mjs';
import { buildRelationIndex } from './candidate-retrieval.mjs';
import { glossDelta, nearReviewEvidence, noteWordsBeyondTarget, renderNearReview, tuplesFromPacket } from './near-review.mjs';

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
  // The authored reasons are on screen, not only the types: the tuple's own note and every sibling's note.
  assert.match(text, /note {3}: n$/mu);
  const resonance = nearReviewEvidence(index, tuples)[0].siblings.find((sibling) => sibling.sense_id === 'w087-s1');
  assert.ok(resonance.note.length > 0);
  assert.ok(text.includes(`note: ${resonance.note}`), 'the sibling note is rendered');
});

test('the gloss delta shows the qualifier one gloss adds, so a wider or narrower target is visible', () => {
  // 단정하다 (차림새·모습) to 말끔하다 (더러움 없이 깨끗하고 단정): the target adds cleanliness the source never names.
  const [wide] = nearReviewEvidence(index, [near('w310-s1', 'w663-s1')]);
  assert.ok(wide.gloss_delta.only_in_target.includes('더러움'), 'the added qualifier is listed');
  assert.ok(wide.gloss_delta.only_in_source.includes('차림새'), 'the qualifier only the source has is listed');
  // Equal glosses show no difference, so a genuinely same-extent pair is not made to look suspicious.
  const [same] = nearReviewEvidence(index, [near('w10010-s1', 'w9799-s1')]);
  assert.deepEqual(same.gloss_delta, { only_in_source: [], only_in_target: [] });
  assert.deepEqual(glossDelta('', undefined), { only_in_source: [], only_in_target: [] });
  assert.match(renderNearReview([wide]), /only in target gloss: .*더러움/u);
});

test('an association against an authored reverse near is presented too, with both notes', () => {
  // 불빛 → 등불: the new association explains the tool-versus-phenomenon difference, while 등불 → 불빛 is an authored near
  // whose own note names the same difference.
  const items = nearReviewEvidence(index, [
    { source_sense_id: 'w180-s1', target_sense: 'w346-s1', type: 'association', note: '새 association note' },
    { source_sense_id: 'w180-s1', target_sense: 'w066-s1', type: 'association', note: '반대 방향이 near가 아닌 association' },
  ]);
  const conflict = items.find((item) => item.target.sense_id === 'w346-s1');
  assert.ok(conflict, 'the association that meets an authored reverse near is listed');
  assert.equal(conflict.kind, 'association-against-reverse-near');
  assert.equal(conflict.reverse.type, 'near');
  assert.ok(conflict.reverse.note.length > 0, 'the reverse note is shown so both stated reasons can be compared');
  assert.equal(conflict.note, '새 association note');
  // An association whose opposite link is not a near is not raised, so ordinary association links stay quiet.
  assert.equal(items.some((item) => item.target.sense_id === 'w066-s1'), false);
  const text = renderNearReview(items);
  assert.match(text, /\[association against an authored reverse near\]/u);
  assert.match(text, /reverse: near — /u);
});

test('a note that gives the target a meaning only the source gloss has is listed, and a faithful note is not', () => {
  // 사그라지다 ("차차 약해져 없어지다") to 사그라들다 ("차츰 가라앉아 약해지다"): the target never says it disappears.
  const sourceGloss = index.bySenseId.get('w10445-s1').gloss;
  const targetGloss = index.bySenseId.get('w10816-s1').gloss;
  assert.match(sourceGloss, /없어지다/u);
  assert.doesNotMatch(targetGloss, /없어/u);
  const wrong = noteWordsBeyondTarget('사그라들다는 기세나 열기가 차츰 가라앉아 없어진다는 뜻이라 사그라지다와 거의 같다.', sourceGloss, targetGloss, '사그라지다', '사그라들다');
  assert.deepEqual(wrong.from_source_gloss, ['없어진다']);
  const faithful = noteWordsBeyondTarget('사그라들다는 기세나 열기, 빛 같은 것이 차츰 가라앉아 약해진다는 뜻이라 사그라지다와 가깝다.', sourceGloss, targetGloss, '사그라지다', '사그라들다');
  assert.deepEqual(faithful, { from_source_gloss: [], in_neither_gloss: [] });
  // The same words reach the reader through the rendered listing and the evidence of a real tuple.
  const [item] = nearReviewEvidence(index, [{ source_sense_id: 'w10445-s1', target_sense: 'w10816-s1', type: 'near', note: '사그라들다는 차츰 가라앉아 없어진다는 뜻이라 거의 같다.' }]);
  assert.deepEqual(item.note_beyond_target.from_source_gloss, ['없어진다']);
  assert.match(renderNearReview([item]), /taken from the source gloss only[^\n]*: 없어진다/u);
});
