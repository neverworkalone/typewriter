import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Optional second Provider: official Kakao Khaiii v0.4 (Apache-2.0), issue #273. It exists only as a
// pinned container (docker/khaiii/Dockerfile); nothing is installed or imported on the host, and
// the module is never constructed unless `khaiii` appears in `--providers`. Khaiii reports one best
// path and no score, so it declares `n_best: false, derivation: false` and Stage 1 never lets it
// settle a candidate alone (provider-resolution-v1).

export const KHAIII_SERVICE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'khaiii_service.py');
export const KHAIII_BATCH_SIZE = 200;
export const DEFAULT_KHAIII_IMAGE = 'typewriter-khaiii:v0.4';
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

export function assertPinnedKhaiii(metadata) {
  if (metadata === null || typeof metadata !== 'object') throw new Error('Khaiii metadata is required to verify the pinned build');
  for (const [key, expected] of Object.entries(PINNED_KHAIII)) {
    if (metadata[key] !== expected) throw new Error(`Khaiii ${key} ${metadata[key] ?? 'missing'} does not match pinned ${expected}`);
  }
}

// One offline container per bounded batch: no network, read-only service script.
function runBatch(docker, image, requests) {
  const args = ['run', '--rm', '-i', '--network', 'none', '-v', `${KHAIII_SERVICE_PATH}:/svc/khaiii_service.py:ro`, image, 'python3', '/svc/khaiii_service.py'];
  return new Promise((resolve, reject) => {
    const child = spawn(docker, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* explicit failure below */ }
      if (code !== 0 || !parsed?.results) reject(new Error(`Khaiii analysis failed (exit ${code}): ${parsed?.error ?? stderr.slice(0, 300)}`));
      else resolve(parsed);
    });
    child.stdin.end(JSON.stringify({ requests }));
  });
}

export function createKhaiiiAnalyzer({ docker = process.env.TYPEWRITER_DOCKER || 'docker', image = process.env.TYPEWRITER_KHAIII_IMAGE || DEFAULT_KHAIII_IMAGE, batchSize = KHAIII_BATCH_SIZE } = {}) {
  return async function analyze(requests) {
    const results = [];
    let metadata = null;
    for (let offset = 0; offset < requests.length; offset += batchSize) {
      const response = await runBatch(docker, image, requests.slice(offset, offset + batchSize));
      metadata ??= response.metadata;
      results.push(...response.results);
    }
    return { metadata, results };
  };
}

// `analyze` is injectable so tests need no container.
export function createKhaiiiProvider({ analyze, docker, image } = {}) {
  return {
    id: 'khaiii',
    identity: Object.freeze({
      provider_id: 'khaiii', implementation: 'khaiii', version: PINNED_KHAIII.khaiii_version, model: `resource:${PINNED_KHAIII.resource_digest}`,
      config: Object.freeze({ source_sha: PINNED_KHAIII.khaiii_source_sha, toolchain: 'ubuntu:20.04 gcc-7 torch-1.13.1', runtime: 'container --network none',
        service_version: PINNED_KHAIII.service_version, proposal_contract: PINNED_KHAIII.proposal_contract }),
    }),
    capabilities: Object.freeze({ n_best: false, derivation: false }),
    analyze: analyze ?? createKhaiiiAnalyzer({ docker, image }),
    assertMetadata: assertPinnedKhaiii,
  };
}
