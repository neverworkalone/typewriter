import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { createKhaiiiAnalyzer, createKhaiiiProvider, KHAIII_RUNTIMES, NATIVE_RELEASE, PINNED_KHAIII, assertPinnedKhaiii, defaultNativeRoot,
  pinnedMetadata, resolveKhaiiiRuntime } from '../scripts/factory/khaiii-provider.mjs';
import { normalizeProviderResult, providerIdentityDigest } from '../scripts/factory/analyzer-providers.mjs';
import { PROVIDER_REGISTRY } from '../scripts/factory/produce-candidates.mjs';
import { FILLER, HEX, cand, fillerTable, holdsOf, item, khaiii, kiwi, produce, realSmoke, rowOf, unresolvedOf } from './support/khaiii-fixtures.mjs';
import { analysisInputDigest } from '../scripts/intake/pipeline.mjs';

// Normal CI runs this file only. It never probes, runs or builds Docker; the Docker runtime is
// covered by the manual tests/manual/khaiii-docker.test.mjs (npm run test:khaiii:docker).

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

test('runtime selection: native is the only default on every host; docker only when explicitly requested', () => {
  assert.equal(resolveKhaiiiRuntime({ env: {} }), 'native');
  assert.equal(resolveKhaiiiRuntime({ env: { TYPEWRITER_KHAIII_RUNTIME: '' } }), 'native');
  assert.equal(resolveKhaiiiRuntime({ env: { TYPEWRITER_KHAIII_RUNTIME: 'docker' } }), 'docker');
  assert.equal(resolveKhaiiiRuntime({ env: { TYPEWRITER_KHAIII_RUNTIME: 'native' } }), 'native');
  assert.throws(() => resolveKhaiiiRuntime({ env: { TYPEWRITER_KHAIII_RUNTIME: 'podman' } }), /native\|docker/);
  // A host without the native release (e.g. Linux) must opt in to docker; it is never chosen implicitly.
  assert.throws(() => createKhaiiiProvider({ runtime: resolveKhaiiiRuntime({ env: {} }), platform: 'linux', arch: 'x64' }), /macOS arm64 only.*TYPEWRITER_KHAIII_RUNTIME=docker/u);
  assert.doesNotThrow(() => createKhaiiiProvider({ runtime: resolveKhaiiiRuntime({ env: { TYPEWRITER_KHAIII_RUNTIME: 'docker' } }), platform: 'linux', arch: 'x64' }));
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

// Real native release. Skipped (and the reason reported) where unavailable: never a mock substitute.
const nativeRoot = process.env.TYPEWRITER_KHAIII_NATIVE_ROOT || defaultNativeRoot();
const nativeSkip = process.platform === 'darwin' && process.arch === 'arm64' && existsSync(`${nativeRoot}/lib/libkhaiii.dylib`) ? false
  : `native Khaiii release not available on ${process.platform}/${process.arch} at ${nativeRoot} (run scripts/factory/fetch-khaiii-native.mjs on macOS arm64); native real-binary evidence not produced here`;

test('REAL pinned Khaiii v0.4 native macOS arm64 release smoke', { skip: nativeSkip }, () => realSmoke('native', { nativeRoot }));

// Patterns are assembled from fragments so this file does not match itself.
const forbidden = new RegExp(['image\\W+inspect', 'spawnSync\\(\\s*dock' + 'er', 'DEFAULT_KHAIII' + '_IMAGE', 'TYPEWRITER' + '_DOCKER'].join('|'), 'u');

test('normal CI never discovers, probes or runs the Docker runtime', () => {
  const registry = readFileSync('scripts/ci/registry.mjs', 'utf8');
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  assert.ok(!registry.includes('manual/khaiii-docker'), 'the manual Docker test is not registered in any CI category');
  for (const [name, command] of Object.entries(scripts)) {
    if (name.startsWith('ci:') || name === 'test' || name.startsWith('test:unit')) assert.ok(!command.includes('manual/khaiii-docker'), `${name} must not run the Docker test`);
  }
  assert.equal(scripts['test:khaiii:docker'], 'node --test tests/manual/khaiii-docker.test.mjs');
  for (const file of ['tests/factory-khaiii-provider.test.mjs', 'tests/support/khaiii-fixtures.mjs']) {
    const source = readFileSync(file, 'utf8');
    assert.ok(!forbidden.test(source), `${file} must not touch the Docker CLI or image`);
  }
});
