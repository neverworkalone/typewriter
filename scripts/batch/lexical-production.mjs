import { validateLexicalAddition } from './lexical-admission.mjs';
import {
  createLexicalProductionPayload,
  createLexicalProductionRun,
  productionBytesSha256,
  productionValueSha256,
  validateLexicalProductionPreAuditState,
  validateLexicalProductionState,
} from './lexical-production-state.mjs';
import {
  validateBulkGlossProjection,
  validateLexicalRecord,
  validateLexicalSemanticReview,
} from '../validate/lexical-quality.mjs';

export const LEXICAL_PRODUCTION_PIPELINE_VERSION = 'lexical-production-v1';
export const LEXICAL_PRODUCTION_DECISIONS = Object.freeze([
  'included',
  'corrected',
  'held',
  'rejected',
  'deferred',
]);

export class LexicalProductionError extends Error {
  constructor(message, code = 'LEXICAL_PRODUCTION_ERROR') {
    super(message);
    this.name = 'LexicalProductionError';
    this.code = code;
  }
}

function fail(message, code = 'LEXICAL_PRODUCTION_ERROR') {
  throw new LexicalProductionError(message, code);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`, 'LEXICAL_PRODUCTION_SHAPE');
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`, 'LEXICAL_PRODUCTION_SHAPE');
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`, 'LEXICAL_PRODUCTION_VALUE');
  }
  return value;
}

function requireSourceBytes(value, label) {
  if (!value || typeof value.length !== 'number') {
    fail(`${label} must provide the source bytes for digest verification`, 'LEXICAL_PRODUCTION_STAGE_BINDING');
  }
  return value;
}

function recordOf(recordInfo) {
  return recordInfo?.record ?? recordInfo;
}

function semanticReviewInput(entry, index) {
  const label = `production.reviews[${index}]`;
  requireObject(entry, label);
  requireString(entry.candidate_id, `${label}.candidate_id`);
  requireString(entry.decision, `${label}.decision`);
  if (!LEXICAL_PRODUCTION_DECISIONS.includes(entry.decision)) {
    fail(`${label}.decision is not a supported production decision`, 'LEXICAL_PRODUCTION_DECISION');
  }
  requireObject(entry.semantic_review, `${label}.semantic_review`);
  return entry;
}

function valuesOf(recordInfos) {
  return recordInfos.map(recordOf);
}

const LEXICAL_SELECTION_AXES = new Set(['E', 'Q', 'S', 'C', 'A', 'O', 'X']);

/**
 * Materialize explicit, Typewriter-authored lexical units as candidate
 * identities and records.  The shared producer binds each identity to the
 * complete source artifact; it does not invent lexical units or decisions.
 */
export function materializeLexicalUnitCandidates({
  batchId,
  source,
  sourceBytes,
  firstInventoryNumber,
  firstCanonicalNumber,
  baseRecords = [],
  baseSeedTargets = [],
} = {}) {
  requireString(batchId, 'candidate_source.batch_id');
  requireObject(source, 'candidate_source');
  requireArray(source.units, 'candidate_source.units');
  requireSourceBytes(sourceBytes, 'candidate_source.source_bytes');
  requireArray(baseRecords, 'candidate_source.base_records');
  requireArray(baseSeedTargets, 'candidate_source.base_seed_targets');
  if (!Number.isInteger(firstInventoryNumber) || firstInventoryNumber < 1) {
    fail('candidate_source.first_inventory_number must be a positive integer', 'LEXICAL_PRODUCTION_VALUE');
  }
  if (!Number.isInteger(firstCanonicalNumber) || firstCanonicalNumber < 1) {
    fail('candidate_source.first_canonical_number must be a positive integer', 'LEXICAL_PRODUCTION_VALUE');
  }
  if (source.contract_version !== 'lexical-candidate-source-v1'
    || source.kind !== 'typewriter-authored-lexical-unit-source'
    || typeof source.source_id !== 'string'
    || !/^[0-9a-f]{64}$/u.test(source.base_canonical_records_sha256)
    || !/^[0-9a-f]{64}$/u.test(source.base_seed_sha256)
    || typeof source.artifact_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(source.artifact_sha256)) {
    fail('candidate_source contract, source identity, or artifact digest is invalid', 'LEXICAL_PRODUCTION_SOURCE_BINDING');
  }
  const sourceWithoutDigest = structuredClone(source);
  delete sourceWithoutDigest.artifact_sha256;
  const artifactSha256 = productionValueSha256(sourceWithoutDigest);
  if (artifactSha256 !== source.artifact_sha256
    || source.candidate_count !== source.units.length
    || source.pool_sha256 !== productionValueSha256(source.units)) {
    fail('candidate_source artifact or pool digest does not match its authored units', 'LEXICAL_PRODUCTION_SOURCE_BINDING');
  }
  let parsedSourceBytes;
  try {
    parsedSourceBytes = JSON.parse(Buffer.from(sourceBytes).toString('utf8'));
  } catch (error) {
    fail(`candidate_source.source_bytes is not valid JSON: ${error.message}`, 'LEXICAL_PRODUCTION_SOURCE_BINDING');
  }
  if (JSON.stringify(parsedSourceBytes) !== JSON.stringify(source)) {
    fail('candidate_source.source_bytes do not encode the supplied source artifact', 'LEXICAL_PRODUCTION_SOURCE_BINDING');
  }

  const observedAxisCounts = Object.fromEntries([...LEXICAL_SELECTION_AXES].map((axis) => [axis, 0]));
  const seenUnitIds = new Set();
  const seenLemmas = new Set();
  const baseTerms = new Map();
  for (const [index, recordValue] of baseRecords.entries()) {
    const record = recordOf(recordValue);
    requireObject(record, `candidate_source.base_records[${index}]`);
    for (const term of [record.lemma, ...(Array.isArray(record.search_forms) ? record.search_forms : [])]) {
      if (typeof term === 'string' && term.length > 0) {
        baseTerms.set(term.normalize('NFC'), `canonical:${record.id ?? index}`);
      }
    }
  }
  for (const [index, target] of baseSeedTargets.entries()) {
    requireObject(target, `candidate_source.base_seed_targets[${index}]`);
    for (const term of [target.lemma, ...(Array.isArray(target.search_forms) ? target.search_forms : [])]) {
      if (typeof term === 'string' && term.length > 0) {
        baseTerms.set(term.normalize('NFC'), `seed:${target.inventory_id ?? index}`);
      }
    }
  }
  const identities = [];
  const candidateRecords = [];
  for (const [index, unit] of source.units.entries()) {
    const label = `candidate_source.units[${index}]`;
    requireObject(unit, label);
    for (const field of ['source_unit_id', 'lemma', 'pos', 'source_kind', 'writer_use', 'writer_gloss']) {
      requireString(unit[field], `${label}.${field}`);
      if (unit[field] !== unit[field].trim() || unit[field].normalize('NFC') !== unit[field]) {
        fail(`${label}.${field} must be trimmed NFC text`, 'LEXICAL_PRODUCTION_SOURCE_BINDING');
      }
    }
    if (seenUnitIds.has(unit.source_unit_id) || seenLemmas.has(unit.lemma)) {
      fail(`${label} duplicates a source unit identity or lemma`, 'LEXICAL_PRODUCTION_SOURCE_BINDING');
    }
    const baseOwner = baseTerms.get(unit.lemma.normalize('NFC'));
    if (baseOwner) {
      fail(`${label}.lemma collides with ${baseOwner}`, 'LEXICAL_PRODUCTION_SOURCE_BINDING');
    }
    seenUnitIds.add(unit.source_unit_id);
    seenLemmas.add(unit.lemma);
    if (!LEXICAL_SELECTION_AXES.has(unit.axis)) {
      fail(`${label}.axis is not a supported Typewriter selection axis`, 'LEXICAL_PRODUCTION_SOURCE_BINDING');
    }
    if (!Array.isArray(unit.flags) || unit.flags.some((flag) => typeof flag !== 'string' || flag.length === 0)) {
      fail(`${label}.flags must contain non-empty strings`, 'LEXICAL_PRODUCTION_SOURCE_BINDING');
    }
    if (!['entry', 'expression'].includes(unit.record_type)
      || (unit.record_type === 'expression') !== (unit.pos === 'expression')) {
      fail(`${label}.record_type and POS do not describe one supported lexical unit`, 'LEXICAL_PRODUCTION_SOURCE_BINDING');
    }
    observedAxisCounts[unit.axis] += 1;
    const inventoryNumber = firstInventoryNumber + index;
    const canonicalNumber = firstCanonicalNumber + index;
    const inventoryId = `m5-${String(inventoryNumber).padStart(4, '0')}`;
    const candidateRecordId = `w${String(canonicalNumber).padStart(4, '0')}`;
    const identity = {
      catalog_index: index,
      slot_id: `${batchId}-slot-${String(index + 1).padStart(4, '0')}`,
      inventory_id: inventoryId,
      candidate_record_id: candidateRecordId,
      lemma: unit.lemma,
      axis: unit.axis,
      flags: [...unit.flags],
      record_type: unit.record_type,
      pos: unit.pos,
      source_kind: unit.source_kind,
      writer_gloss: unit.writer_gloss,
      source_basis: {
        source_id: source.source_id,
        source_artifact_sha256: source.artifact_sha256,
        source_unit_id: unit.source_unit_id,
        source_material: 'Typewriter-authored lexical unit source',
        identity_kind: 'explicit-lexical-unit',
        lexical_unit: unit.lemma,
        writer_use: unit.writer_use,
        writer_gloss: unit.writer_gloss,
        source_kind: unit.source_kind,
        source_position: {
          source_unit_index: index,
          catalog_index: index,
        },
      },
    };
    const candidateRecord = {
      id: candidateRecordId,
      record_type: unit.record_type,
      role: 'start',
      candidate_id: candidateRecordId,
      lemma: unit.lemma,
      search_forms: [unit.lemma],
      senses: [{
        id: `${candidateRecordId}-s1`,
        pos: unit.pos,
        gloss: unit.writer_gloss,
      }],
    };
    try {
      validateLexicalRecord(candidateRecord, {
        label: `${batchId} candidate ${candidateRecordId}`,
        mode: 'candidate',
        expectedId: candidateRecordId,
        expectedLemma: unit.lemma,
      });
    } catch (error) {
      fail(`candidate_source unit ${unit.source_unit_id} failed the shared lexical intake: ${error.message}`, error.code);
    }
    identities.push(identity);
    candidateRecords.push(candidateRecord);
  }
  if (source.axis_counts !== undefined
    && JSON.stringify(observedAxisCounts) !== JSON.stringify(source.axis_counts)) {
    fail('candidate_source axis counts do not match the authored unit pool', 'LEXICAL_PRODUCTION_SOURCE_BINDING');
  }
  return {
    identities,
    candidateRecords,
    sourceSha256: productionBytesSha256(sourceBytes),
    artifactSha256,
    axisCounts: observedAxisCounts,
  };
}

function createPreAuditPayloads({
  batchId,
  candidates,
  reviewRows,
  selectedRecords,
  correctionRecords,
  ranks,
  selectedRanks,
  baseRecords,
  prospectiveRecords,
} = {}) {
  const candidateValues = valuesOf(candidates);
  const reviewedValues = valuesOf([...selectedRecords, ...correctionRecords]);
  const candidateOutput = candidateValues;
  const reviewOutput = {
    review_rows: reviewRows,
    reviewed_records: reviewedValues,
  };
  const selectionOutput = {
    selected_records: reviewedValues,
    selection_ranks: selectedRanks,
  };
  const prospectiveOutput = valuesOf(prospectiveRecords);
  const specs = {
    candidate_intake: {
      input: null,
      output: candidateOutput,
      inputKind: 'none',
      outputKind: 'candidate-records',
      details: {
      candidate_records_sha256: productionValueSha256(candidateOutput),
      candidate_count: candidateValues.length,
      },
    },
    semantic_review: {
      input: candidateOutput,
      output: reviewOutput,
      inputKind: 'candidate-records',
      outputKind: 'reviewed-records',
      details: {
      candidate_records_sha256: productionValueSha256(candidateOutput),
      review_rows_sha256: productionValueSha256(reviewRows),
      reviewed_records_sha256: productionValueSha256(reviewedValues),
      },
    },
    selection: {
      input: reviewOutput,
      output: selectionOutput,
      inputKind: 'reviewed-records',
      outputKind: 'selected-records',
      details: {
      reviewed_records_sha256: productionValueSha256(reviewedValues),
      selected_records_sha256: productionValueSha256(reviewedValues),
      selection_ranks_sha256: productionValueSha256(selectedRanks),
      },
    },
    prospective_canonical: {
      input: selectionOutput,
      output: prospectiveOutput,
      inputKind: 'selected-records',
      outputKind: 'prospective-canonical',
      details: {
        base_records_sha256: productionValueSha256(valuesOf(baseRecords)),
        base_records: valuesOf(baseRecords),
        prospective_records_sha256: productionValueSha256(prospectiveOutput),
      },
    },
  };
  const payloads = Object.fromEntries(
    Object.entries(specs).map(([stageId, spec]) => [
      stageId,
      createLexicalProductionPayload({ stageId, batchId, ...spec }),
    ]),
  );
  return {
    ...payloads,
    payload_specs: specs,
    outputs: { candidateOutput, reviewOutput, selectionOutput, prospectiveOutput },
  };
}

function validateStageEvidence(
  stageEvidence,
  {
    productionState,
    batchId,
    productionStateSources,
    expectedPayloads,
    payloadSpecs,
    allowReplay = false,
  } = {},
) {
  if (productionState !== undefined) {
    try {
      if (productionState.producer_mode === 'replay' && !allowReplay) {
        fail(
          'active lexical production requires a live producer run; replay state is reserved for explicit historical verification',
          'LEXICAL_PRODUCTION_REPLAY_FORBIDDEN',
        );
      }
      const replayState = productionState.producer_mode === 'replay';
      const state = validateLexicalProductionState(productionState, {
        batchId,
        sourceBytesByStage: productionStateSources,
        expectedPayloads: replayState ? undefined : expectedPayloads,
        allowReplay,
      });
      return {
        state,
        run: undefined,
        authorization: undefined,
        authorizationEvidence: undefined,
        auditStage: undefined,
        admissionStage: undefined,
        sources: productionStateSources,
      };
    } catch (error) {
      fail(`production_state failed: ${error.message}`, error.code);
    }
  }
  if (stageEvidence === undefined) {
    fail('production.stage_evidence or production_state is required', 'LEXICAL_PRODUCTION_STAGE_REQUIRED');
  }
  const stages = requireObject(stageEvidence, 'production.stage_evidence');
  const stageIds = [
    'candidate_intake',
    'semantic_review',
    'selection',
    'prospective_canonical',
    'audit',
    'admission',
  ];
  for (const stageId of stageIds) {
    const stage = requireObject(stages[stageId], `production.stage_evidence.${stageId}`);
    if (stage.status !== 'complete') {
      fail(
        `production.stage_evidence.${stageId}.status must be complete`,
        'LEXICAL_PRODUCTION_STAGE_REQUIRED',
      );
    }
    requireString(stage.source_path, `production.stage_evidence.${stageId}.source_path`);
    const sourceBytes = requireSourceBytes(
      stage.source_bytes,
      `production.stage_evidence.${stageId}.source_bytes`,
    );
    if (stage.source_sha256 !== undefined && productionBytesSha256(sourceBytes) !== stage.source_sha256) {
      fail(
        `production.stage_evidence.${stageId}.source_sha256 does not match its source bytes`,
        'LEXICAL_PRODUCTION_STAGE_BINDING',
      );
    }
  }
  try {
    const run = createLexicalProductionRun({ batchId });
    const typedPayloadSpecs = payloadSpecs ?? expectedPayloads?.payload_specs;
    const tokens = {};
    const methodNames = {
      candidate_intake: 'completeCandidateIntake',
      semantic_review: 'completeSemanticReview',
      selection: 'completeSelection',
      prospective_canonical: 'completeProspectiveCanonical',
      audit: 'completeAudit',
    };
    for (const stageId of stageIds.slice(0, 4)) {
      const stage = stages[stageId];
      const previousStageId = stageIds[stageIds.indexOf(stageId) - 1];
      tokens[stageId] = run[methodNames[stageId]]({
        ...(previousStageId ? { predecessor: tokens[previousStageId] } : {}),
        sourcePath: stage.source_path,
        payloadSpec: typedPayloadSpecs?.[stageId],
        ...(stageId === 'selection' ? { policy: stage.policy ?? 'shared-selection-policy' } : {}),
      });
    }
    const auditEvidence = stages.audit;
    const admissionEvidence = stages.admission;
    const authorizationBytes = admissionEvidence.authorization_bytes === undefined
      ? admissionEvidence.source_bytes
      : admissionEvidence.authorization_bytes;
    const auditStage = {
      predecessor: tokens.prospective_canonical,
      sourcePath: auditEvidence.source_path,
    };
    const admissionStage = {
      sourcePath: admissionEvidence.source_path,
    };
    const preAuditState = run.getPreAuditState();
    const preAuditSources = run.getPreAuditSourceBytesByStage();
    validateLexicalProductionPreAuditState(preAuditState, {
      batchId,
      sourceBytesByStage: preAuditSources,
      expectedPayloads,
    });
    return {
      state: undefined,
      run,
      authorization: undefined,
      authorizationEvidence: {
        authorizationRef: admissionEvidence.authorization_ref,
        authorizationBytes,
      },
      auditStage,
      admissionStage,
      sources: preAuditSources,
    };
  } catch (error) {
    fail(`production stage evidence failed: ${error.message}`, error.code);
  }
}

/**
 * Batch-neutral production/review orchestration.
 *
 * A caller supplies candidate records and source-bound review rows.  The
 * function owns the stage order and shared semantic checks; a batch may only
 * add its own scope/count/ID policy around the returned result.
 */
export function validateLexicalProduction({
  batchId,
  candidateRecords,
  reviews,
  corrections = [],
  baseRecords,
  prospectiveRecords,
  semanticAudit,
  stageEvidence,
  productionState,
  productionStateSources,
  productionPayloads,
  allowReplay = false,
  checkPilotCompleteness = false,
  catalogCount,
  expectedSelectedCount,
  candidateLabel = 'production candidate records',
  reviewedLabel = 'production reviewed records',
  prospectiveLabel = 'production prospective canonical records',
  requireIndependentDecisionEvidence = true,
} = {}) {
  if (allowReplay === true) {
    fail(
      'generic lexical production never accepts replay; use an explicit historical validator boundary',
      'LEXICAL_PRODUCTION_REPLAY_FORBIDDEN',
    );
  }
  if (typeof batchId !== 'string' || batchId.trim().length === 0) {
    fail('production.batch_id must be a non-empty string', 'LEXICAL_PRODUCTION_SCOPE');
  }
  const candidates = requireArray(candidateRecords, 'production.candidate_records');
  const reviewRows = requireArray(reviews, 'production.reviews');
  const correctionRows = requireArray(corrections, 'production.corrections');
  if (candidates.length === 0 && correctionRows.length === 0) {
    fail('production must contain candidate records or reviewed corrections', 'LEXICAL_PRODUCTION_SCOPE');
  }
  if (reviewRows.length !== candidates.length) {
    fail('production.reviews must cover every candidate record', 'LEXICAL_PRODUCTION_SCOPE');
  }
  if (catalogCount !== undefined && catalogCount !== candidates.length) {
    fail(
      `production.catalog_count ${catalogCount} must cover the complete candidate pool (${candidates.length})`,
      'LEXICAL_PRODUCTION_SCOPE',
    );
  }
  if (baseRecords === undefined) {
    fail('production.base_records is required; admissions must bind the current canonical base', 'LEXICAL_PROSPECTIVE_REQUIRED');
  }
  if (prospectiveRecords === undefined) {
    fail('production.prospective_records is required; partial batch input cannot be admitted', 'LEXICAL_PROSPECTIVE_REQUIRED');
  }
  if (semanticAudit === undefined) {
    fail('production.semantic_audit is required; semantic coverage cannot be inferred from a batch delta', 'SEMANTIC_AUDIT_REQUIRED');
  }
  const candidateRecordsById = new Map();
  for (const [index, candidateInfo] of candidates.entries()) {
    const candidate = recordOf(candidateInfo);
    requireString(candidate.id, `production.candidate_records[${index}].id`);
    if (candidateRecordsById.has(candidate.id)) {
      fail(`production.candidate_records contains duplicate candidate ${candidate.id}`, 'LEXICAL_PRODUCTION_SCOPE');
    }
    candidateRecordsById.set(candidate.id, candidate);
  }
  try {
    validateBulkGlossProjection(candidates, { maxOccurrences: 3 });
  } catch (error) {
    fail(`production candidate semantic content failed shared diversity validation: ${error.message}`, error.code);
  }
  // `prospectiveRecords` is the complete base-plus-import dictionary by
  // contract.  Apply the same invariant at this producer boundary so a
  // candidate cannot evade the guard merely by splitting a repeated template
  // across batches; the admission audit repeats the check after all evidence
  // and bindings have been validated.
  try {
    validateBulkGlossProjection(prospectiveRecords, { maxOccurrences: 3 });
  } catch (error) {
    fail(`production prospective canonical content failed shared diversity validation: ${error.message}`, error.code);
  }
  const selectedRecords = [];
  const ranks = [];
  const selectedRanks = [];
  const candidateIds = new Set();
  for (const [index, rawEntry] of reviewRows.entries()) {
    const entry = semanticReviewInput(rawEntry, index);
    const candidate = recordOf(candidates[index]);
    if (entry.candidate_id !== candidate.id) {
      fail(`production.reviews[${index}].candidate_id is not bound to ${candidate.id}`, 'LEXICAL_PRODUCTION_BINDING');
    }
    if (candidateIds.has(entry.candidate_id)) {
      fail(`production.reviews contains duplicate candidate ${entry.candidate_id}`, 'LEXICAL_PRODUCTION_SCOPE');
    }
    candidateIds.add(entry.candidate_id);
    const reviewedRecord = entry.reviewed_record ? recordOf(entry.reviewed_record) : undefined;
    const selectedForAdmission = entry.selection_status === undefined
      ? ['included', 'corrected'].includes(entry.decision)
      : entry.selection_status === 'selected';
    if (entry.selection_status !== undefined
      && !['selected', 'reserve', 'excluded'].includes(entry.selection_status)) {
      fail(`production.reviews[${index}].selection_status is unsupported`, 'LEXICAL_PRODUCTION_SELECTION');
    }
    if (selectedForAdmission) {
      if (!['included', 'corrected'].includes(entry.decision)) {
        fail(`production.reviews[${index}] selected status requires an included or corrected decision`, 'LEXICAL_PRODUCTION_SELECTION');
      }
      if (!reviewedRecord) fail(`production.reviews[${index}] selected decision is missing reviewed_record`, 'LEXICAL_PRODUCTION_REVIEW_MISSING');
      if (reviewedRecord.id !== candidate.id) {
        fail(
          `production.reviews[${index}].reviewed_record.id must equal the reviewed candidate ${candidate.id}`,
          'LEXICAL_PRODUCTION_BINDING',
        );
      }
      const duplicateSelectedId = selectedRecords.some((recordInfo) => recordOf(recordInfo).id === reviewedRecord.id);
      if (duplicateSelectedId) {
        fail(`production.reviews selects duplicate reviewed record ${reviewedRecord.id}`, 'LEXICAL_PRODUCTION_SCOPE');
      }
      selectedRecords.push({
        record: entry.reviewed_record,
        decision: entry.decision,
        semantic_review: entry.semantic_review,
      });
    } else if (reviewedRecord) {
      fail(`production.reviews[${index}] non-selected decision must not carry reviewed_record`, 'LEXICAL_PRODUCTION_REVIEW_MISMATCH');
    }
    let result;
    try {
      result = validateLexicalSemanticReview(entry.semantic_review, {
        decision: entry.decision,
        selectionStatus: entry.selection_status,
        candidateRecord: candidate,
        reviewedRecord,
        inventoryId: entry.inventory_id,
        expectedRecordType: entry.expected_record_type,
        catalogCount: catalogCount ?? candidates.length,
        requireSemanticEvidence: true,
        requireIndependentDecisionEvidence,
        selectionRationaleTokens: ['verification', 'coverage'],
      });
    } catch (error) {
      fail(`production.reviews[${index}] semantic review failed: ${error.message}`, error.code);
    }
    ranks.push(result.selection_rank);
    if (selectedForAdmission) {
      selectedRanks.push(result.selection_rank);
    }
  }

  const correctionRecords = [];
  const correctionIds = new Set();
  const baseRecordsById = new Map(
    (baseRecords ?? []).map((recordInfo) => [recordOf(recordInfo).id, recordOf(recordInfo)]),
  );
  for (const [index, rawEntry] of correctionRows.entries()) {
    const label = `production.corrections[${index}]`;
    const entry = requireObject(rawEntry, label);
    requireString(entry.record_id, `${label}.record_id`);
    if (correctionIds.has(entry.record_id)) {
      fail(`${label}.record_id is duplicated`, 'LEXICAL_PRODUCTION_SCOPE');
    }
    correctionIds.add(entry.record_id);
    if (entry.decision !== 'corrected') {
      fail(`${label}.decision must be corrected`, 'LEXICAL_PRODUCTION_DECISION');
    }
    const baseRecord = baseRecordsById.get(entry.record_id);
    if (!baseRecord) {
      fail(`${label}.record_id is not present in base_records`, 'LEXICAL_PRODUCTION_BINDING');
    }
    const reviewedRecord = recordOf(entry.reviewed_record);
    if (!reviewedRecord || reviewedRecord.id !== entry.record_id) {
      fail(`${label}.reviewed_record must replace the named base record`, 'LEXICAL_PRODUCTION_BINDING');
    }
    requireObject(entry.semantic_review, `${label}.semantic_review`);
    let result;
    try {
      result = validateLexicalSemanticReview(entry.semantic_review, {
        decision: 'corrected',
        candidateRecord: baseRecord,
        reviewedRecord,
        inventoryId: entry.inventory_id,
        expectedRecordType: entry.expected_record_type,
        catalogCount: catalogCount ?? Math.max(candidates.length, 1),
        requireSemanticEvidence: true,
        requireIndependentDecisionEvidence,
        selectionRationaleTokens: ['verification', 'coverage'],
      });
    } catch (error) {
      fail(`${label} semantic review failed: ${error.message}`, error.code);
    }
    correctionRecords.push({
      record: reviewedRecord,
      decision: 'corrected',
      semantic_review: entry.semantic_review,
    });
    ranks.push(result.selection_rank);
    selectedRanks.push(result.selection_rank);
  }

  if (new Set(ranks).size !== ranks.length) {
    fail('production semantic selection ranks must be unique', 'LEXICAL_PRODUCTION_SELECTION');
  }
  const selectedCount = selectedRecords.length + correctionRecords.length;
  if (expectedSelectedCount !== undefined && selectedCount !== expectedSelectedCount) {
    fail(`production selected ${selectedCount} record(s), expected ${expectedSelectedCount}`, 'LEXICAL_PRODUCTION_SELECTION');
  }

  const prospectiveRecordsById = new Map(
    prospectiveRecords.map((recordInfo) => [recordOf(recordInfo).id, recordOf(recordInfo)]),
  );
  for (const [index, entry] of reviewRows.entries()) {
    const selectedForAdmission = entry.selection_status === undefined
      ? ['included', 'corrected'].includes(entry.decision)
      : entry.selection_status === 'selected';
    if (!selectedForAdmission) continue;
    const reviewedRecord = recordOf(entry.reviewed_record);
    const prospectiveRecord = prospectiveRecordsById.get(reviewedRecord.id);
    if (!prospectiveRecord || JSON.stringify(prospectiveRecord) !== JSON.stringify(reviewedRecord)) {
      fail(
        `production.reviews[${index}].reviewed_record is not present unchanged in prospective_records`,
        'LEXICAL_PRODUCTION_BINDING',
      );
    }
  }

  const preAuditPayloads = productionState === undefined
    ? createPreAuditPayloads({
      batchId,
      candidates,
      reviewRows,
      selectedRecords,
      correctionRecords,
      ranks,
      selectedRanks,
      baseRecords,
      prospectiveRecords,
    })
    : productionPayloads;
  const productionContext = validateStageEvidence(stageEvidence, {
    productionState,
    batchId,
    productionStateSources,
    expectedPayloads: preAuditPayloads,
    payloadSpecs: preAuditPayloads?.payload_specs,
    allowReplay,
  });

  let admission;
  try {
    admission = validateLexicalAddition({
      batchId,
      candidateRecords: candidates,
      reviewedRecords: [...selectedRecords, ...correctionRecords],
      baseRecords,
      prospectiveRecords,
      semanticAudit,
      productionState: productionContext.state,
      productionStateSources: productionContext.sources,
      productionRun: productionContext.run,
      productionAuditStage: productionContext.auditStage,
      productionAuthorizationEvidence: productionContext.authorizationEvidence,
      productionAdmissionStage: productionContext.admissionStage,
      productionPayloads: preAuditPayloads,
      allowReplay,
      checkPilotCompleteness,
      candidateLabel,
      reviewedLabel,
      prospectiveLabel,
    });
  } catch (error) {
    fail(`production admission failed: ${error.message}`, error.code);
  }
  return {
    pipeline_version: LEXICAL_PRODUCTION_PIPELINE_VERSION,
    batch_id: batchId,
    candidate_count: candidates.length,
    selected_count: selectedCount,
    correction_count: correctionRecords.length,
    review_count: reviewRows.length,
    selection_ranks: ranks,
    production_state: admission.production_state,
    production_state_sources: productionContext.run
      ? productionContext.run.getSourceBytesByStage()
      : productionContext.sources,
    production_payloads: admission.production_payloads,
    admission,
  };
}
