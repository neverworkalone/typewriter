import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateCandidateBatch, validateCandidatePaths } from './candidate-contract.mjs';
import { validateChangedCandidateFiles } from './validate-candidate-changes.mjs';

function fixture(candidate = '다른 표현', batch = '01') {
  const offset = (Number(batch) - 1) * 500;
  const canonicalRows = Array.from({ length: offset + 500 }, (_, index) => ({
    id: `w${index + 1}`,
    lemma: index === offset ? '가짜 미끼' : `표제어 ${index + 1}`,
    senses: [{ id: `w${index + 1}-s1` }],
  }));
  const candidateRows = canonicalRows.slice(offset, offset + 500).map((record, index) => ({
    record_id: record.id,
    senses: [{
      sense_id: record.senses[0].id,
      candidates: index === 0 ? [candidate] : [],
    }],
  }));
  return { canonicalRows, candidateRows };
}

test('Candidate v1 rejects a candidate identical to its source lemma and accepts distinct candidates', () => {
  const invalid = fixture('가짜 미끼');
  assert.throws(
    () => validateCandidateBatch(invalid.canonicalRows, invalid.candidateRows, { batch: '01' }),
    /candidate repeats source lemma "가짜 미끼"/,
  );

  const valid = fixture('가짜 미끼를 물다');
  assert.deepEqual(
    validateCandidateBatch(valid.canonicalRows, valid.candidateRows, { batch: '01' }),
    { recordCount: 500, senseCount: 500, candidateCount: 1, emptySenseCount: 499 },
  );
});

test('Candidate v1 rejects the source lemma with a trailing parenthetical and accepts distinct expressions', () => {
  const run = (candidates, sourceLemma = '공탁') => () => {
    const canonicalRows = [{ id: 'w1', lemma: sourceLemma, senses: [{ id: 'w1-s1' }] }];
    const candidateRows = [{ record_id: 'w1', senses: [{ sense_id: 'w1-s1', candidates }] }];
    return validateCandidateBatch(canonicalRows, candidateRows, { batch: '01' });
  };
  const projection = /repeats source lemma "공탁" with a parenthetical annotation/u;
  for (const invalid of [['공탁(供托)'], ['공탁 (供託)']]) {
    assert.throws(run(invalid), projection, JSON.stringify(invalid));
  }
  assert.throws(
    run(['공안 위원회(1960)'], '공안 위원회'),
    /repeats source lemma "공안 위원회" with a parenthetical annotation/u,
  );
  for (const valid of [['공탁금'], ['공탁(供托) 금액'], ['보관 위탁'], ['과급기']]) {
    assert.doesNotThrow(run(valid), JSON.stringify(valid));
  }
});

test('Candidate v1 requires the shard directory to match the filename', () => {
  const repositoryDirectory = '/repo';
  const canonicalPath = '/repo/data/canonical/stdict-0005.jsonl';
  const validCandidatePath = '/repo/data/relation-candidates/005/005_02_b_codex.jsonl';
  assert.deepEqual(
    validateCandidatePaths(canonicalPath, validCandidatePath, { repositoryDirectory }),
    { shard: '005', batch: '02' },
  );
  assert.throws(
    () => validateCandidatePaths(
      canonicalPath,
      '/repo/data/relation-candidates/006/005_02_b_codex.jsonl',
      { repositoryDirectory },
    ),
    /must be stored at data\/relation-candidates\/005\/005_02_b_codex\.jsonl/u,
  );
  assert.throws(
    () => validateCandidatePaths(
      '/repo/data/canonical/stdict-0006.jsonl',
      validCandidatePath,
      { repositoryDirectory },
    ),
    /must be checked against data\/canonical\/stdict-0005\.jsonl/u,
  );
});

test('the changed-file validator rejects the source lemma and accepts a corrected on-disk batch', async (t) => {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-candidate-change-'));
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }));

  const canonicalRelativePath = 'data/canonical/stdict-0005.jsonl';
  const candidateRelativePath = 'data/relation-candidates/005/005_02_b_codex.jsonl';
  const canonicalPath = path.join(repositoryDirectory, canonicalRelativePath);
  const candidatePath = path.join(repositoryDirectory, candidateRelativePath);
  await mkdir(path.dirname(canonicalPath), { recursive: true });
  await mkdir(path.dirname(candidatePath), { recursive: true });

  const invalid = fixture('가짜 미끼', '02');
  const writeBatch = async (rows) => writeFile(candidatePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await writeFile(canonicalPath, `${invalid.canonicalRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await writeBatch(invalid.candidateRows);

  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const runGit = (args) => {
    assert.deepEqual(args, [
      'diff', '--no-renames', '--diff-filter=ACMRT', '--name-only', '-z',
      `${baseSha}...${headSha}`, '--', 'data/relation-candidates/',
    ]);
    return Buffer.from(`${candidateRelativePath}\0`);
  };

  await assert.rejects(
    validateChangedCandidateFiles(baseSha, headSha, { repositoryDirectory, runGit }),
    /candidate repeats source lemma "가짜 미끼"/u,
  );

  const corrected = fixture('가짜 미끼를 물다', '02');
  await writeBatch(corrected.candidateRows);
  assert.deepEqual(
    await validateChangedCandidateFiles(baseSha, headSha, { repositoryDirectory, runGit }),
    [{ path: candidateRelativePath, recordCount: 500, senseCount: 500, candidateCount: 1, emptySenseCount: 499 }],
  );
});

test('Candidate v1 compares candidates with the Stage 2 normal form (NFC, collapsed whitespace)', () => {
  const lemma = '가'.normalize('NFC');
  const decomposed = lemma.normalize('NFD');
  assert.notEqual(decomposed, lemma);
  const invalid = [
    [decomposed, /repeats source lemma/],
    ['다 라'.replace(' ', '  '), null],
  ];
  const run = (candidates, sourceLemma = lemma) => {
    const canonicalRows = [{ id: 'w1', lemma: sourceLemma, senses: [{ id: 'w1-s1' }] }];
    const rows = [{ record_id: 'w1', senses: [{ sense_id: 'w1-s1', candidates }] }];
    return () => validateCandidateBatch(canonicalRows, rows, { batch: '01' });
  };
  assert.throws(run([invalid[0][0]]), invalid[0][1]);
  assert.throws(run(['다 라', '다  라'], '표제'), /duplicate candidate/);
  assert.throws(run(['가 나'.replace(' ', '  ')], '가 나'), /repeats source lemma/);
  assert.doesNotThrow(run(['다 라'], '표제'));
});

test('Candidate v1 rejects pieces of a thousands-comma number and keeps the whole number', () => {
  const gloss = '높이는 7,460미터. 1,155미터와 1,155미터.';
  const run = (candidates, sourceGloss = gloss) => () => {
    const canonicalRows = [{ id: 'w1', lemma: '산', senses: [{ id: 'w1-s1', gloss: sourceGloss }] }];
    const candidateRows = [{ record_id: 'w1', senses: [{ sense_id: 'w1-s1', candidates }] }];
    return validateCandidateBatch(canonicalRows, candidateRows, { batch: '01', sourceName: 'Canonical' });
  };
  const fragment = /is a fragment of a number written with a thousands comma/;
  for (const invalid of [['7'], ['460미터'], ['460'], ['히말라야', '7', '460미터'], ['1'], ['155미터']]) {
    assert.throws(run(invalid), fragment, JSON.stringify(invalid));
  }
  for (const valid of [['7,460미터'], ['460미터를 넘는'], ['2,000kg 이하'], ['높이'], []]) {
    assert.doesNotThrow(run(valid), JSON.stringify(valid));
  }
  // a number that also appears intact in the gloss is not a fragment; glosses without a thousands comma never match
  assert.doesNotThrow(run(['7'], '7개 중 7,460미터'));
  assert.doesNotThrow(run(['460미터'], '460미터와 12,000'));
  assert.doesNotThrow(run(['7', '460미터'], '높이는 7 460미터'));
});

test('Candidate v1 thousands-comma check ignores digits inside other numbers and non-thousands comma lists', () => {
  const run = (candidates, gloss) => () => {
    const canonicalRows = [{ id: 'w1', lemma: '가짓과', senses: [{ id: 'w1-s1', gloss }] }];
    const candidateRows = [{ record_id: 'w1', senses: [{ sense_id: 'w1-s1', candidates }] }];
    return validateCandidateBatch(canonicalRows, candidateRows, { batch: '01' });
  };
  const fragment = /is a fragment of a number written with a thousands comma/;
  // real pattern (w4461): the "1" inside "15속" must not count as an intact occurrence of "1"
  const solanaceae = '82속 1,700여 종 가운데 15속 30여 종이 있다.';
  for (const invalid of [['1'], ['700여 종'], ['82속', '1']]) assert.throws(run(invalid, solanaceae), fragment, JSON.stringify(invalid));
  for (const valid of [['1,700여 종'], ['15속'], ['30여 종'], ['82속', '1,700여 종']]) assert.doesNotThrow(run(valid, solanaceae), JSON.stringify(valid));
  // repeated digits inside one thousands group cannot make a fragment look intact
  for (const invalid of [['1'], ['111미터'], ['11']]) assert.throws(run(invalid, '높이는 1,111미터.'), fragment, JSON.stringify(invalid));
  assert.doesNotThrow(run(['1,111미터'], '높이는 1,111미터.'));
  // a genuinely separate "1" elsewhere in the gloss keeps the candidate valid
  assert.doesNotThrow(run(['1'], '높이는 1,155미터이며 1개가 있다.'));
  // digit lists that are not thousands groups (locants, plain pairs) are never fragments
  for (const gloss of ['1,2,3-트리클로로벤젠', '2,3 번 위치', '12,34']) {
    for (const candidate of ['1', '2', '3', '34']) assert.doesNotThrow(run([candidate], gloss), `${gloss} ${candidate}`);
  }
});
