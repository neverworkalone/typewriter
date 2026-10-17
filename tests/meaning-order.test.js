import { describe, expect, it } from 'vitest';

import { projectSearchResults } from '../src/domain/projection.js';
import {
  defaultExactSearchCandidate,
  expandExactSearchCandidates,
} from '../src/domain/exact-search-candidates.js';
import {
  compareMeaningIds,
  compareMeaningOrder,
  partitionCandidates,
} from '../src/runtime/meaning-order.js';

const meaning = (id, homographNo = null) => ({ id, homograph_no: homographNo });
const ids = (list) => list.map(({ id }) => id);

describe('meaning order', () => {
  it('orders meaning IDs numerically, not as text', () => {
    expect(['m1000', 'm443_2', 'm443', 'm443_10', 'm97'].sort(compareMeaningIds))
      .toEqual(['m97', 'm443', 'm443_2', 'm443_10', 'm1000']);
  });

  it('is a total order over leading zeros, unbounded integers and ordinals', () => {
    expect(compareMeaningIds('m09', 'm9')).toBeLessThan(0);
    expect(compareMeaningIds('m9', 'm09')).toBeGreaterThan(0);
    expect(compareMeaningIds('m1_1000001', 'm2')).toBeLessThan(0);
    expect(compareMeaningIds(`m${'9'.repeat(30)}`, `m1${'0'.repeat(30)}`)).toBeLessThan(0);
    expect(compareMeaningIds('m5', 'm5')).toBe(0);
  });

  it('follows the STDICT homograph number before the ID, unnumbered meanings last', () => {
    const input = [meaning('m1'), meaning('m50', 1), meaning('m9', 3), meaning('m7', 2), meaning('m3')];
    expect(ids([...input].sort(compareMeaningOrder))).toEqual(['m50', 'm7', 'm9', 'm1', 'm3']);
    expect(ids([...input].reverse().sort(compareMeaningOrder))).toEqual(['m50', 'm7', 'm9', 'm1', 'm3']);
    // Equal numbers (different headwords of one lemma) fall back to the ID.
    expect(ids([meaning('m20', 1), meaning('m4', 1)].sort(compareMeaningOrder))).toEqual(['m4', 'm20']);
  });

  it.each([0, 1, 2, 3, 4, 5, 32])('splits %i candidates into the first three and all the rest', (count) => {
    const input = Array.from({ length: count }, (_, index) => meaning(`m${index + 1}`));
    const { primary, more } = partitionCandidates(input);
    expect(primary).toEqual(input.slice(0, 3));
    expect([...primary, ...more]).toEqual(input);
  });
});

describe('default view across one search', () => {
  const sense = (id, homographNo = null) => ({
    id, pos: 'noun', gloss: `${id} 뜻`, relations: [], homograph_no: homographNo, sense_ids: [`${id}-s`],
  });
  const record = (id, lemma, senses) => ({
    id, view: 'meaning', record_type: 'entry', role: 'start', candidate_id: id, lemma, search_forms: ['공통'], senses,
  });
  const search = (records) => {
    const results = projectSearchResults(records, records.map(({ id }) => ({ id, match: { kind: 'exact-search-form' } })));
    const candidates = expandExactSearchCandidates(results);
    return {
      results,
      shown: candidates.filter(({ isMore }) => !isMore).map(({ senseId }) => senseId),
      more: candidates.filter(({ isMore }) => isMore).map(({ senseId }) => senseId),
    };
  };

  it('lists one lemma in STDICT order and shows three, whatever the relations or the record order', () => {
    const records = [
      record('w010', '가', [sense('m1', 5), sense('m2', 4)]),
      record('w011', '가', [sense('m3', 3), sense('m4', 2), sense('m5', 1)]),
    ];
    const forward = search(records);
    expect(forward.shown).toEqual(['m5', 'm4', 'm3']);
    expect(forward.more).toEqual(['m2', 'm1']);
    expect(defaultExactSearchCandidate(forward.results).senseId).toBe('m5');
    const reversed = search([...records].reverse());
    expect([reversed.shown, reversed.more]).toEqual([forward.shown, forward.more]);
  });

  it('keeps the match order of different lemmas and orders each lemma by STDICT order', () => {
    const { shown, more } = search([
      record('w020', '나', [sense('m20_2', 2), sense('m20_1', 1)]),
      record('w010', '가', [sense('m10')]),
    ]);
    expect(shown).toEqual(['m20_1', 'm20_2', 'm10']);
    expect(more).toEqual([]);
  });

  it('starts on the first candidate and reaches every candidate behind 더보기', () => {
    const { shown, more, results } = search([
      record('w010', '가', ['m1', 'm2', 'm3', 'm4', 'm5'].map((id, index) => sense(id, index + 1))),
    ]);
    expect(shown).toEqual(['m1', 'm2', 'm3']);
    expect(more).toEqual(['m4', 'm5']);
    expect(defaultExactSearchCandidate(results).senseId).toBe('m1');
  });
});
