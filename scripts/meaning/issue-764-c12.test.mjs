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
  ['약년', 'w222900-s1', 'w223419-s1'],
  ['음간', 'w255832-s1', 'w256128-s1'],
  ['음간하다', 'w256127-s1', 'w256129-s1'],
  ['연좌', 'w463507-s1', 'w463507-s2'],
  ['연좌', 'w463507-s1', 'w237725-s1'],
  ['연좌되다', 'w237447-s1', 'w237447-s2'],
  ['연좌되다', 'w237447-s1', 'w237988-s1'],
  ['연좌하다', 'w237448-s1', 'w237448-s2'],
  ['연좌하다', 'w237448-s1', 'w237989-s1'],
  ['옴쏙', 'w243693-s1', 'w245366-s1'],
  ['옴쏙옴쏙', 'w243700-s1', 'w460088-s1'],
  ['옴쏙하다', 'w243440-s1', 'w243696-s1'],
  ['옹솥', 'w247504-s1', 'w247515-s1'],
  ['아기작거리다', 'w211753-s1', 'w454994-s1'],
  ['어기적거리다', 'w225312-s1', 'w456579-s1'],
  ['암내', 'w222683-s1', 'w222684-s1'],
  ['연화좌', 'w233536-s1', 'w466549-s1'],
  ['애연하다', 'w221902-s1', 'w222150-s1'],
  ['애연히', 'w222149-s1', 'w453652-s1'],
  ['애애하다', 'w220998-s1', 'w221256-s1'],
  ['애애히', 'w221572-s1', 'w221582-s1'],
  ['애애하다', 'w221584-s2', 'w221584-s1'],
  ['애애히', 'w458045-s2', 'w458045-s1'],
  ['온온하다', 'w233066-s1', 'w244758-s1'],
  ['어구', 'w223834-s1', 'w456385-s1'],
  ['이해상반', 'w265853-s1', 'w265854-s1'],
  ['이해상반하다', 'w265855-s1', 'w517159-s1'],
];
// 같은 어휘의 변주·준말이어서 병합 상태여야 하는 대조군.
const merged = [
  ['앵순', 'w219228-s2', 'w223417-s1'],
  ['약언', 'w226610-s2', 'w226612-s1'],
  ['연좌', 'w463507-s2', 'w237725-s1'],
  ['연좌되다', 'w237447-s2', 'w237988-s1'],
  ['연좌하다', 'w237448-s2', 'w237989-s1'],
  ['애애하다', 'w220998-s1', 'w221584-s2'],
  ['애애히', 'w221572-s1', 'w458045-s2'],
  ['애연하다', 'w221902-s1', 'w222983-s1'],
  ['애연히', 'w222149-s1', 'w222984-s1'],
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

// 다른 표제어를 가리키는 풀이('X의 원말/준말', 'X를 달리 이르는 말')는 그 대상의 어휘와 같은 Meaning일 때만 의미가 있다.
// 포인터 풀이 record가 포인터 아닌 record와 섞인 교차-record 병합은 허용 목록(같은 어휘의 태/변주)으로만 인정한다.
test('pointer-gloss records are never merged with unrelated-meaning records', () => {
  const pointer = /[\u2018'][^\u2019']*[\u2019'](?:\S{0,8})?(?:의 (?:원말|준말|본말|센말|여린말|큰말|작은말|사동사|피동사|방언)|[를을] (?:달리|속되게|낮잡아|높여|강조하여) 이르는 말)/;
  const allowed = new Set(['안기다']); // 피동/사동 형태의 같은 어휘
  const offenders = [];
  for (const rep of spec.repartitions) {
    const gloss = new Map(rep.before.flatMap((row) => row.sense_ids.map((id) => [id, row.gloss.trim()])));
    for (const group of rep.groups) {
      const byRecord = new Map();
      for (const id of group.senses) {
        const record = id.split('-')[0];
        byRecord.set(record, [...(byRecord.get(record) ?? []), gloss.get(id)]);
      }
      if (byRecord.size < 2) continue;
      const flags = [...byRecord.values()].map((list) => list.every((g) => pointer.test(g)));
      if (flags.some(Boolean) && !flags.every(Boolean) && !allowed.has(rep.lemma)) offenders.push(rep.lemma);
    }
  }
  assert.deepEqual(offenders, []);
});

// 서로 다른 STDICT record는 기본적으로 독립 동음이의어다. 교차-record 병합은 아래 근거가 있는 lemma에만 허용한다:
// 같은 성(姓) record, 같은 어휘의 피동·사동 형태, 풀이가 거의 같은 중복 record, 그리고 리뷰에서 같은 어휘로 확인된 사례.
// 목록에 없는 lemma가 교차-record 병합에 나타나면 근거를 추가하기 전까지 실패한다.
const allowedCrossRecord = new Set([
  '양', '여', '연', '유', '이', '임',
  '안기다', '업히다', '읽히다', '옹다물리다', '얼리다',
  '양월', '약언', '앵순', '연좌', '연좌되다', '연좌하다', '애애하다', '애애히', '애연하다', '애연히', '양양하다',
  '양명하다', '의기하다', '왜식', '영재', '양찰', '양찰하다', '예람', '예람하다', '예참', '예참하다',
  '여읍여소', '여읍여소하다', '어선', '양방', '연철', '연수', '연수하다',
]);
test('cross-record merges are limited to lemmas with a documented identity basis', () => {
  const lemmas = new Set();
  for (const rep of spec.repartitions) {
    for (const group of rep.groups) {
      if (new Set(group.senses.map((id) => id.split('-')[0])).size > 1) lemmas.add(rep.lemma);
    }
  }
  assert.deepEqual([...lemmas].filter((lemma) => !allowedCrossRecord.has(lemma)).sort(), []);
});
