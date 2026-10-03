import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { corpusAdapter } from '../scripts/intake/adapters/corpus-adapter.mjs';
import { syntheticAdapter } from '../scripts/intake/adapters/synthetic-adapter.mjs';
import { dedupeCandidates, normalizeCandidate, validateCandidate } from '../scripts/intake/candidate-contract.mjs';
import { analysisInputDigest, runIntake, verifyAnalysisBinding } from '../scripts/intake/pipeline.mjs';

const METADATA = { service_version: '1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0', top_n: 3 };
const P = (lemma, pos) => ({ lemma, pos, form: lemma });
const TABLE = {
  푸르다: { status: 'ok', analyses: [[P('푸르다', 'adjective')], [P('푸르다', 'noun')]] },
  바람: { status: 'ok', analyses: [[P('바람', 'noun')], [P('바라다', 'verb')]] },
  바라다: { status: 'ok', analyses: [[P('바라다', 'verb')], [P('바라다', 'adjective')]] },
  물결무늬: { status: 'ok', analyses: [[P('물결', 'noun'), P('무늬', 'noun')], [P('물결무늬', 'noun')]] },
  낯선말: { status: 'unsupported', analyses: [] },
  깨짐이: { status: 'error', analyses: [] },
};
const analyzer = async (requests) => ({
  metadata: METADATA,
  results: requests.map(({ id, text }) => ({
    ...(TABLE[text] ?? { status: 'unsupported', proposals: [] }),
    id,
    input_digest: analysisInputDigest(text),
  })),
});
const decisionOf = (run, input) => run.decisions.find((decision) => decision.input === input);

test('synthetic adapter runs the whole common path without the corpus adapter', async () => {
  const run = await runIntake({
    adapterId: 'synthetic',
    analyzer,
    candidates: syntheticAdapter(['푸르다', { word: '바람', pos: 'noun' }, '푸르다', '바라다', '물결무늬', '낯선말', '깨짐이', '없는말', 'abc', { word: '바람', pos: 'verb' }]),
  });
  assert.equal(decisionOf(run, '푸르다').decision, 'semantic_qa');
  assert.equal(decisionOf(run, '푸르다').pos, 'adjective');
  assert.equal(decisionOf(run, '푸르다').duplicateCount, 2);
  assert.equal(decisionOf(run, '바라다').holds[0], 'analysis_ambiguous');
  assert.equal(decisionOf(run, '물결무늬').holds[0], 'lemma_mismatch');
  assert.equal(decisionOf(run, '낯선말').holds[0], 'analysis_unsupported');
  assert.equal(decisionOf(run, '깨짐이').holds[0], 'analysis_error');
  assert.equal(decisionOf(run, '없는말').holds[0], 'analysis_unsupported');
  assert.equal(decisionOf(run, 'abc').holds[0], 'invalid_input');
  assert.deepEqual(run.decisions.filter((d) => d.input === '바람').map((d) => [d.pos ?? d.proposedPos, d.decision]).sort(), [['noun', 'semantic_qa'], ['noun', 'hold']].sort());
});

test('covered lemmas skip analysis; word-only input needs no evidence', async () => {
  let analyzed = [];
  const run = await runIntake({
    candidates: syntheticAdapter(['푸르다', '바람']),
    coveredLemmas: new Set(['바람']),
    analyzer: async (requests) => { analyzed = requests.map((r) => r.text); return analyzer(requests); },
  });
  assert.deepEqual(analyzed, ['푸르다']);
  assert.equal(decisionOf(run, '바람').decision, 'covered');
});

test('corpus adapter maps pilot output to the same contract', async () => {
  const candidates = corpusAdapter({ candidates: [{ proposed_lemma: '푸르다', proposed_pos: 'adjective', observed_surface_forms: [{ surface: '푸른' }] }] });
  const run = await runIntake({ candidates, analyzer });
  const decision = decisionOf(run, '푸르다');
  assert.equal(decision.decision, 'semantic_qa');
  assert.deepEqual(decision.observedForms, ['푸른']);
  assert.equal(validateCandidate(normalizeCandidate(candidates[0])).length, 0);
});

test('analysis bindings fail on stale analyzer or changed POS', async () => {
  const run = await runIntake({ candidates: syntheticAdapter(['푸르다']), analyzer });
  const record = decisionOf(run, '푸르다');
  assert.equal(verifyAnalysisBinding(record, METADATA), true);
  assert.throws(() => verifyAnalysisBinding(record, { ...METADATA, kiwipiepy_version: 'newer' }), /Stale/);
  assert.throws(() => verifyAnalysisBinding({ ...record, pos: 'noun' }, METADATA), /Stale/);
});

test('stale analysis input digest is held, results are deterministic', async () => {
  const stale = async (requests) => {
    const response = await analyzer(requests);
    response.results[0].input_digest = 'stale';
    return response;
  };
  const run = await runIntake({ candidates: syntheticAdapter(['푸르다']), analyzer: stale });
  assert.deepEqual(decisionOf(run, '푸르다').holds, ['analysis_stale']);
  const first = await runIntake({ candidates: syntheticAdapter(['푸르다', '바람']), analyzer });
  const second = await runIntake({ candidates: syntheticAdapter(['바람', '푸르다']), analyzer });
  assert.deepEqual(first, second);
});

test('dedupe merges forms and shared stages never import an adapter', async () => {
  const merged = dedupeCandidates([
    normalizeCandidate({ input: '푸르다', pos: 'adjective', observedForms: ['푸른'] }, { adapterId: 'a' }),
    normalizeCandidate({ input: '푸르다', pos: 'adjective', observedForms: ['푸르게'] }, { adapterId: 'b' }),
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].observedForms, ['푸르게', '푸른']);
  for (const file of ['pipeline.mjs', 'candidate-contract.mjs', 'kiwi-client.mjs']) {
    const source = await readFile(new URL(`../scripts/intake/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /adapters\/|CorpusAdapter|corpus-adapter/);
  }
});

test('frame verdicts bind to analysis and never let Kiwi alone admit a frame', async () => {
  const { analyzeFrames, frameDisposition } = await import('../scripts/intake/frame-analysis.mjs');
  const frames = {
    '푸른 하늘이었다.': { status: 'ok', analyses: [[P('푸르다', 'adjective')], []] },
    '사세요.': { status: 'ok', analyses: [[P('사다', 'verb')], [P('살다', 'verb')]] },
    '가게 앞.': { status: 'ok', analyses: [[P('가게', 'noun')]] },
  };
  const frameAnalyzer = async (requests) => ({
    metadata: METADATA,
    results: requests.map(({ id, text }) => ({ ...frames[text], id, input_digest: analysisInputDigest(text) })),
  });
  const results = await analyzeFrames(frameAnalyzer, [
    { frame: '푸른 하늘이었다.', lemma: '푸르다', pos: 'adjective' },
    { frame: '사세요.', lemma: '살다', pos: 'verb' },
    { frame: '가게 앞.', lemma: '가다', pos: 'verb' },
  ]);
  assert.deepEqual(results.map((r) => r.verdict), ['uses', 'ambiguous', 'absent']);
  assert.equal(frameDisposition(true, 'uses'), 'confirmed');
  assert.equal(frameDisposition(true, 'ambiguous'), 'manual_check');
  assert.equal(frameDisposition(false, 'uses'), 'rejected');
});

test('adapter-observed holds survive and skip analysis', async () => {
  let analyzed = 0;
  const run = await runIntake({
    candidates: corpusAdapter({ candidates: [{ proposed_lemma: '푸르다', proposed_pos: 'adjective', decision_state: 'held' }] }),
    analyzer: async (requests) => { analyzed += requests.length; return analyzer(requests); },
  });
  assert.equal(analyzed, 0);
  assert.deepEqual(decisionOf(run, '푸르다').holds, ['analysis_ambiguous']);
});

test('adverbs and one-syllable words are valid candidates', async () => {
  const table = { 낫: { status: 'ok', analyses: [[P('낫', 'noun')]] }, 매우: { status: 'ok', analyses: [[P('매우', 'adverb')]] } };
  const run = await runIntake({
    candidates: syntheticAdapter([{ word: '낫', pos: 'noun' }, { word: '매우', pos: 'adverb' }, { word: '낫', pos: 'noun' }, 'ab']),
    analyzer: async (requests) => ({ metadata: METADATA, results: requests.map(({ id, text }) => ({ ...table[text], id, input_digest: analysisInputDigest(text) })) }),
  });
  assert.equal(decisionOf(run, '낫').decision, 'semantic_qa');
  assert.equal(decisionOf(run, '매우').pos, 'adverb');
  assert.deepEqual(decisionOf(run, 'ab').holds, ['invalid_input']);
});

test('missing analysis digest, unpinned analyzer and corpus locations are enforced', async () => {
  const noDigest = async (requests) => {
    const response = await analyzer(requests);
    delete response.results[0].input_digest;
    return response;
  };
  const run = await runIntake({ candidates: syntheticAdapter(['푸르다']), analyzer: noDigest });
  assert.deepEqual(decisionOf(run, '푸르다').holds, ['analysis_stale']);
  const unpinned = async (requests) => ({ ...(await analyzer(requests)), metadata: { ...METADATA, kiwipiepy_version: 'unavailable' } });
  await assert.rejects(runIntake({ candidates: syntheticAdapter(['푸르다']), analyzer: unpinned }), /pinned/);
  const [row] = corpusAdapter({ candidates: [{ proposed_lemma: '푸르다', evidence: { representative_hits: [{ document_id: 'D.1', paragraph_id: 'D.1.18', context: 'text' }] } }] });
  assert.deepEqual(row.evidence[0], { kind: 'corpus-paragraph', ref: 'D.1#D.1.18' });
  assert.equal(normalizeCandidate(row).evidence[0].ref, 'D.1#D.1.18');
});
