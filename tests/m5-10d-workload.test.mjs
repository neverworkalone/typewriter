import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { produce } from '../scripts/batch/produce-m5-10d-work.mjs';
import {
  M5DRecorderError,
  runM5DRecorder,
  validateM5DDecisionInputChronology,
} from '../scripts/batch/record-m5-10d-timing.mjs';
import { createM5DContractProposal } from '../scripts/batch/run-m5-10d-recovery-contract.mjs';
import {
  M5_10D_BATCH_ID,
  M5_10D_PROCESS_REVISION,
  M5DRecoveryValidationError,
  validateM5DTiming,
  evaluateM5DRecoveryGate,
  validateM5DProposal,
  validateM5DDecisionRowChronology,
  validateM5DFollowUpSource,
  validateM5DWorkload,
  workloadUnitSetSha256,
} from '../scripts/batch/validate-m5-10d-recovery.mjs';

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeProposal() {
  return {
    schema_version: '1',
    artifact_id: 'm5-10d-calibration-proposal',
    process_revision: M5_10D_PROCESS_REVISION,
    case_count: 20,
    cases: Array.from({ length: 20 }, (_, index) => {
      const number = String(index + 1).padStart(3, '0');
      return {
        case_id: `m5-10d-cal-${number}`,
        record: {
          id: `cal-m5-10d-${number}`,
          record_type: 'entry',
          lemma: `fixture-workload-${number}`,
          search_forms: [`fixture-workload-${number}`],
          senses: [{
            id: `cal-m5-10d-${number}-s1`,
            pos: 'noun',
            gloss: `fixture workload meaning ${number}`,
          }],
        },
        relation_candidate: null,
      };
    }),
  };
}

function makeWorkload(proposalSha256 = 'a'.repeat(64), proposalArtifact = 'contract:m5-10d-calibration-proposal') {
  const all = Array.from({ length: 20 }, (_, index) => `m5-10d-cal-${String(index + 1).padStart(3, '0')}`);
  const passRows = [
    ['target-preparation', 'target-preparation', 'calibration-start', 'pre-review-sample', all],
    ['initial-review', 'semantic-review', 'calibration-start', 'pre-review-sample', all],
    ['feedback-fixes', 'feedback-fix', 'feedback-fix', 'source-derived-initial-findings', []],
    ['final-verification', 'final-verification', 'final-verification', 'source-derived-correction-findings', []],
    ['held-rejected', 'held-rejected', 'held-rejected', 'source-derived-initial-findings', []],
    ['post-freeze-audit', 'post-freeze-audit', 'audit-review', 'frozen-editorial-sample', all],
  ];
  const declaredAt = new Date(Date.now() - 10_000).toISOString();
  return {
    schema_version: '1',
    artifact_id: 'm5-10d-workload-20260912',
    issue: 115,
    parent_issue: 7,
    batch_id: M5_10D_BATCH_ID,
    process_revision: M5_10D_PROCESS_REVISION,
    declaration_kind: 'source-declared-before-each-pass',
    declaration_status: 'frozen',
    frozen_at: declaredAt,
    source: {
      proposal_artifact: proposalArtifact,
      proposal_sha256: proposalSha256,
      decision_independent: true,
    },
    case_count: 20,
    processed_start_count: 20,
    passes: passRows.map(([id, role, unit_kind, declaration_source, expected_unit_ids]) => ({
      id,
      role,
      unit_kind,
      declaration_source,
      declared_at: declaredAt,
      expected_unit_ids,
      expected_unit_count: expected_unit_ids.length,
      expected_unit_set_sha256: workloadUnitSetSha256(expected_unit_ids),
      empty_work: expected_unit_ids.length === 0,
      note: `${id} fixture workload was declared before the pass.`,
    })),
    note: 'Self-authored workload fixture.',
  };
}

function makeEditorial(decisions) {
  return { editorial: { records: decisions.map((decision, index) => ({ case_id: `m5-10d-cal-${String(index + 1).padStart(3, '0')}`, decision })) } };
}

function makeRecorderDecisionRow(proposal, unitId, kind) {
  const caseItem = proposal.cases.find(({ case_id: caseId }) => caseId === unitId);
  const sourceRecordSha256 = sha256Bytes(Buffer.from(JSON.stringify(caseItem.record), 'utf8'));
  if (kind === 'target-preparation') {
    return {
      case_id: unitId,
      record_id: caseItem.record.id,
      source_record_sha256: sourceRecordSha256,
      preparation_status: 'source-bound',
      note: `${unitId} source was prepared after the judgment timer started.`,
    };
  }
  return {
    case_id: unitId,
    record_id: caseItem.record.id,
    source_record_sha256: sourceRecordSha256,
    decision: 'included',
    lemma_pos: {},
    sense_review: {},
    boundary_reviews: {},
    relation_review: {
      outcome: 'no-valid-candidate',
      decision: 'not-applicable',
      noise_assessment: 'not-applicable',
      correction: 'none',
      note: `${unitId} relation-review has no candidate in the fixture proposal.`,
    },
    decision_note: `${unitId} decision was authored after the judgment timer started.`,
  };
}

test('M5-10D producer remains proposal-only and rejects verdict injection', () => {
  assert.throws(
    () => produce({
      unitId: 'm5-10d-cal-001',
      unitKind: 'calibration-start',
      input: {
        phase: 'proposal',
        case_id: 'm5-10d-cal-001',
        record_id: 'cal-m5-10d-001',
        source_record_sha256: 'a'.repeat(64),
        source_sense_ids: ['cal-m5-10d-001-s1'],
        source_pos: ['noun'],
        relation_candidate: null,
        decision: 'included',
      },
    }),
    /forbidden editorial verdict key decision/,
  );
});

test('M5-10D workload validates scoped queues and explicit zero-work passes', () => {
  const proposal = makeProposal();
  const proposalInfo = validateM5DProposal(proposal);
  const workloadInfo = validateM5DWorkload(makeWorkload(), { proposalCaseIds: proposalInfo.case_ids });
  assert.equal(workloadInfo.by_pass.get('feedback-fixes').expected_unit_ids.length, 0);
  assert.equal(workloadInfo.by_pass.get('feedback-fixes').empty_work, true);
  assert.deepEqual(workloadInfo.by_pass.get('final-verification').expected_unit_ids, []);
});

test('M5-10D committed calibration sample is separate from the contract fixture', async () => {
  const committedBytes = await readFile(new URL('../data/batches/m5-10d-calibration-proposal-20260912.json', import.meta.url));
  const committed = JSON.parse(committedBytes.toString('utf8'));
  const contract = createM5DContractProposal();
  assert.notEqual(sha256Bytes(committedBytes), sha256Bytes(Buffer.from(JSON.stringify(contract), 'utf8')));
  assert.ok(committed.cases.every(({ record }) => !record.lemma.startsWith('contract-workload-')));
  const info = validateM5DProposal(committed);
  assert.equal(info.case_ids.length, 20);
});

test('M5-10D recorder measures an empty declared pass as zero editor work', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-10d-zero-work-'));
  try {
    const proposal = makeProposal();
    const proposalBytes = Buffer.from(`${JSON.stringify(proposal)}\n`, 'utf8');
    const proposalPath = path.join(directory, 'proposal.json');
    await writeFile(proposalPath, proposalBytes);
    const proposalSha256 = sha256Bytes(proposalBytes);
    const workload = makeWorkload(proposalSha256);
    const workloadBytes = Buffer.from(`${JSON.stringify(workload)}\n`, 'utf8');
    const workloadPath = path.join(directory, 'workload.json');
    await writeFile(workloadPath, workloadBytes);
    const timingPath = path.join(directory, 'editorial-timing.json');
    const args = { proposal: proposalPath, workload: workloadPath, output: timingPath, kind: 'editorial' };

    for (const pass of ['target-preparation', 'initial-review', 'feedback-fixes', 'final-verification', 'held-rejected']) {
      await runM5DRecorder({ ...args, action: 'start-pass', pass });
      if (workload.passes.find(({ id }) => id === pass).expected_unit_ids.length > 0) {
        if (pass === 'target-preparation') {
          await assert.rejects(
            () => runM5DRecorder({
              ...args,
              action: 'record-work',
              pass,
              unit: 'm5-10d-cal-999',
              'input-json': JSON.stringify({ phase: 'proposal', case_id: 'm5-10d-cal-999' }),
            }),
            (error) => error instanceof M5DRecorderError && error.code === 'TIMING_SCOPE_MISMATCH',
          );
          await assert.rejects(
            () => runM5DRecorder({ ...args, action: 'stop-pass', pass }),
            (error) => error instanceof M5DRecorderError && error.code === 'TIMING_SCOPE_MISMATCH',
          );
        }
        await runM5DRecorder({ ...args, action: 'record-proposal', pass });
        if (pass === 'target-preparation') {
          await assert.rejects(
            () => runM5DRecorder({
              ...args,
              action: 'record-work',
              pass,
              unit: 'm5-10d-cal-001',
              'input-json': JSON.stringify({ phase: 'proposal', case_id: 'm5-10d-cal-001' }),
            }),
            (error) => error instanceof M5DRecorderError && error.code === 'TIMING_SCOPE_MISMATCH',
          );
        }
      }
      if (pass === 'initial-review') {
        await assert.rejects(
          () => runM5DRecorder({
            ...args,
            action: 'start-judgment',
            pass,
            unit: 'm5-10d-cal-001',
            'decision-artifact': 'full-draft.json',
          }),
          (error) => error instanceof M5DRecorderError && error.code === 'TIMING_DECISION_INPUT_FORBIDDEN',
        );
        await assert.rejects(
          () => runM5DRecorder({
            ...args,
            action: 'start-judgment',
            pass,
            unit: 'm5-10d-cal-001',
            'decision-json': JSON.stringify({ case_id: 'm5-10d-cal-001' }),
          }),
          (error) => error instanceof M5DRecorderError && error.code === 'TIMING_DECISION_INPUT_FORBIDDEN',
        );
      }
      if (pass === 'target-preparation') {
        await assert.rejects(
          () => runM5DRecorder({ ...args, action: 'stop-pass', pass }),
          (error) => error instanceof M5DRecorderError && error.code === 'TIMING_EDITOR_WORK_MISSING',
        );
      }
      for (const unitId of workload.passes.find(({ id }) => id === pass).expected_unit_ids) {
        await runM5DRecorder({
          ...args,
          action: 'start-judgment',
          pass,
          unit: unitId,
        });
        await runM5DRecorder({
          ...args,
          action: 'complete-judgment',
          pass,
          unit: unitId,
          'decision-json': JSON.stringify(makeRecorderDecisionRow(proposal, unitId, pass)),
        });
      }
      await runM5DRecorder({ ...args, action: 'stop-pass', pass });
    }
    await runM5DRecorder({ ...args, action: 'finish' });

    const proposalInfo = validateM5DProposal(proposal);
    const workloadInfo = validateM5DWorkload(workload, {
      proposalCaseIds: proposalInfo.case_ids,
      proposalSha256,
    });
    workloadInfo.sha256 = sha256Bytes(workloadBytes);
    const timing = JSON.parse((await readFile(timingPath)).toString('utf8'));
    const summary = validateM5DTiming(timing, {
      timingKind: 'editorial',
      workloadInfo,
      expectedProposalSha256: proposalSha256,
      expectedProposalCases: proposalInfo.compact_cases,
    });

    for (const passId of ['feedback-fixes', 'final-verification', 'held-rejected']) {
      assert.equal(summary.passes[passId].work_status, 'zero-work');
      assert.equal(summary.passes[passId].editor_seconds, 0);
      assert.ok(summary.passes[passId].wall_clock_seconds >= 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('M5-10D timing rejects a decision row authored before judgment start', () => {
  assert.throws(
    () => validateM5DDecisionRowChronology({
      started_at: '2026-09-12T00:00:01.000Z',
      completed_at: '2026-09-12T00:00:01.100Z',
      decision_row_authored_at: '2026-09-12T00:00:00.900Z',
    }, 'initial-review:m5-10d-cal-001'),
    (error) => error instanceof M5DRecoveryValidationError && error.code === 'TIMING_EDITOR_WORK_MISSING',
  );
});

test('M5-10D recorder rejects a pre-existing decision input file', () => {
  assert.throws(
    () => validateM5DDecisionInputChronology({
      startedAt: '2026-09-12T00:00:01.000Z',
      authoredAt: '2026-09-12T00:00:00.900Z',
      inputMtimeMs: Date.parse('2026-09-12T00:00:00.950Z'),
      label: 'initial-review:m5-10d-cal-001 decision input',
    }),
    (error) => error instanceof M5DRecorderError && error.code === 'TIMING_DECISION_INPUT_FORBIDDEN',
  );
});

test('M5-10D production recorder rejects same-process judgment completion', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-10d-invocation-boundary-'));
  try {
    const proposal = makeProposal();
    const proposalPath = path.join(directory, 'proposal.json');
    const proposalBytes = Buffer.from(`${JSON.stringify(proposal)}\n`, 'utf8');
    await writeFile(proposalPath, proposalBytes);
    const workload = makeWorkload(sha256Bytes(proposalBytes), 'data/batches/m5-10d-calibration-proposal-20260912.json');
    const workloadPath = path.join(directory, 'workload.json');
    await writeFile(workloadPath, `${JSON.stringify(workload)}\n`, 'utf8');
    const args = {
      proposal: proposalPath,
      workload: workloadPath,
      output: path.join(directory, 'timing.json'),
    };
    await runM5DRecorder({ ...args, action: 'start-pass', kind: 'editorial', pass: 'target-preparation' });
    await runM5DRecorder({ ...args, action: 'record-proposal', kind: 'editorial', pass: 'target-preparation' });
    await runM5DRecorder({ ...args, action: 'start-judgment', kind: 'editorial', pass: 'target-preparation', unit: 'm5-10d-cal-001' });
    await assert.rejects(
      () => runM5DRecorder({
        ...args,
        action: 'complete-judgment',
        kind: 'editorial',
        pass: 'target-preparation',
        unit: 'm5-10d-cal-001',
        'decision-json': JSON.stringify(makeRecorderDecisionRow(proposal, 'm5-10d-cal-001', 'target-preparation')),
      }),
      (error) => error instanceof M5DRecorderError && error.code === 'TIMING_JUDGMENT_INVOCATION_REUSED',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('M5-10D workload rejects follow-up work without a recorder-owned source', () => {
  const proposalInfo = validateM5DProposal(makeProposal());
  const workload = makeWorkload();
  workload.passes[2].expected_unit_ids = [...proposalInfo.case_ids];
  workload.passes[2].expected_unit_count = proposalInfo.case_ids.length;
  workload.passes[2].expected_unit_set_sha256 = workloadUnitSetSha256(workload.passes[2].expected_unit_ids);
  workload.passes[2].empty_work = false;
  workload.passes[3].expected_unit_ids = [...proposalInfo.case_ids];
  workload.passes[3].expected_unit_count = proposalInfo.case_ids.length;
  workload.passes[3].expected_unit_set_sha256 = workloadUnitSetSha256(workload.passes[3].expected_unit_ids);
  workload.passes[3].empty_work = false;
  assert.throws(
    () => validateM5DWorkload(workload, { proposalCaseIds: proposalInfo.case_ids }),
    (error) => error instanceof M5DRecoveryValidationError && error.code === 'WORKLOAD_SOURCE_REQUIRED',
  );
});

test('M5-10D workload requires causal source before decision alignment', () => {
  const proposalInfo = validateM5DProposal(makeProposal());
  const workload = makeWorkload();
  for (const passIndex of [2, 3]) {
    workload.passes[passIndex].expected_unit_ids = ['m5-10d-cal-001'];
    workload.passes[passIndex].expected_unit_count = 1;
    workload.passes[passIndex].expected_unit_set_sha256 = workloadUnitSetSha256(['m5-10d-cal-001']);
    workload.passes[passIndex].empty_work = false;
  }
  assert.throws(
    () => validateM5DWorkload(workload, { proposalCaseIds: proposalInfo.case_ids }),
    (error) => error instanceof M5DRecoveryValidationError && error.code === 'WORKLOAD_SOURCE_REQUIRED',
  );
});

test('M5-10D workload rejects a queue that is not derived from its causal source', () => {
  const proposal = makeProposal();
  const proposalInfo = validateM5DProposal(proposal);
  const proposalSha256 = 'a'.repeat(64);
  const timingSessionId = '22222222-2222-4222-8222-222222222222';
  const passSessionId = '33333333-3333-4333-8333-333333333333';
  const source = {
    schema_version: '1',
    artifact_id: 'm5-10d-follow-up-source-20260912',
    batch_id: M5_10D_BATCH_ID,
    source_kind: 'recorder-owned-initial-review-findings',
    proposal_sha256: proposalSha256,
    timing_session_id: timingSessionId,
    source_pass_id: 'initial-review',
    source_pass_session_id: passSessionId,
    source_judgment_artifact_sha256: 'b'.repeat(64),
    freeze_event_id: 'm5-10d-workload-freeze-test',
    created_at: new Date().toISOString(),
    findings: [{
      case_id: 'm5-10d-cal-001',
      record_id: 'cal-m5-10d-001',
      source_record_sha256: sha256Bytes(Buffer.from(JSON.stringify(proposal.cases[0].record))),
      finding_kind: 'correction',
      source_judgment_id: '11111111-1111-4111-8111-111111111111',
      source_judgment_row_sha256: 'c'.repeat(64),
      note: 'm5-10d-cal-001 was frozen from its initial-review judgment.',
    }],
    note: 'Test source is recorder-owned and intentionally disagrees with the caller queue.',
  };
  validateM5DFollowUpSource(source, {
    proposalCaseIds: proposalInfo.case_ids,
    proposalSha256,
    proposalCasesById: proposalInfo.by_case,
  });
  assert.throws(
    () => validateM5DFollowUpSource(source, {
      proposalCaseIds: proposalInfo.case_ids,
      proposalSha256,
      proposalCasesById: proposalInfo.by_case,
      timingSessionId,
      initialPassSessionId: passSessionId,
      initialPass: { completed_at: new Date(Date.now() - 1_000).toISOString() },
      initialJudgmentRows: [{
        judgment_id: '44444444-4444-4444-8444-444444444444',
        pass_id: 'initial-review',
        unit_id: 'm5-10d-cal-001',
        pass_session_id: passSessionId,
        evidence: {
          decision_artifact_sha256: source.source_judgment_artifact_sha256,
          decision_row_sha256: source.findings[0].source_judgment_row_sha256,
        },
      }],
    }),
    (error) => error instanceof M5DRecoveryValidationError && error.code === 'WORKLOAD_SOURCE_BINDING',
  );
  const sourceBytes = Buffer.from(`${JSON.stringify(source)}\n`, 'utf8');
  const workload = makeWorkload(proposalSha256);
  workload.source.follow_up_artifact = 'contract:m5-10d-follow-up-source';
  workload.source.follow_up_sha256 = sha256Bytes(sourceBytes);
  workload.source.follow_up_source_kind = source.source_kind;
  workload.source.follow_up_timing_session_id = timingSessionId;
  workload.source.follow_up_pass_id = source.source_pass_id;
  workload.source.follow_up_freeze_event_id = source.freeze_event_id;
  for (const passIndex of [2, 3]) {
    workload.passes[passIndex].expected_unit_ids = ['m5-10d-cal-002'];
    workload.passes[passIndex].expected_unit_count = 1;
    workload.passes[passIndex].expected_unit_set_sha256 = workloadUnitSetSha256(['m5-10d-cal-002']);
    workload.passes[passIndex].empty_work = false;
  }
  assert.throws(
    () => validateM5DWorkload(workload, {
      proposalCaseIds: proposalInfo.case_ids,
      proposalSha256,
      proposalCasesById: proposalInfo.by_case,
      followUpSource: { value: source, sha256: sha256Bytes(sourceBytes) },
      timingSessionId,
    }),
    (error) => error instanceof M5DRecoveryValidationError && error.code === 'WORKLOAD_SOURCE_BINDING',
  );
});

test('M5-10D fixed gate holds on missing workload coverage and excessive editor time', () => {
  const base = {
    correctionRate: 0.2,
    relationNoiseRate: 0.25,
    timing: { status: 'complete', unmeasured_pass_count: 0, total_editor_seconds: 240 },
    audit: { status: 'complete', independent: true, open_blocker_count: 0 },
    editorial: { status: 'complete' },
    canonicalMutation: false,
    inventoryMutation: false,
    verification: { canonical_integrity: true, deterministic_sqlite: true, search_product_regression: true },
    failedStage: { gate_status: 'fail', decision: 'HOLD PROCESS', next_stage_authorized: false },
    failedRecovery: { gate_status: 'fail', decision: 'HOLD PROCESS', ready_to_create: false },
    workloadCoverage: false,
  };
  const result = evaluateM5DRecoveryGate(base);
  assert.equal(result.gate_status, 'fail');
  assert.deepEqual(result.failures, ['workload_coverage']);
  const timingFailure = evaluateM5DRecoveryGate({ ...base, workloadCoverage: true, timing: { ...base.timing, total_editor_seconds: 240.001 } });
  assert.deepEqual(timingFailure.failures, ['editor_seconds_per_processed_start']);
});
