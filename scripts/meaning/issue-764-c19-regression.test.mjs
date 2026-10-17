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
  ['합동 (合同 / 合洞)', 'm371651_1', ['w371651-s1', 'w371653-s1']],
  ['합동되다 (合同 / 合洞)', 'm364871', ['w371652-s1', 'w364871-s1']],
  ['합동하다 (合同 / 合洞)', 'm502844', ['w502844-s1', 'w502845-s1']],
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
  ['후방 (後房 / 後方)', 'pre-fix:후방', ['w378899-s1', 'w506363-s1', 'w506363-s2']],
  ['후차 (後次 / 後車)', 'pre-fix:후차', ['w379204-s1', 'w379206-s1']],
  ['하랍 (夏臘 / 下臘)', 'pre-fix:하랍', ['w360069-s1', 'w501770-s1']],
  ['하재 (下材 / 下才)', 'pre-fix:하재', ['w363132-s1', 'w363132-s2', 'w517360-s1']],
  ['한길 (wide road / one road)', 'pre-fix:한길', ['w368117-s1', 'w368118-s1']],
  ['하향 (下向·下鄕 / 遐鄕)', 'pre-fix:하향', ['w362015-s1', 'w362015-s2', 'w362015-s3', 'w362256-s1', 'w362256-s2', 'w500423-s1']],
  ['항성 (亢星 / 恒星)', 'pre-fix:항성', ['w364475-s1', 'w502074-s1']],
  ['항속 (航速 / 恒速)', 'pre-fix:항속', ['w363710-s1', 'w365377-s1']],
  ['항진 (航進 / 亢進)', 'pre-fix:항진', ['w367441-s1', 'w503132-s1', 'w503132-s2', 'w503132-s3']],
  ['해낭 (亥囊 / 奚囊)', 'pre-fix:해낭', ['w365224-s1', 'w365225-s1']],
  ['해선 (海扇 / 海鮮)', 'pre-fix:해선', ['w365575-s1', 'w499128-s1', 'w499128-s2']],
  ['헤르츠 (physicist / unit)', 'pre-fix:헤르츠', ['w372446-s1', 'w372448-s1']],
  ['헨리 (physicist / unit)', 'pre-fix:헨리', ['w378109-s1', 'w506212-s1']],
  ['현상 (玄象·懸象 / 現狀·現想·現象)', 'pre-fix:현상', ['w370521-s1', 'w370523-s1', 'w370524-s1', 'w503709-s1', 'w503709-s2', 'w503713-s1']],
  ['현연 (玄淵 / 懸然)', 'pre-fix:현연', ['w376022-s1', 'w376029-s1']],
  ['현인 (顯人 / 賢人)', 'pre-fix:현인', ['w373695-s1', 'w498039-s1']],
  ['형사 (形寫 / 形似)', 'pre-fix:형사', ['w374583-s1', 'w501565-s1']],
  ['형지 (型紙 / 形址)', 'pre-fix:형지', ['w373430-s1', 'w507269-s1']],
  ['혜사 (惠赦 / 惠賜 / 惠思)', 'pre-fix:혜사', ['w371190-s1', 'w371191-s1', 'w508802-s1']],
  ['혜사하다 (惠思 / 惠賜 / 惠赦)', 'pre-fix:혜사하다', ['w371189-s1', 'w371192-s1', 'w508803-s1']],
  ['호망 (狐網 / 壺網 / 虎網)', 'pre-fix:호망', ['w375224-s1', 'w375494-s1', 'w504421-s1']],
  ['호세 (怙勢 / 豪勢)', 'pre-fix:호세', ['w375501-s1', 'w379839-s1']],
  ['홍하 (洪河 / 紅河)', 'pre-fix:홍하', ['w381865-s1', 'w382137-s1']],
  ['활동 (滑動 / 活動)', 'pre-fix:활동', ['w380885-s1', 'w508962-s1', 'w508962-s2', 'w508962-s3', 'w508962-s4']],
  ['황고 (皇姑 / 皇考)', 'pre-fix:황고', ['w389400-s1', 'w504063-s1']],
  ['황비 (皇妃 / 皇妣)', 'pre-fix:황비', ['w386855-s1', 'w386856-s1']],
  ['회공 (恢公 / 回公)', 'pre-fix:회공', ['w380618-s1', 'w508961-s1']],
  ['회부 (回附 / 會付)', 'pre-fix:회부', ['w380061-s1', 'w506542-s1']],
  ['행사 (行使 / 行事)', 'pre-fix:행사', ['w364094-s1', 'w364094-s2', 'w364094-s3', 'w502586-s1']],
  ['행사하다 (行使 / 行事)', 'pre-fix:행사하다', ['w364093-s1', 'w502587-s1', 'w502587-s2', 'w502587-s3']],
  ['훈문 (勳門 / 薰門)', 'pre-fix:훈문', ['w381661-s1', 'w381662-s1']],
  ['훈전 (訓典 / 訓傳)', 'pre-fix:훈전', ['w378630-s1', 'w378631-s1']],
  ['휴전 (休電 / 休戰)', 'pre-fix:휴전', ['w387129-s1', 'w387131-s1']],
  ['흉리 (凶裏 / 胸裏)', 'pre-fix:흉리', ['w382796-s1', 'w382797-s1']],
  ['흉심 (凶心 / 胸心)', 'pre-fix:흉심', ['w384227-s1', 'w384228-s1']],
  ['흉조 (凶鳥 / 凶兆)', 'pre-fix:흉조', ['w387834-s1', 'w508849-s1']],
  ['흡기 (吸器 / 吸氣)', 'pre-fix:흡기', ['w388311-s1', 'w508426-s1', 'w508426-s2']],
];

const splitBoundaries = [
  ['합사 (合沙 / 合絲 / 合飼)', [['w368033-s1'], ['w502178-s1'], ['w534893-s1']]],
  ['합동 (合同 / 合洞)', [['w371651-s1'], ['w371653-s1']]],
  ['합동되다 (合同 / 合洞)', [['w371652-s1'], ['w364871-s1']]],
  ['합동하다 (合同 / 合洞)', [['w502844-s1'], ['w502845-s1']]],
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
  ['후방 (後房 / 後方)', [['w378899-s1'], ['w506363-s1', 'w506363-s2']]],
  ['후차 (後次 / 後車)', [['w379204-s1'], ['w379206-s1']]],
  ['하랍 (夏臘 / 下臘)', [['w360069-s1'], ['w501770-s1']]],
  ['하재 (下材 / 下才)', [['w363132-s1', 'w363132-s2'], ['w517360-s1']]],
  ['한길 (wide road / one road)', [['w368117-s1'], ['w368118-s1']]],
  ['하향 (下向 / 下鄕 / 遐鄕)', [['w362015-s1', 'w362015-s2', 'w362015-s3'], ['w362256-s1', 'w362256-s2'], ['w500423-s1']]],
  ['항성 (亢星 / 恒星)', [['w364475-s1'], ['w502074-s1']]],
  ['항속 (航速 / 恒速)', [['w363710-s1'], ['w365377-s1']]],
  ['항진 (航進 / 亢進)', [['w367441-s1'], ['w503132-s1', 'w503132-s2', 'w503132-s3']]],
  ['해낭 (亥囊 / 奚囊)', [['w365224-s1'], ['w365225-s1']]],
  ['해선 (海扇 / 海鮮)', [['w365575-s1'], ['w499128-s1', 'w499128-s2']]],
  ['헤르츠 (physicist / unit)', [['w372446-s1'], ['w372448-s1']]],
  ['헨리 (physicist / unit)', [['w378109-s1'], ['w506212-s1']]],
  ['현상 (celestial / present-state and phenomenon / mental image)', [['w370521-s1', 'w503713-s1'], ['w370523-s1', 'w503709-s1', 'w503709-s2'], ['w370524-s1']]],
  ['현연 (玄淵 / 懸然)', [['w376022-s1'], ['w376029-s1']]],
  ['현인 (顯人 / 賢人)', [['w373695-s1'], ['w498039-s1']]],
  ['형사 (形寫 / 形似)', [['w374583-s1'], ['w501565-s1']]],
  ['형지 (型紙 / 形址)', [['w373430-s1'], ['w507269-s1']]],
  ['혜사 (惠赦 / 惠賜 / 惠思)', [['w371190-s1'], ['w371191-s1'], ['w508802-s1']]],
  ['혜사하다 (惠思 / 惠賜 / 惠赦)', [['w371189-s1'], ['w371192-s1'], ['w508803-s1']]],
  ['호망 (狐網 / 壺網 / 虎網)', [['w375224-s1'], ['w375494-s1'], ['w504421-s1']]],
  ['호세 (怙勢 / 豪勢)', [['w375501-s1'], ['w379839-s1']]],
  ['홍하 (洪河 / 紅河)', [['w381865-s1'], ['w382137-s1']]],
  ['활동 (滑動 / 活動)', [['w380885-s1'], ['w508962-s1', 'w508962-s2', 'w508962-s3', 'w508962-s4']]],
  ['황고 (皇姑 / 皇考)', [['w389400-s1'], ['w504063-s1']]],
  ['황비 (皇妃 / 皇妣)', [['w386855-s1'], ['w386856-s1']]],
  ['회공 (恢公 / 回公)', [['w380618-s1'], ['w508961-s1']]],
  ['회부 (回附 / 會付)', [['w380061-s1'], ['w506542-s1']]],
  ['행사 (行使 / 行事)', [['w364094-s1', 'w364094-s2', 'w364094-s3'], ['w502586-s1']]],
  ['행사하다 (行使 / 行事)', [['w364093-s1'], ['w502587-s1', 'w502587-s2', 'w502587-s3']]],
  ['훈문 (勳門 / 薰門)', [['w381661-s1'], ['w381662-s1']]],
  ['훈전 (訓典 / 訓傳)', [['w378630-s1'], ['w378631-s1']]],
  ['휴전 (休電 / 休戰)', [['w387129-s1'], ['w387131-s1']]],
  ['흉리 (凶裏 / 胸裏)', [['w382796-s1'], ['w382797-s1']]],
  ['흉심 (凶心 / 胸心)', [['w384227-s1'], ['w384228-s1']]],
  ['흉조 (凶鳥 / 凶兆)', [['w387834-s1'], ['w508849-s1']]],
  ['흡기 (吸器 / 吸氣)', [['w388311-s1'], ['w508426-s1', 'w508426-s2']]],
];

const sameIdentityControls = [
  ['합가 family as a whole and the joined household (合家 / 闔家)', ['w364444-s1', 'w364444-s2', 'w364457-s1']],
  ['후방 house rear room and anatomical posterior chamber (後房)', ['w378899-s1', 'w378899-s2']],
  ['해마 seahorse and its shape-based anatomical extension (海馬)', ['w502078-s1', 'w502078-s2', 'w502078-s4']],
  ['향군 modern local military roles and historical local soldiers (鄕軍)', ['w373298-s1', 'w373298-s2', 'w373298-s3']],
  ['화예석 mineral and its Korean-medicine name (花蕊石)', ['w374203-s1', 'w374203-s2']],
  ['희년 Catholic and biblical jubilee years (禧年)', ['w504915-s1', 'w504915-s2']],
  ['후위 historical rear guard, rear-defense roles, and sports defender (後衛)', ['w380772-s1', 'w505660-s1', 'w505660-s2', 'w505660-s3']],
  ['후퇴 backward movement and a building setback (後退)', ['w506500-s1', 'w506500-s2', 'w506500-s3']],
  ['합사묘 combined-spirit shrine and Confucian shrine', ['w368040-s1', 'w368040-s2']],
  ['화원 flower field and flower garden', ['w379310-s1', 'w508714-s1']],
  ['하화 summer flower and summer-retreat offering flower (夏花)', ['w501101-s1', 'w501101-s2']],
  ['합근 wedding cup rite and wedding ceremony (合巹)', ['w502252-s1', 'w502252-s2']],
  ['화원 fire source, hazard source and calamity source', ['w379309-s1', 'w379309-s2', 'w508715-s1']],
  ['후방 general and military rear directions (後方)', ['w506363-s1', 'w506363-s2']],
  ['항진 increase in illness and intensity (亢進)', ['w503132-s1', 'w503132-s2', 'w503132-s3']],
  ['현려 deep consideration and wise thought (玄慮 / 賢慮)', ['w370758-s1', 'w370759-s1', 'w370759-s2']],
  ['하향 rural trip and return-home senses (下鄕)', ['w362256-s1', 'w362256-s2']],
  ['현상 celestial images (玄象 / 懸象)', ['w370521-s1', 'w503713-s1']],
  ['현상 present state and observable phenomenon (現狀 / 現象)', ['w370523-s1', 'w503709-s1', 'w503709-s2']],
  ['활동 general bodily, productive, biological and volcanic activity (活動)', ['w508962-s1', 'w508962-s2', 'w508962-s3', 'w508962-s4']],
  ['하재 lower-grade materials and their named buffalo-bone kind (下材)', ['w363132-s1', 'w363132-s2']],
  ['해선 edible seafood senses (海鮮)', ['w499128-s1', 'w499128-s2']],
];

const distinctIdentityControls = [
  ['후방 房 chambers and 方 rear direction', [['w378899-s1', 'w378899-s2'], ['w506363-s1', 'w506363-s2']]],
  ['후위 rear-guard meanings and Northern Wei state (後衛 / 後魏)', [['w380772-s1', 'w505660-s1', 'w505660-s2', 'w505660-s3'], ['w380773-s1']]],
  ['해마 seahorse/anatomical term and walrus (海馬)', [['w502078-s1', 'w502078-s2', 'w502078-s4'], ['w502078-s3']]],
  ['희년 jubilee and rare age (禧年 / 稀年)', [['w504915-s1', 'w504915-s2'], ['w384992-s1']]],
  ['허공 empty space and number (虛空)', [['w503026-s1', 'w503026-s2', 'w503026-s3'], ['w503026-s4', 'w503026-s5']]],
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

test('C19 risk controls retain independently named identities', () => {
  for (const [label, groups] of distinctIdentityControls) {
    const ids = groups.flat();
    assert.ok(known(ids), `${label}: every control sense must resolve`);
    for (const group of groups) assert.ok(sameMeaning(group), `${label}: each supported group stays intact`);
    for (let left = 0; left < groups.length; left += 1) {
      for (let right = left + 1; right < groups.length; right += 1) {
        assert.equal(sameMeaning([...groups[left], ...groups[right]]), false, `${label}: independent groups stay separate`);
      }
    }
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

test('C19 corrected same-record and later-car source relations preserve endpoints', () => {
  const allMeaningsBySense = new Map();
  for (const file of readdirSync(meaningDirectory).filter((name) => name.endsWith('.jsonl'))) {
    for (const line of readFileSync(path.join(meaningDirectory, file), 'utf8').split('\n')) {
      if (!line) continue;
      const meaning = JSON.parse(line);
      for (const senseId of meaning.sense_ids) allMeaningsBySense.set(senseId, meaning);
    }
  }
  const sourceIds = new Set(['w378899', 'w506363', 'w379204', 'w379206', 'w502078', 'w505660', 'w506500', 'w374203']);
  const records = readCanonicalEntries(path.join(root, 'data/canonical')).filter((record) => sourceIds.has(record.id));
  const adjudications = readAdjudications(path.join(root, 'data/adjudication')).rows;
  const { relations } = projectMeaningRelations({ records, meanings: [...new Set(allMeaningsBySense.values())], adjudications });
  const endpoint = (senseId) => {
    const meaning = allMeaningsBySense.get(senseId);
    assert.ok(meaning, `${senseId}: projected Meaning endpoint must resolve`);
    return meaning;
  };
  const assertSourceRelation = (label, sourceSense, targetSense, type) => {
    const sourceMeaning = endpoint(sourceSense);
    const targetMeaning = endpoint(targetSense);
    const relation = relations.find((item) => item.source_meaning_id === sourceMeaning.id
      && item.target_meaning_id === targetMeaning.id && item.type === type);
    assert.ok(relation, `${label}: source relation must project to its own Meaning endpoint`);
    assert.deepEqual(relation.sources.map((source) => source.source_sense_id), [sourceSense], `${label}: provenance remains bound to its canonical sense`);
    return sourceMeaning;
  };

  const rearRoom = assertSourceRelation('rear room', 'w378899-s1', 'w94426-s1', 'direct');
  const posteriorChamber = assertSourceRelation('posterior chamber', 'w378899-s2', 'w512450-s1', 'direct');
  const rearDirection = endpoint('w506363-s1');
  assert.equal(posteriorChamber.id, rearRoom.id, 'the same 後房 naming principle groups house and anatomical chambers');
  assert.notEqual(rearRoom.id, rearDirection.id, 'the 房 chambers must not share the 方 direction Meaning endpoint');

  const seahorse = assertSourceRelation('seahorse', 'w502078-s2', 'w449460-s1', 'direct');
  const hippocampus = assertSourceRelation('hippocampus', 'w502078-s4', 'w457959-s1', 'direct');
  assert.equal(hippocampus.id, seahorse.id, 'the anatomical 海馬 endpoint stays with the shape-based animal name');
  assertSourceRelation('walrus', 'w502078-s3', 'w428436-s1', 'direct');
  assert.notEqual(endpoint('w502078-s3').id, seahorse.id, 'the walrus remains an independent animal identity');

  const rearGuard = assertSourceRelation('military rear guard', 'w505660-s2', 'w380774-s1', 'direct');
  assertSourceRelation('rear defense antonym', 'w505660-s1', 'w287873-s1', 'antonym');
  assert.equal(endpoint('w380772-s1').id, rearGuard.id, 'the named rear-guard unit retains the same 後衛 identity');
  assert.equal(endpoint('w505660-s3').id, rearGuard.id, 'the sports defender shares the rear-defense Meaning');
  const retreat = assertSourceRelation('retreat', 'w506500-s1', 'w230252-s1', 'direct');
  const buildingSetback = assertSourceRelation('building setback', 'w506500-s3', 'w94358-s1', 'direct');
  assert.equal(buildingSetback.id, retreat.id, 'the architectural setback shares the backward-recession Meaning');
  assertSourceRelation('stone', 'w374203-s1', 'w501984-s1', 'direct');
  assertSourceRelation('later in sequence', 'w379204-s1', 'w448812-s1', 'antonym');
  const nextCar = assertSourceRelation('next vehicle', 'w379206-s1', 'w95438-s1', 'direct');
  assert.notEqual(endpoint('w379204-s1').id, nextCar.id, '次 order and 車 vehicle relations must keep separate source Meaning endpoints');
});

test('C19 合洞 antonyms project only to the administrative-dong meanings', () => {
  const allMeaningsBySense = new Map();
  for (const file of readdirSync(meaningDirectory).filter((name) => name.endsWith('.jsonl'))) {
    for (const line of readFileSync(path.join(meaningDirectory, file), 'utf8').split('\n')) {
      if (!line) continue;
      const meaning = JSON.parse(line);
      for (const senseId of meaning.sense_ids) allMeaningsBySense.set(senseId, meaning);
    }
  }
  const sourceIds = new Set(['w371653', 'w153333', 'w502845', 'w436724']);
  const records = readCanonicalEntries(path.join(root, 'data/canonical'))
    .filter((record) => sourceIds.has(record.id));
  const adjudications = readAdjudications(path.join(root, 'data/adjudication')).rows;
  const { relations } = projectMeaningRelations({ records, meanings: [...new Set(allMeaningsBySense.values())], adjudications });

  for (const [sourceSense, targetSense, sharedActionSense, label] of [
    ['w371653-s1', 'w153333-s1', 'w371651-s1', '합동'],
    ['w502845-s1', 'w436724-s1', 'w502844-s1', '합동하다'],
  ]) {
    const sourceMeaning = allMeaningsBySense.get(sourceSense);
    const targetMeaning = allMeaningsBySense.get(targetSense);
    const actionMeaning = allMeaningsBySense.get(sharedActionSense);
    assert.ok(sourceMeaning && targetMeaning && actionMeaning, `${label}: source and target Meaning endpoints resolve`);
    assert.notEqual(sourceMeaning.id, actionMeaning.id, `${label}: 合洞 and 合同 remain distinct Meanings`);
    const projected = relations.find((relation) => relation.source_meaning_id === sourceMeaning.id
      && relation.target_meaning_id === targetMeaning.id && relation.type === 'antonym');
    assert.ok(projected, `${label}: the canonical administrative-dong antonym projects`);
    assert.deepEqual(projected.sources.map((source) => source.source_sense_id), [sourceSense], `${label}: source provenance stays bound`);
    assert.equal(relations.some((relation) => relation.source_meaning_id === actionMeaning.id
      && relation.target_meaning_id === targetMeaning.id && relation.type === 'antonym'), false,
    `${label}: the administrative-dong antonym does not leak to the shared-action Meaning`);
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
