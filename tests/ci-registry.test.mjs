import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CI_CATEGORIES,
  CI_CATEGORY_ORDER,
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
  assert.deepEqual(Object.keys(CI_CATEGORIES), CI_CATEGORY_ORDER);
  for (const categoryName of CI_CATEGORY_ORDER) {
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
