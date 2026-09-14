import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import {
  assembleSemanticAuditArtifact,
  buildSemanticCoverageArtifact,
  canonicalRecordsSha256,
  SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION,
  SEMANTIC_BOUNDARY_METHOD,
  SEMANTIC_BOUNDARY_RULESET_VERSION,
  SEMANTIC_REVIEW_CONTRACT_VERSION,
  sha256Json,
} from '../../scripts/validate/semantic-audit.mjs';
import { inspectWriterDomainEvidence } from '../../scripts/validate/lexical-quality.mjs';
import {
  produceLexicalProductionState,
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
      source_bytes: productionSourceBytes({ stage: 'semantic_review', semantic_audit: semanticAudit }),
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
      source_bytes: productionSourceBytes({ stage: 'audit', semantic_audit: semanticAudit }),
    },
    admission: {
      source_path: `${artifactId}:admission`,
      source_bytes: productionSourceBytes({ batch_id: batchId, decision: 'admit', record_ids: prospectiveValues.map(({ id }) => id) }),
      decision: 'admit',
      authorization_ref: `${artifactId}:explicit-admission`,
    },
  };
  return produceLexicalProductionState({ batchId, stages: sources });
}

export function makeSemanticReview(
  recordInfos,
  {
    changes = [],
    artifactId = 'test-semantic-review',
    boundaryDecisions = {},
  } = {},
) {
  const records = recordInfos.map(recordOf);
  const coverage = buildSemanticCoverageArtifact(recordInfos, {
    artifactId: `${artifactId}-coverage`,
  });
  const boundaryReviewFor = (record) => {
    const authoredBoundary = boundaryDecisions[record.id] ?? {
      decision: 'retain',
      classification: 'atomic',
      pairwise: [],
    };
    const decision = authoredBoundary.decision;
    const classification = authoredBoundary.classification ?? (decision === 'retain' ? 'atomic' : 'separated');
    const reviewId = `${artifactId}:${record.id}:boundary`;
    const pairs = [];
    for (let leftIndex = 0; leftIndex < record.senses.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < record.senses.length; rightIndex += 1) {
        const left = record.senses[leftIndex];
        const right = record.senses[rightIndex];
        const leftGlossSha256 = sha256Json(left.gloss);
        const rightGlossSha256 = sha256Json(right.gloss);
        const authoredPair = authoredBoundary.pairwise?.find((pair) => (
          pair.left_sense_id === left.id && pair.right_sense_id === right.id
        ));
        pairs.push({
          left_sense_id: left.id,
          right_sense_id: right.id,
          relationship: authoredPair?.relationship ?? 'distinct',
          decision: authoredPair?.decision ?? 'retain',
          left_gloss_sha256: leftGlossSha256,
          right_gloss_sha256: rightGlossSha256,
          evidence_basis: 'fixture pair was explicitly authored as a distinct writer-facing use',
          distinguishing_feature: 'fixture senses have separate reviewed usage conditions',
          rationale: `${record.id} ${left.id} ${right.id} pair cites ${leftGlossSha256.slice(0, 12)} and ${rightGlossSha256.slice(0, 12)}.`,
        });
      }
    }
    return {
      status: 'pass',
      review_id: reviewId,
      method: SEMANTIC_BOUNDARY_METHOD,
      independence: {
        independent_of_sense_count: true,
        source: 'separately-authored-fixture-boundary-decision',
        decision_source_version: SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION,
      },
      decision,
      classification,
      reviewed_sense_ids: record.senses.map(({ id }) => id),
      evidence: record.senses.map((sense) => ({
        sense_id: sense.id,
        gloss_sha256: sha256Json(sense.gloss),
        evidence_basis: 'gloss subject, predicate, and writer-facing usage were reviewed',
        rationale: `${record.id} ${sense.id} reviewed gloss ${sha256Json(sense.gloss).slice(0, 12)} independently of the current sense count.`,
      })),
      pairwise: pairs,
      rationale: `${record.id} boundary outcome ${decision} was explicitly authored from gloss and usage evidence.`,
    };
  };
  const boundaryReviews = new Map(records.map((record) => [record.id, boundaryReviewFor(record)]));
  return {
    schema_version: '2',
    contract_version: SEMANTIC_REVIEW_CONTRACT_VERSION,
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
      boundary_ruleset_version: SEMANTIC_BOUNDARY_RULESET_VERSION,
      boundary_decision_source_version: SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION,
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
          boundary_decision: change.boundary_decision ?? 'rewrite',
        };
      }),
      boundary_decision_history: changes.map((change) => ({
        record_id: change.record_id,
        decision: change.boundary_decision ?? 'rewrite',
        before_record_sha256: change.base_record_sha256 ?? sha256Json(records.find(({ id }) => id === change.record_id)),
        after_record_sha256: change.prospective_record_sha256 ?? sha256Json(records.find(({ id }) => id === change.record_id)),
        rationale: `${change.record_id} boundary ${change.boundary_decision ?? 'rewrite'} was resolved and re-reviewed.`,
      })),
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
      boundary_review: boundaryReviews.get(record.id),
      sense_reviews: record.senses.map((sense, senseIndex) => {
        const coverageRecord = coverage.records.find(({ record_id: recordId }) => recordId === record.id);
        const coverageSense = coverageRecord.sense_coverage[senseIndex];
        const boundaryReview = boundaryReviews.get(record.id);
        const domainAxes = inspectWriterDomainEvidence(sense.gloss).axes;
        const relationCount = sense.relations?.length ?? 0;
        return {
          sense_id: sense.id,
          sense_sha256: sha256Json(sense),
          sense_boundary: {
            status: 'pass',
            action: boundaryReview.decision,
            classification: boundaryReview.classification,
            boundary_decision: boundaryReview.decision === 'retain'
              ? 'atomic'
              : boundaryReview.classification === 'coordinated' ? 'coordinated' : boundaryReview.decision,
            boundary_review_id: boundaryReview.review_id,
            reviewed_sense_ids: record.senses.map(({ id }) => id),
            rationale: `${record.id} ${sense.id} was explicitly reviewed against the independent boundary evidence.`,
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
  const {
    changes = [],
    artifactId = 'test-semantic-audit',
    boundaryDecisions = {},
  } = options;
  const review = makeSemanticReview(recordInfos, {
    changes,
    artifactId: `${artifactId}-review`,
    boundaryDecisions,
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
