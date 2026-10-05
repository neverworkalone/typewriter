import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PROVIDER_ORDER, RESOLUTION_POLICY, createKiwiProvider } from './analyzer-providers.mjs';
import { ENSEMBLE_POLICY, ENSEMBLE_PROVIDER_ORDER } from './ensemble-resolver.mjs';
import { alignedInContext, alignedOffset, fallbackBlockers } from './context-fallback.mjs';
import { createCorpusContextSource } from './corpus-context-source.mjs';
import { createKhaiiiProvider } from './khaiii-provider.mjs';
import { createMecabProvider } from './mecab-provider.mjs';
import { assertCorpusPermission } from '../reference/corpus-index.mjs';
import { parseJsonl } from './contract.mjs';
import { loadSearchFormSupport } from './search-form-support.mjs';
import { validateFactoryRepository, loadCanonicalEntries } from './validate.mjs';
import {
  DEFAULT_MAX_CANDIDATES,
  Stage1Error,
  allocateBatchId,
  canonicalSnapshotDigest,
  compareResolutionPolicies,
  observationsFromCorpusEvidence,
  produceCandidateBatch,
} from './stage1.mjs';

// Factory Stage 1 entry point (issue #264): one serial task, one bounded candidate batch per run.
// Since issue #275 the bound (`--max-candidates`, default 500) counts distinct citation-form lemmas.
//   npm run factory:stage1 -- --evidence data/reference/<run>/candidate-evidence.json --task-id T000001
// Input is the text-free output of `npm run reference:corpus:candidates`. Output is
// data/candidates/C…/{manifest.json,candidates.jsonl} with status `created`; nothing else is written.

// Providers selectable by `--providers`; adding one is a registry entry (docs/lexical-factory-contracts.md).
// Unknown ids fail closed. Local-only: no provider may send candidates or corpus text to a network.
export const PROVIDER_REGISTRY = Object.freeze({
  kiwi: ({ python }) => createKiwiProvider({ python }),
  khaiii: () => createKhaiiiProvider(), // lazy: nothing runs until Stage 1 asks it about an unresolved surface
  mecab: () => createMecabProvider(), // lazy, like khaiii
});

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_BASE_REF = 'origin/master';

// `--policy` selects the resolution policy. Newly produced v2 batches default to the all-three
// ensemble; the v1 conditional-fallback policy (Kiwi-only by default) is an explicit compatibility
// and A/B baseline mode, so a Kiwi-only production run can never happen by accident.
export const POLICY_ALIASES = Object.freeze({ ensemble: ENSEMBLE_POLICY, v1: RESOLUTION_POLICY, [ENSEMBLE_POLICY]: ENSEMBLE_POLICY, [RESOLUTION_POLICY]: RESOLUTION_POLICY });

export function parseArguments(argv) {
  const options = { maxCandidates: DEFAULT_MAX_CANDIDATES, baseRef: DEFAULT_BASE_REF, dryRun: false, python: process.env.TYPEWRITER_PYTHON || 'python3', providers: null, attemptLog: null,
    policy: ENSEMBLE_POLICY, ensembleTrace: null, contextProposals: null, contextReplay: null, contextReviewPack: null, compareKiwiOnly: false };
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
    else if (flag === '--policy') {
      const requested = value(index++, flag);
      if (!Object.hasOwn(POLICY_ALIASES, requested)) throw new Stage1Error([`unknown --policy ${requested}; known: ${Object.keys(POLICY_ALIASES).join(', ')}`]);
      options.policy = POLICY_ALIASES[requested];
    }
    else if (flag === '--ensemble-trace') options.ensembleTrace = value(index++, flag);
    else if (flag === '--context-proposals') options.contextProposals = value(index++, flag);
    else if (flag === '--context-replay') options.contextReplay = value(index++, flag);
    else if (flag === '--context-review-pack') options.contextReviewPack = value(index++, flag);
    else if (flag === '--compare-kiwi-only') options.compareKiwiOnly = true;
    else if (flag === '--python') options.python = value(index++, flag);
    else if (flag === '--base-ref') options.baseRef = value(index++, flag);
    else if (flag === '--max-candidates') options.maxCandidates = Number(value(index++, flag));
    else throw new Stage1Error([`unknown argument ${flag}`]);
  }
  if (!options.evidence) throw new Stage1Error(['--evidence <data/reference/.../candidate-evidence.json> is required']);
  if (!options.taskId) throw new Stage1Error(['--task-id T000000 is required']);
  const explicitProviders = options.providers !== null;
  options.providers ??= options.policy === ENSEMBLE_POLICY ? [...ENSEMBLE_PROVIDER_ORDER] : [...DEFAULT_PROVIDER_ORDER];
  if (options.policy === ENSEMBLE_POLICY && JSON.stringify(options.providers) !== JSON.stringify(ENSEMBLE_PROVIDER_ORDER)) {
    throw new Stage1Error([`the ensemble policy runs exactly ${ENSEMBLE_PROVIDER_ORDER.join(',')}${explicitProviders ? ` (got --providers ${options.providers.join(',')})` : ''}; use --policy ${RESOLUTION_POLICY} for a conditional or Kiwi-only baseline`]);
  }
  if (options.policy !== ENSEMBLE_POLICY && (options.contextProposals || options.contextReplay || options.contextReviewPack)) {
    throw new Stage1Error([`the contextual fallback options require the ${ENSEMBLE_POLICY} policy`]);
  }
  if (options.contextProposals && options.contextReplay) throw new Stage1Error(['--context-proposals and --context-replay are exclusive']);
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
// Local-only output (review packs hold original context text; traces hold analyzer paths) must stay
// inside the ignored data/reference tree and never reach Git.
function ignoredOutputPath(root, file, flag) {
  const resolved = path.resolve(root, file);
  const inside = path.relative(path.join(root, 'data/reference'), resolved);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Stage1Error([`${flag} must be inside data/reference/`]);
  return resolved;
}

const readJson = async (file, label) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Stage1Error([`cannot read ${label} ${file}: ${error.message}`]);
  }
};

// Review pack for the contextual fallback: eligible unresolved observations with a bounded window of
// the ORIGINAL paragraph, for the primary agent's local reading. It is written only to ignored
// data/reference/ and is never part of a batch.
async function buildContextReviewPack({ queue, contextSource }) {
  const items = [];
  for (const entry of queue) {
    const blockers = fallbackBlockers(entry);
    const item = { observation_digest: entry.observation_digest, surface: entry.surface, evidence: entry.evidence, extractor_hint: entry.extractor_hint,
      hypotheses: entry.hypotheses, category: entry.category, reasons: entry.reasons, blocked_by: blockers };
    if (!blockers.length) {
      const found = await contextSource.lookup({ kind: entry.evidence.kind, ref: entry.evidence.ref });
      if (found?.status === 'snapshot_mismatch') throw new Stage1Error(['the local corpus index does not match the evidence source snapshot; refusing to build a review pack from it']);
      item.source_status = found?.status ?? 'absent';
      if (found?.status === 'ok') {
        item.aligned = alignedInContext(found.text, entry.surface);
        const aligned = alignedOffset(found.text, entry.surface);
        item.context = aligned === null ? null : found.text.slice(Math.max(0, aligned.start - 120), aligned.end + 120);
      }
    }
    items.push(item);
  }
  return items;
}

export async function runStage1(argv, {
  root = REPOSITORY_DIRECTORY, analyzer, providers, permission = assertCorpusPermission, log = console.log, contextSource, contextDatabasePath,
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
  let source = contextSource;
  const ownSource = !source && (options.contextProposals || options.contextReviewPack);
  if (ownSource) {
    try {
      source = createCorpusContextSource({ permission, expectedSnapshot: `corpus:${evidence?.index?.input_manifest_sha256}:${evidence?.index?.logical_rows_sha256}`, ...(contextDatabasePath ? { databasePath: contextDatabasePath } : {}) });
    } catch (error) {
      throw new Stage1Error([error.message]);
    }
  }
  let contextProposals = null;
  let contextReplay = null;
  let contextAgent = null;
  if (options.contextProposals) {
    const file = await readJson(ignoredOutputPath(root, options.contextProposals, '--context-proposals'), 'context proposals');
    contextProposals = file.proposals;
    contextAgent = file.agent ?? null; // required: recordContextDecisions refuses a missing author
    if (!Array.isArray(contextProposals)) throw new Stage1Error(['context proposals file must be {agent, proposals: []}']);
  }
  if (options.contextReplay) {
    const file = await readJson(path.resolve(root, options.contextReplay), 'context replay record');
    contextReplay = Array.isArray(file) ? file : file.context_fallback?.decisions;
    if (!Array.isArray(contextReplay)) throw new Stage1Error(['context replay record must be a manifest or a decisions array']);
  }
  const resolvedProviders = providers ?? options.providers.map((id) => (id === 'kiwi' && analyzer
    ? createKiwiProvider({ analyze: analyzer }) : PROVIDER_REGISTRY[id]({ python: options.python })));
  const produceArguments = {
    evidence,
    // Injected `analyzer` stands in for kiwi only; the effective order is printed in the run summary.
    providers: resolvedProviders,
    policy: options.policy,
    contextProposals,
    contextReplay,
    contextSource: source,
    contextAgent,
    canonicalEntries,
    canonicalDigest: await canonicalSnapshotDigest(root),
    batchId,
    taskId: options.taskId,
    maxCandidates: options.maxCandidates,
    producedLemmas: await producedLemmas(root, options.baseRef),
    searchFormSupport: await loadSearchFormSupport(canonicalEntries),
  };
  let produced;
  try {
    produced = await produceCandidateBatch(produceArguments);
    if (options.contextReviewPack) {
      const pack = await buildContextReviewPack({ queue: produced.manifest.unresolved_observations, contextSource: source });
      await writeFile(ignoredOutputPath(root, options.contextReviewPack, '--context-review-pack'), `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
      options.dryRun = true; // a review pack is read locally before any batch is written
    }
  } finally {
    if (ownSource) source.close?.();
  }
  if (options.ensembleTrace && produced.ensemble) {
    // Text-free local trace (provider paths + Kiwi N-best per observation digest); never in Git.
    const lines = produced.ensemble.decisions.map((decision) => JSON.stringify({ observation_digest: decision.observation_digest, trace_digest: decision.trace_digest, trace: decision.trace }));
    await writeFile(ignoredOutputPath(root, options.ensembleTrace, '--ensemble-trace'), `${lines.join('\n')}\n`, 'utf8');
  }
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
  let comparison;
  if (options.compareKiwiOnly) {
    // Same-cohort A/B: nothing is written; verified accuracy stays `not_established`.
    const { observations, source: evidenceSource } = observationsFromCorpusEvidence(evidence);
    comparison = await compareResolutionPolicies({
      observations, kiwiProvider: analyzer ? createKiwiProvider({ analyze: analyzer }) : PROVIDER_REGISTRY.kiwi({ python: options.python }),
      ensembleProviders: resolvedProviders, context: contextProposals || contextReplay ? { contextProposals, contextReplay, contextSource: source, contextAgent, snapshot: evidenceSource.source_snapshot } : null,
    });
  }
  log(JSON.stringify({ batch_id: batchId, dry_run: options.dryRun, directory: path.relative(root, target), ...produced.summary, ...(comparison ? { comparison } : {}) }));
  return produced;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runStage1(process.argv.slice(2)).catch((error) => {
    console.error(error.errors ? error.errors.join('\n') : error.message);
    process.exitCode = 1;
  });
}
