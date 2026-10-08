import { buildCanonicalIndex, classifyLemmaCandidate } from '../factory/identity-adapter.mjs';
import { loadPosScopedSearchFormSupport } from '../factory/search-form-support.mjs';
import { loadCanonicalEntries } from '../factory/validate.mjs';
import { REPOSITORY_DIRECTORY } from './literature-index.mjs';
import { deriveSearchForms, loadFactoryCandidate, pilotTriggerReasons, retrieveLiteratureEvidence } from './literature-evidence.mjs';

// Shared context for running the retriever over factory candidates against the current canonical.
export async function loadEvidenceContext(root = REPOSITORY_DIRECTORY) {
  const canonicalEntries = await loadCanonicalEntries(root);
  return { root, canonicalIndex: buildCanonicalIndex(canonicalEntries), support: await loadPosScopedSearchFormSupport(canonicalEntries) };
}

// Already-supported generated forms of canonical entries, only for a POS the candidate and the canonical
// sense share (route `new_sense_on_existing_entry`). `new_pos_on_existing_lemma` supplies none: the
// existing entry's forms belong to another POS and must not bias evidence for this candidate.
export function supportedFormsForCandidate(row, canonicalIndex, support) {
  if (!Array.isArray(row.observations)) return [];
  const { routes } = classifyLemmaCandidate(row, canonicalIndex);
  return [...new Set(routes
    .filter((route) => route.route === 'new_sense_on_existing_entry')
    .flatMap((route) => route.existingEntryIds.flatMap((id) => [...(support.get(`${id}\0${route.pos}`) ?? [])])))];
}

export async function evidenceForCandidate(context, { batchId, candidateId, databasePath, maxContexts, maxPerWork, matchMode }) {
  const row = await loadFactoryCandidate({ batchId, candidateId, root: context.root });
  const classification = Array.isArray(row.observations) ? classifyLemmaCandidate(row, context.canonicalIndex) : { routes: [] };
  const routes = [...new Set(classification.routes.map((route) => route.route))];
  const supportedForms = supportedFormsForCandidate(row, context.canonicalIndex, context.support);
  const result = retrieveLiteratureEvidence({
    databasePath,
    identity: { batch_id: batchId, candidate_id: candidateId, lemma: row.input, canonical_routes: routes },
    searchForms: deriveSearchForms(row, supportedForms),
    maxContexts,
    maxPerWork,
    ...(matchMode ? { matchMode } : {}),
  });
  result.summary.trigger_reasons = pilotTriggerReasons(row, routes.includes('new_sense_on_existing_entry') ? 'new_sense_on_existing_entry' : null);
  return result;
}
