import { createHash } from 'node:crypto';

// Source-neutral candidate contract (issue #249). Adapters produce these;
// shared stages consume only this shape and never import an adapter.
export const CANDIDATE_CONTRACT_VERSION = 1;
export const POS_VALUES = Object.freeze(['noun', 'verb', 'adjective']);
export const HOLD_REASONS = Object.freeze([
  'missing_lemma',
  'unresolved_pos',
  'invalid_input',
  'no_evidence',
  'analysis_ambiguous',
  'analysis_unsupported',
  'analysis_error',
  'analysis_mismatch',
  'analysis_stale',
  'analysis_missing',
  'lemma_mismatch',
  'pos_mismatch',
  'frame_not_verified',
]);

const KOREAN_WORD = /^[가-힣]{2,}$/u;
const MAX_EVIDENCE_REFERENCES = 5;
const MAX_OBSERVED_FORMS = 8;

export function normalizeText(value) {
  return typeof value === 'string' ? value.normalize('NFC').trim() : '';
}

export function digest(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// Deterministic identity: normalized input word + proposed POS ('' if unresolved).
export function candidateKey({ input, pos }) {
  return `${input}\u0000${pos ?? ''}`;
}

// Normalize an adapter-supplied raw candidate. Never throws: malformed input
// becomes an explicit hold so shared stages stay fail-closed.
export function normalizeCandidate(raw, { adapterId } = {}) {
  const holds = [];
  const input = normalizeText(raw?.input ?? raw?.word);
  if (!input) holds.push('missing_lemma');
  else if (!KOREAN_WORD.test(input)) holds.push('invalid_input');

  let pos = null;
  if (raw?.pos != null && raw.pos !== '') {
    if (POS_VALUES.includes(raw.pos)) pos = raw.pos;
    else holds.push('unresolved_pos');
  }

  const observedForms = [...new Set((raw?.observedForms ?? []).map(normalizeText).filter(Boolean))]
    .sort()
    .slice(0, MAX_OBSERVED_FORMS);
  const evidence = (raw?.evidence ?? [])
    .map((entry) => ({
      kind: normalizeText(entry?.kind),
      ref: normalizeText(entry?.ref),
      ...(normalizeText(entry?.text) ? { text: normalizeText(entry.text) } : {}),
    }))
    .filter((entry) => entry.kind && entry.ref)
    .slice(0, MAX_EVIDENCE_REFERENCES);

  return {
    contractVersion: CANDIDATE_CONTRACT_VERSION,
    adapterId: adapterId ?? normalizeText(raw?.adapterId),
    input,
    pos,
    observedForms,
    evidence,
    key: candidateKey({ input, pos }),
    holds: [...new Set(holds)].sort(),
  };
}

export function validateCandidate(candidate) {
  const errors = [];
  if (candidate?.contractVersion !== CANDIDATE_CONTRACT_VERSION) errors.push('contractVersion');
  if (!candidate?.adapterId) errors.push('adapterId');
  if (typeof candidate?.input !== 'string') errors.push('input');
  if (candidate?.pos != null && !POS_VALUES.includes(candidate.pos)) errors.push('pos');
  if (candidate?.key !== candidateKey({ input: candidate?.input, pos: candidate?.pos })) {
    errors.push('key');
  }
  for (const hold of candidate?.holds ?? []) {
    if (!HOLD_REASONS.includes(hold)) errors.push(`hold:${hold}`);
  }
  return errors;
}

// Merge duplicates by key: union of forms/evidence, sorted deterministically.
export function dedupeCandidates(candidates) {
  const merged = new Map();
  for (const candidate of candidates) {
    const existing = merged.get(candidate.key);
    if (!existing) {
      merged.set(candidate.key, { ...candidate, duplicateCount: 1 });
      continue;
    }
    existing.duplicateCount += 1;
    existing.observedForms = [...new Set([...existing.observedForms, ...candidate.observedForms])]
      .sort()
      .slice(0, MAX_OBSERVED_FORMS);
    existing.evidence = [...existing.evidence, ...candidate.evidence].slice(0, MAX_EVIDENCE_REFERENCES);
    existing.holds = [...new Set([...existing.holds, ...candidate.holds])].sort();
  }
  return [...merged.values()].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}
