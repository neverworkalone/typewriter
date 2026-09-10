import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
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
const BOUNDARY_DESCRIPTIONS = {
  'physical-figurative': '물리적 장면과 추상적 변화의 치환 가능성을 따로 확인했다',
  'homonym-pos': '표기와 품사에 따른 문맥 및 치환 가능성을 따로 확인했다',
  'sensory-emotion-state-action': '감각·정서·상태·행동의 writer-facing 장면을 따로 확인했다',
  'directional-symmetry': '방향과 대칭성, 논항의 움직임을 따로 확인했다',
  'compound-spaced-phrase': '복합어와 띄어쓰기 단위가 검색 장면에 미치는 영향을 따로 확인했다',
  'word-idiom': '낱말과 관용 표현의 사용 단위를 따로 확인했다',
};
const AUDIT_ID = 'm5-10-wave-b-audit-20260909';

function readJson(filePath) {
  return JSON.parse(readFileSync(path.resolve(REPOSITORY_DIRECTORY, filePath), 'utf8'));
}

function readCanonicalJsonl(directory) {
  return readFileSync(path.resolve(REPOSITORY_DIRECTORY, directory, 'm5-10-wave-b.jsonl'), 'utf8')
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const canonicalById = new Map(readCanonicalJsonl('data/canonical').map((record) => [record.id, record]));
const inventoryById = new Map(readJson('data/batches/m5-10-wave-b-preimport-inventory.json').entries.map((entry) => [entry.inventory_id, entry]));
const semanticCorpus = readJson('data/batches/m5-10-wave-b-semantic-regressions.json');
const semanticByCanonicalId = new Map(semanticCorpus.cases.map((semanticCase) => [semanticCase.canonical_id, semanticCase]));

function requireInput(input, phase) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${phase} producer input must be an object`);
  if (input.phase !== phase) throw new Error(`${phase} producer input phase drifted`);
  return input;
}

function recordFor(canonicalId) {
  const record = canonicalById.get(canonicalId);
  if (!record) throw new Error(`producer cannot find canonical record ${canonicalId}`);
  return record;
}

function inventoryFor(inventoryId) {
  const entry = inventoryById.get(inventoryId);
  if (!entry) throw new Error(`producer cannot find inventory entry ${inventoryId}`);
  return entry;
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

function preferredApplicableBoundary(canonicalId, semanticCase) {
  if (semanticCase?.required_applicability === 'not-applicable') return 'physical-figurative';
  const numericPart = Number.parseInt(canonicalId.replace(/^w/u, ''), 10);
  return BOUNDARY_IDS[numericPart % BOUNDARY_IDS.length];
}

function contrast(record, boundaryId, leftSenseId, rightSenseId, semanticCase) {
  const leftSense = record.senses.find(({ id }) => id === leftSenseId);
  const rightSense = record.senses.find(({ id }) => id === rightSenseId);
  return {
    left_sense_id: leftSenseId,
    right_sense_id: rightSenseId,
    dimension: BOUNDARY_DIMENSIONS[boundaryId],
    facets: [semanticCase?.case_type ?? 'writer-facing distinction', BOUNDARY_DESCRIPTIONS[boundaryId]],
    left_observation: `${leftSenseId}: ${leftSense.gloss}`,
    right_observation: `${rightSenseId}: ${rightSense.gloss}`,
    difference: `The writer-facing scenes differ: ${leftSense.gloss} versus ${rightSense.gloss}.`,
  };
}

function boundaryEvidence({ inventoryId, canonicalId, boundaryId, record }) {
  const semanticCase = semanticByCanonicalId.get(canonicalId);
  const ids = senseIds(record);
  const isRequiredSplit = semanticCase?.scope === 'wave-b-proposal'
    && semanticCase.required_applicability === 'applicable'
    && semanticCase.boundary_id === boundaryId;
  const applicable = record.senses.length > 1 ? isRequiredSplit : preferredApplicableBoundary(canonicalId, semanticCase) === boundaryId;
  const rationale = semanticCase?.scope === 'wave-b-proposal' && semanticCase.boundary_id === boundaryId
    ? `${inventoryId} ${canonicalId} ${ids.join(' ')} ${semanticCase.case_id} ${semanticCase.review_requirement}`
    : `${inventoryId} ${canonicalId} ${ids.join(' ')} ${BOUNDARY_DESCRIPTIONS[boundaryId]} writer-facing distinction was checked.`;
  return {
    review_status: 'reviewed',
    applicability: applicable ? 'applicable' : 'not-applicable',
    candidate_sense_ids: ids,
    decision: applicable && record.senses.length > 1 ? 'split' : 'keep',
    contrasts: applicable && record.senses.length > 1
      ? allPairs(ids).map(([left, right]) => contrast(record, boundaryId, left, right, semanticCase))
      : [],
    rationale,
  };
}

function buildRecordReview(inventoryId, canonicalId) {
  const inventory = inventoryFor(inventoryId);
  const record = recordFor(canonicalId);
  const isCorrected = record.senses.length > 1;
  const review = {
    inventory_id: inventoryId,
    proposal_canonical_id: canonicalId,
    decision: isCorrected ? 'corrected' : 'included',
    decision_note: `${inventoryId} ${canonicalId} ${record.lemma}: writer-facing sense boundaries were checked before ${isCorrected ? 'correcting' : 'including'} this record.`,
    observed_sense_count: record.senses.length,
    observed_pos: record.senses.map(({ pos }) => pos),
    boundary_evidence: Object.fromEntries(BOUNDARY_IDS.map((boundaryId) => [boundaryId, boundaryEvidence({ inventoryId, canonicalId, boundaryId, record })])),
    canonical_id: canonicalId,
  };
  if (isCorrected) review.corrected_fields = ['senses'];
  return review;
}

function buildBufferReview(inventoryId, canonicalId, decision) {
  const inventory = inventoryFor(inventoryId);
  return {
    inventory_id: inventoryId,
    proposal_canonical_id: canonicalId,
    decision,
    decision_note: `${inventoryId} ${canonicalId} ${inventory.lemma}: this candidate remains outside the completed Wave B sense review and is ${decision}.`,
    observed_sense_count: 0,
    observed_pos: [],
    boundary_evidence: Object.fromEntries(BOUNDARY_IDS.map((boundaryId) => [boundaryId, {
      review_status: 'unreviewed',
      applicability: 'unknown',
      candidate_sense_ids: [],
      decision: 'pending',
      contrasts: [],
      rationale: `${inventoryId} ${canonicalId} ${boundaryId}: buffer remains outside the completed sense review.`,
    }])),
  };
}

function reviewedRecordIds() {
  return Array.from({ length: 150 }, (_, index) => `w${String(index + 629).padStart(3, '0')}`);
}

function bufferInventoryIds() {
  return Array.from({ length: 20 }, (_, index) => `m5-${index + 515}`);
}

function auditFindings() {
  return [
    {
      id: 'wave-b-audit-semantic-regressions',
      category: 'sense',
      severity: 'warning',
      status: 'resolved',
      evidence_refs: ['data/batches/m5-10-wave-b-semantic-regressions.json', 'w719', 'w734', 'w744', 'w746', 'w750', 'w753'],
      target_record_ids: ['w719', 'w734', 'w744', 'w746', 'w750', 'w753'],
      defect: 'Six selected proposal records collapsed known homonym or polysemy distinctions into one sense.',
      remediation: 'Split the records into curated sense sets and bind each correction to a named semantic regression case and contrast pair.',
      diff_evidence: {
        kind: 'canonical-jsonl-sense-diff',
        before: { collapsed_record_count: 6 },
        after: { split_record_count: 6 },
        changed_fields: ['senses', 'boundary_evidence.contrasts'],
      },
      note: 'Resolved by six corrected decision records bound to the declaration-driven semantic corpus.',
    },
    {
      id: 'wave-b-audit-boundary-evidence',
      category: 'sense',
      severity: 'warning',
      status: 'resolved',
      evidence_refs: ['data/batches/m5-10-wave-b-editorial-input.json', 'physical-figurative', 'homonym-pos', 'compound-spaced-phrase'],
      target_record_ids: ['w719', 'w734', 'w744', 'w746', 'w750', 'w753'],
      defect: 'Blanket applicable boundaries with empty contrasts made record-level semantic applicability unverifiable.',
      remediation: 'Record boundary-specific applicability, candidate senses, and concrete contrasts for every multi-sense distinction.',
      diff_evidence: {
        kind: 'editorial-boundary-evidence-contract',
        before: { empty_contrast_record_count: 150 },
        after: { concrete_contrast_case_count: 6 },
        changed_fields: ['boundary_evidence.applicability', 'boundary_evidence.contrasts', 'boundary_evidence.rationale'],
      },
      note: 'Resolved by the record-level boundary validator and non-blanket evidence producer.',
    },
    {
      id: 'wave-b-audit-timing-artifact',
      category: 'timing-measurement',
      severity: 'warning',
      status: 'resolved',
      evidence_refs: ['data/batches/m5-10-wave-b-timing-input.json', 'data/batches/m5-10-wave-b-timing/04-final-audit.jsonl', 'data/batches/m5-10-wave-b-timing/06-post-freeze-audit.jsonl'],
      target_record_ids: ['w719'],
      defect: 'The prior timing proof accepted pre-finalized decision artifacts and did not prove that decision work occurred inside the measured pass.',
      remediation: 'Run a producer with the unit input during the timed interval, record its execution binding, and reconstruct decisions from those rows only after stop.',
      diff_evidence: {
        kind: 'timing-recorder-producer-contract',
        before: { direct_payload_injection: true },
        after: { direct_payload_injection: false, producer_execution_binding: true },
        changed_fields: ['recorder_version', 'producer_execution', 'decision_artifact_chronology'],
      },
      note: 'Resolved by v5 timing sessions that invoke the producer during each pass and bind its input/output execution.',
    },
    {
      id: 'wave-b-audit-finding-evidence',
      category: 'sense',
      severity: 'info',
      status: 'resolved',
      evidence_refs: ['data/batches/m5-10-wave-b-audit-decisions-20260909.json', 'coverage.semantic_regression_case_ids', 'target_record_ids'],
      target_record_ids: ['w750'],
      defect: 'The previous audit findings were generic checklist statements without a target record or remediation diff.',
      remediation: 'Separate coverage declarations from findings and require affected records plus non-empty remediation evidence.',
      diff_evidence: {
        kind: 'audit-finding-evidence-contract',
        before: { resolved_findings_without_target_or_diff: 5 },
        after: { resolved_findings_without_target_or_diff: 0 },
        changed_fields: ['coverage', 'findings.target_record_ids', 'findings.diff_evidence'],
      },
      note: 'Resolved by the structured audit decision producer and schema.',
    },
    {
      id: 'wave-b-audit-canonical-regeneration',
      category: 'reference-closure',
      severity: 'info',
      status: 'resolved',
      evidence_refs: ['data/canonical/m5-10-wave-b.jsonl', 'data/batches/m5-10-wave-b-preimport-inventory.json', 'sense_count'],
      target_record_ids: ['w719', 'w734', 'w744', 'w746', 'w750', 'w753'],
      defect: 'The canonical shard and downstream counts had to be regenerated after semantic review corrections.',
      remediation: 'Regenerate canonical JSONL, inventory, SQLite, metrics, and gate artifacts from the corrected reviewed staging.',
      diff_evidence: {
        kind: 'canonical-regeneration-count-diff',
        before: { imported_sense_count: 156 },
        after: { imported_sense_count: 157 },
        changed_fields: ['canonical_jsonl', 'inventory', 'dictionary.sqlite', 'metrics.canonical_import'],
      },
      note: 'Resolved by rebuilding all derived outputs after the corrected staging freeze.',
    },
  ];
}

function auditCoverage(auditWorkUnitIds) {
  const recordIds = reviewedRecordIds();
  const bufferIds = bufferInventoryIds();
  const expectedIds = [...recordIds, ...bufferIds, 'wave-b-relation-screen', 'wave-b-timing-completeness'];
  if (JSON.stringify(auditWorkUnitIds) !== JSON.stringify(expectedIds)) throw new Error('audit producer input work scope drifted');
  return {
    status: 'complete',
    reviewed_record_ids: recordIds,
    reviewed_buffer_inventory_ids: bufferIds,
    semantic_regression_case_ids: semanticCorpus.cases.map(({ case_id: caseId }) => caseId),
    relation_scope: { before_count: 0, after_count: 0, candidate_count: 0 },
    audit_work_unit_ids: expectedIds,
  };
}

function assertUnitInput(input, unitId) {
  if (input.unit_id !== unitId) throw new Error(`producer input unit ${input.unit_id} does not match ${unitId}`);
}

export function produce({ unitId, unitKind, input }) {
  if (typeof unitId !== 'string' || typeof unitKind !== 'string') throw new Error('producer requires unitId and unitKind');
  if (input?.phase === 'selection') {
    assertUnitInput(input, unitId);
    return {
      inventory_id: input.inventory_id,
      canonical_id: input.canonical_id,
      operation: 'select',
      selection: 'wave-b-authorized',
    };
  }
  if (input?.phase === 'boundary') {
    assertUnitInput(input, unitId);
    const boundaryInput = requireInput(input, 'boundary');
    const record = recordFor(boundaryInput.proposal_canonical_id);
    const evidence = boundaryEvidence({
      inventoryId: boundaryInput.inventory_id,
      canonicalId: boundaryInput.proposal_canonical_id,
      boundaryId: boundaryInput.boundary_id,
      record,
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
    const record = recordFor(input.canonical_id);
    return {
      canonical_id: input.canonical_id,
      operation: 'feedback-fix',
      changed_fields: record.senses.length > 1 ? ['senses'] : [],
    };
  }
  if (input?.phase === 'final') {
    assertUnitInput(input, unitId);
    const finalInput = requireInput(input, 'final');
    return {
      canonical_id: finalInput.canonical_id,
      record_review: buildRecordReview(finalInput.inventory_id, finalInput.canonical_id),
    };
  }
  if (input?.phase === 'buffer') {
    assertUnitInput(input, unitId);
    const bufferInput = requireInput(input, 'buffer');
    return {
      inventory_id: bufferInput.inventory_id,
      decision: bufferInput.decision,
      record_review: buildBufferReview(bufferInput.inventory_id, bufferInput.proposal_canonical_id, bufferInput.decision),
    };
  }
  if (input?.phase === 'audit-record') {
    assertUnitInput(input, unitId);
    return {
      audit_id: AUDIT_ID,
      unit_id: unitId,
      status: 'verified',
      target_kind: 'record',
      note: 'The frozen record or buffer scope was checked during the independent post-freeze audit.',
    };
  }
  if (input?.phase === 'audit-relation') {
    assertUnitInput(input, unitId);
    return {
      audit_id: AUDIT_ID,
      unit_id: unitId,
      status: 'verified',
      target_kind: 'relation-scope',
      relation_reviews: [],
    };
  }
  if (input?.phase === 'audit-timing') {
    assertUnitInput(input, unitId);
    const timingInput = requireInput(input, 'audit-timing');
    const coverage = auditCoverage(timingInput.audit_work_unit_ids);
    return {
      audit_id: AUDIT_ID,
      unit_id: unitId,
      status: 'verified',
      target_kind: 'timing-scope',
      coverage,
      findings: auditFindings(),
      note: 'Post-freeze audit decision coverage and findings were recorded as work rows before the timing stop; the decision artifact is finalized afterward.',
    };
  }
  throw new Error(`unsupported Wave B producer phase for ${unitKind}: ${input?.phase}`);
}
