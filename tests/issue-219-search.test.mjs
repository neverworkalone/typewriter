import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../scripts/build/dictionary.mjs';
import {
  findRecordsByExactTerm,
  findRecordsBySearchTerm,
  getSenseRelations,
} from '../scripts/build/query.mjs';
import { DEFAULT_CANONICAL_DIRECTORY } from '../scripts/validate/canonical-jsonl.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT_PATH = path.join(ROOT, 'data/canonical/issue-219-m9-a-recovery.jsonl');

function parseJsonl(bytes) {
  return bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

test('Issue #219 admitted expression resolves its exact writer query with zero relations', async () => {
  const records = parseJsonl(await readFile(IMPORT_PATH));
  assert.deepEqual(records.map(({ id }) => id), ['w4701']);
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-issue-219-search-'));
  const outputPath = path.join(outputDirectory, 'dictionary.sqlite');
  let database;
  try {
    await buildDictionary({
      inputDirectory: DEFAULT_CANONICAL_DIRECTORY,
      outputPath,
      checkPilotCompleteness: true,
      allowDirty: true,
      repositoryDirectory: ROOT,
    });
    database = new DatabaseSync(outputPath, { readOnly: true });
    for (const record of records) {
      assert.deepEqual(findRecordsByExactTerm(database, record.lemma).map(({ id }) => id), [record.id]);
      const response = findRecordsBySearchTerm(database, record.lemma);
      assert.equal(response.status, 'ready', `${record.lemma} search status`);
      assert.deepEqual(response.matches.map(({ id, match }) => ({
        id,
        kind: match.kind,
        field: match.field,
        value: match.value,
      })), [{
        id: record.id,
        kind: 'exact-lemma',
        field: 'lemma',
        value: record.lemma,
      }], `${record.lemma} exact lemma precedence`);
      for (const sense of record.senses) {
        assert.deepEqual(getSenseRelations(database, sense.id), [], `${record.lemma}/${sense.id} no relation quota`);
      }
    }
  } finally {
    database?.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
