// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick } from 'vue';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import WebApp from '../web/src/App.vue';

const mountedApps = [];
const STORE_URL =
  'https://chromewebstore.google.com/detail/typewriter/dpifnfihnakglmffddnhmefbllmnbbmk';

function mount(component) {
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(component);
  app.mount(host);
  mountedApps.push({ app, host });
  return host;
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe('Typewriter Web static landing page', () => {
  it('introduces the Chrome Extension without any dictionary search surface', async () => {
    const web = mount(WebApp);
    await nextTick();

    expect(web.querySelector('[data-product-surface="web-landing"]')).not.toBeNull();
    expect(web.querySelector('h1').textContent.replace(/\s+/gu, ''))
      .toBe('더좋은단어가,더넓은이야기를만듭니다.');
    for (const label of ['유의어', '반의어', '말의 결', '연상']) {
      expect(web.textContent).toContain(label);
    }
    expect(web.querySelector('input, [data-dictionary-panel], [role="search"]')).toBeNull();
    expect(web.textContent).not.toContain('다시 시도');
  });

  it('keeps one h1, non-skipping heading levels, and the Chrome Web Store CTAs', async () => {
    const web = mount(WebApp);
    await nextTick();

    const levels = [...web.querySelectorAll('h1, h2, h3')].map((node) => Number(node.tagName[1]));
    expect(levels.filter((level) => level === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
    levels.slice(1).forEach((level, index) => {
      expect(level - levels[index]).toBeLessThanOrEqual(1);
    });

    const storeLinks = [...web.querySelectorAll(`a[href="${STORE_URL}"]`)];
    expect(storeLinks.length).toBeGreaterThanOrEqual(2);
    for (const anchor of web.querySelectorAll('a[href^="#"]')) {
      expect(web.querySelector(anchor.getAttribute('href'))).not.toBeNull();
    }
  });

  it('keeps web source and assets separate from the Chrome Extension public tree', async () => {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const [
      webSource,
      webConfig,
      html,
      aboutHtml,
      webFavicon,
      extensionFavicon,
      extensionIcon16,
    ] = await Promise.all([
      readFile(path.join(repositoryRoot, 'web/src/App.vue'), 'utf8'),
      readFile(path.join(repositoryRoot, 'vite.web.config.js'), 'utf8'),
      readFile(path.join(repositoryRoot, 'web/index.html'), 'utf8'),
      readFile(path.join(repositoryRoot, 'web/about/index.html'), 'utf8'),
      readFile(path.join(repositoryRoot, 'web/public/favicon.ico')),
      readFile(path.join(repositoryRoot, 'public/favicon.ico')),
      readFile(path.join(repositoryRoot, 'public/icon16.png')),
    ]);

    expect(webSource).not.toMatch(/src\/(?:runtime|domain|components)|DictionaryPanel|sqlite|chrome\./u);
    expect(webConfig).toContain("root: webRoot");
    expect(webConfig).toContain("path.join(webRoot, 'public')");
    expect(html).toContain('href="/favicon.ico"');
    expect(aboutHtml).toContain('href="/favicon.ico"');
    expect(aboutHtml).toContain('http-equiv="refresh"');
    expect(html).not.toContain('favicon.svg');
    expect(aboutHtml).not.toContain('favicon.svg');
    expect(webFavicon).toEqual(extensionFavicon);
    const faviconImageOffset = extensionFavicon.readUInt32LE(18);
    const faviconImageLength = extensionFavicon.readUInt32LE(14);
    expect(extensionFavicon.subarray(
      faviconImageOffset,
      faviconImageOffset + faviconImageLength,
    )).toEqual(extensionIcon16);
    expect(html).not.toContain('manifest.json');
    expect(html).not.toContain('options.html');
  });
});
