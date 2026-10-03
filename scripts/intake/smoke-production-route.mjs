// Local, bounded, no-write smoke of the REAL production route (issue #251).
// Needs the pinned kiwipiepy 0.24.0 environment (TYPEWRITER_PYTHON) and the
// ignored local analysis directory; it is intentionally not part of CI.
//
//   node scripts/intake/smoke-production-route.mjs \
//     --batch-id=issue-223-m9-e-corpus-batch-15-20261003 \
//     --analysis-directory=data/reference/production/issue-247/corpus-batch-15
//
// The repository is copied to a temporary directory with the batch's own
// artifacts removed (pre-batch state). There, real Kiwi builds the hand-off, the
// review input is bound to it, and the real `build-issue-223-corpus-batch.mjs
// --intake-handoff` runs. The outputs are compared with the tracked batch
// artifacts. The working tree is never written.
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORPUS_ADAPTER_ID } from './adapters/corpus-adapter.mjs';
import { syntheticAdapter } from './adapters/synthetic-adapter.mjs';
import { createKiwiAnalyzer } from './kiwi-client.mjs';
import { assertHandoffMatchesFreshAnalysis, buildProductionHandoff, verifyProductionHandoff } from './production-handoff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const match = /^--([^=]+)=(.*)$/u.exec(arg);
  if (!match) throw new Error(`invalid argument ${arg}; use --key=value`);
  return [match[1], match[2]];
}));
const batchId = args['batch-id'];
const analysis = args['analysis-directory'];
if (!batchId || !analysis) throw new Error('usage: smoke-production-route.mjs --batch-id=... --analysis-directory=...');
const stem = batchId.replace(/-20[0-9]{6}$/u, '');

const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'typewriter-prod-smoke-')));
try {
  for (const entry of ['scripts', 'config', 'schema', 'package.json']) await cp(path.join(ROOT, entry), path.join(temp, entry), { recursive: true });
  await symlink(path.join(ROOT, 'node_modules'), path.join(temp, 'node_modules'));
  for (const directory of ['canonical', 'batches', 'inventory', 'validation']) {
    await cp(path.join(ROOT, 'data', directory), path.join(temp, 'data', directory), { recursive: true });
  }
  await symlink(path.join(ROOT, 'data/reference'), path.join(temp, 'data/reference'));
  const tracked = {
    review: await readFile(path.join(ROOT, `data/batches/${stem}-candidate-review.json`)),
    semantic: JSON.parse(await readFile(path.join(ROOT, `data/batches/${stem}-semantic-decisions.json`), 'utf8')),
    input: JSON.parse(await readFile(path.join(ROOT, `data/batches/${stem}-semantic-review-input.json`), 'utf8')),
    canonical: await readFile(path.join(ROOT, `data/canonical/${stem}.jsonl`)),
  };
  for (const name of (await readdir(path.join(temp, 'data/batches'))).filter((file) => file.startsWith(`${stem}-`))) await rm(path.join(temp, 'data/batches', name));
  await rm(path.join(temp, `data/canonical/${stem}.jsonl`));

  const run = (script, extra) => execFileSync('node', [path.join(temp, script), ...extra], { cwd: temp, encoding: 'utf8', env: process.env });
  const handoffPath = path.join(temp, 'handoff.json');
  const inputPath = path.join(temp, 'review-input.json');
  const authored = path.join(analysis, 'authored-decisions.json');
  console.log(run('scripts/intake/production-handoff-cli.mjs', ['build', `--batch-id=${batchId}`, `--analysis-directory=${analysis}`, `--out=${handoffPath}`]));
  // The tracked self-check already cites the contexts it checked for each admitted candidate;
  // for this equivalence smoke those citations stand in for explicit resolutions of reviewable holds.
  const handoff = JSON.parse(await readFile(handoffPath, 'utf8'));
  const resolutions = {};
  for (const review of tracked.input.reviews) {
    const entry = handoff.entries.find((item) => item.input === review.lemma);
    if (entry?.decision === 'hold') resolutions[review.lemma] = { checked_hit_indices: review.checked_hit_indices, rationale: review.semantic_rationale };
  }
  await writeFile(inputPath, `${JSON.stringify({ ...tracked.input, intake_handoff: { resolutions } }, null, 2)}\n`);
  console.log(run('scripts/intake/production-handoff-cli.mjs', ['bind', `--handoff=${handoffPath}`, `--review-input=${inputPath}`, `--analysis-directory=${analysis}`, `--authored-decisions=${authored}`]));
  const built = run('scripts/batch/build-issue-223-corpus-batch.mjs', [`--batch-id=${batchId}`, `--analysis-directory=${analysis}`, `--authored-decisions=${authored}`, `--semantic-reviews=${inputPath}`, `--intake-handoff=${handoffPath}`]);
  const summary = JSON.parse(built);
  const out = (relative) => readFile(path.join(temp, relative));
  const comparison = {
    candidate_review_identical: Buffer.compare(await out(`data/batches/${stem}-candidate-review.json`), tracked.review) === 0,
    canonical_import_identical: Buffer.compare(await out(`data/canonical/${stem}.jsonl`), tracked.canonical) === 0,
    semantic_decisions_identical: JSON.stringify(JSON.parse(await out(`data/batches/${stem}-semantic-decisions.json`)).decisions) === JSON.stringify(tracked.semantic.decisions),
    intake_handoff_written: (await readdir(path.join(temp, 'data/batches'))).includes(`${stem}-intake-handoff.json`),
  };
  console.log(JSON.stringify({ builder: { candidates: summary.candidate_count, imported: summary.canonical_import_count }, comparison }, null, 2));

  // Corpus-disabled synthetic adapter through the same hand-off contract and fresh-analysis authentication.
  const synthetic = syntheticAdapter(['푸르다', '덥다', '걷다', '돕다', '가볍다', '시원하다', '바람', '눈', '없는말', '물결무늬']);
  const analyzer = createKiwiAnalyzer();
  const syntheticHandoff = await buildProductionHandoff({ batchId, rawCandidates: synthetic, analyzer, adapterId: 'synthetic-word-list' });
  verifyProductionHandoff(syntheticHandoff, { rawCandidates: synthetic, batchId });
  await assertHandoffMatchesFreshAnalysis(syntheticHandoff, { rawCandidates: synthetic, batchId, analyzer });
  const counts = {};
  for (const entry of syntheticHandoff.entries) {
    const key = entry.decision === 'hold' ? `hold:${entry.holds.join('+')}` : entry.decision;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  console.log(JSON.stringify({ synthetic_adapter: { corpus_adapter_loaded: false, adapter_id_is_corpus: syntheticHandoff.entries.some((e) => e.adapter_ids.includes(CORPUS_ADAPTER_ID)), counts } }, null, 2));
  if (!Object.values(comparison).every(Boolean)) process.exitCode = 1;
} finally {
  await rm(temp, { recursive: true, force: true });
}
