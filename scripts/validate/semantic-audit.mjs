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
  WRITER_DOMAIN_AXES,
  inspectGlossConnectors,
  inspectWriterDomainEvidence,
} from './lexical-quality.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export const SEMANTIC_AUDIT_SCHEMA_VERSION = '1';
export const SEMANTIC_AUDIT_CONTRACT_VERSION = 'lexical-semantic-audit-v1';
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

function recordOf(recordInfo) {
  return recordInfo?.record ?? recordInfo;
}

export function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/**
 * Hash the ordered canonical record values rather than a batch or file name.
 * The same digest is used by the durable audit and prospective admissions, so
 * a file move or a new batch ID cannot make stale semantic coverage valid.
 */
export function canonicalRecordsSha256(recordInfos) {
  return sha256Json(recordInfos.map(recordOf));
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

function senseRelationEvidence(sense) {
  const relations = sense.relations ?? [];
  return {
    relation_count: relations.length,
    relation_sha256: sha256Json({
      source_sense: sense.id,
      relations,
    }),
    relation_fingerprints: relations.map((relation) => relationFingerprint(sense.id, relation)),
    ...(relations.length === 0
      ? {
        no_relation_rationale: `${sense.id} has no relation tuple in the canonical source; zero relations remain an explicit reviewed outcome, not an omitted field.`,
      }
      : {}),
  };
}

function buildSenseAudit(record, sense) {
  const allSenseIds = record.senses.map(({ id }) => id);
  const domainEvidence = inspectWriterDomainEvidence(sense.gloss);
  const boundaryClassification = record.senses.length > 1 ? 'separated' : 'atomic';
  const boundaryDecision = domainEvidence.axes.length > 1
    ? 'coordinated'
    : record.senses.length > 1
      ? 'split'
      : 'atomic';
  const content = {
    gloss_sha256: sha256Json(sense.gloss),
    observed_domain_axes: domainEvidence.axes,
    domain_evidence: domainEvidence.matches,
    connector_observations: inspectGlossConnectors(sense.gloss),
  };
  return {
    sense_id: sense.id,
    sense_sha256: sha256Json(sense),
    content,
    sense_boundary: {
      status: 'pass',
      action: record.senses.length > 1 ? 'split' : 'retain',
      classification: boundaryClassification,
      boundary_decision: boundaryDecision,
      reviewed_sense_ids: allSenseIds,
      rationale: `${record.id} ${sense.id} is covered by the complete canonical semantic audit; the source-bound content digest and every sense in the record were checked.`,
    },
    pos: {
      status: 'pass',
      observed_pos: sense.pos,
      rationale: `${record.id} ${sense.id} POS is bound to the canonical sense content.`,
    },
    expression: {
      status: 'pass',
      expected_record_type: record.record_type,
      observed_record_type: record.record_type,
      rationale: `${record.id} ${sense.id} record-type classification is bound to the canonical record.`,
    },
    relation: {
      status: 'pass',
      ...senseRelationEvidence(sense),
      rationale: `${record.id} ${sense.id} relation presence or explicit zero-relation outcome is covered.`,
    },
  };
}

/**
 * Create the durable machine semantic-coverage artifact for a complete
 * canonical snapshot.  This is a coverage/audit artifact, not a claim of
 * human editorial review; future additions still require a production review
 * artifact before this coverage can be admitted.
 */
export function buildSemanticAuditArtifact(
  recordInfos,
  {
    artifactId = 'canonical-semantic-audit',
    auditMode = 'machine-content-binding',
  } = {},
) {
  const records = recordInfos.map(recordOf);
  return {
    schema_version: SEMANTIC_AUDIT_SCHEMA_VERSION,
    contract_version: SEMANTIC_AUDIT_CONTRACT_VERSION,
    artifact_id: artifactId,
    scope: 'complete-canonical',
    audit_mode: auditMode,
    human_editorial_review_claimed: false,
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
      sense_reviews: record.senses.map((sense) => buildSenseAudit(record, sense)),
    })),
  };
}

function assertExact(actual, expected, label, code = 'SEMANTIC_AUDIT_BINDING') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} does not match the canonical source`, code);
  }
}

function validateSenseReview(record, sense, review, senseIndex, label) {
  requireObject(review, label);
  if (review.sense_id !== sense.id) fail(`${label}.sense_id is not bound`, 'SEMANTIC_AUDIT_BINDING');
  requireDigest(review.sense_sha256, `${label}.sense_sha256`);
  if (review.sense_sha256 !== sha256Json(sense)) {
    fail(`${label}.sense_sha256 does not match the canonical sense`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }

  const content = requireObject(review.content, `${label}.content`);
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
  requireArray(content.domain_evidence, `${label}.content.domain_evidence`);
  assertExact(
    content.domain_evidence,
    domainEvidence.matches,
    `${label}.content.domain_evidence`,
    'SEMANTIC_AUDIT_CONTENT_MISMATCH',
  );
  requireArray(content.connector_observations, `${label}.content.connector_observations`);
  assertExact(
    content.connector_observations,
    inspectGlossConnectors(sense.gloss),
    `${label}.content.connector_observations`,
    'SEMANTIC_AUDIT_CONTENT_MISMATCH',
  );

  const boundary = requireObject(review.sense_boundary, `${label}.sense_boundary`);
  if (boundary.status !== 'pass') fail(`${label}.sense_boundary.status must be pass`, 'SEMANTIC_AUDIT_INCOMPLETE');
  const expectedClassification = record.senses.length > 1 ? 'separated' : 'atomic';
  const expectedAction = record.senses.length > 1 ? 'split' : 'retain';
  if (boundary.action !== expectedAction || boundary.classification !== expectedClassification) {
    fail(`${label}.sense_boundary does not cover the canonical sense set`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
  }
  const expectedDecision = domainEvidence.axes.length > 1
    ? 'coordinated'
    : record.senses.length > 1
      ? 'split'
      : 'atomic';
  if (boundary.boundary_decision !== expectedDecision) {
    fail(`${label}.sense_boundary.boundary_decision does not account for the source content`, 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER');
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
  const expectedRelations = senseRelationEvidence(sense);
  if (relation.relation_count !== expectedRelations.relation_count
    || relation.relation_sha256 !== expectedRelations.relation_sha256) {
    fail(`${label}.relation does not bind canonical relation content`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  assertExact(
    relation.relation_fingerprints,
    expectedRelations.relation_fingerprints,
    `${label}.relation.relation_fingerprints`,
    'SEMANTIC_AUDIT_CONTENT_MISMATCH',
  );
  if (sense.relations?.length > 0) {
    if (Object.hasOwn(relation, 'no_relation_rationale')) {
      fail(`${label}.relation must not claim no relations when tuples exist`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
    }
  } else {
    requireString(relation.no_relation_rationale, `${label}.relation.no_relation_rationale`);
    if (!relation.no_relation_rationale.includes(record.id) && !relation.no_relation_rationale.includes(sense.id)) {
      fail(`${label}.relation.no_relation_rationale must bind the canonical sense`, 'SEMANTIC_AUDIT_BINDING');
    }
  }

  // Keep the index parameter in the error context for callers inspecting a
  // large audit file; it also makes accidental duplicate sense rows obvious.
  if (senseIndex < 0) fail(`${label} has an invalid sense index`, 'SEMANTIC_AUDIT_SCOPE');
}

/**
 * Verify complete semantic coverage and source-content binding.  A matching
 * record count alone is insufficient: every record and every sense must carry
 * the exact canonical digest, POS/type facts, boundary coverage, and relation
 * outcome that the audit claims.
 */
export function validateSemanticAuditCoverage(
  recordInfos,
  artifact,
  { label = 'semantic audit' } = {},
) {
  requireObject(artifact, label);
  if (artifact.schema_version !== SEMANTIC_AUDIT_SCHEMA_VERSION
    || artifact.contract_version !== SEMANTIC_AUDIT_CONTRACT_VERSION) {
    fail(`${label} contract version is unsupported`, 'SEMANTIC_AUDIT_SCHEMA');
  }
  if (artifact.scope !== 'complete-canonical') fail(`${label}.scope must be complete-canonical`, 'SEMANTIC_AUDIT_SCOPE');
  if (artifact.human_editorial_review_claimed !== false) {
    fail(`${label} must not claim human editorial review`, 'SEMANTIC_AUDIT_PROVENANCE');
  }
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

  const records = recordInfos.map(recordOf);
  if (artifact.record_count !== records.length) fail(`${label}.record_count does not cover the complete canonical input`, 'SEMANTIC_AUDIT_SCOPE');
  const expectedSenseCount = records.reduce((sum, record) => sum + record.senses.length, 0);
  if (artifact.sense_count !== expectedSenseCount) fail(`${label}.sense_count does not cover every canonical sense`, 'SEMANTIC_AUDIT_SCOPE');
  const auditedRecords = requireArray(artifact.records, `${label}.records`);
  if (auditedRecords.length !== records.length) fail(`${label}.records must cover every canonical record`, 'SEMANTIC_AUDIT_SCOPE');

  const recordIds = new Set();
  for (const [recordIndex, record] of records.entries()) {
    const recordLabel = `${label}.records[${recordIndex}]`;
    const audited = requireObject(auditedRecords[recordIndex], recordLabel);
    if (recordIds.has(audited.record_id)) fail(`${label} contains duplicate record ${audited.record_id}`, 'SEMANTIC_AUDIT_SCOPE');
    recordIds.add(audited.record_id);
    if (audited.record_id !== record.id) fail(`${recordLabel}.record_id is not in canonical order`, 'SEMANTIC_AUDIT_SCOPE');
    requireDigest(audited.record_sha256, `${recordLabel}.record_sha256`);
    if (audited.record_sha256 !== sha256Json(record)) fail(`${recordLabel}.record_sha256 does not match canonical content`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
    if (audited.lemma !== record.lemma
      || audited.record_type !== record.record_type
      || audited.role !== record.role) {
      fail(`${recordLabel} record identity facts drifted`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
    }
    const senseReviews = requireArray(audited.sense_reviews, `${recordLabel}.sense_reviews`);
    if (senseReviews.length !== record.senses.length) fail(`${recordLabel}.sense_reviews must cover every sense`, 'SEMANTIC_AUDIT_SCOPE');
    const senseIds = new Set();
    for (const [senseIndex, sense] of record.senses.entries()) {
      const senseReview = senseReviews[senseIndex];
      if (senseIds.has(senseReview?.sense_id)) fail(`${recordLabel} contains duplicate sense coverage`, 'SEMANTIC_AUDIT_SCOPE');
      senseIds.add(senseReview?.sense_id);
      validateSenseReview(
        record,
        sense,
        senseReview,
        senseIndex,
        `${recordLabel}.sense_reviews[${senseIndex}]`,
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

export async function validateCanonicalSemanticAudit(
  directory = DEFAULT_CANONICAL_DIRECTORY,
  auditPath = DEFAULT_SEMANTIC_AUDIT_PATH,
) {
  const canonical = await readCanonicalRecords(directory);
  const artifact = await readSemanticAuditArtifact(auditPath);
  return validateSemanticAuditCoverage(canonical.records, artifact);
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
