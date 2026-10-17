import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { initialCodeOf, readAdjudications } from './contract.mjs';
import { readCanonicalEntries } from './initial.mjs';
import { projectMeaningRelations } from './project.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const meaningDirectory = path.join(root, 'data/meanings');
const allMeanings = readdirSync(meaningDirectory).filter((file) => /^c19_\d+\.jsonl$/u.test(file)).sort()
  .flatMap((file) => readFileSync(path.join(meaningDirectory, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
const meaningBySense = new Map();
for (const meaning of allMeanings) {
  for (const senseId of meaning.sense_ids) {
    assert.equal(meaningBySense.has(senseId), false, `${senseId} must belong to exactly one C19 Meaning`);
    meaningBySense.set(senseId, meaning);
  }
}

const sameMeaning = (senseIds, index = meaningBySense) => senseIds.every((id) => index.has(id)
  && index.get(id) !== undefined)
  && new Set(senseIds.map((id) => index.get(id).id ?? index.get(id))).size === 1;
const known = (senseIds) => senseIds.every((id) => meaningBySense.has(id));

// These source-ID fixtures capture the C19 HEAD reviewed by Stage 2 before this correction.
// Each listed source group occupied one Meaning on that HEAD and must now be split by its
// source-bound lexical identity, rather than by the generic shared category/action.
const historicalOvermerges = [
  ['합사 (合沙 / 合絲 / 合飼)', 'm368033', ['w368033-s1', 'w502178-s1', 'w534893-s1']],
  ['합사하다 (合沙 / 合絲 / 合飼)', 'm368034', ['w368034-s1', 'w368036-s1', 'w534894-s1']],
  ['하화 (荷花 / 夏花)', 'm362827', ['w362827-s1', 'w501101-s1', 'w501101-s2']],
  ['합근 (合根 / 合巹)', 'm365690', ['w365690-s1', 'w502252-s1', 'w502252-s2']],
  ['합근하다 (合根 / 合巹)', 'm365689', ['w365689-s1', 'w365689-s2', 'w365691-s1']],
  ['하수 (下壽 / 遐壽 / 賀壽)', 'm361157', ['w361157-s1', 'w361160-s1', 'w503698-s1']],
  ['하수하다 (遐壽 / 賀壽)', 'm361159', ['w361159-s1', 'w361170-s1']],
  ['화난 (火難 / 禍難)', 'm377835', ['w377835-s1', 'w377838-s1']],
  ['화변 (火變 / 禍變)', 'm375812', ['w375812-s1', 'w375813-s1']],
  ['화사 (火事 / 禍事)', 'm376999', ['w376999-s1', 'w505498-s1']],
  ['화원 (化源 / 火源 / 禍源)', 'm379308', ['w379308-s1', 'w379309-s1', 'w379309-s2', 'w508715-s1']],
  ['화인 (禍因 / 火因)', 'm375137', ['w375137-s1', 'w375395-s1']],
  ['화재 (火災 / 禍災)', 'm380401', ['w380401-s1', 'w381532-s1']],
  ['화해 (禍害 / 火海)', 'm376442', ['w376442-s1', 'w376484-s1']],
];

const splitBoundaries = [
  ['합사 (合沙 / 合絲 / 合飼)', [['w368033-s1'], ['w502178-s1'], ['w534893-s1']]],
  ['합사하다 (合沙 / 合絲 / 合飼)', [['w368034-s1'], ['w368036-s1'], ['w534894-s1']]],
  ['하화 lotus versus summer flowers', [['w362827-s1'], ['w501101-s1', 'w501101-s2']]],
  ['합근 (合根 / 合巹)', [['w365690-s1'], ['w502252-s1', 'w502252-s2']]],
  ['합근하다 (合根 / 合巹)', [['w365691-s1'], ['w365689-s1', 'w365689-s2']]],
  ['하수 (下壽 / 遐壽 / 賀壽)', [['w361157-s1'], ['w361160-s1'], ['w503698-s1']]],
  ['하수하다 (遐壽 / 賀壽)', [['w361170-s1'], ['w361159-s1']]],
  ['화난 (火難 / 禍難)', [['w377835-s1'], ['w377838-s1']]],
  ['화변 (火變 / 禍變)', [['w375812-s1'], ['w375813-s1']]],
  ['화사 (火事 / 禍事)', [['w376999-s1'], ['w505498-s1']]],
  ['화원 (化源 / 火源 / 禍源)', [['w379308-s1'], ['w379309-s1', 'w379309-s2', 'w508715-s1']]],
  ['화인 (禍因 / 火因)', [['w375137-s1'], ['w375395-s1']]],
  ['화재 (火災 / 禍災)', [['w380401-s1'], ['w381532-s1']]],
  ['화해 (禍害 / 火海)', [['w376442-s1'], ['w376484-s1']]],
];

const sameIdentityControls = [
  ['합사묘 combined-spirit shrine and Confucian shrine', ['w368040-s1', 'w368040-s2']],
  ['화원 flower field and flower garden', ['w379310-s1', 'w508714-s1']],
  ['하화 summer flower and summer-retreat offering flower (夏花)', ['w501101-s1', 'w501101-s2']],
  ['합근 wedding cup rite and wedding ceremony (合巹)', ['w502252-s1', 'w502252-s2']],
  ['화원 fire source, hazard source and calamity source', ['w379309-s1', 'w379309-s2', 'w508715-s1']],
];

test('C19 recorded pre-fix overmerges are repaired at their source-ID boundaries', () => {
  const historicalIndex = new Map();
  for (const [label, oldMeaningId, senseIds] of historicalOvermerges) {
    for (const senseId of senseIds) historicalIndex.set(senseId, oldMeaningId);
    assert.equal(sameMeaning(senseIds, historicalIndex), true, `${label}: captured reviewed HEAD had one Meaning`);
  }

  for (const [label, groups] of splitBoundaries) {
    for (let left = 0; left < groups.length; left += 1) {
      for (let right = left + 1; right < groups.length; right += 1) {
        for (const a of groups[left]) {
          for (const b of groups[right]) {
            assert.equal(sameMeaning([a, b], historicalIndex), true, `${label}: pre-fix grouping must fail ${a}/${b}`);
            assert.equal(sameMeaning([a, b]), false, `${label}: ${a}/${b} must now resolve to separate Meanings`);
          }
        }
      }
    }
  }
});

test('C19 source-ID controls preserve supported same-identity groupings', () => {
  for (const [label, senseIds] of sameIdentityControls) {
    assert.ok(known(senseIds), `${label}: every control sense must resolve`);
    assert.ok(sameMeaning(senseIds), `${label}: source-bound meanings should remain grouped`);
  }
  for (const [label, groups] of splitBoundaries) {
    const ids = groups.flat();
    assert.ok(known(ids), `${label}: every negative-control sense must resolve`);
  }
});

test('C19 corrected lotus and summer-flower source relations project to distinct endpoints', () => {
  const allMeaningsBySense = new Map();
  for (const file of readdirSync(meaningDirectory).filter((name) => name.endsWith('.jsonl'))) {
    for (const line of readFileSync(path.join(meaningDirectory, file), 'utf8').split('\n')) {
      if (!line) continue;
      const meaning = JSON.parse(line);
      for (const senseId of meaning.sense_ids) allMeaningsBySense.set(senseId, meaning);
    }
  }
  const records = readCanonicalEntries(path.join(root, 'data/canonical'))
    .filter((record) => ['w362827', 'w501101'].includes(record.id));
  const adjudications = readAdjudications(path.join(root, 'data/adjudication')).rows;
  const { relations } = projectMeaningRelations({ records, meanings: [...new Set(allMeaningsBySense.values())], adjudications });
  const lotusMeaning = allMeaningsBySense.get('w362827-s1');
  const summerMeaning = allMeaningsBySense.get('w501101-s1');
  const lotusTarget = allMeaningsBySense.get('w459230-s2');
  const summerTarget = allMeaningsBySense.get('w535328-s1');
  assert.ok(lotusMeaning && summerMeaning && lotusTarget && summerTarget, 'all relation endpoints must resolve');
  assert.notEqual(lotusMeaning.id, summerMeaning.id, 'the lotus and summer-flower sources stay on separate Meaning endpoints');

  for (const [label, sourceMeaning, targetMeaning, sourceSense] of [
    ['lotus', lotusMeaning, lotusTarget, 'w362827-s1'],
    ['summer flower', summerMeaning, summerTarget, 'w501101-s1'],
  ]) {
    const relation = relations.find((item) => item.source_meaning_id === sourceMeaning.id
      && item.target_meaning_id === targetMeaning.id && item.type === 'direct');
    assert.ok(relation, `${label}: canonical direct relation must project`);
    assert.deepEqual(relation.sources.map((source) => source.source_sense_id), [sourceSense], `${label}: relation provenance stays source-bound`);
  }
});

test('C19 source fixture IDs still resolve to their canonical lemma and source gloss', () => {
  const canonicalBySense = new Map();
  for (const record of readCanonicalEntries(path.join(root, 'data/canonical'))) {
    for (const sense of record.senses) canonicalBySense.set(sense.id, { lemma: record.lemma, gloss: sense.gloss });
  }
  const fixtureIds = [
    ...historicalOvermerges.flatMap(([, , senseIds]) => senseIds),
    ...sameIdentityControls.flatMap(([, senseIds]) => senseIds),
  ];
  for (const senseId of new Set(fixtureIds)) {
    const canonical = canonicalBySense.get(senseId);
    const meaning = meaningBySense.get(senseId);
    assert.ok(canonical, `${senseId}: source sense must exist in canonical data`);
    assert.ok(meaning, `${senseId}: source sense must exist in C19 Meaning data`);
    assert.equal(initialCodeOf(canonical.lemma), 'c19', `${senseId}: source sense remains in C19`);
    assert.equal(meaning.lemma, canonical.lemma, `${senseId}: Meaning binding must preserve its canonical lemma`);
    assert.ok(meaning.gloss.includes(canonical.gloss), `${senseId}: Meaning gloss must retain its bound source gloss`);
  }
});
