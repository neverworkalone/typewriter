import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
import { parseJsonl, sha256Hex } from './contract.mjs';
import { loadSearchFormSupport } from './search-form-support.mjs';
import { publishArtifacts, recoverArtifacts } from './artifact-transaction.mjs';
import { refillCandidateBatch } from './refill.mjs';
import { COMPACT_CONTRACT, loadTrash, failedProposalLemmas, mergeUnresolved, compactManifest, TRASH_DIRECTORY, chunkText, jsonText, digest } from './permanent-trash.mjs';
import { validateFactoryRepository, loadBaseManifests, loadCanonicalEntries } from './validate.mjs';
import {
  assertWithinDirectory,
  isWithinDirectory,
  resolveCacheArtifactPath,
  resolveTypewriterCachePaths,
} from '../typewriter-cache.mjs';
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
//   pnpm run factory:stage1 --evidence runs/T000001/candidate-evidence.json --task-id T000001
// Input is the text-free output of `pnpm run reference:corpus:candidates`. Output is
// Compact candidate artifacts, permanent observation trash and batch history are
// published together. A zero-yield exhausted source is a terminal Stage 1 result.

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
  const options = { maxCandidates: DEFAULT_MAX_CANDIDATES, baseRef: DEFAULT_BASE_REF, dryRun: false, python: undefined, providers: null, attemptLog: null,
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
  if (!options.evidence) throw new Stage1Error(['--evidence <cache runs/<run>/candidate-evidence.json> is required']);
  if (!options.taskId) throw new Stage1Error(['--task-id T000000 is required']);
  if (!Number.isSafeInteger(options.maxCandidates) || options.maxCandidates < 1 || options.maxCandidates > 500) throw new Stage1Error(['--max-candidates must be an integer from 1 to 500; production defaults to 500 final valid lemmas']);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(options.taskId) || options.taskId === '.' || options.taskId === '..') {
    throw new Stage1Error(['--task-id must be a simple path-safe identifier']);
  }
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
const STAGE1_SOURCE_PATHS = Object.freeze([
  'scripts/factory',
  'scripts/intake',
  'scripts/reference/corpus-index.mjs',
  'scripts/reference/short-query-counts.mjs',
  'scripts/reference/short-query-postings.mjs',
  'scripts/typewriter-cache.mjs',
  'scripts/python/env.mjs',
]);

// Bind generated manifests to the committed producer tree. Synthetic test roots without Git
// remain supported; a real checkout must not run Stage 1 from modified factory source.
function producerRevisionFor(root) {
  try {
    git(['rev-parse', '--git-dir'], root);
  } catch {
    return null;
  }
  let revision;
  try {
    revision = git(['rev-parse', 'HEAD'], root).trim();
  } catch {
    throw new Stage1Error(['Git-backed Stage 1 checkout has no resolvable HEAD; commit the producer source before generation']);
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(revision)) {
    throw new Stage1Error(['cannot record producer_revision: Git HEAD is not a full object SHA']);
  }
  let sourceStatus;
  try {
    sourceStatus = git(['status', '--porcelain', '--untracked-files=all', '--', ...STAGE1_SOURCE_PATHS], root);
  } catch {
    throw new Stage1Error(['cannot verify producer source cleanliness before Stage 1 generation']);
  }
  if (sourceStatus.trim()) {
    throw new Stage1Error(['Stage 1 producer source scope has uncommitted changes; commit producer dependencies before generation']);
  }
  return revision;
}

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
// Local Stage 1 artifacts are namespaced by task id in the machine cache.
function taskArtifactPath(file, flag, taskRunDirectory, cachePaths) {
  let resolved;
  try {
    const normalized = file.replaceAll('\\', '/');
    const alreadyScoped = path.isAbsolute(file)
      || normalized.startsWith('data/reference/')
      || normalized.startsWith('runs/');
    resolved = alreadyScoped
      ? resolveCacheArtifactPath(file, { paths: cachePaths, areas: ['runs'], label: flag })
      : path.resolve(taskRunDirectory, file);
    assertWithinDirectory(cachePaths.root, resolved, { label: flag });
    assertWithinDirectory(taskRunDirectory, resolved, { label: `${flag} for this task` });
  } catch (error) {
    throw new Stage1Error([error.message]);
  }
  return resolved;
}

const readJson = async (file, label) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Stage1Error([`cannot read ${label} ${file}: ${error.message}`]);
  }
};

// Corpus selection exclusions are part of the text-free evidence source. Reapply them after all
// providers and contextual fallback have resolved observations, so an alternative lemma cannot
// re-enter a later batch merely because it was absent from the raw proposal list.
async function evidenceBoundExcludedLemmas({ evidence, evidencePath, cachePaths }) {
  const selection = evidence?.selection;
  const hasBinding = evidence?.schema_version !== undefined
    || evidence?.publication_state !== undefined
    || evidence?.orchestration !== undefined
    || selection?.exclusion_sha256 !== undefined
    || selection?.exclusion_source_artifacts !== undefined;
  if (!hasBinding) return new Set();
  if (!selection || !/^[0-9a-f]{64}$/u.test(String(selection.exclusion_sha256 ?? ''))
    || !Array.isArray(selection.exclusion_source_artifacts)) {
    throw new Stage1Error(['candidate evidence has an incomplete prior-lemma exclusion binding']);
  }
  const cacheArea = ['runs', 'evidence'].find((area) => isWithinDirectory(cachePaths[area], evidencePath));
  if (!cacheArea) throw new Stage1Error(['candidate evidence exclusion binding must be inside the shared cache']);
  const expectedManifestPath = path.join(path.dirname(evidencePath), 'reviewed-lemma-exclusions.json');
  let exclusionPath;
  try {
    const relative = path.relative(cachePaths.root, expectedManifestPath).split(path.sep).join('/');
    exclusionPath = resolveCacheArtifactPath(relative, { paths: cachePaths, areas: [cacheArea], label: 'reviewed-lemma exclusions bound to evidence' });
  } catch (error) {
    throw new Stage1Error([error.message]);
  }
  const exclusion = await readJson(exclusionPath, 'reviewed-lemma exclusions bound to evidence');
  const { schema_version: schema, lemmas, source_artifacts: sources, exclusion_sha256: recordedDigest } = exclusion;
  if (schema !== 'm9-reviewed-lemma-exclusions-v1' || !Array.isArray(lemmas) || !Array.isArray(sources)) {
    throw new Stage1Error(['reviewed-lemma exclusions have an unsupported or incomplete contract']);
  }
  if (lemmas.length > 0 && sources.length === 0) {
    throw new Stage1Error(['reviewed-lemma exclusions with lemmas must bind at least one source artifact']);
  }
  if (lemmas.some((lemma) => typeof lemma !== 'string' || !lemma || lemma !== lemma.trim() || lemma.normalize('NFC') !== lemma)) {
    throw new Stage1Error(['reviewed-lemma exclusions must contain trimmed NFC lemmas']);
  }
  const sortedLemmas = [...new Set(lemmas)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (sortedLemmas.length !== lemmas.length || sortedLemmas.some((lemma, index) => lemma !== lemmas[index])) {
    throw new Stage1Error(['reviewed-lemma exclusions must be unique and deterministically sorted']);
  }
  if (sources.some((source) => !source || typeof source.path !== 'string' || !source.path
    || !/^[0-9a-f]{64}$/u.test(String(source.sha256 ?? '')))) {
    throw new Stage1Error(['reviewed-lemma exclusion sources must bind paths and SHA-256 digests']);
  }
  const payload = { lemmas, schema_version: schema, source_artifacts: sources };
  const computedDigest = sha256Hex(JSON.stringify(payload));
  if (recordedDigest !== computedDigest) throw new Stage1Error(['reviewed-lemma exclusion digest does not match its contents']);
  if (selection.exclusion_sha256 !== computedDigest) throw new Stage1Error(['reviewed-lemma exclusion digest does not match candidate evidence']);
  if (JSON.stringify(selection.exclusion_source_artifacts) !== JSON.stringify(sources)) {
    throw new Stage1Error(['reviewed-lemma exclusion sources do not match candidate evidence']);
  }
  if (!Number.isSafeInteger(selection.excluded_candidate_lemma_count)
    || selection.excluded_candidate_lemma_count !== lemmas.length) {
    throw new Stage1Error(['reviewed-lemma exclusion count is missing or does not match candidate evidence']);
  }
  const orchestrationDigest = evidence.orchestration?.exclusion_manifest_sha256;
  if (!/^[0-9a-f]{64}$/u.test(String(orchestrationDigest ?? ''))) {
    throw new Stage1Error(['candidate evidence orchestration is missing the prior-lemma exclusion digest']);
  }
  if (orchestrationDigest !== computedDigest) {
    throw new Stage1Error(['reviewed-lemma exclusion digest does not match evidence orchestration']);
  }
  return new Set(lemmas);
}

// Review pack for the contextual fallback: eligible unresolved observations with a bounded window of
// the ORIGINAL paragraph, for the primary agent's local reading. It is written only to ignored
// task-scoped cache runs and is never part of a batch.
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
  validate = validateFactoryRepository, cachePaths = resolveTypewriterCachePaths(), selectPage,
} = {}) {
  const options = parseArguments(argv);
  let evidencePath;
  try {
    const normalized = options.evidence.replaceAll('\\', '/');
    const taskRunDirectory = path.join(cachePaths.runs, options.taskId);
    const alreadyScoped = path.isAbsolute(options.evidence)
      || normalized.startsWith('data/reference/')
      || normalized.startsWith('runs/')
      || normalized.startsWith('evidence/');
    evidencePath = alreadyScoped
      ? resolveCacheArtifactPath(options.evidence, {
        paths: cachePaths,
        areas: ['runs', 'evidence'],
        label: '--evidence',
      })
      : path.resolve(taskRunDirectory, options.evidence);
    if (!['runs', 'evidence'].some((area) => isWithinDirectory(cachePaths[area], evidencePath))) {
      throw new Error(`--evidence must be inside ${cachePaths.runs} or ${cachePaths.evidence}: ${evidencePath}`);
    }
  } catch (error) {
    throw new Stage1Error([`${error.message}. Use the shared ~/.cache/typewriter/runs/<run-id>/ path.`]);
  }
  const taskRunDirectory = path.join(cachePaths.runs, options.taskId);
  for (const [key, flag] of [['ensembleTrace', '--ensemble-trace'], ['attemptLog', '--attempt-log'], ['contextReviewPack', '--context-review-pack']]) {
    if (options[key]) taskArtifactPath(options[key], flag, taskRunDirectory, cachePaths);
  }
  await permission();
  let evidence;
  try {
    evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  } catch (error) {
    throw new Stage1Error([`cannot read evidence ${options.evidence}: ${error.message}`]);
  }
  // Exclusion is before morphology, never before the source/text-free contract.
  observationsFromCorpusEvidence(evidence);
  const sourceExcludedLemmas = await evidenceBoundExcludedLemmas({ evidence, evidencePath, cachePaths });
  const canonicalEntries = await loadCanonicalEntries(root);
  const producerRevision = producerRevisionFor(root);
  if (!options.dryRun) {
    const recovered = await recoverArtifacts({ root, journalDirectory: path.join(taskRunDirectory, 'stage1-publish'),
      validate: async () => {
        const journal = JSON.parse(await readFile(path.join(taskRunDirectory, 'stage1-publish/transaction.json'), 'utf8'));
        const artifact = journal.entries.find((entry) => /^data\/candidates\/C\d{6}\/manifest.json$/.test(entry.path));
        const manifest = artifact && JSON.parse(artifact.after);
        if (!manifest || manifest.task_id !== options.taskId || manifest.production?.initial_evidence_sha256 !== digest(JSON.stringify(evidence))
          || manifest.production.target !== options.maxCandidates || manifest.producer_revision !== (producerRevision ?? undefined)) return ['publication recovery inputs differ from the original run'];
        return validate({ root, base: options.baseRef === 'none' ? null : loadBaseManifests(options.baseRef, root), canonicalEntries });
      } });
    if (recovered) {
      const entry = [...recovered].find(([file]) => /^data\/candidates\/C\d{6}\/manifest.json$/.test(file));
      const manifest = JSON.parse(entry[1]);
      await rm(path.join(taskRunDirectory, 'stage1-refill-checkpoint.json'), { force: true });
      log(JSON.stringify({ batch_id: manifest.batch_id, recovered: true }));
      return { manifest, candidatesText: recovered.get(`data/candidates/${manifest.batch_id}/candidates.jsonl`), stage1DecisionsText: recovered.get(`data/candidates/${manifest.batch_id}/stage1-decisions.json`) };
    }
  }
  const batchId = allocateBatchId(await knownBatchIds(root, options.baseRef));
  const producedLemmaKeys = await producedLemmas(root, options.baseRef);
  const trash = await loadTrash(root);
  const failedProposals = failedProposalLemmas(trash);
  const proposalExclusions = new Set([...producedLemmaKeys, ...failedProposals, ...sourceExcludedLemmas]);
  for (const lemma of sourceExcludedLemmas) if (!failedProposals.has(lemma)) producedLemmaKeys.add(lemma);
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
    const file = await readJson(taskArtifactPath(options.contextProposals, '--context-proposals', taskRunDirectory, cachePaths), 'context proposals');
    contextProposals = file.proposals;
    contextAgent = file.agent ?? null; // required: recordContextDecisions refuses a missing author
    if (!Array.isArray(contextProposals)) throw new Stage1Error(['context proposals file must be {agent, proposals: []}']);
  }
  if (options.contextReplay) {
    const input = options.contextReplay;
    const normalized = input.replaceAll('\\', '/');
    const localCacheInput = path.isAbsolute(input)
      ? isWithinDirectory(cachePaths.root, input)
      : normalized.startsWith('data/reference/')
        || normalized.startsWith('runs/')
        || normalized.startsWith('evidence/');
    let filePath;
    if (localCacheInput) {
      filePath = resolveCacheArtifactPath(input, { paths: cachePaths, areas: ['runs', 'evidence'], label: '--context-replay' });
    } else {
      filePath = path.resolve(root, input);
      try { assertWithinDirectory(root, filePath, { label: '--context-replay repository input' }); }
      catch (error) { throw new Stage1Error([error.message]); }
    }
    let file = await readJson(filePath, 'context replay record');
    if (file.contract === COMPACT_CONTRACT) {
      if (!/^C\d{6}$/.test(file.batch_id) || file.stage1_decisions?.path !== `data/candidates/${file.batch_id}/stage1-decisions.json`) throw new Stage1Error(['invalid compact context replay reference']);
      const decisionsText = await readFile(path.join(root, file.stage1_decisions.path), 'utf8');
      if (digest(decisionsText) !== file.stage1_decisions.sha256) throw new Stage1Error(['compact context replay decisions digest mismatch']);
      file = JSON.parse(decisionsText);
    }
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
    producerRevision,
    taskId: options.taskId,
    maxCandidates: options.maxCandidates,
    producedLemmas: producedLemmaKeys,
    searchFormSupport: await loadSearchFormSupport(canonicalEntries),
  };
  let produced;
  try {
    if (options.dryRun || options.contextReviewPack) produced = await produceCandidateBatch({ ...produceArguments,
      evidence: { ...evidence, candidates: evidence.candidates.filter((row) => !proposalExclusions.has(row.proposed_lemma)) } });
    else {
      const selector = selectPage ?? (async ({ exclusions, page, binding }) => {
        const exclusionPath = path.join(taskRunDirectory, `refill-exclusions-${batchId}-${page}.json`);
        const payload = { lemmas: [...exclusions].sort(), schema_version: 'm9-reviewed-lemma-exclusions-v1',
          source_artifacts: [{ path: 'refill-checkpoint', sha256: binding }] };
        await mkdir(taskRunDirectory, { recursive: true });
        await writeFile(exclusionPath, jsonText({ ...payload, exclusion_sha256: digest(JSON.stringify(payload)) }), 'utf8');
        const output = path.join(taskRunDirectory, `refill-${batchId}-${String(page).padStart(6, '0')}`);
        const outputEvidence = path.join(output, 'candidate-evidence.json');
        // An interruption after page creation reuses that bound page. The refill
        // loop verifies snapshot/proposal progress before accepting it.
        try { return JSON.parse(await readFile(outputEvidence, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        // This page belongs exclusively to the bound task/batch checkpoint. A
        // failed selector may leave partial local output; regenerate that page
        // rather than treating an incomplete directory as exhaustion.
        await rm(output, { recursive: true, force: true });
        const command = [path.join(root, 'scripts/reference/run-corpus-lemma-pilot.mjs'),
          '--candidate-limit', String(options.maxCandidates), '--include-canonical-lemmas',
          '--reuse-analysis-from', path.dirname(evidencePath), '--output-directory', output,
          '--batch-id', options.taskId, '--exclude-lemma-source', exclusionPath,
          ...(options.python ? ['--python', options.python] : [])];
        await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, command, { cwd: root, stdio: 'inherit' });
          child.on('error', reject);
          child.on('close', (code) => code === 0 ? resolve() : reject(new Stage1Error([`refill selector failed with exit ${code}; no partial batch published`])));
        });
        return JSON.parse(await readFile(outputEvidence, 'utf8'));
      });
      produced = await refillCandidateBatch({ initialEvidence: evidence, arguments: produceArguments, exclusions: proposalExclusions,
        checkpointPath: path.join(taskRunDirectory, 'stage1-refill-checkpoint.json'), selectPage: selector,
        progress: (message) => log(JSON.stringify({ phase: 'refill', ...message })) });
    }
    if (options.contextReviewPack) {
      const pack = await buildContextReviewPack({ queue: produced.manifest.unresolved_observations, contextSource: source });
      const outputPath = taskArtifactPath(options.contextReviewPack, '--context-review-pack', taskRunDirectory, cachePaths);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(pack, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      options.dryRun = true; // a review pack is read locally before any batch is written
    }
  } finally {
    if (ownSource) source.close?.();
  }
  if (options.ensembleTrace && produced.ensemble) {
    // Text-free local trace (provider paths + Kiwi N-best per observation digest); never in Git.
    const lines = produced.ensemble.decisions.map((decision) => JSON.stringify({ observation_digest: decision.observation_digest, trace_digest: decision.trace_digest, trace: decision.trace }));
    const outputPath = taskArtifactPath(options.ensembleTrace, '--ensemble-trace', taskRunDirectory, cachePaths);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  if (options.attemptLog) {
    // Text-free (input digests only); task-namespaced and never part of a batch.
    const logPath = taskArtifactPath(options.attemptLog, '--attempt-log', taskRunDirectory, cachePaths);
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, produced.attemptLog.map((entry) => JSON.stringify(entry)).join('\n') + '\n', { encoding: 'utf8', flag: 'wx' });
  }
  const target = path.join(root, 'data/candidates', batchId);
  if (!options.dryRun) {
    const merged = mergeUnresolved(trash, [produced.manifest]);
    const compact = compactManifest(produced.manifest, merged.references.get(batchId));
    compact.manifest.production = produced.production;
    if (!produced.rows.length) compact.manifest.status = 'exhausted';
    const files = new Map([...merged.changed].map((file) => [`${TRASH_DIRECTORY}/${file}`, chunkText(merged.chunks.get(file))]));
    files.set(compact.manifest.stage1_decisions.path, compact.stage1DecisionsText);
    files.set(`data/candidates/${batchId}/candidates.jsonl`, produced.candidatesText);
    files.set(`data/candidates/${batchId}/manifest.json`, jsonText(compact.manifest));
    // Same base comparison as the CI validator, so already-merged reviews are not re-validated as new work.
    const base = options.baseRef === 'none' ? null : loadBaseManifests(options.baseRef, root);
    await publishArtifacts({ root, files, journalDirectory: path.join(taskRunDirectory, 'stage1-publish'),
      validate: () => validate({ root, base, canonicalEntries }) });
    await rm(path.join(taskRunDirectory, 'stage1-refill-checkpoint.json'), { force: true });
    produced.manifest = compact.manifest;
    produced.stage1DecisionsText = compact.stage1DecisionsText;
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
  log(JSON.stringify({ batch_id: batchId, status: produced.manifest.status, dry_run: options.dryRun, directory: path.relative(root, target),
    ...produced.summary, ...(produced.production ? { production: produced.production } : {}), ...(comparison ? { comparison } : {}) }));
  return produced;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runStage1(process.argv.slice(2)).catch((error) => {
    console.error(error.errors ? error.errors.join('\n') : error.message);
    process.exitCode = 1;
  });
}
