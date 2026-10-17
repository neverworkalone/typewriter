import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import LEGACY_CHECK_IDENTITIES from './legacy-check-identities.json' with { type: 'json' };
import LEGACY_CHECK_TIERS from './legacy-check-tiers.json' with { type: 'json' };
import { PRODUCT_UNIT_TEST_FILES } from './product-unit-test-files.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');

const PNPM_EXECUTABLE = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function nodeCommand(args) {
  return {
    executable: process.execPath,
    args,
  };
}

export function pnpmCommand(script, args = []) {
  return {
    executable: PNPM_EXECUTABLE,
    // pnpm forwards arguments after the script name as-is, and passes a literal `--` through to the script.
    args: ['run', script, ...args],
  };
}

function commandCheck(label, args, testFiles = []) {
  return {
    label,
    command: () => nodeCommand(args),
    testFiles,
  };
}

function inProcessCheck(label, inProcess, testFiles = []) {
  return {
    label,
    inProcess,
    command: () => ({ executable: '[in-process]', args: [inProcess] }),
    testFiles,
  };
}

function globalCanonicalAuditCheck() {
  return {
    ...inProcessCheck('Run single-pass global canonical audit', 'global-canonical-audit'),
    oncePerCanonicalSession: 'global-canonical-audit',
  };
}

function pnpmCheck(label, script, args = [], testFiles = []) {
  return {
    label,
    command: () => pnpmCommand(script, args),
    testFiles,
  };
}

function testCheck(file, label = `Run ${file}`) {
  return commandCheck(label, ['--test', file], [file]);
}

function contractCheck(label, script, testFile) {
  return pnpmCheck(label, script, [], [testFile]);
}

export const CI_CATEGORY_ORDER = Object.freeze([
  'canonical',
  'toolchain',
  'relations',
  'product',
  'artifacts',
]);

export const CI_FAST_CATEGORY_ORDER = Object.freeze([
  'canonical',
  'toolchain',
]);

export const CI_NORMAL_CATEGORY_ORDER = Object.freeze([
  ...CI_FAST_CATEGORY_ORDER,
  ...CI_CATEGORY_ORDER.filter(
    (categoryName) => !CI_FAST_CATEGORY_ORDER.includes(categoryName),
  ),
]);
export const CI_DEEP_CATEGORY_ORDER = Object.freeze(['deep']);
export const CI_ALL_CATEGORY_ORDER = Object.freeze([
  ...CI_NORMAL_CATEGORY_ORDER,
  ...CI_DEEP_CATEGORY_ORDER,
]);

export const CI_LEVEL_CATEGORY_ORDER = Object.freeze({
  fast: CI_FAST_CATEGORY_ORDER,
  normal: CI_ALL_CATEGORY_ORDER,
  all: CI_ALL_CATEGORY_ORDER,
  pr: CI_ALL_CATEGORY_ORDER,
  deep: CI_ALL_CATEGORY_ORDER,
});

export const CI_EXECUTION_TIERS = Object.freeze([
  'normal',
  'deep',
]);

export const CI_CHECK_SCHEDULES = Object.freeze([
  'always',
  'affected',
  'manual',
]);


// Execution tier is intentionally separate from scope.
export const CI_TIER_CATEGORY_ORDER = Object.freeze({
  normal: CI_ALL_CATEGORY_ORDER,
  deep: CI_ALL_CATEGORY_ORDER,
});

// `all` runs the current Normal and Deep tiers;
// `deep` selects current-system Deep checks across every domain scope.
export const CI_LEVEL_EXECUTION_POLICY = Object.freeze({
  fast: Object.freeze({ tiers: Object.freeze(['normal']), includeManual: false }),
  normal: Object.freeze({ tiers: Object.freeze(['normal']), includeManual: false }),
  all: Object.freeze({ tiers: Object.freeze(['normal', 'deep']), includeManual: false }),
  pr: Object.freeze({ tiers: Object.freeze(['normal', 'deep']), includeManual: false }),
  deep: Object.freeze({ tiers: Object.freeze(['deep']), includeManual: false }),
});

const RAW_CI_CATEGORIES = Object.freeze({
  canonical: {
    label: 'Core canonical and dataset validation',
    checks: [
      commandCheck('Validate manifest version', ['scripts/ci/validate-manifest.mjs']),
      inProcessCheck('Validate canonical JSONL', 'canonical-jsonl'),
      globalCanonicalAuditCheck(),
      inProcessCheck('Validate M6-3 surface-form projection coverage', 'surface-form-projection'),
      testCheck('tests/validate-canonical-jsonl.test.mjs', 'Test canonical JSONL validator'),
      testCheck('tests/canonical-context.test.mjs', 'Test shared canonical context'),
      testCheck('tests/stdict-import.test.mjs', 'Test STDICT canonical conversion, licensed-source gate and pilot shard'),
      testCheck('tests/validate-dataset-integrity.test.mjs', 'Test dataset validator'),
      {
        ...testCheck('tests/meaning-provenance.test.mjs', 'Test meaning relation provenance completeness and source binding'),
        tier: 'normal',
      },
      {
        ...testCheck('tests/canonical-record-meanings.test.mjs', 'Test Issue #820 canonical-only record meanings (corpus coverage, no Meaning input, record candidates)'),
        tier: 'normal',
      },
      {
        ...testCheck('tests/meaning-search.test.mjs', 'Test meaning search candidates, stored ranking and 더보기 partition'),
        tier: 'normal',
      },
      testCheck('tests/ci-runner.test.mjs', 'Test CI category runner fail-fast behavior'),
      testCheck('tests/ci-registry.test.mjs', 'Test CI check ownership registry'),
      { ...testCheck('tests/sharded-json.test.mjs', 'Test shared sharded source writer'), tier: 'normal' },
      testCheck(
        'tests/ci-sqlite-build-guard.test.mjs',
        'Test one current-revision SQLite build guard (real runner fault injection)',
      ),
    ],
  },

  relations: {
    label: 'Canonical relation authoring and apply validation',
    checks: [
      {
        ...commandCheck(
          'Test Canonical relation backfill queue, apply, and correction paths',
          ['--test', 'scripts/relation/backfill-queue.test.mjs', 'scripts/relation/backfill-queue-cli.test.mjs', 'scripts/relation/backfill-apply.test.mjs', 'scripts/relation/relation-correction.test.mjs'],
        ),
        schedule: 'affected',
        paths: [
          'scripts/relation',
          'scripts/relation/relation-amendments.mjs',
          'scripts/relation/relation-corrections.mjs',
          'scripts/relation/semantic-authority.mjs',
          'scripts/validate/semantic-audit.mjs',
          'scripts/relation/backfill-queue.test.mjs',
          'scripts/relation/backfill-queue-cli.test.mjs',
          'scripts/relation/backfill-apply.test.mjs',
          'scripts/relation/relation-correction.test.mjs',
        ],
        deepInputs: [
          'data/canonical/',
          'data/relation-backfill/',
          'data/validation/canonical-semantic-decision-source.json',
          'data/validation/canonical-semantic-decision-source.shards/',
        ],
      },
      testCheck('tests/relation-relevance.test.mjs', 'Test exploratory relation relevance contract'),
    ],
  },

  toolchain: {
    label: 'Normalization, dictionary build, and integrated audit',
    checks: [
      globalCanonicalAuditCheck(),
      inProcessCheck('Normalize canonical data', 'normalize-canonical'),
      testCheck('tests/normalize-canonical.test.mjs', 'Test canonical normalization'),
      {
        ...inProcessCheck('Build shared SQLite dictionary artifact', 'shared-dictionary-build'),
      },
      {
        ...inProcessCheck('Validate shared SQLite dictionary artifact', 'shared-dictionary-validation'),
      },
      inProcessCheck('Run integrated M2 audit', 'm2-audit'),
      inProcessCheck('Verify shared surface-form projection reuse', 'surface-form-projection-reuse'),
      testCheck('tests/build-dictionary.test.mjs', 'Test SQLite dictionary build'),
      {
        ...testCheck('tests/lite-dictionary.test.mjs', 'Test Full dictionary to Lite product extraction'),
        tier: 'normal',
      },
      {
        ...testCheck('tests/build-provenance.test.mjs', 'Test source revision provenance and dirty-build safeguards'),
        tier: 'normal',
      },
    ],
  },

  product: {
    label: 'Product tests and extension build',
    checks: [
      testCheck('tests/dictionary-validation.test.mjs', 'Test packaged dictionary runtime guards'),
      testCheck('tests/search-query.test.mjs', 'Test shared search query contract'),
      testCheck('tests/runtime-query-adapter.test.mjs', 'Test shared native and WASM SQLite query adapter'),
      testCheck('tests/surface-form-projection.test.mjs', 'Test M6-3 surface-form projection and search'),
      pnpmCheck('Run product unit tests', 'test:unit', [], PRODUCT_UNIT_TEST_FILES),
      pnpmCheck('Build product extension', 'build'),
      pnpmCheck('Build Typewriter Web', 'build:web'),
      pnpmCheck('Validate static Pages artifact', 'validate:pages-artifact'),
      pnpmCheck('Validate built product output contracts', 'validate:product-outputs'),
    ],
  },

  artifacts: {
    label: 'Generated-artifact and clean-checkout enforcement',
    checks: [
      {
        ...testCheck('tests/artifact-policy.test.mjs', 'Test artifact policy'),
        schedule: 'affected',
        paths: [
          'scripts/validate/artifact-policy.mjs',
          'config/artifact-policy.json',
          'tests/artifact-policy.test.mjs',
        ],
        deepInputs: [
          'data/validation/canonical-semantic-decision-source.json',
          'data/validation/canonical-semantic-decision-source.shards/',
        ],
      },
      testCheck('tests/pages-artifact.test.mjs', 'Test Pages artifact publication boundary'),
      testCheck('tests/validate-package.test.mjs', 'Test package validation'),
      commandCheck('Enforce generated-artifact policy and clean checkout', [
        'scripts/validate/artifact-policy.mjs',
        '--clean',
      ]),
    ],
  },

  deep: {
    label: 'Manual deep current-revision reproducibility validation',
    checks: [
      {
        ...globalCanonicalAuditCheck(),
        schedule: 'affected',
        paths: [
          'scripts/ci/global-canonical-audit.mjs',
          'scripts/validate/canonical-context.mjs',
          'scripts/validate/canonical-jsonl.mjs',
          'scripts/validate/dataset-integrity.mjs',
          'scripts/validate/lexical-quality.mjs',
          'scripts/validate/semantic-audit.mjs',
          'scripts/validate/surface-form-projection.mjs',
          'schema/canonical-record.schema.json',
        ],
        deepInputs: [
          'data/canonical/',
          'data/validation/canonical-semantic-decision-source.json',
          'data/validation/canonical-semantic-decision-source.shards/',
        ],
      },
      {
        ...inProcessCheck('Run current-revision SQLite reproducibility audit', 'deep-m2-reproducibility'),
        schedule: 'affected',
        paths: [
          'scripts/verify/m2-pipeline.mjs',
          'scripts/build',
          'scripts/normalize',
          'schema',
          'scripts/validate/canonical-jsonl.mjs',
        ],
        deepInputs: ['data/canonical/'],
      },
    ],
  },
});

/**
 * Register one check with the shared execution policy.
 * New checks default to Deep so they cannot silently increase per-PR work.
 */
export function registerCheck(check, {
  owner,
  tier = 'deep',
  schedule = 'always',
  paths = [],
  deepInputs = check?.deepInputs ?? [],
  protectedContract = check?.label,
} = {}) {
  if (!check || typeof check !== 'object' || typeof check.command !== 'function') {
    throw new TypeError('A CI check must define a command function.');
  }
  if (typeof check.label !== 'string' || check.label.trim().length === 0) {
    throw new TypeError('A CI check must define a non-empty label.');
  }
  if (typeof owner !== 'string' || owner.trim().length === 0) {
    throw new TypeError('A CI check must define its domain owner.');
  }
  if (!CI_EXECUTION_TIERS.includes(tier)) {
    throw new TypeError(`Unknown CI execution tier: ${tier}`);
  }
  if (!CI_CHECK_SCHEDULES.includes(schedule)) {
    throw new TypeError(`Unknown CI check schedule: ${schedule}`);
  }
  if (!Array.isArray(paths)) {
    throw new TypeError('CI check paths must be an array.');
  }
  const uniquePaths = [...new Set(paths)];
  if (uniquePaths.some((pathValue) => (
    typeof pathValue !== 'string'
    || pathValue.length === 0
    || pathValue.startsWith('/')
    || pathValue.includes('\\')
    || pathValue.split('/').some((part) => part === '' || part === '.' || part === '..')
  ))) {
    throw new TypeError('CI check paths must be normalized repository-relative paths.');
  }
  if (uniquePaths.length !== paths.length) {
    throw new TypeError('CI check paths must not contain duplicates.');
  }
  if (!Array.isArray(deepInputs)) {
    throw new TypeError('CI check Deep input paths must be an array.');
  }
  const uniqueDeepInputs = [...new Set(deepInputs)];
  if (uniqueDeepInputs.some((pathValue) => (
    typeof pathValue !== 'string'
    || pathValue.length === 0
    || pathValue.startsWith('/')
    || pathValue.includes('\\')
    || (pathValue.endsWith('/') ? pathValue.slice(0, -1) : pathValue)
      .split('/').some((part) => part === '' || part === '.' || part === '..')
  ))) {
    throw new TypeError('CI check Deep inputs must be normalized repository-relative paths or directory prefixes.');
  }
  if (uniqueDeepInputs.length !== deepInputs.length) {
    throw new TypeError('CI check Deep inputs must not contain duplicates.');
  }
  if (tier !== 'deep' && uniqueDeepInputs.length > 0) {
    throw new TypeError('Only Deep CI checks may declare Deep input paths.');
  }
  if (schedule === 'affected' && uniquePaths.length === 0) {
    throw new TypeError('Affected CI checks must declare at least one dependency path.');
  }
  if (schedule !== 'affected' && uniquePaths.length > 0) {
    throw new TypeError('Only affected CI checks may declare dependency paths.');
  }
  if (typeof protectedContract !== 'string' || protectedContract.trim().length === 0) {
    throw new TypeError('A CI check must name the contract it protects.');
  }

  return Object.freeze({
    ...check,
    owner: owner.trim(),
    tier,
    schedule,
    paths: Object.freeze(uniquePaths),
    deepInputs: Object.freeze(uniqueDeepInputs),
    protectedContract: protectedContract.trim(),
    registration: 'explicit',
  });
}

export function registerCategory(owner, category, {
  legacyIdentities = LEGACY_CHECK_IDENTITIES,
  legacyTiers = LEGACY_CHECK_TIERS,
} = {}) {
  const knownLegacyLabels = legacyIdentities[owner] ?? [];
  const legacyTierByLabel = legacyTiers[owner] ?? {};
  const labels = category.checks.map((check) => check.label);
  const labelSet = new Set(labels);
  if (labelSet.size !== labels.length) {
    throw new TypeError(`CI scope ${owner} contains duplicate check labels.`);
  }
  if (!Array.isArray(knownLegacyLabels) || new Set(knownLegacyLabels).size !== knownLegacyLabels.length) {
    throw new TypeError(`CI scope ${owner} has an invalid legacy identity inventory.`);
  }
  const knownLegacyLabelSet = new Set(knownLegacyLabels);
  const staleIdentities = knownLegacyLabels.filter((label) => !labelSet.has(label));
  const staleTierEntries = Object.keys(legacyTierByLabel).filter((label) => !labelSet.has(label));
  const unboundTierEntries = Object.keys(legacyTierByLabel).filter((label) => !knownLegacyLabelSet.has(label));
  if (
    staleIdentities.length > 0
    || staleTierEntries.length > 0
    || unboundTierEntries.length > 0
  ) {
    throw new TypeError(
      `CI scope ${owner} has stale legacy registrations: ${[
        ...staleIdentities,
        ...staleTierEntries,
        ...unboundTierEntries,
      ].join(', ')}`,
    );
  }
  return Object.freeze({
    ...category,
    owner,
    checks: Object.freeze(category.checks.map((check) => {
      const isKnownLegacyCheck = knownLegacyLabelSet.has(check.label);
      const legacyTier = legacyTierByLabel[check.label];
      if (isKnownLegacyCheck && legacyTier === undefined && check.tier === undefined) {
        throw new TypeError(
          `Known legacy CI check ${owner}/${check.label} has no tier mapping or explicit migration tier.`,
        );
      }
      if (legacyTier !== undefined && check.tier !== undefined && check.tier !== legacyTier) {
        throw new TypeError(
          `CI check ${owner}/${check.label} must remove its legacy tier mapping before an explicit tier migration.`,
        );
      }
      const tier = legacyTier ?? check.tier ?? 'deep';
      const registered = registerCheck(check, {
        owner,
        tier,
        schedule: check.schedule ?? 'always',
        paths: check.paths ?? [],
        deepInputs: check.deepInputs ?? [],
        protectedContract: check.protectedContract ?? check.label,
      });
      return Object.freeze({
        ...registered,
        registration: legacyTier !== undefined ? 'legacy-policy' : 'explicit',
      });
    })),
  });
}

export const CI_CATEGORIES = Object.freeze(Object.fromEntries(
  Object.entries(RAW_CI_CATEGORIES).map(([owner, category]) => [
    owner,
    registerCategory(owner, category),
  ]),
));

const staleLegacyOwners = [...new Set([
  ...Object.keys(LEGACY_CHECK_IDENTITIES),
  ...Object.keys(LEGACY_CHECK_TIERS),
])].filter((owner) => !Object.hasOwn(RAW_CI_CATEGORIES, owner));
if (staleLegacyOwners.length > 0) {
  throw new TypeError(`Legacy CI tier map has stale scopes: ${staleLegacyOwners.join(', ')}`);
}

export function collectCheckRegistrations() {
  return CI_ALL_CATEGORY_ORDER.flatMap((owner) => (
    CI_CATEGORIES[owner].checks.map((check) => ({
      owner: check.owner,
      tier: check.tier,
      schedule: check.schedule,
      paths: check.paths,
      deepInputs: check.deepInputs,
      protectedContract: check.protectedContract,
      registration: check.registration,
      check: check.label,
    }))
  ));
}
