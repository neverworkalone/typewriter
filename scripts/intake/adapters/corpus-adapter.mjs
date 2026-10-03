// CorpusAdapter: maps the bounded #201 pilot extraction output (local ignored
// artifact) onto the common candidate contract. Corpus-only fields (counts,
// document/source concentration, SQLite ids) stay out of the contract; only
// bounded evidence references are kept.
export const CORPUS_ADAPTER_ID = 'written-corpus-2025';

export function corpusAdapter(pilotSelection) {
  return (pilotSelection?.candidates ?? []).map((candidate) => ({
    adapterId: CORPUS_ADAPTER_ID,
    input: candidate.proposed_lemma,
    pos: candidate.proposed_pos ?? null,
    observedForms: (candidate.observed_surface_forms ?? []).map((form) => form.surface),
    evidence: (candidate.observed_surface_forms ?? [])
      .slice(0, 3)
      .map((form) => ({ kind: 'corpus-surface', ref: form.surface })),
  }));
}
