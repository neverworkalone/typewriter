import { describe, expect, it } from 'vitest';

import { projectSearchResults } from '../src/domain/projection.js';
import {
  defaultExactSearchCandidate,
  expandExactSearchCandidates,
} from '../src/domain/exact-search-candidates.js';
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

describe('default view across one search', () => {
  const sense = (id, lexical = 0, exploratory = 0) => ({
    id, pos: 'noun', gloss: `${id} 뜻`, relations: [], ...meaning(id, lexical, exploratory), sense_ids: [`${id}-s`],
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

  it('shows exactly one meaning when several lemmas match and nothing has a relation', () => {
    const { shown, more, results } = search([
      record('w020', '나', [sense('m020')]),
      record('w010', '가', [sense('m010')]),
    ]);
    expect(shown).toEqual(['m010']);
    expect(more).toEqual(['m020']);
    expect(defaultExactSearchCandidate(results)).toMatchObject({ recordId: 'w010', senseId: 'm010' });
  });

  it('shows at most three related meanings across lemmas, keeping the rest reachable', () => {
    const { shown, more } = search([
      record('w010', '가', [sense('m010_1', 1), sense('m010_2', 0, 2)]),
      record('w020', '나', [sense('m020_1', 2), sense('m020_2', 0, 1)]),
    ]);
    expect(shown).toEqual(['m010_1', 'm010_2', 'm020_1']);
    expect(more).toEqual(['m020_2']);
  });

  it('starts on a default-view candidate even when it is not in the first record', () => {
    const { results } = search([
      record('w010', '가', [sense('m010_1'), sense('m010_2')]),
      record('w020', '나', [sense('m020_1', 1)]),
    ]);
    expect(defaultExactSearchCandidate(results)).toMatchObject({ recordId: 'w020', senseId: 'm020_1' });
  });

  it('keeps a single lemma at three plus more', () => {
    const { shown, more } = search([
      record('w010', '가', [sense('m1', 1), sense('m2', 2), sense('m3', 3), sense('m4', 4), sense('m5')]),
    ]);
    expect(shown).toEqual(['m4', 'm3', 'm2']);
    expect(more).toEqual(['m1', 'm5']);
  });
});
