import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  pnpmCommand,
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

test('normal batch CI owns the M9 corpus candidate-review gate and regressions', () => {
  const batchChecks = CI_CATEGORIES.batch.checks;
  const commands = batchChecks.map((check) => check.command({}));

  assert.ok(CI_NORMAL_CATEGORY_ORDER.includes('batch'));
  assert.ok(commands.some(({ executable, args }) => (
    executable === 'pnpm' && args.includes('validate:corpus-candidate-review')
  )));
  assert.ok(commands.some(({ executable, args }) => (
    executable === process.execPath
    && args.includes('scripts/reference/corpus-candidate-review.test.mjs')
  )));
});

test('toolchain builds SQLite only after the shared global audit', () => {
  const toolchainChecks = CI_CATEGORIES.toolchain.checks;
  assert.equal(toolchainChecks[0].inProcess, 'global-canonical-audit');
  assert.equal(toolchainChecks[1].inProcess, 'normalize-canonical');
  assert.equal(toolchainChecks[3].inProcess, 'shared-dictionary-build');
  const projectionReuseIndex = toolchainChecks.findIndex(
    (check) => check.inProcess === 'surface-form-projection-reuse',
  );
  assert.ok(projectionReuseIndex > 3);
  assert.ok(projectionReuseIndex < toolchainChecks.findIndex(
    (check) => check.testFiles?.includes('tests/build-dictionary.test.mjs'),
  ));
  assert.equal(
    CI_CATEGORIES.deep.checks.find((check) => check.testFiles?.includes('tests/reproducibility.test.mjs'))
      .testFiles[0],
    'tests/reproducibility.test.mjs',
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

test('normal canonical CI verifies the frozen M6-4 snapshot without a second full audit build', () => {
  const checks = CI_CATEGORIES.canonical.checks;
  const snapshotCheck = checks.find((check) => check.inProcess === 'm6-4-frozen-snapshot');

  assert.ok(snapshotCheck);
  assert.equal(snapshotCheck.command({}).executable, '[in-process]');
  assert.equal(
    checks.some((check) => check.command({}).args?.includes('audit:m6-4')),
    false,
  );
});

test('M5-15 pre-admission validation owns the current shared in-process session', () => {
  const m515Check = CI_CATEGORIES.batch.checks.find(
    (check) => check.inProcess === 'm5-15-pre-admission',
  );
  assert.ok(m515Check);
  assert.deepEqual(m515Check.testFiles, ['tests/m5-13.test.mjs']);
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
  assert.equal(CI_NORMAL_CATEGORY_ORDER.includes('product'), true);
  assert.equal(
    CI_CATEGORIES.product.checks.some(
      (check) => check.testFiles?.includes('tests/scale-benchmark.test.mjs'),
    ),
    true,
  );
  assert.deepEqual(CI_DEEP_CATEGORY_ORDER, ['historical', 'deep']);
  assert.equal(
    CI_CATEGORIES.deep.checks.at(-1).label,
    'Run 100K/500K/1M release-shaped performance and scale benchmark',
  );
  assert.deepEqual(
    CI_CATEGORIES.deep.checks.at(-1).command({}).args,
    [
      'run',
      'benchmark:release',
      '--sizes=100000,500000,1000000',
      '--sqlite-scale=100000,500000,1000000',
      '--fixed-level-evidence=config/ci-level-evidence.json',
    ],
  );
});


// Execute the actual inline CI classifier against tiny synthetic Git histories. A docs-only
// shortcut must not mask a code deletion disguised as a source-to-doc rename.
test('CI changed-path gate skips only documentation-only PRs', async (t) => {
  const workflow = await readFile(path.resolve(TEST_DIRECTORY, '../.github/workflows/ci.yml'), 'utf8');
  const block = workflow.split('      - name: Classify changed files\n')[1]
    ?.split('      - name: Set up pnpm\n')[0];
  assert.ok(block, 'workflow must classify PR changes before pnpm and Node setup');
  const script = block.split('        run: |\n')[1]
    ?.split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  assert.ok(script?.includes('git diff --no-renames --name-only -z'), 'classification must include both rename sides');
  assert.equal(
    (workflow.match(/if: steps\.changes\.outputs\.run_normal == 'true'/gu) ?? []).length,
    4,
    'pnpm and Node setup, dependencies and the full normal run must all use the same classifier result',
  );

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
  const scenario = async (name, edit, expectedNormal) => {
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
    assert.equal(await readFile(output, 'utf8'), `run_normal=${expectedNormal}\n`, name);
    assert.match(
      await readFile(summary, 'utf8'),
      expectedNormal ? /Full ci:normal required/u : /Documentation-only PR: ci:normal intentionally skipped/u,
      name,
    );
  };

  await scenario('docs-only', () => writeFile(path.join(root, 'docs/guide.md'), 'guide v2\n'), false);
  await scenario('root-docs', async () => {
    await writeFile(path.join(root, 'README.md'), 'readme\n');
    await writeFile(path.join(root, 'REVIEW.md'), 'review\n');
  }, false);
  await scenario('docs-with-spaces', () => writeFile(path.join(root, 'docs/has spaces.md'), 'new\n'), false);
  await scenario('mixed-docs-code', async () => {
    await writeFile(path.join(root, 'docs/guide.md'), 'guide v2\n');
    await writeFile(path.join(root, 'src/main.mjs'), 'export const value = 2;\n');
  }, true);
  await scenario('data', async () => {
    await mkdir(path.join(root, 'data'), { recursive: true });
    await writeFile(path.join(root, 'data/records.jsonl'), '{}\n');
  }, true);
  await scenario('workflow', async () => {
    await mkdir(path.join(root, '.github/workflows'), { recursive: true });
    await writeFile(path.join(root, '.github/workflows/ci.yml'), 'name: changed\n');
  }, true);
  await scenario('other-markdown', () => writeFile(path.join(root, 'UNCLASSIFIED.md'), 'new\n'), true);
  await scenario('source-to-doc-rename', () => rename(path.join(root, 'src/main.mjs'), path.join(root, 'docs/moved.mjs')), true);
  await scenario('no-changed-files', null, true);
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
  const pagesWorkflow = await readFile(
    path.resolve(TEST_DIRECTORY, '../.github/workflows/pages.yml'),
    'utf8',
  );
  const readme = await readFile(
    path.resolve(TEST_DIRECTORY, '../README.md'),
    'utf8',
  );

  assert.match(workflow, /pull_request:/u);
  assert.doesNotMatch(workflow, /^\s+push:/mu, 'normal CI runs on PRs, not on master pushes');
  assert.match(workflow, /name: Normal validation \(fast checkpoint \+ continuation\)/u);
  assert.match(workflow, /run: pnpm run ci:normal/u);
  assert.equal((workflow.match(/run: pnpm run ci:normal/gu) ?? []).length, 1);
  assert.match(workflow, /runs-on: ubuntu-24\.04/u);
  assert.match(workflow, /actions\/checkout@v7/u);
  assert.match(workflow, /actions\/setup-node@v7/u);
  assert.match(workflow, /node-version: 24\.x/u);
  assert.doesNotMatch(workflow, /^\s+schedule:/mu);
  assert.doesNotMatch(workflow, /^\s+workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /pnpm run ci:fast/u);
  assert.doesNotMatch(workflow, /pnpm run ci:all/u);

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
  assert.doesNotMatch(deepWorkflow, /Deep CI Gate|Resolve deep validation target/u);

  const pagesEvents = pagesWorkflow.split('\non:\n')[1]?.split('\npermissions:\n')[0]?.trim();
  assert.equal(pagesEvents, 'push:\n    branches:\n      - master');

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
  for (const file of ['README.md', 'docs/build.md', 'docs/development.md', 'docs/corpus-index-design.md']) {
    const text = await readFile(path.join(root, file), 'utf8');
    assert.ok(
      text.includes(minimum) || text.includes(`${major}.${minor}`),
      `${file} must state the Node ${minimum} minimum`,
    );
    assert.doesNotMatch(text, /22\.13/u, `${file} must not describe Node 22.13 as the baseline`);
  }
});
