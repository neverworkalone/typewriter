import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { PRODUCT_LEGAL_FILES } from './validate/product-output-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webOutput = path.resolve(
  process.env.TYPEWRITER_WEB_BUILD_OUTPUT_DIRECTORY ?? path.join(repositoryRoot, 'dist-web'),
);
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.png', 'image/png'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

function isInside(directory, filePath) {
  return filePath === directory || filePath.startsWith(directory + path.sep);
}

function serveWebOutput() {
  const requests = new Set();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/typewriter' && !url.pathname.startsWith('/typewriter/')) {
        response.writeHead(404).end('Not found');
        return;
      }
      let relativePath = decodeURIComponent(url.pathname.slice('/typewriter'.length));
      relativePath = relativePath.replace(/^\/+/, '') || 'index.html';
      let filePath = path.resolve(webOutput, relativePath);
      if (!isInside(webOutput, filePath)) {
        response.writeHead(400).end('Invalid path');
        return;
      }
      try {
        if ((await stat(filePath)).isDirectory()) filePath = path.join(filePath, 'index.html');
      } catch {
        // The read below returns the same 404 path for missing assets.
      }
      const bytes = await readFile(filePath);
      requests.add(url.pathname);
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': contentTypes.get(path.extname(filePath)) || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(bytes);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  return { server, requests };
}

async function assertNoHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  assert.ok(
    dimensions.documentWidth <= dimensions.viewportWidth,
    `${label} overflows horizontally: ${dimensions.documentWidth}px in a ${dimensions.viewportWidth}px viewport`,
  );
}

async function main() {
  const { server, requests } = serveWebOutput();
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const webOrigin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'chromium', headless: true });
    const context = await browser.newContext();

    // Static landing page: rendering, responsiveness, navigation, CTA, keyboard
    // access, and a network log that proves no dictionary is requested.
    const pageErrors = [];
    const webRequests = [];
    const webPage = await context.newPage();
    webPage.on('pageerror', (error) => pageErrors.push(`web: ${error.message}`));
    webPage.on('request', (request) => webRequests.push(new URL(request.url())));
    const landing = await webPage.goto(`${webOrigin}/typewriter/`, { waitUntil: 'networkidle' });
    assert.equal(landing?.status(), 200);
    await webPage.locator('[data-product-surface="web-landing"]').waitFor();
    const headline = (await webPage.getByRole('heading', { level: 1 }).innerText())
      .replace(/\s+/gu, ' ');
    assert.equal(headline, '더 좋은 단어가, 더 넓은 이야기를 만듭니다.');
    assert.equal(await webPage.getByRole('textbox').count(), 0, 'landing must not offer a search box');
    assert.equal(await webPage.locator('[data-dictionary-panel]').count(), 0);

    const headingLevels = await webPage.locator('h1, h2, h3').evaluateAll((nodes) => (
      nodes.map((node) => Number(node.tagName.slice(1)))
    ));
    assert.equal(headingLevels[0], 1);
    assert.equal(headingLevels.filter((level) => level === 1).length, 1);
    headingLevels.slice(1).forEach((level, index) => {
      assert.ok(level - headingLevels[index] <= 1, 'heading levels must not skip');
    });

    const storeLinks = await webPage.getByRole('link', { name: /크롬 웹 스토어/u }).evaluateAll((links) => (
      links.map((link) => link.href)
    ));
    assert.ok(storeLinks.length >= 2);
    for (const href of storeLinks) {
      assert.equal(
        href,
        'https://chromewebstore.google.com/detail/typewriter/dpifnfihnakglmffddnhmefbllmnbbmk',
      );
    }

    // Keyboard: the skip link is the first tab stop and focus is visible.
    await webPage.keyboard.press('Tab');
    assert.equal(await webPage.evaluate(() => document.activeElement?.className), 'skip-link');
    await webPage.keyboard.press('Enter');
    assert.equal(new URL(webPage.url()).hash, '#main');
    // Focus moved to #main, so every remaining link after it must be reachable
    // and visibly focused.
    const linksAfterMain = await webPage.evaluate(() => (
      [...document.querySelectorAll('a[href]')].filter((link) => (
        document.querySelector('#main').compareDocumentPosition(link)
          & Node.DOCUMENT_POSITION_FOLLOWING
      )).length
    ));
    assert.ok(linksAfterMain >= 6);
    for (let index = 0; index < linksAfterMain; index += 1) {
      await webPage.keyboard.press('Tab');
      const outline = await webPage.evaluate(() => (
        getComputedStyle(document.activeElement).outlineStyle
      ));
      assert.notEqual(outline, 'none', 'focused controls must show a focus indicator');
    }

    // The legacy /about/ anchor target still exists on the landing page.
    await webPage.locator('#philosophy').waitFor();

    // Contrast: every visible text node must meet WCAG AA against the nearest
    // opaque ancestor background (3:1 for large text), at desktop and mobile.
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await webPage.setViewportSize(viewport);
      const failures = await webPage.evaluate(() => {
        const parse = (value) => value.match(/[\d.]+/gu).map(Number);
        const channel = (v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        const opaqueBackground = (element) => {
          for (let node = element; node; node = node.parentElement) {
            const [r, g, b, a = 1] = parse(getComputedStyle(node).backgroundColor);
            if (a === 1) return [r, g, b];
          }
          return [255, 255, 255];
        };
        const found = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
          const element = text.parentElement;
          if (!text.textContent.trim() || element.closest('[aria-hidden="true"]')) continue;
          const style = getComputedStyle(element);
          if (style.display === 'none' || element.getClientRects().length === 0) continue;
          const [r, g, b, a = 1] = parse(style.color);
          if (a < 1) continue;
          const lighter = Math.max(luminance([r, g, b]), luminance(opaqueBackground(element)));
          const darker = Math.min(luminance([r, g, b]), luminance(opaqueBackground(element)));
          const ratio = (lighter + 0.05) / (darker + 0.05);
          const size = parseFloat(style.fontSize);
          const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
          if (ratio < (large ? 3 : 4.5)) {
            found.push(`${text.textContent.trim().slice(0, 24)} ${ratio.toFixed(2)}`);
          }
        }
        return found;
      });
      assert.deepEqual(failures, [], `text contrast at ${viewport.width}px`);
    }

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1280, height: 800 },
    ]) {
      await webPage.setViewportSize(viewport);
      await assertNoHorizontalOverflow(webPage, `landing at ${viewport.width}px`);
    }

    const legalAccess = await webPage.evaluate(async (fileNames) => (
      Promise.all(fileNames.map(async (fileName) => (
        (await fetch(`./${fileName}`)).status
      )))
    ), PRODUCT_LEGAL_FILES);
    assert.deepEqual(legalAccess, PRODUCT_LEGAL_FILES.map(() => 200));

    // /about/ stays valid by redirecting to the landing page.
    const aboutPage = await context.newPage();
    const aboutRequests = [];
    aboutPage.on('request', (request) => aboutRequests.push(new URL(request.url())));
    await aboutPage.goto(`${webOrigin}/typewriter/about/`, { waitUntil: 'load' });
    await aboutPage.waitForURL(`${webOrigin}/typewriter/#philosophy`);
    await aboutPage.locator('[data-product-surface="web-landing"]').waitFor();

    const forbidden = /dictionary\.sqlite|\.wasm$|\/runtime\//u;
    for (const url of [...webRequests, ...aboutRequests]) {
      assert.ok(!forbidden.test(url.pathname), `landing must not request ${url.pathname}`);
    }
    assert.equal(
      [...requests].filter((pathname) => /sqlite|\.wasm|\/runtime\//u.test(pathname)).length,
      0,
      'static server must not have served any dictionary or runtime file',
    );

    assert.deepEqual(pageErrors, [], 'landing must not report runtime errors');
    console.log('Static landing page passed in Chromium; no dictionary or WASM requested.');
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
