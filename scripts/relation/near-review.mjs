import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCanonicalContext } from '../validate/canonical-context.mjs';
import { buildRelationIndex } from './candidate-retrieval.mjs';

// Read-only evidence for the editorial `near` judgment. It presents, for every `near` tuple, what a reviewer must read
// before keeping it: the bound source and target sense (lemma, part of speech, gloss), the link already authored in the
// opposite direction, and every other link authored from the same source sense. It makes no verdict and blocks nothing:
// whether two senses are close substitutes is an editorial decision, not something to derive mechanically.

const sense = (index, id) => {
  const entry = index.bySenseId.get(id);
  return entry ? { sense_id: id, lemma: entry.lemma, pos: entry.pos, gloss: entry.gloss } : { sense_id: id, missing: true };
};

/**
 * `tuples` are `{ source_sense_id, target_sense, type, note? }`. Links already in canonical are read from the index;
 * the other tuples of the same input count as siblings too, so a packet can be read before it is applied.
 */
export function nearReviewEvidence(index, tuples) {
  const fromInput = new Map();
  for (const tuple of tuples) {
    if (!fromInput.has(tuple.source_sense_id)) fromInput.set(tuple.source_sense_id, []);
    fromInput.get(tuple.source_sense_id).push(tuple);
  }
  const links = (sourceId) => {
    const merged = new Map();
    for (const relation of index.bySenseId.get(sourceId)?.relations ?? []) {
      if (relation.target_sense) merged.set(relation.target_sense, { target_sense: relation.target_sense, type: relation.type, note: relation.note });
    }
    for (const tuple of fromInput.get(sourceId) ?? []) merged.set(tuple.target_sense, { target_sense: tuple.target_sense, type: tuple.type, note: tuple.note });
    return merged;
  };
  return tuples.filter((tuple) => tuple.type === 'near').map((tuple) => {
    const reverse = links(tuple.target_sense).get(tuple.source_sense_id) ?? null;
    const siblings = [...links(tuple.source_sense_id).values()]
      .filter((link) => link.target_sense !== tuple.target_sense)
      .map((link) => ({ type: link.type, note: link.note, ...sense(index, link.target_sense) }));
    return {
      source: sense(index, tuple.source_sense_id),
      target: sense(index, tuple.target_sense),
      note: tuple.note ?? null,
      reverse: reverse ? { type: reverse.type, note: reverse.note } : null,
      siblings,
    };
  });
}

export function renderNearReview(evidence) {
  const line = (item) => `${item.lemma}[${item.pos}] ${item.gloss}`;
  return evidence.map((item) => [
    `${item.source.sense_id} → ${item.target.sense_id}`,
    `  source : ${line(item.source)}`,
    `  target : ${line(item.target)}`,
    `  reverse: ${item.reverse ? `${item.reverse.type} — ${item.reverse.note ?? ''}` : 'none'}`,
    ...item.siblings.map((sibling) => `  sibling: ${sibling.type} → ${sibling.sense_id} ${line(sibling)}`),
  ].join('\n')).join('\n\n');
}

export function tuplesFromPacket(packet) {
  return (packet.relation_amendments ?? []).map((item) => ({
    source_sense_id: item.source_sense_id, target_sense: item.relation.target_sense, type: item.relation.type, note: item.relation.note,
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Usage: node scripts/relation/near-review.mjs <packet.json> [--only <source_sense_id>[,<id>...]]
  const [packetPath, flag, only] = process.argv.slice(2);
  if (!packetPath) {
    console.error('usage: node scripts/relation/near-review.mjs <packet.json> [--only <source_sense_id>,...]');
    process.exit(1);
  }
  const packet = JSON.parse(await readFile(packetPath, 'utf8'));
  const index = buildRelationIndex(await loadCanonicalContext());
  let tuples = tuplesFromPacket(packet);
  const wanted = flag === '--only' && only ? new Set(only.split(',')) : null;
  const evidence = nearReviewEvidence(index, tuples).filter((item) => !wanted || wanted.has(item.source.sense_id));
  console.log(renderNearReview(evidence));
}
