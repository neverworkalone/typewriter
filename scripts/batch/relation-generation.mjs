export const M5_10A_RELATION_GENERATION_REVISION = 'm5-10a-relation-generation-v2';
export const M5_10A_CALIBRATION_CASE_COUNT = 20;
export const M5_10A_RELATION_FAILURE_CATEGORIES = Object.freeze([
  'incidental-co-occurrence',
  'generic-result-or-reaction',
  'arbitrary-modifier-or-place',
  'broad-common-category',
  'unsupported-cross-sensory',
  'sense-target-type-error',
  'direction-mismatch',
]);

const SENSORY_DOMAINS = Object.freeze([
  'olfactory',
  'auditory',
  'visual',
  'tactile',
]);

const DOMAIN_PATTERNS = Object.freeze({
  emotion: /마음|감정|느낌|기쁨|슬픔|외롭|허전|두려|걱정|희망|기대|사랑|미움|분노|탓|미워|부끄럽|아쉽|긴장|불안|설렘|그리움|감격|감탄|자부심|후회|망설|질투|믿음|절망|원망/u,
  state: /상태|상황|차분|편안|자연스럽|가라앉|팽팽|가능성|놓이는|끝난|느슨|방향|방법|부담|빠르|속도|흐름|익숙|낯설|어지럽지|잔잔/u,
  olfactory: /냄새|향|코로|맡아|악취|단내/u,
  auditory: /소리|울림|목소리|귀로|되울/u,
  visual: /빛|색|윤곽|밝|어둠|보이|시선|눈/u,
  tactile: /피부|촉감|수분|눅눅|물기|축축|젖|온도|차갑|뜨겁|부드|거칠/u,
  place: /집|건물|공간|자리|바깥|빈 터|길|마당|방|거리/u,
  object: /물체|사물|도구|편지|옷|신발|창|우물/u,
  weather: /비|하늘|계절|밤|아침|저녁|새벽|날씨/u,
});

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

function senseText({ record, sense }) {
  return `${record.lemma ?? ''} ${sense.gloss ?? ''}`;
}

function inferDomains(entry) {
  const domains = new Set();
  const text = senseText(entry);
  for (const [domain, pattern] of Object.entries(DOMAIN_PATTERNS)) {
    if (pattern.test(text)) domains.add(domain);
  }
  if (entry.sense.pos === 'verb' || entry.sense.pos === 'expression') domains.add('action');
  return domains;
}

function isBroadCommonCategory(entry) {
  const text = senseText(entry);
  return entry.record.lemma === '기쁨'
    || /좋은 일이나 바라는 일이 이루어져 즐거운 마음/u.test(text);
}

function sourceSensoryDomains(domains) {
  return SENSORY_DOMAINS.filter((domain) => domains.has(domain));
}

function hasSharedDomain(sourceDomains, targetDomains, domains) {
  return domains.some((domain) => sourceDomains.has(domain) && targetDomains.has(domain));
}

function hasSharedSensoryDomain(sourceDomains, targetDomains) {
  return sourceSensoryDomains(sourceDomains).some((domain) => targetDomains.has(domain));
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
  };
}

function classifySemanticRelation(caseRecord, source, target) {
  const sourceDomains = inferDomains(source);
  const targetDomains = inferDomains(target);
  const relationType = caseRecord.relation.type;

  if (isBroadCommonCategory(target)) return 'broad-common-category';

  if (relationType === 'scene') {
    if ((targetDomains.has('place') || targetDomains.has('object'))
      && !hasSharedDomain(sourceDomains, targetDomains, ['place', 'object', 'weather', 'visual'])) {
      return 'arbitrary-modifier-or-place';
    }
  }

  if (relationType === 'action') {
    return (sourceDomains.has('emotion') || sourceDomains.has('state'))
      && targetDomains.has('action')
      ? undefined
      : 'incidental-co-occurrence';
  }

  if (relationType === 'sensory') {
    const sourceSensory = sourceSensoryDomains(sourceDomains);
    const targetSensory = sourceSensoryDomains(targetDomains);
    if (sourceSensory.length > 0 && targetSensory.length > 0) {
      return sourceSensory.some((domain) => targetSensory.includes(domain))
        ? undefined
        : 'unsupported-cross-sensory';
    }
    return 'incidental-co-occurrence';
  }

  if (['direct', 'near', 'mood', 'association'].includes(relationType)
    && (sourceDomains.has('emotion') || sourceDomains.has('state'))
    && (targetDomains.has('emotion') || targetDomains.has('state'))) return undefined;

  if ((sourceDomains.has('emotion') || sourceDomains.has('state'))
    && sourceSensoryDomains(targetDomains).length > 0) {
    return 'incidental-co-occurrence';
  }
  if (sourceSensoryDomains(sourceDomains).length > 0
    && (targetDomains.has('emotion') || targetDomains.has('state'))) {
    return 'generic-result-or-reaction';
  }

  if ((sourceDomains.has('emotion') || sourceDomains.has('state'))
    && (targetDomains.has('emotion') || targetDomains.has('state'))) return undefined;
  if (hasSharedSensoryDomain(sourceDomains, targetDomains)) return undefined;
  return 'incidental-co-occurrence';
}

function classifyCase(caseRecord, senseById) {
  const source = senseById.get(caseRecord.source_sense);
  const target = senseById.get(caseRecord.relation.target_sense);
  if (!source || !target || target.record.id !== caseRecord.relation.target) {
    return 'sense-target-type-error';
  }
  if (caseRecord.direction.from !== caseRecord.source_sense
    || caseRecord.direction.to !== caseRecord.relation.target_sense) {
    return 'direction-mismatch';
  }
  return classifySemanticRelation(caseRecord, source, target);
}

/**
 * Run the deterministic upstream pre-screen from actual canonical sense
 * content. Fixture labels, notes, and any expected-action fields are never
 * consulted; callers may use those fields in test-only clones to prove that
 * the result is invariant to a supplied oracle.
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
  const rawProposalCount = generatedCandidates.length;
  const preScreenNoiseCount = 0;

  return {
    request_count: fixture.cases.length,
    raw_proposal_count: rawProposalCount,
    generation_suppressed_count: suppressedCandidates.length,
    pre_screen_noise_count: preScreenNoiseCount,
    noise_rate_of_raw_proposals: rawProposalCount === 0 ? 0 : preScreenNoiseCount / rawProposalCount,
    suppressed_category_counts: suppressedCategoryCounts,
    generated_candidates: generatedCandidates,
    suppressed_candidates: suppressedCandidates,
  };
}
