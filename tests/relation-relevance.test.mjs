import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { validateCanonicalRecord } from '../scripts/validate/canonical-jsonl.mjs';
import { validateDatasetRecords } from '../scripts/validate/dataset-integrity.mjs';
import { getSenseRelations } from '../src/runtime/sqlite-query.js';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function record(id, relations = []) {
  return {
    id,
    record_type: 'entry',
    role: 'reference-only',
    lemma: `synthetic-${id}`,
    search_forms: [`synthetic-${id}`],
    senses: [{ id: `${id}-s1`, pos: 'noun', gloss: `synthetic ${id}`, relations }],
  };
}

const relation = (extra) => ({ target: 'r000002', target_sense: 'r000002-s1', note: 'n', ...extra });
const infos = (records) => records.map((r, i) => ({ record: r, filePath: 'x.jsonl', lineNumber: i + 1 }));

test('schema accepts relevance 1..9 and rejects other values', () => {
  validateCanonicalRecord(record('r000001', [relation({ type: 'near', relevance: 1 })]));
  validateCanonicalRecord(record('r000001', [relation({ type: 'near', relevance: 9 })]));
  for (const bad of [0, 10, 2.5, '3']) {
    assert.throws(
      () => validateCanonicalRecord(record('r000001', [relation({ type: 'near', relevance: bad })])),
      /relevance/,
    );
  }
});

test('live canonical requires relevance on exploratory relations only', () => {
  const target = record('r000002');
  const missing = infos([record('r000001', [relation({ type: 'mood' })]), target]);
  assert.doesNotThrow(() => validateDatasetRecords(missing));
  assert.throws(() => validateDatasetRecords(missing, { requireRelevance: true }), /requires relevance/);
  const direct = infos([record('r000001', [relation({ type: 'direct' })]), target]);
  assert.doesNotThrow(() => validateDatasetRecords(direct, { requireRelevance: true }));
});

test('direct and antonym must not carry relevance', () => {
  const target = record('r000002');
  for (const type of ['direct', 'antonym']) {
    assert.throws(
      () => validateDatasetRecords(infos([record('r000001', [relation({ type, relevance: 2 })]), target])),
      /must not carry relevance/,
    );
  }
});

test('SQLite persists relevance and keeps every relation past 100', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'typewriter-relevance-'));
  try {
    await mkdir(path.join(dir, 'canonical'));
    const targets = Array.from({ length: 105 }, (_, i) => record(`r${String(i + 2).padStart(6, '0')}`));
    const relations = targets.map((t, i) => ({
      target: t.id, target_sense: `${t.id}-s1`, type: 'scene', note: 'n', relevance: (i % 9) + 1,
    }));
    relations.push({ target: 'r000002', target_sense: 'r000002-s1', type: 'direct', note: 'n' });
    const rows = [record('r000001', relations), ...targets];
    await writeFile(
      path.join(dir, 'canonical', 'records.jsonl'),
      `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
    const outputPath = path.join(dir, 'dictionary.sqlite');
    const summary = await buildDictionary({
      inputDirectory: path.join(dir, 'canonical'),
      outputPath,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      allowDirty: true,
    });
    assert.equal(summary.metadata.schema_version, '3');
    const database = new DatabaseSync(outputPath, { readOnly: true });
    try {
      const result = getSenseRelations(database, 'r000001-s1');
      assert.equal(result.length, 106);
      assert.equal(result[0].relevance, 1);
      assert.equal(result.at(-1).type, 'direct');
      assert.equal(result.at(-1).relevance, null);
      assert.equal(result[104].position, 104);
    } finally {
      database.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
