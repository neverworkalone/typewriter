import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PINNED_MECAB, assertPinnedMecab, createMecabAnalyzer, createMecabProvider, defaultMecabPython, pinnedMetadata } from '../scripts/factory/mecab-provider.mjs';
import { providerIdentityDigest } from '../scripts/factory/analyzer-providers.mjs';
import { PROVIDER_REGISTRY, parseArguments } from '../scripts/factory/produce-candidates.mjs';
import { analysisInputDigest } from '../scripts/intake/pipeline.mjs';
import { pinnedMetadata as khaiiiMetadata, createKhaiiiProvider } from '../scripts/factory/khaiii-provider.mjs';
import { FILLER, HEX, cand, fillerTable, holdsOf, item, kiwi, produce, rowOf, stub, unresolvedOf } from './support/khaiii-fixtures.mjs';

const mecab = (table) => { const inner = stub(table, pinnedMetadata()); return { ...createMecabProvider({ analyze: inner.analyze }), calls: inner.calls }; };
const khaiii = (table) => { const inner = stub(table, khaiiiMetadata('native')); return { ...createKhaiiiProvider({ analyze: inner.analyze, runtime: 'native' }), calls: inner.calls }; };
const mecabLog = (result) => result.attemptLog.filter((entry) => entry.provider_id === 'mecab');

test('MeCab service regressions (synthetic tagger output recorded from the real runtime)', () => {
  const result = spawnSync(process.env.TYPEWRITER_PYTHON || 'python3', ['scripts/factory/test_mecab_service.py'], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr);
});

test('provider declares honest best-only capabilities and a pinned identity bound to the dictionary', () => {
  const provider = createMecabProvider({ analyze: async () => ({}) });
  assert.equal(provider.id, 'mecab');
  assert.deepEqual(provider.capabilities, { n_best: false, derivation: false });
  assert.equal(provider.identity.version, '1.0.2');
  assert.equal(provider.identity.model, `dictionary:${PINNED_MECAB.dictionary_digest}`);
  assert.equal(provider.identity.config.dictionary_declared_version, 'undeclared', 'the dictionary release is not claimed beyond what the package declares');
  assert.equal(provider.identity.config.wrapper_wheel_sha256, PINNED_MECAB.wrapper_wheel_sha256);
  const changed = { ...provider.identity, model: `dictionary:${HEX}` };
  assert.notEqual(providerIdentityDigest(provider.identity), providerIdentityDigest(changed));
  const requirements = readFileSync('scripts/factory/mecab-requirements.txt', 'utf8');
  assert.ok(requirements.includes(PINNED_MECAB.wrapper_wheel_sha256) && requirements.includes(PINNED_MECAB.dictionary_sdist_sha256), 'install pins match the identity');
});

test('metadata drift (wrapper, library, dictionary, loaded file, user dictionary, python) fails closed', () => {
  assertPinnedMecab(pinnedMetadata());
  for (const patch of [{ mecab_ko_version: '1.0.3' }, { mecab_library_version: '0.996' }, { library_digest: HEX }, { wrapper_extension_digest: HEX }, { dictionary_digest: HEX },
    { dictionary_package_version: '1.0.1' }, { dictionary_declared_version: '2.1.1-20180720' }, { dictionary_file_loaded: 'other.dic' }, { dictionary_lexicon_size: 1 },
    { user_dictionary: 'present' }, { python_version: '3.12' }, { proposal_contract: 'other' }, { top_n: 3 }, { provider: 'kiwi' }]) {
    assert.throws(() => assertPinnedMecab({ ...pinnedMetadata(), ...patch }), /does not match pinned/, JSON.stringify(patch));
  }
  assert.throws(() => assertPinnedMecab(undefined), /required/);
  assert.throws(() => assertPinnedMecab({}), /missing does not match/);
});

test('registry entry is lazy and --providers accepts every permitted ordered combination containing kiwi', () => {
  assert.equal(typeof PROVIDER_REGISTRY.mecab, 'function');
  for (const order of ['kiwi,mecab', 'kiwi,khaiii,mecab', 'kiwi,mecab,khaiii']) {
    assert.deepEqual(parseArguments(['--evidence', 'e.json', '--task-id', 'T000001', '--policy', 'v1', '--providers', order]).providers, order.split(','));
  }
  assert.deepEqual(parseArguments(['--evidence', 'e.json', '--task-id', 'T000001', '--policy', 'v1']).providers, ['kiwi'], 'the explicit v1 baseline stays Kiwi-only');
  assert.throws(() => parseArguments(['--evidence', 'e.json', '--task-id', 'T000001', '--policy', 'v1', '--providers', 'kiwi,mecab,mecab']), /repeat/);
});

test('fallback call count with two providers: clean Kiwi → zero MeCab calls; eligible unresolved → exactly one', async () => {
  const kiwiProvider = kiwi({ ...fillerTable, 짠한: [[item('짠하다', 'adjective')]], 걸어: [[item('걸다', 'verb')]] });
  const mecabProvider = mecab({ 낯선: [[item('낯설다', 'adjective')]], 걸어: [[item('걷다', 'verb')]] });
  const result = await produce([FILLER, cand('짠하다', 'adjective', '짠한'), cand('낯설다', 'adjective', '낯선', 'd2'), cand('걷다', 'verb', '걸어', 'd3')], [kiwiProvider, mecabProvider]);
  assert.deepEqual(mecabProvider.calls, [['낯선']], 'resolved 짠한 and the final lemma_mismatch 걸어 never reach MeCab');
  assert.deepEqual(holdsOf(result, '짠하다'), []);
  assert.deepEqual(holdsOf(result, '걸다'), ['lemma_mismatch'], 'MeCab is not consulted to reopen a mismatch');
  assert.equal(rowOf(result, '낯설다'), undefined, 'a best-only reading never creates a headword by itself');
  assert.deepEqual(unresolvedOf(result), [['낯선', ['analysis_unsupported']]]);
  assert.deepEqual(mecabLog(result).map((entry) => [entry.outcome, entry.state, entry.fallback]), [['success', 'needs_verification', true]]);

  const clean = mecab({});
  await produce([FILLER, cand('짠하다', 'adjective', '짠한')], [kiwi({ ...fillerTable, 짠한: [[item('짠하다', 'adjective')]] }), clean]);
  assert.deepEqual(clean.calls, [], 'a clean Kiwi run makes zero MeCab calls');
});

test('three providers in both orders: deterministic, lazy, one call per eligible surface, only still-unresolved surfaces move on', async () => {
  const run = async (order) => {
    const providers = { kiwi: kiwi(fillerTable), khaiii: khaiii({ 낯선: [[item('낯설다', 'adjective')]] }), mecab: mecab({ 낯선: [[item('낯설다', 'adjective')]], 서늘한: [[item('서늘하다', 'adjective')]] }) };
    const result = await produce([FILLER, cand('낯설다', 'adjective', '낯선', 'd2'), cand('서늘하다', 'adjective', '서늘한', 'd3')], order.map((id) => providers[id]));
    return { providers, result };
  };
  const a = await run(['kiwi', 'khaiii', 'mecab']);
  assert.deepEqual(a.providers.khaiii.calls, [['낯선', '서늘한']]);
  assert.deepEqual(a.providers.mecab.calls, [['낯선', '서늘한']], 'Khaiii\'s best-only reading settles nothing, so MeCab still sees both');
  const b = await run(['kiwi', 'mecab', 'khaiii']);
  assert.deepEqual(b.providers.mecab.calls, [['낯선', '서늘한']]);
  assert.deepEqual(b.providers.khaiii.calls, [['낯선', '서늘한']]);
  assert.deepEqual(a.result.manifest.analyzer_providers.map((entry) => entry.provider_id), ['kiwi', 'khaiii', 'mecab']);
  assert.deepEqual(b.result.manifest.analyzer_providers.map((entry) => entry.provider_id), ['kiwi', 'mecab', 'khaiii']);
  assert.notEqual(a.result.manifest.analyzer_digest, b.result.manifest.analyzer_digest, 'order is part of the digest');
  assert.deepEqual((await run(['kiwi', 'khaiii', 'mecab'])).result.manifest, a.result.manifest, 'deterministic');
  // Agreement of best-only engines is review evidence, never resolution.
  assert.equal(rowOf(a.result, '낯설다'), undefined);
});

test('an unexplained copula path is unsupported and a noun hint cannot turn it into a clean analysis', async () => {
  const raw = (id, text) => ({ id, input_digest: analysisInputDigest(text), status: 'unsupported', reason: 'unmapped_content_morpheme', analyses: [] });
  const provider = mecab({ 사과이다: raw });
  const result = await produce([FILLER, cand('사과', 'noun', '사과이다', 'd2')], [kiwi({ ...fillerTable, 사과이다: [[item('사과', 'noun')], [item('사과이다', 'noun')]] }), provider]);
  assert.deepEqual(provider.calls, [['사과이다']]);
  assert.equal(mecabLog(result)[0].outcome, 'unsupported');
  assert.equal(rowOf(result, '사과'), undefined);
});

test('ineligible holds (non-analysis, editorial, evidence) never reach MeCab; holds stay per observation', async () => {
  const mismatch = mecab({ 낯선: [[item('낯설다', 'adjective')]], 낯설어: [[item('낯설다', 'adjective')]] });
  const result = await produce([FILLER, cand('낯설다', 'adjective', '낯선', 'd2'), { ...cand('흐르다', 'verb', '흘러', 'd3'), ambiguity_status: 'ambiguous' }],
    [kiwi({ ...fillerTable, 낯선: [[item('낯설다', 'adjective')]], 흘러: [[item('흐르다', 'verb')]] }), mismatch]);
  assert.deepEqual(mismatch.calls, [], 'clean Kiwi readings and extractor-level holds are not MeCab business');
  assert.deepEqual(rowOf(result, '낯설다') === undefined, false);
  const two = cand('낯설다', 'adjective', '낯선', 'd2');
  two.observed_surface_forms = [{ surface: '낯선' }, { surface: '낯설어' }];
  two.evidence.representative_hits.push({ ...two.evidence.representative_hits[0], matched_surface_form: '낯설어', document_id: 'd9' });
  const partial = mecab({ 낯선: [[item('낯설다', 'adjective')]] });
  const split = await produce([FILLER, two], [kiwi({ ...fillerTable, 낯설어: [[item('낯설다', 'adjective')]] }), partial]);
  assert.deepEqual(partial.calls, [['낯선']], 'only the unresolved observation is sent');
  assert.deepEqual(unresolvedOf(split).map(([surface]) => surface), ['낯선'], 'the resolved sibling observation is not contaminated');
});

test('malformed, doubled and stale MeCab responses fail closed; run failure and dictionary drift stop the run', async () => {
  const fail = (analyze, pattern) => assert.rejects(() => produce([FILLER, cand('낯설다', 'adjective', '낯선')], [kiwi(fillerTable), { ...mecab({}), analyze }]), pattern);
  const reply = (patch) => async (requests) => ({ metadata: pinnedMetadata(), results: requests.map(({ id, text }) => ({ id, input_digest: analysisInputDigest(text), status: 'ok', reason: '', analyses: [[item('낯설다', 'adjective')]], ...patch })) });
  await fail(async () => { throw new Error('mecab runtime down'); }, /mecab failed closed: mecab runtime down/);
  await fail(async (requests) => ({ metadata: { ...pinnedMetadata(), dictionary_digest: HEX }, results: (await reply({})(requests)).results }), /dictionary_digest/);
  const missing = await produce([FILLER, cand('낯설다', 'adjective', '낯선')], [kiwi(fillerTable), { ...mecab({}), analyze: reply({ id: 'someone-else' }) }]);
  assert.equal(mecabLog(missing)[0].outcome, 'missing', 'a response for another request id is never matched to this surface');
  const doubled = await produce([FILLER, cand('낯설다', 'adjective', '낯선')], [kiwi(fillerTable), { ...mecab({}), analyze: async (requests) => {
    const r = await reply({})(requests); return { metadata: pinnedMetadata(), results: [...r.results, ...r.results] };
  } }]);
  assert.equal(mecabLog(doubled).length, 1, 'a doubled response yields one attempt, not two');
  const stale = await produce([FILLER, cand('낯설다', 'adjective', '낯선')], [kiwi(fillerTable), { ...mecab({}), analyze: reply({ input_digest: HEX }) }]);
  assert.equal(mecabLog(stale)[0].outcome, 'stale', 'a stale input digest is recorded and never trusted');
  const bad = await produce([FILLER, cand('낯설다', 'adjective', '낯선')], [kiwi(fillerTable), { ...mecab({}), analyze: reply({ analyses: [[{ lemma: '낯설다', pos: 'particle', form: '낯설' }]] }) }]);
  assert.equal(mecabLog(bad)[0].outcome, 'error');
});

test('missing runtime, wrong host and a corrupt or wrong environment fail closed without any fallback', async () => {
  assert.throws(() => createMecabAnalyzer({ platform: 'linux', arch: 'x64' }), /macOS arm64 only/);
  await assert.rejects(() => createMecabAnalyzer({ python: '/nonexistent/python', platform: 'darwin', arch: 'arm64' })([{ id: 'a', text: '먹었다' }]),
    /runtime not found.*setup-mecab\.mjs/u);
  assert.equal(defaultMecabPython('/c'), '/c/venv/bin/python');
  const python = process.env.TYPEWRITER_PYTHON || 'python3';
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'mecab-env-'));
  const originalPath = process.env.PYTHONPATH;
  try {
    const run = (files) => {
      rmSync(scratch, { recursive: true, force: true });
      mkdirSync(scratch, { recursive: true });
      for (const [name, body] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(scratch, name)), { recursive: true });
        writeFileSync(path.join(scratch, name), body);
      }
      process.env.PYTHONPATH = scratch;
      return createMecabAnalyzer({ python, platform: 'darwin', arch: 'arm64' })([{ id: 'a', text: '먹었다' }]);
    };
    // Absent dictionary package, a dictionary that cannot be loaded, and a dictionary directory that is gone: explicit service errors.
    await assert.rejects(() => run({ 'mecab_ko.py': 'VERSION = "x"\nclass Tagger:\n    pass\n' }), /mecab_unavailable/);
    await assert.rejects(() => run({ 'mecab_ko.py': 'VERSION = "x"\nclass Tagger:\n    def __init__(self):\n        raise RuntimeError("corrupt")\n', 'mecab_ko_dic.py': 'DICDIR = "/nonexistent"\nVERSION = ""\n' }), /mecab_unavailable: RuntimeError/);
    await assert.rejects(() => run({ 'mecab_ko/__init__.py': 'VERSION = "x"\nclass _I:\n    filename = "/gone/sys.dic"\n    charset = "UTF-8"\n    size = 1\n    next = None\nclass Tagger:\n    def dictionary_info(self):\n        return _I()\n', 'mecab_ko/_MeCab.cpython-311-darwin.so': 'x',
      'mecab_ko/.dylibs/libmecab.2.dylib': 'x', 'mecab_ko_dic.py': 'DICDIR = "/gone"\nVERSION = ""\n' }), /mecab_unavailable: FileNotFoundError/);
    // A runnable but wrong environment (other versions/dictionary) parses but is rejected by the identity check.
    const empty = path.join(scratch, 'dic');
    const wrong = await (async () => {
      const fake = 'VERSION = "0.996"\nclass _I:\n    filename = ' + JSON.stringify(path.join(empty, 'sys.dic')) + '\n    charset = "UTF-8"\n    size = 1\n    next = None\n'
        + 'class Tagger:\n    def dictionary_info(self):\n        return _I()\n    def parse(self, text):\n        return "먹\\tVV,*,T,먹,*,*,*,*\\n었\\tEP,*,T,었,*,*,*,*\\n다\\tEC,*,F,다,*,*,*,*\\nEOS\\n"\n';
      const analyzed = run({ 'dic/sys.dic': 'not the pinned dictionary', 'mecab_ko/__init__.py': fake, 'mecab_ko/_MeCab.cpython-311-darwin.so': 'x', 'mecab_ko/.dylibs/libmecab.2.dylib': 'x',
        'mecab_ko_dic.py': `DICDIR = ${JSON.stringify(empty)}\nVERSION = ""\n` });
      return analyzed;
    })().catch((error) => error);
    assert.ok(!(wrong instanceof Error), String(wrong?.message));
    assert.throws(() => assertPinnedMecab(wrong.metadata), /does not match pinned/);
    assert.equal(wrong.metadata.dictionary_package_version, 'unavailable');
  } finally {
    if (originalPath === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = originalPath;
    rmSync(scratch, { recursive: true, force: true });
  }
});

// Real pinned runtime. Skipped (and the reason reported) where unavailable: never a mock substitute.
const venvPython = process.env.TYPEWRITER_MECAB_PYTHON || defaultMecabPython();
const realSkip = process.platform === 'darwin' && process.arch === 'arm64' && existsSync(venvPython) ? false
  : `pinned MeCab-ko runtime not available on ${process.platform}/${process.arch} at ${venvPython} (run scripts/factory/setup-mecab.mjs on macOS arm64); real-runtime evidence not produced here`;

test('REAL pinned MeCab-ko 1.0.2 + mecab-ko-dic 1.0.0 macOS arm64 smoke', { skip: realSkip }, async () => {
  const analyze = createMecabAnalyzer({ python: venvPython });
  const surfaces = ['먹었다', '걸어', '도와', '망각했다', '행복한', '아름다웠던', '천천히', '꽃잎이', '아버지가방에들어가신다', '춥다', 'ㅋㅋㅋ', 'asdfgh', '먹어보다', '사과이다', '사과였다', '먹었다.', '두 단어', '   '];
  const { metadata, results } = await analyze(surfaces.map((text) => ({ id: text, text })));
  assertPinnedMecab(metadata);
  assert.deepEqual(results.map((result) => result.id), surfaces, 'results keep request order');
  const byId = Object.fromEntries(results.map((result) => [result.id, result]));
  const lemmas = (id) => byId[id].analyses[0].map((entry) => `${entry.lemma}/${entry.pos}`);
  assert.deepEqual(lemmas('먹었다'), ['먹다/verb']);
  assert.deepEqual(lemmas('걸어'), ['걷다/verb'], 'the dictionary best path (not the 걸다 homograph): needs_verification, never settled');
  assert.deepEqual(lemmas('도와'), ['돕다/verb']);
  assert.deepEqual(lemmas('망각했다'), ['망각하다/verb']);
  assert.deepEqual(lemmas('행복한'), ['행복하다/adjective']);
  assert.deepEqual(lemmas('아름다웠던'), ['아름답다/adjective']);
  assert.deepEqual(lemmas('천천히'), ['천천히/adverb']);
  assert.deepEqual(lemmas('꽃잎이'), ['꽃잎/noun']);
  assert.deepEqual(lemmas('아버지가방에들어가신다'), ['아버지/noun', '방/noun', '들어가다/verb']);
  assert.deepEqual(lemmas('먹었다.'), ['먹다/verb']);
  for (const id of ['춥다', 'ㅋㅋㅋ', 'asdfgh', '먹어보다', '사과이다', '사과였다', '두 단어', '   ']) assert.equal(byId[id].status, 'unsupported', id);
  assert.ok(results.every((result) => result.analyses.length <= 1 && result.analyses.flat().every((entry) => !('derived_from' in entry) && !('derived_from_index' in entry))));
  // End to end through the shared policy: MeCab alone never clears; the unsupported/ambiguous state stays explicit.
  const result = await produce([FILLER, cand('먹다', 'verb', '먹었다')], [kiwi(fillerTable), createMecabProvider({ analyze })]);
  assert.equal(rowOf(result, '먹다'), undefined);
  assert.deepEqual(unresolvedOf(result), [['먹었다', ['analysis_unsupported']]]);
});
