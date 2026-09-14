import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import {
  assembleSemanticAuditArtifact,
  buildSemanticCoverageArtifact,
  canonicalRecordsSha256,
  sha256Json,
} from '../../scripts/validate/semantic-audit.mjs';
import { inspectWriterDomainEvidence } from '../../scripts/validate/lexical-quality.mjs';

function recordOf(recordInfo) {
  return recordInfo?.record ?? recordInfo;
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
