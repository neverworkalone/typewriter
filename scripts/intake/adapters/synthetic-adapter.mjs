// Minimal second adapter: proves the shared stages need no other source.
// Accepts directly submitted words with no contextual evidence.
export const SYNTHETIC_ADAPTER_ID = 'synthetic-word-list';

export function syntheticAdapter(entries) {
  return entries.map((entry) => ({
    adapterId: SYNTHETIC_ADAPTER_ID,
    input: typeof entry === 'string' ? entry : entry.word,
    pos: typeof entry === 'string' ? null : entry.pos ?? null,
    evidence: [],
  }));
}
