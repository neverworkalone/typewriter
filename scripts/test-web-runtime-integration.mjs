import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { validateProductOutputContract } from './validate/product-output-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionOutput = path.resolve(
  process.env.TYPEWRITER_BUILD_OUTPUT_DIRECTORY ?? path.join(repositoryRoot, 'dist'),
);
const webOutput = path.resolve(
  process.env.TYPEWRITER_WEB_BUILD_OUTPUT_DIRECTORY ?? path.join(repositoryRoot, 'dist-web'),
);
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

  let context;

  try {
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

    assert.deepEqual(pageErrors, [], 'product pages must not report runtime errors');
    console.log('Extension search runtime passed in Chromium.');
  } finally {
    await context?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
