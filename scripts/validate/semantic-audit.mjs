import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from './canonical-jsonl.mjs';
import {
  LEXICAL_QUALITY_RULESET_VERSION,
  inspectGlossConnectors,
  inspectWriterDomainEvidence,
} from './lexical-quality.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export const SEMANTIC_AUDIT_SCHEMA_VERSION = '2';
export const SEMANTIC_COVERAGE_CONTRACT_VERSION = 'lexical-semantic-coverage-v1';
export const SEMANTIC_REVIEW_CONTRACT_VERSION = 'lexical-semantic-review-v2';
export const SEMANTIC_AUDIT_CONTRACT_VERSION = 'lexical-semantic-audit-v3';
export const SEMANTIC_BOUNDARY_RULESET_VERSION = 'semantic-boundary-v2';
export const SEMANTIC_BOUNDARY_DECISIONS = Object.freeze([
  'retain',
  'split',
  'merge',
  'rewrite',
  'fail',
]);
export const SEMANTIC_BOUNDARY_RELATIONSHIPS = Object.freeze([
  'distinct',
  'duplicate',
  'nested',
  'usage-variant',
]);
export const SEMANTIC_BOUNDARY_METHOD = 'gloss-and-usage-pairwise-v2';
export const DEFAULT_SEMANTIC_REVIEW_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/validation/canonical-semantic-review.json',
);
export const DEFAULT_SEMANTIC_COVERAGE_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/validation/canonical-semantic-coverage.json',
);
export const DEFAULT_SEMANTIC_AUDIT_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/validation/canonical-semantic-audit.json',
);

export class SemanticAuditError extends Error {
  constructor(message, code = 'SEMANTIC_AUDIT_ERROR') {
    super(message);
    this.name = 'SemanticAuditError';
    this.code = code;
  }
}

function fail(message, code = 'SEMANTIC_AUDIT_ERROR') {
  throw new SemanticAuditError(message, code);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`, 'SEMANTIC_AUDIT_SHAPE');
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`, 'SEMANTIC_AUDIT_SHAPE');
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`, 'SEMANTIC_AUDIT_VALUE');
  }
  return value;
}

function requireDigest(value, label) {
  requireString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    fail(`${label} must be a SHA-256 digest`, 'SEMANTIC_AUDIT_VALUE');
  }
  return value;
}

function requireEnum(value, values, label) {
  if (!values.includes(value)) {
    fail(`${label} must be one of ${values.join(', ')}`, 'SEMANTIC_AUDIT_VALUE');
  }
  return value;
}

function recordOf(recordInfo) {
  return recordInfo?.record ?? recordInfo;
}

function compareCanonicalRecordIds(leftId, rightId) {
  const left = /^([a-z]+)([0-9]+)$/u.exec(leftId);
  const right = /^([a-z]+)([0-9]+)$/u.exec(rightId);
  if (left && right) {
    const prefixOrder = left[1].localeCompare(right[1]);
    if (prefixOrder !== 0) return prefixOrder;
    const numberOrder = Number(left[2]) - Number(right[2]);
    if (numberOrder !== 0) return numberOrder;
  }
  return leftId.localeCompare(rightId);
}

/**
 * Use record identity order for source binding. Directory/file enumeration is
 * not a stable append order: a newly named JSONL file can sort between older
 * files without changing any record value.
 */
export function orderCanonicalRecordInfos(recordInfos) {
  return recordInfos
    .map((recordInfo, index) => ({ recordInfo, index }))
    .sort((left, right) => {
      const idOrder = compareCanonicalRecordIds(
        recordOf(left.recordInfo).id,
        recordOf(right.recordInfo).id,
      );
      return idOrder || left.index - right.index;
    })
    .map(({ recordInfo }) => recordInfo);
}

export function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/**
 * Hash the ordered canonical record values rather than a batch or file name.
 * A moved file or a new batch ID cannot make stale semantic evidence valid.
 */
export function canonicalRecordsSha256(recordInfos) {
  return sha256Json(orderCanonicalRecordInfos(recordInfos).map(recordOf));
}

function relationFingerprint(sourceSenseId, relation) {
  return sha256Json({
    source_sense: sourceSenseId,
    target: relation.target,
    target_sense: relation.target_sense ?? null,
    type: relation.type,
    note: relation.note,
  });
}

function senseRelationCoverage(sense) {
  const relations = sense.relations ?? [];
  return {
    relation_count: relations.length,
    relation_sha256: sha256Json({
      source_sense: sense.id,
      relations,
    }),
    relation_fingerprints: relations.map((relation) => relationFingerprint(sense.id, relation)),
  };
}

const BOUNDARY_TOKEN_SUFFIX_PATTERN = /(?:으로|에서|에게|부터|까지|보다|처럼|만큼|은|는|이|가|을|를|의|에|로|와|과|도|만)$/u;

function boundaryTokens(gloss) {
  if (typeof gloss !== 'string') return [];
  return gloss
    .normalize('NFC')
    .replace(/[.,!?·:;()\[\]{}"“”‘’]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean)
    .map((token) => token.replace(BOUNDARY_TOKEN_SUFFIX_PATTERN, ''))
    .filter((token) => token.length > 0);
}

function compactGloss(gloss) {
  return typeof gloss === 'string'
    ? gloss.normalize('NFC').replace(/[\s.,!?·:;()\[\]{}"“”‘’]/gu, '')
    : '';
}

/**
 * Inspect sense pairs using the gloss content itself.  This is deliberately
 * independent of the number of senses currently stored on a record: a
 * duplicate or nested pair remains a finding even when a review claims that
 * the existing sense set is already correct.
 */
export function inspectSenseBoundaryPairs(record) {
  const senses = Array.isArray(record?.senses) ? record.senses : [];
  const pairs = [];
  for (let leftIndex = 0; leftIndex < senses.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < senses.length; rightIndex += 1) {
      const left = senses[leftIndex];
      const right = senses[rightIndex];
      const leftTokens = boundaryTokens(left.gloss);
      const rightTokens = boundaryTokens(right.gloss);
      const leftSet = new Set(leftTokens);
      const rightSet = new Set(rightTokens);
      const sharedTokens = [...leftSet].filter((token) => rightSet.has(token)).sort();
      const leftDistinctiveTokens = [...leftSet].filter((token) => !rightSet.has(token)).sort();
      const rightDistinctiveTokens = [...rightSet].filter((token) => !leftSet.has(token)).sort();
      let relationship = 'distinct';
      if (compactGloss(left.gloss) === compactGloss(right.gloss)) {
        relationship = 'duplicate';
      } else {
        const smallerSize = Math.min(leftSet.size, rightSet.size);
        if (smallerSize >= 2 && sharedTokens.length === smallerSize) relationship = 'nested';
      }
      pairs.push({
        left_sense_id: left.id,
        right_sense_id: right.id,
        relationship,
        shared_tokens: sharedTokens,
        left_distinctive_tokens: leftDistinctiveTokens,
        right_distinctive_tokens: rightDistinctiveTokens,
      });
    }
  }
  return pairs;
}

function buildSenseCoverage(record, sense) {
  const domainEvidence = inspectWriterDomainEvidence(sense.gloss);
  return {
    sense_id: sense.id,
    sense_sha256: sha256Json(sense),
    content: {
      gloss_sha256: sha256Json(sense.gloss),
      observed_domain_axes: domainEvidence.axes,
      domain_evidence: domainEvidence.matches,
      connector_observations: inspectGlossConnectors(sense.gloss),
      pos: sense.pos,
      record_type: record.record_type,
      ...senseRelationCoverage(sense),
    },
  };
}

/**
 * Create only deterministic source coverage. This function intentionally does
 * not invent semantic/editorial decisions, pass statuses, boundary
 * classifications, or no-relation rationales.
 */
export function buildSemanticCoverageArtifact(
  recordInfos,
  { artifactId = 'canonical-semantic-coverage' } = {},
) {
  const records = orderCanonicalRecordInfos(recordInfos).map(recordOf);
  return {
    schema_version: SEMANTIC_AUDIT_SCHEMA_VERSION,
    contract_version: SEMANTIC_COVERAGE_CONTRACT_VERSION,
    artifact_id: artifactId,
    scope: 'complete-canonical',
    lexical_quality_ruleset_version: LEXICAL_QUALITY_RULESET_VERSION,
    source: {
      kind: 'canonical-jsonl-record-values',
      canonical_records_sha256: canonicalRecordsSha256(recordInfos),
    },
    record_count: records.length,
    sense_count: records.reduce((sum, record) => sum + record.senses.length, 0),
    records: records.map((record) => ({
      record_id: record.id,
      record_sha256: sha256Json(record),
      lemma: record.lemma,
      record_type: record.record_type,
      role: record.role,
      sense_coverage: record.senses.map((sense) => buildSenseCoverage(record, sense)),
    })),
  };
}

/**
 * Package deterministic coverage with a separately authored decision
 * artifact. The decision artifact is required from the caller and is never
 * synthesized from canonical records here.
 */
export function assembleSemanticAuditArtifact(
  recordInfos,
  semanticReview,
  { artifactId = 'canonical-semantic-audit' } = {},
) {
  requireObject(semanticReview, 'semantic review artifact');
  const canonicalDigest = canonicalRecordsSha256(recordInfos);
  if (semanticReview.source?.canonical_records_sha256 !== canonicalDigest) {
    fail('semantic review artifact is not bound to the supplied canonical records', 'SEMANTIC_AUDIT_SOURCE_MISMATCH');
  }
  const coverage = buildSemanticCoverageArtifact(recordInfos);
  return {
    schema_version: SEMANTIC_AUDIT_SCHEMA_VERSION,
    contract_version: SEMANTIC_AUDIT_CONTRACT_VERSION,
    artifact_id: artifactId,
    scope: 'complete-canonical',
    lexical_quality_ruleset_version: LEXICAL_QUALITY_RULESET_VERSION,
    source: {
      kind: 'canonical-jsonl-record-values',
      canonical_records_sha256: canonicalDigest,
    },
    record_count: coverage.record_count,
    sense_count: coverage.sense_count,
    coverage,
    review: semanticReview,
  };
}

function assertExact(actual, expected, label, code = 'SEMANTIC_AUDIT_BINDING') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} does not match the canonical source`, code);
  }
}

function validateCoverageSense(record, sense, coverage, senseIndex, label) {
  requireObject(coverage, label);
  if (coverage.sense_id !== sense.id) fail(`${label}.sense_id is not bound`, 'SEMANTIC_AUDIT_BINDING');
  requireDigest(coverage.sense_sha256, `${label}.sense_sha256`);
  if (coverage.sense_sha256 !== sha256Json(sense)) {
    fail(`${label}.sense_sha256 does not match the canonical sense`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }

  const content = requireObject(coverage.content, `${label}.content`);
  requireDigest(content.gloss_sha256, `${label}.content.gloss_sha256`);
  if (content.gloss_sha256 !== sha256Json(sense.gloss)) {
    fail(`${label}.content.gloss_sha256 does not match the canonical gloss`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  const domainEvidence = inspectWriterDomainEvidence(sense.gloss);
  assertExact(
    content.observed_domain_axes,
    domainEvidence.axes,
    `${label}.content.observed_domain_axes`,
    'SEMANTIC_AUDIT_CONTENT_MISMATCH',
  );
  assertExact(
    content.domain_evidence,
    domainEvidence.matches,
    `${label}.content.domain_evidence`,
    'SEMANTIC_AUDIT_CONTENT_MISMATCH',
  );
  assertExact(
    content.connector_observations,
    inspectGlossConnectors(sense.gloss),
    `${label}.content.connector_observations`,
    'SEMANTIC_AUDIT_CONTENT_MISMATCH',
  );
  if (content.pos !== sense.pos || content.record_type !== record.record_type) {
    fail(`${label}.content POS or record type does not match the canonical source`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  const expectedRelations = senseRelationCoverage(sense);
  if (content.relation_count !== expectedRelations.relation_count
    || content.relation_sha256 !== expectedRelations.relation_sha256) {
    fail(`${label}.content relation coverage does not match canonical content`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  assertExact(
    content.relation_fingerprints,
    expectedRelations.relation_fingerprints,
    `${label}.content.relation_fingerprints`,
    'SEMANTIC_AUDIT_CONTENT_MISMATCH',
  );
  if (senseIndex < 0) fail(`${label} has an invalid sense index`, 'SEMANTIC_AUDIT_SCOPE');
}

function validateSemanticCoverageArtifact(recordInfos, artifact, label) {
  requireObject(artifact, label);
  if (artifact.schema_version !== SEMANTIC_AUDIT_SCHEMA_VERSION
    || artifact.contract_version !== SEMANTIC_COVERAGE_CONTRACT_VERSION) {
    fail(`${label} contract version is unsupported`, 'SEMANTIC_AUDIT_SCHEMA');
  }
  if (artifact.scope !== 'complete-canonical') fail(`${label}.scope must be complete-canonical`, 'SEMANTIC_AUDIT_SCOPE');
  if (artifact.lexical_quality_ruleset_version !== LEXICAL_QUALITY_RULESET_VERSION) {
    fail(`${label}.lexical_quality_ruleset_version is unsupported`, 'SEMANTIC_AUDIT_SCHEMA');
  }
  const source = requireObject(artifact.source, `${label}.source`);
  if (source.kind !== 'canonical-jsonl-record-values') fail(`${label}.source.kind is unsupported`, 'SEMANTIC_AUDIT_PROVENANCE');
  requireDigest(source.canonical_records_sha256, `${label}.source.canonical_records_sha256`);
  const expectedCanonicalDigest = canonicalRecordsSha256(recordInfos);
  if (source.canonical_records_sha256 !== expectedCanonicalDigest) {
    fail(`${label}.source.canonical_records_sha256 does not match the complete canonical input`, 'SEMANTIC_AUDIT_SOURCE_MISMATCH');
  }

  const records = orderCanonicalRecordInfos(recordInfos).map(recordOf);
  if (artifact.record_count !== records.length) fail(`${label}.record_count does not cover the complete canonical input`, 'SEMANTIC_AUDIT_SCOPE');
  const expectedSenseCount = records.reduce((sum, record) => sum + record.senses.length, 0);
  if (artifact.sense_count !== expectedSenseCount) fail(`${label}.sense_count does not cover every canonical sense`, 'SEMANTIC_AUDIT_SCOPE');
  const auditedRecords = requireArray(artifact.records, `${label}.records`);
  if (auditedRecords.length !== records.length) fail(`${label}.records must cover every canonical record`, 'SEMANTIC_AUDIT_SCOPE');

  const recordIds = new Set();
  const auditedById = new Map();
  for (const [recordIndex, auditedValue] of auditedRecords.entries()) {
    const recordLabel = `${label}.records[${recordIndex}]`;
    const audited = requireObject(auditedValue, recordLabel);
    if (recordIds.has(audited.record_id)) fail(`${label} contains duplicate record ${audited.record_id}`, 'SEMANTIC_AUDIT_SCOPE');
    recordIds.add(audited.record_id);
    auditedById.set(audited.record_id, { audited, recordLabel });
  }
  for (const record of records) {
    const auditedEntry = auditedById.get(record.id);
    if (!auditedEntry) fail(`${label} is missing record ${record.id}`, 'SEMANTIC_AUDIT_SCOPE');
    const { audited, recordLabel } = auditedEntry;
    requireDigest(audited.record_sha256, `${recordLabel}.record_sha256`);
    if (audited.record_sha256 !== sha256Json(record)) fail(`${recordLabel}.record_sha256 does not match canonical content`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
    if (audited.lemma !== record.lemma
      || audited.record_type !== record.record_type
      || audited.role !== record.role) {
      fail(`${recordLabel} record identity facts drifted`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
    }
    const senseCoverage = requireArray(audited.sense_coverage, `${recordLabel}.sense_coverage`);
    if (senseCoverage.length !== record.senses.length) fail(`${recordLabel}.sense_coverage must cover every sense`, 'SEMANTIC_AUDIT_SCOPE');
    for (const [senseIndex, sense] of record.senses.entries()) {
      validateCoverageSense(
        record,
        sense,
        senseCoverage[senseIndex],
        senseIndex,
        `${recordLabel}.sense_coverage[${senseIndex}]`,
      );
    }
  }

  return {
    contract_version: artifact.contract_version,
    scope: artifact.scope,
    canonical_records_sha256: expectedCanonicalDigest,
    record_count: records.length,
    sense_count: expectedSenseCount,
    covered_record_count: records.length,
    covered_sense_count: expectedSenseCount,
    coverage_complete: true,
  };
}

function boundaryActionForDecision(decision) {
  return decision;
}

function boundarySenseDecisionForRecord(decision, classification) {
  if (decision === 'retain') return 'atomic';
  if (decision === 'split') return classification === 'coordinated' ? 'coordinated' : 'split';
  return decision;
}

function validateBoundaryReview(record, boundary, label) {
  requireObject(boundary, label);
  if (boundary.status !== 'pass') {
    fail(`${label}.status must be pass after boundary findings are resolved`, 'SEMANTIC_AUDIT_INCOMPLETE');
  }
  requireString(boundary.review_id, `${label}.review_id`);
  requireString(boundary.method, `${label}.method`);
  if (boundary.method !== SEMANTIC_BOUNDARY_METHOD) {
    fail(`${label}.method must use the independent pairwise boundary method`, 'SEMANTIC_AUDIT_PROVENANCE');
  }
  const independence = requireObject(boundary.independence, `${label}.independence`);
  if (independence.independent_of_sense_count !== true) {
    fail(`${label}.independence must not derive its decision from the current sense count`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
  }
  requireString(independence.source, `${label}.independence.source`);
  const decision = requireEnum(boundary.decision, SEMANTIC_BOUNDARY_DECISIONS, `${label}.decision`);
  if (!['retain', 'split'].includes(decision)) {
    fail(`${label}.decision ${decision} must be resolved before a complete audit can pass`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
  }
  const classification = requireEnum(
    boundary.classification,
    ['atomic', 'separated', 'coordinated'],
    `${label}.classification`,
  );
  const reviewedSenseIds = requireArray(boundary.reviewed_sense_ids, `${label}.reviewed_sense_ids`);
  assertExact(
    reviewedSenseIds,
    record.senses.map(({ id }) => id),
    `${label}.reviewed_sense_ids`,
  );
  const evidence = requireArray(boundary.evidence, `${label}.evidence`);
  if (evidence.length !== record.senses.length) {
    fail(`${label}.evidence must contain independent evidence for every current sense`, 'SEMANTIC_AUDIT_SCOPE');
  }
  const evidenceSenseIds = new Set();
  for (const [index, item] of evidence.entries()) {
    const evidenceLabel = `${label}.evidence[${index}]`;
    requireObject(item, evidenceLabel);
    if (evidenceSenseIds.has(item.sense_id)) fail(`${label}.evidence contains duplicate sense ${item.sense_id}`, 'SEMANTIC_AUDIT_SCOPE');
    evidenceSenseIds.add(item.sense_id);
    const sense = record.senses.find(({ id }) => id === item.sense_id);
    if (!sense) fail(`${evidenceLabel}.sense_id is not in the current record`, 'SEMANTIC_AUDIT_BINDING');
    requireDigest(item.gloss_sha256, `${evidenceLabel}.gloss_sha256`);
    if (item.gloss_sha256 !== sha256Json(sense.gloss)) {
      fail(`${evidenceLabel}.gloss_sha256 does not bind the current gloss`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
    }
    requireString(item.evidence_basis, `${evidenceLabel}.evidence_basis`);
    if (item.evidence_basis.toLowerCase().includes('sense count')) {
      fail(`${evidenceLabel}.evidence_basis cannot use the current sense count as semantic evidence`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
    }
    requireString(item.rationale, `${evidenceLabel}.rationale`);
    if (!item.rationale.includes(record.id)
      || !item.rationale.includes(item.sense_id)
      || !item.rationale.includes(item.gloss_sha256.slice(0, 12))) {
      fail(`${evidenceLabel}.rationale must cite record, sense, and gloss evidence`, 'SEMANTIC_AUDIT_GENERIC_EVIDENCE');
    }
  }
  const expectedPairs = inspectSenseBoundaryPairs(record);
  const pairwise = requireArray(boundary.pairwise, `${label}.pairwise`);
  if (pairwise.length !== expectedPairs.length) {
    fail(`${label}.pairwise must review every sense pair`, 'SEMANTIC_AUDIT_SCOPE');
  }
  const pairKeys = new Set();
  for (const [index, item] of pairwise.entries()) {
    const pairLabel = `${label}.pairwise[${index}]`;
    requireObject(item, pairLabel);
    const key = `${item.left_sense_id}:${item.right_sense_id}`;
    if (pairKeys.has(key)) fail(`${pairLabel} is duplicated`, 'SEMANTIC_AUDIT_SCOPE');
    pairKeys.add(key);
    const expected = expectedPairs.find((candidate) => (
      candidate.left_sense_id === item.left_sense_id
      && candidate.right_sense_id === item.right_sense_id
    ));
    if (!expected) fail(`${pairLabel} is not bound to the canonical sense pair`, 'SEMANTIC_AUDIT_BINDING');
    requireEnum(item.relationship, SEMANTIC_BOUNDARY_RELATIONSHIPS, `${pairLabel}.relationship`);
    if (expected.relationship !== 'distinct') {
      fail(
        `${pairLabel} contains an unresolved ${expected.relationship} sense pair; merge, rewrite, or fail before admission`,
        'SEMANTIC_AUDIT_BOUNDARY_BLOCKER',
      );
    }
    if (item.relationship !== 'distinct') {
      fail(`${pairLabel}.relationship must be distinct for a resolved canonical sense set`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
    }
    assertExact(item.shared_tokens, expected.shared_tokens, `${pairLabel}.shared_tokens`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
    assertExact(
      item.left_distinctive_tokens,
      expected.left_distinctive_tokens,
      `${pairLabel}.left_distinctive_tokens`,
      'SEMANTIC_AUDIT_CONTENT_MISMATCH',
    );
    assertExact(
      item.right_distinctive_tokens,
      expected.right_distinctive_tokens,
      `${pairLabel}.right_distinctive_tokens`,
      'SEMANTIC_AUDIT_CONTENT_MISMATCH',
    );
    requireString(item.rationale, `${pairLabel}.rationale`);
    if (!item.rationale.includes(record.id)
      || !item.rationale.includes(item.left_sense_id)
      || !item.rationale.includes(item.right_sense_id)) {
      fail(`${pairLabel}.rationale must cite the reviewed sense pair`, 'SEMANTIC_AUDIT_GENERIC_EVIDENCE');
    }
  }
  if ((expectedPairs.length === 0 && decision !== 'retain')
    || (expectedPairs.length > 0 && decision !== 'split')) {
    fail(`${label}.decision is not the explicit resolved outcome for the reviewed pair evidence`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
  }
  if (decision === 'retain' && classification !== 'atomic') {
    fail(`${label}.classification must be atomic for a retained single-sense outcome`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
  }
  if (decision === 'split' && !['separated', 'coordinated'].includes(classification)) {
    fail(`${label}.classification must explain a retained multi-sense outcome`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
  }
  requireString(boundary.rationale, `${label}.rationale`);
  if (!boundary.rationale.includes(record.id)) {
    fail(`${label}.rationale must bind the reviewed record`, 'SEMANTIC_AUDIT_BINDING');
  }
  return {
    review_id: boundary.review_id,
    decision,
    classification,
    expectedPairs,
  };
}

function validateSemanticReviewSense(record, sense, review, senseIndex, label, boundaryReview) {
  requireObject(review, label);
  if (review.sense_id !== sense.id) fail(`${label}.sense_id is not bound`, 'SEMANTIC_AUDIT_BINDING');
  requireDigest(review.sense_sha256, `${label}.sense_sha256`);
  if (review.sense_sha256 !== sha256Json(sense)) {
    fail(`${label}.sense_sha256 does not match the canonical sense`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }

  const boundary = requireObject(review.sense_boundary, `${label}.sense_boundary`);
  if (boundary.status !== 'pass') fail(`${label}.sense_boundary.status must be pass`, 'SEMANTIC_AUDIT_INCOMPLETE');
  requireEnum(boundary.action, SEMANTIC_BOUNDARY_DECISIONS, `${label}.sense_boundary.action`);
  requireEnum(
    boundary.classification,
    ['atomic', 'separated', 'coordinated', 'overlapping', 'nested', 'usage-variant', 'unresolved'],
    `${label}.sense_boundary.classification`,
  );
  requireEnum(
    boundary.boundary_decision,
    ['atomic', 'split', 'coordinated', 'merge', 'rewrite', 'fail'],
    `${label}.sense_boundary.boundary_decision`,
  );
  if (boundary.action !== boundaryActionForDecision(boundaryReview.decision)) {
    fail(`${label}.sense_boundary.action does not match the record-level boundary decision`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
  }
  if (boundary.classification !== boundaryReview.classification) {
    fail(`${label}.sense_boundary.classification does not match the record-level boundary review`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
  }
  if (boundary.boundary_decision !== boundarySenseDecisionForRecord(boundaryReview.decision, boundaryReview.classification)) {
    fail(`${label}.sense_boundary.boundary_decision does not match the record-level boundary review`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
  }
  if (boundary.boundary_review_id !== boundaryReview.review_id) {
    fail(`${label}.sense_boundary.boundary_review_id is not bound to the record review`, 'SEMANTIC_AUDIT_BINDING');
  }
  assertExact(
    boundary.reviewed_sense_ids,
    record.senses.map(({ id }) => id),
    `${label}.sense_boundary.reviewed_sense_ids`,
  );
  requireString(boundary.rationale, `${label}.sense_boundary.rationale`);
  if (!boundary.rationale.includes(record.id) || !boundary.rationale.includes(sense.id)) {
    fail(`${label}.sense_boundary.rationale must bind the record and sense`, 'SEMANTIC_AUDIT_BINDING');
  }

  const pos = requireObject(review.pos, `${label}.pos`);
  if (pos.status !== 'pass' || pos.observed_pos !== sense.pos) {
    fail(`${label}.pos does not bind the canonical POS`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  requireString(pos.rationale, `${label}.pos.rationale`);

  const expression = requireObject(review.expression, `${label}.expression`);
  if (expression.status !== 'pass'
    || expression.expected_record_type !== record.record_type
    || expression.observed_record_type !== record.record_type) {
    fail(`${label}.expression does not bind the canonical record type`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  requireString(expression.rationale, `${label}.expression.rationale`);

  const relation = requireObject(review.relation, `${label}.relation`);
  if (relation.status !== 'pass') fail(`${label}.relation.status must be pass`, 'SEMANTIC_AUDIT_INCOMPLETE');
  const expectedRelations = senseRelationCoverage(sense);
  if (relation.decision !== (expectedRelations.relation_count === 0 ? 'no-relations' : 'relations-reviewed')) {
    fail(`${label}.relation.decision does not explicitly cover the canonical relation outcome`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  if (relation.relation_count !== expectedRelations.relation_count) {
    fail(`${label}.relation.relation_count does not bind canonical content`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  requireDigest(relation.relation_sha256, `${label}.relation.relation_sha256`);
  if (relation.relation_sha256 !== expectedRelations.relation_sha256) {
    fail(`${label}.relation.relation_sha256 does not bind canonical content`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  assertExact(
    relation.relation_fingerprints,
    expectedRelations.relation_fingerprints,
    `${label}.relation.relation_fingerprints`,
    'SEMANTIC_AUDIT_CONTENT_MISMATCH',
  );
  requireString(relation.rationale, `${label}.relation.rationale`);
  if (expectedRelations.relation_count === 0) {
    requireString(relation.no_relation_rationale, `${label}.relation.no_relation_rationale`);
    if (!relation.no_relation_rationale.includes(record.id)
      && !relation.no_relation_rationale.includes(sense.id)) {
      fail(`${label}.relation.no_relation_rationale must bind the canonical sense`, 'SEMANTIC_AUDIT_BINDING');
    }
  } else if (Object.hasOwn(relation, 'no_relation_rationale')) {
    fail(`${label}.relation must not claim no relations when tuples exist`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }

  if (senseIndex < 0) fail(`${label} has an invalid sense index`, 'SEMANTIC_AUDIT_SCOPE');

  const basis = requireObject(review.review_basis, `${label}.review_basis`);
  if (basis.record_id !== record.id || basis.sense_id !== sense.id || basis.lemma !== record.lemma) {
    fail(`${label}.review_basis identity is not bound to the canonical sense`, 'SEMANTIC_AUDIT_BINDING');
  }
  requireDigest(basis.gloss_sha256, `${label}.review_basis.gloss_sha256`);
  if (basis.gloss_sha256 !== sha256Json(sense.gloss)) {
    fail(`${label}.review_basis.gloss_sha256 does not bind the canonical gloss`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  if (basis.pos !== sense.pos || basis.record_type !== record.record_type) {
    fail(`${label}.review_basis POS or record type does not bind the canonical source`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  const basisDomainEvidence = inspectWriterDomainEvidence(sense.gloss);
  assertExact(
    basis.observed_domain_axes,
    basisDomainEvidence.axes,
    `${label}.review_basis.observed_domain_axes`,
    'SEMANTIC_AUDIT_CONTENT_MISMATCH',
  );
  const basisRelations = senseRelationCoverage(sense);
  if (basis.relation_count !== basisRelations.relation_count) {
    fail(`${label}.review_basis.relation_count does not bind canonical relations`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  requireString(basis.rationale, `${label}.review_basis.rationale`);
  const glossDigestPrefix = basis.gloss_sha256.slice(0, 12);
  if (!basis.rationale.includes(record.id)
    || !basis.rationale.includes(sense.id)
    || !basis.rationale.includes(glossDigestPrefix)) {
    fail(
      `${label}.review_basis.rationale must cite the record, sense, and reviewed gloss digest`,
      'SEMANTIC_AUDIT_GENERIC_EVIDENCE',
    );
  }
}

function validateSemanticReviewPass(recordInfos, artifact, label) {
  const pass = requireObject(artifact.review_pass, `${label}.review_pass`);
  requireString(pass.id, `${label}.review_pass.id`);
  if (pass.status !== 'complete') fail(`${label}.review_pass.status must be complete`, 'SEMANTIC_AUDIT_INCOMPLETE');
  requireString(pass.reviewer, `${label}.review_pass.reviewer`);
  if (pass.review_mode !== artifact.review_mode) {
    fail(`${label}.review_pass.review_mode must bind artifact.review_mode`, 'SEMANTIC_AUDIT_PROVENANCE');
  }
  requireString(pass.method, `${label}.review_pass.method`);
  if (pass.ruleset_version !== LEXICAL_QUALITY_RULESET_VERSION) {
    fail(`${label}.review_pass.ruleset_version is unsupported`, 'SEMANTIC_AUDIT_SCHEMA');
  }
  if (pass.boundary_ruleset_version !== SEMANTIC_BOUNDARY_RULESET_VERSION) {
    fail(`${label}.review_pass.boundary_ruleset_version is unsupported`, 'SEMANTIC_AUDIT_SCHEMA');
  }
  const records = recordInfos.map(recordOf);
  const senseCount = records.reduce((sum, record) => sum + record.senses.length, 0);
  if (pass.record_count !== records.length || pass.sense_count !== senseCount) {
    fail(`${label}.review_pass counts do not cover the complete canonical input`, 'SEMANTIC_AUDIT_SCOPE');
  }
  if (pass.open_finding_count !== 0) {
    fail(`${label}.review_pass cannot be complete with open findings`, 'SEMANTIC_AUDIT_INCOMPLETE');
  }
  const history = requireArray(pass.correction_history, `${label}.review_pass.correction_history`);
  if (pass.correction_count !== history.length) {
    fail(`${label}.review_pass.correction_count does not match correction_history`, 'SEMANTIC_AUDIT_SCOPE');
  }
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const correctionIds = new Set();
  const correctionsById = new Map();
  for (const [index, correction] of history.entries()) {
    const correctionLabel = `${label}.review_pass.correction_history[${index}]`;
    requireObject(correction, correctionLabel);
    requireString(correction.record_id, `${correctionLabel}.record_id`);
    if (correctionIds.has(correction.record_id)) {
      fail(`${correctionLabel}.record_id is duplicated`, 'SEMANTIC_AUDIT_SCOPE');
    }
    correctionIds.add(correction.record_id);
    correctionsById.set(correction.record_id, correction);
    const record = recordsById.get(correction.record_id);
    if (!record) fail(`${correctionLabel}.record_id is not canonical`, 'SEMANTIC_AUDIT_SCOPE');
    requireDigest(correction.before_record_sha256, `${correctionLabel}.before_record_sha256`);
    requireDigest(correction.after_record_sha256, `${correctionLabel}.after_record_sha256`);
    if (correction.after_record_sha256 !== sha256Json(record)
      || correction.before_record_sha256 === correction.after_record_sha256) {
      fail(`${correctionLabel} is not bound to the repaired canonical record`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
    }
    requireString(correction.source_revision, `${correctionLabel}.source_revision`);
    requireString(correction.rationale, `${correctionLabel}.rationale`);
    requireEnum(
      correction.boundary_decision,
      SEMANTIC_BOUNDARY_DECISIONS,
      `${correctionLabel}.boundary_decision`,
    );
  }
  const boundaryHistory = requireArray(
    pass.boundary_decision_history,
    `${label}.review_pass.boundary_decision_history`,
  );
  const boundaryHistoryIds = new Set();
  for (const [index, boundaryChange] of boundaryHistory.entries()) {
    const boundaryLabel = `${label}.review_pass.boundary_decision_history[${index}]`;
    requireObject(boundaryChange, boundaryLabel);
    requireString(boundaryChange.record_id, `${boundaryLabel}.record_id`);
    if (boundaryHistoryIds.has(boundaryChange.record_id)) {
      fail(`${boundaryLabel}.record_id is duplicated`, 'SEMANTIC_AUDIT_SCOPE');
    }
    boundaryHistoryIds.add(boundaryChange.record_id);
    const correction = correctionsById.get(boundaryChange.record_id);
    if (!correction) {
      fail(`${boundaryLabel}.record_id must bind to a reviewed correction`, 'SEMANTIC_AUDIT_BINDING');
    }
    requireEnum(boundaryChange.decision, SEMANTIC_BOUNDARY_DECISIONS, `${boundaryLabel}.decision`);
    if (boundaryChange.decision !== correction.boundary_decision) {
      fail(`${boundaryLabel}.decision does not match the correction history`, 'SEMANTIC_AUDIT_BINDING');
    }
    if (boundaryChange.before_record_sha256 !== correction.before_record_sha256
      || boundaryChange.after_record_sha256 !== correction.after_record_sha256) {
      fail(`${boundaryLabel} is not bound to the correction history digests`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
    }
    requireString(boundaryChange.rationale, `${boundaryLabel}.rationale`);
    if (!boundaryChange.rationale.includes(boundaryChange.record_id)) {
      fail(`${boundaryLabel}.rationale must cite the corrected record`, 'SEMANTIC_AUDIT_GENERIC_EVIDENCE');
    }
  }
  if (boundaryHistoryIds.size !== correctionIds.size) {
    fail(`${label}.review_pass.boundary_decision_history must cover every correction`, 'SEMANTIC_AUDIT_SCOPE');
  }
}

function validateSemanticReviewChanges(recordInfos, baseRecords, changes, label) {
  const records = orderCanonicalRecordInfos(recordInfos).map(recordOf);
  const base = (baseRecords ?? recordInfos).map(recordOf);
  const prospectiveById = new Map(records.map((record) => [record.id, record]));
  const baseById = new Map(base.map((record) => [record.id, record]));
  const changeRows = requireArray(changes, `${label}.changes`);
  const changeById = new Map();
  for (const [index, change] of changeRows.entries()) {
    const changeLabel = `${label}.changes[${index}]`;
    requireObject(change, changeLabel);
    requireString(change.record_id, `${changeLabel}.record_id`);
    if (changeById.has(change.record_id)) fail(`${label} contains duplicate correction ${change.record_id}`, 'SEMANTIC_AUDIT_SCOPE');
    changeById.set(change.record_id, change);
    if (change.decision !== 'corrected') fail(`${changeLabel}.decision must be corrected`, 'SEMANTIC_AUDIT_VALUE');
    const baseRecord = baseById.get(change.record_id);
    const prospectiveRecord = prospectiveById.get(change.record_id);
    if (!baseRecord || !prospectiveRecord) fail(`${changeLabel}.record_id is not present in both base and prospective canonical data`, 'SEMANTIC_AUDIT_SCOPE');
    requireDigest(change.base_record_sha256, `${changeLabel}.base_record_sha256`);
    requireDigest(change.prospective_record_sha256, `${changeLabel}.prospective_record_sha256`);
    if (change.base_record_sha256 !== sha256Json(baseRecord)
      || change.prospective_record_sha256 !== sha256Json(prospectiveRecord)
      || change.base_record_sha256 === change.prospective_record_sha256) {
      fail(`${changeLabel} is not bound to an actual reviewed correction`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
    }
    requireString(change.rationale, `${changeLabel}.rationale`);
  }
  for (const baseRecord of base) {
    const prospectiveRecord = prospectiveById.get(baseRecord.id);
    if (!prospectiveRecord) continue;
    const changed = JSON.stringify(baseRecord) !== JSON.stringify(prospectiveRecord);
    const change = changeById.get(baseRecord.id);
    if (changed && !change) {
      fail(`${label} is missing an explicit reviewed correction for ${baseRecord.id}`, 'SEMANTIC_AUDIT_CORRECTION_REQUIRED');
    }
    if (!changed && change) {
      fail(`${label} contains a correction row for unchanged base record ${baseRecord.id}`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
    }
  }
  return changeRows.length;
}

/**
 * Validate a separately authored semantic/editorial decision artifact. No
 * decision is inferred from the canonical record by this validator.
 */
export function validateSemanticReviewArtifact(
  recordInfos,
  artifact,
  { baseRecords, label = 'semantic review' } = {},
) {
  requireObject(artifact, label);
  if (artifact.schema_version !== SEMANTIC_AUDIT_SCHEMA_VERSION
    || artifact.contract_version !== SEMANTIC_REVIEW_CONTRACT_VERSION) {
    fail(`${label} contract version is unsupported`, 'SEMANTIC_AUDIT_SCHEMA');
  }
  if (artifact.scope !== 'complete-canonical') fail(`${label}.scope must be complete-canonical`, 'SEMANTIC_AUDIT_SCOPE');
  if (artifact.review_mode !== 'agent-authored-decision') fail(`${label}.review_mode must be agent-authored-decision`, 'SEMANTIC_AUDIT_PROVENANCE');
  validateSemanticReviewPass(recordInfos, artifact, label);
  const records = recordInfos.map(recordOf);
  const expectedCanonicalDigest = canonicalRecordsSha256(recordInfos);
  const source = requireObject(artifact.source, `${label}.source`);
  if (source.kind !== 'canonical-jsonl-record-values') fail(`${label}.source.kind is unsupported`, 'SEMANTIC_AUDIT_PROVENANCE');
  requireDigest(source.canonical_records_sha256, `${label}.source.canonical_records_sha256`);
  if (source.canonical_records_sha256 !== expectedCanonicalDigest) {
    fail(`${label}.source.canonical_records_sha256 does not match the complete canonical input`, 'SEMANTIC_AUDIT_SOURCE_MISMATCH');
  }
  if (artifact.record_count !== records.length) fail(`${label}.record_count does not cover the complete canonical input`, 'SEMANTIC_AUDIT_SCOPE');
  const expectedSenseCount = records.reduce((sum, record) => sum + record.senses.length, 0);
  if (artifact.sense_count !== expectedSenseCount) fail(`${label}.sense_count does not cover every canonical sense`, 'SEMANTIC_AUDIT_SCOPE');
  const auditedRecords = requireArray(artifact.records, `${label}.records`);
  if (auditedRecords.length !== records.length) fail(`${label}.records must cover every canonical record`, 'SEMANTIC_AUDIT_SCOPE');

  const recordIds = new Set();
  const auditedById = new Map();
  for (const [recordIndex, auditedValue] of auditedRecords.entries()) {
    const recordLabel = `${label}.records[${recordIndex}]`;
    const audited = requireObject(auditedValue, recordLabel);
    if (recordIds.has(audited.record_id)) fail(`${label} contains duplicate record ${audited.record_id}`, 'SEMANTIC_AUDIT_SCOPE');
    recordIds.add(audited.record_id);
    auditedById.set(audited.record_id, { audited, recordLabel });
  }
  for (const [recordIndex, record] of records.entries()) {
    const auditedEntry = auditedById.get(record.id);
    if (!auditedEntry) fail(`${label} is missing record ${record.id}`, 'SEMANTIC_AUDIT_SCOPE');
    const { audited, recordLabel } = auditedEntry;
    requireDigest(audited.record_sha256, `${recordLabel}.record_sha256`);
    if (audited.record_sha256 !== sha256Json(record)) fail(`${recordLabel}.record_sha256 does not match canonical content`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
    const boundaryReview = validateBoundaryReview(
      record,
      audited.boundary_review,
      `${recordLabel}.boundary_review`,
    );
    const senseReviews = requireArray(audited.sense_reviews, `${recordLabel}.sense_reviews`);
    if (senseReviews.length !== record.senses.length) fail(`${recordLabel}.sense_reviews must cover every sense`, 'SEMANTIC_AUDIT_SCOPE');
    for (const [senseIndex, sense] of record.senses.entries()) {
      validateSemanticReviewSense(
        record,
        sense,
        senseReviews[senseIndex],
        senseIndex,
        `${recordLabel}.sense_reviews[${senseIndex}]`,
        boundaryReview,
      );
    }
  }
  const correctedRecordCount = validateSemanticReviewChanges(
    recordInfos,
    baseRecords,
    artifact.changes,
    label,
  );
  return {
    contract_version: artifact.contract_version,
    scope: artifact.scope,
    canonical_records_sha256: expectedCanonicalDigest,
    record_count: records.length,
    sense_count: expectedSenseCount,
    review_complete: true,
    corrected_record_count: correctedRecordCount,
  };
}

/**
 * Verify the complete pre-written audit envelope. Coverage is deterministic
 * machine evidence; review is a separately authored semantic decision set.
 */
export function validateSemanticAuditCoverage(
  recordInfos,
  artifact,
  { baseRecords, label = 'semantic audit' } = {},
) {
  requireObject(artifact, label);
  if (artifact.schema_version !== SEMANTIC_AUDIT_SCHEMA_VERSION
    || artifact.contract_version !== SEMANTIC_AUDIT_CONTRACT_VERSION) {
    fail(`${label} contract version is unsupported`, 'SEMANTIC_AUDIT_SCHEMA');
  }
  if (artifact.scope !== 'complete-canonical') fail(`${label}.scope must be complete-canonical`, 'SEMANTIC_AUDIT_SCOPE');
  if (artifact.lexical_quality_ruleset_version !== LEXICAL_QUALITY_RULESET_VERSION) {
    fail(`${label}.lexical_quality_ruleset_version is unsupported`, 'SEMANTIC_AUDIT_SCHEMA');
  }
  const expectedCanonicalDigest = canonicalRecordsSha256(recordInfos);
  const source = requireObject(artifact.source, `${label}.source`);
  if (source.kind !== 'canonical-jsonl-record-values') fail(`${label}.source.kind is unsupported`, 'SEMANTIC_AUDIT_PROVENANCE');
  requireDigest(source.canonical_records_sha256, `${label}.source.canonical_records_sha256`);
  if (source.canonical_records_sha256 !== expectedCanonicalDigest) {
    fail(`${label}.source.canonical_records_sha256 does not match the complete canonical input`, 'SEMANTIC_AUDIT_SOURCE_MISMATCH');
  }
  const coverage = requireObject(artifact.coverage, `${label}.coverage`);
  const review = requireObject(artifact.review, `${label}.review`);
  const coverageResult = validateSemanticCoverageArtifact(recordInfos, coverage, `${label}.coverage`);
  const reviewResult = validateSemanticReviewArtifact(recordInfos, review, {
    baseRecords,
    label: `${label}.review`,
  });
  if (coverage.source.canonical_records_sha256 !== review.source.canonical_records_sha256) {
    fail(`${label} coverage and review source digests differ`, 'SEMANTIC_AUDIT_SOURCE_MISMATCH');
  }
  if (artifact.record_count !== coverageResult.record_count
    || artifact.sense_count !== coverageResult.sense_count) {
    fail(`${label} top-level counts do not match complete coverage`, 'SEMANTIC_AUDIT_SCOPE');
  }
  return {
    contract_version: artifact.contract_version,
    scope: artifact.scope,
    canonical_records_sha256: expectedCanonicalDigest,
    record_count: coverageResult.record_count,
    sense_count: coverageResult.sense_count,
    covered_record_count: coverageResult.covered_record_count,
    covered_sense_count: coverageResult.covered_sense_count,
    coverage_complete: coverageResult.coverage_complete,
    review_complete: reviewResult.review_complete,
    corrected_record_count: reviewResult.corrected_record_count,
  };
}

export async function readSemanticAuditArtifact(
  auditPath = DEFAULT_SEMANTIC_AUDIT_PATH,
) {
  let bytes;
  try {
    bytes = await readFile(auditPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(`semantic audit artifact does not exist: ${auditPath}`, 'SEMANTIC_AUDIT_MISSING');
    }
    throw error;
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`semantic audit artifact is not valid JSON: ${auditPath} (${error.message})`, 'SEMANTIC_AUDIT_JSON');
  }
}

export async function readSemanticReviewArtifact(
  reviewPath = DEFAULT_SEMANTIC_REVIEW_PATH,
) {
  let bytes;
  try {
    bytes = await readFile(reviewPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(`semantic review artifact does not exist: ${reviewPath}`, 'SEMANTIC_REVIEW_MISSING');
    }
    throw error;
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`semantic review artifact is not valid JSON: ${reviewPath} (${error.message})`, 'SEMANTIC_REVIEW_JSON');
  }
}

export async function validateCanonicalSemanticAudit(
  directory = DEFAULT_CANONICAL_DIRECTORY,
  auditPath = DEFAULT_SEMANTIC_AUDIT_PATH,
) {
  const canonical = await readCanonicalRecords(directory);
  const artifact = await readSemanticAuditArtifact(auditPath);
  return validateSemanticAuditCoverage(canonical.records, artifact, {
    baseRecords: canonical.records,
  });
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  validateCanonicalSemanticAudit()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}
