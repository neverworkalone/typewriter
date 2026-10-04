import { runIntake } from '../intake/pipeline.mjs';

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
      senses: (entry.senses ?? []).map((sense) => ({ id: sense.id, pos: sense.pos })),
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

export async function runFactoryIntake({ candidates, analyzer, canonicalIndex, adapterId = 'factory' }) {
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
      source_candidate_id: candidate.candidate_id,
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
