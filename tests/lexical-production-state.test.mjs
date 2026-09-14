import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEXICAL_PRODUCTION_STAGE_IDS,
  createLexicalProductionState,
  productionSourceBytes,
  validateLexicalProductionState,
} from '../scripts/batch/lexical-production-state.mjs';

function makeState(batchId = 'future-batch-2040') {
  const stages = Object.fromEntries(LEXICAL_PRODUCTION_STAGE_IDS.map((id) => [
    id,
    {
      source_path: `external:${batchId}:${id}`,
      source_bytes: productionSourceBytes({ batch_id: batchId, stage: id }),
      ...(id === 'selection' ? { policy: 'shared-quality-and-reviewed-selection-v1' } : {}),
      ...(id === 'admission' ? { decision: 'admit', authorization_ref: `${batchId}:authorization` } : {}),
    },
  ]));
  const state = createLexicalProductionState({ batchId, stages });
  const sourceBytesByStage = Object.fromEntries(
    Object.entries(stages).map(([id, stage]) => [id, stage.source_bytes]),
  );
  return { state, sourceBytesByStage };
}

test('shared production state validates all six transitions and source digests', () => {
  const { state, sourceBytesByStage } = makeState();
  const result = validateLexicalProductionState(state, {
    batchId: 'future-batch-2040',
    sourceBytesByStage,
  });

  assert.equal(result.stage_count, 6);
  assert.deepEqual(
    result.stages.map(({ id }) => id),
    LEXICAL_PRODUCTION_STAGE_IDS,
  );
  assert.equal(result.stages.at(-1).decision, 'admit');
});

test('shared production state fails closed when a stage, transition, or authorization is omitted', () => {
  const { state, sourceBytesByStage } = makeState();

  const missingStage = structuredClone(state);
  missingStage.stages.pop();
  assert.throws(
    () => validateLexicalProductionState(missingStage, { sourceBytesByStage }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_SCOPE',
  );

  const wrongTransition = structuredClone(state);
  wrongTransition.stages[2].transition.to = 'batch-selection-complete';
  assert.throws(
    () => validateLexicalProductionState(wrongTransition, { sourceBytesByStage }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_TRANSITION',
  );

  const missingAuthorization = structuredClone(state);
  delete missingAuthorization.stages.at(-1).authorization_ref;
  assert.throws(
    () => validateLexicalProductionState(missingAuthorization, { sourceBytesByStage }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_AUTHORIZATION',
  );
});

test('shared production state rejects stale source bytes and mismatched batch IDs', () => {
  const { state, sourceBytesByStage } = makeState();
  const staleSources = { ...sourceBytesByStage, audit: productionSourceBytes({ stale: true }) };
  assert.throws(
    () => validateLexicalProductionState(state, { sourceBytesByStage: staleSources }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_BINDING',
  );
  assert.throws(
    () => validateLexicalProductionState(state, {
      batchId: 'm5-11-special-case',
      sourceBytesByStage,
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_SCOPE',
  );
});
