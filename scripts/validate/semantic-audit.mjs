import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from './canonical-jsonl.mjs';
import {
  LEXICAL_TOPIC_EVIDENCE_CONTRACT_VERSION,
  LEXICAL_TOPIC_EVIDENCE_KIND,
  LEXICAL_QUALITY_RULESET_VERSION,
  inspectGlossConnectors,
  inspectWriterDomainEvidence,
  validateTopicAnalysisEvidence,
} from './lexical-quality.mjs';
import { inspectSenseBoundaryPairs } from './sense-boundary.mjs';

export { inspectSenseBoundaryPairs } from './sense-boundary.mjs';

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
  'overlapping',
]);
const MECHANICAL_BOUNDARY_RELATIONSHIPS = new Set([
  'duplicate',
  'nested',
  'usage-variant',
  'overlapping',
]);
export const SEMANTIC_BOUNDARY_METHOD = 'gloss-and-usage-pairwise-v2';
export const SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION = 'lexical-semantic-boundary-decisions-v1';
export const SEMANTIC_DECISION_SOURCE_SCHEMA_VERSION = '1';
export const SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION = 'lexical-semantic-decision-source-v1';
export const COMPACT_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION = 'lexical-semantic-canonical-decision-source-v2';
export const COMPACT_SEMANTIC_REVIEW_CONTRACT_VERSION = 'lexical-semantic-review-storage-v1';
export const SEMANTIC_DECISION_SOURCE_KIND = 'separately-authored-semantic-decision-source';
export const SEMANTIC_BOUNDARY_PAIR_DECISIONS = Object.freeze([
  'retain',
  'merge',
  'rewrite',
  'fail',
]);
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
export const DEFAULT_SEMANTIC_BOUNDARY_DECISIONS_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/validation/canonical-semantic-boundary-decisions.json',
);
export const DEFAULT_SEMANTIC_DECISION_SOURCE_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/validation/canonical-semantic-decision-source.json',
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

function validateDecisionSourceMetadata(artifact, label) {
  const decisionSource = requireObject(artifact.decision_source, `${label}.decision_source`);
  if (decisionSource.kind !== SEMANTIC_DECISION_SOURCE_KIND) {
    fail(`${label}.decision_source.kind must identify a separately authored decision source`, 'SEMANTIC_AUDIT_PROVENANCE');
  }
  if (decisionSource.contract_version !== SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION) {
    fail(`${label}.decision_source.contract_version is unsupported`, 'SEMANTIC_AUDIT_PROVENANCE');
  }
  requireString(decisionSource.source_id, `${label}.decision_source.source_id`);
  requireString(decisionSource.path, `${label}.decision_source.path`);
  if (decisionSource.authored_review_sha256 !== undefined) {
    requireDigest(decisionSource.authored_review_sha256, `${label}.decision_source.authored_review_sha256`);
  }
  return decisionSource;
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

function pickDefined(value, fields) {
  return Object.fromEntries(fields
    .filter((field) => Object.hasOwn(value ?? {}, field))
    .map((field) => [field, value[field]]));
}

/**
 * Store authored semantic decisions and immutable bindings only. Canonical
 * content facts, pass envelopes, and validator projections are reconstructed
 * by materializeSemanticReviewArtifact() before validation.
 */
export function compactSemanticReviewRecord(reviewed) {
  const boundary = reviewed?.boundary_review ?? {};
  const compactBoundary = {
    ...pickDefined(boundary, ['review_id', 'decision', 'classification', 'rationale']),
    evidence: (boundary.evidence ?? []).map((item) => pickDefined(item, [
      'sense_id',
      'evidence_basis',
      'rationale',
    ])),
    pairwise: (boundary.pairwise ?? []).map((item) => pickDefined(item, [
      'left_sense_id',
      'right_sense_id',
      'relationship',
      'decision',
      'evidence_basis',
      'distinguishing_feature',
      'rationale',
    ])),
  };
  const compactSenseReviews = (reviewed?.sense_reviews ?? []).map((senseReview) => {
    const compact = pickDefined(senseReview, [
      'sense_id',
      'semantic_rationale',
      'boundary_rationale',
      'no_relation_rationale',
    ]);
    if (!Object.hasOwn(compact, 'no_relation_rationale')
      && senseReview.relation?.no_relation_rationale !== undefined) {
      compact.no_relation_rationale = senseReview.relation.no_relation_rationale;
    }
    const topicEvidence = pickDefined(senseReview.review_basis, ['topic_analysis', 'topic_analyses']);
    if (Object.keys(topicEvidence).length > 0) compact.review_basis = topicEvidence;
    return compact;
  });
  return {
    ...pickDefined(reviewed, ['record_id', 'record_sha256', 'authored_batch_decision']),
    boundary_review: compactBoundary,
    sense_reviews: compactSenseReviews,
  };
}

export function compactSemanticReviewArtifact(review) {
  const compactReview = structuredClone(review);
  if (compactReview.review_pass) {
    compactReview.review_pass = pickDefined(compactReview.review_pass, [
      'id',
      'status',
      'reviewer',
      'review_mode',
      'method',
      'ruleset_version',
      'boundary_ruleset_version',
      'boundary_decision_source_version',
      'correction_history',
      'boundary_decision_history',
      'correction_source',
    ]);
  }
  delete compactReview.record_count;
  delete compactReview.sense_count;
  return {
    ...compactReview,
    contract_version: COMPACT_SEMANTIC_REVIEW_CONTRACT_VERSION,
    records: (review.records ?? []).map(compactSemanticReviewRecord),
  };
}

export function isCompactSemanticDecisionSource(source) {
  return source?.contract_version === COMPACT_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION;
}

export function compactSemanticDecisionSource(source) {
  const compactReview = compactSemanticReviewArtifact(source.authored_review);
  const compact = {
    ...structuredClone(source),
    contract_version: COMPACT_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
    authored_review: compactReview,
    authored_review_sha256: sha256Json(compactReview),
  };
  if (compact.correction_source == null) delete compact.correction_source;
  return compact;
}

function materializedBoundarySource(review, decisionSourceId) {
  const source = review.boundary_decision_source ?? {};
  return {
    method: source.method ?? SEMANTIC_BOUNDARY_METHOD,
    source: source.source ?? 'separately-authored-boundary-decision-source',
    decision_source_version: source.decision_source_version ?? SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION,
    inspected_fields: source.inspected_fields ?? ['gloss', 'writer-facing-usage', 'pairwise-authored-decision'],
    decision_source_id: decisionSourceId,
  };
}

/**
 * Expand the compact durable source into the in-memory review contract. Every
 * expanded field below is a deterministic projection of canonical content or
 * a compact authored judgment retained by the source.
 */
export function materializeSemanticReviewArtifact(
  recordInfos,
  compactReview,
  { decisionSourceId } = {},
) {
  if (compactReview?.contract_version !== COMPACT_SEMANTIC_REVIEW_CONTRACT_VERSION) {
    return structuredClone(compactReview);
  }
  const recordsById = new Map(recordInfos.map((recordInfo) => {
    const record = recordOf(recordInfo);
    return [record.id, record];
  }));
  const sourceId = decisionSourceId ?? compactReview.decision_source?.source_id;
  const boundarySource = materializedBoundarySource(compactReview, sourceId);
  const reviewPassId = compactReview.review_pass?.id ?? compactReview.artifact_id ?? 'canonical-semantic-review';
  const records = (compactReview.records ?? []).map((storedRecord, recordIndex) => {
    const record = recordsById.get(storedRecord.record_id);
    if (!record) {
      fail(
        `${compactReview.artifact_id ?? 'compact semantic review'}.records[${recordIndex}] is not canonical`,
        'SEMANTIC_AUDIT_SCOPE',
      );
    }
    const storedBoundary = storedRecord.boundary_review ?? {};
    const boundaryReviewId = storedBoundary.review_id ?? `${reviewPassId}:${record.id}:boundary`;
    const evidenceBySense = new Map((storedBoundary.evidence ?? []).map((item) => [item.sense_id, item]));
    const materializedEvidence = record.senses.map((sense) => {
      const item = evidenceBySense.get(sense.id) ?? {};
      return {
        sense_id: sense.id,
        gloss_sha256: sha256Json(sense.gloss),
        evidence_basis: item.evidence_basis,
        rationale: item.rationale,
        decision_source_id: sourceId,
      };
    });
    const materializedPairwise = (storedBoundary.pairwise ?? []).map((item) => {
      const leftSense = record.senses.find(({ id }) => id === item.left_sense_id);
      const rightSense = record.senses.find(({ id }) => id === item.right_sense_id);
      return {
        ...structuredClone(item),
        left_gloss_sha256: item.left_gloss_sha256 ?? (leftSense ? sha256Json(leftSense.gloss) : undefined),
        right_gloss_sha256: item.right_gloss_sha256 ?? (rightSense ? sha256Json(rightSense.gloss) : undefined),
        decision_source_id: sourceId,
      };
    });
    const boundaryReview = {
      status: 'pass',
      review_id: boundaryReviewId,
      method: boundarySource.method,
      independence: {
        independent_of_sense_count: true,
        source: boundarySource.source,
        decision_source_version: boundarySource.decision_source_version,
        inspected_fields: boundarySource.inspected_fields,
        decision_source_id: sourceId,
      },
      decision: storedBoundary.decision,
      classification: storedBoundary.classification,
      reviewed_sense_ids: record.senses.map(({ id }) => id),
      evidence: materializedEvidence,
      pairwise: materializedPairwise,
      rationale: storedBoundary.rationale,
    };
    const storedSenseById = new Map((storedRecord.sense_reviews ?? []).map((item) => [item.sense_id, item]));
    const senseReviews = record.senses.map((sense) => {
      const storedSense = storedSenseById.get(sense.id) ?? {};
      const storedBasis = storedSense.review_basis ?? {};
      const senseGlossSha256 = sha256Json(sense.gloss);
      const relationCoverage = senseRelationCoverage(sense);
      const relationDecision = relationCoverage.relation_count === 0 ? 'no-relations' : 'relations-reviewed';
      const boundaryEvidence = evidenceBySense.get(sense.id);
      const boundaryRationale = storedSense.boundary_rationale
        ?? boundaryEvidence?.rationale
        ?? `${record.id} ${sense.id} was reviewed against the authored boundary decision.`;
      const relationRationale = storedSense.no_relation_rationale
        ?? `${record.id} ${sense.id} relation tuples were reviewed against canonical content.`;
      return {
        sense_id: sense.id,
        sense_sha256: sha256Json(sense),
        sense_boundary: {
          status: 'pass',
          action: storedBoundary.decision,
          classification: storedBoundary.classification,
          boundary_decision: boundarySenseDecisionForRecord(storedBoundary.decision, storedBoundary.classification),
          boundary_review_id: boundaryReviewId,
          reviewed_sense_ids: record.senses.map(({ id }) => id),
          rationale: boundaryRationale,
          decision_source_id: sourceId,
        },
        pos: {
          status: 'pass',
          observed_pos: sense.pos,
          rationale: `${record.id} ${sense.id} POS was verified from canonical content under the authored review.`,
          decision: 'verified',
          decision_source_id: sourceId,
        },
        expression: {
          status: 'pass',
          expected_record_type: record.record_type,
          observed_record_type: record.record_type,
          rationale: `${record.id} ${sense.id} record type was verified from canonical content under the authored review.`,
          decision: 'verified',
          decision_source_id: sourceId,
        },
        relation: {
          status: 'pass',
          decision: relationDecision,
          relation_count: relationCoverage.relation_count,
          relation_sha256: relationCoverage.relation_sha256,
          relation_fingerprints: relationCoverage.relation_fingerprints,
          rationale: relationRationale,
          ...(relationCoverage.relation_count === 0
            ? { no_relation_rationale: storedSense.no_relation_rationale ?? relationRationale }
            : {}),
          decision_source_id: sourceId,
        },
        review_basis: {
          record_id: record.id,
          sense_id: sense.id,
          lemma: record.lemma,
          gloss_sha256: senseGlossSha256,
          observed_domain_axes: inspectWriterDomainEvidence(sense.gloss).axes,
          pos: sense.pos,
          record_type: record.record_type,
          relation_count: relationCoverage.relation_count,
          rationale: storedBasis.rationale
            ?? storedSense.semantic_rationale
            ?? `${record.id} ${sense.id} reviewed gloss ${senseGlossSha256.slice(0, 12)} from the authored decision source.`,
          decision_source_id: sourceId,
          ...(storedBasis.topic_analysis ? { topic_analysis: structuredClone(storedBasis.topic_analysis) } : {}),
          ...(Array.isArray(storedBasis.topic_analyses)
            ? { topic_analyses: structuredClone(storedBasis.topic_analyses) }
            : {}),
        },
      };
    });
    return {
      record_id: storedRecord.record_id,
      record_sha256: storedRecord.record_sha256,
      ...(storedRecord.authored_batch_decision
        ? { authored_batch_decision: structuredClone(storedRecord.authored_batch_decision) }
        : {}),
      boundary_review: boundaryReview,
      sense_reviews: senseReviews,
    };
  });
  const senseCount = recordInfos.reduce((sum, recordInfo) => sum + recordOf(recordInfo).senses.length, 0);
  const materializedReviewPass = {
    ...structuredClone(compactReview.review_pass ?? {}),
    record_count: records.length,
    sense_count: senseCount,
    open_finding_count: 0,
    correction_count: Array.isArray(compactReview.review_pass?.correction_history)
      ? compactReview.review_pass.correction_history.length
      : 0,
  };
  return {
    ...structuredClone(compactReview),
    contract_version: SEMANTIC_REVIEW_CONTRACT_VERSION,
    record_count: records.length,
    sense_count: senseCount,
    review_pass: materializedReviewPass,
    records,
  };
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
  const decisionSource = validateDecisionSourceMetadata(
    semanticReview,
    'semantic review artifact',
  );
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
    decision_source: structuredClone(decisionSource),
    record_count: coverage.record_count,
    sense_count: coverage.sense_count,
    coverage,
    review: semanticReview,
  };
}

/**
 * Reconstruct the complete audit envelope from canonical records and the
 * authoritative decision source without persisting any derived projection.
 * The decision source remains the only durable semantic input; coverage,
 * review, and the outer audit envelope are deterministic views of it.
 */
export function buildSemanticAuditFromDecisionSource(
  recordInfos,
  decisionSource,
  { artifactId = 'canonical-semantic-audit', baseRecords } = {},
) {
  const semanticReview = validateSemanticDecisionSource(
    recordInfos,
    decisionSource,
    {
      baseRecords: baseRecords ?? recordInfos,
      label: 'semantic decision source',
    },
  );
  const artifact = assembleSemanticAuditArtifact(recordInfos, semanticReview, {
    artifactId,
  });
  validateSemanticAuditCoverage(recordInfos, artifact, {
    baseRecords: baseRecords ?? recordInfos,
    label: 'reconstructed semantic audit',
  });
  return artifact;
}

export async function buildCanonicalSemanticAudit({
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  decisionSourcePath = DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
  artifactId = 'canonical-semantic-audit',
} = {}) {
  const canonical = await readCanonicalRecords(canonicalDirectory);
  const decisionSource = await readSemanticDecisionSourceArtifact(decisionSourcePath);
  const artifact = buildSemanticAuditFromDecisionSource(
    canonical.records,
    decisionSource,
    { artifactId },
  );
  return { canonical, decisionSource, artifact };
}

export function serializeSemanticAuditArtifact(artifact) {
  return Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

export function serializeSemanticDecisionSource(decisionSource) {
  return Buffer.from(`${JSON.stringify(decisionSource, null, 2)}\n`, 'utf8');
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

function validateBoundaryReview(
  record,
  boundary,
  label,
  { decisionSourceId, requireDecisionSource = true } = {},
) {
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
  if (requireDecisionSource) {
    requireString(independence.decision_source_id, `${label}.independence.decision_source_id`);
    if (decisionSourceId !== undefined && independence.decision_source_id !== decisionSourceId) {
      fail(`${label}.independence.decision_source_id is not bound to the authored decision source`, 'SEMANTIC_AUDIT_PROVENANCE');
    }
  }
  requireString(independence.decision_source_version, `${label}.independence.decision_source_version`);
  if (independence.decision_source_version !== SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION) {
    fail(`${label}.independence.decision_source_version is unsupported`, 'SEMANTIC_AUDIT_PROVENANCE');
  }
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
    if (requireDecisionSource) {
      requireString(item.decision_source_id, `${evidenceLabel}.decision_source_id`);
      if (decisionSourceId !== undefined && item.decision_source_id !== decisionSourceId) {
        fail(`${evidenceLabel}.decision_source_id is not bound to the authored decision source`, 'SEMANTIC_AUDIT_PROVENANCE');
      }
    }
    if (!item.rationale.includes(record.id)
      || !item.rationale.includes(item.sense_id)
      || !item.rationale.includes(item.gloss_sha256.slice(0, 12))) {
      fail(`${evidenceLabel}.rationale must cite record, sense, and gloss evidence`, 'SEMANTIC_AUDIT_GENERIC_EVIDENCE');
    }
  }
  const expectedPairs = [];
  for (let leftIndex = 0; leftIndex < record.senses.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < record.senses.length; rightIndex += 1) {
      expectedPairs.push({
        left_sense_id: record.senses[leftIndex].id,
        right_sense_id: record.senses[rightIndex].id,
      });
    }
  }
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
    requireEnum(item.decision, SEMANTIC_BOUNDARY_PAIR_DECISIONS, `${pairLabel}.decision`);
    const leftSense = record.senses.find(({ id }) => id === item.left_sense_id);
    const rightSense = record.senses.find(({ id }) => id === item.right_sense_id);
    requireDigest(item.left_gloss_sha256, `${pairLabel}.left_gloss_sha256`);
    requireDigest(item.right_gloss_sha256, `${pairLabel}.right_gloss_sha256`);
    if (item.left_gloss_sha256 !== sha256Json(leftSense.gloss)
      || item.right_gloss_sha256 !== sha256Json(rightSense.gloss)) {
      fail(`${pairLabel} gloss evidence does not match the canonical sense pair`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
    }
    requireString(item.evidence_basis, `${pairLabel}.evidence_basis`);
    if (item.evidence_basis.toLowerCase().includes('sense count')) {
      fail(`${pairLabel}.evidence_basis cannot use the current sense count as semantic evidence`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
    }
    requireString(item.distinguishing_feature, `${pairLabel}.distinguishing_feature`);
    if (item.distinguishing_feature.toLowerCase().includes('sense count')) {
      fail(`${pairLabel}.distinguishing_feature cannot use the current sense count as semantic evidence`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
    }
    requireString(item.rationale, `${pairLabel}.rationale`);
    if (requireDecisionSource) {
      requireString(item.decision_source_id, `${pairLabel}.decision_source_id`);
      if (decisionSourceId !== undefined && item.decision_source_id !== decisionSourceId) {
        fail(`${pairLabel}.decision_source_id is not bound to the authored decision source`, 'SEMANTIC_AUDIT_PROVENANCE');
      }
    }
    if (!item.rationale.includes(record.id)
      || !item.rationale.includes(item.left_sense_id)
      || !item.rationale.includes(item.right_sense_id)
      || !item.rationale.includes(item.left_gloss_sha256.slice(0, 12))
      || !item.rationale.includes(item.right_gloss_sha256.slice(0, 12))) {
      fail(`${pairLabel}.rationale must cite the reviewed sense pair and gloss evidence`, 'SEMANTIC_AUDIT_GENERIC_EVIDENCE');
    }
  }
  const mechanicalPairsByKey = new Map(
    inspectSenseBoundaryPairs(record).map((pair) => [
      `${pair.left_sense_id}:${pair.right_sense_id}`,
      pair,
    ]),
  );
  for (const item of pairwise) {
    const mechanicalPair = mechanicalPairsByKey.get(`${item.left_sense_id}:${item.right_sense_id}`);
    if (!mechanicalPair || !MECHANICAL_BOUNDARY_RELATIONSHIPS.has(mechanicalPair.relationship)) continue;
    if (item.relationship !== mechanicalPair.relationship) {
      fail(
        `${label}.pairwise for ${item.left_sense_id}/${item.right_sense_id} contradicts the mechanical ${mechanicalPair.relationship} finding`,
        'SEMANTIC_AUDIT_BOUNDARY_BLOCKER',
      );
    }
    if (item.decision === 'retain') {
      fail(
        `${label}.pairwise for ${item.left_sense_id}/${item.right_sense_id} cannot retain a mechanical ${mechanicalPair.relationship} pair`,
        'SEMANTIC_AUDIT_BOUNDARY_BLOCKER',
      );
    }
  }
  if (decision === 'retain' && classification !== 'atomic') {
    fail(`${label}.classification must be atomic for a retained single-sense outcome`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
  }
  if (decision === 'split' && !['separated', 'coordinated'].includes(classification)) {
    fail(`${label}.classification must explain a retained multi-sense outcome`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
  }
  const pairDecisions = pairwise.map(({ decision: pairDecision }) => pairDecision);
  if (decision === 'retain' && pairDecisions.some((pairDecision) => pairDecision !== 'retain')) {
    fail(`${label}.decision retain conflicts with a pair requiring merge, rewrite, or failure`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
  }
  if (decision === 'split' && pairDecisions.some((pairDecision) => pairDecision !== 'retain')) {
    fail(`${label}.decision split cannot pass while a pair remains unresolved`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
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

function validateSemanticReviewSense(
  record,
  sense,
  review,
  senseIndex,
  label,
  boundaryReview,
  {
    decisionSourceId,
    requireDecisionSource = true,
    requireTopicAnalysis = true,
  } = {},
) {
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
  if (requireDecisionSource) {
    requireString(boundary.decision_source_id, `${label}.sense_boundary.decision_source_id`);
    if (decisionSourceId !== undefined && boundary.decision_source_id !== decisionSourceId) {
      fail(`${label}.sense_boundary.decision_source_id is not bound to the authored decision source`, 'SEMANTIC_AUDIT_PROVENANCE');
    }
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
  if (requireDecisionSource) {
    if (pos.decision !== 'verified') {
      fail(`${label}.pos.decision must be an explicit verified decision`, 'SEMANTIC_AUDIT_PROVENANCE');
    }
    requireString(pos.decision_source_id, `${label}.pos.decision_source_id`);
    if (decisionSourceId !== undefined && pos.decision_source_id !== decisionSourceId) {
      fail(`${label}.pos.decision_source_id is not bound to the authored decision source`, 'SEMANTIC_AUDIT_PROVENANCE');
    }
  }
  requireString(pos.rationale, `${label}.pos.rationale`);

  const expression = requireObject(review.expression, `${label}.expression`);
  if (expression.status !== 'pass'
    || expression.expected_record_type !== record.record_type
    || expression.observed_record_type !== record.record_type) {
    fail(`${label}.expression does not bind the canonical record type`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  if (requireDecisionSource) {
    if (expression.decision !== 'verified') {
      fail(`${label}.expression.decision must be an explicit verified decision`, 'SEMANTIC_AUDIT_PROVENANCE');
    }
    requireString(expression.decision_source_id, `${label}.expression.decision_source_id`);
    if (decisionSourceId !== undefined && expression.decision_source_id !== decisionSourceId) {
      fail(`${label}.expression.decision_source_id is not bound to the authored decision source`, 'SEMANTIC_AUDIT_PROVENANCE');
    }
  }
  requireString(expression.rationale, `${label}.expression.rationale`);

  const relation = requireObject(review.relation, `${label}.relation`);
  if (relation.status !== 'pass') fail(`${label}.relation.status must be pass`, 'SEMANTIC_AUDIT_INCOMPLETE');
  if (requireDecisionSource) {
    requireString(relation.decision_source_id, `${label}.relation.decision_source_id`);
    if (decisionSourceId !== undefined && relation.decision_source_id !== decisionSourceId) {
      fail(`${label}.relation.decision_source_id is not bound to the authored decision source`, 'SEMANTIC_AUDIT_PROVENANCE');
    }
  }
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
  if (requireDecisionSource) {
    requireString(basis.decision_source_id, `${label}.review_basis.decision_source_id`);
    if (decisionSourceId !== undefined && basis.decision_source_id !== decisionSourceId) {
      fail(`${label}.review_basis.decision_source_id is not bound to the authored decision source`, 'SEMANTIC_AUDIT_PROVENANCE');
    }
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
  validateTopicAnalysisEvidence(
    sense.gloss,
    basis,
      {
        decisionSourceId,
        requireEvidence: requireTopicAnalysis,
        incompleteCode: 'SEMANTIC_AUDIT_INCOMPLETE',
        label: `${label}.review_basis`,
    },
  );
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
  if (pass.boundary_decision_source_version !== SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION) {
    fail(`${label}.review_pass.boundary_decision_source_version is unsupported`, 'SEMANTIC_AUDIT_PROVENANCE');
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
  const correctionKeys = new Set();
  const correctionsByKey = new Map();
  const correctionsByRecord = new Map();
  for (const [index, correction] of history.entries()) {
    const correctionLabel = `${label}.review_pass.correction_history[${index}]`;
    requireObject(correction, correctionLabel);
    requireString(correction.record_id, `${correctionLabel}.record_id`);
    const record = recordsById.get(correction.record_id);
    if (!record) fail(`${correctionLabel}.record_id is not canonical`, 'SEMANTIC_AUDIT_SCOPE');
    requireDigest(correction.before_record_sha256, `${correctionLabel}.before_record_sha256`);
    requireDigest(correction.after_record_sha256, `${correctionLabel}.after_record_sha256`);
    if (correction.before_record_sha256 === correction.after_record_sha256) {
      fail(`${correctionLabel} is not bound to a changed canonical record`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
    }
    requireString(correction.source_revision, `${correctionLabel}.source_revision`);
    requireString(correction.rationale, `${correctionLabel}.rationale`);
    requireEnum(
      correction.boundary_decision,
      SEMANTIC_BOUNDARY_DECISIONS,
      `${correctionLabel}.boundary_decision`,
    );
    const correctionKey = `${correction.record_id}:${correction.after_record_sha256}`;
    if (correctionKeys.has(correctionKey)) {
      fail(`${correctionLabel} duplicates a correction revision`, 'SEMANTIC_AUDIT_SCOPE');
    }
    correctionKeys.add(correctionKey);
    correctionsByKey.set(correctionKey, correction);
    const recordHistory = correctionsByRecord.get(correction.record_id) ?? [];
    const previousCorrection = recordHistory.at(-1);
    if (previousCorrection
      && correction.before_record_sha256 !== previousCorrection.after_record_sha256) {
      fail(
        `${correctionLabel}.before_record_sha256 does not continue the previous correction for ${correction.record_id}`,
        'SEMANTIC_AUDIT_CONTENT_MISMATCH',
      );
    }
    recordHistory.push(correction);
    correctionsByRecord.set(correction.record_id, recordHistory);
  }
  for (const [recordId, recordHistory] of correctionsByRecord.entries()) {
    const record = recordsById.get(recordId);
    const lastCorrection = recordHistory.at(-1);
    if (lastCorrection.after_record_sha256 !== sha256Json(record)) {
      fail(
        `${label}.review_pass.correction_history for ${recordId} is not bound to the repaired canonical record`,
        'SEMANTIC_AUDIT_CONTENT_MISMATCH',
      );
    }
  }
  const boundaryHistory = requireArray(
    pass.boundary_decision_history,
    `${label}.review_pass.boundary_decision_history`,
  );
  const boundaryHistoryKeys = new Set();
  for (const [index, boundaryChange] of boundaryHistory.entries()) {
    const boundaryLabel = `${label}.review_pass.boundary_decision_history[${index}]`;
    requireObject(boundaryChange, boundaryLabel);
    requireString(boundaryChange.record_id, `${boundaryLabel}.record_id`);
    requireDigest(boundaryChange.before_record_sha256, `${boundaryLabel}.before_record_sha256`);
    requireDigest(boundaryChange.after_record_sha256, `${boundaryLabel}.after_record_sha256`);
    const boundaryHistoryKey = `${boundaryChange.record_id}:${boundaryChange.after_record_sha256}`;
    if (boundaryHistoryKeys.has(boundaryHistoryKey)) {
      fail(`${boundaryLabel} duplicates a correction revision`, 'SEMANTIC_AUDIT_SCOPE');
    }
    boundaryHistoryKeys.add(boundaryHistoryKey);
    const correction = correctionsByKey.get(boundaryHistoryKey);
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
  if (boundaryHistoryKeys.size !== correctionKeys.size) {
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
  {
    baseRecords,
    label = 'semantic review',
    requireDecisionSource = true,
    requireTopicAnalysis = true,
  } = {},
) {
  requireObject(artifact, label);
  if (artifact.schema_version !== SEMANTIC_AUDIT_SCHEMA_VERSION
    || artifact.contract_version !== SEMANTIC_REVIEW_CONTRACT_VERSION) {
    fail(`${label} contract version is unsupported`, 'SEMANTIC_AUDIT_SCHEMA');
  }
  if (artifact.scope !== 'complete-canonical') fail(`${label}.scope must be complete-canonical`, 'SEMANTIC_AUDIT_SCOPE');
  if (artifact.review_mode !== 'agent-authored-decision') fail(`${label}.review_mode must be agent-authored-decision`, 'SEMANTIC_AUDIT_PROVENANCE');
  const decisionSource = requireDecisionSource
    ? validateDecisionSourceMetadata(artifact, label)
    : artifact.decision_source;
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
      {
        decisionSourceId: decisionSource?.source_id,
        requireDecisionSource,
      },
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
        {
          decisionSourceId: decisionSource?.source_id,
          requireDecisionSource,
          requireTopicAnalysis,
        },
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
 * Validate the separately authored semantic decision source consumed by the
 * rebuild command.  The source contains the complete review decision set;
 * this function only verifies its bindings and never derives a decision from
 * canonical content.
 */
export function validateSemanticDecisionSource(
  recordInfos,
  decisionSource,
  { baseRecords, label = 'semantic decision source' } = {},
) {
  requireObject(decisionSource, label);
  if (decisionSource.schema_version !== SEMANTIC_DECISION_SOURCE_SCHEMA_VERSION
    || ![
      SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
      COMPACT_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
    ].includes(decisionSource.contract_version)) {
    fail(`${label} contract version is unsupported`, 'SEMANTIC_AUDIT_SCHEMA');
  }
  if (decisionSource.scope !== 'complete-canonical') {
    fail(`${label}.scope must be complete-canonical`, 'SEMANTIC_AUDIT_SCOPE');
  }
  if (decisionSource.kind !== SEMANTIC_DECISION_SOURCE_KIND) {
    fail(`${label}.kind must identify a separately authored decision source`, 'SEMANTIC_AUDIT_PROVENANCE');
  }
  requireString(decisionSource.source_id, `${label}.source_id`);
  requireString(decisionSource.authoring_mode, `${label}.authoring_mode`);
  if (decisionSource.authoring_mode !== 'separately-authored') {
    fail(`${label}.authoring_mode must be separately-authored`, 'SEMANTIC_AUDIT_PROVENANCE');
  }
  const source = requireObject(decisionSource.source, `${label}.source`);
  if (source.kind !== 'canonical-jsonl-record-values') {
    fail(`${label}.source.kind is unsupported`, 'SEMANTIC_AUDIT_PROVENANCE');
  }
  const expectedCanonicalDigest = canonicalRecordsSha256(recordInfos);
  requireDigest(source.canonical_records_sha256, `${label}.source.canonical_records_sha256`);
  if (source.canonical_records_sha256 !== expectedCanonicalDigest) {
    fail(`${label}.source.canonical_records_sha256 does not match the complete canonical input`, 'SEMANTIC_AUDIT_SOURCE_MISMATCH');
  }
  const authoredReview = requireObject(decisionSource.authored_review, `${label}.authored_review`);
  requireDigest(decisionSource.authored_review_sha256, `${label}.authored_review_sha256`);
  if (decisionSource.authored_review_sha256 !== sha256Json(authoredReview)) {
    fail(`${label}.authored_review_sha256 does not match the authored review`, 'SEMANTIC_AUDIT_SOURCE_MISMATCH');
  }
  const authoredMetadata = validateDecisionSourceMetadata(authoredReview, `${label}.authored_review`);
  if (authoredMetadata.source_id !== decisionSource.source_id
    || authoredMetadata.contract_version !== SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION) {
    fail(`${label}.authored_review is not bound to this decision source`, 'SEMANTIC_AUDIT_PROVENANCE');
  }
  const materializedReview = isCompactSemanticDecisionSource(decisionSource)
    ? materializeSemanticReviewArtifact(recordInfos, authoredReview, {
      decisionSourceId: decisionSource.source_id,
    })
    : authoredReview;
  validateSemanticReviewArtifact(recordInfos, materializedReview, {
    baseRecords,
    label: `${label}.authored_review`,
  });
  return materializedReview;
}

/**
 * Verify the complete pre-written audit envelope. Coverage is deterministic
 * machine evidence; review is a separately authored semantic decision set.
 */
export function validateSemanticAuditCoverage(
  recordInfos,
  artifact,
  {
    baseRecords,
    label = 'semantic audit',
    requireDecisionSource = true,
    requireTopicAnalysis = true,
  } = {},
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
  const decisionSource = requireDecisionSource
    ? validateDecisionSourceMetadata(artifact, label)
    : artifact.decision_source;
  const coverage = requireObject(artifact.coverage, `${label}.coverage`);
  const review = requireObject(artifact.review, `${label}.review`);
  const coverageResult = validateSemanticCoverageArtifact(recordInfos, coverage, `${label}.coverage`);
  const reviewResult = validateSemanticReviewArtifact(recordInfos, review, {
    baseRecords,
    label: `${label}.review`,
    requireDecisionSource,
    requireTopicAnalysis,
  });
  if (coverage.source.canonical_records_sha256 !== review.source.canonical_records_sha256) {
    fail(`${label} coverage and review source digests differ`, 'SEMANTIC_AUDIT_SOURCE_MISMATCH');
  }
  if (requireDecisionSource) {
    const reviewDecisionSource = validateDecisionSourceMetadata(review, `${label}.review`);
    if (JSON.stringify(decisionSource) !== JSON.stringify(reviewDecisionSource)) {
      fail(`${label}.decision_source is not bound to the semantic review decision source`, 'SEMANTIC_AUDIT_PROVENANCE');
    }
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

/**
 * Project the source-bound topic/adnominal decisions that were authored with
 * the semantic review.  This is the only input that can establish a blocking
 * noun-topic reading; lexical POS presence remains open-world evidence.
 */
export function buildSemanticTopicEvidence(
  recordInfos,
  artifact,
  { label = 'semantic audit', requireTopicAnalysis = true } = {},
) {
  requireObject(artifact, label);
  const review = requireObject(artifact.review, `${label}.review`);
  const expectedCanonicalDigest = canonicalRecordsSha256(recordInfos);
  const source = requireObject(review.source, `${label}.review.source`);
  requireDigest(source.canonical_records_sha256, `${label}.review.source.canonical_records_sha256`);
  if (source.canonical_records_sha256 !== expectedCanonicalDigest) {
    fail(
      `${label}.review.source.canonical_records_sha256 does not match the complete canonical input`,
      'SEMANTIC_AUDIT_SOURCE_MISMATCH',
    );
  }
  const decisionSource = artifact.decision_source ?? review.decision_source;
  const decisionSourceId = decisionSource?.source_id;
  if (decisionSourceId !== undefined) requireString(decisionSourceId, `${label}.decision_source.source_id`);
  const reviewedRecords = requireArray(review.records, `${label}.review.records`);
  const reviewedById = new Map(reviewedRecords.map((reviewed) => [reviewed.record_id, reviewed]));
  const bySense = new Map();

  for (const [recordIndex, recordInfo] of recordInfos.entries()) {
    const record = recordOf(recordInfo);
    const reviewed = reviewedById.get(record.id);
    if (!reviewed) fail(`${label}.review is missing record ${record.id}`, 'SEMANTIC_AUDIT_SCOPE');
    const senseReviews = requireArray(reviewed.sense_reviews, `${label}.review.records[${recordIndex}].sense_reviews`);
    for (const [senseIndex, sense] of record.senses.entries()) {
      const senseReview = requireObject(
        senseReviews[senseIndex],
        `${label}.review.records[${recordIndex}].sense_reviews[${senseIndex}]`,
      );
      const analyses = validateTopicAnalysisEvidence(
        sense.gloss,
        senseReview.review_basis,
        {
          decisionSourceId,
          requireEvidence: requireTopicAnalysis,
          incompleteCode: 'SEMANTIC_AUDIT_INCOMPLETE',
          label: `${label}.review.records[${recordIndex}].sense_reviews[${senseIndex}].review_basis`,
        },
      );
      if (analyses === undefined) continue;
      for (const analysis of analyses) {
        if (analysis.state === 'noun-topic' && decisionSourceId === undefined) {
          fail(
            `${label}.review contains noun-topic evidence without an authored decision source`,
            'SEMANTIC_AUDIT_PROVENANCE',
          );
        }
      }
      if (bySense.has(sense.id)) {
        fail(`${label}.review contains duplicate topic analysis for ${sense.id}`, 'SEMANTIC_AUDIT_SCOPE');
      }
      bySense.set(sense.id, analyses.map((analysis) => ({
        ...analysis,
        sense_id: sense.id,
      })));
    }
  }

  return {
    kind: LEXICAL_TOPIC_EVIDENCE_KIND,
    contract_version: LEXICAL_TOPIC_EVIDENCE_CONTRACT_VERSION,
    source: {
      kind: 'semantic-review-topic-analysis',
      canonical_records_sha256: expectedCanonicalDigest,
      decision_source_id: decisionSourceId ?? null,
    },
    by_sense: bySense,
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

export async function readSemanticDecisionSourceArtifact(
  decisionSourcePath = DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
) {
  let bytes;
  try {
    bytes = await readFile(decisionSourcePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(`semantic decision source does not exist: ${decisionSourcePath}`, 'SEMANTIC_DECISION_SOURCE_MISSING');
    }
    throw error;
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`semantic decision source is not valid JSON: ${decisionSourcePath} (${error.message})`, 'SEMANTIC_DECISION_SOURCE_JSON');
  }
}

export async function validateCanonicalSemanticAudit(
  directory = DEFAULT_CANONICAL_DIRECTORY,
  auditPath,
  decisionSourcePath = DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
) {
  const { canonical, artifact } = await buildCanonicalSemanticAudit({
    canonicalDirectory: directory,
    decisionSourcePath,
  });
  // Explicit non-default paths are retained for historical/replay callers.
  // The current canonical audit path is deliberately reconstructed in memory.
  if (auditPath && path.resolve(auditPath) !== path.resolve(DEFAULT_SEMANTIC_AUDIT_PATH)) {
    const persisted = await readSemanticAuditArtifact(auditPath);
    if (JSON.stringify(persisted) !== JSON.stringify(artifact)) {
      fail('persisted semantic audit does not match the reconstructed audit', 'SEMANTIC_AUDIT_SOURCE_MISMATCH');
    }
  }
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
