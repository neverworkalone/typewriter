/**
 * Deterministic relation proposal generation for the M5-10A calibration.
 *
 * The calibration fixture supplies only a source sense and its sense-preflight
 * evidence. Target senses and relation types are selected from canonical gloss
 * content by the contracts below; fixture labels are intentionally ignored.
 */

export const M5_10A_RELATION_GENERATION_REVISION = 'm5-10a-relation-generation-v3';
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

const SENSORY_DOMAINS = Object.freeze(['olfactory', 'auditory', 'visual', 'tactile']);
const EMOTION_OR_STATE_DOMAINS = Object.freeze(['emotion', 'state']);

const DOMAIN_PATTERNS = Object.freeze({
  emotion: /마음|감정|느낌|기쁨|슬픔|외롭|허전|두려|걱정|희망|기대|사랑|미움|분노|탓|미워|부끄럽|아쉽|긴장|불안|설렘|그리움|감격|감탄|자부심|후회|망설|질투|믿음|절망|원망|서운/u,
  state: /상태|상황|차분|편안|자연스럽|가라앉|팽팽|가능성|놓이는|끝난|느슨|방향|방법|부담|빠르|속도|흐름|익숙|낯설|어지럽지|잔잔|머뭇|답답|급하고/u,
  olfactory: /냄새|향|코로|맡아|악취|단내|향기/u,
  auditory: /소리|울림|목소리|귀로|되울|메아리/u,
  visual: /빛|색|윤곽|밝|어둠|보이|시선|눈|선명|뚜렷|희미/u,
  tactile: /피부|촉감|수분|눅눅|물기|축축|젖|온도|차갑|뜨겁|부드|거칠|습기/u,
  place: /집|건물|공간|자리|바깥|빈 터|마당|하늘|날씨/u,
  object: /물체|사물|도구|편지|옷|신발|창|우물/u,
  weather: /비|하늘|계절|밤|아침|저녁|새벽|날씨|빗/u,
});

// These are deliberately narrower than the broad emotion/state domains. A
// shared generic word such as “마음” is not semantic overlap for near/mood.
const SEMANTIC_GROUP_PATTERNS = Object.freeze({
  anticipation: /기다리|바라|원하|가능성|결과|걱정|위험|결정|머뭇|방향|방법|막막|초조|불안|희망|기대|설렘/u,
  absence_pain: /없거나|허전|외롭|쓸쓸|잃|이루어지지|아픈|슬픔|가라앉|상처|서운|후회|절망/u,
  interpersonal_conflict: /미워|탓|부당|상처|질투|빼앗|관심|원망|불편/u,
  calm_release: /차분|편안|잔잔|자연스럽|익숙|놓이는|어지럽지|가라앉|평온|담담/u,
  positive_belief: /좋은|즐거|기분 좋|믿|바라|희망|기대|설렘|들뜨/u,
  visual_clarity: /빛깔|윤곽|밝|어둠|보이|선명|뚜렷|희미|시선/u,
  smell_quality: /냄새|향|향기|악취|단내|코로|맡아/u,
  sound_event: /소리|울림|목소리|귀로|되울|메아리|빗소리/u,
  moisture_state: /습기|수분|눅눅|물기|축축|젖|비|액체/u,
  spatial_scene: /집|건물|공간|자리|바깥|빈 터|마당|하늘|날씨/u,
});
const MOOD_GROUPS = new Set(['absence_pain', 'calm_release', 'interpersonal_conflict', 'positive_belief']);
const ASSOCIATION_GROUPS = new Set([
  'anticipation',
  'absence_pain',
  'interpersonal_conflict',
  'calm_release',
  'positive_belief',
  'visual_clarity',
  'smell_quality',
  'sound_event',
  'moisture_state',
  'spatial_scene',
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

function senseText({ record, sense }) {
  return `${record.lemma ?? ''} ${sense.gloss ?? ''}`;
}

function normalizedText(entry) {
  return senseText(entry).normalize('NFC');
}

export function inferDomains(entry) {
  const domains = new Set();
  const text = normalizedText(entry);
  for (const [domain, pattern] of Object.entries(DOMAIN_PATTERNS)) {
    if (pattern.test(text)) domains.add(domain);
  }
  if (entry.sense.pos === 'verb' || entry.sense.pos === 'expression') domains.add('action');
  return domains;
}

export function inferSemanticGroups(entry) {
  const groups = new Set();
  const text = normalizedText(entry);
  for (const [group, pattern] of Object.entries(SEMANTIC_GROUP_PATTERNS)) {
    if (pattern.test(text)) groups.add(group);
  }
  return groups;
}

export function isBroadCommonCategory(entry) {
  const text = normalizedText(entry);
  return /(좋은 일|나쁜 일|어떤 일|여러\s*(가지\s*)?감정|일반적|전반적|넓은 범주|즐거운 마음|기분이나 감정|포괄하는 감정)/u.test(text);
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

function hasEmotionOrState(domains) {
  return EMOTION_OR_STATE_DOMAINS.some((domain) => domains.has(domain));
}

function hasMeaningfulGroupOverlap(source, target) {
  const sourceGroups = inferSemanticGroups(source);
  const targetGroups = inferSemanticGroups(target);
  return [...sourceGroups].some((group) => targetGroups.has(group));
}

function sharedSemanticGroups(source, target) {
  const targetGroups = inferSemanticGroups(target);
  return [...inferSemanticGroups(source)].filter((group) => targetGroups.has(group));
}

function hasNearSemanticOverlap(source, target) {
  return sharedSemanticGroups(source, target).length > 0;
}

function hasMoodGroupRelation(source, target) {
  return sharedSemanticGroups(source, target).some((group) => MOOD_GROUPS.has(group));
}

function hasAssociationGroupRelation(source, target) {
  return sharedSemanticGroups(source, target).some((group) => ASSOCIATION_GROUPS.has(group));
}

function directGlossEvidence(source, target) {
  const sourceLemma = source.record.lemma?.normalize('NFC');
  const targetLemma = target.record.lemma?.normalize('NFC');
  const sourceGloss = source.sense.gloss?.normalize('NFC') ?? '';
  const targetGloss = target.sense.gloss?.normalize('NFC') ?? '';
  if (sourceGloss === targetGloss && sourceGloss.length > 0) return true;
  const interchangeability = /같은 뜻|같은 의미|동의어|서로\s*바꾸|바꾸어?\s*쓸|대신\s*쓸|직접\s*바꾸/u;
  return interchangeability.test(sourceGloss) || interchangeability.test(targetGloss)
    ? (sourceLemma && targetGloss.includes(sourceLemma))
      || (targetLemma && sourceGloss.includes(targetLemma))
    : false;
}

function classifyRelationContract(relationType, source, target) {
  const sourceDomains = inferDomains(source);
  const targetDomains = inferDomains(target);
  const sourceSensory = sourceSensoryDomains(sourceDomains);
  const targetSensory = sourceSensoryDomains(targetDomains);

  if (isBroadCommonCategory(target)) return 'broad-common-category';

  if (relationType === 'direct') {
    return directGlossEvidence(source, target) ? undefined : 'incidental-co-occurrence';
  }
  if (relationType === 'near') {
    return hasNearSemanticOverlap(source, target) ? undefined : 'incidental-co-occurrence';
  }
  if (relationType === 'mood') {
    return hasMoodGroupRelation(source, target) ? undefined : 'incidental-co-occurrence';
  }
  if (relationType === 'association') {
    return hasAssociationGroupRelation(source, target) ? undefined : 'incidental-co-occurrence';
  }
  if (relationType === 'scene') {
    return hasSharedDomain(sourceDomains, targetDomains, ['place', 'object', 'weather', 'visual'])
      ? undefined
      : 'arbitrary-modifier-or-place';
  }
  if (relationType === 'action') {
    return hasEmotionOrState(sourceDomains) && targetDomains.has('action')
      ? undefined
      : 'incidental-co-occurrence';
  }
  if (relationType === 'sensory') {
    if (sourceSensory.length > 0 && targetSensory.length > 0) {
      return hasSharedSensoryDomain(sourceDomains, targetDomains)
        ? undefined
        : 'unsupported-cross-sensory';
    }
    return 'incidental-co-occurrence';
  }
  return 'incidental-co-occurrence';
}

/**
 * Classify a relation-bearing request for negative/contract tests. Calibration
 * generation does not call this with target/type labels; it uses the same
 * independent contracts after selecting its own target and type.
 */
export function classifyRelationRequest(caseRecord, senseByIdOrRecords) {
  const senseById = senseByIdOrRecords instanceof Map
    ? senseByIdOrRecords
    : buildSenseIndex(senseByIdOrRecords);
  const source = senseById.get(caseRecord?.source_sense);
  const relation = caseRecord?.relation;
  const target = relation ? senseById.get(relation.target_sense) : undefined;
  if (!source || !target || target.record.id !== relation?.target) return 'sense-target-type-error';
  if (caseRecord.direction?.from !== caseRecord.source_sense
    || caseRecord.direction?.to !== relation.target_sense) return 'direction-mismatch';
  return classifyRelationContract(relation.type, source, target);
}

function canonicalRelationTuples(canonicalRecords) {
  const tuples = new Set();
  for (const { record } of canonicalRecords) {
    for (const sense of record.senses ?? []) {
      for (const relation of sense.relations ?? []) {
        tuples.add(`${sense.id}\u0000${relation.target_sense}\u0000${relation.type}`);
      }
    }
  }
  return tuples;
}

function recordNumber(id) {
  const match = /^[wr](\d+)-s\d+$/u.exec(id);
  return match ? Number(match[1]) : undefined;
}

function relationTypeFor(source, target) {
  const sourceDomains = inferDomains(source);
  const targetDomains = inferDomains(target);
  const sharedSensory = hasSharedSensoryDomain(sourceDomains, targetDomains);
  if (sharedSensory) return 'sensory';
  if (hasEmotionOrState(sourceDomains) && targetDomains.has('action')) return 'action';
  if (hasEmotionOrState(sourceDomains)
    && hasEmotionOrState(targetDomains)
    && hasMeaningfulGroupOverlap(source, target)) {
    return 'near';
  }
  if (hasSharedDomain(sourceDomains, targetDomains, ['place', 'object', 'weather', 'visual'])) {
    return 'scene';
  }
  if (hasMeaningfulGroupOverlap(source, target)) return 'mood';
  return undefined;
}

function proposalScore(source, target, relationType) {
  const sharedGroups = [...inferSemanticGroups(source)].filter((group) => inferSemanticGroups(target).has(group)).length;
  const sourceDomains = inferDomains(source);
  const targetDomains = inferDomains(target);
  const samePos = source.sense.pos === target.sense.pos ? 3 : 0;
  const sameSensory = hasSharedSensoryDomain(sourceDomains, targetDomains) ? 20 : 0;
  const sameScene = hasSharedDomain(sourceDomains, targetDomains, ['place', 'object', 'weather', 'visual']) ? 5 : 0;
  const typeBonus = relationType === 'near' || relationType === 'sensory' ? 2 : 0;
  return sharedGroups * 100 + sameSensory + sameScene + samePos + typeBonus;
}

function selectTarget(source, senseById, canonicalTuples, usedTuples) {
  const candidates = [];
  for (const target of senseById.values()) {
    if (target.sense.id === source.sense.id || target.record.id === source.record.id) continue;
    const targetNumber = recordNumber(target.sense.id);
    if (targetNumber === undefined || targetNumber >= 529) continue;
    if (isBroadCommonCategory(target)) continue;
    const relationType = relationTypeFor(source, target);
    if (!relationType) continue;
    const tuple = `${source.sense.id}\u0000${target.sense.id}\u0000${relationType}`;
    if (canonicalTuples.has(tuple) || usedTuples.has(tuple)) continue;
    candidates.push({ target, relationType, score: proposalScore(source, target, relationType) });
  }
  candidates.sort((left, right) => (
    right.score - left.score
    || left.target.sense.id.localeCompare(right.target.sense.id)
    || left.relationType.localeCompare(right.relationType)
  ));
  return candidates[0];
}

function generated(caseRecord, source, selected) {
  return {
    case_id: caseRecord.case_id,
    source_sense: source.sense.id,
    relation: {
      target: selected.target.record.id,
      target_sense: selected.target.sense.id,
      type: selected.relationType,
    },
    direction: {
      from: source.sense.id,
      to: selected.target.sense.id,
    },
  };
}

/**
 * Generate one independently selected relation proposal for every source-only
 * calibration case. A source without a contract-valid target is an error: it
 * must not silently reduce the denominator by becoming a pre-screen skip.
 */
export function generateRelationCandidates(fixture, canonicalRecords) {
  if (!fixture || !Array.isArray(fixture.cases)) {
    fail('relation calibration fixture must contain cases', 'INVALID_CALIBRATION_FIXTURE');
  }
  if (fixture.cases.length !== M5_10A_CALIBRATION_CASE_COUNT) {
    fail(`relation calibration fixture must contain ${M5_10A_CALIBRATION_CASE_COUNT} cases`, 'CALIBRATION_CASE_COUNT');
  }

  const senseById = buildSenseIndex(canonicalRecords);
  const canonicalTuples = canonicalRelationTuples(canonicalRecords);
  const generatedCandidates = [];
  const usedTuples = new Set();
  const caseIds = new Set();
  const orderedCases = [...fixture.cases].sort((left, right) => left.case_id.localeCompare(right.case_id));
  for (const caseRecord of orderedCases) {
    if (caseIds.has(caseRecord.case_id)) fail(`calibration repeats ${caseRecord.case_id}`, 'DUPLICATE_CALIBRATION_CASE');
    caseIds.add(caseRecord.case_id);
    const source = senseById.get(caseRecord.source_sense);
    if (!source) fail(`${caseRecord.case_id} source sense is missing`, 'CALIBRATION_SOURCE_SENSE_MISSING');
    const selected = selectTarget(source, senseById, canonicalTuples, usedTuples);
    if (!selected) fail(`${caseRecord.case_id} has no contract-valid generated target`, 'RELATION_GENERATION_NO_VALID_TARGET');
    const candidate = generated(caseRecord, source, selected);
    const tuple = `${candidate.source_sense}\u0000${candidate.relation.target_sense}\u0000${candidate.relation.type}`;
    usedTuples.add(tuple);
    generatedCandidates.push(candidate);
  }

  const rawProposalCount = generatedCandidates.length;
  return {
    request_count: fixture.cases.length,
    raw_proposal_count: rawProposalCount,
    generation_suppressed_count: 0,
    pre_screen_noise_count: 0,
    noise_rate_of_raw_proposals: 0,
    suppressed_category_counts: {},
    generated_candidates: generatedCandidates,
    suppressed_candidates: [],
  };
}
