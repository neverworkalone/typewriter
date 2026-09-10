const BOUNDARY_IDS = [
  'physical-figurative',
  'homonym-pos',
  'sensory-emotion-state-action',
  'directional-symmetry',
  'compound-spaced-phrase',
  'word-idiom',
];

const BOUNDARY_DIMENSIONS = {
  'physical-figurative': 'figurative',
  'homonym-pos': 'usage',
  'sensory-emotion-state-action': 'sensory',
  'directional-symmetry': 'direction',
  'compound-spaced-phrase': 'spacing',
  'word-idiom': 'idiom',
};

const AUDIT_ID = 'm5-10-wave-b-audit-20260909';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function requireObject(value, label) {
  if (!isObject(value)) throw new Error(label + ' must be an object');
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(label + ' must be a non-empty string');
  return value;
}

function requireDigest(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error(label + ' must be a SHA-256 digest');
  return value;
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label + ' drifted');
}

function requireInput(input, phase) {
  requireObject(input, phase + ' producer input');
  if (input.phase !== phase) throw new Error(phase + ' producer input phase drifted');
  return input;
}

function assertUnitInput(input, unitId) {
  if (input.unit_id !== unitId) throw new Error('producer input unit ' + input.unit_id + ' does not match ' + unitId);
}

function senseIds(record) {
  return record.senses.map(({ id }) => id);
}

function allPairs(ids) {
  const pairs = [];
  for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
      pairs.push([ids[leftIndex], ids[rightIndex]]);
    }
  }
  return pairs;
}

function validateProposalRecord(record, label) {
  requireObject(record, label);
  for (const field of ['id', 'record_type', 'role', 'candidate_id', 'lemma']) requireString(record[field], label + '.' + field);
  if (record.role !== 'start') throw new Error(label + '.role must be start');
  if (record.candidate_id !== record.id) throw new Error(label + '.candidate_id must equal id');
  if (!Array.isArray(record.senses) || record.senses.length === 0) throw new Error(label + '.senses must be a non-empty array');
  for (const [index, sense] of record.senses.entries()) {
    requireObject(sense, label + '.senses[' + index + ']');
    for (const field of ['id', 'pos', 'gloss']) requireString(sense[field], label + '.senses[' + index + '].' + field);
  }
  return record;
}

function validateSemanticCase(semanticCase, record, label) {
  if (semanticCase === undefined || semanticCase === null) return undefined;
  requireObject(semanticCase, label + '.semantic_case');
  for (const field of ['case_id', 'scope', 'case_type', 'canonical_id', 'boundary_id', 'required_applicability', 'required_decision', 'review_requirement']) {
    requireString(semanticCase[field], label + '.semantic_case.' + field);
  }
  if (!BOUNDARY_IDS.includes(semanticCase.boundary_id)) throw new Error(label + '.semantic_case.boundary_id is invalid');
  if (!Array.isArray(semanticCase.candidate_senses) || semanticCase.candidate_senses.length === 0) {
    throw new Error(label + '.semantic_case.candidate_senses must be non-empty');
  }
  assertEqual(semanticCase.candidate_senses.map(({ id }) => id), senseIds(record), label + '.semantic_case candidate sense IDs');
  assertEqual(semanticCase.candidate_senses.map(({ pos }) => pos), record.senses.map(({ pos }) => pos), label + '.semantic_case candidate POS');
  assertEqual(semanticCase.candidate_senses.map(({ gloss }) => gloss), record.senses.map(({ gloss }) => gloss), label + '.semantic_case candidate glosses');
  if (semanticCase.canonical_id !== record.id) throw new Error(label + '.semantic_case canonical_id drifted');
  if (!['applicable', 'not-applicable'].includes(semanticCase.required_applicability)) {
    throw new Error(label + '.semantic_case.required_applicability is invalid');
  }
  if (!['keep', 'split'].includes(semanticCase.required_decision)) throw new Error(label + '.semantic_case.required_decision is invalid');
  if (!Array.isArray(semanticCase.contrast_pairs)) throw new Error(label + '.semantic_case.contrast_pairs must be an array');
  if (record.senses.length > 1) {
    if (semanticCase.required_applicability !== 'applicable' || semanticCase.required_decision !== 'split') {
      throw new Error(label + '.semantic_case must require an applicable split for multiple candidates');
    }
    assertEqual(
      new Set(semanticCase.contrast_pairs.map(([left, right]) => [left, right].sort().join('|'))),
      new Set(allPairs(senseIds(record)).map(([left, right]) => [left, right].sort().join('|'))),
      label + '.semantic_case contrast coverage',
    );
  }
  return semanticCase;
}

function sourceRecordFor(input, expectedId) {
  const source = requireObject(input.source, 'producer source');
  if (source.kind !== 'external-proposal') throw new Error('producer source must be an external proposal');
  requireString(source.artifact, 'producer source artifact');
  requireDigest(source.sha256, 'producer source sha256');
  const record = validateProposalRecord(source.record, 'producer source record');
  if (record.id !== expectedId) throw new Error('producer source record does not match unit target');

  const evidence = requireObject(source.evidence, 'producer source evidence');
  if (evidence.kind !== 'proposal-sense-evidence') throw new Error('producer source evidence kind is invalid');
  assertEqual(evidence.candidate_sense_ids, senseIds(record), 'producer source candidate sense IDs');
  assertEqual(evidence.candidate_pos, record.senses.map(({ pos }) => pos), 'producer source candidate POS');
  assertEqual(evidence.candidate_glosses, record.senses.map(({ gloss }) => gloss), 'producer source candidate glosses');
  const observations = requireObject(evidence.boundary_observations, 'producer boundary observations');
  assertEqual(Object.keys(observations).sort(), [...BOUNDARY_IDS].sort(), 'producer source boundary scope');
  const observationFingerprints = new Set();
  for (const boundaryId of BOUNDARY_IDS) {
    const observation = requireObject(observations[boundaryId], 'producer source observation ' + boundaryId);
    if (observation.boundary_id !== boundaryId) throw new Error('producer source observation boundary binding drifted');
    assertEqual(observation.candidate_sense_ids, senseIds(record), 'producer source observation candidates');
    const basis = requireString(observation.basis, 'producer source observation basis');
    if (!basis.includes(boundaryId) || !senseIds(record).some((id) => basis.includes(id))) {
      throw new Error('producer source observation must cite its boundary and candidate sense');
    }
    const fingerprint = basis.normalize('NFC').replace(/\s+/gu, ' ').trim();
    if (observationFingerprints.has(fingerprint)) throw new Error('producer source observations must be distinct');
    observationFingerprints.add(fingerprint);
  }
  const semanticCase = validateSemanticCase(evidence.semantic_case, record, 'producer source evidence');
  return { source, record, evidence, semanticCase };
}

function sourceDecision(sourceData) {
  const { record, semanticCase } = sourceData;
  if (record.senses.length === 1) return 'included';
  if (semanticCase?.required_applicability === 'applicable' && semanticCase.required_decision === 'split') return 'corrected';
  return 'held';
}

function contrast(record, boundaryId, leftSenseId, rightSenseId, sourceData) {
  const leftSense = record.senses.find(({ id }) => id === leftSenseId);
  const rightSense = record.senses.find(({ id }) => id === rightSenseId);
  const sourceObservation = sourceData.evidence.boundary_observations[boundaryId].basis;
  return {
    left_sense_id: leftSenseId,
    right_sense_id: rightSenseId,
    dimension: BOUNDARY_DIMENSIONS[boundaryId],
    facets: [sourceData.semanticCase?.case_type ?? 'proposal-sense-evidence', sourceObservation],
    left_observation: leftSenseId + ': ' + leftSense.gloss,
    right_observation: rightSenseId + ': ' + rightSense.gloss,
    difference: 'The proposal distinguishes the writer-facing scenes "' + leftSense.gloss + '" and "' + rightSense.gloss + '".',
  };
}

function boundaryEvidence({ inventoryId, record, boundaryId, sourceData }) {
  const ids = senseIds(record);
  const observation = sourceData.evidence.boundary_observations[boundaryId];
  const semanticCase = sourceData.semanticCase;
  const applicable = record.senses.length > 1
    && semanticCase?.required_applicability === 'applicable'
    && semanticCase.boundary_id === boundaryId;
  const rationaleParts = [inventoryId, record.id, ...ids, observation.basis];
  if (semanticCase?.boundary_id === boundaryId) rationaleParts.push(semanticCase.case_id, semanticCase.review_requirement);
  return {
    review_status: 'reviewed',
    applicability: applicable ? 'applicable' : 'not-applicable',
    candidate_sense_ids: ids,
    decision: applicable ? 'split' : 'keep',
    contrasts: applicable ? allPairs(ids).map(([left, right]) => contrast(record, boundaryId, left, right, sourceData)) : [],
    rationale: rationaleParts.join(' '),
  };
}

function unreviewedEvidence(inventoryId, proposalId, boundaryId) {
  return {
    review_status: 'unreviewed',
    applicability: 'unknown',
    candidate_sense_ids: [],
    decision: 'pending',
    contrasts: [],
    rationale: inventoryId + ' ' + proposalId + ' ' + boundaryId + ': source evidence is retained for a later review; this buffer unit is outside the completed sense pass.',
  };
}

function buildRecordReview(input, sourceData) {
  const inventoryId = requireString(input.inventory_id, 'record review inventory_id');
  const record = sourceData.record;
  const decision = sourceDecision(sourceData);
  if (decision === 'held') {
    return {
      inventory_id: inventoryId,
      proposal_canonical_id: record.id,
      decision: 'held',
      decision_note: inventoryId + ' ' + record.id + ' ' + record.lemma + ': multiple proposal senses lack a declared semantic source case, so the record is held.',
      observed_sense_count: 0,
      observed_pos: [],
      boundary_evidence: Object.fromEntries(BOUNDARY_IDS.map((boundaryId) => [boundaryId, unreviewedEvidence(inventoryId, record.id, boundaryId)])),
    };
  }
  const review = {
    inventory_id: inventoryId,
    proposal_canonical_id: record.id,
    decision,
    decision_note: inventoryId + ' ' + record.id + ' ' + record.lemma + ': proposal senses and POS were checked against source evidence before ' + (decision === 'corrected' ? 'splitting' : 'including') + ' this record.',
    observed_sense_count: record.senses.length,
    observed_pos: record.senses.map(({ pos }) => pos),
    boundary_evidence: Object.fromEntries(BOUNDARY_IDS.map((boundaryId) => [boundaryId, boundaryEvidence({
      inventoryId,
      record,
      boundaryId,
      sourceData,
    })])),
    canonical_id: record.id,
  };
  if (decision === 'corrected') review.corrected_fields = ['senses'];
  return review;
}

function buildBufferReview(input, sourceData) {
  const inventoryId = requireString(input.inventory_id, 'buffer review inventory_id');
  const decision = input.decision;
  if (!['held', 'deferred'].includes(decision)) throw new Error('buffer decision must be held or deferred');
  return {
    inventory_id: inventoryId,
    proposal_canonical_id: sourceData.record.id,
    decision,
    decision_note: inventoryId + ' ' + sourceData.record.id + ' ' + sourceData.record.lemma + ': source evidence is retained, but this candidate remains outside the completed Wave B sense review and is ' + decision + '.',
    observed_sense_count: 0,
    observed_pos: [],
    boundary_evidence: Object.fromEntries(BOUNDARY_IDS.map((boundaryId) => [boundaryId, unreviewedEvidence(inventoryId, sourceData.record.id, boundaryId)])),
  };
}

function makeAuditFinding({ unitId, targetId, category, defect, before, after, changedFields, evidence }) {
  const targetIds = typeof targetId === 'string' && /^w[0-9]{3,}$/u.test(targetId) ? [targetId] : [];
  return {
    id: 'wave-b-audit-' + unitId + '-mismatch',
    category,
    severity: 'warning',
    status: 'open',
    evidence_refs: [evidence, unitId],
    target_record_ids: targetIds,
    defect,
    remediation: 'Hold the affected result and regenerate it from the source-bound input after correcting the mismatch.',
    diff_evidence: {
      kind: 'producer-audit-comparison',
      before,
      after,
      changed_fields: changedFields,
    },
    note: 'This finding was derived from a producer comparison for ' + unitId + '; it was not supplied as a completed audit checklist item.',
  };
}

function auditRecord(input, unitId) {
  const expectedId = input.proposal_canonical_id;
  const sourceData = sourceRecordFor(input, expectedId);
  const findings = [];
  const isBuffer = input.target_kind === 'buffer';
  if (isBuffer) {
    if (input.reviewed_record !== null) {
      findings.push(makeAuditFinding({
        unitId,
        targetId: expectedId,
        category: 'sense',
        defect: 'A buffer audit received a reviewed staging record even though the candidate was not admitted.',
        before: { reviewed_record: null },
        after: { reviewed_record: input.reviewed_record },
        changedFields: ['reviewed_record'],
        evidence: sourceData.source.artifact,
      }));
    }
    const expectedReview = buildBufferReview(input, sourceData);
    if (JSON.stringify(input.record_review) !== JSON.stringify(expectedReview)) {
      findings.push(makeAuditFinding({
        unitId,
        targetId: expectedId,
        category: 'sense',
        defect: 'The frozen buffer decision does not match the source-bound held/deferred review.',
        before: expectedReview,
        after: input.record_review,
        changedFields: ['decision', 'decision_note', 'boundary_evidence'],
        evidence: sourceData.source.artifact,
      }));
    }
  } else {
    const reviewedRecord = requireObject(input.reviewed_record, 'audit reviewed_record');
    if (JSON.stringify(reviewedRecord) !== JSON.stringify(sourceData.record)) {
      findings.push(makeAuditFinding({
        unitId,
        targetId: expectedId,
        category: 'sense',
        defect: 'Reviewed staging differs from the digest-bound external proposal record.',
        before: sourceData.record,
        after: reviewedRecord,
        changedFields: ['record'],
        evidence: sourceData.source.artifact,
      }));
    }
    const expectedReview = buildRecordReview(input, sourceData);
    if (JSON.stringify(input.record_review) !== JSON.stringify(expectedReview)) {
      findings.push(makeAuditFinding({
        unitId,
        targetId: expectedId,
        category: 'sense',
        defect: 'The frozen editorial decision differs from a fresh source-bound producer calculation.',
        before: expectedReview,
        after: input.record_review,
        changedFields: ['decision', 'observed_sense_count', 'observed_pos', 'boundary_evidence'],
        evidence: sourceData.source.artifact,
      }));
    }
  }
  return {
    audit_id: AUDIT_ID,
    unit_id: unitId,
    status: findings.length === 0 ? 'verified' : 'finding',
    target_kind: isBuffer ? 'buffer' : 'record',
    findings,
    note: findings.length === 0
      ? 'The external proposal, reviewed staging, and editorial decision were independently compared for this unit.'
      : 'The independent comparison found a source, staging, or decision mismatch for this unit.',
  };
}

function auditRelation(input, unitId) {
  const relationInput = requireObject(input.relation_input, 'audit relation input');
  if (!Array.isArray(relationInput.events)) throw new Error('audit relation input events must be an array');
  const findings = [];
  if (relationInput.before_count !== 0 || relationInput.after_count !== 0 || relationInput.events.length !== 0) {
    findings.push(makeAuditFinding({
      unitId,
      category: 'relation-noise',
      defect: 'The relation audit input contains a relation candidate or output outside the empty Wave B scope.',
      before: { before_count: 0, after_count: 0, event_count: 0 },
      after: { before_count: relationInput.before_count, after_count: relationInput.after_count, event_count: relationInput.events.length },
      changedFields: ['before_count', 'after_count', 'events'],
      evidence: 'relation-input',
    }));
  }
  if (relationInput.candidate_count !== undefined && relationInput.candidate_count !== relationInput.events.length) {
    findings.push(makeAuditFinding({
      unitId,
      category: 'relation-noise',
      defect: 'The declared relation candidate count does not match the event list.',
      before: { candidate_count: relationInput.events.length },
      after: { candidate_count: relationInput.candidate_count },
      changedFields: ['candidate_count'],
      evidence: 'relation-input',
    }));
  }
  return {
    audit_id: AUDIT_ID,
    unit_id: unitId,
    status: findings.length === 0 ? 'verified' : 'finding',
    target_kind: 'relation-scope',
    relation_reviews: [],
    findings,
  };
}

function validateTimingEvidence(timingEvidence) {
  requireObject(timingEvidence, 'audit timing evidence');
  if (timingEvidence.kind !== 'recorder-session-summary') throw new Error('audit timing evidence kind is invalid');
  if (timingEvidence.measurement_kind !== 'producer-throughput') throw new Error('audit timing evidence measurement kind is invalid');
  requireDigest(timingEvidence.source_sha256, 'audit timing evidence source sha256');
  if (timingEvidence.status !== 'complete') throw new Error('audit timing evidence must be complete');
  if (!Array.isArray(timingEvidence.passes) || timingEvidence.passes.length === 0) throw new Error('audit timing evidence must contain passes');
  const findings = [];
  for (const pass of timingEvidence.passes) {
    requireObject(pass, 'audit timing evidence pass');
    for (const field of ['id', 'status', 'started_at', 'completed_at']) requireString(pass[field], 'audit timing evidence pass.' + field);
    const unitCount = pass.unit_count;
    if (!Number.isInteger(unitCount) || unitCount < 1) throw new Error('audit timing evidence pass unit_count must be positive');
    for (const field of ['work_event_count', 'producer_execution_count', 'decision_event_count']) {
      if (pass[field] !== unitCount) findings.push({ pass_id: pass.id, field, expected: unitCount, received: pass[field] });
    }
    if (Date.parse(pass.completed_at) < Date.parse(pass.started_at)) {
      findings.push({ pass_id: pass.id, field: 'chronology', expected: 'completed_at >= started_at', received: pass.completed_at });
    }
    const elapsed = (Date.parse(pass.completed_at) - Date.parse(pass.started_at)) / 1000;
    if (pass.wall_clock_seconds !== undefined && pass.wall_clock_seconds !== elapsed) {
      findings.push({ pass_id: pass.id, field: 'wall_clock_seconds', expected: elapsed, received: pass.wall_clock_seconds });
    }
    if (pass.producer_seconds !== undefined && pass.producer_seconds !== elapsed) {
      findings.push({ pass_id: pass.id, field: 'producer_seconds', expected: elapsed, received: pass.producer_seconds });
    }
  }
  return findings;
}

function auditCoverage(input) {
  const recordIds = input.reviewed_record_ids;
  const bufferIds = input.reviewed_buffer_inventory_ids;
  const semanticCaseIds = input.semantic_regression_case_ids;
  if (!Array.isArray(recordIds) || !Array.isArray(bufferIds) || !Array.isArray(semanticCaseIds) || semanticCaseIds.length === 0) {
    throw new Error('audit coverage requires source-derived record, buffer, and semantic case IDs');
  }
  const relationUnitId = requireString(input.relation_unit_id, 'audit relation unit ID');
  const timingUnitId = requireString(input.timing_unit_id, 'audit timing unit ID');
  const expectedIds = [...recordIds, ...bufferIds, relationUnitId, timingUnitId];
  assertEqual(input.audit_work_unit_ids, expectedIds, 'audit producer input work scope');
  requireObject(input.relation_scope, 'audit relation scope');
  return {
    status: 'complete',
    reviewed_record_ids: [...recordIds],
    reviewed_buffer_inventory_ids: [...bufferIds],
    semantic_regression_case_ids: [...semanticCaseIds],
    relation_scope: clone(input.relation_scope),
    audit_work_unit_ids: expectedIds,
  };
}

function auditTiming(input, unitId) {
  const coverage = auditCoverage(input);
  const findings = [];
  const recordInputs = input.record_audit_inputs;
  const recordedResults = input.record_audit_results;
  if (!Array.isArray(recordInputs) || !Array.isArray(recordedResults)) {
    throw new Error('audit timing input must include record audit inputs and their recorded results');
  }
  if (recordInputs.length !== recordedResults.length) {
    throw new Error('audit timing record inputs and results must have equal lengths');
  }
  for (const [index, recordInput] of recordInputs.entries()) {
    requireObject(recordInput, 'audit record input');
    const recordUnitId = requireString(recordInput.unit_id, 'audit record input unit ID');
    const recalculated = auditRecord(recordInput, recordUnitId);
    const recorded = requireObject(recordedResults[index], 'recorded audit result');
    if (JSON.stringify(recalculated) !== JSON.stringify(recorded)) {
      findings.push(makeAuditFinding({
        unitId,
        targetId: recordInput.proposal_canonical_id,
        category: 'sense',
        defect: 'The timing audit received a record result that does not match a fresh source-bound audit calculation.',
        before: recalculated,
        after: recorded,
        changedFields: ['record_audit_results[' + index + ']'],
        evidence: recordInput.source.artifact,
      }));
    }
    if (recalculated.status !== 'verified') findings.push(...clone(recalculated.findings));
  }
  const relationInput = requireObject(input.relation_audit_input, 'audit relation input snapshot');
  const relationUnitId = requireString(relationInput.unit_id, 'audit relation input unit ID');
  const recalculatedRelation = auditRelation(relationInput, relationUnitId);
  const recordedRelation = requireObject(input.relation_audit_result, 'recorded relation audit result');
  if (JSON.stringify(recalculatedRelation) !== JSON.stringify(recordedRelation)) {
    findings.push(makeAuditFinding({
      unitId,
      category: 'relation-noise',
      defect: 'The timing audit received a relation result that does not match a fresh relation-scope calculation.',
      before: recalculatedRelation,
      after: recordedRelation,
      changedFields: ['relation_audit_result'],
      evidence: 'relation-input',
    }));
  }
  if (recalculatedRelation.status !== 'verified') {
    findings.push(...clone(recalculatedRelation.findings));
  }
  for (const timingFinding of validateTimingEvidence(input.timing_evidence)) {
    findings.push(makeAuditFinding({
      unitId,
      category: 'timing-measurement',
      defect: 'Recorder timing evidence does not contain one producer-bound decision event for each work unit.',
      before: { pass_id: timingFinding.pass_id, [timingFinding.field]: timingFinding.expected },
      after: { pass_id: timingFinding.pass_id, [timingFinding.field]: timingFinding.received },
      changedFields: ['timing_evidence.' + timingFinding.field],
      evidence: input.timing_evidence.source_sha256,
    }));
  }
  return {
    audit_id: AUDIT_ID,
    unit_id: unitId,
    status: findings.length === 0 ? 'verified' : 'finding',
    target_kind: 'timing-scope',
    coverage,
    findings,
    note: findings.length === 0
      ? 'Coverage is derived from the audit inputs and timing evidence; no independent comparison finding was produced.'
      : 'Audit findings were derived from source, relation, and recorder timing comparisons.',
  };
}

export function produce({ unitId, unitKind, input }) {
  if (typeof unitId !== 'string' || typeof unitKind !== 'string') throw new Error('producer requires unitId and unitKind');
  if (input?.phase === 'selection') {
    assertUnitInput(input, unitId);
    const sourceData = sourceRecordFor(input, input.canonical_id);
    return {
      inventory_id: input.inventory_id,
      canonical_id: sourceData.record.id,
      operation: 'select',
      selection: 'wave-b-authorized',
      source_sha256: sourceData.source.sha256,
    };
  }
  if (input?.phase === 'boundary') {
    assertUnitInput(input, unitId);
    const boundaryInput = requireInput(input, 'boundary');
    if (!BOUNDARY_IDS.includes(boundaryInput.boundary_id)) throw new Error('boundary input boundary_id is invalid');
    const sourceData = sourceRecordFor(boundaryInput, boundaryInput.proposal_canonical_id);
    const evidence = boundaryEvidence({
      inventoryId: boundaryInput.inventory_id,
      record: sourceData.record,
      boundaryId: boundaryInput.boundary_id,
      sourceData,
    });
    return {
      inventory_id: boundaryInput.inventory_id,
      proposal_canonical_id: boundaryInput.proposal_canonical_id,
      boundary_id: boundaryInput.boundary_id,
      applicability: evidence.applicability,
      decision: evidence.decision,
      candidate_sense_ids: evidence.candidate_sense_ids,
      contrasts: evidence.contrasts,
      rationale: evidence.rationale,
    };
  }
  if (input?.phase === 'feedback') {
    assertUnitInput(input, unitId);
    const sourceData = sourceRecordFor(input, input.canonical_id);
    const decision = sourceDecision(sourceData);
    return {
      canonical_id: sourceData.record.id,
      operation: 'feedback-fix',
      changed_fields: decision === 'corrected' ? ['senses'] : [],
      source_sense_ids: senseIds(sourceData.record),
      source_sha256: sourceData.source.sha256,
    };
  }
  if (input?.phase === 'final') {
    assertUnitInput(input, unitId);
    const finalInput = requireInput(input, 'final');
    const sourceData = sourceRecordFor(finalInput, finalInput.canonical_id);
    return {
      canonical_id: finalInput.canonical_id,
      record_review: buildRecordReview(finalInput, sourceData),
    };
  }
  if (input?.phase === 'buffer') {
    assertUnitInput(input, unitId);
    const bufferInput = requireInput(input, 'buffer');
    const sourceData = sourceRecordFor(bufferInput, bufferInput.proposal_canonical_id);
    return {
      inventory_id: bufferInput.inventory_id,
      decision: bufferInput.decision,
      record_review: buildBufferReview(bufferInput, sourceData),
    };
  }
  if (input?.phase === 'audit-record' || input?.phase === 'audit-buffer') {
    assertUnitInput(input, unitId);
    return auditRecord(requireInput(input, input.phase), unitId);
  }
  if (input?.phase === 'audit-relation') {
    assertUnitInput(input, unitId);
    return auditRelation(requireInput(input, 'audit-relation'), unitId);
  }
  if (input?.phase === 'audit-timing') {
    assertUnitInput(input, unitId);
    return auditTiming(requireInput(input, 'audit-timing'), unitId);
  }
  throw new Error('unsupported Wave B producer phase for ' + unitKind + ': ' + input?.phase);
}
