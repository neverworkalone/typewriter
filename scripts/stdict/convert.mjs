import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { classifySense, normalizeWordKey } from './policy.mjs';

/**
 * Deterministic 표준국어대사전 (STDICT) JSON -> canonical record conversion.
 *
 * Identity contract (stable for every future shard):
 *   record id  = `w${target_code}` (zero-padded to 3 digits)
 *   candidate  = record id (role `start` requires candidate_id === id)
 *   sense id   = `${record id}-s${n}`, n = 1-based position of the sense in
 *                source order (pos_info -> comm_pattern_info -> sense_info);
 *                a sense removed by the inclusion policy leaves a gap, never a renumbering
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

const WORD_UNITS = new Set(['단어', '구', '속담', '관용구']);
/** Source value of a word that carries no part of speech. */
const NO_POS = new Set([undefined, null, '', '품사 없음']);

/**
 * Canonical POS for a source POS. A word with no POS becomes `unclassified`; an explicit POS this contract does not
 * know, or an unknown word unit, returns `null` so the entry is held instead of being silently reclassified.
 */
export function mapPos(sourcePos, wordUnit) {
  if (!WORD_UNITS.has(wordUnit)) return null;
  if (wordUnit !== '단어') return 'expression';
  if (NO_POS.has(sourcePos)) return 'unclassified';
  return POS_MAP[sourcePos] ?? null;
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
// A subscript and a superscript source-crossed (`<sub>2<sup></sub>+</sup>`) read as sub(`2`) followed by sup(`+`).
const CROSSED_SUB_SUP = /<sub(?:\s[^>]*)?>([^<]*)<sup(?:\s[^>]*)?><\/sub>([^<]*)<\/sup>/gu;
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
  text = text.replace(CROSSED_SUB_SUP, (_, below, above) => { note('sub'); note('sup'); return mapScript(below, SUBSCRIPT) + mapScript(above, SUPERSCRIPT); });
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

/**
 * Compact lookup used to bind lexical links by `sense_code` first. Every sense keeps its original source position
 * (`position`) and its policy verdict (`include`): filtering never renumbers, so `-s<n>` and `sense_code` stay aligned.
 */
export function addToSenseIndex(index, item) {
  const targetCode = item.target_code;
  const { word, word_unit: wordUnit } = item.word_info;
  const entry = { included: 0, held: false };
  flattenSenses(item).forEach(({ sense, sourcePos }, position) => {
    const verdict = classifySense({ word, wordUnit, sourcePos, definition: sense.definition });
    index.senseByCode.set(Number(sense.sense_code), { targetCode, position, include: verdict.include });
    if (verdict.include) entry.included += 1;
    if (verdict.include && verdict.hold) entry.held = true;
    if (verdict.rootTarget) index.roots.push({ targetCode, word, rootTarget: verdict.rootTarget });
  });
  index.targetCodes.add(targetCode);
  index.entries.set(targetCode, entry);
  if (wordUnit === '단어') {
    const key = normalizeWordKey(word);
    const codes = index.wordIndex.get(key);
    if (codes) codes.push(targetCode);
    else index.wordIndex.set(key, [targetCode]);
  }
}

export function createSenseIndex() {
  return {
    senseByCode: new Map(),
    targetCodes: new Set(),
    entries: new Map(),
    wordIndex: new Map(),
    roots: [],
    aliasesByTarget: new Map(),
    rootReport: [],
  };
}

/**
 * Root senses are not entries of their own; each becomes a search alias of the one complete word its official
 * definition names. The target is matched against the source word including its homograph number and is only linked
 * when that is unambiguous, differs from the root itself, and keeps at least one included sense. Everything else is
 * counted by reason and never guessed.
 */
export function finalizeSenseIndex(index) {
  index.aliasesByTarget = new Map();
  index.rootReport = [];
  for (const root of index.roots) {
    const hits = index.wordIndex.get(normalizeWordKey(root.rootTarget)) ?? [];
    const target = hits.length === 1 ? hits[0] : null;
    const entry = target === null ? null : index.entries.get(target);
    const status = hits.length === 0 ? 'no-target'
      : hits.length > 1 ? 'ambiguous'
        : target === root.targetCode ? 'self'
          : !entry.included || entry.held ? 'target-excluded' : 'resolved';
    index.rootReport.push({ target_code: root.targetCode, status });
    if (status !== 'resolved') continue;
    const forms = index.aliasesByTarget.get(target) ?? [];
    const alias = surfaceForms(root.word, '단어').lemma;
    if (!forms.includes(alias)) forms.push(alias);
    index.aliasesByTarget.set(target, forms);
  }
  return index;
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
  const report = { relations: [], markup: [], unknownMarkup: [], unsupportedPos: [], excluded: [] };
  const senses = [];
  flat.forEach(({ sense, sourcePos }, position) => {
    const senseId = `${id}-s${position + 1}`;
    const verdict = classifySense({ word: info.word, wordUnit: info.word_unit, sourcePos, definition: sense.definition });
    if (!verdict.include) {
      report.excluded.push({ sense: senseId, reason: verdict.reason });
      return;
    }
    const cleaned = cleanDefinition(sense.definition);
    for (const name of cleaned.markup) report.markup.push({ sense: senseId, markup: name });
    if (cleaned.unknownMarkup) report.unknownMarkup.push(senseId);
    const pos = mapPos(sourcePos, info.word_unit);
    if (pos === null) report.unsupportedPos.push({ sense: senseId, pos: sourcePos ?? null, word_unit: info.word_unit });
    const converted = {
      id: senseId,
      pos: pos ?? 'unclassified',
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
      // A policy-excluded target sense (or entry) is a decided absence, distinct from a target that simply has not
      // been loaded yet and from a source link that never resolved.
      const targetEntry = index.entries.get(resolved.targetCode);
      if (!resolved.include || !targetEntry || targetEntry.included === 0) {
        report.relations.push({ ...entry, status: 'policy-excluded' });
        continue;
      }
      if (targetEntry.held) {
        report.relations.push({ ...entry, status: 'held-target' });
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
    senses.push(converted);
  });
  if (senses.length === 0) return { record: null, report };
  const forms = surfaceForms(info.word, info.word_unit);
  const aliases = (index.aliasesByTarget?.get(targetCode) ?? []).filter((alias) => !forms.search_forms.includes(alias));
  return {
    record: {
      id,
      record_type: info.word_unit === '단어' ? 'entry' : 'expression',
      role: 'start',
      candidate_id: id,
      lemma: forms.lemma,
      search_forms: [...forms.search_forms, ...aliases],
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
