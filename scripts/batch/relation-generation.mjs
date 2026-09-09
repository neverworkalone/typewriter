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
  emotion: /마음|감정|느낌|기쁨|슬픔|외롭|허전|두려|걱정|희망|사랑|미움|분노|탓|미워|부끄럽|아쉽|긴장|불안|설렘|그리움|감격|감탄|자부심|후회|망설|질투|믿음|절망|원망|서운/u,
  state: /상태|상황|차분|편안|자연스럽|가라앉|팽팽|가능성|놓이는|끝난|느슨|방향|방법|부담|빠르|속도|흐름|익숙|낯설|어지럽지|잔잔|머뭇|답답|급하고/u,
  olfactory: /냄새|향|코로|맡아|악취|단내|향기/u,
  auditory: /소리|울림|목소리|귀로|되울|메아리/u,
  visual: /빛|색|윤곽|모양|밝|어둠|보이|시선|눈/u,
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

// These words describe the carrier of a definition rather than the writer-useful
// concept being compared. Shared carrier words are useful for candidate search,
// but are never sufficient evidence for a relation admission.
const GENERIC_LEXICAL_TOKENS = new Set([
  '마음', '느낌', '상태', '상황', '감정', '사람', '대상', '일', '것', '수', '곳',
  '말', '행동', '기운', '성질', '모양', '부분', '경우', '정도', '모든', '여러',
  '어떤', '소리', '냄새', '향', '빛', '색', '물', '수분', '느끼', '생각',
  '관심', '배려', '비', '날씨', '공기', '잃', '기다리', '바라', '이루어',
  '생기', '되', '있', '없', '남', '여기', '이어', '이어지', '느껴지', '움직임',
  '다른', '촉감', '감각', '가운데', '하나', '골라', '일어나', '좋',
]);
const LEXICAL_SUFFIXES = Object.freeze([
  '으로부터', '에서는', '에게서', '하면서', '이라서', '이며', '하고', '하며',
  '거나', '면서', '이고', '처럼', '까지', '부터', '으로', '에서', '에게',
  '이나', '기에', '도록', '기를', '다고', '는데', '지만', '하는', '했다',
  '하다', '한', '할', '을', '를', '은', '는', '이', '가', '에', '도', '로',
  '던', '든', '하게',
  '와', '과', '의', '며', '고', '다', '지',
]);
const OPPOSING_MARKER_PAIRS = Object.freeze([
  [/설렘|기대|희망|기쁨|안도|믿음|긍정/u, /절망|불안|초조|허탈|허무|공허|건조|메마르/u],
  [/믿음|신뢰|옳다고\s*여기/u, /의심|불신|믿지\s*못/u],
  [/습기|눅눅|축축|젖|수분/u, /건조|마르|메마르/u],
  [/선명|뚜렷|밝/u, /흐릿|희미|어둡/u],
  [/자연스럽|편안|차분/u, /어색|부자연|불편/u],
  [/향기|향내|단내|좋은\s*냄새/u, /악취|역한|불쾌한\s*냄새/u],
  [/소리|울림|목소리/u, /고요|잠잠|조용|잦아들/u],
]);
const NEGATED_LEXICAL_CONTEXT = /^(?:않|없|못|아니)/u;
const NEAR_MEANING_FRAME_PATTERNS = Object.freeze({
  absence: /허전|쓸쓸|공허|외롭|빈/u,
  calm: /담담|차분|편안|가라앉|안정|잔잔/u,
  clarity: /선명|뚜렷|또렷|빛깔|윤곽|모양/u,
  regret: /후회|뉘우|잘못|아쉬/u,
  resentment: /원망|탓|부당|대우|미워/u,
  hurt: /상처|아픔|흔적/u,
  jealousy: /질투|빼앗길|관심을/u,
  ambivalence: /애증|사랑과\s*미움|동시에/u,
  manner: /말과\s*행동|장면|흐름|억지스럽|자연스럽/u,
  temperament: /성격|태도|까다롭|너그럽|무던/u,
  sound: /소리|울림|목소리|귀로|되울|메아리/u,
});
const NEAR_INCOMPATIBLE_FRAME_PAIRS = Object.freeze([
  ['resentment', 'hurt'],
  ['jealousy', 'ambivalence'],
  ['manner', 'temperament'],
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

function meaningFrames(entry) {
  const text = normalizedText(entry);
  return new Set(
    Object.entries(NEAR_MEANING_FRAME_PATTERNS)
      .filter(([, pattern]) => pattern.test(text))
      .map(([frame]) => frame),
  );
}

function hasIncompatibleNearFrame(source, target) {
  const sourceFrames = meaningFrames(source);
  const targetFrames = meaningFrames(target);
  return NEAR_INCOMPATIBLE_FRAME_PAIRS.some(([left, right]) => (
    (sourceFrames.has(left) && targetFrames.has(right))
      || (sourceFrames.has(right) && targetFrames.has(left))
  ));
}

function normalizeLexicalToken(token) {
  let value = token.normalize('NFC').replace(/[^\p{L}]/gu, '');
  for (const suffix of LEXICAL_SUFFIXES) {
    if (value.length >= suffix.length + 1 && value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length);
      break;
    }
  }
  return value;
}

function lexicalTokens(entry) {
  return [...new Set(
    `${entry.record.lemma ?? ''} ${entry.sense.gloss ?? ''}`
      .split(/\s+/u)
      .map(normalizeLexicalToken)
      .filter((token) => token.length >= 2 && !GENERIC_LEXICAL_TOKENS.has(token)),
  )];
}

function glossLexicalTokens(entry) {
  return [...new Set(
    `${entry.sense.gloss ?? ''}`
      .split(/\s+/u)
      .map(normalizeLexicalToken)
      .filter((token) => token.length >= 2 && !GENERIC_LEXICAL_TOKENS.has(token)),
  )];
}

function compactLemmaTokens(entry) {
  return `${entry.record.lemma ?? ''}`
    .split(/\s+/u)
    .map(normalizeLexicalToken)
    .filter((token) => token.length >= 2);
}

function rawLemmaTokens(entry) {
  return `${entry.record.lemma ?? ''}`
    .split(/\s+/u)
    .map((token) => token.normalize('NFC').replace(/[^\p{L}]/gu, ''))
    .filter((token) => token.length >= 2);
}

function lexicalTokenMatches(left, right) {
  return left === right
    || (left.length >= 3 && right.length >= 3 && (left.startsWith(right) || right.startsWith(left)));
}

function sharedLexicalAnchors(source, target) {
  const targetTokens = lexicalTokens(target);
  return lexicalTokens(source)
    .filter((sourceToken) => targetTokens.some((targetToken) => lexicalTokenMatches(sourceToken, targetToken)))
    .filter((token, index, tokens) => tokens.indexOf(token) === index);
}

function sharedGlossAnchors(source, target) {
  const targetTokens = glossLexicalTokens(target);
  return glossLexicalTokens(source)
    .filter((sourceToken) => targetTokens.some((targetToken) => lexicalTokenMatches(sourceToken, targetToken)))
    .filter((token, index, tokens) => tokens.indexOf(token) === index);
}

function crossLemmaGlossAnchors(source, target) {
  const sourceLemmas = compactLemmaTokens(source)
    .filter((token) => !GENERIC_LEXICAL_TOKENS.has(token));
  const targetLemmas = compactLemmaTokens(target)
    .filter((token) => !GENERIC_LEXICAL_TOKENS.has(token));
  const sourceGloss = glossLexicalTokens(source);
  const targetGloss = glossLexicalTokens(target);
  return [
    ...sourceLemmas.filter((lemma) => targetGloss.some((token) => lexicalTokenMatches(lemma, token))),
    ...targetLemmas.filter((lemma) => sourceGloss.some((token) => lexicalTokenMatches(lemma, token))),
  ].filter((token, index, tokens) => tokens.indexOf(token) === index);
}

function writerUseAnchors(source, target) {
  return [
    ...sharedGlossAnchors(source, target),
    ...crossLemmaGlossAnchors(source, target),
  ].filter((token, index, tokens) => tokens.indexOf(token) === index);
}

function hasNegatedAnchor(entry, anchor) {
  const tokens = `${entry.record.lemma ?? ''} ${entry.sense.gloss ?? ''}`
    .split(/\s+/u)
    .map((rawToken) => rawToken.normalize('NFC'));
  return tokens.some((rawToken, index) => {
      const token = normalizeLexicalToken(rawToken);
      if (!lexicalTokenMatches(token, anchor)) return false;
      const following = tokens.slice(index, index + 3).join('');
      return NEGATED_LEXICAL_CONTEXT.test(rawToken)
        || /(?:지|지?만)(?:않|못|없)/u.test(following)
        || /^(?:않|못|없|아니)/u.test(tokens[index + 1] ?? '');
    });
}

function hasOpposingMarkers(source, target) {
  const sourceText = normalizedText(source);
  const targetText = normalizedText(target);
  return OPPOSING_MARKER_PAIRS.some(([left, right]) => (
    (left.test(sourceText) && right.test(targetText))
      || (right.test(sourceText) && left.test(targetText))
  ));
}

function hasWriterUseBridge(source, target) {
  const anchors = writerUseAnchors(source, target);
  return anchors.length > 0
    && !hasOpposingMarkers(source, target)
    && anchors.some((anchor) => !hasNegatedAnchor(source, anchor) && !hasNegatedAnchor(target, anchor));
}

function lemmaBridge(source, target) {
  const sourceText = normalizedText(source).replace(/\s+/gu, '');
  const targetText = normalizedText(target).replace(/\s+/gu, '');
  const sourceLemmas = rawLemmaTokens(source);
  const targetLemmas = rawLemmaTokens(target);
  return sourceLemmas.some((lemma) => targetText.includes(lemma))
    || targetLemmas.some((lemma) => sourceText.includes(lemma))
    || sourceLemmas.some((sourceLemma) => targetLemmas.some((targetLemma) => (
      sourceLemma.length >= 2
        && targetLemma.length >= 2
        && (sourceLemma.includes(targetLemma) || targetLemma.includes(sourceLemma))
    )));
}

function hasSensoryWriterBridge(source, target) {
  return lemmaBridge(source, target)
    && !hasOpposingMarkers(source, target);
}

function hasActionWriterBridge(source, target) {
  const anchors = writerUseAnchors(source, target);
  return anchors.length >= 2
    && !hasOpposingMarkers(source, target)
    && anchors.some((anchor) => !hasNegatedAnchor(source, anchor) && !hasNegatedAnchor(target, anchor));
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

function sharedSemanticGroups(source, target) {
  const targetGroups = inferSemanticGroups(target);
  return [...inferSemanticGroups(source)].filter((group) => targetGroups.has(group));
}

function hasNearSemanticOverlap(source, target) {
  if (source.sense.pos !== target.sense.pos
    || !hasWriterUseBridge(source, target)
    || hasIncompatibleNearFrame(source, target)) return false;
  const sourceDomains = inferDomains(source);
  const targetDomains = inferDomains(target);
  return (hasEmotionOrState(sourceDomains) && hasEmotionOrState(targetDomains))
    || hasSharedSensoryDomain(sourceDomains, targetDomains);
}

function hasMoodGroupRelation(source, target) {
  return sharedSemanticGroups(source, target).some((group) => MOOD_GROUPS.has(group))
    && hasWriterUseBridge(source, target);
}

function hasAssociationGroupRelation(source, target) {
  return sharedSemanticGroups(source, target).some((group) => ASSOCIATION_GROUPS.has(group))
    && hasWriterUseBridge(source, target);
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
      && lemmaBridge(source, target)
      ? undefined
      : 'arbitrary-modifier-or-place';
  }
  if (relationType === 'action') {
    return hasEmotionOrState(sourceDomains)
      && targetDomains.has('action')
      && target.sense.pos === 'verb'
      && hasActionWriterBridge(source, target)
      ? undefined
      : 'incidental-co-occurrence';
  }
  if (relationType === 'sensory') {
    if (sourceSensory.length > 0 && targetSensory.length > 0) {
      return hasSharedSensoryDomain(sourceDomains, targetDomains)
        && hasSensoryWriterBridge(source, target)
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
  if (hasNearSemanticOverlap(source, target)) return 'near';
  if (hasEmotionOrState(sourceDomains)
    && targetDomains.has('action')
    && target.sense.pos === 'verb'
    && hasActionWriterBridge(source, target)) return 'action';
  if (hasSharedSensoryDomain(sourceDomains, targetDomains)
    && hasSensoryWriterBridge(source, target)) return 'sensory';
  if (hasSharedDomain(sourceDomains, targetDomains, ['place', 'object', 'weather', 'visual'])
    && lemmaBridge(source, target)) return 'scene';
  return undefined;
}

function proposalScore(source, target, relationType) {
  const sharedGroups = [...inferSemanticGroups(source)].filter((group) => inferSemanticGroups(target).has(group)).length;
  const sharedAnchors = sharedLexicalAnchors(source, target).length;
  const sourceDomains = inferDomains(source);
  const targetDomains = inferDomains(target);
  const samePos = source.sense.pos === target.sense.pos ? 3 : 0;
  const lexicalBridge = lemmaBridge(source, target) ? 25 : 0;
  const sameSensory = hasSharedSensoryDomain(sourceDomains, targetDomains) ? 10 : 0;
  const sameScene = hasSharedDomain(sourceDomains, targetDomains, ['place', 'object', 'weather', 'visual']) ? 5 : 0;
  const typeBonus = relationType === 'near' || relationType === 'sensory' ? 4 : 0;
  return sharedAnchors * 100 + lexicalBridge + sharedGroups * 10 + sameSensory + sameScene + samePos + typeBonus;
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
 * Generate an independently selected relation proposal when the canonical
 * sense content supplies a contract-valid, writer-useful target. A source
 * without such a target is a normal no-candidate result, not a quota failure or
 * a hidden pre-screen suppression.
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
  const notGeneratedCases = [];
  const usedTuples = new Set();
  const caseIds = new Set();
  const orderedCases = [...fixture.cases].sort((left, right) => left.case_id.localeCompare(right.case_id));
  for (const caseRecord of orderedCases) {
    if (caseIds.has(caseRecord.case_id)) fail(`calibration repeats ${caseRecord.case_id}`, 'DUPLICATE_CALIBRATION_CASE');
    caseIds.add(caseRecord.case_id);
    const source = senseById.get(caseRecord.source_sense);
    if (!source) fail(`${caseRecord.case_id} source sense is missing`, 'CALIBRATION_SOURCE_SENSE_MISSING');
    const selected = selectTarget(source, senseById, canonicalTuples, usedTuples);
    if (!selected) {
      notGeneratedCases.push({
        case_id: caseRecord.case_id,
        source_sense: source.sense.id,
        reason: 'no-contract-valid-candidate',
      });
      continue;
    }
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
    not_generated_count: notGeneratedCases.length,
    not_generated_cases: notGeneratedCases,
  };
}
