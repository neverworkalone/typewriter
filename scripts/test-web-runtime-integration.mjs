import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import {
  PRODUCT_LEGAL_FILES,
  validateProductOutputContract,
} from './validate/product-output-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionOutput = path.resolve(
  process.env.TYPEWRITER_BUILD_OUTPUT_DIRECTORY ?? path.join(repositoryRoot, 'dist'),
);
const webOutput = path.resolve(
  process.env.TYPEWRITER_WEB_BUILD_OUTPUT_DIRECTORY ?? path.join(repositoryRoot, 'dist-web'),
);
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.sqlite', 'application/vnd.sqlite3'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
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
        const fileStat = await stat(filePath);
        if (fileStat.isDirectory()) filePath = path.join(filePath, 'index.html');
      } catch {
        // The file read below returns the same 404 path for missing assets.
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

async function waitForRuntimeReady(page, label) {
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-product-surface]');
    return root?.dataset.runtimeQueryOnly === '1'
      && root.dataset.runtimeWriteBlocked === 'true'
      && root.dataset.runtimePersistedWriteCount === '0';
  }, undefined, { timeout: 30000 });

  const identity = await page.locator('[data-product-surface]').evaluate((root) => ({
    surface: root.dataset.productSurface,
    queryOnly: root.dataset.runtimeQueryOnly,
    writeBlocked: root.dataset.runtimeWriteBlocked,
    persistedWrites: root.dataset.runtimePersistedWriteCount,
  }));
  assert.equal(identity.surface, label);
  assert.equal(identity.queryOnly, '1');
  assert.equal(identity.writeBlocked, 'true');
  assert.equal(identity.persistedWrites, '0');
}

async function search(page, term) {
  const searchBox = page.getByRole('textbox', { name: '검색어', exact: true });
  await searchBox.fill(term);
  await searchBox.press('Enter');
  await page.waitForFunction((expectedTerm) => {
    const input = document.querySelector('[aria-label="검색어"]');
    const panel = document.querySelector('[data-dictionary-panel]');
    return input?.value === expectedTerm
      && panel?.getAttribute('aria-busy') === 'false'
      && panel.querySelector('[data-dictionary-record]');
  }, term, { timeout: 30000 });
  return snapshot(page);
}

async function snapshot(page) {
  return page.evaluate(() => ({
    recordIds: [...document.querySelectorAll('[data-dictionary-record]')]
      .map((record) => record.getAttribute('data-record-id')),
    visibleSenseIds: [...document.querySelectorAll('.sense-block')]
      .map((sense) => sense.getAttribute('data-sense-id')),
    candidateSenseIds: [...document.querySelectorAll('[role="option"][data-sense-id]')]
      .map((candidate) => candidate.getAttribute('data-sense-id')),
    selectedCandidateSenseId: document.querySelector(
      '[role="option"][aria-selected="true"][data-sense-id]',
    )?.getAttribute('data-sense-id') ?? null,
  }));
}

async function waitForRecord(page, recordId) {
  await page.waitForFunction((expectedRecordId) => (
    document.querySelector(`[data-dictionary-record][data-record-id="${expectedRecordId}"]`)
      && document.querySelector('[data-dictionary-panel]')?.getAttribute('aria-busy') === 'false'
  ), recordId, { timeout: 30000 });
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
  await validateProductOutputContract({
    root: repositoryRoot,
    extensionOutput,
    webOutput,
  });

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'typewriter-web-integration-'));
  const extensionFixture = path.join(temporaryRoot, 'extension');
  const userDataDirectory = path.join(temporaryRoot, 'browser-profile');
  await cp(extensionOutput, extensionFixture, { recursive: true });

  // Add a test-only service worker so Chromium exposes the generated extension ID.
  const manifestPath = path.join(extensionFixture, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.background = { service_worker: 'test-extension-id.js' };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await writeFile(
    path.join(extensionFixture, 'test-extension-id.js'),
    'chrome.runtime.onInstalled.addListener(() => {});\n',
  );

  const { server, requests } = serveWebOutput();
  let context;

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const webOrigin = `http://127.0.0.1:${address.port}`;

    context = await chromium.launchPersistentContext(userDataDirectory, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionFixture}`,
        `--load-extension=${extensionFixture}`,
      ],
    });

    let extensionWorker = context.serviceWorkers()[0];
    if (!extensionWorker) {
      extensionWorker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    }
    const extensionId = new URL(extensionWorker.url()).hostname;
    assert.match(extensionId, /^[a-p]{32}$/u, 'test extension must load in Chromium');

    const pageErrors = [];
    const extensionPage = await context.newPage();
    extensionPage.on('pageerror', (error) => pageErrors.push(`extension: ${error.message}`));
    await extensionPage.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: 'load',
    });
    await waitForRuntimeReady(extensionPage, 'popup');

    for (const term of [
      '담담하다',
      '담담',
      '쓰다',
      '마음이 놓이다',
      '바라보는',
      '썼다',
      '들었다',
      '바라봤다',
      '달',
    ]) {
      const popupSnapshot = await search(extensionPage, term);
      assert.ok(popupSnapshot.recordIds.length > 0, `${term} must resolve in the extension`);
    }

    const popupInflectionCollision = await search(extensionPage, '들었다');
    assert.deepEqual(popupInflectionCollision.recordIds, ['w201']);
    assert.deepEqual(popupInflectionCollision.candidateSenseIds, [
      'w201-s1',
      'w201-s2',
      'w2797-s1',
    ]);
    await extensionPage.locator('[role="option"][data-sense-id="w2797-s1"]').click();
    await waitForRecord(extensionPage, 'w2797');
    const popupSelectedInflectionCollision = await snapshot(extensionPage);
    assert.deepEqual(popupSelectedInflectionCollision.recordIds, ['w2797']);
    assert.deepEqual(popupSelectedInflectionCollision.visibleSenseIds, ['w2797-s1']);

    const popupPolysemy = await search(extensionPage, '쓰다');
    assert.deepEqual(popupPolysemy.recordIds, ['w237']);
    assert.deepEqual(popupPolysemy.candidateSenseIds, [
      'w237-s1',
      'w237-s2',
      'w237-s3',
      'w237-s4',
    ]);
    assert.deepEqual(popupPolysemy.visibleSenseIds, ['w237-s1']);

    await extensionPage.locator('[role="option"][data-sense-id="w237-s2"]').click();
    await extensionPage.waitForFunction(() => (
      document.querySelector('[role="option"][aria-selected="true"]')
        ?.getAttribute('data-sense-id') === 'w237-s2'
      && document.querySelector('.sense-block')?.getAttribute('data-sense-id') === 'w237-s2'
    ));
    assert.deepEqual((await snapshot(extensionPage)).visibleSenseIds, ['w237-s2']);

    await search(extensionPage, '담담하다');
    await extensionPage.locator('[data-target-record-id="r008"]').click();
    await waitForRecord(extensionPage, 'r008');
    const popupRelationTarget = await snapshot(extensionPage);
    assert.deepEqual(popupRelationTarget.recordIds, ['r008']);
    assert.deepEqual(popupRelationTarget.visibleSenseIds, ['r008-s1']);

    // Static landing page: rendering, responsiveness, navigation, CTA, keyboard
    // access, and a network log that proves no dictionary is requested.
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

    assert.deepEqual(pageErrors, [], 'product pages must not report runtime errors');
    console.log('Extension search and static landing page passed in Chromium.');
  } finally {
    await context?.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
