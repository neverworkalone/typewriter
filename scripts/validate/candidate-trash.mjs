import { createHash } from 'node:crypto';

export const TRASH_CONTRACT = 'lexical-factory-permanent-trash-v1';
export const TRASH_DIRECTORY = 'data/candidate-trash';
export const CHUNK_SIZE = 500;

const digest = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value);
const same = (left, right) => json(left) === json(right);
const sha = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const tuple = (entry, snapshot) => [snapshot, entry.surface.normalize('NFC'), entry.evidence.kind,
  entry.evidence.ref, entry.extractor_hint?.lemma?.normalize('NFC') ?? null, entry.extractor_hint?.pos ?? null];

const SURFACE_TOKEN = /^[\p{L}\p{N}\-·]{1,24}$/u;
const REFERENCE_TOKEN = /^[^\s\p{C}]{1,200}$/u;
const isSurfaceToken = (value) => typeof value === 'string' && SURFACE_TOKEN.test(value);
const isReferenceToken = (value) => typeof value === 'string' && REFERENCE_TOKEN.test(value);
const UNRESOLVED_HOLDS = new Set(['analysis_missing', 'analysis_stale', 'analysis_error', 'analysis_unsupported']);
const HOLD_REASONS = new Set([
  'missing_lemma', 'unresolved_pos', 'invalid_input', 'no_evidence', 'analysis_ambiguous', 'coverage_collision',
  'analysis_unsupported', 'analysis_error', 'analysis_mismatch', 'analysis_stale', 'analysis_missing',
  'lemma_mismatch', 'pos_mismatch', 'frame_not_verified',
]);
const POS_VALUES = new Set(['noun', 'verb', 'adjective', 'adverb']);
const ENSEMBLE_REASONS = new Set([
  'three_way_agreement', 'kiwi_alternative_supported', 'one_vs_two_disagreement', 'kiwi_isolated_pair', 'all_three_differ',
  'kiwi_unsupported_rival', 'segmentation_incompatible', 'no_single_target_morpheme', 'extractor_hint_mismatch',
  'unsupported_lemma_shape', 'kiwi_unusable', 'khaiii_unusable', 'mecab_unusable', 'kiwi_reported_ambiguous',
  'khaiii_reported_ambiguous', 'mecab_reported_ambiguous',
]);
const SUPPORTERS = new Set(['kiwi_alt', 'kiwi_top', 'khaiii', 'mecab']);
const QUEUE_STATES = new Set(['needs_verification', 'truth_unknown', 'blocked']);
const QUEUE_KEYS = ['queue_id', 'surface', 'evidence', 'holds', 'category', 'reasons', 'hypotheses', 'extractor_hint', 'extractor_holds',
  'observation_digest', 'trace_digest', 'verification'];
const sortedUnique = (values) => [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const keysAre = (value, keys) => plain(value) && Object.keys(value).sort().join() === [...keys].sort().join();

function validateQueueEntry(entry, index) {
  const at = `candidate manifest: unresolved_observations[${index}]`;
  const errors = [];
  if (!keysAre(entry, QUEUE_KEYS)) return [`${at} must use the permanent unresolved queue shape`];
  if (entry.queue_id !== `U${String(index + 1).padStart(4, '0')}`) errors.push(`${at}: queue_id is out of order`);
  if (!isSurfaceToken(entry.surface)) errors.push(`${at}: surface must be a bounded word form`);
  if (!keysAre(entry.evidence, ['kind', 'ref']) || !isReferenceToken(entry.evidence.kind) || !isReferenceToken(entry.evidence.ref)) {
    errors.push(`${at}: evidence must be a bounded text-free reference`);
  }
  if (!Array.isArray(entry.holds) || entry.holds.length === 0
    || entry.holds.some((hold) => !UNRESOLVED_HOLDS.has(hold) && hold !== 'analysis_ambiguous')) {
    errors.push(`${at}: holds must name unresolved analysis reasons`);
  }
  if (!['conflicted', 'unsupported_or_unknown'].includes(entry.category)) errors.push(`${at}: category is invalid`);
  if (!Array.isArray(entry.reasons) || entry.reasons.length === 0
    || entry.reasons.some((reason) => !ENSEMBLE_REASONS.has(reason))
    || !same(sortedUnique(entry.reasons), entry.reasons)) errors.push(`${at}: reasons must be sorted known reason codes`);
  if (!Array.isArray(entry.hypotheses)) errors.push(`${at}: hypotheses must be an array`);
  else {
    const identities = new Set();
    for (const hypothesis of entry.hypotheses) {
      if (!keysAre(hypothesis, ['lemma', 'pos', 'supporters']) || !/^[가-힣]+$/u.test(String(hypothesis.lemma))
        || !POS_VALUES.has(hypothesis.pos) || !Array.isArray(hypothesis.supporters) || hypothesis.supporters.length === 0
        || hypothesis.supporters.some((supporter) => !SUPPORTERS.has(supporter))
        || !same(sortedUnique(hypothesis.supporters), hypothesis.supporters)) {
        errors.push(`${at}: each hypothesis must bind a Korean lemma, POS, and sorted supporters`);
        continue;
      }
      const identity = `${hypothesis.lemma}\u0000${hypothesis.pos}`;
      if (identities.has(identity)) errors.push(`${at}: hypotheses repeat a lemma/POS`);
      identities.add(identity);
    }
    const ordered = [...entry.hypotheses].sort((left, right) => compare(left.lemma, right.lemma) || compare(left.pos, right.pos));
    if (!same(ordered, entry.hypotheses)) errors.push(`${at}: hypotheses must be ordered by lemma then POS`);
  }
  if (!keysAre(entry.extractor_hint, ['lemma', 'pos'])) errors.push(`${at}: extractor_hint must contain lemma and POS`);
  if (!Array.isArray(entry.extractor_holds) || entry.extractor_holds.some((hold) => !HOLD_REASONS.has(hold))) {
    errors.push(`${at}: extractor_holds must contain known hold reasons`);
  }
  for (const key of ['observation_digest', 'trace_digest']) if (!sha(entry[key])) errors.push(`${at}: ${key} must be a SHA-256 digest`);
  const verification = entry.verification;
  if (!plain(verification) || !QUEUE_STATES.has(verification.state)) errors.push(`${at}: verification state is invalid`);
  else if (verification.state === 'blocked') {
    const blockers = [...new Set([
      ...(entry.extractor_holds ?? []).filter((hold) => hold !== 'analysis_ambiguous'),
      ...(entry.evidence?.kind === 'corpus-paragraph' && /^[^#\s]+#[^#\s]+$/u.test(String(entry.evidence?.ref)) ? [] : ['no_located_source']),
    ])].sort();
    if (!same(verification.blocked_by, blockers) || blockers.length === 0 || verification.decision_id !== undefined) {
      errors.push(`${at}: blocked verification must record its exact blockers`);
    }
  } else if (verification.state === 'truth_unknown') {
    if (typeof verification.decision_id !== 'string' || verification.blocked_by !== undefined) errors.push(`${at}: truth_unknown must name its decision`);
  } else if (verification.decision_id !== undefined || verification.blocked_by !== undefined) {
    errors.push(`${at}: needs_verification has no decision or blockers`);
  }
  return errors;
}

function validateUnresolved(observation) {
  if (!plain(observation)) return ['trash observation must be an object'];
  if (observation.category !== undefined) return validateQueueEntry({ queue_id: 'U0001', ...observation }, 0);
  const errors = [];
  if (Object.keys(observation).some((key) => !['surface', 'evidence', 'holds'].includes(key))) errors.push('trash observation has unknown fields');
  if (!isSurfaceToken(observation.surface)) errors.push('trash observation surface must be a bounded word form');
  if (!keysAre(observation.evidence, ['kind', 'ref']) || !isReferenceToken(observation.evidence.kind) || !isReferenceToken(observation.evidence.ref)) {
    errors.push('trash observation evidence must be a bounded text-free reference');
  }
  if (!Array.isArray(observation.holds) || observation.holds.length === 0
    || observation.holds.some((hold) => !UNRESOLVED_HOLDS.has(hold))) errors.push('trash observation holds must name unresolved analysis reasons');
  return errors;
}

/** Validate one changed archive chunk before it is admitted through the Normal gate. */
export function validateTrashChunk(text) {
  const errors = [];
  let rows;
  try { rows = text.trimEnd().split('\n').filter(Boolean).map(JSON.parse); }
  catch { return ['trash must be valid JSONL']; }
  if (!rows.length || rows.length > CHUNK_SIZE) errors.push(`trash chunk must contain 1..${CHUNK_SIZE} observations`);
  const ids = new Set();
  for (const row of rows) {
    if (!keysAre(row, ['contract', 'identity', 'observation_id', 'variants']) || row.contract !== TRASH_CONTRACT
      || !Array.isArray(row.identity) || row.identity.length !== 6 || !sha(row.observation_id)
      || digest(json(row.identity)) !== row.observation_id) {
      errors.push('invalid trash identity');
      continue;
    }
    if (ids.has(row.observation_id)) errors.push('duplicate observation in trash chunk');
    ids.add(row.observation_id);
    if (!Array.isArray(row.variants) || row.variants.length === 0) { errors.push('missing analysis history'); continue; }
    const variants = new Set();
    for (const variant of row.variants) {
      if (!keysAre(variant, ['analysis_sha256', 'observation', 'occurrences']) || !sha(variant.analysis_sha256)
        || digest(json(variant.observation)) !== variant.analysis_sha256 || variants.has(variant.analysis_sha256)) {
        errors.push('invalid or repeated analysis history');
        continue;
      }
      variants.add(variant.analysis_sha256);
      try {
        if (!same(tuple(variant.observation, row.identity[0]), row.identity)) errors.push('analysis history differs from observation identity');
      } catch { errors.push('invalid source observation'); }
      if (!isReferenceToken(row.identity[0])) errors.push('source snapshot must be a bounded opaque reference');
      errors.push(...validateUnresolved(variant.observation));
      if (!Array.isArray(variant.occurrences) || variant.occurrences.length === 0
        || variant.occurrences.some((item) => !keysAre(item, ['batch_id', 'queue_id'])
          || !/^C\d{6}$/u.test(item.batch_id) || (item.queue_id !== null && typeof item.queue_id !== 'string'))
        || new Set(variant.occurrences.map(json)).size !== variant.occurrences.length) errors.push('invalid batch occurrence history');
    }
  }
  return errors;
}
