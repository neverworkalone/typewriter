import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Deterministic 표준국어대사전 (STDICT) JSON -> canonical record conversion.
 *
 * Identity contract (stable for every future shard):
 *   record id  = `w${target_code}` (zero-padded to 3 digits)
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

const SUPERSCRIPT = Object.freeze({ 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ' });
const SUBSCRIPT = Object.freeze({ 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎' });
const mapScript = (text, table) => {
  const chars = [...text];
  return chars.every((char) => Object.hasOwn(table, char)) ? chars.map((char) => table[char]).join('') : text;
};
// Markup STDICT embeds in `definition`: cross-reference ids, script markup, math emphasis and inline images.
const ID_TAGS = /<(each_sense_no|sense_no|ptrn_no)>[^<]*<\/\1>/gu;
const SUP_TAG = /<sup(?:\s[^>]*)?>([^<]*)<\/sup>/gu;
const SUB_TAG = /<sub(?:\s[^>]*)?>([^<]*)<\/sub>/gu;
const IMG_TAG = /<img(?:\s[^>]*)?>/gu;
const WRAP_TOKEN = /<\/?(I|i|l|equ|font)(?:\s[^>]*)?>/gu;
// A real tag is an ASCII name followed by whitespace, `/` or `>`; `<거미의 향연>` and `<Y의 비극>` are titles.
const ANY_TAG = /<\/?[A-Za-z_]+(?:[\s/][^>]*)?>/u;

/**
 * Plain-text gloss from a STDICT `definition`. Returns `markup` listing what was
 * removed or rewritten so the conversion report never hides it, and `unknownMarkup`
 * when a tag this contract does not know remains (the entry is then held).
 */
export function cleanDefinition(definition) {
  const markup = [];
  let text = definition;
  const note = (name) => markup.push(name);
  text = text.replace(ID_TAGS, (_, name) => { note(name); return ''; });
  text = text.replace(IMG_TAG, () => { note('img'); return ''; });
  // Emphasis tokens are stripped one by one: the source sometimes nests them badly (`<sup><I>n</sup></I>`) or leaves a
  // literal `<` inside (`<I>(x+1)<0</I>`), and only the text itself matters.
  text = text.replace(WRAP_TOKEN, (token, name) => { if (!token.startsWith('</')) note(name); return ''; });
  text = text.replace(SUP_TAG, (_, inner) => { note('sup'); return mapScript(inner, SUPERSCRIPT); });
  text = text.replace(SUB_TAG, (_, inner) => { note('sub'); return mapScript(inner, SUBSCRIPT); });
  text = text.replace(/&#x([0-9a-f]+);|&#(\d+);/giu, (_, hex, decimal) => {
    note('entity');
    return String.fromCodePoint(hex ? Number.parseInt(hex, 16) : Number(decimal));
  });
  text = text.replace(/\s+/gu, ' ').trim();
  return { text, markup, unknownMarkup: ANY_TAG.test(text) };
}

export function recordIdFor(targetCode) {
  // The canonical id pattern needs at least three digits; target_codes 1-99 are zero-padded.
  return `w${String(targetCode).padStart(3, '0')}`;
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
  const report = { relations: [], markup: [], unknownMarkup: [] };
  const senses = flat.map(({ sense, sourcePos }, position) => {
    const senseId = `${id}-s${position + 1}`;
    const cleaned = cleanDefinition(sense.definition);
    for (const name of cleaned.markup) report.markup.push({ sense: senseId, markup: name });
    if (cleaned.unknownMarkup) report.unknownMarkup.push(senseId);
    const converted = {
      id: senseId,
      pos: mapPos(sourcePos, info.word_unit),
      gloss: cleaned.text,
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
      source: 'stdict',
    },
    report,
  };
}

export function serializeRecord(record) {
  // Stable key order for byte-reproducible shards.
  const { id, record_type, role, candidate_id, lemma, search_forms, senses, source } = record;
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
    source,
  });
}
