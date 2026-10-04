// Manual end-to-end integration (not in CI): runs the REAL complete-canonical tracked validator
// (`validate-issue-223.mjs`) on temp trees: a normal B16 passes; hand-off removal/tampering,
// B16+ review-only, an unrelated-name canonical record and an unreviewed B16 import fail.
// Each validator run re-reads all canonical data (~45 s), so this stays out of ci:normal, which
// keeps a single shared complete-revision context (#253). Shared-function regressions that
// cover the same boundaries run in tests/intake-batch-boundary.test.mjs.
//
//   npm run intake:validator:integration      (needs python3; Kiwi is replaced by a stand-in)
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { B16, ROOT, STEM, buildB16, tree, validate } from './b16-tree.mjs';

const record = { id: 'w99999', record_type: 'entry', role: 'start', candidate_id: 'w99999', lemma: '시험삼음말', search_forms: ['시험삼음말'], senses: [{ id: 'w99999-s1', pos: 'noun', gloss: '시험으로 끼워 넣은 말.' }] };
const b05Review = await readFile(path.join(ROOT, 'data/batches/issue-223-m9-e-corpus-batch-05-candidate-review.json'), 'utf8');

async function withTree(fn) {
  const temp = await tree();
  try { return await fn(temp); } finally { await rm(temp, { recursive: true, force: true }); }
}

const results = {};
await withTree(async (temp) => {
  const build = await buildB16(temp);
  await build.withHandoff();
  results.normalB16 = await validate(temp);
  assert.equal(results.normalB16.ok, true, results.normalB16.message.slice(-800));
  const handoffPath = path.join(temp, `data/batches/${STEM}-intake-handoff.json`);
  const saved = await readFile(handoffPath);
  await rm(handoffPath);
  results.handoffRemoved = await validate(temp);
  assert.equal(results.handoffRemoved.ok, false);
  const tampered = JSON.parse(saved.toString('utf8'));
  tampered.entries[0].duplicate_count += 1;
  await writeFile(handoffPath, JSON.stringify(tampered));
  results.handoffTampered = await validate(temp);
  assert.equal(results.handoffTampered.ok, false);
});
await withTree(async (temp) => {
  const variant = JSON.parse(b05Review);
  variant.batch_id = B16;
  variant.canonical_import_status = 'owner-deferred-review-only';
  await writeFile(path.join(temp, `data/batches/${STEM}-candidate-review.json`), JSON.stringify(variant));
  results.reviewOnlyB16 = await validate(temp);
  assert.equal(results.reviewOnlyB16.ok, false);
  assert.match(results.reviewOnlyB16.message, /only B05/u);
});
await withTree(async (temp) => {
  await writeFile(path.join(temp, 'data/canonical/zz-anything.jsonl'), `${JSON.stringify(record)}\n`);
  results.injectedCanonical = await validate(temp);
  assert.equal(results.injectedCanonical.ok, false);
  assert.match(results.injectedCanonical.message, /CANONICAL_RECORD_OUTSIDE_REVIEWED_BATCH|outside validated corpus batches/u);
});
await withTree(async (temp) => {
  await writeFile(path.join(temp, `data/canonical/${STEM}.jsonl`), `${JSON.stringify(record)}\n`);
  results.orphanImport = await validate(temp);
  assert.equal(results.orphanImport.ok, false);
  assert.match(results.orphanImport.message, /canonical import without a reviewed/u);
});
console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([name, result]) => [name, result.ok ? 'pass' : 'rejected as expected'])), null, 2));
