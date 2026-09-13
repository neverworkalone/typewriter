import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  M5_11_AUDIT_TIMING_PASS_IDS,
  M5_11_EDITORIAL_TIMING_PASS_IDS,
  M5_11_MACHINE_CHECK_IDS,
  M5_11_TIMING_RECORDER_VERSION,
  deriveM511AdmissionGate,
  validateM511Admission,
} from '../scripts/batch/validate-m5-11-admission.mjs';
import { buildM511PromotionSeed, promoteM511 } from '../scripts/batch/promote-m5-11.mjs';
import { validateM511DurableEvidence } from '../scripts/batch/validate-m5-11-promotion.mjs';
import { M5_11_BATCH_ID } from '../scripts/batch/m5-11-editorial.mjs';
import { sha256Json, sha256ProposalRow } from '../scripts/batch/m5-11-editorial.mjs';

const BATCH_ID = 'm5-11-expansion-20260913';

function fileSource(path, value, bytes = Buffer.from(JSON.stringify(value), 'utf8')) {
  return {
    path,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    value,
  };
}

function makeCatalog() {
  return [0, 1, 2, 3].map((index) => ({
    catalog_index: index,
    inventory_id: `m5-${String(535 + index).padStart(3, '0')}`,
    axis: 'A',
    flags: ['action-direction'],
  }));
}

function makeProposal(catalog) {
  const proposals = catalog.map((entry, index) => {
    const candidateLemma = ['보류말', '거절말', '포함말', '수정말'][index];
    const candidateId = `proposal-${entry.inventory_id}`;
    const candidateRecord = {
      id: candidateId,
      record_type: 'entry',
      role: 'start',
      candidate_id: candidateId,
      lemma: candidateLemma,
      search_forms: [candidateLemma],
      senses: [{
        id: `${candidateId}-s1`,
        pos: 'noun',
        gloss: `${candidateLemma}의 검수된 의미`,
      }],
    };
    const row = {
      inventory_id: entry.inventory_id,
      candidate_lemma: candidateLemma,
      candidate_record: candidateRecord,
    };
    return { ...row, proposal_sha256: sha256ProposalRow(row) };
  });
  return {
    schema_version: '1',
    issue: 97,
    batch_id: BATCH_ID,
    catalog_sha256: sha256Json(catalog),
    catalog_count: catalog.length,
    proposals,
  };
}

function boundaryChecks(inventoryId, senseId) {
  return Object.fromEntries([
    'physical-figurative',
    'homonym-pos',
    'sensory-emotion-state-action',
    'directional-symmetry',
    'compound-spaced-phrase',
    'word-idiom',
  ].map((id) => [id, {
    status: 'checked',
    rationale: `${inventoryId} ${id} checked ${senseId}`,
    contrast: `${id} contrast`,
    sense_ids: [senseId],
  }]));
}

function admittedDecision(inventoryId, candidateLemma, canonicalId, correctedLemma) {
  const lemma = correctedLemma ?? candidateLemma;
  const senseId = `${canonicalId}-s1`;
  return {
    inventory_id: inventoryId,
    decision: correctedLemma === undefined ? 'included' : 'corrected',
    candidate_lemma: candidateLemma,
    candidate_proposal_sha256: '',
    ...(correctedLemma === undefined ? {} : { corrected_lemma: correctedLemma }),
    canonical_record: {
      id: canonicalId,
      record_type: 'entry',
      role: 'start',
      candidate_id: canonicalId,
      lemma,
      search_forms: [lemma],
      senses: [{ id: senseId, pos: 'noun', gloss: `${lemma}의 검수된 의미` }],
    },
      sense_review: {
      status: 'complete',
      observed_sense_count: 1,
      observed_sense_ids: [senseId],
      observed_pos: ['noun'],
      note: `${inventoryId} reviewed ${senseId}`,
      boundary_checks: boundaryChecks(inventoryId, senseId),
      },
    decision_note: `${inventoryId} editorially reviewed for bounded admission`,
  };
}

function makeSources(catalog) {
  const proposal = makeProposal(catalog);
  const editorial = {
    schema_version: '1',
    issue: 97,
    batch_id: BATCH_ID,
    catalog_sha256: sha256Json(catalog),
    catalog_count: catalog.length,
    human_editorial_review_complete: true,
    gate_decision: 'APPROVE BOUNDED',
    decisions: [
      {
        inventory_id: 'm5-535',
        decision: 'held',
        decision_note: 'm5-535 held for a later bounded review pass',
      },
      {
        inventory_id: 'm5-536',
        decision: 'rejected',
        decision_note: 'm5-536 rejected during the independent editorial pass',
      },
      admittedDecision('m5-537', '포함말', 'w779'),
      admittedDecision('m5-538', '수정말', 'w780', '수정말새'),
    ],
  };
  for (const decision of editorial.decisions) {
    const proposalRow = proposal.proposals.find(({ inventory_id: inventoryId }) => inventoryId === decision.inventory_id);
    decision.candidate_lemma = proposalRow.candidate_lemma;
    decision.candidate_proposal_sha256 = proposalRow.proposal_sha256;
  }
  editorial.proposal_sha256 = sha256Json(proposal);
  editorial.proposal_count = proposal.proposals.length;
  const proposalSource = fileSource('/tmp/m5-11-proposal.json', proposal);
  const editorialSource = fileSource('/tmp/m5-11-editorial.json', editorial);
  const imported = editorial.decisions
    .filter(({ canonical_record: record }) => record)
    .map(({ canonical_record: record }) => record);
  const importBytes = Buffer.from(`${imported.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  const reviewedImportSource = fileSource('/tmp/m5-11-import.jsonl', imported, importBytes);
  const relationDiff = {
    schema_version: '1',
    batch_id: BATCH_ID,
    before_count: 0,
    after_count: 0,
    events: [],
  };
  const relationDiffSource = fileSource('/tmp/m5-11-relation-diff.json', relationDiff);
  const editorialTiming = {
    schema_version: '1',
    issue: 97,
    batch_id: BATCH_ID,
    timing_kind: 'editorial',
    session_id: '11111111-1111-4111-8111-111111111111',
    source: {
      proposal_sha256: proposalSource.sha256,
      editorial_sha256: editorialSource.sha256,
    },
    recorder_version: M5_11_TIMING_RECORDER_VERSION,
    recording_source: M5_11_TIMING_RECORDER_VERSION,
    passes: M5_11_EDITORIAL_TIMING_PASS_IDS.map((id) => {
      const unitIds = id === 'final-verification'
        ? ['m5-537', 'm5-538']
        : id === 'held-rejected'
          ? ['m5-535', 'm5-536']
          : id === 'feedback-fixes'
            ? []
            : catalog.map(({ inventory_id: inventoryId }) => inventoryId);
      const durationMs = unitIds.length === 0 ? 0 : 1000;
      const startedAt = '2026-09-13T10:00:00.000Z';
      const completedAt = new Date(Date.parse(startedAt) + durationMs).toISOString();
      return {
        id,
        status: 'complete',
        unit_ids: unitIds,
        unit_count: unitIds.length,
        event_ids: unitIds.map((_, index) => `${id}-event-${index + 1}`),
        wall_clock_seconds: durationMs / 1000,
        editor_seconds: unitIds.length === 0 ? 0 : 1,
        started_at: startedAt,
        completed_at: completedAt,
        recording_source: M5_11_TIMING_RECORDER_VERSION,
      };
    }),
  };
  editorialTiming.events = editorialTiming.passes.flatMap((pass) => pass.unit_ids.map((unitId, index) => {
    const durationMs = pass.unit_ids.length === 0 ? 0 : Math.floor(Date.parse(pass.completed_at) - Date.parse(pass.started_at)) / pass.unit_ids.length;
    const startedAt = Date.parse(pass.started_at) + index * durationMs;
    const completedAt = startedAt + durationMs;
    return {
      event_id: pass.event_ids[index],
      kind: 'work',
      pass_id: pass.id,
      session_id: editorialTiming.session_id,
      unit_id: unitId,
      recording_source: M5_11_TIMING_RECORDER_VERSION,
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date(completedAt).toISOString(),
      recorded_at: new Date(completedAt).toISOString(),
    };
  }));
  editorialTiming.recorder = {
    version: M5_11_TIMING_RECORDER_VERSION,
    session_id: editorialTiming.session_id,
    event_count: editorialTiming.events.length,
    event_log_sha256: sha256Json(editorialTiming.events),
  };
  const editorialTimingSource = fileSource('/tmp/m5-11-editorial-timing.json', editorialTiming);
  const audit = {
    schema_version: '1',
    issue: 97,
    batch_id: BATCH_ID,
    audit_id: 'm5-11-independent-audit',
    session_id: '22222222-2222-4222-8222-222222222222',
    editorial_session_id: editorialTiming.session_id,
    independent: true,
    status: 'complete',
    source: {
      proposal_sha256: proposalSource.sha256,
      editorial_sha256: editorialSource.sha256,
    },
    reviewed_inventory_ids: catalog.map(({ inventory_id: inventoryId }) => inventoryId),
    findings: [],
    open_blocker_count: 0,
  };
  const auditSource = fileSource('/tmp/m5-11-audit.json', audit);
  const auditTiming = {
    schema_version: '1',
    issue: 97,
    batch_id: BATCH_ID,
    timing_kind: 'post-freeze-audit',
    session_id: audit.session_id,
    source: {
      proposal_sha256: proposalSource.sha256,
      editorial_sha256: editorialSource.sha256,
      audit_sha256: auditSource.sha256,
      editorial_timing_sha256: editorialTimingSource.sha256,
    },
    recorder_version: M5_11_TIMING_RECORDER_VERSION,
    recording_source: M5_11_TIMING_RECORDER_VERSION,
    passes: M5_11_AUDIT_TIMING_PASS_IDS.map((id) => ({
      id,
      status: 'complete',
      unit_ids: catalog.map(({ inventory_id: inventoryId }) => inventoryId),
      unit_count: catalog.length,
      event_ids: catalog.map((_, index) => `${id}-event-${index + 1}`),
      wall_clock_seconds: 1,
      audit_seconds: 1,
      started_at: '2026-09-13T11:00:00.000Z',
      completed_at: '2026-09-13T11:00:01.000Z',
      recording_source: M5_11_TIMING_RECORDER_VERSION,
    })),
  };
  auditTiming.events = auditTiming.passes.flatMap((pass) => pass.unit_ids.map((unitId, index) => {
    const durationMs = 250;
    const startedAt = Date.parse(pass.started_at) + index * durationMs;
    const completedAt = startedAt + durationMs;
    return {
      event_id: pass.event_ids[index],
      kind: 'work',
      pass_id: pass.id,
      session_id: auditTiming.session_id,
      unit_id: unitId,
      recording_source: M5_11_TIMING_RECORDER_VERSION,
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date(completedAt).toISOString(),
      recorded_at: new Date(completedAt).toISOString(),
    };
  }));
  auditTiming.recorder = {
    version: M5_11_TIMING_RECORDER_VERSION,
    session_id: auditTiming.session_id,
    event_count: auditTiming.events.length,
    event_log_sha256: sha256Json(auditTiming.events),
  };
  const auditTimingSource = fileSource('/tmp/m5-11-audit-timing.json', auditTiming);
  const finalSummary = {
    record_count: 3,
    start_count: 3,
    reference_only_count: 0,
    sense_count: 3,
    relation_count: 0,
    expression_count: 0,
  };
  const verification = {
    schema_version: '1',
    issue: 97,
    batch_id: BATCH_ID,
    editorial_review_complete: true,
    human_editorial_review_complete: true,
    canonical_integrity: true,
    deterministic_sqlite: true,
    search_product_regression: true,
    raw_material_excluded: true,
    reviewed_import_sha256: reviewedImportSource.sha256,
    editorial_sha256: editorialSource.sha256,
    proposal_sha256: proposalSource.sha256,
    relation_diff_sha256: relationDiffSource.sha256,
    final_canonical_summary: finalSummary,
    machine_generated: true,
    verifier_version: 'm5-11-prospective-verifier-v1',
    prospective_canonical_sha256: 'a'.repeat(64),
    checks: M5_11_MACHINE_CHECK_IDS.map((id) => ({
      id,
      status: 'pass',
      result_sha256: 'b'.repeat(64),
    })),
  };
  const verificationSource = fileSource('/tmp/m5-11-verification.json', verification);
  return {
    catalog,
    proposal,
    editorial,
    proposalSource,
    editorialSource,
    editorialTiming,
    editorialTimingSource,
    audit,
    auditSource,
    auditTiming,
    auditTimingSource,
    relationDiff,
    relationDiffSource,
    verification,
    verificationSource,
    reviewedImport: imported,
    reviewedImportSource,
  };
}

function makeBaseRecords() {
  return [{
    id: 'w001',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w001',
    lemma: '기존말',
    search_forms: ['기존말'],
    senses: [{ id: 'w001-s1', pos: 'noun', gloss: '기존 의미' }],
  }];
}

function makeRelationBaseRecords() {
  return [{
    id: 'w001',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w001',
    lemma: '기존말',
    search_forms: ['기존말'],
    senses: [{
      id: 'w001-s1',
      pos: 'noun',
      gloss: '기존 의미',
      relations: ['w002', 'w003', 'w004', 'w005'].map((id, index) => ({
        target: id,
        target_sense: `${id}-s1`,
        type: 'near',
      })),
    }],
  }, ...['w002', 'w003', 'w004', 'w005'].map((id) => ({
    id,
    record_type: 'entry',
    role: 'reference-only',
    lemma: `${id}참조`,
    search_forms: [`${id}참조`],
    senses: [{ id: `${id}-s1`, pos: 'noun', gloss: `${id} 참조 의미` }],
  }))];
}

function setTimingPassDuration(artifact, passId, durationMs, durationField = 'editor_seconds') {
  const pass = artifact.passes.find(({ id }) => id === passId);
  const startedMs = Date.parse(pass.started_at);
  pass.completed_at = new Date(startedMs + durationMs).toISOString();
  pass.wall_clock_seconds = durationMs / 1000;
  pass[durationField] = durationMs / 1000;
  const eventIds = new Set(pass.event_ids);
  const passEvents = artifact.events.filter(({ event_id: eventId }) => eventIds.has(eventId));
  const perEventMs = durationMs / passEvents.length;
  passEvents.forEach((event, index) => {
    const eventStartedMs = startedMs + index * perEventMs;
    const eventCompletedMs = eventStartedMs + perEventMs;
    event.started_at = new Date(eventStartedMs).toISOString();
    event.completed_at = new Date(eventCompletedMs).toISOString();
    event.recorded_at = event.completed_at;
  });
  artifact.recorder.event_log_sha256 = sha256Json(artifact.events);
}

function rebindFixtureSources(fixture) {
  fixture.proposalSource = fileSource(fixture.proposalSource.path, fixture.proposal);
  fixture.editorial.proposal_sha256 = sha256Json(fixture.proposal);
  fixture.editorial.proposal_count = fixture.proposal.proposals.length;
  fixture.editorialSource = fileSource(fixture.editorialSource.path, fixture.editorial);
  fixture.editorialTiming.source = {
    proposal_sha256: fixture.proposalSource.sha256,
    editorial_sha256: fixture.editorialSource.sha256,
  };
  fixture.editorialTimingSource = fileSource(
    fixture.editorialTimingSource.path,
    fixture.editorialTiming,
  );
  fixture.audit.source = {
    proposal_sha256: fixture.proposalSource.sha256,
    editorial_sha256: fixture.editorialSource.sha256,
  };
  fixture.auditSource = fileSource(fixture.auditSource.path, fixture.audit);
  fixture.auditTiming.source = {
    proposal_sha256: fixture.proposalSource.sha256,
    editorial_sha256: fixture.editorialSource.sha256,
    audit_sha256: fixture.auditSource.sha256,
    editorial_timing_sha256: fixture.editorialTimingSource.sha256,
  };
  fixture.auditTimingSource = fileSource(fixture.auditTimingSource.path, fixture.auditTiming);
  fixture.relationDiffSource = fileSource(fixture.relationDiffSource.path, fixture.relationDiff);
  fixture.verification.reviewed_import_sha256 = fixture.reviewedImportSource.sha256;
  fixture.verification.editorial_sha256 = fixture.editorialSource.sha256;
  fixture.verification.proposal_sha256 = fixture.proposalSource.sha256;
  fixture.verification.relation_diff_sha256 = fixture.relationDiffSource.sha256;
  fixture.verificationSource = fileSource(fixture.verificationSource.path, fixture.verification);
  return fixture;
}

test('M5-11 completed admission gate derives counts and passes the bounded thresholds', () => {
  const fixture = makeSources(makeCatalog());
  const result = deriveM511AdmissionGate({
    ...fixture,
    baseRecords: makeBaseRecords(),
    baseSummary: {
      record_count: 1,
      start_count: 1,
      reference_only_count: 0,
      sense_count: 1,
      relation_count: 0,
      expression_count: 0,
    },
    expectedImportedCount: 2,
    expectedCumulativeStartCount: 3,
    candidateBuffer: 2,
    checkPilotCompleteness: false,
  });

  assert.equal(result.gate.gate_status, 'pass');
  assert.equal(result.gate.decision, 'APPROVE BOUNDED');
  assert.deepEqual(result.decision_counts, {
    included: 1,
    corrected: 1,
    held: 1,
    rejected: 1,
    deferred: 0,
  });
  assert.equal(result.processed_start_count, 4);
  assert.equal(result.metrics.editor_seconds_per_processed_start, 1);
  assert.equal(result.final_summary.start_count, 3);
});

test('M5-11 promotion seed preserves the 500-plus-reserve decision state', () => {
  const fixture = makeSources(makeCatalog());
  const result = deriveM511AdmissionGate({
    ...fixture,
    baseRecords: makeBaseRecords(),
    baseSummary: {
      record_count: 1,
      start_count: 1,
      reference_only_count: 0,
      sense_count: 1,
      relation_count: 0,
      expression_count: 0,
    },
    expectedImportedCount: 2,
    expectedCumulativeStartCount: 3,
    candidateBuffer: 2,
    checkPilotCompleteness: false,
  });
  const promoted = buildM511PromotionSeed({
    seed: { schema_version: '1', inventory_id: 'm5-core-5k', revision: 'm5-11', targets: [] },
    catalog: fixture.catalog,
    proposalRows: result.proposal_rows,
    editorialDecisions: result.editorial_decisions,
  });

  assert.deepEqual(
    promoted.targets.map(({ inventory_id: inventoryId, status, planned_role, canonical_id: canonicalId }) => ({
      inventoryId,
      status,
      planned_role,
      canonicalId,
    })),
    [
      { inventoryId: 'm5-535', status: 'held', planned_role: 'start', canonicalId: undefined },
      { inventoryId: 'm5-536', status: 'rejected', planned_role: null, canonicalId: undefined },
      { inventoryId: 'm5-537', status: 'promoted', planned_role: 'start', canonicalId: 'w779' },
      { inventoryId: 'm5-538', status: 'promoted', planned_role: 'start', canonicalId: 'w780' },
    ],
  );
});

test('M5-11 gate accepts exact correction, relation-noise, and editor-time thresholds', () => {
  const fixture = makeSources(makeCatalog());
  const corrected = fixture.editorial.decisions[2];
  corrected.decision = 'corrected';
  corrected.corrected_lemma = '포함말수정';
  corrected.canonical_record.lemma = '포함말수정';
  corrected.canonical_record.search_forms = ['포함말수정'];
  corrected.canonical_record.senses[0].gloss = '포함말수정의 검수된 의미';
  fixture.relationDiff = {
    schema_version: '1',
    batch_id: BATCH_ID,
    before_count: 4,
    after_count: 0,
    events: Array.from({ length: 4 }, (_, index) => ({
      event_id: `${BATCH_ID}-event-${String(index + 1).padStart(4, '0')}`,
      relation_id: `${BATCH_ID}-relation-${index + 1}`,
      operation: 'remove',
      source_sense: 'w001-s1',
      before: {
        target: `w00${index + 2}`,
        target_sense: `w00${index + 2}-s1`,
        type: 'near',
      },
      ...(index === 0 ? { error_category: 'broad-common-category' } : {}),
    })),
  };
  fixture.editorialTiming.passes.forEach((pass) => {
    pass.editor_seconds = 0;
  });
  fixture.editorialTiming.passes[0].editor_seconds = 48;
  fixture.reviewedImport = fixture.editorial.decisions
    .filter(({ canonical_record: record }) => record)
    .map(({ canonical_record: record }) => record);
  const importBytes = Buffer.from(
    `${fixture.reviewedImport.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
  fixture.reviewedImportSource = fileSource(
    fixture.reviewedImportSource.path,
    fixture.reviewedImport,
    importBytes,
  );
  setTimingPassDuration(fixture.editorialTiming, 'target-preparation', 47992);
  setTimingPassDuration(fixture.editorialTiming, 'initial-review', 4);
  setTimingPassDuration(fixture.editorialTiming, 'final-verification', 2);
  setTimingPassDuration(fixture.editorialTiming, 'held-rejected', 2);
  fixture.verification.final_canonical_summary = {
    record_count: 7,
    start_count: 3,
    reference_only_count: 4,
    sense_count: 7,
    relation_count: 4,
    expression_count: 0,
  };
  fixture.verificationSource = fileSource(fixture.verificationSource.path, fixture.verification);
  rebindFixtureSources(fixture);

  const result = deriveM511AdmissionGate({
    ...fixture,
    baseRecords: makeRelationBaseRecords(),
    baseSummary: {
      record_count: 5,
      start_count: 1,
      reference_only_count: 4,
      sense_count: 5,
      relation_count: 4,
      expression_count: 0,
    },
    expectedImportedCount: 2,
    expectedCumulativeStartCount: 3,
    candidateBuffer: 2,
    checkPilotCompleteness: false,
  });

  assert.equal(result.metrics.correction_rate_of_selected, 0.5);
  assert.equal(result.metrics.relation_noise_rate_of_candidates, 0.25);
  assert.equal(result.metrics.editor_seconds_per_processed_start, 12);
  assert.equal(result.gate.gate_status, 'pass');
});

test('M5-11 gate rejects an editor-time threshold breach before promotion', () => {
  const fixture = makeSources(makeCatalog());
  fixture.editorialTiming.passes
    .filter(({ unit_ids: unitIds }) => unitIds.length > 0)
    .forEach(({ id }) => setTimingPassDuration(fixture.editorialTiming, id, 20000));
  fixture.editorialTimingSource = fileSource('/tmp/m5-11-editorial-timing-breach.json', fixture.editorialTiming);
  fixture.auditTiming.source.editorial_timing_sha256 = fixture.editorialTimingSource.sha256;
  fixture.auditTimingSource = fileSource('/tmp/m5-11-audit-timing-breach.json', fixture.auditTiming);

  const result = deriveM511AdmissionGate({
      ...fixture,
      baseRecords: makeBaseRecords(),
      baseSummary: {
        record_count: 1,
        start_count: 1,
        reference_only_count: 0,
        sense_count: 1,
        relation_count: 0,
        expression_count: 0,
      },
      expectedImportedCount: 2,
      expectedCumulativeStartCount: 3,
      candidateBuffer: 2,
      checkPilotCompleteness: false,
    });
  assert.equal(result.gate.gate_status, 'fail');
  assert.equal(result.gate.quality_passes.editor_seconds_per_selected_start, false);
});

test('M5-11 gate rejects an audit session reused from editorial timing', () => {
  const fixture = makeSources(makeCatalog());
  fixture.audit.session_id = fixture.editorialTiming.session_id;
  fixture.auditTiming.session_id = fixture.audit.session_id;
  fixture.auditTiming.recorder.session_id = fixture.auditTiming.session_id;
  fixture.auditTiming.events.forEach((event) => {
    event.session_id = fixture.auditTiming.session_id;
  });
  fixture.auditTiming.recorder.event_log_sha256 = sha256Json(fixture.auditTiming.events);
  fixture.auditSource = fileSource('/tmp/m5-11-audit-reused.json', fixture.audit);
  fixture.auditTiming.source.audit_sha256 = fixture.auditSource.sha256;
  fixture.auditTimingSource = fileSource('/tmp/m5-11-audit-timing-reused.json', fixture.auditTiming);

  assert.throws(
    () => deriveM511AdmissionGate({
      ...fixture,
      baseRecords: makeBaseRecords(),
      baseSummary: {
        record_count: 1,
        start_count: 1,
        reference_only_count: 0,
        sense_count: 1,
        relation_count: 0,
        expression_count: 0,
      },
      expectedImportedCount: 2,
      expectedCumulativeStartCount: 3,
      candidateBuffer: 2,
      checkPilotCompleteness: false,
    }),
    /distinct session/u,
  );
});

test('M5-11 promotion failure leaves canonical, seed, and inventory untouched', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-11-promotion-guard-'));
  const manifestPath = path.join(process.cwd(), `.m5-11-promotion-guard-${path.basename(temporaryDirectory)}.json`);
  const manifest = {
    schema_version: '1',
    issue: 97,
    batch_id: M5_11_BATCH_ID,
    gate: { gate_status: 'fail', decision: 'HOLD PROCESS' },
    promotion: {
      canonical_mutation: false,
      seed_mutation: false,
      inventory_mutation: false,
    },
  };
  const paths = {
    canonical: path.join(process.cwd(), 'data/canonical/m5-9-expansion.jsonl'),
    seed: path.join(process.cwd(), 'data/inventory/m5-target-seed.json'),
    inventory: path.join(process.cwd(), 'data/inventory/m5-target-inventory.json'),
  };
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    const before = await Promise.all(Object.values(paths).map((filePath) => readFile(filePath)));
    await assert.rejects(
      promoteM511({ manifestPath }),
      /only a passing APPROVE BOUNDED admission manifest/u,
    );
    const after = await Promise.all(Object.values(paths).map((filePath) => readFile(filePath)));
    after.forEach((bytes, index) => assert.deepEqual(bytes, before[index]));
  } finally {
    await rm(manifestPath, { force: true });
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('M5-11 admission rejects repository-local external review inputs', async () => {
  const input = 'data/batches/m5-11-review.json';
  await assert.rejects(
    validateM511Admission({
      proposalPath: input,
      editorialDecisionPath: input,
      editorialTimingPath: input,
      auditPath: input,
      auditTimingPath: input,
      relationDiffPath: input,
      verificationPath: input,
      reviewedImportPath: input,
    }),
    /must remain outside the repository/u,
  );
});

test('M5-11 timing rejects fabricated editor seconds without recorder events', () => {
  const fixture = makeSources(makeCatalog());
  fixture.editorialTiming.passes[0].editor_seconds = 999;
  assert.throws(
    () => deriveM511AdmissionGate({
      ...fixture,
      baseRecords: makeBaseRecords(),
      baseSummary: {
        record_count: 1,
        start_count: 1,
        reference_only_count: 0,
        sense_count: 1,
        relation_count: 0,
        expression_count: 0,
      },
      expectedImportedCount: 2,
      expectedCumulativeStartCount: 3,
      candidateBuffer: 2,
      checkPilotCompleteness: false,
    }),
    /recorder-derived duration/u,
  );
});

test('M5-11 verification rejects literal pass claims without machine checks', () => {
  const fixture = makeSources(makeCatalog());
  fixture.verification.checks = [{ id: 'all-m5-11-checks', status: 'pass' }];
  assert.throws(
    () => deriveM511AdmissionGate({
      ...fixture,
      baseRecords: makeBaseRecords(),
      baseSummary: {
        record_count: 1,
        start_count: 1,
        reference_only_count: 0,
        sense_count: 1,
        relation_count: 0,
        expression_count: 0,
      },
      expectedImportedCount: 2,
      expectedCumulativeStartCount: 3,
      candidateBuffer: 2,
      checkPilotCompleteness: false,
    }),
    /checks/u,
  );
});

test('M5-11 relation evidence rejects an imported relation omitted from the diff', () => {
  const fixture = makeSources(makeCatalog());
  const admitted = fixture.editorial.decisions[2];
  admitted.decision = 'corrected';
  admitted.corrected_lemma = '포함말수정';
  admitted.canonical_record.lemma = '포함말수정';
  admitted.canonical_record.search_forms = ['포함말수정'];
  admitted.canonical_record.senses[0].gloss = '포함말수정의 검수된 의미';
  admitted.canonical_record.senses[0].relations = [{
    target: 'w001',
    target_sense: 'w001-s1',
    type: 'near',
  }];
  fixture.editorialSource = fileSource(fixture.editorialSource.path, fixture.editorial);
  fixture.reviewedImport = fixture.editorial.decisions
    .filter(({ canonical_record: record }) => record)
    .map(({ canonical_record: record }) => record);
  fixture.reviewedImportSource = fileSource(
    fixture.reviewedImportSource.path,
    fixture.reviewedImport,
    Buffer.from(`${fixture.reviewedImport.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8'),
  );
  rebindFixtureSources(fixture);
  assert.throws(
    () => deriveM511AdmissionGate({
      ...fixture,
      baseRecords: makeBaseRecords(),
      baseSummary: {
        record_count: 1,
        start_count: 1,
        reference_only_count: 0,
        sense_count: 1,
        relation_count: 0,
        expression_count: 0,
      },
      expectedImportedCount: 2,
      expectedCumulativeStartCount: 3,
      candidateBuffer: 2,
      checkPilotCompleteness: false,
    }),
    /absent from the relation diff/u,
  );
});

test('M5-11 post-promotion validation uses portable durable evidence after external inputs disappear', () => {
  const sharedSource = (sourceId, sourcePath) => ({
    source_id: sourceId,
    path: sourcePath,
    sha256: 'a'.repeat(64),
  });
  const sources = Object.fromEntries([
    ['proposal', sharedSource('proposal', 'external:proposal')],
    ['editorial', sharedSource('editorial', 'external:editorial')],
    ['editorial_timing', sharedSource('editorial_timing', 'external:editorial_timing')],
    ['audit', sharedSource('audit', 'external:audit')],
    ['audit_timing', sharedSource('audit_timing', 'external:audit_timing')],
    ['relation_diff', sharedSource('relation_diff', 'external:relation_diff')],
    ['verification', sharedSource('verification', 'external:verification')],
    ['reviewed_import', sharedSource('reviewed_import', 'external:reviewed_import')],
    ['authorization', sharedSource('authorization', 'data/batches/m5-10d-m5-11-authorization-20260912.json')],
    ['base_inventory', sharedSource('base_inventory', 'data/batches/m5-11-base-inventory.json')],
  ]);
  const base = {
    record_count: 820,
    start_count: 778,
    reference_only_count: 42,
    sense_count: 966,
    relation_count: 473,
    expression_count: 63,
  };
  const actual = {
    record_count: 1320,
    start_count: 1278,
    reference_only_count: 42,
    sense_count: 1466,
    relation_count: 700,
    expression_count: 100,
  };
  const gate = { gate_status: 'pass', decision: 'APPROVE BOUNDED' };
  const target = {
    net_start_increase: 500,
    cumulative_start_target: 1278,
    candidate_buffer: 50,
    selected_start_count: 550,
  };
  const metrics = { editor_seconds_per_processed_start: 10 };
  const relation = { noise_rate_of_candidates: 0.1 };
  const timing = { status: 'complete' };
  const audit = { status: 'complete', independent: true, open_blocker_count: 0 };
  const verification = { machine_generated: true };
  const manifest = {
    schema_version: '1',
    issue: 97,
    batch_id: M5_11_BATCH_ID,
    gate,
    target,
    base,
    actual,
    metrics,
    relation,
    timing,
    audit,
    verification,
    authorization: 'AUTHORIZE M5-11 +500 VALIDATION',
    sources,
  };
  const evidence = {
    schema_version: '1',
    issue: 97,
    batch_id: M5_11_BATCH_ID,
    gate,
    target,
    base: {
      summary: base,
      canonical_directory_sha256: '14ab89dcb9e21626515d982ea172ea77144ea07ec816fc50a1b17e7fd0567473',
      inventory_sha256: '2d6ec1f03ce4c52bb16509354e501d2e1e10dc684bc068b995b9cead1f4eb947',
      seed_sha256: 'bda4bec9be8e90fca1c16e6aa4979bbf242342534856b8bacc9b91dd276da0e9',
    },
    actual,
    metrics,
    relation,
    timing,
    audit,
    verification,
    authorization: manifest.authorization,
    decisions: {
      included: 400,
      corrected: 100,
      held: 20,
      rejected: 10,
      deferred: 20,
      processed_start_count: 530,
      imported_start_count: 500,
    },
    stage: {
      status: 'passed',
      target: { net_start_increase: 500, cumulative_start_target: 1278 },
    },
    sources,
    outputs: {},
    promotion: {
      canonical_mutation: true,
      seed_mutation: true,
      inventory_mutation: true,
      explicit: true,
    },
  };
  assert.deepEqual(
    validateM511DurableEvidence({ manifest, evidence }).summary,
    actual,
  );
});
