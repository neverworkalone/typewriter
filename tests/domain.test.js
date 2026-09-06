import { describe, expect, it } from 'vitest';

import {
  projectRecord,
  projectRelationTarget,
  projectSearchResults,
  projectSense,
  SearchSession,
} from '../src/domain/index.js';

const relationDefinitions = [
  ['direct', 'direct-target'],
  ['antonym', 'antonym-target'],
  ['near', 'near-target'],
  ['mood', 'mood-target'],
  ['scene', 'scene-target'],
  ['sensory', 'sensory-target'],
  ['action', 'action-target'],
  ['association', 'association-target'],
];

function makeRelation(type, target, position) {
  return {
    position,
    target,
    target_sense: `${target}-s1`,
    type,
    note: `${type} note`,
    target_lemma: `${target} lemma`,
    target_pos: 'noun',
    target_gloss: `${target} gloss`,
  };
}

function makeRecord(id, lemma, role = 'start', senses = []) {
  return {
    id,
    record_type: 'entry',
    role,
    candidate_id: role === 'start' ? id : null,
    lemma,
    search_forms: [lemma],
    senses,
  };
}

describe('Editorial Model v1 projection', () => {
  it('maps all eight canonical relation types to the five ordered UI groups', () => {
    const sense = projectSense({
      id: 'w026-s1',
      pos: 'adjective',
      gloss: '차분한 뜻풀이',
      relations: relationDefinitions.map(([type, target], position) => (
        makeRelation(type, target, position)
      )),
    });

    expect(sense.activeGroupIds).toEqual([
      'definition',
      'synonyms',
      'antonyms',
      'texture',
      'association',
    ]);
    expect(sense.groups.map(({ id }) => id)).toEqual(sense.activeGroupIds);
    expect(sense.relationGroups.synonyms.items.map(({ canonicalType }) => canonicalType)).toEqual(['direct']);
    expect(sense.relationGroups.antonyms.items.map(({ canonicalType }) => canonicalType)).toEqual(['antonym']);
    expect(sense.relationGroups.texture.items.map(({ canonicalType }) => canonicalType)).toEqual(['near', 'mood']);
    expect(sense.relationGroups.association.items.map(({ canonicalType }) => canonicalType)).toEqual([
      'scene',
      'sensory',
      'action',
      'association',
    ]);
    expect(sense.relationGroups.synonyms.items[0]).toMatchObject({
      targetId: 'direct-target',
      targetSenseId: 'direct-target-s1',
      note: 'direct note',
      sourceSenseId: 'w026-s1',
      sourcePosition: 0,
      action: {
        type: 'open-relation-target',
        targetRecordId: 'direct-target',
      },
    });
    expect(sense.relationGroups.synonyms.items).not.toContainEqual(
      expect.objectContaining({ canonicalType: 'near' }),
    );
  });

  it('keeps the definition group and omits empty relation groups', () => {
    const projected = projectSense({
      id: 'w032-s2',
      pos: 'adjective',
      gloss: '관계가 없는 뜻풀이',
      relations: [],
    });

    expect(projected.hasRelations).toBe(false);
    expect(projected.activeGroupIds).toEqual(['definition']);
    expect(projected.groups).toHaveLength(1);
    expect(projected.relationGroups).toEqual({});
    expect(projected.unmappedRelations).toEqual([]);
  });

  it('preserves polysemy, expression records, source order, and reference-only IDs', () => {
    const records = [
      makeRecord('w288', '마음이 놓이다', 'start', [{
        id: 'w288-s1',
        pos: 'expression',
        gloss: '걱정이 풀리다',
        relations: [],
      }]),
      makeRecord('r008', '덤덤하다', 'reference-only', [{
        id: 'r008-s1',
        pos: 'adjective',
        gloss: '감정의 동요를 드러내지 않다',
        relations: [],
      }]),
    ];
    records[0].record_type = 'expression';

    const projected = projectSearchResults(records);
    expect(projected.map(({ id }) => id)).toEqual(['w288']);
    expect(projected[0]).toMatchObject({
      recordType: 'expression',
      role: 'start',
      match: { kind: 'exact', position: 0 },
    });
    expect(projectRelationTarget(records[1])).toMatchObject({
      role: 'reference-only',
      match: { kind: 'relation-target' },
    });

    const polysemous = projectRecord({
      ...makeRecord('w237', '쓰다'),
      senses: [
        { id: 'w237-s1', pos: 'verb', gloss: '기록하다', relations: [] },
        { id: 'w237-s2', pos: 'verb', gloss: '이용하다', relations: [] },
      ],
    });
    expect(polysemous.senses.map(({ id }) => id)).toEqual(['w237-s1', 'w237-s2']);
  });
});

describe('SearchSession', () => {
  it('retains the structured query contract and match provenance in state and history', async () => {
    const record = makeRecord('w026', '담담하다', 'start', [{
      id: 'w026-s1',
      pos: 'adjective',
      gloss: '차분하다',
      relations: [],
    }]);
    const response = {
      rawQuery: '  담담하다  ',
      normalizedQuery: '담담하다',
      normalizationRules: ['trim-surrounding-whitespace'],
      status: 'ready',
      reason: null,
      matches: [{
        id: 'w026',
        record_type: 'entry',
        role: 'start',
        candidate_id: 'w026',
        lemma: '담담하다',
        match: {
          kind: 'normalized',
          field: 'lemma',
          value: '담담하다',
          normalizationRules: ['trim-surrounding-whitespace'],
        },
      }],
    };
    const runtime = {
      search: async () => response,
      getRecord: async () => record,
    };
    const session = new SearchSession({ runtime });

    const state = await session.searchExact('  담담하다  ');

    expect(state.queryMeta).toEqual(response);
    expect(state.results[0]).toMatchObject({
      id: 'w026',
      match: response.matches[0].match,
    });
    expect(session.history[0]).toMatchObject({
      query: '  담담하다  ',
      queryMeta: response,
    });
  });

  it('separates exact search from relation navigation and restores the prior result', async () => {
    const calls = [];
    const records = new Map([
      ['w026', makeRecord('w026', '담담하다', 'start', [{
        id: 'w026-s1',
        pos: 'adjective',
        gloss: '차분하다',
        relations: [],
      }])],
      ['w030', makeRecord('w030', '평온', 'start', [{
        id: 'w030-s1',
        pos: 'noun',
        gloss: '잔잔하다',
        relations: [],
      }])],
      ['r008', makeRecord('r008', '덤덤하다', 'reference-only', [{
        id: 'r008-s1',
        pos: 'adjective',
        gloss: '동요를 드러내지 않다',
        relations: [],
      }])],
    ]);
    const runtime = {
      search: async (term) => {
        calls.push(['search', term]);
        return term === '담담하다' ? [{ id: 'w026' }, { id: 'w030' }] : [];
      },
      getRecord: async (id) => {
        calls.push(['getRecord', id]);
        return records.get(id) || null;
      },
    };
    const session = new SearchSession({ runtime });
    const statuses = [];
    session.subscribe(({ status }) => statuses.push(status));

    const first = await session.searchExact('담담하다');
    expect(first.status).toBe('ready');
    expect(first.mode).toBe('exact');
    expect(first.results.map(({ id }) => id)).toEqual(['w026', 'w030']);
    expect(first.canGoBack).toBe(true);
    const selected = session.selectCandidate('w030');
    expect(selected.selectedRecordId).toBe('w030');
    expect(session.history[0].selectedRecordId).toBe('w030');
    expect(calls).toEqual([
      ['search', '담담하다'],
      ['getRecord', 'w026'],
      ['getRecord', 'w030'],
    ]);

    const relation = await session.openRelationTarget({
      targetId: 'r008',
      sourceSenseId: 'w026-s1',
      canonicalType: 'direct',
    });
    expect(relation.status).toBe('ready');
    expect(relation.mode).toBe('relation-target');
    expect(relation.targetRecordId).toBe('r008');
    expect(relation.results[0]).toMatchObject({
      id: 'r008',
      role: 'reference-only',
      match: {
        kind: 'relation-target',
        targetRecordId: 'r008',
        sourceSenseId: 'w026-s1',
        relationType: 'direct',
      },
    });
    expect(calls).not.toContainEqual(['search', '덤덤하다']);

    const restored = session.back();
    expect(restored.mode).toBe('exact');
    expect(restored.results.map(({ id }) => id)).toEqual(['w026', 'w030']);
    expect(restored.selectedRecordId).toBe('w030');
    expect(restored.canGoForward).toBe(true);

    await session.searchExact('없는 말');
    expect(session.state.status).toBe('empty');
    expect(session.state.emptyReason).toBe('no-exact-match');
    expect(session.state.selectedRecordId).toBe(null);
    expect(session.state.canGoForward).toBe(false);
    expect(session.history.map(({ kind }) => kind)).toEqual(['exact', 'exact']);
    expect(statuses).toContain('loading');
  });

  it('does not retain a cancelled loading search in history', async () => {
    const deferred = new Map();
    const records = new Map([
      ['w001', makeRecord('w001', '첫 검색', 'start', [{
        id: 'w001-s1',
        pos: 'noun',
        gloss: '첫 결과',
        relations: [],
      }])],
      ['w002', makeRecord('w002', '두 번째 검색', 'start', [{
        id: 'w002-s1',
        pos: 'noun',
        gloss: '두 번째 결과',
        relations: [],
      }])],
    ]);
    const runtime = {
      search: (term) => new Promise((resolve) => {
        deferred.set(term, resolve);
      }),
      getRecord: async (id) => records.get(id) || null,
    };
    const session = new SearchSession({ runtime });

    const first = session.searchExact('A');
    const second = session.searchExact('B');
    deferred.get('B')([{ id: 'w002' }]);
    await second;
    expect(session.state.results.map(({ id }) => id)).toEqual(['w002']);

    session.back();
    expect(session.state.status).toBe('idle');
    expect(session.state.results).toEqual([]);
    expect(session.history.map(({ query }) => query)).toEqual(['B']);
    expect(session.history.some(({ query }) => query === 'A')).toBe(false);
    deferred.get('A')([{ id: 'w001' }]);
    await first;
    expect(session.state.status).toBe('idle');
  });

  it('cancels a pending search before back/forward restoration', async () => {
    let resolvePending;
    const record = makeRecord('w026', '담담하다', 'start', [{
      id: 'w026-s1',
      pos: 'adjective',
      gloss: '차분하다',
      relations: [],
    }]);
    const runtime = {
      search: async (term) => {
        if (term === '기준') return [{ id: 'w026' }];
        return new Promise((resolve) => {
          resolvePending = resolve;
        });
      },
      getRecord: async () => record,
    };
    const session = new SearchSession({ runtime });

    await session.searchExact('기준');
    const pending = session.searchExact('진행 중');
    expect(session.state.status).toBe('loading');
    session.back();
    expect(session.state).toMatchObject({ status: 'ready', query: '기준' });
    expect(session.state.canGoForward).toBe(false);
    session.forward();
    expect(session.state).toMatchObject({ status: 'ready', query: '기준' });
    resolvePending([{ id: 'w026' }]);
    await pending;
    expect(session.state).toMatchObject({ status: 'ready', query: '기준' });
  });

  it('cancels a pending search without clearing the current result or history', async () => {
    let resolvePending;
    const records = new Map([
      ['first', makeRecord('first', '첫 결과')],
      ['second', makeRecord('second', '두 번째 결과')],
    ]);
    const runtime = {
      search: async (term) => {
        if (term === '첫 검색') return [{ id: 'first' }];
        return new Promise((resolve) => {
          resolvePending = resolve;
        });
      },
      getRecord: async (id) => records.get(id) || null,
    };
    const session = new SearchSession({ runtime });

    await session.searchExact('첫 검색');
    const pending = session.searchExact('두 번째 검색');
    expect(session.state).toMatchObject({ status: 'loading', query: '두 번째 검색' });

    expect(session.cancelPending()).toMatchObject({
      status: 'ready',
      query: '첫 검색',
      results: [expect.objectContaining({ id: 'first' })],
    });
    expect(session.history.map(({ query }) => query)).toEqual(['첫 검색']);

    resolvePending([{ id: 'second' }]);
    await pending;
    expect(session.state).toMatchObject({
      status: 'ready',
      query: '첫 검색',
      results: [expect.objectContaining({ id: 'first' })],
    });
  });

  it('distinguishes no-result, load failure, query failure, and missing relation targets', async () => {
    const runtime = {
      search: async (term) => {
        if (term === 'load failure') {
          throw Object.assign(new Error('database missing'), {
            code: 'TIMEOUT',
            details: { phase: 'load' },
          });
        }
        if (term === 'query failure') {
          throw Object.assign(new Error('SQL failed'), {
            code: 'TIMEOUT',
            details: { phase: 'query' },
          });
        }
        return [];
      },
      getRecord: async () => null,
    };
    const session = new SearchSession({ runtime });

    await session.searchExact('없는 말');
    expect(session.state).toMatchObject({ status: 'empty', emptyReason: 'no-exact-match' });

    await session.searchExact('load failure');
    expect(session.state).toMatchObject({
      status: 'error',
      error: { kind: 'load', code: 'TIMEOUT' },
    });

    await session.searchExact('query failure');
    expect(session.state).toMatchObject({
      status: 'error',
      error: { kind: 'query', code: 'TIMEOUT' },
    });

    await session.openRelationTarget('r404');
    expect(session.state).toMatchObject({
      status: 'empty',
      mode: 'relation-target',
      targetRecordId: 'r404',
      emptyReason: 'relation-target-not-found',
    });
  });
});
