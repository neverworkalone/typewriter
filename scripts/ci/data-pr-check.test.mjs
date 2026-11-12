import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkDataPr } from './data-pr-check.mjs';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

const CANONICAL = [
  { id: 'w100', lemma: '바람', senses: [{ id: 'w100-s1', gloss: '공기의 움직임.' }] },
  { id: 'w200', lemma: '물결', senses: [{ id: 'w200-s1', gloss: '물의 움직임.' }, { id: 'w200-s2', gloss: '흐름.' }] },
];
const CANDIDATE = [
  { record_id: 'w100', senses: [{ sense_id: 'w100-s1', candidates: ['산들'] }] },
  { record_id: 'w200', senses: [{ sense_id: 'w200-s1', candidates: [] }, { sense_id: 'w200-s2', candidates: ['파도'] }] },
];
const RELATION = { id: 'w100', sid: 'w100-s1', tid: 'w900', tsid: 'w900-s1', tp: 'mood', rv: 5, ver: 1, fm: ['파도'], rfm: [] };
const DROP = { id: 'w200', sid: 'w200-s2', cd: '흐름새', by: 'e' };

async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'typewriter-data-pr-'));
  git(cwd, ['init', '-q', '--initial-branch=master']);
  git(cwd, ['config', 'user.name', 'CI fixture']);
  git(cwd, ['config', 'user.email', 'ci-fixture@example.invalid']);
  await mkdir(path.join(cwd, 'schema'), { recursive: true });
  await copyFile(path.join(REPOSITORY_DIRECTORY, 'schema/canonical-record.schema.json'), path.join(cwd, 'schema/canonical-record.schema.json'));
  await write(cwd, 'data/canonical/stdict-0007.jsonl', jsonl(CANONICAL));
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-qm', 'base']);
  return { cwd, base: git(cwd, ['rev-parse', 'HEAD']) };
}

async function write(cwd, filePath, contents) {
  await mkdir(path.dirname(path.join(cwd, filePath)), { recursive: true });
  await writeFile(path.join(cwd, filePath), contents, 'utf8');
}

async function check({ cwd, base }, files) {
  git(cwd, ['switch', '-q', '--detach', base]);
  for (const [filePath, contents] of Object.entries(files)) await write(cwd, filePath, contents);
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-qm', 'change']);
  const head = git(cwd, ['rev-parse', 'HEAD']);
  return () => checkDataPr(base, head, head, { cwd });
}

test('pure data PR check accepts valid files and rejects storage-contract or scope violations', async () => {
  const repo = await fixture();
  try {
    const candidatePath = 'data/relation-candidates/007/007_01_c_claude.jsonl';
    assert.equal((await check(repo, { [candidatePath]: jsonl(CANDIDATE) }))().results[0].candidateCount, 2);
    const reordered = [CANDIDATE[0], { ...CANDIDATE[1], senses: [...CANDIDATE[1].senses].reverse() }];
    assert.throws(await check(repo, { [candidatePath]: jsonl(reordered) }), /sense_id does not match/u);
    assert.throws(await check(repo, { 'data/relation-candidates/007/007_1_c.jsonl': jsonl(CANDIDATE) }), /filename contract/u);

    const relationPath = 'data/relations/relation-007.jsonl';
    const dropPath = 'data/relation-drops/drop-007.jsonl';
    const valid = await check(repo, { [relationPath]: jsonl([RELATION]), [dropPath]: jsonl([DROP]) });
    assert.deepEqual(valid().results.map((item) => item.rows), [1, 1]);

    const invalid = [
      [{ [relationPath]: jsonl([{ ...RELATION, rv: 10 }]) }, /relevance must be an integer 1\.\.9/u],
      [{ [dropPath]: jsonl([{ ...DROP, by: 'q' }]) }, /reason must be one of x\/e\/z\/f/u],
      [{ [relationPath]: jsonl([{ ...RELATION, id: 'w300', sid: 'w300-s1' }]) }, /not in Canonical shard 007/u],
      [{ [relationPath]: jsonl([{ ...RELATION, tid: 'w9', tsid: 'w9-s1' }]) }, /is not a Canonical ID/u],
      [{ [relationPath]: jsonl([{ id: 'w100', sid: 'w100-s1', tt: '바람', tp: 'mood', rv: 3 }]) }, /repeats the source lemma/u],
      [{ [relationPath]: jsonl([
        { ...RELATION, tid: 'w200', tsid: 'w200-s1' },
        { ...RELATION, id: 'w200', sid: 'w200-s1', tid: 'w100', tsid: 'w100-s1' },
      ]) }, /reverse-duplicate/u],
    ];
    for (const [files, pattern] of invalid) assert.throws(await check(repo, files), pattern);
  } finally {
    await rm(repo.cwd, { recursive: true, force: true });
  }
});
