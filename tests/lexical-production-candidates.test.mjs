import assert from 'node:assert/strict';
import test from 'node:test';

import {
  materializeLexicalUnitCandidates,
} from '../scripts/batch/lexical-production.mjs';
import {
  productionBytesSha256,
  productionValueSha256,
} from '../scripts/batch/lexical-production-state.mjs';

function sourceWithUnits(units) {
  const source = {
    schema_version: '1',
    contract_version: 'lexical-candidate-source-v1',
    kind: 'typewriter-authored-lexical-unit-source',
    source_id: 'test-authored-lexical-unit-source',
    authoring_mode: 'agent-authored-per-unit-semantic-source',
    base_canonical_records_sha256: 'a'.repeat(64),
    base_seed_sha256: 'b'.repeat(64),
    pool_sha256: productionValueSha256(units),
    candidate_count: units.length,
    units,
  };
  source.artifact_sha256 = productionValueSha256(source);
  const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`, 'utf8');
  return { source, sourceBytes };
}

const unit = (sourceUnitId, lemma) => ({
  source_unit_id: sourceUnitId,
  lemma,
  axis: 'E',
  flags: ['mood-range'],
  record_type: 'entry',
  pos: 'noun',
  source_kind: 'typewriter-authored-lexical-unit',
  writer_use: '마음의 결을 구체적으로 드러내는 출발어.',
  writer_gloss: '바라는 일이 이루어져 마음이 기쁜 상태.',
});

test('shared lexical producer materializes explicit units with immutable source binding', () => {
  const { source, sourceBytes } = sourceWithUnits([
    unit('unit-1', '기쁨'),
    unit('unit-2', '슬픔'),
  ]);

  const result = materializeLexicalUnitCandidates({
    batchId: 'test-batch',
    source,
    sourceBytes,
    firstInventoryNumber: 3101,
    firstCanonicalNumber: 3181,
  });

  assert.deepEqual(result.identities.map(({ inventory_id, candidate_record_id }) => [
    inventory_id,
    candidate_record_id,
  ]), [
    ['m5-3101', 'w3181'],
    ['m5-3102', 'w3182'],
  ]);
  assert.equal(result.candidateRecords[0].senses[0].gloss, source.units[0].writer_gloss);
  assert.equal(result.identities[0].source_basis.source_artifact_sha256, source.artifact_sha256);
  assert.equal(result.sourceSha256, productionBytesSha256(sourceBytes));
});

test('shared lexical producer rejects duplicate candidate lemmas', () => {
  const { source, sourceBytes } = sourceWithUnits([
    unit('unit-1', '기쁨'),
    unit('unit-2', '기쁨'),
  ]);

  assert.throws(() => materializeLexicalUnitCandidates({
    batchId: 'test-batch',
    source,
    sourceBytes,
    firstInventoryNumber: 3101,
    firstCanonicalNumber: 3181,
  }), /duplicates a source unit identity or lemma/u);
});

test('shared lexical producer rejects canonical and seed term collisions', () => {
  const { source, sourceBytes } = sourceWithUnits([unit('unit-1', '기쁨')]);

  assert.throws(() => materializeLexicalUnitCandidates({
    batchId: 'test-batch',
    source,
    sourceBytes,
    firstInventoryNumber: 3101,
    firstCanonicalNumber: 3181,
    baseRecords: [{ record: { id: 'w0001', lemma: 'joy', search_forms: ['기쁨'] } }],
  }), /collides with canonical:w0001/u);

  assert.throws(() => materializeLexicalUnitCandidates({
    batchId: 'test-batch',
    source,
    sourceBytes,
    firstInventoryNumber: 3101,
    firstCanonicalNumber: 3181,
    baseSeedTargets: [{ inventory_id: 'm5-0001', lemma: '기쁨', search_forms: [] }],
  }), /collides with seed:m5-0001/u);
});
