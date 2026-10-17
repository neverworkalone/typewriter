// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick } from 'vue';
import { readFileSync } from 'node:fs';

import DictionaryResult from '../src/components/DictionaryResult.vue';
import { DEFAULT_SETTINGS } from '../src/ui/settings.js';
import { projectRecord } from '../src/domain/projection.js';

const mounted = [];

function mountGlosses(glosses) {
  const record = projectRecord({
    id: 'w1',
    record_type: 'entry',
    role: 'start',
    lemma: '시험',
    senses: [{ id: 'w1-s1', pos: 'verb', gloss: glosses.join('\n'), relations: [] }],
  });
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(DictionaryResult, { record, settings: { ...DEFAULT_SETTINGS } });
  app.mount(host);
  mounted.push({ app, host });
  return host;
}

const texts = (host) => [...host.querySelectorAll('.definition-text')].map((p) => p.textContent);
const numbers = (host) => [...host.querySelectorAll('.definition-number')].map((s) => s.textContent);

afterEach(() => {
  while (mounted.length) {
    const { app, host } = mounted.pop();
    app.unmount();
    host.remove();
  }
});

describe('multi-gloss definition numbering', () => {
  it('shows no number for a single gloss', () => {
    const host = mountGlosses(['하나']);
    expect(numbers(host)).toEqual([]);
    expect(texts(host)).toEqual(['하나']);
  });

  it.each([2, 3, 20, 21, 25])('numbers %i glosses as consecutive "N. " without circled digits', async (n) => {
    const glosses = Array.from({ length: n }, (_, i) => `뜻풀이${i + 1}`);
    const host = mountGlosses(glosses);
    // Beyond three definitions the rest sit behind 뜻풀이 더보기.
    host.querySelector('.definition-more')?.click();
    await nextTick();
    expect(numbers(host)).toEqual(glosses.map((_, i) => `${i + 1}.`));
    expect(texts(host)).toEqual(glosses.map((g, i) => `${i + 1}. ${g}`));
    expect(host.textContent).not.toMatch(/[①-⑳]/u);
  });

  it('styles only the number with a muted neutral colour', () => {
    const css = readFileSync('src/components/DictionaryResult.vue', 'utf8');
    expect(css).toMatch(/\.definition-number\s*\{\s*color:\s*#77716b;\s*\}/u);
  });
});
