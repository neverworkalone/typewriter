import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  auditMeaningGlossHomonymNumbers,
  findMeaningGlossHomonymNumbers,
  readCompletedGlossNumberScopes,
} from '../scripts/validate/meaning-gloss-numbers.mjs';

const tokensOf = (gloss) => findMeaningGlossHomonymNumbers(gloss).map((found) => found.token);

test('flags source dictionary homonym numbers in user-facing glosses', () => {
  // Issue #797 calibration: `쓸쓸`/`슬슬02` and `이01` are the documented positive cases.
  assert.deepEqual(tokensOf('배가 조금 쓰리면서 아픈 모양. ‘슬슬02’보다 센 느낌을 준다.'), ['슬슬02']);
  assert.deepEqual(tokensOf('‘이01’을 이르는 말.'), ['이01']);
  assert.deepEqual(tokensOf('→ 마하01.'), ['마하01']);
  assert.deepEqual(tokensOf('‘까닥01「1」’보다 센 느낌을 준다.'), ['까닥01']);
  assert.deepEqual(tokensOf('‘갈이02[Ⅰ].'), ['갈이02']);
  assert.deepEqual(tokensOf('‘깨다02’를 강조하여 이르는 말.'), ['깨다02']);
  assert.deepEqual(
    findMeaningGlossHomonymNumbers('‘꼬박02’의 센말.').map((found) => found.headword),
    ['꼬박'],
  );
});

test('leaves real numbers, units, dates and ordinal ranks untouched', () => {
  const preserved = [
    '가짓과의 한해살이풀. 높이는 60~90cm이며, 잎은 둥글고 끝이 뾰족하다.',
    '삭과(蒴果)로 9월에 익는다.',
    '몸의 길이는 1.5cm 정도이며, 날개는 6.5~6.8cm이다.',
    '줄기는 높이가 50~100cm이고 잎은 마주 난다.',
    '미국의 제20대 대통령(1831~1881)',
    '고려의 제23대 왕(1192~1259)',
    '이에 대하여 형법 제40조는 가장 무거운 형을 정한다.',
    '1950년 제12차 헤이그 회의를 열었다.',
    '제16회 국제 연합 총회에서 채택되었다.',
    '상묘법연화경(實相妙法蓮華經) 제25품(品)인 관세음보살보문품',
    '숫자 3·1 운동과 6·25 전쟁',
  ];
  for (const gloss of preserved) assert.deepEqual(tokensOf(gloss), [], gloss);
});

test('the completed scope registry stays machine-readable', () => {
  const registry = readCompletedGlossNumberScopes();
  assert.equal(registry.version, 1);
  assert.ok(Array.isArray(registry.completed_scopes));
  assert.ok(registry.completed_scopes.length > 0);
});

test('the whole stored corpus is scanned and completed #797 scopes are clean', () => {
  const { completed_scopes: completedScopes } = readCompletedGlossNumberScopes();
  const audit = auditMeaningGlossHomonymNumbers({ completedScopes });
  const completed = new Set(completedScopes);
  // The audit is corpus-wide, not an example-only check: every stored 초성 scope is read.
  assert.ok(audit.scopeCount >= 19, `expected every 초성 scope, saw ${audit.scopeCount}`);
  assert.ok(audit.shardCount >= audit.scopeCount);
  assert.deepEqual(audit.unknownCompletedScopes, []);
  // A completed scope must expose no source homonym number, so a later edit cannot reintroduce one.
  assert.deepEqual(audit.violations, []);
  for (const occurrence of audit.occurrences) {
    assert.ok(!completed.has(occurrence.scope), `${occurrence.shard} still exposes ${occurrence.token}`);
  }
  // Pending scopes keep reporting their backlog instead of being silently skipped.
  for (const scope of audit.pendingScopes) {
    assert.ok((audit.byScope.get(scope) ?? 0) > 0, `${scope} must only be pending while it still has occurrences`);
  }
});

test('a reintroduced number in a completed scope fails the audit (old fails / new passes)', async (t) => {
  const meaningsDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-gloss-numbers-'));
  t.after(() => rm(meaningsDirectory, { recursive: true, force: true }));
  const shardPath = path.join(meaningsDirectory, 'c09_001.jsonl');
  const writeShard = (gloss) => writeFile(
    shardPath,
    `${JSON.stringify({ id: 'm900001', lemma: '가짜', gloss, sense_ids: ['w900001-s1'] })}\n`,
  );

  await writeShard('‘이01’을 이르는 말.');
  const dirty = auditMeaningGlossHomonymNumbers({ meaningsDirectory, completedScopes: ['c09'] });
  assert.equal(dirty.violations.length, 1);
  assert.equal(dirty.violations[0].token, '이01');

  await writeShard('‘이’를 이르는 말.');
  const clean = auditMeaningGlossHomonymNumbers({ meaningsDirectory, completedScopes: ['c09'] });
  assert.deepEqual(clean.violations, []);

  // A completed scope that has no stored shard fails closed instead of silently disabling the gate.
  const unknown = auditMeaningGlossHomonymNumbers({ meaningsDirectory, completedScopes: ['c08'] });
  assert.deepEqual(unknown.unknownCompletedScopes, ['c08']);
});
