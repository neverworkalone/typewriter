import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { providerDescriptor } from './analyzer-providers.mjs';
import { produceCandidateBatch, Stage1Error } from './stage1.mjs';
import { digest, jsonText } from './permanent-trash.mjs';

async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, jsonText(value), 'utf8');
  await rename(`${file}.tmp`, file);
}
const snapshotOf = (evidence) => `${evidence.index?.input_manifest_sha256}:${evidence.index?.logical_rows_sha256}`;

// Pages remain local. No partial batch/trash is published from this loop. The
// checkpoint caches source-bound analyzer answers, never a separate AI judgment.
export async function refillCandidateBatch({ initialEvidence, arguments: args, exclusions, checkpointPath, selectPage, progress = () => {} }) {
  const binding = digest(JSON.stringify({ evidence: initialEvidence, exclusions: [...exclusions].sort(),
    batch: args.batchId, task: args.taskId, target: args.maxCandidates, canonical: args.canonicalDigest,
    revision: args.producerRevision, policy: args.policy, providers: args.providers.map(providerDescriptor),
    contextProposals: args.contextProposals, contextReplay: args.contextReplay, contextAgent: args.contextAgent }));
  let state = { contract: 'lexical-factory-refill-checkpoint-v1', binding, pages: [], providers: {}, exhausted: false };
  try {
    const previous = JSON.parse(await readFile(checkpointPath, 'utf8'));
    if (previous.binding !== binding || previous.contract !== state.contract) throw new Stage1Error(['refill checkpoint input binding differs; choose a new task or restore its original inputs']);
    state = previous;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const excluded = new Set(exclusions);
  const visited = new Set();
  const combined = { ...initialEvidence, candidates: [] };
  function append(page) {
    if (snapshotOf(page) !== snapshotOf(initialEvidence)
      || JSON.stringify(page.extractor) !== JSON.stringify(initialEvidence.extractor)) throw new Stage1Error(['refill page changed corpus snapshot or extractor']);
    const proposals = new Set(page.candidates.map((row) => row.proposed_lemma));
    for (const lemma of proposals) if (visited.has(lemma)) throw new Stage1Error([`refill selector repeated proposal ${lemma}`]);
    for (const lemma of proposals) visited.add(lemma);
    combined.candidates.push(...page.candidates.filter((row) => !exclusions.has(row.proposed_lemma)));
    for (const lemma of proposals) excluded.add(lemma);
  }
  for (const page of state.pages) append(page);
  const providers = args.providers.map((provider) => ({ ...provider, analyze: async (requests) => {
    const cached = state.providers[provider.id] ??= { metadata: null, results: {} };
    const missing = requests.filter((request) => !cached.results[request.text]);
    if (missing.length) {
      const response = await provider.analyze(missing);
      provider.assertMetadata(response?.metadata);
      if (cached.metadata && JSON.stringify(cached.metadata) !== JSON.stringify(response.metadata)) throw new Stage1Error(['analyzer metadata changed during refill']);
      const ids = new Set(missing.map((request) => request.id));
      if (!Array.isArray(response.results) || response.results.length !== missing.length
        || new Set(response.results.map((row) => row.id)).size !== ids.size
        || response.results.some((row) => !ids.has(row.id) || row.status === 'error')) throw new Stage1Error([`provider ${provider.id} execution failed; refusing partial refill`]);
      cached.metadata = response.metadata;
      for (const result of response.results) cached.results[result.id] = result;
      await save(checkpointPath, state);
    }
    return { metadata: cached.metadata, results: requests.map((request) => ({ ...cached.results[request.text], id: request.id })) };
  } }));
  if (!state.pages.length) {
    state.pages.push(initialEvidence);
    append(initialEvidence);
    await save(checkpointPath, state);
  }
  while (true) {
    let produced = null;
    if (combined.candidates.length) produced = await produceCandidateBatch({ ...args, evidence: combined, providers, refill: true });
    const count = produced?.rows.length ?? 0;
    progress({ pages: state.pages.length, candidates: count, visited_proposals: visited.size });
    if (count >= args.maxCandidates || state.exhausted) {
      if (!count) {
        await rm(checkpointPath, { force: true });
        throw new Stage1Error(['source exhausted with no valid new candidates; no batch published']);
      }
      produced.production = { contract: 'lexical-factory-refill-v1', target: args.maxCandidates, pages: state.pages.length,
        visited_proposal_count: visited.size, exhausted: state.exhausted, source_snapshot: snapshotOf(initialEvidence),
        initial_evidence_sha256: digest(JSON.stringify(initialEvidence)), checkpoint_binding: binding,
        ...(state.exhausted ? { exhaustion: { ...state.exhaustion,
          ...(state.pages.at(-1).selection.exclusion_sha256 ? { exclusion_sha256: state.pages.at(-1).selection.exclusion_sha256 } : {}),
          ...(state.pages.at(-1).orchestration?.candidate_selection_sha256 ? { selection_sha256: state.pages.at(-1).orchestration.candidate_selection_sha256 } : {}) } } : {}) };
      return produced;
    }
    const page = await selectPage({ exclusions: excluded, page: state.pages.length, binding });
    if (!page || !Array.isArray(page.candidates) || !page.selection?.exhaustion
      || page.selection.exhaustion.contract !== 'corpus-selector-exhaustion-v1'
      || !Number.isSafeInteger(page.selection.exhaustion.remaining_lemma_count)
      || page.selection.exhaustion.remaining_lemma_count < 0) throw new Stage1Error(['refill selector must provide bounded candidates and an explicit remaining-source proof']);
    if (!page.candidates.length && page.selection.exhaustion.remaining_lemma_count !== 0) throw new Stage1Error(['empty selector page is not proof of source exhaustion']);
    if (page.candidates.some((row) => excluded.has(row.proposed_lemma))) throw new Stage1Error(['refill selector returned a previously excluded proposal']);
    append(page);
    state.pages.push(page);
    state.exhausted = page.selection.exhaustion.remaining_lemma_count === 0;
    state.exhaustion = page.selection.exhaustion;
    await save(checkpointPath, state);
  }
}
