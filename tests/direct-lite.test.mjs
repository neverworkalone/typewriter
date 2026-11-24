import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { buildProductDictionary } from '../scripts/build/direct-lite.mjs';
import { compareDirectLite, liteLogicalDigest } from '../scripts/verify/direct-lite-equivalence.mjs';
import { traceInputs } from '../scripts/build/build-inputs.mjs';
import { serializeRelationJsonl } from '../scripts/relation/persisted-jsonl.mjs';
import { PLAIN_LAYOUT } from '../src/runtime/dictionary-contract.js';
import { validatePackagedDictionary } from '../src/runtime/dictionary-validation.js';

const record = (n, lemma, senses) => ({
  id: `w00${n}`, record_type: 'entry', role: 'start', candidate_id: `w00${n}`, lemma, search_forms: [lemma],
  senses: senses.map(([gloss, relations], index) => ({
    id: `w00${n}-s${index + 1}`, pos: 'noun', gloss, ...(relations ? { relations } : {}),
  })),
});
const RECORDS = [
  record(1, '가나', [['가나의 뜻.', [{ target: 'w002', target_sense: 'w002-s1', type: 'direct', note: '표준국어대사전 동의어' }]]]),
  record(2, '다라', [['다라의 뜻.']]),
  record(3, '마바', [['마바의 뜻.']]),
  record(4, '사아', [['사아의 첫째 뜻.'], ['사아의 둘째 뜻.']]),
  record(5, '자차', [['자차의 첫째 뜻.'], ['자차의 둘째 뜻.']]),
];
const idRow = (over = {}) => {
  const row = {
    source_record_id: 'w001', source_sense_id: 'w001-s1', target_record_id: 'w003', target_sense_id: 'w003-s1',
    type: 'near', relevance: 2, ...over,
  };
  return { ...row, reverse_type: row.type, reverse_relevance: row.relevance };
};
const textRow = (over = {}) => ({ source_record_id: 'w001', source_sense_id: 'w001-s1', text: '새 말', type: 'scene', relevance: 4, ...over });
// Two senses of w004 reach w002 with one pair/type (deduplication); w005 holds text duplicates across senses.
const RELATIONS = {
  '001': [idRow(), textRow(), idRow({ target_record_id: 'w002', target_sense_id: 'w002-s1', type: 'mood', relevance: 3 })],
  '002': [
    idRow({ source_record_id: 'w004', source_sense_id: 'w004-s1', target_record_id: 'w002', target_sense_id: 'w002-s1', type: 'sensory', relevance: 5 }),
    idRow({ source_record_id: 'w004', source_sense_id: 'w004-s2', target_record_id: 'w002', target_sense_id: 'w002-s1', type: 'sensory', relevance: 2 }),
    textRow({ source_record_id: 'w005', source_sense_id: 'w005-s1', text: '겹친 말', type: 'action', relevance: 6 }),
    textRow({ source_record_id: 'w005', source_sense_id: 'w005-s2', text: '겹친 말', type: 'action', relevance: 3 }),
  ],
};

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-direct-lite-'));
  const canonical = path.join(directory, 'canonical');
  const relations = path.join(directory, 'relations');
  await mkdir(canonical);
  await mkdir(relations);
  await writeFile(path.join(canonical, 'stdict-0001.jsonl'), `${RECORDS.slice(0, 3).map((item) => JSON.stringify(item)).join('\n')}\n`);
  await writeFile(path.join(canonical, 'stdict-0002.jsonl'), `${RECORDS.slice(3).map((item) => JSON.stringify(item)).join('\n')}\n`);
  for (const [shard, rows] of Object.entries(RELATIONS)) {
    await writeFile(path.join(relations, `relation-${shard}.jsonl`), serializeRelationJsonl(rows));
  }
  const cacheDirectory = path.join(directory, 'cache');
  const build = (name, options = {}) => buildProductDictionary({
    canonicalDirectory: canonical, relationsDirectory: relations, recordMeanings: true, allowDirty: true,
    cacheDirectory, cache: true, outputPath: path.join(directory, `${name}.sqlite`), ...options,
  });
  return { directory, canonical, relations, cacheDirectory, build, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const entries = async (cacheDirectory, kind) => (existsSync(cacheDirectory) ? (await readdir(cacheDirectory)).filter((name) => name.startsWith(`${kind}-`)) : []);

test('Direct Lite is logically identical to Full -> Lite for packed and plain layouts', async () => {
  const built = await fixture();
  try {
    const result = await compareDirectLite({ canonicalDirectory: built.canonical, relationsDirectory: built.relations, recordMeanings: true });
    assert.deepEqual(result.differences, []);
    assert.ok(result.direct.meaning_relations_packed.rows > 0);
    assert.equal(result.direct.meaning_text_relations.rows, 2);

    const plain = await built.build('plain', { optimization: PLAIN_LAYOUT, cache: false });
    const plainDigest = liteLogicalDigest(plain.outputPath);
    assert.equal(plainDigest.meaning_relations_plain.rows, result.direct.meaning_relations_plain.rows + result.direct.meaning_relations_packed.rows);
    const database = new DatabaseSync(plain.outputPath, { readOnly: true });
    try {
      assert.doesNotThrow(() => validatePackagedDictionary(database));
    } finally {
      database.close();
    }
  } finally {
    await built.cleanup();
  }
});

test('cold, cache-hit and cache-off builds give identical bytes; a hit does no relation work', async () => {
  const built = await fixture();
  try {
    const cold = await built.build('cold');
    assert.equal(cold.cache, 'miss');
    assert.equal((await entries(built.cacheDirectory, 'base')).length, 1);
    assert.equal((await entries(built.cacheDirectory, 'lite')).length, 1);
    const hit = await built.build('hit');
    assert.equal(hit.cache, 'hit');
    const off = await built.build('off', { cache: false });
    assert.equal(off.cache, 'off');
    const bytes = async (file) => (await readFile(file)).toString('base64');
    assert.equal(await bytes(hit.outputPath), await bytes(cold.outputPath));
    assert.equal(await bytes(off.outputPath), await bytes(cold.outputPath));
    // Nothing but the product Lite is produced: no Full database next to the output or in the cache.
    const files = await readdir(built.directory, { recursive: true });
    assert.deepEqual(files.filter((name) => /full\.sqlite$/u.test(name)), []);
    const database = new DatabaseSync(hit.outputPath, { readOnly: true });
    try {
      assert.match(database.prepare("SELECT value FROM metadata WHERE key = 'source_revision'").get().value, /^[0-9a-f]{40}$/u);
      assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'worktree_state'").get().value === 'unbound', false);
    } finally {
      database.close();
    }
  } finally {
    await built.cleanup();
  }
});

test('relation changes reuse the Static Base; additions, removals and renames invalidate the Lite', async () => {
  const built = await fixture();
  try {
    await built.build('first');
    const baseBefore = await entries(built.cacheDirectory, 'base');
    await appendFile(path.join(built.relations, 'relation-001.jsonl'), serializeRelationJsonl([idRow({ target_record_id: 'w005', target_sense_id: 'w005-s1', type: 'scene', relevance: 4 })]));
    const changed = await built.build('changed');
    assert.equal(changed.cache, 'miss');
    assert.deepEqual(await entries(built.cacheDirectory, 'base'), baseBefore, 'Static Base reused');
    assert.notDeepEqual(liteLogicalDigest(changed.outputPath).meaning_relations_packed, liteLogicalDigest(path.join(built.directory, 'first.sqlite')).meaning_relations_packed);

    await rename(path.join(built.relations, 'relation-002.jsonl'), path.join(built.relations, 'relation-002.jsonl.off'));
    assert.equal((await built.build('removed')).cache, 'miss');
    await rename(path.join(built.relations, 'relation-002.jsonl.off'), path.join(built.relations, 'relation-002.jsonl'));
    // Back to a recorded state: the matching cached Lite is reused.
    assert.equal((await built.build('restored')).cache, 'hit');
    // An unrelated file in the relation directory changes the listing the loader read.
    await writeFile(path.join(built.relations, 'notes.txt'), 'x');
    assert.equal((await built.build('listed')).cache, 'miss');

    // A Canonical change invalidates the Static Base too.
    await appendFile(path.join(built.canonical, 'stdict-0002.jsonl'), `${JSON.stringify(record(6, '카타', [['바람이 지나간 자리에 남은 흔적.']]))}\n`);
    assert.equal((await built.build('canonical')).cache, 'miss');
    assert.notDeepEqual(await entries(built.cacheDirectory, 'base'), baseBefore);
  } finally {
    await built.cleanup();
  }
});

test('a corrupted cache entry is never used and is regenerated', async () => {
  const built = await fixture();
  try {
    const cold = await built.build('cold');
    const [lite] = await entries(built.cacheDirectory, 'lite');
    await appendFile(path.join(built.cacheDirectory, lite, 'lite.sqlite'), 'corrupt');
    const [base] = await entries(built.cacheDirectory, 'base');
    await appendFile(path.join(built.cacheDirectory, base, 'static-index.v8'), 'corrupt');
    const again = await built.build('again');
    assert.equal(again.cache, 'miss');
    assert.equal((await readFile(again.outputPath)).equals(await readFile(cold.outputPath)), true);
    // The corrupted entries were replaced by verified ones.
    assert.equal((await built.build('healed')).cache, 'hit');
  } finally {
    await built.cleanup();
  }
});

test('a failing Approved Relation input publishes nothing', async () => {
  const built = await fixture();
  try {
    await writeFile(path.join(built.relations, 'relation-001.jsonl'), serializeRelationJsonl([idRow({ target_sense_id: 'w003-s9' })]));
    await assert.rejects(built.build('bad'));
    assert.deepEqual(await entries(built.cacheDirectory, 'lite'), []);
    assert.equal(existsSync(path.join(built.directory, 'bad.sqlite')), false);
  } finally {
    await built.cleanup();
  }
});

test('an input that changes between two reads of one build fails the build', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-trace-'));
  try {
    const file = path.join(directory, 'input.txt');
    await writeFile(file, 'a');
    await assert.rejects(traceInputs(async () => {
      await readFile(file);
      await writeFile(file, 'b');
      await readFile(file);
    }, { root: directory }), /changed while the build was reading it/u);
    await assert.rejects(traceInputs(async () => {
      await readFile(file);
      await writeFile(file, 'c');
    }, { root: directory }), /changed during the build/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
