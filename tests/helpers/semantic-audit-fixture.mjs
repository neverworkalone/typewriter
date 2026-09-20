import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import {
  assembleSemanticAuditArtifact,
  buildSemanticCoverageArtifact,
  buildSemanticTopicEvidence,
  canonicalRecordsSha256,
  SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION,
  SEMANTIC_BOUNDARY_METHOD,
  SEMANTIC_BOUNDARY_RULESET_VERSION,
  SEMANTIC_REVIEW_CONTRACT_VERSION,
  sha256Json,
  validateSemanticAuditCoverage,
} from '../../scripts/validate/semantic-audit.mjs';
import {
  auditCanonicalLexicalQuality,
  findAmbiguousParticleFragments,
  inspectGlossConnectors,
  inspectWriterDomainEvidence,
  requiresTopicAnalysis,
} from '../../scripts/validate/lexical-quality.mjs';
import { inspectSenseBoundaryPairs } from '../../scripts/validate/sense-boundary.mjs';
import {
  createLexicalProductionRun,
  productionBytesSha256,
  productionValueSha256,
  productionSourceBytes,
} from '../../scripts/batch/lexical-production-state.mjs';

function recordOf(recordInfo) {
  return recordInfo?.record ?? recordInfo;
}

function makeTopicAnalysis(sense, decisionSourceId, topicAnalyses = {}) {
  const configured = topicAnalyses[sense.id];
  const fragment = findAmbiguousParticleFragments(sense.gloss)[0];
  if (!fragment && configured === undefined) return undefined;
  const configuredValue = typeof configured === 'string'
    ? { state: configured }
    : (configured ?? {});
  const state = configuredValue.state ?? (fragment ? 'ambiguous' : 'unsupported');
  return {
    status: 'pass',
    state,
    ...(fragment ? {
      topic: fragment.topic,
      particle: fragment.particle,
      predicate: fragment.predicate,
    } : {}),
    ...(configuredValue.topic ? { topic: configuredValue.topic } : {}),
    ...(configuredValue.particle ? { particle: configuredValue.particle } : {}),
    ...(configuredValue.predicate ? { predicate: configuredValue.predicate } : {}),
    gloss_sha256: sha256Json(sense.gloss),
    rationale: configuredValue.rationale
      ?? `${sense.id} topic/adnominal reading was explicitly reviewed from the authored fixture evidence.`,
    decision_source_id: decisionSourceId,
    ...(state === 'noun-topic'
      ? {
        topic_pos: configuredValue.topic_pos ?? 'noun',
        evidence_basis: configuredValue.evidence_basis
          ?? `${sense.id} explicitly establishes a noun topic before the particle.`,
      }
      : {}),
  };
}

function makeProductionSemanticReview(record, {
  decision,
  artifactId,
  rank,
  candidateRecord = record,
  reviewedRecord = record,
  topicAnalyses = {},
} = {}) {
  const decisionSourceId = `${artifactId}:decision-source`;
  const multiSense = record.senses.length > 1;
  const action = multiSense ? 'split' : 'retain';
  const classification = multiSense ? 'separated' : 'atomic';
  const score = 1;
  const sourceSha256 = sha256Json({
    artifact_id: artifactId,
    decision_source_id: decisionSourceId,
    candidate_record_sha256: sha256Json(candidateRecord),
    reviewed_record_sha256: sha256Json(reviewedRecord),
    decision,
    rank,
    score,
  });
  const pairs = inspectSenseBoundaryPairs(record).map((pair) => {
    const leftSense = record.senses.find(({ id }) => id === pair.left_sense_id);
    const rightSense = record.senses.find(({ id }) => id === pair.right_sense_id);
    const leftGlossSha256 = sha256Json(leftSense.gloss);
    const rightGlossSha256 = sha256Json(rightSense.gloss);
    return {
      left_sense_id: pair.left_sense_id,
      right_sense_id: pair.right_sense_id,
      relationship: pair.relationship,
      decision: 'retain',
      left_gloss_sha256: leftGlossSha256,
      right_gloss_sha256: rightGlossSha256,
      evidence_basis: 'fixture pair was explicitly reviewed from both glosses and usage conditions',
      distinguishing_feature: 'fixture pair has separately authored writer-facing usage conditions',
      decision_source_id: decisionSourceId,
      rationale: `${record.id} ${pair.left_sense_id} ${pair.right_sense_id} pair cites ${leftGlossSha256.slice(0, 12)} and ${rightGlossSha256.slice(0, 12)}.`,
    };
  });
  return {
    status: 'complete',
    decision_source: {
      kind: 'separately-authored-semantic-decision-source',
      contract_version: 'lexical-semantic-decision-source-v1',
      source_id: decisionSourceId,
      path: `tests/fixtures/${artifactId}-decision-source.json`,
      authoring_mode: 'agent-authored-decision',
      source_sha256: sourceSha256,
    },
    authored_decision: {
      source_sha256: sourceSha256,
      decision_source_id: decisionSourceId,
      candidate_record_id: candidateRecord.id,
      candidate_record_sha256: sha256Json(candidateRecord),
      reviewed_record_sha256: sha256Json(reviewedRecord),
      decision,
      selection_rank: rank,
      selection_score: score,
      rationale: `${candidateRecord.id} was selected from the separately authored fixture decision source.`,
      sense_evidence: reviewedRecord.senses.map((sense) => ({
        sense_id: sense.id,
        gloss_sha256: sha256Json(sense.gloss),
        basis: `${reviewedRecord.id} ${sense.id} gloss and writer-facing use were explicitly reviewed.`,
      })),
      relation_evidence: reviewedRecord.senses.map((sense) => {
        const relationCount = sense.relations?.length ?? 0;
        return {
          sense_id: sense.id,
          relation_count: relationCount,
          decision: relationCount === 0 ? 'no-relations' : 'relations-reviewed',
          basis: `${reviewedRecord.id} ${sense.id} relation outcome was explicitly reviewed.`,
        };
      }),
    },
    sense_boundary: {
      status: 'pass',
      decision_source_id: decisionSourceId,
      review_id: `${artifactId}:${record.id}:boundary`,
      method: SEMANTIC_BOUNDARY_METHOD,
      independence: {
        independent_of_sense_count: true,
        source: 'separately-authored-fixture-boundary-decision',
        decision_source_id: decisionSourceId,
        decision_source_version: SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION,
      },
      findings: record.senses.map((sense) => {
        const topicAnalysis = makeTopicAnalysis(sense, decisionSourceId, topicAnalyses);
        return {
          sense_id: sense.id,
          action,
          classification,
          rationale: `${record.id} ${sense.id} boundary was independently reviewed from the authored decision source`,
          semantic_evidence: {
            status: 'pass',
            gloss_sha256: sha256Json(sense.gloss),
            observed_domain_axes: inspectWriterDomainEvidence(sense.gloss).axes,
            domain_evidence: inspectWriterDomainEvidence(sense.gloss).matches,
            connector_observations: inspectGlossConnectors(sense.gloss),
            rationale: `${record.id} ${sense.id} gloss domains were authored and reviewed`,
            boundary_decision: inspectWriterDomainEvidence(sense.gloss).axes.length > 1
              ? 'coordinated'
              : multiSense ? 'split' : 'atomic',
            decision_source_id: decisionSourceId,
            ...(topicAnalysis ? { topic_analysis: topicAnalysis } : {}),
          },
        };
      }),
      pairwise: pairs,
      rationale: `${record.id} boundary was explicitly authored independently of the current sense count`,
    },
    pos: {
      status: 'pass',
      decision: 'verified',
      observed_pos: record.senses.map(({ pos }) => pos),
      decision_source_id: decisionSourceId,
      rationale: `${record.id} POS was explicitly verified from the authored decision source`,
    },
    expression: {
      status: 'pass',
      decision: 'verified',
      expected_record_type: record.record_type,
      observed_record_type: record.record_type,
      decision_source_id: decisionSourceId,
      rationale: `${record.id} expression classification was explicitly verified`,
    },
    relation: {
      status: 'pass',
      decision_source_id: decisionSourceId,
      per_sense: record.senses.map((sense) => {
        const relationCount = sense.relations?.length ?? 0;
        return {
          sense_id: sense.id,
          decision: relationCount === 0 ? 'no-relations' : 'relations-reviewed',
          decision_source_id: decisionSourceId,
          relation_count: relationCount,
          relation_ids: relationCount > 0
            ? sense.relations.map((_, index) => `${sense.id}:relation-${index + 1}`)
            : [],
          ...(relationCount === 0
            ? { no_relation_rationale: `${record.id} ${sense.id} has no relation tuple after authored review.` }
            : {}),
        };
      }),
    },
    selection: {
      status: ['included', 'corrected'].includes(decision) ? 'selected' : decision,
      rank,
      score,
      rationale: `${record.id} was selected by authored verification and coverage evidence`,
    },
  };
}

export function makeProductionState({
  batchId = 'test-production-batch',
  candidateRecords = [],
  reviewedRecords = [],
  baseRecords = [],
  prospectiveRecords = [],
  semanticAudit = {},
  artifactId = 'test-production-state',
  topicAnalyses = {},
  producerLexicalAudit,
  producerGateDigest,
} = {}) {
  const reviewedValues = reviewedRecords.map(recordOf);
  const reviewedDecisions = reviewedRecords.map((recordInfo) => recordInfo?.decision ?? 'included');
  const candidateValues = (candidateRecords.length > 0 ? candidateRecords : reviewedRecords).map(recordOf);
  const baseValues = baseRecords.map(recordOf);
  const prospectiveValues = prospectiveRecords.length > 0
    ? prospectiveRecords.map(recordOf)
    : [...baseValues, ...reviewedValues];
  const reviewRows = candidateValues.map((candidate, index) => {
    const decision = reviewedValues[index] ? reviewedDecisions[index] : 'held';
    return {
      candidate_id: candidate.id,
      decision,
      semantic_review: makeProductionSemanticReview(reviewedValues[index] ?? candidate, {
        decision,
        artifactId,
        rank: index + 1,
        candidateRecord: candidate,
        reviewedRecord: reviewedValues[index] ?? candidate,
        topicAnalyses,
      }),
      ...(reviewedValues[index] ? { reviewed_record: reviewedValues[index] } : {}),
    };
  });
  const selectedRanks = reviewedValues.map((_, index) => index + 1);
  const candidateOutput = candidateValues;
  const reviewOutput = { review_rows: reviewRows, reviewed_records: reviewedValues };
  const selectionOutput = { selected_records: reviewedValues, selection_ranks: selectedRanks };
  const prospectiveOutput = prospectiveValues;
  const baseInfos = baseRecords.map((recordInfo, index) => (
    recordInfo?.record
      ? recordInfo
      : {
        record: recordInfo,
        source: 'base-canonical',
        filePath: 'base-canonical',
        lineNumber: index + 1,
      }
  ));
  const prospectiveInfos = prospectiveRecords.length > 0
    ? prospectiveRecords
    : prospectiveValues.map((record, index) => ({
      record,
      source: 'prospective-canonical',
      filePath: 'prospective-canonical',
      lineNumber: index + 1,
    }));
  const semanticAuditCoverage = validateSemanticAuditCoverage(prospectiveInfos, semanticAudit, {
    baseRecords: baseInfos,
    label: `${batchId} semantic audit`,
    requireDecisionSource: true,
  });
  const topicEvidence = buildSemanticTopicEvidence(prospectiveInfos, semanticAudit, {
    label: `${batchId} semantic audit`,
  });
  const lexicalAudit = auditCanonicalLexicalQuality(prospectiveInfos, {
    scope: `${batchId}:prospective-canonical`,
    throwOnError: false,
    topicEvidence,
  });
  const producerLexicalAuditValue = producerLexicalAudit ?? lexicalAudit;
  const specs = {
    candidate_intake: {
      input: null,
      output: candidateOutput,
      inputKind: 'none',
      outputKind: 'candidate-records',
      details: {
        candidate_records_sha256: productionValueSha256(candidateOutput),
        candidate_count: candidateOutput.length,
      },
    },
    semantic_review: {
      input: candidateOutput,
      output: reviewOutput,
      inputKind: 'candidate-records',
      outputKind: 'reviewed-records',
      details: {
        candidate_records_sha256: productionValueSha256(candidateOutput),
        review_rows_sha256: productionValueSha256(reviewRows),
        reviewed_records_sha256: productionValueSha256(reviewedValues),
      },
    },
    selection: {
      input: reviewOutput,
      output: selectionOutput,
      inputKind: 'reviewed-records',
      outputKind: 'selected-records',
      details: {
        reviewed_records_sha256: productionValueSha256(reviewedValues),
        selected_records_sha256: productionValueSha256(reviewedValues),
        selection_ranks_sha256: productionValueSha256(selectedRanks),
      },
    },
    prospective_canonical: {
      input: selectionOutput,
      output: prospectiveOutput,
      inputKind: 'selected-records',
      outputKind: 'prospective-canonical',
      details: {
        base_records_sha256: productionValueSha256(baseValues),
        base_records: baseValues,
        prospective_records_sha256: productionValueSha256(prospectiveOutput),
      },
    },
  };
  const auditOutput = {
    prospective_records_sha256: productionValueSha256(prospectiveOutput),
    semantic_audit_sha256: productionValueSha256(semanticAudit),
    lexical_audit_sha256: productionValueSha256(producerLexicalAuditValue),
  };
  specs.audit = {
    input: prospectiveOutput,
    output: auditOutput,
    inputKind: 'prospective-canonical',
    outputKind: 'complete-canonical-audit',
    details: auditOutput,
  };
  const authorizationBytes = productionSourceBytes({
    artifact_id: artifactId,
    batch_id: batchId,
    decision: 'admit',
  });
  const gateBytes = productionSourceBytes({
    batch_id: batchId,
    pipeline_version: 'lexical-admission-v1',
    candidate_count: candidateValues.length,
    reviewed_count: reviewedValues.length,
    prospective_record_count: prospectiveValues.length,
    semantic_audit: semanticAuditCoverage,
    lexical_audit: producerLexicalAuditValue,
  });
  const admissionOutput = {
    status: 'admitted',
    gate_digest: producerGateDigest ?? productionBytesSha256(gateBytes),
  };
  specs.admission = {
    input: auditOutput,
    output: admissionOutput,
    inputKind: 'complete-canonical-audit',
    outputKind: 'admitted-canonical',
    details: {
      authorization_sha256: productionBytesSha256(authorizationBytes),
      gate_sha256: admissionOutput.gate_digest,
    },
  };

  const run = createLexicalProductionRun({ batchId });
  const candidateToken = run.completeCandidateIntake({
    sourcePath: `${artifactId}:candidate-intake`,
    payloadSpec: specs.candidate_intake,
  });
  const reviewToken = run.completeSemanticReview({
    predecessor: candidateToken,
    sourcePath: `${artifactId}:semantic-review`,
    payloadSpec: specs.semantic_review,
  });
  const selectionToken = run.completeSelection({
    predecessor: reviewToken,
    sourcePath: `${artifactId}:selection`,
    payloadSpec: specs.selection,
    policy: 'test-shared-selection',
  });
  const prospectiveToken = run.completeProspectiveCanonical({
    predecessor: selectionToken,
    sourcePath: `${artifactId}:prospective-canonical`,
    payloadSpec: specs.prospective_canonical,
  });
  const auditToken = run.completeAudit({
    predecessor: prospectiveToken,
    sourcePath: `${artifactId}:audit`,
    payloadSpec: specs.audit,
  });
  const authorization = run.authorizeAdmission({
    predecessor: auditToken,
    authorizationRef: `${artifactId}:explicit-admission`,
    authorizationBytes,
  });
  const admissionToken = run.completeAdmission({
    authorization,
    sourcePath: `${artifactId}:admission`,
    payloadSpec: specs.admission,
    decision: 'admit',
    admissionResult: admissionOutput,
  });
  void admissionToken;
  const sourceBytes = run.getSourceBytesByStage();
  const payloads = Object.fromEntries(
    Object.entries(sourceBytes).map(([stageId, bytes]) => [
      stageId,
      JSON.parse(bytes.toString('utf8')).payload,
    ]),
  );
  return {
    state: run.getState(),
    sources: sourceBytes,
    payloads,
    lexicalAudit,
  };
}

export function makeSemanticReview(
  recordInfos,
  {
    changes = [],
    artifactId = 'test-semantic-review',
    boundaryDecisions = {},
    topicAnalyses = {},
  } = {},
) {
  const records = recordInfos.map(recordOf);
  const decisionSourceId = `${artifactId}:decision-source`;
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
          decision_source_id: decisionSourceId,
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
        decision_source_id: decisionSourceId,
        decision_source_version: SEMANTIC_BOUNDARY_DECISION_SOURCE_VERSION,
      },
      decision,
      classification,
      reviewed_sense_ids: record.senses.map(({ id }) => id),
      evidence: record.senses.map((sense) => ({
        sense_id: sense.id,
        gloss_sha256: sha256Json(sense.gloss),
        evidence_basis: 'gloss subject, predicate, and writer-facing usage were reviewed',
        decision_source_id: decisionSourceId,
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
    decision_source: {
      kind: 'separately-authored-semantic-decision-source',
      contract_version: 'lexical-semantic-decision-source-v1',
      source_id: decisionSourceId,
      path: `tests/fixtures/${decisionSourceId}.json`,
    },
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
            decision_source_id: decisionSourceId,
            rationale: `${record.id} ${sense.id} was explicitly reviewed against the independent boundary evidence.`,
          },
          pos: {
            status: 'pass',
            decision: 'verified',
            observed_pos: sense.pos,
            decision_source_id: decisionSourceId,
            rationale: `${record.id} ${sense.id} POS was explicitly reviewed.`,
          },
          expression: {
            status: 'pass',
            decision: 'verified',
            expected_record_type: record.record_type,
            observed_record_type: record.record_type,
            decision_source_id: decisionSourceId,
            rationale: `${record.id} ${sense.id} record type was explicitly reviewed.`,
          },
          relation: {
            status: 'pass',
            decision: relationCount === 0 ? 'no-relations' : 'relations-reviewed',
            relation_count: relationCount,
            decision_source_id: decisionSourceId,
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
            decision_source_id: decisionSourceId,
            rationale: `${record.id} ${sense.id} reviewed gloss ${sha256Json(sense.gloss).slice(0, 12)} with its POS, type, boundary, and relation outcome.`,
            ...(requiresTopicAnalysis(sense.gloss) || topicAnalyses[sense.id] !== undefined
              ? { topic_analysis: makeTopicAnalysis(sense, decisionSourceId, topicAnalyses) }
              : {}),
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
    topicAnalyses = {},
  } = options;
  const review = makeSemanticReview(recordInfos, {
    changes,
    artifactId: `${artifactId}-review`,
    boundaryDecisions,
    topicAnalyses,
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
