import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { createKiwiProvider, normalizeProviderResult } from '../scripts/factory/analyzer-providers.mjs';
import { DEFAULT_KHAIII_IMAGE, KHAIII_RUNTIMES, NATIVE_RELEASE, PINNED_KHAIII, assertPinnedKhaiii, createKhaiiiAnalyzer, createKhaiiiProvider, defaultNativeRoot,
  pinnedMetadata, resolveKhaiiiRuntime } from '../scripts/factory/khaiii-provider.mjs';
import { providerIdentityDigest } from '../scripts/factory/analyzer-providers.mjs';
import { PROVIDER_REGISTRY } from '../scripts/factory/produce-candidates.mjs';
import { produceCandidateBatch } from '../scripts/factory/stage1.mjs';
import { analysisInputDigest } from '../scripts/intake/pipeline.mjs';

const HEX = 'a'.repeat(64);
const KIWI_METADATA = { service_version: '1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0', top_n: 3, proposal_contract: 'derivation-root-v1' };
const item = (lemma, pos, form = lemma.replace(/다$/u, '')) => ({ lemma, pos, form });

// Synthetic table → service-shaped result. Records the surfaces each provider was asked about.
function stub(table, metadata) {
  const calls = [];
  return { calls, analyze: async (requests) => {
    calls.push(requests.map((request) => request.text));
    return { metadata, results: requests.map(({ id, text }) => {
      const entry = table[text];
      if (typeof entry === 'function') return entry(id, text);
      return { id, input_digest: analysisInputDigest(text), reason: '', ...(entry ? { status: 'ok', analyses: entry } : { status: 'unsupported', analyses: [] }) };
    }) };
  } };
}
const kiwi = (table) => { const inner = stub(table, KIWI_METADATA); return { ...createKiwiProvider({ analyze: inner.analyze }), calls: inner.calls }; };
const khaiii = (table, runtime = 'native') => { const inner = stub(table, pinnedMetadata(runtime)); return { ...createKhaiiiProvider({ analyze: inner.analyze, runtime }), calls: inner.calls }; };

const hit = (document, surface) => ({ source_path: 'c/x', corpus_id: 'c', document_id: document, document_ordinal: 1, paragraph_id: 'p1',
  paragraph_ordinal: 1, source_category: 'written', source_year: 2025, matched_surface_form: surface });
const cand = (lemma, pos, surface, document = 'd1') => ({ proposed_lemma: lemma, proposed_pos: pos, coverage_status: 'uncovered', ambiguity_status: 'clear',
  observed_surface_forms: [{ surface }], evidence: { representative_hits: [hit(document, surface)] } });
const produce = (candidates, providers) => produceCandidateBatch({
  evidence: { contract_version: 'm9-corpus-candidate-evidence-v1', index: { input_manifest_sha256: HEX, logical_rows_sha256: 'b'.repeat(64) },
    extractor: { extractor_version: 'ex-1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0' }, candidates },
  providers, canonicalEntries: [], canonicalDigest: HEX, batchId: 'C000001', taskId: 'T000001',
});
const rowOf = (result, lemma) => result.rows.find((row) => row.input === lemma);
const unresolvedOf = (result) => result.manifest.unresolved_observations.map((entry) => [entry.surface, entry.holds]);
const FILLER = cand('걸음', 'noun', '걸음', 'dz');
const fillerTable = { 걸음: [[item('걸음', 'noun')]] };
const holdsOf = (result, lemma) => [...new Set(rowOf(result, lemma).observations.flatMap((observation) => observation.holds))].sort();

test('Khaiii service regressions (synthetic Khaiii API; not proof the official binary ran)', () => {
  const result = spawnSync(process.env.TYPEWRITER_PYTHON || 'python3', ['scripts/factory/test_khaiii_service.py'], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr);
});

test('provider declares honest best-only capabilities and a pinned, reproducible identity', () => {
  for (const runtime of KHAIII_RUNTIMES) {
    const provider = createKhaiiiProvider({ analyze: async () => ({}), runtime });
    assert.deepEqual(provider.capabilities, { n_best: false, derivation: false });
    assert.equal(provider.identity.version, '0.4');
    assert.equal(provider.identity.config.runtime, runtime);
    assert.equal(provider.identity.config.source_sha, 'fa5fbd10aeddfe97cd7aa87faee39628e5e9c18a');
    assert.match(provider.identity.model, /^resource:[0-9a-f]{64}$/u);
  }
  const native = createKhaiiiProvider({ analyze: async () => ({}), runtime: 'native' }).identity.config;
  assert.deepEqual([native.archive_sha256, native.library_digest, native.fork_commit], [NATIVE_RELEASE.archive_sha256, NATIVE_RELEASE.library_digest, NATIVE_RELEASE.fork_commit]);
  // Runtime and binary identity are part of the digest: native and docker never share one.
  assert.notEqual(providerIdentityDigest(createKhaiiiProvider({ analyze: async () => ({}), runtime: 'native' }).identity),
    providerIdentityDigest(createKhaiiiProvider({ analyze: async () => ({}), runtime: 'docker' }).identity));
  // The Dockerfile builds exactly the pinned source revision.
  const dockerfile = readFileSync('docker/khaiii/Dockerfile', 'utf8');
  assert.ok(dockerfile.includes(`KHAIII_SHA=${PINNED_KHAIII.khaiii_source_sha}`));
  assert.ok(dockerfile.includes('FROM ubuntu:20.04'));
  assert.ok(readFileSync('docker/khaiii/README.md', 'utf8').includes(PINNED_KHAIII.resource_digest));
});

test('metadata drift (version, source, resource bundle, binary, runtime) fails closed per runtime', () => {
  for (const runtime of KHAIII_RUNTIMES) {
    assertPinnedKhaiii(pinnedMetadata(runtime), runtime);
    for (const patch of [{ khaiii_version: '0.5' }, { khaiii_source_sha: 'deadbeef' }, { resource_digest: HEX }, { proposal_contract: 'other' }, { top_n: 3 },
      { library_digest: HEX }, { release_fork_commit: 'deadbeef' }, { release_provenance_digest: HEX }]) {
      assert.throws(() => assertPinnedKhaiii({ ...pinnedMetadata(runtime), ...patch }, runtime), /does not match pinned/);
    }
  }
  assert.throws(() => assertPinnedKhaiii(pinnedMetadata('docker'), 'native'), /does not match pinned/, 'a container result cannot pass as the native runtime');
  assert.throws(() => assertPinnedKhaiii(pinnedMetadata('native'), 'docker'), /does not match pinned/);
  assert.throws(() => assertPinnedKhaiii(undefined), /required/);
});

test('runtime selection: native default on macOS arm64, docker elsewhere, explicit override, invalid fails', () => {
  assert.equal(resolveKhaiiiRuntime({ env: {}, platform: 'darwin', arch: 'arm64' }), 'native');
  assert.equal(resolveKhaiiiRuntime({ env: {}, platform: 'linux', arch: 'x64' }), 'docker');
  assert.equal(resolveKhaiiiRuntime({ env: {}, platform: 'darwin', arch: 'x64' }), 'docker');
  assert.equal(resolveKhaiiiRuntime({ env: { TYPEWRITER_KHAIII_RUNTIME: 'docker' }, platform: 'darwin', arch: 'arm64' }), 'docker');
  assert.equal(resolveKhaiiiRuntime({ env: { TYPEWRITER_KHAIII_RUNTIME: 'native' }, platform: 'linux', arch: 'x64' }), 'native');
  assert.throws(() => resolveKhaiiiRuntime({ env: { TYPEWRITER_KHAIII_RUNTIME: 'podman' } }), /native\|docker/);
});

test('native failure is reported, never silently switched to docker', async () => {
  const missing = createKhaiiiAnalyzer({ runtime: 'native', nativeRoot: '/nonexistent/khaiii', platform: 'darwin', arch: 'arm64', docker: '/nonexistent/docker-must-not-run' });
  await assert.rejects(() => missing([{ id: 'a', text: '먹었다' }]), /native release not found.*Not falling back to docker/u);
  assert.throws(() => createKhaiiiAnalyzer({ runtime: 'native', platform: 'linux', arch: 'x64' }), /macOS arm64 only.*TYPEWRITER_KHAIII_RUNTIME=docker/u);
  assert.equal(defaultNativeRoot('/c'), `/c/${NATIVE_RELEASE.tag}/${NATIVE_RELEASE.directory}`);
});

test('kiwi alone never constructs or runs Khaiii (lazy registry)', async () => {
  // The registry entry is a factory: nothing is constructed (and no container started) unless listed.
  assert.equal(typeof PROVIDER_REGISTRY.khaiii, 'function');
  let started = 0;
  const original = PROVIDER_REGISTRY.khaiii;
  assert.ok(original);
  const kiwiOnly = kiwi({ 짠한: [[item('짠하다', 'adjective')]] });
  const result = await produce([cand('짠하다', 'adjective', '짠한')], [kiwiOnly]);
  assert.deepEqual(holdsOf(result, '짠하다'), []);
  assert.equal(started, 0);
  assert.equal(result.manifest.analyzer_providers, undefined, 'the default manifest is unchanged');
});

test('fallback call count: a Kiwi-resolved candidate never reaches Khaiii; only unresolved eligible surfaces do', async () => {
  const kiwiProvider = kiwi({ ...fillerTable, 짠한: [[item('짠하다', 'adjective')]], 걸어: [[item('걸다', 'verb')]] });
  const khaiiiProvider = khaiii({ 낯선: [[item('낯설다', 'adjective')]], 걸어: [[item('걷다', 'verb')]] });
  const result = await produce([FILLER, cand('짠하다', 'adjective', '짠한'), cand('낯설다', 'adjective', '낯선', 'd2'), cand('걷다', 'verb', '걸어', 'd3')], [kiwiProvider, khaiiiProvider]);
  assert.deepEqual(kiwiProvider.calls, [['걸어', '걸음', '낯선', '짠한']]);
  assert.deepEqual(khaiiiProvider.calls, [['낯선']], 'resolved 짠한 and the final lemma_mismatch 걸어 are not sent to Khaiii');
  assert.deepEqual(holdsOf(result, '짠하다'), []);
  assert.deepEqual(holdsOf(result, '걸다'), ['lemma_mismatch']);
  // Best-only: Khaiii's clean single path never makes 낯선 a headword; it stays an explicit unresolved observation.
  assert.equal(rowOf(result, '낯설다'), undefined);
  assert.deepEqual(unresolvedOf(result), [['낯선', ['analysis_unsupported']]]);
  const log = result.attemptLog.filter((entry) => entry.provider_id === 'khaiii');
  assert.deepEqual(log.map((entry) => [entry.outcome, entry.state, entry.fallback]), [['success', 'needs_verification', true]]);
});

test('Khaiii never clears analysis_ambiguous or any hold on one best segmentation', async () => {
  const kiwiRival = kiwi({ ...fillerTable, 바라: [[item('바라다', 'verb')], [item('바람', 'noun')]] });
  const result = await produce([FILLER, cand('바라다', 'verb', '바라')], [kiwiRival, khaiii({ 바라: [[item('바라다', 'verb')]] })]);
  assert.deepEqual(holdsOf(result, '바라다'), ['analysis_ambiguous'], 'the rival reading stays held');
  // Khaiii is consulted (eligible hold) but cannot settle it; its agreement is not N-best proof.
  assert.equal(result.attemptLog.filter((entry) => entry.provider_id === 'khaiii')[0].state, 'needs_verification');
});

test('Khaiii that explains only part of a surface keeps the shared lemma_mismatch hold', async () => {
  const result = await produce([FILLER, cand('사하다', 'verb', '사사하다')],
    [kiwi(fillerTable), khaiii({ 사사하다: [[item('사', 'noun'), item('사하다', 'verb', '사하')]] })]);
  assert.equal(rowOf(result, '사하다'), undefined, 'a partly explained surface is not a headword');
  assert.ok(unresolvedOf(result).flatMap(([, holds]) => holds).length > 0);
});

test('Khaiii failure is isolated to a closed run and metadata change alters the analyzer digest', async () => {
  const down = { ...khaiii({}), analyze: async () => { throw new Error('docker unavailable'); } };
  await assert.rejects(() => produce([FILLER, cand('낯설다', 'adjective', '낯선')], [kiwi(fillerTable), down]), /khaiii failed closed: docker unavailable/);
  const run = (providers) => produce([FILLER, cand('낯설다', 'adjective', '낯선')], providers);
  const base = await run([kiwi(fillerTable), khaiii({ 낯선: [[item('낯설다', 'adjective')]] })]);
  const again = await run([kiwi(fillerTable), khaiii({ 낯선: [[item('낯설다', 'adjective')]] })]);
  assert.deepEqual(base.manifest, again.manifest);
  assert.deepEqual(base.manifest.analyzer_providers.map((entry) => entry.provider_id), ['kiwi', 'khaiii']);
  const changed = { ...khaiii({ 낯선: [[item('낯설다', 'adjective')]] }) };
  changed.identity = { ...changed.identity, model: `resource:${HEX}` };
  assert.notEqual((await run([kiwi(fillerTable), changed])).manifest.analyzer_digest, base.manifest.analyzer_digest);
});

test('Khaiii results pass the shared normalization (malformed output is an error, not a certain result)', () => {
  const provider = createKhaiiiProvider({ analyze: async () => ({}) });
  const request = { id: '낯선', text: '낯선' };
  const bad = normalizeProviderResult(provider, request, { id: '낯선', input_digest: analysisInputDigest('낯선'), status: 'ok', analyses: [[{ lemma: '낯설다', pos: 'particle', form: '낯설' }]] });
  assert.equal(bad.outcome, 'error');
});

// Real pinned runtimes. Each is skipped (and the reason reported) where unavailable: never a mock substitute.
const image = process.env.TYPEWRITER_KHAIII_IMAGE || DEFAULT_KHAIII_IMAGE;
const docker = process.env.TYPEWRITER_DOCKER || 'docker';
const probe = spawnSync(docker, ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' });
const dockerSkip = probe.status === 0 ? false : `Khaiii image ${image} not available (build: docker/khaiii/README.md); docker real-binary evidence not produced here`;
const nativeRoot = process.env.TYPEWRITER_KHAIII_NATIVE_ROOT || defaultNativeRoot();
const nativeSkip = process.platform === 'darwin' && process.arch === 'arm64' && existsSync(`${nativeRoot}/lib/libkhaiii.dylib`) ? false
  : `native Khaiii release not available on ${process.platform}/${process.arch} at ${nativeRoot} (run scripts/factory/fetch-khaiii-native.mjs on macOS arm64); native real-binary evidence not produced here`;

async function realSmoke(runtime) {
  const analyze = createKhaiiiAnalyzer({ runtime, docker, image, nativeRoot });
  const surfaces = ['먹었다', '아름다웠던', '망각했다', '행복한', '조용히', '서울에', 'ㅁㅁㅁ', '두 단어', '   '];
  const { metadata, results } = await analyze(surfaces.map((text) => ({ id: text, text })));
  assertPinnedKhaiii(metadata, runtime);
  assert.equal(metadata.runtime, runtime);
  const byId = Object.fromEntries(results.map((result) => [result.id, result]));
  const lemmas = (id) => byId[id].analyses[0].map((entry) => `${entry.lemma}/${entry.pos}`);
  assert.deepEqual(lemmas('먹었다'), ['먹다/verb']);
  assert.deepEqual(lemmas('아름다웠던'), ['아름답다/adjective']);
  assert.deepEqual(lemmas('망각했다'), ['망각하다/verb']);
  assert.deepEqual(lemmas('행복한'), ['행복하다/adjective']);
  assert.deepEqual(lemmas('조용히'), ['조용히/adverb']);
  assert.equal(byId['먹었다'].analyses.length, 1, 'best path only');
  for (const id of ['서울에', 'ㅁㅁㅁ', '두 단어', '   ']) assert.equal(byId[id].status, 'unsupported', id);
  assert.ok(results.every((result) => result.analyses.flat().every((entry) => !('derived_from' in entry) && !('derived_from_index' in entry))));
  // End to end through the shared policy: Khaiii alone never clears; invalid/missing input stays held.
  const result = await produce([FILLER, cand('먹다', 'verb', '먹었다')], [kiwi(fillerTable), createKhaiiiProvider({ analyze, runtime })]);
  assert.equal(rowOf(result, '먹다'), undefined);
  assert.deepEqual(unresolvedOf(result), [['먹었다', ['analysis_unsupported']]]);
  return results;
}

test('REAL pinned Khaiii v0.4 native macOS arm64 release smoke', { skip: nativeSkip }, () => realSmoke('native'));
test('REAL pinned Khaiii v0.4 docker container smoke', { skip: dockerSkip }, () => realSmoke('docker'));

test('native and docker runtimes yield identical analyses (when both real runtimes exist)', { skip: nativeSkip || dockerSkip }, async () => {
  const surfaces = ['먹었다', '아름다웠던', '망각했다', '행복한'];
  const run = (runtime) => createKhaiiiAnalyzer({ runtime, docker, image, nativeRoot })(surfaces.map((text) => ({ id: text, text })));
  assert.deepEqual((await run('native')).results, (await run('docker')).results);
});

test('a missing container runtime is an explicit failure, not silent output', async () => {
  await assert.rejects(() => createKhaiiiAnalyzer({ runtime: 'docker', docker: '/nonexistent/docker' })([{ id: 'a', text: '먹었다' }]));
});
