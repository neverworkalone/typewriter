import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateCandidateBatch } from '../scripts/factory/contract.mjs';
import { buildCanonicalIndex, classifyAgainstCanonical, runFactoryIntake } from '../scripts/factory/identity-adapter.mjs';
import { runStage1 } from '../scripts/factory/produce-candidates.mjs';
import { Stage1Error, allocateBatchId, produceCandidateBatch } from '../scripts/factory/stage1.mjs';
import { validateFactoryRepository } from '../scripts/factory/validate.mjs';
import { analysisInputDigest } from '../scripts/intake/pipeline.mjs';

const METADATA = { service_version: '1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0', top_n: 3 };
const HEX = 'a'.repeat(64);

// Synthetic stand-in for kiwi_service: surface → ranked proposal paths.
const ANALYSES = {
  짠한: [[{ lemma: '짠하다', pos: 'adjective', form: '짠하' }]],
  짠해서: [[{ lemma: '짠하다', pos: 'adjective', form: '짠하' }]],
  걸음: [[{ lemma: '걸음', pos: 'noun', form: '걸음' }]],
  걸어: [[{ lemma: '걷다', pos: 'verb', form: '걷' }]],
  바람물결: [[{ lemma: '바람', pos: 'noun', form: '바람' }, { lemma: '물결', pos: 'noun', form: '물결' }]],
  망각한: [[{ lemma: '망각', pos: 'noun', form: '망각' }, { lemma: '망각하다', pos: 'verb', form: '망각하' }]],
  나는: [[{ lemma: '나', pos: 'noun', form: '나' }], [{ lemma: '날다', pos: 'verb', form: '날' }]],
};
const syntheticAnalyzer = (analyses = ANALYSES, metadata = METADATA) => async (requests) => ({
  metadata,
  results: requests.map(({ id, text }) => ({
    id, input_digest: analysisInputDigest(text), reason: '',
    ...(analyses[text] ? { status: 'ok', analyses: analyses[text] } : { status: 'unsupported', analyses: [] }),
  })),
});

const hit = (document, paragraph, surface, extra = {}) => ({
  source_path: 'corpus/x', corpus_id: 'c', document_id: document, document_ordinal: 1, paragraph_id: paragraph,
  paragraph_ordinal: 1, source_category: 'written', source_year: 2025, matched_surface_form: surface, ...extra,
});
const cand = (lemma, pos, hits, extra = {}) => ({
  proposed_lemma: lemma, proposed_pos: pos, coverage_status: 'uncovered', ambiguity_status: 'clear',
  observed_surface_forms: [...new Set(hits.map((h) => h.matched_surface_form))].map((surface) => ({ surface })),
  evidence: { representative_hits: hits }, ...extra,
});
const evidenceDoc = (candidates, over = {}) => ({
  contract_version: 'm9-corpus-candidate-evidence-v1',
  index: { input_manifest_sha256: HEX, logical_rows_sha256: 'b'.repeat(64) },
  extractor: { extractor_version: 'ex-1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0' },
  candidates, ...over,
});
const CANONICAL = [
  { id: 'w1', record_type: 'entry', lemma: '걸음', senses: [{ id: 'w1-s1', pos: 'noun', gloss: 'g' }] },
  { id: 'w2', record_type: 'entry', lemma: '걷다', senses: [{ id: 'w2-s1', pos: 'noun', gloss: 'g' }] },
];
const produce = (evidence, over = {}) => produceCandidateBatch({
  evidence, analyzer: syntheticAnalyzer(), canonicalEntries: CANONICAL, canonicalDigest: HEX, batchId: 'C000001', taskId: 'T000001', ...over,
});

test('inflected observed forms resolve to the dictionary lemma/POS, keep surfaces, and record pinned versions', async () => {
  const { manifest, rows, candidatesText } = await produce(evidenceDoc([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한'), hit('d1', 'p2', '짠해서')])]));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.candidate_id, row.input, row.pos, row.observedForms, row.holds]), [
    ['C000001-0001', '짠하다', 'adjective', ['짠한'], []],
    ['C000001-0002', '짠하다', 'adjective', ['짠해서'], []],
  ]);
  assert.equal(manifest.analyzer_version, 'kiwipiepy==0.24.0');
  assert.equal(manifest.extractor_version, 'ex-1');
  assert.equal(manifest.source_snapshot, `corpus:${HEX}:${'b'.repeat(64)}`);
  assert.equal(manifest.status, 'created');
  assert.deepEqual(validateCandidateBatch({ manifest, candidatesText }), []);
  assert.ok(!candidatesText.includes('context'));
});

test('ambiguous analysis stays an explicit hold; distinct usages of one lemma/POS stay separate; true repeats merge', async () => {
  const { rows, summary } = await produce(evidenceDoc([
    cand('나', 'noun', [hit('d2', 'p1', '나는')]),
    cand('걸음', 'noun', [hit('d3', 'p1', '걸음'), hit('d3', 'p1', '걸음'), hit('d3', 'p2', '걸음')]),
  ]));
  const ambiguous = rows.find((row) => row.input === '나');
  assert.ok(ambiguous.holds.includes('analysis_ambiguous'));
  const steps = rows.filter((row) => row.input === '걸음');
  assert.equal(steps.length, 2, 'two distinct paragraph usages stay two rows; the repeated one merges');
  assert.equal(summary.repeatsMerged, 1);
  assert.deepEqual(steps.map((row) => row.holds), [[], []], 'a sibling hold is never inherited');
});

test('existing canonical lemma, new POS and new sense are not dropped as covered', async () => {
  const { rows, summary } = await produce(evidenceDoc([
    cand('걸음', 'noun', [hit('d3', 'p1', '걸음')], { coverage_status: 'exact_canonical_lemma' }),
    cand('걷다', 'verb', [hit('d4', 'p1', '걸어')], { coverage_status: 'exact_canonical_lemma' }),
    cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')]),
  ]));
  assert.equal(rows.length, 3);
  const index = buildCanonicalIndex(CANONICAL);
  assert.deepEqual(rows.map((row) => classifyAgainstCanonical(row, index).route),
    ['new_pos_on_existing_lemma', 'new_sense_on_existing_entry', 'new_entry']);
  assert.deepEqual(summary.routes, { new_entry: 1, new_pos_on_existing_lemma: 1, new_sense_on_existing_entry: 1, held: 0 });
  // The batch feeds the shared factory identity adapter with one decision per C… id.
  const run = await runFactoryIntake({ candidates: rows, analyzer: syntheticAnalyzer({ ...ANALYSES, 걸음: ANALYSES.걸음, 걷다: [[{ lemma: '걷다', pos: 'verb', form: '걷' }]], 짠하다: ANALYSES.짠한 }), canonicalIndex: index });
  assert.deepEqual(run.results.map((result) => result.source_candidate_id), rows.map((row) => row.candidate_id));
});

test('replay is byte-identical and independent of evidence order', async () => {
  const candidates = [cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')]), cand('걸음', 'noun', [hit('d3', 'p1', '걸음')])];
  const first = await produce(evidenceDoc(candidates));
  const second = await produce(evidenceDoc(candidates));
  const shuffled = await produce(evidenceDoc([...candidates].reverse()));
  assert.equal(first.candidatesText, second.candidatesText);
  assert.equal(first.manifest.candidates_sha256, shuffled.manifest.candidates_sha256);
  assert.deepEqual(first.rows.map((row) => row.candidate_id), ['C000001-0001', 'C000001-0002']);
});

test('fails closed on raw text, malformed evidence, incompatible analyzer and unrepresentable analysis', async () => {
  const good = [cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')])];
  const rejects = async (evidence, fragment, over) => assert.rejects(() => produce(evidence, over), (error) => error instanceof Stage1Error && error.message.includes(fragment), fragment);
  await rejects(evidenceDoc([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한', { context: '원문 문단' })])]), 'raw corpus text');
  await rejects(evidenceDoc(good, { contract_version: 'other' }), 'contract_version');
  await rejects(evidenceDoc(good, { index: {} }), 'index digests');
  await rejects(evidenceDoc([]), 'no candidates');
  await rejects(evidenceDoc(good, { extractor: { extractor_version: 'x', kiwipiepy_version: '0.25.0', kiwipiepy_model_version: '0.24.0' } }), 'pinned');
  await rejects(evidenceDoc([{ ...good[0], evidence: {} }]), 'representative_hits');
  await assert.rejects(() => produce(evidenceDoc(good), { analyzer: syntheticAnalyzer(ANALYSES, { ...METADATA, kiwipiepy_version: '0.25.0' }) }), /does not match pinned/);
  await rejects(evidenceDoc([{ ...good[0], proposed_lemma: 'abc' }]), 'Korean word');
  // No hint and no analysis: nothing may be guessed.
  await assert.rejects(() => produce(evidenceDoc([{ ...good[0], proposed_pos: 'particle' }])), /proposed_pos/);
});

test('an unsupported analysis keeps the extractor hint and an explicit hold instead of a guess', async () => {
  const { rows } = await produce(evidenceDoc([cand('낯설다', 'adjective', [hit('d5', 'p1', '낯선')])]));
  assert.deepEqual(rows[0].holds, ['analysis_unsupported']);
  assert.equal(rows[0].input, '낯설다');
});

test('a candidate without a located paragraph is held, and bounded batches never split a lemma', async () => {
  const none = await produce(evidenceDoc([cand('짠하다', 'adjective', [])]));
  assert.deepEqual(none.rows[0].holds, ['no_evidence', 'analysis_unsupported'].sort().filter((h) => none.rows[0].holds.includes(h)));
  assert.ok(none.rows[0].holds.includes('no_evidence'));
  const bounded = await produce(evidenceDoc([
    cand('걸음', 'noun', [hit('d3', 'p1', '걸음'), hit('d3', 'p2', '걸음')]),
    cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한'), hit('d1', 'p2', '짠해서')]),
  ]), { maxCandidates: 3 });
  assert.equal(bounded.rows.length, 2);
  assert.deepEqual(bounded.summary.deferredLemmas, ['짠하다']);
  await assert.rejects(() => produce(evidenceDoc([cand('걸음', 'noun', [hit('d3', 'p1', '걸음'), hit('d3', 'p2', '걸음')])]), { maxCandidates: 1 }), /above the batch bound/);
});

test('batch ids are serial and collision-free', () => {
  assert.equal(allocateBatchId([]), 'C000001');
  assert.equal(allocateBatchId(['C000001', 'C000007', 'junk']), 'C000008');
});

test('CLI writes an immutable, valid batch under data/candidates and nothing else; replays to the next id', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-stage1-'));
  await mkdir(path.join(root, 'data/reference/run'), { recursive: true });
  await mkdir(path.join(root, 'data/canonical'), { recursive: true });
  await writeFile(path.join(root, 'data/canonical/a.jsonl'), `${CANONICAL.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  await writeFile(path.join(root, 'data/reference/run/candidate-evidence.json'), JSON.stringify(evidenceDoc([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')])])));
  const deps = { root, analyzer: syntheticAnalyzer(), permission: async () => {}, log: () => {} };
  const args = ['--evidence', 'data/reference/run/candidate-evidence.json', '--task-id', 'T000001', '--base-ref', 'none'];

  const dry = await runStage1([...args, '--dry-run'], deps);
  await assert.rejects(() => readdir(path.join(root, 'data/candidates')), { code: 'ENOENT' });
  const first = await runStage1(args, deps);
  assert.equal(first.manifest.batch_id, 'C000001');
  assert.equal(first.candidatesText, dry.candidatesText);
  assert.deepEqual((await readdir(path.join(root, 'data/candidates/C000001'))).sort(), ['candidates.jsonl', 'manifest.json']);
  assert.deepEqual(await readdir(path.join(root, 'data')).then((names) => names.sort()), ['candidates', 'canonical', 'reference']);
  assert.equal(await readFile(path.join(root, 'data/candidates/C000001/candidates.jsonl'), 'utf8'), first.candidatesText);
  assert.deepEqual(await validateFactoryRepository({ root }), []);
  assert.equal((await runStage1(args, deps)).manifest.batch_id, 'C000002');
  assert.deepEqual(await validateFactoryRepository({ root }), []);
});

test('CLI fails closed without permission, outside data/reference, on bad arguments and on a missing evidence file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-stage1-'));
  await mkdir(path.join(root, 'data/reference'), { recursive: true });
  const deps = { root, analyzer: syntheticAnalyzer(), permission: async () => {}, log: () => {} };
  const base = ['--task-id', 'T000001', '--base-ref', 'none'];
  await assert.rejects(() => runStage1(['--evidence', 'data/reference/x.json', ...base], { ...deps, permission: async () => { throw new Error('Corpus use is not authorized'); } }), /not authorized/);
  await assert.rejects(() => runStage1(['--evidence', 'elsewhere.json', ...base], deps), /data\/reference/);
  await assert.rejects(() => runStage1(['--evidence', 'data/reference/missing.json', ...base], deps), /cannot read evidence/);
  await assert.rejects(() => runStage1(['--task-id', 'T000001'], deps), /--evidence/);
  await assert.rejects(() => runStage1(['--evidence', 'data/reference/x.json'], deps), /--task-id/);
  await assert.rejects(() => runStage1(['--evidence', 'data/reference/x.json', ...base, '--bogus'], deps), /unknown argument/);
  await assert.rejects(() => readdir(path.join(root, 'data/candidates')), { code: 'ENOENT' });
});

test('a multi-morpheme surface not explained by the proposed lemma is held; derived predicates and plain inflections pass', async () => {
  const { rows } = await produce(evidenceDoc([
    cand('바람', 'noun', [hit('d6', 'p1', '바람물결')]),
    cand('망각하다', 'verb', [hit('d7', 'p1', '망각한')]),
    cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')]),
  ]));
  const by = Object.fromEntries(rows.map((row) => [row.input, row.holds]));
  assert.deepEqual(by.바람, ['lemma_mismatch']);
  assert.deepEqual(by.망각하다, []);
  assert.deepEqual(by.짠하다, []);
});
