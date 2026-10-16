import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Issue-specific editorial regression checkpoint; run directly with node --test.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'data/meanings');
const rows = readdirSync(dir).filter((file) => /^c06_\d+\.jsonl$/u.test(file)).sort()
  .flatMap((file) => readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
const meaningOf = new Map(rows.flatMap((row) => row.sense_ids.map((senseId) => [senseId, row.id])));
const meaningById = new Map(rows.map((row) => [row.id, row]));
const canonicalGlossBySense = new Map(readdirSync(path.join(root, 'data/canonical'))
  .filter((file) => /^stdict-(0076|0077|0328|0329|0333)\.jsonl$/u.test(file))
  .flatMap((file) => readFileSync(path.join(root, 'data/canonical', file), 'utf8').split('\n').filter(Boolean)
    .flatMap((line) => JSON.parse(line).senses.map((sense) => [sense.id, sense.gloss]))));
const spec = JSON.parse(readFileSync(path.join(root, 'scripts/meaning/issue-764-c06.json'), 'utf8'));
const sameMeaning = (senseIds) => senseIds.every((senseId) => meaningOf.has(senseId)
  && new Set(senseIds.map((senseId) => meaningOf.get(senseId))).size === 1);
const known = (senseIds) => senseIds.every((senseId) => meaningOf.has(senseId));

// This also makes the executable spec a regression oracle: the former bad groups
// cannot pass by merely preserving total sense coverage.
test('C06 repartition spec groups exactly match final Meaning rows', () => {
  for (const edit of spec.repartitions) {
    const covered = edit.groups.flatMap((group) => group.senses).sort();
    assert.deepEqual(covered, edit.before.flatMap((row) => row.sense_ids).sort(), `${edit.lemma}: every before sense appears once`);
    for (const group of edit.groups) {
      const id = meaningOf.get(group.senses[0]);
      assert.ok(id, `${edit.lemma}: ${group.senses[0]} has no Meaning`);
      assert.deepEqual([...meaningById.get(id).sense_ids].sort(), [...group.senses].sort(), `${edit.lemma}: final membership matches spec`);
      assert.equal(meaningById.get(id).gloss, group.gloss, `${edit.lemma}: final gloss matches spec`);
    }
  }
});

// Positive controls: the same concrete name/function extends across targets.
const mustMerge = [
  ['룩셈부르크 국가/수도', ['w103570-s1', 'w103570-s2']],
  ['러거 경기/선수', ['w424485-s1', 'w424485-s2']],
  ['람다 글자/기호를 쓰는 부피 단위', ['w99297-s1', 'w99297-s2']],
  ['리시버 수신 장치/서브를 받는 선수', ['w418668-s1', 'w418668-s2']],
  ['로마의 역사적 도시/동명 행정 구역', ['w417861-s1', 'w417861-s2', 'w417861-s3', 'w417861-s4']],
];
for (const [name, senseIds] of mustMerge) {
  test(`C06 under-merge control: ${name} is one Meaning`, () => assert.ok(sameMeaning(senseIds), name));
}

test('C06 positive controls preserve every original canonical gloss verbatim', () => {
  for (const [name, senseIds] of mustMerge) {
    const canonicalGlosses = senseIds.map((senseId) => canonicalGlossBySense.get(senseId));
    assert.ok(canonicalGlosses.every(Boolean), `${name}: canonical glosses must be present`);
    assert.equal(meaningById.get(meaningOf.get(senseIds[0])).gloss, canonicalGlosses.join(' '), name);
  }
});

// Negative controls: distinct named works remain separate even when they share
// a title, character, or source narrative.
const mustSplit = [
  ['로미오와 줄리엣 희곡/베를리오즈 교향곡', 'w102822-s1', 'w422538-s1'],
  ['로미오와 줄리엣 희곡/차이콥스키 서곡', 'w102822-s1', 'w422538-s2'],
  ['로미오와 줄리엣 희곡/프로코피예프 발레곡', 'w102822-s1', 'w422538-s3'],
  ['로미오와 줄리엣 베를리오즈 교향곡/차이콥스키 서곡', 'w422538-s1', 'w422538-s2'],
  ['로미오와 줄리엣 베를리오즈 교향곡/프로코피예프 발레곡', 'w422538-s1', 'w422538-s3'],
  ['로미오와 줄리엣 차이콥스키 서곡/프로코피예프 발레곡', 'w422538-s2', 'w422538-s3'],
  ['로엔그린 서사시/바그너 오페라', 'w421601-s1', 'w421601-s2'],
  ['룩셈부르크 국가/혁명가', 'w103570-s1', 'w419193-s1'],
  ['룩셈부르크 수도/혁명가', 'w103570-s2', 'w419193-s1'],
  ['로드레이서 경기자/경기용 자전거나 오토바이', 'w105637-s1', 'w105637-s2'],
  ['로마 조약의 서로 다른 국제 협정', 'w417471-s1', 'w417471-s2'],
];
for (const [name, left, right] of mustSplit) {
  test(`C06 over-merge control: ${name} stays separate`, () => {
    assert.ok(known([left, right]), `${name}: source senses must exist`);
    assert.notEqual(meaningOf.get(left), meaningOf.get(right), name);
  });
}

test('C06 boundary controls fail closed for unknown source sense ids', () => {
  assert.equal(sameMeaning(['w000000-s1', 'w000000-s2']), false);
  assert.equal(known(['w000000-s1']), false);
  for (const [, senseIds] of mustMerge) assert.ok(known(senseIds), `${senseIds.join(', ')} must exist`);
});
