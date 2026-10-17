import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'data/meanings');
const rows = readdirSync(dir).filter((f) => /^c12_\d+\.jsonl$/.test(f)).sort()
  .flatMap((f) => readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const meaningOf = new Map(rows.flatMap((row) => row.sense_ids.map((id) => [id, row.id])));
const spec = JSON.parse(readFileSync(path.join(root, 'scripts/meaning/issue-764-c12.json'), 'utf8'));
const audit = readFileSync(path.join(root, 'scripts/meaning/issue-764-c12-audit.md'), 'utf8');
const same = (a, b) => meaningOf.has(a) && meaningOf.has(b) && meaningOf.get(a) === meaningOf.get(b);
const known = (...ids) => ids.every((id) => meaningOf.has(id));

// 서로 다른 구성어·한자·방향이어서 한 Meaning이 될 수 없는 쌍(사례: 우찰 愚札/愚察, 억매 抑買/抑賣).
const separate = [
  ['우찰', 'w249236-s1', 'w249237-s1'],
  ['양봉', 'w230521-s1', 'w230779-s1'],
  ['약언', 'w226610-s1', 'w226610-s2'],
  ['억매', 'w223619-s1', 'w460317-s1'],
  ['예매', 'w236185-s1', 'w236201-s1'],
  ['원매자', 'w252735-s1', 'w252736-s1'],
  ['영리', 'w234243-s1', 'w463173-s1'],
  ['외적', 'w247462-s1', 'w460765-s1'],
  ['용인', 'w242925-s1', 'w242927-s1'],
  ['연소', 'w237114-s1', 'w458107-s1'],
  ['어구', 'w223834-s1', 'w456385-s1'],
  ['이해상반', 'w265853-s1', 'w265854-s1'],
  ['이해상반하다', 'w265855-s1', 'w517159-s1'],
];
// 같은 어휘의 변주·준말이어서 병합 상태여야 하는 대조군.
const merged = [
  ['앵순', 'w219228-s2', 'w223417-s1'],
  ['약언', 'w226610-s2', 'w226612-s1'],
];

test('independent lexical items stay separate Meanings', () => {
  for (const [lemma, a, b] of separate) {
    assert.ok(known(a, b), `${lemma}: sense ids must exist`);
    assert.ok(!same(a, b), `${lemma}: ${a} and ${b} must not share a Meaning`);
  }
});

test('control pairs of one lexical item remain merged', () => {
  for (const [lemma, a, b] of merged) {
    assert.ok(same(a, b), `${lemma}: ${a} and ${b} must share a Meaning`);
  }
});

test('cross-record merge ledger in the audit equals the cross-record groups in the spec', () => {
  const lemmas = new Set();
  for (const rep of spec.repartitions) {
    for (const group of rep.groups) {
      if (new Set(group.senses.map((id) => id.split('-')[0])).size > 1) lemmas.add(rep.lemma);
    }
  }
  const section = audit.split('## record 간 병합 판정 기록')[1].split('## 한계와 미검토 범위')[0];
  const listed = new Set([...section.matchAll(/^- \*\*(.+?)\*\* — /gm)].map((m) => m[1]));
  assert.deepEqual([...listed].sort(), [...lemmas].sort());
});
