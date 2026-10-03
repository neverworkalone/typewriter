import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { openCurrentRevisionDatabasePath } from '../scripts/ci/current-revision-database.mjs';
import {
  findRecordsByExactTerm,
  findRecordsBySearchTerm,
} from '../scripts/build/query.mjs';

const repositoryDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const admittedStarts = [
  { lemma: '시작', recordId: 'w5349' },
  { lemma: '이야기', recordId: 'w5350' },
  { lemma: '모습', recordId: 'w5351' },
  { lemma: '순간', recordId: 'w5352' },
  { lemma: '사랑', recordId: 'w5353' },
  { lemma: '향하다', recordId: 'w5354' },
  { lemma: '대답', recordId: 'w5355' },
  { lemma: '기억', recordId: 'w5356' },
  { lemma: '기분', recordId: 'w5357' },
  { lemma: '하루', recordId: 'w5358' },
];

async function openDictionary() {
  const { databasePath, outputDirectory } = await openCurrentRevisionDatabasePath({
    temporaryRoot: repositoryDirectory,
    prefix: 'tmp-issue-204-search-',
    repositoryDirectory,
  });
  return {
    database: new DatabaseSync(databasePath, { readOnly: true }),
    outputDirectory,
  };
}

test('Issue #204 starts resolve exact lemmas without shadowing other matches', async () => {
  const opened = await openDictionary();
  try {
    for (const { lemma, recordId } of admittedStarts) {
      const exactRows = findRecordsByExactTerm(opened.database, lemma);
      assert.deepEqual(exactRows.map(({ id }) => id), [recordId], lemma + ' exact lookup');

      const response = findRecordsBySearchTerm(opened.database, lemma);
      assert.equal(response.status, 'ready', lemma + ' search status');
      assert.deepEqual(
        response.matches.map(({ id, match }) => ({
          id,
          kind: match.kind,
          field: match.field,
          value: match.value,
        })),
        [{ id: recordId, kind: 'exact-lemma', field: 'lemma', value: lemma }],
        lemma + ' exact precedence and match provenance',
      );
    }

    for (const surface of ['향하는', '향했다']) {
      assert.deepEqual(
        findRecordsByExactTerm(opened.database, surface).map(({ id }) => id),
        ['w5354'],
        surface + ' exact indexed surface resolves to the admitted predicate',
      );
      const response = findRecordsBySearchTerm(opened.database, surface);
      assert.equal(response.status, 'ready', surface + ' generated search status');
      assert.deepEqual(
        response.matches.map(({ id, match }) => ({
          id,
          kind: match.kind,
          field: match.field,
          value: match.value,
        })),
        [{
          id: 'w5354',
          kind: 'generated-surface-form',
          field: 'generated-surface-form',
          value: surface,
        }],
        surface + ' generated-surface match provenance',
      );
    }
  } finally {
    opened.database.close();
    if (opened.outputDirectory) await rm(opened.outputDirectory, { recursive: true, force: true });
  }
});
