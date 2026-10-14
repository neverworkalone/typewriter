import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Deterministic 표준국어대사전 (STDICT) JSON -> canonical record conversion.
 *
 * Identity contract (stable for every future shard):
 *   record id  = `w${target_code}`
 *   candidate  = record id (role `start` requires candidate_id === id)
 *   sense id   = `${record id}-s${n}`, n = 1-based position of the sense in
 *                source order (pos_info -> comm_pattern_info -> sense_info)
 *   sense_code = recoverable from the source by (target_code, n)
 */

export const STDICT_SHARD_SIZE = 1000;
export const STDICT_NOTES = Object.freeze({
  direct: '표준국어대사전 동의어',
  antonym: '표준국어대사전 반대말',
});

const RELATION_BY_SOURCE_TYPE = Object.freeze({
  동의어: 'direct',
  반대말: 'antonym',
});

/** STDICT `pos` -> canonical sense pos (owner decision D1 proposal; see docs). */
const POS_MAP = Object.freeze({
  명사: 'noun',
  '의존 명사': 'noun',
  대명사: 'noun',
  수사: 'noun',
  동사: 'verb',
  '보조 동사': 'verb',
  형용사: 'adjective',
  '보조 형용사': 'adjective',
  부사: 'adverb',
  관형사: 'determiner',
  감탄사: 'interjection',
  조사: 'particle',
  어미: 'ending',
  접사: 'affix',
});

export function mapPos(sourcePos, wordUnit) {
  if (wordUnit !== '단어') return 'expression';
  return POS_MAP[sourcePos] ?? 'unclassified';
}

export function recordIdFor(targetCode) {
  return `w${targetCode}`;
}

export function surfaceForms(word, wordUnit) {
  const homographFree = word.replace(/(?<=[^\d])\d{2}$/u, '');
  const lemmaSource = homographFree.normalize('NFC');
  const isExpression = wordUnit !== '단어';
  const spaced = lemmaSource.replace(/\^/gu, ' ').replace(/-/gu, '');
  const joined = lemmaSource.replace(/\^/gu, '').replace(/-/gu, '');
  const edgeHyphen = /^-|-$/u.test(lemmaSource);
  const lemma = edgeHyphen
    ? lemmaSource.replace(/\^/gu, '').replace(/(?<=.)-(?=.)/gu, '')
    : isExpression ? spaced : joined;
  const forms = [lemma];
  for (const form of [spaced, joined]) {
    if (form && !forms.includes(form)) forms.push(form);
  }
  return { lemma, search_forms: forms };
}

export function flattenSenses(item) {
  const senses = [];
  for (const posInfo of item.word_info.pos_info ?? []) {
    for (const pattern of posInfo.comm_pattern_info ?? []) {
      for (const sense of pattern.sense_info ?? []) {
        senses.push({ sense, sourcePos: posInfo.pos });
      }
    }
  }
  return senses;
}

/** Compact lookup used to bind lexical links by `sense_code` first. */
export function addToSenseIndex(index, item) {
  const targetCode = item.target_code;
  flattenSenses(item).forEach(({ sense }, position) => {
    index.senseByCode.set(Number(sense.sense_code), { targetCode, position });
  });
  index.targetCodes.add(targetCode);
}

export function createSenseIndex() {
  return { senseByCode: new Map(), targetCodes: new Set() };
}

export async function readStdictItems(directory, onItem) {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort(
    (left, right) => Number(left.match(/_(\d+)\.json$/u)?.[1]) - Number(right.match(/_(\d+)\.json$/u)?.[1]),
  );
  for (const file of files) {
    const parsed = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
    for (const item of parsed.channel.item) onItem(item, file);
  }
  return files;
}

/**
 * Convert one source entry. `isSelected(targetCode)` says whether a relation
 * target belongs to the shard being built; out-of-sample targets are reported
 * but never emitted.
 */
export function convertItem(item, { index, isSelected }) {
  const info = item.word_info;
  const targetCode = item.target_code;
  const id = recordIdFor(targetCode);
  const flat = flattenSenses(item);
  const report = { relations: [] };
  const senses = flat.map(({ sense, sourcePos }, position) => {
    const senseId = `${id}-s${position + 1}`;
    const converted = {
      id: senseId,
      pos: mapPos(sourcePos, info.word_unit),
      gloss: sense.definition.trim(),
    };
    const relations = [];
    const seen = new Set();
    for (const link of sense.lexical_info ?? []) {
      const type = RELATION_BY_SOURCE_TYPE[link.type];
      if (!type || link.unit !== '의미') continue;
      const code = Number(link.link_target_code);
      const resolved = index.senseByCode.get(code);
      const entry = { source_sense: senseId, source_type: link.type, link_target_code: String(link.link_target_code) };
      if (!resolved) {
        report.relations.push({ ...entry, status: index.targetCodes.has(code) ? 'target-code-only' : 'broken' });
        continue;
      }
      if (resolved.targetCode === targetCode) {
        report.relations.push({ ...entry, status: 'self' });
        continue;
      }
      if (!isSelected(resolved.targetCode)) {
        report.relations.push({ ...entry, status: 'out-of-sample' });
        continue;
      }
      const target = recordIdFor(resolved.targetCode);
      const targetSense = `${target}-s${resolved.position + 1}`;
      const key = `${type}\0${targetSense}`;
      if (seen.has(key)) {
        report.relations.push({ ...entry, status: 'duplicate' });
        continue;
      }
      seen.add(key);
      relations.push({ target, target_sense: targetSense, type, note: STDICT_NOTES[type] });
      report.relations.push({ ...entry, status: 'converted' });
    }
    if (relations.length > 0) converted.relations = relations;
    return converted;
  });
  return {
    record: {
      id,
      record_type: info.word_unit === '단어' ? 'entry' : 'expression',
      role: 'start',
      candidate_id: id,
      ...surfaceForms(info.word, info.word_unit),
      senses,
    },
    report,
  };
}

export function serializeRecord(record) {
  // Stable key order for byte-reproducible shards.
  const { id, record_type, role, candidate_id, lemma, search_forms, senses } = record;
  return JSON.stringify({
    id,
    record_type,
    role,
    candidate_id,
    lemma,
    search_forms,
    senses: senses.map(({ id: senseId, pos, gloss, relations }) => ({
      id: senseId,
      pos,
      gloss,
      ...(relations ? { relations: relations.map(({ target, target_sense, type, note }) => ({ target, target_sense, type, note })) } : {}),
    })),
  });
}
