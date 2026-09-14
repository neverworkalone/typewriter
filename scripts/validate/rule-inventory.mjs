import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
export const DEFAULT_RULE_INVENTORY_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/validation/lexical-rule-inventory.json',
);

export const RULE_CLASSIFICATIONS = Object.freeze([
  'dictionary-wide invariant',
  'admission invariant',
  'batch policy',
  'historical assertion',
  'obsolete/duplicate',
]);

const SHARED_IMPLEMENTATION_PREFIXES = Object.freeze([
  'schema/',
  'scripts/validate/',
  'scripts/batch/lexical-',
  'scripts/build/',
  'scripts/normalize/',
  'scripts/inventory/',
]);
const SHARED_IMPLEMENTATION_PATHS = new Set([
  'scripts/batch/validate-batch.mjs',
  'scripts/batch/import-reviewed-batch.mjs',
]);

export class RuleInventoryError extends Error {
  constructor(message, code = 'RULE_INVENTORY_ERROR') {
    super(message);
    this.name = 'RuleInventoryError';
    this.code = code;
  }
}

function fail(message, code = 'RULE_INVENTORY_ERROR') {
  throw new RuleInventoryError(message, code);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`, 'INVALID_SHAPE');
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`, 'INVALID_VALUE');
  }
  if (value !== value.trim()) {
    fail(`${label} must not have leading or trailing whitespace`, 'UNTRIMMED_VALUE');
  }
  return value;
}

function requireArray(value, label, { minItems = 0 } = {}) {
  if (!Array.isArray(value) || value.length < minItems) {
    fail(`${label} must be an array with at least ${minItems} item(s)`, 'INVALID_ARRAY');
  }
  return value;
}

function displayPath(filePath) {
  const relativePath = path.relative(process.cwd(), filePath);
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return filePath;
}

function isSharedImplementation(filePath) {
  return SHARED_IMPLEMENTATION_PATHS.has(filePath)
    || SHARED_IMPLEMENTATION_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

async function requireImplementationPath(rule, index) {
  const label = `rules[${index}].implementation.path`;
  const implementation = requireObject(rule.implementation, `rules[${index}].implementation`);
  requireString(implementation.path, label);
  requireString(implementation.symbol, `rules[${index}].implementation.symbol`);

  if (implementation.path === 'none') {
    if (rule.classification !== 'obsolete/duplicate') {
      fail(`${label} may be none only for obsolete/duplicate rules`, 'MISSING_IMPLEMENTATION');
    }
    return implementation;
  }

  if (path.isAbsolute(implementation.path) || implementation.path.startsWith('../')) {
    fail(`${label} must be a repository-relative path`, 'INVALID_PATH');
  }
  const resolvedPath = path.resolve(REPOSITORY_DIRECTORY, implementation.path);
  try {
    await access(resolvedPath);
  } catch {
    fail(`${label} does not exist: ${implementation.path}`, 'MISSING_IMPLEMENTATION');
  }
  if (rule.classification === 'obsolete/duplicate') {
    fail(`${label} must be none for obsolete/duplicate rules`, 'OBSOLETE_IMPLEMENTATION');
  }
  return implementation;
}

function validateRuleShape(rule, index) {
  const label = `rules[${index}]`;
  requireObject(rule, label);
  for (const field of ['id', 'title', 'classification', 'applies_to', 'disposition']) {
    requireString(rule[field], `${label}.${field}`);
  }
  if (!/^[a-z][a-z0-9-]+$/u.test(rule.id)) {
    fail(`${label}.id must be a stable kebab-case identifier`, 'INVALID_ID');
  }
  if (!RULE_CLASSIFICATIONS.includes(rule.classification)) {
    fail(`${label}.classification is not a supported rule classification`, 'INVALID_CLASSIFICATION');
  }
  requireArray(rule.historical_sources, `${label}.historical_sources`, { minItems: 1 });
  rule.historical_sources.forEach((source, sourceIndex) => {
    requireString(source, `${label}.historical_sources[${sourceIndex}]`);
  });
  return rule;
}

function validateSharedOwnership(rule, implementation, index) {
  if (!['dictionary-wide invariant', 'admission invariant'].includes(rule.classification)) return;
  if (!isSharedImplementation(implementation.path)) {
    fail(
      `rules[${index}] ${rule.classification} must be owned by a shared implementation (received ${implementation.path})`,
      'NON_SHARED_IMPLEMENTATION',
    );
  }
  if (/(?:allowlist|record[-_ ]id\s+exception|batch[-_ ]id\s+exception)/iu.test(JSON.stringify(rule))) {
    fail(`rules[${index}] contains an identifier-specific bypass declaration`, 'BYPASS_DECLARATION');
  }
}

function validateObsoleteDisposition(rule, index) {
  if (rule.classification !== 'obsolete/duplicate') return;
  if (rule.implementation.path !== 'none') {
    fail(`rules[${index}] obsolete/duplicate implementation must be none`, 'OBSOLETE_IMPLEMENTATION');
  }
  if (!/(?:forbidden|replaced|no active path)/iu.test(rule.disposition)) {
    fail(`rules[${index}] obsolete/duplicate disposition must explain its replacement or prohibition`, 'MISSING_DISPOSITION');
  }
}

export async function readRuleInventory(inventoryPath = DEFAULT_RULE_INVENTORY_PATH) {
  let inventory;
  try {
    inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new RuleInventoryError(
        `${displayPath(inventoryPath)}: invalid JSON (${error.message})`,
        'INVALID_JSON',
      );
    }
    throw error;
  }
  return { inventory, inventoryPath };
}

export async function validateLexicalRuleInventory({
  inventoryPath = DEFAULT_RULE_INVENTORY_PATH,
} = {}) {
  const { inventory } = await readRuleInventory(inventoryPath);
  requireObject(inventory, 'inventory');
  if (inventory.schema_version !== '1') fail('inventory.schema_version must be 1', 'SCHEMA_VERSION');
  if (inventory.inventory_id !== 'typewriter-lexical-rule-inventory') {
    fail('inventory.inventory_id is not the Typewriter lexical rule inventory', 'INVENTORY_ID');
  }
  requireString(inventory.revision, 'inventory.revision');
  requireObject(inventory.scope, 'inventory.scope');
  requireString(inventory.scope.from, 'inventory.scope.from');
  requireString(inventory.scope.through, 'inventory.scope.through');
  requireString(inventory.scope.purpose, 'inventory.scope.purpose');
  const rules = requireArray(inventory.rules, 'inventory.rules', { minItems: 1 });

  const ruleIds = new Set();
  const classificationCounts = Object.fromEntries(RULE_CLASSIFICATIONS.map((classification) => [classification, 0]));
  for (const [index, rawRule] of rules.entries()) {
    const rule = validateRuleShape(rawRule, index);
    if (ruleIds.has(rule.id)) fail(`duplicate rule id ${rule.id}`, 'DUPLICATE_RULE_ID');
    ruleIds.add(rule.id);
    const implementation = await requireImplementationPath(rule, index);
    validateSharedOwnership(rule, implementation, index);
    validateObsoleteDisposition(rule, index);
    classificationCounts[rule.classification] += 1;
  }

  for (const classification of RULE_CLASSIFICATIONS) {
    if (classificationCounts[classification] === 0) {
      fail(`inventory must contain at least one ${classification} rule`, 'MISSING_CLASSIFICATION');
    }
  }

  return {
    inventoryPath,
    inventoryId: inventory.inventory_id,
    revision: inventory.revision,
    ruleCount: rules.length,
    classificationCounts,
  };
}

export async function main() {
  const summary = await validateLexicalRuleInventory();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(
    `Validated ${summary.ruleCount} lexical rule inventory item(s): ${JSON.stringify(summary.classificationCounts)}`,
  );
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
