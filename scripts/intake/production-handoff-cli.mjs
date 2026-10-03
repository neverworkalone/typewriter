// Production hand-off tooling (issue #251). Local only; the Kiwi step needs the
// pinned kiwipiepy environment (see docs/intake-pipeline-issue-249.md).
//
//   build: <analysis-directory> inventory+evidence → shared intake (real Kiwi) →
//          <out> hand-off artifact (text-free, bounded)
//   bind:  review-input + hand-off → writes the `intake_handoff` integration
//          block (per-admission bindings) into the review input.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createKiwiAnalyzer } from './kiwi-client.mjs';
import { CORPUS_ADAPTER_ID } from './adapters/corpus-adapter.mjs';
import {
  buildProductionHandoff,
  corpusBatchCandidates,
  handoffEntryFor,
  handoffQaBinding,
  integrationBlock,
  verifyProductionHandoff,
} from './production-handoff.mjs';
import { sha256Json } from '../validate/semantic-audit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(3).map((arg) => {
  const match = /^--([^=]+)=(.*)$/u.exec(arg);
  if (!match) throw new Error(`invalid argument ${arg}; use --key=value`);
  return [match[1], match[2]];
}));
const readJson = async (file) => JSON.parse(await readFile(path.resolve(ROOT, file), 'utf8'));

async function canonicalLemmas() {
  const directory = path.join(ROOT, 'data/canonical');
  const lemmas = new Set();
  for (const name of (await readdir(directory)).filter((file) => file.endsWith('.jsonl'))) {
    for (const line of (await readFile(path.join(directory, name), 'utf8')).split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.lemma) lemmas.add(record.lemma.normalize('NFC'));
    }
  }
  return lemmas;
}

async function build() {
  const directory = args['analysis-directory'];
  const inventory = await readJson(path.join(directory, 'candidate-inventory.json'));
  const evidence = await readJson(path.join(directory, 'candidate-evidence.json'));
  const rawCandidates = corpusBatchCandidates(inventory, evidence);
  const handoff = await buildProductionHandoff({
    batchId: args['batch-id'],
    rawCandidates,
    analyzer: createKiwiAnalyzer(),
    coveredLemmas: await canonicalLemmas(),
    adapterId: CORPUS_ADAPTER_ID,
  });
  verifyProductionHandoff(handoff, { rawCandidates, batchId: args['batch-id'] });
  await writeFile(path.resolve(ROOT, args.out), `${JSON.stringify(handoff, null, 2)}\n`);
  const counts = {};
  for (const entry of handoff.entries) {
    const key = entry.decision === 'hold' ? `hold:${entry.holds.join('+')}` : entry.decision;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  console.log(JSON.stringify({ batch_id: handoff.batch_id, total: handoff.entries.length, counts }, null, 2));
}

async function bind() {
  const handoffBytes = await readFile(path.resolve(ROOT, args.handoff));
  const handoff = JSON.parse(handoffBytes.toString('utf8'));
  const inputPath = path.resolve(ROOT, args['review-input']);
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const analysis = args['analysis-directory'];
  const inventory = await readJson(path.join(analysis, 'candidate-inventory.json'));
  const authored = await readJson(args['authored-decisions']);
  const proposed = new Map(inventory.candidates.map((candidate) => [candidate.proposed_lemma, candidate.proposed_pos]));
  const correctedPos = new Map((authored.decisions ?? []).filter((row) => row.corrected_pos).map((row) => [row.lemma, row.corrected_pos]));
  const bindings = {};
  for (const review of input.reviews) {
    const entry = handoffEntryFor(handoff, { lemma: review.lemma, proposedPos: proposed.get(review.lemma) });
    if (!entry) throw new Error(`${review.lemma}: not in the intake hand-off`);
    bindings[review.lemma] = handoffQaBinding(handoff, entry, {
      glossSha256: review.gloss_sha256,
      pos: correctedPos.get(review.lemma) ?? proposed.get(review.lemma),
    });
  }
  input.intake_handoff = integrationBlock(handoff, handoffBytes, { bindings, resolutions: input.intake_handoff?.resolutions ?? {} });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  console.log(JSON.stringify({ bound: Object.keys(bindings).length, handoff_sha256: input.intake_handoff.handoff_sha256, digest: sha256Json(input.intake_handoff) }, null, 2));
}

const command = process.argv[2];
if (command === 'build') await build();
else if (command === 'bind') await bind();
else throw new Error('usage: production-handoff-cli.mjs build|bind --key=value ...');
