import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CANONICAL_DIRECTORY,
} from './canonical-jsonl.mjs';
import { loadCanonicalContext } from './canonical-context.mjs';
import {
  LEXICAL_TOPIC_EVIDENCE_CONTRACT_VERSION,
  LEXICAL_TOPIC_EVIDENCE_KIND,
  LEXICAL_QUALITY_RULESET_VERSION,
  inspectGlossConnectors,
  inspectWriterDomainEvidence,
  validateTopicAnalysisEvidence,
} from './lexical-quality.mjs';
import { inspectSenseBoundaryPairs } from './sense-boundary.mjs';
import {
  AUTHORED_SEMANTIC_REVIEW_BINDING_CONTRACT_VERSION,
  compactAuthoredSemanticDecisionRow,
  isGrandfatheredM512ADecisionSource,
  SOURCE_BOUND_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
  validateAuthoredSemanticReviewBinding,
} from './semantic-decision-row.mjs';

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
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
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
export const DEFAULT_AUTHORED_BATCH_DECISION_SOURCE_PATHS = Object.freeze([
  path.resolve(SCRIPT_DIRECTORY, '../../data/batches/m5-12a-semantic-decisions.json'),
  path.resolve(SCRIPT_DIRECTORY, '../../data/batches/m5-13-semantic-decisions.json'),
  path.resolve(SCRIPT_DIRECTORY, '../../data/batches/m5-14-semantic-decisions.json'),
  path.resolve(SCRIPT_DIRECTORY, '../../data/batches/m5-15-semantic-decisions.json'),
]);
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');

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
  if (!SHA256_PATTERN.test(value)) {
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
  let isAlreadyOrdered = true;
  for (let index = 1; index < recordInfos.length; index += 1) {
    if (compareCanonicalRecordIds(
      recordOf(recordInfos[index - 1]).id,
      recordOf(recordInfos[index]).id,
    ) > 0) {
      isAlreadyOrdered = false;
      break;
    }
  }
  if (isAlreadyOrdered) return recordInfos;
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

const CANONICAL_AUDIT_CACHE_TOKEN = Symbol('canonical-audit-cache');

export function createCanonicalAuditCache(recordInfos) {
  const ordered = orderCanonicalRecordInfos(recordInfos);
  return {
    [CANONICAL_AUDIT_CACHE_TOKEN]: true,
    recordInfos,
    orderedRecordInfos: ordered,
    canonicalDigest: sha256Json(ordered.map(recordOf)),
    objectHashes: new WeakMap(),
    primitiveHashes: new Map(),
    relationCoverage: new WeakMap(),
    writerDomainEvidence: new Map(),
    glossConnectors: new Map(),
  };
}

function isCanonicalAuditCache(hashCache, recordInfos) {
  return Boolean(
    hashCache?.[CANONICAL_AUDIT_CACHE_TOKEN] === true
      && hashCache.recordInfos === recordInfos,
  );
}

export function cachedSha256Json(value, hashCache) {
  if (!hashCache?.[CANONICAL_AUDIT_CACHE_TOKEN]) return sha256Json(value);
  if (value !== null && typeof value === 'object') {
    const cached = hashCache.objectHashes.get(value);
    if (cached) return cached;
    const digest = sha256Json(value);
    hashCache.objectHashes.set(value, digest);
    return digest;
  }
  const key = `${typeof value}:${String(value)}`;
  const cached = hashCache.primitiveHashes.get(key);
  if (cached) return cached;
  const digest = sha256Json(value);
  hashCache.primitiveHashes.set(key, digest);
  return digest;
}

function canonicalDigestFor(recordInfos, hashCache) {
  if (isCanonicalAuditCache(hashCache, recordInfos)) return hashCache.canonicalDigest;
  return canonicalRecordsSha256(recordInfos);
}

function orderedRecordInfosFor(recordInfos, hashCache) {
  if (isCanonicalAuditCache(hashCache, recordInfos)) return hashCache.orderedRecordInfos;
  return orderCanonicalRecordInfos(recordInfos);
}

function cachedWriterDomainEvidence(gloss, hashCache) {
  if (!hashCache?.writerDomainEvidence) return inspectWriterDomainEvidence(gloss);
  const cached = hashCache.writerDomainEvidence.get(gloss);
  if (cached) return cached;
  const evidence = inspectWriterDomainEvidence(gloss);
  hashCache.writerDomainEvidence.set(gloss, evidence);
  return evidence;
}

function cachedGlossConnectors(gloss, hashCache) {
  if (!hashCache?.glossConnectors) return inspectGlossConnectors(gloss);
  const cached = hashCache.glossConnectors.get(gloss);
  if (cached) return cached;
  const connectors = inspectGlossConnectors(gloss);
  hashCache.glossConnectors.set(gloss, connectors);
  return connectors;
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

function replaceAll(value, token, replacement) {
  return token ? value.split(token).join(replacement) : value;
}

function rationaleTemplate(value, context = {}) {
  if (typeof value !== 'string') return undefined;
  let template = value;
  const tokens = [
    ['left_gloss_sha256', context.left_gloss_sha256],
    ['right_gloss_sha256', context.right_gloss_sha256],
    ['gloss_sha256', context.gloss_sha256],
    ['left_gloss_sha256_prefix', context.left_gloss_sha256?.slice(0, 12)],
    ['right_gloss_sha256_prefix', context.right_gloss_sha256?.slice(0, 12)],
    ['gloss_sha256_prefix', context.gloss_sha256?.slice(0, 12)],
    ['left_sense_id', context.left_sense_id],
    ['right_sense_id', context.right_sense_id],
    ['sense_id', context.sense_id],
    ['record_id', context.record_id],
  ].filter(([, token]) => typeof token === 'string' && token.length > 0)
    .sort((left, right) => right[1].length - left[1].length);
  for (const [name, token] of tokens) {
    template = replaceAll(template, token, `{{${name}}}`);
  }
  return template;
}

function rationaleOccurrences(review) {
  const occurrences = [];
  const add = (value, context) => {
    if (typeof value === 'string' && value.length > 0) occurrences.push({ value, context });
  };
  for (const record of review.records ?? []) {
    if (record.authored_batch_decision) continue;
    const recordContext = { record_id: record.record_id };
    add(record.boundary_review?.rationale, recordContext);
    for (const evidence of record.boundary_review?.evidence ?? []) {
      add(evidence.evidence_basis, {
        ...recordContext,
        sense_id: evidence.sense_id,
        gloss_sha256: evidence.gloss_sha256,
      });
      add(evidence.rationale, {
        ...recordContext,
        sense_id: evidence.sense_id,
        gloss_sha256: evidence.gloss_sha256,
      });
    }
    for (const pair of record.boundary_review?.pairwise ?? []) {
      const context = {
        ...recordContext,
        left_sense_id: pair.left_sense_id,
        right_sense_id: pair.right_sense_id,
        left_gloss_sha256: pair.left_gloss_sha256,
        right_gloss_sha256: pair.right_gloss_sha256,
      };
      add(pair.evidence_basis, context);
      add(pair.distinguishing_feature, context);
      add(pair.rationale, context);
    }
    for (const sense of record.sense_reviews ?? []) {
      const context = {
        ...recordContext,
        sense_id: sense.sense_id,
        gloss_sha256: sense.review_basis?.gloss_sha256,
      };
      add(sense.semantic_rationale, context);
      add(sense.boundary_rationale, context);
      add(sense.relation?.rationale, context);
      add(sense.no_relation_rationale ?? sense.relation?.no_relation_rationale, context);
    }
  }
  return occurrences;
}

function buildRationaleTemplateRegistry(review) {
  const counts = new Map();
  for (const occurrence of rationaleOccurrences(review)) {
    const template = rationaleTemplate(occurrence.value, occurrence.context);
    counts.set(template, (counts.get(template) ?? 0) + 1);
  }
  const codeByTemplate = new Map();
  const templatesByCode = {};
  for (const [template, count] of counts.entries()) {
    if (count < 2) continue;
    const code = `reason-${sha256Json(template).slice(0, 16)}`;
    if (templatesByCode[code] !== undefined && templatesByCode[code] !== template) {
      fail(`rationale template code collision for ${code}`, 'SEMANTIC_AUDIT_TEMPLATE_COLLISION');
    }
    codeByTemplate.set(template, code);
    templatesByCode[code] = template;
  }
  return {
    codeByTemplate,
    templates: Object.entries(templatesByCode).map(([code, template]) => ({ code, template })),
  };
}

function compactTextField(target, field, value, context, rationaleRegistry) {
  if (value === undefined) return;
  const template = rationaleTemplate(value, context);
  const code = rationaleRegistry?.codeByTemplate.get(template);
  if (code) target[`${field}_code`] = code;
  else target[field] = value;
}

const RATIONALE_TEMPLATE_TOKEN_PATTERN = /\{\{(left_gloss_sha256|right_gloss_sha256|gloss_sha256|left_gloss_sha256_prefix|right_gloss_sha256_prefix|gloss_sha256_prefix|left_sense_id|right_sense_id|sense_id|record_id)\}\}/gu;

function resolveTextField(stored, field, context, templates, label) {
  if (stored[field] !== undefined) return stored[field];
  const code = stored[`${field}_code`];
  if (code === undefined) return undefined;
  const template = templates?.get(code);
  if (typeof template !== 'string') {
    fail(`${label}.${field}_code does not reference a retained rationale template`, 'SEMANTIC_AUDIT_TEMPLATE_MISSING');
  }
  return template.replace(RATIONALE_TEMPLATE_TOKEN_PATTERN, (_match, token) => {
    if (token.endsWith('_prefix')) {
      return context[token.slice(0, -'_prefix'.length)]?.slice(0, 12) ?? '';
    }
    return context[token] ?? '';
  });
}

/**
 * Store authored semantic decisions and immutable bindings only. Canonical
 * content facts, pass envelopes, and validator projections are reconstructed
 * by materializeSemanticReviewArtifact() before validation.
 */
export function compactSemanticReviewRecord(reviewed, { rationaleRegistry } = {}) {
  // M5-12A owns its authored narrative in the batch decision source. The
  // canonical authority keeps only the immutable binding and dereferences the
  // row during materialization; copying the narrative here would create a
  // second authority for the same decision.
  if (reviewed?.authored_batch_decision) {
    return {
      ...pickDefined(reviewed, ['record_id', 'record_sha256', 'authored_batch_decision']),
    };
  }
  const boundary = reviewed?.boundary_review ?? {};
  const compactBoundary = {
    ...pickDefined(boundary, ['review_id', 'decision', 'classification']),
    evidence: (boundary.evidence ?? []).map((item) => pickDefined(item, [
      'sense_id',
    ])),
    pairwise: (boundary.pairwise ?? []).map((item) => pickDefined(item, [
      'left_sense_id',
      'right_sense_id',
      'relationship',
      'decision',
    ])),
  };
  for (const [index, item] of (boundary.evidence ?? []).entries()) {
    const compact = compactBoundary.evidence[index];
    compactTextField(compact, 'evidence_basis', item.evidence_basis, {
      record_id: reviewed.record_id,
      sense_id: item.sense_id,
      gloss_sha256: item.gloss_sha256,
    }, rationaleRegistry);
    compactTextField(compact, 'rationale', item.rationale, {
      record_id: reviewed.record_id,
      sense_id: item.sense_id,
      gloss_sha256: item.gloss_sha256,
    }, rationaleRegistry);
  }
  for (const [index, item] of (boundary.pairwise ?? []).entries()) {
    const compact = compactBoundary.pairwise[index];
    const context = {
      record_id: reviewed.record_id,
      left_sense_id: item.left_sense_id,
      right_sense_id: item.right_sense_id,
      left_gloss_sha256: item.left_gloss_sha256,
      right_gloss_sha256: item.right_gloss_sha256,
    };
    compactTextField(compact, 'evidence_basis', item.evidence_basis, context, rationaleRegistry);
    compactTextField(compact, 'distinguishing_feature', item.distinguishing_feature, context, rationaleRegistry);
    compactTextField(compact, 'rationale', item.rationale, context, rationaleRegistry);
  }
  compactTextField(compactBoundary, 'rationale', boundary.rationale, {
    record_id: reviewed.record_id,
  }, rationaleRegistry);
  const compactSenseReviews = (reviewed?.sense_reviews ?? []).map((senseReview) => {
    const compact = pickDefined(senseReview, [
      'sense_id',
      'relation_decision',
    ]);
    const relationDecision = senseReview.relation_decision ?? senseReview.relation?.decision;
    if (relationDecision !== undefined) compact.relation_decision = relationDecision;
    const context = {
      record_id: reviewed.record_id,
      sense_id: senseReview.sense_id,
      gloss_sha256: senseReview.review_basis?.gloss_sha256,
    };
    compactTextField(compact, 'semantic_rationale', senseReview.semantic_rationale, context, rationaleRegistry);
    compactTextField(compact, 'boundary_rationale', senseReview.boundary_rationale, context, rationaleRegistry);
    compactTextField(compact, 'relation_rationale', senseReview.relation_rationale ?? senseReview.relation?.rationale, context, rationaleRegistry);
    compactTextField(
      compact,
      'no_relation_rationale',
      senseReview.no_relation_rationale ?? senseReview.relation?.no_relation_rationale,
      context,
      rationaleRegistry,
    );
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
  const rationaleRegistry = buildRationaleTemplateRegistry(review);
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
  const compact = {
    ...compactReview,
    contract_version: COMPACT_SEMANTIC_REVIEW_CONTRACT_VERSION,
    records: (review.records ?? []).map((record) => compactSemanticReviewRecord(record, { rationaleRegistry })),
  };
  if (rationaleRegistry.templates.length > 0) {
    compact.rationale_templates = rationaleRegistry.templates;
  } else {
    delete compact.rationale_templates;
  }
  return compact;
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

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Load authored batch sources used by canonical records that retain only an
 * immutable batch binding. The returned entries are deliberately generic so
 * the semantic validator can verify a reference without owning the batch's
 * candidate/admission policy.
 */
export async function readAuthoredBatchDecisionSources(
  sourcePaths = DEFAULT_AUTHORED_BATCH_DECISION_SOURCE_PATHS,
) {
  const sources = [];
  for (const sourcePath of sourcePaths) {
    const sourceBytes = await readFile(sourcePath);
    let source;
    try {
      source = JSON.parse(sourceBytes.toString('utf8'));
    } catch (error) {
      fail(`authored batch decision source is not valid JSON: ${sourcePath} (${error.message})`, 'SEMANTIC_BATCH_SOURCE_JSON');
    }
    if (!Array.isArray(source.decisions)) {
      fail(`authored batch decision source has no decisions: ${sourcePath}`, 'SEMANTIC_BATCH_SOURCE_SHAPE');
    }
    sources.push({
      source,
      sourcePath: path.relative(REPOSITORY_DIRECTORY, path.resolve(sourcePath)).split(path.sep).join('/'),
      sourceBytes,
      sourceSha256: sha256Bytes(sourceBytes),
      artifactSha256: source.artifact_sha256,
      rows: source.decisions,
      byCandidateId: new Map(source.decisions.map((row) => [row.candidate_record_id, row])),
    });
  }
  return sources;
}

function normalizeBatchDecisionSources(batchDecisionSources = []) {
  return batchDecisionSources.map((entry) => {
    const source = entry?.source?.source_id ? entry.source : entry;
    const rows = entry?.rows ?? source?.decisions ?? [];
    return {
      source,
      sourceId: source?.source_id,
      sourceSha256: entry?.sourceSha256
        ?? (entry?.sourceBytes ? sha256Bytes(entry.sourceBytes) : undefined),
      artifactSha256: entry?.artifactSha256 ?? source?.artifact_sha256,
      sourcePath: entry?.sourcePath,
      byCandidateId: entry?.byCandidateId instanceof Map
        ? entry.byCandidateId
        : new Map(rows.map((row) => [row.candidate_record_id, row])),
    };
  });
}

function resolveBatchDecision(record, binding, batchDecisionSources) {
  const source = batchDecisionSources.find(({ sourceId }) => sourceId === binding.source_id);
  if (!source) {
    fail(
      `${record.id} references an unavailable authored batch decision source ${binding.source_id}`,
      'SEMANTIC_AUDIT_BATCH_SOURCE_MISSING',
    );
  }
  if (source.sourceSha256 !== undefined && source.sourceSha256 !== binding.source_sha256) {
    fail(`${record.id} authored batch source bytes do not match its immutable binding`, 'SEMANTIC_AUDIT_BATCH_SOURCE_MISMATCH');
  }
  if (source.artifactSha256 !== undefined && source.artifactSha256 !== binding.artifact_sha256) {
    fail(`${record.id} authored batch artifact does not match its immutable binding`, 'SEMANTIC_AUDIT_BATCH_SOURCE_MISMATCH');
  }
  const row = source.byCandidateId.get(binding.candidate_record_id);
  if (!row) {
    fail(`${record.id} is missing its bound authored batch decision row`, 'SEMANTIC_AUDIT_BATCH_SOURCE_MISSING');
  }
  const sourceContract = source.source?.contract_version;
  const isGrandfathered = isGrandfatheredM512ADecisionSource({
    source: source.source,
    sourcePath: source.sourcePath,
    sourceSha256: source.sourceSha256,
    artifactSha256: source.artifactSha256,
  });
  if (!isGrandfathered) {
    if (sourceContract !== SOURCE_BOUND_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION
      || source.source?.review_binding_contract_version !== AUTHORED_SEMANTIC_REVIEW_BINDING_CONTRACT_VERSION) {
      fail(`${record.id} authored batch source must use the source-bound semantic decision contract`, 'SEMANTIC_AUDIT_BATCH_SOURCE_MISMATCH');
    }
    try {
      validateAuthoredSemanticReviewBinding(row, record);
    } catch (error) {
      fail(`${record.id} authored semantic review evidence is not bound to the reviewed candidate: ${error.message}`, 'SEMANTIC_AUDIT_BATCH_SOURCE_MISMATCH');
    }
  }
  const selectionBindingMatches = Object.hasOwn(binding, 'selection_axis')
    ? row.selection_axis === binding.selection_axis && !Object.hasOwn(binding, 'selection_score')
    : row.score === binding.selection_score;
  if (row.candidate_record_id !== record.id
    || row.candidate_record_sha256 !== binding.candidate_record_sha256
    || row.decision !== binding.decision
    || row.rank !== binding.selection_rank
    || !selectionBindingMatches
    || sha256Json(compactAuthoredSemanticDecisionRow(row)) !== binding.decision_row_sha256) {
    fail(`${record.id} authored batch decision row drifted from its canonical binding`, 'SEMANTIC_AUDIT_BATCH_SOURCE_MISMATCH');
  }
  return row;
}

function materializeBatchReviewRecord(
  record,
  storedRecord,
  binding,
  row,
  decisionSourceId,
  { hashCache } = {},
) {
  const storedSenseReviews = row.sense_reviews ?? [
    {
      ...row,
      sense_id: record.senses[0]?.id,
    },
  ];
  if (!Array.isArray(storedSenseReviews) || storedSenseReviews.length !== record.senses.length) {
    fail(`${record.id} authored batch row does not cover every canonical sense`, 'SEMANTIC_AUDIT_BATCH_SOURCE_SCOPE');
  }
  const storedSenseById = new Map(storedSenseReviews.map((senseReview) => [senseReview.sense_id, senseReview]));
  const firstSenseReview = storedSenseById.get(record.senses[0]?.id);
  if (!firstSenseReview) fail(`${record.id} authored batch row is missing its first sense review`, 'SEMANTIC_AUDIT_BATCH_SOURCE_SCOPE');
  const boundaryDecision = firstSenseReview.boundary_action;
  const boundaryClassification = firstSenseReview.boundary_classification;
  const boundaryReviewId = `${row.review_pass_id}:canonical:${record.id}:boundary`;
  const boundary = {
    status: 'pass',
    review_id: boundaryReviewId,
    method: SEMANTIC_BOUNDARY_METHOD,
    independence: {
      independent_of_sense_count: true,
      source: 'separate-agent-verification-pass',
      decision_source_version: SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION,
      inspected_fields: ['gloss', 'writer-facing-usage', 'pairwise-authored-decision'],
      decision_source_id: decisionSourceId,
    },
    decision: boundaryDecision,
    classification: boundaryClassification,
    reviewed_sense_ids: record.senses.map(({ id }) => id),
    evidence: record.senses.map((sense) => {
      const senseReview = storedSenseById.get(sense.id);
      if (!senseReview) fail(`${record.id} authored batch row is missing ${sense.id}`, 'SEMANTIC_AUDIT_BATCH_SOURCE_SCOPE');
      return {
        sense_id: sense.id,
        gloss_sha256: cachedSha256Json(sense.gloss, hashCache),
        evidence_basis: senseReview.semantic_rationale,
        rationale: senseReview.boundary_rationale,
        decision_source_id: decisionSourceId,
      };
    }),
    pairwise: (row.boundary_pairs ?? []).map((pair) => ({
      ...structuredClone(pair),
      decision_source_id: decisionSourceId,
    })),
    rationale: firstSenseReview.boundary_rationale,
  };
  const senseReviews = record.senses.map((sense) => {
    const storedSense = storedSenseById.get(sense.id);
    const relationCoverage = senseRelationCoverage(sense, { hashCache });
    if (!storedSense?.relation_decision) {
      fail(`${record.id} ${sense.id} authored relation decision is missing`, 'SEMANTIC_AUDIT_BATCH_SOURCE_SCOPE');
    }
    const relationRationale = storedSense.no_relation_rationale ?? storedSense.semantic_rationale;
    const senseGlossSha256 = cachedSha256Json(sense.gloss, hashCache);
    return {
      sense_id: sense.id,
      sense_sha256: cachedSha256Json(sense, hashCache),
      sense_boundary: {
        status: 'pass',
        action: boundaryDecision,
        classification: boundaryClassification,
        boundary_decision: boundarySenseDecisionForRecord(boundaryDecision, boundaryClassification),
        boundary_review_id: boundaryReviewId,
        reviewed_sense_ids: record.senses.map(({ id }) => id),
        rationale: storedSense.boundary_rationale,
        decision_source_id: decisionSourceId,
      },
      pos: {
        status: 'pass',
        observed_pos: sense.pos,
        rationale: `${record.id} ${sense.id} POS was verified from canonical content under the bound authored batch decision.`,
        decision: 'verified',
        decision_source_id: decisionSourceId,
      },
      expression: {
        status: 'pass',
        expected_record_type: record.record_type,
        observed_record_type: record.record_type,
        rationale: `${record.id} ${sense.id} record type was verified from canonical content under the bound authored batch decision.`,
        decision: 'verified',
        decision_source_id: decisionSourceId,
      },
      relation: {
        status: 'pass',
        decision: storedSense.relation_decision,
        relation_count: relationCoverage.relation_count,
        relation_sha256: relationCoverage.relation_sha256,
        relation_fingerprints: relationCoverage.relation_fingerprints,
        rationale: relationRationale,
        ...(relationCoverage.relation_count === 0
          ? { no_relation_rationale: storedSense.no_relation_rationale ?? relationRationale }
          : {}),
        decision_source_id: decisionSourceId,
      },
      review_basis: {
        record_id: record.id,
        sense_id: sense.id,
        lemma: record.lemma,
        gloss_sha256: senseGlossSha256,
        observed_domain_axes: cachedWriterDomainEvidence(sense.gloss, hashCache).axes,
        pos: sense.pos,
        record_type: record.record_type,
        relation_count: relationCoverage.relation_count,
        rationale: `${record.id} ${sense.id} reviewed gloss ${senseGlossSha256.slice(0, 12)} from the bound authored batch decision.`,
        decision_source_id: decisionSourceId,
        ...(storedSense.review_basis?.topic_analysis
          ? {
            topic_analysis: {
              ...structuredClone(storedSense.review_basis.topic_analysis),
              decision_source_id: decisionSourceId,
            },
          }
          : {}),
        ...(Array.isArray(storedSense.review_basis?.topic_analyses)
          ? {
            topic_analyses: storedSense.review_basis.topic_analyses.map((analysis) => ({
              ...structuredClone(analysis),
              decision_source_id: decisionSourceId,
            })),
          }
          : {}),
      },
    };
  });
  return {
    record_id: storedRecord.record_id,
    record_sha256: storedRecord.record_sha256,
    authored_batch_decision: structuredClone(binding),
    boundary_review: boundary,
    sense_reviews: senseReviews,
  };
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
  { decisionSourceId, batchDecisionSources = [], hashCache, onRecord } = {},
) {
  if (compactReview?.contract_version !== COMPACT_SEMANTIC_REVIEW_CONTRACT_VERSION) {
    return structuredClone(compactReview);
  }
  const canonicalRecords = recordInfos.map(recordOf);
  const compactRecords = compactReview.records ?? [];
  const recordsMatchCanonicalOrder = compactRecords.length === canonicalRecords.length
    && compactRecords.every((storedRecord, index) => storedRecord.record_id === canonicalRecords[index].id);
  const recordsById = recordsMatchCanonicalOrder
    ? undefined
    : new Map(canonicalRecords.map((record) => [record.id, record]));
  const sourceId = decisionSourceId ?? compactReview.decision_source?.source_id;
  const boundarySource = materializedBoundarySource(compactReview, sourceId);
  const normalizedBatchDecisionSources = normalizeBatchDecisionSources(batchDecisionSources);
  const rationaleTemplates = new Map(
    (compactReview.rationale_templates ?? []).map(({ code, template }) => [code, template]),
  );
  const reviewPassId = compactReview.review_pass?.id ?? compactReview.artifact_id ?? 'canonical-semantic-review';
  const records = compactRecords.map((storedRecord, recordIndex) => {
    const record = recordsMatchCanonicalOrder
      ? canonicalRecords[recordIndex]
      : recordsById.get(storedRecord.record_id);
    if (!record) {
      fail(
        `${compactReview.artifact_id ?? 'compact semantic review'}.records[${recordIndex}] is not canonical`,
        'SEMANTIC_AUDIT_SCOPE',
      );
    }
    const batchBinding = storedRecord.authored_batch_decision;
    const referencedRecord = batchBinding
      ? materializeBatchReviewRecord(
        record,
        storedRecord,
        batchBinding,
        resolveBatchDecision(record, batchBinding, normalizedBatchDecisionSources),
        sourceId,
        { hashCache },
      )
      : storedRecord;
    if (batchBinding && (storedRecord.boundary_review || storedRecord.sense_reviews)) {
      fail(
        `${record.id} must dereference its authored batch decision instead of copying its review narrative`,
        'SEMANTIC_AUDIT_REDUNDANT_AUTHORITY',
      );
    }
    const storedBoundary = referencedRecord.boundary_review ?? {};
    const boundaryReviewId = storedBoundary.review_id ?? `${reviewPassId}:${record.id}:boundary`;
    const boundaryEvidenceItems = storedBoundary.evidence ?? [];
    const evidenceMatchesSenseOrder = boundaryEvidenceItems.length === record.senses.length
      && boundaryEvidenceItems.every((item, senseIndex) => item.sense_id === record.senses[senseIndex].id);
    const evidenceBySense = evidenceMatchesSenseOrder
      ? undefined
      : new Map(boundaryEvidenceItems.map((item) => [item.sense_id, item]));
    const materializedEvidence = record.senses.map((sense, senseIndex) => {
      const item = (evidenceMatchesSenseOrder
        ? boundaryEvidenceItems[senseIndex]
        : evidenceBySense.get(sense.id)) ?? {};
      const glossSha256 = cachedSha256Json(sense.gloss, hashCache);
      const context = {
        record_id: record.id,
        sense_id: sense.id,
        gloss_sha256: item.gloss_sha256 ?? glossSha256,
      };
      return {
        sense_id: sense.id,
        gloss_sha256: glossSha256,
        evidence_basis: resolveTextField(item, 'evidence_basis', context, rationaleTemplates, `${record.id} ${sense.id} boundary evidence`),
        rationale: resolveTextField(item, 'rationale', context, rationaleTemplates, `${record.id} ${sense.id} boundary evidence`),
        decision_source_id: sourceId,
      };
    });
    const materializedPairwise = (storedBoundary.pairwise ?? []).map((item) => {
      const leftSense = record.senses.find(({ id }) => id === item.left_sense_id);
      const rightSense = record.senses.find(({ id }) => id === item.right_sense_id);
      const context = {
        record_id: record.id,
        left_sense_id: item.left_sense_id,
        right_sense_id: item.right_sense_id,
        left_gloss_sha256: item.left_gloss_sha256
          ?? (leftSense ? cachedSha256Json(leftSense.gloss, hashCache) : undefined),
        right_gloss_sha256: item.right_gloss_sha256
          ?? (rightSense ? cachedSha256Json(rightSense.gloss, hashCache) : undefined),
      };
      return {
        ...structuredClone(item),
        evidence_basis: resolveTextField(item, 'evidence_basis', context, rationaleTemplates, `${record.id} boundary pair`),
        distinguishing_feature: resolveTextField(item, 'distinguishing_feature', context, rationaleTemplates, `${record.id} boundary pair`),
        rationale: resolveTextField(item, 'rationale', context, rationaleTemplates, `${record.id} boundary pair`),
        left_gloss_sha256: context.left_gloss_sha256,
        right_gloss_sha256: context.right_gloss_sha256,
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
      rationale: resolveTextField(
        storedBoundary,
        'rationale',
        { record_id: record.id },
        rationaleTemplates,
        `${record.id} boundary review`,
      ),
    };
    const storedSenseReviews = referencedRecord.sense_reviews ?? [];
    const senseReviewsMatchSenseOrder = storedSenseReviews.length === record.senses.length
      && storedSenseReviews.every((item, senseIndex) => item.sense_id === record.senses[senseIndex].id);
    const storedSenseById = senseReviewsMatchSenseOrder
      ? undefined
      : new Map(storedSenseReviews.map((item) => [item.sense_id, item]));
    const senseReviews = record.senses.map((sense, senseIndex) => {
      const rawStoredSense = (senseReviewsMatchSenseOrder
        ? storedSenseReviews[senseIndex]
        : storedSenseById.get(sense.id)) ?? {};
      const senseContext = {
        record_id: record.id,
        sense_id: sense.id,
        gloss_sha256: cachedSha256Json(sense.gloss, hashCache),
      };
      const storedSense = {
        ...rawStoredSense,
        semantic_rationale: resolveTextField(rawStoredSense, 'semantic_rationale', senseContext, rationaleTemplates, `${record.id} ${sense.id}`),
        boundary_rationale: resolveTextField(rawStoredSense, 'boundary_rationale', senseContext, rationaleTemplates, `${record.id} ${sense.id}`),
        relation_rationale: resolveTextField(rawStoredSense, 'relation_rationale', senseContext, rationaleTemplates, `${record.id} ${sense.id}`),
        no_relation_rationale: resolveTextField(rawStoredSense, 'no_relation_rationale', senseContext, rationaleTemplates, `${record.id} ${sense.id}`),
      };
      const storedBasis = storedSense.review_basis ?? {};
      const senseGlossSha256 = cachedSha256Json(sense.gloss, hashCache);
      const relationCoverage = senseRelationCoverage(sense, { hashCache });
      const relationDecision = storedSense.relation_decision ?? storedSense.relation?.decision;
      if (relationDecision === undefined) {
        fail(`${record.id} ${sense.id} authored relation decision is missing`, 'SEMANTIC_AUDIT_DECISION_MISSING');
      }
      const boundaryEvidenceItem = evidenceMatchesSenseOrder
        ? boundaryEvidenceItems[senseIndex]
        : evidenceBySense.get(sense.id);
      const boundaryRationale = storedSense.boundary_rationale
        ?? boundaryEvidenceItem?.rationale
        ?? `${record.id} ${sense.id} was reviewed against the authored boundary decision.`;
      const relationRationale = storedSense.relation_rationale
        ?? storedSense.no_relation_rationale
        ?? `${record.id} ${sense.id} relation tuples were reviewed against canonical content.`;
      return {
        sense_id: sense.id,
        sense_sha256: cachedSha256Json(sense, hashCache),
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
          observed_domain_axes: cachedWriterDomainEvidence(sense.gloss, hashCache).axes,
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
    const materializedRecord = {
      record_id: referencedRecord.record_id,
      record_sha256: referencedRecord.record_sha256,
      ...(referencedRecord.authored_batch_decision
        ? { authored_batch_decision: structuredClone(referencedRecord.authored_batch_decision) }
        : {}),
      boundary_review: boundaryReview,
      sense_reviews: senseReviews,
    };
    onRecord?.({
      record,
      materializedRecord,
      recordIndex,
      boundaryReview,
      senseReviews,
    });
    return materializedRecord;
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
  // The compact source can contain hundreds of thousands of record bindings
  // during scale validation. Clone only the review metadata here; cloning the
  // compact `records` array before immediately replacing it duplicates the
  // entire corpus and adds avoidable O(N) memory pressure. Preserve the source
  // key order by placing the materialized records at the compact records key.
  const reviewWithoutRationaleTemplates = {};
  for (const [key, value] of Object.entries(compactReview)) {
    if (key === 'rationale_templates') continue;
    reviewWithoutRationaleTemplates[key] = key === 'records'
      ? records
      : structuredClone(value);
  }
  return {
    ...reviewWithoutRationaleTemplates,
    contract_version: SEMANTIC_REVIEW_CONTRACT_VERSION,
    record_count: records.length,
    sense_count: senseCount,
    review_pass: materializedReviewPass,
    records,
  };
}

function relationFingerprint(sourceSenseId, relation, { hashCache } = {}) {
  return cachedSha256Json({
    source_sense: sourceSenseId,
    target: relation.target,
    target_sense: relation.target_sense ?? null,
    type: relation.type,
    note: relation.note,
  }, hashCache);
}

function senseRelationCoverage(sense, { hashCache } = {}) {
  if (hashCache?.relationCoverage instanceof WeakMap) {
    const cached = hashCache.relationCoverage.get(sense);
    if (cached) return cached;
  }
  const relations = sense.relations ?? [];
  const coverage = {
    relation_count: relations.length,
    relation_sha256: cachedSha256Json({
      source_sense: sense.id,
      relations,
    }, hashCache),
    relation_fingerprints: relations.map((relation) => relationFingerprint(sense.id, relation, { hashCache })),
  };
  if (hashCache?.relationCoverage instanceof WeakMap) hashCache.relationCoverage.set(sense, coverage);
  return coverage;
}

function buildSenseCoverage(record, sense, { hashCache } = {}) {
  const domainEvidence = cachedWriterDomainEvidence(sense.gloss, hashCache);
  return {
    sense_id: sense.id,
    sense_sha256: cachedSha256Json(sense, hashCache),
    content: {
      gloss_sha256: cachedSha256Json(sense.gloss, hashCache),
      observed_domain_axes: domainEvidence.axes,
      domain_evidence: domainEvidence.matches,
      connector_observations: cachedGlossConnectors(sense.gloss, hashCache),
      pos: sense.pos,
      record_type: record.record_type,
      ...senseRelationCoverage(sense, { hashCache }),
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
  { artifactId = 'canonical-semantic-coverage', hashCache } = {},
) {
  const records = orderedRecordInfosFor(recordInfos, hashCache).map(recordOf);
  return {
    schema_version: SEMANTIC_AUDIT_SCHEMA_VERSION,
    contract_version: SEMANTIC_COVERAGE_CONTRACT_VERSION,
    artifact_id: artifactId,
    scope: 'complete-canonical',
    lexical_quality_ruleset_version: LEXICAL_QUALITY_RULESET_VERSION,
    source: {
      kind: 'canonical-jsonl-record-values',
      canonical_records_sha256: canonicalDigestFor(recordInfos, hashCache),
    },
    record_count: records.length,
    sense_count: records.reduce((sum, record) => sum + record.senses.length, 0),
    records: records.map((record) => ({
      record_id: record.id,
      record_sha256: cachedSha256Json(record, hashCache),
      lemma: record.lemma,
      record_type: record.record_type,
      role: record.role,
      sense_coverage: record.senses.map((sense) => buildSenseCoverage(record, sense, { hashCache })),
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
  { artifactId = 'canonical-semantic-audit', hashCache } = {},
) {
  requireObject(semanticReview, 'semantic review artifact');
  const decisionSource = validateDecisionSourceMetadata(
    semanticReview,
    'semantic review artifact',
  );
  const canonicalDigest = canonicalDigestFor(recordInfos, hashCache);
  if (semanticReview.source?.canonical_records_sha256 !== canonicalDigest) {
    fail('semantic review artifact is not bound to the supplied canonical records', 'SEMANTIC_AUDIT_SOURCE_MISMATCH');
  }
  const coverage = buildSemanticCoverageArtifact(recordInfos, { hashCache });
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
  {
    artifactId = 'canonical-semantic-audit',
    baseRecords,
    batchDecisionSources = [],
    hashCache = createCanonicalAuditCache(recordInfos),
  } = {},
) {
  const semanticReview = validateSemanticDecisionSource(
    recordInfos,
    decisionSource,
    {
      baseRecords: baseRecords ?? recordInfos,
      label: 'semantic decision source',
      batchDecisionSources,
      hashCache,
    },
  );
  const artifact = assembleSemanticAuditArtifact(recordInfos, semanticReview, {
    artifactId,
    hashCache,
  });
  // `validateSemanticDecisionSource` has already validated every authored
  // review binding.  The coverage envelope is generated directly from the
  // same canonical records here, so validating that newly constructed
  // projection again would repeat the complete review and coverage scan.
  // Consumers that accept a serialized or externally supplied audit still use
  // `validateSemanticAuditCoverage` at their boundary.
  return artifact;
}

export async function buildCanonicalSemanticAudit({
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  canonicalContext,
  decisionSourcePath = DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
  decisionSource: suppliedDecisionSource,
  hashCache: suppliedHashCache,
  artifactId = 'canonical-semantic-audit',
  batchDecisionSourcePaths = DEFAULT_AUTHORED_BATCH_DECISION_SOURCE_PATHS,
} = {}) {
  const context = canonicalContext ?? await loadCanonicalContext({
    directory: canonicalDirectory,
  });
  const canonical = {
    fileCount: context.fileCount,
    records: context.records,
  };
  const canReuseMaterializedArtifact = Boolean(
    suppliedDecisionSource === undefined
      && context.semanticAudit
      && artifactId === 'canonical-semantic-audit'
      && path.resolve(decisionSourcePath) === path.resolve(DEFAULT_SEMANTIC_DECISION_SOURCE_PATH)
      && JSON.stringify(batchDecisionSourcePaths) === JSON.stringify(DEFAULT_AUTHORED_BATCH_DECISION_SOURCE_PATHS),
  );
  if (canReuseMaterializedArtifact) {
    return {
      canonical,
      decisionSource: context.semanticDecisionSource,
      artifact: context.semanticAudit,
    };
  }

  const decisionSource = suppliedDecisionSource
    ?? await readSemanticDecisionSourceArtifact(decisionSourcePath);
  const batchDecisionSources = suppliedDecisionSource
    ? []
    : await readAuthoredBatchDecisionSources(batchDecisionSourcePaths);
  const hashCache = isCanonicalAuditCache(suppliedHashCache, canonical.records)
    ? suppliedHashCache
    : createCanonicalAuditCache(canonical.records);
  const artifact = buildSemanticAuditFromDecisionSource(
    canonical.records,
    decisionSource,
    { artifactId, batchDecisionSources, hashCache },
  );
  context.semanticAuditCache = hashCache;
  return { canonical, decisionSource, artifact };
}

export function serializeSemanticAuditArtifact(artifact) {
  return Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

export function serializeSemanticDecisionSource(decisionSource) {
  return Buffer.from(`${JSON.stringify(decisionSource, null, 2)}\n`, 'utf8');
}

function valuesExactlyEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => valuesExactlyEqual(value, right[index]));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.hasOwn(right, key) && valuesExactlyEqual(left[key], right[key]));
  }
  return false;
}

function assertExact(actual, expected, label, code = 'SEMANTIC_AUDIT_BINDING') {
  if (!valuesExactlyEqual(actual, expected)) {
    fail(`${label} does not match the canonical source`, code);
  }
}

function validateCoverageSense(record, sense, coverage, senseIndex, label, { hashCache } = {}) {
  requireObject(coverage, label);
  if (coverage.sense_id !== sense.id) fail(`${label}.sense_id is not bound`, 'SEMANTIC_AUDIT_BINDING');
  requireDigest(coverage.sense_sha256, `${label}.sense_sha256`);
  if (coverage.sense_sha256 !== cachedSha256Json(sense, hashCache)) {
    fail(`${label}.sense_sha256 does not match the canonical sense`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }

  const content = requireObject(coverage.content, `${label}.content`);
  requireDigest(content.gloss_sha256, `${label}.content.gloss_sha256`);
  if (content.gloss_sha256 !== cachedSha256Json(sense.gloss, hashCache)) {
    fail(`${label}.content.gloss_sha256 does not match the canonical gloss`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  const domainEvidence = cachedWriterDomainEvidence(sense.gloss, hashCache);
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
    cachedGlossConnectors(sense.gloss, hashCache),
    `${label}.content.connector_observations`,
    'SEMANTIC_AUDIT_CONTENT_MISMATCH',
  );
  if (content.pos !== sense.pos || content.record_type !== record.record_type) {
    fail(`${label}.content POS or record type does not match the canonical source`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  const expectedRelations = senseRelationCoverage(sense, { hashCache });
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

function validateSemanticCoverageArtifact(recordInfos, artifact, label, { hashCache } = {}) {
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
  const expectedCanonicalDigest = canonicalDigestFor(recordInfos, hashCache);
  if (source.canonical_records_sha256 !== expectedCanonicalDigest) {
    fail(`${label}.source.canonical_records_sha256 does not match the complete canonical input`, 'SEMANTIC_AUDIT_SOURCE_MISMATCH');
  }

  const records = orderedRecordInfosFor(recordInfos, hashCache).map(recordOf);
  if (artifact.record_count !== records.length) fail(`${label}.record_count does not cover the complete canonical input`, 'SEMANTIC_AUDIT_SCOPE');
  const expectedSenseCount = records.reduce((sum, record) => sum + record.senses.length, 0);
  if (artifact.sense_count !== expectedSenseCount) fail(`${label}.sense_count does not cover every canonical sense`, 'SEMANTIC_AUDIT_SCOPE');
  const auditedRecords = requireArray(artifact.records, `${label}.records`);
  if (auditedRecords.length !== records.length) fail(`${label}.records must cover every canonical record`, 'SEMANTIC_AUDIT_SCOPE');

  const auditedRecordsMatchCanonicalOrder = auditedRecords.every(
    (audited, recordIndex) => audited?.record_id === records[recordIndex].id,
  );
  const auditedById = auditedRecordsMatchCanonicalOrder ? undefined : new Map();
  if (auditedById) {
    const recordIds = new Set();
    for (const [recordIndex, auditedValue] of auditedRecords.entries()) {
      const recordLabel = `${label}.records[${recordIndex}]`;
      const audited = requireObject(auditedValue, recordLabel);
      if (recordIds.has(audited.record_id)) fail(`${label} contains duplicate record ${audited.record_id}`, 'SEMANTIC_AUDIT_SCOPE');
      recordIds.add(audited.record_id);
      auditedById.set(audited.record_id, { audited, recordLabel });
    }
  }
  for (const [recordIndex, record] of records.entries()) {
    const recordLabel = `${label}.records[${recordIndex}]`;
    const auditedEntry = auditedRecordsMatchCanonicalOrder
      ? { audited: requireObject(auditedRecords[recordIndex], recordLabel), recordLabel }
      : auditedById.get(record.id);
    if (!auditedEntry) fail(`${label} is missing record ${record.id}`, 'SEMANTIC_AUDIT_SCOPE');
    const { audited, recordLabel: auditedRecordLabel } = auditedEntry;
    requireDigest(audited.record_sha256, `${auditedRecordLabel}.record_sha256`);
    if (audited.record_sha256 !== cachedSha256Json(record, hashCache)) fail(`${auditedRecordLabel}.record_sha256 does not match canonical content`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
    if (audited.lemma !== record.lemma
      || audited.record_type !== record.record_type
      || audited.role !== record.role) {
      fail(`${auditedRecordLabel} record identity facts drifted`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
    }
    const senseCoverage = requireArray(audited.sense_coverage, `${auditedRecordLabel}.sense_coverage`);
    if (senseCoverage.length !== record.senses.length) fail(`${auditedRecordLabel}.sense_coverage must cover every sense`, 'SEMANTIC_AUDIT_SCOPE');
    for (const [senseIndex, sense] of record.senses.entries()) {
      validateCoverageSense(
        record,
        sense,
        senseCoverage[senseIndex],
        senseIndex,
        `${auditedRecordLabel}.sense_coverage[${senseIndex}]`,
        { hashCache },
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
  { decisionSourceId, requireDecisionSource = true, hashCache } = {},
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
    if (item.gloss_sha256 !== cachedSha256Json(sense.gloss, hashCache)) {
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
    if (item.left_gloss_sha256 !== cachedSha256Json(leftSense.gloss, hashCache)
      || item.right_gloss_sha256 !== cachedSha256Json(rightSense.gloss, hashCache)) {
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
    hashCache,
  } = {},
) {
  requireObject(review, label);
  if (review.sense_id !== sense.id) fail(`${label}.sense_id is not bound`, 'SEMANTIC_AUDIT_BINDING');
  requireDigest(review.sense_sha256, `${label}.sense_sha256`);
  if (review.sense_sha256 !== cachedSha256Json(sense, hashCache)) {
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
  const expectedRelations = senseRelationCoverage(sense, { hashCache });
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
  if (basis.gloss_sha256 !== cachedSha256Json(sense.gloss, hashCache)) {
    fail(`${label}.review_basis.gloss_sha256 does not bind the canonical gloss`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  if (basis.pos !== sense.pos || basis.record_type !== record.record_type) {
    fail(`${label}.review_basis POS or record type does not bind the canonical source`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  const basisDomainEvidence = cachedWriterDomainEvidence(sense.gloss, hashCache);
  assertExact(
    basis.observed_domain_axes,
    basisDomainEvidence.axes,
    `${label}.review_basis.observed_domain_axes`,
    'SEMANTIC_AUDIT_CONTENT_MISMATCH',
  );
  const basisRelations = senseRelationCoverage(sense, { hashCache });
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

function validateSemanticReviewPass(recordInfos, artifact, label, { hashCache } = {}) {
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
  // The common complete-canonical pass has no correction history.  Avoid
  // rebuilding a million-entry record map when there are no correction rows
  // that can consult it; corrected historical inputs still use the indexed
  // path below.
  const recordsById = history.length > 0
    ? new Map(records.map((record) => [record.id, record]))
    : undefined;
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
    if (lastCorrection.after_record_sha256 !== cachedSha256Json(record, hashCache)) {
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

function validateSemanticReviewChanges(recordInfos, baseRecords, changes, label, { hashCache } = {}) {
  const changeRows = requireArray(changes, `${label}.changes`);
  if ((baseRecords === undefined || baseRecords === recordInfos) && changeRows.length === 0) {
    return 0;
  }
  const records = orderCanonicalRecordInfos(recordInfos).map(recordOf);
  const base = (baseRecords ?? recordInfos).map(recordOf);
  const prospectiveById = new Map(records.map((record) => [record.id, record]));
  const baseById = new Map(base.map((record) => [record.id, record]));
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
    if (change.base_record_sha256 !== cachedSha256Json(baseRecord, hashCache)
      || change.prospective_record_sha256 !== cachedSha256Json(prospectiveRecord, hashCache)
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

function validateSemanticReviewRecord(
  record,
  audited,
  recordLabel,
  {
    decisionSourceId,
    requireDecisionSource = true,
    requireTopicAnalysis = true,
    hashCache,
  } = {},
) {
  const reviewedRecord = requireObject(audited, recordLabel);
  requireDigest(reviewedRecord.record_sha256, `${recordLabel}.record_sha256`);
  if (reviewedRecord.record_sha256 !== cachedSha256Json(record, hashCache)) {
    fail(`${recordLabel}.record_sha256 does not match canonical content`, 'SEMANTIC_AUDIT_CONTENT_MISMATCH');
  }
  const boundaryReview = validateBoundaryReview(
    record,
    reviewedRecord.boundary_review,
    `${recordLabel}.boundary_review`,
    {
      decisionSourceId,
      requireDecisionSource,
      hashCache,
    },
  );
  const senseReviews = requireArray(reviewedRecord.sense_reviews, `${recordLabel}.sense_reviews`);
  if (senseReviews.length !== record.senses.length) {
    fail(`${recordLabel}.sense_reviews must cover every sense`, 'SEMANTIC_AUDIT_SCOPE');
  }
  for (const [senseIndex, sense] of record.senses.entries()) {
    validateSemanticReviewSense(
      record,
      sense,
      senseReviews[senseIndex],
      senseIndex,
      `${recordLabel}.sense_reviews[${senseIndex}]`,
      boundaryReview,
      {
        decisionSourceId,
        requireDecisionSource,
        requireTopicAnalysis,
        hashCache,
      },
    );
  }
  return { boundaryReview, senseReviews };
}

function validateCompactSemanticReviewEnvelope(
  recordInfos,
  artifact,
  label,
  { decisionSourceId, requireDecisionSource = true, hashCache } = {},
) {
  requireObject(artifact, label);
  if (artifact.schema_version !== SEMANTIC_AUDIT_SCHEMA_VERSION
    || artifact.contract_version !== COMPACT_SEMANTIC_REVIEW_CONTRACT_VERSION) {
    fail(`${label} contract version is unsupported`, 'SEMANTIC_AUDIT_SCHEMA');
  }
  if (artifact.scope !== 'complete-canonical') fail(`${label}.scope must be complete-canonical`, 'SEMANTIC_AUDIT_SCOPE');
  if (artifact.review_mode !== 'agent-authored-decision') {
    fail(`${label}.review_mode must be agent-authored-decision`, 'SEMANTIC_AUDIT_PROVENANCE');
  }
  const decisionSource = requireDecisionSource
    ? validateDecisionSourceMetadata(artifact, label)
    : artifact.decision_source;
  if (decisionSourceId !== undefined && decisionSource?.source_id !== decisionSourceId) {
    fail(`${label}.decision_source is not bound to the outer decision source`, 'SEMANTIC_AUDIT_PROVENANCE');
  }
  const records = recordInfos.map(recordOf);
  const expectedCanonicalDigest = canonicalDigestFor(recordInfos, hashCache);
  const source = requireObject(artifact.source, `${label}.source`);
  if (source.kind !== 'canonical-jsonl-record-values') {
    fail(`${label}.source.kind is unsupported`, 'SEMANTIC_AUDIT_PROVENANCE');
  }
  requireDigest(source.canonical_records_sha256, `${label}.source.canonical_records_sha256`);
  if (source.canonical_records_sha256 !== expectedCanonicalDigest) {
    fail(`${label}.source.canonical_records_sha256 does not match the complete canonical input`, 'SEMANTIC_AUDIT_SOURCE_MISMATCH');
  }
  const compactRecords = requireArray(artifact.records, `${label}.records`);
  if (compactRecords.length !== records.length) {
    fail(`${label}.records must cover every canonical record`, 'SEMANTIC_AUDIT_SCOPE');
  }
  const recordsMatchCanonicalOrder = compactRecords.every(
    (storedRecord, recordIndex) => storedRecord?.record_id === records[recordIndex].id,
  );
  const canonicalIds = recordsMatchCanonicalOrder
    ? undefined
    : new Set(records.map((record) => record.id));
  const seenIds = recordsMatchCanonicalOrder ? undefined : new Set();
  for (const [recordIndex, compactRecord] of compactRecords.entries()) {
    const recordLabel = `${label}.records[${recordIndex}]`;
    const storedRecord = requireObject(compactRecord, recordLabel);
    requireString(storedRecord.record_id, `${recordLabel}.record_id`);
    if (canonicalIds && !canonicalIds.has(storedRecord.record_id)) {
      fail(`${recordLabel}.record_id is not canonical`, 'SEMANTIC_AUDIT_SCOPE');
    }
    if (seenIds?.has(storedRecord.record_id)) {
      fail(`${label} contains duplicate record ${storedRecord.record_id}`, 'SEMANTIC_AUDIT_SCOPE');
    }
    seenIds?.add(storedRecord.record_id);
  }
  return {
    decisionSource,
    canonicalRecords: records,
    canonicalRecordsSha256: expectedCanonicalDigest,
  };
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
    hashCache,
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
  validateSemanticReviewPass(recordInfos, artifact, label, { hashCache });
  const records = recordInfos.map(recordOf);
  const expectedCanonicalDigest = canonicalDigestFor(recordInfos, hashCache);
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

  const auditedRecordsMatchCanonicalOrder = auditedRecords.every(
    (audited, recordIndex) => audited?.record_id === records[recordIndex].id,
  );
  const auditedById = auditedRecordsMatchCanonicalOrder
    ? undefined
    : new Map();
  if (auditedById) {
    const recordIds = new Set();
    for (const [recordIndex, auditedValue] of auditedRecords.entries()) {
      const recordLabel = `${label}.records[${recordIndex}]`;
      const audited = requireObject(auditedValue, recordLabel);
      if (recordIds.has(audited.record_id)) fail(`${label} contains duplicate record ${audited.record_id}`, 'SEMANTIC_AUDIT_SCOPE');
      recordIds.add(audited.record_id);
      auditedById.set(audited.record_id, { audited, recordLabel });
    }
  }
  for (const [recordIndex, record] of records.entries()) {
    const recordLabel = `${label}.records[${recordIndex}]`;
    const auditedEntry = auditedRecordsMatchCanonicalOrder
      ? { audited: requireObject(auditedRecords[recordIndex], recordLabel), recordLabel }
      : auditedById.get(record.id);
    if (!auditedEntry) fail(`${label} is missing record ${record.id}`, 'SEMANTIC_AUDIT_SCOPE');
    validateSemanticReviewRecord(record, auditedEntry.audited, recordLabel, {
      decisionSourceId: decisionSource?.source_id,
      requireDecisionSource,
      requireTopicAnalysis,
      hashCache,
    });
  }
  const correctedRecordCount = validateSemanticReviewChanges(
    recordInfos,
    baseRecords,
    artifact.changes,
    label,
    { hashCache },
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
  {
    baseRecords,
    label = 'semantic decision source',
    batchDecisionSources = [],
    hashCache,
  } = {},
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
  const expectedCanonicalDigest = canonicalDigestFor(recordInfos, hashCache);
  requireDigest(source.canonical_records_sha256, `${label}.source.canonical_records_sha256`);
  if (source.canonical_records_sha256 !== expectedCanonicalDigest) {
    fail(`${label}.source.canonical_records_sha256 does not match the complete canonical input`, 'SEMANTIC_AUDIT_SOURCE_MISMATCH');
  }
  const authoredReview = requireObject(decisionSource.authored_review, `${label}.authored_review`);
  requireDigest(decisionSource.authored_review_sha256, `${label}.authored_review_sha256`);
  if (decisionSource.authored_review_sha256 !== cachedSha256Json(authoredReview, hashCache)) {
    fail(`${label}.authored_review_sha256 does not match the authored review`, 'SEMANTIC_AUDIT_SOURCE_MISMATCH');
  }
  const authoredMetadata = validateDecisionSourceMetadata(authoredReview, `${label}.authored_review`);
  if (authoredMetadata.source_id !== decisionSource.source_id
    || authoredMetadata.contract_version !== SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION) {
    fail(`${label}.authored_review is not bound to this decision source`, 'SEMANTIC_AUDIT_PROVENANCE');
  }
  if (!isCompactSemanticDecisionSource(decisionSource)) {
    validateSemanticReviewArtifact(recordInfos, authoredReview, {
      baseRecords,
      label: `${label}.authored_review`,
      hashCache,
    });
    return authoredReview;
  }

  const authoredReviewLabel = `${label}.authored_review`;
  validateCompactSemanticReviewEnvelope(
    recordInfos,
    authoredReview,
    authoredReviewLabel,
    {
      decisionSourceId: decisionSource.source_id,
      hashCache,
    },
  );
  const materializedReview = materializeSemanticReviewArtifact(recordInfos, authoredReview, {
    decisionSourceId: decisionSource.source_id,
    batchDecisionSources,
    hashCache,
    onRecord: ({ record, materializedRecord, recordIndex }) => {
      validateSemanticReviewRecord(
        record,
        materializedRecord,
        `${authoredReviewLabel}.records[${recordIndex}]`,
        {
          decisionSourceId: decisionSource.source_id,
          hashCache,
        },
      );
    },
  });
  validateSemanticReviewPass(recordInfos, materializedReview, authoredReviewLabel, { hashCache });
  validateSemanticReviewChanges(
    recordInfos,
    baseRecords,
    materializedReview.changes,
    authoredReviewLabel,
    { hashCache },
  );
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
    hashCache,
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
  const expectedCanonicalDigest = canonicalDigestFor(recordInfos, hashCache);
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
  const coverageResult = validateSemanticCoverageArtifact(recordInfos, coverage, `${label}.coverage`, { hashCache });
  const reviewResult = validateSemanticReviewArtifact(recordInfos, review, {
    baseRecords,
    label: `${label}.review`,
    requireDecisionSource,
    requireTopicAnalysis,
    hashCache,
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
  { label = 'semantic audit', requireTopicAnalysis = true, hashCache } = {},
) {
  requireObject(artifact, label);
  const review = requireObject(artifact.review, `${label}.review`);
  const expectedCanonicalDigest = canonicalDigestFor(recordInfos, hashCache);
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
  const reviewedRecordsMatchCanonicalOrder = reviewedRecords.length === recordInfos.length
    && reviewedRecords.every(
      (reviewed, recordIndex) => reviewed?.record_id === recordOf(recordInfos[recordIndex]).id,
    );
  const reviewedById = reviewedRecordsMatchCanonicalOrder
    ? undefined
    : new Map(reviewedRecords.map((reviewed) => [reviewed.record_id, reviewed]));
  const bySense = new Map();

  for (const [recordIndex, recordInfo] of recordInfos.entries()) {
    const record = recordOf(recordInfo);
    const reviewed = reviewedRecordsMatchCanonicalOrder
      ? reviewedRecords[recordIndex]
      : reviewedById.get(record.id);
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
