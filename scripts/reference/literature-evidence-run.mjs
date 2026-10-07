import { buildCanonicalIndex, classifyLemmaCandidate } from '../factory/identity-adapter.mjs';
import { loadSearchFormSupport } from '../factory/search-form-support.mjs';
import { loadCanonicalEntries } from '../factory/validate.mjs';
import { REPOSITORY_DIRECTORY } from './literature-index.mjs';
import { deriveSearchForms, loadFactoryCandidate, pilotTriggerReasons, retrieveLiteratureEvidence } from './literature-evidence.mjs';

// Shared context for running the retriever over factory candidates against the current canonical.
export async function loadEvidenceContext(root = REPOSITORY_DIRECTORY) {
  const canonicalEntries = await loadCanonicalEntries(root);
  return { root, canonicalIndex: buildCanonicalIndex(canonicalEntries), support: await loadSearchFormSupport(canonicalEntries) };
}

export async function evidenceForCandidate(context, { batchId, candidateId, databasePath, maxContexts, maxPerWork }) {
  const row = await loadFactoryCandidate({ batchId, candidateId, root: context.root });
  const classification = Array.isArray(row.observations) ? classifyLemmaCandidate(row, context.canonicalIndex) : { routes: [] };
  const routes = [...new Set(classification.routes.map((route) => route.route))];
  const entryIds = new Set(classification.routes.flatMap((route) => route.existingEntryIds));
  const supportedForms = [...entryIds].flatMap((id) => [...(context.support.get(id) ?? [])]);
  const result = retrieveLiteratureEvidence({
    databasePath,
    identity: { batch_id: batchId, candidate_id: candidateId, lemma: row.input, canonical_routes: routes },
    searchForms: deriveSearchForms(row, supportedForms),
    maxContexts,
    maxPerWork,
  });
  result.summary.trigger_reasons = pilotTriggerReasons(row, routes.includes('new_sense_on_existing_entry') ? 'new_sense_on_existing_entry' : null);
  return result;
}
