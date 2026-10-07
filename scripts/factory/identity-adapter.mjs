import { runIntake } from '../intake/pipeline.mjs';
import { isLemmaRow } from './lemma-contract.mjs';

// Adapter between factory candidates (one `C…` id per usage) and the legacy shared
// intake, which keys by input+POS, merges same-key candidates and drops every
// already-canonical lemma as `covered` (design §10.1). The legacy contract is not
// changed (B05–B16 history stays intact): the adapter feeds it every candidate, which it merges per
// distinct input+POS only to share Kiwi analysis, then fans each result back out to
// every factory candidate, never passing `coveredLemmas`.

// Index of canonical entries by lemma: Map<lemma, [{id, posList, senses}]>.
export function buildCanonicalIndex(entries) {
  const byLemma = new Map();
  for (const entry of entries) {
    if (entry.record_type !== undefined && entry.record_type !== 'entry') continue;
    const list = byLemma.get(entry.lemma) ?? [];
    list.push({
      id: entry.id,
      senses: (entry.senses ?? []).map((sense) => ({ id: sense.id, pos: sense.pos, gloss: sense.gloss })),
    });
    byLemma.set(entry.lemma, list);
  }
  return byLemma;
}

// Where a candidate lands relative to canonical. Never `covered`: an existing lemma/POS
// still routes to Stage 2, which decides (and Stage 3 admits) any sense-level addition.
export function classifyAgainstCanonical(candidate, canonicalIndex) {
  const entries = canonicalIndex.get(candidate.input) ?? [];
  if (entries.length === 0) return { route: 'new_entry', existingEntryIds: [] };
  const sameLemmaPos = entries.filter((entry) => entry.senses.some((sense) => sense.pos === candidate.pos));
  if (sameLemmaPos.length === 0) {
    return { route: 'new_pos_on_existing_lemma', existingEntryIds: entries.map((entry) => entry.id) };
  }
  return { route: 'new_sense_on_existing_entry', existingEntryIds: sameLemmaPos.map((entry) => entry.id) };
}

// Legacy (input+POS) views of factory rows, for the shared intake and its hand-off. A v1 row is its
// own view. A lemma-centered v2 row yields one view per observation, so a hold stays attached to
// the observation that earned it and the shared intake still merges per input+POS for analysis.
export function candidateViews(rows) {
  return rows.flatMap((row) => {
    if (!isLemmaRow(row)) return [{ ...row, source_candidate_id: row.candidate_id }];
    const surfaceOf = new Map(row.forms.map((form) => [form.form_id, form.surface]));
    return row.observations.map((observation) => ({
      candidate_id: observation.observation_id,
      source_candidate_id: row.candidate_id,
      input: row.input,
      pos: observation.pos,
      group_id: observation.group_id,
      observedForms: [surfaceOf.get(observation.form_id)],
      evidence: [observation.evidence],
      holds: observation.holds,
    }));
  });
}

// Support of observed surface forms by the generated search forms (rows of the shared surface-form
// projection) and by the citation form itself: Map<record id, Set<form>>.
export function buildSearchFormSupport(projectionRows) {
  const support = new Map();
  for (const { record_id: id, form } of projectionRows) support.set(id, (support.get(id) ?? new Set()).add(form));
  return support;
}

const formSupported = (lemma, surface, entryIds, support) => surface === lemma || entryIds.some((id) => support.get(id)?.has(surface));

// Canonical comparison of a lemma candidate (issue #275), per POS hypothesis and per observed form.
// Stage 1 never concludes that a meaning is already covered from spelling or POS: every lemma stays
// a Stage 2 candidate, and `new_sense_on_existing_entry` means "possible new sense", not "covered".
// An unsupported form of an existing lemma is reported for the separate search/morphology
// coverage route (`unsupported_forms`); it never creates a canonical lexical entry.
export function classifyLemmaCandidate(row, canonicalIndex, support = new Map()) {
  const routes = row.pos_hypotheses.map((pos) => ({ pos, ...classifyAgainstCanonical({ input: row.input, pos }, canonicalIndex) }));
  const entryIds = [...new Set(routes.flatMap((route) => route.existingEntryIds))];
  const unsupportedForms = entryIds.length === 0 ? []
    : row.forms.map((form) => form.surface).filter((surface) => !formSupported(row.input, surface, entryIds, support));
  return { routes, unsupported_forms: unsupportedForms };
}

export const toRawCandidate = (candidate) => ({
  input: candidate.input,
  pos: candidate.pos,
  observedForms: candidate.observedForms,
  evidence: candidate.evidence,
  holds: candidate.holds,
});

const keyOf = (candidate) => `${candidate.input}\u0000${candidate.pos}`;

// What the legacy intake/hand-off sees. It merges same input+POS and unions their holds, so a
// held usage would hold every sibling. Held usages are therefore kept out of a key that also has
// a non-held usage (they stay explicit factory decisions); a key whose usages are all held is
// kept whole so the hold remains visible. Hold isolation is per candidate, analysis is shared.
export function intakeCandidates(candidates) {
  const hasUnheld = new Set(candidates.filter((candidate) => (candidate.holds ?? []).length === 0).map(keyOf));
  return candidates.filter((candidate) => (candidate.holds ?? []).length === 0 || !hasUnheld.has(keyOf(candidate)));
}

export async function runFactoryIntake({ candidates: rows, analyzer, canonicalIndex, adapterId = 'factory' }) {
  const candidates = candidateViews(rows);
  const ids = new Set(candidates.map((candidate) => candidate.candidate_id));
  if (ids.size !== candidates.length) throw new Error('factory candidates must have distinct candidate_id values');
  // runIntake merges same input+POS before analysis, so Kiwi runs once per key while
  // every `C…` identity is fanned back out below.
  const run = await runIntake({
    candidates: intakeCandidates(candidates).map(toRawCandidate),
    analyzer,
    adapterId,
  });
  const byKey = new Map(run.decisions.map((decision) => [decision.key, decision]));
  const results = candidates.map((candidate) => {
    const own = [...new Set(candidate.holds ?? [])].sort();
    // A candidate's own holds are never inherited by, or inherited from, another usage.
    const shared = own.length === 0 ? byKey.get(keyOf(candidate)) : undefined;
    const holds = own.length ? own : shared.holds;
    return {
      source_candidate_id: candidate.source_candidate_id,
      ...(candidate.source_candidate_id === candidate.candidate_id ? {} : { observation_id: candidate.candidate_id, group_id: candidate.group_id }),
      input: candidate.input,
      ...classifyAgainstCanonical(candidate, canonicalIndex),
      decision: holds.length ? 'hold' : shared.decision,
      holds,
      proposedPos: shared?.pos ?? shared?.proposedPos ?? null,
      analysisBinding: shared?.analysisBinding ?? null,
    };
  });
  return { analyzerDigest: run.analyzerDigest, metadata: run.metadata, results };
}
