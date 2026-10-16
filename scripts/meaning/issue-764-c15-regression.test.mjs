import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Editorial regressions for Issue #764 C15 review findings. They pin source-bound decisions (not a string rule):
// a lemma's source senses must either share one Meaning (natural polysemy / figurative extension) or stay apart
// (independent homonyms, proper names, opposite or unrelated acts that only share a form).
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/meanings');
const meaningOf = new Map();
for (const file of readdirSync(dir).filter((name) => /^c15_\d+\.jsonl$/u.test(name))) {
  for (const line of readFileSync(path.join(dir, file), 'utf8').split('\n')) {
    if (!line) continue;
    const row = JSON.parse(line);
    for (const senseId of row.sense_ids) meaningOf.set(senseId, row.id);
  }
}
const same = (a, b) => { assert.ok(meaningOf.has(a) && meaningOf.has(b), `unknown sense ${a} / ${b}`); return meaningOf.get(a) === meaningOf.get(b); };

test('natural polysemy in one STDICT record stays one Meaning', () => {
  assert.ok(same('w486341-s1', 'w486341-s2'), '차양: eave awning and hat brim');
  assert.ok(same('w494076-s1', 'w494076-s2'), '총근: scallion root and figurative white fingers');
  assert.ok(same('w486333-s1', 'w486333-s2'), '차트');
  assert.ok(same('w320934-s1', 'w320934-s2'), '차문: asking');
  assert.ok(same('w484045-s1', 'w484045-s2'), '차호: next number / next issue');
  assert.ok(same('w491663-s1', 'w491663-s2'), '총림');
  assert.ok(same('w336164-s1', 'w336164-s2'), '축양');
  assert.ok(same('w342020-s1', 'w342020-s2'), '침염');
  assert.ok(same('w338650-s1', 'w338650-s2'), '침유');
  assert.ok(same('w328155-s2', 'w328159-s1'), '천기: the two star-name senses (天璣)');
});

test('independent words and proper names stay separate Meanings', () => {
  assert.ok(!same('w489081-s1', 'w489081-s2'), '침출: trespass vs solvent extraction');
  assert.ok(!same('w342208-s1', 'w342208-s2'), '침출되다');
  assert.ok(!same('w342209-s1', 'w342209-s2'), '침출하다');
  assert.ok(!same('w341467-s1', 'w341467-s2'), '칭명: false name vs calling a name');
  assert.ok(!same('w336048-s1', 'w336048-s2'), '치신: devote vs spare oneself');
  assert.ok(!same('w336049-s1', 'w336049-s2'), '치신하다');
  assert.ok(!same('w322800-s1', 'w322800-s2'), '찬류: life before heaven vs exile');
  assert.ok(!same('w334645-s1', 'w334645-s2'), '칠재: Buddhist rite vs Goryeo school divisions');
  assert.ok(!same('w327465-s1', 'w490799-s1'), '천지 창조: oratorio vs the concept');
  assert.ok(!same('w315324-s1', 'w486341-s1'), '차양: adoption system vs awning');
  assert.ok(!same('w328155-s1', 'w328155-s2'), '천기: 天紀 (celestial order) vs 天璣 (star name)');
  assert.ok(!same('w328155-s1', 'w328159-s1'), '천기: 天紀 vs the star 天璣');
  assert.ok(!same('w334660-s1', 'w334660-s2'), '축모: curled hair vs sheep wool (different naming principle)');
  assert.ok(!same('w331985-s1', 'w331985-s2'), '취타수: military band player vs cannon gunner');
  assert.ok(!same('w337342-s1', 'w337342-s2'), '칙찬: king writing himself vs compiling by royal order');
  assert.ok(!same('w337343-s1', 'w337343-s2'), '칙찬하다');
  assert.ok(!same('w335861-s1', 'w335861-s2'), '출번: going on duty vs coming off duty');
  assert.ok(!same('w490546-s1', 'w490546-s2'), '출물: contributed goods vs forced loss');
});
