import assert from 'node:assert/strict';
import test from 'node:test';

import { planStage3Admission } from '../scripts/factory/admission.mjs';
import { sha256Json } from '../scripts/validate/semantic-audit.mjs';
import { pageRelationItems } from '../src/domain/relation-paging.js';
import { projectRecord } from '../src/domain/projection.js';

// #400 Top-100 product validation through the production append path: relations are appended by the real
// Stage 3 planner (append_relations), then projected and paged by the real runtime code.

const digest = 'a'.repeat(64);
const GLOSS = '기준이 되는 말.';
const target = (n) => ({
  id: `w${String(n).padStart(5, '0')}`, record_type: 'entry', role: 'start', candidate_id: `w${String(n).padStart(5, '0')}`,
  lemma: `단어${n}`, search_forms: [`단어${n}`], senses: [{ id: `w${String(n).padStart(5, '0')}-s1`, pos: 'noun', gloss: `뜻풀이 ${n}.` }],
});
const tuple = (n, relevance, type = 'scene') => ({
  target: target(n).id, target_sense: `${target(n).id}-s1`, type, note: `연결 ${n}`, relevance,
});
const sourceWith = (relations) => ({
  id: 'w00001', record_type: 'entry', role: 'start', candidate_id: 'w00001', lemma: '기준', search_forms: ['기준'],
  senses: [{ id: 'w00001-s1', pos: 'noun', gloss: GLOSS, ...(relations.length ? { relations } : {}) }],
});
const targets = Array.from({ length: 130 }, (_, i) => target(i + 2));

function appendReviewed(existing, added) {
  const NEW = 'C000001-0001';
  const decision = {
    source_candidate_id: NEW, disposition: 'included', target: { kind: 'new_entry' },
    reviewed_record: { lemma: '새말', senses: [{ pos: 'noun', gloss: '새로 들어온 뜻.' }] },
    relation_amendments: [{
      source_record_id: 'w00001', source_sense_id: 'w00001-s1', source_gloss_sha256: sha256Json(GLOSS),
      relation: { target: NEW, target_sense: `${NEW}-s1`, ...added },
      rationale: 'w00001 w00001-s1: 새 뜻과 이어지는 연상이다.',
    }],
  };
  const records = [sourceWith(existing), ...targets];
  return planStage3Admission({
    batchId: 'C000001', attempt: 1, admissionPr: 1,
    candidateManifest: { batch_id: 'C000001', status: 'complete', candidates_sha256: digest },
    reviewManifest: { batch_id: 'C000001', status: 'ready', attempt: 1, candidates_sha256: digest, semantic_decisions_sha256: digest },
    candidates: [{ candidate_id: NEW }], decisions: [decision], canonicalRecords: records,
    recordPathById: new Map(records.map((record) => [record.id, 'data/canonical/base.jsonl'])), baseCanonicalSnapshotDigest: digest,
  });
}

const ordered = (relations, groupId = 'association') => {
  const record = projectRecord({ ...sourceWith(relations), senses: sourceWith(relations).senses.map((s) => ({ ...s, relations: relations.map((r, position) => ({ position, ...r, target_lemma: r.target })) })) });
  return record.senses[0].relationGroups[groupId].items;
};

const hundred = Array.from({ length: 100 }, (_, i) => tuple(i + 2, 4 + (i % 4)));

test('a relevance-1 relation appended past the 100 boundary enters the window; nothing is deleted', () => {
  const plan = appendReviewed(hundred, { type: 'scene', note: '가장 먼저 떠오르는 장면이다.', relevance: 1 });
  const stored = plan.records.get('w00001').record.senses[0].relations;
  assert.equal(stored.length, 101, 'the 101st canonical relation is stored');
  assert.deepEqual(stored.slice(0, 100), hundred, 'existing relations are neither rewritten nor re-ranked');
  const items = ordered(stored);
  assert.equal(items.length, 101, 'the projection keeps every canonical relation');
  const page = pageRelationItems('association', items, 5);
  assert.equal(page.items.length, 100, 'the UI never exposes more than 100');
  assert.equal(page.hasMore, false);
  assert.equal(page.items[0].relevance, 1, 'the relevance-1 addition moves to the front');
  assert.equal(items.at(-1).relevance, 7, 'the weakest stays stored behind the window');
});

test('a relevance-9 relation past 100 is stored but stays outside the window; below 100 nothing is cut', () => {
  const plan = appendReviewed(hundred, { type: 'scene', note: '아주 느슨한 연상이다.', relevance: 9 });
  const stored = plan.records.get('w00001').record.senses[0].relations;
  const items = ordered(stored);
  assert.equal(items.length, 101);
  assert.equal(items.at(-1).relevance, 9);
  assert.equal(pageRelationItems('association', items, 5).items.some((item) => item.relevance === 9), false);
  const small = appendReviewed(hundred.slice(0, 98), { type: 'scene', note: '느슨한 연상이다.', relevance: 9 });
  const count = small.records.get('w00001').record.senses[0].relations.length;
  assert.equal(count, 99);
  assert.equal(pageRelationItems('association', ordered(small.records.get('w00001').record.senses[0].relations), 5).items.length, 99);
});

test('equal-relevance ordering is deterministic and independent of any hidden state', () => {
  const equal = Array.from({ length: 30 }, (_, i) => tuple(i + 2, 3, i % 2 ? 'scene' : 'action'));
  const first = ordered(equal).map((item) => item.targetId);
  const again = ordered(structuredClone(equal)).map((item) => item.targetId);
  assert.deepEqual(first, again);
  assert.deepEqual(first, equal.map((relation) => relation.target), 'ties keep canonical source order');
  const appended = appendReviewed(equal, { type: 'sensory', note: '같은 순위의 연상이다.', relevance: 3 });
  const after = ordered(appended.records.get('w00001').record.senses[0].relations).map((item) => item.targetId);
  assert.deepEqual(after.slice(0, 30), first, 'a later equal-relevance append sorts after earlier ties');
});

test('the UI exposes 20 at a time up to 100 for 말의 결 and 연상 only', () => {
  const texture = Array.from({ length: 110 }, (_, i) => tuple(i + 2, (i % 9) + 1, i % 2 ? 'near' : 'mood'));
  const items = ordered(texture, 'texture');
  assert.equal(items.length, 110);
  let shown = 0;
  for (let pages = 1; pages <= 6; pages += 1) shown = pageRelationItems('texture', items, pages).items.length;
  assert.equal(shown, 100);
  assert.equal(pageRelationItems('texture', items, 1).items.length, 20);
  assert.equal(pageRelationItems('texture', items, 1).hasMore, true);
  assert.equal(pageRelationItems('synonyms', items, 1).items.length, 110, 'precision groups are not paged');
});
