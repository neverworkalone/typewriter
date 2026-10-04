import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PROVIDER_ORDER, createKiwiProvider } from './analyzer-providers.mjs';
import { assertCorpusPermission } from '../reference/corpus-index.mjs';
import { parseJsonl } from './contract.mjs';
import { loadSearchFormSupport } from './search-form-support.mjs';
import { validateFactoryRepository, loadCanonicalEntries } from './validate.mjs';
import {
  DEFAULT_MAX_CANDIDATES,
  Stage1Error,
  allocateBatchId,
  canonicalSnapshotDigest,
  produceCandidateBatch,
} from './stage1.mjs';

// Factory Stage 1 entry point (issue #264): one serial task, one bounded candidate batch per run.
// Since issue #275 the bound (`--max-candidates`, default 500) counts distinct citation-form lemmas.
//   npm run factory:stage1 -- --evidence data/reference/<run>/candidate-evidence.json --task-id T000001
// Input is the text-free output of `npm run reference:corpus:candidates`. Output is
// data/candidates/C…/{manifest.json,candidates.jsonl} with status `created`; nothing else is written.

// Providers selectable by `--providers`; adding one is a registry entry (docs/lexical-factory-contracts.md).
// Unknown ids fail closed. Local-only: no provider may send candidates or corpus text to a network.
export const PROVIDER_REGISTRY = Object.freeze({ kiwi: ({ python }) => createKiwiProvider({ python }) });

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_BASE_REF = 'origin/master';

export function parseArguments(argv) {
  const options = { maxCandidates: DEFAULT_MAX_CANDIDATES, baseRef: DEFAULT_BASE_REF, dryRun: false, python: process.env.TYPEWRITER_PYTHON || 'python3', providers: [...DEFAULT_PROVIDER_ORDER], attemptLog: null };
  const value = (index, flag) => {
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Stage1Error([`${flag} requires a value`]);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--evidence') options.evidence = value(index++, flag);
    else if (flag === '--task-id') options.taskId = value(index++, flag);
    else if (flag === '--providers') options.providers = value(index++, flag).split(',').map((id) => id.trim());
    else if (flag === '--attempt-log') options.attemptLog = value(index++, flag);
    else if (flag === '--python') options.python = value(index++, flag);
    else if (flag === '--base-ref') options.baseRef = value(index++, flag);
    else if (flag === '--max-candidates') options.maxCandidates = Number(value(index++, flag));
    else throw new Stage1Error([`unknown argument ${flag}`]);
  }
  if (!options.evidence) throw new Stage1Error(['--evidence <data/reference/.../candidate-evidence.json> is required']);
  if (!options.taskId) throw new Stage1Error(['--task-id T000000 is required']);
  const unknown = options.providers.filter((id) => !Object.hasOwn(PROVIDER_REGISTRY, id));
  if (unknown.length) throw new Stage1Error([`unknown analyzer provider(s) ${unknown.join(',')}; known: ${Object.keys(PROVIDER_REGISTRY).join(',')}`]);
  if (new Set(options.providers).size !== options.providers.length) throw new Stage1Error(['--providers must not repeat a provider']);
  return options;
}

const git = (args, root) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// Batch ids already used locally or on the merged base; an unresolved base fails closed unless
// the owner explicitly passes `--base-ref none`.
async function knownBatchIds(root, baseRef) {
  const ids = new Set();
  for (const directory of ['data/candidates', 'data/reviews']) {
    try {
      for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) if (entry.isDirectory()) ids.add(entry.name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (baseRef !== 'none') {
      let listing;
      try {
        listing = git(['ls-tree', '--name-only', baseRef, `${directory}/`], root);
      } catch {
        throw new Stage1Error([`cannot resolve ${baseRef}; fetch master or pass --base-ref none to skip the remote id check`]);
      }
      for (const entry of listing.split('\n').filter(Boolean)) ids.add(path.basename(entry));
    }
  }
  return [...ids];
}

// Lemmas already produced by any existing batch (v1 usage rows and v2 lemma rows alike), locally and
// on the merged base, so a rerun only yields unprocessed headwords.
async function producedLemmas(root, baseRef) {
  const keys = new Set();
  const add = (text, label) => {
    const errors = [];
    for (const row of parseJsonl(text, label, errors)) keys.add(row.input);
    if (errors.length) throw new Stage1Error(errors);
  };
  try {
    for (const entry of await readdir(path.join(root, 'data/candidates'), { withFileTypes: true })) {
      if (entry.isDirectory()) add(await readFile(path.join(root, 'data/candidates', entry.name, 'candidates.jsonl'), 'utf8'), entry.name);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (baseRef !== 'none') {
    for (const entry of git(['ls-tree', '--name-only', baseRef, 'data/candidates/'], root).split('\n').filter(Boolean)) {
      add(git(['show', `${baseRef}:${entry}/candidates.jsonl`], root), path.basename(entry));
    }
  }
  return keys;
}

// `analyzer` and `permission` are injectable so tests need neither Kiwi nor the corpus.
export async function runStage1(argv, {
  root = REPOSITORY_DIRECTORY, analyzer, providers, permission = assertCorpusPermission, log = console.log,
} = {}) {
  const options = parseArguments(argv);
  const evidencePath = path.resolve(root, options.evidence);
  const relative = path.relative(path.join(root, 'data/reference'), evidencePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Stage1Error(['evidence must come from the ignored data/reference/ extractor output']);
  }
  await permission();
  let evidence;
  try {
    evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  } catch (error) {
    throw new Stage1Error([`cannot read evidence ${options.evidence}: ${error.message}`]);
  }
  const canonicalEntries = await loadCanonicalEntries(root);
  const batchId = allocateBatchId(await knownBatchIds(root, options.baseRef));
  const produced = await produceCandidateBatch({
    evidence,
    // Injected `analyzer` stands in for kiwi only; the default order is exactly [kiwi].
    providers: providers ?? options.providers.map((id) => (id === 'kiwi' && analyzer
      ? createKiwiProvider({ analyze: analyzer }) : PROVIDER_REGISTRY[id]({ python: options.python }))),
    canonicalEntries,
    canonicalDigest: await canonicalSnapshotDigest(root),
    batchId,
    taskId: options.taskId,
    maxCandidates: options.maxCandidates,
    producedLemmas: await producedLemmas(root, options.baseRef),
    searchFormSupport: await loadSearchFormSupport(canonicalEntries),
  });
  if (options.attemptLog) {
    // Text-free (input digests only); kept in the ignored data/reference tree, never in a batch.
    const logPath = path.resolve(root, options.attemptLog);
    const inside = path.relative(path.join(root, 'data/reference'), logPath);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Stage1Error(['--attempt-log must be inside data/reference/']);
    await writeFile(logPath, produced.attemptLog.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  }
  const target = path.join(root, 'data/candidates', batchId);
  if (!options.dryRun) {
    await mkdir(path.join(root, 'data/candidates'), { recursive: true });
    const staging = await mkdtemp(path.join(root, 'data/candidates', '.stage1-'));
    try {
      await writeFile(path.join(staging, 'candidates.jsonl'), produced.candidatesText, 'utf8');
      await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(produced.manifest, null, 2)}\n`, 'utf8');
      await rename(staging, target); // fails when the batch directory already exists: batches are immutable
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    const errors = await validateFactoryRepository({ root, canonicalEntries });
    if (errors.length) {
      await rm(target, { recursive: true, force: true });
      throw new Stage1Error(errors);
    }
  }
  log(JSON.stringify({ batch_id: batchId, dry_run: options.dryRun, directory: path.relative(root, target), ...produced.summary }));
  return produced;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runStage1(process.argv.slice(2)).catch((error) => {
    console.error(error.errors ? error.errors.join('\n') : error.message);
    process.exitCode = 1;
  });
}
