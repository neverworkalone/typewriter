import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { initialCodeOf, readAdjudications } from './contract.mjs';
import { readCanonicalEntries } from './initial.mjs';
import { projectMeaningRelations } from './project.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const canonicalDir = path.join(root, 'data/canonical');
const meaningDir = path.join(root, 'data/meanings');
const rows = readdirSync(meaningDir).filter((file) => /^c01_\d+\.jsonl$/u.test(file)).sort()
  .flatMap((file) => readFileSync(path.join(meaningDir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
const rowBySense = new Map();
for (const row of rows) {
  for (const senseId of row.sense_ids) {
    assert.equal(rowBySense.has(senseId), false, senseId + ' must belong to exactly one C01 Meaning');
    rowBySense.set(senseId, row);
  }
}
const spec = JSON.parse(readFileSync(path.join(root, 'scripts/meaning/issue-764-c01.json'), 'utf8'));
const canonicalRecords = readCanonicalEntries(canonicalDir);
const canonical = canonicalRecords.filter((record) => initialCodeOf(record.lemma) === 'c01');
const canonicalSense = new Map();
for (const record of canonical) {
  for (const sense of record.senses ?? []) canonicalSense.set(sense.id, { lemma: record.lemma, recordId: record.id });
}
const sameMeaning = (ids) => ids.every((id) => rowBySense.has(id))
  && new Set(ids.map((id) => rowBySense.get(id).id)).size === 1;

test('C01 repartitions match the source-sense groups and final rows', () => {
  const seenLemmas = new Set();
  for (const edit of spec.repartitions) {
    assert.equal(seenLemmas.has(edit.lemma), false, edit.lemma + ': only one repartition is allowed');
    seenLemmas.add(edit.lemma);
    const before = edit.before.flatMap((row) => row.sense_ids).sort();
    const grouped = edit.groups.flatMap((group) => group.senses).sort();
    assert.deepEqual(grouped, before, edit.lemma + ': repartition must cover each prior sense exactly once');
    assert.equal(new Set(grouped).size, grouped.length, edit.lemma + ': no source sense may be assigned twice');
    for (const group of edit.groups) {
      const actual = rowBySense.get(group.senses[0]);
      assert.ok(actual, edit.lemma + ': missing final Meaning for ' + group.senses[0]);
      assert.deepEqual([...actual.sense_ids].sort(), [...group.senses].sort(), edit.lemma + ': final source membership differs from spec');
      assert.equal(actual.gloss, group.gloss, edit.lemma + ': final gloss differs from spec');
      for (const senseId of group.senses) {
        assert.equal(canonicalSense.get(senseId)?.lemma, edit.lemma, edit.lemma + ': ' + senseId + ' must be a canonical sense of the same lemma');
      }
    }
  }
});

test('C01 canonical senses have exactly one Meaning or explicit duplicate adjudication', () => {
  const expected = canonical.flatMap((record) => (record.senses ?? []).map((sense) => sense.id)).sort();
  const adjudications = readAdjudications(path.join(root, 'data/adjudication')).rows
    .filter((item) => initialCodeOf(item.lemma) === 'c01');
  const adjudicatedBySense = new Map(adjudications.map((item) => [item.sense_id, item]));
  for (const senseId of rowBySense.keys()) {
    assert.equal(adjudicatedBySense.has(senseId), false, senseId + ' cannot be both a Meaning and adjudicated');
  }
  assert.deepEqual([...rowBySense.keys(), ...adjudicatedBySense.keys()].sort(), expected,
    'every canonical C01 source sense must have exactly one Meaning or adjudication');
  assert.deepEqual(adjudications.map(({ sense_id, duplicate_of }) => [sense_id, duplicate_of]).sort(),
    spec.drops.map(({ sense_id, duplicate_of }) => [sense_id, duplicate_of]).sort(),
    'C01 duplicate adjudications must match the edit spec');
  for (const item of adjudications) {
    assert.equal(item.reason, 'duplicate', item.sense_id + ': C01 drops must remain explicit duplicate decisions');
    const target = rowBySense.get(item.duplicate_of);
    assert.ok(target, item.sense_id + ': duplicate target must have a live Meaning');
    assert.equal(target.lemma, item.lemma, item.sense_id + ': duplicate target must have the same lemma');
    assert.equal(canonicalSense.get(item.duplicate_of)?.lemma, item.lemma,
      item.sense_id + ': duplicate target must be a canonical sense of the same lemma');
  }
});

const crossRecordNegativeControls = [
  [
    "가구",
    "w258-s1",
    "w695-s1"
  ],
  [
    "가모",
    "w1020-s1",
    "w1023-s1"
  ],
  [
    "가모",
    "w1020-s1",
    "w387920-s1"
  ],
  [
    "가모",
    "w1020-s1",
    "w387920-s2"
  ],
  [
    "가모",
    "w1023-s1",
    "w387920-s1"
  ],
  [
    "가모",
    "w1023-s1",
    "w387920-s2"
  ],
  [
    "가문",
    "w1767-s1",
    "w1768-s1"
  ],
  [
    "가미",
    "w1309-s1",
    "w1371-s1"
  ],
  [
    "가미",
    "w1309-s1",
    "w1371-s2"
  ],
  [
    "가미",
    "w1309-s1",
    "w1371-s3"
  ],
  [
    "가보",
    "w1974-s1",
    "w1975-s1"
  ],
  [
    "가전",
    "w3692-s1",
    "w3695-s1"
  ],
  [
    "가전",
    "w3692-s1",
    "w3699-s1"
  ],
  [
    "가전",
    "w3692-s1",
    "w385293-s1"
  ],
  [
    "가전",
    "w3695-s1",
    "w3699-s1"
  ],
  [
    "가전",
    "w3695-s1",
    "w385293-s1"
  ],
  [
    "가전",
    "w3699-s1",
    "w385293-s1"
  ],
  [
    "각방",
    "w5347-s1",
    "w5349-s1"
  ],
  [
    "각방",
    "w5347-s2",
    "w5349-s1"
  ],
  [
    "각방",
    "w5348-s1",
    "w5349-s1"
  ],
  [
    "각설",
    "w3814-s1",
    "w389723-s1"
  ],
  [
    "각설",
    "w3814-s1",
    "w389723-s2"
  ],
  [
    "각설",
    "w3814-s2",
    "w389723-s1"
  ],
  [
    "각설",
    "w3814-s2",
    "w389723-s2"
  ],
  [
    "각설하다",
    "w3816-s1",
    "w3817-s1"
  ],
  [
    "각설하다",
    "w3816-s2",
    "w3817-s1"
  ],
  [
    "각지",
    "w4546-s1",
    "w4547-s1"
  ],
  [
    "각지",
    "w4546-s1",
    "w387713-s1"
  ],
  [
    "각지",
    "w4547-s1",
    "w387713-s1"
  ],
  [
    "간고",
    "w5403-s1",
    "w5404-s1"
  ],
  [
    "간부",
    "w5093-s1",
    "w5094-s1"
  ],
  [
    "간부",
    "w5095-s1",
    "w5094-s1"
  ],
  [
    "강수",
    "w8769-s1",
    "w8829-s1"
  ],
  [
    "강수하다",
    "w8771-s1",
    "w8830-s1"
  ],
  [
    "강장",
    "w9195-s1",
    "w9248-s1"
  ],
  [
    "강장",
    "w9195-s1",
    "w388179-s1"
  ],
  [
    "강장",
    "w9248-s1",
    "w388179-s1"
  ],
  [
    "개견하다",
    "w10526-s1",
    "w10528-s1"
  ],
  [
    "개관",
    "w10534-s1",
    "w392008-s1"
  ],
  [
    "개관",
    "w10534-s1",
    "w392008-s2"
  ],
  [
    "개관",
    "w10534-s1",
    "w392009-s1"
  ],
  [
    "개관",
    "w392008-s1",
    "w392009-s1"
  ],
  [
    "개관",
    "w392008-s2",
    "w392009-s1"
  ],
  [
    "개관하다",
    "w10751-s1",
    "w10802-s1"
  ],
  [
    "개관하다",
    "w10751-s1",
    "w10802-s2"
  ],
  [
    "개관하다",
    "w10751-s1",
    "w10803-s1"
  ],
  [
    "개관하다",
    "w10802-s1",
    "w10803-s1"
  ],
  [
    "개관하다",
    "w10802-s2",
    "w10803-s1"
  ],
  [
    "거사",
    "w12454-s1",
    "w391085-s1"
  ],
  [
    "거사",
    "w391086-s1",
    "w391085-s1"
  ],
  [
    "거사",
    "w391086-s2",
    "w391085-s1"
  ],
  [
    "거사",
    "w391086-s3",
    "w391085-s1"
  ],
  [
    "거사",
    "w391086-s4",
    "w391085-s1"
  ],
  [
    "격분",
    "w18571-s1",
    "w395741-s1"
  ],
  [
    "격분",
    "w18571-s1",
    "w395741-s2"
  ],
  [
    "견인하다",
    "w17669-s1",
    "w17670-s1"
  ],
  [
    "결안",
    "w17257-s1",
    "w391980-s1"
  ],
  [
    "결의",
    "w18065-s1",
    "w18198-s1"
  ],
  [
    "결의",
    "w18065-s1",
    "w18200-s1"
  ],
  [
    "결의",
    "w18198-s1",
    "w18200-s1"
  ],
  [
    "결의문",
    "w18692-s1",
    "w392723-s1"
  ],
  [
    "결의하다",
    "w18197-s1",
    "w18199-s1"
  ],
  [
    "결의하다",
    "w18197-s1",
    "w18201-s1"
  ],
  [
    "결의하다",
    "w18199-s1",
    "w18201-s1"
  ],
  [
    "고가",
    "w20065-s1",
    "w21077-s1"
  ],
  [
    "고가",
    "w20065-s1",
    "w21077-s2"
  ],
  [
    "고가",
    "w20065-s1",
    "w21078-s1"
  ],
  [
    "고가",
    "w21077-s1",
    "w21078-s1"
  ],
  [
    "고가",
    "w21077-s2",
    "w21078-s1"
  ],
  [
    "고가",
    "w20066-s1",
    "w21073-s1"
  ],
  [
    "고가",
    "w20066-s1",
    "w395274-s1"
  ],
  [
    "고가",
    "w21069-s1",
    "w21076-s1"
  ],
  [
    "고고하다",
    "w23338-s1",
    "w395483-s1"
  ],
  [
    "고급",
    "w22270-s1",
    "w22272-s1"
  ],
  [
    "고급",
    "w22270-s2",
    "w22272-s1"
  ],
  [
    "고기",
    "w22203-s1",
    "w22205-s1"
  ],
  [
    "고기",
    "w22203-s1",
    "w398604-s1"
  ],
  [
    "고기",
    "w22205-s1",
    "w398604-s1"
  ],
  [
    "고래",
    "w23904-s1",
    "w23905-s1"
  ],
  [
    "고탑",
    "w24777-s1",
    "w24993-s1"
  ],
  [
    "고평",
    "w26756-s1",
    "w26758-s1"
  ],
  [
    "고평",
    "w26756-s1",
    "w26758-s2"
  ],
  [
    "공로",
    "w27590-s1",
    "w27593-s1"
  ],
  [
    "공로",
    "w27592-s1",
    "w27593-s1"
  ],
  [
    "공로",
    "w27590-s1",
    "w27596-s1"
  ],
  [
    "공로",
    "w27592-s1",
    "w27596-s1"
  ],
  [
    "공로",
    "w27593-s1",
    "w27596-s1"
  ],
  [
    "공매",
    "w27341-s1",
    "w27343-s1"
  ],
  [
    "공매하다",
    "w27342-s1",
    "w27401-s1"
  ],
  [
    "공보관",
    "w29223-s1",
    "w394896-s1"
  ],
  [
    "공부",
    "w28994-s1",
    "w28996-s1"
  ],
  [
    "과자",
    "w32751-s1",
    "w32752-s1"
  ],
  [
    "관원",
    "w31793-s1",
    "w399191-s1"
  ],
  [
    "광열",
    "w398236-s1",
    "w32710-s1"
  ],
  [
    "광혹",
    "w32967-s1",
    "w32969-s1"
  ],
  [
    "괴괴하다",
    "w36214-s1",
    "w396572-s1"
  ],
  [
    "괴변",
    "w34139-s1",
    "w34206-s1"
  ],
  [
    "괴병",
    "w34208-s1",
    "w34209-s1"
  ],
  [
    "괴사",
    "w33079-s1",
    "w399574-s1"
  ],
  [
    "괴사",
    "w33079-s1",
    "w399575-s1"
  ],
  [
    "괴사",
    "w399574-s1",
    "w399575-s1"
  ],
  [
    "교무",
    "w33621-s1",
    "w33622-s1"
  ],
  [
    "교무",
    "w33621-s1",
    "w33622-s2"
  ],
  [
    "교지",
    "w34942-s1",
    "w34943-s1"
  ],
  [
    "구료",
    "w37091-s1",
    "w37092-s1"
  ],
  [
    "구료하다",
    "w399771-s1",
    "w37093-s1"
  ],
  [
    "구부",
    "w36809-s1",
    "w397518-s1"
  ],
  [
    "구수",
    "w37209-s1",
    "w37210-s1"
  ],
  [
    "구수하다",
    "w36710-s1",
    "w397499-s1"
  ],
  [
    "국세",
    "w397171-s1",
    "w397172-s1"
  ],
  [
    "국세",
    "w397171-s1",
    "w397172-s2"
  ],
  [
    "국악사",
    "w40364-s1",
    "w396621-s1"
  ],
  [
    "국악사",
    "w40364-s1",
    "w396621-s2"
  ],
  [
    "궁사",
    "w400655-s1",
    "w400656-s1"
  ],
  [
    "권매",
    "w400372-s1",
    "w40781-s1"
  ],
  [
    "권매",
    "w42822-s1",
    "w42824-s1"
  ],
  [
    "권매하다",
    "w40780-s1",
    "w42587-s1"
  ],
  [
    "권매하다",
    "w42823-s1",
    "w42825-s1"
  ],
  [
    "귀지",
    "w43818-s1",
    "w43819-s1"
  ],
  [
    "귀지",
    "w43818-s1",
    "w401012-s1"
  ],
  [
    "귀지",
    "w43819-s1",
    "w401012-s1"
  ],
  [
    "귓불",
    "w43287-s1",
    "w43288-s1"
  ],
  [
    "극화",
    "w45756-s1",
    "w401637-s1"
  ],
  [
    "극화",
    "w45756-s2",
    "w401637-s1"
  ],
  [
    "기모",
    "w50435-s1",
    "w403066-s1"
  ],
  [
    "길다",
    "w48351-s1",
    "w401753-s1"
  ],
  [
    "길다",
    "w48351-s1",
    "w401753-s2"
  ],
  [
    "길다",
    "w48351-s1",
    "w401753-s3"
  ],
  [
    "길다",
    "w48351-s1",
    "w401753-s4"
  ]
];
test('C01 reviewed cross-record identity boundaries remain split', () => {
  for (const [lemma, left, right] of crossRecordNegativeControls) {
    assert.equal(rowBySense.get(left)?.lemma, lemma, lemma + ': ' + left + ' must belong to the lemma');
    assert.equal(rowBySense.get(right)?.lemma, lemma, lemma + ': ' + right + ' must belong to the lemma');
    assert.notEqual(rowBySense.get(left)?.id, rowBySense.get(right)?.id,
      lemma + ': reviewed independent identities ' + left + ' and ' + right + ' must stay separate');
  }
});

test('C01 ga-mo separates three identities while preserving the 家母 usage group', () => {
  const nonBloodMother = rowBySense.get('w1020-s1');
  const remarriedMother = rowBySense.get('w1023-s1');
  const householdMother = rowBySense.get('w387920-s1');
  const householdHead = rowBySense.get('w387920-s2');
  assert.notEqual(nonBloodMother.id, remarriedMother.id);
  assert.notEqual(nonBloodMother.id, householdMother.id);
  assert.notEqual(remarriedMother.id, householdMother.id);
  assert.equal(householdMother.id, householdHead.id,
    'the two source-bound 家母 uses remain one identity');
});

test('C01 positive identity controls preserve valid cross-record and polysemous groups', () => {
  assert.ok(sameMeaning(['w23298-s1', 'w395675-s1']), '古道 retains its old-path and old-moral-way extensions');
  assert.ok(sameMeaning(['w27590-s1', 'w27592-s1']), '공로 retains the overlapping public-road definitions');
});

test('C01 ga-mo relation projection stays on the self-mother address Meaning', () => {
  const relevantRecords = canonicalRecords
    .filter((record) => ['w1020', 'w1023', 'w387920', 'w1523', 'w2747'].includes(record.id));
  const adjudications = readAdjudications(path.join(root, 'data/adjudication')).rows
    .filter((item) => initialCodeOf(item.lemma) === 'c01');
  const { relations } = projectMeaningRelations({ records: relevantRecords, meanings: rows, adjudications });
  const source = rowBySense.get('w387920-s1');
  const antonymTarget = rowBySense.get('w1523-s1');
  const directTarget = rowBySense.get('w2747-s1');
  const antonym = relations.find((item) => item.source_meaning_id === source.id
    && item.target_meaning_id === antonymTarget.id && item.type === 'antonym');
  const direct = relations.find((item) => item.source_meaning_id === source.id
    && item.target_meaning_id === directTarget.id && item.type === 'direct');
  assert.ok(antonym, 'the 家母 antonym to 가부 must be projected');
  assert.ok(direct, 'the 家母 synonym to 가자 must be projected');
  assert.deepEqual(antonym.sources.map((item) => item.source_sense_id), ['w387920-s1']);
  assert.deepEqual(direct.sources.map((item) => item.source_sense_id), ['w387920-s1']);
  for (const id of ['w1020-s1', 'w1023-s1']) {
    const unrelated = rowBySense.get(id);
    assert.equal(relations.some((item) => item.source_meaning_id === unrelated.id), false,
      id + ' must not inherit 家母 relations');
  }
});

test('C01 길다 growth remains separate from adjective extent and keeps adjective-bound antonymy', () => {
  const growth = rowBySense.get('w48351-s1');
  const long = rowBySense.get('w401753-s1');
  const shortRows = readdirSync(meaningDir).filter((file) => file.startsWith(initialCodeOf('짧다') + '_') && file.endsWith('.jsonl')).sort()
    .flatMap((file) => readFileSync(path.join(meaningDir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  const short = shortRows.find((row) => row.sense_ids.includes('w483382-s1'));
  assert.ok(short, 'the 짧다 target Meaning must remain live');
  assert.notEqual(growth.id, long.id,
    'the verb sense for hair or beard growing is distinct from the adjective for spatial extent');
  const relevantRecords = canonicalRecords
    .filter((record) => ['w48351', 'w401753', 'w483382'].includes(record.id));
  const adjudications = readAdjudications(path.join(root, 'data/adjudication')).rows
    .filter((item) => initialCodeOf(item.lemma) === 'c01');
  const { relations } = projectMeaningRelations({ records: relevantRecords, meanings: [...rows, ...shortRows], adjudications });
  const antonym = relations.find((item) => item.source_meaning_id === long.id
    && item.target_meaning_id === short.id && item.type === 'antonym');
  assert.ok(antonym, 'the adjective length sense must retain its source-bound antonym to 짧다');
  assert.deepEqual(antonym.sources.map((item) => item.source_sense_id).sort(),
    ['w401753-s1', 'w401753-s2', 'w401753-s3']);
  assert.equal(relations.some((item) => item.source_meaning_id === growth.id), false,
    'the adjective-bound 짧다 antonym must not project from the verb growth sense');
});
