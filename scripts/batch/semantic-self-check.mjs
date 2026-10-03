/**
 * Agent self-check provenance for semantic review inputs (Issue #240, M10).
 *
 * Owner decision (2026-10-02): from M10 batch 11 the main implementation agent
 * may both author and check candidate decisions. That check is recorded as
 * exactly what it is, an AI producer self-check, and is never described as
 * independent or human review. The input keeps every per-candidate judgment the
 * independent-review contract preserved (identity, POS, gloss fit, sense
 * boundary, checked contexts, candidate-specific notes, gloss-digest binding),
 * and forbids the artifacts that would pretend a separate run happened: a
 * registry reviewer label, review runs, a run record, or proposal digests.
 *
 * B05-B10 keep their original contract and evidence unchanged.
 */

import assert from 'node:assert/strict';

import { sha256Json } from '../validate/semantic-audit.mjs';
import { admissionGateFor, assertReviewNotesAreCandidateSpecific } from './reviewer-raw-outputs.mjs';

export const SELF_CHECK_PROVENANCE = 'agent-self-check';
export const SELF_CHECK_FIRST_BATCH = 11;
const SYLLABLE_BASE = 0xAC00;
const decompose = (char) => {
  const code = char.charCodeAt(0) - SYLLABLE_BASE;
  return { cho: Math.floor(code / 588), jung: Math.floor((code % 588) / 28), jong: code % 28 };
};
const compose = ({ cho, jung, jong }) => String.fromCharCode(SYLLABLE_BASE + cho * 588 + jung * 28 + jong);
const isSyllable = (char) => char !== undefined && char >= '가' && char <= '힣';

// Every ending below is matched against the WHOLE remainder of the word (plus trailing punctuation), so a
// valid prefix followed by junk (갑니다말, 가시겠말) is not a form of the lemma.
const TAIL = '[\\p{P}~…]*$';
const complete = (pieces) => new RegExp(`^(?:${pieces})${TAIL}`, 'u');
const CONNECTIVE = '(?:고|는|며|면|니|가)';
const AUX = '(?:지(?:다|고|는|며|면|니|가|요|죠|어요|지만)?|졌(?:다|어요|습니다|고|는데)|주(?:다|세요|었다|고|면|어요)|줬(?:다|어요|고)|버(?:렸다|리다|려|리고|렸어요)|놓(?:았다|다|고)|두(?:었다|다|고)|내(?:다|었다|고)|냈(?:다|어요|습니다|고|는데)|오(?:다|았다|고|는)|보(?:다|았다|고|니|면|세요)|있(?:다|었다|고|는|어요|습니다)|야(?:겠다|한다|지))';
const CLOSE = `(?:다${CONNECTIVE}?|어요|아요|여요|[어아여](?:서|도|야|${AUX})?|지만|지요|지|죠|요|네요|네|는데|는|은|을|던|며|면|니까|니|서|도|자|기|게|러|려|라|으니|으면|으며|으려|습니다|습니까|고(?:서)?)`;
const HONORIFIC = complete(`시(?:는데|는|고|면|며|니까|니|죠|지요|요|어도|어서|어|지만|지|다${CONNECTIVE}?)|시겠(?:어요|습니다|습니까|죠|지요|네요|지만|지|는데|어|다${CONNECTIVE}?)|세요|십니다|십니까|셨(?:어요|습니다|습니까|죠|고|는데|지만|으나|다${CONNECTIVE}?)|셔서|셔도|신`);
const END = complete('');
const STEM_ENDING = complete(`(?:었|았|였|겠)*${CLOSE}`);
const SHORT_STEM_ENDING = complete(`(?:었|았|겠)*(?:다${CONNECTIVE}?|고|는|은|을|던|며|면|서|니|으니|으면|어요|아요|[어아](?:서|도|야)?|죠|요|습니다|습니까)`);
const PAST_ENDING = complete(CLOSE);
const VOWEL_ENDING = complete('(?:었|았)(?:다' + CONNECTIVE + '?|어요|습니다|습니까|죠|지요|고|는데|지만|으나)|어요|아요|어서|아서|어도|아도|[어아](?:' + AUX + ')?|은|으니|으면|으며|으려');
const CONTRACTED_ENDING = complete(`(?:서요?|도|야|요|라|${AUX})?`);
const FORMAL_VERB = complete('니다|니까|시다|시오');
const FORMAL_ADJECTIVE = complete('니다|니까');
const DROP_L_ENDING = complete(`는|니|니까|신|시(?:[고면며니죠요다어])|오|습니다|십니다`);
// Irregular classes need a lexicon: only these stems alternate (the rest, e.g. 받·닫·믿, 씻·웃·벗, 입·잡, are regular).
const D_IRREGULAR = new Set(['듣', '걷', '묻', '싣', '깨닫', '긷', '일컫', '붇']);
const S_IRREGULAR = new Set(['낫', '짓', '잇', '붓', '긋', '젓', '잣']);
// Stems with both a regular and an irregular sense (묻다 ask/bury, 걷다 walk/fold, 굽다 roast/bend): either form is admitted;
// choosing the sense is the source-bound review's job, not this form check's.
// 러 irregular: 르-final stems that take -러/-렀 instead of -라/-랐 (푸르렀다, 이르러).
const RU_IRREGULAR = new Set(['푸르', '이르', '누르', '노르']);
const DUAL_CONJUGATION = new Set(['묻', '걷', '굽']);
const B_REGULAR = new Set(['입', '잡', '접', '좁', '뽑', '씹', '꼽', '집', '업']);

/**
 * Surface alternatives a verb/adjective stem takes before an ending, each with
 * the endings that may follow it (so 간/갔다 are forms of 가다 but 감고 and
 * 발(을) are not forms of 가다/받다).
 */
function stemForms(stem, plainEnding, pos) {
  // -ㅂ시다/-ㅂ시오 (propositive/imperative) attach to verbs only; a formal declarative/interrogative suits both.
  const formal = pos === 'adjective' ? FORMAL_ADJECTIVE : FORMAL_VERB;
  const last = stem.at(-1);
  const syllable = isSyllable(last) ? decompose(last) : null;
  // An alternating stem never takes a vowel-initial ending uncontracted (돕아, 듣어, 쓰어, 가아 are not forms).
  const dual = DUAL_CONJUGATION.has(stem);
  const alternating = syllable !== null && !dual && (
    (syllable.jong === 7 && D_IRREGULAR.has(stem))
    || (syllable.jong === 19 && S_IRREGULAR.has(stem))
    || (syllable.jong === 17 && !B_REGULAR.has(stem))
    || (syllable.jong === 0 && [0, 4, 18].includes(syllable.jung)));
  const noVowelEnding = (follows) => ({ test: (rest) => !(last === '하' ? /^(?:아|어|았|었)/u : /^(?:아|어|여|았|었|였|은|으)/u).test(rest) && follows.test(rest) });
  // A vowel-final stem takes -ㄴ/-ㄹ as a final consonant (간, 갈), never as a separate 은/을/으 ending (가은, 일하을).
  const openPlain = syllable !== null && syllable.jong === 0 ? { test: (rest) => !/^(?:은|을|으)/u.test(rest) && plainEnding.test(rest) } : plainEnding;
  const forms = [{ surface: stem, follows: alternating ? noVowelEnding(openPlain) : openPlain, bare: false }];
  if (syllable === null) return forms;
  const prefix = stem.slice(0, -1);
  // Honorific -(으)시-: 가세요, 가십니다, 가셨다, 읽으세요, 사세요(살다).
  const open = prefix + compose({ ...syllable, jong: 0 });
  const dIrregular = syllable.jong === 7 && D_IRREGULAR.has(stem);
  const sIrregular = syllable.jong === 19 && S_IRREGULAR.has(stem);
  const bIrregular = syllable.jong === 17 && !B_REGULAR.has(stem);
  let honorificBase;
  if (syllable.jong === 0) honorificBase = stem;
  else if (syllable.jong === 8) honorificBase = open;
  else if (dIrregular) honorificBase = prefix + compose({ ...syllable, jong: 8 }) + '으';
  else if (sIrregular) honorificBase = open + '으';
  else if (bIrregular) honorificBase = open + '우';
  else honorificBase = stem + '으';
  forms.push({ surface: honorificBase, follows: HONORIFIC, bare: false });
  if (dual) forms.push({ surface: stem + '으', follows: HONORIFIC, bare: false });
  const add = (surface, follows, bare = false) => forms.push({ surface, follows, bare });
  const pastVowels = [0, 4, 1, 5]; // ㅏ ㅓ ㅐ ㅔ
  if (syllable.jong !== 0) {
    const open = prefix + compose({ ...syllable, jong: 0 });
    if (syllable.jong === 7 && D_IRREGULAR.has(stem)) add(prefix + compose({ ...syllable, jong: 8 }), VOWEL_ENDING);
    if (syllable.jong === 19 && S_IRREGULAR.has(stem)) add(open, VOWEL_ENDING);
    if (syllable.jong === 8) add(open, DROP_L_ENDING);
    if (syllable.jong === 8) add(prefix + compose({ ...syllable, jong: 17 }), formal);
    // ㄹ-final stems lose ㄹ before -ㄴ: 낯선, 사는 → 산, 만든.
    if (syllable.jong === 8) add(prefix + compose({ ...syllable, jong: 4 }), pos === 'adjective' ? END : complete('다?'), true);
    if (syllable.jong === 17 && !B_REGULAR.has(stem)) {
      for (const tail of ['워', '와']) add(open + tail, CONTRACTED_ENDING, true);
      for (const tail of ['웠', '왔']) add(open + tail, PAST_ENDING);
      add(open + '운', END, true);
      add(open + '우', complete('니(?:까)?|면|며|려|러'));
    }
    return forms;
  }
  add(prefix + compose({ ...syllable, jong: 4 }), complete('다?'), true);
  add(prefix + compose({ ...syllable, jong: 17 }), formal);
  add(prefix + compose({ ...syllable, jong: 8 }), complete('(?:까|수)?'), true);
  if (pastVowels.includes(syllable.jung)) add(prefix + compose({ ...syllable, jong: 20 }), PAST_ENDING);
  const merged = { 8: 9, 13: 14, 20: 6, 11: 10 }[syllable.jung];
  if (merged !== undefined) {
    add(prefix + compose({ ...syllable, jung: merged, jong: 0 }), CONTRACTED_ENDING, true);
    add(prefix + compose({ ...syllable, jung: merged, jong: 20 }), PAST_ENDING);
  }
  if (last === '하') {
    add(prefix + compose({ ...syllable, jung: 1, jong: 0 }), CONTRACTED_ENDING, true);
    add(prefix + compose({ ...syllable, jung: 1, jong: 20 }), PAST_ENDING);
  }
  if (syllable.jung === 18 && last !== '르') {
    for (const jung of [0, 4]) {
      add(prefix + compose({ ...syllable, jung, jong: 0 }), CONTRACTED_ENDING, true);
      add(prefix + compose({ ...syllable, jung, jong: 20 }), PAST_ENDING);
    }
  }
  if (RU_IRREGULAR.has(stem)) {
    add(stem + '러', CONTRACTED_ENDING, true);
    add(stem + '렀', PAST_ENDING);
  }
  if (last === '르' && prefix.length > 0 && isSyllable(prefix.at(-1))) {
    const before = decompose(prefix.at(-1));
    const base = prefix.slice(0, -1) + compose({ ...before, jong: 8 });
    for (const tail of ['러', '라']) add(base + tail, CONTRACTED_ENDING, true);
    for (const tail of ['렀', '랐']) add(base + tail, PAST_ENDING);
  }
  return forms;
}

/**
 * The shared frame-contains-the-lemma rule. A frame carries the citation form,
 * or, for a verb/adjective, an eojeol made of the stem (with its regular and
 * irregular alternations) followed by an ending, so 읽었다, 들었다 (듣다) and
 * 갔다 (가다) are admissible while 가게 is not a form of 가다. Homographs that
 * are real conjugations of another word cannot be told apart without an
 * analyzer; the grammar rule for a bare citation form stays in
 * assertVerbFramesGrammatical.
 */
export function frameUsesLemma(frame, lemma, pos) {
  if (typeof frame !== 'string') return false;
  if (frame.includes(lemma)) return true;
  if ((pos !== 'verb' && pos !== 'adjective') || lemma.length < 2 || !lemma.endsWith('다')) return false;
  const stem = lemma.slice(0, -1);
  const forms = stemForms(stem, stem.length === 1 ? SHORT_STEM_ENDING : STEM_ENDING, pos);
  for (const token of frame.split(/[\s,]+/u)) {
    const word = token.replace(/^[“"‘'(]+/u, '');
    for (const { surface, follows, bare } of forms) {
      if (!word.startsWith(surface)) continue;
      const rest = word.slice(surface.length);
      if (rest === '' ? bare : follows.test(rest)) return true;
    }
  }
  return false;
}

export const SELF_CHECK_FRAME_GRAMMAR_FIRST_BATCH = 13;
// A verb frame may carry the citation form only where Korean grammar allows it
// before a connective (-다가, -다니, -다 보니, -다 못해, -다 말고, ...), never
// as a bare sentence-final predicate; an adjective's plain form is a valid
// sentence ending and is not restricted.
const VERB_CITATION_CONTINUATION = /^(?:니|가(?:[\s,]|[는도만])|고|는|며|면|\s*(?:말고|못해|못하|보니|보면))/u;
const SENTENCE_END = /^[\s.?!"'”’]*$/u;

/** Rows: { lemma, pos, frames }. Frames lacking the lemma are left to the shared containment check. */
export function assertVerbFramesGrammatical(rows) {
  for (const { lemma, pos, frames } of rows) {
    if (pos !== 'verb') continue;
    for (const frame of frames) {
      const tails = [];
      for (let at = frame.indexOf(lemma); at !== -1; at = frame.indexOf(lemma, at + 1)) tails.push(frame.slice(at + lemma.length));
      if (tails.length === 0) continue;
      assert.ok(!tails.some((tail) => SENTENCE_END.test(tail)),
        `${lemma}: a verb frame must not end the sentence with the bare citation form`);
      assert.ok(tails.every((tail) => VERB_CITATION_CONTINUATION.test(tail)),
        `${lemma}: a verb frame must use the citation form only before a connective such as -다가, -다니, -다 보니, -다 못해, -다 말고`);
    }
  }
}

export const SELF_CHECK_SPECIFIC_FIRST_BATCH = 14;
const FRAME_DEFINITION_FORM = /['"「][^'"」]+['"」](?:은|는|은\(는\)|이|가)\s*['"「][^'"」]+['"」]/u;
const MAX_REPEATED_SELF_CHECK_SHARE = 0.1;

/**
 * Self-check passes are the only evidence for a primary-agent admission, so a
 * pass must say what each checked context shows (a note citing every checked
 * context index), its frames must be usage sentences rather than a restated
 * gloss, and the notes may not be one sentence templated over lemma and gloss.
 * Shared by self-check assembly, the batch builder and the full-revision
 * validator. Each row: { ordinal, lemma, gloss, hits, senseNote, useNote, frames }.
 */
export function assertSelfCheckPassesSpecific(rows) {
  const groups = { senseNote: new Map(), useNote: new Map() };
  for (const row of rows) {
    const gloss = String(typeof row.gloss === 'string' ? row.gloss : (row.gloss?.text ?? '')).replace(/[.\s]+$/u, '');
    const label = `${row.lemma}`;
    for (const index of row.hits) {
      assert.ok(String(row.senseNote).includes(`문맥 ${index}`),
        `${label}: sense_note must state what checked context ${index} shows`);
    }
    for (const frame of row.frames) {
      assert.ok(!frame.includes(gloss) && !FRAME_DEFINITION_FORM.test(frame),
        `${label}: a frame must be a usage sentence, not a restated definition`);
    }
    for (const field of ['senseNote', 'useNote']) {
      const key = String(row[field]).split(row.lemma).join('§').split(gloss).join('¶')
        .replace(/문맥 *[0-9]+/gu, '').replace(/[0-9]/gu, '#').replace(/\s+/gu, ' ').trim();
      groups[field].set(key, (groups[field].get(key) ?? 0) + 1);
    }
  }
  for (const [field, map] of Object.entries(groups)) {
    const repeated = [...map.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
    assert.ok(repeated <= Math.floor(rows.length * MAX_REPEATED_SELF_CHECK_SHARE),
      `${repeated} of ${rows.length} self-check passes repeat the same ${field === 'senseNote' ? 'sense_note' : 'use_note'} text; notes must be specific to each candidate`);
  }
}

const SEPARATE_RUN_FIELDS = ['review_runs', 'run_record_sha256', 'generator_proposal_sha256'];
const CLAIM_PATTERN = /independent|reviewer|human/iu;

export function isSelfCheckInput(input) {
  return input?.review_provenance !== undefined;
}

/** Envelope rules; the caller still runs the shared envelope check first. */
export function assertSelfCheckEnvelope(input, { ordinal, candidateAuthor }) {
  assert.equal(input.review_provenance, SELF_CHECK_PROVENANCE, 'semantic review input names an unsupported review provenance');
  assert.ok(ordinal >= SELF_CHECK_FIRST_BATCH,
    `agent self-check applies from batch ${SELF_CHECK_FIRST_BATCH}; earlier batches keep their original review contract`);
  assert.equal(input.independent_review, false, 'a self-check input must state independent_review: false');
  assert.equal(input.reviewer, candidateAuthor,
    'a self-check is recorded under the producing agent itself, never under a separate reviewer identity');
  assert.ok(!CLAIM_PATTERN.test(input.reviewer), 'a self-check reviewer label must not claim independent, reviewer, or human status');
  for (const field of SEPARATE_RUN_FIELDS) {
    assert.equal(input[field], undefined, `a self-check input must not carry ${field}: no separate review run took place`);
  }
}

/**
 * Cross-check the preserved outcomes against the candidate review and the
 * glosses admitted into canonical data (the tracked-artifact half of the
 * independent contract, without any run record).
 */
export function assertSelfCheckBinding({ input, candidateRows, glossByLemma }) {
  assert.equal(input.candidate_outcomes.length, candidateRows.length, 'self-check outcomes must cover every candidate');
  const reviewByLemma = new Map(input.reviews.map((review) => [review.lemma, review]));
  assert.equal(reviewByLemma.size, input.reviews.length, 'self-check reviews contain a duplicate lemma');
  let passes = 0;
  candidateRows.forEach((row, index) => {
    const lemma = row.morphology_proposal.lemma;
    const outcome = input.candidate_outcomes[index];
    assert.equal(outcome?.ordinal, index + 1, `${lemma}: self-check outcome ordinal must follow batch order`);
    assert.equal(outcome.lemma, lemma, `${lemma}: self-check outcome is bound to a different lemma`);
    if (outcome.verdict !== 'pass') {
      assert.equal(reviewByLemma.has(lemma), false, `${lemma}: a held candidate cannot carry a review row`);
      return;
    }
    const gate = admissionGateFor(row);
    if (gate) {
      assert.equal(outcome.admission_gate, gate, `${lemma}: a gated candidate must record the gate that held it`);
      assert.equal(reviewByLemma.has(lemma), false, `${lemma}: a gated candidate cannot carry a review row`);
      return;
    }
    passes += 1;
    const review = reviewByLemma.get(lemma);
    assert.ok(review, `${lemma}: a passed candidate needs its review row`);
    assert.equal(review.gloss_sha256, sha256Json(glossByLemma.get(lemma)),
      `${lemma}: the self-check is not bound to the gloss admitted into canonical data`);
    for (const field of ['identity_check', 'pos_check', 'gloss_check', 'sense_boundary_check', 'checked_hit_indices']) {
      assert.deepEqual(review[field], outcome[field], `${lemma}: the outcome and the review row disagree on ${field}`);
    }
  });
  assert.equal(input.reviews.length, passes, 'review rows must exist exactly for the passed candidates');
  assertReviewNotesAreCandidateSpecific(input.reviews);
  const batchOrdinal = Number(String(input.batch_id).match(/corpus-batch-(\d+)-/u)?.[1]);
  if (batchOrdinal >= SELF_CHECK_FRAME_GRAMMAR_FIRST_BATCH) {
    const posByLemma = new Map(candidateRows.map((row) => [row.morphology_proposal.lemma, row.morphology_proposal.pos]));
    for (const review of input.reviews) {
      for (const frame of review.frames) {
        assert.ok(frameUsesLemma(frame.sentence_frame, review.lemma, posByLemma.get(review.lemma)),
          `${review.lemma}: every frame must use the lemma in citation form or as a real conjugated form`);
      }
    }
    assertVerbFramesGrammatical(input.reviews.map((review) => ({
      lemma: review.lemma,
      pos: posByLemma.get(review.lemma),
      frames: review.frames.map((frame) => frame.sentence_frame),
    })));
  }
  if (batchOrdinal >= SELF_CHECK_SPECIFIC_FIRST_BATCH) {
    assertSelfCheckPassesSpecific(input.reviews.map((review) => ({
      lemma: review.lemma,
      gloss: glossByLemma.get(review.lemma),
      hits: review.checked_hit_indices,
      senseNote: review.boundary_rationale,
      useNote: review.semantic_rationale,
      frames: review.frames.map((frame) => frame.sentence_frame),
    })));
  }
}

/**
 * Truthfulness of the admitted semantic decision source. A self-check batch's
 * canonical source must carry the machine-readable provenance flag and no
 * claim of independent, separate, or human review; every other batch must not
 * carry the flag, so historical serialized artifacts stay byte-compatible.
 * (`kind` and `prior_generator_replaced` are structural fields required by the
 * shared decision-source contract and carry no review-independence claim.)
 */
/** The only parenthetical disclaimers allowed to name independent/human review, and only to deny it. */
const SELF_CHECK_DISCLAIMERS = [
  '(agent self-check, not independent or human review)',
  '(agent self-check; not independent, separately authored, or human review)',
  // Structural criterion about relation evidence, not a review-independence claim.
  'zero relations when no candidate-specific relation is separately supported',
];

export function assertSourceClaimsTruthful(source, { selfCheck }) {
  const { review } = source;
  if (!selfCheck) {
    assert.equal(review.review_provenance, undefined, 'only a self-check source may carry review_provenance');
    assert.equal(review.independent_review, undefined, 'only a self-check source may carry independent_review');
    return;
  }
  assert.equal(review.review_provenance, SELF_CHECK_PROVENANCE, 'a self-check source must record its provenance');
  assert.equal(review.independent_review, false, 'a self-check source must state independent_review: false');
  // Every free-text value the source stores about its review, authoring, or
  // selection (criteria and admission rules included) is a possible claim.
  const claims = [];
  const collect = (value) => {
    if (typeof value === 'string') claims.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(source.provenance);
  collect(review);
  collect(source.selection);
  for (const text of claims) {
    let stripped = text;
    for (const disclaimer of SELF_CHECK_DISCLAIMERS) stripped = stripped.split(disclaimer).join('');
    assert.ok(!REVIEW_CLAIM_PATTERN.test(stripped), `a self-check source must not claim independent, separate, or human review: ${text.slice(0, 80)}`);
  }
}

// One shared claim vocabulary for sources, rationales and decisions: English
// independent/separate/human/reviewer wording and Korean forms with or
// without a particle (인간이 검토, 사람은 검수, 별도 리뷰어, ...).
const REVIEW_CLAIM_PATTERN = new RegExp([
  // English: who is said to have reviewed, or the act attributed to someone else.
  String.raw`independent|separately|\bhuman\b|\breviewers?\b|\bauditors?\b|\bthird[- ]party\b|\bsecond (?:pair|opinion|session|agent|model)\b`,
  String.raw`\b(?:editors?|experts?|colleagues?|peers?|person|people|team|someone|somebody|claude|model|agent|session)\b[^.;]{0,40}\b(?:reviewed|checked|verified|approved|audited|validated|confirmed|signed[- ]off)\b`,
  String.raw`\b(?:another|other|different|separate|second|new|fresh|outside|external)\s+(?:claude|model|agent|session|ai|llm|instance|team|editor|expert|person)\b`,
  String.raw`\b(?:reviewed|checked|verified|approved|audited|validated|signed[- ]off)\s+(?:by|with)\s+(?!the producing (?:AI )?agent\b)`,
  // Korean, with or without particles.
  String.raw`독립\s*(?:적으로)?\s*(?:검|리뷰)|독립적|(?:(?:별도|다른|외부|추가|독립|제\s*3)\s*(?:의\s*)?(?:사람|인간)|(?<![가-힣])(?:사람|인간))(?:이|은|가|의|들이|에\s*의해|에게)?\s*(?:직접\s*)?(?:검|리뷰|확인|승인|판단|판정|판별|결정|평가|심사|채택|선정|선별|보류|통과|감수|수정|교정|작성)`,
  String.raw`별도\s*(?:의\s*)?(?:검|리뷰|에이전트|모델|세션)|검수자|리뷰어|제\s*3\s*자|제삼자`,
  String.raw`(?<![가-힣])(?:외부|다른|타|추가|두\s*번째)\s*(?:의\s*)?(?:편집자|전문가|검토자|감수자|세션|에이전트|모델|클로드|팀)`,
  String.raw`(?<![가-힣])(?:편집자|전문가|감수자?|검토자|동료|팀)(?:들)?(?:이|가|께서|에게서)?\s*(?:직접\s*)?(?:검토|검수|확인|승인|리뷰)`,
  String.raw`검토자|감수자|(?:에게|한테|로부터|에\s*의해)\s*(?:검토|검수|확인|승인)`,
].join('|'), 'iu');

/**
 * Per-candidate rationales are free text copied into the canonical decisions
 * (and kept in the self-check input); none may claim independent, separate, or
 * human review. Every string under `reviews` and `decisions` is scanned.
 */
export function assertDecisionClaimsTruthful({ reviews, decisions, outcomes = [] }) {
  // Lexical content (glosses, frames, lemmas) may legitimately contain words
  // such as 사람 or 독립; only free-text explanation fields are claim carriers.
  const CLAIM_KEY = /rationale|reason|note|method|basis|criteria|summary|explanation|status/iu;
  const visit = (value, where, inClaimField) => {
    if (typeof value === 'string') {
      if (inClaimField) {
        assert.ok(!REVIEW_CLAIM_PATTERN.test(value), `a self-check batch must not claim independent, separate, or human review in ${where}: ${value.slice(0, 80)}`);
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${where}[${index}]`, inClaimField));
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) visit(item, `${where}.${key}`, inClaimField || CLAIM_KEY.test(key));
    }
  };
  visit(reviews, 'reviews', false);
  visit(decisions, 'decisions', false);
  visit(outcomes, 'candidate_outcomes', false);
}

const COPIED_NEIGHBOR_WORDS = 3;
const HOLD_COPIED_NEIGHBOR_WORDS = 2;
const wordsOf = (text) => text.replace(/[^\p{L}\p{N}_\s]/gu, ' ').split(/\s+/u).filter(Boolean);

/**
 * Rationales may name the observed form of a candidate but must not reproduce
 * its corpus contexts. A verbatim run of consecutive context words that holds
 * three or more words other than the lemma, its stem, or an observed form is a copied
 * phrase. Needs the local context text, so it runs where that text exists.
 */
export function findCopiedContextPhrases(text, { contexts, allowedForms, threshold = COPIED_NEIGHBOR_WORDS }) {
  const bigrams = new Set();
  for (const context of contexts) {
    const words = wordsOf(context);
    for (let index = 0; index + 1 < words.length; index += 1) bigrams.add(`${words[index]}\u0000${words[index + 1]}`);
  }
  const words = wordsOf(text);
  const copied = [];
  let index = 0;
  while (index + 1 < words.length) {
    if (!bigrams.has(`${words[index]}\u0000${words[index + 1]}`)) { index += 1; continue; }
    let end = index + 1;
    while (end + 1 < words.length && bigrams.has(`${words[end]}\u0000${words[end + 1]}`)) end += 1;
    const run = words.slice(index, end + 1);
    if (run.filter((word) => !allowedForms.some((form) => word.includes(form))).length >= threshold) copied.push(run.join(' '));
    index = end + 1;
  }
  return copied;
}

export function assertNoCorpusPhraseCopy({ lemma, texts, contexts, allowedForms }) {
  for (const [where, text] of texts) {
    const stem = lemma.endsWith('다') ? lemma.slice(0, -1) : lemma;
    // Holds quote contexts to explain a split; they get the stricter limit.
    const copied = findCopiedContextPhrases(text, { contexts, allowedForms: [lemma, stem, ...allowedForms], threshold: /hold/iu.test(where) ? HOLD_COPIED_NEIGHBOR_WORDS : COPIED_NEIGHBOR_WORDS });
    assert.deepEqual(copied, [], `${lemma} ${where} reproduces corpus context wording; describe contexts in your own words and quote at most the observed form`);
  }
}

/**
 * Shared fail-closed gate for the builder and the validator: from the first
 * self-check batch, only self-check input is accepted; earlier batches keep
 * their original review contract and may not carry the self-check marker.
 */
export function assertReviewContractForBatch(ordinal, selfCheck) {
  if (ordinal >= SELF_CHECK_FIRST_BATCH) {
    assert.ok(selfCheck, `batch ${ordinal} must use the agent self-check contract; separate-reviewer input is only accepted for batches before ${SELF_CHECK_FIRST_BATCH}`);
  } else {
    assert.ok(!selfCheck, `batch ${ordinal} predates the agent self-check contract and may not carry self-check input`);
  }
}

/**
 * From the first self-check batch the primary producer authors every decision
 * itself. Merging author outputs therefore needs an explicit statement that
 * the files were written by the primary agent (no worker fan-out).
 */
export function assertPrimaryAuthoringAllowed(batchId, { primaryAgentAuthored } = {}) {
  const match = /-batch-([0-9]{2})-/u.exec(batchId ?? '');
  assert.ok(match, `unsupported batch id ${batchId}`);
  if (Number(match[1]) < SELF_CHECK_FIRST_BATCH) return;
  assert.ok(primaryAgentAuthored === true,
    `batch ${match[1]} uses the agent self-check contract: author outputs must be written by the primary agent; pass --primary-agent-authored to attest that no subagent or worker wrote them`);
}

/** Legacy separate-reviewer workflows may not be used for self-check batches. */
export function assertLegacyReviewWorkflowAllowed(batchId) {
  const match = /-batch-([0-9]{2})-/u.exec(batchId);
  assert.ok(match, `unsupported batch id ${batchId}`);
  assert.ok(Number(match[1]) < SELF_CHECK_FIRST_BATCH,
    `batch ${match[1]} uses the agent self-check contract; the separate-reviewer workflow is only for earlier batches`);
}
