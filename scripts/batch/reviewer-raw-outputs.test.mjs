import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { sha256Json } from '../validate/semantic-audit.mjs';
import {
  assertInputBoundToRunRecord,
  assertInputDerivedFromRaw,
  assertReviewNotesAreCandidateSpecific,
  outcomeFromRaw,
  proposalDigests,
  reviewFromRaw,
  runRecordFromRaw,
} from './reviewer-raw-outputs.mjs';

const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const BATCH = 'issue-223-m9-e-corpus-batch-06-20261001';
const GLOSS = '소리나 움직임이 이어지며 이루는 흐름';
const rows = [{ morphology_proposal: { lemma: '가락' } }, { morphology_proposal: { lemma: '나락' } }];
const glossByLemma = new Map([['가락', GLOSS]]);
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

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

// Local, staged raw outputs (never tracked).
function rawArtifactFor(outputs = [passRaw, holdRaw], proposals = PROPOSALS) {
  return {
    schema_version: '1',
    contract_version: 'reviewer-raw-outputs-v1',
    kind: 'reviewer-raw-outputs',
    batch_id: BATCH,
    reviewer: 'reviewer-a',
    reviewed_proposals: proposals,
    runs: [
      { run: 1, context: 'isolated-subagent', model: 'm', first_ordinal: 1, last_ordinal: 1, candidate_count: 1, packet_sha256: HEX_A, raw_output_sha256: sha256Json(outputs.slice(0, 1)), outputs: outputs.slice(0, 1) },
      { run: 2, context: 'isolated-subagent', model: 'm', first_ordinal: 2, last_ordinal: 2, candidate_count: 1, packet_sha256: HEX_B, raw_output_sha256: sha256Json(outputs.slice(1)), outputs: outputs.slice(1) },
    ],
  };
}

function fixture() {
  const rawArtifact = rawArtifactFor();
  const runRecord = runRecordFromRaw(rawArtifact);
  const runRecordBytes = Buffer.from(JSON.stringify(runRecord));
  const input = {
    batch_id: BATCH,
    reviewer: 'reviewer-a',
    generator_proposal_sha256: sha256Json(runRecord.reviewed_proposals),
    run_record_sha256: sha256Bytes(runRecordBytes),
    review_runs: runRecord.runs,
    reviews: [reviewFromRaw({ lemma: '가락', gloss: GLOSS, raw: passRaw })],
    candidate_outcomes: [outcomeFromRaw('admit', passRaw), outcomeFromRaw('hold', holdRaw)],
  };
  return { input, runRecord, runRecordBytes, rawArtifact, candidateRows: rows, glossByLemma, sha256Bytes };
}

// Rebuild a consistent record/input pair from a mutated run record so a test
// changes one thing and still passes every digest check except the one under test.
function rebindRecord(base, mutate) {
  const runRecord = structuredClone(base.runRecord);
  mutate(runRecord);
  const runRecordBytes = Buffer.from(JSON.stringify(runRecord));
  return {
    ...base,
    runRecord,
    runRecordBytes,
    input: {
      ...base.input,
      run_record_sha256: sha256Bytes(runRecordBytes),
      generator_proposal_sha256: Array.isArray(runRecord.reviewed_proposals)
        ? sha256Json(runRecord.reviewed_proposals)
        : base.input.generator_proposal_sha256,
      review_runs: runRecord.runs,
    },
  };
}

const bound = (args) => assertInputBoundToRunRecord(args);
const derived = (args) => assertInputDerivedFromRaw(args);

test('the tracked run record holds metadata and digests only, never gloss text or model prose', () => {
  const { runRecord } = fixture();
  const text = JSON.stringify(runRecord);
  for (const forbidden of [GLOSS, passRaw.sense_note, passRaw.frames[0], holdRaw.hold_rationale]) {
    assert.equal(text.includes(forbidden), false, `run record must not contain ${forbidden}`);
  }
  assert.equal(runRecord.reviewed_proposals[0].gloss_sha256, sha256Json(GLOSS));
  assert.equal('outputs' in runRecord.runs[0], false);
  assert.deepEqual(proposalDigests(PROPOSALS), runRecord.reviewed_proposals);
});

test('an input bound to its run record passes the tracked-artifact check', () => {
  bound(fixture());
  assert.equal(outcomeFromRaw('admit', holdRaw).generator_agreement, 'disagree');
  assert.equal(outcomeFromRaw('admit', passRaw).generator_agreement, 'agree');
  assert.equal(outcomeFromRaw('hold', { ...holdRaw, generator_agreement: 'agree' }).generator_agreement, 'agree');
  assert.deepEqual(outcomeFromRaw('admit', passRaw).checked_hit_indices, [0, 1]);
});

test('the reviewer result is bound to the exact gloss it assessed', () => {
  const base = fixture();
  // The reviewer saw GLOSS and said fit. A gloss changed after review is rejected
  // even if the review row is regenerated for the new gloss.
  assert.throws(() => bound({ ...base, glossByLemma: new Map([['가락', '전혀 다른 풀이']]) }), /admitted gloss differs from the gloss the reviewer assessed/u);
  const regenerated = { ...base, glossByLemma: new Map([['가락', '바뀐 풀이']]) };
  regenerated.input = { ...base.input, reviews: [reviewFromRaw({ lemma: '가락', gloss: '바뀐 풀이', raw: passRaw })] };
  assert.throws(() => bound(regenerated), /admitted gloss differs/u);
  // A review row that was built for a different gloss is not bound to the reviewed one.
  const wrongRow = structuredClone(base.input);
  wrongRow.reviews[0].gloss_sha256 = sha256Json('다른 풀이');
  assert.throws(() => bound({ ...base, input: wrongRow }), /not bound to the gloss the reviewer assessed/u);
  // Rewriting the recorded gloss digest to match a changed gloss breaks the proposal digests.
  const forged = structuredClone(base.runRecord);
  forged.reviewed_proposals[0].gloss_sha256 = sha256Json('바뀐 풀이');
  const forgedBytes = Buffer.from(JSON.stringify(forged));
  assert.throws(() => bound({ ...base, runRecord: forged, runRecordBytes: forgedBytes, glossByLemma: new Map([['가락', '바뀐 풀이']]), input: { ...base.input, run_record_sha256: sha256Bytes(forgedBytes) } }), /digest of the reviewed proposals|did not review the recorded proposals/u);
});

test('tampered or mismatched run records fail', () => {
  const base = fixture();
  assert.throws(() => bound({ ...base, runRecordBytes: Buffer.concat([base.runRecordBytes, Buffer.from(' ')]) }), /digest bound in the input/u);
  assert.throws(() => bound({ ...base, input: { ...base.input, batch_id: 'issue-223-m9-e-corpus-batch-07-20261001' } }), /different batch/u);
  assert.throws(() => bound({ ...base, input: { ...base.input, reviewer: 'someone-else' } }), /different reviewer/u);
  assert.throws(() => bound({ ...base, runRecord: { ...base.runRecord, kind: 'other' } }), /wrong kind/u);
  assert.throws(() => bound({ ...base, input: { ...base.input, review_runs: [] } }), /run information does not match/u);
});

test('runs must cover every candidate exactly once, with real digests', () => {
  const base = fixture();
  assert.throws(() => bound(rebindRecord(base, (r) => { r.runs[1].first_ordinal = 3; r.runs[1].last_ordinal = 3; })), /must start at candidate 2/u);
  assert.throws(() => bound(rebindRecord(base, (r) => { r.runs.pop(); })), /every candidate/u);
  assert.throws(() => bound(rebindRecord(base, (r) => { r.runs[0].packet_sha256 = 'p1'; })), /packet's SHA-256/u);
  assert.throws(() => bound(rebindRecord(base, (r) => { r.runs[0].packet_sha256 = ''; })), /packet's SHA-256/u);
  assert.throws(() => bound(rebindRecord(base, (r) => { r.runs[0].raw_output_sha256 = 'x'; })), /raw output's SHA-256/u);
  assert.throws(() => bound(rebindRecord(base, (r) => { r.runs[0].context = ''; })), /record its context/u);
});

test('reviewed proposal digests must be preserved and consistent with the outcomes', () => {
  const base = fixture();
  assert.throws(() => bound(rebindRecord(base, (r) => { delete r.reviewed_proposals; })), /proposal digest for every candidate/u);
  assert.throws(() => bound(rebindRecord(base, (r) => { r.reviewed_proposals.pop(); })), /every candidate/u);
  assert.throws(() => bound(rebindRecord(base, (r) => { r.reviewed_proposals[1].lemma = '다락'; })), /different lemma/u);
  assert.throws(() => bound(rebindRecord(base, (r) => { delete r.reviewed_proposals[0].gloss_sha256; })), /gloss digest/u);
  assert.throws(() => bound(rebindRecord(base, (r) => { r.reviewed_proposals[1].gloss_sha256 = HEX_A; })), /carries no gloss digest/u);
  assert.throws(() => bound({ ...base, input: { ...base.input, generator_proposal_sha256: HEX_A } }), /digest of the reviewed proposals/u);
  assert.throws(() => bound(rebindRecord(base, (r) => { r.runs[0].proposals_sha256 = HEX_A; })), /did not review the recorded proposals/u);
  const swapped = structuredClone(base.input);
  swapped.candidate_outcomes[0] = outcomeFromRaw('hold', passRaw);
  assert.throws(() => bound({ ...base, input: swapped }), /different proposal than the reviewer was shown/u);
});

test('review rows exist exactly for reviewer passes', () => {
  const base = fixture();
  const rejects = (change, pattern) => {
    const input = structuredClone(base.input);
    change(input);
    assert.throws(() => bound({ ...base, input }), pattern);
  };
  rejects((i) => { i.reviews.push({ ...i.reviews[0], lemma: '나락' }); }, /cannot carry a review row/u);
  rejects((i) => { i.reviews = []; }, /needs its review row/u);
  rejects((i) => { i.reviews.push(structuredClone(i.reviews[0])); }, /exactly for the reviewer passes/u);
});

test('the outcome and the review row must cite the same verdicts and contexts, even with recomputed digests', () => {
  const base = fixture();
  const rejects = (name, change, pattern) => {
    const input = structuredClone(base.input);
    change(input);
    assert.throws(() => bound({ ...base, input }), pattern, name);
  };
  // The outcome says contexts [0,1] were checked; the review row (and so the
  // semantic decision) must not quietly cite different ones.
  rejects('review cites other contexts', (i) => { i.reviews[0].checked_hit_indices = [0]; }, /disagree on checked_hit_indices/u);
  rejects('outcome cites other contexts', (i) => { i.candidate_outcomes[0].checked_hit_indices = [1]; }, /disagree on checked_hit_indices/u);
  rejects('verdict axis differs', (i) => { i.reviews[0].identity_check = 'unresolved'; }, /disagree on identity_check/u);
  rejects('gloss verdict differs', (i) => { i.candidate_outcomes[0].gloss_check = 'misfit'; }, /disagree on gloss_check/u);
  rejects('boundary verdict differs', (i) => { i.reviews[0].sense_boundary_check = 'multiple'; }, /disagree on sense_boundary_check/u);
});

test('locally staged raw outputs re-derive the run record and the input', () => {
  const base = fixture();
  derived(base);
  const rejects = (name, change, pattern) => {
    const args = structuredClone({ input: base.input, runRecord: base.runRecord, rawArtifact: base.rawArtifact });
    change(args);
    assert.throws(() => derived({ ...base, ...args }), pattern, name);
  };
  rejects('raw edited after the record was made', (a) => { a.rawArtifact.runs[0].outputs[0].sense_note = '바뀐 근거.'; }, /recorded digest|run record is not what/u);
  rejects('record rewritten', (a) => { a.runRecord.runs[0].context = 'other'; }, /run record is not what the staged raw outputs yield/u);
  rejects('outcome rewritten', (a) => { a.input.candidate_outcomes[1].hold_rationale = '다른 사유.'; }, /not what the reviewer's raw output yields/u);
  rejects('verdict flipped', (a) => { a.input.candidate_outcomes[0].verdict = 'hold'; }, /not what the reviewer's raw output yields/u);
  rejects('review text edited', (a) => { a.input.reviews[0].boundary_rationale = '가락: 편집됨.'; }, /review row is not what/u);
  rejects('frame edited', (a) => { a.input.reviews[0].frames[0].sentence_frame = '다른 문장 “가락”'; }, /review row is not what/u);
  rejects('wrong kind', (a) => { a.rawArtifact.kind = 'other'; }, /wrong kind/u);
  // The staged proposal's gloss must be the admitted gloss.
  assert.throws(() => derived({ ...base, glossByLemma: new Map([['가락', '바뀐 풀이']]) }), /admitted gloss differs/u);
});

test('templated review notes are rejected, specific ones pass', () => {
  const row = (lemma, boundary, semantic) => ({ lemma, boundary_rationale: `${lemma}: ${boundary}`, semantic_rationale: `${lemma}: ${semantic}` });
  const specific = Array.from({ length: 20 }, (_, i) => row(`어${i}`, `맥락 0·1은 ${i}번 쓰임만 보여 한 뜻이다.`.replace(/[0-9]+번/u, `${'가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허'[i]}번`), `${i}에 맞는 고유한 설명이다 ${'가나다라마바사아자차카타파하'[i % 14]}.`));
  assertReviewNotesAreCandidateSpecific(specific);
  // One identical sentence for every pass (the rejected B07 shard 2 shape).
  const templated = Array.from({ length: 20 }, (_, i) => row(`어${i}`, '컨텍스트 0~2가 같은 하나의 풀이로 읽힌다.', '표제어의 쓰임을 짚는다.'));
  assert.throws(() => assertReviewNotesAreCandidateSpecific(templated), /reuse the same boundary_rationale text/u);
  // A couple of coincidental repeats are tolerated.
  const mostly = specific.map((r, i) => (i < 2 ? { ...r, boundary_rationale: `${r.lemma}: 같은 문장이다.` } : r));
  assertReviewNotesAreCandidateSpecific(mostly);
});
