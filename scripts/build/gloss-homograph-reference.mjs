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
 * A reference is only rewritten when its headword is a lemma of the canonical corpus (affix `-x` matches lemma `x`),
 * so quoted non-reference text such as `‘제10대’` and every unquoted number (years, counts, units) stays untouched.
 */
const QUOTE = /‘([^’]*)’/gu;
const REFERENCE = /(?<![가-힣\d])(-?[가-힣]+(?: [가-힣]+)*)(\d{2})(?!\d)/gu;
const ARROW_PREFIX = '→ ';

/** Lemma set used to confirm that a numbered headword really is a canonical headword. */
export function homographLemmaIndex(records) {
  const lemmas = new Set();
  for (const record of records) lemmas.add(record.lemma);
  return lemmas;
}

const isHeadword = (lemmas, headword) => lemmas.has(headword.startsWith('-') ? headword.slice(1) : headword);

function stripReferences(span, lemmas, counters) {
  return span.replace(REFERENCE, (whole, headword) => {
    if (!isHeadword(lemmas, headword)) {
      counters.unconfirmed += 1;
      return whole;
    }
    counters.stripped += 1;
    return headword;
  });
}

/**
 * @param {string} gloss one source gloss
 * @param {Set<string>} lemmas from {@link homographLemmaIndex}
 * @param {{ stripped: number, unconfirmed: number }} [counters] optional audit counters
 */
export function productGloss(gloss, lemmas, counters = { stripped: 0, unconfirmed: 0 }) {
  let head = '';
  let rest = gloss;
  if (gloss.startsWith(ARROW_PREFIX)) {
    // Only the reference token directly after the arrow, up to its terminating period (a trailing `「n」`/`[Ⅰ]`/`(hanja)` is kept).
    const match = /^→ (-?[가-힣]+(?: [가-힣]+)*\d{2})(?!\d)/u.exec(gloss);
    if (match) {
      head = `${ARROW_PREFIX}${stripReferences(match[1], lemmas, counters)}`;
      rest = gloss.slice(match[0].length);
    }
  }
  return head + rest.replace(QUOTE, (_whole, inner) => `‘${stripReferences(inner, lemmas, counters)}’`);
}
