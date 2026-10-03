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
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORPUS_ADAPTER_ID } from './adapters/corpus-adapter.mjs';
import { SYNTHETIC_ADAPTER_ID } from './adapters/synthetic-adapter.mjs';

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
  for (const entry of ['scripts', 'config', 'schema', 'src', 'package.json']) await cp(path.join(ROOT, entry), path.join(temp, entry), { recursive: true });
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

  const run = (script, extra) => execFileSync('node', [path.join(temp, script), ...extra], { cwd: temp, encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const cli = (extra) => run('scripts/intake/production-handoff-cli.mjs', extra);
  const resetBatch = async () => {
    for (const name of (await readdir(path.join(temp, 'data/batches'))).filter((file) => file.startsWith(`${stem}-`))) await rm(path.join(temp, 'data/batches', name));
    await rm(path.join(temp, `data/canonical/${stem}.jsonl`), { force: true });
  };
  const validateTracked = () => {
    try {
      run('scripts/batch/validate-issue-223.mjs', ['--no-local-corpus-evidence', '--skip-issue-222', '--no-build']);
      return 'pass';
    } catch (error) {
      return `fail: ${String(error.stderr || error.message).split("\n").filter(Boolean).slice(0, 6).join(" | ")}`;
    }
  };
  const countsOf = (handoff) => {
    const counts = {};
    for (const entry of handoff.entries) {
      const key = entry.decision === 'hold' ? `hold:${entry.holds.join('+')}` : entry.decision;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  };

  async function route({ label, sourceAdapter, analysisDirectory, authoredPath, input }) {
    const handoffPath = path.join(temp, `${label}-handoff.json`);
    const inputPath = path.join(temp, `${label}-review-input.json`);
    cli(['build', `--batch-id=${batchId}`, `--analysis-directory=${analysisDirectory}`, `--out=${handoffPath}`, `--source-adapter=${sourceAdapter}`]);
    const handoff = JSON.parse(await readFile(handoffPath, 'utf8'));
    // The tracked self-check already cites the contexts it checked for each admitted candidate;
    // for this equivalence smoke those citations stand in for explicit resolutions of reviewable holds.
    const resolutions = {};
    for (const review of input.reviews) {
      const entry = handoff.entries.find((item) => item.input === review.lemma);
      if (entry?.decision === 'hold') resolutions[review.lemma] = { checked_hit_indices: review.checked_hit_indices, rationale: review.semantic_rationale };
    }
    await writeFile(inputPath, `${JSON.stringify({ ...input, intake_handoff: { resolutions } }, null, 2)}\n`);
    cli(['bind', `--handoff=${handoffPath}`, `--review-input=${inputPath}`, `--analysis-directory=${analysisDirectory}`, `--authored-decisions=${authoredPath}`]);
    const builderArgs = [`--batch-id=${batchId}`, `--analysis-directory=${analysisDirectory}`, `--authored-decisions=${authoredPath}`, `--semantic-reviews=${inputPath}`, `--intake-handoff=${handoffPath}`];
    // Tampered binding: the real builder refuses before writing anything.
    const tampered = JSON.parse(await readFile(inputPath, 'utf8'));
    const firstLemma = Object.keys(tampered.intake_handoff.bindings)[0];
    tampered.intake_handoff.bindings[firstLemma] = '0'.repeat(64);
    await writeFile(path.join(temp, `${label}-tampered.json`), JSON.stringify(tampered));
    let tamperedRejection = 'NOT REJECTED';
    try { run('scripts/batch/build-issue-223-corpus-batch.mjs', builderArgs.map((arg) => arg.replace(inputPath, path.join(temp, `${label}-tampered.json`)))); } catch (error) { tamperedRejection = String(error.stderr).split('\n')[0]; }
    const wroteAnything = (await readdir(path.join(temp, 'data/batches'))).some((file) => file.startsWith(`${stem}-`));
    const summary = JSON.parse(run('scripts/batch/build-issue-223-corpus-batch.mjs', builderArgs));
    return { handoff, summary, tamperedRejection, wroteBeforeAdmission: wroteAnything, trackedValidation: validateTracked() };
  }

  const corpus = await route({ label: 'corpus', sourceAdapter: CORPUS_ADAPTER_ID, analysisDirectory: analysis, authoredPath: path.join(analysis, 'authored-decisions.json'), input: tracked.input });
  const out = (relative) => readFile(path.join(temp, relative));
  const comparison = {
    candidate_review_identical: Buffer.compare(await out(`data/batches/${stem}-candidate-review.json`), tracked.review) === 0,
    canonical_import_identical: Buffer.compare(await out(`data/canonical/${stem}.jsonl`), tracked.canonical) === 0,
    semantic_decisions_identical: JSON.stringify(JSON.parse(await out(`data/batches/${stem}-semantic-decisions.json`)).decisions) === JSON.stringify(tracked.semantic.decisions),
    intake_handoff_written: (await readdir(path.join(temp, 'data/batches'))).includes(`${stem}-intake-handoff.json`),
  };
  console.log(JSON.stringify({ corpus_adapter: { counts: countsOf(corpus.handoff), imported: corpus.summary.canonical_import_count, tampered_binding_rejected_before_write: corpus.tamperedRejection, wrote_before_admission: corpus.wroteBeforeAdmission, tracked_validator: corpus.trackedValidation, comparison } }, null, 2));

  // Synthetic adapter: the hand-off reads only each candidate's word + POS (no corpus data, evidence or
  // adapter-level holds enter the contract) and drives the same real builder and tracked validation over the
  // same batch inputs. Outputs are compared with the tracked artifacts exactly as for the corpus adapter.
  await resetBatch();
  const synthetic = await route({ label: 'synthetic', sourceAdapter: SYNTHETIC_ADAPTER_ID, analysisDirectory: analysis, authoredPath: path.join(analysis, 'authored-decisions.json'), input: tracked.input });
  const syntheticComparison = {
    candidate_review_identical: Buffer.compare(await out(`data/batches/${stem}-candidate-review.json`), tracked.review) === 0,
    canonical_import_identical: Buffer.compare(await out(`data/canonical/${stem}.jsonl`), tracked.canonical) === 0,
  };
  const syntheticEvidenceInContract = synthetic.handoff.entries.some((entry) => (entry.evidence ?? []).length > 0 || entry.adapter_ids.includes(CORPUS_ADAPTER_ID));
  console.log(JSON.stringify({ synthetic_adapter: { source_adapter: synthetic.handoff.source_adapter, counts: countsOf(synthetic.handoff), imported: synthetic.summary.canonical_import_count, corpus_data_in_contract: syntheticEvidenceInContract, tampered_binding_rejected_before_write: synthetic.tamperedRejection, wrote_before_admission: synthetic.wroteBeforeAdmission, tracked_validator: synthetic.trackedValidation, comparison: syntheticComparison } }, null, 2));
  if (!Object.values(comparison).every(Boolean) || !Object.values(syntheticComparison).every(Boolean) || corpus.wroteBeforeAdmission || synthetic.wroteBeforeAdmission || syntheticEvidenceInContract
    || corpus.trackedValidation !== 'pass' || synthetic.trackedValidation !== 'pass') process.exitCode = 1;
} finally {
  await rm(temp, { recursive: true, force: true });
}
