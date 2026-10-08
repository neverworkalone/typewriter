import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COHORT_RULE, measurePilot, pagedGroupStats, readReviewedBatchSenses, selectCohortSenses, senseRefOfTarget, validatePilotRecord,
} from './pilot.mjs';
import { buildRelationIndex } from './candidate-retrieval.mjs';

const entry = (id, lemma, gloss) => ({ id, record_type: 'entry', role: 'start', candidate_id: id, lemma, search_forms: [lemma], senses: [{ id: `${id}-s1`, pos: 'noun', gloss }] });
const index = buildRelationIndex({ canonicalRevision: 'a'.repeat(64), records: [entry('w1', '메아리', '산에서 되돌아오는 소리.'), entry('w2', '울림', '소리가 퍼지며 남는 떨림.')] });
const cohortRefs = ['C000001-0001-s1', 'C000001-0002-s1'];
const batchSenseIds = new Set(cohortRefs);
const poolBySource = new Map(cohortRefs.map((ref) => [ref, { total: 3, shortlist: new Set(['w1-s1', 'w2-s1', 'C000001-0002-s1', 'C000001-0001-s1']) }]));
const sense = (ref, relations, over = {}) => ({
  sense_ref: ref, target_kind: 'new_entry', candidate_count: 3, inspected_count: 3,
  decision: relations.length ? 'relations-reviewed' : 'no-relations', relations,
  rationale: `${ref}: 검토 결과이다.`, ...over,
});
const rel = (over = {}) => ({ target_kind: 'canonical', target_sense: 'w1-s1', type: 'near', relevance: 3, note: '가깝다.', ...over });
const pilot = (senses, amendments = []) => ({ contract: 'relation-enrichment-pilot-v1', senses, amendments });
const check = (record) => validatePilotRecord(record, { index, cohortRefs, batchSenseIds, poolBySource });

test('cohort selection depends only on the sense id hash, never on outcomes or order', () => {
  const senses = Array.from({ length: 30 }, (_, i) => ({ sense_id: `C000001-${String(i + 1).padStart(4, '0')}-s1` }));
  const a = selectCohortSenses(senses).map((s) => s.sense_id);
  const b = selectCohortSenses([...senses].reverse()).map((s) => s.sense_id);
  assert.deepEqual(a, b);
  assert.equal(a.length, COHORT_RULE.per_batch);
});

test('a valid pilot record passes; zero-relation senses are valid', () => {
  const ok = pilot([sense(cohortRefs[0], [rel()]), sense(cohortRefs[1], [])]);
  assert.deepEqual(check(ok), []);
});

test('the shared tuple contract is enforced: relevance, precision types, targets, self and duplicates', () => {
  const bad = (relations, extra) => check(pilot([sense(cohortRefs[0], relations, extra), sense(cohortRefs[1], [])])).join('\n');
  assert.match(bad([rel({ relevance: undefined })]), /relevance 1-9/u);
  assert.match(bad([rel({ relevance: 10 })]), /relevance 1-9/u);
  assert.match(bad([rel({ type: 'direct' })]), /must not carry relevance/u);
  assert.match(bad([rel({ type: 'synonym' })]), /unsupported type/u);
  assert.match(bad([rel({ target_sense: 'w9-s1' })]), /not found/u);
  assert.match(bad([rel({ target_kind: 'same_batch', target_sense: cohortRefs[0] })]), /self reference/u);
  assert.match(bad([rel(), rel()]), /duplicate/u);
  assert.match(bad([rel({ note: '' })]), /note required/u);
  assert.match(bad([rel()], { rationale: '근거 없음' }), /sense-bound rationale/u);
  assert.match(bad([rel()], { candidate_count: 9 }), /candidate_count differs/u);
});

test('a target outside the inspected shortlist, or a partial cohort, is rejected', () => {
  poolBySource.get(cohortRefs[0]).shortlist.delete('w1-s1');
  assert.match(check(pilot([sense(cohortRefs[0], [rel()]), sense(cohortRefs[1], [])])).join('\n'), /not in the inspected shortlist/u);
  poolBySource.get(cohortRefs[0]).shortlist.add('w1-s1');
  assert.match(check(pilot([sense(cohortRefs[0], [])])).join('\n'), /exactly the pre-registered cohort/u);
});

test('a reverse amendment needs an accepted forward relation of the same pair and a current gloss digest', async () => {
  const { sha256Json } = await import('../validate/semantic-audit.mjs');
  const amendment = (over = {}) => ({
    source_sense_id: 'w1-s1', source_gloss_sha256: sha256Json('산에서 되돌아오는 소리.'),
    relation: { target_sense: cohortRefs[0], type: 'near', relevance: 3, note: '가깝다.' }, rationale: 'w1 w1-s1: 되돌아오는 결이 이어진다.', ...over,
  });
  const base = [sense(cohortRefs[0], [rel()]), sense(cohortRefs[1], [])];
  assert.deepEqual(check(pilot(base, [amendment()])), []);
  assert.match(check(pilot(base, [amendment({ source_gloss_sha256: 'f'.repeat(64) })])).join('\n'), /stale source gloss digest/u);
  assert.match(check(pilot([sense(cohortRefs[0], []), sense(cohortRefs[1], [])], [amendment()])).join('\n'), /accepted forward relation/u);
});

test('measurement counts types, relevance, direction and acceptance without a density target', () => {
  const record = pilot([
    sense(cohortRefs[0], [rel(), rel({ target_kind: 'same_batch', target_sense: cohortRefs[1], type: 'direct', relevance: undefined })]),
    sense(cohortRefs[1], []),
  ]);
  const metrics = measurePilot(record, { canonicalRecords: [] });
  assert.equal(metrics.reviewed_senses, 2);
  assert.equal(metrics.accepted_relations, 2);
  assert.equal(metrics.zero_relation_senses, 1);
  assert.deepEqual(metrics.relation_counts_by_type, { direct: 1, near: 1 });
  assert.deepEqual(metrics.relevance_distribution, { 3: 1 });
  assert.equal(metrics.same_batch_relations, 1);
  assert.equal(metrics.acceptance_rate_of_inspected, Number((2 / 6).toFixed(4)));
});

test('paged group statistics report >20 and >100 groups and use the shared UI grouping', () => {
  const relations = (n, type) => Array.from({ length: n }, (_, i) => ({ target: `t${i}`, type }));
  const stats = pagedGroupStats([
    { record: { senses: [{ id: 'a', relations: relations(21, 'near') }, { id: 'b', relations: relations(101, 'scene') }, { id: 'c', relations: relations(5, 'direct') }] } },
  ]);
  assert.deepEqual(stats.texture, { groups: 1, over_20: 1, over_100: 0, max: 21 });
  assert.deepEqual(stats.association, { groups: 1, over_20: 1, over_100: 1, max: 101 });
  assert.equal(senseRefOfTarget({ provisional_id: 'provisional:C000001/C000001-0002/s1' }), 'C000001-0002-s1');
});

test('the Stage 2 relation source reader admits included and corrected decisions only when asked, never held or rejected ones', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = await mkdtemp(join(tmpdir(), 'stage2-sources-'));
  try {
    await mkdir(join(repo, 'data/reviews/C000099'), { recursive: true });
    const row = (id, disposition) => ({
      source_candidate_id: id, disposition, target: { kind: 'new_entry' },
      reviewed_record: { lemma: id, senses: [{ pos: 'noun', gloss: `${id} 뜻.` }] },
    });
    await writeFile(join(repo, 'data/reviews/C000099/decisions.jsonl'),
      ['included', 'corrected', 'deferred', 'rejected'].map((d, i) => JSON.stringify(row(`C000099-000${i + 1}`, d))).join('\n') + '\n');
    assert.equal((await readReviewedBatchSenses('C000099', repo)).length, 1, 'pilot default stays included-only');
    const production = await readReviewedBatchSenses('C000099', repo, new Set(['included', 'corrected']));
    assert.deepEqual(production.map((sense) => sense.candidate_id), ['C000099-0001', 'C000099-0002']);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('the production relation:candidates path takes included and corrected senses, skips held ones, and validates the full source set', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { stage2CandidateArtifact } = await import('./stage2-candidates.mjs');
  const repo = await mkdtemp(join(tmpdir(), 'stage2-cli-'));
  try {
    await mkdir(join(repo, 'data/reviews/C000098'), { recursive: true });
    const row = (n, disposition) => ({
      source_candidate_id: `C000098-000${n}`, disposition, target: { kind: 'new_entry' },
      reviewed_record: { lemma: `새말${n}`, senses: [{ pos: 'noun', gloss: `새말${n}의 뜻풀이.` }] },
    });
    await writeFile(join(repo, 'data/reviews/C000098/decisions.jsonl'),
      ['included', 'corrected', 'deferred', 'rejected'].map((d, i) => JSON.stringify(row(i + 1, d))).join('\n') + '\n');
    const index = buildRelationIndex({ canonicalRevision: 'd'.repeat(64), records: [{
      id: 'w1', record_type: 'entry', role: 'start', candidate_id: 'w1', lemma: '기존', search_forms: ['기존'],
      senses: [{ id: 'w1-s1', pos: 'noun', gloss: '이미 있던 뜻.' }],
    }] });
    const artifact = await stage2CandidateArtifact('C000098', { repo, index });
    assert.deepEqual(artifact.sources.map((source) => source.source.provisional_id).sort(),
      ['provisional:C000098/C000098-0001/s1', 'provisional:C000098/C000098-0002/s1']);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
