import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CI_CATEGORIES,
  CI_ALL_CATEGORY_ORDER,
  CI_CATEGORY_ORDER,
  CI_DEEP_CATEGORY_ORDER,
  CI_FAST_CATEGORY_ORDER,
  CI_LEVEL_CATEGORY_ORDER,
  CI_NORMAL_CATEGORY_ORDER,
  collectTestOwnership,
} from '../scripts/ci/registry.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

test('every root Node test file has exactly one CI category owner', async () => {
  const expectedFiles = (await readdir(TEST_DIRECTORY, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => `tests/${entry.name}`)
    .sort();
  const ownership = collectTestOwnership();
  const ownershipCounts = new Map();

  for (const item of ownership) {
    ownershipCounts.set(item.file, (ownershipCounts.get(item.file) ?? 0) + 1);
  }

  assert.deepEqual(
    [...ownershipCounts.keys()].sort(),
    expectedFiles,
    'CI registry must cover every root tests/*.test.mjs file and no other file',
  );
  for (const file of expectedFiles) {
    assert.equal(ownershipCounts.get(file), 1, `${file} must have one CI owner`);
  }
});

test('CI categories are ordered and every category has a descriptive label', () => {
  const allCategoryNames = [...CI_CATEGORY_ORDER, ...CI_DEEP_CATEGORY_ORDER];
  assert.deepEqual(
    new Set(Object.keys(CI_CATEGORIES)),
    new Set(allCategoryNames),
  );
  for (const categoryName of allCategoryNames) {
    const category = CI_CATEGORIES[categoryName];
    assert.equal(typeof category.label, 'string');
    assert.ok(category.label.length > 0);
    assert.ok(category.checks.length > 0);
    for (const check of category.checks) {
      assert.equal(typeof check.label, 'string');
      assert.equal(typeof check.command, 'function');
    }
  }
});

test('toolchain builds SQLite only after the shared global audit', () => {
  const toolchainChecks = CI_CATEGORIES.toolchain.checks;
  assert.equal(toolchainChecks[0].inProcess, 'global-canonical-audit');
  assert.equal(toolchainChecks[1].inProcess, 'normalize-canonical');
  assert.equal(toolchainChecks[3].inProcess, 'shared-dictionary-build');
  assert.equal(
    CI_CATEGORIES.deep.checks.find((check) => check.testFiles?.includes('tests/reproducibility.test.mjs'))
      .testFiles[0],
    'tests/reproducibility.test.mjs',
  );
});

test('CI levels are nested and deep owns the scale benchmark', () => {
  assert.deepEqual(
    CI_NORMAL_CATEGORY_ORDER.slice(0, CI_FAST_CATEGORY_ORDER.length),
    CI_FAST_CATEGORY_ORDER,
  );
  assert.equal(new Set(CI_NORMAL_CATEGORY_ORDER).size, CI_NORMAL_CATEGORY_ORDER.length);
  assert.deepEqual(
    [...CI_NORMAL_CATEGORY_ORDER].sort(),
    [...CI_CATEGORY_ORDER].sort(),
  );
  assert.deepEqual(CI_ALL_CATEGORY_ORDER, [
    ...CI_NORMAL_CATEGORY_ORDER,
    ...CI_DEEP_CATEGORY_ORDER,
  ]);
  assert.ok(CI_FAST_CATEGORY_ORDER.every(
    (categoryName) => CI_NORMAL_CATEGORY_ORDER.includes(categoryName),
  ));
  assert.deepEqual(CI_LEVEL_CATEGORY_ORDER.fast, CI_FAST_CATEGORY_ORDER);
  assert.deepEqual(CI_LEVEL_CATEGORY_ORDER.normal, CI_NORMAL_CATEGORY_ORDER);
  assert.deepEqual(CI_LEVEL_CATEGORY_ORDER.all, CI_ALL_CATEGORY_ORDER);
  assert.equal(
    CI_CATEGORIES.batch.checks.some((check) => check.testFiles?.includes('tests/m5-12a.test.mjs')),
    false,
  );
  assert.equal(
    CI_CATEGORIES.deep.checks.some((check) => check.testFiles?.includes('tests/m5-12a.test.mjs')),
    true,
  );
  assert.equal(
    CI_NORMAL_CATEGORY_ORDER.includes('historical'),
    false,
  );
  assert.deepEqual(CI_DEEP_CATEGORY_ORDER, ['historical', 'deep']);
  assert.equal(
    CI_CATEGORIES.deep.checks.at(-1).label,
    'Run 500K/1M fast/normal/deep synthetic canonical benchmark',
  );
  assert.deepEqual(
    CI_CATEGORIES.deep.checks.at(-1).command({}).args,
    ['run', 'benchmark:canonical', '--', '--sizes=500000,1000000', '--sqlite-scale=500000,1000000'],
  );
});

test('workflow maps pull requests, master pushes, and deep triggers to CI levels', async () => {
  const workflow = await readFile(
    path.resolve(TEST_DIRECTORY, '../.github/workflows/ci.yml'),
    'utf8',
  );
  assert.match(workflow, /pull_request:/u);
  assert.match(workflow, /Pull request normal validation \(fast checkpoint \+ continuation\)/u);
  assert.match(workflow, /run: npm run ci:normal/u);
  assert.doesNotMatch(workflow, /name: PR fast validation/u);
  assert.doesNotMatch(workflow, /name: PR full normal validation/u);
  assert.match(workflow, /schedule:/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /run: npm run ci:all/u);
  await assert.rejects(
    readFile(path.resolve(TEST_DIRECTORY, '../.github/workflows/deep-validation.yml'), 'utf8'),
    (error) => error.code === 'ENOENT',
  );
});
