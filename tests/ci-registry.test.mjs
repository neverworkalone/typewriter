import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import LEGACY_CHECK_IDENTITIES from '../scripts/ci/legacy-check-identities.json' with { type: 'json' };
import LEGACY_CHECK_TIERS from '../scripts/ci/legacy-check-tiers.json' with { type: 'json' };

import {
  CI_CATEGORIES,
  CI_ALL_CATEGORY_ORDER,
  CI_CATEGORY_ORDER,
  CI_CHECK_SCHEDULES,
  CI_DEEP_CATEGORY_ORDER,
  CI_EXECUTION_TIERS,
  CI_FAST_CATEGORY_ORDER,
  CI_LEVEL_EXECUTION_POLICY,
  CI_LEVEL_CATEGORY_ORDER,
  CI_NORMAL_CATEGORY_ORDER,
  CI_TIER_CATEGORY_ORDER,
  collectCheckRegistrations,
  pnpmCommand,
  registerCategory,
  registerCheck,
} from '../scripts/ci/registry.mjs';
import { PRODUCT_UNIT_TEST_FILES } from '../scripts/ci/product-unit-test-files.mjs';
import { selectChecksForPolicy } from '../scripts/ci/run-category.mjs';
import {
  classifyDeepGateDiff,
  classifyDeepGatePaths,
  routePrDeepGate,
  validateNormalCoverage,
  validateAdditiveNormalCoverage,
} from '../scripts/ci/deep-gate.mjs';
import NORMAL_COVERAGE from '../scripts/ci/deep-gate-coverage.json' with { type: 'json' };
import NORMAL_COVERAGE_RETIREMENTS from '../scripts/ci/deep-gate-coverage-retirements.json' with { type: 'json' };
import { sampleCanonicalRecordLine, syntheticRelationPacket } from './helpers/synthetic-data.mjs';
import VITEST_CONFIG from '../vitest.config.js';
const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const EMPTY_COVERAGE_RETIREMENTS = { version: 1, retirements: [] };

test('real Git classification reads large routine files and preserves fail-closed routing', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-large-ci-diff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', encoding: 'utf8' }).trim();
  const commit = (message) => {
    git(['add', '-A']);
    git(['-c', 'commit.gpgsign=false', '-c', 'user.name=CI Test', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', message]);
    return git(['rev-parse', 'HEAD']);
  };
  const put = async (file, bytes) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), bytes);
  };
  git(['init', '-q']);
  await put('README.md', 'fixture\n');
  await put('scripts/ci/deep-gate-coverage.json', JSON.stringify(NORMAL_COVERAGE));
  const base = commit('base');
  const inventoryPath = 'data/inventory/large-fixture.json';
  const largeJson = JSON.stringify({ observations: ['x'.repeat(2 * 1024 * 1024)] });
  const packetPath = 'data/relation-backfill/R999999.json';
  const packet = syntheticRelationPacket('R999999');
  const canonicalPath = 'data/canonical/large-fixture.jsonl';
  const record = sampleCanonicalRecordLine();
  const canonical = `${record}\n`.repeat(Math.ceil(2 * 1024 * 1024 / Buffer.byteLength(record)));
  let scenarioCount = 0;
  const classify = async (files) => {
    git(['checkout', '-q', '-B', `scenario-${++scenarioCount}`, base]);
    for (const [file, bytes] of files) await put(file, bytes);
    const head = commit('scenario');
    return { head, result: classifyDeepGateDiff(base, head, { cwd: root }) };
  };

  const routineFiles = [
    [inventoryPath, largeJson],
    [canonicalPath, canonical],
    [packetPath, ' '.repeat(2 * 1024 * 1024) + JSON.stringify(packet)],
    ['data/validation/canonical-semantic-decision-source.json', largeJson],
    ['data/validation/issue-999-checkpoint-report.json', largeJson],
  ];
  const valid = await classify(routineFiles);
  // Both the complete file and canonical patch exceed the old subprocess limit.
  for (const args of [
    ['show', `${valid.head}:${inventoryPath}`],
    ['diff', '--unified=0', `${base}...${valid.head}`, '--', canonicalPath],
  ]) {
    assert.throws(() => execFileSync('git', args, { cwd: root, stdio: 'pipe' }), { code: 'ENOBUFS' });
  }
  const oldBoundary = classifyDeepGateDiff(base, valid.head, {
    runGit: (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }),
  });
  assert.equal(oldBoundary.deepMode, 'full');
  assert.match(oldBoundary.detail, /ENOBUFS/u);
  assert.equal(valid.result.deepMode, 'none');
  assert.equal(valid.result.reason, 'validated-routine-data');
  assert.equal(valid.result.normalDataPaths.length, routineFiles.length);
  assert.deepEqual(valid.result.selectedDeepChecks, []);

  for (const [file, bytes, detail] of [
    [inventoryPath, largeJson.slice(0, -1), /invalid JSON/u],
    [inventoryPath, Buffer.concat([Buffer.from(largeJson), Buffer.from([0xff])]), /invalid UTF-8/u],
    [packetPath, ' '.repeat(2 * 1024 * 1024) + JSON.stringify({ packet_id: 'R999999' }), /relation-packet-contract-missing/u],
    [canonicalPath, canonical + JSON.stringify({ lemma: 'invalid' }) + '\n', /./u],
  ]) {
    const { result } = await classify([[file, bytes]]);
    assert.equal(result.deepMode, 'full');
    assert.equal(result.reason, 'routine-data-validation-failed');
    assert.equal(result.path, file);
    assert.match(result.detail, detail);
  }

  // A blob above the previous 64 MiB limit is read by the production classifier.
  const large = await classify([[inventoryPath, JSON.stringify({ padding: 'x'.repeat(64 * 1024 * 1024) })]]);
  assert.equal(large.result.deepMode, 'none');
  assert.equal(large.result.reason, 'validated-routine-data');
  // Exceeding the configured buffer still fails closed with a content-free diagnostic.
  const oversized = classifyDeepGateDiff(base, large.head, {
    runGit: (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', maxBuffer: 1024 * 1024 }),
  });
  assert.equal(oversized.deepMode, 'full');
  assert.equal(oversized.path, inventoryPath);
  assert.match(oversized.detail, /git "show" .*code=ENOBUFS/u);
  assert.ok(oversized.detail.length < 1000, 'buffer failure diagnostics must not contain file output');

  const mixed = await classify([[inventoryPath, largeJson], ['scripts/normalize/canonical.mjs', '// fixture\n']]);
  assert.equal(mixed.result.deepMode, 'selective');
  assert.ok(mixed.result.selectedDeepChecks.length > 0);
  const classifier = await classify([[inventoryPath, largeJson], ['scripts/ci/deep-gate.mjs', '// fixture\n']]);
  assert.equal(classifier.result.deepMode, 'full');
  const unknown = await classify([['unclassified.bin', 'fixture']]);
  assert.equal(unknown.result.reason, 'unclassified-path');
  assert.equal(unknown.result.deepMode, 'full');
  for (const [revision, cwd] of [['missing-revision', root], [base, path.join(root, 'missing-directory')]]) {
    const result = classifyDeepGateDiff(revision, unknown.head, { cwd });
    assert.equal(result.deepMode, 'full');
    assert.equal(result.reason, 'diff-command-failed');
    assert.match(result.detail, /git "diff" .*failed/u);
    assert.match(result.detail, /status=128|code=ENOENT/u);
    assert.ok(result.detail.length < 1000);
  }

  const secret = 'REDACT_ME_PRIVATE_TOKEN_MUST_NEVER_APPEAR';
  for (const [file, bytes, kind] of [
    [inventoryPath, secret + ' invalid JSON', 'invalid JSON'],
    ['data/inventory/large-fixture.jsonl', JSON.stringify({ ok: true }) + '\n' + secret, 'invalid JSON'],
    [canonicalPath, secret + '\n', 'invalid JSON'],
    ['data/inventory/large-fixture.jsonl', JSON.stringify(secret) + '\n', 'jsonl-row-not-object'],
    ['data/inventory/large-fixture.jsonl', JSON.stringify({ secret }) + '\n\n', 'jsonl-empty-or-blank-row'],
    [canonicalPath, JSON.stringify({ ...JSON.parse(record), [secret]: true }) + '\n', 'canonical-record-validation-failed'],
    [packetPath, JSON.stringify({ ...packet, packet_id: secret }), 'relation-packet-id-mismatch'],
    [packetPath, JSON.stringify({ ...packet, relation_amendments: [{ secret }] }), 'relation-packet-validation-failed'],
    ['scripts/ci/deep-gate-coverage.json', JSON.stringify({ version: 1, bindings: [{ path: secret }] }), 'coverage-registration-validation-failed'],
  ]) {
    const { head } = await classify([[file, bytes]]);
    // Exercise the actual CLI and Git subprocesses, including public JSON output
    // and the exact summary artifact GitHub publishes. No mocked validators.
    const summaryPath = path.join(root, '.git', 'failure-summary.md');
    await rm(summaryPath, { force: true });
    const stdout = execFileSync(process.execPath, [path.resolve(TEST_DIRECTORY, '../scripts/ci/deep-gate.mjs'), base, head], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_DIR: path.join(root, '.git'), GIT_WORK_TREE: root, GITHUB_STEP_SUMMARY: summaryPath, GITHUB_OUTPUT: path.join(root, '.git', 'outputs') },
    });
    const result = JSON.parse(stdout);
    const summary = await readFile(summaryPath, 'utf8');
    assert.equal(result.deepMode, 'none', 'bad classification evidence falls back to PR Normal, not Full Deep');
    assert.ok(result.prFallbackReason);
    assert.equal(result.path, file);
    for (const output of [stdout, summary]) {
      assert.ok(!output.includes('REDACT_ME'), 'parser and validator input must not leak into public diagnostics');
      assert.ok(output.includes(file), 'failure path remains visible');
      assert.ok(output.includes(kind), `${file}: safe error kind remains visible`);
    }
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
    assert.equal(category.owner, categoryName, `${categoryName} must remain an explicit domain scope`);
    assert.equal(typeof category.label, 'string');
    assert.ok(category.label.length > 0);
    assert.ok(category.checks.length > 0);
    for (const check of category.checks) {
      assert.equal(typeof check.label, 'string');
      assert.equal(typeof check.command, 'function');
      assert.equal(check.owner, categoryName);
      assert.ok(CI_EXECUTION_TIERS.includes(check.tier));
      const expectedSchedule = check.tier === 'deep' ? 'affected' : 'always';
      assert.equal(check.schedule, expectedSchedule);
      assert.equal(check.protectedContract, check.label);
      assert.ok(Array.isArray(check.deepInputs));
      if (check.tier !== 'deep') assert.deepEqual(check.deepInputs, [], `${categoryName}/${check.label} cannot carry Deep input paths`);
    }
  }
});

test('changed relation Candidate files use an always-on Normal enforcement check', () => {
  const candidateCheck = CI_CATEGORIES.relations.checks.find(
    (check) => check.label === 'Validate changed relation Candidate batches',
  );
  assert.ok(candidateCheck);
  assert.equal(candidateCheck.owner, 'relations');
  assert.equal(candidateCheck.tier, 'normal');
  assert.equal(candidateCheck.schedule, 'always');
  assert.deepEqual(candidateCheck.command().args, ['scripts/relation/validate-candidate-changes.mjs']);

  const contractTest = CI_CATEGORIES.relations.checks.find(
    (check) => check.label === 'Test relation Candidate v1 batch contract',
  );
  assert.ok(contractTest);
  assert.equal(contractTest.tier, 'normal');
  assert.equal(contractTest.schedule, 'always');
});

test('legacy tier data stays consistent with registered checks', () => {
  assert.deepEqual(Object.keys(LEGACY_CHECK_TIERS).sort(), Object.keys(LEGACY_CHECK_IDENTITIES).sort());
  for (const owner of Object.keys(LEGACY_CHECK_IDENTITIES)) {
    assert.deepEqual(
      [...LEGACY_CHECK_IDENTITIES[owner]].sort(),
      Object.keys(LEGACY_CHECK_TIERS[owner]).sort(),
      `${owner} must have a tier for every known legacy check`,
    );
  }
});

test('new CI checks default to Deep and affected schedules require explicit dependencies', () => {
  const check = {
    label: 'Synthetic future check',
    command: () => ({ executable: 'synthetic', args: [] }),
  };
  const registered = registerCheck(check, { owner: 'toolchain' });
  assert.equal(registered.tier, 'deep');
  assert.equal(registered.schedule, 'always');
  assert.deepEqual(registered.paths, []);
  assert.equal(registered.protectedContract, check.label);
  assert.equal(registered.registration, 'explicit');
  assert.deepEqual(registered.deepInputs, []);

  assert.throws(
    () => registerCheck(check, { owner: 'toolchain', schedule: 'affected' }),
    /at least one dependency path/u,
  );
  assert.throws(
    () => registerCheck(check, {
      owner: 'toolchain',
      schedule: 'affected',
      paths: ['scripts/ci', '../outside'],
    }),
    /normalized repository-relative paths/u,
  );
  assert.throws(
    () => registerCheck(check, { owner: 'toolchain', tier: 'sometimes' }),
    /Unknown CI execution tier/u,
  );
  assert.throws(
    () => registerCheck(check, { owner: 'relations', tier: 'historical' }),
    /Unknown CI execution tier/u,
  );
  assert.throws(
    () => registerCheck(check, {
      owner: 'canonical',
      tier: 'normal',
      deepInputs: ['data/canonical/'],
    }),
    /Only Deep CI checks/u,
  );
  assert.throws(
    () => registerCheck(check, {
      owner: 'canonical',
      deepInputs: ['data/canonical/', '../outside'],
    }),
    /normalized repository-relative paths/u,
  );

  const futureCategory = registerCategory('future-scope', {
    label: 'Future scope',
    checks: [check],
  });
  assert.equal(futureCategory.checks[0].tier, 'deep');
  assert.equal(futureCategory.checks[0].registration, 'explicit');

  const extendedCanonical = registerCategory('canonical', {
    ...CI_CATEGORIES.canonical,
    checks: [
      ...CI_CATEGORIES.canonical.checks,
      {
        label: 'New canonical Deep regression',
        command: () => ({ executable: 'synthetic', args: [] }),
      },
    ],
  });
  assert.equal(extendedCanonical.checks.at(-1).tier, 'deep');
  assert.equal(extendedCanonical.checks.at(-1).registration, 'explicit');

  const intentionalMigration = registerCategory('migration-scope', {
    label: 'Migration scope',
    checks: [{ ...check, tier: 'normal' }],
  }, {
    legacyIdentities: { 'migration-scope': [check.label] },
    legacyTiers: { 'migration-scope': {} },
  });
  assert.equal(intentionalMigration.checks[0].tier, 'normal');
  assert.equal(intentionalMigration.checks[0].registration, 'explicit');
});

test('removing or misspelling a known legacy tier cannot demote required checks to Deep', () => {
  const scenarios = [
    {
      owner: 'canonical',
      label: 'Validate manifest version',
      replacement: undefined,
    },
    {
      owner: 'canonical',
      label: 'Validate canonical JSONL',
      replacement: 'Validate canonical JSONL (misspelled)',
    },
  ];

  for (const { owner, label, replacement } of scenarios) {
    const category = CI_CATEGORIES[owner];
    const legacyTiers = structuredClone(LEGACY_CHECK_TIERS);
    const tier = legacyTiers[owner][label];
    assert.ok(tier, `${owner}/${label} must be in the current legacy migration map`);
    delete legacyTiers[owner][label];
    if (replacement) legacyTiers[owner][replacement] = tier;
    const checks = category.checks.map(({ tier: _tier, ...check }) => ({
      ...check,
      tier: undefined,
    }));

    assert.throws(
      () => registerCategory(owner, { ...category, checks }, {
        legacyIdentities: LEGACY_CHECK_IDENTITIES,
        legacyTiers,
      }),
      /stale legacy registrations|has no tier mapping or explicit migration tier/u,
      `${owner}/${label} must fail closed`,
    );
  }
});

test('registry selects checks by tier and schedule with fail-closed affected-path inputs', () => {
  const check = (label, policy) => registerCheck({
    label,
    command: () => ({ executable: 'synthetic', args: [label] }),
  }, { owner: 'toolchain', ...policy });
  const always = check('normal always', { tier: 'normal' });
  const affected = check('normal affected', {
    tier: 'normal',
    schedule: 'affected',
    paths: ['scripts/ci'],
  });
  const manual = check('deep manual', { tier: 'deep', schedule: 'manual' });
  const checks = [always, affected, manual];

  assert.deepEqual(
    selectChecksForPolicy(checks, {
      tiers: ['normal'],
      changedPaths: ['scripts/ci/registry.mjs'],
    }),
    [always, affected],
  );
  assert.deepEqual(
    selectChecksForPolicy(checks, {
      tiers: ['normal'],
      changedPaths: ['src/search.mjs'],
    }),
    [always, affected],
    'an unclassified changed path must run every affected check in the tier',
  );
  assert.deepEqual(
    selectChecksForPolicy(checks, { tiers: ['normal'], changedPaths: [] }),
    [always, affected],
    'an empty or unclassifiable change set must run affected checks',
  );
  assert.deepEqual(
    selectChecksForPolicy(checks, {
      tiers: ['deep'],
      includeManual: true,
      changedPaths: ['scripts/ci/registry.mjs'],
    }),
    [manual],
  );
  assert.deepEqual(
    selectChecksForPolicy(checks, { tiers: ['normal'] }),
    [always, affected],
    'missing changed-path evidence must run every affected check',
  );
  assert.deepEqual(
    selectChecksForPolicy(checks, {
      tiers: ['normal'],
      changedPaths: ['../unclassifiable'],
    }),
    [always, affected],
    'malformed changed paths must run every affected check',
  );
});

test('automatic Vitest files are explicit, durable, and match their Normal CI registration', async () => {
  const productCheck = CI_CATEGORIES.product.checks.find((check) => check.label === 'Run product unit tests');
  const configured = [...(VITEST_CONFIG.test?.include ?? [])].sort();
  const registered = [...(productCheck?.testFiles ?? [])].sort();
  const filesOnDisk = (await readdir(TEST_DIRECTORY))
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => `tests/${name}`)
    .sort();

  assert.deepEqual(registered, [...PRODUCT_UNIT_TEST_FILES].sort());
  assert.deepEqual(configured, registered, 'Vitest discovery and CI ownership must have one exact file set');
  assert.deepEqual(filesOnDisk, registered, 'a one-off or unregistered Vitest test must not remain in the repository');
});

test('every Node test file has one automatic CI owner and no retired manual test remains', async () => {
  const testFilePattern = /^(?:tests|scripts)\/.+\.test\.(?:mjs|js|py)$/u;
  const pythonTestPattern = /^(?:tests|scripts)\/.+\/test_[^/]+\.py$/u;
  const filesOnDisk = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) {
        const repositoryPath = path.relative(path.resolve(TEST_DIRECTORY, '..'), absolutePath).split(path.sep).join('/');
        if (testFilePattern.test(repositoryPath) || pythonTestPattern.test(repositoryPath)) {
          filesOnDisk.push(repositoryPath);
        }
      }
    }
  };
  await Promise.all(['tests', 'scripts'].map((directory) => visit(path.resolve(TEST_DIRECTORY, '..', directory))));

  const owners = new Map();
  for (const categoryName of CI_ALL_CATEGORY_ORDER) {
    for (const check of CI_CATEGORIES[categoryName].checks) {
      const files = new Set(check.testFiles ?? []);
      const command = check.command({});
      for (const argument of command.args ?? []) {
        if (typeof argument === 'string' && (testFilePattern.test(argument) || pythonTestPattern.test(argument))) {
          files.add(argument);
        }
      }
      for (const file of files) {
        const previous = owners.get(file) ?? [];
        previous.push({ categoryName, check });
        owners.set(file, previous);
      }
    }
  }

  assert.deepEqual([...owners.keys()].sort(), filesOnDisk.sort(), 'on-disk test files and CI registrations must match exactly');
  for (const [file, registeredOwners] of owners) {
    assert.equal(registeredOwners.length, 1, `${file} has one owner: ${registeredOwners.map(({ categoryName, check }) => `${categoryName}/${check.label}`).join(', ')}`);
    const { check } = registeredOwners[0];
    assert.ok(check && check.schedule !== 'manual', `${file} remains an automatic current-contract check`);
  }
});

test('Normal CI owns current relation backfill and correction regressions', () => {
  const relationChecks = CI_CATEGORIES.relations.checks;
  const commands = relationChecks.map((check) => check.command({}));

  assert.ok(CI_NORMAL_CATEGORY_ORDER.includes('relations'));
  assert.ok(commands.some(({ executable, args }) => (
    executable === process.execPath && args.includes('scripts/relation/backfill-apply.test.mjs')
  )));
});

test('automatic toolchain checks preserve data validation and never build current-canonical SQLite', () => {
  const toolchainChecks = CI_CATEGORIES.toolchain.checks;
  assert.equal(toolchainChecks[0].inProcess, 'global-canonical-audit');
  assert.equal(toolchainChecks[1].inProcess, 'normalize-canonical');
  assert.equal(toolchainChecks[3].inProcess, 'm2-data-audit');
  const projectionReuseIndex = toolchainChecks.findIndex(
    (check) => check.inProcess === 'surface-form-projection-reuse',
  );
  assert.ok(projectionReuseIndex > 2);
  assert.ok(projectionReuseIndex < toolchainChecks.findIndex(
    (check) => check.testFiles?.includes('tests/build-dictionary.test.mjs'),
  ));
  assert.ok(toolchainChecks.some((check) => check.testFiles?.includes('tests/build-provenance.test.mjs')));
  const productScripts = CI_CATEGORIES.product.checks
    .flatMap((check) => check.command({}).args ?? [])
    .filter((argument) => typeof argument === 'string');
  assert.ok(productScripts.includes('build:ui'));
  assert.equal(productScripts.includes('build'), false);
  assert.equal(productScripts.includes('validate:product-outputs'), false);
  assert.equal(CI_CATEGORIES.deep.checks.some(
    (check) => check.testFiles?.some((file) => /reproducibility\.test/u.test(file)),
  ), false, 'the in-process Deep data projection audit has no DB-dependent test module');
});

test('the SQL schema-only workflow is the only automatic path to the current-canonical Full/Lite build', async () => {
  const packageJson = JSON.parse(await readFile(path.resolve(TEST_DIRECTORY, '../package.json'), 'utf8'));
  const workflow = await readFile(path.resolve(TEST_DIRECTORY, '../.github/workflows/ci.yml'), 'utf8');
  assert.equal(packageJson.scripts['ci:schema'], 'node scripts/ci/schema-build-gate.mjs');
  assert.match(workflow, /Classify exact SQL schema diff/u);
  assert.match(workflow, /steps\.schema\.outputs\.schema_changed == 'true'/u);
  assert.match(workflow, /pnpm run ci:schema/u);
  assert.ok(
    workflow.indexOf('name: Set up Node.js') < workflow.indexOf('name: Classify exact SQL schema diff'),
    'the schema classifier must use the repository-supported Node version',
  );
});

test('current-canonical surface-form gate runs in-process on the shared projection', () => {
  const checks = CI_CATEGORIES.canonical.checks;
  const auditIndex = checks.findIndex((check) => check.inProcess === 'global-canonical-audit');
  const projectionIndex = checks.findIndex((check) => check.inProcess === 'surface-form-projection');
  assert.ok(auditIndex >= 0);
  assert.ok(projectionIndex > auditIndex);
  assert.equal(
    checks[projectionIndex].label,
    'Validate M6-3 surface-form projection coverage',
  );
  assert.equal(checks[projectionIndex].command({}).executable, '[in-process]');
});

test('CI levels are nested and Deep reproducibility stays on the data projection', async () => {
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
  assert.deepEqual(CI_LEVEL_CATEGORY_ORDER.normal, CI_ALL_CATEGORY_ORDER);
  assert.deepEqual(CI_LEVEL_CATEGORY_ORDER.all, CI_ALL_CATEGORY_ORDER);
  assert.deepEqual(CI_LEVEL_CATEGORY_ORDER.pr, CI_ALL_CATEGORY_ORDER);
  assert.deepEqual(CI_LEVEL_CATEGORY_ORDER.deep, CI_ALL_CATEGORY_ORDER);
  assert.deepEqual(CI_TIER_CATEGORY_ORDER.normal, CI_ALL_CATEGORY_ORDER);
  assert.deepEqual(CI_TIER_CATEGORY_ORDER.deep, CI_ALL_CATEGORY_ORDER);
  assert.deepEqual(CI_LEVEL_EXECUTION_POLICY.normal.tiers, ['normal']);
  assert.deepEqual(CI_LEVEL_EXECUTION_POLICY.deep.tiers, ['deep']);
  assert.deepEqual(CI_LEVEL_EXECUTION_POLICY.all.tiers, ['normal', 'deep']);
  assert.deepEqual(CI_LEVEL_EXECUTION_POLICY.pr.tiers, ['normal', 'deep']);
  assert.equal(Object.hasOwn(CI_LEVEL_CATEGORY_ORDER, 'candidates'), false);
  assert.equal(CI_EXECUTION_TIERS.includes('candidate'), false);
  const allChecks = CI_ALL_CATEGORY_ORDER.flatMap((categoryName) => CI_CATEGORIES[categoryName].checks);
  const allLevelChecks = selectChecksForPolicy(allChecks, CI_LEVEL_EXECUTION_POLICY.all);
  assert.ok(allLevelChecks.every((check) => ['normal', 'deep'].includes(check.tier)));
  assert.equal(CI_NORMAL_CATEGORY_ORDER.includes('product'), true);
  assert.equal(Object.hasOwn(CI_CATEGORIES, 'factory'), false);
  assert.equal(Object.hasOwn(CI_CATEGORIES, 'batch'), false);
  assert.equal(Object.hasOwn(CI_CATEGORIES, 'lexical'), false);
  assert.deepEqual(CI_DEEP_CATEGORY_ORDER, ['deep']);
  assert.ok(CI_CATEGORIES.deep.checks.some(
    (check) => check.inProcess === 'deep-data-projection-reproducibility',
  ));
  assert.equal(CI_CATEGORIES.deep.checks.some(
    (check) => check.testFiles?.some((file) => /reproducibility\.test/u.test(file)),
  ), false);
  assert.ok(CI_CATEGORIES.deep.checks.every(
    (check) => !/100K|500K|1M|scale benchmark/iu.test(check.label),
  ));
});

test('Normal coverage additions bind actual always-on tests without weakening existing Deep coverage', () => {
  const manifestPath = 'scripts/ci/deep-gate-coverage.json';
  const coveredPath = 'scripts/ci/product-unit-test-files.mjs';
  const base = NORMAL_COVERAGE;
  const current = {
    ...NORMAL_COVERAGE,
    bindings: [...NORMAL_COVERAGE.bindings, {
      path: coveredPath,
      normal_tests: ['tests/ci-registry.test.mjs'],
      protected_contract: 'explicit product unit test enrollment',
    }],
  };
  const registered = validateNormalCoverage();
  assert.ok(registered.size > 0);
  assert.equal(classifyDeepGatePaths(['scripts/retired/unregistered-future.mjs']).deepMode, 'full');
  assert.equal(classifyDeepGatePaths([manifestPath]).deepMode, 'full');
  assert.equal(classifyDeepGatePaths(['scripts/validate/canonical-jsonl.mjs']).deepMode, 'selective');

  assert.equal(validateAdditiveNormalCoverage(base, current).size, current.bindings.length);
  assert.throws(() => validateAdditiveNormalCoverage(current, base), /removes or alters/);
  assert.throws(() => validateAdditiveNormalCoverage(current, {
    ...current,
    bindings: current.bindings.filter((binding) => binding.path !== coveredPath),
  }), /removes or alters/);
  assert.throws(() => validateAdditiveNormalCoverage(current, {
    ...current,
    bindings: current.bindings.map((binding) => binding.path === coveredPath
      ? { ...binding, protected_contract: 'weakened contract' }
      : binding),
  }), /removes or alters/);

  const missingTest = { version: 1, bindings: [
    { path: 'scripts/feature/future.mjs', normal_tests: ['tests/missing-future.test.mjs'], protected_contract: 'not actually tested' },
  ] };
  assert.throws(() => validateNormalCoverage(missingTest, { retirements: EMPTY_COVERAGE_RETIREMENTS }), /not always-on/);
  const deepOverlap = { version: 1, bindings: [
    { path: 'scripts/validate/canonical-jsonl.mjs', normal_tests: ['tests/ci-registry.test.mjs'], protected_contract: 'unsafe deep override' },
  ] };
  assert.throws(() => validateNormalCoverage(deepOverlap, { retirements: EMPTY_COVERAGE_RETIREMENTS }), /Unsafe or duplicate/);
  const wildcard = { version: 1, bindings: [
    { path: 'scripts/feature/', normal_tests: ['tests/ci-registry.test.mjs'], protected_contract: 'unsafe broad allowlist' },
  ] };
  assert.throws(() => validateNormalCoverage(wildcard, { retirements: EMPTY_COVERAGE_RETIREMENTS }), /Unsafe or duplicate/);

  const pathBytes = Buffer.from([manifestPath, coveredPath].join('\0') + '\0');
  const runGit = (args) => {
    if (args[0] === 'diff') return pathBytes;
    if (args[0] === 'show' && args[1] === 'base:' + manifestPath) return Buffer.from(JSON.stringify(base));
    if (args[0] === 'show' && args[1] === 'head:' + manifestPath) return Buffer.from(JSON.stringify(current));
    throw new Error('unexpected git invocation: ' + args.join(' '));
  };
  const updated = classifyDeepGateDiff('base', 'head', { runGit });
  assert.equal(updated.deepMode, 'none', 'add-only registry plus source file uses always-on Normal regression');

  const invalid = classifyDeepGateDiff('base', 'head', { runGit: (args) => (
    args[0] === 'show' && args[1] === 'head:' + manifestPath
      ? Buffer.from(JSON.stringify(base))
      : args[0] === 'show' && args[1] === 'base:' + manifestPath
        ? Buffer.from(JSON.stringify(current))
        : runGit(args)
  ) });
  assert.equal(invalid.deepMode, 'full', 'removed binding cannot silently skip independent Deep');
  assert.equal(invalid.reason, 'normal-coverage-registration-unverified');
});

test('retired append-only Normal bindings are documented and cannot silently return', async (t) => {
  const bindings = new Map(NORMAL_COVERAGE.bindings.map((binding) => [binding.path, binding]));
  for (const retirement of NORMAL_COVERAGE_RETIREMENTS.retirements) {
    assert.deepEqual(bindings.get(retirement.path)?.normal_tests, retirement.normal_tests);
    for (const testFile of retirement.normal_tests) {
      const absolutePath = path.resolve(TEST_DIRECTORY, '..', testFile);
      try {
        await readFile(absolutePath);
        assert.ok(
          Object.values(CI_CATEGORIES).some((category) => category.checks.some((check) => (
            (check.testFiles ?? []).includes(testFile)
          ))),
          `${testFile} must remain actively registered if it still exists`,
        );
      } catch (error) {
        assert.equal(error.code, 'ENOENT');
      }
    }
  }
  assert.equal(validateNormalCoverage().size, bindings.size);

  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-retired-coverage-'));
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }));
  const reintroducedPath = 'scripts/factory/produce-candidates.mjs';
  await mkdir(path.join(repositoryDirectory, path.dirname(reintroducedPath)), { recursive: true });
  await writeFile(path.join(repositoryDirectory, reintroducedPath), '// reintroduced\n');
  assert.throws(() => validateNormalCoverage(NORMAL_COVERAGE, { repositoryDirectory }), /reintroduced/);
});

test('Deep gate separates validated data from affected contracts and fails closed', async () => {
  const deepCheckIds = (result) => result.selectedDeepChecks ?? [];
  const relationId = 'relations/Test Canonical relation backfill queue, apply, and correction paths';
  const artifactPolicyId = 'artifacts/Test artifact policy';

  for (const pathValue of [
    '.github/workflows/deep.yml',
    '.github/workflows/ci.yml',
    'scripts/ci/run-category.mjs',
    'scripts/ci/deep-gate.mjs',
    'tests/ci-registry.test.mjs',
    'tests/ci-runner.test.mjs',
    'new/unknown/path.txt',
    'data/new-deep-input.json',
    'data/candidates/C000001/new-file.json',
    'data/candidates/C000001/nested/candidates.jsonl',
  ]) {
    assert.equal(classifyDeepGatePaths([pathValue]).deepMode, 'full', pathValue);
  }

  const runtimeHelper = classifyDeepGatePaths(['scripts/benchmark/sqlite-runtime.mjs']);
  assert.equal(runtimeHelper.deepMode, 'none', 'the current WASM runtime helper is covered by Normal, not Deep');
  assert.equal(routePrDeepGate(runtimeHelper).deepMode, 'none', 'the runtime helper does not select unrelated Deep checks');
  for (const pathValue of [
    'src/runtime/dictionary-contract.js',
    'src/runtime/sqlite-query.js',
    'src/runtime/search-query.js',
    'src/runtime/dictionary-validation.js',
  ]) {
    assert.deepEqual(deepCheckIds(classifyDeepGatePaths([pathValue])), [], pathValue);
  }
  assert.deepEqual(deepCheckIds(classifyDeepGatePaths(['tests/artifact-policy.test.mjs'])), [artifactPolicyId]);
  assert.deepEqual(deepCheckIds(classifyDeepGatePaths(['scripts/relation/backfill-apply.test.mjs'])), [relationId]);
  assert.deepEqual(
    deepCheckIds(classifyDeepGatePaths(['schema/canonical-record.schema.json'])).sort(),
    [
      'deep/Run single-pass global canonical audit',
    ].sort(),
  );

  for (const pathValue of [
    'docs/review-toolchain.md',
    'docs/new-deep-gate-contract.md',
    'src/components/SearchBar.vue',
    'web/src/App.vue',
    'public/favicon.ico',
    'tests/normalize-canonical.test.mjs',
  ]) {
    assert.equal(classifyDeepGatePaths([pathValue]).deepMode, 'none', pathValue);
  }
  assert.equal(
    classifyDeepGatePaths(['data/canonical/records.jsonl']).deepMode,
    'full',
    'path-only canonical evidence cannot select the routine-data exemption',
  );
  assert.equal(
    classifyDeepGatePaths(['data/canonical/records.jsonl'], {
      validatedDataPaths: new Set(['data/canonical/records.jsonl']),
    }).deepMode,
    'none',
  );
  assert.equal(classifyDeepGatePaths(['tests/new-unregistered-check.test.mjs']).deepMode, 'full');
  assert.equal(classifyDeepGatePaths(['docs/review-toolchain.md', 'scripts/ci/run-category.mjs']).deepMode, 'full');
  assert.equal(classifyDeepGatePaths([]).deepMode, 'full');
  assert.equal(classifyDeepGatePaths(['../outside']).deepMode, 'full');
  assert.equal(classifyDeepGateDiff(undefined, 'head').deepMode, 'full');
  assert.equal(classifyDeepGateDiff('base', 'head', { runGit: () => Buffer.from('') }).deepMode, 'full');
  assert.equal(
    classifyDeepGateDiff('base', 'head', { runGit: () => Buffer.from('docs/review-toolchain.md\0') }).deepMode,
    'none',
  );
  assert.equal(
    classifyDeepGateDiff('base', 'head', { runGit: () => Buffer.from('scripts/benchmark/sqlite-runtime.mjs\0') }).deepMode,
    'none',
  );
  assert.equal(
    classifyDeepGateDiff('base', 'head', { runGit: () => { throw new Error('git diff failed'); } }).deepMode,
    'full',
  );

  const canonicalPath = 'data/canonical/sample.jsonl';
  const originalRecord = JSON.parse(sampleCanonicalRecordLine());
  const changedRecord = { ...originalRecord, lemma: `${originalRecord.lemma}확인` };
  const canonicalRunGit = (nextRecord) => (args) => {
    if (args[0] === 'diff' && args.includes('--name-only')) return Buffer.from(`${canonicalPath}\0`);
    if (args[0] === 'diff' && args.includes('--unified=0')) {
      return Buffer.from(`--- a/${canonicalPath}\n+++ b/${canonicalPath}\n@@ -1 +1 @@\n-${JSON.stringify(originalRecord)}\n+${JSON.stringify(nextRecord)}\n`);
    }
    throw new Error(`unexpected git command: ${args.join(' ')}`);
  };
  const validCanonical = classifyDeepGateDiff('base', 'head', { runGit: canonicalRunGit(changedRecord) });
  assert.equal(validCanonical.deepMode, 'none');
  assert.equal(validCanonical.changeClass, 'routine-data');
  const malformedCanonical = classifyDeepGateDiff('base', 'head', {
    runGit: canonicalRunGit({ ...changedRecord, unknown_schema_field: true }),
  });
  assert.equal(malformedCanonical.deepMode, 'full');
  assert.equal(malformedCanonical.reason, 'routine-data-validation-failed');

  const packetPath = 'data/relation-backfill/R999999.json';
  const packet = syntheticRelationPacket('R999999');
  const packetRunGit = (value) => (args) => {
    if (args[0] === 'diff' && args.includes('--name-only')) return Buffer.from(`${packetPath}\0`);
    if (args[0] === 'show') return Buffer.from(JSON.stringify(value));
    throw new Error(`unexpected git command: ${args.join(' ')}`);
  };
  assert.equal(classifyDeepGateDiff('base', 'head', { runGit: packetRunGit(packet) }).deepMode, 'none');
  const malformedPacket = structuredClone(packet);
  malformedPacket.packet_id = 'R000004';
  assert.equal(classifyDeepGateDiff('base', 'head', { runGit: packetRunGit(malformedPacket) }).deepMode, 'full');

  const deletedPacketRunGit = (deleted) => (args) => {
    if (args[0] === 'diff' && args.includes('--diff-filter=D')) {
      return Buffer.from(deleted ? `${packetPath}\0` : '');
    }
    if (args[0] === 'diff' && args.includes('--name-only')) return Buffer.from(`${packetPath}\0`);
    if (args[0] === 'show' && args[1] === `base:${packetPath}`) return Buffer.from(JSON.stringify(packet));
    if (args[0] === 'show') throw new Error('head blob is unavailable');
    throw new Error(`unexpected git command: ${args.join(' ')}`);
  };
  assert.equal(
    classifyDeepGateDiff('base', 'head', { runGit: deletedPacketRunGit(true) }).deepMode,
    'none',
    'a confirmed deletion validates the prior packet shape before Normal handles integrity',
  );
  const unreadableHead = classifyDeepGateDiff('base', 'head', {
    runGit: deletedPacketRunGit(false),
  });
  assert.equal(unreadableHead.deepMode, 'full');
  assert.equal(unreadableHead.reason, 'routine-data-validation-failed');

  const relationRepairPaths = [
    canonicalPath,
    packetPath,
    'data/inventory/issue-210-recovery-inventory.json',
    'data/validation/canonical-semantic-decision-source.json',
    'data/validation/issue-512-relation-repair-report.json',
    'docs/relation-pilot-repair-issue-507.md',
  ];
  const relationRepairValues = new Map([
    [packetPath, packet],
    ['data/inventory/issue-210-recovery-inventory.json', { records: [] }],
    ['data/validation/canonical-semantic-decision-source.json', { contract_version: 'fixture' }],
    ['data/validation/issue-512-relation-repair-report.json', { outcome: 'fixture' }],
  ]);
  const relationRepair = classifyDeepGateDiff('base', 'head', {
    runGit: (args) => {
      if (args[0] === 'diff' && args.includes('--name-only')) {
        return Buffer.from(`${relationRepairPaths.join('\0')}\0`);
      }
      if (args[0] === 'diff' && args.includes('--unified=0')) {
        return Buffer.from(`--- a/${canonicalPath}\n+++ b/${canonicalPath}\n@@ -1 +1 @@\n-${JSON.stringify(originalRecord)}\n+${JSON.stringify(changedRecord)}\n`);
      }
      if (args[0] === 'show') {
        const filePath = args[1].split(':').slice(1).join(':');
        if (!relationRepairValues.has(filePath)) throw new Error(`unexpected HEAD data path: ${filePath}`);
        return Buffer.from(JSON.stringify(relationRepairValues.get(filePath)));
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    },
  });
  assert.equal(relationRepair.deepMode, 'none');
  assert.equal(relationRepair.changeClass, 'routine-data');
  assert.equal(relationRepair.normalDataPaths.length, 5);
  assert.equal(relationRepair.selectedDeepChecks.length, 0);

  const allChecks = CI_ALL_CATEGORY_ORDER.flatMap((categoryName) => CI_CATEGORIES[categoryName].checks);
  const relationRegression = CI_CATEGORIES.relations.checks.find((check) => (
    check.tier === 'deep' && check.command({}).args.includes('scripts/relation/backfill-apply.test.mjs')
  ));
  assert.ok(relationRegression, 'Deep retains current relation backfill and correction regressions');
  const allDeep = selectChecksForPolicy(allChecks, CI_LEVEL_EXECUTION_POLICY.all).filter((check) => check.tier === 'deep');
  assert.equal(allDeep.length, 5, 'ci:all keeps only current-system Deep checks');
  const runtimeBinding = validateNormalCoverage().get('scripts/benchmark/sqlite-runtime.mjs');
  assert.deepEqual(runtimeBinding?.normal_tests, ['tests/runtime-query-adapter.test.mjs']);
  const affectedRuntimeDeepChecks = selectChecksForPolicy(allChecks, {
    tiers: ['deep'],
    changedPaths: ['scripts/benchmark/sqlite-runtime.mjs'],
    selectedDeepCheckIds: deepCheckIds(runtimeHelper),
  });
  assert.deepEqual(affectedRuntimeDeepChecks, []);

  const workflow = await readFile(path.resolve(TEST_DIRECTORY, '../.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /^name: CI$/mu);
  assert.match(workflow, /^  validate:$/mu);
  assert.match(workflow, /name: Classify changed files/u);
  assert.match(workflow, /node scripts\/ci\/deep-gate\.mjs/u);
  assert.match(workflow, /continue-on-error: true/u);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
  assert.match(workflow, /run: pnpm run ci:pr -- --base/u);
  assert.doesNotMatch(workflow, /run: pnpm run ci:all/u);
  assert.match(workflow, /steps\.changes\.outcome != 'success'/u);
  assert.match(workflow, /steps\.changes\.outputs\.deep_mode == 'selective'/u);
  assert.doesNotMatch(workflow, /steps\.changes\.outputs\.deep_mode == 'full'/u);
  assert.match(workflow, /name: Record executed CI gate/u);
  assert.match(workflow, /- Final gate result: \$\{FINAL_GATE:-unknown\}/u);
  assert.doesNotMatch(workflow, /name: Classify Deep coverage/u);
  assert.doesNotMatch(workflow, /^  classify:$/mu);
});


// Execute the actual inline CI classifier against tiny synthetic Git histories.
// Retired Stage 1 artifact paths and every other non-doc change use Normal.
test('CI changed-path gate sends all non-doc changes through Normal', async (t) => {
  const workflow = await readFile(path.resolve(TEST_DIRECTORY, '../.github/workflows/ci.yml'), 'utf8');
  const block = workflow.split('      - name: Classify changed files\n')[1]
    ?.split('      - name: Install pinned dependencies\n')[0];
  assert.ok(block, 'workflow must classify PR changes before validation');
  const scriptBlock = block.split('\n          # Deep impact and exact-check selection stay inside this PR check.\n')[0];
  const script = scriptBlock.split('        run: |\n')[1]
    ?.split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  assert.ok(script?.includes('git diff --no-renames --name-only -z'), 'classification must include both rename sides');
  assert.match(workflow, /node scripts\/ci\/deep-gate\.mjs/u, 'Deep classification must run inside the existing classifier step');
  assert.doesNotMatch(workflow, /ci:candidates|run_level == 'candidates'/u);
  assert.match(workflow, /steps\.changes\.outcome != 'success' \|\| \(steps\.changes\.outputs\.run_level == 'normal'/u);

  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-ci-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', encoding: 'utf8' }).trim();
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'docs/guide.md'), 'guide v1\n');
  await writeFile(path.join(root, 'src/main.mjs'), 'export const value = 1;\n');
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.name=CI Test', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']);

  let count = 0;
  const scenario = async (name, edit, expectedLevel) => {
    git(['checkout', '-q', '-B', `fixture-${++count}`, base]);
    if (edit) {
      await edit();
      git(['add', '-A']);
      git(['-c', 'user.name=CI Test', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', name]);
    }
    const head = git(['rev-parse', 'HEAD']);
    // Keep runner outputs under .git so later fixture commits never include them.
    const output = path.join(root, '.git', 'ci-result');
    const summary = path.join(root, '.git', 'ci-summary');
    await rm(output, { force: true });
    await rm(summary, { force: true });
    execFileSync('bash', ['-c', script], {
      cwd: root,
      stdio: 'pipe',
      env: {
        ...process.env,
        BASE_SHA: base,
        HEAD_SHA: head,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    assert.equal(await readFile(output, 'utf8'), `run_level=${expectedLevel}\n`, name);
    const expectedSummary = {
      none: /Changed-path classification: none/u,
      normal: /Changed-path classification: normal/u,
    };
    assert.match(await readFile(summary, 'utf8'), expectedSummary[expectedLevel], name);
  };

  const candidateDir = path.join(root, 'data/candidates/C000031');
  const addCandidate = async (file = 'candidates.jsonl') => {
    await mkdir(candidateDir, { recursive: true });
    await writeFile(path.join(candidateDir, file), '{}\n');
  };
  await scenario('docs-only', () => writeFile(path.join(root, 'docs/guide.md'), 'guide v2\n'), 'none');
  await scenario('root-docs', async () => {
    await writeFile(path.join(root, 'README.md'), 'readme\n');
    await writeFile(path.join(root, 'REVIEW.md'), 'review\n');
  }, 'none');
  await scenario('repository-guidance', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'agents\n');
    await writeFile(path.join(root, 'CLAUDE.md'), 'claude\n');
  }, 'normal');
  await scenario('docs-with-spaces', () => writeFile(path.join(root, 'docs/has spaces.md'), 'new\n'), 'none');
  await scenario('nested-docs', async () => {
    await mkdir(path.join(root, 'docs/reference'), { recursive: true });
    await writeFile(path.join(root, 'docs/reference/data.json'), '{}\n');
  }, 'none');
  await scenario('retired candidate path still requires Normal', () => addCandidate('manifest.json'), 'normal');
  await scenario('mixed-docs-code', async () => {
    await writeFile(path.join(root, 'docs/guide.md'), 'guide v2\n');
    await writeFile(path.join(root, 'src/main.mjs'), 'export const value = 2;\n');
  }, 'normal');
  await scenario('canonical-data', async () => {
    await mkdir(path.join(root, 'data/canonical'), { recursive: true });
    await writeFile(path.join(root, 'data/canonical/records.jsonl'), '{}\n');
  }, 'normal');
  await scenario('unregistered review path still requires Normal', async () => {
    await mkdir(path.join(root, 'data/reviews/C000031'), { recursive: true });
    await writeFile(path.join(root, 'data/reviews/C000031/decisions.jsonl'), '{}\n');
  }, 'normal');
  await scenario('workflow', async () => {
    await mkdir(path.join(root, '.github/workflows'), { recursive: true });
    await writeFile(path.join(root, '.github/workflows/ci.yml'), 'name: changed\n');
  }, 'normal');
  await scenario('docs-nonmarkdown', () => writeFile(path.join(root, 'docs/data.json'), '{}\n'), 'none');
  await scenario('other-markdown', () => writeFile(path.join(root, 'UNCLASSIFIED.md'), 'new\n'), 'normal');
  await scenario('source-to-doc-rename', () => rename(path.join(root, 'src/main.mjs'), path.join(root, 'docs/moved.mjs')), 'normal');
  await scenario('no-changed-files', null, 'normal');
});

test('CI and Pages workflows keep their trigger responsibilities separate', async () => {
  const workflow = await readFile(
    path.resolve(TEST_DIRECTORY, '../.github/workflows/ci.yml'),
    'utf8',
  );
  const deepWorkflow = await readFile(
    path.resolve(TEST_DIRECTORY, '../.github/workflows/deep.yml'),
    'utf8',
  );
  await assert.rejects(
    readFile(path.resolve(TEST_DIRECTORY, '../.github/workflows/deep-gate.yml')),
    { code: 'ENOENT' },
    'Deep coverage must not publish a separate PR check workflow',
  );
  const pagesWorkflow = await readFile(
    path.resolve(TEST_DIRECTORY, '../.github/workflows/pages.yml'),
    'utf8',
  );
  const readme = await readFile(
    path.resolve(TEST_DIRECTORY, '../README.md'),
    'utf8',
  );
  const packageJson = JSON.parse(await readFile(
    path.resolve(TEST_DIRECTORY, '../package.json'),
    'utf8',
  ));

  assert.match(workflow, /pull_request:/u);
  assert.doesNotMatch(workflow, /^\s+push:/mu, 'normal CI runs on PRs, not on master pushes');
  assert.match(workflow, /name: Normal validation \(fast checkpoint \+ continuation\)/u);
  assert.match(workflow, /run: pnpm run ci:normal/u);
  assert.equal((workflow.match(/run: pnpm run ci:normal/gu) ?? []).length, 1);
  assert.match(workflow, /node scripts\/ci\/deep-gate\.mjs/u);
  assert.match(workflow, /name: Selective Deep validation \(Normal \+ affected current Deep\)/u);
  assert.doesNotMatch(workflow, /name: Full Deep validation \(Normal \+ all current Deep\)/u);
  assert.doesNotMatch(workflow, /run: pnpm run ci:all/u);
  assert.match(workflow, /run: pnpm run ci:pr -- --base/u);
  assert.match(workflow, /steps\.changes\.outcome != 'success'/u);
  assert.match(workflow, /steps\.changes\.outputs\.deep_mode == 'selective'/u);
  assert.doesNotMatch(workflow, /steps\.changes\.outputs\.deep_mode == 'full'/u);
  assert.match(workflow, /name: Record executed CI gate/u);
  assert.match(workflow, /FINAL_GATE: \$\{\{ job\.status \}\}/u);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
  assert.doesNotMatch(workflow, /name: Classify Deep coverage/u);
  assert.doesNotMatch(workflow, /^  classify:$/mu);
  assert.match(workflow, /runs-on: ubuntu-24\.04/u);
  assert.match(workflow, /actions\/checkout@v7/u);
  assert.match(workflow, /actions\/setup-node@v7/u);
  assert.match(workflow, /node-version: 24\.x/u);
  assert.doesNotMatch(workflow, /^\s+schedule:/mu);
  assert.doesNotMatch(workflow, /^\s+workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /Candidate validation|ci:candidates/u);
  assert.doesNotMatch(workflow, /run: pnpm run ci:fast/u);
  assert.equal(packageJson.scripts['ci:candidates'], undefined);
  assert.equal(packageJson.scripts['ci:pr'], 'node scripts/ci/run-category.mjs pr');
  assert.equal(packageJson.scripts['ci:historical'], undefined);
  assert.equal((workflow.match(/run: pnpm run ci:all/gu) ?? []).length, 0);

  assert.match(deepWorkflow, /^name: Deep CI$/mu);
  assert.match(deepWorkflow, /schedule:\n\s+- cron: '0 22 \* \* 0'/u);
  assert.match(deepWorkflow, /workflow_dispatch:/u);
  assert.doesNotMatch(deepWorkflow, /^\s+pull_request:/mu);
  assert.doesNotMatch(deepWorkflow, /^\s+push:/mu);
  assert.match(deepWorkflow, /name: Deep validation/u);
  assert.match(deepWorkflow, /run: pnpm run ci:all/u);
  assert.equal((deepWorkflow.match(/run: pnpm run ci:all/gu) ?? []).length, 1);
  assert.match(deepWorkflow, /runs-on: ubuntu-24\.04/u);
  assert.match(deepWorkflow, /actions\/checkout@v7/u);
  assert.match(deepWorkflow, /actions\/setup-node@v7/u);
  assert.match(deepWorkflow, /node-version: 24\.x/u);
  assert.match(deepWorkflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.doesNotMatch(deepWorkflow, /pull_request:/u);

  const pagesEvents = pagesWorkflow.split('\non:\n')[1]?.split('\npermissions:\n')[0]?.trim();
  assert.doesNotMatch(pagesEvents, /schedule:|cron:/u);
  assert.match(pagesEvents, /^workflow_dispatch:$|^  workflow_dispatch:$/mu);
  assert.match(pagesEvents, /^push:\n    branches:\n      - master\n    paths:\n      - 'web\/\*\*'\n/mu);
  assert.doesNotMatch(pagesEvents, /pull_request/u);
  assert.equal((pagesWorkflow.match(/github\.ref == 'refs\/heads\/master'/gu) ?? []).length, 2,
    'both Pages artifact upload and deployment must require master');

  assert.match(
    readme,
    /!\[CI\]\(https:\/\/github\.com\/neverworkalone\/typewriter\/actions\/workflows\/ci\.yml\/badge\.svg\)/u,
  );
  assert.match(
    readme,
    /!\[Deep CI\]\(https:\/\/github\.com\/neverworkalone\/typewriter\/actions\/workflows\/deep\.yml\/badge\.svg\)/u,
  );
});

// pnpm forwards a literal `--` to the script (npm consumed it), so assert against the
// real package manager that a script receives exactly the intended arguments.
test('pnpm script commands deliver exactly the intended arguments to the script', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-pnpm-args-'));
  try {
    await writeFile(path.join(directory, 'argv.mjs'), 'process.stdout.write(`\\nARGV=${JSON.stringify(process.argv.slice(2))}\\n`);\n');
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({
      name: 'pnpm-args-probe',
      private: true,
      scripts: { probe: 'node argv.mjs' },
    }));
    const run = (script, args) => {
      const { executable, args: commandArgs } = pnpmCommand(script, args);
      const output = execFileSync(executable, commandArgs, { cwd: directory, encoding: 'utf8' });
      return JSON.parse(/ARGV=(\[.*\])/u.exec(output)[1]);
    };
    assert.deepEqual(run('probe', []), []);
    assert.deepEqual(run('probe', ['--staged=/tmp/a b.jsonl', '--semantic-audit=/tmp/c.json']), [
      '--staged=/tmp/a b.jsonl',
      '--semantic-audit=/tmp/c.json',
    ]);
    assert.deepEqual(run('probe', ['--scope=issue-219']), ['--scope=issue-219']);
    assert.deepEqual(run('probe', ['--scope=issue-219']), ['--scope=issue-219']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// The Node baseline in package.json must agree with every active document that states it.
test('documented Node baseline matches package.json engines', async () => {
  const root = path.resolve(TEST_DIRECTORY, '..');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const minimum = pkg.engines.node.replace(/^>=/u, '');
  assert.match(minimum, /^24\.\d+\.\d+$/u);
  const [major, minor] = minimum.split('.');
  const workflowDirectory = path.join(root, '.github/workflows');
  let nodeWorkflows = 0;
  for (const workflow of (await readdir(workflowDirectory)).filter((name) => /\.ya?ml$/u.test(name))) {
    const text = await readFile(path.join(workflowDirectory, workflow), 'utf8');
    if (!text.includes('actions/setup-node')) continue;
    nodeWorkflows += 1;
    const versions = [...text.matchAll(/node-version: (\S+)/gu)].map((match) => match[1]);
    assert.deepEqual([...new Set(versions)], [`${major}.x`], `${workflow} must use the Node ${major} baseline only`);
    assert.equal(versions.length, (text.match(/actions\/setup-node/gu) ?? []).length, `${workflow} must pin every setup-node step`);
  }
  assert.ok(nodeWorkflows > 0, 'expected every active Node workflow to be scanned');
  for (const file of ['README.md', 'docs/build.md', 'docs/development.md', 'docs/corpus-index-design.md']) {
    const text = await readFile(path.join(root, file), 'utf8');
    assert.ok(
      text.includes(minimum) || text.includes(`${major}.${minor}`),
      `${file} must state the Node ${minimum} minimum`,
    );
    assert.doesNotMatch(text, /22\.13/u, `${file} must not describe Node 22.13 as the baseline`);
    assert.doesNotMatch(
      text,
      /minimum Node[^.]*\bmay not (?:provide|support|include)|Node 22[^.]*(?:lacks?|without|no) FTS5|FTS5[^.]*(?:lacks?|missing)[^.]*Node 22/iu,
      `${file} must not describe FTS5 as possibly missing on the supported Node baseline`,
    );
  }
});


test('PR gate keeps Normal plus affected Deep for classifier changes', async () => {
  const reproducibility = 'deep/Run canonical data projection reproducibility audit';
  const registry = routePrDeepGate(classifyDeepGateDiff('base', 'head', {
    runGit: (args) => {
      assert.equal(args[0], 'diff');
      return Buffer.from('scripts/ci/registry.mjs\0');
    },
  }));
  assert.equal(registry.deepMode, 'none');
  assert.equal(registry.runDeep, false);
  assert.equal(registry.prFallbackReason, 'classifier-or-ci-contract-path');

  for (const pathValue of ['scripts/ci/deep-gate.mjs', '.github/workflows/ci.yml',
    'tests/ci-registry.test.mjs', 'unknown-future-file.bin']) {
    const outcome = routePrDeepGate(classifyDeepGatePaths([pathValue]));
    assert.equal(outcome.deepMode, 'none', pathValue);
    assert.deepEqual(outcome.selectedDeepChecks, []);
  }

  const mixed = routePrDeepGate(classifyDeepGateDiff('base', 'head', {
    runGit: (args) => {
      assert.equal(args[0], 'diff');
      return Buffer.from('scripts/ci/registry.mjs\0scripts/normalize/canonical.mjs\0');
    },
  }));
  assert.equal(mixed.deepMode, 'selective');
  assert.deepEqual(mixed.selectedDeepChecks, [reproducibility]);
  assert.deepEqual(mixed.matchedTriggers.map(({ path }) => path), ['scripts/normalize/canonical.mjs']);

  const runtime = routePrDeepGate(classifyDeepGatePaths(['scripts/benchmark/sqlite-runtime.mjs']));
  assert.equal(runtime.deepMode, 'none');
  assert.deepEqual(runtime.selectedDeepChecks, []);

  const direct = routePrDeepGate(classifyDeepGatePaths(['scripts/normalize/canonical.mjs']));
  assert.equal(direct.deepMode, 'selective');
  assert.deepEqual(direct.selectedDeepChecks, [reproducibility]);

  const unknownWithDeep = routePrDeepGate(classifyDeepGateDiff('base', 'head', {
    runGit: () => Buffer.from('unclassified.file\0scripts/normalize/canonical.mjs\0'),
  }));
  assert.equal(unknownWithDeep.deepMode, 'selective');
  assert.deepEqual(unknownWithDeep.selectedDeepChecks, [reproducibility]);
  assert.equal(unknownWithDeep.prFallbackReason, 'unclassified-path');

  const missingDiff = routePrDeepGate(classifyDeepGateDiff('base', 'head', {
    runGit: () => { throw new Error('missing git diff'); },
  }));
  assert.equal(missingDiff.deepMode, 'none');
  assert.equal(missingDiff.prFallbackReason, 'diff-command-failed');

  const workflow = await readFile(path.resolve(TEST_DIRECTORY, '../.github/workflows/ci.yml'), 'utf8');
  const weeklyDeep = await readFile(path.resolve(TEST_DIRECTORY, '../.github/workflows/deep.yml'), 'utf8');
  assert.doesNotMatch(workflow, /pnpm run ci:all|Full Deep validation/u);
  assert.match(weeklyDeep, /pnpm run ci:all/u);
  assert.match(weeklyDeep, /cron: '0 22 \* \* 0'/u);
});

test('canonical-only meaning invariants are Normal checks selected even when only canonical data changes', () => {
  const required = [
    'tests/canonical-record-meanings.test.mjs',
    'tests/meaning-provenance.test.mjs',
    'tests/meaning-search.test.mjs',
  ];
  const allChecks = Object.values(CI_CATEGORIES).flatMap((category) => category.checks);
  const meaningChecks = required.map((file) => {
    const matches = allChecks.filter((check) => (check.testFiles ?? []).includes(file));
    assert.equal(matches.length, 1, `${file} has exactly one registry owner`);
    return matches[0];
  });
  for (const check of meaningChecks) {
    assert.equal(check.tier, 'normal');
    assert.equal(check.schedule, 'always');
  }
  for (const changedPaths of [['data/canonical/stdict-0001.jsonl'], []]) {
    const selected = selectChecksForPolicy(meaningChecks, { tiers: ['normal'], changedPaths });
    assert.equal(selected.length, meaningChecks.length, JSON.stringify(changedPaths));
  }
  // The removed Meaning editing layer must not be referenced by any registered check (Issue #822).
  for (const check of allChecks) {
    assert.doesNotMatch(JSON.stringify(check), /scripts\/meaning|data\/meanings|data\/adjudication|meaning-references/u, check.label);
  }
});

test('War Room supervisor tests are a Deep affected check selected by tools/warroom and the war launcher', () => {
  const label = 'Test War Room production supervisor';
  const check = CI_CATEGORIES.toolchain.checks.find((candidate) => candidate.label === label);
  assert.ok(check, 'War Room check is registered');
  assert.equal(check.schedule, 'affected');
  assert.notEqual(check.tier, 'normal');
  assert.deepEqual(check.command({}).args, ['tools/warroom/run-tests.mjs']);
  for (const changed of ['tools/warroom/warroom/supervisor.py', 'tools/warroom/tests/test_core.py', 'war']) {
    const selected = classifyDeepGatePaths([changed]).selectedDeepChecks.map((item) => item.label ?? item.id ?? item);
    assert.ok(selected.some((item) => String(item).includes(label)), `${changed} selects the War Room check`);
  }
  assert.ok(!JSON.stringify(NORMAL_COVERAGE).includes('warroom'),
    'Deep War Room tests are not bound as Normal always-on coverage');
});
