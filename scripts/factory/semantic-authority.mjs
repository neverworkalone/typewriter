import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Stage3AdmissionError, canonicalRecordSha256 } from './admission.mjs';
import { existingSensePairsOf } from './existing-sense-pairs.mjs';
import {
  buildSemanticAuditFromDecisionSource,
  canonicalRecordsSha256,
  compactSemanticReviewRecord,
  inspectSenseBoundaryPairs,
  readAuthoredBatchDecisionSources,
  sha256Json,
} from '../validate/semantic-audit.mjs';

const ADMITTED = new Set(['included', 'corrected']);
const AUTHORITY_PATH = 'data/validation/canonical-semantic-decision-source.json';
const failLexical = (message, code) => { throw new Stage3AdmissionError(message, { category: 'lexical', code }); };
const failSystemic = (message, code) => { throw new Stage3AdmissionError(message, { category: 'systemic', code }); };
const pairKey = (left, right) => `${left}:${right}`;

function boundText(record, sense, sourceCandidateId, text) {
  const value = typeof text === 'string' && text.trim() ? text.trim() : `${sourceCandidateId}: reviewed source-bound Stage 2 decision.`;
  return `${record.id} ${sense.id} ${sha256Json(sense.gloss).slice(0, 12)} [${sourceCandidateId}]: ${value}`;
}

function withDecisionSourceId(value, decisionSourceId) {
  if (Array.isArray(value)) return value.map((item) => withDecisionSourceId(item, decisionSourceId));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    key === 'decision_source_id' ? decisionSourceId : withDecisionSourceId(child, decisionSourceId),
  ]));
}

function sourceSenseMap(decision, mapping, record) {
  return decision.reviewed_record.senses.map((reviewedSense, index) => {
    const sense = record.senses.find(({ id }) => id === mapping.sense_ids[index]);
    if (!sense || sense.pos !== reviewedSense.pos || sense.gloss !== reviewedSense.gloss) {
      failLexical(`${decision.source_candidate_id}: canonical sense mapping no longer matches its reviewed payload`, 'STAGE3_SEMANTIC_SENSE_MAPPING');
    }
    return { sourceIndex: index, sourceSenseId: `${decision.source_candidate_id}-s${index + 1}`, reviewedSense, sense };
  });
}

function sourcePairMap(decision, semanticRow, mappedSenses, record, sourceId) {
  const pairs = semanticRow.boundary_pairs ?? [];
  if (mappedSenses.length > 1 && pairs.length === 0) {
    failLexical(`${decision.source_candidate_id}: Stage 2 did not author pairwise evidence for every admitted sense pair`, 'STAGE3_BOUNDARY_EVIDENCE_MISSING');
  }
  const sourceSenseToFinal = new Map(mappedSenses.map((item) => [item.sourceSenseId, item.sense]));
  const result = new Map();
  const mechanicalByKey = new Map(inspectSenseBoundaryPairs(record).map((pair) => [pairKey(pair.left_sense_id, pair.right_sense_id), pair]));
  for (const pair of pairs) {
    const left = sourceSenseToFinal.get(pair.left_sense_id);
    const right = sourceSenseToFinal.get(pair.right_sense_id);
    if (!left || !right) failSystemic(`${decision.source_candidate_id}: pairwise source uses an unknown candidate sense`, 'STAGE3_BOUNDARY_PAIR_ID');
    const key = pairKey(left.id, right.id);
    const mechanical = mechanicalByKey.get(key);
    if (pair.decision !== 'retain' || !mechanical || pair.relationship !== mechanical.relationship) {
      failLexical(`${decision.source_candidate_id}: pairwise source conflicts with the current mechanical sense-boundary result`, 'STAGE3_BOUNDARY_PAIR_CONFLICT');
    }
    const leftHash = sha256Json(left.gloss);
    const rightHash = sha256Json(right.gloss);
    const sourceLeft = mappedSenses.find((item) => item.sourceSenseId === pair.left_sense_id)?.reviewedSense;
    const sourceRight = mappedSenses.find((item) => item.sourceSenseId === pair.right_sense_id)?.reviewedSense;
    if (pair.left_gloss_sha256 !== sha256Json(sourceLeft?.gloss) || pair.right_gloss_sha256 !== sha256Json(sourceRight?.gloss)) {
      failSystemic(`${decision.source_candidate_id}: source pair gloss evidence could not be bound to its candidate senses`, 'STAGE3_BOUNDARY_PAIR_DIGEST');
    }
    const reviewPair = {
      left_sense_id: left.id,
      right_sense_id: right.id,
      relationship: pair.relationship,
      decision: pair.decision,
      left_gloss_sha256: leftHash,
      right_gloss_sha256: rightHash,
      evidence_basis: `${record.id} ${left.id} ${right.id}: ${pair.evidence_basis}`,
      distinguishing_feature: `${record.id} ${left.id} ${right.id}: ${pair.distinguishing_feature}`,
      rationale: `${record.id} ${left.id} ${right.id} ${leftHash.slice(0, 12)} ${rightHash.slice(0, 12)} [${decision.source_candidate_id}]: ${pair.rationale}`,
      decision_source_id: sourceId,
    };
    result.set(key, reviewPair);
  }
  return result;
}

function buildNewSenseReview({ record, sense, sourceCandidateId, semanticSense, boundary, decisionSourceId }) {
  const semantic = boundText(record, sense, sourceCandidateId, semanticSense.semantic_rationale);
  const boundaryRationale = boundText(record, sense, sourceCandidateId, semanticSense.boundary_rationale);
  const relationRationale = boundText(record, sense, sourceCandidateId,
    semanticSense.relation_rationale ?? semanticSense.no_relation_rationale ?? semanticSense.semantic_rationale);
  const noRelationRationale = semanticSense.no_relation_rationale === undefined
    ? undefined
    : boundText(record, sense, sourceCandidateId, semanticSense.no_relation_rationale);
  const reviewBasis = withDecisionSourceId(semanticSense.review_basis ?? {}, decisionSourceId);
  reviewBasis.rationale = semantic;
  return {
    sense_id: sense.id,
    sense_sha256: canonicalRecordSha256(sense),
    sense_boundary: {
      status: 'pass', action: boundary.decision, classification: boundary.classification,
      boundary_decision: boundary.decision === 'retain' ? 'atomic' : boundary.classification === 'coordinated' ? 'coordinated' : 'split',
      boundary_review_id: boundary.review_id,
      reviewed_sense_ids: record.senses.map(({ id }) => id),
      rationale: boundaryRationale,
      decision_source_id: decisionSourceId,
    },
    pos: { status: 'pass', observed_pos: sense.pos, rationale: `${record.id} ${sense.id} POS is source-bound to ${sourceCandidateId}.`, decision: 'verified', decision_source_id: decisionSourceId },
    expression: { status: 'pass', expected_record_type: record.record_type, observed_record_type: record.record_type, rationale: `${record.id} ${sense.id} entry type is source-bound to ${sourceCandidateId}.`, decision: 'verified', decision_source_id: decisionSourceId },
    relation: {
      status: 'pass', decision: semanticSense.relation_decision,
      relation_count: (sense.relations ?? []).length,
      relation_sha256: undefined,
      relation_fingerprints: [],
      rationale: relationRationale,
      ...(noRelationRationale === undefined ? {} : { no_relation_rationale: noRelationRationale }),
      decision_source_id: decisionSourceId,
    },
    review_basis: {
      ...reviewBasis,
      record_id: record.id, sense_id: sense.id, lemma: record.lemma,
      gloss_sha256: sha256Json(sense.gloss), observed_domain_axes: [], pos: sense.pos,
      record_type: record.record_type, relation_count: (sense.relations ?? []).length,
      rationale: semantic, decision_source_id: decisionSourceId,
    },
    semantic_rationale: semantic,
    boundary_rationale: boundaryRationale,
    relation_decision: semanticSense.relation_decision,
    relation_rationale: relationRationale,
    ...(noRelationRationale === undefined ? {} : { no_relation_rationale: noRelationRationale }),
  };
}

// Stage 2's explicit pair evidence between each reviewed sense and each existing same-POS sense of the target entry.
// Each pair is validated against the latest canonical record and consumed exactly once; an entry with two or
// more existing same-POS senses needs every pair, one existing same-POS sense keeps working with the context id.
function existingPairMap(decision, semanticRow, beforeRecord, mappedSenses) {
  const result = new Map();
  if (decision.target.kind !== 'new_sense_on_existing_entry') {
    if (existingSensePairsOf(semanticRow).length) failLexical(`${decision.source_candidate_id}: existing-sense pair evidence belongs only to a new_sense_on_existing_entry decision`, 'STAGE3_BOUNDARY_EXISTING_PAIR');
    return { result, requireAll: () => false };
  }
  const oldSenses = beforeRecord?.senses ?? [];
  for (const pair of existingSensePairsOf(semanticRow)) {
    const oldSense = oldSenses.find(({ id }) => id === pair.existing_sense_id);
    const mapped = mappedSenses.find(({ sourceSenseId }) => sourceSenseId === pair.new_sense_id);
    if (!oldSense || !mapped) failLexical(`${decision.source_candidate_id}: pair evidence names ${pair.existing_sense_id} / ${pair.new_sense_id}, which is not an existing sense of the target entry and a reviewed sense`, 'STAGE3_BOUNDARY_EXISTING_PAIR');
    if (oldSense.pos !== mapped.sense.pos) failLexical(`${decision.source_candidate_id}: pair evidence compares ${oldSense.id} (${oldSense.pos}) with a ${mapped.sense.pos} sense`, 'STAGE3_BOUNDARY_EXISTING_PAIR');
    if (pair.relationship !== 'distinct' || pair.decision !== 'retain') failLexical(`${decision.source_candidate_id}: pair evidence must retain a distinct sense (${oldSense.id})`, 'STAGE3_BOUNDARY_EXISTING_PAIR');
    if (pair.existing_gloss_sha256 !== sha256Json(oldSense.gloss) || pair.new_gloss_sha256 !== sha256Json(mapped.reviewedSense.gloss)) {
      failLexical(`${decision.source_candidate_id}: pair evidence for ${oldSense.id} no longer binds the canonical and reviewed glosses`, 'STAGE3_BOUNDARY_EXISTING_PAIR');
    }
    const key = `${oldSense.id}\u0000${mapped.sense.id}`;
    if (result.has(key)) failLexical(`${decision.source_candidate_id}: duplicate pair evidence for ${oldSense.id} / ${mapped.sourceSenseId}`, 'STAGE3_BOUNDARY_EXISTING_PAIR');
    result.set(key, pair);
  }
  const samePosCount = (pos) => oldSenses.filter((sense) => sense.pos === pos).length;
  return { result, requireAll: (pos) => samePosCount(pos) >= 2 };
}

function crossBoundaryPair({ record, beforeReview, oldSense, newSense, decision, sourceSemanticSense, decisionSourceId, stage2Pair, requireStage2Pair }) {
  const mechanical = inspectSenseBoundaryPairs(record).find((pair) => pair.left_sense_id === oldSense.id && pair.right_sense_id === newSense.id)
    ?? inspectSenseBoundaryPairs(record).find((pair) => pair.left_sense_id === newSense.id && pair.right_sense_id === oldSense.id);
  if (!mechanical || mechanical.relationship !== 'distinct') {
    failLexical(`${decision.source_candidate_id}: a new canonical sense overlaps or mechanically conflicts with existing ${oldSense.id}`, 'STAGE3_CANONICAL_SENSE_CONFLICT');
  }
  if (decision.target.kind === 'new_sense_on_existing_entry' && oldSense.pos === newSense.pos
    && (requireStage2Pair ? !stage2Pair : (!stage2Pair && oldSense.id !== decision.target.context_sense_id))) {
    failLexical(`${decision.source_candidate_id}: same-POS new-sense review does not compare against every existing same-POS sense`, 'STAGE3_BOUNDARY_CONTEXT_MISSING');
  }
  const oldReview = beforeReview?.sense_reviews?.find(({ sense_id: id }) => id === oldSense.id);
  const left = record.senses.indexOf(oldSense) < record.senses.indexOf(newSense) ? oldSense : newSense;
  const right = left === oldSense ? newSense : oldSense;
  const leftHash = sha256Json(left.gloss);
  const rightHash = sha256Json(right.gloss);
  const newText = sourceSemanticSense.semantic_rationale ?? sourceSemanticSense.boundary_rationale ?? decision.source_candidate_id;
  const oldText = oldReview?.review_basis?.rationale ?? oldReview?.sense_boundary?.rationale ?? oldSense.id;
  const context = `Stage 2 ${decision.target.kind}${decision.target.context_sense_id ? ` context ${decision.target.context_sense_id}` : ` POS ${newSense.pos}`}`;
  if (stage2Pair) {
    return {
      left_sense_id: left.id, right_sense_id: right.id,
      relationship: 'distinct', decision: 'retain',
      left_gloss_sha256: leftHash, right_gloss_sha256: rightHash,
      evidence_basis: `${record.id} ${left.id} ${right.id}: ${stage2Pair.evidence_basis}`,
      distinguishing_feature: `${record.id} ${left.id} ${right.id}: ${stage2Pair.distinguishing_feature}`,
      rationale: `${record.id} ${left.id} ${right.id} ${leftHash.slice(0, 12)} ${rightHash.slice(0, 12)} [${decision.source_candidate_id}]: ${stage2Pair.rationale}`,
      decision_source_id: decisionSourceId,
    };
  }
  return {
    left_sense_id: left.id, right_sense_id: right.id,
    relationship: 'distinct', decision: 'retain',
    left_gloss_sha256: leftHash, right_gloss_sha256: rightHash,
    evidence_basis: `${record.id} ${left.id} ${right.id}: ${oldText} ${newText}`,
    distinguishing_feature: `${record.id} ${left.id} ${right.id}: ${context}; the source-bound Stage 2 target is distinct from the existing canonical sense.`,
    rationale: `${record.id} ${left.id} ${right.id} ${leftHash.slice(0, 12)} ${rightHash.slice(0, 12)} [${decision.source_candidate_id}]: ${context}; ${newText}`,
    decision_source_id: decisionSourceId,
  };
}

// Entry-level boundary of the complete canonical record. Stage 2 states every reviewed sense as
// a retained atomic unit; a record that ends with several senses (new or amended) is a split,
// separated record, and a single-sense record keeps its authored boundary.
export function finalBoundary({ senseCount, boundaryAction, candidateClassification, priorClassification }) {
  if (senseCount > 1) {
    const coordinated = priorClassification === 'coordinated' || candidateClassification === 'coordinated';
    return { finalDecision: 'split', finalClassification: coordinated ? 'coordinated' : 'separated' };
  }
  return { finalDecision: boundaryAction, finalClassification: candidateClassification };
}

function buildReviewForChangedRecord({ record, beforeRecord, beforeReview, mappedDecisions, semanticRows, decisionSourceId, batchId, attempt }) {
  if (mappedDecisions.length !== 1) {
    failSystemic(`${record.id}: Stage 3 must not combine multiple source candidates on one canonical record without authored cross-candidate pairwise evidence`, 'STAGE3_MULTI_CANDIDATE_RECORD');
  }
  const { decision, mapping } = mappedDecisions[0];
  const semanticRow = semanticRows.get(decision.source_candidate_id);
  if (!semanticRow || !Array.isArray(semanticRow.sense_reviews)
    || semanticRow.sense_reviews.length !== mapping.sense_ids.length) {
    failLexical(`${decision.source_candidate_id}: source-bound semantic sense decisions are incomplete`, 'STAGE3_SEMANTIC_COVERAGE');
  }
  const mappedSenses = sourceSenseMap(decision, mapping, record);
  const boundaryId = `factory-stage3:${batchId}-a${attempt}:${record.id}:boundary`;
  const isNew = !beforeRecord;
  const boundaryAction = semanticRow.sense_reviews[0]?.boundary_action;
  const candidateClassification = semanticRow.sense_reviews[0]?.boundary_classification;
  if (mappedSenses.some(({ sourceIndex }) => (
    semanticRow.sense_reviews[sourceIndex]?.boundary_action !== boundaryAction
      || semanticRow.sense_reviews[sourceIndex]?.boundary_classification !== candidateClassification
  ))) failLexical(`${decision.source_candidate_id}: per-sense boundary decisions disagree`, 'STAGE3_BOUNDARY_DECISION_CONFLICT');

  const sourceId = decisionSourceId;
  const priorBoundary = beforeReview?.boundary_review;
  const { finalDecision, finalClassification } = finalBoundary({
    senseCount: record.senses.length, boundaryAction, candidateClassification, priorClassification: priorBoundary?.classification,
  });
  if (!['retain', 'split'].includes(finalDecision)
    || !['atomic', 'separated', 'coordinated'].includes(finalClassification)
    || (finalDecision === 'retain' && (record.senses.length !== 1 || finalClassification !== 'atomic'))
    || (finalDecision === 'split' && record.senses.length < 2)) {
    failLexical(`${decision.source_candidate_id}: Stage 2 boundary source cannot support a complete canonical review`, 'STAGE3_BOUNDARY_DECISION_CONFLICT');
  }

  const evidenceBySense = new Map((priorBoundary?.evidence ?? []).map((item) => [item.sense_id, structuredClone(item)]));
  const pairwiseByKey = new Map((priorBoundary?.pairwise ?? []).map((item) => [pairKey(item.left_sense_id, item.right_sense_id), structuredClone(item)]));
  const fullSenseReviews = new Map((beforeReview?.sense_reviews ?? []).map((item) => [item.sense_id, structuredClone(item)]));
  const candidatePairwise = sourcePairMap(decision, semanticRow, mappedSenses, record, sourceId);
  const beforeSenseIds = new Set((beforeRecord?.senses ?? []).map(({ id }) => id));
  for (const { sourceIndex, sense, sourceSenseId } of mappedSenses) {
    const sourceSenseReview = semanticRow.sense_reviews[sourceIndex];
    const glossDigest = sha256Json(sense.gloss);
    const semanticText = boundText(record, sense, decision.source_candidate_id, sourceSenseReview.semantic_rationale);
    const boundaryText = boundText(record, sense, decision.source_candidate_id, sourceSenseReview.boundary_rationale);
    evidenceBySense.set(sense.id, {
      sense_id: sense.id,
      gloss_sha256: glossDigest,
      evidence_basis: semanticText,
      rationale: boundaryText,
      decision_source_id: sourceId,
    });
    fullSenseReviews.set(sense.id, buildNewSenseReview({
      record, sense, sourceCandidateId: decision.source_candidate_id, semanticSense: sourceSenseReview,
      boundary: { decision: finalDecision, classification: finalClassification, review_id: boundaryId }, decisionSourceId: sourceId,
    }));
    for (const [key, value] of candidatePairwise) {
      if (value.left_sense_id === sense.id || value.right_sense_id === sense.id) pairwiseByKey.set(key, value);
    }
  }

  if (!isNew) {
    const oldSenses = (beforeRecord?.senses ?? []).filter(({ id }) => beforeSenseIds.has(id));
    const newSenses = mappedSenses.map(({ sense }) => sense);
    const stage2Pairs = existingPairMap(decision, semanticRow, beforeRecord, mappedSenses);
    for (const newSense of newSenses) {
      const sourceIndex = mappedSenses.find(({ sense }) => sense.id === newSense.id).sourceIndex;
      const sourceSemanticSense = semanticRow.sense_reviews[sourceIndex];
      for (const oldSense of oldSenses) {
        const pair = crossBoundaryPair({
          record, beforeReview, oldSense, newSense, decision, sourceSemanticSense, decisionSourceId: sourceId,
          stage2Pair: stage2Pairs.result.get(`${oldSense.id}\u0000${newSense.id}`), requireStage2Pair: stage2Pairs.requireAll(newSense.pos),
        });
        pairwiseByKey.set(pairKey(pair.left_sense_id, pair.right_sense_id), pair);
      }
    }

    // The old sense gloss/POS/relations are preserved, but its boundary record
    // now belongs to the complete current sense set. Rebind only those review
    // fields whose subject expanded; keep its original source-bound lexical
    // and sense rationale intact.
    for (const oldSense of oldSenses) {
      const oldSenseReview = fullSenseReviews.get(oldSense.id);
      if (!oldSenseReview) failSystemic(`${record.id}: prior semantic review omitted ${oldSense.id}`, 'STAGE3_BASE_SEMANTIC_COVERAGE');
      const decisionText = `${record.id} ${oldSense.id}: Stage 3 attempt ${batchId}-a${attempt} preserves the existing canonical review and adds source-bound Stage 2 evidence from ${decision.source_candidate_id}.`;
      oldSenseReview.sense_boundary = {
        ...oldSenseReview.sense_boundary,
        status: 'pass',
        action: finalDecision,
        classification: finalClassification,
        boundary_decision: finalDecision === 'retain' ? 'atomic' : finalClassification === 'coordinated' ? 'coordinated' : 'split',
        boundary_review_id: boundaryId,
        reviewed_sense_ids: record.senses.map(({ id }) => id),
        rationale: decisionText,
        decision_source_id: sourceId,
      };
    }
  }

  const expectedPairs = [];
  for (let leftIndex = 0; leftIndex < record.senses.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < record.senses.length; rightIndex += 1) {
      const left = record.senses[leftIndex];
      const right = record.senses[rightIndex];
      expectedPairs.push(pairKey(left.id, right.id));
    }
  }
  if (expectedPairs.some((key) => !pairwiseByKey.has(key))) {
    failLexical(`${decision.source_candidate_id}: pairwise source does not cover every final canonical sense pair`, 'STAGE3_BOUNDARY_COVERAGE');
  }
  const finalPairs = expectedPairs.map((key) => {
    const pair = pairwiseByKey.get(key);
    const mechanical = inspectSenseBoundaryPairs(record).find((item) => pairKey(item.left_sense_id, item.right_sense_id) === key);
    if (!mechanical || mechanical.relationship !== pair.relationship || pair.decision !== 'retain') {
      failLexical(`${decision.source_candidate_id}: final canonical pair conflicts with source-bound boundary decisions`, 'STAGE3_BOUNDARY_PAIR_CONFLICT');
    }
    return pair;
  });
  const allEvidence = record.senses.map((sense) => {
    const evidence = evidenceBySense.get(sense.id);
    if (!evidence) failSystemic(`${record.id}: base semantic authority omitted existing sense ${sense.id}`, 'STAGE3_BASE_SEMANTIC_COVERAGE');
    return evidence;
  });
  const boundary = {
    ...(priorBoundary ? structuredClone(priorBoundary) : {}),
    status: 'pass', review_id: boundaryId, method: 'gloss-and-usage-pairwise-v2',
    independence: {
      independent_of_sense_count: true,
      source: 'source-bound-stage2-admission-decisions',
      decision_source_version: 'lexical-semantic-boundary-decisions-v1',
      inspected_fields: ['gloss', 'writer-facing-usage', 'pairwise-authored-decision'],
      decision_source_id: sourceId,
    },
    decision: finalDecision,
    classification: finalClassification,
    reviewed_sense_ids: record.senses.map(({ id }) => id),
    evidence: allEvidence,
    pairwise: finalPairs,
    rationale: `${record.id}: source-bound Stage 3 admission combines the preserved canonical review with ${decision.source_candidate_id} Stage 2 evidence.`,
  };
  const oldReviewed = beforeReview ? structuredClone(beforeReview) : {};
  delete oldReviewed.authored_batch_decision;
  const full = {
    ...oldReviewed,
    record_id: record.id,
    record_sha256: canonicalRecordSha256(record),
    boundary_review: boundary,
    sense_reviews: record.senses.map((sense) => {
      const review = fullSenseReviews.get(sense.id);
      if (!review) failSystemic(`${record.id}: semantic authority omits ${sense.id}`, 'STAGE3_SEMANTIC_COVERAGE');
      return review;
    }),
  };
  return compactSemanticReviewRecord(full);
}

/**
 * Extend the complete-canonical semantic source only from already source-bound
 * Stage 2 decisions. Existing authored review rows are materialized and
 * preserved before the changed rows are compacted again.
 */
export async function buildStage3SemanticAuthority({
  root, baseCanonicalRecords, plan, semanticDecisions, semanticDecisionsText,
} = {}) {
  const sourcePath = path.join(root, AUTHORITY_PATH);
  let sourceText;
  try { sourceText = await readFile(sourcePath, 'utf8'); }
  catch (error) { failSystemic(`complete canonical semantic authority is unavailable: ${error.message}`, 'STAGE3_SEMANTIC_AUTHORITY_MISSING'); }
  let source;
  try { source = JSON.parse(sourceText); }
  catch (error) { failSystemic(`complete canonical semantic authority is invalid JSON: ${error.message}`, 'STAGE3_SEMANTIC_AUTHORITY_JSON'); }
  const semanticRows = new Map((semanticDecisions?.decisions ?? []).map((row) => [row.source_candidate_id, row]));
  const batchDecisionSources = await readAuthoredBatchDecisionSources();
  let baseAudit;
  try {
    baseAudit = buildSemanticAuditFromDecisionSource(baseCanonicalRecords, source, {
      baseRecords: baseCanonicalRecords, batchDecisionSources,
      artifactId: 'stage3-base-canonical-semantic-audit',
    });
  } catch (error) {
    failSystemic(`latest master semantic authority failed its complete source-bound audit: ${error.message}`, 'STAGE3_BASE_SEMANTIC_AUTHORITY');
  }
  const baseById = new Map(baseCanonicalRecords.map((record) => [record.id, record]));
  const reviewById = new Map(baseAudit.review.records.map((review) => [review.record_id, review]));
  const afterById = new Map(baseById);
  for (const [id, update] of plan.records) afterById.set(id, update.record);
  const afterRecords = [...afterById.values()];
  const outputRows = new Map((source.authored_review.records ?? []).map((row) => [row.record_id, row]));
  const oldCompactById = new Map(outputRows);
  const mappingBySource = new Map(plan.entries.map((entry) => [entry.source_candidate_id, entry]));
  const decisionBySource = new Map((plan.decisions ?? []).map((row) => [row.source_candidate_id, row]));
  const events = [...(source.factory_admissions ?? [])];
  const changes = [];
  for (const change of plan.changes) {
    const mappings = [...mappingBySource.entries()].filter(([, entry]) => entry.record_id === change.entry_id);
    const associated = mappings.map(([sourceCandidateId, mapping]) => ({
      sourceCandidateId, mapping, decision: decisionBySource.get(sourceCandidateId),
    }));
    if (associated.some(({ decision }) => !decision || !ADMITTED.has(decision.disposition))) {
      failSystemic(`${change.entry_id}: admission map refers to a non-admitted decision`, 'STAGE3_SEMANTIC_MAP');
    }
    const record = afterById.get(change.entry_id);
    const beforeRecord = baseById.get(change.entry_id) ?? null;
    const reviewed = buildReviewForChangedRecord({
      record, beforeRecord, beforeReview: reviewById.get(change.entry_id),
      mappedDecisions: associated.map(({ decision, mapping }) => ({ decision, mapping })),
      semanticRows, decisionSourceId: source.source_id, batchId: plan.batchId, attempt: plan.attempt,
    });
    const previous = oldCompactById.get(change.entry_id);
    outputRows.set(change.entry_id, reviewed);
    changes.push({
      ...change,
      previous_semantic_review_sha256: previous ? sha256Json(previous) : null,
      ...(previous ? { previous_semantic_review: structuredClone(previous), previous_record: structuredClone(beforeRecord) } : {}),
      semantic_review_sha256: sha256Json(reviewed),
    });
  }
  source.source.canonical_records_sha256 = canonicalRecordsSha256(afterRecords);
  source.authored_review.source.canonical_records_sha256 = source.source.canonical_records_sha256;
  source.authored_review.records = [...outputRows.values()].sort((left, right) => left.record_id.localeCompare(right.record_id, 'en', { numeric: true }));
  const event = {
    batch_id: plan.batchId,
    attempt: plan.attempt,
    semantic_decisions_sha256: plan.reviewManifest.semantic_decisions_sha256,
    entries: structuredClone(plan.entries),
    changes,
  };
  event.sha256 = sha256Json(event);
  events.push(event);
  source.factory_admissions = events;
  source.authored_review_sha256 = sha256Json(source.authored_review);
  const updatedText = `${JSON.stringify(source, null, 2)}\n`;
  plan.reviewManifest.admission.semantic_authority = {
    path: AUTHORITY_PATH,
    source_id: source.source_id,
    admission_sha256: event.sha256,
  };
  return {
    sourcePath: AUTHORITY_PATH,
    sourceText: updatedText,
    sourceObject: source,
    sourceEvent: event,
    canonicalRecordsSha256: source.source.canonical_records_sha256,
  };
}

export { AUTHORITY_PATH };
