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
  taste: Object.freeze(['맛', '미각', '입맛']),
  smell: Object.freeze(['냄새', '향기', '후각']),
  sound: Object.freeze(['소리', '목소리', '음성', '울림', '청각']),
  visual: Object.freeze(['빛', '빛깔', '색', '윤곽', '시각']),
  tactile: Object.freeze(['표면', '감촉', '촉감', '질감']),
  affective: Object.freeze(['분위기', '감정', '기분', '정서', '마음']),
  body: Object.freeze(['목구멍', '몸', '신체', '피부']),
});

export const WRITER_DOMAIN_AXES = Object.freeze(Object.keys(WRITER_DOMAIN_TERMS));

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
// being used as a noun topic and the second token is a bare nominal stub.  Do
// not keep a list of historical bad strings here: the production invariant
// must describe the shape of the defect and remain useful for future words.
const MALFORMED_TOPIC_FRAGMENT_PATTERN = /^(?<topic>[^\s]+)(?<particle>은|는)\s+(?<predicate>[^\s]+)$/u;
const VALID_PREDICATE_ENDING_PATTERN = /다$/u;
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

function isLikelyAdnominalModifier(token) {
  if (typeof token !== 'string' || token.length < 2) return false;
  if (token.endsWith('는')) {
    // `-는` is the productive verbal adnominal ending.  A bare `X는 Y`
    // shape cannot be rejected safely without a Korean POS lexicon: the same
    // surface form can be a valid modifier (`달리는 사람`) or a topic.
    return true;
  }
  if (!token.endsWith('은')) return false;

  // `-은` is also an adjective/verb adnominal ending.  A one-syllable stem
  // covers productive forms such as `작은`, `넓은`, and `먹은` without
  // maintaining a finite list of known modifiers.  Longer `X은` tokens are
  // conservatively treated as topic-shaped unless their predicate is a full
  // verb/adjective form (`...다`), which keeps the invariant fail-closed for
  // the malformed two-token fragments it is meant to catch.
  return [...token.slice(0, -1)].length === 1;
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

function nearestDomainAxis(text, direction) {
  const matches = [];
  for (const [axis, terms] of Object.entries(WRITER_DOMAIN_TERMS)) {
    for (const term of terms) {
      let from = 0;
      while (true) {
        const index = text.indexOf(term, from);
        if (index < 0) break;
        matches.push({ axis, term, index, end: index + term.length });
        from = index + term.length;
      }
    }
  }
  if (matches.length === 0) return undefined;
  const longestMatches = matches.filter((candidate) => !matches.some((other) => (
    other.term.length > candidate.term.length
      && other.index <= candidate.index
      && other.end >= candidate.end
  )));
  return direction === 'left'
    ? longestMatches.sort((left, right) => right.index - left.index)[0]
    : longestMatches.sort((left, right) => left.index - right.index)[0];
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
  const matches = [];
  for (const [axis, terms] of Object.entries(WRITER_DOMAIN_TERMS)) {
    for (const term of terms) {
      let from = 0;
      while (true) {
        const index = gloss.indexOf(term, from);
        if (index < 0) break;
        matches.push({ axis, term, index, end: index + term.length });
        from = index + term.length;
      }
    }
  }
  const longestMatches = matches.filter((candidate) => !matches.some((other) => (
    other.term.length > candidate.term.length
      && other.index <= candidate.index
      && other.end >= candidate.end
  )));
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

export function inspectGlossQuality(gloss) {
  if (typeof gloss !== 'string' || gloss.trim().length === 0) {
    return {
      token_count: 0,
      generic_template: false,
      malformed_fragment: false,
      malformed_structure: false,
    };
  }
  const trimmed = gloss.trim();
  const topicFragment = MALFORMED_TOPIC_FRAGMENT_PATTERN.exec(trimmed);
  const topicToken = topicFragment?.groups.topic
    ? `${topicFragment.groups.topic}${topicFragment.groups.particle}`
    : undefined;
  const malformedStructure = topicFragment !== null
    && topicFragment.groups.particle === '은'
    && !isLikelyAdnominalModifier(topicToken)
    && !VALID_PREDICATE_ENDING_PATTERN.test(topicFragment.groups.predicate);
  return {
    token_count: trimmed.split(/\s+/u).length,
    generic_template: GENERIC_GLOSS_TEMPLATE_PATTERN.test(gloss),
    malformed_fragment: malformedStructure,
    malformed_structure: malformedStructure,
  };
}

function recordQualityFindings(record, {
  label = 'record',
  mode = 'canonical',
  rejectAnyBroadConnector = false,
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
    const glossQuality = inspectGlossQuality(sense.gloss);
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
  const findings = recordQualityFindings(record, { label, mode, rejectAnyBroadConnector });
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
 * Run the complete canonical audit.  The returned report is deterministic and
 * can be embedded in a batch verification artifact.  No batch ID, record ID,
 * or historical allowlist can suppress a finding.
 */
export function auditCanonicalLexicalQuality(
  recordInfos,
  { scope = 'complete-canonical', throwOnError = true } = {},
) {
  const normalized = recordInfos.map(recordOf);
  const findings = [];
  const connectorCounts = Object.fromEntries(CONNECTORS.map((connector) => [connector, 0]));
  const classificationCounts = {};
  let senseCount = 0;
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
  return auditCanonicalLexicalQuality(result.records, {
    scope: 'complete-canonical',
    throwOnError: true,
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
