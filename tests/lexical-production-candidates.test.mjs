import assert from 'node:assert/strict';
import test from 'node:test';

import {
  materializeLexicalUnitCandidates,
} from '../scripts/batch/lexical-production.mjs';
import {
  productionBytesSha256,
  productionValueSha256,
} from '../scripts/batch/lexical-production-state.mjs';

function sourceWithUnits(units, contractVersion = 'lexical-candidate-source-v1') {
  const source = {
    schema_version: '1',
    contract_version: contractVersion,
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

test('v2 recovery sources require explicit inventory and canonical identities', () => {
  const explicitUnit = {
    ...unit('unit-1', '기쁨'),
    inventory_id: 'm5-4101',
    candidate_record_id: 'w4181',
  };
  const { source, sourceBytes } = sourceWithUnits([explicitUnit], 'lexical-candidate-source-v2');
  const result = materializeLexicalUnitCandidates({
    batchId: 'test-recovery-batch',
    source,
    sourceBytes,
    firstInventoryNumber: 1,
    firstCanonicalNumber: 1,
  });
  assert.deepEqual(result.identities.map(({ inventory_id, candidate_record_id }) => [
    inventory_id,
    candidate_record_id,
  ]), [['m5-4101', 'w4181']]);

  const missingIdentity = sourceWithUnits([unit('unit-1', '기쁨')], 'lexical-candidate-source-v2');
  assert.throws(() => materializeLexicalUnitCandidates({
    batchId: 'test-recovery-batch',
    source: missingIdentity.source,
    sourceBytes: missingIdentity.sourceBytes,
    firstInventoryNumber: 1,
    firstCanonicalNumber: 1,
  }), /must bind explicit recovery identities/u);
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

test('shared lexical producer rejects canonical collisions and only reopens rejected seed rows by default', () => {
  const { source, sourceBytes } = sourceWithUnits([unit('unit-1', '기쁨')]);

  assert.throws(() => materializeLexicalUnitCandidates({
    batchId: 'test-batch',
    source,
    sourceBytes,
    firstInventoryNumber: 3101,
    firstCanonicalNumber: 3181,
    baseRecords: [{ record: { id: 'w0001', lemma: 'joy', search_forms: ['기쁨'] } }],
  }), /collides with canonical:w0001/u);

  for (const status of ['candidate', 'held', 'deferred', 'inflected-form', undefined]) {
    assert.throws(() => materializeLexicalUnitCandidates({
      batchId: 'test-batch',
      source,
      sourceBytes,
      firstInventoryNumber: 3101,
      firstCanonicalNumber: 3181,
      baseSeedTargets: [{ inventory_id: 'm5-0001', status, lemma: '기쁨', search_forms: [] }],
    }), /collides with seed:m5-0001/u, `status=${String(status)} retains seed collision ownership`);
  }

  assert.doesNotThrow(() => materializeLexicalUnitCandidates({
    batchId: 'test-batch',
    source,
    sourceBytes,
    firstInventoryNumber: 3101,
    firstCanonicalNumber: 3181,
    baseSeedTargets: [{ inventory_id: 'm5-0001', status: 'rejected', lemma: '기쁨', search_forms: [] }],
  }), 'a rejected historical target is not an active search owner during a source-bound recovery');
});

test('shared lexical producer can reopen an exactly matched deferred seed identity', () => {
  const { source, sourceBytes } = sourceWithUnits([unit('unit-1', '기쁨')]);
  const deferredTarget = {
    inventory_id: 'm5-3101',
    status: 'deferred',
    record_type: 'entry',
    lemma: '기쁨',
    search_forms: ['기쁨'],
    pos: ['noun'],
  };
  const common = {
    batchId: 'test-batch',
    source,
    sourceBytes,
    firstInventoryNumber: 3101,
    firstCanonicalNumber: 3181,
    baseSeedTargets: [deferredTarget],
    reopenedSeedTargetIds: [deferredTarget.inventory_id],
  };

  const result = materializeLexicalUnitCandidates(common);
  assert.equal(result.identities[0].inventory_id, deferredTarget.inventory_id);
  assert.equal(result.identities[0].lemma, deferredTarget.lemma);

  for (const change of [
    { status: 'held' },
    { lemma: '희망' },
    { record_type: 'expression' },
    { pos: ['verb'] },
    { search_forms: ['기쁜'] },
  ]) {
    assert.throws(() => materializeLexicalUnitCandidates({
      ...common,
      baseSeedTargets: [{ ...deferredTarget, ...change }],
    }), /deferred seed target|one deferred seed target/u);
  }

  assert.throws(() => materializeLexicalUnitCandidates({
    ...common,
    firstInventoryNumber: 3102,
  }), /not covered by candidate identities/u);
});
