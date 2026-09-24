// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick } from 'vue';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import DictionaryPanel from '../src/components/DictionaryPanel.vue';
import PopupApp from '../src/popup/App.vue';
import WebApp from '../web/src/App.vue';
import { ERROR_CODES } from '../src/runtime/protocol.js';
import { DEFAULT_SETTINGS } from '../src/ui/settings.js';

const mountedApps = [];

function mountWithProps(component, props = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(component, props);
  app.mount(host);
  mountedApps.push({ app, host });
  return host;
}

async function flush() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

function makeRecord(id, lemma, senses, role = 'start') {
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

function makeRuntime({ search } = {}) {
  const source = makeRecord('w026', '담담하다', [{
    id: 'w026-s1',
    pos: 'adjective',
    gloss: '감정의 동요를 드러내지 않다',
    relations: [{
      position: 0,
      target: 'r008',
      target_sense: 'r008-s1',
      type: 'direct',
      target_lemma: '덤덤하다',
      target_pos: 'adjective',
      target_gloss: '감정의 동요를 드러내지 않다',
    }],
  }]);
  const polysemous = makeRecord('w237', '쓰다', [
    { id: 'w237-s1', pos: 'verb', gloss: '붓이나 펜으로 글씨를 적다', relations: [] },
    { id: 'w237-s2', pos: 'verb', gloss: '맛이 달지 않고 쓰다', relations: [] },
    { id: 'w237-s3', pos: 'verb', gloss: '모자나 안경을 머리에 얹다', relations: [] },
    { id: 'w237-s4', pos: 'verb', gloss: '어떤 일을 맡아 사용하다', relations: [] },
  ]);
  const target = makeRecord('r008', '덤덤하다', [{
    id: 'r008-s1',
    pos: 'adjective',
    gloss: '감정의 동요를 드러내지 않다',
    relations: [],
  }], 'reference-only');
  const records = new Map([
    [source.id, source],
    [polysemous.id, polysemous],
    [target.id, target],
  ]);

  return {
    search: search || (async (term) => {
      const recordId = term === '쓰다' ? 'w237' : term === '담담하다' ? 'w026' : null;
      return recordId ? [{ id: recordId, lemma: records.get(recordId).lemma }] : [];
    }),
    getRecord: async (id) => records.get(id) || null,
  };
}

function makeSettingsStore() {
  let value = { ...DEFAULT_SETTINGS };
  return {
    load: async () => ({ ...value }),
    save: async (next) => {
      value = { ...next };
      return { ...value };
    },
  };
}

async function submit(host, term) {
  const input = host.querySelector('[aria-label="검색어"]');
  input.value = term;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'Enter',
  }));
  await flush();
}

function visibleIdentity(host) {
  return {
    records: [...host.querySelectorAll('[data-dictionary-record]')]
      .map((record) => record.getAttribute('data-record-id')),
    senses: [...host.querySelectorAll('.sense-block')]
      .map((sense) => sense.getAttribute('data-sense-id')),
  };
}

async function settleHistoryChange(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flush();
    if (predicate()) return;
  }
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  window.history.replaceState(null, '', '/');
});

describe('Typewriter Web product surface', () => {
  it('reuses the extension panel and matches search, selected sense, relations, and browser history', async () => {
    expect(WebApp).toBeDefined();
    expect(DictionaryPanel).toBeDefined();
    window.history.replaceState(null, '', '/typewriter/');

    const popup = mountWithProps(PopupApp, {
      runtime: makeRuntime(),
      settingsStore: makeSettingsStore(),
    });
    const web = mountWithProps(WebApp, {
      runtime: makeRuntime(),
      settingsStore: makeSettingsStore(),
    });

    expect(web.querySelector('[data-product-surface="web"]')).not.toBeNull();
    await submit(popup, '담담하다');
    await submit(web, '담담하다');
    expect(visibleIdentity(web)).toEqual(visibleIdentity(popup));
    expect(visibleIdentity(web)).toEqual({ records: ['w026'], senses: ['w026-s1'] });

    popup.querySelector('[data-target-record-id="r008"]').click();
    web.querySelector('[data-target-record-id="r008"]').click();
    await flush();
    expect(visibleIdentity(web)).toEqual(visibleIdentity(popup));
    expect(visibleIdentity(web)).toEqual({ records: ['r008'], senses: ['r008-s1'] });
    expect(new URL(window.location.href).searchParams.get('target')).toBe('r008');

    window.history.back();
    await settleHistoryChange(() => web.querySelector('[data-record-id="w026"]') !== null);
    expect(visibleIdentity(web)).toEqual({ records: ['w026'], senses: ['w026-s1'] });
    expect(new URL(window.location.href).searchParams.get('q')).toBe('담담하다');

    window.history.forward();
    await settleHistoryChange(() => web.querySelector('[data-record-id="r008"]') !== null);
    expect(visibleIdentity(web)).toEqual({ records: ['r008'], senses: ['r008-s1'] });

    await submit(popup, '쓰다');
    await submit(web, '쓰다');
    expect(visibleIdentity(web)).toEqual(visibleIdentity(popup));
    expect(visibleIdentity(web)).toEqual({ records: ['w237'], senses: ['w237-s1'] });
    for (const host of [popup, web]) {
      host.querySelector('[role="option"][data-sense-id="w237-s2"]').click();
      await flush();
    }
    expect(visibleIdentity(web)).toEqual(visibleIdentity(popup));
    expect(visibleIdentity(web)).toEqual({ records: ['w237'], senses: ['w237-s2'] });
  });

  it('adapts settings to browser storage and presents clear product and licensing context', async () => {
    const saves = [];
    const settingsStore = {
      load: async () => ({ ...DEFAULT_SETTINGS }),
      save: async (value) => {
        saves.push(value);
        return value;
      },
    };
    const web = mountWithProps(WebApp, {
      runtime: makeRuntime(),
      settingsStore,
    });

    expect(web.querySelector('#hero-title').textContent.replace(/\s+/gu, ''))
      .toBe('작가를위한,말의결을찾는사전.');
    expect(web.textContent).toContain('문장 생성이나 AI 다시쓰기를 하지 않습니다.');
    expect(web.textContent).toContain('재배포 권리 확인이 끝나지 않아 공개 배포가 보류되어 있습니다.');
    expect(web.querySelector('a[href*="DATA-LICENSE.md"]')).not.toBeNull();
    expect(web.querySelector('a[href*="LICENSE.md"]')).not.toBeNull();

    web.querySelector('[data-settings-link]').click();
    await flush();
    expect(web.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    const closeButton = web.querySelector('.settings-close');
    const lastBackground = web.querySelector('[role="radio"][aria-label="달빛"]');
    closeButton.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    expect(document.activeElement).toBe(lastBackground);
    lastBackground.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    }));
    expect(document.activeElement).toBe(closeButton);

    web.querySelector('[role="switch"][aria-label="뜻풀이 표시"]').click();
    await flush();
    expect(saves).toHaveLength(1);
    expect(saves[0].definition).toBe(false);

    web.querySelector('[role="radio"][aria-label="안개"]').click();
    await flush();
    expect(web.querySelector('[role="radio"][aria-label="안개"]')
      .getAttribute('aria-checked')).toBe('true');
    expect(document.body.style.backgroundColor).toBe('rgb(241, 244, 246)');
    expect(saves).toHaveLength(2);
  });

  it('shows empty, loading, and retryable runtime failure states', async () => {
    let failureCount = 0;
    let finishSlowSearch;
    const runtime = makeRuntime({
      search: async (term) => {
        if (term === '천천히') {
          return new Promise((resolve) => {
            finishSlowSearch = () => resolve([{ id: 'w026', lemma: '담담하다' }]);
          });
        }
        if (term === '없는말') return [];
        failureCount += 1;
        throw Object.assign(new Error('Dictionary asset unavailable.'), {
          code: ERROR_CODES.ASSET_LOAD_FAILED,
        });
      },
    });
    const web = mountWithProps(WebApp, {
      runtime,
      settingsStore: makeSettingsStore(),
    });

    await submit(web, '천천히');
    expect(web.querySelector('.dictionary-panel[aria-busy="true"]')).not.toBeNull();
    finishSlowSearch();
    await settleHistoryChange(() => web.querySelector('[data-record-id="w026"]') !== null);

    await submit(web, '없는말');
    expect(web.querySelector('[data-search-state="empty"]')).not.toBeNull();
    expect(web.textContent).toContain('사전에 없는 말입니다.');

    await submit(web, '자산 오류');
    expect(web.querySelector('[data-search-state="error"]')).not.toBeNull();
    expect(web.textContent).toContain('사전을 불러오지 못했습니다.');
    expect(web.querySelector('.retry-button')).not.toBeNull();
    web.querySelector('.retry-button').click();
    await flush();
    expect(failureCount).toBe(2);
    expect(web.querySelector('[data-search-state="error"]')).not.toBeNull();
  });

  it('keeps web source and assets separate from the Chrome Extension public tree', async () => {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const [webSource, webConfig, html] = await Promise.all([
      readFile(path.join(repositoryRoot, 'web/src/App.vue'), 'utf8'),
      readFile(path.join(repositoryRoot, 'vite.web.config.js'), 'utf8'),
      readFile(path.join(repositoryRoot, 'web/index.html'), 'utf8'),
    ]);

    expect(webSource).toContain("from '../../src/components/DictionaryPanel.vue'");
    expect(webSource).toContain("from '../../src/domain/index.js'");
    expect(webSource).toContain("from '../../src/runtime/query-adapter.js'");
    expect(webSource).not.toContain('chrome.');
    expect(webConfig).toContain("root: webRoot");
    expect(webConfig).toContain("path.join(webRoot, 'public')");
    expect(html).not.toContain('manifest.json');
    expect(html).not.toContain('options.html');
  });
});
