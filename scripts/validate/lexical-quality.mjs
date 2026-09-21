import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from './canonical-jsonl.mjs';
import { inspectSenseBoundaryPairs } from './sense-boundary.mjs';

/**
 * Shared lexical-quality rules used by canonical validation and every reviewed
 * admission path.  Batch modules may tighten a rule for a particular review
 * (for example, an agent pass can reject every broad connector), but they do
 * not replace these repository-wide invariants.
 */
export const LEXICAL_QUALITY_RULESET_VERSION = 'lexical-quality-v1';
export const BROAD_GLOSS_CONNECTOR_PATTERN = /(?:이나|또는|거나)/u;
export const LEXICAL_TOPIC_EVIDENCE_CONTRACT_VERSION = 'lexical-topic-evidence-v2';
export const LEXICAL_TOPIC_EVIDENCE_KIND = 'semantic-review-topic-analysis';

const RECORD_TYPES = Object.freeze(['entry', 'expression']);
const ROLES = Object.freeze(['start', 'reference-only']);
const ENTRY_POS = Object.freeze(['noun', 'adjective', 'verb']);
const ALL_POS = Object.freeze([...ENTRY_POS, 'expression']);
const CONNECTORS = Object.freeze(['이나', '또는', '거나']);
const SEMANTIC_BOUNDARY_ACTIONS = Object.freeze(['retain', 'split', 'merge', 'rewrite', 'fail']);
const SEMANTIC_BOUNDARY_CLASSIFICATIONS = Object.freeze([
  'atomic',
  'separated',
  'coordinated',
  'overlapping',
  'nested',
  'usage-variant',
  'unresolved',
]);
const SEMANTIC_BOUNDARY_RELATIONSHIPS = Object.freeze([
  'distinct',
  'duplicate',
  'nested',
  'usage-variant',
  'overlapping',
]);
const SEMANTIC_BOUNDARY_PAIR_DECISIONS = Object.freeze(['retain', 'merge', 'rewrite', 'fail']);
const SEMANTIC_BOUNDARY_METHOD = 'gloss-and-usage-pairwise-v2';
const SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION = 'lexical-semantic-boundary-decisions-v1';
const SEMANTIC_DECISION_SOURCE_KIND = 'separately-authored-semantic-decision-source';
const SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION = 'lexical-semantic-decision-source-v1';

// These are deliberately writer-facing semantic domains, not record IDs or
// historical batch exceptions.  They let the audit distinguish a genuinely
// disjunctive definition ("taste or mood") from a normal coordinated phrase
// ("taste or smell") without pretending that every Korean conjunction is a
// separate dictionary sense.
const WRITER_DOMAIN_TERMS = Object.freeze({
  taste: Object.freeze(['맛', '미각', '입맛', '단맛', '신맛', '쓴맛', '짠맛']),
  smell: Object.freeze(['냄새', '향', '향기', '향긋', '향내', '향취', '후각']),
  sound: Object.freeze(['소리', '목소리', '음성', '울림', '청각', '말소리', '숨소리', '음색']),
  visual: Object.freeze([
    '빛', '빛깔', '색', '색깔', '색감', '색조', '색채', '윤곽', '시각',
    '살빛', '햇빛', '달빛', '푸른빛', '불빛', '낮빛',
    '보라색', '분홍색', '붉은색', '하얀색', '빛나',
  ]),
  tactile: Object.freeze(['표면', '감촉', '촉감', '질감']),
  affective: Object.freeze(['분위기', '감정', '기분', '정서', '마음', '마음속', '마음가짐', '마음씨']),
  body: Object.freeze(['목구멍', '몸', '몸통', '몸놀림', '신체', '피부']),
});

export const WRITER_DOMAIN_AXES = Object.freeze(Object.keys(WRITER_DOMAIN_TERMS));

// A domain term is matched as a lexical token, not as an arbitrary sequence
// of Hangul syllables.  `하고` is intentionally excluded: without a
// morphological analyzer, a token such as `향하고` is ambiguous between the
// noun `향` plus a particle and the inflected verb `향하다`.  Unsupported
// ambiguity must not become writer-domain evidence.
//
// These are safe first-position nominal particles.  Their composition rules
// live below instead of being enumerated as complete surface tails, so forms
// such as `에서는` and `으로는` remain covered without opening the grammar to
// arbitrary suffix recursion.
const WRITER_DOMAIN_NOMINAL_PARTICLE_ATOMS = Object.freeze([
  '으로', '에서', '에게', '한테', '처럼', '만큼', '부터', '까지', '보다',
  '이나', '이랑', '랑', '조차', '마저', '밖에', '뿐', '대로',
  '은', '는', '이', '가', '을', '를', '에', '로', '과', '와', '도', '만', '의', '나',
].sort((left, right) => right.length - left.length));

const WRITER_DOMAIN_NOMINAL_COMPOSITION = Object.freeze({
  으로: Object.freeze(['부터', '서', '써']),
  에서: Object.freeze(['부터']),
  에게: Object.freeze(['서']),
  한테: Object.freeze(['서']),
});

const WRITER_DOMAIN_NOMINAL_ENCLITIC_ATOMS = Object.freeze(['까지', '은', '는', '도', '만']);

// These forms visibly contain the copular stem `이`, so they are safer for a
// token-only analyzer than homographic endings such as `인` or `일`.
const WRITER_DOMAIN_COPULAR_TAILS = new Set([
  '이다', '이었다', '이었던', '이면', '이므로', '이라', '이어서', '이지만',
]);

// Most configured terms are nouns.  A small number are explicitly configured
// as a lexical stem with the forms that preserve that reading.  Keeping this
// metadata per term prevents one generic suffix table from treating every
// one-syllable term as if it were a noun, adjective, and verb at once.
const WRITER_DOMAIN_TERM_METADATA = Object.freeze({
  정서: Object.freeze({
    lexical_class: 'noun',
    derived_tails: new Set(['적']),
  }),
  향기: Object.freeze({
    lexical_class: 'noun',
    derived_tails: new Set(['롭다', '로운', '롭게', '로움']),
  }),
  향긋: Object.freeze({
    lexical_class: 'adjective-stem',
    inflectional_tails: new Set(['하다', '한', '하게', '함']),
  }),
  빛나: Object.freeze({
    lexical_class: 'verb-stem',
    inflectional_tails: new Set(['다', '는', '며', '고', '서', '지', '게', '도록', '던']),
  }),
});

const WRITER_DOMAIN_EDGE_PUNCTUATION_PATTERN = /[()[\]{}"'“”‘’.,;:!?。！？…]/u;

// A single gloss may legitimately state a property over a shared writer
// domain.  This is a semantic rule, not a grandfathered record allowlist.
const COMMON_DOMAIN_PAIRS = new Set([
  'affective:body',
  'smell:taste',
  'tactile:visual',
]);

const PLACEHOLDER_GLOSS_PATTERN = /^(?:placeholder|tbd|todo|n\/a|na|미정|미작성|임시|예시|테스트)(?:[\s:.-]|$)/iu;
const GENERIC_GLOSS_TEMPLATE_PATTERN = /(?:가|이)\s*나타내는\s+(?:첫 번째|두 번째|세 번째|네 번째)\s+구체적 의미/u;
// A two-token `X은 Y` fragment is not a definition when the first token is
// being used as a noun topic and the second token is a bare nominal stub.  The
// topic/adnominal forms are homographs.  The shared rule therefore treats the
// lexical POS map as open-world evidence: noun-only presence is not proof that
// an adnominal reading is impossible.  A blocking noun-topic result requires
// separate, explicit topic evidence from a caller that can establish that
// reading.
const MALFORMED_TOPIC_FRAGMENT_PATTERN = /^(?<topic>[\p{L}\p{M}\p{N}]+)(?<particle>은|는)\s+(?<predicate>[\p{L}\p{M}\p{N}]+)$/u;
const VALID_PREDICATE_ENDING_PATTERN = /다$/u;
const PARTICLE_COMPATIBILITY = Object.freeze({
  은: (finalIndex) => (finalIndex === 0 ? '는' : '은'),
  는: (finalIndex) => (finalIndex === 0 ? '는' : '은'),
  이: (finalIndex) => (finalIndex === 0 ? '가' : '이'),
  가: (finalIndex) => (finalIndex === 0 ? '가' : '이'),
  을: (finalIndex) => (finalIndex === 0 ? '를' : '을'),
  를: (finalIndex) => (finalIndex === 0 ? '를' : '을'),
  과: (finalIndex) => (finalIndex === 0 ? '와' : '과'),
  와: (finalIndex) => (finalIndex === 0 ? '와' : '과'),
  으로: (finalIndex) => (finalIndex === 0 || finalIndex === 8 ? '로' : '으로'),
  로: (finalIndex) => (finalIndex === 0 || finalIndex === 8 ? '로' : '으로'),
  이라는: (finalIndex) => (finalIndex === 0 ? '라는' : '이라는'),
  라는: (finalIndex) => (finalIndex === 0 ? '라는' : '이라는'),
});
const PARTICLE_LEXICAL_CONTEXT_CUE_PATTERN = /^(?:드러나|나타나|보이|보인|읽히|번지|바뀌|남|지나|맞물리|가리키|포착|선명하게|구체화|묘사|보여|생기|퍼지|이어지|통과|전하|느껴|만들|붙잡|바라보|인상)/u;
// These are surface-grammar patterns rather than word or batch allowlists:
// conjugated `려` connective endings cover forms such as `맞물려`, while a
// noun-like complement ending in `으로` covers contexts such as `배경으로`.
// Narrowing this to an unambiguous connective family avoids treating a
// productive adnominal such as `있는` before a token ending in `고` as a
// nominal particle.
const PARTICLE_CONNECTIVE_CONTEXT_CUE_PATTERN = /려(?:고|서|면|야)?$/u;
const PARTICLE_NOMINAL_COMPLEMENT_CONTEXT_CUE_PATTERN = /^[\p{L}\p{M}\p{N}]{2,}으로$/u;
// `은/는` are also productive adnominal endings (`먹는 방식으로`).  Without
// a morphological analyzer, a following noun-like complement is the only
// conservative context in which the surface can remain ambiguous.  Ordinary
// predicate contexts and bound authored noun-topic evidence still run the
// particle compatibility check.
const AMBIGUOUS_ADNOMINAL_PARTICLES = new Set(['은', '는']);
const PARTICLE_SURFACE_PATTERN = /^(?<stem>[\p{L}\p{M}\p{N}]{1,}?)(?<particle>이라는|라는|으로|로|은|는|이|가|을|를|과|와)$/u;
const TOPIC_ANALYSIS_STATES = Object.freeze([
  'noun-topic',
  'adnominal',
  'ambiguous',
  'unsupported',
]);
const MECHANICAL_BOUNDARY_RELATIONSHIPS = new Set([
  'duplicate',
  'nested',
  'usage-variant',
  'overlapping',
]);

export class LexicalQualityError extends Error {
  constructor(message, code = 'LEXICAL_QUALITY_ERROR', finding = undefined) {
    super(message);
    this.name = 'LexicalQualityError';
    this.code = code;
    this.finding = finding;
  }
}

function fail(message, code = 'LEXICAL_QUALITY_ERROR', finding = undefined) {
  throw new LexicalQualityError(message, code, finding);
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function nominalTermPositions(nominalTerms, topic) {
  if (nominalTerms instanceof Map) return nominalTerms.get(topic);
  if (nominalTerms instanceof Set && nominalTerms.has(topic)) return new Set(['noun']);
  if (Array.isArray(nominalTerms) && nominalTerms.includes(topic)) return new Set(['noun']);
  return undefined;
}

function topicAnalysisForSense(
  topicEvidence,
  { senseId, gloss, topic, particle, predicate, tokenIndex } = {},
) {
  if (!topicEvidence
    || topicEvidence.kind !== LEXICAL_TOPIC_EVIDENCE_KIND
    || topicEvidence.contract_version !== LEXICAL_TOPIC_EVIDENCE_CONTRACT_VERSION
    || !(topicEvidence.by_sense instanceof Map)
    || typeof senseId !== 'string') {
    return undefined;
  }
  const evidence = topicEvidence.by_sense.get(senseId);
  const candidates = Array.isArray(evidence) ? evidence : [evidence];
  return candidates.find((candidate) => candidate
    && candidate.sense_id === senseId
    && candidate.gloss_sha256 === sha256Json(gloss)
    && candidate.topic === topic
    && candidate.particle === particle
    && candidate.predicate === predicate
    && (tokenIndex === undefined
      || candidate.token_index === undefined
      || candidate.token_index === tokenIndex));
}

function classifyTopicToken(
  topic,
  nominalTerms,
  topicEvidence,
  { senseId, gloss, particle, predicate, tokenIndex } = {},
) {
  const authoredTopicAnalysis = topicAnalysisForSense(topicEvidence, {
    senseId,
    gloss,
    topic,
    particle,
    predicate,
    tokenIndex,
  });
  if (authoredTopicAnalysis !== undefined) {
    return { state: authoredTopicAnalysis.state };
  }
  const positions = nominalTermPositions(nominalTerms, topic);
  const hasNoun = positions?.has('noun') === true;
  const hasAdnominal = positions?.has('verb') || positions?.has('adjective');
  if (hasNoun && hasAdnominal) return { state: 'ambiguous' };
  if (hasAdnominal) return { state: 'adnominal' };
  if (hasNoun) return { state: 'ambiguous' };
  return { state: 'unsupported' };
}

function inspectTopicFragment(gloss, { nominalTerms, topicEvidence, senseId } = {}) {
  const fragment = MALFORMED_TOPIC_FRAGMENT_PATTERN.exec(gloss.trim());
  if (!fragment) return { state: 'unsupported', malformed: false };
  const { topic, particle, predicate } = fragment.groups;
  const topicAnalysis = classifyTopicToken(topic, nominalTerms, topicEvidence, {
    senseId,
    gloss,
    particle,
    predicate,
    tokenIndex: 0,
  });
  const bareNominalPredicate = !VALID_PREDICATE_ENDING_PATTERN.test(predicate);
  return {
    ...topicAnalysis,
    malformed: topicAnalysis.state === 'noun-topic' && bareNominalPredicate,
  };
}

function hangulFinalIndex(text) {
  const codePoint = text.codePointAt(text.length - 1);
  if (codePoint === undefined || codePoint < 0xac00 || codePoint > 0xd7a3) return undefined;
  return (codePoint - 0xac00) % 28;
}

function stripGlossTokenPunctuation(token) {
  return token.replace(/^[()[\]{}"“”‘’'.,;:!?。！？…]+|[()[\]{}"“”‘’'.,;:!?。！？…]+$/gu, '');
}

function findAuthoredParticleFragment(
  gloss,
  {
    topic,
    particle,
    predicate,
    tokenIndex,
    token_index: authoredTokenIndex,
  } = {},
) {
  if (typeof gloss !== 'string'
    || typeof topic !== 'string'
    || typeof particle !== 'string'
    || typeof predicate !== 'string') {
    return undefined;
  }
  const tokens = gloss.split(/\s+/u).map(stripGlossTokenPunctuation);
  const topicToken = `${topic}${particle}`;
  const expectedTokenIndex = tokenIndex ?? authoredTokenIndex;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (expectedTokenIndex !== undefined && index !== expectedTokenIndex) continue;
    if (tokens[index] === topicToken && tokens[index + 1] === predicate) {
      return { topic, particle, predicate, token_index: index };
    }
  }
  return undefined;
}

function isParticleContextCue(token) {
  return PARTICLE_LEXICAL_CONTEXT_CUE_PATTERN.test(token)
    || PARTICLE_CONNECTIVE_CONTEXT_CUE_PATTERN.test(token)
    || PARTICLE_NOMINAL_COMPLEMENT_CONTEXT_CUE_PATTERN.test(token);
}

function findContextualParticleFragments(gloss) {
  if (typeof gloss !== 'string' || gloss.trim().length === 0) return [];
  const tokens = gloss.split(/\s+/u).map(stripGlossTokenPunctuation);
  const fragments = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    const nextToken = tokens[index + 1];
    if (!token || !nextToken || !isParticleContextCue(nextToken)) continue;
    const match = PARTICLE_SURFACE_PATTERN.exec(token);
    if (!match) continue;
    fragments.push({
      token,
      stem: match.groups.stem,
      particle: match.groups.particle,
      nextToken,
      token_index: index,
    });
  }
  return fragments;
}

/**
 * Return the token spans whose particle reading is ambiguous without
 * authored grammatical evidence.  The detector deliberately covers both
 * productive adnominal `은/는` before a noun-like `으로` complement and
 * vowel-final terminal `이`, in addition to the historical two-token topic
 * shape.  Callers can bind an authored analysis to the returned topic,
 * particle, predicate, and full gloss digest.
 */
export function findAmbiguousParticleFragments(gloss) {
  const fragments = [];
  const seen = new Set();
  const add = (fragment, kind) => {
    const key = `${fragment.topic}:${fragment.particle}:${fragment.predicate}:${fragment.token_index}`;
    if (seen.has(key)) return;
    seen.add(key);
    fragments.push({ ...fragment, kind });
  };

  const wholeGlossFragment = typeof gloss === 'string'
    ? MALFORMED_TOPIC_FRAGMENT_PATTERN.exec(gloss.trim())
    : undefined;
  if (wholeGlossFragment) {
    add({
      topic: wholeGlossFragment.groups.topic,
      particle: wholeGlossFragment.groups.particle,
      predicate: wholeGlossFragment.groups.predicate,
      token_index: 0,
    }, 'topic-fragment');
  }

  for (const fragment of findContextualParticleFragments(gloss)) {
    const { stem, particle, nextToken } = fragment;
    if ((AMBIGUOUS_ADNOMINAL_PARTICLES.has(particle)
      && PARTICLE_NOMINAL_COMPLEMENT_CONTEXT_CUE_PATTERN.test(nextToken))
      || (particle === '이' && hangulFinalIndex(stem) === 0)) {
      add({
        topic: stem,
        particle,
        predicate: nextToken,
        token_index: fragment.token_index,
      }, particle === '이' ? 'terminal-i' : 'adnominal');
    }
  }
  return fragments;
}

function hasAuthoredNounTopicEvidence(
  gloss,
  { stem, particle, nextToken, tokenIndex, topicEvidence, senseId } = {},
) {
  const fragment = findAuthoredParticleFragment(gloss, {
    topic: stem,
    particle,
    predicate: nextToken,
    tokenIndex,
  });
  if (!fragment) return false;
  return topicAnalysisForSense(topicEvidence, {
    senseId,
    gloss,
    topic: stem,
    particle,
    predicate: nextToken,
    tokenIndex,
  })?.state === 'noun-topic';
}

function isProductiveAdnominalAmbiguity(
  gloss,
  { stem, particle, nextToken, tokenIndex, topicEvidence, senseId } = {},
) {
  if (!AMBIGUOUS_ADNOMINAL_PARTICLES.has(particle)
    || !PARTICLE_NOMINAL_COMPLEMENT_CONTEXT_CUE_PATTERN.test(nextToken)) {
    return false;
  }
  if (hasAuthoredNounTopicEvidence(gloss, {
    stem,
    particle,
    nextToken,
    tokenIndex,
    topicEvidence,
    senseId,
  })) {
    return false;
  }
  // The canonical lexicon is intentionally incomplete: a missing verb or
  // adjective entry is not evidence that the surface cannot be adnominal.
  // Without positive authored noun-topic evidence, leave this homograph
  // ambiguous rather than guessing from the current term inventory.
  return true;
}

function hasUnresolvedLexicalAdverbAmbiguity(
  gloss,
  { stem, particle, nextToken, tokenIndex, topicEvidence, senseId } = {},
) {
  if (particle !== '이' || hangulFinalIndex(stem) !== 0) return false;
  return !hasAuthoredNounTopicEvidence(gloss, {
    stem,
    particle,
    nextToken,
    tokenIndex,
    topicEvidence,
    senseId,
  });
}

/**
 * Detect the compatibility errors that arise when an attached Korean nominal
 * particle is selected without considering the preceding syllable's final
 * consonant.  The rule is intentionally context-bound: terminal `이` is
 * ambiguous with productive lexical adverbial `-이`, so a surface with no
 * final consonant remains open unless bound authored noun-topic evidence
 * establishes a grammatical particle reading.
 */
export function inspectMalformedParticles(
  gloss,
  { topicEvidence, senseId } = {},
) {
  if (typeof gloss !== 'string' || gloss.trim().length === 0) return [];
  const findings = [];
  for (const { token, stem, particle, nextToken, token_index: tokenIndex } of findContextualParticleFragments(gloss)) {
    if (isProductiveAdnominalAmbiguity(gloss, {
      stem,
      particle,
      nextToken,
      tokenIndex,
      topicEvidence,
      senseId,
    })) continue;
    if (hasUnresolvedLexicalAdverbAmbiguity(gloss, {
      stem,
      particle,
      nextToken,
      tokenIndex,
      topicEvidence,
      senseId,
    })) continue;
    const finalIndex = hangulFinalIndex(stem);
    if (finalIndex === undefined) continue;
    const expectedParticle = PARTICLE_COMPATIBILITY[particle]?.(finalIndex);
    if (expectedParticle === undefined || expectedParticle === particle) continue;
    findings.push({
      token,
      stem,
      particle,
      expected_particle: expectedParticle,
      next_token: nextToken,
      token_index: tokenIndex,
    });
  }
  return findings;
}

export function requiresTopicAnalysis(gloss) {
  return findAmbiguousParticleFragments(gloss).length > 0;
}

export function validateAuthoredTopicAnalysis(
  gloss,
  analysis,
  { decisionSourceId, label = 'topic_analysis', expectedFragment } = {},
) {
  requireObject(analysis, label);
  if (analysis.status !== 'pass') {
    fail(`${label}.status must be pass`, 'LEXICAL_SEMANTIC_REVIEW_INCOMPLETE');
  }
  requireEnum(analysis.state, TOPIC_ANALYSIS_STATES, `${label}.state`);
  requireString(analysis.gloss_sha256, `${label}.gloss_sha256`);
  if (analysis.gloss_sha256 !== sha256Json(gloss)) {
    fail(`${label}.gloss_sha256 does not bind the reviewed gloss`, 'LEXICAL_SEMANTIC_BINDING');
  }
  if (decisionSourceId !== undefined) {
    requireString(analysis.decision_source_id, `${label}.decision_source_id`);
    if (analysis.decision_source_id !== decisionSourceId) {
      fail(`${label}.decision_source_id is not bound to the authored decision source`, 'LEXICAL_SEMANTIC_PROVENANCE');
    }
  }
  requireString(analysis.rationale, `${label}.rationale`);
  const fragment = expectedFragment
    ?? MALFORMED_TOPIC_FRAGMENT_PATTERN.exec(gloss.trim())
    ?? findAuthoredParticleFragment(gloss, analysis);
  if (!fragment) {
    if (analysis.state === 'noun-topic') {
      fail(`${label}.state noun-topic requires a two-token topic fragment`, 'LEXICAL_SEMANTIC_BINDING');
    }
    return analysis;
  }
  const { topic, particle, predicate } = fragment.groups ?? fragment;
  if (analysis.token_index !== undefined
    && analysis.token_index !== fragment.token_index) {
    fail(`${label}.token_index must bind the normalized gloss token span`, 'LEXICAL_SEMANTIC_BINDING');
  }
  if (analysis.topic !== topic
    || analysis.particle !== particle
    || analysis.predicate !== predicate) {
    fail(`${label} must bind the topic fragment surface`, 'LEXICAL_SEMANTIC_BINDING');
  }
  if (analysis.state === 'noun-topic') {
    if (analysis.topic_pos !== 'noun') {
      fail(`${label}.topic_pos must explicitly establish a noun topic`, 'LEXICAL_SEMANTIC_PROVENANCE');
    }
    requireString(analysis.evidence_basis, `${label}.evidence_basis`);
  }
  return analysis;
}

/**
 * Validate the complete authored evidence contract for every ambiguous
 * particle span in a gloss.  The legacy singular field remains valid for a
 * single span; multiple spans must use the ordered `topic_analyses` array so
 * one decision cannot accidentally cover a different span.
 */
export function validateTopicAnalysisEvidence(
  gloss,
  evidence,
  {
    decisionSourceId,
    label = 'topic_analysis',
    requireEvidence = true,
    incompleteCode = 'LEXICAL_SEMANTIC_REVIEW_INCOMPLETE',
  } = {},
) {
  const fragments = findAmbiguousParticleFragments(gloss);
  const topicAnalysis = evidence?.topic_analysis;
  const topicAnalyses = evidence?.topic_analyses;
  if (topicAnalysis !== undefined && topicAnalyses !== undefined) {
    fail(`${label} must use either topic_analysis or topic_analyses, not both`, 'LEXICAL_SEMANTIC_SHAPE');
  }

  if (fragments.length > 1) {
    if (!Array.isArray(topicAnalyses)) {
      if (requireEvidence) {
        fail(
          `${label}.topic_analyses must cover every ambiguous particle span`,
          incompleteCode,
        );
      }
      return undefined;
    }
    if (topicAnalyses.length !== fragments.length) {
      fail(
        `${label}.topic_analyses must contain exactly one analysis per ambiguous particle span`,
        incompleteCode,
      );
    }
    const coveredIndexes = new Set();
    for (const [index, analysis] of topicAnalyses.entries()) {
      requireObject(analysis, `${label}.topic_analyses[${index}]`);
      const fragment = fragments.find((candidate) => candidate.token_index === analysis.token_index
        && candidate.topic === analysis.topic
        && candidate.particle === analysis.particle
        && candidate.predicate === analysis.predicate);
      if (!fragment || coveredIndexes.has(fragment.token_index)) {
        fail(
          `${label}.topic_analyses[${index}] does not bind a unique ambiguous particle span`,
          'LEXICAL_SEMANTIC_BINDING',
        );
      }
      coveredIndexes.add(fragment.token_index);
      validateAuthoredTopicAnalysis(gloss, analysis, {
        decisionSourceId,
        expectedFragment: fragment,
        label: `${label}.topic_analyses[${index}]`,
      });
    }
    return topicAnalyses;
  }

  if (topicAnalyses !== undefined) {
    if (!Array.isArray(topicAnalyses)) {
      fail(`${label}.topic_analyses must be an array`, 'LEXICAL_SEMANTIC_SHAPE');
    }
    if (topicAnalyses.length !== fragments.length) {
      fail(
        `${label}.topic_analyses must contain exactly one analysis per ambiguous particle span`,
        incompleteCode,
      );
    }
    for (const [index, analysis] of topicAnalyses.entries()) {
      validateAuthoredTopicAnalysis(gloss, analysis, {
        decisionSourceId,
        expectedFragment: fragments[index],
        label: `${label}.topic_analyses[${index}]`,
      });
    }
    return topicAnalyses;
  }

  if (topicAnalysis !== undefined) {
    validateAuthoredTopicAnalysis(gloss, topicAnalysis, {
      decisionSourceId,
      expectedFragment: fragments[0],
      label,
    });
    return [topicAnalysis];
  }
  if (requireEvidence && fragments.length > 0) {
    fail(`${label} is required for every ambiguous particle span`, incompleteCode);
  }
  return undefined;
}

export function buildNominalTermPositions(recordInfos) {
  const positions = new Map();
  for (const recordInfo of recordInfos) {
    const record = recordOf(recordInfo);
    if (!record || typeof record !== 'object' || !Array.isArray(record.senses)) continue;
    const recordPositions = new Set(
      record.senses
        .map((sense) => sense?.pos)
        .filter((pos) => typeof pos === 'string'),
    );
    for (const term of [record.lemma, ...(record.search_forms ?? [])]) {
      if (typeof term !== 'string' || term.length === 0) continue;
      const indexedTerms = [term];
      const inflectionalStem = /^(?<stem>[\p{L}\p{M}\p{N}]+)다$/u.exec(term)?.groups.stem;
      // A verb/adjective lemma is stored with its dictionary ending, while
      // productive adnominal forms attach directly to the stem (`먹다` ->
      // `먹는`).  Index that stem as well so an exact noun homograph does not
      // override the available verb/adjective evidence.
      if (inflectionalStem
        && (recordPositions.has('verb') || recordPositions.has('adjective'))) {
        indexedTerms.push(inflectionalStem);
      }
      for (const indexedTerm of indexedTerms) {
        const existing = positions.get(indexedTerm) ?? new Set();
        for (const pos of recordPositions) existing.add(pos);
        positions.set(indexedTerm, existing);
      }
    }
  }
  return positions;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`, 'LEXICAL_SHAPE_ERROR');
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`, 'LEXICAL_VALUE_ERROR');
  }
  if (value !== value.trim()) {
    fail(`${label} must not have leading or trailing whitespace`, 'LEXICAL_VALUE_ERROR');
  }
  if (value.normalize('NFC') !== value) {
    fail(`${label} must be NFC-normalized`, 'LEXICAL_VALUE_ERROR');
  }
  return value;
}

function requireArray(value, label, { minItems = 0 } = {}) {
  if (!Array.isArray(value) || value.length < minItems) {
    fail(`${label} must be an array with at least ${minItems} item(s)`, 'LEXICAL_SHAPE_ERROR');
  }
  return value;
}

function requireEnum(value, values, label) {
  if (!values.includes(value)) {
    fail(`${label} must be one of ${values.join(', ')} (received ${String(value)})`, 'LEXICAL_VALUE_ERROR');
  }
}

function validateSemanticDecisionSource(review, label) {
  const source = requireObject(review.decision_source, `${label}.decision_source`);
  if (source.kind !== SEMANTIC_DECISION_SOURCE_KIND) {
    fail(
      `${label}.decision_source.kind must identify a separately authored decision source`,
      'LEXICAL_SEMANTIC_PROVENANCE',
    );
  }
  if (source.contract_version !== SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION) {
    fail(
      `${label}.decision_source.contract_version is unsupported`,
      'LEXICAL_SEMANTIC_PROVENANCE',
    );
  }
  requireString(source.source_id, `${label}.decision_source.source_id`);
  requireString(source.path, `${label}.decision_source.path`);
  return source.source_id;
}

function validateIndependentDecisionEvidence(review, {
  decision,
  candidateRecord,
  reviewedRecord,
  inventoryId,
  label,
  decisionSourceId,
} = {}) {
  const source = review.decision_source;
  if (!['agent-authored-decision', 'human-authored-decision'].includes(source.authoring_mode)) {
    fail(
      `${label}.decision_source.authoring_mode must identify the authored decision path`,
      'LEXICAL_SEMANTIC_PROVENANCE',
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(source.source_sha256 ?? '')) {
    fail(
      `${label}.decision_source.source_sha256 must bind a separately supplied decision artifact`,
      'LEXICAL_SEMANTIC_PROVENANCE',
    );
  }
  const authored = requireObject(review.authored_decision, `${label}.authored_decision`);
  if (authored.source_sha256 !== source.source_sha256
    || authored.decision_source_id !== decisionSourceId) {
    fail(
      `${label}.authored_decision must bind the exact authored decision source`,
      'LEXICAL_SEMANTIC_PROVENANCE',
    );
  }
  if (authored.candidate_record_id !== candidateRecord.id
    || authored.candidate_record_sha256 !== sha256Json(candidateRecord)) {
    fail(
      `${label}.authored_decision must bind the exact candidate record`,
      'LEXICAL_SEMANTIC_BINDING',
    );
  }
  const reviewed = reviewedRecord ?? candidateRecord;
  if (authored.reviewed_record_sha256 !== sha256Json(reviewed)) {
    fail(
      `${label}.authored_decision.reviewed_record_sha256 must bind the exact reviewed record`,
      'LEXICAL_SEMANTIC_BINDING',
    );
  }
  if (authored.decision !== decision
    || authored.selection_rank !== review.selection.rank
    || authored.selection_score !== review.selection.score) {
    fail(
      `${label}.authored_decision must bind the decision and selection output`,
      'LEXICAL_SELECTION_BINDING',
    );
  }
  requireString(authored.rationale, `${label}.authored_decision.rationale`);
  if (inventoryId !== undefined && !authored.rationale.includes(inventoryId)) {
    fail(
      `${label}.authored_decision.rationale must bind ${inventoryId}`,
      'LEXICAL_SEMANTIC_BINDING',
    );
  }
  const senseEvidence = requireArray(
    authored.sense_evidence,
    `${label}.authored_decision.sense_evidence`,
    { minItems: 1 },
  );
  assert.deepEqual(
    senseEvidence.map(({ sense_id: senseId }) => senseId),
    reviewed.senses.map(({ id }) => id),
    `${label}.authored_decision.sense_evidence must cover every reviewed sense`,
  );
  for (const [index, evidence] of senseEvidence.entries()) {
    const evidenceLabel = `${label}.authored_decision.sense_evidence[${index}]`;
    requireObject(evidence, evidenceLabel);
    const sense = reviewed.senses[index];
    if (evidence.sense_id !== sense.id || evidence.gloss_sha256 !== sha256Json(sense.gloss)) {
      fail(`${evidenceLabel} does not bind the reviewed sense`, 'LEXICAL_SEMANTIC_BINDING');
    }
    requireString(evidence.basis, `${evidenceLabel}.basis`);
  }
  const relationEvidence = requireArray(
    authored.relation_evidence,
    `${label}.authored_decision.relation_evidence`,
    { minItems: 1 },
  );
  assert.deepEqual(
    relationEvidence.map(({ sense_id: senseId }) => senseId),
    reviewed.senses.map(({ id }) => id),
    `${label}.authored_decision.relation_evidence must cover every reviewed sense`,
  );
  for (const [index, evidence] of relationEvidence.entries()) {
    const evidenceLabel = `${label}.authored_decision.relation_evidence[${index}]`;
    requireObject(evidence, evidenceLabel);
    const sense = reviewed.senses[index];
    const relationCount = sense.relations?.length ?? 0;
    if (evidence.sense_id !== sense.id
      || evidence.relation_count !== relationCount
      || evidence.decision !== (relationCount === 0 ? 'no-relations' : 'relations-reviewed')) {
      fail(`${evidenceLabel} does not bind the reviewed relation outcome`, 'LEXICAL_RELATION_BINDING');
    }
    requireString(evidence.basis, `${evidenceLabel}.basis`);
  }
}

function boundaryDecisionForFinding(action, classification) {
  if (action === 'retain') return classification === 'coordinated' ? 'coordinated' : 'atomic';
  if (action === 'split') return classification === 'coordinated' ? 'coordinated' : 'split';
  return action;
}

function validateAuthoredBoundaryPairs(
  record,
  boundary,
  label,
  { decisionSourceId, productionDecision } = {},
) {
  requireString(boundary.review_id, `${label}.review_id`);
  requireString(boundary.method, `${label}.method`);
  if (boundary.method !== SEMANTIC_BOUNDARY_METHOD) {
    fail(`${label}.method must use the independent pairwise boundary method`, 'LEXICAL_SEMANTIC_PROVENANCE');
  }
  const independence = requireObject(boundary.independence, `${label}.independence`);
  if (independence.independent_of_sense_count !== true) {
    fail(
      `${label}.independence must not derive its decision from the current sense count`,
      'LEXICAL_SEMANTIC_BOUNDARY_BLOCKER',
    );
  }
  requireString(independence.source, `${label}.independence.source`);
  requireString(independence.decision_source_id, `${label}.independence.decision_source_id`);
  if (independence.decision_source_id !== decisionSourceId) {
    fail(`${label}.independence.decision_source_id is not bound to the authored decision source`, 'LEXICAL_SEMANTIC_PROVENANCE');
  }
  requireString(independence.decision_source_version, `${label}.independence.decision_source_version`);
  if (independence.decision_source_version !== SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION) {
    fail(`${label}.independence.decision_source_version is unsupported`, 'LEXICAL_SEMANTIC_PROVENANCE');
  }

  const expectedPairs = inspectSenseBoundaryPairs(record);
  const pairwise = requireArray(boundary.pairwise, `${label}.pairwise`);
  if (pairwise.length !== expectedPairs.length) {
    fail(`${label}.pairwise must review every sense pair`, 'LEXICAL_SEMANTIC_SCOPE');
  }
  const expectedByKey = new Map(expectedPairs.map((pair) => [
    `${pair.left_sense_id}:${pair.right_sense_id}`,
    pair,
  ]));
  const seen = new Set();
  for (const [index, item] of pairwise.entries()) {
    const pairLabel = `${label}.pairwise[${index}]`;
    requireObject(item, pairLabel);
    requireString(item.left_sense_id, `${pairLabel}.left_sense_id`);
    requireString(item.right_sense_id, `${pairLabel}.right_sense_id`);
    const key = `${item.left_sense_id}:${item.right_sense_id}`;
    if (seen.has(key)) fail(`${pairLabel} is duplicated`, 'LEXICAL_SEMANTIC_SCOPE');
    seen.add(key);
    const expected = expectedByKey.get(key);
    if (!expected) fail(`${pairLabel} is not bound to the reviewed sense pair`, 'LEXICAL_SEMANTIC_BINDING');
    requireEnum(item.relationship, SEMANTIC_BOUNDARY_RELATIONSHIPS, `${pairLabel}.relationship`);
    requireEnum(item.decision, SEMANTIC_BOUNDARY_PAIR_DECISIONS, `${pairLabel}.decision`);
    const leftSense = record.senses.find(({ id }) => id === item.left_sense_id);
    const rightSense = record.senses.find(({ id }) => id === item.right_sense_id);
    const leftGlossSha256 = sha256Json(leftSense.gloss);
    const rightGlossSha256 = sha256Json(rightSense.gloss);
    if (item.left_gloss_sha256 !== leftGlossSha256 || item.right_gloss_sha256 !== rightGlossSha256) {
      fail(`${pairLabel} gloss evidence does not bind the reviewed sense pair`, 'LEXICAL_SEMANTIC_BINDING');
    }
    requireString(item.evidence_basis, `${pairLabel}.evidence_basis`);
    requireString(item.distinguishing_feature, `${pairLabel}.distinguishing_feature`);
    requireString(item.rationale, `${pairLabel}.rationale`);
    requireString(item.decision_source_id, `${pairLabel}.decision_source_id`);
    if (item.decision_source_id !== decisionSourceId) {
      fail(`${pairLabel}.decision_source_id is not bound to the authored decision source`, 'LEXICAL_SEMANTIC_PROVENANCE');
    }
    if (!item.rationale.includes(record.id)
      || !item.rationale.includes(item.left_sense_id)
      || !item.rationale.includes(item.right_sense_id)
      || !item.rationale.includes(leftGlossSha256.slice(0, 12))
      || !item.rationale.includes(rightGlossSha256.slice(0, 12))) {
      fail(`${pairLabel}.rationale must cite the reviewed sense pair and gloss evidence`, 'LEXICAL_SEMANTIC_EVIDENCE');
    }
    const mechanicalRelationship = expected.relationship;
    if (MECHANICAL_BOUNDARY_RELATIONSHIPS.has(mechanicalRelationship)) {
      if (item.relationship !== mechanicalRelationship) {
        fail(
          `${pairLabel} contradicts the mechanical ${mechanicalRelationship} boundary finding`,
          'LEXICAL_SEMANTIC_BOUNDARY_BLOCKER',
        );
      }
      if (item.decision === 'retain') {
        fail(
          `${pairLabel} cannot retain a mechanical ${mechanicalRelationship} pair`,
          'LEXICAL_SEMANTIC_BOUNDARY_BLOCKER',
        );
      }
      if (['included', 'corrected'].includes(productionDecision)) {
        fail(
          `${pairLabel} remains a mechanical ${mechanicalRelationship} pair in an importable reviewed record`,
          'LEXICAL_SEMANTIC_BOUNDARY_BLOCKER',
        );
      }
    }
  }
  if (seen.size !== expectedPairs.length) {
    fail(`${label}.pairwise must cover every canonical sense pair`, 'LEXICAL_SEMANTIC_SCOPE');
  }
  return pairwise;
}

function recordOf(recordInfo) {
  return recordInfo?.record ?? recordInfo;
}

function sourceLabel(recordInfo, index) {
  if (!recordInfo || !recordInfo.filePath) return `records[${index}]`;
  return `${recordInfo.filePath}:${recordInfo.lineNumber ?? index + 1}`;
}

function consumesNominalEnclitics(tail) {
  let remaining = tail;
  while (remaining.length > 0) {
    const enclitic = WRITER_DOMAIN_NOMINAL_ENCLITIC_ATOMS.find((candidate) => (
      remaining.startsWith(candidate)
    ));
    if (!enclitic) return false;
    remaining = remaining.slice(enclitic.length);
  }
  return true;
}

function consumesNominalParticleTail(tail) {
  if (tail.length === 0) return true;
  const firstParticle = WRITER_DOMAIN_NOMINAL_PARTICLE_ATOMS.find((candidate) => (
    tail.startsWith(candidate)
  ));
  if (!firstParticle) return false;

  let remaining = tail.slice(firstParticle.length);
  if (remaining.length === 0) return true;

  const compositions = WRITER_DOMAIN_NOMINAL_COMPOSITION[firstParticle] ?? [];
  const composedParticle = compositions.find((candidate) => (
    remaining.startsWith(candidate)
  ));
  if (composedParticle) remaining = remaining.slice(composedParticle.length);
  return remaining.length === 0 || consumesNominalEnclitics(remaining);
}

function isAllowedDomainTail(term, tail) {
  if (tail.length === 0) return true;
  const metadata = WRITER_DOMAIN_TERM_METADATA[term] ?? { lexical_class: 'noun' };
  if (metadata.lexical_class === 'noun') {
    return consumesNominalParticleTail(tail)
      || WRITER_DOMAIN_COPULAR_TAILS.has(tail)
      || metadata.derived_tails?.has(tail) === true;
  }
  return metadata.inflectional_tails?.has(tail) === true;
}

function trimDomainToken(text, start, end) {
  while (start < end && WRITER_DOMAIN_EDGE_PUNCTUATION_PATTERN.test(text[start])) start += 1;
  while (end > start && WRITER_DOMAIN_EDGE_PUNCTUATION_PATTERN.test(text[end - 1])) end -= 1;
  return { start, end };
}

function writerDomainTokenMatches(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const matches = [];
  for (const tokenMatch of text.matchAll(/\S+/gu)) {
    const tokenStart = tokenMatch.index;
    const tokenEnd = tokenStart + tokenMatch[0].length;
    const trimmed = trimDomainToken(text, tokenStart, tokenEnd);
    const token = text.slice(trimmed.start, trimmed.end);
    for (const [axis, terms] of Object.entries(WRITER_DOMAIN_TERMS)) {
      for (const term of terms) {
        if (!token.startsWith(term)) continue;
        const tail = token.slice(term.length);
        if (!isAllowedDomainTail(term, tail)) continue;
        matches.push({
          axis,
          term,
          index: trimmed.start,
          end: trimmed.start + term.length,
        });
      }
    }
  }
  return matches;
}

function longestDomainMatches(matches) {
  return matches.filter((candidate) => !matches.some((other) => (
    other.term.length > candidate.term.length
      && other.index <= candidate.index
      && other.end >= candidate.end
  )));
}

function nearestDomainAxis(text, direction) {
  const matches = longestDomainMatches(writerDomainTokenMatches(text));
  if (matches.length === 0) return undefined;
  return direction === 'left'
    ? matches.sort((left, right) => right.index - left.index)[0]
    : matches.sort((left, right) => left.index - right.index)[0];
}

function pairKey(leftAxis, rightAxis) {
  return [leftAxis, rightAxis].sort().join(':');
}

function hasCoordinationCue(gloss, connectorIndex, connector) {
  const tail = gloss.slice(connectorIndex + connector.length, connectorIndex + connector.length + 18);
  // "A이나 B 등" is a normal coordinated class, not a claim that A and B
  // are separate senses.  The cue is structural and applies to any record.
  return /\s등(?:이|은|는|을|를|에|으로|에서|과|와|도|만|$)/u.test(tail);
}

/**
 * Return the conjunction observations used by both the batch semantic gate
 * and the complete-canonical audit.
 */
export function inspectGlossConnectors(gloss) {
  if (typeof gloss !== 'string') return [];
  const observations = [];
  for (const connector of CONNECTORS) {
    let from = 0;
    while (true) {
      const index = gloss.indexOf(connector, from);
      if (index < 0) break;
      const leftText = gloss.slice(Math.max(0, index - 24), index);
      const rightText = gloss.slice(index + connector.length, index + connector.length + 28);
      const left = nearestDomainAxis(leftText, 'left');
      const right = nearestDomainAxis(rightText, 'right');
      const sameDomain = left && right && left.axis === right.axis;
      const commonDomain = left && right && COMMON_DOMAIN_PAIRS.has(pairKey(left.axis, right.axis));
      const contextual = hasCoordinationCue(gloss, index, connector);
      let classification = 'unclassified-coordination';
      if (sameDomain) classification = 'same-domain-coordination';
      else if (commonDomain) classification = 'common-domain-coordination';
      else if (contextual) classification = 'contextual-coordination';
      else if (left && right) classification = 'disjunctive-domain';
      observations.push({
        connector,
        index,
        left_axis: left?.axis ?? null,
        left_term: left?.term ?? null,
        right_axis: right?.axis ?? null,
        right_term: right?.term ?? null,
        classification,
        excerpt: gloss.slice(Math.max(0, index - 18), index + connector.length + 24),
      });
      from = index + connector.length;
    }
  }
  return observations.sort((left, right) => left.index - right.index);
}

export function hasBroadGlossConnector(gloss) {
  return typeof gloss === 'string' && BROAD_GLOSS_CONNECTOR_PATTERN.test(gloss);
}

/**
 * Extract semantic domain evidence from the gloss itself.  This intentionally
 * does not look for conjunction spelling: a review must account for distinct
 * writer domains even when the gloss uses 과/와 or simply places two domain
 * terms next to one another.
 */
export function inspectWriterDomainEvidence(gloss) {
  if (typeof gloss !== 'string') return { axes: [], matches: [] };
  const longestMatches = longestDomainMatches(writerDomainTokenMatches(gloss));
  const axes = [...new Set(
    longestMatches
      .sort((left, right) => left.index - right.index || right.term.length - left.term.length)
      .map(({ axis }) => axis),
  )];
  return {
    axes,
    matches: longestMatches.map(({ axis, term, index }) => ({
      axis,
      term,
      index,
      excerpt: gloss.slice(Math.max(0, index - 14), index + term.length + 20),
    })),
  };
}

export function isPlaceholderGloss(gloss) {
  return typeof gloss !== 'string' || PLACEHOLDER_GLOSS_PATTERN.test(gloss.trim());
}

export function inspectGlossQuality(gloss, { nominalTerms, topicEvidence, senseId } = {}) {
  if (typeof gloss !== 'string' || gloss.trim().length === 0) {
    return {
      token_count: 0,
      generic_template: false,
      malformed_fragment: false,
      malformed_structure: false,
      malformed_particles: [],
      topic_state: 'unsupported',
    };
  }
  const trimmed = gloss.trim();
  const topicAnalysis = inspectTopicFragment(trimmed, { nominalTerms, topicEvidence, senseId });
  return {
    token_count: trimmed.split(/\s+/u).length,
    generic_template: GENERIC_GLOSS_TEMPLATE_PATTERN.test(gloss),
    malformed_fragment: topicAnalysis.malformed,
    malformed_structure: topicAnalysis.malformed,
    malformed_particles: inspectMalformedParticles(trimmed, {
      topicEvidence,
      senseId,
    }),
    topic_state: TOPIC_ANALYSIS_STATES.includes(topicAnalysis.state)
      ? topicAnalysis.state
      : 'unsupported',
  };
}

function recordQualityFindings(record, {
  label = 'record',
  mode = 'canonical',
  rejectAnyBroadConnector = false,
  nominalTerms,
  topicEvidence,
} = {}) {
  const findings = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    findings.push({ code: 'LEXICAL_SHAPE_ERROR', message: `${label} must be an object` });
    return findings;
  }
  if (!RECORD_TYPES.includes(record.record_type)) {
    findings.push({ code: 'LEXICAL_RECORD_TYPE', message: `${label}.record_type must be entry or expression` });
  }
  if (!ROLES.includes(record.role)) {
    findings.push({ code: 'LEXICAL_ROLE', message: `${label}.role must be start or reference-only` });
  }
  if (typeof record.lemma !== 'string' || record.lemma.trim().length === 0) {
    findings.push({ code: 'LEXICAL_LEMMA', message: `${label}.lemma must be a non-empty string` });
  }
  if (Array.isArray(record.search_forms)) {
    const normalizedForms = record.search_forms
      .filter((form) => typeof form === 'string')
      .map((form) => form.normalize('NFC'));
    if (typeof record.lemma === 'string' && !normalizedForms.includes(record.lemma.normalize('NFC'))) {
      findings.push({
        code: 'LEXICAL_SEARCH_FORM_LEMMA',
        message: `${label}.search_forms must include the lemma`,
      });
    }
    if (new Set(normalizedForms).size !== normalizedForms.length) {
      findings.push({
        code: 'LEXICAL_SEARCH_FORM_DUPLICATE',
        message: `${label}.search_forms must not contain duplicate normalized forms`,
      });
    }
  }
  if (!Array.isArray(record.senses) || record.senses.length === 0) {
    findings.push({ code: 'LEXICAL_SENSES', message: `${label}.senses must contain at least one sense` });
    return findings;
  }
  if (mode === 'canonical' && typeof record.id === 'string' && !/^[wr][0-9]{3,}$/u.test(record.id)) {
    findings.push({ code: 'LEXICAL_CANONICAL_ID', message: `${label}.id must be a canonical w/r identifier` });
  }
  if (record.record_type === 'expression' && record.senses.some(({ pos }) => pos !== 'expression')) {
    findings.push({
      code: 'LEXICAL_EXPRESSION_POS',
      message: `${label} expression record must use expression POS for every sense`,
    });
  }
  if (record.record_type === 'entry' && record.senses.some(({ pos }) => pos === 'expression')) {
    findings.push({
      code: 'LEXICAL_ENTRY_EXPRESSION_POS',
      message: `${label} entry record must not contain expression POS`,
    });
  }
  for (const [senseIndex, sense] of record.senses.entries()) {
    const senseLabel = `${label}.senses[${senseIndex}]`;
    if (!sense || typeof sense !== 'object' || Array.isArray(sense)) {
      findings.push({ code: 'LEXICAL_SENSE_SHAPE', message: `${senseLabel} must be an object` });
      continue;
    }
    if (!ALL_POS.includes(sense.pos)) {
      findings.push({ code: 'LEXICAL_SENSE_POS', message: `${senseLabel}.pos is not a supported part of speech` });
    } else if (record.record_type === 'entry' && !ENTRY_POS.includes(sense.pos)) {
      findings.push({ code: 'LEXICAL_ENTRY_POS', message: `${senseLabel}.pos is invalid for an entry` });
    }
    if (typeof sense.gloss !== 'string' || sense.gloss.trim().length === 0) {
      findings.push({ code: 'LEXICAL_GLOSS_EMPTY', message: `${senseLabel}.gloss must be non-empty` });
      continue;
    }
    if (isPlaceholderGloss(sense.gloss)) {
      findings.push({
        code: 'LEXICAL_PLACEHOLDER_GLOSS',
        message: `${senseLabel}.gloss is a placeholder and cannot enter canonical data`,
      });
    }
    const glossQuality = inspectGlossQuality(sense.gloss, {
      nominalTerms,
      topicEvidence,
      senseId: sense.id,
    });
    if (glossQuality.token_count < 2) {
      findings.push({
        code: 'LEXICAL_GLOSS_TOO_SHORT',
        message: `${senseLabel}.gloss must contain at least two whitespace-delimited words`,
      });
    } else if (glossQuality.generic_template) {
      findings.push({
        code: 'LEXICAL_GENERIC_GLOSS',
        message: `${senseLabel}.gloss is a generic drafting template and must be replaced with a reviewed meaning`,
      });
    } else if (glossQuality.malformed_fragment) {
      findings.push({
        code: 'LEXICAL_MALFORMED_GLOSS',
        message: `${senseLabel}.gloss contains an unfinished or malformed lexical fragment`,
      });
    }
    if (glossQuality.malformed_particles.length > 0) {
      const particleFinding = glossQuality.malformed_particles[0];
      findings.push({
        code: 'LEXICAL_MALFORMED_PARTICLE',
        message: `${senseLabel}.gloss attaches ${particleFinding.particle} to ${particleFinding.stem}, but the compatible particle is ${particleFinding.expected_particle} before ${particleFinding.next_token}`,
        observation: particleFinding,
      });
    }
    const observations = inspectGlossConnectors(sense.gloss);
    if (rejectAnyBroadConnector && observations.length > 0) {
      findings.push({
        code: 'LEXICAL_BROAD_GLOSS',
        message: `${senseLabel}.gloss contains a broad connector`,
      });
    } else {
      for (const observation of observations) {
        if (observation.classification !== 'disjunctive-domain') continue;
        findings.push({
          code: 'LEXICAL_MERGED_SENSE_GLOSS',
          message: `${senseLabel}.gloss joins distinct writer domains (${observation.left_axis} and ${observation.right_axis}) with ${observation.connector} in "${observation.excerpt}"; split the senses or rewrite the gloss to one domain`,
          observation,
        });
      }
    }
  }
  return findings;
}

/**
 * Validate one candidate or canonical record through the shared quality
 * contract.  Structural JSON Schema and cross-record relation checks remain
 * separate concerns and are invoked by the admission pipeline.
 */
export function validateLexicalRecord(record, options = {}) {
  const {
    label = 'record',
    mode = 'canonical',
    expectedId,
    expectedLemma,
    rejectAnyBroadConnector = false,
    nominalTerms,
    topicEvidence,
  } = options;
  requireObject(record, label);
  requireString(record.id, `${label}.id`);
  requireString(record.lemma, `${label}.lemma`);
  if (expectedId !== undefined && record.id !== expectedId) {
    fail(`${label}.id must be ${expectedId}`, 'LEXICAL_ID_BINDING');
  }
  if (expectedLemma !== undefined && record.lemma !== expectedLemma) {
    fail(`${label}.lemma must bind the reviewed candidate`, 'LEXICAL_LEMMA_BINDING');
  }
  requireEnum(record.record_type, RECORD_TYPES, `${label}.record_type`);
  requireEnum(record.role, ROLES, `${label}.role`);
  if (record.role === 'start') {
    requireString(record.candidate_id, `${label}.candidate_id`);
    if (record.candidate_id !== record.id) {
      fail(`${label}.candidate_id must equal the start record id`, 'LEXICAL_CANDIDATE_BINDING');
    }
  } else if (record.role === 'reference-only' && record.id.startsWith('r')
    && Object.hasOwn(record, 'candidate_id')) {
    fail(`${label} pure reference-only record must not carry candidate_id`, 'LEXICAL_REFERENCE_CANDIDATE');
  }
  const forms = requireArray(record.search_forms, `${label}.search_forms`, { minItems: 1 });
  for (const [index, form] of forms.entries()) requireString(form, `${label}.search_forms[${index}]`);
  const senses = requireArray(record.senses, `${label}.senses`, { minItems: 1 });
  for (const [index, sense] of senses.entries()) {
    requireObject(sense, `${label}.senses[${index}]`);
    requireString(sense.id, `${label}.senses[${index}].id`);
    requireEnum(sense.pos, ALL_POS, `${label}.senses[${index}].pos`);
    requireString(sense.gloss, `${label}.senses[${index}].gloss`);
    if (!sense.id.startsWith(`${record.id}-`)) {
      fail(`${label}.senses[${index}].id must belong to ${record.id}`, 'LEXICAL_SENSE_BINDING');
    }
  }
  if (mode === 'canonical' && record.record_type === 'expression'
    && senses.some(({ pos }) => pos !== 'expression')) {
    fail(`${label} expression record must use expression POS for every sense`, 'LEXICAL_EXPRESSION_POS');
  }
  const findings = recordQualityFindings(record, {
    label,
    mode,
    rejectAnyBroadConnector,
    nominalTerms,
    topicEvidence,
  });
  if (findings.length > 0) {
    const finding = findings[0];
    fail(finding.message, finding.code, finding);
  }
  return record;
}

export function findLexicalQualityFindings(record, options = {}) {
  return recordQualityFindings(record, options);
}

/**
 * A batch must not manufacture a large lexical set by copying one gloss over
 * unrelated records.  A repeated gloss can be legitimate in a small semantic
 * cluster, so the shared boundary only rejects bulk reuse; callers that need a
 * broader equivalence class must author separate evidence instead of silently
 * bypassing this invariant.
 */
export function findBulkGlossProjectionFindings(
  recordInfos,
  { maxOccurrences = 3 } = {},
) {
  const ownersByGloss = new Map();
  const ownersByTemplate = new Map();

  const lemmaTerms = (lemma) => {
    const terms = new Set([lemma, lemma.replace(/\s+/gu, '')]);
    for (const token of lemma.split(/\s+/gu)) {
      terms.add(token);
      for (const component of token.split(/(?=의|에)|(?<=의|에)/u)) {
        if (component !== '의' && component !== '에') terms.add(component);
      }
      const stem = token.replace(/(?:으로|에서|에게|한테|처럼|까지|부터|보다|의|은|는|이|가|을|를|에|로|와|과|도|만)$/u, '');
      if (stem.length >= 1) terms.add(stem);
    }
    return [...terms]
      .filter((term) => term.length >= 1 && term !== '의' && term !== '에')
      .sort((left, right) => right.length - left.length);
  };

  const templateFingerprint = (record, gloss) => {
    let fingerprint = gloss.normalize('NFC').split(/[.!?。！？]/u)[0];
    for (const term of lemmaTerms(record.lemma)) {
      fingerprint = fingerprint.replaceAll(term, '{lexeme}');
    }
    return fingerprint
      .replace(/[‘’“”"']/gu, '')
      .replace(/\s+/gu, ' ')
      .trim();
  };

  for (const recordInfo of recordInfos) {
    const record = recordOf(recordInfo);
    for (const sense of record?.senses ?? []) {
      if (typeof sense.gloss !== 'string') continue;
      const owner = { record_id: record.id, sense_id: sense.id };
      const glossOwners = ownersByGloss.get(sense.gloss) ?? [];
      glossOwners.push(owner);
      ownersByGloss.set(sense.gloss, glossOwners);
      const fingerprint = templateFingerprint(record, sense.gloss);
      const templateOwners = ownersByTemplate.get(fingerprint) ?? [];
      templateOwners.push(owner);
      ownersByTemplate.set(fingerprint, templateOwners);
    }
  }
  const exactFindings = [...ownersByGloss.entries()]
    .filter(([, owners]) => owners.length > maxOccurrences)
    .map(([gloss, owners]) => ({
      code: 'LEXICAL_BULK_GLOSS_PROJECTION',
      kind: 'exact-gloss',
      gloss,
      owners,
      message: `gloss ${JSON.stringify(gloss)} is reused by ${owners.length} candidate senses; author lemma-specific semantic content before admission`,
    }));
  const exactFindingKeys = new Set(exactFindings.flatMap(({ owners }) => owners.map(({ record_id: recordId, sense_id: senseId }) => `${recordId}:${senseId}`)));
  const templateFindings = [...ownersByTemplate.entries()]
    .filter(([, owners]) => owners.length > maxOccurrences)
    .map(([fingerprint, owners]) => ({
      code: 'LEXICAL_PARAMETERIZED_GLOSS_PROJECTION',
      kind: 'parameterized-template',
      fingerprint,
      owners,
      message: `gloss definition template ${JSON.stringify(fingerprint)} is reused by ${owners.length} candidate senses after lemma substitution; author candidate-specific semantic content before admission`,
    }))
    .filter(({ owners }) => owners.some(({ record_id: recordId, sense_id: senseId }) => !exactFindingKeys.has(`${recordId}:${senseId}`)));
  return [...exactFindings, ...templateFindings];
}

export function validateBulkGlossProjection(recordInfos, options = {}) {
  const findings = findBulkGlossProjectionFindings(recordInfos, options);
  if (findings.length > 0) {
    const finding = findings[0];
    fail(finding.message, finding.code, finding);
  }
  return findings;
}

/**
 * Run the complete canonical audit.  The returned report is deterministic and
 * can be embedded in a batch verification artifact.  No batch ID, record ID,
 * or historical allowlist can suppress a finding.
 */
export function auditCanonicalLexicalQuality(
  recordInfos,
  { scope = 'complete-canonical', throwOnError = true, topicEvidence } = {},
) {
  const normalized = recordInfos.map(recordOf);
  const nominalTerms = buildNominalTermPositions(recordInfos);
  const findings = [];
  const connectorCounts = Object.fromEntries(CONNECTORS.map((connector) => [connector, 0]));
  const classificationCounts = {};
  let senseCount = 0;
  for (const finding of findBulkGlossProjectionFindings(recordInfos)) {
    const owner = finding.owners[0];
    findings.push({
      ...finding,
      record_id: owner?.record_id ?? null,
      sense_id: owner?.sense_id ?? null,
      location: scope,
      message: `${scope}: ${finding.message.replace(/candidate senses/gu, 'canonical senses')}`,
    });
  }
  for (const [index, recordInfo] of recordInfos.entries()) {
    const record = normalized[index];
    if (!record || typeof record !== 'object') {
      findings.push({
        code: 'LEXICAL_SHAPE_ERROR',
        record_id: null,
        sense_id: null,
        location: sourceLabel(recordInfo, index),
        message: 'record must be an object',
      });
      continue;
    }
    const qualityFindings = recordQualityFindings(record, {
      label: sourceLabel(recordInfo, index),
      mode: 'canonical',
      nominalTerms,
      topicEvidence,
    });
    for (const finding of qualityFindings) {
      const senseMatch = /\.senses\[(\d+)\]/u.exec(finding.message);
      const senseIndex = senseMatch ? Number(senseMatch[1]) : undefined;
      findings.push({
        ...finding,
        record_id: record.id ?? null,
        sense_id: senseIndex === undefined ? null : record.senses?.[senseIndex]?.id ?? null,
        location: sourceLabel(recordInfo, index),
      });
    }
    for (const sense of record.senses ?? []) {
      senseCount += 1;
      for (const observation of inspectGlossConnectors(sense.gloss)) {
        connectorCounts[observation.connector] += 1;
        classificationCounts[observation.classification] = (classificationCounts[observation.classification] ?? 0) + 1;
      }
    }
    for (const pair of inspectSenseBoundaryPairs(record)) {
      if (!MECHANICAL_BOUNDARY_RELATIONSHIPS.has(pair.relationship)) continue;
      const leftSense = record.senses.find(({ id }) => id === pair.left_sense_id);
      const rightSense = record.senses.find(({ id }) => id === pair.right_sense_id);
      findings.push({
        code: 'LEXICAL_SEMANTIC_BOUNDARY_BLOCKER',
        record_id: record.id,
        sense_id: null,
        location: sourceLabel(recordInfo, index),
        message: `${sourceLabel(recordInfo, index)} contains a high-confidence ${pair.relationship} sense pair (${pair.left_sense_id}/${pair.right_sense_id}); the pair must be merged or rewritten before canonical admission`,
        boundary_pair: {
          ...pair,
          left_gloss: leftSense?.gloss,
          right_gloss: rightSense?.gloss,
        },
      });
    }
  }
  const lemmaOwners = new Map();
  const searchFormOwners = new Map();
  for (const [index, record] of normalized.entries()) {
    if (!record || typeof record !== 'object') continue;
    const location = sourceLabel(recordInfos[index], index);
    if (typeof record.lemma === 'string') {
      const key = record.lemma.normalize('NFC');
      const owners = lemmaOwners.get(key) ?? [];
      owners.push(record.id ?? location);
      lemmaOwners.set(key, owners);
    }
    const searchForms = Array.isArray(record.search_forms) ? record.search_forms : [];
    for (const form of searchForms) {
      if (typeof form !== 'string') continue;
      const key = form.normalize('NFC');
      const owners = searchFormOwners.get(key) ?? [];
      owners.push(record.id ?? location);
      searchFormOwners.set(key, owners);
    }
  }
  for (const [lemma, owners] of lemmaOwners.entries()) {
    if (owners.length < 2) continue;
    findings.push({
      code: 'LEXICAL_DUPLICATE_LEMMA',
      record_id: owners[1],
      sense_id: null,
      location: scope,
      message: `lemma ${JSON.stringify(lemma)} is owned by multiple records: ${owners.join(', ')}`,
    });
  }
  for (const [searchForm, owners] of searchFormOwners.entries()) {
    if (owners.length < 2) continue;
    findings.push({
      code: 'LEXICAL_DUPLICATE_SEARCH_FORM',
      record_id: owners[1],
      sense_id: null,
      location: scope,
      message: `search form ${JSON.stringify(searchForm)} is owned by multiple records: ${owners.join(', ')}`,
    });
  }
  const report = {
    ruleset_version: LEXICAL_QUALITY_RULESET_VERSION,
    scope,
    record_count: normalized.length,
    sense_count: senseCount,
    connector_counts: connectorCounts,
    connector_classification_counts: Object.fromEntries(
      Object.entries(classificationCounts).sort(([left], [right]) => left.localeCompare(right)),
    ),
    blocking_findings: findings,
    blocking_finding_count: findings.length,
  };
  if (throwOnError && findings.length > 0) {
    const finding = findings[0];
    throw new LexicalQualityError(
      `${finding.location}: ${finding.message}`,
      finding.code,
      finding,
    );
  }
  return report;
}

function semanticStatusForDecision(decision) {
  return ['included', 'corrected'].includes(decision) ? 'selected' : decision;
}

/**
 * Shared semantic-review contract.  Batch-specific modules supply scope
 * bindings (axis, inventory IDs, rank ranges); this function owns the
 * reusable sense/POS/expression/relation/selection checks.
 */
export function validateLexicalSemanticReview(review, {
  decision,
  candidateRecord,
  reviewedRecord,
  inventoryId,
  label = 'semantic_review',
  version,
  expectedRecordType,
  catalogCount = 550,
  rejectAnyBroadConnector = false,
  requireSemanticEvidence = false,
  requireIndependentDecisionEvidence = false,
  selectionRationaleTokens = ['verification', 'coverage'],
} = {}) {
  requireObject(review, label);
  if (version !== undefined && review.version !== version) {
    fail(`${label}.version must be ${version}`, 'LEXICAL_SEMANTIC_REVIEW_INCOMPLETE');
  }
  if (review.status !== 'complete') {
    fail(`${label}.status must be complete`, 'LEXICAL_SEMANTIC_REVIEW_INCOMPLETE');
  }
  const record = reviewedRecord ?? candidateRecord;
  validateLexicalRecord(candidateRecord, {
    label: `${label}.candidate_record`,
    mode: 'candidate',
    rejectAnyBroadConnector,
  });
  if (reviewedRecord) {
    validateLexicalRecord(reviewedRecord, {
      label: `${label}.reviewed_record`,
      mode: 'canonical',
      rejectAnyBroadConnector,
    });
  }

  const boundary = requireObject(review.sense_boundary, `${label}.sense_boundary`);
  if (boundary.status !== 'pass') {
    fail(`${label}.sense_boundary.status must be pass`, 'LEXICAL_SEMANTIC_REVIEW_INCOMPLETE');
  }
  const decisionSourceId = requireSemanticEvidence
    ? validateSemanticDecisionSource(review, label)
    : undefined;
  if (requireSemanticEvidence) {
    requireString(boundary.decision_source_id, `${label}.sense_boundary.decision_source_id`);
    if (boundary.decision_source_id !== decisionSourceId) {
      fail(`${label}.sense_boundary.decision_source_id is not bound to the authored decision source`, 'LEXICAL_SEMANTIC_PROVENANCE');
    }
    validateAuthoredBoundaryPairs(record, boundary, `${label}.sense_boundary`, {
      decisionSourceId,
      productionDecision: decision,
    });
  }
  const findings = requireArray(boundary.findings, `${label}.sense_boundary.findings`, { minItems: 1 });
  assert.deepEqual(
    findings.map(({ sense_id: senseId }) => senseId),
    record.senses.map(({ id }) => id),
    `${label}.sense_boundary.findings must bind every reviewed sense`,
  );
  for (const [senseIndex, finding] of findings.entries()) {
    const senseLabel = `${label}.sense_boundary.findings[${senseIndex}]`;
    requireObject(finding, senseLabel);
    const sense = record.senses[senseIndex];
    if (finding.sense_id !== sense.id) {
      fail(`${senseLabel}.sense_id is not bound to the reviewed sense`, 'LEXICAL_SEMANTIC_BINDING');
    }
    requireEnum(finding.action, SEMANTIC_BOUNDARY_ACTIONS, `${senseLabel}.action`);
    requireEnum(finding.classification, SEMANTIC_BOUNDARY_CLASSIFICATIONS, `${senseLabel}.classification`);
    requireString(finding.rationale, `${senseLabel}.rationale`);
    if (inventoryId !== undefined
      && (!finding.rationale.includes(inventoryId) || !finding.rationale.includes(sense.id))) {
      fail(`${senseLabel}.rationale must bind ${inventoryId} and ${sense.id}`, 'LEXICAL_SEMANTIC_BINDING');
    }
    if (requireSemanticEvidence) {
      const semanticEvidence = requireObject(
        finding.semantic_evidence,
        `${senseLabel}.semantic_evidence`,
      );
      if (semanticEvidence.status !== 'pass') {
        fail(`${senseLabel}.semantic_evidence.status must be pass`, 'LEXICAL_SEMANTIC_REVIEW_INCOMPLETE');
      }
      if (semanticEvidence.gloss_sha256 !== sha256Json(sense.gloss)) {
        fail(`${senseLabel}.semantic_evidence.gloss_sha256 does not bind the reviewed gloss`, 'LEXICAL_SEMANTIC_BINDING');
      }
      const observedDomainAxes = requireArray(
        semanticEvidence.observed_domain_axes,
        `${senseLabel}.semantic_evidence.observed_domain_axes`,
      );
      if (new Set(observedDomainAxes).size !== observedDomainAxes.length
        || observedDomainAxes.some((axis) => !WRITER_DOMAIN_AXES.includes(axis))) {
        fail(`${senseLabel}.semantic_evidence.observed_domain_axes contains an unsupported or duplicate domain`, 'LEXICAL_SEMANTIC_BINDING');
      }
      const derivedDomainAxes = inspectWriterDomainEvidence(sense.gloss).axes;
      if (JSON.stringify(observedDomainAxes) !== JSON.stringify(derivedDomainAxes)) {
        fail(
          `${senseLabel}.semantic_evidence.observed_domain_axes does not bind the domains observed in the gloss`,
          'LEXICAL_SEMANTIC_BOUNDARY_BLOCKER',
        );
      }
      const domainEvidence = requireArray(
        semanticEvidence.domain_evidence,
        `${senseLabel}.semantic_evidence.domain_evidence`,
      );
      if (JSON.stringify(domainEvidence) !== JSON.stringify(inspectWriterDomainEvidence(sense.gloss).matches)) {
        fail(
          `${senseLabel}.semantic_evidence.domain_evidence does not bind the reviewed gloss`,
          'LEXICAL_SEMANTIC_BOUNDARY_BLOCKER',
        );
      }
      const connectorObservations = requireArray(
        semanticEvidence.connector_observations,
        `${senseLabel}.semantic_evidence.connector_observations`,
      );
      if (JSON.stringify(connectorObservations) !== JSON.stringify(inspectGlossConnectors(sense.gloss))) {
        fail(
          `${senseLabel}.semantic_evidence.connector_observations does not bind the reviewed gloss`,
          'LEXICAL_SEMANTIC_BOUNDARY_BLOCKER',
        );
      }
      requireString(semanticEvidence.rationale, `${senseLabel}.semantic_evidence.rationale`);
      requireEnum(
        semanticEvidence.boundary_decision,
        ['atomic', 'split', 'coordinated'],
        `${senseLabel}.semantic_evidence.boundary_decision`,
      );
      if (derivedDomainAxes.length > 1 && semanticEvidence.boundary_decision !== 'coordinated') {
        fail(
          `${senseLabel} has multiple writer domains; the semantic review must explicitly justify a coordinated domain`,
          'LEXICAL_SEMANTIC_BOUNDARY_BLOCKER',
        );
      }
      if (requireSemanticEvidence) {
        requireString(semanticEvidence.decision_source_id, `${senseLabel}.semantic_evidence.decision_source_id`);
        if (semanticEvidence.decision_source_id !== decisionSourceId) {
          fail(`${senseLabel}.semantic_evidence.decision_source_id is not bound to the authored decision source`, 'LEXICAL_SEMANTIC_PROVENANCE');
        }
        const expectedBoundaryDecision = boundaryDecisionForFinding(finding.action, finding.classification);
        const boundaryDecisionMatches = semanticEvidence.boundary_decision === expectedBoundaryDecision
          || (semanticEvidence.boundary_decision === 'coordinated'
            && ['atomic', 'split'].includes(expectedBoundaryDecision));
        if (!boundaryDecisionMatches) {
          fail(
            `${senseLabel}.semantic_evidence.boundary_decision does not match the authored boundary decision`,
            'LEXICAL_SEMANTIC_BOUNDARY_BLOCKER',
          );
        }
      }
      validateTopicAnalysisEvidence(
        sense.gloss,
        semanticEvidence,
        {
          decisionSourceId,
          label: `${senseLabel}.semantic_evidence`,
        },
      );
    }
  }

  const pos = requireObject(review.pos, `${label}.pos`);
  if (pos.status !== 'pass') fail(`${label}.pos.status must be pass`, 'LEXICAL_SEMANTIC_REVIEW_INCOMPLETE');
  if (requireSemanticEvidence) {
    if (pos.decision !== 'verified') {
      fail(`${label}.pos.decision must be verified by an authored semantic decision`, 'LEXICAL_SEMANTIC_REVIEW_INCOMPLETE');
    }
    requireString(pos.decision_source_id, `${label}.pos.decision_source_id`);
    if (pos.decision_source_id !== decisionSourceId) {
      fail(`${label}.pos.decision_source_id is not bound to the authored decision source`, 'LEXICAL_SEMANTIC_PROVENANCE');
    }
  }
  assert.deepEqual(
    pos.observed_pos,
    record.senses.map(({ pos: sensePos }) => sensePos),
    `${label}.pos.observed_pos must bind every reviewed sense`,
  );
  requireString(pos.rationale, `${label}.pos.rationale`);
  if (inventoryId !== undefined && !pos.rationale.includes(inventoryId)) {
    fail(`${label}.pos.rationale must bind ${inventoryId}`, 'LEXICAL_SEMANTIC_BINDING');
  }

  const expression = requireObject(review.expression, `${label}.expression`);
  if (expression.status !== 'pass') {
    fail(`${label}.expression.status must be pass`, 'LEXICAL_SEMANTIC_REVIEW_INCOMPLETE');
  }
  if (requireSemanticEvidence) {
    if (expression.decision !== 'verified') {
      fail(`${label}.expression.decision must be verified by an authored semantic decision`, 'LEXICAL_SEMANTIC_REVIEW_INCOMPLETE');
    }
    requireString(expression.decision_source_id, `${label}.expression.decision_source_id`);
    if (expression.decision_source_id !== decisionSourceId) {
      fail(`${label}.expression.decision_source_id is not bound to the authored decision source`, 'LEXICAL_SEMANTIC_PROVENANCE');
    }
  }
  if (expectedRecordType !== undefined
    && (expression.expected_record_type !== expectedRecordType
      || expression.observed_record_type !== record.record_type
      || record.record_type !== expectedRecordType)) {
    fail(`${label}.expression does not bind the expression-unit classification`, 'LEXICAL_SEMANTIC_BOUNDARY_BLOCKER');
  }
  requireString(expression.rationale, `${label}.expression.rationale`);
  if (inventoryId !== undefined && !expression.rationale.includes(inventoryId)) {
    fail(`${label}.expression.rationale must bind ${inventoryId}`, 'LEXICAL_SEMANTIC_BINDING');
  }

  const relation = requireObject(review.relation, `${label}.relation`);
  if (relation.status !== 'pass') {
    fail(`${label}.relation.status must be pass`, 'LEXICAL_SEMANTIC_REVIEW_INCOMPLETE');
  }
  if (requireSemanticEvidence) {
    requireString(relation.decision_source_id, `${label}.relation.decision_source_id`);
    if (relation.decision_source_id !== decisionSourceId) {
      fail(`${label}.relation.decision_source_id is not bound to the authored decision source`, 'LEXICAL_SEMANTIC_PROVENANCE');
    }
  }
  const perSense = requireArray(relation.per_sense, `${label}.relation.per_sense`, { minItems: 1 });
  assert.deepEqual(
    perSense.map(({ sense_id: senseId }) => senseId),
    record.senses.map(({ id }) => id),
    `${label}.relation.per_sense must bind every reviewed sense`,
  );
  const relationBindings = [];
  let relationCount = 0;
  let noRelationRationaleCount = 0;
  let relationSenseCount = 0;
  let noRelationSenseCount = 0;
  for (const [senseIndex, senseDecision] of perSense.entries()) {
    const senseLabel = `${label}.relation.per_sense[${senseIndex}]`;
    requireObject(senseDecision, senseLabel);
    const sense = record.senses[senseIndex];
    const actualRelationCount = sense.relations?.length ?? 0;
    if (senseDecision.sense_id !== sense.id || senseDecision.relation_count !== actualRelationCount) {
      fail(`${senseLabel} does not bind the reviewed relation count`, 'LEXICAL_RELATION_BINDING');
    }
    if (requireSemanticEvidence) {
      const expectedDecision = actualRelationCount === 0 ? 'no-relations' : 'relations-reviewed';
      if (senseDecision.decision !== expectedDecision) {
        fail(`${senseLabel}.decision must be ${expectedDecision} from an authored relation decision`, 'LEXICAL_RELATION_BINDING');
      }
      requireString(senseDecision.decision_source_id, `${senseLabel}.decision_source_id`);
      if (senseDecision.decision_source_id !== decisionSourceId) {
        fail(`${senseLabel}.decision_source_id is not bound to the authored decision source`, 'LEXICAL_SEMANTIC_PROVENANCE');
      }
    }
    const relationIds = requireArray(senseDecision.relation_ids, `${senseLabel}.relation_ids`);
    if (relationIds.some((relationId) => typeof relationId !== 'string' || relationId.trim().length === 0)) {
      fail(`${senseLabel}.relation_ids must contain non-empty IDs`, 'LEXICAL_RELATION_BINDING');
    }
    if (actualRelationCount === 0) {
      if (relationIds.length !== 0) fail(`${senseLabel}.relation_ids must be empty`, 'LEXICAL_RELATION_BINDING');
      requireString(senseDecision.no_relation_rationale, `${senseLabel}.no_relation_rationale`);
      if (inventoryId !== undefined
        && (!senseDecision.no_relation_rationale.includes(inventoryId)
          || !senseDecision.no_relation_rationale.includes(sense.id))) {
        fail(`${senseLabel}.no_relation_rationale must bind ${inventoryId} and ${sense.id}`, 'LEXICAL_SEMANTIC_BINDING');
      }
      noRelationRationaleCount += 1;
      noRelationSenseCount += 1;
    } else {
      if (relationIds.length !== actualRelationCount || senseDecision.no_relation_rationale !== undefined) {
        fail(`${senseLabel} must bind every relation tuple without a no-relation rationale`, 'LEXICAL_RELATION_BINDING');
      }
      relationCount += actualRelationCount;
      relationSenseCount += 1;
      relationBindings.push({
        inventory_id: inventoryId,
        source_sense: sense.id,
        relation_ids: [...relationIds],
      });
    }
  }

  const selection = requireObject(review.selection, `${label}.selection`);
  const expectedSelectionStatus = semanticStatusForDecision(decision);
  if (selection.status !== expectedSelectionStatus) {
    fail(`${label}.selection.status must be ${expectedSelectionStatus}`, 'LEXICAL_SELECTION_BINDING');
  }
  if (!Number.isInteger(selection.rank) || selection.rank < 1 || selection.rank > catalogCount) {
    fail(`${label}.selection.rank must be within the candidate pool`, 'LEXICAL_SELECTION_BINDING');
  }
  if (!Number.isFinite(selection.score)) {
    fail(`${label}.selection.score must be finite`, 'LEXICAL_SELECTION_BINDING');
  }
  requireString(selection.rationale, `${label}.selection.rationale`);
  if (inventoryId !== undefined && !selection.rationale.includes(inventoryId)) {
    fail(`${label}.selection.rationale must bind ${inventoryId}`, 'LEXICAL_SELECTION_BINDING');
  }
  if (selectionRationaleTokens.length > 0
    && !selectionRationaleTokens.some((token) => selection.rationale.includes(token))) {
    fail(`${label}.selection.rationale must bind ${selectionRationaleTokens.join(' or ')}`, 'LEXICAL_SELECTION_BINDING');
  }
  if (requireIndependentDecisionEvidence) {
    validateIndependentDecisionEvidence(review, {
      decision,
      candidateRecord,
      reviewedRecord,
      inventoryId,
      label,
      decisionSourceId,
    });
  }

  return {
    selection_rank: selection.rank,
    selection_score: selection.score,
    sense_count: record.senses.length,
    relation_count: relationCount,
    relation_bindings: relationBindings,
    no_relation_rationale_count: noRelationRationaleCount,
    relation_sense_count: relationSenseCount,
    no_relation_sense_count: noRelationSenseCount,
    broad_gloss_count: record.senses.filter(({ gloss }) => hasBroadGlossConnector(gloss)).length,
  };
}

export const WRITER_DOMAIN_POLICY = Object.freeze({
  ruleset_version: LEXICAL_QUALITY_RULESET_VERSION,
  domain_axes: WRITER_DOMAIN_AXES,
  domain_terms: WRITER_DOMAIN_TERMS,
  common_domain_pairs: [...COMMON_DOMAIN_PAIRS].sort(),
  disjunctive_connector_behavior: 'block distinct writer domains unless same/common/contextual domain is observable',
});

export async function validateCanonicalLexicalQuality(
  directory = DEFAULT_CANONICAL_DIRECTORY,
) {
  const result = await readCanonicalRecords(directory);
  let topicEvidence;
  if (path.resolve(directory) === path.resolve(DEFAULT_CANONICAL_DIRECTORY)) {
    const {
      buildCanonicalSemanticAudit,
      buildSemanticTopicEvidence,
    } = await import('./semantic-audit.mjs');
    const { artifact } = await buildCanonicalSemanticAudit({ canonicalDirectory: directory });
    topicEvidence = buildSemanticTopicEvidence(result.records, artifact);
  }
  return auditCanonicalLexicalQuality(result.records, {
    scope: 'complete-canonical',
    throwOnError: true,
    topicEvidence,
  });
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  validateCanonicalLexicalQuality()
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}
