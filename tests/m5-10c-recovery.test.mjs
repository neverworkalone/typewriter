import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { produce } from '../scripts/batch/produce-m5-10c-work.mjs';
import { validateM5CAuditDraftFindings } from '../scripts/batch/record-m5-10c-timing.mjs';
import {
  assertM5CRecoveryAuthorizable,
  evaluateM5CRecoveryGate,
  M5CRecoveryValidationError,
  validateM5CAuditIndependence,
  validateM5CEditorialDecisionChronology,
  validateM5CFailedStageContract,
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

test('M5-10C proposal validator rejects a record already present in canonical data', () => {
  const proposal = makeProposal();
  assert.throws(
    () => validateM5CProposal(proposal, { canonicalRecords: [proposal.cases[0].record] }),
    (error) => error instanceof M5CRecoveryValidationError && error.code === 'CALIBRATION_CANONICAL_MUTATION',
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

test('M5-10C audit draft preserves findings and derives open blockers', () => {
  const result = validateM5CAuditDraftFindings([{
    id: 'm5-10c-audit-timing-001',
    severity: 'blocker',
    status: 'open',
    category: 'timing',
    case_id: 'm5-10c-cal-001',
    note: 'm5-10c-cal-001 audit found a timing discrepancy requiring a hold.',
  }]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.open_blocker_count, 1);
});

test('M5-10C audit draft rejects invalid finding target, severity, and status', () => {
  const baseFinding = {
    id: 'm5-10c-audit-timing-001',
    severity: 'blocker',
    status: 'open',
    category: 'timing',
    case_id: 'm5-10c-cal-001',
    note: 'm5-10c-cal-001 audit found a timing discrepancy requiring a hold.',
  };
  for (const [field, value] of [
    ['case_id', 'm5-10c-cal-999'],
    ['severity', 'info'],
    ['status', 'pending'],
  ]) {
    assert.throws(
      () => validateM5CAuditDraftFindings([{ ...baseFinding, [field]: value }]),
      (error) => error.code === 'AUDIT_DRAFT_FINDINGS_INVALID',
    );
  }
});

test('M5-10C recovery gate holds on canonical or inventory mutation', () => {
  const result = evaluateM5CRecoveryGate({
    ...passGateInputs(),
    canonicalMutation: true,
    inventoryMutation: true,
  });
  assert.equal(result.gate_status, 'fail');
  assert.deepEqual(result.failures, ['calibration_canonical_mutation', 'inventory_mutation']);
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

test('M5-10C timing rejects a completed session with a missing required pass', async () => {
  const timing = JSON.parse(await readFile('data/batches/m5-10c-editorial-timing-20260910.json', 'utf8'));
  timing.passes.at(-1).status = 'unmeasured';
  assert.throws(
    () => validateM5CTiming(timing, { timingKind: 'editorial' }),
    (error) => error instanceof M5CRecoveryValidationError && error.code === 'TIMING_INCOMPLETE',
  );
});

test('M5-10C editorial chronology rejects a decision authored before the timed pass', async () => {
  const timing = JSON.parse(await readFile('data/batches/m5-10c-editorial-timing-20260910.json', 'utf8'));
  const sessionStartedAt = Date.parse(timing.started_at);
  const firstPassStartedAt = Date.parse(timing.passes[0].started_at);
  assert.ok(firstPassStartedAt > sessionStartedAt);
  const editorial = {
    draft_created_at: new Date(Math.floor((sessionStartedAt + firstPassStartedAt) / 2)).toISOString(),
    created_at: timing.passes.at(-1).completed_at,
    finalized_at: new Date(Date.parse(timing.passes.at(-1).completed_at) + 1000).toISOString(),
  };
  assert.throws(
    () => validateM5CEditorialDecisionChronology(editorial, { timing }),
    (error) => error instanceof M5CRecoveryValidationError && error.code === 'EDITORIAL_DECISION_CHRONOLOGY',
  );
});

test('M5-10C audit rejects editorial and audit session reuse', () => {
  const sharedSessionId = '11111111-1111-4111-8111-111111111111';
  const auditTimingSessionId = '22222222-2222-4222-8222-222222222222';
  assert.throws(
    () => validateM5CAuditIndependence(
      {
        audit_session_id: sharedSessionId,
        timing_session_id: auditTimingSessionId,
        editorial_session_id: sharedSessionId,
      },
      {
        editorial: {
          editorial_session_id: sharedSessionId,
          timing_session_id: '33333333-3333-4333-8333-333333333333',
        },
      },
      {
        audit_session_id: sharedSessionId,
        session_id: auditTimingSessionId,
      },
    ),
    (error) => error instanceof M5CRecoveryValidationError && error.code === 'AUDIT_INDEPENDENCE',
  );
});

test('M5-10C failed-stage contract preserves the prior unmeasured history', async () => {
  const stage = JSON.parse(await readFile('data/batches/m5-10-wave-b-stage.json', 'utf8'));
  stage.metrics.total_editor_seconds = 1;
  assert.throws(
    () => validateM5CFailedStageContract(stage),
    (error) => error instanceof M5CRecoveryValidationError && error.code === 'FAILED_STAGE_HISTORY_CHANGED',
  );
});

test('M5-10C authorization rejects a fabricated recovery pass', () => {
  const gate = evaluateM5CRecoveryGate(passGateInputs(passGateTiming(240.001)));
  assert.equal(gate.gate_status, 'fail');
  assert.throws(
    () => assertM5CRecoveryAuthorizable({
      gate,
      artifact: { ready_to_create: true },
    }),
    (error) => error instanceof M5CRecoveryValidationError && error.code === 'AUTHORIZATION_SCOPE_MISMATCH',
  );
});
