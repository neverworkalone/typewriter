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
    expect(restored.canGoForward).toBe(true);

    await session.searchExact('없는 말');
    expect(session.state.status).toBe('empty');
    expect(session.state.emptyReason).toBe('no-exact-match');
    expect(session.state.canGoForward).toBe(false);
    expect(session.history.map(({ kind }) => kind)).toEqual(['exact', 'exact']);
    expect(statuses).toContain('loading');
  });

  it('distinguishes no-result, load failure, query failure, and missing relation targets', async () => {
    const runtime = {
      search: async (term) => {
        if (term === 'load failure') {
          throw Object.assign(new Error('database missing'), { code: 'ASSET_LOAD_FAILED' });
        }
        if (term === 'query failure') {
          throw Object.assign(new Error('SQL failed'), { code: 'QUERY_FAILED' });
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
      error: { kind: 'load', code: 'ASSET_LOAD_FAILED' },
    });

    await session.searchExact('query failure');
    expect(session.state).toMatchObject({
      status: 'error',
      error: { kind: 'query', code: 'QUERY_FAILED' },
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
