export const M5_10A_RELATION_GENERATION_REVISION = 'm5-10a-relation-generation-v1';
export const M5_10A_CALIBRATION_CASE_COUNT = 20;
export const M5_10A_ALLOWED_GENERATION_BASIS = 'sense-anchored-writer-use';
export const M5_10A_RELATION_FAILURE_CATEGORIES = Object.freeze([
  'incidental-co-occurrence',
  'generic-result-or-reaction',
  'arbitrary-modifier-or-place',
  'broad-common-category',
  'unsupported-cross-sensory',
  'sense-target-type-error',
]);

export class RelationGenerationError extends Error {
  constructor(message, code = 'RELATION_GENERATION_ERROR') {
    super(message);
    this.name = 'RelationGenerationError';
    this.code = code;
  }
}

function fail(message, code = 'RELATION_GENERATION_ERROR') {
  throw new RelationGenerationError(message, code);
}

function asRecords(canonicalRecords) {
  return canonicalRecords.map((entry) => entry?.record ?? entry);
}

function buildSenseIndex(canonicalRecords) {
  const bySenseId = new Map();
  for (const record of asRecords(canonicalRecords)) {
    for (const sense of record.senses ?? []) {
      if (bySenseId.has(sense.id)) fail(`canonical data repeats sense ${sense.id}`, 'CANONICAL_SENSE_DUPLICATE');
      bySenseId.set(sense.id, { record, sense });
    }
  }
  return bySenseId;
}

function suppress(caseRecord, category) {
  return {
    case_id: caseRecord.case_id,
    category,
  };
}

function generated(caseRecord) {
  return {
    case_id: caseRecord.case_id,
    source_sense: caseRecord.source_sense,
    relation: caseRecord.relation,
    direction: caseRecord.direction,
    writer_use_note: caseRecord.writer_use_note,
  };
}

function classifyCase(caseRecord, senseById) {
  const source = senseById.get(caseRecord.source_sense);
  const target = senseById.get(caseRecord.relation.target_sense);
  if (!source || !target
    || target.record.id !== caseRecord.relation.target
    || caseRecord.direction.from !== caseRecord.source_sense
    || caseRecord.direction.to !== caseRecord.relation.target_sense) {
    return 'sense-target-type-error';
  }
  if (caseRecord.generation_basis !== M5_10A_ALLOWED_GENERATION_BASIS) {
    if (!M5_10A_RELATION_FAILURE_CATEGORIES.includes(caseRecord.generation_basis)) {
      fail(
        `${caseRecord.case_id} has an unsupported generation basis ${caseRecord.generation_basis}`,
        'UNKNOWN_GENERATION_BASIS',
      );
    }
    return caseRecord.generation_basis;
  }
  return undefined;
}

/**
 * Run the deterministic pre-screen used by the M5-10A calibration gate.
 * The expected_action field is deliberately not consulted: the generator
 * decides from sense ownership, direction, and the allowed writer-use basis.
 */
export function generateRelationCandidates(fixture, canonicalRecords) {
  if (!fixture || !Array.isArray(fixture.cases)) {
    fail('relation calibration fixture must contain cases', 'INVALID_CALIBRATION_FIXTURE');
  }
  if (fixture.cases.length !== M5_10A_CALIBRATION_CASE_COUNT) {
    fail(
      `relation calibration fixture must contain ${M5_10A_CALIBRATION_CASE_COUNT} cases`,
      'CALIBRATION_CASE_COUNT',
    );
  }

  const senseById = buildSenseIndex(canonicalRecords);
  const generatedCandidates = [];
  const suppressedCandidates = [];
  const caseIds = new Set();
  for (const caseRecord of fixture.cases) {
    if (caseIds.has(caseRecord.case_id)) fail(`calibration repeats ${caseRecord.case_id}`, 'DUPLICATE_CALIBRATION_CASE');
    caseIds.add(caseRecord.case_id);
    const category = classifyCase(caseRecord, senseById);
    if (category) suppressedCandidates.push(suppress(caseRecord, category));
    else generatedCandidates.push(generated(caseRecord));
  }

  const suppressedCategoryCounts = Object.fromEntries(
    M5_10A_RELATION_FAILURE_CATEGORIES
      .filter((category) => suppressedCandidates.some((candidate) => candidate.category === category))
      .map((category) => [
        category,
        suppressedCandidates.filter((candidate) => candidate.category === category).length,
      ]),
  );
  const preScreenNoiseCount = generatedCandidates.filter((candidate) => {
    const sourceCase = fixture.cases.find(({ case_id: caseId }) => caseId === candidate.case_id);
    return sourceCase && M5_10A_RELATION_FAILURE_CATEGORIES.includes(sourceCase.generation_basis);
  }).length;

  return {
    case_count: fixture.cases.length,
    generated_candidate_count: generatedCandidates.length,
    suppressed_candidate_count: suppressedCandidates.length,
    pre_screen_noise_count: preScreenNoiseCount,
    noise_rate_of_emitted_candidates: generatedCandidates.length === 0
      ? 0
      : preScreenNoiseCount / generatedCandidates.length,
    suppressed_category_counts: suppressedCategoryCounts,
    generated_candidates: generatedCandidates,
    suppressed_candidates: suppressedCandidates,
  };
}
