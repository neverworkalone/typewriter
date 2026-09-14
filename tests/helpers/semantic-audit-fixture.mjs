import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import {
  assembleSemanticAuditArtifact,
  buildSemanticCoverageArtifact,
  canonicalRecordsSha256,
  sha256Json,
} from '../../scripts/validate/semantic-audit.mjs';
import { inspectWriterDomainEvidence } from '../../scripts/validate/lexical-quality.mjs';
import {
  createLexicalProductionState,
  productionSourceBytes,
} from '../../scripts/batch/lexical-production-state.mjs';

function recordOf(recordInfo) {
  return recordInfo?.record ?? recordInfo;
}

export function makeProductionState({
  batchId = 'test-production-batch',
  candidateRecords = [],
  reviewedRecords = [],
  baseRecords = [],
  prospectiveRecords = [],
  semanticAudit = {},
  artifactId = 'test-production-state',
} = {}) {
  const candidateValues = candidateRecords.map(recordOf);
  const reviewedValues = reviewedRecords.map(recordOf);
  const baseValues = baseRecords.map(recordOf);
  const prospectiveValues = prospectiveRecords.length > 0
    ? prospectiveRecords.map(recordOf)
    : [...baseValues, ...reviewedValues];
  const sources = {
    candidate_intake: {
      source_path: `${artifactId}:candidate-intake`,
      source_bytes: productionSourceBytes(candidateValues),
    },
    semantic_review: {
      source_path: `${artifactId}:semantic-review`,
      source_bytes: productionSourceBytes(semanticAudit),
    },
    selection: {
      source_path: `${artifactId}:selection`,
      source_bytes: productionSourceBytes(reviewedValues),
      policy: 'test-shared-selection',
    },
    prospective_canonical: {
      source_path: `${artifactId}:prospective-canonical`,
      source_bytes: productionSourceBytes(prospectiveValues),
    },
    audit: {
      source_path: `${artifactId}:audit`,
      source_bytes: productionSourceBytes(semanticAudit),
    },
    admission: {
      source_path: `${artifactId}:admission`,
      source_bytes: productionSourceBytes({ batch_id: batchId, decision: 'admit', record_ids: prospectiveValues.map(({ id }) => id) }),
      decision: 'admit',
      authorization_ref: `${artifactId}:explicit-admission`,
    },
  };
  return {
    state: createLexicalProductionState({ batchId, stages: sources }),
    sources: Object.fromEntries(
      Object.entries(sources).map(([stageId, stage]) => [stageId, stage.source_bytes]),
    ),
  };
}

export function makeSemanticReview(recordInfos, { changes = [], artifactId = 'test-semantic-review' } = {}) {
  const records = recordInfos.map(recordOf);
  const coverage = buildSemanticCoverageArtifact(recordInfos, {
    artifactId: `${artifactId}-coverage`,
  });
  return {
    schema_version: '2',
    contract_version: 'lexical-semantic-review-v1',
    artifact_id: artifactId,
    scope: 'complete-canonical',
    review_mode: 'agent-authored-decision',
    review_pass: {
      id: `${artifactId}-pass`,
      status: 'complete',
      reviewer: 'test-agent',
      review_mode: 'agent-authored-decision',
      method: 'record-by-record fixture semantic re-audit with source-bound facts',
      ruleset_version: 'lexical-quality-v1',
      record_count: records.length,
      sense_count: records.reduce((sum, record) => sum + record.senses.length, 0),
      open_finding_count: 0,
      correction_count: changes.length,
      correction_history: changes.map((change) => {
        const record = records.find(({ id }) => id === change.record_id);
        return {
          record_id: change.record_id,
          before_record_sha256: change.base_record_sha256 ?? sha256Json(record),
          after_record_sha256: change.prospective_record_sha256 ?? sha256Json(record),
          source_revision: 'test-fixture-base',
          rationale: change.rationale ?? `${change.record_id} was corrected before the fixture re-audit.`,
        };
      }),
    },
    source: {
      kind: 'canonical-jsonl-record-values',
      canonical_records_sha256: canonicalRecordsSha256(recordInfos),
    },
    record_count: records.length,
    sense_count: records.reduce((sum, record) => sum + record.senses.length, 0),
    records: records.map((record) => ({
      record_id: record.id,
      record_sha256: sha256Json(record),
      sense_reviews: record.senses.map((sense, senseIndex) => {
        const coverageRecord = coverage.records.find(({ record_id: recordId }) => recordId === record.id);
        const coverageSense = coverageRecord.sense_coverage[senseIndex];
        const domainAxes = inspectWriterDomainEvidence(sense.gloss).axes;
        const boundaryDecision = domainAxes.length > 1
          ? 'coordinated'
          : record.senses.length > 1
            ? 'split'
            : 'atomic';
        const relationCount = sense.relations?.length ?? 0;
        return {
          sense_id: sense.id,
          sense_sha256: sha256Json(sense),
          sense_boundary: {
            status: 'pass',
            action: record.senses.length > 1 ? 'split' : 'retain',
            classification: record.senses.length > 1 ? 'separated' : 'atomic',
            boundary_decision: boundaryDecision,
            reviewed_sense_ids: record.senses.map(({ id }) => id),
            rationale: `${record.id} ${sense.id} was explicitly reviewed for the complete test canonical scope.`,
          },
          pos: {
            status: 'pass',
            observed_pos: sense.pos,
            rationale: `${record.id} ${sense.id} POS was explicitly reviewed.`,
          },
          expression: {
            status: 'pass',
            expected_record_type: record.record_type,
            observed_record_type: record.record_type,
            rationale: `${record.id} ${sense.id} record type was explicitly reviewed.`,
          },
          relation: {
            status: 'pass',
            decision: relationCount === 0 ? 'no-relations' : 'relations-reviewed',
            relation_count: relationCount,
            relation_sha256: coverageSense.content.relation_sha256,
            relation_fingerprints: coverageSense.content.relation_fingerprints,
            rationale: `${record.id} ${sense.id} relation outcome was explicitly reviewed.`,
            ...(relationCount === 0
              ? { no_relation_rationale: `${record.id} ${sense.id} has no relation tuple after review.` }
              : {}),
          },
          review_basis: {
            record_id: record.id,
            sense_id: sense.id,
            lemma: record.lemma,
            gloss_sha256: sha256Json(sense.gloss),
            observed_domain_axes: domainAxes,
            pos: sense.pos,
            record_type: record.record_type,
            relation_count: relationCount,
            rationale: `${record.id} ${sense.id} reviewed gloss ${sha256Json(sense.gloss).slice(0, 12)} with its POS, type, boundary, and relation outcome.`,
          },
        };
      }),
    })),
    changes,
  };
}

export function makeSemanticAudit(recordInfos, options = {}) {
  const { changes = [], artifactId = 'test-semantic-audit' } = options;
  const review = makeSemanticReview(recordInfos, {
    changes,
    artifactId: `${artifactId}-review`,
  });
  return assembleSemanticAuditArtifact(recordInfos, review, { artifactId });
}

export async function writeSemanticAuditFixture(filePath, recordInfos, options = {}) {
  const artifact = makeSemanticAudit(recordInfos, options);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  await writeFile(filePath, bytes);
  return {
    artifact,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
