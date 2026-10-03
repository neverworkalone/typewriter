import assert from 'node:assert/strict';
import test from 'node:test';

import { assertBatchIntakeHandoff } from '../scripts/batch/build-issue-223-corpus-batch.mjs';
import { sha256Json } from '../scripts/validate/semantic-audit.mjs';
import { syntheticAdapter } from '../scripts/intake/adapters/synthetic-adapter.mjs';
import { analysisInputDigest } from '../scripts/intake/pipeline.mjs';
import {
  buildProductionHandoff,
  corpusBatchCandidates,
  handoffEntryFor,
  handoffQaBinding,
  integrationBlock,
  verifyProductionHandoff,
  verifyTrackedHandoff,
} from '../scripts/intake/production-handoff.mjs';

const BATCH = 'issue-223-m9-e-corpus-batch-16-20261004';
const METADATA = { service_version: '1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0', top_n: 3 };
const P = (lemma, pos) => ({ lemma, pos, form: lemma });
const TABLE = {
  푸르다: { status: 'ok', analyses: [[P('푸르다', 'adjective')], []] },
  장년: { status: 'ok', analyses: [[P('장년', 'noun')], []] },
  물결무늬: { status: 'ok', analyses: [[P('물결', 'noun'), P('무늬', 'noun')]] },
  바라다: { status: 'ok', analyses: [[P('바라다', 'verb')], [P('바라다', 'adjective')]] },
};
const analyzer = async (requests) => ({
  metadata: METADATA,
  results: requests.map(({ id, text }) => ({ ...(TABLE[text] ?? { status: 'unsupported', analyses: [] }), id, input_digest: analysisInputDigest(text) })),
});

const hit = (n) => ({ document_id: `D${n}`, paragraph_id: `P${n}` });
const inventoryCandidate = (lemma, pos, extra = {}) => ({
  proposed_lemma: lemma, proposed_pos: pos, decision_state: 'candidate', coverage_status: 'uncovered', ambiguity_status: 'single_observed_analysis_unverified',
  observed_surface_forms: [{ surface: lemma }], ...extra,
});
const INVENTORY = { candidates: [inventoryCandidate('푸르다', 'adjective'), inventoryCandidate('장년', 'noun'), inventoryCandidate('물결무늬', 'noun'), inventoryCandidate('바라다', 'verb'), inventoryCandidate('오오', 'noun', { decision_state: 'held', ambiguity_status: 'held_homograph' })] };
const EVIDENCE = { candidates: INVENTORY.candidates.map((_, index) => ({ evidence: { representative_hits: [hit(index), hit(index + 10)] } })) };

const rowFor = (lemma, pos, gloss, ordinal) => ({
  candidate_ordinal: ordinal,
  morphology_proposal: { lemma, pos },
  bounded_provenance: { representative_hits: [hit(1), hit(2)] },
  editorial_judgment: { disposition: 'admit', writer_gloss: gloss },
});
const ROWS = [rowFor('푸르다', 'adjective', '맑은 초록이나 파랑을 띠다.', 1), rowFor('장년', 'noun', '청년과 노년 사이의 나이대.', 2)];

async function fixture() {
  const raw = corpusBatchCandidates(INVENTORY, EVIDENCE);
  const handoff = await buildProductionHandoff({ batchId: BATCH, rawCandidates: raw, analyzer });
  const bytes = Buffer.from(`${JSON.stringify(handoff, null, 2)}\n`);
  const bindings = Object.fromEntries(ROWS.map((row) => {
    const lemma = row.morphology_proposal.lemma;
    const entry = handoffEntryFor(handoff, { lemma, proposedPos: row.morphology_proposal.pos });
    return [lemma, handoffQaBinding(handoff, entry, { glossSha256: sha256Json(row.editorial_judgment.writer_gloss), pos: row.morphology_proposal.pos })];
  }));
  return { handoff, bytes, raw, semanticInput: { intake_handoff: integrationBlock(handoff, bytes, { bindings }) } };
}
const check = (f, overrides = {}) => assertBatchIntakeHandoff({
  handoffBytes: f.bytes, inventory: INVENTORY, evidence: EVIDENCE, batchId: BATCH, semanticInput: f.semanticInput, rows: ROWS, ...overrides,
});
const code = (error) => error.code;
const qa = (handoff) => handoff.entries.find((entry) => entry.input === '푸르다');

test('hand-off preserves adapter holds and routes uncertain analysis to QA/hold, never auto-admits', async () => {
  const { handoff } = await fixture();
  const by = (input) => handoff.entries.find((entry) => entry.input === input);
  assert.equal(by('푸르다').decision, 'semantic_qa');
  assert.equal(by('물결무늬').holds[0], 'lemma_mismatch');
  assert.equal(by('바라다').holds[0], 'analysis_ambiguous');
  assert.ok(by('오오').holds.includes('analysis_ambiguous'));
  assert.deepEqual(by('푸르다').adapter_ids, ['written-corpus-2025']);
  assert.ok(handoff.entries.every((entry) => !('text' in entry)));
});

test('valid hand-off admits bound reviews through the real builder boundary', async () => {
  assert.equal(check(await fixture()), true);
});

test('corpus-disabled synthetic adapter yields the same hand-off contract', async () => {
  const raw = syntheticAdapter(['푸르다', '장년']);
  const handoff = await buildProductionHandoff({ batchId: BATCH, rawCandidates: raw, analyzer, adapterId: 'synthetic-word-list' });
  assert.equal(verifyProductionHandoff(handoff, { rawCandidates: raw, batchId: BATCH }), true);
  assert.deepEqual(handoff.entries.map((entry) => entry.decision), ['semantic_qa', 'semantic_qa']);
});

test('tampered inputs, versions, evidence and bindings are rejected', async () => {
  const f = await fixture();
  const mutate = (fn) => { const copy = structuredClone(f.handoff); fn(copy); return Buffer.from(JSON.stringify(copy)); };
  const expectCode = (overrides, expected) => assert.throws(() => check(f, overrides), (error) => code(error) === expected);

  expectCode({ handoffBytes: mutate((h) => { h.analyzer.kiwipiepy_version = '0.23.0'; }) }, 'INTAKE_HANDOFF_ANALYZER');
  expectCode({ handoffBytes: mutate((h) => { h.analyzer = null; }) }, 'INTAKE_HANDOFF_ANALYZER');
  expectCode({ handoffBytes: mutate((h) => { h.input_digest = 'x'; }) }, 'INTAKE_HANDOFF_INPUT_DIGEST');
  expectCode({ batchId: 'issue-223-m9-e-corpus-batch-17-20261004' }, 'INTAKE_HANDOFF_BATCH');
  expectCode({ evidence: { candidates: EVIDENCE.candidates.map((entry, i) => (i === 0 ? { evidence: { representative_hits: [hit(10), hit(0)].slice(0, 1) } } : entry)) } }, 'INTAKE_HANDOFF_INPUT_DIGEST');
  expectCode({ inventory: { candidates: [...INVENTORY.candidates.slice(0, 1).map((c) => ({ ...c, proposed_pos: 'noun' })), ...INVENTORY.candidates.slice(1)] } }, 'INTAKE_HANDOFF_INPUT_DIGEST');
  expectCode({ handoffBytes: mutate((h) => { qa(h).analysis_binding = '0'.repeat(64); }) }, 'INTAKE_HANDOFF_ANALYSIS_BINDING');
  expectCode({ handoffBytes: mutate((h) => { qa(h).evidence.reverse(); }) }, 'INTAKE_HANDOFF_EVIDENCE');
  expectCode({ handoffBytes: mutate((h) => { qa(h).adapter_ids = ['other']; }) }, 'INTAKE_HANDOFF_ADAPTERS');
  expectCode({ handoffBytes: mutate((h) => { h.entries.pop(); }) }, 'INTAKE_HANDOFF_COVERAGE');
  // The review input is bound to the exact hand-off bytes.
  expectCode({ handoffBytes: mutate((h) => { h.entries[1].duplicate_count = 9; }) }, 'INTAKE_HANDOFF_QA_BINDING');
});

test('changed gloss, POS or lemma invalidates the prior QA disposition', async () => {
  const f = await fixture();
  const expectBinding = (rows) => assert.throws(() => check(f, { rows }), (error) => code(error) === 'INTAKE_HANDOFF_QA_BINDING');
  expectBinding([{ ...ROWS[0], editorial_judgment: { ...ROWS[0].editorial_judgment, writer_gloss: '다른 풀이.' } }, ROWS[1]]);
  expectBinding([ROWS[0]]);
  expectBinding([...ROWS, rowFor('낯선말', 'noun', '풀이.', 4)]);
});

test('held, covered and unresolved-uncertainty candidates cannot be admitted', async () => {
  const f = await fixture();
  const withBinding = (lemma, proposedPos, rows, extra = {}) => {
    const entry = handoffEntryFor(f.handoff, { lemma, proposedPos });
    const row = rowFor(lemma, proposedPos, '풀이.', rows);
    const binding = handoffQaBinding(f.handoff, entry, { glossSha256: sha256Json('풀이.'), pos: proposedPos });
    return { row, semanticInput: { intake_handoff: integrationBlock(f.handoff, f.bytes, { bindings: { [lemma]: binding }, ...extra }) } };
  };
  // Reviewable analyzer hold (compound Kiwi splits): needs an explicit, evidence-citing resolution.
  const compound = withBinding('물결무늬', 'noun', 3);
  assert.throws(() => check(f, { rows: [compound.row], semanticInput: compound.semanticInput }), (error) => code(error) === 'INTAKE_HANDOFF_HOLD_UNRESOLVED');
  const resolved = withBinding('물결무늬', 'noun', 3, { resolutions: { 물결무늬: { checked_hit_indices: [0, 1], rationale: '문맥 0, 1에서 하나의 합성어로 쓰인다.' } } });
  assert.equal(check(f, { rows: [resolved.row], semanticInput: resolved.semanticInput }), true);
  const outOfRange = withBinding('물결무늬', 'noun', 3, { resolutions: { 물결무늬: { checked_hit_indices: [7], rationale: '존재하지 않는 문맥.' } } });
  assert.throws(() => check(f, { rows: [outOfRange.row], semanticInput: outOfRange.semanticInput }), (error) => code(error) === 'INTAKE_HANDOFF_HOLD_UNRESOLVED');
  // A hold with a hard reason (adapter held for ambiguity is reviewable; invalid input is not).
  const hardHandoff = structuredClone(f.handoff);
  hardHandoff.entries.find((entry) => entry.input === '바라다').holds = ['coverage_collision'];
  const hardBytes = Buffer.from(JSON.stringify(hardHandoff));
  const hardEntry = hardHandoff.entries.find((entry) => entry.input === '바라다');
  const hardBinding = handoffQaBinding(hardHandoff, hardEntry, { glossSha256: sha256Json('풀이.'), pos: 'verb' });
  assert.throws(
    () => assertBatchIntakeHandoff({
      handoffBytes: hardBytes, inventory: INVENTORY, evidence: EVIDENCE, batchId: BATCH, rows: [rowFor('바라다', 'verb', '풀이.', 4)],
      semanticInput: { intake_handoff: integrationBlock(hardHandoff, hardBytes, { bindings: { 바라다: hardBinding } }) },
    }),
    (error) => ['INTAKE_HANDOFF_HELD', 'INTAKE_HANDOFF_INPUT_DIGEST', 'INTAKE_HANDOFF_DECISION'].includes(code(error)),
  );
  // An admitted candidate with no intake entry, or a covered lemma, is refused.
  const covered = await buildProductionHandoff({ batchId: BATCH, rawCandidates: corpusBatchCandidates(INVENTORY, EVIDENCE), analyzer, coveredLemmas: new Set(['장년']) });
  const coveredBytes = Buffer.from(JSON.stringify(covered));
  const coveredEntry = handoffEntryFor(covered, { lemma: '장년', proposedPos: 'noun' });
  const coveredBinding = handoffQaBinding(covered, coveredEntry, { glossSha256: sha256Json('풀이.'), pos: 'noun' });
  assert.throws(
    () => assertBatchIntakeHandoff({
      handoffBytes: coveredBytes, inventory: INVENTORY, evidence: EVIDENCE, batchId: BATCH, rows: [rowFor('장년', 'noun', '풀이.', 2)],
      semanticInput: { intake_handoff: integrationBlock(covered, coveredBytes, { bindings: { 장년: coveredBinding } }) },
    }),
    (error) => code(error) === 'INTAKE_HANDOFF_COVERED',
  );
});

test('an integration block without --intake-handoff is not silently ignored by the builder contract', async () => {
  const f = await fixture();
  assert.throws(() => check(f, { semanticInput: {} }), (error) => code(error) === 'INTAKE_HANDOFF_QA_BINDING');
});

test('tracked hand-off re-verifies offline against tracked admissions', async () => {
  const f = await fixture();
  const rows = ROWS.map((row) => ({ ...row, editorial_judgment: { ...row.editorial_judgment } }));
  assert.equal(verifyTrackedHandoff({ handoffBytes: f.bytes, semanticInput: f.semanticInput, candidateRows: rows, batchId: BATCH }), true);
  const changed = rows.map((row, index) => (index ? row : { ...row, editorial_judgment: { ...row.editorial_judgment, writer_gloss: '바뀐 풀이.' } }));
  assert.throws(() => verifyTrackedHandoff({ handoffBytes: f.bytes, semanticInput: f.semanticInput, candidateRows: changed, batchId: BATCH }), (error) => code(error) === 'INTAKE_HANDOFF_QA_BINDING');
});

test('an adapter-held candidate re-labelled semantic_qa with recomputed bindings is rejected at the builder boundary', async () => {
  const f = await fixture();
  const forged = structuredClone(f.handoff);
  const entry = forged.entries.find((item) => item.input === '오오');
  const source = f.raw.find((candidate) => candidate.input === '오오');
  Object.assign(entry, { decision: 'semantic_qa', holds: [], pos: 'noun', observed_forms: ['오오'], evidence: [], analysis_binding: qa(f.handoff).analysis_binding });
  delete entry.proposed_pos;
  assert.ok(source.holds.includes('analysis_ambiguous'));
  const bytes = Buffer.from(JSON.stringify(forged));
  const row = rowFor('오오', 'noun', '풀이.', 5);
  const binding = handoffQaBinding(forged, entry, { glossSha256: sha256Json('풀이.'), pos: 'noun' });
  assert.throws(
    () => assertBatchIntakeHandoff({ handoffBytes: bytes, inventory: INVENTORY, evidence: EVIDENCE, batchId: BATCH, rows: [row], semanticInput: { intake_handoff: integrationBlock(forged, bytes, { bindings: { 오오: binding } }) } }),
    (error) => code(error) === 'INTAKE_HANDOFF_HOLD_DROPPED',
  );
});

test('an analyzer-originated hold re-labelled semantic_qa with recomputed bindings is rejected', async () => {
  const f = await fixture();
  const forged = structuredClone(f.handoff);
  const entry = forged.entries.find((item) => item.input === '바라다');
  assert.equal(entry.decision, 'hold');
  Object.assign(entry, { decision: 'semantic_qa', holds: [], pos: 'verb', observed_forms: ['바라다'], evidence: f.raw.find((c) => c.input === '바라다').evidence, analysis_binding: qa(f.handoff).analysis_binding });
  delete entry.proposed_pos;
  const bytes = Buffer.from(JSON.stringify(forged));
  const binding = handoffQaBinding(forged, entry, { glossSha256: sha256Json('풀이.'), pos: 'verb' });
  const run = (hand, buf) => assertBatchIntakeHandoff({ handoffBytes: buf, inventory: INVENTORY, evidence: EVIDENCE, batchId: BATCH, rows: [rowFor('바라다', 'verb', '풀이.', 4)], semanticInput: { intake_handoff: integrationBlock(hand, buf, { bindings: { 바라다: binding } }) } });
  assert.throws(() => run(forged, bytes), (error) => ['INTAKE_HANDOFF_DECISION', 'INTAKE_HANDOFF_EVIDENCE', 'INTAKE_HANDOFF_ANALYSIS_BINDING'].includes(code(error)));
  // Even with the outcome rewritten to look clean, an entry that omits it is refused.
  delete entry.analysis_outcome;
  const noOutcome = Buffer.from(JSON.stringify(forged));
  assert.throws(() => run(forged, noOutcome), (error) => code(error) === 'INTAKE_HANDOFF_OUTCOME');
});
