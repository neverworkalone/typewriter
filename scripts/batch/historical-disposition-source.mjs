import { createHash } from 'node:crypto';

import {
  isGrandfatheredLegacyDispositionSource,
  isGrandfatheredM512ADecisionSource,
} from '../validate/semantic-decision-row.mjs';

// These two external-file digests are the M5-11 source_digests recorded in
// data/batches/m5-11-review.json; both source artifacts must match together.
const M5_11_GRANDFATHERED_SOURCES = Object.freeze({
  editorialSha256: 'e08ff61b5802f252a17ade1085665c1ad54a6197afb43d4dc67f4d620d3c5237',
  proposalSha256: '5131dfc9ac17ea0519b8d19a6d3ebfe8c91240931e665265356e4a15459ef0ad',
  batchId: 'm5-11-expansion-20260913',
  issue: 97,
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function sourceBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function parseSource(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    const wrapped = new Error(`${label} is not valid JSON: ${error.message}`);
    wrapped.code = 'LEXICAL_PRODUCTION_HISTORICAL_SOURCE';
    throw wrapped;
  }
}

function failBinding(message) {
  const error = new Error(message);
  error.code = 'LEXICAL_PRODUCTION_HISTORICAL_SOURCE_BINDING';
  throw error;
}

function recordOf(value) {
  return value?.record ?? value;
}

function isMissingDispositionBasis(row) {
  if (row.decision === 'held') return !Object.hasOwn(row, 'hold_basis');
  if (row.decision === 'rejected') return !Object.hasOwn(row, 'rejection_basis');
  return false;
}

function rebaseM511CandidateRecord(record, expectedId) {
  return {
    ...record,
    id: expectedId,
    candidate_id: expectedId,
    senses: record.senses.map((sense, index) => ({
      ...sense,
      id: `${expectedId}-s${index + 1}`,
    })),
  };
}

function verifyDecisionSourceRows(source, candidateRecords, reviews, batchId) {
  if (source.batch_id !== batchId
    || !Array.isArray(source.decisions)
    || !Array.isArray(source.candidate_records)
    || source.decisions.length !== reviews.length
    || source.candidate_records.length !== candidateRecords.length) {
    failBinding('historical decision source does not cover this production batch');
  }

  const candidatesById = new Map();
  for (const candidateInfo of candidateRecords) {
    const candidate = recordOf(candidateInfo);
    if (typeof candidate?.id !== 'string' || candidatesById.has(candidate.id)) {
      failBinding('historical production candidates do not have unique record identities');
    }
    candidatesById.set(candidate.id, candidate);
  }
  const sourceCandidatesById = new Map();
  for (const candidate of source.candidate_records) {
    if (typeof candidate?.id !== 'string' || sourceCandidatesById.has(candidate.id)) {
      failBinding('grandfathered source candidates do not have unique record identities');
    }
    sourceCandidatesById.set(candidate.id, candidate);
  }
  const reviewsById = new Map();
  for (const review of reviews) {
    if (typeof review?.candidate_id !== 'string' || reviewsById.has(review.candidate_id)) {
      failBinding('historical production reviews do not have unique candidate identities');
    }
    reviewsById.set(review.candidate_id, review);
  }
  if (candidatesById.size !== sourceCandidatesById.size
    || reviewsById.size !== candidatesById.size) {
    failBinding('historical source candidate scope differs from shared production');
  }

  const legacyDispositionIds = new Set();
  for (const sourceRow of source.decisions) {
    const candidateId = sourceRow?.candidate_record_id;
    const candidate = candidatesById.get(candidateId);
    const sourceCandidate = sourceCandidatesById.get(candidateId);
    const review = reviewsById.get(candidateId);
    if (!candidate || !sourceCandidate || !review
      || sha256Json(sourceCandidate) !== sourceRow.candidate_record_sha256
      || sha256Json(candidate) !== sourceRow.candidate_record_sha256
      || review.decision !== sourceRow.decision
      || (sourceRow.inventory_id !== undefined && review.inventory_id !== sourceRow.inventory_id)) {
      failBinding(`historical review ${candidateId ?? '(missing candidate id)'} is not bound to the pinned source row`);
    }
    if (isMissingDispositionBasis(sourceRow) && isMissingDispositionBasis(review)) {
      legacyDispositionIds.add(candidateId);
    }
  }
  if (legacyDispositionIds.size > 0) {
    const sourceIds = new Set(source.decisions.map(({ candidate_record_id: id }) => id));
    if (sourceIds.size !== reviewsById.size
      || [...reviewsById.keys()].some((id) => !sourceIds.has(id))) {
      failBinding('historical production reviews do not exactly cover the pinned decision source');
    }
  }
  return legacyDispositionIds;
}

function verifyM511Sources({ source, sourceSha256, proposal, proposalSha256, candidateRecords, reviews, batchId }) {
  if (sourceSha256 !== M5_11_GRANDFATHERED_SOURCES.editorialSha256
    || proposalSha256 !== M5_11_GRANDFATHERED_SOURCES.proposalSha256) {
    return null;
  }
  if (batchId !== M5_11_GRANDFATHERED_SOURCES.batchId
    || source?.issue !== M5_11_GRANDFATHERED_SOURCES.issue
    || source?.batch_id !== batchId
    || source?.schema_version !== '1'
    || proposal?.schema_version !== '1'
    || !Array.isArray(source?.decisions)
    || !Array.isArray(proposal?.proposals)
    || source.decisions.length !== proposal.proposals.length
    || source.decisions.length !== reviews.length
    || candidateRecords.length !== reviews.length) {
    failBinding('grandfathered M5-11 editorial/proposal source scope is invalid');
  }

  const candidatesById = new Map(candidateRecords.map((candidateInfo) => {
    const candidate = recordOf(candidateInfo);
    return [candidate?.id, candidate];
  }));
  const reviewsByInventoryId = new Map();
  for (const review of reviews) {
    if (typeof review?.inventory_id !== 'string' || reviewsByInventoryId.has(review.inventory_id)) {
      failBinding('M5-11 production reviews do not have unique inventory identities');
    }
    reviewsByInventoryId.set(review.inventory_id, review);
  }
  const legacyDispositionIds = new Set();
  for (const [index, sourceRow] of source.decisions.entries()) {
    const proposalRow = proposal.proposals[index];
    const expectedCandidate = sourceRow.canonical_record
      ? rebaseM511CandidateRecord(proposalRow.candidate_record, sourceRow.canonical_record.id)
      : proposalRow.candidate_record;
    const candidate = candidatesById.get(expectedCandidate.id);
    const review = reviewsByInventoryId.get(sourceRow.inventory_id);
    if (!candidate || !review
      || sha256Json(candidate) !== sha256Json(expectedCandidate)
      || review.candidate_id !== expectedCandidate.id
      || review.decision !== sourceRow.decision
      || JSON.stringify(review.semantic_review) !== JSON.stringify(sourceRow.semantic_review)
      || proposalRow.inventory_id !== sourceRow.inventory_id
      || proposalRow.candidate_lemma !== sourceRow.candidate_lemma
      || proposalRow.proposal_sha256 !== sourceRow.candidate_proposal_sha256) {
      failBinding(`M5-11 production review ${sourceRow.inventory_id ?? index} is not bound to the pinned editorial/proposal rows`);
    }
    if (isMissingDispositionBasis(sourceRow) && isMissingDispositionBasis(review)) {
      legacyDispositionIds.add(review.candidate_id);
    }
  }
  if (legacyDispositionIds.size > 0
    && reviewsByInventoryId.size !== source.decisions.length) {
    failBinding('M5-11 historical production reviews do not cover the pinned source');
  }
  return legacyDispositionIds;
}

/**
 * Return only the exact old decision rows whose missing basis is grandfathered.
 * The caller's historicalReplay boolean is never evidence; file bytes, source
 * pins, candidate digests, and one-to-one review correspondence are rechecked
 * here at the shared producer boundary.
 */
export function verifyGrandfatheredHistoricalDispositions({
  batchId,
  candidateRecords,
  reviews,
  historicalDispositionSource,
} = {}) {
  if (!historicalDispositionSource || typeof historicalDispositionSource !== 'object') return new Set();
  const editorialBytes = sourceBytes(historicalDispositionSource.sourceBytes);
  if (!editorialBytes) return new Set();
  const sourceSha256 = sha256(editorialBytes);
  const source = parseSource(editorialBytes, 'historical disposition source');
  const proposalBytes = sourceBytes(historicalDispositionSource.proposalSourceBytes);
  if (proposalBytes) {
    const proposalSha256 = sha256(proposalBytes);
    const proposal = parseSource(proposalBytes, 'historical candidate proposal source');
    return verifyM511Sources({
      source,
      sourceSha256,
      proposal,
      proposalSha256,
      candidateRecords,
      reviews,
      batchId,
    }) ?? new Set();
  }

  const sourcePath = historicalDispositionSource.sourcePath;
  const isGrandfathered = isGrandfatheredM512ADecisionSource({
    source,
    sourcePath,
    sourceSha256,
    artifactSha256: source.artifact_sha256,
  }) || isGrandfatheredLegacyDispositionSource({
    source,
    sourcePath,
    sourceSha256,
    artifactSha256: source.artifact_sha256,
  });
  if (!isGrandfathered) return new Set();
  return verifyDecisionSourceRows(source, candidateRecords, reviews, batchId);
}
