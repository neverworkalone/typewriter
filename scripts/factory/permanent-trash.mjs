import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { validateUnresolved, isReferenceToken } from './lemma-contract.mjs';

export const COMPACT_CONTRACT = 'lexical-factory-candidate-manifest-v3';
export const TRASH_CONTRACT = 'lexical-factory-permanent-trash-v1';
export const TRASH_DIRECTORY = 'data/candidate-trash';
export const CHUNK_SIZE = 500;
export const digest = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value);
const same = (a, b) => json(a) === json(b);
const sha = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const tuple = (entry, snapshot) => [snapshot, entry.surface.normalize('NFC'), entry.evidence.kind,
  entry.evidence.ref, entry.extractor_hint?.lemma?.normalize('NFC') ?? null, entry.extractor_hint?.pos ?? null];
export const trashIdentity = (entry, snapshot) => tuple(entry, snapshot);
export const trashId = (entry, snapshot) => digest(json(tuple(entry, snapshot)));
export const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const chunkText = (rows) => rows.map(json).join('\n') + '\n';
export function unresolvedReferences(manifest) {
  return manifest.unresolved_observations.map(({ queue_id: queueId, ...observation }) => ({
    observation_id: trashId(observation, manifest.source_snapshot), analysis_sha256: digest(json(observation)), queue_id: queueId ?? null,
  }));
}

// The writer loads the archive once per transaction. Normal CI never calls this
// global reader to revalidate the past. Keeping the tuples catches hash collisions.
export async function loadTrash(root) {
  const chunks = new Map();
  let names;
  try { names = (await readdir(path.join(root, TRASH_DIRECTORY))).sort(); }
  catch (error) { if (error.code === 'ENOENT') return chunks; throw error; }
  for (const name of names) {
    if (!/^T\d{6}\.jsonl$/.test(name)) throw new Error(`unexpected trash file ${name}`);
    chunks.set(name, (await readFile(path.join(root, TRASH_DIRECTORY, name), 'utf8')).trimEnd().split('\n').filter(Boolean).map(JSON.parse));
  }
  return chunks;
}

export function trashIndex(chunks) {
  const index = new Map();
  for (const [file, rows] of chunks) for (const row of rows) {
    if (index.has(row.observation_id)) throw new Error(`duplicate archive identity ${row.observation_id}`);
    index.set(row.observation_id, { row, file });
  }
  return index;
}

export function mergeUnresolved(chunks, manifests) {
  const index = trashIndex(chunks);
  const changed = new Set();
  const references = new Map();
  const pending = new Map();
  for (const manifest of manifests) {
    const refs = [];
    for (const entry of manifest.unresolved_observations) {
      const identity = tuple(entry, manifest.source_snapshot);
      const id = digest(json(identity));
      let record = index.get(id)?.row ?? pending.get(id);
      if (!record) {
        record = { contract: TRASH_CONTRACT, observation_id: id, identity, variants: [] };
        pending.set(id, record);
      } else if (!same(record.identity, identity)) throw new Error(`trash identity hash collision ${id}`);
      const { queue_id: queueId, ...observation } = entry;
      const variantId = digest(json(observation));
      let variant = record.variants.find((item) => item.analysis_sha256 === variantId);
      if (variant && !same(variant.observation, observation)) throw new Error(`analysis hash collision ${variantId}`);
      if (!variant) {
        variant = { analysis_sha256: variantId, observation, occurrences: [] };
        record.variants.push(variant);
      }
      const occurrence = { batch_id: manifest.batch_id, queue_id: queueId ?? null };
      if (!variant.occurrences.some((item) => same(item, occurrence))) variant.occurrences.push(occurrence);
      variant.occurrences.sort((a, b) => json(a) < json(b) ? -1 : json(a) > json(b) ? 1 : 0);
      record.variants.sort((a, b) => a.analysis_sha256 < b.analysis_sha256 ? -1 : 1);
      if (index.has(id)) changed.add(index.get(id).file);
      refs.push({ observation_id: id, analysis_sha256: variantId, queue_id: queueId ?? null });
    }
    references.set(manifest.batch_id, refs);
  }
  let number = Math.max(0, ...[...chunks.keys()].map((name) => Number(name.slice(1, 7))));
  const additions = [...pending.values()].sort((a, b) => a.observation_id < b.observation_id ? -1 : 1);
  for (let offset = 0; offset < additions.length; offset += CHUNK_SIZE) {
    const file = `T${String(++number).padStart(6, '0')}.jsonl`;
    chunks.set(file, additions.slice(offset, offset + CHUNK_SIZE));
    changed.add(file);
  }
  return { chunks, references, changed };
}

export function compactManifest(manifest, references) {
  const { unresolved_observations: unresolved, excluded_observations: excluded, context_fallback: fallback, ...metadata } = manifest;
  const history = { batch_id: manifest.batch_id, unresolved: references,
    ...(excluded === undefined ? {} : { excluded_observations: excluded }),
    ...(fallback === undefined ? {} : { context_fallback: fallback }) };
  const decisions = { contract: 'lexical-factory-stage1-decisions-v1', batch_id: manifest.batch_id,
    ...(excluded === undefined ? {} : { excluded_observations: excluded }),
    ...(fallback === undefined ? {} : { context_fallback: fallback }) };
  const stage1DecisionsText = jsonText(decisions);
  const compact = { ...metadata, contract: COMPACT_CONTRACT,
    archive: { contract: TRASH_CONTRACT, unresolved_count: unresolved.length,
      unresolved_sha256: digest(json(unresolved)), excluded_count: excluded?.length ?? 0,
      context_decision_count: fallback?.decisions.length ?? 0 },
    stage1_decisions: { path: `data/candidates/${manifest.batch_id}/stage1-decisions.json`, sha256: digest(stage1DecisionsText) },
    ...(fallback === undefined ? {} : { context_fallback: { contract: fallback.contract,
      decisions_sha256: fallback.decisions_sha256, decision_count: fallback.decisions.length } }) };
  return { manifest: compact, history, stage1DecisionsText };
}

export function restoreManifest(compact, history, index) {
  const { archive, stage1_decisions: _decisions, context_fallback: _fallback, ...metadata } = compact;
  const unresolved = history.unresolved.map((ref) => {
    const row = index.get(ref.observation_id)?.row;
    const variant = row?.variants.find((item) => item.analysis_sha256 === ref.analysis_sha256);
    if (!variant || !variant.occurrences.some((item) => item.batch_id === history.batch_id && item.queue_id === ref.queue_id)) {
      throw new Error(`missing observation history ${history.batch_id}:${ref.observation_id}`);
    }
    return ref.queue_id === null ? { ...variant.observation } : { queue_id: ref.queue_id, ...variant.observation };
  });
  return { ...metadata, contract: 'lexical-factory-candidate-manifest-v2', unresolved_observations: unresolved,
    ...(history.excluded_observations === undefined ? {} : { excluded_observations: history.excluded_observations }),
    ...(history.context_fallback === undefined ? {} : { context_fallback: history.context_fallback }) };
}

export function validateTrashChunk(text) {
  const errors = [];
  let rows;
  try { rows = text.trimEnd().split('\n').filter(Boolean).map(JSON.parse); }
  catch { return ['trash must be valid JSONL']; }
  if (!rows.length || rows.length > CHUNK_SIZE) errors.push(`trash chunk must contain 1..${CHUNK_SIZE} observations`);
  const ids = new Set();
  for (const row of rows) {
    if (!plain(row) || Object.keys(row).sort().join() !== 'contract,identity,observation_id,variants'
      || row.contract !== TRASH_CONTRACT || !Array.isArray(row.identity) || row.identity.length !== 6
      || !sha(row.observation_id) || digest(json(row.identity)) !== row.observation_id) {
      errors.push('invalid trash identity'); continue;
    }
    if (ids.has(row.observation_id)) errors.push('duplicate observation in trash chunk');
    ids.add(row.observation_id);
    if (!Array.isArray(row.variants) || !row.variants.length) { errors.push('missing analysis history'); continue; }
    const variants = new Set();
    for (const variant of row.variants) {
      if (!plain(variant) || Object.keys(variant).sort().join() !== 'analysis_sha256,observation,occurrences'
        || !sha(variant.analysis_sha256) || digest(json(variant.observation)) !== variant.analysis_sha256
        || variants.has(variant.analysis_sha256)) { errors.push('invalid or repeated analysis history'); continue; }
      variants.add(variant.analysis_sha256);
      try { if (!same(tuple(variant.observation, row.identity[0]), row.identity)) errors.push('analysis history differs from observation identity'); }
      catch { errors.push('invalid source observation'); }
      if (!isReferenceToken(row.identity[0])) errors.push('source snapshot must be a bounded opaque reference');
      if (plain(variant.observation)) errors.push(...validateUnresolved([
        variant.observation.category === undefined ? variant.observation : { queue_id: 'U0001', ...variant.observation },
      ], variant.observation.category !== undefined));
      if (!Array.isArray(variant.occurrences) || !variant.occurrences.length
        || variant.occurrences.some((item) => !plain(item) || Object.keys(item).sort().join() !== 'batch_id,queue_id'
          || !/^C\d{6}$/.test(item.batch_id) || (item.queue_id !== null && typeof item.queue_id !== 'string'))
        || new Set(variant.occurrences.map(json)).size !== variant.occurrences.length) errors.push('invalid batch occurrence history');
    }
  }
  return errors;
}

// Validate the complete unresolved queue of one newly produced compact batch
// using only the rows of chunks created or modified by this transaction.
// A new batch cannot be referenced by an unchanged chunk: appending its
// occurrence necessarily changes the owning chunk.
export function validateArchivedUnresolved(manifest, entries) {
  const at = 'candidate ' + manifest.batch_id + ': ';
  const errors = [];
  const count = manifest.archive?.unresolved_count;
  if (!Number.isSafeInteger(count) || count < 0) return [at + 'invalid unresolved archive count'];
  const byQueue = new Map();
  for (const { row, variant, occurrence } of entries) {
    if (occurrence.batch_id !== manifest.batch_id) continue;
    const queueId = occurrence.queue_id;
    const match = typeof queueId === 'string' && /^U([1-9]\d*)$/u.exec(queueId.replace(/^U0+/u, 'U'));
    const index = match ? Number(match[1]) : 0;
    if (!Number.isSafeInteger(index) || index < 1 || index > count
      || queueId !== 'U' + String(index).padStart(4, '0')) {
      errors.push(at + 'invalid or out-of-range archive queue_id ' + String(queueId));
      continue;
    }
    if (row.identity[0] !== manifest.source_snapshot) {
      errors.push(at + 'archive source snapshot differs for ' + queueId);
    }
    if (byQueue.has(queueId)) {
      errors.push(at + 'duplicate archive queue_id ' + queueId);
      continue;
    }
    byQueue.set(queueId, { queue_id: queueId, ...variant.observation });
  }
  if (byQueue.size !== count) {
    errors.push(at + 'archive unresolved occurrence count ' + byQueue.size + ' differs from manifest ' + count);
    return errors;
  }

  // Every accepted queue ID is unique and in 1..count. If there are `count`
  // such IDs, that bounded set is necessarily contiguous; sort only observed
  // keys to restore the producer's original queue order for the digest.
  const unresolved = [...byQueue.entries()]
    .sort(([left], [right]) => Number(left.slice(1)) - Number(right.slice(1)))
    .map(([, observation]) => observation);
  if (digest(json(unresolved)) !== manifest.archive?.unresolved_sha256) {
    errors.push(at + 'archive unresolved observations digest differs from manifest');
  }
  return errors;
}

export function failedProposalLemmas(chunks) {
  return new Set([...chunks.values()].flatMap((rows) => rows.flatMap((row) => row.identity[4] ? [row.identity[4]] : [])));
}
