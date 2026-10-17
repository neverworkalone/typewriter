import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { extractLiteDictionary } from '../scripts/build/lite-dictionary.mjs';
import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { MEANING_INTEGRITY_QUERIES } from '../src/runtime/dictionary-contract.js';
import { projectGlossReferenceDirects, parseSoleReference } from '../scripts/build/gloss-reference-relations.mjs';
import { projectRecordMeanings, projectMeaningRelations } from '../scripts/build/record-meanings.mjs';
import { MEANING_SOURCE_INTEGRITY_QUERIES } from '../scripts/build/meaning-source-checks.mjs';
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

// Issue #797 function B: gloss-reference direct relations and the reverse projection of every verified direct.
const typed = (n, lemma, pos, glosses, homograph_no, relations) => ({
  ...record(n, lemma, glosses.map((gloss, index) => [gloss, index === 0 ? relations : undefined])),
  ...(homograph_no ? { homograph_no } : {}),
  senses: glosses.map((gloss, index) => ({ id: `w00${n}-s${index + 1}`, pos, gloss, ...(index === 0 && relations ? { relations } : {}) })),
});
const DERIVED_RECORDS = [
  typed(10, '동의', 'noun', ['표준 표기.'], 1),
  typed(11, '이표기', 'noun', ['→ 동의01.']),              // approved by (lemma, homograph_no)
  typed(12, '동의', 'noun', ['다른 동의.'], 2),
  typed(13, '모호', 'noun', ['→ 동의.']),                   // HOLD: unnumbered but two homographs
  typed(14, '품사', 'verb', ['→ 동의01.']),                 // HOLD: part of speech differs
  typed(15, '체인', 'noun', ['→ 이표기.']),                 // HOLD: target is itself a reference
  typed(16, '복합', 'noun', ['→ 동의01. 또는 다른 말.']),   // HOLD: not a sole reference
  typed(17, '자기', 'noun', ['→ 자기.']),                   // HOLD: self
  typed(18, '없음', 'noun', ['→ 없는말.']),                 // HOLD: unknown target
  typed(19, '단일', 'noun', ['단일 뜻.']),
  typed(20, '두번째', 'noun', ['→ 단일.']),                 // approved, unnumbered, single homograph
  typed(21, '원본가', 'noun', ['원본 뜻 가.'], undefined, [direct('w0022-s1')]),
  typed(22, '원본나', 'noun', ['원본 뜻 나.'], undefined, [direct('w0021-s1')]), // original reverse exists: no duplicate
  typed(23, '원본다', 'noun', ['원본 뜻 다.'], undefined, [direct('w0024-s1'), { ...direct('w0024-s1'), type: 'antonym', note: '반의' }]),
  typed(24, '원본라', 'noun', ['원본 뜻 라.']),
];

// Lexical-quality admits one record per lemma outside licensed STDICT data, so the database fixture has no homographs.
const BUILD_RECORDS = [
  typed(10, '동의', 'noun', ['표준 표기.']),
  typed(11, '이표기', 'noun', ['→ 동의.']),
  ...DERIVED_RECORDS.filter((item) => ['w0019', 'w0020', 'w0021', 'w0022', 'w0023', 'w0024'].includes(item.id)),
];

test('gloss-reference direct: approval table, holds and reverse projection', () => {
  const parse = [
    ['→ 동의01.', { headword: '동의', homograph: '01', sense: null }],
    ['→ 동의01「2」.', { headword: '동의', homograph: '01', sense: 2 }],
    ['→ 고수레02[Ⅰ].', { headword: '고수레', homograph: '02', sense: null }],
    ['→ 파투(破鬪).', { headword: '파투', homograph: null, sense: null }],
    ['→ 가계 경제.', { headword: '가계 경제', homograph: null, sense: null }],
  ];
  for (const [gloss, expected] of parse) {
    const { headword, homograph, sense, start, length } = parseSoleReference(gloss);
    assert.deepEqual({ headword, homograph, sense }, expected, gloss);
    assert.equal(gloss.slice(start, start + length).startsWith(headword), true, gloss);
  }
  for (const gloss of ['→ 동의01. 또는', '→ 할머니_.', '뜻 → 동의.', '→ 동의', '→ 동의01. → 동의02.', '→ ', null]) {
    assert.equal(parseSoleReference(gloss), null, String(gloss));
  }

  const meanings = projectRecordMeanings(DERIVED_RECORDS.map((item) => ({ ...item, senses: item.senses.map((sense) => ({ relations: [], ...sense })) })));
  const records = DERIVED_RECORDS.map((item) => ({ ...item, senses: item.senses.map((sense) => ({ relations: [], ...sense })) }));
  const { relations: original } = projectMeaningRelations({ records, meanings });
  const derived = projectGlossReferenceDirects({ records, relations: original });
  const key = (r) => `${r.source_meaning_id}>${r.target_meaning_id}:${r.origin}`;
  // Forward gloss relations first, then reverses (original directs before gloss ones); 원본가<->원본나 already mirror each other.
  assert.deepEqual(derived.relations.map(key), [
    'm0011>m0010:stdict-gloss-reference',
    'm0020>m0019:stdict-gloss-reference',
    'm0024>m0023:direct-reverse-projection',
    'm0010>m0011:direct-reverse-projection',
    'm0019>m0020:direct-reverse-projection',
  ]);

  assert.deepEqual(Object.fromEntries(derived.holds), { unnumbered_ambiguous: 1, pos_mismatch: 1, reference_chain: 1, not_sole_reference: 1, self_reference: 1, target_missing: 1 });
  // The antonym is never mirrored; only direct is.
  assert.equal(derived.relations.some((r) => r.type !== 'direct'), false);
});

test('derived direct provenance: valid build passes; forged, missing and mismatched derivations fail', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-derived-'));
  try {
    const { deployed, full: good } = await buildFixture(directory, BUILD_RECORDS);
    assert.deepEqual(violations(good), {});
    const shipped = new DatabaseSync(deployed, { readOnly: true });
    // The shipped database holds no derivation tables, yet still proves every direct is shown in both directions.
    assert.deepEqual(Object.entries(MEANING_INTEGRITY_QUERIES).filter(([, sql]) => Number(Object.values(shipped.prepare(sql).get())[0]) !== 0), []);
    assert.equal(shipped.prepare("SELECT COUNT(*) AS c FROM meaning_relations WHERE origin = 'direct-reverse-projection'").get().c, 3);
    shipped.close();
    const database = new DatabaseSync(good, { readOnly: true });
    const count = (table) => Number(database.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
    assert.equal(count('meaning_relation_gloss_sources'), 2);
    assert.equal(count('meaning_relation_reverse_sources'), 3);
    // Derived rows are never recorded as original source positions.
    assert.equal(Number(database.prepare(
      "SELECT COUNT(*) FROM meaning_relation_sources AS s JOIN meaning_relations AS r ON r.source_meaning_id = s.source_meaning_id AND r.position = s.relation_position WHERE r.origin <> 'stdict-sense-projection'",
    ).get()['COUNT(*)']), 0);
    // The Canonical source gloss keeps its homograph number and arrow; the gloss provenance names the token inside it.
    const gloss = database.prepare("SELECT senses.gloss, source.gloss_start, source.gloss_length FROM meaning_relation_gloss_sources AS source JOIN senses ON senses.id = source.source_sense_id WHERE source.source_sense_id = 'w0011-s1'").get();
    assert.equal(gloss.gloss.slice(gloss.gloss_start, gloss.gloss_start + gloss.gloss_length), '동의');
    database.close();

    const copy = (name) => path.join(directory, name);
    const mutate = async (name, sql, off = false) => {
      await copyFile(good, copy(`${name}.sqlite`));
      return violations(copy(`${name}.sqlite`), (db) => { if (off) db.exec('PRAGMA foreign_keys = OFF'); db.exec(sql); });
    };
    // Forward row without gloss provenance, reverse row without reverse provenance.
    assert.equal((await mutate('no-gloss', "DELETE FROM meaning_relation_gloss_sources WHERE source_sense_id = 'w0011-s1'")).gloss_reference_relation_without_provenance, 1);
    assert.equal((await mutate('no-reverse', "DELETE FROM meaning_relation_reverse_sources WHERE source_meaning_id = 'm0010'")).reverse_relation_without_provenance, 1);
    // A deleted reverse leaves a one-directional direct.
    assert.ok((await mutate('one-way', "DELETE FROM meaning_relations WHERE source_meaning_id = 'm0010' AND origin = 'direct-reverse-projection'")).direct_relation_without_reverse > 0);
    // A gloss derivation pointing at the wrong token, wrong target or a relabelled origin is rejected.
    assert.ok((await mutate('offset', "UPDATE meaning_relation_gloss_sources SET gloss_start = 3 WHERE source_sense_id = 'w0011-s1'")).gloss_reference_mismatch > 0);
    assert.ok((await mutate('target', "UPDATE meaning_relation_gloss_sources SET target_record_id = 'w0019' WHERE source_sense_id = 'w0011-s1'")).gloss_reference_mismatch > 0);
    assert.ok((await mutate('relabel', "UPDATE meaning_relations SET origin = 'typewriter-authored' WHERE source_meaning_id = 'm0011'", true)).gloss_reference_provenance_on_other_origin > 0);
    assert.ok((await mutate('wrong-pos', "UPDATE senses SET pos = 'verb' WHERE id = 'w0011-s1'")).gloss_reference_mismatch > 0);
    // A reverse that does not mirror its forward (note or direction) or mirrors another reverse is rejected.
    assert.ok((await mutate('rev-note', "UPDATE meaning_relations SET note = '위조' WHERE origin = 'direct-reverse-projection' AND source_meaning_id = 'm0010'")).reverse_relation_mismatch > 0);
    assert.ok((await mutate('rev-chain', "UPDATE meaning_relation_reverse_sources SET forward_source_meaning_id = 'm0010', forward_position = (SELECT position FROM meaning_relations WHERE source_meaning_id = 'm0010' AND origin = 'direct-reverse-projection') WHERE source_meaning_id = 'm0010'", true)).reverse_relation_mismatch > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
