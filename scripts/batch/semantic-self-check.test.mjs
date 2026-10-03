import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDecisionClaimsTruthful,
  assertLegacyReviewWorkflowAllowed,
  assertNoCorpusPhraseCopy,
  findCopiedContextPhrases,
  assertPrimaryAuthoringAllowed,
  assertReviewContractForBatch,
  assertSelfCheckBinding,
  assertVerbFramesGrammatical,
  frameUsesLemma,
  assertSelfCheckEnvelope,
  assertSourceClaimsTruthful,
  isSelfCheckInput,
  SELF_CHECK_PROVENANCE,
} from './semantic-self-check.mjs';
import { sha256Json } from '../validate/semantic-audit.mjs';

const AUTHOR = 'claude-sonnet-5-5';
const GLOSS = { text: '예시 뜻풀이' };

const NOTES = {
  가나: { boundary: '첫 용례는 장소를, 둘째 용례도 같은 장소를 가리킨다', semantic: '풀이의 핵심어가 두 용례 모두에서 확인된다' },
  다라: { boundary: '용례마다 대상이 달라 하나로 묶기 어렵다', semantic: '풀이가 한 용례에만 맞는다' },
  마바: { boundary: '동사형 활용만 보이며 다른 품사 용법이 없다', semantic: '풀이의 동작 서술이 용례의 흐름과 일치한다' },
};
const row = (lemma) => ({
  morphology_proposal: { lemma, pos: 'noun' },
  bounded_provenance: { representative_hits: [{}, {}, {}] },
});
const outcome = (ordinal, lemma, verdict) => (verdict === 'pass'
  ? {
    ordinal, lemma, verdict, identity_check: 'ok', pos_check: 'ok', gloss_check: 'fit', sense_boundary_check: 'single', checked_hit_indices: [0, 1],
  }
  : { ordinal, lemma, verdict });
const review = (lemma) => ({
  lemma,
  identity_check: 'ok',
  pos_check: 'ok',
  gloss_check: 'fit',
  sense_boundary_check: 'single',
  checked_hit_indices: [0, 1],
  gloss_sha256: sha256Json(GLOSS),
  boundary_rationale: `${lemma}: ${NOTES[lemma].boundary}`,
  semantic_rationale: `${lemma}: ${NOTES[lemma].semantic}`,
});

const fixture = () => {
  const candidateRows = [row('가나'), row('다라'), row('마바')];
  return {
    candidateRows,
    glossByLemma: new Map([['가나', GLOSS], ['다라', GLOSS], ['마바', GLOSS]]),
    input: {
      review_provenance: SELF_CHECK_PROVENANCE,
      independent_review: false,
      reviewer: AUTHOR,
      candidate_outcomes: [outcome(1, '가나', 'pass'), outcome(2, '다라', 'hold'), outcome(3, '마바', 'pass')],
      reviews: [review('가나'), review('마바')],
    },
  };
};
const clone = (value) => structuredClone(value);
const envelope = (input, ordinal = 11) => assertSelfCheckEnvelope(input, { ordinal, candidateAuthor: AUTHOR });
const binding = (f) => assertSelfCheckBinding(f);

test('an honest agent self-check is accepted', () => {
  const f = fixture();
  assert.ok(isSelfCheckInput(f.input));
  envelope(f.input);
  binding(f);
});

test('the self-check envelope rejects spoofed or missing provenance', () => {
  const base = fixture().input;
  const cases = {
    'missing provenance': (i) => { delete i.review_provenance; },
    'invalid provenance': (i) => { i.review_provenance = 'independent-review'; },
    'independent_review omitted': (i) => { delete i.independent_review; },
    'independent_review true': (i) => { i.independent_review = true; },
    'separate reviewer label': (i) => { i.reviewer = 'claude-sonnet-5-5-independent-reviewer'; },
    'review_runs artifact': (i) => { i.review_runs = []; },
    'run record digest': (i) => { i.run_record_sha256 = 'a'.repeat(64); },
    'proposal digest': (i) => { i.generator_proposal_sha256 = 'a'.repeat(64); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const input = clone(base);
    mutate(input);
    assert.throws(() => (isSelfCheckInput(input) ? envelope(input) : assert.fail('not a self-check')), undefined, name);
  }
  assert.throws(() => envelope(clone(base), 10), /from batch 11/u, 'earlier batches keep their original contract');
});

test('the self-check binding rejects inconsistent outcomes and reviews', () => {
  const cases = {
    'missing outcome': (f) => { f.input.candidate_outcomes.pop(); },
    'out-of-order outcome': (f) => { f.input.candidate_outcomes.reverse(); },
    'gloss digest mismatch': (f) => { f.input.reviews[0].gloss_sha256 = sha256Json({ text: '다른 뜻' }); },
    'held candidate carries a review': (f) => { f.input.reviews.push(review('다라')); },
    'passed candidate lacks a review': (f) => { f.input.reviews.pop(); },
    'review and outcome disagree': (f) => { f.input.reviews[0].checked_hit_indices = [2]; },
    'duplicate review lemma': (f) => { f.input.reviews.push(clone(f.input.reviews[0])); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const f = fixture();
    mutate(f);
    assert.throws(() => binding(f), undefined, name);
  }
});

test('the canonical source of a self-check batch never claims independent or human review', () => {
  const honest = () => ({
    provenance: { authoring_note: 'checked by the producing AI agent (agent self-check; not independent, separately authored, or human review).' },
    review: {
      review_provenance: SELF_CHECK_PROVENANCE,
      independent_review: false,
      method: 'The producing agent checks each identity (agent self-check, not independent or human review).',
      criteria: ['bounded in-scope lexical meaning and complete single-sense boundary review', 'zero relations when no candidate-specific relation is separately supported'],
      admission_rule: 'Admit only identities that pass the agent self-check.',
    },
    selection: { coverage_basis: ['identity after agent self-check semantic eligibility'], selection_rationale: 'Every self-checked, admitted identity proceeds.' },
  });
  assertSourceClaimsTruthful(honest(), { selfCheck: true });
  const cases = {
    'missing flag': (s) => { delete s.review.review_provenance; },
    'independent_review true': (s) => { s.review.independent_review = true; },
    'separately verify method': (s) => { s.review.method = 'Separately verify each identity.'; },
    'independent coverage basis': (s) => { s.selection.coverage_basis = ['identity after independent semantic eligibility']; },
    'independently reviewed rationale': (s) => { s.selection.selection_rationale = 'Every independently reviewed identity proceeds.'; },
    'self-check parenthetical hiding a human claim': (s) => { s.review.method = 'The agent checks identities (self-check; human review completed).'; },
    'self-check parenthetical hiding an independent claim': (s) => { s.provenance.authoring_note = 'checked (agent self-check and independent reviewer approved).'; },
    'separate-review claim reusing the relation criterion wording': (s) => { s.review.criteria = ['zero relations when separately reviewed by a person']; },
    'independent claim in criteria': (s) => { s.review.criteria = ['gloss verified by an independent reviewer']; },
    'human claim in admission rule': (s) => { s.review.admission_rule = 'admitted after human review'; },
    'separate claim in a nested review field': (s) => { s.review.extra = { note: 'separately reviewed' }; },
    'source mentions another reviewer': (s) => { s.provenance.authoring_note = 'another reviewer checked this.'; },
    'human authoring note': (s) => { s.provenance.authoring_note = 'Each lemma was human reviewed.'; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const source = honest();
    mutate(source);
    assert.throws(() => assertSourceClaimsTruthful(source, { selfCheck: true }), undefined, name);
  }
  // Legacy independent-review sources must not carry the self-check flags.
  assert.throws(() => assertSourceClaimsTruthful(honest(), { selfCheck: false }));
  assertSourceClaimsTruthful({ review: {}, provenance: {}, selection: {} }, { selfCheck: false });
});

test('per-candidate rationales and generated decisions never claim independent, separate, or human review', () => {
  const clean = () => ({
    reviews: [{ lemma: 'a', semantic_rationale: '풀이는 표제어의 검토된 핵심 뜻과 맞는다.', boundary_rationale: 'atomic sense boundary retained.' }],
    outcomes: [{ lemma: 'b', verdict: 'hold', hold_rationale: '명사 단독 용례가 확인되지 않는다.' }],
    decisions: [{ decision_rationale: '정체성·품사·풀이·의미 경계를 후보 근거에서 검토했다.', sense_reviews: [{ semantic_rationale: 'gloss fits the headword.' }] }],
  });
  assertDecisionClaimsTruthful(clean());
  const bad = {
    'English human claim in a review rationale': (x) => { x.reviews[0].semantic_rationale = 'human reviewed this gloss'; },
    'independent claim in a boundary rationale': (x) => { x.reviews[0].boundary_rationale = 'independently reviewed boundary'; },
    'separate claim in a decision rationale': (x) => { x.decisions[0].decision_rationale = 'separately verified'; },
    'nested sense review claim': (x) => { x.decisions[0].sense_reviews[0].semantic_rationale = 'an independent reviewer approved'; },
    'Korean independent review claim': (x) => { x.reviews[0].semantic_rationale = '독립 검토를 마쳤다.'; },
    'hold rationale human judged': (x) => { x.outcomes[0].hold_rationale = '사람이 판단하여 보류했다.'; },
    'hold rationale human decided': (x) => { x.outcomes[0].hold_rationale = '사람이 판정했다.'; },
    'decision rationale human determined': (x) => { x.decisions[0].decision_rationale = '인간이 직접 결정했다.'; },
    'hold rationale claims an external reviewer': (x) => { x.outcomes[0].hold_rationale = 'held after an external reviewer checked it'; },
    'hold rationale claims another session': (x) => { x.outcomes[0].hold_rationale = 'another Claude session reviewed this hold'; },
    'hold rationale Korean human review': (x) => { x.outcomes[0].hold_rationale = '사람이 검토하여 보류했다.'; },
    'hold rationale 별도 사람이 검토': (x) => { x.outcomes[0].hold_rationale = '별도 사람이 검토했다.'; },
    'decision rationale 다른 인간이 확인': (x) => { x.decisions[0].decision_rationale = '다른 인간이 확인했다.'; },
    'Korean 인간이 검토 with a particle': (x) => { x.reviews[0].semantic_rationale = '인간이 검토했다.'; },
    'Korean 사람은 검수 with a particle': (x) => { x.decisions[0].decision_rationale = '사람은 검수를 마쳤다.'; },
    'Korean separate reviewer': (x) => { x.reviews[0].boundary_rationale = '별도 리뷰어가 확인했다.'; },
    'English another reviewer': (x) => { x.decisions[0].decision_rationale = 'another reviewer checked this'; },
    'Korean external editor reviewed': (x) => { x.reviews[0].semantic_rationale = '외부 편집자가 검토했다.'; },
    'English another Claude session reviewed': (x) => { x.reviews[0].semantic_rationale = 'another Claude session reviewed this'; },
    'English reviewed by passive': (x) => { x.decisions[0].decision_rationale = 'gloss was checked by a colleague'; },
    'Korean expert': (x) => { x.decisions[0].decision_rationale = '전문가가 승인했다.'; },
    'Korean human review claim': (x) => { x.decisions[0].decision_rationale = '사람이 검토하여 승인했다.'; },
  };
  for (const [name, mutate] of Object.entries(bad)) {
    const value = clean();
    mutate(value);
    assert.throws(() => assertDecisionClaimsTruthful(value), /must not claim/u, name);
  }
});

test('the generated self-check method describes the preserved frame contract, not a fixed frame count', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./build-issue-223-corpus-batch.mjs', import.meta.url), 'utf8');
  const method = /const SELF_CHECK_METHOD = '([^']*)'/u.exec(source)[1];
  assert.match(method, /one authored diagnostic frame per gloss span/u);
  assert.doesNotMatch(method, /two authored diagnostic frames/u);
});

test('rationales may name observed forms but never reproduce corpus context wording', () => {
  const contexts = ['그는 홍콩 주재 총영사관 앞에서 오래 기다렸다', '왕국을 주재하는 왕은 회의를 주재하던 사람이었다'];
  const base = { lemma: '주재', contexts, allowedForms: ['주재', '주재하는', '주재하던'] };
  assertNoCorpusPhraseCopy({ ...base, texts: [['boundary_rationale', '문맥 0의 주재는 머물러 있음을 뜻하고 문맥 1의 주재하는은 이끎을 뜻한다.']] });
  assertNoCorpusPhraseCopy({ ...base, texts: [['boundary_rationale', '문맥 1의 왕국을 주재하는이 모두 같은 뜻이다.']] });
  const copied = (where, text) => assert.throws(() => assertNoCorpusPhraseCopy({ ...base, texts: [[where, text]] }), /reproduces corpus context wording/u);
  copied('boundary_rationale', '문맥 0의 그는 홍콩 주재 총영사관 앞에서 같은 뜻이다.');
  copied('hold_rationale', '문맥 0의 홍콩 주재 총영사관 앞에서 머물러 있음을 뜻한다.');
  // The hold limit is stricter: two copied neighbour words already fail there, not in a boundary rationale.
  assert.deepEqual(findCopiedContextPhrases('회의를 주재하던 사람이었다', { contexts, allowedForms: ['주재'] }).length, 0);
  assert.equal(findCopiedContextPhrases('회의를 주재하던 사람이었다', { contexts, allowedForms: ['주재'], threshold: 2 }).length, 1);
  copied('hold_rationale', '문맥 1의 회의를 주재하던 사람이었다.');
});

test('the shared builder/validator gate fails closed on the review contract by batch', () => {
  assertReviewContractForBatch(10, false);
  assertReviewContractForBatch(11, true);
  assertReviewContractForBatch(12, true);
  assert.throws(() => assertReviewContractForBatch(11, false), /self-check contract/u);
  assert.throws(() => assertReviewContractForBatch(25, false), /self-check contract/u);
  assert.throws(() => assertReviewContractForBatch(10, true), /predates/u);
});

test('author merging from batch 11 needs a primary-agent attestation; legacy batches are unaffected', () => {
  assertPrimaryAuthoringAllowed('issue-223-m9-e-corpus-batch-10-20261002');
  assertPrimaryAuthoringAllowed('issue-223-m9-e-corpus-batch-11-20261003', { primaryAgentAuthored: true });
  assert.throws(() => assertPrimaryAuthoringAllowed('issue-223-m9-e-corpus-batch-11-20261003'), /primary agent/u);
  assert.throws(() => assertPrimaryAuthoringAllowed('issue-223-m9-e-corpus-batch-12-20261003', { primaryAgentAuthored: false }), /primary agent/u);
  assert.throws(() => assertPrimaryAuthoringAllowed('bogus', { primaryAgentAuthored: true }), /unsupported batch id/u);
});

test('the separate-reviewer workflow is refused for self-check batches only', () => {
  assertLegacyReviewWorkflowAllowed('issue-223-m9-e-corpus-batch-10-20261002');
  assert.throws(() => assertLegacyReviewWorkflowAllowed('issue-223-m9-e-corpus-batch-11-20261003'), /self-check contract/u);
  assert.throws(() => assertLegacyReviewWorkflowAllowed('bogus'), /unsupported batch id/u);
});

test('the self-check binding enforces evidence specificity from batch 14 at the builder/validator boundary', () => {
  const lemmas = ['가나', '다라', '마바'];
  const specific = {
    가나: ['문맥 0: 시장 골목의 가게; 문맥 1: 학교 앞의 가게', '뜻이 갈리는 동음이의 용법이 없다', '가나에 들렀다.'],
    마바: ['문맥 0: 병원 복도의 움직임; 문맥 1: 강가 나루의 움직임', '활용형이 같은 동사 하나로 읽힌다', '마바 걷는 일이다.'],
  };
  const build = (batchId, boundary, semantic, frame) => {
    const f = fixture();
    f.input.batch_id = batchId;
    f.input.reviews = ['가나', '마바'].map((lemma) => ({
      ...review(lemma),
      boundary_rationale: boundary(lemma),
      semantic_rationale: semantic(lemma),
      frames: [{ sentence_frame: frame(lemma) }],
    }));
    return f;
  };
  const good = build('issue-223-m9-e-corpus-batch-14-20261003', (l) => `${l}: ${specific[l][0]}`, (l) => `${l}: ${specific[l][1]}`, (l) => specific[l][2]);
  assert.doesNotThrow(() => binding(good));
  const boiler = build('issue-223-m9-e-corpus-batch-14-20261003', (l) => `${l}: 문맥 0·문맥 1 모두 같은 뜻으로 맞는다`, (l) => `${l}: 같은 뜻으로 읽힌다`, (l) => specific[l][2]);
  assert.throws(() => binding(boiler), /(?:repeat|reuse) the same/u);
  const noContext = build('issue-223-m9-e-corpus-batch-14-20261003', (l) => `${l}: ${specific[l][0].split(';')[0]}`, (l) => `${l}: ${specific[l][1]}`, (l) => specific[l][2]);
  assert.throws(() => binding(noContext), /checked context 1/u);
  const definition = build('issue-223-m9-e-corpus-batch-14-20261003', (l) => `${l}: ${specific[l][0]}`, (l) => `${l}: ${specific[l][1]}`, (l) => `'${l}'은(는) '예시 뜻풀이'라는 뜻이다.`);
  assert.throws(() => binding(definition), /usage sentence/u);
  // The boundary itself: batch 14 enforces, batch 13 keeps its original contract, batch 15 enforces.
  assert.throws(() => binding(build('issue-223-m9-e-corpus-batch-15-20261003', (l) => `${l}: ${specific[l][0].split(';')[0]}`, (l) => `${l}: ${specific[l][1]}`, (l) => specific[l][2])), /checked context 1/u);
  assert.doesNotThrow(() => binding(build('issue-223-m9-e-corpus-batch-13-20261003', (l) => `${l}: ${specific[l][0].split(';')[0]}`, (l) => `${l}: ${specific[l][1]}`, (l) => specific[l][2])));
  // Earlier self-check batches keep their original contract.
  const legacy = build('issue-223-m9-e-corpus-batch-13-20261003', (l) => `${l}: ${specific[l][0].replace(/문맥 [0-9]: /gu, '')}`, (l) => `${l}: ${specific[l][1]}`, (l) => `'${l}'은(는) '예시 뜻풀이'라는 뜻이다.`);
  assert.doesNotThrow(() => binding(legacy));
});

test('verb frames must be grammatical usage sentences; adjectives and legitimate constructions pass', () => {
  const ok = (lemma, pos, frame) => assertVerbFramesGrammatical([{ lemma, pos, frames: [frame] }]);
  assert.doesNotThrow(() => ok('읽다', 'verb', '그는 책을 읽다 못해 졸았다.'));
  assert.doesNotThrow(() => ok('먹다', 'verb', '그는 밥을 먹다 말고 일어났다.'));
  assert.doesNotThrow(() => ok('읽다', 'verb', '그는 책을 읽다가 잠들었다.'));
  assert.doesNotThrow(() => ok('읽다', 'verb', '이렇게 두꺼운 책을 읽다니 놀랍다.'));
  assert.doesNotThrow(() => ok('미루다', 'verb', '자꾸 할 일을 미루다가는 나중에 걷잡을 수 없이 많아질 거야.'));
  assert.doesNotThrow(() => ok('미루다', 'verb', '일을 미루다가도 결국 끝냈다.'));
  assert.doesNotThrow(() => ok('좋다', 'adjective', '이 책은 내용이 정말 좋다.'));
  assert.doesNotThrow(() => ok('읽다', 'verb', '그는 책을 읽었다.'));
  assert.throws(() => ok('읽다', 'verb', '그는 책을 읽다.'), /bare citation form/u);
  assert.throws(() => ok('읽다', 'verb', '그는 책을 읽다 오래 졸았다.'), /only before a connective/u);
  assert.throws(() => ok('깔보다', 'verb', '그는 상대를 깔보다 크게 졌다.'), /only before a connective/u);
});

test('the self-check binding applies the verb frame rule from batch 13 and leaves earlier batches alone', () => {
  const lemmas = ['가나', '마바'];
  const build = (batchId, frame) => {
    const f = fixture();
    f.candidateRows = [row('가나'), row('다라'), row('마바')].map((r) => ({ ...r, morphology_proposal: { ...r.morphology_proposal, pos: 'verb' } }));
    f.input.batch_id = batchId;
    f.input.reviews = lemmas.map((lemma) => ({ ...review(lemma), frames: [{ sentence_frame: frame(lemma) }] }));
    return f;
  };
  const bare = (l) => `그는 ${l}.`;
  const connective = (l) => `그는 ${l}가 아니라 ${l}다가 쓰러졌다.`;
  assert.doesNotThrow(() => binding(build('issue-223-m9-e-corpus-batch-13-20261003', connective)));
  assert.throws(() => binding(build('issue-223-m9-e-corpus-batch-13-20261003', bare)), /bare citation form|connective/u);
  assert.throws(() => binding(build('issue-223-m9-e-corpus-batch-15-20261003', bare)), /bare citation form|connective/u);
  assert.doesNotThrow(() => binding(build('issue-223-m9-e-corpus-batch-12-20261003', bare)));
  // The full-revision boundary also rejects a frame that is not a form of its lemma.
  assert.throws(() => binding(build('issue-223-m9-e-corpus-batch-13-20261003', (l) => `눈을 감고 잤다.`)), /real conjugated form/u);
});

test('the shared lemma-in-frame rule admits correctly conjugated verb frames and still rejects unrelated ones', () => {
  assert.equal(frameUsesLemma('그는 책을 읽었다.', '읽다', 'verb'), true);
  assert.equal(frameUsesLemma('그는 책을 읽다 못해 졸았다.', '읽다', 'verb'), true);
  assert.equal(frameUsesLemma('이 책은 정말 좋았다.', '좋다', 'adjective'), true);
  assert.equal(frameUsesLemma('그는 책을 샀다.', '읽다', 'verb'), false);
  // Stem collisions are rejected; irregular and contracted conjugations are admitted.
  assert.equal(frameUsesLemma('그는 가게에서 책을 샀다.', '가다', 'verb'), false);
  assert.equal(frameUsesLemma('그는 먹이를 주었다.', '먹다', 'verb'), false);
  assert.equal(frameUsesLemma('그 말을 들었다.', '듣다', 'verb'), true);
  assert.equal(frameUsesLemma('그는 학교에 갔다.', '가다', 'verb'), true);
  assert.equal(frameUsesLemma('이웃을 도왔다.', '돕다', 'verb'), true);
  assert.equal(frameUsesLemma('편지를 썼다.', '쓰다', 'verb'), true);
  assert.equal(frameUsesLemma('노래를 불렀다.', '부르다', 'verb'), true);
  assert.equal(frameUsesLemma('그는 멀리 사는 친구를 찾았다.', '살다', 'verb'), true);
  assert.equal(frameUsesLemma('그는 친구를 돕아.', '돕다', 'verb'), false);
  assert.equal(frameUsesLemma('그 말을 듣어.', '듣다', 'verb'), false);
  assert.equal(frameUsesLemma('그는 친구를 도와.', '돕다', 'verb'), true);
  assert.equal(frameUsesLemma('그 말을 들어.', '듣다', 'verb'), true);
  assert.equal(frameUsesLemma('편지를 쓰어.', '쓰다', 'verb'), false);
  assert.equal(frameUsesLemma('편지를 써.', '쓰다', 'verb'), true);
  assert.equal(frameUsesLemma('학교에 가아.', '가다', 'verb'), false);
  assert.equal(frameUsesLemma('일을 하여.', '하다', 'verb'), false);
  assert.equal(frameUsesLemma('일을 하여 마쳤다.', '일하다', 'verb'), false);
  assert.equal(frameUsesLemma('그는 일하여 돈을 벌었다.', '일하다', 'verb'), true);
  assert.equal(frameUsesLemma('그는 학교에 갑니다.', '가다', 'verb'), true);
  assert.equal(frameUsesLemma('그는 열심히 일합니다.', '일하다', 'verb'), true);
  assert.equal(frameUsesLemma('그는 시골에 삽니다.', '살다', 'verb'), true);
  assert.equal(frameUsesLemma('그는 책을 읽습니다.', '읽다', 'verb'), true);
  assert.equal(frameUsesLemma('우리 함께 갑시다.', '가다', 'verb'), true);
  assert.equal(frameUsesLemma('꽃이 예쁩니다.', '예쁘다', 'adjective'), true);
  assert.equal(frameUsesLemma('꽃이 예쁩니까?', '예쁘다', 'adjective'), true);
  assert.equal(frameUsesLemma('우리 모두 예쁩시다.', '예쁘다', 'adjective'), false);
  assert.equal(frameUsesLemma('우리 모두 예쁩시오.', '예쁘다', 'adjective'), false);
  assert.equal(frameUsesLemma('그는 갑옷을 입었다.', '가다', 'verb'), false);
  assert.equal(frameUsesLemma('눈을 감고 잤다.', '가다', 'verb'), false);
  assert.equal(frameUsesLemma('발을 씻었다.', '받다', 'verb'), false);
  assert.equal(frameUsesLemma('손을 씻었다.', '씻다', 'verb'), true);
  assert.equal(frameUsesLemma('문을 닫았다.', '닫다', 'verb'), true);
  assert.equal(frameUsesLemma('집을 지었다.', '짓다', 'verb'), true);
  assert.equal(frameUsesLemma('글을 쓴다.', '쓰다', 'verb'), true);
  assert.equal(frameUsesLemma('그는 일을 했다.', '일하다', 'verb'), false);
  assert.equal(frameUsesLemma('그는 일했다.', '일하다', 'verb'), true);
  assert.equal(frameUsesLemma('그는 책을 읽었다.', '읽다', 'noun'), false);
});

test('the full-revision binding applies the adjective/verb split of the frame rule', () => {
  const build = (frame, pos) => {
    const f = fixture();
    f.candidateRows = [row('예쁘다'), row('다라'), row('마바')].map((r, i) => (i === 0
      ? { ...r, morphology_proposal: { ...r.morphology_proposal, pos } } : r));
    f.glossByLemma = new Map([['예쁘다', GLOSS], ['다라', GLOSS], ['마바', GLOSS]]);
    f.input.batch_id = 'issue-223-m9-e-corpus-batch-13-20261003';
    f.input.candidate_outcomes = [outcome(1, '예쁘다', 'pass'), outcome(2, '다라', 'hold'), outcome(3, '마바', 'pass')];
    f.input.reviews = [
      { ...review('가나'), lemma: '예쁘다', boundary_rationale: '예쁘다: 첫 용례는 꽃을, 둘째 용례는 사람을 꾸민다', semantic_rationale: '예쁘다: 풀이의 핵심어가 두 용례 모두에서 확인된다', frames: [{ sentence_frame: frame }] },
      { ...review('마바'), frames: [{ sentence_frame: '그는 마바 걷다 못해 쉬었다.' }] },
    ];
    return f;
  };
  assert.doesNotThrow(() => binding(build('꽃이 예쁩니다.', 'adjective')));
  assert.throws(() => binding(build('우리 모두 예쁩시다.', 'adjective')), /real conjugated form/u);
  assert.doesNotThrow(() => binding(build('우리 모두 예쁩시다.', 'verb')));
});
