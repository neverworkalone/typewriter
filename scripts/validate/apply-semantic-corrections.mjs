import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from './canonical-jsonl.mjs';
import {
  DEFAULT_SEMANTIC_AUDIT_PATH,
  DEFAULT_SEMANTIC_BOUNDARY_DECISIONS_PATH,
  DEFAULT_SEMANTIC_COVERAGE_PATH,
  DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
  SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION,
  SEMANTIC_BOUNDARY_METHOD,
  canonicalRecordsSha256,
  sha256Json,
} from './semantic-audit.mjs';
import { inspectWriterDomainEvidence } from './lexical-quality.mjs';
import { rebuildSemanticEvidence } from './rebuild-semantic-evidence.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CORRECTION_MANIFEST_CONTRACT_VERSION = 'lexical-semantic-correction-manifest-v1';

function fail(message) {
  const error = new Error(message);
  error.code = 'SEMANTIC_CORRECTION_INPUT';
  throw error;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) fail(`invalid JSON at ${filePath}: ${error.message}`);
    throw error;
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function requireDigest(value, label) {
  requireString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(value)) fail(`${label} must be a SHA-256 digest`);
  return value;
}

// Keep the semantic decision source acyclic with the output digests that bind
// the correction manifest. The correction rows are the authored decision
// payload; hashing only that payload lets the audit cite its source without
// making the manifest and rebuilt audit hash each other recursively.
function correctionDecisionDigest(manifest) {
  return sha256Json({
    contract_version: manifest.contract_version,
    source_revision: manifest.source_revision,
    corrections: manifest.corrections,
  });
}

function relationCoverage(sense) {
  const relations = sense.relations ?? [];
  return {
    relation_count: relations.length,
    relation_sha256: sha256Json({
      source_sense: sense.id,
      relations,
    }),
    relation_fingerprints: relations.map((relation) => sha256Json({
      source_sense: sense.id,
      target: relation.target,
      target_sense: relation.target_sense ?? null,
      type: relation.type,
      note: relation.note,
    })),
  };
}

function validateCorrectionDecisionEvidence(correction, record, decisionSourceId) {
  const semanticReview = correction.semantic_review;
  if (!semanticReview || typeof semanticReview !== 'object' || Array.isArray(semanticReview)) {
    fail(`${record.id} is missing explicit semantic decision evidence`);
  }
  if (semanticReview.decision_source_id !== decisionSourceId) {
    fail(`${record.id} semantic decision evidence is not bound to the authored decision source`);
  }
  const boundary = semanticReview.boundary;
  if (!boundary || typeof boundary !== 'object' || Array.isArray(boundary)) {
    fail(`${record.id} is missing explicit boundary decision evidence`);
  }
  requireString(boundary.review_id, `${record.id}.semantic_review.boundary.review_id`);
  if (boundary.method !== SEMANTIC_BOUNDARY_METHOD) {
    fail(`${record.id} correction boundary evidence must use the independent pairwise boundary method`);
  }
  const independence = boundary.independence;
  if (!independence || typeof independence !== 'object' || Array.isArray(independence)
    || independence.independent_of_sense_count !== true
    || independence.decision_source_id !== decisionSourceId
    || independence.decision_source_version !== SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION) {
    fail(`${record.id} correction boundary evidence must explicitly bind an independent authored decision source`);
  }
  requireString(independence.source, `${record.id}.semantic_review.boundary.independence.source`);
  if (!Array.isArray(boundary.pairwise) || boundary.pairwise.length !== 0) {
    fail(`${record.id} corrected boundary evidence must explicitly contain no unresolved pairwise findings`);
  }
  if (boundary.decision !== 'retain'
    || boundary.action !== 'retain'
    || boundary.classification !== 'atomic'
    || boundary.boundary_decision !== 'atomic') {
    fail(`${record.id} correction boundary evidence must explicitly resolve to one atomic retained sense`);
  }
  const expectedSenseIds = record.senses.map(({ id }) => id);
  if (JSON.stringify(boundary.reviewed_sense_ids) !== JSON.stringify(expectedSenseIds)) {
    fail(`${record.id} correction boundary evidence must cover the exact repaired sense set`);
  }
  requireString(boundary.rationale, `${record.id}.semantic_review.boundary.rationale`);
  if (!boundary.rationale.includes(record.id)) fail(`${record.id} boundary rationale must identify the record`);
  if (!Array.isArray(boundary.evidence) || boundary.evidence.length !== record.senses.length) {
    fail(`${record.id} correction boundary evidence must contain one authored row per repaired sense`);
  }
  const boundaryEvidenceBySense = new Map();
  for (const [index, item] of boundary.evidence.entries()) {
    const label = `${record.id}.semantic_review.boundary.evidence[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${label} must be an object`);
    if (boundaryEvidenceBySense.has(item.sense_id)) fail(`${label}.sense_id is duplicated`);
    const sense = record.senses.find(({ id }) => id === item.sense_id);
    if (!sense) fail(`${label}.sense_id is not a repaired canonical sense`);
    requireString(item.evidence_basis, `${label}.evidence_basis`);
    requireString(item.rationale, `${label}.rationale`);
    const glossSha256 = sha256Json(sense.gloss);
    if (!item.rationale.includes(record.id)
      || !item.rationale.includes(item.sense_id)
      || !item.rationale.includes(glossSha256.slice(0, 12))) {
      fail(`${label}.rationale must cite record, sense, and repaired gloss evidence`);
    }
    if (item.gloss_sha256 !== glossSha256 || item.decision_source_id !== decisionSourceId) {
      fail(`${label} must bind the exact repaired gloss and authored decision source`);
    }
    boundaryEvidenceBySense.set(item.sense_id, item);
  }
  if (boundaryEvidenceBySense.size !== record.senses.length) {
    fail(`${record.id} correction boundary evidence does not cover every repaired sense`);
  }

  if (!Array.isArray(semanticReview.senses) || semanticReview.senses.length !== record.senses.length) {
    fail(`${record.id} correction semantic evidence must contain one authored row per repaired sense`);
  }
  const senseEvidenceById = new Map();
  for (const [index, item] of semanticReview.senses.entries()) {
    const label = `${record.id}.semantic_review.senses[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${label} must be an object`);
    if (senseEvidenceById.has(item.sense_id)) fail(`${label}.sense_id is duplicated`);
    const sense = record.senses.find(({ id }) => id === item.sense_id);
    if (!sense) fail(`${label}.sense_id is not a repaired canonical sense`);
    const pos = item.pos;
    if (!pos || pos.decision !== 'verified' || pos.observed_pos !== sense.pos) {
      fail(`${label}.pos must contain an explicit verified decision for the canonical POS`);
    }
    requireString(pos.rationale, `${label}.pos.rationale`);
    if (!pos.rationale.includes(record.id) || !pos.rationale.includes(sense.id)) {
      fail(`${label}.pos.rationale must identify the reviewed record and sense`);
    }
    const expression = item.expression;
    if (!expression
      || expression.decision !== 'verified'
      || expression.expected_record_type !== record.record_type
      || expression.observed_record_type !== record.record_type) {
      fail(`${label}.expression must contain an explicit verified decision for the canonical record type`);
    }
    requireString(expression.rationale, `${label}.expression.rationale`);
    if (!expression.rationale.includes(record.id) || !expression.rationale.includes(sense.id)) {
      fail(`${label}.expression.rationale must identify the reviewed record and sense`);
    }
    const relation = item.relation;
    const relations = relationCoverage(sense);
    if (!relation || relation.decision !== (relations.relation_count === 0 ? 'no-relations' : 'relations-reviewed')) {
      fail(`${label}.relation must contain an explicit decision for the complete relation tuple set`);
    }
    requireString(relation.rationale, `${label}.relation.rationale`);
    if (!relation.rationale.includes(record.id) || !relation.rationale.includes(sense.id)) {
      fail(`${label}.relation.rationale must identify the reviewed record and sense`);
    }
    if (relations.relation_count === 0) {
      requireString(relation.no_relation_rationale, `${label}.relation.no_relation_rationale`);
      if (!relation.no_relation_rationale.includes(record.id)
        && !relation.no_relation_rationale.includes(sense.id)) {
        fail(`${label}.relation.no_relation_rationale must identify the reviewed record or sense`);
      }
    } else if (Object.hasOwn(relation, 'no_relation_rationale')) {
      fail(`${label}.relation cannot include no_relation_rationale when tuples exist`);
    }
    const reviewBasis = item.review_basis;
    if (!reviewBasis || !Array.isArray(reviewBasis.observed_domain_axes)
      || JSON.stringify(reviewBasis.observed_domain_axes)
        !== JSON.stringify(inspectWriterDomainEvidence(sense.gloss).axes)
      || reviewBasis.pos !== sense.pos
      || reviewBasis.record_type !== record.record_type
      || reviewBasis.relation_count !== relations.relation_count) {
      fail(`${label}.review_basis must explicitly bind the repaired sense facts`);
    }
    requireString(reviewBasis.rationale, `${label}.review_basis.rationale`);
    if (!reviewBasis.rationale.includes(record.id)
      || !reviewBasis.rationale.includes(sense.id)
      || !reviewBasis.rationale.includes(sha256Json(sense.gloss).slice(0, 12))) {
      fail(`${label}.review_basis.rationale must cite record, sense, and repaired gloss evidence`);
    }
    requireString(item.sense_boundary_rationale, `${label}.sense_boundary_rationale`);
    if (!item.sense_boundary_rationale.includes(record.id)
      || !item.sense_boundary_rationale.includes(sense.id)) {
      fail(`${label}.sense_boundary_rationale must identify the reviewed record and sense`);
    }
    senseEvidenceById.set(item.sense_id, item);
  }
  if (senseEvidenceById.size !== record.senses.length) {
    fail(`${record.id} correction semantic evidence does not cover every repaired sense`);
  }
  return { boundary, boundaryEvidenceBySense, senseEvidenceById };
}

function replaceSenseReview(previous, record, sense, boundary, boundaryEvidence, senseEvidence, decisionSourceId) {
  if (!previous) fail(`${record.id} is missing a previously authored review row for ${sense.id}`);
  const next = structuredClone(previous);
  const glossSha256 = sha256Json(sense.gloss);
  const domainEvidence = inspectWriterDomainEvidence(sense.gloss);
  const relations = relationCoverage(sense);

  next.sense_id = sense.id;
  next.sense_sha256 = sha256Json(sense);
  next.sense_boundary = {
    ...next.sense_boundary,
    status: 'pass',
    action: boundary.action,
    classification: boundary.classification,
    boundary_decision: boundary.boundary_decision,
    boundary_review_id: boundary.review_id,
    reviewed_sense_ids: boundary.reviewed_sense_ids,
    rationale: senseEvidence.sense_boundary_rationale,
    decision_source_id: decisionSourceId,
  };
  next.pos = {
    ...next.pos,
    status: 'pass',
    ...senseEvidence.pos,
    decision_source_id: decisionSourceId,
  };
  next.expression = {
    ...next.expression,
    ...senseEvidence.expression,
    decision_source_id: decisionSourceId,
  };
  next.relation = {
    ...next.relation,
    status: 'pass',
    ...senseEvidence.relation,
    relation_count: relations.relation_count,
    relation_sha256: relations.relation_sha256,
    relation_fingerprints: relations.relation_fingerprints,
    decision_source_id: decisionSourceId,
  };
  if (relations.relation_count > 0) delete next.relation.no_relation_rationale;
  next.review_basis = {
    ...next.review_basis,
    record_id: record.id,
    sense_id: sense.id,
    lemma: record.lemma,
    gloss_sha256: glossSha256,
    observed_domain_axes: domainEvidence.axes,
    ...senseEvidence.review_basis,
    decision_source_id: decisionSourceId,
  };
  next.coverage_gloss_sha256 = glossSha256;
  return next;
}

function replaceRecordReview(previous, record, correction, decisionSourceId) {
  const next = structuredClone(previous);
  const { boundary, boundaryEvidenceBySense, senseEvidenceById } = validateCorrectionDecisionEvidence(
    correction,
    record,
    decisionSourceId,
  );
  const previousSenseReviews = new Map(
    previous.sense_reviews.map((senseReview) => [senseReview.sense_id, senseReview]),
  );
  const evidence = record.senses.map((sense) => {
    const authoredEvidence = boundaryEvidenceBySense.get(sense.id);
    const glossSha256 = sha256Json(sense.gloss);
    return {
      ...authoredEvidence,
      sense_id: sense.id,
      gloss_sha256: glossSha256,
      decision_source_id: decisionSourceId,
    };
  });

  next.record_id = record.id;
  next.record_sha256 = sha256Json(record);
  next.boundary_review = {
    status: 'pass',
    ...boundary,
    decision: boundary.decision,
    classification: boundary.classification,
    reviewed_sense_ids: boundary.reviewed_sense_ids,
    evidence,
    pairwise: boundary.pairwise,
    rationale: boundary.rationale,
  };
  next.sense_reviews = record.senses.map((sense) => replaceSenseReview(
    previousSenseReviews.get(sense.id),
    record,
    sense,
    boundary,
    boundaryEvidenceBySense.get(sense.id),
    senseEvidenceById.get(sense.id),
    decisionSourceId,
  ));
  return next;
}

function validateManifest(manifest) {
  if (manifest.schema_version !== '1'
    || manifest.contract_version !== CORRECTION_MANIFEST_CONTRACT_VERSION) {
    fail('correction manifest contract version is unsupported');
  }
  if (manifest.scope !== 'complete-canonical' || manifest.authoring_mode !== 'separately-authored') {
    fail('correction manifest must be separately authored for complete-canonical scope');
  }
  requireString(manifest.source_revision, 'correction manifest.source_revision');
  requireString(manifest.decision_source_id, 'correction manifest.decision_source_id');
  requireDigest(manifest.previous_manifest_sha256, 'correction manifest.previous_manifest_sha256');
  requireDigest(manifest.previous_correction_source_sha256, 'correction manifest.previous_correction_source_sha256');
  requireDigest(manifest.base_canonical_records_sha256, 'correction manifest.base_canonical_records_sha256');
  requireDigest(manifest.prospective_canonical_records_sha256, 'correction manifest.prospective_canonical_records_sha256');
  for (const outputSet of ['base_outputs', 'prospective_outputs']) {
    if (!manifest[outputSet] || typeof manifest[outputSet] !== 'object') {
      fail(`correction manifest.${outputSet} must bind generated output digests`);
    }
    for (const key of [
      'canonical_import_sha256',
      'inventory_sha256',
      'canonical_directory_sha256',
      'semantic_audit_sha256',
    ]) requireDigest(manifest[outputSet][key], `correction manifest.${outputSet}.${key}`);
  }
  if (!Array.isArray(manifest.corrections) || manifest.corrections.length === 0) {
    fail('correction manifest.corrections must contain at least one explicit correction');
  }
  const ids = new Set();
  for (const [index, correction] of manifest.corrections.entries()) {
    const label = `correction manifest.corrections[${index}]`;
    if (!correction || typeof correction !== 'object' || Array.isArray(correction)) fail(`${label} must be an object`);
    requireString(correction.record_id, `${label}.record_id`);
    if (ids.has(correction.record_id)) fail(`${label}.record_id is duplicated`);
    ids.add(correction.record_id);
    if (correction.decision !== 'corrected' || correction.boundary_decision !== 'merge') {
      fail(`${label} must record a corrected merge decision`);
    }
    requireDigest(correction.before_record_sha256, `${label}.before_record_sha256`);
    requireDigest(correction.after_record_sha256, `${label}.after_record_sha256`);
    requireString(correction.rationale, `${label}.rationale`);
    if (!Array.isArray(correction.removed_sense_ids) || correction.removed_sense_ids.length === 0) {
      fail(`${label}.removed_sense_ids must identify the reviewed redundant sense(s)`);
    }
    if (!correction.semantic_review || typeof correction.semantic_review !== 'object') {
      fail(`${label}.semantic_review must contain explicit boundary, POS, expression, and relation decisions`);
    }
  }
}

function appendCorrectionHistory(reviewPass, manifest) {
  const historyRows = manifest.corrections.map((correction) => ({
    record_id: correction.record_id,
    before_record_sha256: correction.before_record_sha256,
    after_record_sha256: correction.after_record_sha256,
    source_revision: manifest.source_revision,
    rationale: correction.rationale,
    boundary_decision: correction.boundary_decision,
  }));
  const boundaryRows = historyRows.map((correction) => {
    const sourceCorrection = manifest.corrections.find(
      ({ record_id: recordId }) => recordId === correction.record_id,
    );
    return {
      record_id: correction.record_id,
      decision: correction.boundary_decision,
      before_record_sha256: correction.before_record_sha256,
      after_record_sha256: correction.after_record_sha256,
      review_id: sourceCorrection.semantic_review.boundary.review_id,
      rationale: sourceCorrection.semantic_review.boundary.rationale,
    };
  });
  reviewPass.correction_history.push(...historyRows);
  reviewPass.boundary_decision_history.push(...boundaryRows);
  reviewPass.correction_count = reviewPass.correction_history.length;
}

async function applyCorrections({
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  decisionSourcePath = DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
  correctionManifestPath,
  boundaryDecisionsPath = DEFAULT_SEMANTIC_BOUNDARY_DECISIONS_PATH,
  reviewOutputPath,
  coverageOutputPath,
  auditOutputPath,
  amendExisting = false,
} = {}) {
  if (!correctionManifestPath) fail('apply-semantic-corrections requires --corrections=<path>');
  const [manifest, decisionSource, canonical, boundaryDecisions] = await Promise.all([
    readJson(correctionManifestPath),
    readJson(decisionSourcePath),
    readCanonicalRecords(canonicalDirectory),
    readJson(boundaryDecisionsPath),
  ]);
  validateManifest(manifest);

  const canonicalDigest = canonicalRecordsSha256(canonical.records);
  if (canonicalDigest !== manifest.prospective_canonical_records_sha256) {
    fail('canonical input does not match correction manifest prospective digest');
  }
  if (decisionSource.source_id !== manifest.decision_source_id) {
    fail('decision source id does not match correction manifest.decision_source_id');
  }
  const oldSourceDigest = decisionSource.source?.canonical_records_sha256;
  const alreadyApplied = oldSourceDigest === manifest.prospective_canonical_records_sha256;
  if (oldSourceDigest !== manifest.base_canonical_records_sha256 && !alreadyApplied) {
    fail('decision source does not point at the correction manifest base or prospective digest');
  }
  if (alreadyApplied && !amendExisting) {
    fail('correction manifest has already been applied; use --amend-existing=true only to rebind its explicit decision evidence');
  }
  if (alreadyApplied
    && ![
      manifest.previous_manifest_sha256,
      manifest.previous_correction_source_sha256,
      sha256Json(manifest),
      correctionDecisionDigest(manifest),
    ].includes(decisionSource.correction_source?.sha256)) {
    fail('existing correction source is not the manifest revision being amended');
  }
  const canonicalById = new Map(canonical.records.map((recordInfo) => [recordInfo.record.id, recordInfo.record]));
  const authoredReview = decisionSource.authored_review;
  const authoredById = new Map(authoredReview.records.map((record) => [record.record_id, record]));

  for (const correction of manifest.corrections) {
    const record = canonicalById.get(correction.record_id);
    const authoredRecord = authoredById.get(correction.record_id);
    if (!record || !authoredRecord) fail(`${correction.record_id} is missing from canonical or authored review`);
    const expectedAuthoredDigest = alreadyApplied
      ? correction.after_record_sha256
      : correction.before_record_sha256;
    if (authoredRecord.record_sha256 !== expectedAuthoredDigest) {
      fail(`${correction.record_id} authored review is not at the manifest ${alreadyApplied ? 'prospective' : 'base'} revision`);
    }
    if (sha256Json(record) !== correction.after_record_sha256) {
      fail(`${correction.record_id} canonical content does not match the manifest after digest`);
    }
    const presentRemovedSenseIds = correction.removed_sense_ids.filter((senseId) => (
      record.senses.some((sense) => sense.id === senseId)
    ));
    if (presentRemovedSenseIds.length > 0) fail(`${correction.record_id} still contains a reviewed redundant sense`);
    authoredById.set(
      correction.record_id,
      replaceRecordReview(authoredRecord, record, correction, decisionSource.source_id),
    );
  }

  authoredReview.records = authoredReview.records.map((record) => authoredById.get(record.record_id) ?? record);
  authoredReview.source.canonical_records_sha256 = canonicalDigest;
  authoredReview.record_count = canonical.records.length;
  authoredReview.sense_count = canonical.records.reduce((sum, recordInfo) => sum + recordInfo.record.senses.length, 0);
  authoredReview.review_pass.record_count = authoredReview.record_count;
  authoredReview.review_pass.sense_count = authoredReview.sense_count;
  if (alreadyApplied) {
    const correctionKeys = new Map(
      manifest.corrections.map((correction) => [
        `${correction.record_id}:${correction.after_record_sha256}`,
        correction,
      ]),
    );
    authoredReview.review_pass.correction_history = authoredReview.review_pass.correction_history.map((history) => {
      const correction = correctionKeys.get(`${history.record_id}:${history.after_record_sha256}`);
      return correction
        ? {
          ...history,
          source_revision: manifest.source_revision,
          rationale: correction.rationale,
          boundary_decision: correction.boundary_decision,
        }
        : history;
    });
    authoredReview.review_pass.boundary_decision_history = authoredReview.review_pass.boundary_decision_history.map((history) => {
      const correction = correctionKeys.get(`${history.record_id}:${history.after_record_sha256}`);
      return correction
        ? {
          ...history,
          decision: correction.boundary_decision,
          rationale: correction.semantic_review.boundary.rationale,
        }
        : history;
    });
    authoredReview.review_pass.correction_count = authoredReview.review_pass.correction_history.length;
  } else {
    appendCorrectionHistory(authoredReview.review_pass, manifest);
  }
  authoredReview.review_pass.correction_source = {
    kind: 'separately-authored-correction-manifest',
    path: path.relative(path.resolve(SCRIPT_DIRECTORY, '../..'), correctionManifestPath),
    sha256: correctionDecisionDigest(manifest),
    source_revision: manifest.source_revision,
  };

  decisionSource.source.canonical_records_sha256 = canonicalDigest;
  decisionSource.authored_review = authoredReview;
  decisionSource.authored_review_sha256 = sha256Json(authoredReview);
  decisionSource.correction_source = authoredReview.review_pass.correction_source;
  await writeFile(decisionSourcePath, `${JSON.stringify(decisionSource, null, 2)}\n`, 'utf8');

  const generated = await rebuildSemanticEvidence({
    canonicalDirectory,
    decisionSourceInputPath: decisionSourcePath,
    reviewOutputPath,
    coverageOutputPath,
    auditOutputPath,
  });

  const expectedBoundarySourceDigest = alreadyApplied
    ? manifest.prospective_canonical_records_sha256
    : manifest.base_canonical_records_sha256;
  if (boundaryDecisions.source?.canonical_records_sha256 !== expectedBoundarySourceDigest) {
    fail('boundary decision artifact does not point at the correction manifest expected digest');
  }
  const boundaryById = new Map(boundaryDecisions.records.map((record) => [record.record_id, record]));
  for (const correction of manifest.corrections) {
    const reviewedRecord = authoredById.get(correction.record_id);
    if (!boundaryById.has(correction.record_id)) fail(`${correction.record_id} is missing from boundary decision artifact`);
    boundaryById.set(correction.record_id, {
      record_id: correction.record_id,
      decision: reviewedRecord.boundary_review.decision,
      classification: reviewedRecord.boundary_review.classification,
      rationale: reviewedRecord.boundary_review.rationale,
      pairwise: reviewedRecord.boundary_review.pairwise,
    });
  }
  boundaryDecisions.records = boundaryDecisions.records.map((record) => boundaryById.get(record.record_id) ?? record);
  boundaryDecisions.source.canonical_records_sha256 = canonicalDigest;
  await writeFile(boundaryDecisionsPath, `${JSON.stringify(boundaryDecisions, null, 2)}\n`, 'utf8');

  return {
    decisionSourcePath,
    correctionManifestPath,
    amendExisting: alreadyApplied,
    canonicalRecordsSha256: canonicalDigest,
    recordCount: generated.recordCount,
    senseCount: generated.senseCount,
    correctionCount: manifest.corrections.length,
  };
}

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) fail(`arguments must use --name=value form (received ${argument})`);
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const args = parseArguments(process.argv.slice(2));
  applyCorrections({
    canonicalDirectory: args.canonical ?? DEFAULT_CANONICAL_DIRECTORY,
    decisionSourcePath: args['decision-source'] ?? DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
    correctionManifestPath: args.corrections,
    amendExisting: args['amend-existing'] === 'true',
    boundaryDecisionsPath: args['boundary-decisions'] ?? DEFAULT_SEMANTIC_BOUNDARY_DECISIONS_PATH,
    reviewOutputPath: args.review ?? path.resolve(SCRIPT_DIRECTORY, '../../data/validation/canonical-semantic-review.json'),
    coverageOutputPath: args.coverage ?? DEFAULT_SEMANTIC_COVERAGE_PATH,
    auditOutputPath: args.audit ?? DEFAULT_SEMANTIC_AUDIT_PATH,
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}
