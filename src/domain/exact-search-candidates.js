import { compareMeaningRank } from '../runtime/meaning-ranking.js';

const isRankedMeaning = (sense) => Number.isInteger(sense?.lexical_relation_count);

export function expandExactSearchCandidates(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('Exact search records must be an array.');
  }

  const candidates = records.flatMap((record) => {
    if (!record || typeof record.id !== 'string') {
      throw new TypeError('Each exact search record must have an ID.');
    }
    const senses = Array.isArray(record.senses) ? record.senses : [];
    // 더보기 is decided once for the whole search (see projection `moreSenseIds`), also for single-meaning records.
    const moreSenseIds = new Set(record.moreSenseIds ?? []);
    if (senses.length > 1) {
      return senses.map((sense, senseIndex) => ({
        isMore: moreSenseIds.has(sense.id),
        key: `${record.id}:${sense.id}`,
        recordId: record.id,
        senseId: sense.id,
        record,
        sense,
        senseIndex,
        isSenseChoice: true,
      }));
    }

    const sense = senses[0] ?? null;
    return [{
      key: `${record.id}:${sense?.id || 'record'}`,
      recordId: record.id,
      senseId: sense?.id ?? null,
      record,
      sense,
      senseIndex: 0,
      isSenseChoice: false,
      isMore: sense !== null && moreSenseIds.has(sense.id),
    }];
  });
  // Meaning candidates are listed in the search-wide ranking order (compareMeaningRank), whichever record they
  // belong to; the record and its match are kept on each candidate. Raw-sense results keep their order.
  return candidates.every(({ sense }) => isRankedMeaning(sense))
    ? [...candidates].sort((left, right) => compareMeaningRank(left.sense, right.sense))
    : candidates;
}

/** The candidate selected first: the first default-view candidate, else the first candidate. */
export function defaultExactSearchCandidate(records) {
  const candidates = expandExactSearchCandidates(records);
  return candidates.find(({ isMore }) => !isMore) ?? candidates[0] ?? null;
}

const SENTENCE_TERMINATORS = new Set(['.', '!', '?', '。', '！', '？']);
const TRAILING_CLOSERS = new Set([')', ']', '}', '"', "'", '”', '’', '」', '』', '〉', '》', '）', '］']);
const OPENERS = new Map([
  ['(', ')'], ['[', ']'], ['{', '}'], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['〈', '〉'], ['《', '》'],
  ['（', '）'], ['［', '］'],
]);
const CLOSER_TO_OPENER = new Map([...OPENERS].map(([open, close]) => [close, open]));
// A '.' ending one of these tokens abbreviates a word and does not end the sentence.
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'etc', 'vs', 'cf', 'no', 'nos', 'ca', 'approx', 'fig', 'vol', 'dr', 'mr', 'mrs', 'ms', 'st', 'jr', 'sr',
]);

function isAbbreviationPeriod(text, index) {
  let start = index;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  const token = text.slice(start, index).replace(/^[([{"'“‘「『〈《（［]+/, '');
  if (token.length === 0) return false;
  // Ordinal/list notation such as "1." or "2)." is not a sentence end.
  if (/^제?\d+$/u.test(token)) return true;
  if (/^[A-Za-z]$/.test(token)) return true;
  return ABBREVIATIONS.has(token.toLowerCase());
}

/**
 * Display-only: the first complete sentence of a gloss, for the candidate picker.
 * A sentence ends at '.', '!' or '?' (plus any closing quotes/brackets) followed by whitespace or the end of
 * the text, outside any open bracket or quote, and not at a numbering/abbreviation period. Text without such a
 * boundary is returned whole (trimmed); the UI clips the width with CSS.
 */
export function firstSentence(text) {
  if (typeof text !== 'string') return '';
  const source = text.trim();
  const open = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      // Straight double quotes are their own opener and closer.
      if (open.at(-1) === char) open.pop();
      else open.push(char);
      continue;
    }
    if (char === "'") {
      // ASCII single quotes also serve as apostrophes: only a quote at a word start opens, and only one
      // not followed by a letter/digit closes. Anything else (don't, dogs') is ignored.
      const before = source[index - 1];
      const after = source[index + 1];
      if (open.at(-1) === char && !(after && /[\p{L}\p{N}]/u.test(after))) {
        // Inside a quote, an ASCII letter followed by ' + space is either a closing quote or a possessive
        // (dogs' bones). That cannot be decided here, so fail closed: keep the whole text, CSS clips it.
        if (before && /[A-Za-z]/.test(before)) return source;
        open.pop();
      } else if ((before === undefined || /[\s([{“‘「『]/u.test(before)) && after && !/\s/.test(after)) {
        open.push(char);
      }
      continue;
    }
    if (OPENERS.has(char)) {
      open.push(char);
      continue;
    }
    if (CLOSER_TO_OPENER.has(char)) {
      const position = open.lastIndexOf(CLOSER_TO_OPENER.get(char));
      if (position !== -1) open.length = position;
      continue;
    }
    if (!SENTENCE_TERMINATORS.has(char) || open.length > 0) continue;

    let end = index + 1;
    while (end < source.length && (SENTENCE_TERMINATORS.has(source[end]) || TRAILING_CLOSERS.has(source[end]))) {
      end += 1;
    }
    if (end < source.length && !/\s/.test(source[end])) continue;
    if (char === '.' && end === index + 1 && isAbbreviationPeriod(source, index)) continue;
    // Nothing to show before the terminator (e.g. "..."-only text): keep the whole text.
    if (!/[^\s.!?。！？]/.test(source.slice(0, index))) continue;
    return source.slice(0, end);
  }
  return source;
}
