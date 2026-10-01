import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { sha256Json } from '../validate/semantic-audit.mjs';
import {
  assertInputDerivedFromRaw,
  outcomeFromRaw,
  reviewFromRaw,
  runSummaries,
} from './reviewer-raw-outputs.mjs';

const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const BATCH = 'issue-223-m9-e-corpus-batch-06-20261001';
const GLOSS = '소리나 움직임이 이어지며 이루는 흐름';
const rows = [{ morphology_proposal: { lemma: '가락' } }, { morphology_proposal: { lemma: '나락' } }];
const glossByLemma = new Map([['가락', GLOSS]]);

const passRaw = {
  ordinal: 1, lemma: '가락', identity: 'ok', pos: 'ok', gloss: 'fit', sense_boundary: 'single',
  verdict: 'pass', generator_agreement: 'agree', sense_note: '하나의 의미다.', use_note: '결을 짚는다.',
  frames: ['“가락”이 번졌다.'], note_hit_checked: [1, 0, 1],
};
const holdRaw = {
  ordinal: 2, lemma: '나락', identity: 'ok', pos: 'ok', gloss: 'misfit', sense_boundary: 'multiple',
  verdict: 'hold', generator_agreement: 'disagree', hold_basis: 'unresolved-identity', hold_rationale: '근거가 모호하다.',
};

const PROPOSALS = [
  { ordinal: 1, lemma: '가락', disposition: 'admit', gloss: GLOSS },
  { ordinal: 2, lemma: '나락', disposition: 'hold' },
];
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

function fixture(outputs = [passRaw, holdRaw], proposals = PROPOSALS) {
  const rawArtifact = {
    schema_version: '1',
    contract_version: 'reviewer-raw-outputs-v1',
    kind: 'reviewer-raw-outputs',
    batch_id: BATCH,
    reviewer: 'reviewer-a',
    reviewed_proposals: proposals,
    runs: [
      { run: 1, context: 'isolated-subagent', model: 'm', first_ordinal: 1, last_ordinal: 1, candidate_count: 1, packet_sha256: HEX_A, proposals_sha256: sha256Json(proposals.slice(0, 1)), raw_output_sha256: sha256Json(outputs.slice(0, 1)), outputs: outputs.slice(0, 1) },
      { run: 2, context: 'isolated-subagent', model: 'm', first_ordinal: 2, last_ordinal: 2, candidate_count: 1, packet_sha256: HEX_B, proposals_sha256: sha256Json(proposals.slice(1)), raw_output_sha256: sha256Json(outputs.slice(1)), outputs: outputs.slice(1) },
    ],
  };
  const rawBytes = Buffer.from(JSON.stringify(rawArtifact));
  const input = {
    batch_id: BATCH,
    reviewer: 'reviewer-a',
    generator_proposal_sha256: sha256Json(proposals),
    raw_outputs_sha256: sha256Bytes(rawBytes),
    review_runs: runSummaries(rawArtifact),
    reviews: [reviewFromRaw({ lemma: '가락', gloss: GLOSS, raw: passRaw })],
    candidate_outcomes: [outcomeFromRaw('admit', passRaw), outcomeFromRaw('hold', holdRaw)],
  };
  return { input, rawArtifact, rawBytes, candidateRows: rows, glossByLemma, sha256Bytes };
}

// Rebuild a consistent artifact/input pair from a mutated artifact, so a test
// can change one thing and still pass every digest check except the one under test.
function rebind(base, mutate) {
  const rawArtifact = structuredClone(base.rawArtifact);
  mutate(rawArtifact);
  const rawBytes = Buffer.from(JSON.stringify(rawArtifact));
  return {
    ...base,
    rawArtifact,
    rawBytes,
    input: {
      ...base.input,
      raw_outputs_sha256: sha256Bytes(rawBytes),
      generator_proposal_sha256: Array.isArray(rawArtifact.reviewed_proposals)
        ? sha256Json(rawArtifact.reviewed_proposals)
        : base.input.generator_proposal_sha256,
      review_runs: runSummaries(rawArtifact),
    },
  };
}

const check = (args) => assertInputDerivedFromRaw(args);

test('a review input that is a function of the preserved raw outputs passes', () => {
  check(fixture());
  // The producer's agreement label is derived, never copied: an admit proposal
  // agrees exactly when the reviewer passes it.
  assert.equal(outcomeFromRaw('admit', holdRaw).generator_agreement, 'disagree');
  assert.equal(outcomeFromRaw('admit', passRaw).generator_agreement, 'agree');
  assert.equal(outcomeFromRaw('hold', { ...holdRaw, generator_agreement: 'agree' }).generator_agreement, 'agree');
  assert.deepEqual(outcomeFromRaw('admit', passRaw).checked_hit_indices, [0, 1]);
});

test('tampered or mismatched raw outputs fail', () => {
  const base = fixture();
  assert.throws(() => check({ ...base, rawBytes: Buffer.concat([base.rawBytes, Buffer.from(' ')]) }), /digest bound in the input/u);
  const edited = structuredClone(base.rawArtifact);
  edited.runs[0].outputs[0].sense_note = '바뀐 근거.';
  const editedBytes = Buffer.from(JSON.stringify(edited));
  assert.throws(() => check({ ...base, rawArtifact: edited, rawBytes: editedBytes, input: { ...base.input, raw_outputs_sha256: sha256Bytes(editedBytes) } }), /recorded digest/u);
  assert.throws(() => check({ ...base, input: { ...base.input, batch_id: 'issue-223-m9-e-corpus-batch-07-20261001' } }), /different batch/u);
  assert.throws(() => check({ ...base, input: { ...base.input, reviewer: 'someone-else' } }), /different reviewer/u);
  assert.throws(() => check({ ...base, rawArtifact: { ...base.rawArtifact, kind: 'other' } }), /wrong kind/u);
});

test('runs must cover every candidate exactly once, in order', () => {
  const base = fixture();
  const gap = structuredClone(base.rawArtifact);
  gap.runs[1].first_ordinal = 3;
  gap.runs[1].last_ordinal = 3;
  const gapBytes = Buffer.from(JSON.stringify(gap));
  assert.throws(() => check({ ...base, rawArtifact: gap, rawBytes: gapBytes, input: { ...base.input, raw_outputs_sha256: sha256Bytes(gapBytes) } }), /must start at candidate 2/u);
  const short = structuredClone(base.rawArtifact);
  short.runs.pop();
  const shortBytes = Buffer.from(JSON.stringify(short));
  assert.throws(() => check({ ...base, rawArtifact: short, rawBytes: shortBytes, input: { ...base.input, raw_outputs_sha256: sha256Bytes(shortBytes), review_runs: runSummaries(short) } }), /every candidate/u);
  assert.throws(() => check({ ...base, input: { ...base.input, review_runs: [] } }), /run information does not match/u);
});

test('an input that departs from what the raw outputs yield fails', () => {
  const base = fixture();
  const rejects = (name, change, pattern) => {
    const input = structuredClone(base.input);
    change(input);
    assert.throws(() => check({ ...base, input }), pattern, name);
  };
  rejects('outcome rewritten', (i) => { i.candidate_outcomes[1].hold_rationale = '다른 사유.'; }, /not what the reviewer's raw output yields/u);
  rejects('verdict flipped', (i) => { i.candidate_outcomes[0].verdict = 'hold'; }, /not what the reviewer's raw output yields/u);
  rejects('review text edited', (i) => { i.reviews[0].boundary_rationale = '가락: 편집됨.'; }, /review row is not what/u);
  rejects('frame edited', (i) => { i.reviews[0].frames[0].sentence_frame = '다른 문장 “가락”'; }, /review row is not what/u);
  rejects('hold carries a review row', (i) => { i.reviews.push({ ...i.reviews[0], lemma: '나락' }); }, /cannot carry a review row/u);
  rejects('pass lacks its review row', (i) => { i.reviews = []; }, /review row is not what|exactly for the reviewer passes/u);
  rejects('extra review row count', (i) => { i.reviews.push(structuredClone(i.reviews[0])); }, /exactly for the reviewer passes/u);
});

test('the raw reviewer result is bound to the exact gloss it assessed', () => {
  const base = fixture();
  // The reviewer saw GLOSS and said fit. Changing the admitted gloss while the
  // reviewer outputs stay unchanged must be rejected, even if the review row is
  // regenerated for the new gloss.
  assert.throws(
    () => check({ ...base, glossByLemma: new Map([['가락', '전혀 다른 풀이']]) }),
    /admitted gloss differs from the gloss the reviewer assessed/u,
  );
  const regenerated = { ...base, glossByLemma: new Map([['가락', '바뀐 풀이']]) };
  regenerated.input = { ...base.input, reviews: [reviewFromRaw({ lemma: '가락', gloss: '바뀐 풀이', raw: passRaw })] };
  assert.throws(() => check(regenerated), /admitted gloss differs/u);
  // Rewriting the preserved proposal to match a changed gloss breaks its digests.
  const forgedProposals = structuredClone(PROPOSALS);
  forgedProposals[0].gloss = '바뀐 풀이';
  const forged = fixture([passRaw, holdRaw], PROPOSALS);
  const withForgedProposal = { ...forged, rawArtifact: { ...forged.rawArtifact, reviewed_proposals: forgedProposals } };
  const forgedBytes = Buffer.from(JSON.stringify(withForgedProposal.rawArtifact));
  assert.throws(
    () => check({ ...withForgedProposal, rawBytes: forgedBytes, glossByLemma: new Map([['가락', '바뀐 풀이']]), input: { ...forged.input, raw_outputs_sha256: sha256Bytes(forgedBytes) } }),
    /review input does not match the digest of the reviewed proposals|did not review the recorded proposals/u,
  );
});

test('reviewed proposals must be preserved, hashed, and consistent with the outcomes', () => {
  const base = fixture();
  assert.throws(() => check(rebind(base, (a) => { delete a.reviewed_proposals; })), /reviewed proposal for every candidate/u);
  assert.throws(() => check(rebind(base, (a) => { a.reviewed_proposals.pop(); })), /every candidate/u);
  assert.throws(() => check(rebind(base, (a) => { a.reviewed_proposals[1].lemma = '다락'; })), /different lemma/u);
  assert.throws(() => check(rebind(base, (a) => { delete a.reviewed_proposals[0].gloss; })), /must preserve its gloss/u);
  assert.throws(() => check(rebind(base, (a) => { a.reviewed_proposals[1].gloss = '풀이'; })), /carries no gloss/u);
  assert.throws(() => check({ ...base, input: { ...base.input, generator_proposal_sha256: HEX_A } }), /digest of the reviewed proposals/u);
  // A run must have reviewed the proposals recorded for its range.
  assert.throws(() => check(rebind(base, (a) => { a.runs[0].proposals_sha256 = HEX_A; })), /did not review the recorded proposals/u);
  // The outcome must name the proposal the reviewer was shown.
  const swapped = structuredClone(base.input);
  swapped.candidate_outcomes[0] = outcomeFromRaw('hold', passRaw);
  assert.throws(() => check({ ...base, input: swapped }), /different proposal than the reviewer was shown|not what the reviewer's raw output yields/u);
  // The recorded packet digest must be a SHA-256, not a placeholder.
  assert.throws(() => check(rebind(base, (a) => { a.runs[0].packet_sha256 = 'p1'; })), /packet's SHA-256/u);
  assert.throws(() => check(rebind(base, (a) => { a.runs[0].packet_sha256 = ''; })), /packet's SHA-256/u);
});
