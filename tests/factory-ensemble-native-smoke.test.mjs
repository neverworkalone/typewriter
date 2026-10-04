import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createKiwiProvider } from '../scripts/factory/analyzer-providers.mjs';
import { validateCandidateBatch } from '../scripts/factory/contract.mjs';
import { CATEGORIES, ENSEMBLE_POLICY } from '../scripts/factory/ensemble-resolver.mjs';
import { createKhaiiiProvider, defaultNativeRoot } from '../scripts/factory/khaiii-provider.mjs';
import { createMecabProvider, defaultMecabPython } from '../scripts/factory/mecab-provider.mjs';
import { produceCandidateBatch } from '../scripts/factory/stage1.mjs';
import { HEX, cand, hit } from './support/khaiii-fixtures.mjs';

// REAL three-native-Provider smoke (issue #285): the pinned Kiwi, Khaiii v0.4 native release and
// MeCab-ko run on the same surfaces through the ensemble policy. Skipped with the reason where any
// runtime is missing — never replaced by a mock, and never claimed as evidence then. It proves the
// native providers are genuinely invoked and the batch validates; it does NOT claim analyzer
// agreement is correct (accuracy is `not_established`).
const kiwiPython = process.env.TYPEWRITER_PYTHON || (existsSync('data/reference/venv-kiwi024/bin/python') ? path.resolve('data/reference/venv-kiwi024/bin/python') : null);
const khaiiiRoot = process.env.TYPEWRITER_KHAIII_NATIVE_ROOT || defaultNativeRoot();
const mecabPython = process.env.TYPEWRITER_MECAB_PYTHON || defaultMecabPython();
const missing = [
  process.platform === 'darwin' && process.arch === 'arm64' ? null : `host is ${process.platform}/${process.arch}, not macOS arm64`,
  kiwiPython ? null : 'no pinned Kiwi python (set TYPEWRITER_PYTHON)',
  existsSync(path.join(khaiiiRoot, 'lib/libkhaiii.dylib')) ? null : `native Khaiii release missing at ${khaiiiRoot}`,
  existsSync(mecabPython) ? null : `MeCab-ko venv missing at ${mecabPython}`,
].filter(Boolean);
const skip = missing.length ? `three-native-provider smoke unavailable: ${missing.join('; ')}; no real-runtime ensemble evidence produced here` : false;

test('REAL Kiwi + Khaiii native + MeCab-ko ensemble run on the same surfaces validates and records all three', { skip }, async () => {
  const providers = [createKiwiProvider({ python: kiwiPython }), createKhaiiiProvider({ runtime: 'native' }), createMecabProvider()];
  const forms = [['먹다', 'verb', '먹었다'], ['아름답다', 'adjective', '아름다웠던'], ['걷다', 'verb', '걸어'], ['가다', 'verb', '가는'], ['짠하다', 'adjective', '짠한'], ['서울', 'noun', '서울에']];
  const result = await produceCandidateBatch({
    evidence: {
      contract_version: 'm9-corpus-candidate-evidence-v1',
      index: { input_manifest_sha256: HEX, logical_rows_sha256: 'b'.repeat(64) },
      extractor: { extractor_version: 'smoke', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0' },
      candidates: forms.map(([lemma, pos, surface], index) => ({
        proposed_lemma: lemma, proposed_pos: pos, coverage_status: 'uncovered', ambiguity_status: 'clear',
        observed_surface_forms: [{ surface }], evidence: { representative_hits: [hit(`d${index}`, surface)] },
      })),
    },
    providers, policy: ENSEMBLE_POLICY, canonicalEntries: [], canonicalDigest: HEX, batchId: 'C000002', taskId: 'T000001',
  });
  assert.deepEqual(result.summary.providerOrder, ['kiwi', 'khaiii', 'mecab']);
  for (const id of ['kiwi', 'khaiii', 'mecab']) assert.equal(result.summary.providerAttempts[id].surfaces, forms.length, `${id} analyzed every surface`);
  assert.deepEqual(validateCandidateBatch({ manifest: result.manifest, candidatesText: result.candidatesText }), []);
  const categories = result.ensemble.decisions.map((decision) => decision.category);
  assert.ok(categories.every((category) => CATEGORIES.includes(category)));
  assert.equal(result.summary.ensemble.verified_correct, 'not_established');
  // Diagnostic only (text-free): the real category distribution for these surfaces.
  console.log(`# real three-provider categories: ${JSON.stringify(Object.fromEntries(result.ensemble.decisions.map((decision, index) => [forms[index][2], decision.category])))}`);
  console.log(`# real provider calls (ms): ${JSON.stringify(Object.fromEntries(Object.entries(result.summary.providerAttempts).map(([id, call]) => [id, call.ms])))}`);
});
