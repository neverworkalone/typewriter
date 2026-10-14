import { cleanDefinition, mapPos } from './convert.mjs';

/**
 * Owner inclusion policy (Issue #678) applied per source sense, never per `target_code`.
 *
 *   include  nouns/verbs/adjectives/adverbs/determiners/interjections, phrases/proverbs/idioms, and independent
 *            words without a part of speech (`unclassified`)
 *   exclude  the meaning of a particle, ending or affix; a POS-less root (`‘…하다’의 어근.`, searched through the
 *            complete word instead); a POS-less bound form written with an edge `-`
 */
export const EXCLUDED_POS = Object.freeze({ 조사: 'particle', 어미: 'ending', 접사: 'affix' });
const NO_POS = new Set([undefined, null, '', '품사 없음']);
const ROOT_DEFINITION = /^‘([^’]+?)(?:「\d+」)?’의 어근\.$/u;

export const normalizeWordKey = (word) => word.replace(/[-^]/gu, '');

/**
 * Verdict for one source sense: `{ include, reason?, hold?, rootTarget? }`.
 * `hold` marks a sense this contract cannot convert faithfully (explicit unsupported POS, unknown markup): the entry
 * is held instead of being silently reclassified or truncated.
 */
export function classifySense({ word, wordUnit, sourcePos, definition }) {
  if (wordUnit === '단어') {
    if (Object.hasOwn(EXCLUDED_POS, sourcePos)) return { include: false, reason: EXCLUDED_POS[sourcePos] };
    if (NO_POS.has(sourcePos)) {
      const root = ROOT_DEFINITION.exec(cleanDefinition(definition).text);
      if (root) return { include: false, reason: 'root', rootTarget: root[1] };
      if (/^-|-$/u.test(word)) return { include: false, reason: 'bound-form' };
    }
  }
  if (mapPos(sourcePos, wordUnit) === null) return { include: true, hold: 'unsupported-pos' };
  if (cleanDefinition(definition).unknownMarkup) return { include: true, hold: 'unknown-markup' };
  return { include: true };
}
