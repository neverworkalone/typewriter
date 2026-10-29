import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { removeCandidates } from './candidate-amend.mjs';

async function fixture({ candidates = ['첫 후보', '둘 후보'] } = {}) {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'candidate-amend-repo-'));
  const worktree = await mkdtemp(path.join(tmpdir(), 'candidate-amend-worktree-'));
  const canonicalPath = path.join(repositoryDirectory, 'data/canonical/stdict-0001.jsonl');
  const candidatePath = path.join(repositoryDirectory, 'data/relation-candidates/001/001_01_a_codex.jsonl');
  const inputPath = path.join(worktree, '.warroom-scratch/fix-remove.tsv');
  const canonicalRows = [{ id: 'w1', lemma: '표제어', senses: [{ id: 'w1-s1', pos: 'noun', gloss: '뜻' }] }];
  const candidateRows = [{ record_id: 'w1', senses: [{ sense_id: 'w1-s1', candidates }] }];
  await mkdir(path.dirname(canonicalPath), { recursive: true });
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await mkdir(path.dirname(inputPath), { recursive: true });
  await writeFile(canonicalPath, `${JSON.stringify(canonicalRows[0])}\n`);
  await writeFile(candidatePath, `${JSON.stringify(candidateRows[0])}\n`);
  return { repositoryDirectory, worktree, canonicalPath, candidatePath, inputPath, canonicalRows, candidateRows };
}

async function cleanup(f) {
  await Promise.all([rm(f.repositoryDirectory, { recursive: true, force: true }),
    rm(f.worktree, { recursive: true, force: true })]);
}

test('remove applies exact tuples and validates the official candidate path before atomic replacement', async (t) => {
  const f = await fixture();
  t.after(() => cleanup(f));
  await writeFile(f.inputPath, 'w1\tw1-s1\t첫 후보\n');

  const result = await removeCandidates(f);

  assert.deepEqual(result, { removed: 1, recordCount: 1, senseCount: 1, candidateCount: 1, beforeCandidateCount: 2 });
  const rows = (await readFile(f.candidatePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows[0].senses[0].candidates, ['둘 후보']);
});

test('empty, malformed, duplicate, missing tuple, and invalid remaining candidate fail without changing bytes', async (t) => {
  const f = await fixture({ candidates: ['표제어', '정상 후보'] });
  t.after(() => cleanup(f));
  const original = await readFile(f.candidatePath);
  const invalidInputs = [
    '',
    'w1\tw1-s1\n',
    'w1\tw1-s1\t정상 후보\nw1\tw1-s1\t정상 후보\n',
    'w1\tw9-s1\t정상 후보\n',
    'w1\tw1-s1\t없는 후보\n',
    'w1\tw1-s1\t정상 후보\n', // leaves the source-lemma candidate, which fails Candidate v1
  ];
  for (const input of invalidInputs) {
    await writeFile(f.inputPath, input);
    await assert.rejects(removeCandidates(f));
    assert.deepEqual(await readFile(f.candidatePath), original);
  }
});

test('candidate and canonical path checks and scratch-only input restriction fail before writes', async (t) => {
  const f = await fixture();
  t.after(() => cleanup(f));
  await writeFile(f.inputPath, 'w1\tw1-s1\t첫 후보\n');
  const original = await readFile(f.candidatePath);
  await assert.rejects(removeCandidates({ ...f, candidatePath: f.candidatePath.replace('/001/', '/002/') }), /must be stored/u);
  await assert.rejects(removeCandidates({ ...f, canonicalPath: f.candidatePath }), /must be checked/u);
  await assert.rejects(removeCandidates({ ...f, inputPath: f.candidatePath }), /scratch/u);
  assert.deepEqual(await readFile(f.candidatePath), original);
});
