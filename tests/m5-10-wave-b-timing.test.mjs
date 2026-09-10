import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main as recordWaveBTiming } from '../scripts/batch/record-m5-10-wave-b-timing.mjs';
import { produce as produceWaveBWork } from '../scripts/batch/produce-m5-10-wave-b-work.mjs';

const PRODUCER_BOUNDARIES = [
  'physical-figurative',
  'homonym-pos',
  'sensory-emotion-state-action',
  'directional-symmetry',
  'compound-spaced-phrase',
  'word-idiom',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function proposalSource(record, semanticCase) {
  const senseIds = record.senses.map(({ id }) => id);
  return {
    kind: 'external-proposal',
    artifact: 'external-proposal-fixture',
    sha256: 'a'.repeat(64),
    record,
    evidence: {
      kind: 'proposal-sense-evidence',
      candidate_sense_ids: senseIds,
      candidate_pos: record.senses.map(({ pos }) => pos),
      candidate_glosses: record.senses.map(({ gloss }) => gloss),
      boundary_observations: Object.fromEntries(PRODUCER_BOUNDARIES.map((boundaryId) => [boundaryId, {
        boundary_id: boundaryId,
        candidate_sense_ids: senseIds,
        basis: 'source fixture ' + record.id + ' sense ' + senseIds.join(' ') + ' boundary ' + boundaryId + ' was considered.',
      }])),
      ...(semanticCase ? { semantic_case: semanticCase } : {}),
    },
  };
}

function semanticCaseFor(record, boundaryId = 'homonym-pos') {
  const candidateSenses = record.senses.map(({ id, pos, gloss }) => ({ id, pos, gloss }));
  return {
    case_id: 'synthetic-producer-case',
    scope: 'synthetic-regression',
    case_type: 'homonym',
    canonical_id: record.id,
    boundary_id: boundaryId,
    candidate_senses: candidateSenses,
    required_applicability: 'applicable',
    required_decision: 'split',
    contrast_pairs: [[candidateSenses[0].id, candidateSenses[1].id]],
    review_requirement: 'Synthetic candidate senses must remain separate.',
  };
}

function producerInput(record, phase, extra = {}, semanticCase) {
  return {
    phase,
    unit_id: extra.unit_id ?? record.id,
    source: proposalSource(record, semanticCase),
    ...extra,
  };
}

test('Wave B timing recorder derives scope from recorder-created work-log rows', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-10-wave-b-timing-'));
  try {
    const sessionPath = path.join(directory, 'timing-session.json');
    const firstInputPath = path.join(directory, 'seed.jsonl');
    const firstOutputPath = path.join(directory, 'first-output.jsonl');
    const secondOutputPath = path.join(directory, 'second-output.jsonl');
    const preparedOutputPath = path.join(directory, 'prepared-output.jsonl');
    const producerPath = path.join(directory, 'producer.mjs');
    const firstInput = '{"kind":"seed","source":"self-authored"}\n';
    await writeFile(firstInputPath, firstInput, 'utf8');
    await writeFile(preparedOutputPath, '{"kind":"summary","count":1}\n', 'utf8');
    await writeFile(producerPath, [
      'export function produce({ unitId, unitKind, input }) {',
      '  return { ...input, produced_by: "timed-test-producer", unit_id: unitId, unit_kind: unitKind };',
      '}',
      '',
    ].join('\n'), 'utf8');

    await assert.rejects(
      recordWaveBTiming([
        '--action=start',
        '--kind=editorial',
        '--pass=target-preparation',
        `--output=${sessionPath}`,
        `--input-artifact=${firstInputPath}`,
        `--output-artifact=${preparedOutputPath}`,
      ]),
      /pre-existing timing output artifact/u,
    );

    await recordWaveBTiming([
      '--action=start',
      '--kind=editorial',
      '--pass=target-preparation',
      `--output=${sessionPath}`,
      `--input-artifact=${firstInputPath}`,
      `--output-artifact=${firstOutputPath}`,
    ]);
    await assert.rejects(
      recordWaveBTiming([
        '--action=work',
        '--pass=target-preparation',
        `--input=${sessionPath}`,
        '--unit-id=m5-000',
        '--unit-kind=selected-target',
        '--work-json={"inventory_id":"m5-000"}',
      ]),
      /--work-json is not accepted/u,
    );
    await recordWaveBTiming([
      '--action=work',
      '--pass=target-preparation',
      `--input=${sessionPath}`,
      '--unit-id=m5-001',
      '--unit-kind=selected-target',
      `--producer=${producerPath}`,
      '--input-json={"inventory_id":"m5-001","operation":"select"}',
    ]);
    await recordWaveBTiming([
      '--action=stop',
      '--kind=editorial',
      '--pass=target-preparation',
      `--input=${sessionPath}`,
    ]);
    await recordWaveBTiming([
      '--action=start',
      '--kind=editorial',
      '--pass=initial-review',
      `--input=${sessionPath}`,
      `--output=${sessionPath}`,
      `--input-artifact=${firstOutputPath}`,
      `--output-artifact=${secondOutputPath}`,
    ]);
    await assert.rejects(
      recordWaveBTiming([
        '--action=work',
        '--pass=initial-review',
        `--input=${sessionPath}`,
        '--unit-id=m5-001:physical-figurative',
        '--unit-kind=boundary-check',
        '--work-record=/missing/work-record.json',
      ]),
      /--work-record is not accepted/u,
    );
    await assert.rejects(
      recordWaveBTiming([
        '--action=work',
        '--kind=editorial',
        '--pass=initial-review',
        `--input=${sessionPath}`,
        '--unit-id=m5-001:physical-figurative',
        '--unit-kind=boundary-check',
        `--producer=${producerPath}`,
        '--input-json={"inventory_id":"m5-001","operation":"review"}',
        `--unit-count=1`,
      ]),
      /--unit-count is not accepted/u,
    );
    await recordWaveBTiming([
      '--action=work',
      '--pass=initial-review',
      `--input=${sessionPath}`,
      '--unit-id=m5-001:physical-figurative',
      '--unit-kind=boundary-check',
      `--producer=${producerPath}`,
      '--input-json={"inventory_id":"m5-001","boundary_id":"physical-figurative","operation":"review"}',
    ]);
    await recordWaveBTiming([
      '--action=stop',
      '--kind=editorial',
      '--pass=initial-review',
      `--input=${sessionPath}`,
    ]);

    const session = JSON.parse(await readFile(sessionPath, 'utf8'));
    const firstPass = session.passes[0];
    assert.equal(session.recorder_version, 'wave-b-timing-recorder-v6');
    assert.equal(session.recording_source, 'timing-recorder-v6');
    assert.equal(session.measurement_kind, 'producer-throughput');
    assert.equal(firstPass.work_evidence.before_sha256, sha256(firstInput));
    assert.equal(firstPass.work_evidence.unit_count, 1);
    assert.deepEqual(firstPass.work_evidence.unit_ids, ['m5-001']);
    assert.equal(firstPass.work_evidence.work_log.path, firstPass.work_evidence.output_artifact.path);
    assert.equal(session.passes[1].work_evidence.before_sha256, firstPass.work_evidence.after_sha256);
    assert.equal(session.events.length, 6);
    assert.deepEqual(session.events.map(({ kind }) => kind), ['start', 'work', 'stop', 'start', 'work', 'stop']);
    assert.equal(firstPass.work_evidence.work_event_ids[0], session.events[1].event_id);
    assert.equal(session.events[1].unit_id, 'm5-001');
    assert.ok(Date.parse(session.events[1].at) >= Date.parse(firstPass.started_at));
    assert.ok(Date.parse(session.events[1].at) <= Date.parse(firstPass.completed_at));
    const firstOutputRows = (await readFile(firstOutputPath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    const firstWorkRow = firstOutputRows.find(({ kind, unit_id: unitId }) => kind === 'work' && unitId === 'm5-001');
    assert.deepEqual(firstWorkRow.input.payload, { inventory_id: 'm5-001', operation: 'select' });
    assert.equal(firstWorkRow.producer.export, 'produce');
    assert.equal(firstWorkRow.producer.input_payload_sha256, sha256(JSON.stringify(firstWorkRow.input.payload)));
    assert.equal(firstWorkRow.producer.output_sha256, sha256(JSON.stringify(firstWorkRow.payload)));
    assert.ok(Date.parse(firstWorkRow.producer.started_at) >= Date.parse(firstPass.started_at));
    assert.ok(Date.parse(firstWorkRow.producer.completed_at) <= Date.parse(firstPass.completed_at));
    assert.equal(firstPass.producer_seconds, firstPass.wall_clock_seconds);
    await assert.rejects(
      recordWaveBTiming([
        '--action=work',
        '--kind=editorial',
        '--pass=feedback-fixes',
        `--input=${sessionPath}`,
        `--before-sha256=${'0'.repeat(64)}`,
        '--unit-id=w629',
        '--unit-kind=sense-correction',
        '--work-json={"operation":"correct"}',
      ]),
      /--before-sha256 is not accepted/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('prepared 900-payload replay fails the timing gate while timed producer work passes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-10-wave-b-replay-'));
  try {
    const sessionPath = path.join(directory, 'timing-session.json');
    const inputPath = path.join(directory, 'seed.jsonl');
    const outputPath = path.join(directory, 'output.jsonl');
    const producerPath = path.join(directory, 'producer.mjs');
    const preparedPayloads = Array.from({ length: 900 }, (_, index) => ({
      unit_id: `prepared-${String(index + 1).padStart(3, '0')}`,
      decision: index % 2 === 0 ? 'included' : 'corrected',
      source: 'prepared-before-session',
    }));
    await writeFile(inputPath, '{"kind":"seed"}\n', 'utf8');
    await writeFile(producerPath, [
      'export function produce({ unitId, input }) {',
      '  return { unit_id: unitId, decision: "produced-in-pass", source_unit: input.source_unit };',
      '}',
      '',
    ].join('\n'), 'utf8');

    const originalLog = console.log;
    console.log = () => {};
    try {
      await recordWaveBTiming([
        '--action=start',
        '--kind=editorial',
        '--pass=target-preparation',
        `--output=${sessionPath}`,
        `--input-artifact=${inputPath}`,
        `--output-artifact=${outputPath}`,
      ]);

      for (const payload of preparedPayloads) {
        await assert.rejects(
          recordWaveBTiming([
            '--action=work',
            '--pass=target-preparation',
            `--input=${sessionPath}`,
            `--unit-id=${payload.unit_id}`,
            '--unit-kind=selected-target',
            `--work-json=${JSON.stringify(payload)}`,
          ]),
          /--work-json is not accepted/u,
        );
      }
      const replayAttempt = JSON.parse(await readFile(sessionPath, 'utf8'));
      assert.equal(replayAttempt.passes[0].work_events?.length ?? 0, 0);
      await assert.rejects(
        recordWaveBTiming([
          '--action=stop',
          '--pass=target-preparation',
          '--kind=editorial',
          `--input=${sessionPath}`,
        ]),
        /no recorded work transition/u,
      );

      for (const payload of preparedPayloads) {
        await recordWaveBTiming([
          '--action=work',
          '--pass=target-preparation',
          `--input=${sessionPath}`,
          `--unit-id=${payload.unit_id}`,
          '--unit-kind=selected-target',
          `--producer=${producerPath}`,
          `--input-json=${JSON.stringify({ source_unit: payload.unit_id })}`,
        ]);
      }
      await recordWaveBTiming([
        '--action=stop',
        '--kind=editorial',
        '--pass=target-preparation',
        `--input=${sessionPath}`,
      ]);
      const measured = JSON.parse(await readFile(sessionPath, 'utf8'));
      assert.equal(measured.passes[0].work_evidence.unit_count, 900);
      assert.equal(measured.passes[0].work_evidence.unit_ids.length, 900);
      const measuredRows = (await readFile(outputPath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
      const firstMeasuredRow = measuredRows.find(({ kind }) => kind === 'work');
      assert.equal(firstMeasuredRow.producer.export, 'produce');
      assert.equal(firstMeasuredRow.payload.decision, 'produced-in-pass');
    } finally {
      console.log = originalLog;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Wave B producer uses external proposal evidence and refuses an unsupported multi-sense admission', () => {
  const singleSenseRecord = {
    id: 'synthetic-producer-single',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'synthetic-producer-single',
    lemma: '가상 단일',
    search_forms: ['가상 단일'],
    senses: [{ id: 'synthetic-producer-single-s1', pos: 'noun', gloss: '하나의 source sense.' }],
  };
  const singleReview = produceWaveBWork({
    unitId: singleSenseRecord.id,
    unitKind: 'final-audit',
    input: producerInput(singleSenseRecord, 'final', {
      inventory_id: 'synthetic-inventory-single',
      canonical_id: singleSenseRecord.id,
    }),
  }).record_review;
  assert.equal(singleReview.decision, 'included');
  assert.equal(singleReview.observed_sense_count, 1);
  assert.deepEqual(
    Object.values(singleReview.boundary_evidence).map(({ applicability }) => applicability),
    PRODUCER_BOUNDARIES.map(() => 'not-applicable'),
  );

  const unsupportedMulti = {
    ...singleSenseRecord,
    id: 'synthetic-producer-multi',
    candidate_id: 'synthetic-producer-multi',
    senses: [
      { id: 'synthetic-producer-multi-s1', pos: 'noun', gloss: '첫 번째 source sense.' },
      { id: 'synthetic-producer-multi-s2', pos: 'noun', gloss: '두 번째 source sense.' },
    ],
  };
  const heldReview = produceWaveBWork({
    unitId: unsupportedMulti.id,
    unitKind: 'final-audit',
    input: producerInput(unsupportedMulti, 'final', {
      inventory_id: 'synthetic-inventory-multi',
      canonical_id: unsupportedMulti.id,
    }),
  }).record_review;
  assert.equal(heldReview.decision, 'held');
  assert.equal(heldReview.canonical_id, undefined);

  const splitReview = produceWaveBWork({
    unitId: unsupportedMulti.id,
    unitKind: 'final-audit',
    input: producerInput(unsupportedMulti, 'final', {
      inventory_id: 'synthetic-inventory-multi',
      canonical_id: unsupportedMulti.id,
    }, semanticCaseFor(unsupportedMulti)),
  }).record_review;
  assert.equal(splitReview.decision, 'corrected');
  assert.deepEqual(splitReview.corrected_fields, ['senses']);
  assert.equal(splitReview.boundary_evidence['homonym-pos'].contrasts.length, 1);
});

test('Wave B independent audit derives findings from record and timing comparisons', () => {
  const record = {
    id: 'synthetic-producer-audit',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'synthetic-producer-audit',
    lemma: '가상 감사',
    search_forms: ['가상 감사'],
    senses: [{ id: 'synthetic-producer-audit-s1', pos: 'noun', gloss: '감사 비교용 source sense.' }],
  };
  const input = producerInput(record, 'final', {
    inventory_id: 'synthetic-inventory-audit',
    canonical_id: record.id,
  });
  const review = produceWaveBWork({
    unitId: record.id,
    unitKind: 'final-audit',
    input,
  }).record_review;
  const clean = produceWaveBWork({
    unitId: record.id,
    unitKind: 'post-freeze-audit-item',
    input: {
      ...input,
      phase: 'audit-record',
      target_kind: 'record',
      proposal_canonical_id: record.id,
      reviewed_record: record,
      record_review: review,
    },
  });
  assert.equal(clean.status, 'verified');
  assert.deepEqual(clean.findings, []);

  const drifted = produceWaveBWork({
    unitId: record.id,
    unitKind: 'post-freeze-audit-item',
    input: {
      ...input,
      phase: 'audit-record',
      target_kind: 'record',
      proposal_canonical_id: record.id,
      reviewed_record: { ...record, lemma: '변조된 결과' },
      record_review: review,
    },
  });
  assert.equal(drifted.status, 'finding');
  assert.ok(drifted.findings.length > 0);
  assert.equal(drifted.findings[0].status, 'open');

  const relationInput = {
    phase: 'audit-relation',
    unit_id: 'wave-b-relation-screen',
    relation_input: { before_count: 0, after_count: 0, events: [], candidate_count: 0 },
  };
  const relationResult = produceWaveBWork({
    unitId: relationInput.unit_id,
    unitKind: 'post-freeze-audit-item',
    input: relationInput,
  });

  const timingAudit = produceWaveBWork({
    unitId: 'wave-b-timing-completeness',
    unitKind: 'post-freeze-audit-item',
    input: {
      phase: 'audit-timing',
      unit_id: 'wave-b-timing-completeness',
      reviewed_record_ids: [record.id],
      reviewed_buffer_inventory_ids: [],
      semantic_regression_case_ids: ['synthetic-case'],
      relation_unit_id: 'wave-b-relation-screen',
      timing_unit_id: 'wave-b-timing-completeness',
      audit_work_unit_ids: [record.id, 'wave-b-relation-screen', 'wave-b-timing-completeness'],
      relation_scope: { before_count: 0, after_count: 0, candidate_count: 0 },
      record_audit_inputs: [{
        ...input,
        phase: 'audit-record',
        target_kind: 'record',
        proposal_canonical_id: record.id,
        reviewed_record: { ...record, lemma: '변조된 결과' },
        record_review: review,
      }],
      record_audit_results: [drifted],
      relation_audit_input: relationInput,
      relation_audit_result: relationResult,
      timing_evidence: {
        kind: 'recorder-session-summary',
        measurement_kind: 'producer-throughput',
        source_sha256: 'b'.repeat(64),
        status: 'complete',
        passes: [{
          id: 'editorial',
          status: 'complete',
          started_at: '2026-09-10T00:00:00.000Z',
          completed_at: '2026-09-10T00:00:01.000Z',
          unit_count: 1,
          work_event_count: 0,
          producer_execution_count: 1,
          decision_event_count: 1,
        }],
      },
    },
  });
  assert.equal(timingAudit.status, 'finding');
  assert.ok(timingAudit.findings.some(({ category }) => category === 'timing-measurement'));
});
