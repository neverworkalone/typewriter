import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Editorial regressions for the Issue #764 C13 re-edit. They pin source-bound decisions, not a string rule: a lemma's
// source senses must either share one Meaning (one lexical identity whose uses differ by object, field, figure or voice)
// or stay apart (independent homonyms, proper names, unrelated acts that only share a form).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'data/meanings');
const rows = readdirSync(dir).filter((name) => /^c13_\d+\.jsonl$/u.test(name)).sort()
  .flatMap((name) => readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
const meaningOf = new Map(rows.flatMap((row) => row.sense_ids.map((id) => [id, row.id])));
const spec = JSON.parse(readFileSync(path.join(root, 'scripts/meaning/issue-764-c13.json'), 'utf8')).repartitions;
const known = (ids) => ids.every((id) => meaningOf.has(id));
const sameMeaning = (ids) => known(ids) && new Set(ids.map((id) => meaningOf.get(id))).size === 1;

test('C13 repartition spec groups are exactly the final Meaning rows', () => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const lemmas = new Set();
  for (const edit of spec) {
    assert.ok(!lemmas.has(edit.lemma), `${edit.lemma}: repartitioned twice`);
    lemmas.add(edit.lemma);
    const before = edit.before.flatMap((row) => row.sense_ids).sort();
    const covered = edit.groups.flatMap((group) => group.senses).sort();
    assert.deepEqual(covered, before, `${edit.lemma}: groups must cover every before sense exactly once`);
    assert.ok(edit.groups.length <= edit.before.length, `${edit.lemma}: a repartition must not split a Meaning`);
    for (const group of edit.groups) {
      const id = meaningOf.get(group.senses[0]);
      assert.ok(id, `${edit.lemma}: ${group.senses[0]} has no Meaning`);
      const row = byId.get(id);
      assert.equal(row.lemma, edit.lemma, `${edit.lemma}: final row belongs to another lemma`);
      assert.deepEqual([...row.sense_ids].sort(), [...group.senses].sort(), `${edit.lemma}: group differs from final row`);
      assert.equal(row.gloss, group.gloss, `${edit.lemma}: gloss differs from final row`);
    }
  }
});

test('C13 merged glosses keep every source usage gloss', () => {
  for (const edit of spec) {
    const sourceGloss = new Map(edit.before.map((row) => [row.id, row.gloss]));
    for (const group of edit.groups) {
      const members = edit.before.filter((row) => row.sense_ids.some((id) => group.senses.includes(id)));
      if (members.length === 1) continue;
      for (const member of members) {
        assert.ok(group.gloss.includes(sourceGloss.get(member.id)), `${edit.lemma}: merged gloss dropped the gloss of ${member.id}`);
      }
    }
  }
});

// Positive controls: one lexical identity whose uses differ by object, field, figure, voice or record.
const mustMerge = [
  ['좋다 성질·성품·날씨·적합', ['w302141-s1', 'w302141-s10', 'w302141-s19']],
  ['죽다 생명·불·색·효력', ['w480678-s1', 'w480678-s4', 'w480678-s12']],
  ['지르다 내지르기·불 붙이기·약 타기', ['w484111-s1', 'w484111-s8', 'w484111-s9']],
  ['줄이다 길이·분량·기간·말끝', ['w480097-s1', 'w480097-s6']],
  ['주다 건네기·허용·감정', ['w482489-s1', 'w482489-s12']],
  ['중성 중간적 성질·전하·성(性)', ['w483023-s1', 'w483023-s6']],
  ['지나가다 시간·장소·표정', ['w487197-s1', 'w487197-s9']],
  ['지다 짊어지기·빚·책임', ['w307853-s1', 'w307853-s6']],
  ['지다 해가 지다·시들다·목숨', ['w486281-s1', 'w486281-s8']],
  ['집 건물·가족·바둑의 집', ['w485034-s1', 'w485034-s10']],
  ['쥐 설치류 총칭과 종', ['w486294-s1', 'w486294-s2']],
  ['질 속성·바탕·판단', ['w488559-s1', 'w488559-s3']],
  ['진 수액과 눅눅한 끈끈이', ['w480474-s1', 'w480474-s2']],
  ['지게 운반 도구와 그 분량 단위', ['w479445-s1', 'w479445-s2']],
  ['중 등급·여럿·동안·속', ['w488715-s1', 'w488715-s9']],
  ['줄 끈과 선·인연의 은유', ['w479828-s1', 'w479828-s12']],
  ['주 구세주와 유일신', ['w303406-s1', 'w303406-s3']],
  ['주 일주일과 그 단위', ['w303699-s1', 'w303699-s2']],
  ['좌우 양쪽·측근·좌익과 우익', ['w300640-s1', 'w300640-s6']],
  ['중간 사이·가운데·중개', ['w481053-s1', 'w481053-s6']],
  ['짓다 밥·약·글·표정·이름', ['w486065-s1', 'w486065-s12']],
  ['지키다 재산·길목·약속·절개', ['w488705-s1', 'w488705-s5']],
  ['죄 양심·벌·종교적 죄', ['w485858-s1', 'w485858-s5']],
  ['죄다 조이기·긴장·압박', ['w481757-s1', 'w481757-s5']],
  ['주사 방송 화면 훑기와 파일 검색', ['w483071-s1', 'w483071-s2']],
  ['죽 부사의 모양 용법', ['w482737-s1', 'w482737-s11']],
  ['준행되다 서로 다른 record의 같은 피동', ['w308704-s1', 'w308707-s1']],
  ['질책하다 서로 다른 record의 같은 행위', ['w315258-s1', 'w315261-s1']],
  ['질정하다 서로 다른 record의 같은 행위', ['w317999-s1', 'w318251-s1']],
];
for (const [name, ids] of mustMerge) {
  test(`C13 under-merge control: ${name} is one Meaning`, () => assert.ok(sameMeaning(ids), name));
}

// Negative controls: independent homonyms, proper names and unrelated acts must stay separate.
const mustSplit = [
  ['죽 죽(粥)/대나무 관악기', 'w299830-s1', 'w299829-s1'],
  ['죽 죽(粥)/부사', 'w299830-s1', 'w482737-s1'],
  ['죽다 칼날이 무뎌지다/생명', 'w309257-s1', 'w480678-s1'],
  ['지르다 소리치다/내지르다', 'w312902-s1', 'w484111-s1'],
  ['지르다 내지르다/지름길로 가다', 'w484111-s1', 'w485540-s1'],
  ['주다 신라 외위/건네다', 'w306150-s1', 'w482489-s1'],
  ['중성 음절의 모음/전하가 없는 상태', 'w301323-s1', 'w483023-s1'],
  ['지다 패하다/짊어지다', 'w307852-s1', 'w307853-s1'],
  ['지다 짊어지다/그렇게 되다', 'w307853-s1', 'w481022-s3'],
  ['짐 임금의 1인칭/꾸러미', 'w308824-s1', 'w484460-s1'],
  ['쥐 경련/설치류', 'w308503-s1', 'w486294-s1'],
  ['집 시문집/건물', 'w318259-s1', 'w485034-s1'],
  ['질 여성 생식 통로/질그릇 흙', 'w310707-s1', 'w311650-s1'],
  ['질 질그릇 흙/속성', 'w311650-s1', 'w488559-s1'],
  ['진 끈끈한 수액/피부 이상 물질', 'w480474-s2', 'w485269-s1'],
  ['진 십이지 진/군대 진', 'w312708-s1', 'w312710-s1'],
  ['징 신발 못/타악기', 'w319510-s1', 'w483532-s1'],
  ['지게 문/운반 도구', 'w297466-s1', 'w479445-s1'],
  ['중 승려/등급·가운데', 'w480663-s1', 'w488715-s1'],
  ['중 중국/승려', 'w304907-s1', 'w480663-s1'],
  ['줄 쇠붙이 연장/끈', 'w309266-s1', 'w479828-s1'],
  ['주 구세주/붉은빛', 'w303406-s1', 'w303408-s1'],
  ['주 일주일/주식', 'w303699-s1', 'w483977-s6'],
  ['중간 책 거듭 간행/사이', 'w306108-s1', 'w481053-s1'],
  ['짓다 예스러운 사동 형태/만들다', 'w321955-s1', 'w486065-s1'],
  ['죄 남김없이/잘못', 'w308201-s1', 'w485858-s1'],
  ['죄다 남김없이/조이다', 'w305551-s1', 'w481757-s1'],
  ['주사 약액 주입/주장하여 부림', 'w483072-s1', 'w306158-s1'],
];
for (const [name, a, b] of mustSplit) {
  test(`C13 over-merge control: ${name} stays separate`, () => assert.ok(known([a, b]) && !sameMeaning([a, b]), name));
}

test('C13 controls fail on unknown sense ids instead of passing vacuously', () => {
  assert.equal(sameMeaning(['w000000-s1', 'w000000-s2']), false);
  assert.equal(known(['w000000-s1']), false);
  assert.equal(known([]), true);
  for (const [name, ids] of mustMerge) assert.ok(known(ids), `${name}: control sense ids must exist`);
  for (const [name, a, b] of mustSplit) assert.ok(known([a, b]), `${name}: control sense ids must exist`);
});

test('audit table matches the checked-in C13 shards and repartition spec', () => {
  const num = (text) => Number(text.replaceAll(',', ''));
  const audit = readFileSync(path.join(root, 'scripts/meaning/issue-764-c13-audit.md'), 'utf8');
  const cell = (label) => {
    const line = audit.split('\n').find((row) => row.startsWith(`| ${label}`));
    assert.ok(line, `audit row missing: ${label}`);
    return line.split('|').map((part) => part.trim());
  };
  const perLemma = new Map();
  for (const row of rows) perLemma.set(row.lemma, (perLemma.get(row.lemma) ?? 0) + 1);
  // The repository-wide total is deliberately not pinned: any later range PR changes it, which would leave this test stale.
  const reduced = spec.reduce((sum, edit) => sum + edit.before.length - edit.groups.length, 0);
  const beforeRows = spec.reduce((sum, edit) => sum + edit.before.length, 0);
  assert.equal(num(cell('C13 lemmas')[3]), perLemma.size);
  assert.equal(num(cell('C13 Meaning rows')[3]), rows.length);
  assert.equal(num(cell('다중 Meaning lemma')[3]), [...perLemma.values()].filter((count) => count > 1).length);
  assert.equal(num(cell('재분할(repartition) 적용 lemma')[3]), spec.length);
  assert.equal(num(cell('병합으로 줄어든 Meaning 행')[3]), reduced);
  assert.equal(num(cell('C13 Meaning rows')[2]), rows.length + reduced);
  assert.ok(beforeRows >= reduced);
});
