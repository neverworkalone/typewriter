import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCanonicalIndex } from '../factory/identity-adapter.mjs';
import { loadPosScopedSearchFormSupport } from '../factory/search-form-support.mjs';
import { supportedFormsForCandidate } from './literature-evidence-run.mjs';

// Synthetic canonical records through the real surface-form projection (production path).
const entry = (id, lemma, senses) => ({
  record_type: 'entry', id, lemma,
  senses: senses.map(([senseId, pos]) => ({ id: senseId, pos, gloss: 'x', relations: [] })),
});
const candidate = (input, pos) => ({
  candidate_id: 'C000001-0001', input, pos_hypotheses: [pos], forms: [{ form_id: 'f1', surface: input }],
  usage_groups: [{ group_id: 'g1', pos }], observations: [{ observation_id: 'o1', form_id: 'f1', group_id: 'g1', pos, holds: [] }],
});

async function fixture(entries) {
  return { index: buildCanonicalIndex(entries), support: await loadPosScopedSearchFormSupport(entries) };
}

test('a candidate of another POS gets none of the existing verb entry\'s generated forms', async () => {
  const { index, support } = await fixture([entry('w1', '가다', [['w1-s1', 'verb']])]);
  const verbForms = [...support.get('w1\u0000verb')];
  assert.ok(verbForms.includes('가는') || verbForms.length > 0, 'projection must generate verb forms for the fixture');
  for (const pos of ['noun', 'adverb']) {
    assert.deepEqual(supportedFormsForCandidate(candidate('가다', pos), index, support), [], pos);
  }
});

test('the same lemma and POS keeps the supported forms', async () => {
  const { index, support } = await fixture([entry('w1', '가다', [['w1-s1', 'verb']])]);
  const forms = supportedFormsForCandidate(candidate('가다', 'verb'), index, support);
  assert.deepEqual(forms.sort(), [...support.get('w1\u0000verb')].sort());
  assert.ok(forms.length > 0);
});

test('in a multi-POS record only the forms of the candidate POS are supplied', async () => {
  const { index, support } = await fixture([entry('w2', '가다', [['w2-s1', 'verb'], ['w2-s2', 'adjective']])]);
  const verbOnly = new Set(support.get('w2\u0000verb'));
  const adjective = new Set(support.get('w2\u0000adjective') ?? []);
  const verbCandidate = new Set(supportedFormsForCandidate(candidate('가다', 'verb'), index, support));
  const adjectiveCandidate = new Set(supportedFormsForCandidate(candidate('가다', 'adjective'), index, support));
  assert.deepEqual([...verbCandidate].sort(), [...verbOnly].sort());
  assert.deepEqual([...adjectiveCandidate].sort(), [...adjective].sort());
  // Forms generated only for one POS never leak into the other candidate.
  for (const form of verbOnly) if (!adjective.has(form)) assert.equal(adjectiveCandidate.has(form), false, form);
  for (const form of adjective) if (!verbOnly.has(form)) assert.equal(verbCandidate.has(form), false, form);
  assert.deepEqual(supportedFormsForCandidate(candidate('가다', 'noun'), index, support), []);
});

test('no canonical entry and v1 rows supply nothing', async () => {
  const { index, support } = await fixture([entry('w1', '먹다', [['w1-s1', 'verb']])]);
  assert.deepEqual(supportedFormsForCandidate(candidate('걷다', 'verb'), index, support), []);
  assert.deepEqual(supportedFormsForCandidate({ candidate_id: 'C000001-0002', input: '먹다', pos: 'verb', observedForms: ['먹는'] }, index, support), []);
});
