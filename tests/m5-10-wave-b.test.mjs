import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildArtifacts } from '../scripts/batch/build-m5-10-wave-b.mjs';
import { main as recordWaveBAudit } from '../scripts/batch/record-m5-10-wave-b-audit.mjs';
import { main as recordWaveBEditorial } from '../scripts/batch/record-m5-10-wave-b-editorial.mjs';
import {
  DEFAULT_AUDIT_TIMING_INPUT_PATH,
  DEFAULT_AUDIT_INPUT_PATH,
  DEFAULT_METRICS_PATH,
  DEFAULT_OUTPUT_PATH,
  DEFAULT_RELATION_DIFF_PATH,
  DEFAULT_STAGE_PATH,
  DEFAULT_TIMING_INPUT_PATH,
  DEFAULT_VERIFICATION_PATH,
  WaveBValidationError,
  createWaveBTimingProof,
  deriveWaveBAuditDecisionFromTiming,
  deriveWaveBEditorialRecordsFromTiming,
  validateWaveBChronology,
  validateWaveBSemanticRegression,
  validateWaveB,
  validateWaveBTimingInput,
} from '../scripts/batch/validate-m5-10-wave-b.mjs';
import { DEFAULT_CANONICAL_DIRECTORY, readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';

const BATCH_DIRECTORY = path.resolve('data/batches');
const CURRENT_SHARD_PATH = path.join(DEFAULT_CANONICAL_DIRECTORY, 'm5-10-wave-b.jsonl');
const RECORDERS_TEMP_PARENT = path.resolve('artifacts/.test-wave-b-recorders');

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function makeStagingDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-10-wave-b-'));
  const stagingPath = path.join(directory, 'reviewed.jsonl');
  await writeFile(stagingPath, await readFile(CURRENT_SHARD_PATH), 'utf8');
  return { directory, stagingPath };
}

test('M5-10 Wave B validates the independent +150 gate without a browser', async () => {
  const { directory, stagingPath } = await makeStagingDirectory();
  try {
    const result = await validateWaveB({ stagedRecordsPath: stagingPath });
    assert.equal(result.batch.batch_id, 'm5-10-wave-b-20260909');
    assert.equal(result.batch.selected_start_count, 170);
    assert.equal(result.batch.processed_start_count, 160);
    assert.equal(result.batch.imported_start_count, 150);
    assert.equal(result.canonical.start_count, 778);
    assert.equal(result.metrics.canonical_import.imported_sense_count, 157);
    assert.deepEqual(result.metrics.sense_review.split_canonical_ids, ['w719', 'w734', 'w744', 'w746', 'w750', 'w753']);
    assert.equal(result.metrics.canonical_import.imported_relation_count, 0);
    assert.equal(result.stage.gate_status, 'pass');
    assert.equal(result.gate.quality_passes.timing_complete, true);
    assert.equal(result.gate.quality_passes.unmeasured_timing_passes, true);

    const editorial = await readJson(path.join(BATCH_DIRECTORY, 'm5-10-wave-b-editorial-input.json'));
    const audit = await readJson(path.join(BATCH_DIRECTORY, 'm5-10-wave-b-audit-input.json'));
    const timing = await readJson(DEFAULT_TIMING_INPUT_PATH);
    const auditTiming = await readJson(DEFAULT_AUDIT_TIMING_INPUT_PATH);
    assert.deepEqual(deriveWaveBEditorialRecordsFromTiming(timing), editorial.records);
    assert.deepEqual(deriveWaveBAuditDecisionFromTiming(auditTiming), {
      audit_id: audit.audit_id,
      coverage: audit.coverage,
      findings: audit.findings,
      relation_reviews: audit.relation_reviews,
      note: audit.note,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Wave B validates post-freeze timing against the runtime staging path', async () => {
  const { directory, stagingPath } = await makeStagingDirectory();
  try {
    const editorial = await readJson(path.join(BATCH_DIRECTORY, 'm5-10-wave-b-editorial-input.json'));
    const audit = await readJson(path.join(BATCH_DIRECTORY, 'm5-10-wave-b-audit-input.json'));
    const auditTiming = await readJson(DEFAULT_AUDIT_TIMING_INPUT_PATH);
    auditTiming.reviewed_staging_artifact.path = path.join(directory, 'materialized-reviewed.jsonl');
    auditTiming.recording_proof_sha256 = createWaveBTimingProof(auditTiming);

    assert.doesNotThrow(() => validateWaveBTimingInput(auditTiming, {
      timingKind: 'post-freeze-audit',
      reviewedStagingSha256: editorial.reviewed_staging_sha256,
      reviewedStagingPath: stagingPath,
      auditSessionId: audit.provenance.session_id,
    }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Wave B fails closed on editorial scope, relation output, and timing regressions', async () => {
  const { directory, stagingPath } = await makeStagingDirectory();
  try {
    const editorialPath = path.join(directory, 'editorial.json');
    const editorial = await readJson(path.join(BATCH_DIRECTORY, 'm5-10-wave-b-editorial-input.json'));
    editorial.records[149].boundary_evidence['word-idiom'].rationale = 'generic evidence';
    await writeFile(editorialPath, `${JSON.stringify(editorial)}\n`, 'utf8');
    await assert.rejects(
      validateWaveB({ stagedRecordsPath: stagingPath, editorialInputPath: editorialPath }),
      (error) => error instanceof WaveBValidationError && error.code === 'BOUNDARY_EVIDENCE_MISMATCH',
    );

    const blanketEditorialPath = path.join(directory, 'blanket-editorial.json');
    const blanketEditorial = await readJson(path.join(BATCH_DIRECTORY, 'm5-10-wave-b-editorial-input.json'));
    const blanketRecord = blanketEditorial.records.find(({ inventory_id: inventoryId }) => inventoryId === 'm5-365');
    for (const evidence of Object.values(blanketRecord.boundary_evidence)) {
      evidence.applicability = 'applicable';
      evidence.decision = 'keep';
      evidence.contrasts = [];
    }
    await writeFile(blanketEditorialPath, `${JSON.stringify(blanketEditorial)}\n`, 'utf8');
    await assert.rejects(
      validateWaveB({ stagedRecordsPath: stagingPath, editorialInputPath: blanketEditorialPath }),
      (error) => error instanceof WaveBValidationError && error.code === 'GENERIC_EDITORIAL_EVIDENCE',
    );

    const precomputedDecisionPath = path.join(directory, 'precomputed-decision.json');
    const precomputedDecision = await readJson(path.join(BATCH_DIRECTORY, 'm5-10-wave-b-editorial-input.json'));
    precomputedDecision.records.find(({ inventory_id: inventoryId }) => inventoryId === 'm5-455').decision = 'included';
    await writeFile(precomputedDecisionPath, `${JSON.stringify(precomputedDecision)}\n`, 'utf8');
    await assert.rejects(
      validateWaveB({ stagedRecordsPath: stagingPath, editorialInputPath: precomputedDecisionPath }),
      (error) => error instanceof WaveBValidationError && error.code === 'EDITORIAL_DECISION_MISMATCH',
    );

    const relationPath = path.join(directory, 'relation.json');
    const relation = await readJson(DEFAULT_RELATION_DIFF_PATH);
    relation.after_count = 1;
    relation.events = [{
      event_id: 'wave-b-regression',
      relation_id: 'wave-b-regression',
      operation: 'add',
      source_sense: 'w629-s1',
      after: { target: 'w018', target_sense: 'w018-s1', type: 'mood' },
    }];
    await writeFile(relationPath, `${JSON.stringify(relation)}\n`, 'utf8');
    await assert.rejects(
      validateWaveB({ stagedRecordsPath: stagingPath, relationDiffPath: relationPath }),
      (error) => error instanceof WaveBValidationError && error.code === 'RELATION_DIFF_NOT_EMPTY',
    );

    const timingPath = path.join(directory, 'timing.json');
    const timing = await readJson(DEFAULT_TIMING_INPUT_PATH);
    timing.passes[2].status = 'unmeasured';
    delete timing.passes[2].completed_at;
    delete timing.passes[2].wall_clock_seconds;
    delete timing.passes[2].editor_seconds;
    await writeFile(timingPath, `${JSON.stringify(timing)}\n`, 'utf8');
    await assert.rejects(
      validateWaveB({ stagedRecordsPath: stagingPath, timingInputPath: timingPath }),
      (error) => error instanceof WaveBValidationError && error.code === 'TIMING_INCOMPLETE',
    );

    const digestTimingPath = path.join(directory, 'digest-timing.json');
    const digestTiming = await readJson(DEFAULT_TIMING_INPUT_PATH);
    digestTiming.passes[0].work_evidence.before_sha256 = '0'.repeat(64);
    await writeFile(digestTimingPath, `${JSON.stringify(digestTiming)}\n`, 'utf8');
    await assert.rejects(
      validateWaveB({ stagedRecordsPath: stagingPath, timingInputPath: digestTimingPath }),
      (error) => error instanceof WaveBValidationError && error.code === 'TIMING_ARTIFACT_DIGEST_MISMATCH',
    );

    const missingTimingArtifactPath = path.join(directory, 'missing-timing-artifact.json');
    const missingTimingArtifact = await readJson(DEFAULT_TIMING_INPUT_PATH);
    missingTimingArtifact.passes[0].work_evidence.input_artifact.path = path.join(directory, 'does-not-exist.json');
    await writeFile(missingTimingArtifactPath, `${JSON.stringify(missingTimingArtifact)}\n`, 'utf8');
    await assert.rejects(
      validateWaveB({ stagedRecordsPath: stagingPath, timingInputPath: missingTimingArtifactPath }),
      (error) => error instanceof WaveBValidationError && error.code === 'TIMING_ARTIFACT_MISSING',
    );

    const outOfScopeAuditPath = path.join(directory, 'out-of-scope-audit.json');
    const outOfScopeAudit = await readJson(DEFAULT_AUDIT_INPUT_PATH);
    outOfScopeAudit.findings[0].target_record_ids = ['w999'];
    await writeFile(outOfScopeAuditPath, `${JSON.stringify(outOfScopeAudit)}\n`, 'utf8');
    await assert.rejects(
      validateWaveB({ stagedRecordsPath: stagingPath, auditInputPath: outOfScopeAuditPath }),
      (error) => error instanceof WaveBValidationError && error.code === 'AUDIT_TARGET_SCOPE',
    );

    const stagePath = path.join(directory, 'stage.json');
    const stage = await readJson(DEFAULT_STAGE_PATH);
    stage.source.canonical_sha256 = '0'.repeat(64);
    await writeFile(stagePath, `${JSON.stringify(stage)}\n`, 'utf8');
    await assert.rejects(
      validateWaveB({ stagedRecordsPath: stagingPath, stagePath }),
      (error) => error instanceof WaveBValidationError && error.code === 'STAGE_SOURCE_MISMATCH',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Wave B binds the editorial and post-freeze audit chronology', async () => {
  const editorial = await readJson(path.join(BATCH_DIRECTORY, 'm5-10-wave-b-editorial-input.json'));
  const audit = await readJson(path.join(BATCH_DIRECTORY, 'm5-10-wave-b-audit-input.json'));
  const timing = await readJson(DEFAULT_TIMING_INPUT_PATH);
  const auditTiming = await readJson(DEFAULT_AUDIT_TIMING_INPUT_PATH);

  assert.doesNotThrow(() => validateWaveBChronology({
    editorialInput: editorial,
    auditInput: audit,
    timingInput: timing,
    auditTimingInput: auditTiming,
  }));

  const earlyAudit = structuredClone(auditTiming);
  earlyAudit.passes[0].started_at = editorial.completed_at;
  earlyAudit.passes[0].completed_at = new Date(Date.parse(editorial.completed_at) + 1).toISOString();
  assert.throws(
    () => validateWaveBChronology({
      editorialInput: editorial,
      auditInput: audit,
      timingInput: timing,
      auditTimingInput: earlyAudit,
    }),
    (error) => error instanceof WaveBValidationError && error.code === 'AUDIT_TIMING_CHRONOLOGY',
  );

  const earlyDecision = structuredClone(editorial);
  earlyDecision.decision_artifact.created_at = new Date(Date.parse(timing.passes[0].started_at) - 2).toISOString();
  earlyDecision.decision_artifact.finalized_at = new Date(Date.parse(timing.passes[0].started_at) - 1).toISOString();
  assert.throws(
    () => validateWaveBChronology({
      editorialInput: earlyDecision,
      auditInput: audit,
      timingInput: timing,
      auditTimingInput: auditTiming,
    }),
    (error) => error instanceof WaveBValidationError && error.code === 'EDITORIAL_DECISION_CHRONOLOGY',
  );

  const earlyAuditDecision = structuredClone(audit);
  earlyAuditDecision.decision_artifact.created_at = new Date(Date.parse(auditTiming.passes[0].started_at) - 2).toISOString();
  earlyAuditDecision.decision_artifact.finalized_at = new Date(Date.parse(auditTiming.passes[0].started_at) - 1).toISOString();
  assert.throws(
    () => validateWaveBChronology({
      editorialInput: editorial,
      auditInput: earlyAuditDecision,
      timingInput: timing,
      auditTimingInput: auditTiming,
    }),
    (error) => error instanceof WaveBValidationError && error.code === 'AUDIT_DECISION_CHRONOLOGY',
  );
});

test('Wave B keeps held and deferred buffer rows outside completed sense review', async () => {
  const editorial = await readJson(path.join(BATCH_DIRECTORY, 'm5-10-wave-b-editorial-input.json'));
  const manifest = await readJson(DEFAULT_OUTPUT_PATH);
  assert.equal(editorial.sense_review.reviewed_start_count, 150);
  assert.equal(editorial.records[149].observed_sense_count, 1);
  assert.equal(editorial.records[150].observed_sense_count, 0);
  assert.equal(editorial.records[150].boundary_evidence['word-idiom'].review_status, 'unreviewed');
  assert.equal(editorial.records[160].observed_sense_count, 0);
  assert.equal(editorial.records[160].boundary_evidence['word-idiom'].decision, 'pending');
  assert.equal(manifest.sense_review.preflight.record_checkpoints[149].status, 'complete');
  assert.equal(manifest.sense_review.preflight.record_checkpoints[150].status, 'held');
  assert.equal(manifest.sense_review.preflight.record_checkpoints[160].status, 'deferred');
});

test('Wave B semantic regression cases stay connected to proposal preflight', async () => {
  const editorial = await readJson(path.join(BATCH_DIRECTORY, 'm5-10-wave-b-editorial-input.json'));
  const canonical = await readJson(path.join(BATCH_DIRECTORY, 'm5-10-wave-b-semantic-regressions.json'));
  const canonicalRecords = (await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY)).records;
  const broken = structuredClone(editorial);
  const brokenRecord = broken.records.find(({ inventory_id: inventoryId }) => inventoryId === 'm5-455');
  brokenRecord.observed_sense_count = 1;
  await assert.rejects(
    async () => validateWaveBSemanticRegression({ corpus: canonical, referenceRecords: canonicalRecords, editorialRecords: broken.records }),
    (error) => error instanceof WaveBValidationError && error.code === 'SEMANTIC_PREFLIGHT_DISCONNECTED',
  );
});

test('Wave B semantic regression corpus accepts new declared synthetic cases and rejects drift', async () => {
  const editorial = await readJson(path.join(BATCH_DIRECTORY, 'm5-10-wave-b-editorial-input.json'));
  const corpus = await readJson(path.join(BATCH_DIRECTORY, 'm5-10-wave-b-semantic-regressions.json'));
  const canonicalRecords = (await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY)).records;
  const syntheticCase = {
    case_id: 'wave-b-sem-013',
    scope: 'synthetic-regression',
    case_type: 'homonym',
    canonical_id: 'synthetic-new-homonym-case',
    lemma: '가상 결',
    boundary_id: 'homonym-pos',
    candidate_senses: [
      { id: 'synthetic-new-homonym-case-s1', pos: 'noun', gloss: '나무 표면의 무늬를 가리키는 가상 명사.' },
      { id: 'synthetic-new-homonym-case-s2', pos: 'noun', gloss: '사람의 성격이나 분위기를 가리키는 가상 명사.' },
    ],
    source_evidence: {
      kind: 'curated-candidate-senses',
      candidate_sense_ids: ['synthetic-new-homonym-case-s1', 'synthetic-new-homonym-case-s2'],
      note: 'wave-b-sem-013은 새 synthetic homonym 후보를 검증하는 선언형 회귀다.',
    },
    expected_sense_count: 2,
    expected_sense_ids: ['synthetic-new-homonym-case-s1', 'synthetic-new-homonym-case-s2'],
    expected_pos: ['noun', 'noun'],
    expected_glosses: ['나무 표면의 무늬를 가리키는 가상 명사.', '사람의 성격이나 분위기를 가리키는 가상 명사.'],
    required_applicability: 'applicable',
    required_decision: 'split',
    contrast_pairs: [['synthetic-new-homonym-case-s1', 'synthetic-new-homonym-case-s2']],
    review_requirement: '새 synthetic 후보도 서로 다른 장면을 빈 contrast 단일 sense로 축약하지 않는다.',
  };
  const extendedCorpus = { ...corpus, cases: [...corpus.cases, syntheticCase] };
  assert.doesNotThrow(() => validateWaveBSemanticRegression({
    corpus: extendedCorpus,
    referenceRecords: canonicalRecords,
    editorialRecords: editorial.records,
  }));

  const driftedCorpus = structuredClone(extendedCorpus);
  driftedCorpus.cases.at(-1).expected_sense_ids = ['synthetic-new-homonym-case-s1'];
  assert.throws(
    () => validateWaveBSemanticRegression({
      corpus: driftedCorpus,
      referenceRecords: canonicalRecords,
      editorialRecords: editorial.records,
    }),
    (error) => error instanceof WaveBValidationError && error.code === 'SEMANTIC_CASE_CONTRACT',
  );
});

test('Wave B rejects an incomplete reviewed staging shard before promotion', async () => {
  const { directory, stagingPath } = await makeStagingDirectory();
  try {
    const rows = (await readFile(stagingPath, 'utf8')).trim().split('\n');
    await writeFile(stagingPath, `${rows.slice(0, -1).join('\n')}\n`, 'utf8');
    await assert.rejects(
      validateWaveB({ stagedRecordsPath: stagingPath }),
      (error) => (error instanceof WaveBValidationError && ['MISSING_STAGED_RECORD', 'COVERAGE_MISMATCH', 'STAGED_COUNT_MISMATCH', 'TIMING_ARTIFACT_DIGEST_MISMATCH'].includes(error.code))
        || error.code === 'REVIEWED_STAGING_DIGEST_MISMATCH',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Wave B build and recorders require explicit external review artifacts', async () => {
  await assert.rejects(buildArtifacts(), /requires --staged=<external-reviewed-shard\.jsonl>/);

  const { directory: externalDirectory, stagingPath } = await makeStagingDirectory();
  await mkdir(RECORDERS_TEMP_PARENT, { recursive: true });
  const directory = await mkdtemp(path.join(RECORDERS_TEMP_PARENT, 'run-'));
  const proposalPath = path.join(externalDirectory, 'proposal.jsonl');
  await writeFile(proposalPath, 'self-authored external proposal fixture\n', 'utf8');
  try {
    const editorialSessionPath = path.join(directory, 'editorial-session.json');
    const editorialDecisionPath = path.join(directory, 'editorial-decisions.json');
    await writeFile(editorialDecisionPath, '{}\n', 'utf8');
    await assert.rejects(
      recordWaveBEditorial([
        '--action=start',
        `--proposal=${proposalPath}`,
        `--session=${editorialSessionPath}`,
        `--decisions=${editorialDecisionPath}`,
      ]),
      /existing editorial decision artifact/u,
    );
    await rm(editorialDecisionPath, { force: true });
    await recordWaveBEditorial([
      '--action=start',
      `--proposal=${proposalPath}`,
      `--session=${editorialSessionPath}`,
      `--decisions=${editorialDecisionPath}`,
    ]);
    await assert.rejects(
      recordWaveBEditorial([
        '--action=complete',
        `--session=${editorialSessionPath}`,
        `--staging=${stagingPath}`,
        '--timing=data/batches/m5-10-wave-b-timing-input.json',
        '--editorial=data/batches/m5-10-wave-b-editorial-input.json',
        '--canonical=data/canonical',
        '--inventory=data/batches/m5-10-wave-b-preimport-inventory.json',
      ]),
      /--decisions is required for complete/,
    );

    const auditSessionPath = path.join(directory, 'audit-session.json');
    const auditTimingPath = path.join(directory, 'audit-timing.json');
    const auditDecisionPath = path.join(directory, 'audit-decisions.json');
    await writeFile(auditDecisionPath, '{}\n', 'utf8');
    await assert.rejects(
      recordWaveBAudit([
        '--action=start',
        `--session=${auditSessionPath}`,
        '--editorial=data/batches/m5-10-wave-b-editorial-input.json',
        `--staging=${stagingPath}`,
        '--timing=data/batches/m5-10-wave-b-timing-input.json',
        `--relation=data/batches/m5-10-wave-b-relation-diff.json`,
        '--canonical=data/canonical',
        '--inventory=data/batches/m5-10-wave-b-preimport-inventory.json',
        `--audit-timing=${auditTimingPath}`,
        `--decisions=${auditDecisionPath}`,
      ]),
      /existing audit decision artifact/u,
    );
    await rm(auditDecisionPath, { force: true });
    await recordWaveBAudit([
      '--action=start',
      `--session=${auditSessionPath}`,
      '--editorial=data/batches/m5-10-wave-b-editorial-input.json',
      `--staging=${stagingPath}`,
      '--timing=data/batches/m5-10-wave-b-timing-input.json',
      '--relation=data/batches/m5-10-wave-b-relation-diff.json',
      '--canonical=data/canonical',
      '--inventory=data/batches/m5-10-wave-b-preimport-inventory.json',
      `--audit-timing=${auditTimingPath}`,
      `--decisions=${auditDecisionPath}`,
    ]);
    await assert.rejects(
      recordWaveBAudit([
        '--action=complete',
        `--session=${auditSessionPath}`,
        '--editorial=data/batches/m5-10-wave-b-editorial-input.json',
        `--staging=${stagingPath}`,
        '--timing=data/batches/m5-10-wave-b-timing-input.json',
        `--audit-timing=${auditTimingPath}`,
        '--audit=data/batches/m5-10-wave-b-audit-input.json',
        '--relation=data/batches/m5-10-wave-b-relation-diff.json',
        '--canonical=data/canonical',
      ]),
      /--decisions is required for complete/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(externalDirectory, { recursive: true, force: true });
  }
});
