import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Keeps the numbers in issue-764-c15-audit.md reproducible from the checked-in shards and specs.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const num = (text) => Number(text.replaceAll(',', ''));
const audit = readFileSync(path.join(root, 'scripts/meaning/issue-764-c15-audit.md'), 'utf8');
const cell = (label) => {
  const line = audit.split('\n').find((row) => row.startsWith(`| ${label}`));
  assert.ok(line, `audit row missing: ${label}`);
  return line.split('|').map((part) => part.trim());
};

test('audit table matches the checked-in C15 and repository meaning shards', () => {
  const dir = path.join(root, 'data/meanings');
  let c15 = 0;
  let all = 0;
  const perLemma = new Map();
  for (const file of readdirSync(dir).filter((name) => /^c\d+_\d+\.jsonl$/u.test(name))) {
    for (const line of readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line) continue;
      all += 1;
      if (!file.startsWith('c15_')) continue;
      c15 += 1;
      const { lemma } = JSON.parse(line);
      perLemma.set(lemma, (perLemma.get(lemma) ?? 0) + 1);
    }
  }
  const multi = [...perLemma.values()].filter((count) => count > 1).length;
  assert.equal(num(cell('C15 Meaning rows')[3]), c15);
  assert.equal(num(cell('다중 Meaning lemma')[3]), multi);
  assert.equal(num(cell('C15 lemmas')[3]), perLemma.size);
  assert.equal(num(cell('전체 meanings (repo)')[3]), all);
});

test('audit reduction counts match the two repartition specs', () => {
  const spec = (name) => JSON.parse(readFileSync(path.join(root, 'scripts/meaning', name), 'utf8')).repartitions;
  const reduced = (rows) => rows.reduce((sum, row) => sum + row.before.length - row.groups.length, 0);
  const first = spec('issue-764-c15.json');
  const second = spec('issue-764-c15-stage2.json');
  const line = cell('병합으로 줄어든 Meaning 행')[3];
  const [, total, firstReduced, secondReduced] = /^([\d,]+) \(1차 ([\d,]+) \+ Stage 2 반영 ([\d,]+)\)$/u.exec(line);
  assert.equal(num(firstReduced), reduced(first));
  assert.equal(num(secondReduced), reduced(second));
  assert.equal(num(total), reduced(first) + reduced(second));
  assert.equal(cell('C15 Meaning rows')[2], '24,466');
  assert.equal(24466 - reduced(first) - reduced(second), num(cell('C15 Meaning rows')[3]));
});
