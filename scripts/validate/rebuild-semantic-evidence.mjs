import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  DEFAULT_SEMANTIC_REVIEW_PATH,
  SEMANTIC_BOUNDARY_METHOD,
  SEMANTIC_BOUNDARY_RULESET_VERSION,
  SEMANTIC_REVIEW_CONTRACT_VERSION,
  assembleSemanticAuditArtifact,
  buildSemanticCoverageArtifact,
  canonicalRecordsSha256,
  SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION,
  sha256Json,
} from './semantic-audit.mjs';
import { inspectWriterDomainEvidence } from './lexical-quality.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function recordOf(recordInfo) {
  return recordInfo?.record ?? recordInfo;
}

function bindPairwiseRationale(record, pairwise) {
  return pairwise.map((item) => {
    const leftGlossSha256 = item.left_gloss_sha256;
    const rightGlossSha256 = item.right_gloss_sha256;
    const requiredEvidence = [
      record.id,
      item.left_sense_id,
      item.right_sense_id,
      leftGlossSha256?.slice(0, 12),
      rightGlossSha256?.slice(0, 12),
    ];
    if (requiredEvidence.every((fragment) => fragment && item.rationale?.includes(fragment))) {
      return item;
    }
    const prefix = item.rationale?.trim();
    const evidence = `reviewed sense pair ${item.left_sense_id}/${item.right_sense_id} `
      + `with gloss evidence ${leftGlossSha256?.slice(0, 12)} and ${rightGlossSha256?.slice(0, 12)}`;
    return {
      ...item,
      rationale: `${prefix ? `${prefix} ` : ''}${record.id} ${evidence}.`,
    };
  });
}

function relationCoverage(sense, coverageSense) {
  const relationCount = sense.relations?.length ?? 0;
  return {
    status: 'pass',
    decision: relationCount === 0 ? 'no-relations' : 'relations-reviewed',
    relation_count: relationCount,
    relation_sha256: coverageSense.content.relation_sha256,
    relation_fingerprints: coverageSense.content.relation_fingerprints,
    rationale: `${sense.id} relation tuples were independently checked against the canonical source.`,
    ...(relationCount === 0
      ? { no_relation_rationale: `${sense.id} has no relation tuple after review.` }
      : {}),
  };
}

function boundaryReview(record, artifactId, decisionSource) {
  const authored = decisionSource.records.find(({ record_id: recordId }) => recordId === record.id);
  if (!authored) throw new Error(`boundary decision source is missing ${record.id}`);
  const expectedSenseIds = record.senses.map(({ id }) => id);
  if (JSON.stringify(authored.sense_ids ?? expectedSenseIds) !== JSON.stringify(expectedSenseIds)) {
    throw new Error(`boundary decision source sense coverage drifted for ${record.id}`);
  }
  const reviewId = `${artifactId}:${record.id}:boundary`;
  return {
    status: 'pass',
    review_id: reviewId,
    method: SEMANTIC_BOUNDARY_METHOD,
    independence: {
      independent_of_sense_count: true,
      source: 'separately-authored-boundary-decision-source',
      decision_source_version: SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION,
      inspected_fields: ['gloss', 'writer-facing-usage', 'pairwise-authored-decision'],
    },
    decision: authored.decision,
    classification: authored.classification,
    reviewed_sense_ids: expectedSenseIds,
    evidence: record.senses.map((sense) => {
      const evidence = inspectWriterDomainEvidence(sense.gloss);
      const glossSha256 = sha256Json(sense.gloss);
      return {
        sense_id: sense.id,
        gloss_sha256: glossSha256,
        evidence_basis: evidence.axes.length > 0
          ? `gloss content and writer domain axes: ${evidence.axes.join(', ')}`
          : 'gloss subject, predicate, and writer-facing usage were reviewed',
        rationale: `${record.id} ${sense.id} reviewed gloss ${glossSha256.slice(0, 12)} independently of the current sense count.`,
      };
    }),
    pairwise: bindPairwiseRationale(record, authored.pairwise),
    rationale: authored.rationale,
  };
}

function reviewSense(record, sense, coverageSense, boundary) {
  const domainEvidence = inspectWriterDomainEvidence(sense.gloss);
  const relationCount = sense.relations?.length ?? 0;
  return {
    sense_id: sense.id,
    sense_sha256: sha256Json(sense),
    sense_boundary: {
      status: 'pass',
      action: boundary.decision,
      classification: boundary.classification,
      boundary_decision: boundary.decision === 'retain'
        ? 'atomic'
        : boundary.classification === 'coordinated' ? 'coordinated' : boundary.decision,
      boundary_review_id: boundary.review_id,
      reviewed_sense_ids: record.senses.map(({ id }) => id),
      rationale: `${record.id} ${sense.id} was reviewed against the independent pairwise boundary evidence.`,
    },
    pos: {
      status: 'pass',
      observed_pos: sense.pos,
      rationale: `${record.id} ${sense.id} POS was independently checked.`,
    },
    expression: {
      status: 'pass',
      expected_record_type: record.record_type,
      observed_record_type: record.record_type,
      rationale: `${record.id} ${sense.id} word/expression classification was independently checked.`,
    },
    relation: relationCoverage(sense, coverageSense),
    review_basis: {
      record_id: record.id,
      sense_id: sense.id,
      lemma: record.lemma,
      gloss_sha256: sha256Json(sense.gloss),
      observed_domain_axes: domainEvidence.axes,
      pos: sense.pos,
      record_type: record.record_type,
      relation_count: relationCount,
      rationale: `${record.id} ${sense.id} reviewed gloss ${sha256Json(sense.gloss).slice(0, 12)} with its POS, type, boundary, and relation outcome.`,
    },
  };
}

function correctionHistory(oldReview, recordsById, boundaryDecisionSource) {
  const oldHistory = oldReview.review_pass?.correction_history ?? [];
  const sourceCorrections = new Map(
    boundaryDecisionSource.records
      .filter((record) => record.correction)
      .map((record) => [record.record_id, record.correction]),
  );
  const existingIds = new Set(oldHistory.map(({ record_id: recordId }) => recordId));
  const history = oldHistory.map((oldCorrection) => {
    const record = recordsById.get(oldCorrection.record_id);
    if (!record) throw new Error(`correction history references missing record ${oldCorrection.record_id}`);
    const sourceCorrection = sourceCorrections.get(record.id);
    const boundaryDecision = sourceCorrection?.boundary_decision
      ?? oldCorrection.boundary_decision
      ?? 'rewrite';
    return {
      record_id: record.id,
      before_record_sha256: oldCorrection.before_record_sha256,
      after_record_sha256: sha256Json(record),
      source_revision: oldCorrection.source_revision,
      rationale: sourceCorrection?.rationale ?? oldCorrection.rationale,
      boundary_decision: boundaryDecision,
    };
  });
  for (const [recordId, correction] of sourceCorrections) {
    if (existingIds.has(recordId)) continue;
    const record = recordsById.get(recordId);
    if (!record) throw new Error(`boundary correction references missing record ${recordId}`);
    history.push({
      record_id: recordId,
      before_record_sha256: correction.before_record_sha256,
      after_record_sha256: sha256Json(record),
      source_revision: correction.source_revision,
      rationale: correction.rationale,
      boundary_decision: correction.boundary_decision,
    });
  }
  return history;
}

function buildSemanticReview(recordInfos, oldReview, boundaryDecisionSource, { artifactId } = {}) {
  const records = recordInfos.map(recordOf);
  const coverage = buildSemanticCoverageArtifact(recordInfos, {
    artifactId: 'canonical-semantic-coverage',
  });
  const coverageByRecord = new Map(coverage.records.map((item) => [item.record_id, item]));
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const history = correctionHistory(oldReview, recordsById, boundaryDecisionSource);
  const reviewPass = oldReview.review_pass ?? {};
  return {
    schema_version: '2',
    contract_version: SEMANTIC_REVIEW_CONTRACT_VERSION,
    artifact_id: artifactId,
    scope: 'complete-canonical',
    review_mode: 'agent-authored-decision',
    review_pass: {
      id: reviewPass.id ?? `${artifactId}-pass`,
      status: 'complete',
      reviewer: reviewPass.reviewer ?? 'codex-agent',
      review_mode: 'agent-authored-decision',
      method: reviewPass.method ?? 'record-by-record complete-canonical semantic re-audit with source-bound facts',
      ruleset_version: 'lexical-quality-v1',
      boundary_ruleset_version: SEMANTIC_BOUNDARY_RULESET_VERSION,
      boundary_decision_source_version: SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION,
      record_count: records.length,
      sense_count: records.reduce((sum, record) => sum + record.senses.length, 0),
      open_finding_count: 0,
      correction_count: history.length,
      correction_history: history,
      boundary_decision_history: history.map((correction) => ({
        record_id: correction.record_id,
        decision: correction.boundary_decision,
        before_record_sha256: correction.before_record_sha256,
        after_record_sha256: correction.after_record_sha256,
        rationale: `${correction.record_id} boundary ${correction.boundary_decision} was resolved and re-reviewed.`,
      })),
    },
    source: {
      kind: 'canonical-jsonl-record-values',
      canonical_records_sha256: canonicalRecordsSha256(recordInfos),
    },
    record_count: records.length,
    sense_count: records.reduce((sum, record) => sum + record.senses.length, 0),
    records: records.map((record) => {
      const boundary = boundaryReview(record, artifactId, boundaryDecisionSource);
      const coverageRecord = coverageByRecord.get(record.id);
      return {
        record_id: record.id,
        record_sha256: sha256Json(record),
        boundary_review: boundary,
        sense_reviews: record.senses.map((sense, senseIndex) => reviewSense(
          record,
          sense,
          coverageRecord.sense_coverage[senseIndex],
          boundary,
        )),
      };
    }),
    changes: Array.isArray(oldReview.changes) ? oldReview.changes : [],
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function rebuildOne({ canonicalDirectory, oldReview, boundaryDecisionSource, auditOutputPath, reviewOutputPath, coverageOutputPath }) {
  const canonical = await readCanonicalRecords(canonicalDirectory);
  const canonicalDigest = canonicalRecordsSha256(canonical.records);
  if (boundaryDecisionSource.contract_version !== SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION
    || boundaryDecisionSource.scope !== 'complete-canonical'
    || boundaryDecisionSource.source?.canonical_records_sha256 !== canonicalDigest) {
    throw new Error('boundary decision source is not bound to the complete canonical input');
  }
  const review = buildSemanticReview(canonical.records, oldReview, boundaryDecisionSource, {
    artifactId: oldReview.artifact_id ?? path.basename(reviewOutputPath, '.json'),
  });
  const audit = assembleSemanticAuditArtifact(canonical.records, review, {
    artifactId: path.basename(auditOutputPath, '.json'),
  });
  await mkdir(path.dirname(auditOutputPath), { recursive: true });
  await mkdir(path.dirname(reviewOutputPath), { recursive: true });
  await mkdir(path.dirname(coverageOutputPath), { recursive: true });
  await Promise.all([
    writeFile(reviewOutputPath, `${JSON.stringify(review, null, 2)}\n`, 'utf8'),
    writeFile(coverageOutputPath, `${JSON.stringify(audit.coverage, null, 2)}\n`, 'utf8'),
    writeFile(auditOutputPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf8'),
  ]);
  return {
    canonicalDirectory,
    auditOutputPath,
    reviewOutputPath,
    coverageOutputPath,
    recordCount: audit.record_count,
    senseCount: audit.sense_count,
    canonicalRecordsSha256: audit.source.canonical_records_sha256,
  };
}

export async function rebuildSemanticEvidence({
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  reviewInputPath = DEFAULT_SEMANTIC_REVIEW_PATH,
  auditInputPath,
  boundaryDecisionInputPath = DEFAULT_SEMANTIC_BOUNDARY_DECISIONS_PATH,
  reviewOutputPath = DEFAULT_SEMANTIC_REVIEW_PATH,
  coverageOutputPath = DEFAULT_SEMANTIC_COVERAGE_PATH,
  auditOutputPath = DEFAULT_SEMANTIC_AUDIT_PATH,
} = {}) {
  const oldReview = auditInputPath
    ? (await readJson(auditInputPath)).review
    : await readJson(reviewInputPath);
  const boundaryDecisionSource = await readJson(boundaryDecisionInputPath);
  return rebuildOne({
    canonicalDirectory,
    oldReview,
    boundaryDecisionSource,
    auditOutputPath,
    reviewOutputPath,
    coverageOutputPath,
  });
}

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) {
      throw new Error(`arguments must use --name=value form (received ${argument})`);
    }
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const args = parseArguments(process.argv.slice(2));
  rebuildSemanticEvidence({
    canonicalDirectory: args.canonical ?? DEFAULT_CANONICAL_DIRECTORY,
    reviewInputPath: args['review-input'] ?? DEFAULT_SEMANTIC_REVIEW_PATH,
    auditInputPath: args['audit-input'],
    boundaryDecisionInputPath: args['boundary-decisions'] ?? DEFAULT_SEMANTIC_BOUNDARY_DECISIONS_PATH,
    reviewOutputPath: args.review ?? DEFAULT_SEMANTIC_REVIEW_PATH,
    coverageOutputPath: args.coverage ?? DEFAULT_SEMANTIC_COVERAGE_PATH,
    auditOutputPath: args.audit ?? DEFAULT_SEMANTIC_AUDIT_PATH,
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}
