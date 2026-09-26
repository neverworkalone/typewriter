import assert from 'node:assert/strict';
import test from 'node:test';

import { createSyntheticBenchmarkRecord } from '../scripts/benchmark/canonical-validation.mjs';

const templates = [
  {
    id: 'w001',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w001',
    lemma: '기대다',
    search_forms: ['기대다', '기대'],
    senses: [{
      id: 'w001-s1',
      pos: 'verb',
      gloss: '원본 문장',
      relations: [{
        target: 'r001',
        target_sense: 'r001-s1',
        type: 'near',
        note: '원본 관계 문장',
      }],
    }],
  },
  {
    id: 'r001',
    record_type: 'entry',
    role: 'reference-only',
    lemma: '기대',
    search_forms: ['기대'],
    senses: [{ id: 'r001-s1', pos: 'noun', gloss: '참조 뜻' }],
  },
];
const templateIndexById = new Map(templates.map(({ id }, index) => [id, index]));

test('synthetic scale records deterministically retain structure and relation shape without copying canonical text', () => {
  const first = createSyntheticBenchmarkRecord(0, templates, templateIndexById, 100);
  const repeated = createSyntheticBenchmarkRecord(0, templates, templateIndexById, 100);

  assert.deepEqual(first, repeated);
  assert.equal(first.id, 'w0000001');
  assert.equal(first.role, 'start');
  assert.equal(first.record_type, 'entry');
  assert.equal(first.candidate_id, first.id);
  assert.equal(first.senses.length, 1);
  assert.equal(first.senses[0].pos, 'verb');
  assert.equal(first.search_forms.length, 2);
  assert.notEqual(first.search_forms[1], first.lemma);
  assert.equal([...first.senses[0].gloss].length, [...templates[0].senses[0].gloss].length);
  assert.notEqual(first.senses[0].gloss, templates[0].senses[0].gloss);
  assert.deepEqual(first.senses[0].relations, [{
    target: 'r0000002',
    target_sense: 'r0000002-s1',
    type: 'near',
    note: '합성 관계 가가',
  }]);
  assert.notEqual(first.senses[0].relations[0].note, templates[0].senses[0].relations[0].note);

  const reference = createSyntheticBenchmarkRecord(1, templates, templateIndexById, 100);
  assert.equal(reference.id, 'r0000002');
  assert.equal(reference.role, 'reference-only');
  assert.equal(Object.hasOwn(reference, 'candidate_id'), false);
});

test('synthetic multi-sense glosses retain whitespace and remain mechanically distinguishable', () => {
  const multiSenseTemplates = [{
    ...templates[0],
    senses: [
      { id: 'w001-s1', pos: 'verb', gloss: '원본 의미 한 가지' },
      { id: 'w001-s2', pos: 'verb', gloss: '또 다른 원본 의미' },
    ],
  }];
  const generated = createSyntheticBenchmarkRecord(
    10,
    multiSenseTemplates,
    new Map([['w001', 0]]),
    100,
  );
  const laterGenerated = createSyntheticBenchmarkRecord(
    11172,
    multiSenseTemplates,
    new Map([['w001', 0]]),
    1000000,
  );

  assert.equal(generated.senses.length, 2);
  assert.notEqual(generated.senses[0].gloss, generated.senses[1].gloss);
  assert.notEqual(generated.senses[0].gloss, laterGenerated.senses[0].gloss);
  for (const [index, sense] of generated.senses.entries()) {
    assert.equal([...sense.gloss].length, [...multiSenseTemplates[0].senses[index].gloss].length);
    assert.equal(sense.gloss.split(/\s+/u).length, multiSenseTemplates[0].senses[index].gloss.split(/\s+/u).length);
    assert.equal(sense.gloss.includes('원본'), false);
  }
});
