import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assembleReviewed,
  assertSharedIntake,
  collectFailures,
  splitRunForAmendment,
  makeReviewerPackets,
  mergeAuthors,
  finalDecisionRow,
  passIdsFor,
  reviewerPacketCandidate,
  validateAuthorDecision,
  validateReviewerOutput,
} from './review-workflow.mjs';
import { contextWindow, packetCandidate, shardRanges } from './make-review-packets.mjs';
import { assertInputDerivedFromRaw, runRecordFromRaw } from './reviewer-raw-outputs.mjs';

const candidate = (lemma, { hits = 3, pos = 'noun', ambiguity = 'single_observed_analysis_unverified' } = {}) => ({
  proposed_lemma: lemma,
  proposed_pos: pos,
  analyzer_pos: pos === 'noun' ? 'NNG' : 'VV',
  coverage_status: 'uncovered',
  ambiguity_status: ambiguity,
  pos_interpretation_count_in_sample: 1,
  ambiguous_observed_surface_count_in_sample: 0,
  oov_morpheme_occurrences_in_sample: 0,
  typewriter_surface_matches: [],
  observed_surface_forms: [{ surface: `${lemma}이`, kiwi_morpheme_occurrences_in_sample: 3 }],
  observed_morpheme_spans: [{ surface: lemma }],
  evidence: {
    representative_hits: Array.from({ length: hits }, (_, index) => ({
      matched_surface_form: `${lemma}이`,
      context: `앞 문장이다. ${lemma}이 ${index}번째 문맥에 나온다. 뒤 문장이다.`,
    })),
  },
});

const ADMIT = { ordinal: 1, lemma: '가락', disposition: 'admit', axis: 'S', gloss: '소리의 높낮이가 이어지며 이루는 흐름.' };
const HOLD = { ordinal: 2, lemma: '나락', disposition: 'hold', basis: 'unresolved-identity', rationale: '관찰형이 다른 표제어의 활용형뿐이다.' };

test('batch ids yield the three registered pass ids', () => {
  assert.deepEqual(passIdsFor('issue-223-m9-e-corpus-batch-10-20261002'), {
    generation_pass_id: 'issue-223-m9-e-corpus-batch-10-authored-generation-20261002-r1',
    candidate_review_pass_id: 'issue-223-m9-e-corpus-batch-10-lexical-review-20261002-r1',
    semantic_verification_pass_id: 'issue-223-m9-e-corpus-batch-10-semantic-verification-20261002-r1',
  });
  assert.throws(() => passIdsFor('not-a-batch'), /unsupported batch id/u);
});

test('author decisions are validated against their candidate and never defaulted', () => {
  const lemma = candidate('가락');
  assert.deepEqual(validateAuthorDecision(ADMIT, lemma, 1), {
    candidate_ordinal: 1, lemma: '가락', disposition: 'admit', axis: 'S', gloss: ADMIT.gloss,
  });
  assert.throws(() => validateAuthorDecision({ ...ADMIT, ordinal: 2 }, lemma, 1), /ordinal mismatch/u);
  assert.throws(() => validateAuthorDecision({ ...ADMIT, lemma: '다른' }, lemma, 1), /different lemma/u);
  assert.throws(() => validateAuthorDecision({ ...ADMIT, axis: 'Z' }, lemma, 1), /unsupported axis/u);
  assert.throws(() => validateAuthorDecision({ ...ADMIT, gloss: '마침표 없는 풀이' }, lemma, 1), /ending in a period/u);
  assert.throws(() => validateAuthorDecision({ ordinal: 1, lemma: '가락', disposition: 'maybe' }, lemma, 1), /admit or hold/u);
  assert.throws(() => validateAuthorDecision({ ...HOLD, ordinal: 1, lemma: '가락', basis: 'low-value' }, lemma, 1), /hold basis/u);
  assert.throws(() => validateAuthorDecision({ ...HOLD, ordinal: 1, lemma: '가락', basis: 'unresolved-sense' }, lemma, 1), /at least two directions/u);
  assert.throws(() => validateAuthorDecision({
    ordinal: 1, lemma: '가락', disposition: 'hold', basis: 'unresolved-sense', rationale: '두 갈래다.',
    directions: [{ label: '가', hit_indices: [0] }, { label: '나', hit_indices: [7] }],
  }, lemma, 1), /outside the 3 bounded contexts/u);
  assert.throws(() => validateAuthorDecision({ ...ADMIT, corrected_pos: 'noun' }, lemma, 1), /invalid corrected POS/u);
});

test('the reviewer packet carries the exact proposal but never the author rationale', () => {
  const evidence = packetCandidate(candidate('나락'), 2);
  const packet = reviewerPacketCandidate(evidence, { ...HOLD }, candidate('나락'));
  assert.deepEqual(packet.proposal, { disposition: 'hold', hold_basis: 'unresolved-identity' });
  assert.ok(!JSON.stringify(packet).includes(HOLD.rationale));
  const admitted = reviewerPacketCandidate(packetCandidate(candidate('가락'), 1), ADMIT, candidate('가락'));
  assert.equal(admitted.proposal.gloss, ADMIT.gloss);
  assert.equal(admitted.frames_required, 1);
  const gated = reviewerPacketCandidate(
    packetCandidate(candidate('가락', { ambiguity: 'held_surface_has_multiple_analyzer_interpretations' }), 1),
    ADMIT,
    candidate('가락', { ambiguity: 'held_surface_has_multiple_analyzer_interpretations' }),
  );
  assert.match(gated.admission_gate_note, /morphology-blocker/u);
});

const PASS = {
  ordinal: 1, lemma: '가락', identity: 'ok', pos: 'ok', gloss: 'fit', sense_boundary: 'single', verdict: 'pass', generator_agreement: 'agree',
  sense_note: '문맥 0, 1, 2 모두 같은 소리의 흐름을 가리킨다.', use_note: '음악이나 말투의 흐름을 묘사할 때 쓴다.',
  frames: ['느린 가락이 방 안을 채웠다.'], note_hit_checked: [0, 1, 2],
};

test('reviewer outputs must carry their own verdicts, frames and context checks', () => {
  const lemma = candidate('가락');
  const proposal = { ordinal: 1, lemma: '가락', disposition: 'admit', gloss: ADMIT.gloss };
  assert.equal(validateReviewerOutput(PASS, proposal, lemma, 1), PASS);
  assert.throws(() => validateReviewerOutput({ ...PASS, frames: [] }, proposal, lemma, 1), /exactly 1 frame/u);
  assert.throws(() => validateReviewerOutput({ ...PASS, frames: ['소리가 이어졌다.'] }, proposal, lemma, 1), /contains the lemma/u);
  assert.throws(() => validateReviewerOutput({ ...PASS, note_hit_checked: [0, 0] }, proposal, lemma, 1), /twice/u);
  assert.throws(() => validateReviewerOutput({ ...PASS, note_hit_checked: [5] }, proposal, lemma, 1), /outside/u);
  assert.throws(() => validateReviewerOutput({ ...PASS, gloss: 'misfit' }, proposal, lemma, 1), /every axis/u);
  assert.throws(() => validateReviewerOutput(PASS, { ...proposal, disposition: 'hold', hold_basis: 'unresolved-identity' }, lemma, 1), /cannot pass a proposed hold/u);
  assert.throws(() => validateReviewerOutput({ ...PASS, lemma: '다른' }, proposal, lemma, 1), /different lemma/u);

  const hold = {
    ordinal: 1, lemma: '가락', identity: 'ok', pos: 'ok', gloss: 'misfit', sense_boundary: 'multiple', verdict: 'hold', generator_agreement: 'disagree',
    hold_basis: 'unresolved-sense', hold_rationale: '두 갈래라서 한 풀이로 묶을 수 없다.',
    directions: [{ label: '소리', hit_indices: [0] }, { label: '자세', hit_indices: [1, 2] }],
  };
  assert.equal(validateReviewerOutput(hold, proposal, lemma, 1), hold);
  assert.throws(() => validateReviewerOutput({ ...hold, generator_agreement: 'agree' }, proposal, lemma, 1), /disagreement/u);
  assert.throws(() => validateReviewerOutput({ ...hold, directions: [hold.directions[0]] }, proposal, lemma, 1), /directions/u);
  const holdProposal = { ordinal: 1, lemma: '가락', disposition: 'hold', hold_basis: 'unresolved-identity' };
  assert.throws(() => validateReviewerOutput({ ...hold, gloss: 'misfit' }, holdProposal, lemma, 1), /carries no gloss/u);
  const noGloss = {
    ordinal: 1, lemma: '가락', identity: 'ok', pos: 'ok', gloss: 'n/a', sense_boundary: 'single', verdict: 'hold', generator_agreement: 'disagree',
    hold_basis: 'no-gloss-proposed', hold_rationale: '막는 요인은 없으나 풀이가 제안되지 않았다.',
  };
  assert.equal(validateReviewerOutput(noGloss, holdProposal, lemma, 1), noGloss);
  assert.throws(() => validateReviewerOutput(noGloss, proposal, lemma, 1), /only a proposed hold/u);
  assert.throws(() => validateReviewerOutput({ ...noGloss, identity: 'unresolved' }, holdProposal, lemma, 1), /must not record a lexical blocker/u);
  assert.throws(() => validateReviewerOutput({
    ...hold, hold_basis: 'unresolved-identity', sense_boundary: 'single', gloss: 'fit',
  }, holdProposal, lemma, 1), /carries no gloss|identity hold/u);
});

test('only a reviewer-changed admission becomes a reviewer-authored hold', () => {
  const admit = { candidate_ordinal: 1, lemma: '가락', disposition: 'admit', axis: 'S', gloss: ADMIT.gloss };
  assert.equal(finalDecisionRow(admit, PASS), admit);
  const changed = finalDecisionRow(admit, {
    verdict: 'hold', hold_basis: 'unresolved-sense', hold_rationale: '두 갈래다.', directions: [{ label: 'a', hit_indices: [0] }, { label: 'b', hit_indices: [1] }],
  });
  assert.deepEqual(changed, {
    candidate_ordinal: 1, lemma: '가락', disposition: 'hold', basis: 'unresolved-sense', rationale: '두 갈래다.',
    directions: [{ label: 'a', hit_indices: [0] }, { label: 'b', hit_indices: [1] }],
  });
  const authorHold = { candidate_ordinal: 2, lemma: '나락', disposition: 'hold', basis: 'unresolved-identity', rationale: '작성자 보류.' };
  assert.equal(finalDecisionRow(authorHold, { verdict: 'hold', hold_basis: 'no-gloss-proposed', hold_rationale: '다른 설명.' }), authorHold);
});

test('packet windows stay bounded and shards cover every candidate once', () => {
  const long = `${'가'.repeat(900)} 목표어가 나온다 ${'나'.repeat(900)}`;
  const window = contextWindow(long, '목표어가');
  assert.ok(window.length < 400 && window.includes('목표어가') && window.startsWith('…') && window.endsWith('…'));
  assert.equal(contextWindow('짧은 문장.', '없는말'), '짧은 문장.');
  assert.deepEqual(shardRanges(10, 3), [
    { shard: 1, first_ordinal: 1, last_ordinal: 4 },
    { shard: 2, first_ordinal: 5, last_ordinal: 7 },
    { shard: 3, first_ordinal: 8, last_ordinal: 10 },
  ]);
  assert.deepEqual(shardRanges(2, 5).map(({ shard }) => shard), [1, 2]);
});

test('assemble derives the tracked input and run record from worker outputs only', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-workflow-'));
  try {
    const batchId = 'issue-223-m9-e-corpus-batch-10-20261002';
    const candidates = [candidate('가락'), candidate('나락'), candidate('다락')];
    await mkdir(path.join(directory, 'reviewed'), { recursive: true });
    await mkdir(path.join(directory, 'review-packets'), { recursive: true });
    const decisions = [
      { candidate_ordinal: 1, lemma: '가락', disposition: 'admit', axis: 'S', gloss: ADMIT.gloss },
      { candidate_ordinal: 2, lemma: '나락', disposition: 'hold', basis: 'unresolved-identity', rationale: '관찰형이 다른 표제어의 활용형뿐이다.' },
      { candidate_ordinal: 3, lemma: '다락', disposition: 'admit', axis: 'O', gloss: '지붕 바로 아래에 만든 좁은 공간.' },
    ];
    await writeFile(path.join(directory, 'candidate-inventory.json'), JSON.stringify({ candidates }));
    await writeFile(path.join(directory, 'candidate-evidence.json'), JSON.stringify({ candidates }));
    await writeFile(path.join(directory, 'authored-decisions.generator.json'), JSON.stringify({ decisions }));
    await writeFile(path.join(directory, 'review-packets/review-packet-manifest.json'), JSON.stringify([
      { shard: 1, first_ordinal: 1, last_ordinal: 3, candidate_count: 3, packet_sha256: 'a'.repeat(64) },
    ]));
    const outputs = [
      PASS,
      {
        ordinal: 2, lemma: '나락', identity: 'unresolved', pos: 'ok', gloss: 'n/a', sense_boundary: 'single', verdict: 'hold',
        generator_agreement: 'agree', hold_basis: 'unresolved-identity', hold_rationale: '관찰형이 모두 파생형이라 단독 명사가 확인되지 않는다.',
      },
      {
        ordinal: 3, lemma: '다락', identity: 'ok', pos: 'ok', gloss: 'misfit', sense_boundary: 'multiple', verdict: 'hold', generator_agreement: 'disagree',
        hold_basis: 'unresolved-sense', hold_rationale: '문맥 0은 방의 위층이고 문맥 1은 높은 선반이라 풀이가 두 갈래를 가린다.',
        directions: [{ label: '방의 위층', hit_indices: [0] }, { label: '높은 선반', hit_indices: [1, 2] }],
      },
    ];
    await writeFile(path.join(directory, 'reviewed/review-01.json'), JSON.stringify(outputs));

    const { artifacts, ...summary } = await assembleReviewed({ batchId, directory: path.relative(process.cwd(), directory), writeTracked: false });
    assert.equal(artifacts.input.review_runs.length, 1);
    assert.equal(artifacts.input.candidate_outcomes.length, 3);
    assert.deepEqual(summary, { candidates: 3, admit: 1, hold: 2, reviewer_changed_admit_to_hold: 1, review_rows: 1 });

    const final = JSON.parse(await readFile(path.join(directory, 'authored-decisions.json'), 'utf8'));
    assert.equal(final.decisions[2].disposition, 'hold');
    assert.equal(final.decisions[2].rationale, outputs[2].hold_rationale);
    assert.equal(final.decisions[1].rationale, decisions[1].rationale, 'an author hold is kept as the author wrote it');

    const raw = JSON.parse(await readFile(path.join(directory, 'reviewer-raw-outputs.json'), 'utf8'));
    assert.equal(raw.runs[0].packet_sha256, 'a'.repeat(64));
    assert.deepEqual(raw.reviewed_proposals.map(({ disposition }) => disposition), ['admit', 'hold', 'admit']);
    assert.equal(runRecordFromRaw(raw).runs[0].proposals_sha256.length, 64);
    assert.ok(!JSON.stringify(runRecordFromRaw(raw)).includes('지붕'), 'the tracked run record never carries gloss text');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('assertInputDerivedFromRaw stays the shared check for assembled inputs', () => {
  assert.equal(typeof assertInputDerivedFromRaw, 'function');
});

test('the shared lexical intake rejects an unadmittable gloss before any review', () => {
  const ok = { ordinal: 1, lemma: '가락', disposition: 'admit', gloss: '소리의 높낮이가 이어지며 이루는 흐름.' };
  assert.doesNotThrow(() => assertSharedIntake(ok, candidate('가락')));
  assert.throws(() => assertSharedIntake({ ...ok, gloss: '마음속.' }, candidate('가락')), /at least two whitespace-delimited words/u);
  assert.doesNotThrow(() => assertSharedIntake({ disposition: 'hold' }, candidate('가락')));
});

test('all worker failures are reported together', () => {
  assert.throws(() => collectFailures([1, 2, 3], (value) => { if (value !== 2) throw new Error(`bad ${value}`); }),
    (error) => /2 worker output\(s\) failed/u.test(error.message) && /bad 1/u.test(error.message) && /bad 3/u.test(error.message));
  assert.doesNotThrow(() => collectFailures([1], () => {}));
});

test('an amended candidate gets its own run and the other rows keep their original run', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-workflow-split-'));
  try {
    const candidates = ['가락', '나락', '다락', '라락'].map((lemma) => candidate(lemma));
    const decisions = candidates.map((entry, index) => ({
      candidate_ordinal: index + 1, lemma: entry.proposed_lemma, disposition: 'admit', axis: 'O', gloss: `${entry.proposed_lemma}의 올바른 풀이.`,
    }));
    await mkdir(path.join(directory, 'reviewed'));
    await mkdir(path.join(directory, 'review-packets'));
    await writeFile(path.join(directory, 'candidate-inventory.json'), JSON.stringify({ candidates }));
    await writeFile(path.join(directory, 'candidate-evidence.json'), JSON.stringify({ candidates }));
    await writeFile(path.join(directory, 'authored-decisions.generator.json'), JSON.stringify({ decisions }));
    await writeFile(path.join(directory, 'review-packets/review-packet-manifest.json'), JSON.stringify([
      { shard: 1, first_ordinal: 1, last_ordinal: 4, file: 'review-packets/review-packet-01.json', candidate_count: 4, packet_sha256: 'b'.repeat(64) },
      { shard: 2, first_ordinal: 5, last_ordinal: 5, file: 'review-packets/review-packet-02.json', candidate_count: 1, packet_sha256: 'c'.repeat(64) },
    ]));
    await writeFile(path.join(directory, 'reviewed/review-01.json'), JSON.stringify([{ ordinal: 1 }, { ordinal: 2 }, { ordinal: 3 }, { ordinal: 4 }]));
    await writeFile(path.join(directory, 'reviewed/review-02.json'), JSON.stringify([{ ordinal: 5 }]));
    const result = await splitRunForAmendment({ batchId: 'issue-223-m9-e-corpus-batch-10-20261002', directory: path.relative(process.cwd(), directory), shard: 1, ordinal: 2 });
    assert.equal(result.shards, 4);
    const manifest = JSON.parse(await readFile(path.join(directory, 'review-packets/review-packet-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.map(({ shard, first_ordinal: first, last_ordinal: last }) => [shard, first, last]), [[1, 1, 1], [2, 2, 2], [3, 3, 4], [4, 5, 5]]);
    assert.equal(manifest[0].packet_sha256, 'b'.repeat(64));
    assert.equal(manifest[2].packet_sha256, 'b'.repeat(64));
    assert.notEqual(manifest[1].packet_sha256, 'b'.repeat(64));
    const read = async (name) => JSON.parse(await readFile(path.join(directory, 'reviewed', name), 'utf8'));
    assert.deepEqual(await read('review-01.json'), [{ ordinal: 1 }]);
    assert.deepEqual(await read('review-03.json'), [{ ordinal: 3 }, { ordinal: 4 }]);
    assert.deepEqual(await read('review-04.json'), [{ ordinal: 5 }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the legacy fan-out entrypoints refuse batch 11 and later', async () => {
  const later = 'issue-223-m9-e-corpus-batch-11-20261003';
  await assert.rejects(() => makeReviewerPackets({ batchId: later, directory: 'unused', shards: 5 }), /self-check contract/u);
  await assert.rejects(() => splitRunForAmendment({ batchId: later, directory: 'unused', shard: 1, ordinal: 1 }), /self-check contract/u);
  await assert.rejects(() => mergeAuthors({ batchId: later, directory: 'unused' }), /primary agent/u);
});

test('self-check evidence gate accepts context-specific passes and rejects templated or definition-only ones', async () => {
  const { assertSelfCheckEvidenceIsSpecific } = await import('./review-workflow.mjs');
  const mk = (ordinal, lemma, gloss, sense, frame, use = `${lemma}의 쓰임을 ${ordinal}번째로 점검했다.`) => ({
    ordinal, lemma, verdict: 'pass', note_hit_checked: [0, 1], sense_note: sense, use_note: use, frames: [frame],
  });
  const SCENES = ['시장 골목', '학교 운동장', '병원 복도', '강가 나루', '산속 절간', '공항 대합실', '부엌 아궁이', '극장 로비', '공장 창고', '도서관 열람실', '항구 부두', '들판 논둑'];
  const proposals = Array.from({ length: 12 }, (_, i) => ({ gloss: `풀이 번호 ${i}.` }));
  const good = Array.from({ length: 12 }, (_, i) => mk(i + 1, `낱말${i}`, '', `문맥 0: ${SCENES[i]}에서 쓰임; 문맥 1: ${SCENES[(i + 5) % 12]}을 가리킴`, `낱말${i}을 보았다.`, `${SCENES[i]}과 ${SCENES[(i + 7) % 12]}가 같은 뜻으로 읽힌다.`));
  assert.doesNotThrow(() => assertSelfCheckEvidenceIsSpecific(good, proposals));
  const templated = good.map((row) => ({ ...row, sense_note: `문맥 0·문맥 1 모두 ${row.lemma}의 풀이 「풀이 번호 ${row.ordinal - 1}」와 맞는다.`, use_note: '같은 뜻으로 읽힌다.' }));
  assert.throws(() => assertSelfCheckEvidenceIsSpecific(templated, proposals), /repeat the same/u);
  const missingContext = good.map((row, i) => (i === 0 ? { ...row, sense_note: '문맥 0만 확인했다.' } : row));
  assert.throws(() => assertSelfCheckEvidenceIsSpecific(missingContext, proposals), /checked context 1/u);
  const definition = good.map((row, i) => (i === 0 ? { ...row, frames: [`'${row.lemma}'은(는) '풀이'라는 뜻이다.`] } : row));
  assert.throws(() => assertSelfCheckEvidenceIsSpecific(definition, proposals), /usage sentence/u);
  const echo = good.map((row, i) => (i === 0 ? { ...row, frames: ['풀이 번호 0이 그대로 쓰였다.'] } : row));
  assert.throws(() => assertSelfCheckEvidenceIsSpecific(echo, proposals), /usage sentence/u);
});

test('reviewer frames for a verb must be real forms of the lemma, not a stem collision', () => {
  const verb = (lemma) => ({ ...candidate('가락'), proposed_lemma: lemma, proposed_pos: 'verb' });
  const out = (lemma, frame) => ({ ...PASS, lemma, frames: [frame] });
  const proposal = (lemma) => ({ ordinal: 1, lemma, disposition: 'admit', gloss: ADMIT.gloss });
  assert.doesNotThrow(() => validateReviewerOutput(out('가다', '그는 학교에 갔다.'), proposal('가다'), verb('가다'), 1));
  assert.doesNotThrow(() => validateReviewerOutput(out('듣다', '그 말을 들었다.'), proposal('듣다'), verb('듣다'), 1));
  assert.throws(() => validateReviewerOutput(out('가다', '눈을 감고 잤다.'), proposal('가다'), verb('가다'), 1), /citation form/u);
  const adj = (lemma) => ({ ...candidate('가락'), proposed_lemma: lemma, proposed_pos: 'adjective' });
  assert.doesNotThrow(() => validateReviewerOutput(out('예쁘다', '꽃이 예쁩니다.'), proposal('예쁘다'), adj('예쁘다'), 1));
  assert.throws(() => validateReviewerOutput(out('예쁘다', '우리 모두 예쁩시다.'), proposal('예쁘다'), adj('예쁘다'), 1), /citation form/u);
  assert.doesNotThrow(() => validateReviewerOutput(out('가다', '우리 함께 갑시다.'), proposal('가다'), verb('가다'), 1));
  assert.doesNotThrow(() => validateReviewerOutput(out('가다', '교장 선생님이 학교에 가십니다.'), proposal('가다'), verb('가다'), 1));
  assert.doesNotThrow(() => validateReviewerOutput(out('일하다', '그는 종일 일한 뒤에 쉬었다.'), proposal('일하다'), verb('일하다'), 1));
  assert.throws(() => validateReviewerOutput(out('일하다', '그는 종일 일하은 뒤에 쉬었다.'), proposal('일하다'), verb('일하다'), 1), /citation form/u);
  assert.doesNotThrow(() => validateReviewerOutput(out('가다', '선생님이 학교에 가시겠습니다!'), proposal('가다'), verb('가다'), 1));
  assert.doesNotThrow(() => validateReviewerOutput(out('가다', '선생님이 내일 학교에 가시겠다고 말씀하셨다.'), proposal('가다'), verb('가다'), 1));
  assert.throws(() => validateReviewerOutput(out('가다', '선생님이 학교에 가시겠말!'), proposal('가다'), verb('가다'), 1), /citation form/u);
  assert.throws(() => validateReviewerOutput(out('가다', '선생님이 학교에 가시겠.'), proposal('가다'), verb('가다'), 1), /citation form/u);
  assert.throws(() => validateReviewerOutput(out('가다', '선생님이 학교에 가시겠말.'), proposal('가다'), verb('가다'), 1), /citation form/u);
  assert.doesNotThrow(() => validateReviewerOutput(out('가다', '선생님은 학교에 가시겠어요?'), proposal('가다'), verb('가다'), 1));
  assert.doesNotThrow(() => validateReviewerOutput(out('묻다', '씨앗을 묻으세요.'), proposal('묻다'), verb('묻다'), 1));
  assert.doesNotThrow(() => validateReviewerOutput(out('묻다', '선생님께 물으세요.'), proposal('묻다'), verb('묻다'), 1));
  assert.doesNotThrow(() => validateReviewerOutput(out('듣다', '선생님이 그 말을 들으세요.'), proposal('듣다'), verb('듣다'), 1));
  assert.throws(() => validateReviewerOutput(out('듣다', '그 말을 듣으세요.'), proposal('듣다'), verb('듣다'), 1), /citation form/u);
  assert.doesNotThrow(() => validateReviewerOutput(out('오다', '여기 오세요.'), proposal('오다'), verb('오다'), 1));
  assert.doesNotThrow(() => validateReviewerOutput(out('가다', '그는 학교에 갑니다.'), proposal('가다'), verb('가다'), 1));
  assert.throws(() => validateReviewerOutput(out('듣다', '그 말을 듣어.'), proposal('듣다'), verb('듣다'), 1), /citation form/u);
  assert.throws(() => validateReviewerOutput(out('받다', '발을 씻었다.'), proposal('받다'), verb('받다'), 1), /citation form/u);
  assert.throws(() => validateReviewerOutput(out('가다', '그는 가게에서 책을 샀다.'), proposal('가다'), verb('가다'), 1), /citation form/u);
});
