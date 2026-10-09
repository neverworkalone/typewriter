import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { expectedAnalyzerDigest, sha256Hex, validateCandidateBatch } from '../scripts/factory/contract.mjs';
import { buildCanonicalIndex, buildSearchFormSupport, classifyLemmaCandidate, runFactoryIntake } from '../scripts/factory/identity-adapter.mjs';
import { MAX_OBSERVATIONS_PER_CANDIDATE } from '../scripts/factory/lemma-contract.mjs';
import { runStage1 } from '../scripts/factory/produce-candidates.mjs';
import { buildExclusionManifest, parseArguments as parseCorpusArguments } from '../scripts/reference/run-corpus-lemma-pilot.mjs';
import { resolveTypewriterCachePaths } from '../scripts/typewriter-cache.mjs';
import { Stage1Error, allocateBatchId, produceCandidateBatch } from '../scripts/factory/stage1.mjs';
import { validateFactoryRepository } from '../scripts/factory/validate.mjs';
import { analysisInputDigest } from '../scripts/intake/pipeline.mjs';

const METADATA = { service_version: '1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0', top_n: 3, proposal_contract: 'derivation-root-v1' };
const HEX = 'a'.repeat(64);

async function taskCacheFor(root, taskId = 'T000001') {
  const cachePaths = resolveTypewriterCachePaths({ homeDirectory: path.join(root, '.test-home'), env: {} });
  const taskDirectory = path.join(cachePaths.runs, taskId);
  await mkdir(taskDirectory, { recursive: true });
  return { cachePaths, taskDirectory, evidenceArgument: `runs/${taskId}/candidate-evidence.json` };
}

// Synthetic stand-in for kiwi_service: surface → ranked proposal paths.
const P = (lemma, pos, form = lemma) => ({ lemma, pos, form });
const ANALYSES = {
  짠한: [[P('짠하다', 'adjective', '짠하')]],
  짠해서: [[P('짠하다', 'adjective', '짠하')]],
  걸음: [[P('걸음', 'noun')]],
  걸어: [[P('걷다', 'verb', '걷')]],
  가는: [[P('가다', 'verb', '가')]],
  가서: [[P('가다', 'verb', '가')]],
  갈: [[P('가다', 'verb', '가')]],
  다시: [[P('다시', 'adverb')]],
  다신: [[P('다시', 'noun')]],
  바람물결: [[P('바람', 'noun'), P('물결', 'noun')]],
  집집: [[P('집', 'noun'), P('집', 'noun')]],
  사랑한: [[P('사', 'noun'), P('사랑하다', 'verb', '사랑하')]],
  사하다형: [[P('사', 'noun'), P('사', 'noun'), { ...P('사하다', 'verb', '사하'), derived_from: '사', derived_from_index: 1 }]],
  망각한: [[P('망각', 'noun'), { ...P('망각하다', 'verb', '망각하'), derived_from: '망각', derived_from_index: 0 }]],
  나는: [[P('나', 'noun')], [P('날다', 'verb', '날')]],
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
  evidence, analyzer: syntheticAnalyzer(), canonicalEntries: CANONICAL, canonicalDigest: HEX, batchId: 'C000002', taskId: 'T000001', ...over,
});

test('one lemma observed as several inflected forms is ONE candidate with attributable forms and observations', async () => {
  const { manifest, rows, candidatesText } = await produce(evidenceDoc([
    cand('가다', 'verb', [hit('d1', 'p1', '가는'), hit('d2', 'p4', '가서'), hit('d3', 'p9', '갈')]),
  ]));
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.candidate_id, 'C000002-0001');
  assert.equal(row.input, '가다');
  assert.deepEqual(row.pos_hypotheses, ['verb']);
  assert.deepEqual(row.forms, [
    { form_id: 'C000002-0001.f01', surface: '가는' }, { form_id: 'C000002-0001.f02', surface: '가서' }, { form_id: 'C000002-0001.f03', surface: '갈' },
  ]);
  assert.equal(row.observations.length, 3);
  assert.deepEqual(row.observations.map((o) => [o.observation_id, o.form_id, o.evidence.ref]), [
    ['C000002-0001.o01', 'C000002-0001.f01', 'd1#p1'], ['C000002-0001.o02', 'C000002-0001.f02', 'd2#p4'], ['C000002-0001.o03', 'C000002-0001.f03', 'd3#p9'],
  ]);
  assert.equal(row.observation_total, 3);
  assert.equal(manifest.contract, 'lexical-factory-candidate-manifest-v2');
  assert.equal(manifest.candidate_count, 1, 'candidate_count counts distinct lemmas');
  assert.equal(manifest.observation_count, 3);
  assert.equal(manifest.analyzer_version, 'kiwipiepy==0.24.0');
  assert.equal(manifest.source_snapshot, `corpus:${HEX}:${'b'.repeat(64)}`);
  assert.equal(manifest.status, 'created');
  assert.deepEqual(validateCandidateBatch({ manifest, candidatesText }), []);
  assert.ok(!candidatesText.includes('context'));
});

test('the bound and accounting count distinct lemmas, never usages; metrics are reported separately', async () => {
  const hits = Array.from({ length: 6 }, (_, i) => hit('d1', `p${i}`, i % 2 ? '가는' : '가서'));
  const { rows, manifest, summary } = await produce(evidenceDoc([
    cand('가다', 'verb', hits),
    cand('짠하다', 'adjective', [hit('d2', 'p1', '짠한'), hit('d2', 'p2', '짠해서')]),
    cand('걸음', 'noun', [hit('d3', 'p1', '걸음')]),
  ]), { maxCandidates: 2 });
  assert.deepEqual(rows.map((row) => row.input), ['가다', '걸음'], 'deterministic lemma order; 9 observations never fill a 2-lemma bound');
  assert.equal(manifest.candidate_count, 2);
  assert.deepEqual(manifest.selection, { bound: 2, eligible_lemma_count: 3, deferred_lemma_count: 1 });
  assert.deepEqual(summary.deferredLemmas, ['짠하다']);
  assert.equal(summary.metrics.unique_lemmas, 2);
  assert.equal(summary.metrics.observations_total, 7);
  assert.equal(summary.metrics.observed_forms, 3);
  assert.equal(summary.metrics.pos_hypotheses, 2);
  assert.equal(summary.metrics.usage_groups, 2);
  assert.equal(summary.metrics.repeated_evidence_merged, 0);
  await assert.rejects(() => produce(evidenceDoc([cand('가다', 'verb', [hit('d1', 'p1', '가는')])]), { maxCandidates: 0 }), /max candidates/);
  await assert.rejects(() => produce(evidenceDoc([cand('가다', 'verb', [hit('d1', 'p1', '가는')])]), { maxCandidates: 1001 }), /max candidates/);
});

test('two evidence-backed sense directions of one lemma/POS stay two usage groups of ONE candidate', async () => {
  const { rows, manifest, candidatesText } = await produce(evidenceDoc([
    cand('가다', 'verb', [hit('d1', 'p1', '가는', { usage_group: 'move' }), hit('d2', 'p1', '가서', { usage_group: 'move' }), hit('d3', 'p1', '갈', { usage_group: 'pass' })]),
  ]));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].usage_groups, [
    { group_id: 'C000002-0001.g01', pos: 'verb', basis: 'corpus-hint', hint: 'move' },
    { group_id: 'C000002-0001.g02', pos: 'verb', basis: 'corpus-hint', hint: 'pass' },
  ]);
  assert.deepEqual(rows[0].observations.map((o) => o.group_id), ['C000002-0001.g01', 'C000002-0001.g01', 'C000002-0001.g02']);
  assert.deepEqual(validateCandidateBatch({ manifest, candidatesText }), []);
  await assert.rejects(() => produce(evidenceDoc([cand('가다', 'verb', [hit('d1', 'p1', '가는', { usage_group: 'Free Text!' })])])), /usage_group/);
});

test('noun and verb POS hypotheses of one lemma count once and each POS route stays reviewable', async () => {
  const { rows, summary } = await produce(evidenceDoc([
    cand('다시', 'adverb', [hit('d1', 'p1', '다시')]),
    cand('다시', 'noun', [hit('d2', 'p1', '다신')]),
  ]));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].pos_hypotheses, ['adverb', 'noun']);
  assert.deepEqual(rows[0].usage_groups.map((g) => [g.group_id, g.pos]), [['C000002-0001.g01', 'adverb'], ['C000002-0001.g02', 'noun']]);
  assert.equal(summary.metrics.unique_lemmas, 1);
  assert.equal(summary.metrics.pos_hypotheses, 2);
  assert.equal(summary.routes.new_entry, 2, 'one route per POS hypothesis');
});

test('an ambiguous surface holds only its own observation; sibling forms and the lemma stay clear', async () => {
  const analyses = { ...ANALYSES, 갈: [[P('가다', 'verb', '가')], [P('갈다', 'verb', '갈')]] };
  const { rows } = await produceCandidateBatch({
    evidence: evidenceDoc([cand('가다', 'verb', [hit('d1', 'p1', '가는'), hit('d2', 'p1', '갈')])]),
    analyzer: syntheticAnalyzer(analyses), canonicalEntries: CANONICAL, canonicalDigest: HEX, batchId: 'C000002', taskId: 'T000001',
  });
  assert.equal(rows.length, 1);
  const bySurface = Object.fromEntries(rows[0].observations.map((o) => [rows[0].forms.find((f) => f.form_id === o.form_id).surface, o.holds]));
  assert.deepEqual(bySurface, { 가는: [], 갈: ['analysis_ambiguous'] });
});

test('distinct references of one form stay traceable; identical repeats merge; no text is stored', async () => {
  const { rows, summary } = await produce(evidenceDoc([
    cand('걸음', 'noun', [hit('d3', 'p1', '걸음'), hit('d3', 'p1', '걸음'), hit('d3', 'p2', '걸음')]),
  ]));
  assert.deepEqual(rows[0].observations.map((o) => o.evidence.ref), ['d3#p1', 'd3#p2']);
  assert.equal(rows[0].observation_total, 2);
  assert.equal(summary.metrics.repeated_evidence_merged, 1);
});

test('over-cap evidence is bounded but can never erase a form or a usage group; the rest is digest-bound', async () => {
  const many = Array.from({ length: 80 }, (_, i) => hit('d1', `p${String(i).padStart(3, '0')}`, '가는', { usage_group: 'move' }));
  const tail = [hit('d9', 'p1', '갈', { usage_group: 'pass' })];
  const { rows, manifest, candidatesText } = await produce(evidenceDoc([cand('가다', 'verb', [...many, ...tail])]));
  const [row] = rows;
  assert.equal(row.observations.length, MAX_OBSERVATIONS_PER_CANDIDATE);
  assert.equal(row.observation_total, 81);
  assert.ok(row.observations.some((o) => o.group_id === 'C000002-0001.g02'), 'the later sense group survives the cap');
  assert.ok(row.forms.every((form) => row.observations.some((o) => o.form_id === form.form_id)));
  assert.deepEqual(validateCandidateBatch({ manifest, candidatesText }), []);
  const same = await produce(evidenceDoc([cand('가다', 'verb', [...many, ...tail])]));
  assert.equal(same.rows[0].observation_digest, row.observation_digest);
  const fewer = await produce(evidenceDoc([cand('가다', 'verb', [...many.slice(1), ...tail])]));
  assert.notEqual(fewer.rows[0].observation_digest, row.observation_digest, 'an omitted observation still changes the digest');
});

test('analysis without a reliable lemma/POS is preserved for verification, never counted as a headword', async () => {
  const { rows, manifest, summary } = await produce(evidenceDoc([
    cand('낯설다', 'adjective', [hit('d5', 'p1', '낯선')]),
    cand('걸음', 'noun', [hit('d3', 'p1', '걸음')]),
  ]));
  assert.deepEqual(rows.map((row) => row.input), ['걸음']);
  assert.deepEqual(manifest.unresolved_observations, [{ surface: '낯선', evidence: { kind: 'corpus-paragraph', ref: 'd5#p1' }, holds: ['analysis_unsupported'] }]);
  assert.equal(summary.metrics.unique_lemmas, 1);
  assert.equal(summary.metrics.unresolved_observations, 1);
  await assert.rejects(() => produce(evidenceDoc([cand('낯설다', 'adjective', [hit('d5', 'p1', '낯선')])])), /no unprocessed lemmas/);
});

test('a candidate without a located paragraph is held on its surface observation', async () => {
  const { rows } = await produce(evidenceDoc([cand('걸음', 'noun', [])]));
  assert.deepEqual(rows[0].observations.map((o) => [o.evidence.kind, o.holds]), [['corpus-surface', ['no_evidence']]]);
});

test('a punctuated eojeol hit is counted and omitted, never stored; a phrase still fails closed', async () => {
  const { rows, summary } = await produce(evidenceDoc([
    cand('걸음', 'noun', [hit('d3', 'p1', '걸음'), hit('d3', 'p2', "걸음'을")]),
    cand('낯설다', 'adjective', [hit('d5', 'p1', "낯선'")]),
  ]));
  assert.equal(summary.omittedNonWordFormHits, 2);
  assert.deepEqual(rows.find((row) => row.input === '걸음').observations.map((o) => o.evidence.ref), ['d3#p1']);
  assert.deepEqual(rows.find((row) => row.input === '낯설다')?.observations.map((o) => [o.evidence.kind, o.holds]) ?? [['corpus-surface', ['no_evidence']]], [['corpus-surface', ['no_evidence']]]);
  await assert.rejects(() => produce(evidenceDoc([cand('걸음', 'noun', [hit('d3', 'p1', '걸음 을 걷다')])])), /single bounded word form/);
  for (const bad of ['🙂', '1\uFE0F\u20E3', '걸음1\uFE0F\u20E3', '1.', '걸음🙂', '걸음\u0007', '가'.repeat(25), '걸음 을']) {
    await assert.rejects(() => produce(evidenceDoc([cand('걸음', 'noun', [hit('d3', 'p1', bad)])])), /single bounded word form/, `symbol/control/oversize form ${JSON.stringify(bad)} must fail closed`);
  }
});

test('canonical comparison: new lemma, new POS, possible new sense, and unsupported search forms are routed, never auto-covered', async () => {
  const entries = [
    ...CANONICAL,
    { id: 'w3', record_type: 'entry', lemma: '가다', senses: [{ id: 'w3-s1', pos: 'verb', gloss: 'g' }] },
  ];
  const { rows, summary } = await produce(evidenceDoc([
    cand('가다', 'verb', [hit('d1', 'p1', '가는'), hit('d2', 'p1', '가서')]),
    cand('걸음', 'verb', [hit('d3', 'p1', '걸음')], { coverage_status: 'exact_canonical_lemma' }),
    cand('짠하다', 'adjective', [hit('d4', 'p1', '짠한')]),
  ]), {
    canonicalEntries: entries,
    searchFormSupport: buildSearchFormSupport([{ record_id: 'w3', sense_id: 'w3-s1', form: '가는', rule_id: 'r' }]),
    analyzer: syntheticAnalyzer({ ...ANALYSES, 걸음: [[P('걸음', 'verb')]] }),
  });
  assert.equal(rows.length, 3, 'nothing is dropped as covered at Stage 1');
  assert.deepEqual(summary.routes, {
    new_entry: 1, new_pos_on_existing_lemma: 1, new_sense_on_existing_entry: 1,
    lemmas_with_unsupported_forms: 1, unsupported_forms: 1, lemmas_with_holds: 0,
  });
  const index = buildCanonicalIndex(entries);
  const support = buildSearchFormSupport([{ record_id: 'w3', sense_id: 'w3-s1', form: '가는', rule_id: 'r' }]);
  const go = classifyLemmaCandidate(rows.find((row) => row.input === '가다'), index, support);
  assert.deepEqual(go.routes.map((r) => [r.pos, r.route]), [['verb', 'new_sense_on_existing_entry']]);
  assert.deepEqual(go.unsupported_forms, ['가서'], 'the supported form is not re-added; only 가서 needs the search coverage route');
  assert.deepEqual(classifyLemmaCandidate(rows.find((row) => row.input === '짠하다'), index, support).unsupported_forms, [], 'a new lemma has no search-form gap');
});

test('the lemma batch feeds the shared factory identity adapter; each observation keeps its own hold', async () => {
  const { rows } = await produce(evidenceDoc([cand('가다', 'verb', [hit('d1', 'p1', '가는'), hit('d2', 'p1', '가서')])]));
  rows[0].observations[1].holds = ['analysis_ambiguous'];
  const table = { 가다: { status: 'ok', analyses: [[P('가다', 'verb')]] } };
  const analyzer = async (requests) => ({ metadata: { service_version: '1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0', top_n: 3 }, results: requests.map(({ id, text }) => ({ ...table[text], id, input_digest: analysisInputDigest(text) })) });
  const { results } = await runFactoryIntake({ candidates: rows, analyzer, canonicalIndex: buildCanonicalIndex(CANONICAL) });
  assert.deepEqual(results.map((r) => [r.source_candidate_id, r.observation_id, r.decision]), [
    ['C000002-0001', 'C000002-0001.o01', 'semantic_qa'], ['C000002-0001', 'C000002-0001.o02', 'hold'],
  ]);
});

test('replay is byte-identical and independent of evidence order', async () => {
  const candidates = [cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')]), cand('걸음', 'noun', [hit('d3', 'p1', '걸음')])];
  const first = await produce(evidenceDoc(candidates));
  const second = await produce(evidenceDoc(candidates));
  const shuffled = await produce(evidenceDoc([...candidates].reverse()));
  assert.equal(first.candidatesText, second.candidatesText);
  assert.equal(first.manifest.candidates_sha256, shuffled.manifest.candidates_sha256);
  assert.deepEqual(first.rows.map((row) => [row.candidate_id, row.input]), [['C000002-0001', '걸음'], ['C000002-0002', '짠하다']]);
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
  await assert.rejects(() => produce(evidenceDoc([{ ...good[0], proposed_pos: 'particle' }])), /proposed_pos/);
});

test('an analyzer without the derivation-root proposal contract is refused and the manifest records it', async () => {
  const { proposal_contract: _omit, ...legacy } = METADATA;
  const evidence = evidenceDoc([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')])]);
  await assert.rejects(() => produce(evidence, { analyzer: syntheticAnalyzer(ANALYSES, legacy) }), /proposal_contract missing/);
  await assert.rejects(() => produce(evidence, { analyzer: syntheticAnalyzer(ANALYSES, { ...METADATA, proposal_contract: 'other' }) }), /proposal_contract other/);
  const { manifest } = await produce(evidence);
  assert.equal(manifest.proposal_contract, 'derivation-root-v1');
  assert.equal(manifest.analyzer_digest, expectedAnalyzerDigest(manifest));
});

test('batch ids are serial and collision-free', () => {
  assert.equal(allocateBatchId([]), 'C000001');
  assert.equal(allocateBatchId(['C000001', 'C000007', 'junk']), 'C000008');
});

test('CLI writes an immutable, valid lemma batch and nothing else; reruns only yield unproduced lemmas', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-stage1-'));
  const cache = await taskCacheFor(root);
  await mkdir(path.join(root, 'data/canonical'), { recursive: true });
  await writeFile(path.join(root, 'data/canonical/a.jsonl'), `${CANONICAL.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  const writeEvidence = (candidates) => writeFile(path.join(cache.taskDirectory, 'candidate-evidence.json'), JSON.stringify(evidenceDoc(candidates)));
  await writeEvidence([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')])]);
  const deps = { root, cachePaths: cache.cachePaths, analyzer: syntheticAnalyzer(), permission: async () => {}, log: () => {} };
  const args = ['--evidence', cache.evidenceArgument, '--task-id', 'T000001', '--base-ref', 'none', '--policy', 'provider-resolution-v1'];

  const dry = await runStage1([...args, '--dry-run'], deps);
  await assert.rejects(() => readdir(path.join(root, 'data/candidates')), { code: 'ENOENT' });
  await assert.rejects(() => readdir(path.join(root, 'data/reference')), { code: 'ENOENT' });
  const first = await runStage1(args, deps);
  assert.equal(first.manifest.batch_id, 'C000001');
  assert.equal(first.candidatesText, dry.candidatesText);
  assert.deepEqual((await readdir(path.join(root, 'data/candidates/C000001'))).sort(), ['candidates.jsonl', 'manifest.json']);
  assert.deepEqual(await readdir(path.join(root, 'data')).then((names) => names.sort()), ['candidates', 'canonical']);
  assert.equal(await readFile(path.join(root, 'data/candidates/C000001/candidates.jsonl'), 'utf8'), first.candidatesText);
  assert.deepEqual(await validateFactoryRepository({ root }), []);
  // Same evidence again: its lemma is already produced, so nothing is regenerated.
  await assert.rejects(() => runStage1(args, deps), /no unprocessed lemmas/);
  assert.deepEqual((await readdir(path.join(root, 'data/candidates'))).sort(), ['C000001']);
  // New evidence adds one more lemma and more evidence for a produced one: only the new headword is produced.
  await writeEvidence([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한'), hit('d1', 'p2', '짠해서')]), cand('걸음', 'noun', [hit('d3', 'p1', '걸음')])]);
  const next = await runStage1(args, deps);
  assert.equal(next.manifest.batch_id, 'C000002');
  assert.deepEqual(next.rows.map((row) => [row.candidate_id, row.input]), [['C000002-0001', '걸음']]);
  assert.equal(next.summary.skippedProducedLemmas, 1);
  assert.deepEqual(await validateFactoryRepository({ root }), []);
});

test('Stage 1 consumes real-shape cached selections, rejects malformed rows, and uses source-bound manifests', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-stage1-exclusion-binding-'));
  const cache = await taskCacheFor(root);
  await mkdir(path.join(root, 'data/canonical'), { recursive: true });
  await writeFile(path.join(root, 'data/canonical/a.jsonl'), `${CANONICAL.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  const candidate = cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')]);
  const selectionPath = path.join(cache.taskDirectory, 'candidate-selection.json');
  const selectorInput = {
    selection: { contract_version: 'm9-corpus-candidate-selection-v1' },
    candidates: [{ proposed_lemma: '짠하다', proposed_pos: 'adjective', coverage_normalized_key: '짠하다' }],
  };
  const sourceOptions = { repositoryDirectory: root, cachePaths: cache.cachePaths };
  const deps = { root, cachePaths: cache.cachePaths, analyzer: syntheticAnalyzer(), permission: async () => {}, log: () => {} };
  const args = ['--evidence', cache.evidenceArgument, '--task-id', 'T000001', '--base-ref', 'none', '--policy', 'provider-resolution-v1'];
  const writeBoundEvidence = async (manifest) => {
    await writeFile(path.join(cache.taskDirectory, 'reviewed-lemma-exclusions.json'), JSON.stringify(manifest));
    await writeFile(path.join(cache.taskDirectory, 'candidate-evidence.json'), JSON.stringify(evidenceDoc([candidate], {
      schema_version: 'm9-corpus-candidate-evidence-v1',
      selection: {
        exclusion_sha256: manifest.exclusion_sha256,
        exclusion_source_artifacts: manifest.source_artifacts,
        excluded_candidate_lemma_count: manifest.lemmas.length,
      },
      orchestration: { exclusion_manifest_sha256: manifest.exclusion_sha256 },
    })));
  };

  await writeFile(selectionPath, JSON.stringify({
    ...selectorInput,
    candidates: [...selectorInput.candidates, { lemma: '잘못된' }],
  }));
  const malformedArgs = parseCorpusArguments([
    '--exclude-lemma-source', 'runs/T000001/candidate-selection.json',
  ], sourceOptions);
  await assert.rejects(buildExclusionManifest(malformedArgs.exclusionLemmaSources, sourceOptions), /trimmed NFC lemmas/u);

  await writeFile(selectionPath, JSON.stringify(selectorInput));
  const validArgs = parseCorpusArguments([
    '--exclude-lemma-source', 'runs/T000001/candidate-selection.json',
  ], sourceOptions);
  const manifest = await buildExclusionManifest(validArgs.exclusionLemmaSources, sourceOptions);
  assert.deepEqual(manifest.lemmas, ['짠하다']);
  assert.deepEqual(manifest.source_artifacts.map(({ path: source }) => source), ['runs/T000001/candidate-selection.json']);
  await writeBoundEvidence(manifest);
  await assert.rejects(() => runStage1(args, deps), /no unprocessed lemmas/u);
});

test('Stage 1 consumer rejects a digest-valid nonempty exclusion manifest without source artifacts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-stage1-unbound-exclusions-'));
  const cache = await taskCacheFor(root);
  await mkdir(path.join(root, 'data/canonical'), { recursive: true });
  const payload = {
    lemmas: ['짠하다'],
    schema_version: 'm9-reviewed-lemma-exclusions-v1',
    source_artifacts: [],
  };
  const exclusionSha256 = sha256Hex(JSON.stringify(payload));
  await writeFile(path.join(cache.taskDirectory, 'reviewed-lemma-exclusions.json'), JSON.stringify({
    ...payload,
    exclusion_sha256: exclusionSha256,
  }));
  await writeFile(path.join(cache.taskDirectory, 'candidate-evidence.json'), JSON.stringify(evidenceDoc([
    cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')]),
  ], {
    schema_version: 'm9-corpus-candidate-evidence-v1',
    selection: {
      exclusion_sha256: exclusionSha256,
      exclusion_source_artifacts: [],
      excluded_candidate_lemma_count: 1,
    },
    orchestration: { exclusion_manifest_sha256: exclusionSha256 },
  })));
  const deps = { root, cachePaths: cache.cachePaths, analyzer: syntheticAnalyzer(), permission: async () => {}, log: () => {} };
  await assert.rejects(() => runStage1([
    '--evidence', cache.evidenceArgument,
    '--task-id', 'T000001',
    '--base-ref', 'none',
    '--policy', 'provider-resolution-v1',
  ], deps), /must bind at least one source artifact/u);
});

test('post-write validation is base-aware like CI: merged reviews are compared to the base, a new batch stays fail-closed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-stage1-'));
  const cache = await taskCacheFor(root);
  await mkdir(path.join(root, 'data/canonical'), { recursive: true });
  await writeFile(path.join(root, 'data/canonical/a.jsonl'), `${CANONICAL.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  await writeFile(path.join(cache.taskDirectory, 'candidate-evidence.json'), JSON.stringify(evidenceDoc([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')])])));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('add', 'data/canonical');
  git('commit', '-q', '-m', 'base');
  const args = ['--evidence', cache.evidenceArgument, '--task-id', 'T000001', '--policy', 'provider-resolution-v1'];
  const seen = [];
  const deps = { root, cachePaths: cache.cachePaths, analyzer: syntheticAnalyzer(), permission: async () => {}, log: () => {}, validate: async (options) => { seen.push(options.base); return validateFactoryRepository(options); } };
  const generated = await runStage1([...args, '--base-ref', 'HEAD'], deps);
  assert.equal(generated.manifest.producer_revision, git('rev-parse', 'HEAD').toString().trim());
  assert.equal(seen.length, 1);
  assert.match(seen[0].commit, /^[0-9a-f]{40}$/u);
  await rm(path.join(root, 'data/candidates'), { recursive: true });
  await runStage1([...args, '--base-ref', 'none'], deps);
  assert.equal(seen[1], null);
  await rm(path.join(root, 'data/candidates'), { recursive: true });
  const failing = { ...deps, validate: async () => ['C000001: new batch error'] };
  await assert.rejects(() => runStage1([...args, '--base-ref', 'HEAD'], failing), /new batch error/);
  await assert.rejects(() => readdir(path.join(root, 'data/candidates/C000001')), { code: 'ENOENT' });
  for (const sourcePath of ['scripts/factory/working-copy.mjs', 'scripts/intake/kiwi-client.mjs']) {
    const absoluteSource = path.join(root, sourcePath);
    await mkdir(path.dirname(absoluteSource), { recursive: true });
    await writeFile(absoluteSource, 'export const dirty = true;\n');
    await assert.rejects(
      () => runStage1([...args, '--base-ref', 'HEAD'], deps),
      /producer source scope has uncommitted changes/u,
      sourcePath,
    );
    await rm(path.dirname(absoluteSource), { recursive: true, force: true });
    await assert.rejects(() => readdir(path.join(root, 'data/candidates/C000001')), { code: 'ENOENT' });
  }
});

test('Git-backed Stage 1 refuses an unresolved HEAD even when base-ref is none', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-stage1-unborn-git-'));
  try {
    const cache = await taskCacheFor(root);
    await mkdir(path.join(root, 'data/canonical'), { recursive: true });
    await writeFile(path.join(root, 'data/canonical/a.jsonl'), `${CANONICAL.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    await writeFile(path.join(cache.taskDirectory, 'candidate-evidence.json'), JSON.stringify(evidenceDoc([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')])])));
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
    const deps = { root, cachePaths: cache.cachePaths, analyzer: syntheticAnalyzer(), permission: async () => {}, log: () => {} };
    await assert.rejects(() => runStage1([
      '--evidence', cache.evidenceArgument, '--task-id', 'T000001', '--base-ref', 'none', '--policy', 'provider-resolution-v1',
    ], deps), /Git-backed Stage 1 checkout has no resolvable HEAD/u);
    await assert.rejects(() => readdir(path.join(root, 'data/candidates')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI fails closed without permission, outside data/reference, on bad arguments and on a missing evidence file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-stage1-'));
  const cache = await taskCacheFor(root);
  const deps = { root, cachePaths: cache.cachePaths, analyzer: syntheticAnalyzer(), permission: async () => {}, log: () => {} };
  const base = ['--task-id', 'T000001', '--base-ref', 'none', '--policy', 'provider-resolution-v1'];
  await assert.rejects(() => runStage1(['--evidence', 'data/reference/x.json', ...base], { ...deps, permission: async () => { throw new Error('Corpus use is not authorized'); } }), /not authorized/);
  await assert.rejects(() => runStage1(['--evidence', path.join(root, 'elsewhere.json'), ...base], deps), /must be inside/u);
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
    cand('집', 'noun', [hit('d8', 'p1', '집집')]),
    cand('사랑하다', 'verb', [hit('d9', 'p1', '사랑한')]),
    cand('사하다', 'verb', [hit('d10', 'p1', '사하다형')]),
  ]));
  const by = Object.fromEntries(rows.map((row) => [row.input, row.observations.flatMap((o) => o.holds)]));
  assert.deepEqual(by.바람, ['lemma_mismatch']);
  assert.deepEqual(by.망각하다, []);
  assert.deepEqual(by.짠하다, []);
  assert.deepEqual(by.사랑하다, ['lemma_mismatch'], 'a prefix noun without the analyzer-recorded derivation link is held');
  assert.deepEqual(by.사하다, ['lemma_mismatch'], 'only the linked root occurrence is explained; a duplicate same-spelled root is held');
  assert.deepEqual(by.집, ['lemma_mismatch'], 'a repeated/prefix non-derived morpheme is not an explained surface');
});
