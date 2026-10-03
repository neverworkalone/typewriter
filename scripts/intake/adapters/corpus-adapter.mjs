// CorpusAdapter: maps the bounded #201 pilot extraction output (local ignored
// artifact) onto the common candidate contract. Corpus-only fields (counts,
// document/source concentration, SQLite ids) stay out of the contract; only
// bounded evidence references are kept.
export const CORPUS_ADAPTER_ID = 'written-corpus-2025';

// Preserve the pilot's own reason for holding: morphology ambiguity and a
// coverage collision are different defects. Unknown held causes fail closed.
export function corpusHolds(candidate) {
  if (candidate.decision_state !== 'held') return [];
  const holds = [];
  if (String(candidate.ambiguity_status ?? '').startsWith('held_')) holds.push('analysis_ambiguous');
  if (!['uncovered', 'exact_canonical_lemma', undefined].includes(candidate.coverage_status)) holds.push('coverage_collision');
  return holds.length ? holds : ['analysis_ambiguous'];
}

export function corpusAdapter(pilotSelection) {
  return (pilotSelection?.candidates ?? []).map((candidate) => ({
    adapterId: CORPUS_ADAPTER_ID,
    input: candidate.proposed_lemma,
    pos: candidate.proposed_pos ?? null,
    holds: corpusHolds(candidate),
    observedForms: (candidate.observed_surface_forms ?? []).map((form) => form.surface),
    evidence: [
      // Stable, bounded location ids (no paragraph text) so QA can re-find the hit.
      ...(candidate.evidence?.representative_hits ?? []).slice(0, 3).map((hit) => ({
        kind: 'corpus-paragraph',
        ref: `${hit.document_id}#${hit.paragraph_id}`,
      })),
      ...(candidate.observed_surface_forms ?? []).slice(0, 2).map((form) => ({ kind: 'corpus-surface', ref: form.surface })),
    ].slice(0, 5),
  }));
}
