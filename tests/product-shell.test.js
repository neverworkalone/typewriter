// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick } from 'vue';

import PopupApp from '../src/popup/App.vue';
import OptionsApp from '../src/options/App.vue';
import { DEFAULT_SETTINGS } from '../src/ui/settings.js';

const mountedApps = [];

function mount(component) {
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(component);
  app.mount(host);
  mountedApps.push({app, host});
  return host;
}

function mountWithProps(component, props) {
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(component, props);
  app.mount(host);
  mountedApps.push({app, host});
  return host;
}

async function flush() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

function makeRecord(id, lemma, role = 'start', relations = []) {
  return {
    id,
    record_type: 'entry',
    role,
    candidate_id: role === 'start' ? id : null,
    lemma,
    search_forms: [lemma],
    senses: [{
      id: id + '-s1',
      pos: 'adjective',
      gloss: lemma + ' 뜻풀이',
      relations,
    }],
  };
}

afterEach(() => {
  for (const {app, host} of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe('product MV3 Vue shells', () => {
  it('mounts the popup with the Figma search surface and no fixture data', () => {
    const host = mount(PopupApp);

    expect(host.querySelector('[data-product-surface="popup"]')).not.toBeNull();
    expect(host.querySelector('[data-dictionary-panel]')).not.toBeNull();
    expect(host.querySelector('[aria-label="검색어"]')).not.toBeNull();
    expect(host.textContent).toContain('Typewriter');
    expect(host.textContent).toContain('설정');
    expect(host.querySelector('[data-dictionary-record]')).toBeNull();
  });

  it('mounts the options shell independently from the popup', () => {
    const host = mount(OptionsApp);

    expect(host.querySelector('[data-product-surface="options"]')).not.toBeNull();
    expect(host.textContent).toContain('설정');
    expect(host.querySelector('.brand-version').textContent.trim()).toBe('0.3.0');
  });

  it('searches on Enter, moves through relation targets, and returns with the back control', async () => {
    const records = new Map([
      ['w026', makeRecord('w026', '담담하다', 'start', [{
        position: 0,
        target: 'r008',
        target_sense: 'r008-s1',
        type: 'direct',
        target_lemma: '덤덤하다',
        target_pos: 'adjective',
        target_gloss: '감정의 동요를 드러내지 않다',
      }])],
      ['r008', makeRecord('r008', '덤덤하다', 'reference-only')],
    ]);
    const runtime = {
      search: async () => [{ id: 'w026' }],
      getRecord: async (id) => records.get(id) || null,
    };
    const host = mountWithProps(PopupApp, {
      runtime,
      settingsStore: {
        load: async () => ({ ...DEFAULT_SETTINGS }),
        save: async (value) => value,
      },
    });
    const input = host.querySelector('[aria-label="검색어"]');
    const button = host.querySelector('.search-button');

    input.value = '담담하다';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    }));
    await flush();

    expect(host.querySelector('[data-record-id="w026"]')).not.toBeNull();
    expect(host.textContent).toContain('덤덤하다');

    input.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Tab',
    }));
    expect(document.activeElement).toBe(button);

    host.querySelector('[data-target-record-id="r008"]').click();
    await flush();
    expect(host.querySelector('[data-record-id="r008"]')).not.toBeNull();
    expect(host.querySelector('.back-button')).not.toBeNull();
    expect(host.querySelector('.back-button').textContent.trim()).toBe('← 뒤로');
    expect(host.querySelector('[data-dictionary-panel].is-relation-target')).not.toBeNull();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(document.activeElement).toBe(input);

    host.querySelector('.back-button').click();
    await flush();

    expect(host.querySelector('[data-record-id="w026"]')).not.toBeNull();
    expect(host.querySelector('.back-button')).toBeNull();
    expect(host.querySelector('[data-dictionary-panel].is-relation-target')).toBeNull();
    expect(input.value).toBe('담담하다');
    expect(document.activeElement).toBe(input);
  });

  it('does not submit during Korean IME composition and submits once after compositionend', async () => {
    const record = makeRecord('w026', '담담하다');
    const calls = [];
    const runtime = {
      search: async (term) => {
        calls.push(term);
        return [{ id: record.id }];
      },
      getRecord: async () => record,
    };
    const host = mountWithProps(PopupApp, {
      runtime,
      settingsStore: {
        load: async () => ({ ...DEFAULT_SETTINGS }),
      },
    });
    const input = host.querySelector('[aria-label="검색어"]');

    input.focus();
    input.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    input.value = '담';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const composingEnter = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    });
    input.dispatchEvent(composingEnter);
    await flush();

    expect(composingEnter.defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
    expect(host.querySelector('[data-dictionary-record]')).toBeNull();

    input.value = record.lemma;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('compositionend', { bubbles: true }));
    const committedEnter = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    });
    input.dispatchEvent(committedEnter);
    await flush();

    expect(committedEnter.defaultPrevented).toBe(true);
    expect(calls).toEqual([record.lemma]);
    expect(host.querySelector('[data-record-id="w026"]')).not.toBeNull();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(0);
  });

  it('moves, selects, and restores focus for multiple keyboard candidates', async () => {
    const records = new Map([
      ['first', makeRecord('first', '첫 번째')],
      ['second', makeRecord('second', '두 번째', 'start', [{
        position: 0,
        target: 'target',
        target_sense: 'target-s1',
        type: 'direct',
        target_lemma: '관계 대상',
        target_pos: 'noun',
        target_gloss: '관계 대상 뜻풀이',
      }])],
      ['target', makeRecord('target', '관계 대상', 'reference-only')],
    ]);
    const calls = [];
    const runtime = {
      search: async (term) => {
        calls.push(term);
        return [{ id: 'first' }, { id: 'second' }];
      },
      getRecord: async (id) => records.get(id) || null,
    };
    const host = mountWithProps(PopupApp, {
      runtime,
      settingsStore: {
        load: async () => ({ ...DEFAULT_SETTINGS }),
      },
    });
    const input = host.querySelector('[aria-label="검색어"]');
    input.value = '후보';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    host.querySelector('.search-row').dispatchEvent(new Event('submit', {
      bubbles: true,
      cancelable: true,
    }));
    await flush();

    const options = () => [...host.querySelectorAll('[role="option"]')];
    expect(options()).toHaveLength(2);
    expect(options()[0].getAttribute('tabindex')).toBe('-1');
    expect(options()[0].getAttribute('aria-selected')).toBe('false');

    const firstDown = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowDown',
    });
    input.dispatchEvent(firstDown);
    await flush();
    expect(firstDown.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(options()[0]);
    expect(options()[0].getAttribute('aria-selected')).toBe('true');

    const secondDown = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowDown',
    });
    options()[0].dispatchEvent(secondDown);
    await flush();
    expect(secondDown.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(options()[1]);
    expect(options()[1].getAttribute('aria-selected')).toBe('true');

    const boundaryDown = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowDown',
    });
    options()[1].dispatchEvent(boundaryDown);
    await flush();
    expect(document.activeElement).toBe(options()[1]);

    const relationLink = host.querySelector('[data-record-id="second"] [data-target-record-id="target"]');

    const enter = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    });
    options()[1].dispatchEvent(enter);
    await flush();
    expect(enter.defaultPrevented).toBe(true);
    expect(calls).toEqual(['후보']);
    expect(document.activeElement).toBe(relationLink);

    const up = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowUp',
    });
    options()[1].dispatchEvent(up);
    await flush();
    expect(document.activeElement).toBe(options()[0]);
    expect(options()[0].getAttribute('aria-selected')).toBe('true');

    relationLink.focus();
    expect(document.activeElement).toBe(relationLink);
    expect(relationLink.tabIndex).toBe(0);
    relationLink.click();
    await flush();
    expect(host.querySelector('[data-record-id="target"]')).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(host.querySelector('.back-button')).not.toBeNull();
    expect(host.querySelector('[role="option"][aria-selected="true"]')).toBeNull();
  });

  it('shows a clear control and keeps results while the first Escape clears only the query', async () => {
    const record = makeRecord('w026', '담담하다');
    const runtime = {
      search: async () => [{ id: record.id }],
      getRecord: async () => record,
    };
    const host = mountWithProps(PopupApp, {
      runtime,
      settingsStore: {
        load: async () => ({ ...DEFAULT_SETTINGS }),
      },
    });
    const input = host.querySelector('[aria-label="검색어"]');
    const form = host.querySelector('.search-row');

    input.value = record.lemma;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(host.querySelector('.search-clear-button')).not.toBeNull();
    expect(host.querySelector('[data-record-id="w026"]')).not.toBeNull();

    host.querySelector('.search-clear-button').click();
    await flush();

    expect(input.value).toBe('');
    expect(host.querySelector('[data-record-id="w026"]')).not.toBeNull();
    expect(host.querySelector('.dictionary-scroll-region')).not.toBeNull();
    expect(host.querySelector('.dictionary-empty-region')).toBeNull();
    expect(host.querySelector('.search-clear-button')).toBeNull();

    input.value = record.lemma;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    const firstEscape = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    });
    input.dispatchEvent(firstEscape);
    await flush();

    expect(firstEscape.defaultPrevented).toBe(true);
    expect(input.value).toBe('');
    expect(host.querySelector('[data-record-id="w026"]')).not.toBeNull();
    expect(host.querySelector('.dictionary-scroll-region')).not.toBeNull();
    expect(host.querySelector('.dictionary-empty-region')).toBeNull();

    const secondEscape = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    });
    input.dispatchEvent(secondEscape);
    expect(secondEscape.defaultPrevented).toBe(false);
  });

  it('keeps the current result visible while a later search is pending', async () => {
    let releaseFirstSearch;
    const firstSearch = new Promise((resolve) => {
      releaseFirstSearch = () => resolve([{ id: 'first' }]);
    });
    let releaseSecondSearch;
    const secondSearch = new Promise((resolve) => {
      releaseSecondSearch = () => resolve([{ id: 'second' }]);
    });
    const records = new Map([
      ['first', makeRecord('first', '첫 단어')],
      ['second', makeRecord('second', '두 번째')],
    ]);
    const runtime = {
      search: async (term) => (term === '첫 단어' ? firstSearch : secondSearch),
      getRecord: async (id) => records.get(id) || null,
    };
    const host = mountWithProps(PopupApp, {
      runtime,
      settingsStore: {
        load: async () => ({ ...DEFAULT_SETTINGS }),
      },
    });
    const input = host.querySelector('[aria-label="검색어"]');
    const form = host.querySelector('.search-row');

    async function submit(term) {
      input.value = term;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
    }

    const pendingFirstSearch = submit('첫 단어');
    await nextTick();
    await nextTick();
    expect(host.querySelector('[data-search-state="loading"]')).toBeNull();
    expect(host.querySelector('.dictionary-empty-region.is-loading')).not.toBeNull();

    releaseFirstSearch();
    await pendingFirstSearch;
    await flush();
    expect(host.querySelector('[data-record-id="first"]')).not.toBeNull();

    const pendingSearch = submit('두 번째');
    await nextTick();
    await nextTick();

    expect(host.querySelector('[data-record-id="first"]')).not.toBeNull();
    expect(host.querySelector('[data-dictionary-panel].has-results')).not.toBeNull();
    expect(host.querySelector('[data-dictionary-panel][aria-busy="true"]')).not.toBeNull();
    expect(host.querySelector('[data-search-state="loading"]')).toBeNull();

    const firstEscape = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    });
    input.dispatchEvent(firstEscape);
    await flush();

    expect(firstEscape.defaultPrevented).toBe(true);
    expect(input.value).toBe('');
    expect(host.querySelector('[data-record-id="first"]')).not.toBeNull();
    expect(host.querySelector('[data-record-id="second"]')).toBeNull();
    expect(host.querySelector('[data-dictionary-panel][aria-busy="true"]')).toBeNull();

    releaseSecondSearch();
    await pendingSearch;
    await flush();
    expect(host.querySelector('[data-record-id="first"]')).not.toBeNull();
    expect(host.querySelector('[data-record-id="second"]')).toBeNull();
  });

  it('stays idle when the first pending search is cleared before it resolves', async () => {
    let releaseSearch;
    const pendingSearch = new Promise((resolve) => {
      releaseSearch = resolve;
    });
    const record = makeRecord('first', '첫 결과');
    const runtime = {
      search: async () => pendingSearch,
      getRecord: async () => record,
    };
    const host = mountWithProps(PopupApp, {
      runtime,
      settingsStore: {
        load: async () => ({ ...DEFAULT_SETTINGS }),
      },
    });
    const input = host.querySelector('[aria-label="검색어"]');
    const form = host.querySelector('.search-row');

    input.value = '지운 검색';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(host.querySelector('.dictionary-empty-region.is-loading')).not.toBeNull();

    const firstEscape = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    });
    input.dispatchEvent(firstEscape);
    await flush();

    expect(firstEscape.defaultPrevented).toBe(true);
    expect(input.value).toBe('');
    expect(host.querySelector('.dictionary-empty-region')).not.toBeNull();
    expect(host.querySelector('.dictionary-empty-region.is-loading')).toBeNull();
    expect(host.querySelector('[data-record-id="first"]')).toBeNull();

    releaseSearch([{ id: record.id }]);
    await flush();
    expect(host.querySelector('.dictionary-empty-region')).not.toBeNull();
    expect(host.querySelector('.dictionary-empty-region.is-loading')).toBeNull();
    expect(host.querySelector('[data-record-id="first"]')).toBeNull();
  });

  it('renders all distinct runtime states with retry and error copy', async () => {
    let mode = 'empty';
    const runtime = {
      search: async () => {
        if (mode === 'load') {
          throw Object.assign(new Error('WASM missing'), {
            code: 'WASM_LOAD_FAILED',
            details: { phase: 'load' },
          });
        }
        if (mode === 'query') {
          throw Object.assign(new Error('SQL failed'), {
            code: 'QUERY_FAILED',
            details: { phase: 'query' },
          });
        }
        if (mode === 'unsupported') {
          return {
            rawQuery: '마음이  놓이다',
            normalizedQuery: '마음이  놓이다',
            normalizationRules: [],
            status: 'unsupported',
            reason: 'internal-whitespace-not-normalized',
            matches: [],
          };
        }
        if (mode === 'gap') return [{ id: 'gap' }];
        return [];
      },
      getRecord: async (id) => (id === 'gap' ? makeRecord('gap', '마당') : null),
    };
    const host = mountWithProps(PopupApp, {
      runtime,
      settingsStore: {
        load: async () => ({ ...DEFAULT_SETTINGS }),
      },
    });
    const input = host.querySelector('[aria-label="검색어"]');

    async function submit(term) {
      input.value = term;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      host.querySelector('.search-row').dispatchEvent(new Event('submit', {
        bubbles: true,
        cancelable: true,
      }));
      await flush();
    }

    await submit('없는 말');
    expect(host.querySelector('[data-search-state="empty"]')).not.toBeNull();
    expect(host.querySelector('[data-search-category="no-data"]')).not.toBeNull();
    expect(host.textContent).toContain('사전에 없는 말입니다.');
    expect(host.querySelector('.state-copy').textContent.trim()).toContain('사전에 없는 말입니다.');
    expect(host.querySelector('.state-copy span').textContent.trim()).toBe('자주 쓰는 말이라면 등록을 요청해 보세요.');
    expect(host.querySelector('.retry-button')).toBeNull();

    mode = 'unsupported';
    await submit('마음이  놓이다');
    expect(host.querySelector('[data-search-category="unsupported"]')).not.toBeNull();
    expect(host.querySelector('[data-search-reason="internal-whitespace-not-normalized"]')).not.toBeNull();
    expect(host.textContent).toContain('지원하지 않는 입력 형식입니다.');
    expect(host.textContent).toContain('사전에 등록된 공백 그대로');
    expect(host.querySelector('.retry-button')).toBeNull();

    mode = 'load';
    await submit('load');
    expect(host.querySelector('[data-search-state="error"]')).not.toBeNull();
    expect(host.textContent).toContain('사전을 불러오지 못했습니다.');

    mode = 'query';
    await submit('query');
    expect(host.textContent).toContain('검색을 처리하지 못했습니다.');

    mode = 'gap';
    await submit('마당');
    expect(host.querySelector('[data-record-id="gap"]')).not.toBeNull();
    expect(host.querySelector('[data-editorial-gap]')).not.toBeNull();
    expect(host.textContent).toContain('연결된 관계어는 아직 정리되지 않았습니다.');
  });

  it('shows dirty state until Settings are explicitly saved', async () => {
    let stored = { ...DEFAULT_SETTINGS };
    let saveCalls = 0;
    const settingsStore = {
      load: async () => ({ ...stored }),
      save: async (value) => {
        saveCalls += 1;
        stored = { ...value };
        return { ...stored };
      },
    };
    const host = mountWithProps(OptionsApp, { settingsStore });
    await flush();

    const switches = [...host.querySelectorAll('[role="switch"]')];
    expect(switches).toHaveLength(5);
    expect(switches[0].getAttribute('aria-checked')).toBe('true');
    expect(switches[2].getAttribute('aria-checked')).toBe('false');
    expect(host.querySelector('[data-group-id="synonyms"]')).not.toBeNull();
    expect(host.querySelector('[data-group-id="antonyms"]')).toBeNull();

    switches[2].click();
    await flush();
    expect(stored.antonyms).toBe(false);
    expect(host.querySelector('.save-status').textContent).toContain('저장되지 않음');
    expect(host.querySelector('.save-button').disabled).toBe(false);
    expect(host.querySelector('[data-group-id="antonyms"]')).not.toBeNull();

    switches[0].click();
    await flush();
    expect(stored.definition).toBe(true);
    expect(host.querySelector('[data-group-id="definition"]')).toBeNull();

    host.querySelector('.save-button').click();
    await flush();
    expect(saveCalls).toBe(1);
    expect(stored).toEqual({
      ...DEFAULT_SETTINGS,
      definition: false,
      antonyms: true,
    });
    expect(host.querySelector('.save-status').textContent).toContain('저장됨');
    expect(host.querySelector('.save-button').disabled).toBe(true);
  });

  it('locks setting edits while loading and while an explicit save is pending', async () => {
    let resolveLoad;
    let resolveSave;
    let saveCalls = 0;
    const loaded = new Promise((resolve) => {
      resolveLoad = () => resolve({ ...DEFAULT_SETTINGS });
    });
    const settingsStore = {
      load: () => loaded,
      save: (value) => {
        saveCalls += 1;
        return new Promise((resolve) => {
          resolveSave = () => resolve({ ...value });
        });
      },
    };
    const host = mountWithProps(OptionsApp, { settingsStore });
    const firstSwitch = host.querySelector('[role="switch"]');

    expect(firstSwitch.disabled).toBe(true);
    firstSwitch.click();
    expect(host.querySelector('.save-status').textContent).toContain('불러오는 중');

    resolveLoad();
    await flush();
    expect(firstSwitch.disabled).toBe(false);

    firstSwitch.click();
    await flush();
    const saveButton = host.querySelector('.save-button');
    saveButton.click();
    saveButton.click();
    await flush();
    expect(saveCalls).toBe(1);
    expect(host.querySelectorAll('[role="switch"]:disabled')).toHaveLength(5);

    firstSwitch.click();
    expect(host.querySelector('.save-status').textContent).toContain('저장 중');

    resolveSave();
    await flush();
    expect(host.querySelectorAll('[role="switch"]:disabled')).toHaveLength(0);
    expect(host.querySelector('.save-status').textContent).toContain('저장됨');
  });
});
