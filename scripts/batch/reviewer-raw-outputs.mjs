import assert from 'node:assert/strict';

import { findAmbiguousParticleFragments } from '../validate/lexical-quality.mjs';
import { sha256Json } from '../validate/semantic-audit.mjs';

// A semantic review input is derived from the reviewers' original outputs, but
// original model outputs are not tracked: repository policy keeps raw responses
// and draft text out of `data/batches/`. Two layers therefore exist.
//
// 1. A tracked, metadata-only run record: per run, the context, the candidate
//    range, the digest of the reviewed packet, the digest of the staged raw
//    output, and for every candidate the reviewed proposal's disposition and
//    gloss *digest*. Normal CI checks the input against this record.
// 2. Locally staged raw outputs (ignored `data/reference/`): where present, the
//    input and the run record are re-derived from them.
//
// Neither layer authenticates who ran the reviewers (see
// docs/issue-223-m9-e-scale-coverage.md, "Reviewer independence").

export const RUN_RECORD_CONTRACT_VERSION = 'reviewer-run-record-v1';
export const RUN_RECORD_KIND = 'reviewer-run-record';
export const RAW_OUTPUTS_CONTRACT_VERSION = 'reviewer-raw-outputs-v1';
export const RAW_OUTPUTS_KIND = 'reviewer-raw-outputs';

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const HEX_64 = /^[0-9a-f]{64}$/u;

// The producer's own generator-agreement label is derived, not copied: an
// admit proposal agrees exactly when the reviewer passes it. For a proposed
// hold the reviewer's own label is kept.
export function outcomeFromRaw(generatorDisposition, raw) {
  const outcome = {
    ordinal: raw.ordinal,
    lemma: raw.lemma,
    generator_disposition: generatorDisposition,
    generator_agreement: generatorDisposition === 'admit'
      ? (raw.verdict === 'pass' ? 'agree' : 'disagree')
      : raw.generator_agreement,
    verdict: raw.verdict,
    identity_check: raw.identity,
    pos_check: raw.pos,
    gloss_check: raw.gloss,
    sense_boundary_check: raw.sense_boundary,
  };
  if (raw.verdict === 'hold') {
    outcome.hold_basis = raw.hold_basis;
    outcome.hold_rationale = raw.hold_rationale;
    if (raw.hold_basis === 'unresolved-sense') outcome.directions = raw.directions;
  } else {
    outcome.checked_hit_indices = [...new Set(raw.note_hit_checked)].sort((left, right) => left - right);
  }
  return outcome;
}

export function reviewFromRaw({ lemma, gloss, raw }) {
  const review = {
    lemma,
    gloss_sha256: sha256Json(gloss),
    gloss_judgment: 'fit',
    boundary_action: 'retain',
    boundary_classification: 'atomic',
    single_sense_boundary_status: 'pass',
    identity_check: raw.identity,
    pos_check: raw.pos,
    gloss_check: raw.gloss,
    sense_boundary_check: raw.sense_boundary,
    checked_hit_indices: [...new Set(raw.note_hit_checked)].sort((left, right) => left - right),
    boundary_rationale: `${lemma}: ${raw.sense_note}`,
    semantic_rationale: `${lemma}: 풀이는 표제어의 검토된 핵심 뜻과 맞는다. ${raw.use_note}`,
    no_relation_rationale: `${lemma}: 이 검토에서 개별 관계 근거를 따로 세우지 않았으므로 관계 없음이 유효하다.`,
    decision_rationale: `${lemma}: ${raw.sense_note} 정체성·품사·풀이·의미 경계를 후보 근거에서 별도 맥락으로 검토했고 공통 승인 경로에서 판단한다.`,
    frame_rationale: `${lemma}: 진단 프레임은 풀이 구간마다 같은 의미를 유지하며, 경로 표시는 보강 메타데이터이지 승인 근거가 아니다.`,
    frames: raw.frames.map((sentenceFrame) => ({
      sentence_frame: sentenceFrame,
      relation_type: 'near',
      target_class: `${lemma}의 검토된 핵심 뜻`,
    })),
  };
  if (findAmbiguousParticleFragments(gloss).length > 0) {
    review.topic_analysis = { status: 'pass', state: 'adnominal', rationale: raw.topic_rationale };
  }
  return review;
}

// Tracked form of the reviewed proposals: digests only, never gloss text.
export function proposalDigests(proposals) {
  return proposals.map((proposal) => ({
    ordinal: proposal.ordinal,
    lemma: proposal.lemma,
    disposition: proposal.disposition,
    ...(proposal.gloss === undefined ? {} : { gloss_sha256: sha256Json(proposal.gloss) }),
  }));
}

export function runRecordFromRaw(rawArtifact) {
  const digests = proposalDigests(rawArtifact.reviewed_proposals);
  return {
    schema_version: '1',
    contract_version: RUN_RECORD_CONTRACT_VERSION,
    kind: RUN_RECORD_KIND,
    batch_id: rawArtifact.batch_id,
    reviewer: rawArtifact.reviewer,
    reviewed_proposals: digests,
    runs: rawArtifact.runs.map(({ outputs, ...summary }) => ({
      ...summary,
      proposals_sha256: sha256Json(digests.slice(summary.first_ordinal - 1, summary.last_ordinal)),
    })),
  };
}

// A review that reuses one sentence for many candidates was templated, not
// reviewed candidate by candidate. Reasoning text (with the lemma, context
// indices, and digits removed) may repeat for at most a small share of rows.
const MAX_REPEATED_NOTE_SHARE = 0.1;
export function assertReviewNotesAreCandidateSpecific(reviews) {
  for (const field of ['boundary_rationale', 'semantic_rationale']) {
    const groups = new Map();
    for (const review of reviews) {
      const key = String(review[field])
        .split(review.lemma).join('§')
        .replace(/^§: /u, '')
        .replace(/(?:맥락|컨텍스트) *[0-9~·,\s]+/gu, '')
        .replace(/[0-9]/gu, '#')
        .replace(/\s+/gu, ' ')
        .trim();
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const repeated = [...groups.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
    assert.ok(repeated <= Math.floor(reviews.length * MAX_REPEATED_NOTE_SHARE),
      `${repeated} of ${reviews.length} review rows reuse the same ${field} text; notes must be specific to each candidate`);
  }
}

function assertRunCoverage(runs, candidateCount, outputsPerRun) {
  assert.ok(Array.isArray(runs) && runs.length > 0, 'reviewer run record lists no runs');
  let next = 1;
  for (const run of runs) {
    assert.equal(run.first_ordinal, next, `run ${run.run} must start at candidate ${next}`);
    assert.ok(Number.isInteger(run.candidate_count) && run.candidate_count > 0
      && run.last_ordinal === run.first_ordinal + run.candidate_count - 1
      && (outputsPerRun === undefined || run.outputs?.length === run.candidate_count),
    `run ${run.run} must report exactly the candidates it covers`);
    assert.ok(nonEmpty(run.context), `run ${run.run} must record its context`);
    assert.match(String(run.packet_sha256), HEX_64, `run ${run.run} must record the reviewed packet's SHA-256`);
    assert.match(String(run.raw_output_sha256), HEX_64, `run ${run.run} must record its raw output's SHA-256`);
    next = run.last_ordinal + 1;
  }
  assert.equal(next - 1, candidateCount, 'reviewer runs must cover every candidate in the batch');
}

// Normal-CI check, from tracked artifacts only. `candidateRows` are the
// candidate-review decision rows, `glossByLemma` maps each admitted lemma to the
// gloss currently in its candidate record, and `runRecordBytes` are the tracked
// run record's exact bytes.
export function assertInputBoundToRunRecord({
  input, runRecord, runRecordBytes, candidateRows, glossByLemma, sha256Bytes,
}) {
  assert.equal(runRecord?.kind, RUN_RECORD_KIND, 'reviewer run record has the wrong kind');
  assert.equal(runRecord.contract_version, RUN_RECORD_CONTRACT_VERSION, 'reviewer run record has an unregistered contract version');
  assert.equal(runRecord.batch_id, input.batch_id, 'reviewer run record is bound to a different batch');
  assert.equal(runRecord.reviewer, input.reviewer, 'reviewer run record names a different reviewer than the input');
  assert.equal(sha256Bytes(runRecordBytes), input.run_record_sha256, 'reviewer run record does not match the digest bound in the input');

  const proposals = runRecord.reviewed_proposals;
  assert.ok(Array.isArray(proposals) && proposals.length === candidateRows.length,
    'reviewer run record must preserve the reviewed proposal digest for every candidate');
  proposals.forEach((proposal, index) => {
    const lemma = candidateRows[index].morphology_proposal.lemma;
    assert.equal(proposal.ordinal, index + 1, `${lemma}: reviewed proposal ordinal`);
    assert.equal(proposal.lemma, lemma, `${lemma}: reviewed proposal is bound to a different lemma`);
    assert.ok(['admit', 'hold'].includes(proposal.disposition), `${lemma}: reviewed proposal names no disposition`);
    if (proposal.disposition === 'admit') assert.match(String(proposal.gloss_sha256), HEX_64, `${lemma}: an admit proposal must preserve its gloss digest`);
    else assert.equal(proposal.gloss_sha256, undefined, `${lemma}: a hold proposal carries no gloss digest`);
  });
  assert.equal(input.generator_proposal_sha256, sha256Json(proposals),
    'review input does not match the digest of the reviewed proposals');

  assertRunCoverage(runRecord.runs, candidateRows.length);
  for (const run of runRecord.runs) {
    assert.equal(run.proposals_sha256, sha256Json(proposals.slice(run.first_ordinal - 1, run.last_ordinal)),
      `run ${run.run} did not review the recorded proposals`);
  }
  assert.deepEqual(input.review_runs, runRecord.runs, 'review input run information does not match the run record');

  assert.equal(input.candidate_outcomes.length, candidateRows.length);
  const reviewByLemma = new Map(input.reviews.map((review) => [review.lemma, review]));
  let passes = 0;
  candidateRows.forEach((row, index) => {
    const lemma = row.morphology_proposal.lemma;
    const outcome = input.candidate_outcomes[index];
    assert.equal(outcome.generator_disposition, proposals[index].disposition,
      `${lemma}: outcome names a different proposal than the reviewer was shown`);
    if (outcome.verdict !== 'pass') {
      assert.equal(reviewByLemma.has(lemma), false, `${lemma}: a reviewer hold cannot carry a review row`);
      return;
    }
    passes += 1;
    assert.equal(proposals[index].disposition, 'admit', `${lemma}: a reviewer pass needs an admit proposal`);
    const review = reviewByLemma.get(lemma);
    assert.ok(review, `${lemma}: a reviewer pass needs its review row`);
    const admittedGlossDigest = sha256Json(glossByLemma.get(lemma));
    // The reviewer's `fit` belongs to the gloss it was shown; the gloss admitted
    // into canonical data and the review row must be that same gloss.
    assert.equal(proposals[index].gloss_sha256, admittedGlossDigest,
      `${lemma}: the admitted gloss differs from the gloss the reviewer assessed`);
    assert.equal(review.gloss_sha256, proposals[index].gloss_sha256,
      `${lemma}: the review row is not bound to the gloss the reviewer assessed`);
    // The outcome and the review row are two tracked records of one reviewer
    // pass; they must cite the same four verdicts and the same checked contexts.
    for (const field of ['identity_check', 'pos_check', 'gloss_check', 'sense_boundary_check', 'checked_hit_indices']) {
      assert.deepEqual(review[field], outcome[field], `${lemma}: the outcome and the review row disagree on ${field}`);
    }
  });
  assert.equal(input.reviews.length, passes, 'review rows must exist exactly for the reviewer passes');
  assertReviewNotesAreCandidateSpecific(input.reviews);
}

// Local check, where the raw outputs are staged outside the repository: the
// tracked run record and the review input must both be a mechanical function of
// the reviewers' original outputs.
export function assertInputDerivedFromRaw({ input, runRecord, rawArtifact, candidateRows, glossByLemma }) {
  assert.equal(rawArtifact?.kind, RAW_OUTPUTS_KIND, 'staged reviewer raw outputs have the wrong kind');
  assert.equal(rawArtifact.contract_version, RAW_OUTPUTS_CONTRACT_VERSION, 'staged reviewer raw outputs have an unregistered contract version');
  assert.deepEqual(runRecord, runRecordFromRaw(rawArtifact), 'the tracked run record is not what the staged raw outputs yield');

  assertRunCoverage(rawArtifact.runs, candidateRows.length, true);
  const flat = [];
  for (const run of rawArtifact.runs) {
    assert.equal(run.raw_output_sha256, sha256Json(run.outputs), `run ${run.run} outputs do not match their recorded digest`);
    flat.push(...run.outputs);
  }
  assert.equal(flat.length, candidateRows.length, 'staged raw outputs must cover every candidate in the batch');

  const proposals = rawArtifact.reviewed_proposals;
  const reviewByLemma = new Map(input.reviews.map((review) => [review.lemma, review]));
  candidateRows.forEach((row, index) => {
    const lemma = row.morphology_proposal.lemma;
    const raw = flat[index];
    assert.equal(raw.ordinal, index + 1, `${lemma}: raw output ordinal`);
    assert.equal(raw.lemma, lemma, `${lemma}: raw output is bound to a different lemma`);
    const stated = input.candidate_outcomes[index];
    assert.deepEqual(stated, outcomeFromRaw(stated.generator_disposition, raw),
      `${lemma}: candidate outcome is not what the reviewer's raw output yields`);
    if (raw.verdict !== 'pass') return;
    const reviewedGloss = proposals[index].gloss;
    assert.equal(glossByLemma.get(lemma), reviewedGloss,
      `${lemma}: the admitted gloss differs from the gloss the reviewer assessed`);
    assert.deepEqual(reviewByLemma.get(lemma), reviewFromRaw({ lemma, gloss: reviewedGloss, raw }),
      `${lemma}: review row is not what the reviewer's raw output yields`);
  });
}
