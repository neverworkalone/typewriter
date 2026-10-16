import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Manual editorial regression checkpoint; intentionally not registered in CI.
// Run directly with: node scripts/meaning/issue-764-c03-editorial-checkpoint.manual.mjs
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'scripts/meaning/issue-764-c03.json'), 'utf8'));
const readShard = (name) => fs.readFileSync(path.join(root, 'data/meanings', name), 'utf8')
  .trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const c03Rows = fs.readdirSync(path.join(root, 'data/meanings'))
  .filter((name) => /^c03_\d+\.jsonl$/u.test(name))
  .flatMap(readShard);
const rowBySense = new Map(c03Rows.flatMap((row) => row.sense_ids.map((id) => [id, row])));
const editByLemma = new Map(spec.repartitions.map((item) => [item.lemma, item]));
const sourceBySense = new Map();
for (const name of fs.readdirSync(path.join(root, 'data/canonical')).filter((item) => item.endsWith('.jsonl'))) {
  const rows = fs.readFileSync(path.join(root, 'data/canonical', name), 'utf8').trimEnd().split('\n').filter(Boolean);
  for (const line of rows) {
    const entry = JSON.parse(line);
    for (const sense of entry.senses ?? []) sourceBySense.set(sense.id, {
      lemma: entry.lemma,
      gloss: sense.gloss,
      recordId: entry.id,
      pos: sense.pos,
    });
  }
}

const senseRange = (entryId, count) => Array.from({ length: count }, (_, index) => `${entryId}-s${index + 1}`);
const expectedMerges = [
  {
    lemma: '녹다', senses: senseRange('w408835', 11),
    signals: [/얼음/u, /열·습기/u, /추워 굳은 몸/u, /감정/u, /손해나 타격/u, /음식의 맛/u, /결정체/u, /스며들거나 동화/u, /술에 몹시 취해/u, /모습이 없어지다/u, /반하여 홀리다/u],
  },
  {
    lemma: '넣다', senses: senseRange('w406793', 14),
    signals: [/공간이나 범위/u, /섞/u, /사이에/u, /위에 입혀/u, /구성원/u, /기계를 작동/u, /은행/u, /글자나 무늬/u, /제삼자/u, /서류를 제출/u, /타격/u, /불을 지피/u, /신문을 정기적으로 배달/u, /씨앗을 심/u],
  },
  {
    lemma: '늘어지다', senses: senseRange('w410211', 6),
    signals: [/길어지/u, /끝이 아래로 처지/u, /기운이 풀려/u, /공간이나 시간이/u, /느려지/u, /근심이나 걱정 없이/u],
  },
  {
    lemma: '높이다', senses: senseRange('w68572', 15),
    signals: [/길이나 벌어진 사이/u, /온도·습도·압력/u, /가능성/u, /품질·수준/u, /지위·신분/u, /명성/u, /음계/u, /기세/u, /꿈·이상/u, /의견/u, /강도/u, /높임말/u],
  },
  {
    lemma: '넘기다', senses: senseRange('w411059', 11),
    signals: [/시간·시기·범위/u, /어려움/u, /가득/u, /책장/u, /머리카락/u, /넘어뜨리/u, /목구멍/u, /권리·책임/u, /짐승/u],
  },
  {
    lemma: '넘어가다', senses: senseRange('w408063', 15),
    signals: [/기울/u, /옮아가/u, /해나 달이 지/u, /책장이/u, /숨이 멎/u, /유혹/u, /목구멍/u, /노래나 목소리/u, /한계/u, /소홀히/u],
  },
  {
    lemma: '놀리다', senses: senseRange('w407520', 7),
    signals: [/놀이나 재미있는/u, /직업이나 일정한 일/u, /쉬게/u, /시설/u, /신체 부위/u, /기구나 도구/u, /말을 함부로/u],
  },
  {
    lemma: '날리다', senses: [...senseRange('w407593', 7), 'w407794-s1'],
    signals: [/공중에/u, /바람에 나부끼/u, /명성을/u, /재산이나 자료/u, /아이를/u, /정성을 들이지/u, /웃음/u],
  },
  {
    lemma: '넘어오다', senses: senseRange('w65136', 7),
    signals: [/기울거나 쓰러지/u, /경계를/u, /사람·물건/u, /현재로/u, /유혹/u, /음식·말·감정/u, /목구멍/u],
  },
  {
    lemma: '놓이다', senses: senseRange('w409425', 7),
    signals: [/걱정·근심·긴장/u, /물체·기계/u, /장치·구조물·덫/u, /무늬/u, /솜·털/u, /음식 재료/u],
  },
  {
    lemma: '넘겨보다', senses: senseRange('w509707', 4),
    signals: [/가리어진 물건 너머/u, /관심/u, /슬쩍슬쩍/u, /욕심/u, /넘겨짚어/u],
  },
];

function assertSplitBeforeAndMergedAfter({ lemma, senses, signals }) {
  const edit = editByLemma.get(lemma);
  assert.ok(edit, `${lemma} must have a recorded C03 repartition`);
  const beforeBySense = new Map(edit.before.flatMap((row) => row.sense_ids.map((id) => [id, row.id])));
  assert.ok(senses.every((id) => beforeBySense.has(id)), `${lemma} fixture senses must appear in exact before snapshots`);
  assert.ok(new Set(senses.map((id) => beforeBySense.get(id))).size > 1, `${lemma} fixture must fail against its before snapshot`);

  const specGroup = edit.groups.find((group) => senses.every((id) => group.senses.includes(id)));
  assert.ok(specGroup, `${lemma} senses must share one final edit-spec group`);
  assert.deepEqual(specGroup.senses, senses, `${lemma} group must preserve every reviewed source sense`);

  const rows = senses.map((id) => rowBySense.get(id));
  assert.ok(rows.every(Boolean), `${lemma} source senses must all survive in C03 output`);
  assert.ok(rows.every((row) => row.lemma === lemma), `${lemma} source bindings must retain their lemma`);
  assert.ok(senses.every((id) => sourceBySense.get(id)?.lemma === lemma), `${lemma} fixture senses must resolve to the canonical source`);
  assert.equal(new Set(rows.map((row) => row.id)).size, 1, `${lemma} uses must resolve to one Meaning`);
  assert.deepEqual(rows[0].sense_ids, senses, `${lemma} committed Meaning must match its full reviewed group`);
  for (const signal of signals) assert.match(rows[0].gloss, signal, `${lemma} merged gloss must retain ${signal}`);
}

function assertSeparate(...senseIds) {
  const rows = senseIds.map((id) => rowBySense.get(id));
  assert.ok(rows.every(Boolean), `negative-control senses must survive: ${senseIds.join(', ')}`);
  assert.equal(new Set(rows.map((row) => row.id)).size, senseIds.length, `independent lexical identities must remain separate: ${senseIds.join(', ')}`);
}

test('C03 source-bound verb merges fix the exact before-snapshot failures and preserve independent homonyms', () => {
  for (const repair of expectedMerges) assertSplitBeforeAndMergedAfter(repair);

  // Independent-entry controls: eye/snow, the distinct 낙수 identities, and 난계's disorder/friendship senses.
  assertSeparate('w409998-s1', 'w71074-s1');
  assertSeparate('w58323-s1', 'w58324-s1', 'w60107-s1', 'w408046-s1');
  assertSeparate('w60112-s1', 'w60114-s1');

  // Same lemma, independent records remain separate while each real identity is internally grouped.
  assertSeparate('w67524-s1', 'w408835-s1');
  assertSeparate('w407350-s1', 'w407520-s1', 'w69050-s1');
});
