/**
 * Product-gloss derivation (Issue #797). STDICT writes a reference to another headword with an editorial homograph
 * number (`‘슬슬02’`, `‘본가01「3」’`, `‘주다01[Ⅰ]「1」’`, `→ 까치발02.`). The number identifies the target for editors;
 * a reader of the product should see `‘슬슬’`. Canonical keeps the source gloss byte-for-byte; only the derived
 * meaning gloss drops the number.
 *
 * Grammar (a reference is recognised only in these two positions, never by scanning for digits):
 *   quoted reference : `‘` headword NN [`[`…`]`] [`「`n`」`] [`(`hanja`)`] `’`  — every quote span is scanned
 *   arrow reference  : gloss-initial `→ ` headword NN …
 * headword = optional `-`, Hangul words separated by single spaces; NN = exactly two digits not followed by a digit.
 * A reference is only rewritten when `(headword, NN)` is an actual `(lemma, homograph_no)` of the canonical corpus (affix
 * `-x` matches lemma `x`), so an unknown number (`‘슬슬99’`), a number followed by other text (`‘슬슬02형’`), quoted
 * non-reference text such as `‘제10대’` and every unquoted number (years, counts, units) stay untouched and are counted.
 */
const QUOTE = /‘([^’]*)’/gu;
// The number must end the token: end of the quoted span or a group `[…]`, sense number `「n」` or hanja `(…)`.
const REFERENCE = /(?<![가-힣\d])(-?[가-힣]+(?: [가-힣]+)*)(\d{2})(?=$|[[「(])/gu;
const ARROW_PREFIX = '→ ';

const pad2 = (value) => String(value).padStart(2, '0');
const indexKey = (lemma, number) => `${lemma}\u0000${number}`;

/** `(lemma, homograph_no)` evidence of the canonical corpus; a record without a homograph number has no evidence. */
export function homographLemmaIndex(records) {
  const index = new Set();
  for (const record of records) {
    if (Number.isInteger(record.homograph_no)) index.add(indexKey(record.lemma, pad2(record.homograph_no)));
  }
  return index;
}

const isHomograph = (index, headword, number) =>
  index.has(indexKey(headword, number)) || (headword.startsWith('-') && index.has(indexKey(headword.slice(1), number)));

function stripReferences(span, lemmas, counters) {
  return span.replace(REFERENCE, (whole, headword, number) => {
    if (!isHomograph(lemmas, headword, number)) {
      counters.unconfirmed += 1;
      return whole;
    }
    counters.stripped += 1;
    return headword;
  });
}

/**
 * @param {string} gloss one source gloss
 * @param {Set<string>} lemmas homograph evidence from {@link homographLemmaIndex}
 * @param {{ stripped: number, unconfirmed: number }} [counters] optional audit counters
 */
export function productGloss(gloss, lemmas, counters = { stripped: 0, unconfirmed: 0 }) {
  let head = '';
  let rest = gloss;
  if (gloss.startsWith(ARROW_PREFIX)) {
    // Only the reference token directly after the arrow, up to its terminating period (a trailing `「n」`/`[Ⅰ]`/`(hanja)` is kept).
    const match = /^→ (-?[가-힣]+(?: [가-힣]+)*\d{2})(?=[[「(.]|$)/u.exec(gloss);
    if (match) {
      head = `${ARROW_PREFIX}${stripReferences(match[1], lemmas, counters)}`;
      rest = gloss.slice(match[0].length);
    }
  }
  return head + rest.replace(QUOTE, (_whole, inner) => `‘${stripReferences(inner, lemmas, counters)}’`);
}
