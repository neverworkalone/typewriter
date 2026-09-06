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
  });

  it('searches on Enter, moves through relation targets, and restores with back', async () => {
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

    host.querySelector('.back-button').click();
    await flush();
    expect(host.querySelector('[data-record-id="w026"]')).not.toBeNull();
    expect(host.querySelector('[data-record-id="r008"]')).toBeNull();
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
        return [];
      },
      getRecord: async () => null,
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
    expect(host.textContent).toContain('검색 결과가 없습니다.');

    mode = 'load';
    await submit('load');
    expect(host.querySelector('[data-search-state="error"]')).not.toBeNull();
    expect(host.textContent).toContain('사전과 WASM을 불러오지 못했습니다.');

    mode = 'query';
    await submit('query');
    expect(host.textContent).toContain('검색 중 오류가 발생했습니다.');
  });

  it('persists settings toggles and applies them to the shared preview renderer', async () => {
    let stored = { ...DEFAULT_SETTINGS };
    const settingsStore = {
      load: async () => ({ ...stored }),
      save: async (value) => {
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
    expect(stored.antonyms).toBe(true);
    expect(host.querySelector('[data-group-id="antonyms"]')).not.toBeNull();

    switches[0].click();
    await flush();
    expect(stored.definition).toBe(false);
    expect(host.querySelector('[data-group-id="definition"]')).toBeNull();
  });
});
