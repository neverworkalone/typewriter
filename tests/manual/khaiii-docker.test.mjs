import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { DEFAULT_KHAIII_IMAGE, PINNED_KHAIII, createKhaiiiAnalyzer, defaultNativeRoot } from '../../scripts/factory/khaiii-provider.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { realSmoke } from '../support/khaiii-fixtures.mjs';

// MANUAL Docker-runtime tests (npm run test:khaiii:docker). Deliberately not in scripts/ci/registry.mjs:
// no CI category (ci:fast, ci:normal, ci:all) discovers, probes, builds or runs Docker.
const image = process.env.TYPEWRITER_KHAIII_IMAGE || DEFAULT_KHAIII_IMAGE;
const docker = process.env.TYPEWRITER_DOCKER || 'docker';
const probe = spawnSync(docker, ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' });
const dockerSkip = probe.status === 0 ? false : `Khaiii image ${image} not available (build: docker/khaiii/README.md); docker real-binary evidence not produced here`;
const nativeRoot = process.env.TYPEWRITER_KHAIII_NATIVE_ROOT || defaultNativeRoot();
const nativeSkip = process.platform === 'darwin' && process.arch === 'arm64' && existsSync(`${nativeRoot}/lib/libkhaiii.dylib`) ? false
  : `native Khaiii release not available at ${nativeRoot}`;

test('REAL pinned Khaiii v0.4 docker container smoke', { skip: dockerSkip }, () => realSmoke('docker', { docker, image }));

test('native and docker runtimes yield identical analyses (when both real runtimes exist)', { skip: nativeSkip || dockerSkip }, async () => {
  const surfaces = ['먹었다', '아름다웠던', '망각했다', '행복한'];
  const run = (runtime) => createKhaiiiAnalyzer({ runtime, docker, image, nativeRoot })(surfaces.map((text) => ({ id: text, text })));
  assert.deepEqual((await run('native')).results, (await run('docker')).results);
});

test('a missing container runtime is an explicit failure, not silent output', async () => {
  await assert.rejects(() => createKhaiiiAnalyzer({ runtime: 'docker', docker: '/nonexistent/docker' })([{ id: 'a', text: '먹었다' }]));
});

test('the Dockerfile builds exactly the pinned source and the README records the pinned resource digest', () => {
  const dockerfile = readFileSync('docker/khaiii/Dockerfile', 'utf8');
  assert.ok(dockerfile.includes(`KHAIII_SHA=${PINNED_KHAIII.khaiii_source_sha}`));
  assert.ok(dockerfile.includes('FROM ubuntu:20.04'));
  assert.ok(readFileSync('docker/khaiii/README.md', 'utf8').includes(PINNED_KHAIII.resource_digest));
});
