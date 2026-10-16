import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'data/meanings');
const rows = readdirSync(dir).filter((f) => /^c16_\d+\.jsonl$/.test(f)).sort()
  .flatMap((f) => readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const meaningOf = new Map(rows.flatMap((row) => row.sense_ids.map((id) => [id, row.id])));
const spec = JSON.parse(readFileSync(path.join(root, 'scripts/meaning/issue-764-c16.json'), 'utf8'));
const sameMeaning = (ids) => ids.every((id) => meaningOf.has(id)) && new Set(ids.map((id) => meaningOf.get(id))).size === 1;
const known = (ids) => ids.every((id) => meaningOf.has(id));

test('C16 repartition spec groups are exactly the final Meaning rows', () => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const edit of spec.repartitions) {
    const covered = edit.groups.flatMap((g) => g.senses).sort();
    assert.deepEqual(covered, edit.before.flatMap((r) => r.sense_ids).sort(), `${edit.lemma}: spec must cover every before sense once`);
    for (const group of edit.groups) {
      const id = meaningOf.get(group.senses[0]);
      assert.ok(id, `${edit.lemma}: ${group.senses[0]} has no Meaning`);
      assert.deepEqual([...byId.get(id).sense_ids].sort(), [...group.senses].sort(), `${edit.lemma}: group differs from final row`);
      assert.equal(byId.get(id).gloss, group.gloss, `${edit.lemma}: gloss differs from final row`);
    }
  }
});

// Positive controls: one lexical identity whose uses differ by object, field, figure or POS-like role.
const mustMerge = [
  ['큰물', ['w492715-s1', 'w492715-s2']], // 넓은 활동 무대 비유 / 불어난 물
  ['큰손', ['w342709-s1', 'w342709-s2', 'w535122-s1']], // 귀한·많은 손님 / 시세를 움직이는 큰 거래 주체
  ['칼질', ['w340349-s1', 'w340349-s2', 'w340349-s3']], // 베기 / 편집 비유 / 칼부림 교차 참조
  ['큰곰', ['w344243-s1', 'w493524-s1']], // 같은 명명 원리: 동물과 별자리
  ['큰소리', ['w342694-s1', 'w496819-s1', 'w496819-s2', 'w496819-s3']],
  ['쌀쌀하다 analogue 카랑카랑', ['w338862-s1', 'w338862-s2']], // 목소리 / 날씨의 맑고 차가운 결
  ['카드', ['w489053-s1', 'w489053-s2', 'w489053-s3', 'w489053-s4', 'w489053-s5', 'w489053-s6', 'w489053-s7', 'w489053-s8']],
  ['쿠웨이트', ['w339419-s1', 'w492404-s1']], // 나라와 그 수도
  ['커버 보호와 방어', ['w340603-s1', 'w340603-s2']],
  ['콩과', ['w491158-s1', 'w491158-s2']], // 콩 식물과 그 식물군
  ['켤레', ['w493168-s1', 'w493169-s1']], // 일상의 한 쌍 / 수학의 대응 관계
  ['코르사주', ['w339080-s1', 'w339080-s2']], // 의복 부위 / 그 자리에 다는 장식
  ['콱', ['w491758-s1', 'w491758-s2', 'w491758-s3']],
  ['클럽', ['w345346-s2', 'w345346-s3']],
  ['큰이', ['w346076-s1', 'w346076-s2']], // 남의 맏이 / 남의 본부인: 한 집단의 으뜸
  ['콩팥', ['w340476-s1', 'w492299-s1']], // 콩과 팥 / 그 모양을 딴 장기
];
for (const [name, ids] of mustMerge) {
  test(`C16 under-merge control: ${name} is one Meaning`, () => assert.ok(sameMeaning(ids), name));
}

// Negative controls: independent homonyms must stay separate.
const mustSplit = [
  ['칼 형틀/도구', 'w339857-s1', 'w490027-s1'],
  ['칼집 보관/베인 틈', 'w340350-s1', 'w340580-s1'],
  ['큰손 풍신의 딸', 'w496821-s1', 'w535122-s1'],
  ['키 높이/배의 키', 'w343986-s1', 'w343987-s1'],
  ['키 열쇠/곡식 키', 'w495580-s1', 'w497829-s1'],
  ['켜다 점등/들이킴', 'w340756-s1', 'w340757-s1'],
  ['크리스마스 캐럴 찬송가/디킨스 소설', 'w494172-s1', 'w494172-s2'],
  ['커버 보호/탁구 모서리 타구', 'w340603-s1', 'w340603-s3'],
  ['커버 방어/탁구 모서리 타구', 'w340603-s2', 'w340603-s3'],
  ['컨버트 럭비/야구', 'w335067-s1', 'w335067-s2'],
  ['카르멘 소설/오페라', 'w342024-s1', 'w342024-s2'],
  ['칼리스토 요정/위성', 'w494515-s1', 'w494515-s2'],
  ['쾌락 즐거움/허락', 'w341534-s1', 'w341535-s1'],
  ['코 콧구멍/그물코', 'w492487-s1', 'w338024-s1'],
];
for (const [name, a, b] of mustSplit) {
  test(`C16 over-merge control: ${name} stays separate`, () => assert.ok(!sameMeaning([a, b]), name));
}

test('C16 controls fail on unknown sense ids instead of passing vacuously', () => {
  assert.equal(sameMeaning(['w000000-s1', 'w000000-s2']), false);
  assert.equal(known(['w000000-s1']), false);
  for (const [name, ids] of mustMerge) assert.ok(known(ids), `${name}: control sense ids must exist`);
  for (const [name, a, b] of mustSplit) assert.ok(known([a, b]), `${name}: control sense ids must exist`);
});
