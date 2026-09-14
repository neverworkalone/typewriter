import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_RULE_INVENTORY_PATH,
  RuleInventoryError,
  validateLexicalRuleInventory,
} from '../scripts/validate/rule-inventory.mjs';

async function readInventory() {
  return JSON.parse(await readFile(DEFAULT_RULE_INVENTORY_PATH, 'utf8'));
}

async function validateMutation(mutator) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-rule-inventory-'));
  const inventoryPath = path.join(temporaryDirectory, 'inventory.json');
  try {
    const inventory = await readInventory();
    mutator(inventory);
    await writeFile(inventoryPath, `${JSON.stringify(inventory)}\n`, 'utf8');
    return await validateLexicalRuleInventory({ inventoryPath });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('lexical rule inventory covers every classification and shared owner', async () => {
  const summary = await validateLexicalRuleInventory();

  assert.ok(summary.ruleCount >= 20);
  for (const classification of [
    'dictionary-wide invariant',
    'admission invariant',
    'batch policy',
    'historical assertion',
    'obsolete/duplicate',
  ]) {
    assert.ok(summary.classificationCounts[classification] > 0, classification);
  }
});

test('lexical rule inventory rejects duplicate IDs and missing implementation files', async () => {
  await assert.rejects(
    validateMutation((inventory) => {
      inventory.rules.push({ ...inventory.rules[0] });
    }),
    (error) => error instanceof RuleInventoryError && error.code === 'DUPLICATE_RULE_ID',
  );

  await assert.rejects(
    validateMutation((inventory) => {
      inventory.rules[0].implementation.path = 'scripts/validate/does-not-exist.mjs';
    }),
    (error) => error instanceof RuleInventoryError && error.code === 'MISSING_IMPLEMENTATION',
  );
});

test('lexical rule inventory rejects local quality forks and bypass declarations', async () => {
  await assert.rejects(
    validateMutation((inventory) => {
      inventory.rules[0].implementation.path = 'scripts/batch/validate-m5-11-admission.mjs';
    }),
    (error) => error instanceof RuleInventoryError && error.code === 'NON_SHARED_IMPLEMENTATION',
  );

  await assert.rejects(
    validateMutation((inventory) => {
      inventory.rules[0].title = 'canonical record allowlist';
    }),
    (error) => error instanceof RuleInventoryError && error.code === 'BYPASS_DECLARATION',
  );
});
