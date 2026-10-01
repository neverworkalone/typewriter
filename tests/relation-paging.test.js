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

function mount(record) {
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(DictionaryResult, {
    record,
    settings: { ...DEFAULT_SETTINGS, association: true },
  });
  app.mount(host);
  mounted.push({ app, host });
  return host;
}

const count = (host, groupId) => host.querySelectorAll(
  `[data-group-id="${groupId}"] .relation-link`,
).length;
const more = (host, groupId) => host.querySelector(`[data-group-id="${groupId}"] .relation-more`);

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
    expect(pageRelationItems('synonyms', items, 1)).toEqual({ items, hasMore: false });
  });

  it.each([
    [1, 20, true],
    [2, 40, true],
    [3, 60, true],
    [4, 80, true],
    [5, 100, false],
    [9, 100, false],
  ])('shows %i page(s) as %i items of 130', (pages, shown, hasMore) => {
    const items = Array.from({ length: 130 }, (_, i) => i);
    const result = pageRelationItems('texture', items, pages);
    expect(result.items).toEqual(items.slice(0, shown));
    expect(result.hasMore).toBe(hasMore);
  });

  it('reports no more when the pool fits exactly or is smaller', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(pageRelationItems('association', items, 1).hasMore).toBe(false);
    expect(pageRelationItems('association', items.slice(0, 5), 1).hasMore).toBe(false);
  });
});

describe('DictionaryResult 더보기', () => {
  it('reveals 20 more per activation up to 100 and then removes the control', async () => {
    const host = mount(makeRecord(130));
    expect(count(host, 'texture')).toBe(20);

    for (const expected of [40, 60, 80, 100]) {
      more(host, 'texture').click();
      await nextTick();
      expect(count(host, 'texture')).toBe(expected);
    }
    expect(more(host, 'texture')).toBeNull();
    expect(document.activeElement.classList.contains('relation-link')).toBe(true);
    expect(host.querySelector('[data-group-id="texture"] .relation-link').textContent).toBe('단어0');
  });

  it('shows no control when 20 or fewer exist and leaves 유의어 unpaged', async () => {
    const host = mount(makeRecord(20));
    expect(more(host, 'texture')).toBeNull();
    expect(count(host, 'synonyms')).toBe(1);
  });

  it('pages 연상 independently', async () => {
    const host = mount(makeRecord(45, 'scene'));
    expect(count(host, 'association')).toBe(20);
    more(host, 'association').click();
    await nextTick();
    more(host, 'association').click();
    await nextTick();
    expect(count(host, 'association')).toBe(45);
    expect(more(host, 'association')).toBeNull();
  });
});
