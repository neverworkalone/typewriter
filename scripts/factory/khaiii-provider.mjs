import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Optional second Provider: Kakao Khaiii v0.4 (Apache-2.0), issue #273. Khaiii reports one best
// path and no score, so it declares `n_best: false, derivation: false` and Stage 1 never lets it
// settle a candidate alone (provider-resolution-v1). The module is never constructed unless
// `khaiii` appears in `--providers`.
//
// Two interchangeable runtimes feed the same `khaiii_service.py` (one normalization, one provider
// interface), selected by TYPEWRITER_KHAIII_RUNTIME=native|docker:
//   native — the verified `genonfire/khaiii` v0.4 macOS arm64 GitHub Release (default on darwin/arm64;
//            fetched and checked by scripts/factory/fetch-khaiii-native.mjs);
//   docker — the pinned Linux container built from docker/khaiii/Dockerfile (default elsewhere).
// A failing runtime is a clear error; it never falls back to the other one silently.

export const KHAIII_SERVICE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'khaiii_service.py');
export const KHAIII_BATCH_SIZE = 200;
export const KHAIII_RUNTIMES = Object.freeze(['native', 'docker']);
export const DEFAULT_KHAIII_IMAGE = 'typewriter-khaiii:v0.4';

// Pins shared by both runtimes: same upstream revision, same compiled model bundle (digest verified
// identical on the native and container builds).
export const PINNED_KHAIII = Object.freeze({
  khaiii_version: '0.4',
  khaiii_source_tag: 'v0.4',
  khaiii_source_sha: 'fa5fbd10aeddfe97cd7aa87faee39628e5e9c18a',
  resource_digest: '7b9838bb286ff0f824fee4b35eaed383fbcb4adeea6e2d8c62bf6beb926ec3bb',
  service_version: '1',
  proposal_contract: 'derivation-root-v1',
  provider: 'khaiii',
  top_n: 1,
});

// Verified GitHub Release consumed by the native runtime (never rebuilt inside Typewriter).
export const NATIVE_RELEASE = Object.freeze({
  repo: 'genonfire/khaiii',
  tag: 'v0.4',
  asset: 'khaiii-0.4-macos-arm64.tar.gz',
  url: 'https://github.com/genonfire/khaiii/releases/download/v0.4/khaiii-0.4-macos-arm64.tar.gz',
  archive_sha256: 'd3f9e5786892bd83b80a8a8602a10b2c56f6f00168a6b7e9d7d809fdc99b08e6',
  fork_commit: '33f786926541b9809561c803c1c8dfc50edda135',
  library_digest: '901ebf144a638683bd441273c6f36c6285e105d05e8118fd36eef3117c213429',
  provenance_digest: '963e45abf17d44917df2f3b3b845ff465e87e3c764402ee53240ae8db6107f65',
  directory: 'khaiii-0.4-macos-arm64',
});
export const DEFAULT_NATIVE_CACHE = path.join(os.homedir(), '.cache', 'typewriter', 'khaiii');
export const defaultNativeRoot = (cache = DEFAULT_NATIVE_CACHE) => path.join(cache, NATIVE_RELEASE.tag, NATIVE_RELEASE.directory);

const RUNTIME_PINS = Object.freeze({
  native: Object.freeze({ runtime: 'native', library_digest: NATIVE_RELEASE.library_digest, release_fork_commit: NATIVE_RELEASE.fork_commit,
    release_provenance_digest: NATIVE_RELEASE.provenance_digest }),
  docker: Object.freeze({ runtime: 'docker', library_digest: 'container', release_fork_commit: 'container', release_provenance_digest: 'container' }),
});

// Metadata a correct run of `runtime` must report.
export const pinnedMetadata = (runtime) => ({ ...PINNED_KHAIII, ...RUNTIME_PINS[runtime] });

export function resolveKhaiiiRuntime({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const requested = env.TYPEWRITER_KHAIII_RUNTIME;
  if (requested === undefined || requested === '') return platform === 'darwin' && arch === 'arm64' ? 'native' : 'docker';
  if (!KHAIII_RUNTIMES.includes(requested)) throw new Error(`TYPEWRITER_KHAIII_RUNTIME must be one of ${KHAIII_RUNTIMES.join('|')}, got ${requested}`);
  return requested;
}

export function assertPinnedKhaiii(metadata, runtime = 'native') {
  if (!RUNTIME_PINS[runtime]) throw new Error(`unknown Khaiii runtime ${runtime}`);
  if (metadata === null || typeof metadata !== 'object') throw new Error('Khaiii metadata is required to verify the pinned build');
  for (const [key, expected] of Object.entries(pinnedMetadata(runtime))) {
    if (metadata[key] !== expected) throw new Error(`Khaiii ${key} ${metadata[key] ?? 'missing'} does not match pinned ${expected} (${runtime} runtime)`);
  }
}

function collect(child, label, resolve, reject, requests) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => reject(new Error(`Khaiii ${label} runtime could not start: ${error.message}`)));
  child.on('close', (code) => {
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* explicit failure below */ }
    if (code !== 0 || !parsed?.results) reject(new Error(`Khaiii ${label} analysis failed (exit ${code}): ${parsed?.error ?? stderr.slice(0, 300)}`));
    else resolve(parsed);
  });
  child.stdin.end(JSON.stringify({ requests }));
}

// One offline container per bounded batch: no network, read-only service script.
const dockerBatch = (docker, image) => (requests) => new Promise((resolve, reject) => {
  const args = ['run', '--rm', '-i', '--network', 'none', '-v', `${KHAIII_SERVICE_PATH}:/svc/khaiii_service.py:ro`, image, 'python3', '/svc/khaiii_service.py'];
  collect(spawn(docker, args, { stdio: ['pipe', 'pipe', 'pipe'] }), 'docker', resolve, reject, requests);
});

// One host process per bounded batch against the extracted release; no network is used.
const nativeBatch = (python, root) => (requests) => new Promise((resolve, reject) => {
  if (!existsSync(path.join(root, 'lib', 'libkhaiii.dylib'))) {
    reject(new Error(`Khaiii native release not found at ${root}; run: node scripts/factory/fetch-khaiii-native.mjs (or set TYPEWRITER_KHAIII_NATIVE_ROOT). Not falling back to docker.`));
    return;
  }
  collect(spawn(python, [KHAIII_SERVICE_PATH], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, KHAIII_NATIVE_ROOT: root } }), 'native', resolve, reject, requests);
});

export function createKhaiiiAnalyzer({ runtime = resolveKhaiiiRuntime(), docker = process.env.TYPEWRITER_DOCKER || 'docker',
  image = process.env.TYPEWRITER_KHAIII_IMAGE || DEFAULT_KHAIII_IMAGE, python = process.env.TYPEWRITER_PYTHON || 'python3',
  nativeRoot = process.env.TYPEWRITER_KHAIII_NATIVE_ROOT || defaultNativeRoot(), batchSize = KHAIII_BATCH_SIZE, platform = process.platform, arch = process.arch } = {}) {
  if (!KHAIII_RUNTIMES.includes(runtime)) throw new Error(`unknown Khaiii runtime ${runtime}`);
  if (runtime === 'native' && !(platform === 'darwin' && arch === 'arm64')) {
    throw new Error(`Khaiii native runtime supports macOS arm64 only (this host: ${platform}/${arch}); set TYPEWRITER_KHAIII_RUNTIME=docker explicitly`);
  }
  const runBatch = runtime === 'native' ? nativeBatch(python, nativeRoot) : dockerBatch(docker, image);
  return async function analyze(requests) {
    const results = [];
    let metadata = null;
    for (let offset = 0; offset < requests.length; offset += batchSize) {
      const response = await runBatch(requests.slice(offset, offset + batchSize));
      metadata ??= response.metadata;
      results.push(...response.results);
    }
    return { metadata, results };
  };
}

// Runtime and the exact binary/resource identification are part of the identity (hence of the
// manifest analyzer digest), so switching runtime or binary can never share a digest.
const binaryIdentity = (runtime) => (runtime === 'native'
  ? { release: `${NATIVE_RELEASE.repo}@${NATIVE_RELEASE.tag}`, archive_sha256: NATIVE_RELEASE.archive_sha256, fork_commit: NATIVE_RELEASE.fork_commit,
    library_digest: NATIVE_RELEASE.library_digest, provenance_digest: NATIVE_RELEASE.provenance_digest }
  : { toolchain: 'ubuntu:20.04 gcc-7 torch-1.13.1', isolation: 'container --network none' });

// `analyze` is injectable so tests need no runtime.
export function createKhaiiiProvider({ analyze, runtime = resolveKhaiiiRuntime(), ...options } = {}) {
  if (!KHAIII_RUNTIMES.includes(runtime)) throw new Error(`unknown Khaiii runtime ${runtime}`);
  return {
    id: 'khaiii',
    identity: Object.freeze({
      provider_id: 'khaiii', implementation: 'khaiii', version: PINNED_KHAIII.khaiii_version, model: `resource:${PINNED_KHAIII.resource_digest}`,
      config: Object.freeze({ runtime, source_sha: PINNED_KHAIII.khaiii_source_sha, service_version: PINNED_KHAIII.service_version,
        proposal_contract: PINNED_KHAIII.proposal_contract, ...binaryIdentity(runtime) }),
    }),
    capabilities: Object.freeze({ n_best: false, derivation: false }),
    analyze: analyze ?? createKhaiiiAnalyzer({ runtime, ...options }),
    assertMetadata: (metadata) => assertPinnedKhaiii(metadata, runtime),
  };
}
