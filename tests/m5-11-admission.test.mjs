import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  M5_11_AUDIT_TIMING_PASS_IDS,
  M5_11_EDITORIAL_TIMING_PASS_IDS,
  M5_11_MACHINE_CHECK_IDS,
  M5_11_PROSPECTIVE_VERIFIER_VERSION,
  M5_11_TIMING_CLOCK_SOURCE,
  M5_11_TIMING_LIFECYCLE_VERSION,
  M5_11_TIMING_PROVENANCE_ALGORITHM,
  M5_11_TIMING_PROVENANCE_VERSION,
  M5_11_TIMING_RECORDING_COMMAND,
  M5_11_TIMING_RECORDER_VERSION,
  createM511TimingProof,
  deriveM511AdmissionGate,
  runM511ProspectiveVerification,
  validateM511TimingArtifact,
  validateM511Admission,
  validateM511VerificationArtifact,
} from '../scripts/batch/validate-m5-11-admission.mjs';
import {
  buildM511PromotionSeed,
  commitM511PromotionTransaction,
  promoteM511,
  verifySemanticDecisionSource,
} from '../scripts/batch/promote-m5-11.mjs';
import { main as recordM511Timing } from '../scripts/batch/record-m5-11-timing.mjs';
import { validateM511DurableEvidence } from '../scripts/batch/validate-m5-11-promotion.mjs';
import {
  M5_11_BATCH_ID,
  M5_11_AGENT_SEMANTIC_REVIEW_VERSION,
  evaluateM511SemanticCoverage,
  rebaseM511CandidateRecord,
  sha256Json,
  sha256ProposalRow,
  validateM511EditorialDecisions,
} from '../scripts/batch/m5-11-editorial.mjs';
import { compareRelationSnapshots } from '../scripts/batch/relation-diff.mjs';
import {
  inspectGlossConnectors,
  inspectWriterDomainEvidence,
} from '../scripts/validate/lexical-quality.mjs';
import { inspectSenseBoundaryPairs } from '../scripts/validate/sense-boundary.mjs';
import { readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';
import {
  DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
  buildCanonicalSemanticAudit,
  canonicalRecordsSha256,
  serializeSemanticAuditArtifact,
  validateCanonicalSemanticAudit,
} from '../scripts/validate/semantic-audit.mjs';
import {
  buildTargetInventory,
  serializeTargetInventory,
} from '../scripts/inventory/generate-target-inventory.mjs';
import { hashCanonicalDirectory } from '../scripts/batch/validate-m5-8-process.mjs';
import {
  makeProductionState,
  makeSemanticAudit,
} from './helpers/semantic-audit-fixture.mjs';

const BATCH_ID = 'm5-11-expansion-20260913';

function fileSource(path, value, bytes = Buffer.from(JSON.stringify(value), 'utf8')) {
  return {
    path,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    value,
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createM511PromotionTransactionFixture() {
  const temporaryDirectory = await mkdtemp(path.join(process.cwd(), '.m5-11-semantic-authority-'));
  const currentCanonicalDirectory = path.join(temporaryDirectory, 'current-canonical');
  const prospectiveDirectory = path.join(temporaryDirectory, 'prospective');
  const prospectiveCanonicalDirectory = path.join(prospectiveDirectory, 'canonical');
  const currentSeedPath = path.join(temporaryDirectory, 'current-seed.json');
  const prospectiveSeedPath = path.join(prospectiveDirectory, 'seed.json');
  const canonicalImportPath = path.join(currentCanonicalDirectory, 'm5-11-expansion.jsonl');
  const promotionEvidencePath = path.join(temporaryDirectory, 'promotion.json');
  const initialSeedBytes = Buffer.from('base seed placeholder\n', 'utf8');

  await cp('data/batches/m5-11-base-canonical', currentCanonicalDirectory, { recursive: true });
  await cp('data/batches/m5-11-base-canonical', prospectiveCanonicalDirectory, { recursive: true });
  const importBytes = await readFile('data/canonical/m5-11-expansion.jsonl');
  const currentSeed = JSON.parse(await readFile('data/inventory/m5-target-seed.json', 'utf8'));
  currentSeed.revision = 'm5-11';
  currentSeed.targets = currentSeed.targets.filter(({ inventory_id: inventoryId }) => {
    const number = Number(inventoryId.slice(3));
    return !(inventoryId.startsWith('m5-') && number >= 1085 && number <= 1886);
  });
  const seedBytes = Buffer.from(`${JSON.stringify(currentSeed, null, 2)}\n`, 'utf8');
  await writeFile(path.join(prospectiveCanonicalDirectory, 'm5-11-expansion.jsonl'), importBytes);
  await writeFile(prospectiveSeedPath, seedBytes);
  await writeFile(currentSeedPath, initialSeedBytes);

  // M5-11 is a historical 1,320-record boundary. The live decision source
  // now includes the promoted M5-12A rows, so derive the exact historical
  // source in this isolated fixture instead of binding an older snapshot to
  // a newer canonical authority.
  const historicalDecisionSourcePath = path.join(temporaryDirectory, 'm5-11-decision-source.json');
  const historicalCanonical = await readCanonicalRecords(prospectiveCanonicalDirectory);
  const historicalIds = new Set(historicalCanonical.records.map(({ record }) => record.id));
  const historicalDecisionSource = JSON.parse(
    await readFile(DEFAULT_SEMANTIC_DECISION_SOURCE_PATH, 'utf8'),
  );
  const historicalReview = historicalDecisionSource.authored_review;
  const historicalRecords = historicalCanonical.records.map(({ record }) => record);
  const historicalSenseCount = historicalRecords.reduce((sum, record) => sum + record.senses.length, 0);
  const historicalDigest = canonicalRecordsSha256(historicalCanonical.records);
  historicalReview.records = historicalReview.records.filter(({ record_id: recordId }) => historicalIds.has(recordId));
  historicalReview.record_count = historicalRecords.length;
  historicalReview.sense_count = historicalSenseCount;
  historicalReview.source.canonical_records_sha256 = historicalDigest;
  historicalReview.review_pass.record_count = historicalRecords.length;
  historicalReview.review_pass.sense_count = historicalSenseCount;
  historicalDecisionSource.source.canonical_records_sha256 = historicalDigest;
  historicalDecisionSource.authored_review_sha256 = sha256Json(historicalReview);
  await writeFile(
    historicalDecisionSourcePath,
    `${JSON.stringify(historicalDecisionSource, null, 2)}\n`,
    'utf8',
  );

  const { artifact } = await buildCanonicalSemanticAudit({
    canonicalDirectory: prospectiveCanonicalDirectory,
    decisionSourcePath: historicalDecisionSourcePath,
  });
  const semanticAuditBytes = serializeSemanticAuditArtifact(artifact);
  const prospectiveInventoryBytes = serializeTargetInventory(await buildTargetInventory({
    canonicalDirectory: prospectiveCanonicalDirectory,
    seedPath: prospectiveSeedPath,
    generatedFromCanonicalDirectory: currentCanonicalDirectory,
    generatedFromSeedPath: currentSeedPath,
    canonicalScopeDirectory: currentCanonicalDirectory,
  }));

  return {
    temporaryDirectory,
    currentCanonicalDirectory,
    currentSeedPath,
    canonicalImportPath,
    promotionEvidencePath,
    historicalDecisionSourcePath,
    initialSeedBytes,
    semanticAuditBytes,
    prospective: {
      temporaryDirectory: prospectiveDirectory,
      importBytes,
      seedBytes,
      canonicalDigest: await hashCanonicalDirectory(prospectiveCanonicalDirectory),
      seedSha256: sha256(seedBytes),
      inventorySha256: sha256(prospectiveInventoryBytes),
    },
  };
}

function promotionForTransactionFixture({ prospective, semanticAuditBytes }) {
  return {
    outputs: {
      seed: { sha256: prospective.seedSha256 },
      inventory: { sha256: prospective.inventorySha256 },
      semantic_audit: { sha256: sha256(semanticAuditBytes) },
    },
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
  const authoredGlosses = [
    '보류말은 비 갠 골목에 남은 느린 여운을 가리킨다.',
    '거절말은 낮은 계단 앞에서 멈춘 단호한 태도를 가리킨다.',
    '포함말은 열린 우편함에서 발견되는 뜻밖의 안도를 가리킨다.',
    '수정말은 비어 있는 정류장에 남은 오래된 다짐을 가리킨다.',
  ];
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
        gloss: authoredGlosses[index],
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

function syncTimingLifecycle(artifact) {
  const firstPass = artifact.passes[0];
  const finalPass = artifact.passes.at(-1);
  const startEvent = artifact.recorder_events.find(({ pass_id: passId, kind }) => (
    passId === firstPass.id && kind === 'start'
  ));
  const stopEvent = artifact.recorder_events.find(({ pass_id: passId, kind }) => (
    passId === finalPass.id && kind === 'stop'
  ));
  const sourceKey = artifact.timing_kind === 'editorial' ? 'editorial_sha256' : 'audit_sha256';
  Object.assign(artifact.recorder.lifecycle, {
    session_started_at: firstPass.started_at,
    session_start_event_id: startEvent.event_id,
    artifact_bound_at: finalPass.completed_at,
    artifact_bound_event_id: stopEvent.event_id,
    artifact_bound_pass_id: finalPass.id,
    artifact_sha256: artifact.source[sourceKey],
  });
}

function signTimingArtifact(artifact) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  artifact.recorder.provenance = {
    version: M5_11_TIMING_PROVENANCE_VERSION,
    algorithm: M5_11_TIMING_PROVENANCE_ALGORITHM,
    public_key_spki_base64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    signed_recording_proof_sha256: null,
    signature_base64: null,
  };
  artifact.recording_proof_sha256 = createM511TimingProof(artifact);
  artifact.recorder.provenance.signed_recording_proof_sha256 = artifact.recording_proof_sha256;
  artifact.recorder.provenance.signature_base64 = sign(
    null,
    Buffer.from(artifact.recording_proof_sha256, 'utf8'),
    privateKey,
  ).toString('base64');
}

function makeTimingArtifact({ timingKind, sessionId, source, passes, startAt }) {
  let cursor = Date.parse(startAt);
  const artifact = {
    schema_version: '1',
    issue: 97,
    batch_id: BATCH_ID,
    timing_kind: timingKind,
    session_id: sessionId,
    source,
    recorder_version: M5_11_TIMING_RECORDER_VERSION,
    recording_source: M5_11_TIMING_RECORDER_VERSION,
    recorder_command: M5_11_TIMING_RECORDING_COMMAND,
    clock_source: M5_11_TIMING_CLOCK_SOURCE,
    passes: [],
    events: [],
    recorder_events: [],
  };

  for (const { id, unitIds, durationMs } of passes) {
    const startedAt = new Date(cursor).toISOString();
    const completedAt = new Date(cursor + durationMs).toISOString();
    const eventIds = unitIds.map((_, index) => `${id}-event-${index + 1}`);
    const pass = {
      id,
      status: 'complete',
      unit_ids: unitIds,
      unit_count: unitIds.length,
      event_ids: eventIds,
      wall_clock_seconds: durationMs / 1000,
      ...(timingKind === 'editorial'
        ? { editor_seconds: unitIds.length === 0 ? 0 : durationMs / 1000 }
        : { audit_seconds: unitIds.length === 0 ? 0 : durationMs / 1000 }),
      started_at: startedAt,
      completed_at: completedAt,
      recording_source: M5_11_TIMING_RECORDER_VERSION,
    };
    artifact.passes.push(pass);
    artifact.recorder_events.push({
      event_id: `${id}-start`,
      pass_id: id,
      kind: 'start',
      session_id: sessionId,
      at: startedAt,
    });
    if (unitIds.length > 0) {
      const perEventMs = durationMs / unitIds.length;
      unitIds.forEach((unitId, index) => {
        const eventStartedAt = new Date(cursor + index * perEventMs).toISOString();
        const eventCompletedAt = new Date(cursor + (index + 1) * perEventMs).toISOString();
        artifact.events.push({
          event_id: eventIds[index],
          kind: 'work',
          pass_id: id,
          session_id: sessionId,
          unit_id: unitId,
          recording_source: M5_11_TIMING_RECORDER_VERSION,
          started_at: eventStartedAt,
          completed_at: eventCompletedAt,
          recorded_at: eventCompletedAt,
        });
      });
    }
    artifact.recorder_events.push({
      event_id: `${id}-stop`,
      pass_id: id,
      kind: 'stop',
      session_id: sessionId,
      at: completedAt,
    });
    cursor += durationMs;
  }

  artifact.recorder = {
    version: M5_11_TIMING_RECORDER_VERSION,
    session_id: sessionId,
    event_count: artifact.events.length,
    event_log_sha256: sha256Json(artifact.events),
    recorder_event_count: artifact.recorder_events.length,
    recorder_event_log_sha256: sha256Json(artifact.recorder_events),
    provenance: {},
    lifecycle: {
      version: M5_11_TIMING_LIFECYCLE_VERSION,
      artifact_kind: timingKind === 'editorial' ? 'editorial-decisions' : 'independent-audit',
      binding_mode: 'start-before-artifact-finalization',
      artifact_path: `/tmp/m5-11-${timingKind}-bound-artifact.json`,
      artifact_existed_at_session_start: false,
      artifact_bound_at_stop: true,
      session_started_at: artifact.passes[0]?.started_at,
      session_start_event_id: artifact.recorder_events[0]?.event_id,
      artifact_bound_at: artifact.passes.at(-1)?.completed_at,
      artifact_bound_event_id: artifact.recorder_events.at(-1)?.event_id,
      artifact_bound_pass_id: artifact.passes.at(-1)?.id,
      artifact_sha256: source[timingKind === 'editorial' ? 'editorial_sha256' : 'audit_sha256'],
      artifact_byte_count: 1,
      private_key_path: null,
    },
  };
  signTimingArtifact(artifact);
  return artifact;
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
  const editorialTiming = makeTimingArtifact({
    timingKind: 'editorial',
    sessionId: '11111111-1111-4111-8111-111111111111',
    source: {
      proposal_sha256: proposalSource.sha256,
      editorial_sha256: editorialSource.sha256,
    },
    startAt: '2026-09-13T10:00:00.000Z',
    passes: M5_11_EDITORIAL_TIMING_PASS_IDS.map((id) => ({
      id,
      unitIds: id === 'final-verification'
        ? ['m5-537', 'm5-538']
        : id === 'held-rejected'
          ? ['m5-535', 'm5-536']
          : id === 'feedback-fixes'
            ? []
            : catalog.map(({ inventory_id: inventoryId }) => inventoryId),
      durationMs: id === 'feedback-fixes' ? 0 : 1000,
    })),
  });
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
  const auditTiming = makeTimingArtifact({
    timingKind: 'post-freeze-audit',
    sessionId: audit.session_id,
    source: {
      proposal_sha256: proposalSource.sha256,
      editorial_sha256: editorialSource.sha256,
      audit_sha256: auditSource.sha256,
      editorial_timing_sha256: editorialTimingSource.sha256,
    },
    startAt: '2026-09-13T11:00:00.000Z',
    passes: M5_11_AUDIT_TIMING_PASS_IDS.map((id) => ({
      id,
      unitIds: catalog.map(({ inventory_id: inventoryId }) => inventoryId),
      durationMs: 1000,
    })),
  });
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
    verifier_version: M5_11_PROSPECTIVE_VERIFIER_VERSION,
    prospective_canonical_sha256: 'a'.repeat(64),
    checks: M5_11_MACHINE_CHECK_IDS.map((id) => ({
      id,
      status: 'pass',
      result_sha256: 'b'.repeat(64),
    })),
  };
  const verificationSource = fileSource('/tmp/m5-11-verification.json', verification);
  const semanticAuditResult = makeSemanticAuditSource(makeBaseRecords(), imported);
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
    semanticAudit: semanticAuditResult.value,
    semanticAuditSource: semanticAuditResult.source,
  };
}

function makeAgentSources(catalog) {
  const fixture = makeSources(catalog);
  const relationId = 'm5-11-agent-relation-1';
  const relation = {
    target: 'w001',
    target_sense: 'w001-s1',
    type: 'near',
  };
  fixture.proposal.proposals[2].candidate_record.senses[0].relations = [relation];
  fixture.proposal.proposals[2].proposal_sha256 = sha256ProposalRow(fixture.proposal.proposals[2]);
  fixture.editorial = structuredClone(fixture.editorial);
  fixture.editorial.decisions[2].candidate_proposal_sha256 = fixture.proposal.proposals[2].proposal_sha256;
  fixture.editorial.decisions[2].canonical_record.senses[0].relations = [relation];
  Object.assign(fixture.editorial, {
    review_mode: 'agent-generated',
    editorial_review_complete: true,
    automated_editorial_review_complete: true,
    human_editorial_review_complete: false,
    gate_decision: 'APPROVE AUTOMATED BOUNDED',
    provenance: {
      kind: 'agent_generated',
      generator: 'codex',
      generator_version: 'm5-11a-agent-editorial-v2',
      pass_id: 'agent-generation-pass',
    },
  });
  fixture.relationDiff = compareRelationSnapshots({
    batchId: BATCH_ID,
    before: [],
    after: [{
      id: relationId,
      source_sense: 'w779-s1',
      ...relation,
    }],
    candidateReviews: [{
      candidate_id: 'm5-537',
      relation_id: relationId,
      source_sense: 'w779-s1',
      relation,
      decision: 'admit',
      review_note: 'w779-s1 relation was retained as a writer-useful action link to w001-s1',
    }],
  });
  const ranks = [3, 4, 1, 2];
  const scores = [80, 70, 100, 99];
  fixture.editorial.decisions.forEach((decision, index) => {
    const catalogEntry = catalog[index];
    const proposalRecord = fixture.proposal.proposals[index].candidate_record;
    const record = decision.canonical_record ?? proposalRecord;
    const imported = decision.canonical_record !== undefined;
    const producerCandidate = imported
      ? rebaseM511CandidateRecord(proposalRecord, record.id)
      : proposalRecord;
    const decisionSourceId = `${catalogEntry.inventory_id}:decision-source`;
    const boundaryAction = record.senses.length > 1 ? 'split' : 'retain';
    const boundaryClassification = record.senses.length > 1 ? 'separated' : 'atomic';
    const selectionScore = scores[index];
    const sourceSha256 = sha256Json({
      candidate_record_sha256: sha256Json(producerCandidate),
      reviewed_record_sha256: sha256Json(record),
      decision: decision.decision,
      selection_rank: ranks[index],
      selection_score: selectionScore,
    });
    const pairwise = inspectSenseBoundaryPairs(record).map((pair) => {
      const leftSense = record.senses.find(({ id }) => id === pair.left_sense_id);
      const rightSense = record.senses.find(({ id }) => id === pair.right_sense_id);
      const leftGlossSha256 = sha256Json(leftSense.gloss);
      const rightGlossSha256 = sha256Json(rightSense.gloss);
      return {
        left_sense_id: pair.left_sense_id,
        right_sense_id: pair.right_sense_id,
        relationship: pair.relationship,
        decision: 'retain',
        left_gloss_sha256: leftGlossSha256,
        right_gloss_sha256: rightGlossSha256,
        evidence_basis: 'M5-11 fixture pair was explicitly reviewed from both glosses',
        distinguishing_feature: 'M5-11 fixture pair has separate writer-facing usage conditions',
        decision_source_id: decisionSourceId,
        rationale: `${record.id} ${pair.left_sense_id} ${pair.right_sense_id} pair cites ${leftGlossSha256.slice(0, 12)} and ${rightGlossSha256.slice(0, 12)}.`,
      };
    });
    decision.semantic_review = {
      version: M5_11_AGENT_SEMANTIC_REVIEW_VERSION,
      status: 'complete',
      decision_source: {
        kind: 'separately-authored-semantic-decision-source',
        contract_version: 'lexical-semantic-decision-source-v1',
        source_id: decisionSourceId,
        path: `tests/fixtures/${catalogEntry.inventory_id}-decision-source.json`,
        authoring_mode: 'agent-authored-decision',
        source_sha256: sourceSha256,
      },
      authored_decision: {
        source_sha256: sourceSha256,
        decision_source_id: decisionSourceId,
        candidate_record_id: producerCandidate.id,
        candidate_record_sha256: sha256Json(producerCandidate),
        reviewed_record_sha256: sha256Json(record),
        decision: decision.decision,
        selection_rank: ranks[index],
        selection_score: selectionScore,
        rationale: `${catalogEntry.inventory_id} was selected from the separately authored M5-11 fixture decision source.`,
        sense_evidence: record.senses.map((sense) => ({
          sense_id: sense.id,
          gloss_sha256: sha256Json(sense.gloss),
          basis: `${catalogEntry.inventory_id} ${sense.id} gloss and writer-facing use were explicitly reviewed.`,
        })),
        relation_evidence: record.senses.map((sense) => {
          const relationCount = sense.relations?.length ?? 0;
          return {
            sense_id: sense.id,
            relation_count: relationCount,
            decision: relationCount === 0 ? 'no-relations' : 'relations-reviewed',
            basis: `${catalogEntry.inventory_id} ${sense.id} relation outcome was explicitly reviewed.`,
          };
        }),
      },
      axis: catalogEntry.axis,
      flags: [...catalogEntry.flags],
      sense_boundary: {
        status: 'pass',
        decision_source_id: decisionSourceId,
        review_id: `${catalogEntry.inventory_id}:boundary`,
        method: 'gloss-and-usage-pairwise-v2',
        independence: {
          independent_of_sense_count: true,
          source: 'separately-authored-m5-11-fixture-boundary-decision',
          decision_source_id: decisionSourceId,
          decision_source_version: 'lexical-semantic-boundary-decisions-v1',
        },
        findings: record.senses.map((sense) => ({
          sense_id: sense.id,
          action: boundaryAction,
          classification: boundaryClassification,
          rationale: `${catalogEntry.inventory_id} ${sense.id} boundary was explicitly authored after verification`,
          semantic_evidence: {
            status: 'pass',
            gloss_sha256: sha256Json(sense.gloss),
            observed_domain_axes: inspectWriterDomainEvidence(sense.gloss).axes,
            domain_evidence: inspectWriterDomainEvidence(sense.gloss).matches,
            connector_observations: inspectGlossConnectors(sense.gloss),
            rationale: `${catalogEntry.inventory_id} ${sense.id} domain evidence was checked`,
            boundary_decision: inspectWriterDomainEvidence(sense.gloss).axes.length > 1
              ? 'coordinated'
              : boundaryAction === 'split' ? 'split' : 'atomic',
            decision_source_id: decisionSourceId,
          },
        })),
        pairwise,
        rationale: `${record.id} boundary was authored independently of the current sense count`,
      },
      pos: {
        status: 'pass',
        decision: 'verified',
        observed_pos: record.senses.map(({ pos }) => pos),
        decision_source_id: decisionSourceId,
        rationale: `${catalogEntry.inventory_id} POS was verified against every sense`,
      },
      expression: {
        status: 'pass',
        decision: 'verified',
        expected_record_type: 'entry',
        observed_record_type: record.record_type,
        decision_source_id: decisionSourceId,
        rationale: `${catalogEntry.inventory_id} verification classified this candidate as an entry`,
      },
      relation: {
        status: 'pass',
        decision_source_id: decisionSourceId,
        per_sense: record.senses.map((sense) => ({
          sense_id: sense.id,
          decision: sense.relations?.length ? 'relations-reviewed' : 'no-relations',
          decision_source_id: decisionSourceId,
          relation_count: sense.relations?.length ?? 0,
          relation_ids: sense.relations?.length ? [relationId] : [],
          ...(sense.relations?.length
            ? {}
            : { no_relation_rationale: `${catalogEntry.inventory_id} ${sense.id} has no validated relation tuple` }),
        })),
      },
      selection: {
        status: imported ? 'selected' : decision.decision,
        rank: ranks[index],
        score: selectionScore,
        rationale: `${catalogEntry.inventory_id} selected by verification and coverage outcome`,
      },
    };
    if (!record.senses.some(({ relations }) => relations?.length)) {
      decision.semantic_review.relation.per_sense.forEach((senseDecision) => {
        delete senseDecision.relation_ids;
        senseDecision.relation_ids = [];
      });
    }
  });
  fixture.proposalSource = fileSource(fixture.proposalSource.path, fixture.proposal);
  fixture.editorial.proposal_sha256 = sha256Json(fixture.proposal);
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
  fixture.editorialSource = fileSource('/tmp/m5-11-agent-editorial.json', fixture.editorial);
  fixture.relationDiffSource = fileSource('/tmp/m5-11-agent-relation-diff.json', fixture.relationDiff);
  const editorialResult = validateM511EditorialDecisions(fixture.editorial, {
    catalog,
    proposal: fixture.proposal,
    expectedImportedCount: 2,
  });
  const semanticCoverage = evaluateM511SemanticCoverage({
    semantic: editorialResult.semantic,
    catalog,
    expectedImportedCount: 2,
  });
  fixture.verification = structuredClone(fixture.verification);
  Object.assign(fixture.verification, {
    review_mode: 'agent-generated',
    automated_editorial_review_complete: true,
    human_editorial_review_complete: false,
    generation_verification_separated: true,
    generation_pass_id: 'agent-generation-pass',
    verification_pass_id: 'agent-verification-pass',
    generation_editorial_sha256: fixture.editorialSource.sha256,
    provenance: {
      kind: 'agent_generated',
      generator: 'codex',
      generator_version: 'm5-11a-agent-editorial-v2',
      pass_id: 'agent-verification-pass',
    },
    semantic_quality_complete: true,
    semantic_summary: editorialResult.semantic,
    semantic_coverage: semanticCoverage,
    semantic_findings: editorialResult.semantic_findings,
    semantic_finding_count: editorialResult.semantic_findings.length,
    semantic_findings_sha256: sha256Json(editorialResult.semantic_findings),
    machine_check_evidence: Object.fromEntries(
      M5_11_MACHINE_CHECK_IDS.map((id) => [id, { observed: true }]),
    ),
  });
  fixture.verification.final_canonical_summary.relation_count = 1;
  fixture.verification.machine_check_evidence['semantic-quality'] = {
    status: 'pass',
    summary: editorialResult.semantic,
    coverage: semanticCoverage,
  };
  fixture.verification.editorial_sha256 = fixture.editorialSource.sha256;
  fixture.verification.proposal_sha256 = fixture.proposalSource.sha256;
  fixture.verification.relation_diff_sha256 = fixture.relationDiffSource.sha256;
  fixture.verification.reviewed_import_sha256 = fixture.reviewedImportSource.sha256;
  fixture.verificationSource = fileSource('/tmp/m5-11-agent-verification.json', fixture.verification);
  const semanticAuditResult = makeSemanticAuditSource(
    makeBaseRecords(),
    fixture.reviewedImport,
    '/tmp/m5-11-agent-semantic-audit.json',
  );
  fixture.semanticAudit = semanticAuditResult.value;
  fixture.semanticAuditSource = semanticAuditResult.source;
  return fixture;
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

function makeSemanticAuditSource(baseRecords, importedRecords, filePath = '/tmp/m5-11-semantic-audit.json') {
  const recordInfos = [
    ...baseRecords.map((record) => ({ record, source: 'base' })),
    ...importedRecords.map((record) => ({ record, source: 'reviewed-import' })),
  ];
  const value = makeSemanticAudit(recordInfos);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return {
    value,
    source: fileSource(filePath, value, bytes),
  };
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
  pass.wall_clock_seconds = durationMs / 1000;
  pass[durationField] = durationMs / 1000;
  const firstStartedMs = Date.parse(artifact.passes[0].started_at);
  let cursor = firstStartedMs;
  for (const currentPass of artifact.passes) {
    const currentDurationMs = Math.round(currentPass.wall_clock_seconds * 1000);
    const currentStartedMs = cursor;
    const currentCompletedMs = currentStartedMs + currentDurationMs;
    currentPass.started_at = new Date(currentStartedMs).toISOString();
    currentPass.completed_at = new Date(currentCompletedMs).toISOString();
    const passEvents = artifact.events.filter(({ event_id: eventId }) => currentPass.event_ids.includes(eventId));
    let eventCursor = currentStartedMs;
    passEvents.forEach((event, index) => {
      const remainingEvents = passEvents.length - index;
      const remainingMs = currentCompletedMs - eventCursor;
      const eventDurationMs = Math.floor(remainingMs / remainingEvents);
      const eventStartedMs = eventCursor;
      const eventCompletedMs = index === passEvents.length - 1
        ? currentCompletedMs
        : eventStartedMs + eventDurationMs;
      event.started_at = new Date(eventStartedMs).toISOString();
      event.completed_at = new Date(eventCompletedMs).toISOString();
      event.recorded_at = event.completed_at;
      eventCursor = eventCompletedMs;
    });
    const startEvent = artifact.recorder_events.find(({ pass_id: id, kind }) => id === currentPass.id && kind === 'start');
    const stopEvent = artifact.recorder_events.find(({ pass_id: id, kind }) => id === currentPass.id && kind === 'stop');
    startEvent.at = currentPass.started_at;
    stopEvent.at = currentPass.completed_at;
    cursor = currentCompletedMs;
  }
  syncTimingLifecycle(artifact);
  artifact.recorder.event_log_sha256 = sha256Json(artifact.events);
  artifact.recorder.recorder_event_log_sha256 = sha256Json(artifact.recorder_events);
  signTimingArtifact(artifact);
}

function refreshTimingArtifact(artifact, {
  proof = true,
  resign = true,
  syncLifecycle = true,
} = {}) {
  if (syncLifecycle) syncTimingLifecycle(artifact);
  artifact.recorder.event_log_sha256 = sha256Json(artifact.events);
  artifact.recorder.recorder_event_log_sha256 = sha256Json(artifact.recorder_events);
  if (proof && resign) signTimingArtifact(artifact);
  else if (proof) artifact.recording_proof_sha256 = createM511TimingProof(artifact);
}

function rebindFixtureSources(fixture, baseRecords = makeBaseRecords()) {
  fixture.proposalSource = fileSource(fixture.proposalSource.path, fixture.proposal);
  fixture.editorial.proposal_sha256 = sha256Json(fixture.proposal);
  fixture.editorial.proposal_count = fixture.proposal.proposals.length;
  fixture.editorialSource = fileSource(fixture.editorialSource.path, fixture.editorial);
  fixture.editorialTiming.source = {
    proposal_sha256: fixture.proposalSource.sha256,
    editorial_sha256: fixture.editorialSource.sha256,
  };
  refreshTimingArtifact(fixture.editorialTiming);
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
  refreshTimingArtifact(fixture.auditTiming);
  fixture.auditTimingSource = fileSource(fixture.auditTimingSource.path, fixture.auditTiming);
  fixture.relationDiffSource = fileSource(fixture.relationDiffSource.path, fixture.relationDiff);
  fixture.verification.reviewed_import_sha256 = fixture.reviewedImportSource.sha256;
  fixture.verification.editorial_sha256 = fixture.editorialSource.sha256;
  fixture.verification.proposal_sha256 = fixture.proposalSource.sha256;
  fixture.verification.relation_diff_sha256 = fixture.relationDiffSource.sha256;
  fixture.verificationSource = fileSource(fixture.verificationSource.path, fixture.verification);
  const semanticAuditResult = makeSemanticAuditSource(
    baseRecords,
    fixture.reviewedImport,
    fixture.semanticAuditSource?.path ?? '/tmp/m5-11-semantic-audit.json',
  );
  fixture.semanticAudit = semanticAuditResult.value;
  fixture.semanticAuditSource = semanticAuditResult.source;
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

test('M5-11A accepts truthful agent provenance without human timing or audit', () => {
  const fixture = makeAgentSources(makeCatalog());
  const result = deriveM511AdmissionGate({
    ...fixture,
    editorialTiming: undefined,
    editorialTimingSource: undefined,
    audit: undefined,
    auditSource: undefined,
    auditTiming: undefined,
    auditTimingSource: undefined,
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
    expectedCandidatePoolCount: 4,
    checkPilotCompleteness: false,
  });

  assert.equal(result.gate.gate_status, 'pass');
  assert.equal(result.gate.decision, 'APPROVE AUTOMATED BOUNDED');
  assert.equal(result.timing.editorial.status, 'not-required');
  assert.equal(result.audit.status, 'not-required');
  assert.equal(result.verification.human_editorial_review_complete, false);
  assert.equal(result.verification.generation_verification_separated, true);
});

test('M5-11A does not silently pass relation-bearing axes with zero admitted relations', () => {
  const catalog = makeCatalog();
  const coverage = evaluateM511SemanticCoverage({
    semantic: {
      selected_axis_counts: { A: 2 },
      selected_relation_axis_counts: { A: 0 },
      selected_expression_unit_count: 0,
    },
    catalog,
    expectedImportedCount: 2,
  });

  assert.deepEqual(coverage.relation_bearing_axes, ['A']);
  assert.equal(coverage.relation_coverage_complete, false);

  const explicitlyReviewed = evaluateM511SemanticCoverage({
    semantic: {
      selected_axis_counts: { A: 2 },
      selected_relation_axis_counts: { A: 0 },
      selected_relation_evidence_by_axis: {
        A: {
          record_count: 2,
          sense_count: 2,
          relation_sense_count: 0,
          no_relation_sense_count: 2,
          relation_tuple_count: 0,
        },
      },
      selected_expression_unit_count: 0,
    },
    catalog,
    expectedImportedCount: 2,
  });
  assert.equal(explicitlyReviewed.relation_coverage_complete, true);
});

test('M5-11A rejects human attribution and reused generation/verification passes', () => {
  const attributed = makeAgentSources(makeCatalog());
  attributed.editorial.human_editorial_review_complete = true;
  assert.throws(
    () => validateM511EditorialDecisions(attributed.editorial, {
      catalog: attributed.catalog,
      proposal: attributed.proposal,
      expectedImportedCount: 2,
    }),
    /must not claim human editorial review/u,
  );

  const reused = makeAgentSources(makeCatalog());
  reused.verification.verification_pass_id = reused.verification.generation_pass_id;
  reused.verification.provenance.pass_id = reused.verification.verification_pass_id;
  assert.throws(
    () => validateM511VerificationArtifact(reused.verification, {
      source: reused.verificationSource,
      finalSummary: {
        record_count: 3,
        start_count: 3,
        reference_only_count: 0,
        sense_count: 3,
        relation_count: 0,
        expression_count: 0,
      },
      reviewedImportSha256: reused.reviewedImportSource.sha256,
      editorialSourceSha256: reused.editorialSource.sha256,
      proposalSourceSha256: reused.proposalSource.sha256,
      relationDiffSha256: reused.relationDiffSource.sha256,
    }),
    /generation and verification passes must be distinct/u,
  );
});

test('M5-11A rejects a corrected record that collides with canonical lexical data', () => {
  const fixture = makeAgentSources(makeCatalog());
  const corrected = fixture.editorial.decisions[2];
  corrected.decision = 'corrected';
  corrected.corrected_lemma = '기존말';
  corrected.canonical_record.lemma = '기존말';
  corrected.canonical_record.search_forms = ['기존말'];

  assert.throws(
    () => deriveM511AdmissionGate({
      ...fixture,
      editorialTiming: undefined,
      editorialTimingSource: undefined,
      audit: undefined,
      auditSource: undefined,
      auditTiming: undefined,
      auditTimingSource: undefined,
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
      expectedCandidatePoolCount: 4,
      checkPilotCompleteness: false,
    }),
    /promoted canonical record .* collides with canonical lexical value/u,
  );
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
  const relationTargets = ['w001', 'w002', 'w003', 'w004'];
  fixture.editorial.decisions[2].canonical_record.senses[0].relations = relationTargets.slice(1, 2).map((target) => ({
    target,
    target_sense: `${target}-s1`,
    type: 'near',
  }));
  fixture.editorial.decisions[3].canonical_record.senses[0].relations = relationTargets.slice(2, 4).map((target) => ({
    target,
    target_sense: `${target}-s1`,
    type: 'near',
  }));
  fixture.relationDiff = {
    schema_version: '1',
    batch_id: BATCH_ID,
    before_count: 0,
    after_count: 3,
    events: Array.from({ length: 3 }, (_, index) => ({
      event_id: `${BATCH_ID}-event-${String(index + 1).padStart(4, '0')}`,
      relation_id: `${BATCH_ID}-relation-${index + 2}`,
      operation: 'add',
      source_sense: index === 0 ? 'w779-s1' : 'w780-s1',
      after: {
        target: relationTargets[index + 1],
        target_sense: `${relationTargets[index + 1]}-s1`,
        type: 'near',
      },
    })),
    candidate_reviews: relationTargets.map((target, index) => ({
      candidate_id: `m5-11-candidate-${index + 1}`,
      relation_id: `${BATCH_ID}-relation-${index + 1}`,
      source_sense: index < 2 ? 'w779-s1' : 'w780-s1',
      relation: {
        target,
        target_sense: `${target}-s1`,
        type: 'near',
      },
      decision: index === 0 ? 'reject' : 'admit',
      ...(index === 0 ? { error_category: 'broad-common-category' } : {}),
      review_note: `reviewed ${target}`,
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
    relation_count: 7,
    expression_count: 0,
  };
  fixture.verificationSource = fileSource(fixture.verificationSource.path, fixture.verification);
  rebindFixtureSources(fixture, makeRelationBaseRecords());

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
  refreshTimingArtifact(fixture.auditTiming);
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
  fixture.auditTiming.recorder_events.forEach((event) => {
    event.session_id = fixture.auditTiming.session_id;
  });
  fixture.auditTiming.recorder.event_log_sha256 = sha256Json(fixture.auditTiming.events);
  fixture.auditTiming.recorder.recorder_event_log_sha256 = sha256Json(fixture.auditTiming.recorder_events);
  fixture.auditSource = fileSource('/tmp/m5-11-audit-reused.json', fixture.audit);
  fixture.auditTiming.source.audit_sha256 = fixture.auditSource.sha256;
  refreshTimingArtifact(fixture.auditTiming);
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

test('M5-11 successful promotion transaction verifies the durable semantic source before returning', async () => {
  const fixture = await createM511PromotionTransactionFixture();
  try {
    const { prospective, semanticAuditBytes } = fixture;
    const transaction = await commitM511PromotionTransaction({
      promotion: promotionForTransactionFixture(fixture),
      prospective,
      semanticAuditBytes,
      currentCanonicalDirectory: fixture.currentCanonicalDirectory,
      currentSeedPath: fixture.currentSeedPath,
      canonicalImportPath: fixture.canonicalImportPath,
      promotionEvidencePath: fixture.promotionEvidencePath,
      semanticDecisionSourcePath: fixture.historicalDecisionSourcePath,
    });

    assert.equal(transaction.canonicalDigest, prospective.canonicalDigest);
    assert.equal(transaction.seedDigest, prospective.seedSha256);
    assert.equal(transaction.inventoryDigest, prospective.inventorySha256);
    assert.deepEqual(await readFile(fixture.canonicalImportPath), prospective.importBytes);
    const promotionEvidence = JSON.parse(await readFile(fixture.promotionEvidencePath, 'utf8'));
    assert.equal(
      promotionEvidence.outputs.semantic_decision_source.path,
      path.relative(process.cwd(), fixture.historicalDecisionSourcePath),
    );
    assert.equal(
      promotionEvidence.outputs.semantic_audit.sha256,
      sha256(semanticAuditBytes),
    );

    const authority = await verifySemanticDecisionSource({
      canonicalDirectory: fixture.currentCanonicalDirectory,
      decisionSourcePath: fixture.historicalDecisionSourcePath,
      expectedSemanticAuditBytes: semanticAuditBytes,
    });

    assert.equal(authority.sourceId, 'canonical-semantic-decision-source-20260914');
    assert.deepEqual(authority.semanticAuditBytes, semanticAuditBytes);
    await validateCanonicalSemanticAudit(
      fixture.currentCanonicalDirectory,
      undefined,
      fixture.historicalDecisionSourcePath,
    );
  } finally {
    await rm(fixture.temporaryDirectory, { recursive: true, force: true });
  }
});

test('M5-11 promotion transaction rejects a mismatched semantic authority without mutation', async () => {
  const fixture = await createM511PromotionTransactionFixture();
  const beforeCanonicalDigest = await hashCanonicalDirectory(fixture.currentCanonicalDirectory);
  const mismatchedSemanticAuditBytes = Buffer.from(fixture.semanticAuditBytes);
  mismatchedSemanticAuditBytes[0] ^= 1;
  try {
    await assert.rejects(
      commitM511PromotionTransaction({
        promotion: promotionForTransactionFixture(fixture),
        prospective: fixture.prospective,
        semanticAuditBytes: mismatchedSemanticAuditBytes,
        currentCanonicalDirectory: fixture.currentCanonicalDirectory,
        currentSeedPath: fixture.currentSeedPath,
        canonicalImportPath: fixture.canonicalImportPath,
        promotionEvidencePath: fixture.promotionEvidencePath,
        semanticDecisionSourcePath: fixture.historicalDecisionSourcePath,
      }),
      (error) => error?.code === 'SEMANTIC_DECISION_SOURCE_MISMATCH',
    );
    assert.equal(
      await hashCanonicalDirectory(fixture.currentCanonicalDirectory),
      beforeCanonicalDigest,
    );
    assert.deepEqual(await readFile(fixture.currentSeedPath), fixture.initialSeedBytes);
    await assert.rejects(readFile(fixture.canonicalImportPath), { code: 'ENOENT' });
    await assert.rejects(readFile(fixture.promotionEvidencePath), { code: 'ENOENT' });
  } finally {
    await rm(fixture.temporaryDirectory, { recursive: true, force: true });
  }
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
  };
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    const before = await Promise.all(Object.values(paths).map((filePath) => readFile(filePath)));
    const inventoryBefore = serializeTargetInventory(await buildTargetInventory());
    await assert.rejects(
      promoteM511({ manifestPath }),
      /only a passing APPROVE BOUNDED admission manifest/u,
    );
    const after = await Promise.all(Object.values(paths).map((filePath) => readFile(filePath)));
    after.forEach((bytes, index) => assert.deepEqual(bytes, before[index]));
    assert.deepEqual(serializeTargetInventory(await buildTargetInventory()), inventoryBefore);
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
      semanticAuditPath: input,
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
    /recording[_ ]proof|recorder-derived duration/u,
  );
});

test('M5-11 timing rejects a fabricated but self-consistent event log', () => {
  const fixture = makeSources(makeCatalog());
  const originalLifecycle = structuredClone(fixture.editorialTiming.recorder.lifecycle);
  setTimingPassDuration(fixture.editorialTiming, 'target-preparation', 1001);
  fixture.editorialTiming.recorder.lifecycle = originalLifecycle;
  refreshTimingArtifact(fixture.editorialTiming, {
    proof: true,
    resign: true,
    syncLifecycle: false,
  });
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
    /artifact (?:binding|finalization)/u,
  );
});

test('M5-11 timing rejects an audit recorded before the editorial freeze completed', () => {
  const fixture = makeSources(makeCatalog());
  const auditPass = fixture.auditTiming.passes[0];
  auditPass.started_at = '2026-09-13T09:00:00.000Z';
  auditPass.completed_at = '2026-09-13T09:00:01.000Z';
  fixture.auditTiming.events.forEach((event, index) => {
    const startedAt = Date.parse(auditPass.started_at) + index * 250;
    const completedAt = startedAt + 250;
    event.started_at = new Date(startedAt).toISOString();
    event.completed_at = new Date(completedAt).toISOString();
    event.recorded_at = event.completed_at;
  });
  fixture.auditTiming.recorder_events.find(({ kind }) => kind === 'start').at = auditPass.started_at;
  fixture.auditTiming.recorder_events.find(({ kind }) => kind === 'stop').at = auditPass.completed_at;
  refreshTimingArtifact(fixture.auditTiming);
  fixture.auditTimingSource = fileSource('/tmp/m5-11-audit-before-freeze.json', fixture.auditTiming);
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
    /before the editorial timing session completed/u,
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

test('M5-11 relation evidence rejects a diff event sourced from the frozen base', () => {
  const fixture = makeSources(makeCatalog());
  fixture.relationDiff = {
    schema_version: '1',
    batch_id: BATCH_ID,
    before_count: 1,
    after_count: 0,
    events: [{
      event_id: `${BATCH_ID}-phantom-base-event`,
      relation_id: `${BATCH_ID}-phantom-base-relation`,
      operation: 'remove',
      source_sense: 'w001-s1',
      before: {
        target: 'w002',
        target_sense: 'w002-s1',
        type: 'near',
      },
    }],
  };
  fixture.relationDiffSource = fileSource('/tmp/m5-11-phantom-base-relation.json', fixture.relationDiff);
  rebindFixtureSources(fixture, makeRelationBaseRecords());
  assert.throws(
    () => deriveM511AdmissionGate({
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
    }),
    /non-imported source sense/u,
  );
});

test('M5-11 prospective verification runs the complete M4 baseline contract', async () => {
  const importedRecords = [{
    id: 'w779',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w779',
    lemma: '담담하다',
    search_forms: ['담담하다'],
    senses: [{ id: 'w779-s1', pos: 'adjective', gloss: '검증용 충돌 의미' }],
  }];
  const baseCanonical = await readCanonicalRecords(
    path.join(process.cwd(), 'data/batches/m5-11-base-canonical'),
  );
  const semanticAudit = makeSemanticAudit([
    ...baseCanonical.records,
    ...importedRecords.map((record) => ({ record, source: 'reviewed-import' })),
  ]);
  const productionState = makeProductionState({
    batchId: M5_11_BATCH_ID,
    baseRecords: baseCanonical.records,
    reviewedRecords: importedRecords,
    prospectiveRecords: [
      ...baseCanonical.records,
      ...importedRecords.map((record) => ({ record, source: 'reviewed-import' })),
    ],
    semanticAudit,
  });
  await assert.rejects(
    runM511ProspectiveVerification({
      baseCanonicalDirectory: path.join(process.cwd(), 'data/batches/m5-11-base-canonical'),
      importedRecords,
      semanticAudit,
      productionState: productionState.state,
      productionStateSources: productionState.sources,
      productionPayloads: productionState.payloads,
      expectedFinalSummary: {
        record_count: 821,
        start_count: 779,
        reference_only_count: 42,
        sense_count: 967,
        relation_count: 473,
        expression_count: 63,
      },
      checkPilotCompleteness: true,
    }),
    /M4 baseline .* result IDs|owned by multiple records|producer-owned prospective output/u,
  );
});

test('M5-11 timing recorder owns the clock and rejects caller-supplied timestamps', async () => {
  await assert.rejects(
    recordM511Timing([
      '--action=start',
      '--pass=target-preparation',
      '--output=/tmp/m5-11-recorder-forbidden.json',
      '--proposal-sha256=a'.repeat(64),
      '--editorial-sha256=b'.repeat(64),
      '--started-at=2026-09-13T10:00:00.000Z',
    ]),
    /not accepted; the recorder uses current-clock events/u,
  );
});

test('M5-11 timing recorder binds an artifact finalized during the session', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-11-recorder-lifecycle-'));
  const proposalPath = path.join(temporaryDirectory, 'proposal.json');
  const artifactPath = path.join(temporaryDirectory, 'editorial.json');
  const scopePath = path.join(temporaryDirectory, 'scope.json');
  const timingPath = path.join(temporaryDirectory, 'timing.json');
  const catalog = makeCatalog();
  const scopes = {
    'target-preparation': catalog.map(({ inventory_id: inventoryId }) => inventoryId),
    'initial-review': catalog.map(({ inventory_id: inventoryId }) => inventoryId),
    'feedback-fixes': [],
    'final-verification': ['m5-537', 'm5-538'],
    'held-rejected': ['m5-535', 'm5-536'],
  };
  try {
    await writeFile(proposalPath, `${JSON.stringify({ frozen: true, catalog_count: catalog.length })}\n`, 'utf8');
    await writeFile(artifactPath, '{"preexisting":true}\n', 'utf8');
    await writeFile(scopePath, `${JSON.stringify(scopes['target-preparation'])}\n`, 'utf8');
    await assert.rejects(
      recordM511Timing([
        '--action=start',
        '--pass=target-preparation',
        `--output=${timingPath}`,
        `--proposal=${proposalPath}`,
        `--artifact=${artifactPath}`,
        `--unit-ids-file=${scopePath}`,
      ]),
      /absent before the recorder session starts/u,
    );
    await rm(artifactPath, { force: true });

    await recordM511Timing([
      '--action=start',
      '--pass=target-preparation',
      `--output=${timingPath}`,
      `--proposal=${proposalPath}`,
      `--artifact=${artifactPath}`,
      `--unit-ids-file=${scopePath}`,
    ]);
    for (const [index, passId] of M5_11_EDITORIAL_TIMING_PASS_IDS.entries()) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (index === M5_11_EDITORIAL_TIMING_PASS_IDS.length - 1) {
        await writeFile(artifactPath, '{"human_editorial_review_complete":true}\n', 'utf8');
      }
      const stopped = await recordM511Timing([
        '--action=stop',
        `--pass=${passId}`,
        `--input=${timingPath}`,
        `--output=${timingPath}`,
      ]);
      if (index < M5_11_EDITORIAL_TIMING_PASS_IDS.length - 1) {
        const nextPass = M5_11_EDITORIAL_TIMING_PASS_IDS[index + 1];
        await writeFile(scopePath, `${JSON.stringify(scopes[nextPass])}\n`, 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 10));
        await recordM511Timing([
          '--action=start',
          `--pass=${nextPass}`,
          `--input=${timingPath}`,
          `--output=${timingPath}`,
          `--unit-ids-file=${scopePath}`,
        ]);
      } else {
        assert.equal(stopped.status, 'complete');
        assert.equal(stopped.recorder.lifecycle.artifact_existed_at_session_start, false);
        assert.equal(stopped.recorder.lifecycle.artifact_bound_at_stop, true);
        assert.equal(stopped.source.editorial_sha256, createHash('sha256')
          .update('{"human_editorial_review_complete":true}\n')
          .digest('hex'));
        const timingBytes = await readFile(timingPath);
        const validated = validateM511TimingArtifact(stopped, {
          source: fileSource(timingPath, stopped, timingBytes),
          catalog,
          importedInventoryIds: ['m5-537', 'm5-538'],
          reserveInventoryIds: ['m5-535', 'm5-536'],
        });
        assert.equal(validated.status, 'complete');
        await assert.rejects(
          readFile(`${timingPath}.provenance-key`),
          { code: 'ENOENT' },
        );
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('M5-11 audit recorder binds the audit report at its final stop', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-11-audit-recorder-'));
  const proposalPath = path.join(temporaryDirectory, 'proposal.json');
  const editorialPath = path.join(temporaryDirectory, 'editorial.json');
  const editorialTimingPath = path.join(temporaryDirectory, 'editorial-timing.json');
  const auditPath = path.join(temporaryDirectory, 'audit.json');
  const scopePath = path.join(temporaryDirectory, 'scope.json');
  const timingPath = path.join(temporaryDirectory, 'audit-timing.json');
  const catalog = makeCatalog();
  const proposalBytes = Buffer.from('{"frozen":true}\n', 'utf8');
  const editorialBytes = Buffer.from('{"human_editorial_review_complete":true}\n', 'utf8');
  const editorialTimingBytes = Buffer.from('{"status":"complete"}\n', 'utf8');
  const auditBytes = Buffer.from('{"independent":true,"open_blocker_count":0}\n', 'utf8');
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  try {
    await writeFile(proposalPath, proposalBytes);
    await writeFile(editorialPath, editorialBytes);
    await writeFile(editorialTimingPath, editorialTimingBytes);
    await writeFile(scopePath, `${JSON.stringify(catalog.map(({ inventory_id: inventoryId }) => inventoryId))}\n`);
    await recordM511Timing([
      '--action=start',
      '--pass=post-freeze-audit',
      `--output=${timingPath}`,
      `--proposal=${proposalPath}`,
      `--editorial=${editorialPath}`,
      `--editorial-timing=${editorialTimingPath}`,
      `--artifact=${auditPath}`,
      `--unit-ids-file=${scopePath}`,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(auditPath, auditBytes);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const completed = await recordM511Timing([
      '--action=stop',
      '--pass=post-freeze-audit',
      `--input=${timingPath}`,
      `--output=${timingPath}`,
    ]);
    assert.equal(completed.source.proposal_sha256, digest(proposalBytes));
    assert.equal(completed.source.editorial_sha256, digest(editorialBytes));
    assert.equal(completed.source.editorial_timing_sha256, digest(editorialTimingBytes));
    assert.equal(completed.source.audit_sha256, digest(auditBytes));
    const timingBytes = await readFile(timingPath);
    const validated = validateM511TimingArtifact(completed, {
      source: fileSource(timingPath, completed, timingBytes),
      catalog,
      timingKind: 'post-freeze-audit',
      expectedSessionId: completed.session_id,
      proposalSourceSha256: digest(proposalBytes),
      editorialSourceSha256: digest(editorialBytes),
      auditSourceSha256: digest(auditBytes),
      editorialTimingSourceSha256: digest(editorialTimingBytes),
    });
    assert.equal(validated.status, 'complete');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
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
  const target = {
    net_start_increase: 500,
    cumulative_start_target: 1278,
    candidate_buffer: 50,
    selected_start_count: 550,
  };
  const metrics = {
    correction_rate_of_selected: 100 / 530,
    relation_noise_rate_of_candidates: 0.1,
    editor_seconds_per_selected_start: 10,
    editor_seconds_per_processed_start: 10,
    editor_time_status: 'measured',
    timing_status: 'complete',
    unmeasured_timing_pass_count: 0,
    audit_status: 'complete',
    audit_independent: true,
    open_audit_blocker_count: 0,
    editorial_review_complete: true,
    human_editorial_review_complete: true,
    canonical_integrity: true,
    deterministic_sqlite: true,
    search_product_regression: true,
  };
  const relation = { noise_rate_of_candidates: 0.1 };
  const interval = (id, startMs, durationMs, unitCount) => ({
    id,
    unit_count: unitCount,
    event_count: unitCount,
    start_event_id: `${id}-start`,
    stop_event_id: `${id}-stop`,
    started_at: new Date(startMs).toISOString(),
    completed_at: new Date(startMs + durationMs).toISOString(),
    wall_clock_seconds: durationMs / 1000,
    measured_seconds: unitCount === 0 ? 0 : durationMs / 1000,
  });
  const durableTiming = ({ timingKind, sessionId, sourceBinding, passIntervals, field }) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const firstPass = passIntervals[0];
    const finalPass = passIntervals.at(-1);
    const proof = sha256Json({
      test: 'm5-11-durable-recorder',
      timing_kind: timingKind,
      session_id: sessionId,
      source_binding: sourceBinding,
      pass_intervals: passIntervals,
    });
    return {
      status: 'complete',
      timing_kind: timingKind,
      session_id: sessionId,
      editor_seconds: field === 'editor_seconds'
        ? passIntervals.reduce((sum, pass) => sum + pass.measured_seconds, 0)
        : 0,
      audit_seconds: field === 'audit_seconds'
        ? passIntervals.reduce((sum, pass) => sum + pass.measured_seconds, 0)
        : 0,
      unmeasured_pass_count: 0,
      pass_ids: passIntervals.map(({ id }) => id),
      recording_proof_sha256: proof,
      source_binding: sourceBinding,
      recorder: {
        version: M5_11_TIMING_RECORDER_VERSION,
        session_id: sessionId,
        event_count: passIntervals.reduce((sum, pass) => sum + pass.event_count, 0),
        event_log_sha256: 'a'.repeat(64),
        recorder_event_count: passIntervals.length * 2,
        recorder_event_log_sha256: 'b'.repeat(64),
        provenance: {
          version: M5_11_TIMING_PROVENANCE_VERSION,
          algorithm: M5_11_TIMING_PROVENANCE_ALGORITHM,
          public_key_spki_base64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
          signed_recording_proof_sha256: proof,
          signature_base64: sign(
            null,
            Buffer.from(proof, 'utf8'),
            privateKey,
          ).toString('base64'),
        },
        lifecycle: {
          version: M5_11_TIMING_LIFECYCLE_VERSION,
          artifact_kind: timingKind === 'editorial' ? 'editorial-decisions' : 'independent-audit',
          binding_mode: 'start-before-artifact-finalization',
          artifact_existed_at_session_start: false,
          artifact_bound_at_stop: true,
          session_started_at: firstPass.started_at,
          session_start_event_id: firstPass.start_event_id,
          artifact_bound_at: finalPass.completed_at,
          artifact_bound_event_id: finalPass.stop_event_id,
          artifact_bound_pass_id: finalPass.id,
          artifact_sha256: sourceBinding[field === 'editor_seconds' ? 'editorial_sha256' : 'audit_sha256'],
          artifact_byte_count: 1,
        },
      },
      pass_intervals: passIntervals,
    };
  };
  const editorialStartMs = Date.parse('2026-09-13T10:00:00.000Z');
  const editorialDurations = [1000000, 1000000, 0, 1000000, 2300000];
  let editorialCursor = editorialStartMs;
  const editorialIntervals = M5_11_EDITORIAL_TIMING_PASS_IDS.map((id, index) => {
    const pass = interval(id, editorialCursor, editorialDurations[index], index === 2 ? 0 : 1);
    editorialCursor += editorialDurations[index];
    return pass;
  });
  const auditIntervals = [interval(
    'post-freeze-audit',
    editorialCursor + 1000,
    1000,
    1,
  )];
  const timing = {
    editorial: durableTiming({
      timingKind: 'editorial',
      sessionId: 'editorial-session',
      sourceBinding: {
        proposal_sha256: sources.proposal.sha256,
        editorial_sha256: sources.editorial.sha256,
      },
      passIntervals: editorialIntervals,
      field: 'editor_seconds',
    }),
    audit: durableTiming({
      timingKind: 'post-freeze-audit',
      sessionId: 'audit-session',
      sourceBinding: {
        proposal_sha256: sources.proposal.sha256,
        editorial_sha256: sources.editorial.sha256,
        audit_sha256: sources.audit.sha256,
        editorial_timing_sha256: sources.editorial_timing.sha256,
      },
      passIntervals: auditIntervals,
      field: 'audit_seconds',
    }),
  };
  const audit = { status: 'complete', independent: true, open_blocker_count: 0 };
  audit.session_id = timing.audit.session_id;
  const verification = {
    editorial_review_complete: true,
    human_editorial_review_complete: true,
    canonical_integrity: true,
    deterministic_sqlite: true,
    search_product_regression: true,
    raw_material_excluded: true,
    machine_generated: true,
    verifier_version: M5_11_PROSPECTIVE_VERIFIER_VERSION,
    prospective_canonical_sha256: 'e'.repeat(64),
    checks: M5_11_MACHINE_CHECK_IDS.map((id) => ({
      id,
      status: 'pass',
      result_sha256: 'f'.repeat(64),
    })),
  };
  const gate = {
    quality_passes: {
      correction_rate: true,
      relation_noise_rate: true,
      relation_noise_below_baseline: true,
      editor_seconds_per_selected_start: true,
      timing_complete: true,
      unmeasured_timing_passes: true,
      audit_complete: true,
      audit_independent: true,
      open_audit_blockers: true,
      editorial_review_complete: true,
      canonical_integrity: true,
      deterministic_sqlite: true,
      search_product_regression: true,
      exact_net_start_increase: true,
    },
    gate_status: 'pass',
    decision: 'APPROVE BOUNDED',
  };
  const gateEvidence = {
    schema_version: '1',
    evidence_version: 'm5-11-gate-evidence-v1',
    batch_id: M5_11_BATCH_ID,
    base_summary: base,
    final_summary: actual,
    decision_counts: {
      included: 400,
      corrected: 100,
      held: 20,
      rejected: 10,
      deferred: 20,
      processed_start_count: 530,
      imported_start_count: 500,
    },
    processed_start_count: 530,
    imported_start_count: 500,
    relation,
    timing,
    audit,
    verification,
    metrics,
    gate,
  };
  const manifest = {
    schema_version: '1',
    issue: 97,
    batch_id: M5_11_BATCH_ID,
    gate,
    target,
    base,
    actual,
    decisions: {
      included: 400,
      corrected: 100,
      held: 20,
      rejected: 10,
      deferred: 20,
      processed_start_count: 530,
      imported_start_count: 500,
    },
    metrics,
    relation,
    timing,
    audit,
    verification,
    gate_evidence: gateEvidence,
    gate_evidence_sha256: sha256Json(gateEvidence),
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
    gate_evidence: gateEvidence,
    gate_evidence_sha256: sha256Json(gateEvidence),
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

  const tamperedManifest = structuredClone(manifest);
  const tamperedEvidence = structuredClone(evidence);
  tamperedManifest.metrics = {
    ...tamperedManifest.metrics,
    editor_seconds_per_processed_start: 11,
  };
  tamperedEvidence.metrics = {
    ...tamperedEvidence.metrics,
    editor_seconds_per_processed_start: 11,
  };
  assert.throws(
    () => validateM511DurableEvidence({ manifest: tamperedManifest, evidence: tamperedEvidence }),
    /durable gate metrics/u,
  );

  const splitTamperedManifest = structuredClone(manifest);
  const splitTamperedEvidence = structuredClone(evidence);
  splitTamperedManifest.decisions = {
    ...splitTamperedManifest.decisions,
    included: 401,
    corrected: 99,
  };
  splitTamperedEvidence.decisions = {
    ...splitTamperedEvidence.decisions,
    included: 401,
    corrected: 99,
  };
  assert.throws(
    () => validateM511DurableEvidence({
      manifest: splitTamperedManifest,
      evidence: splitTamperedEvidence,
    }),
    /decision evidence/u,
  );
});
