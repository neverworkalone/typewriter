// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from 'vue';

import PopupApp from '../src/popup/App.vue';
import OptionsApp from '../src/options/App.vue';

const mountedApps = [];

function mount(component) {
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(component);
  app.mount(host);
  mountedApps.push({app, host});
  return host;
}

afterEach(() => {
  for (const {app, host} of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe('product MV3 Vue shells', () => {
  it('mounts the popup shell without dictionary fixture data', () => {
    const host = mount(PopupApp);

    expect(host.querySelector('[data-product-surface="popup"]')).not.toBeNull();
    expect(host.textContent).toContain('말의 결을 찾는 사전');
    expect(host.querySelector('[data-dictionary-record]')).toBeNull();
  });

  it('mounts the options shell independently from the popup', () => {
    const host = mount(OptionsApp);

    expect(host.querySelector('[data-product-surface="options"]')).not.toBeNull();
    expect(host.textContent).toContain('설정');
  });
});
