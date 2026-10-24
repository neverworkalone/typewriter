// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick } from 'vue';

import DictionaryResult from '../src/components/DictionaryResult.vue';
import { pageRelationItems } from '../src/domain/relation-paging.js';
import { DEFAULT_SETTINGS } from '../src/ui/settings.js';
import { projectRecord } from '../src/domain/projection.js';

const mounted = [];

function makeRecord(count, type = 'near') {
  const relations = Array.from({ length: count }, (_, position) => ({
    position,
    target: `t${position}`,
    type,
    target_lemma: `단어${position}`,
  }));
  relations.push({ position: count, target: 'syn', type: 'direct', target_lemma: '유의' });
  return projectRecord({
    id: 'w1',
    record_type: 'entry',
    role: 'start',
    lemma: '시험',
    senses: [{ id: 'w1-s1', pos: 'noun', gloss: '뜻', relations }],
  });
}

function mount(record, options = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(DictionaryResult, {
    record,
    settings: { ...DEFAULT_SETTINGS, association: true },
    ...options,
  });
  app.mount(host);
  mounted.push({ app, host });
  return host;
}

const count = (host, groupId) => host.querySelectorAll(
  `[data-group-id="${groupId}"] .relation-link`,
).length;
const pagination = (host, groupId) => host.querySelector(`[data-group-id="${groupId}"] .relation-pagination`);
const pageButton = (host, groupId, direction) => host.querySelector(
  `[data-group-id="${groupId}"] [data-page-direction="${direction}"]`,
);

afterEach(() => {
  while (mounted.length) {
    const { app, host } = mounted.pop();
    app.unmount();
    host.remove();
  }
});

describe('pageRelationItems', () => {
  it('leaves non-exploratory groups untouched', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(pageRelationItems('synonyms', items, 1)).toEqual({
      items,
      page: 1,
      pageCount: 1,
      total: 50,
      start: 1,
      end: 50,
      hasPrevious: false,
      hasNext: false,
    });
  });

  it.each([
    [0, 1, 0, 0],
    [1, 1, 1, 1],
    [20, 1, 1, 20],
    [21, 2, 21, 21],
    [100, 5, 81, 100],
    [101, 6, 101, 101],
    [130, 7, 121, 130],
  ])('pages a %i-item pool through its final item', (total, pageCount, start, end) => {
    const items = Array.from({ length: total }, (_, i) => i);
    const result = pageRelationItems('texture', items, pageCount);
    expect(result.page).toBe(pageCount);
    expect(result.pageCount).toBe(Math.max(1, Math.ceil(total / 20)));
    expect(result.total).toBe(total);
    expect(result.start).toBe(start);
    expect(result.end).toBe(end);
    expect(result.items).toEqual(items.slice(start - 1, end));
    expect(result.hasPrevious).toBe(pageCount > 1);
    expect(result.hasNext).toBe(false);
  });

  it('returns only the requested page and clamps page boundaries to the live item count', () => {
    const items = Array.from({ length: 130 }, (_, i) => i);
    const second = pageRelationItems('texture', items, 2);
    expect(second.items).toEqual(items.slice(20, 40));
    expect(second).toMatchObject({ page: 2, pageCount: 7, start: 21, end: 40, hasPrevious: true, hasNext: true });
    expect(pageRelationItems('texture', items, 0).page).toBe(1);
    expect(pageRelationItems('texture', items, 99).page).toBe(7);
    expect(pageRelationItems('texture', items.slice(0, 21), 7)).toMatchObject({
      page: 2, pageCount: 2, start: 21, end: 21, hasPrevious: true, hasNext: false,
    });
  });
});

describe('DictionaryResult relation pagination', () => {
  it('replaces the visible page and reports range and disabled boundaries', async () => {
    const host = mount(makeRecord(130));
    expect(count(host, 'texture')).toBe(20);
    expect(pagination(host, 'texture').textContent).toContain('1–20 / 전체 130개');
    expect(pageButton(host, 'texture', 'previous').disabled).toBe(true);

    pageButton(host, 'texture', 'next').focus();
    pageButton(host, 'texture', 'next').click();
    await nextTick();
    expect(count(host, 'texture')).toBe(20);
    expect(host.querySelector('[data-group-id="texture"] .relation-link').textContent).toBe('단어20');
    expect(pagination(host, 'texture').textContent).toContain('21–40 / 전체 130개');
    expect(document.activeElement.dataset.pageDirection).toBe('next');

    for (let page = 3; page <= 7; page += 1) {
      pageButton(host, 'texture', 'next').click();
      await nextTick();
    }
    expect(count(host, 'texture')).toBe(10);
    expect(host.querySelector('[data-group-id="texture"] .relation-link').textContent).toBe('단어120');
    expect(pagination(host, 'texture').textContent).toContain('121–130 / 전체 130개');
    expect(pageButton(host, 'texture', 'next').disabled).toBe(true);
    expect(document.activeElement.dataset.pageDirection).toBe('previous');

    pageButton(host, 'texture', 'previous').click();
    await nextTick();
    expect(host.querySelector('[data-group-id="texture"] .relation-link').textContent).toBe('단어100');
    expect(pagination(host, 'texture').textContent).toContain('101–120 / 전체 130개');
  });

  it('shows no control when 20 or fewer exist and leaves 유의어 unpaged', async () => {
    const host = mount(makeRecord(20));
    expect(pagination(host, 'texture')).toBeNull();
    expect(count(host, 'synonyms')).toBe(1);
  });

  it('pages 연상 independently and keeps compact pages bounded to 20 items', async () => {
    const host = mount(makeRecord(45, 'scene'), { compact: true });
    expect(host.querySelector('.dictionary-result').classList.contains('is-compact')).toBe(true);
    expect(count(host, 'association')).toBe(20);
    pageButton(host, 'association', 'next').click();
    await nextTick();
    expect(host.querySelector('[data-group-id="association"] .relation-link').textContent).toBe('단어20');
    pageButton(host, 'association', 'next').click();
    await nextTick();
    expect(count(host, 'association')).toBe(5);
    expect(pagination(host, 'association').textContent).toContain('41–45 / 전체 45개');
  });

  it('keeps page positions independent for each sense in the same record', async () => {
    const relations = (prefix) => Array.from({ length: 45 }, (_, position) => ({
      position,
      target: `${prefix}-${position}`,
      type: 'near',
      target_lemma: `${prefix}${position}`,
    }));
    const record = projectRecord({
      id: 'w1', record_type: 'entry', role: 'start', lemma: '시험',
      senses: [
        { id: 'w1-s1', pos: 'noun', gloss: '첫 뜻', relations: relations('첫') },
        { id: 'w1-s2', pos: 'noun', gloss: '둘째 뜻', relations: relations('둘') },
      ],
    });
    const host = mount(record);
    const sense = (id) => host.querySelector(`.sense-block[data-sense-id="${id}"]`);
    const firstItem = (id) => sense(id).querySelector('.relation-link').textContent;
    const next = (id) => sense(id).querySelector('[data-page-direction="next"]');

    expect(firstItem('w1-s1')).toBe('첫0');
    expect(firstItem('w1-s2')).toBe('둘0');
    next('w1-s1').click();
    await nextTick();
    expect(firstItem('w1-s1')).toBe('첫20');
    expect(firstItem('w1-s2')).toBe('둘0');

    next('w1-s2').click();
    await nextTick();
    expect(firstItem('w1-s1')).toBe('첫20');
    expect(firstItem('w1-s2')).toBe('둘20');
  });
});

describe('DictionaryResult 뜻풀이 더보기', () => {
  const withGlosses = (count) => projectRecord({
    id: 'w1', record_type: 'entry', role: 'start', lemma: '시험', view: 'meaning',
    senses: [{
      id: 'm1', pos: 'noun', sense_ids: ['w1-s1'], relations: [],
      gloss: Array.from({ length: count }, (_, index) => `뜻${index + 1}`).join('\n'),
    }],
  });
  const shown = (host) => [...host.querySelectorAll('.definition-text')].map((node) => node.textContent.trim());
  const toggle = (host) => host.querySelector('.definition-more');

  it.each([[1, 1], [2, 2], [3, 3]])('shows all %i definitions without a control', (count, visible) => {
    const host = mount(withGlosses(count));
    expect(shown(host)).toHaveLength(visible);
    expect(toggle(host)).toBeNull();
  });

  it('shows three of four or more, expands to every definition in order and collapses again', async () => {
    const host = mount(withGlosses(39));
    expect(shown(host)).toEqual(['1. 뜻1', '2. 뜻2', '3. 뜻3']);
    expect(toggle(host).textContent).toBe('뜻풀이 더보기 (36)');
    toggle(host).click();
    await nextTick();
    expect(shown(host)).toHaveLength(39);
    expect(shown(host)[38]).toBe('39. 뜻39');
    expect(toggle(host).textContent).toBe('뜻풀이 접기');
    toggle(host).click();
    await nextTick();
    expect(shown(host)).toHaveLength(3);
  });
});

describe('relevance ordering (#396)', () => {
  function relations(specs) {
    return specs.map(([type, relevance], position) => ({
      position, target: `t${position}`, type, relevance, target_lemma: `단어${position}`,
    }));
  }
  function group(specs, groupId = 'texture') {
    const record = projectRecord({
      id: 'w1', record_type: 'entry', role: 'start', lemma: '시험',
      senses: [{ id: 'w1-s1', pos: 'noun', gloss: '뜻', relations: relations(specs) }],
    });
    return record.senses[0].relationGroups[groupId].items;
  }

  it('moves a later-added relevance-1 relation ahead of weaker ones', () => {
    const items = group([['near', 5], ['mood', 3], ['near', 1]]);
    expect(items.map(({ targetId }) => targetId)).toEqual(['t2', 't1', 't0']);
  });

  it('keeps source position as the deterministic tie-breaker within a band', () => {
    const items = group([['near', 4], ['mood', 2], ['near', 4], ['mood', 2]]);
    expect(items.map(({ targetId }) => targetId)).toEqual(['t1', 't3', 't0', 't2']);
  });

  it('keeps all 101+ relations in the projection and pages to the final item', () => {
    const specs = Array.from({ length: 105 }, (_, i) => ['scene', (i % 9) + 1]);
    const items = group(specs, 'association');
    expect(items).toHaveLength(105);
    const page = pageRelationItems('association', items, 6);
    expect(page.items).toHaveLength(5);
    expect(page.items.at(-1)).toEqual(items.at(-1));
    expect(page).toMatchObject({ page: 6, pageCount: 6, start: 101, end: 105, hasNext: false });
    // a later relevance-1 addition re-enters the visible window
    const later = group([...specs, ['sensory', 1]], 'association');
    expect(pageRelationItems('association', later, 1).items.map(({ targetId }) => targetId))
      .toContain('t105');
  });

  it('leaves direct/antonym order untouched', () => {
    const record = projectRecord({
      id: 'w1', record_type: 'entry', role: 'start', lemma: '시험',
      senses: [{
        id: 'w1-s1', pos: 'noun', gloss: '뜻',
        relations: [
          { position: 0, target: 'a', type: 'antonym', target_lemma: 'a' },
          { position: 1, target: 'b', type: 'antonym', target_lemma: 'b', relevance: 1 },
        ],
      }],
    });
    expect(record.senses[0].relationGroups.antonyms.items.map(({ targetId }) => targetId))
      .toEqual(['a', 'b']);
  });
});

describe('text-only authored relation', () => {
  it('renders as plain text without a click target while linked relations stay buttons', () => {
    const record = projectRecord({
      id: 'w1', record_type: 'entry', role: 'start', lemma: '시험',
      senses: [{
        id: 'w1-s1', pos: 'noun', gloss: '뜻',
        relations: [
          { position: 0, target: 't0', type: 'near', relevance: 2, target_lemma: '연결' },
          { position: 1, target: null, target_sense: null, type: 'near', relevance: 3, target_lemma: '글자뿐' },
        ],
      }],
    });
    const host = mount(record);
    const group = host.querySelector('[data-group-id="near"]') ?? host;
    const buttons = [...group.querySelectorAll('button.relation-link')].map((el) => el.textContent);
    const statics = [...group.querySelectorAll('.relation-link.is-static')].map((el) => el.textContent);
    expect(buttons).toContain('연결');
    expect(buttons).not.toContain('글자뿐');
    expect(statics).toContain('글자뿐');

    const preview = mount(record, { interactive: false });
    const previewGroup = preview.querySelector('[data-group-id="texture"]');
    expect(previewGroup.querySelector('.relation-link.is-disabled')?.textContent).toBe('연결');
    expect(previewGroup.querySelector('.relation-link.is-disabled.is-static')).toBeNull();
    expect(previewGroup.querySelector('.relation-link.is-static')?.textContent).toBe('글자뿐');
  });
});
