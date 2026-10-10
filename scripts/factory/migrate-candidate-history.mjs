import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCandidateBatch } from './contract.mjs';
import { validateFactoryRepository, loadBaseManifests } from './validate.mjs';
import { publishArtifacts, recoverArtifacts } from './artifact-transaction.mjs';
import { COMPACT_CONTRACT, TRASH_DIRECTORY, compactManifest, mergeUnresolved, trashIndex,
  restoreManifest, digest, chunkText, jsonText, validateTrashChunk } from './permanent-trash.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT_PATH = 'data/validation/stage1-history-migration.json';

// Deliberately manual, not a recurring CI check. Reads the complete legacy
// cohort once and proves lossless restoration before writing any repository data.
export async function planHistoryMigration(root) {
  const names = (await readdir(path.join(root, 'data/candidates'))).filter((name) => /^C\d{6}$/.test(name)).sort();
  const batches = [];
  for (const batch of names) {
    const directory = path.join(root, 'data/candidates', batch);
    const text = await readFile(path.join(directory, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(text);
    if (manifest.contract === COMPACT_CONTRACT) throw new Error('migration already applied; use the recorded report and Git baseline, do not migrate twice');
    const candidatesText = await readFile(path.join(directory, 'candidates.jsonl'), 'utf8');
    const errors = validateCandidateBatch({ manifest, candidatesText });
    if (errors.length) throw new Error(`${batch}: ${errors.join('\n')}`);
    batches.push({ manifest, text, candidatesText });
  }
  const { chunks, references } = mergeUnresolved(new Map(), batches.map((item) => item.manifest));
  const index = trashIndex(chunks);
  const files = new Map();
  for (const [name, rows] of chunks) {
    const text = chunkText(rows);
    const errors = validateTrashChunk(text);
    if (errors.length) throw new Error(`${name}: ${errors.join('\n')}`);
    files.set(`${TRASH_DIRECTORY}/${name}`, text);
  }
  const mapping = [];
  for (const { manifest, text, candidatesText } of batches) {
    const compact = compactManifest(manifest, references.get(manifest.batch_id));
    assert.equal(compact.manifest.unresolved_observations, undefined);
    assert.equal(compact.manifest.excluded_observations, undefined);
    assert.equal(compact.manifest.context_fallback?.decisions, undefined);
    const decisions = JSON.parse(compact.stage1DecisionsText);
    assert.equal(decisions.unresolved, undefined);
    assert.deepStrictEqual(restoreManifest(compact.manifest, { ...compact.history, ...decisions }, index), manifest);
    assert.equal(digest(candidatesText), compact.manifest.candidates_sha256);
    const errors = validateCandidateBatch({ manifest: compact.manifest, candidatesText, stage1DecisionsText: compact.stage1DecisionsText });
    if (errors.length) throw new Error(`${manifest.batch_id}: ${errors.join('\n')}`);
    const nextText = jsonText(compact.manifest);
    files.set(compact.manifest.stage1_decisions.path, compact.stage1DecisionsText);
    files.set(`data/candidates/${manifest.batch_id}/manifest.json`, nextText);
    mapping.push({ batch_id: manifest.batch_id, before_manifest_sha256: digest(text), after_manifest_sha256: digest(nextText),
      candidates_sha256: digest(candidatesText), stage1_decisions_sha256: digest(compact.stage1DecisionsText),
      unresolved_count: manifest.unresolved_observations.length, excluded_count: manifest.excluded_observations?.length ?? 0,
      context_decision_count: manifest.context_fallback?.decisions.length ?? 0 });
  }
  // Persisted downstream references bind candidates.jsonl, never its manifest.
  let reviewNames = [];
  try { reviewNames = await readdir(path.join(root, 'data/reviews')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const reviewBindings = [];
  for (const batch of reviewNames.filter((name) => /^C\d{6}$/.test(name)).sort()) {
    const text = await readFile(path.join(root, 'data/reviews', batch, 'manifest.json'), 'utf8');
    const review = JSON.parse(text);
    const candidate = mapping.find((item) => item.batch_id === batch);
    assert.equal(review.candidates_sha256, candidate?.candidates_sha256, `review binding ${batch}`);
    reviewBindings.push({ batch_id: batch, review_manifest_sha256: digest(text), candidates_sha256: review.candidates_sha256 });
  }
  const total = mapping.reduce((sum, item) => sum + item.unresolved_count, 0);
  const occurrences = [...index.values()].reduce((sum, { row }) => sum + row.variants.reduce((count, variant) => count + variant.occurrences.length, 0), 0);
  assert.equal(occurrences, total, 'all historical batch occurrences must survive');
  const report = { contract: 'lexical-factory-history-migration-v1', issue: 526,
    historical_audit: 'one-time-manual', batches: mapping, review_bindings: reviewBindings,
    totals: { batches: batches.length, unresolved_before: total, unique_observations: index.size,
      repeated_observations_merged: total - index.size, occurrences_preserved: occurrences,
      analysis_variants: [...index.values()].reduce((sum, { row }) => sum + row.variants.length, 0),
      chunks: chunks.size, excluded: mapping.reduce((sum, item) => sum + item.excluded_count, 0),
      context_decisions: mapping.reduce((sum, item) => sum + item.context_decision_count, 0) },
    proof: { exact_manifest_restoration: true, candidates_bytes_unchanged: true, review_bindings_unchanged: true } };
  files.set(REPORT_PATH, jsonText(report));
  return { files, report };
}

export async function migrateHistory({ root = ROOT, apply = false, baseRef = 'origin/master' } = {}) {
  const base = apply && baseRef !== 'none' ? loadBaseManifests(baseRef, root) : null;
  const journalDirectory = path.join(root, 'data/local/stage1-history-migration');
  if (apply) {
    const recovered = await recoverArtifacts({ root, journalDirectory, validate: () => validateFactoryRepository({ root, base }) });
    if (recovered) return JSON.parse(recovered.get(REPORT_PATH));
  }
  const plan = await planHistoryMigration(root);
  if (apply) {
    await publishArtifacts({ root, files: plan.files, journalDirectory,
      validate: () => validateFactoryRepository({ root, base }) });
  }
  return plan.report;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--apply', '--dry-run'].includes(arg)) || args.includes('--apply') && args.includes('--dry-run')) throw new Error('usage: node scripts/factory/migrate-candidate-history.mjs [--dry-run|--apply]');
  migrateHistory({ apply: args.includes('--apply') }).then((report) => console.log(JSON.stringify({ ...report.totals, applied: args.includes('--apply') }))).catch((error) => { console.error(error.stack); process.exitCode = 1; });
}
