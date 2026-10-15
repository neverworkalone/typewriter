import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import LEGACY_CHECK_IDENTITIES from './legacy-check-identities.json' with { type: 'json' };
import LEGACY_CHECK_TIERS from './legacy-check-tiers.json' with { type: 'json' };

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
  'lexical',
  'toolchain',
  'batch',
  'product',
  'artifacts',
  'factory',
]);

export const CI_FAST_CATEGORY_ORDER = Object.freeze([
  'canonical',
  'lexical',
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
  candidates: CI_ALL_CATEGORY_ORDER,
});

export const CI_EXECUTION_TIERS = Object.freeze([
  'candidate',
  'normal',
  'deep',
]);

export const CI_CHECK_SCHEDULES = Object.freeze([
  'always',
  'affected',
  'manual',
]);


// Execution tier is intentionally separate from scope. These category values
// describe the current registry while PR 2 moves individual checks out of the
// legacy batch category.
export const CI_TIER_CATEGORY_ORDER = Object.freeze({
  candidate: CI_ALL_CATEGORY_ORDER,
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
  candidates: Object.freeze({ tiers: Object.freeze(['candidate']), includeManual: false }),
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
        ...commandCheck(
          'Test Issue #713 meaning/adjudication data contract (ids, initial codes, shard placement, canonical references)',
          ['--test', 'scripts/meaning/contract.test.mjs'],
        ),
        tier: 'normal',
      },
      {
        ...commandCheck(
          'Validate meaning/adjudication references against current canonical',
          ['scripts/meaning/validate.mjs'],
        ),
        tier: 'normal',
      },
      pnpmCheck('Validate lexical rule inventory', 'validate:rules'),
      testCheck('tests/lexical-rule-inventory.test.mjs', 'Test lexical rule inventory'),
      testCheck('tests/ci-runner.test.mjs', 'Test CI category runner fail-fast behavior'),
      testCheck('tests/ci-registry.test.mjs', 'Test CI check ownership registry'),
      testCheck(
        'tests/ci-sqlite-build-guard.test.mjs',
        'Test one current-revision SQLite build guard (real runner fault injection)',
      ),
    ],
  },

  lexical: {
    label: 'Shared lexical and semantic validation',
    checks: [
      globalCanonicalAuditCheck(),
      testCheck('tests/lexical-quality.test.mjs', 'Test shared lexical quality'),
      testCheck('tests/semantic-audit-decision-source.test.mjs', 'Test semantic audit decision source'),
      testCheck(
        'tests/shared-admission-context.test.mjs',
        'Test shared admission context equivalence, tamper rejection, and immutable digest reuse',
      ),
      testCheck('tests/lexical-selection.test.mjs', 'Test shared lexical selection'),
      testCheck('tests/intake-pipeline.test.mjs', 'Test source-agnostic intake pipeline'),
      testCheck('tests/intake-end-to-end.test.mjs', 'Test corpus intake to SQLite direct-search path'),
      testCheck('tests/intake-end-to-end-synthetic.test.mjs', 'Test corpus-free synthetic intake to SQLite direct-search path'),
      testCheck('tests/intake-production-handoff.test.mjs', 'Test production intake hand-off binding at the batch builder boundary'),
      testCheck('tests/intake-production-e2e.test.mjs', 'Test production hand-off to canonical, SQLite and direct search (both adapters)'),
      testCheck('tests/production-entrypoints.test.mjs', 'Test declared canonical-writer entrypoints and the mandatory intake hand-off policy'),
      testCheck('tests/intake-kiwi-service.test.mjs', 'Test shared Kiwi batch service'),
      testCheck('tests/python-env.test.mjs', 'Test shared Typewriter Python venv contract, launcher and staleness checks (synthetic interpreter)'),
      commandCheck('Validate factory candidate/review batch contracts', ['scripts/factory/validate.mjs'], []),
      commandCheck('Require factory results to be current with the shared factory contract on master', ['scripts/factory/freshness.mjs'], []),
      testCheck('tests/factory-freshness.test.mjs', 'Test factory contract freshness gate and contract-repair transition'),
      testCheck('tests/factory-contracts.test.mjs', 'Test factory contracts, state machines, identity adapter, and typed handoff'),
      testCheck('tests/factory-stage1.test.mjs', 'Test factory Stage 1 lemma-centered candidate batch producer'),
      testCheck('tests/corpus-lemma-pilot-python.test.mjs', 'Test Python corpus extractor and cached selection (factory opt-in keeps canonical lemmas and every POS; default M9 behavior; stale cache rejected)'),
      {
        ...testCheck('tests/corpus-morphology-python.test.mjs', 'Test resumable corpus morphology partitions and exact cumulative statistics'),
        tier: 'deep',
        schedule: 'affected',
        paths: [
          'scripts/reference/corpus_morphology.py',
          'scripts/reference/corpus_morphology_readonly.py',
          'scripts/reference/corpus_morphology_selector.py',
          'scripts/reference/test-corpus-morphology.py',
          'scripts/reference/corpus_lemma_pilot.py',
          'scripts/reference/run-corpus-lemma-pilot.mjs',
          'scripts/python/local_cache.py',
          'scripts/python/requirements.txt',
          'tests/corpus-morphology-python.test.mjs',
        ],
      },
      testCheck('tests/factory-lemma.test.mjs', 'Test lemma-centered candidate contract, usage-group decisions, and v1/v2 compatibility'),
      testCheck('tests/factory-analyzer-providers.test.mjs', 'Test factory Stage 1 analyzer provider boundary and fallback'),
      testCheck('tests/factory-khaiii-provider.test.mjs', 'Test pinned Khaiii provider contract, lazy fallback and native smoke (synthetic; native skipped without the release; no Docker)'),
      testCheck('tests/factory-mecab-provider.test.mjs', 'Test pinned MeCab-ko provider contract, three-way fallback and real runtime smoke (synthetic; real runtime skipped without the pinned venv)'),
      testCheck('tests/factory-ensemble.test.mjs', 'Test Ensemble Resolver v2: three-provider adjudication, contextual fallback decisions, verification queue, tamper rejection and same-cohort metrics (synthetic)'),
      testCheck('tests/factory-ensemble-native-smoke.test.mjs', 'Test real three-native-provider ensemble smoke (skipped with the reason where Kiwi, Khaiii native or MeCab-ko is absent; no mock substitute)'),
      { ...testCheck('tests/sharded-json.test.mjs', 'Test sharded JSON writer: stable shard membership, size-guided first split, promotion file set'), tier: 'normal' },
      testCheck('tests/factory-stage2-worker.test.mjs', 'Test Stage 2 atomic claims, merge-gated session loop, and cleanup'),
      testCheck('tests/factory-stage3-worker.test.mjs', 'Test Stage 3 serial admission, rejection, recovery, and ID/reference allocation'),
      testCheck('tests/factory-relation-amendments.test.mjs', 'Test Stage 3 reverse relation amendments: remapping, staleness, idempotence, semantic authority and audit'),
    ],
  },

  batch: {
    label: 'Batch process, contract, recovery, and authorization validation',
    checks: [
      testCheck('tests/lexical-production-candidates.test.mjs', 'Test lexical production candidates'),
      testCheck('tests/lexical-production-state.test.mjs', 'Test lexical production state'),
      commandCheck(
        'Test shared Typewriter cache paths and explicit local-reference migration',
        ['--test', 'scripts/typewriter-cache.test.mjs', 'scripts/reference/migrate-local-reference.test.mjs', 'scripts/reference/run-corpus-lemma-pilot.test.mjs', 'scripts/batch/repository-source-digest.test.mjs'],
      ),
      commandCheck(
        'Test M9 corpus candidate-review disposition regressions',
        ['--test', 'scripts/reference/corpus-candidate-review.test.mjs'],
      ),
      commandCheck(
        'Test Issues #332 and #334 literature TXT pilot and full index',
        ['--test', 'scripts/reference/literature-index.test.mjs'],
      ),
      commandCheck(
        'Test Issue #391 Stage 2 literature evidence retriever',
        ['--test', 'scripts/reference/literature-evidence.test.mjs', 'scripts/reference/literature-evidence-selfcheck.test.mjs', 'scripts/reference/literature-evidence-run.test.mjs', 'scripts/reference/literature-validation.test.mjs', 'scripts/reference/literature-boundary.test.mjs'],
      ),
      commandCheck(
        'Test Issue #392 bounded literature rescue of evidence-insufficiency deferrals',
        ['--test', 'scripts/reference/literature-rescue.test.mjs'],
      ),
      commandCheck(
        'Test Issue #397 canonical relation candidate retrieval',
        ['--test', 'scripts/relation/candidate-retrieval.test.mjs'],
      ),
      {
        ...commandCheck(
          'Test Issue #400/#446 relation enrichment pilot contract, backfill queue and canonical apply',
          ['--test', 'scripts/relation/pilot.test.mjs', 'scripts/relation/backfill-queue.test.mjs', 'scripts/relation/backfill-queue-cli.test.mjs', 'scripts/relation/backfill-apply.test.mjs', 'scripts/relation/relation-correction.test.mjs'],
        ),
        schedule: 'affected',
        paths: [
          'scripts/relation',
          'scripts/factory/relation-amendments.mjs',
          'scripts/factory/relation-corrections.mjs',
          'scripts/factory/semantic-authority.mjs',
          'scripts/factory/source-exclusions.mjs',
          'scripts/factory/validate.mjs',
          'scripts/validate/semantic-audit.mjs',
          'scripts/relation/pilot.test.mjs',
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
      commandCheck(
        'Test Issue #223 reviewer run-record binding and raw-output derivation',
        ['--test', 'scripts/batch/reviewer-raw-outputs.test.mjs'],
      ),
      commandCheck(
        'Test M10 per-batch stage timing ledger',
        ['--test', 'scripts/batch/stage-timing.test.mjs'],
      ),
      commandCheck(
        'Test agent self-check semantic review contract and legacy review workflow',
        ['--test', 'scripts/batch/semantic-self-check.test.mjs', 'scripts/batch/review-workflow.test.mjs'],
      ),
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
      testCheck('tests/relation-relevance.test.mjs', 'Test exploratory relation relevance'),
      testCheck('tests/relation-enrichment-top100.test.mjs', 'Test Issue #400 Top-100 window through the production append path'),
      testCheck('tests/m2-pipeline.test.mjs', 'Test integrated M2 audit'),
    ],
  },

  product: {
    label: 'Product tests and extension build',
    checks: [
      testCheck('tests/dictionary-validation.test.mjs', 'Test packaged dictionary runtime guards'),
      testCheck('tests/search-query.test.mjs', 'Test shared search query contract'),
      testCheck('tests/runtime-query-adapter.test.mjs', 'Test shared native and WASM SQLite query adapter'),
      testCheck('tests/searchable-start-contract.test.mjs', 'Test role-independent searchable lexical eligibility'),
      testCheck('tests/scale-benchmark.test.mjs', 'Test deterministic product-shaped scale fixture'),
      testCheck('tests/surface-form-projection.test.mjs', 'Test M6-3 surface-form projection and search'),
      pnpmCheck('Run product unit tests', 'test:unit'),
      pnpmCheck('Build product extension', 'build'),
      pnpmCheck('Build Typewriter Web', 'build:web'),
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

  factory: {
    label: 'Stage 1 candidate artifact validation',
    checks: [
      {
        ...commandCheck(
          'Validate candidate manifests, digests, identities, and factory contracts',
          ['scripts/factory/validate.mjs'],
        ),
        tier: 'candidate',
      },
      {
        ...commandCheck(
          'Require candidate artifacts to match the shared factory contract on master',
          ['scripts/factory/freshness.mjs'],
        ),
        tier: 'candidate',
      },
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
      {
        ...testCheck('tests/reproducibility.test.mjs', 'Test reproducible dictionary builds'),
        schedule: 'affected',
        paths: [
          'scripts/build',
          'scripts/normalize',
          'schema',
          'tests/reproducibility.test.mjs',
        ],
        deepInputs: ['data/canonical/'],
      },
      {
        ...pnpmCheck(
          'Run 100K/500K/1M release-shaped performance and scale benchmark',
          'benchmark:release',
          [
            '--sizes=100000,500000,1000000',
            '--sqlite-scale=100000,500000,1000000',
            '--fixed-level-evidence=config/ci-level-evidence.json',
          ],
        ),
        schedule: 'affected',
        paths: [
          'scripts/benchmark',
          'scripts/build',
          'scripts/normalize',
          'src/runtime/dictionary-contract.js',
          'src/runtime/dictionary-validation.js',
          'src/runtime/search-query.js',
          'src/runtime/sqlite-query.js',
          'schema',
          'config/ci-level-evidence.json',
          'tests/scale-benchmark.test.mjs',
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
