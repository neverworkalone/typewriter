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
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
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
    assert.equal(headline, '작가를 위한, 말의 결을 찾는 사전.');
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

    const storeLinks = await webPage.getByRole('link', { name: /Chrome/u }).evaluateAll((links) => (
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
    for (let index = 0; index < 8; index += 1) {
      await webPage.keyboard.press('Tab');
      const outline = await webPage.evaluate(() => (
        getComputedStyle(document.activeElement).outlineStyle
      ));
      assert.notEqual(outline, 'none', 'focused controls must show a focus indicator');
    }

    // In-page navigation lands on the matching section.
    await webPage.getByRole('link', { name: '철학', exact: true }).click();
    assert.equal(new URL(webPage.url()).hash, '#philosophy');
    await webPage.locator('#philosophy').waitFor();

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
