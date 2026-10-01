import assert from 'node:assert/strict';

import { findAmbiguousParticleFragments } from '../validate/lexical-quality.mjs';
import { sha256Json } from '../validate/semantic-audit.mjs';

// A semantic review input is derived from the reviewers' original outputs. The
// original outputs and the run information are preserved verbatim next to the
// input, and the input is checked to be a mechanical function of them, so the
// reviewers' own judgments stay distinguishable from the producer's assembly.
//
// This preserves and cross-checks evidence; it does not authenticate who ran the
// reviewers (see docs/issue-223-m9-e-scale-coverage.md, "Reviewer independence").

export const RAW_OUTPUTS_CONTRACT_VERSION = 'reviewer-raw-outputs-v1';
export const RAW_OUTPUTS_KIND = 'reviewer-raw-outputs';

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

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

export function runSummaries(rawArtifact) {
  return rawArtifact.runs.map(({ outputs, ...summary }) => summary);
}

// `candidateRows` are the candidate-review decision rows, `glossByLemma` maps
// each admitted lemma to its gloss, and `rawBytes` are the preserved artifact's
// exact bytes.
export function assertInputDerivedFromRaw({ input, rawArtifact, rawBytes, candidateRows, glossByLemma, sha256Bytes }) {
  assert.equal(rawArtifact?.kind, RAW_OUTPUTS_KIND, 'reviewer raw outputs have the wrong kind');
  assert.equal(rawArtifact.contract_version, RAW_OUTPUTS_CONTRACT_VERSION, 'reviewer raw outputs have an unregistered contract version');
  assert.equal(rawArtifact.batch_id, input.batch_id, 'reviewer raw outputs are bound to a different batch');
  assert.equal(rawArtifact.reviewer, input.reviewer, 'reviewer raw outputs name a different reviewer than the input');
  assert.equal(sha256Bytes(rawBytes), input.raw_outputs_sha256, 'reviewer raw outputs do not match the digest bound in the input');

  // Runs must cover every candidate exactly once, in order.
  assert.ok(Array.isArray(rawArtifact.runs) && rawArtifact.runs.length > 0, 'reviewer raw outputs list no runs');
  let next = 1;
  const flat = [];
  for (const run of rawArtifact.runs) {
    assert.equal(run.first_ordinal, next, `run ${run.run} must start at candidate ${next}`);
    assert.ok(Array.isArray(run.outputs) && run.outputs.length === run.candidate_count
      && run.last_ordinal === run.first_ordinal + run.candidate_count - 1,
    `run ${run.run} must report exactly the candidates it covers`);
    assert.equal(run.raw_output_sha256, sha256Json(run.outputs), `run ${run.run} outputs do not match their recorded digest`);
    assert.ok(nonEmpty(run.context) && nonEmpty(run.packet_sha256), `run ${run.run} must record its context and packet digest`);
    flat.push(...run.outputs);
    next = run.last_ordinal + 1;
  }
  assert.equal(flat.length, candidateRows.length, 'reviewer raw outputs must cover every candidate in the batch');
  assert.deepEqual(input.review_runs, runSummaries(rawArtifact), 'review input run information does not match the preserved raw outputs');

  assert.equal(input.candidate_outcomes.length, candidateRows.length);
  const reviewByLemma = new Map(input.reviews.map((review) => [review.lemma, review]));
  let passes = 0;
  candidateRows.forEach((row, index) => {
    const lemma = row.morphology_proposal.lemma;
    const raw = flat[index];
    assert.equal(raw.ordinal, index + 1, `${lemma}: raw output ordinal`);
    assert.equal(raw.lemma, lemma, `${lemma}: raw output is bound to a different lemma`);
    const stated = input.candidate_outcomes[index];
    assert.deepEqual(stated, outcomeFromRaw(stated.generator_disposition, raw),
      `${lemma}: candidate outcome is not what the reviewer's raw output yields`);
    if (raw.verdict !== 'pass') {
      assert.equal(reviewByLemma.has(lemma), false, `${lemma}: a reviewer hold cannot carry a review row`);
      return;
    }
    passes += 1;
    const gloss = glossByLemma.get(lemma);
    assert.ok(nonEmpty(gloss), `${lemma}: no gloss to bind the reviewer pass to`);
    assert.deepEqual(reviewByLemma.get(lemma), reviewFromRaw({ lemma, gloss, raw }),
      `${lemma}: review row is not what the reviewer's raw output yields`);
  });
  assert.equal(input.reviews.length, passes, 'review rows must exist exactly for the reviewer passes');
}
