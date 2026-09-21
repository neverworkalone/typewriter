import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CI_CATEGORIES,
  CI_CATEGORY_ORDER,
  CI_DEEP_CATEGORY_ORDER,
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
  assert.deepEqual(Object.keys(CI_CATEGORIES), allCategoryNames);
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
  assert.equal(CI_CATEGORIES.deep.checks.at(-1).testFiles[0], 'tests/reproducibility.test.mjs');
});
