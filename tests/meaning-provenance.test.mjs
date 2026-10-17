import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { extractLiteDictionary } from '../scripts/build/lite-dictionary.mjs';
import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { MEANING_INTEGRITY_QUERIES } from '../src/runtime/dictionary-contract.js';
import { projectDirectReverses } from '../scripts/build/direct-reverse.mjs';
import { projectRecordMeanings, projectMeaningRelations } from '../scripts/build/record-meanings.mjs';
import { MEANING_SOURCE_INTEGRITY_QUERIES, glossReferenceViolations } from '../scripts/build/meaning-source-checks.mjs';
import { parseArrowReference, projectGlossReferences } from '../scripts/build/gloss-arrow-reference.mjs';
import { validatePackagedDictionary } from '../src/runtime/dictionary-validation.js';

const record = (n, lemma, senses) => ({
  id: `w00${n}`, record_type: 'entry', role: 'start', candidate_id: `w00${n}`, lemma, search_forms: [lemma],
  senses: senses.map(([gloss, relations], index) => ({
    id: `w00${n}-s${index + 1}`, pos: 'noun', gloss, ...(relations ? { relations } : {}),
  })),
});
const direct = (target_sense) => ({ target: target_sense.split('-')[0], target_sense, type: 'direct', note: '표준국어대사전 동의어' });

// w001's two senses are one record meaning; both reach w002-s1 (one deduplicated meaning relation, two sources) and s2 reaches w003-s1.
const RECORDS = [
  record(1, '가나', [['첫째 뜻풀이.', [{ ...direct('w002-s1'), type: 'near', note: '첫째 근거', relevance: 2 }]], ['둘째 뜻풀이.', [{ ...direct('w002-s1'), type: 'near', note: '둘째 근거', relevance: 4 }, direct('w003-s1')]]]),
  record(2, '다라', [['다라의 뜻풀이.']]),
  record(3, '마바', [['마바의 뜻풀이.']]),
];
async function buildFixture(directory, records = RECORDS) {
  const canonicalDirectory = path.join(directory, 'canonical');
  await mkdir(canonicalDirectory);
  await writeFile(path.join(canonicalDirectory, 'part.jsonl'), `${records.map((item) => JSON.stringify(item)).join('\n')}\n`);
  const outputPath = path.join(directory, 'dictionary.sqlite');
  await buildDictionary({
    inputDirectory: canonicalDirectory,
    outputPath,
    allowDirty: true,
    recordMeanings: true,
  });
  // The source-derived checks run on the Full database; the Lite product database is extracted from it.
  const litePath = path.join(directory, 'lite.sqlite');
  await extractLiteDictionary({ fullPath: outputPath, litePath });
  return { deployed: litePath, full: outputPath };
}

function violations(databasePath, mutate = () => {}) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON');
    mutate(database);
    return Object.fromEntries(Object.entries({ ...MEANING_INTEGRITY_QUERIES, ...MEANING_SOURCE_INTEGRITY_QUERIES })
      .map(([name, sql]) => [name, Number(Object.values(database.prepare(sql).get())[0])])
      .filter(([, count]) => count !== 0));
  } finally {
    database.close();
  }
}

test('meaning relation provenance: valid mapping passes; deleted, mis-bound and missing provenance fail', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-provenance-'));
  try {
    const { deployed, full: good } = await buildFixture(directory);
    const database = new DatabaseSync(good, { readOnly: true });
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM meaning_relations').get().c, 3);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM meaning_relation_sources').get().c, 3);
    database.close();
    const shipped = new DatabaseSync(deployed, { readOnly: true });
    assert.equal(shipped.prepare('SELECT COUNT(*) AS c FROM meaning_relations').get().c, 3);
    assert.deepEqual(
      shipped.prepare("SELECT name FROM sqlite_master WHERE name IN ('senses', 'relations', 'meaning_relation_sources', 'meaning_relation_gloss_sources', 'meaning_relation_reverse_sources')").all(),
      [],
    );
    shipped.close();
    const shippedChecked = new DatabaseSync(deployed, { readOnly: true });
    // Source-derived checks need the Full tables; the shipped database runs only its self-contained checks.
    assert.doesNotThrow(() => validatePackagedDictionary(shippedChecked, { expectedSourceRevision: undefined }));
    shippedChecked.close();
    assert.deepEqual(violations(good), {});

    const copy = (name) => path.join(directory, name);
    await copyFile(good, copy('deleted.sqlite'));
    assert.deepEqual(
      violations(copy('deleted.sqlite'), (db) => db.exec(
        "DELETE FROM meaning_relation_sources WHERE source_sense_id = 'w001-s2' AND source_position = 1",
      )),
      { meaning_relation_without_provenance: 1, projectable_relation_without_provenance: 1 },
    );

    // Same row count, but two provenance rows point at each other's (existing) original relation.
    await copyFile(good, copy('misbound.sqlite'));
    const misbound = violations(copy('misbound.sqlite'), (db) => {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`
        UPDATE meaning_relation_sources SET source_position = 100 WHERE source_sense_id = 'w001-s2' AND source_position = 0;
        UPDATE meaning_relation_sources SET source_position = 0 WHERE source_sense_id = 'w001-s2' AND source_position = 1;
        UPDATE meaning_relation_sources SET source_position = 1 WHERE source_sense_id = 'w001-s2' AND source_position = 100;
      `);
    });
    assert.ok(misbound.meaning_relation_source_mismatch > 0, JSON.stringify(misbound));

    // Typewriter-authored relation without STDICT provenance is valid; an unknown origin is rejected by the schema.
    await copyFile(good, copy('authored.sqlite'));
    assert.deepEqual(violations(copy('authored.sqlite'), (db) => db.exec(
      "INSERT INTO meaning_relations (source_meaning_id, position, target_meaning_id, type, note, relevance, origin) "
      + "VALUES ('m002', 0, 'm003', 'near', '작성한 연관', 3, 'typewriter-authored')",
    )), {});
    await copyFile(good, copy('origin.sqlite'));
    assert.throws(() => violations(copy('origin.sqlite'), (db) => db.exec(
      "UPDATE meaning_relations SET origin = 'other' WHERE source_meaning_id = 'm001' AND position = 0",
    )), /CHECK/);

    // Relabelling a projected relation as authored does not bypass the source checks.
    await copyFile(good, copy('relabel.sqlite'));
    assert.ok(violations(copy('relabel.sqlite'), (db) => db.exec(
      "UPDATE meaning_relations SET origin = 'typewriter-authored' WHERE source_meaning_id = 'm001' AND position = 0",
    )).meaning_relation_provenance_on_non_projection > 0);
    await copyFile(good, copy('relabel-clean.sqlite'));
    assert.ok(violations(copy('relabel-clean.sqlite'), (db) => db.exec(`
      DELETE FROM meaning_relation_sources WHERE source_meaning_id = 'm001' AND relation_position = 0;
      UPDATE meaning_relations SET origin = 'typewriter-authored' WHERE source_meaning_id = 'm001' AND position = 0;
    `)).projectable_relation_without_provenance > 0);

    // Displayed note/relevance must equal the first contributing source relation (here w001-s1's, not w001-s2's).
        const stored = new DatabaseSync(good, { readOnly: true });
    const row = stored.prepare("SELECT note, relevance FROM meaning_relations WHERE source_meaning_id = 'm001' AND target_meaning_id = 'm002'").get();
    stored.close();
    assert.deepEqual({ ...row }, { note: '첫째 근거', relevance: 2 });
    for (const [name, sql] of [
      ['note', "UPDATE meaning_relations SET note = '허위 원본 근거' WHERE source_meaning_id = 'm001' AND target_meaning_id = 'm002'"],
      ['relevance', "UPDATE meaning_relations SET relevance = 9 WHERE source_meaning_id = 'm001' AND target_meaning_id = 'm002'"],
      ['priority', "UPDATE meaning_relations SET note = '둘째 근거', relevance = 4 WHERE source_meaning_id = 'm001' AND target_meaning_id = 'm002'"],
    ]) {
      await copyFile(good, copy(`${name}.sqlite`));
      assert.ok(violations(copy(`${name}.sqlite`), (db) => db.exec(sql)).meaning_relation_content_mismatch > 0, name);
    }
    // Reordering the provenance ordinals and the displayed values together must not bypass the canonical-first rule.
    await copyFile(good, copy('reordered.sqlite'));
    const reordered = violations(copy('reordered.sqlite'), (db) => {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`
        UPDATE meaning_relation_sources SET position = 100 WHERE source_sense_id = 'w001-s1' AND source_position = 0;
        UPDATE meaning_relation_sources SET position = 0 WHERE source_sense_id = 'w001-s2' AND source_position = 0;
        UPDATE meaning_relation_sources SET position = 1 WHERE source_sense_id = 'w001-s1' AND source_position = 0;
        UPDATE meaning_relations SET note = '둘째 근거', relevance = 4 WHERE source_meaning_id = 'm001' AND target_meaning_id = 'm002';
      `);
    });
    assert.deepEqual(reordered, { meaning_relation_source_order_violation: 1 });

    // Swapping the positions of two projected relations (and their provenance links) changes the product order only.
    await copyFile(good, copy('swapped.sqlite'));
    const swapped = violations(copy('swapped.sqlite'), (db) => {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`
        UPDATE meaning_relations SET position = 100 WHERE source_meaning_id = 'm001' AND position = 0;
        UPDATE meaning_relation_sources SET relation_position = 100 WHERE source_meaning_id = 'm001' AND relation_position = 0;
        UPDATE meaning_relations SET position = 0 WHERE source_meaning_id = 'm001' AND position = 1;
        UPDATE meaning_relation_sources SET relation_position = 0 WHERE source_meaning_id = 'm001' AND relation_position = 1;
        UPDATE meaning_relations SET position = 1 WHERE source_meaning_id = 'm001' AND position = 100;
        UPDATE meaning_relation_sources SET relation_position = 1 WHERE source_meaning_id = 'm001' AND relation_position = 100;
      `);
    });
    // The reverse relation m003 -> m001 points at its forward by position, so the swap breaks that link too.
    assert.deepEqual(swapped, { meaning_relation_position_order_violation: 1, reverse_relation_mismatch: 1 });

    // An authored relation owns its own note/relevance and is not compared with STDICT.
    await copyFile(good, copy('authored-content.sqlite'));
    assert.deepEqual(violations(copy('authored-content.sqlite'), (db) => db.exec(
      "INSERT INTO meaning_relations (source_meaning_id, position, target_meaning_id, type, note, relevance, origin) "
      + "VALUES ('m002', 0, 'm001', 'mood', '자체 근거', 9, 'typewriter-authored')",
    )), {});

    await copyFile(good, copy('flag.sqlite'));
    assert.ok(violations(copy('flag.sqlite'), (db) => db.exec(
      'UPDATE meaning_relation_sources SET target_redirected = 1',
    )).meaning_relation_source_mismatch > 0);

    await copyFile(deployed, copy('shipped-tampered.sqlite'));
    const tampered = new DatabaseSync(copy('shipped-tampered.sqlite'));
    try {
      tampered.exec("DELETE FROM meaning_relations WHERE source_meaning_id = 'm001' AND position = 0");
      assert.throws(() => validatePackagedDictionary(tampered), (error) => error.code !== undefined);
    } finally {
      tampered.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Issue #797: every original direct is shown in both directions. Issue #834: a `→` gloss reference is a direct too.
const typed = (n, lemma, gloss, relations) => ({
  id: `w00${n}`, record_type: 'entry', role: 'start', candidate_id: `w00${n}`, lemma, search_forms: [lemma],
  senses: [{ id: `w00${n}-s1`, pos: 'noun', gloss, ...(relations ? { relations } : {}) }],
});
const DIRECT_RECORDS = [
  typed(10, '원본가', '원본 뜻 가.', [direct('w0011-s1')]),   // reverse missing -> derived
  typed(11, '원본나', '원본 뜻 나.'),
  typed(12, '원본다', '원본 뜻 다.', [direct('w0013-s1')]),   // mirrors each other: no duplicate
  typed(13, '원본라', '원본 뜻 라.', [direct('w0012-s1')]),
  typed(14, '원본마', '원본 뜻 마.', [{ ...direct('w0015-s1'), type: 'antonym', note: '반의' }, { ...direct('w0015-s1'), type: 'near', note: '근접', relevance: 3 }]),
  typed(15, '원본바', '원본 뜻 바.'),
  typed(16, '비표준', '→ 원본바.'),                              // a gloss reference: forward row + derived reverse (Issue #834)
];

test('direct reverse projection: only direct is mirrored and never twice', () => {
  const records = DIRECT_RECORDS.map((item) => ({ ...item, senses: item.senses.map((sense) => ({ relations: [], ...sense })) }));
  const meanings = projectRecordMeanings(records);
  const { relations: original } = projectMeaningRelations({ records, meanings });
  const { relations, stats } = projectDirectReverses({ relations: original });
  assert.deepEqual(relations.map((r) => `${r.source_meaning_id}>${r.target_meaning_id}:${r.type}:${r.origin}`), [
    'm0011>m0010:direct:direct-reverse-projection',
  ]);
  assert.deepEqual(stats, { reverse_count: 1, reverse_existing_count: 2 });
  assert.deepEqual(relations[0].reverse_of, { source_meaning_id: 'm0010', position: 0 });
  assert.equal(relations[0].note, original[0].note);
  // Idempotent over its own output: a reverse is never mirrored again.
  assert.deepEqual(projectDirectReverses({ relations: [...original, ...relations] }).relations, []);
});

test('derived reverse provenance: valid build passes; forged, missing and mismatched reverses fail', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-derived-'));
  try {
    const { deployed, full: good } = await buildFixture(directory, DIRECT_RECORDS);
    assert.deepEqual(violations(good), {});
    const shipped = new DatabaseSync(deployed, { readOnly: true });
    // The shipped database holds no derivation tables, yet still proves every direct is shown in both directions.
    assert.deepEqual(Object.entries(MEANING_INTEGRITY_QUERIES).filter(([, sql]) => Number(Object.values(shipped.prepare(sql).get())[0]) !== 0), []);
    assert.equal(shipped.prepare("SELECT COUNT(*) AS c FROM meaning_relations WHERE origin = 'direct-reverse-projection'").get().c, 2);
    shipped.close();
    const database = new DatabaseSync(good, { readOnly: true });
    assert.equal(Number(database.prepare('SELECT COUNT(*) AS c FROM meaning_relation_reverse_sources').get().c), 2);
    // Derived rows are never recorded as original source positions.
    assert.equal(Number(database.prepare(
      "SELECT COUNT(*) AS c FROM meaning_relation_sources AS s JOIN meaning_relations AS r ON r.source_meaning_id = s.source_meaning_id AND r.position = s.relation_position WHERE r.origin <> 'stdict-sense-projection'",
    ).get().c), 0);
    // The reference gloss is a forward row from the referencing meaning, mirrored back by a derived reverse.
    assert.deepEqual(
      database.prepare("SELECT source_meaning_id AS s, target_meaning_id AS t, origin FROM meaning_relations WHERE source_meaning_id = 'm0016' OR target_meaning_id = 'm0016' ORDER BY origin").all().map((row) => ({ ...row })),
      [{ s: 'm0015', t: 'm0016', origin: 'direct-reverse-projection' }, { s: 'm0016', t: 'm0015', origin: 'stdict-gloss-reference' }],
    );
    database.close();

    const copy = (name) => path.join(directory, name);
    const mutate = async (name, sql, off = false) => {
      await copyFile(good, copy(`${name}.sqlite`));
      return violations(copy(`${name}.sqlite`), (db) => { if (off) db.exec('PRAGMA foreign_keys = OFF'); db.exec(sql); });
    };
    assert.equal((await mutate('no-provenance', 'DELETE FROM meaning_relation_reverse_sources')).reverse_relation_without_provenance, 2);
    assert.ok((await mutate('one-way', "DELETE FROM meaning_relations WHERE origin = 'direct-reverse-projection'")).direct_relation_without_reverse > 0);
    assert.ok((await mutate('note', "UPDATE meaning_relations SET note = '위조' WHERE origin = 'direct-reverse-projection'")).reverse_relation_mismatch > 0);
    assert.ok((await mutate('type', "UPDATE meaning_relations SET type = 'near' WHERE origin = 'direct-reverse-projection'")).reverse_relation_mismatch > 0);
    assert.ok((await mutate('chain', "UPDATE meaning_relation_reverse_sources SET forward_source_meaning_id = 'm0011', forward_position = 0", true)).reverse_relation_mismatch > 0);
    assert.ok((await mutate('relabel', "UPDATE meaning_relations SET origin = 'typewriter-authored' WHERE origin = 'direct-reverse-projection'", true)).reverse_relation_mismatch > 0);

    // Gloss-reference evidence (Issue #834): the same Full database passes, and every kind of tampering is caught.
    const glossViolations = async (name, sql, off = true) => {
      await copyFile(good, copy(`${name}.sqlite`));
      const db = new DatabaseSync(copy(`${name}.sqlite`));
      try {
        if (off) db.exec('PRAGMA foreign_keys = OFF');
        db.exec(sql);
        return { ...glossReferenceViolations(db), ...Object.fromEntries(Object.entries(MEANING_SOURCE_INTEGRITY_QUERIES)
          .filter(([key]) => key.startsWith('gloss_')).map(([key, query]) => [key, Number(Object.values(db.prepare(query).get())[0])])) };
      } finally { db.close(); }
    };
    const clean = await glossViolations('gloss-clean', 'SELECT 1');
    assert.ok(Object.values(clean).every((count) => count === 0), JSON.stringify(clean));
    assert.equal((await glossViolations('gloss-missing', 'DELETE FROM meaning_relation_gloss_sources')).gloss_reference_evidence_missing, 1);
    assert.equal((await glossViolations('gloss-no-evidence', 'DELETE FROM meaning_relation_gloss_sources')).gloss_relation_without_evidence, 1);
    assert.equal((await glossViolations('gloss-offset', 'UPDATE meaning_relation_gloss_sources SET gloss_offset = 3')).gloss_reference_evidence_mismatch, 1);
    assert.equal((await glossViolations('gloss-text', "UPDATE meaning_relation_gloss_sources SET reference_text = '원본가'")).gloss_reference_evidence_mismatch, 1);
    assert.equal((await glossViolations('gloss-target', "UPDATE meaning_relation_gloss_sources SET target_record_id = 'w0014'")).gloss_reference_evidence_mismatch, 1);
    assert.equal((await glossViolations('gloss-relation', "UPDATE meaning_relations SET target_meaning_id = 'm0014' WHERE origin = 'stdict-gloss-reference'")).gloss_reference_evidence_mismatch, 1);
    assert.equal((await glossViolations('gloss-type', "UPDATE meaning_relations SET type = 'near' WHERE origin = 'stdict-gloss-reference'")).gloss_relation_without_evidence, 1);
    // Evidence invented for a gloss that is no reference.
    assert.equal((await glossViolations('gloss-forged', "INSERT INTO meaning_relation_gloss_sources VALUES ('m0010', 0, 5, 'w0010-s1', 2, '원본나', 'w0011', NULL)")).gloss_reference_evidence_forged, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Issue #834: the `→` grammar and the exact-target resolution, over valid, unusual and invalid forms.
test('arrow reference grammar: a table of valid, unusual and invalid glosses', () => {
  const table = [
    // gloss, expected [headword, homograph_no, sense_no, group, token] or reason
    ['→ 희롱질.', ['희롱질', null, null, null, '희롱질']],
    ['→ 포수03.', ['포수', 3, null, null, '포수03']],
    ['→ 강낭콩「1」.', ['강낭콩', null, 1, null, '강낭콩「1」']],
    ['→ 감잡이02「3」.', ['감잡이', 2, 3, null, '감잡이02「3」']],
    ['→ 고수레02[Ⅱ].', ['고수레', 2, null, 'Ⅱ', '고수레02[Ⅱ]']],
    ['→ 둘째[Ⅰ].', ['둘째', null, null, 'Ⅰ', '둘째[Ⅰ]']],
    ['→ 리넨01(linen).', ['리넨', 1, null, null, '리넨01(linen)']],
    ['→ 누룽지「1」', ['누룽지', null, 1, null, '누룽지「1」']],
    ['→ ‘바둑돌’', ['바둑돌', null, null, null, '‘바둑돌’']],
    ['→ 거덜02. ‘거덜02’을 한자를 빌려서 쓴 말이다.', ['거덜', 2, null, null, '거덜02']],
    ['→ 큰 집.', ['큰 집', null, null, null, '큰 집']],
    ['→ -하다.', ['-하다', null, null, null, '-하다']],
    ['→ .', 'malformed'],
    ['→ 군호_.', 'malformed'],
    ['→ ‘바둑돌.', 'malformed'],
    ['→ 바둑돌’.', 'malformed'],
    ['→ 가나다「0」.', 'malformed'],
    ['→ 가나다02형.', 'malformed'],
    ['→ A형.', 'malformed'],
    ['→ 가나다. 나다', ['가나다', null, null, null, '가나다']],
    ['→지각06.', null],
    ['뜻. → 까치발02.', null],
    ['S(문장)→NP(명사구)+VP(동사구)', null],
    ['', null],
  ];
  for (const [gloss, expected] of table) {
    const parsed = parseArrowReference(gloss);
    if (expected === null) assert.equal(parsed, null, gloss);
    else if (typeof expected === 'string') assert.deepEqual(parsed, { ok: false, reason: expected }, gloss);
    else {
      assert.equal(parsed.ok, true, gloss);
      assert.deepEqual([parsed.headword, parsed.homograph_no, parsed.sense_no, parsed.group, parsed.text], expected, gloss);
      assert.equal(gloss.slice(parsed.offset, parsed.offset + parsed.text.length), parsed.text, gloss);
    }
  }
});

const withHomograph = (n, lemma, homograph_no, senses) => ({ ...record(n, lemma, senses), homograph_no });
const projectGloss = (records, relations = null) => {
  const full = records.map((item) => ({ ...item, senses: item.senses.map((sense) => ({ relations: [], ...sense })) }));
  const meanings = projectRecordMeanings(full);
  const original = relations ?? projectMeaningRelations({ records: full, meanings }).relations;
  return { meanings, ...projectGlossReferences({ records: full, meanings, relations: original }) };
};
const summary = (relations) => relations.map((r) => `${r.source_meaning_id}>${r.target_meaning_id}:${r.type}:${r.origin}`);

test('gloss reference projection: exact targets only, held otherwise, original direct respected', () => {
  const { relations, holds, stats } = projectGloss([
    record(20, '희닥거리', [['→ 희롱질.']]),                       // plain unique target
    record(21, '희롱질', [['서로 놀리는 짓.']]),
    withHomograph(22, '포수', 3, [['사냥꾼.']]),                    // numbered target
    withHomograph(23, '포수', 4, [['대포 쏘는 사람.']]),
    record(24, '소포수', [['→ 포수03.']]),                         // picks 03, not 04
    record(25, '대포수', [['→ 포수.']]),                           // plain reference to a homograph pair: ambiguous
    record(26, '없는말', [['→ 존재하지않음.']]),                    // no such record
    record(27, '자기', [['→ 자기.']]),                             // self reference
    record(28, '범위', [['→ 희롱질「9」.']]),                       // sense beyond the target's senses
    record(29, '둘째뜻', [['→ 희롱질「1」.'], ['→ 희롱질.']]),      // two glosses, one pair, both kept as evidence
    record(30, '고리', [['→ 연쇄.']]),                             // chain: names 연쇄, not what 연쇄 names
    record(31, '연쇄', [['→ 희롱질.']]),
    record(32, '빈참조', [['→ .']]),                               // malformed
    withHomograph(33, '숫자', 1, [['뜻.']]),
    record(34, '숫자부정', [['→ 숫자.']]),                         // numberless reference naming a numbered record
    record(35, '원본선행', [['→ 희롱질.']]),
  ].map((item) => (item.id === 'w0035' ? { ...item, senses: [{ ...item.senses[0], relations: [direct('w0021-s1')] }] } : item)));
  assert.deepEqual(summary(relations.filter((r) => r.origin === 'stdict-gloss-reference')), [
    'm0020>m0021:direct:stdict-gloss-reference',
    'm0024>m0022:direct:stdict-gloss-reference',
    'm0029>m0021:direct:stdict-gloss-reference',
    'm0030>m0031:direct:stdict-gloss-reference',
    'm0031>m0021:direct:stdict-gloss-reference',
  ]);
  // The original direct keeps its origin; the gloss only adds evidence.
  assert.deepEqual(summary(relations.filter((r) => r.source_meaning_id === 'm0035')), ['m0035>m0021:direct:stdict-sense-projection']);
  assert.equal(relations.find((r) => r.source_meaning_id === 'm0035').gloss_sources.length, 1);
  assert.deepEqual(relations.find((r) => r.source_meaning_id === 'm0029').gloss_sources.map((s) => [s.source_sense_id, s.target_sense_position]), [['w0029-s1', 0], ['w0029-s2', null]]);
  assert.deepEqual(Object.fromEntries(holds.map((hold) => [hold.sense_id, hold.reason])), {
    'w0025-s1': 'ambiguous_target',
    'w0026-s1': 'target_not_found',
    'w0027-s1': 'self_reference',
    'w0028-s1': 'sense_out_of_range',
    'w0032-s1': 'malformed',
    'w0034-s1': 'numberless_reference_to_homograph',
  });
  assert.equal(stats.gloss_reference_count, 13);
  assert.equal(stats.gloss_reference_resolved_count + stats.gloss_reference_held_count, stats.gloss_reference_count);
  assert.equal(stats.gloss_forward_count, 5);
  assert.equal(stats.gloss_forward_existing_direct_count, 1);
  assert.equal(stats.gloss_forward_shared_count, 1);
  // Positions stay dense and unique per source meaning.
  const positions = new Map();
  for (const r of relations) positions.set(r.source_meaning_id, [...(positions.get(r.source_meaning_id) ?? []), r.position]);
  for (const list of positions.values()) assert.deepEqual([...list].sort((a, b) => a - b), list.map((_, i) => i));
});

test('gloss reference projection: reverse is mirrored for every direct, once, and original relations are untouched', () => {
  const { relations } = projectGloss([
    record(40, '비표준', [['→ 표준.']]),
    record(41, '표준', [['표준 뜻.']]),
    record(42, '상호가', [['→ 상호나.']]),                         // both directions are references: no duplicate
    record(43, '상호나', [['→ 상호가.']]),
  ]);
  const all = [...relations, ...projectDirectReverses({ relations }).relations];
  assert.deepEqual(summary(all).sort(), [
    'm0040>m0041:direct:stdict-gloss-reference',
    'm0041>m0040:direct:direct-reverse-projection',
    'm0042>m0043:direct:stdict-gloss-reference',
    'm0043>m0042:direct:stdict-gloss-reference',
  ]);
  const reverse = all.find((r) => r.origin === 'direct-reverse-projection');
  assert.deepEqual(reverse.reverse_of, { source_meaning_id: 'm0040', position: 0 });
  assert.deepEqual(reverse.sources, []);
});
