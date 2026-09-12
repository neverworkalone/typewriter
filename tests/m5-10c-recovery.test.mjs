import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { produce } from '../scripts/batch/produce-m5-10c-work.mjs';
import {
  evaluateM5CRecoveryGate,
  M5CRecoveryValidationError,
  validateM5CTiming,
  validateM5CProposal,
} from '../scripts/batch/validate-m5-10c-recovery.mjs';

function makeProposal() {
  return {
    schema_version: '1',
    artifact_id: 'm5-10c-calibration-proposal',
    process_revision: 'm5-10c-editor-time-recovery-v1',
    case_count: 20,
    cases: Array.from({ length: 20 }, (_, index) => {
      const number = String(index + 1).padStart(3, '0');
      return {
        case_id: `m5-10c-cal-${number}`,
        record: {
          id: `cal-m5-10c-${number}`,
          record_type: 'entry',
          lemma: `fixture-${number}`,
          search_forms: [`fixture-${number}`],
          senses: [{
            id: `cal-m5-10c-${number}-s1`,
            pos: 'noun',
            gloss: `fixture gloss ${number}`,
          }],
        },
        relation_candidate: null,
      };
    }),
  };
}

function passGateTiming(totalEditorSeconds = 240) {
  return {
    status: 'complete',
    unmeasured_pass_count: 0,
    total_editor_seconds: totalEditorSeconds,
  };
}

function passGateInputs(timing = passGateTiming()) {
  return {
    correctionRate: 0.25,
    relationNoiseRate: 0.125,
    timing,
    audit: { status: 'complete', independent: true, open_blocker_count: 0 },
    editorial: { status: 'complete' },
    canonicalMutation: false,
    inventoryMutation: false,
    verification: {
      canonical_integrity: true,
      deterministic_sqlite: true,
      search_product_regression: true,
    },
    failedStage: { gate_status: 'fail', decision: 'HOLD PROCESS', next_stage_authorized: false },
  };
}

test('M5-10C producer refuses editorial verdict fields', () => {
  assert.throws(
    () => produce({
      unitId: 'm5-10c-cal-001',
      unitKind: 'calibration-start',
      input: {
        phase: 'proposal',
        case_id: 'm5-10c-cal-001',
        record_id: 'cal-m5-10c-001',
        source_record_sha256: 'a'.repeat(64),
        source_sense_ids: ['cal-m5-10c-001-s1'],
        source_pos: ['noun'],
        relation_candidate: null,
        decision: 'included',
      },
    }),
    /forbidden editorial verdict key decision/,
  );
});

test('M5-10C proposal validator rejects verdict contamination', () => {
  const proposal = makeProposal();
  proposal.cases[0].decision = 'included';
  assert.throws(
    () => validateM5CProposal(proposal),
    (error) => error instanceof M5CRecoveryValidationError && error.code === 'PROPOSAL_SCHEMA_ERROR',
  );
});

test('M5-10C recovery gate holds when editor time exceeds the fixed limit', () => {
  const result = evaluateM5CRecoveryGate(passGateInputs(passGateTiming(240.001)));
  assert.equal(result.gate_status, 'fail');
  assert.equal(result.decision, 'HOLD PROCESS');
  assert.deepEqual(result.failures, ['editor_seconds_per_processed_start']);
});

test('M5-10C recovery gate passes exactly at the fixed editor-time limit', () => {
  const result = evaluateM5CRecoveryGate(passGateInputs());
  assert.equal(result.gate_status, 'pass');
  assert.equal(result.decision, 'APPROVE BOUNDED');
  assert.deepEqual(result.failures, []);
});

test('M5-10C timing rejects producer execution copied into editor time', async () => {
  const timing = JSON.parse(await readFile('data/batches/m5-10c-editorial-timing-20260910.json', 'utf8'));
  timing.passes[0].editor_seconds = timing.passes[0].producer_seconds;
  timing.passes[0].wall_clock_seconds = timing.passes[0].producer_seconds;
  assert.throws(
    () => validateM5CTiming(timing, { timingKind: 'editorial' }),
    (error) => error instanceof M5CRecoveryValidationError && error.code === 'TIMING_PRODUCER_SUBSTITUTION',
  );
});

test('M5-10C timing rejects an unmeasured completed-session claim', async () => {
  const timing = JSON.parse(await readFile('data/batches/m5-10c-editorial-timing-20260910.json', 'utf8'));
  timing.status = 'in-progress';
  assert.throws(
    () => validateM5CTiming(timing, { timingKind: 'editorial' }),
    (error) => error instanceof M5CRecoveryValidationError && error.code === 'TIMING_INCOMPLETE',
  );
});
