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

// Content words that only one of the two glosses contains. It is a rough surface comparison (whitespace tokens with a
// trailing particle removed; words that share their first two syllables count as the same word), meant to make an added
// or missing qualifier easy to see. The glosses decide, not this.
const TRAILING_PARTICLE = /(으로|에서|이나|이며|에는|이|가|은|는|을|를|의|에|로|와|과|도|고|며|서|나)$/u;
const contentWords = (text) => [...new Set(String(text ?? '').split(/[^0-9A-Za-z가-힣]+/u).filter(Boolean)
  .map((word) => { const stem = word.replace(TRAILING_PARTICLE, ''); return stem.length >= 2 ? stem : word; })
  .filter((word) => word.length >= 2))];
const sharesStem = (word, others) => others.some((other) => other.slice(0, 2) === word.slice(0, 2));
export function glossDelta(sourceGloss, targetGloss) {
  const source = contentWords(sourceGloss);
  const target = contentWords(targetGloss);
  return {
    only_in_source: source.filter((word) => !sharesStem(word, target)),
    only_in_target: target.filter((word) => !sharesStem(word, source)),
  };
}

// Words an authored note uses that its target gloss does not carry. A note that restates the target in its own words can put a
// meaning there that the target lacks: a word the note borrows from the SOURCE gloss ("없어진다" for a target glossed "약해지다")
// or a word found in neither gloss. Both are listed so the reader checks them against the target gloss. Common connective
// words of the note pattern are ignored, and a word counts as present when a gloss word starts with the same syllable,
// because conjugation changes the second syllable (원하다, 원한다).
const NOTE_FILLER = new Set(['거의', '같다', '가깝다', '가까우나', '가깝지만', '이라', '라서', '뜻이라', '뜻으로', '한다는', '하다는', '이어', '찾게', '한다', '쪽으로', '쪽을', '쪽이다', '않다', '않아', '같지', '않는다', '않고', '있다', '뜻과', '첫째', '둘째', '셋째', '뜻은', '표현이라', '같은', '느낌이라', '곳이라', '일이라', '쪽']);
export function noteWordsBeyondTarget(note, sourceGloss, targetGloss, sourceLemma, targetLemma) {
  const target = contentWords(`${targetGloss ?? ''} ${targetLemma ?? ''} ${sourceLemma ?? ''}`);
  const source = contentWords(sourceGloss);
  const has = (word, words) => words.some((other) => other[0] === word[0]);
  const beyond = contentWords(note).filter((word) => !NOTE_FILLER.has(word) && !has(word, target));
  return {
    from_source_gloss: beyond.filter((word) => has(word, source)),
    in_neither_gloss: beyond.filter((word) => !has(word, source)),
  };
}

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
  // Two groups need a reviewer's eye: every near tuple, and every association whose opposite link is an authored near,
  // because the same two senses then show different types depending on the direction a writer explores them from.
  const reviewed = tuples.map((tuple) => ({ tuple, reverse: links(tuple.target_sense).get(tuple.source_sense_id) ?? null }))
    .filter(({ tuple, reverse }) => tuple.type === 'near' || (tuple.type === 'association' && reverse?.type === 'near'));
  return reviewed.map(({ tuple, reverse }) => {
    const siblings = [...links(tuple.source_sense_id).values()]
      .filter((link) => link.target_sense !== tuple.target_sense)
      .map((link) => ({ type: link.type, note: link.note, ...sense(index, link.target_sense) }));
    return {
      kind: tuple.type === 'near' ? 'near' : 'association-against-reverse-near',
      source: sense(index, tuple.source_sense_id),
      target: sense(index, tuple.target_sense),
      note: tuple.note ?? null,
      note_beyond_target: noteWordsBeyondTarget(tuple.note, index.bySenseId.get(tuple.source_sense_id)?.gloss, index.bySenseId.get(tuple.target_sense)?.gloss, index.bySenseId.get(tuple.source_sense_id)?.lemma, index.bySenseId.get(tuple.target_sense)?.lemma),
      gloss_delta: glossDelta(index.bySenseId.get(tuple.source_sense_id)?.gloss, index.bySenseId.get(tuple.target_sense)?.gloss),
      reverse: reverse ? { type: reverse.type, note: reverse.note } : null,
      siblings,
    };
  });
}

export function renderNearReview(evidence) {
  const line = (item) => `${item.lemma}[${item.pos}] ${item.gloss}`;
  return evidence.map((item) => [
    `${item.source.sense_id} → ${item.target.sense_id}${item.kind === 'near' ? '' : '  [association against an authored reverse near]'}`,
    `  source : ${line(item.source)}`,
    `  target : ${line(item.target)}`,
    `  only in source gloss: ${item.gloss_delta.only_in_source.join(' ') || '-'}`,
    `  only in target gloss: ${item.gloss_delta.only_in_target.join(' ') || '-'}`,
    `  note   : ${item.note ?? 'none'}`,
    `  note words taken from the source gloss only (check them against the target gloss): ${item.note_beyond_target.from_source_gloss.join(' ') || '-'}`,
    `  note words found in neither gloss: ${item.note_beyond_target.in_neither_gloss.join(' ') || '-'}`,
    `  reverse: ${item.reverse ? `${item.reverse.type} — ${item.reverse.note ?? ''}` : 'none'}`,
    ...item.siblings.flatMap((sibling) => [
      `  sibling: ${sibling.type} → ${sibling.sense_id} ${line(sibling)}`,
      `           note: ${sibling.note ?? 'none'}`,
    ]),
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
