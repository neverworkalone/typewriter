import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTypewriterCachePaths } from '../typewriter-cache.mjs';

// Optional third Provider: MeCab-ko (PyPI `mecab-ko` 1.0.2 + `mecab-ko-dic` 1.0.0), issue #281.
// Only the single best path (`Tagger.parse`) is used. On the real dictionary `parse` and
// `parseNBest(1)` choose different equal-cost paths for the same input (걸어: 걷다 vs 걸다), so no
// dependable N-best or score exists: it declares `n_best: false, derivation: false` and Stage 1
// never lets it settle a candidate alone (provider-resolution-v1). The module is never constructed
// unless `mecab` appears in `--providers`. A missing/corrupt runtime is a clear error; there is no
// fallback to another runtime.

export const MECAB_SERVICE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mecab_service.py');
export const MECAB_REQUIREMENTS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mecab-requirements.txt');
export const MECAB_BATCH_SIZE = 200;
export const DEFAULT_MECAB_CACHE = path.join(resolveTypewriterCachePaths().root, 'mecab');
export const defaultMecabPython = (cache = DEFAULT_MECAB_CACHE) => path.join(cache, 'venv', 'bin', 'python');

// Identity of the wrapper, library and dictionary, as observed from a verified install.
export const PINNED_MECAB = Object.freeze({
  provider: 'mecab',
  service_version: '1',
  proposal_contract: 'derivation-root-v1',
  top_n: 1,
  python_version: '3.11',
  mecab_ko_version: '1.0.2',
  mecab_library_version: '0.996/ko-0.9.2',
  wrapper_wheel_sha256: 'fbe31456cceac890cecbc100ff981260c1fa1bd971687f32e45f8620c3a0be09',
  wrapper_extension_digest: '718c3c089eb06d7cd1963a5cf22345ac23b509dbe720628908e8659ad0c6b754',
  library_digest: '4e993d7fccb1ba737cce75a4d8fe0d16da09c5ce8b440aabf0b0d18dd1bcb535',
  dictionary_package: 'mecab-ko-dic',
  dictionary_package_version: '1.0.0',
  dictionary_sdist_sha256: '3ba22858736e02e8a0e92f2a7f099528c733ae47701b29d12c75e982a85d1f11',
  // The package ships an empty `version` file: the dictionary release (e.g. 2.1.1-20180720) is NOT
  // declared by it and is deliberately not asserted here. The content digest is the identity.
  dictionary_declared_version: 'undeclared',
  dictionary_digest: 'd65a8a68459dc8b070a6d5604ed9c5d2b5958c9ad6142ed93201a02d17d2f5da',
  dictionary_file_loaded: 'sys.dic',
  dictionary_charset: 'UTF-8',
  dictionary_lexicon_size: 811795,
  user_dictionary: 'none',
});
// Pins the service reports itself; wheel/sdist hashes are install-time pins (mecab-requirements.txt).
const REPORTED = new Set(['provider', 'service_version', 'proposal_contract', 'top_n', 'python_version', 'mecab_ko_version', 'mecab_library_version',
  'wrapper_extension_digest', 'library_digest', 'dictionary_package', 'dictionary_package_version', 'dictionary_declared_version', 'dictionary_digest',
  'dictionary_file_loaded', 'dictionary_charset', 'dictionary_lexicon_size', 'user_dictionary']);

export const pinnedMetadata = () => Object.fromEntries(Object.entries(PINNED_MECAB).filter(([key]) => REPORTED.has(key)));

export function assertPinnedMecab(metadata) {
  if (metadata === null || typeof metadata !== 'object') throw new Error('MeCab metadata is required to verify the pinned runtime and dictionary');
  for (const [key, expected] of Object.entries(pinnedMetadata())) {
    if (metadata[key] !== expected) throw new Error(`MeCab ${key} ${metadata[key] ?? 'missing'} does not match pinned ${expected}`);
  }
}

function runBatch(python, requests) {
  return new Promise((resolve, reject) => {
    if (path.isAbsolute(python) && !existsSync(python)) {
      reject(new Error(`MeCab-ko runtime not found at ${python}; run: node scripts/factory/setup-mecab.mjs (or set TYPEWRITER_MECAB_PYTHON)`));
      return;
    }
    const child = spawn(python, [MECAB_SERVICE_PATH], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new Error(`MeCab runtime could not start: ${error.message}`)));
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* explicit failure below */ }
      if (code !== 0 || !parsed?.results) reject(new Error(`MeCab analysis failed (exit ${code}): ${parsed?.error ?? stderr.slice(0, 300)}`));
      else resolve(parsed);
    });
    child.stdin.end(JSON.stringify({ requests }));
  });
}

// One host process per bounded batch inside the pinned venv; no network is used.
export function createMecabAnalyzer({ python = process.env.TYPEWRITER_MECAB_PYTHON || defaultMecabPython(), batchSize = MECAB_BATCH_SIZE,
  platform = process.platform, arch = process.arch } = {}) {
  if (!(platform === 'darwin' && arch === 'arm64')) {
    throw new Error(`MeCab-ko runtime is pinned and verified for macOS arm64 only (this host: ${platform}/${arch})`);
  }
  return async function analyze(requests) {
    const results = [];
    let metadata = null;
    for (let offset = 0; offset < requests.length; offset += batchSize) {
      const response = await runBatch(python, requests.slice(offset, offset + batchSize));
      metadata ??= response.metadata;
      results.push(...response.results);
    }
    return { metadata, results };
  };
}

// `analyze` is injectable so tests need no runtime.
export function createMecabProvider({ analyze, ...options } = {}) {
  return {
    id: 'mecab',
    identity: Object.freeze({
      provider_id: 'mecab', implementation: 'mecab-ko', version: PINNED_MECAB.mecab_ko_version,
      model: `dictionary:${PINNED_MECAB.dictionary_digest}`,
      config: Object.freeze({ service_version: PINNED_MECAB.service_version, proposal_contract: PINNED_MECAB.proposal_contract,
        mecab_library_version: PINNED_MECAB.mecab_library_version, python_version: PINNED_MECAB.python_version,
        wrapper_wheel_sha256: PINNED_MECAB.wrapper_wheel_sha256, wrapper_extension_digest: PINNED_MECAB.wrapper_extension_digest,
        library_digest: PINNED_MECAB.library_digest, dictionary_package: `${PINNED_MECAB.dictionary_package}@${PINNED_MECAB.dictionary_package_version}`,
        dictionary_sdist_sha256: PINNED_MECAB.dictionary_sdist_sha256, dictionary_declared_version: PINNED_MECAB.dictionary_declared_version,
        user_dictionary: PINNED_MECAB.user_dictionary, analysis: 'parse-best-path' }),
    }),
    capabilities: Object.freeze({ n_best: false, derivation: false }),
    analyze: analyze ?? createMecabAnalyzer(options),
    assertMetadata: assertPinnedMecab,
  };
}
