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

    const webPage = await context.newPage();
    webPage.on('pageerror', (error) => pageErrors.push(`web: ${error.message}`));
    await webPage.goto(`${webOrigin}/typewriter/`, { waitUntil: 'load' });
    await waitForRuntimeReady(webPage, 'web');

    const legalAccess = await webPage.evaluate(async (fileNames) => (
      Promise.all(fileNames.map(async (fileName) => {
        const response = await fetch(`./${fileName}`);
        const visibleLink = [...document.querySelectorAll('a[href]')]
          .some((anchor) => anchor.getAttribute('href') === `./${fileName}`);
        return { fileName, visibleLink, status: response.status };
      }))
    ), PRODUCT_LEGAL_FILES);
    assert.deepEqual(legalAccess, PRODUCT_LEGAL_FILES.map((fileName) => ({
      fileName,
      visibleLink: false,
      status: 200,
    })), 'web must package legal files without requiring visible links');

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
      const webSnapshot = await search(webPage, term);
      assert.deepEqual(webSnapshot, popupSnapshot, `${term} product parity`);
    }

    const popupInflectionCollision = await search(extensionPage, '들었다');
    const webInflectionCollision = await search(webPage, '들었다');
    assert.deepEqual(popupInflectionCollision.recordIds, ['w201', 'w2797']);
    assert.deepEqual(popupInflectionCollision.candidateSenseIds, [
      'w201-s1',
      'w201-s2',
      'w2797-s1',
    ]);
    assert.deepEqual(webInflectionCollision, popupInflectionCollision);

    const popupPolysemy = await search(extensionPage, '쓰다');
    const webPolysemy = await search(webPage, '쓰다');
    const expectedCandidateSenses = ['w237-s1', 'w237-s2', 'w237-s3', 'w237-s4'];
    assert.deepEqual(popupPolysemy.recordIds, ['w237']);
    assert.deepEqual(popupPolysemy.candidateSenseIds, expectedCandidateSenses);
    assert.deepEqual(popupPolysemy.visibleSenseIds, ['w237-s1']);
    assert.deepEqual(webPolysemy, popupPolysemy);

    for (const page of [extensionPage, webPage]) {
      await page.locator('[role="option"][data-sense-id="w237-s2"]').click();
      await page.waitForFunction(() => (
        document.querySelector('[role="option"][aria-selected="true"]')
          ?.getAttribute('data-sense-id') === 'w237-s2'
        && document.querySelector('.sense-block')?.getAttribute('data-sense-id') === 'w237-s2'
      ));
    }
    const popupSelectedSense = await snapshot(extensionPage);
    const webSelectedSense = await snapshot(webPage);
    assert.deepEqual(popupSelectedSense, webSelectedSense, 'selected sense parity');
    assert.deepEqual(popupSelectedSense.visibleSenseIds, ['w237-s2']);

    await search(extensionPage, '담담하다');
    await search(webPage, '담담하다');
    for (const page of [extensionPage, webPage]) {
      await page.locator('[data-target-record-id="r008"]').click();
      await waitForRecord(page, 'r008');
    }
    const popupRelationTarget = await snapshot(extensionPage);
    const webRelationTarget = await snapshot(webPage);
    assert.deepEqual(popupRelationTarget, webRelationTarget, 'relation target parity');
    assert.deepEqual(popupRelationTarget.recordIds, ['r008']);
    assert.deepEqual(popupRelationTarget.visibleSenseIds, ['r008-s1']);

    await webPage.goBack();
    await waitForRecord(webPage, 'w026');
    assert.equal(new URL(webPage.url()).searchParams.get('q'), '담담하다');
    await webPage.goForward();
    await waitForRecord(webPage, 'r008');
    assert.equal(new URL(webPage.url()).searchParams.get('target'), 'r008');

    await webPage.setViewportSize({ width: 390, height: 844 });
    await assertNoHorizontalOverflow(webPage, 'dictionary page at mobile width');
    await webPage.setViewportSize({ width: 1280, height: 800 });

    await webPage.getByRole('link', { name: '제품 소개' }).click();
    await webPage.waitForURL(`${webOrigin}/typewriter/about/`);
    assert.ok(requests.has('/typewriter/'));
    assert.ok(requests.has('/typewriter/about/'));
    assert.equal(await webPage.locator('[data-product-surface]').getAttribute('data-product-surface'), 'web-about');
    assert.equal(await webPage.locator('[data-dictionary-panel]').count(), 0);

    const aboutPage = await context.newPage();
    const aboutResponse = await aboutPage.goto(`${webOrigin}/typewriter/about/`, { waitUntil: 'load' });
    assert.equal(aboutResponse?.status(), 200, 'product introduction must load directly');
    await aboutPage.locator('[data-product-surface="web-about"]').waitFor();
    const aboutLinks = await aboutPage.locator('.site-navigation a').evaluateAll((links) => (
      Object.fromEntries(links.map((link) => [link.textContent.trim(), new URL(link.href).pathname]))
    ));
    assert.deepEqual(aboutLinks, {
      '제품 소개': '/typewriter/about/',
      GitHub: '/neverworkalone/typewriter',
    });
    const aboutReload = await aboutPage.reload({ waitUntil: 'load' });
    assert.equal(aboutReload?.status(), 200, 'product introduction must survive a direct reload');
    await aboutPage.locator('[data-product-surface="web-about"]').waitFor();
    assert.equal(await aboutPage.locator('[data-dictionary-panel]').count(), 0);
    await aboutPage.setViewportSize({ width: 390, height: 844 });
    await assertNoHorizontalOverflow(aboutPage, 'product introduction page at mobile width');
    await aboutPage.getByRole('link', { name: 'Typewriter 홈' }).click();
    await aboutPage.waitForURL(`${webOrigin}/typewriter/`);
    await waitForRuntimeReady(aboutPage, 'web');

    assert.ok(requests.has('/typewriter/runtime/dictionary-worker.mjs'));
    assert.ok(requests.has('/typewriter/runtime/vendor/sqlite3.wasm'));
    assert.ok(requests.has('/typewriter/dictionary.sqlite'));
    assert.deepEqual(pageErrors, [], 'product pages must not report runtime errors');
    console.log('Chromium product runtime parity passed at /typewriter/.');
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
