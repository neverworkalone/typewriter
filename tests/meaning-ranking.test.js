import { describe, expect, it } from 'vitest';

import {
  compareMeaningIds,
  countMeaningRelations,
  partitionMeanings,
} from '../src/runtime/meaning-ranking.js';

const meaning = (id, lexical = 0, exploratory = 0) => ({
  id,
  lexical_relation_count: lexical,
  exploratory_relation_count: exploratory,
});
const ids = (list) => list.map(({ id }) => id);

describe('meaning ranking', () => {
  it('orders meaning IDs numerically, not as text', () => {
    expect(['m1000', 'm443_2', 'm443', 'm443_10', 'm97'].sort(compareMeaningIds))
      .toEqual(['m97', 'm443', 'm443_2', 'm443_10', 'm1000']);
  });

  it('is a total order over leading zeros, unbounded integers and ordinals', () => {
    expect(['m9', 'm09', 'm1_1000001', 'm2', 'm007', 'm7'].sort(compareMeaningIds))
      .toEqual(['m007', 'm7', 'm09', 'm9', 'm1_1000001', 'm2'].sort(compareMeaningIds));
    expect(compareMeaningIds('m09', 'm9')).toBeLessThan(0);
    expect(compareMeaningIds('m9', 'm09')).toBeGreaterThan(0);
    expect(compareMeaningIds('m1_1000001', 'm2')).toBeLessThan(0);
    expect(compareMeaningIds(`m${'9'.repeat(30)}`, `m1${'0'.repeat(30)}`)).toBeLessThan(0);
    expect(compareMeaningIds('m5', 'm5')).toBe(0);
  });

  it('counts distinct targets per ranking key', () => {
    expect(countMeaningRelations([
      { type: 'direct', target_meaning_id: 'm1' },
      { type: 'antonym', target_meaning_id: 'm1' },
      { type: 'antonym', target_meaning_id: 'm2' },
      { type: 'near', target_meaning_id: 'm3' },
      { type: 'mood', target_meaning_id: 'm3' },
      { type: 'scene', target_meaning_id: 'm4' },
    ])).toEqual({ lexical: 2, exploratory: 2 });
  });

  it('shows at most three related meanings by default, the rest behind 더보기', () => {
    const { primary, more } = partitionMeanings([
      meaning('m1', 0, 1), meaning('m2', 1, 0), meaning('m3', 2, 0), meaning('m4', 0, 5), meaning('m5'),
    ]);
    expect(ids(primary)).toEqual(['m3', 'm2', 'm4']);
    expect(ids(more)).toEqual(['m1', 'm5']);
  });

  it('keeps unrelated meanings out of the default view while related ones exist', () => {
    const { primary, more } = partitionMeanings([meaning('m1'), meaning('m2', 0, 1), meaning('m3')]);
    expect(ids(primary)).toEqual(['m2']);
    expect(ids(more)).toEqual(['m1', 'm3']);
  });

  it('shows the lowest ID when no meaning has any relation', () => {
    const { primary, more } = partitionMeanings([meaning('m1000'), meaning('m443_2'), meaning('m443')]);
    expect(ids(primary)).toEqual(['m443']);
    expect(ids(more)).toEqual(['m443_2', 'm1000']);
  });

  it('is deterministic regardless of input order', () => {
    const input = [meaning('m5', 1, 1), meaning('m2', 1, 1), meaning('m9', 1, 2), meaning('m1')];
    expect(partitionMeanings(input)).toEqual(partitionMeanings([...input].reverse()));
  });
});
