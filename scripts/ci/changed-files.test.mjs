import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { classifyChangedFiles, classifyChangedPathDiff, resolveChangeRange } from './changed-files.mjs';
import { classifyDeepGateDiff, classifyDeepGatePaths, routePrDeepGate } from './deep-gate.mjs';
import { runCli } from './run-category.mjs';

function git(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
}

async function writeRepoFile(directory, filePath, contents) {
  const absolutePath = path.join(directory, filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, 'utf8');
}

async function commit(directory, message) {
  git(directory, ['add', '-A']);
  git(directory, ['commit', '-qm', message]);
  return git(directory, ['rev-parse', 'HEAD']);
}

async function makePrWithAdvancedBase() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-changed-paths-'));
  git(directory, ['init', '-q', '--initial-branch=master']);
  git(directory, ['config', 'user.name', 'CI fixture']);
  git(directory, ['config', 'user.email', 'ci-fixture@example.invalid']);
  const candidatePath = 'data/relation-candidates/152/152_02_a_codex.jsonl';
  const warRoomPath = 'tools/warroom/tests/test_issue_1555.py';

  await writeRepoFile(directory, candidatePath, '{"records":[]}\n');
  const commonSha = await commit(directory, 'common ancestor');

  git(directory, ['switch', '-q', '-c', 'candidate-pr']);
  await writeRepoFile(directory, candidatePath, '{"records":["candidate"]}\n');
  const pullRequestHeadSha = await commit(directory, 'candidate change');

  git(directory, ['switch', '-q', 'master']);
  // The target branch independently reaches the same Candidate tree after
  // the PR event. The PR diff still contains the Candidate change from its
  // merge-base, while the integration result no longer shows that path as a
  // change relative to the event base.
  await writeRepoFile(directory, candidatePath, '{"records":["candidate"]}\n');
  const pullRequestBaseSha = await commit(directory, 'event base catches up');

  await writeRepoFile(directory, warRoomPath, 'def test_unrelated_issue_1555():\n    pass\n');
  const integrationBaseSha = await commit(directory, 'unrelated War Room update');

  git(directory, ['merge', '--no-ff', '-q', 'candidate-pr', '-m', 'synthetic integration candidate']);
  const integrationHeadSha = git(directory, ['rev-parse', 'HEAD']);

  return {
    directory,
    candidatePath,
    warRoomPath,
    commonSha,
    pullRequestBaseSha,
    pullRequestHeadSha,
    integrationBaseSha,
    integrationHeadSha,
  };
}

test('PR path selection excludes unrelated changes present only in the synthetic merge base update', async () => {
  const fixture = await makePrWithAdvancedBase();
  try {
    const integrationRange = classifyChangedPathDiff(
      fixture.pullRequestBaseSha,
      fixture.integrationHeadSha,
      { cwd: fixture.directory },
    );
    assert.deepEqual(integrationRange.changedPaths, [fixture.warRoomPath]);
    assert.equal(integrationRange.runLevel, 'warroom');
    assert.equal(integrationRange.runWarRoomTests, true);

    const exactRange = resolveChangeRange({
      eventName: 'pull_request',
      integrationBaseSha: fixture.pullRequestBaseSha,
      integrationHeadSha: fixture.integrationHeadSha,
      pullRequestBaseSha: fixture.pullRequestBaseSha,
      pullRequestHeadSha: fixture.pullRequestHeadSha,
    }, {
      runGit: (args) => git(fixture.directory, args),
    });
    assert.equal(exactRange.changeBaseSha, fixture.commonSha);
    assert.equal(exactRange.changeHeadSha, fixture.pullRequestHeadSha);

    const prRange = classifyChangedPathDiff(
      exactRange.changeBaseSha,
      exactRange.changeHeadSha,
      { cwd: fixture.directory },
    );
    assert.deepEqual(prRange.changedPaths, [fixture.candidatePath]);
    assert.equal(prRange.runLevel, 'normal');
    assert.equal(prRange.runWarRoomTests, false);

    const deep = routePrDeepGate(classifyDeepGateDiff(
      exactRange.changeBaseSha,
      exactRange.changeHeadSha,
      { cwd: fixture.directory },
    ));
    assert.equal(deep.deepMode, 'none');
    assert.deepEqual(deep.selectedDeepChecks, []);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('merge-group path selection keeps the integration-candidate comparison', async () => {
  const fixture = await makePrWithAdvancedBase();
  try {
    const range = resolveChangeRange({
      eventName: 'merge_group',
      integrationBaseSha: fixture.pullRequestBaseSha,
      integrationHeadSha: fixture.integrationHeadSha,
    }, {
      runGit: (args) => git(fixture.directory, args),
    });
    assert.equal(range.changeBaseSha, fixture.pullRequestBaseSha);
    assert.equal(range.changeHeadSha, fixture.integrationHeadSha);

    const result = classifyChangedPathDiff(range.changeBaseSha, range.changeHeadSha, {
      cwd: fixture.directory,
    });
    assert.deepEqual(result.changedPaths, [fixture.warRoomPath]);
    assert.equal(result.runWarRoomTests, true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('ci:pr classifies the source head while requiring the synthetic integration checkout', async () => {
  const fixture = await makePrWithAdvancedBase();
  try {
    const range = resolveChangeRange({
      eventName: 'pull_request',
      integrationBaseSha: fixture.pullRequestBaseSha,
      integrationHeadSha: fixture.integrationHeadSha,
      pullRequestBaseSha: fixture.pullRequestBaseSha,
      pullRequestHeadSha: fixture.pullRequestHeadSha,
    }, {
      runGit: (args) => git(fixture.directory, args),
    });

    await assert.rejects(runCli([
      'pr',
      '--base', range.changeBaseSha,
      '--head', range.changeHeadSha,
      '--validation-head', fixture.integrationHeadSha,
    ], {
      getCurrentHead: () => fixture.integrationHeadSha,
      classify: (baseSha, headSha) => {
        assert.equal(baseSha, range.changeBaseSha);
        assert.equal(headSha, fixture.pullRequestHeadSha);
        return {
          ...classifyDeepGatePaths(['scripts/ci/changed-files.mjs']),
          changedPaths: ['scripts/ci/changed-files.mjs'],
        };
      },
      executeLevel: async (level, options) => {
        assert.equal(level, 'pr');
        assert.equal(options.changedPaths.includes('scripts/ci/changed-files.mjs'), true);
        assert.equal(process.env.BASE_SHA, range.changeBaseSha);
        assert.equal(process.env.HEAD_SHA, fixture.pullRequestHeadSha);
        throw new Error('source-path classifier and validation checkout separated');
      },
    }), /source-path classifier and validation checkout separated/u);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('actual War Room and Stage 2 paths retain their existing validation selection', () => {
  const warRoom = classifyChangedFiles([
    { status: 'M', path: 'tools/warroom/warroom/stage2.py' },
  ]);
  assert.equal(warRoom.runLevel, 'warroom');
  assert.equal(warRoom.runWarRoomTests, true);

  const stage2 = classifyDeepGatePaths(['scripts/relation/admission.mjs']);
  assert.equal(stage2.deepMode, 'selective');
  assert.ok(stage2.selectedDeepChecks.length > 0);
});

test('CI classifier and workflow changes select this regression test in PR Deep validation', () => {
  for (const changedPath of ['scripts/ci/changed-files.mjs', '.github/workflows/ci.yml']) {
    const classification = routePrDeepGate(classifyDeepGatePaths([changedPath]));
    assert.equal(classification.deepMode, 'selective', changedPath);
    assert.ok(classification.selectedDeepChecks.some((id) => (
      id.includes('Test exact PR changed-path selection and integration validation range')
    )), changedPath);
  }
});
