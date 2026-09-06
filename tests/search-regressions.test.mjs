import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../scripts/build/dictionary.mjs';
import {
  assertValidSearchRegressionCorpus,
  validateSearchRegressionCorpus,
} from '../scripts/validate/search-regressions.mjs';
import {
  caseById,
  casesByEvaluation,
  recordAssertions,
  relationAssertions,
  relationSignature,
  resultIds,
} from './helpers/search-regressions.js';
import {
  findRecordsByExactTerm,
  findRecordsBySearchTerm,
  getRecord,
  getSenseRelations,
} from '../scripts/build/query.mjs';

const repositoryDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const fixturePath = path.join(
  repositoryDirectory,
  'tests/fixtures/search-regressions/m4-baseline.json',
);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));

test('M4 search regression corpus has a valid shape and no source sentences', () => {
  assert.deepEqual(validateSearchRegressionCorpus(fixture), []);
  assert.doesNotThrow(() => assertValidSearchRegressionCorpus(fixture));
});

test('fixture validation rejects duplicate results and source-text fields', () => {
  const invalidFixture = structuredClone(fixture);
  invalidFixture.cases[0].actual.result_ids.push('w026');
  invalidFixture.cases[0].source_text = 'forbidden';
  invalidFixture.cases[0].expected.definition = 'forbidden';

  const errors = validateSearchRegressionCorpus(invalidFixture);
  assert.ok(errors.some((error) => error.includes('duplicate value')));
  assert.ok(errors.some((error) => error.includes('source_text')));
  assert.ok(errors.some((error) => error.includes('definition')));
  assert.ok(errors.some((error) => error.includes('raw source/example text')));
});

test('M3 baseline cases match the canonical SQLite exact-query contract', async () => {
  const outputDirectory = await mkdtemp(path.join(repositoryDirectory, 'tmp-search-regression-'));
  const outputPath = path.join(outputDirectory, 'dictionary.sqlite');

  try {
    await buildDictionary({
      inputDirectory: path.join(repositoryDirectory, 'data/canonical'),
      outputPath,
      checkPilotCompleteness: true,
      allowDirty: true,
      repositoryDirectory,
    });

    const database = new DatabaseSync(outputPath, { readOnly: true });
    try {
      for (const searchCase of casesByEvaluation(fixture, 'baseline')) {
        const rows = findRecordsByExactTerm(database, searchCase.query);
        assert.deepEqual(
          resultIds(rows),
          searchCase.actual.result_ids,
          `${searchCase.id} exact result IDs`,
        );

        for (const assertion of recordAssertions(searchCase)) {
          const record = getRecord(database, assertion.record_id);
          assert.ok(record, `${searchCase.id} should resolve ${assertion.record_id}`);
          assert.equal(
            assertion.in_results,
            searchCase.actual.result_ids.includes(assertion.record_id),
            `${searchCase.id} result membership for ${assertion.record_id}`,
          );

          if (assertion.record_type !== undefined) {
            assert.equal(record.record_type, assertion.record_type);
          }
          if (assertion.role !== undefined) {
            assert.equal(record.role, assertion.role);
          }
          if (assertion.sense_ids !== undefined) {
            assert.deepEqual(
              record.senses.map(({ id }) => id),
              assertion.sense_ids,
              `${searchCase.id} sense order for ${assertion.record_id}`,
            );
          }
          if (assertion.relation_count !== undefined) {
            assert.equal(
              record.senses.reduce((count, sense) => count + sense.relations.length, 0),
              assertion.relation_count,
              `${searchCase.id} relation count for ${assertion.record_id}`,
            );
          }
        }

        for (const assertion of relationAssertions(searchCase)) {
          const relations = getSenseRelations(database, assertion.source_sense_id);
          assert.ok(
            relations.some((relation) => relationSignature({
              source_sense_id: assertion.source_sense_id,
              target_record_id: relation.target,
              target_sense_id: relation.target_sense,
              type: relation.type,
            }) === relationSignature(assertion)),
            `${searchCase.id} should preserve ${relationSignature(assertion)}`,
          );
        }

        if (searchCase.selection?.kind === 'relation-target') {
          const source = getRecord(database, searchCase.selection.source_record_id);
          const sourceSense = source?.senses.find(
            ({ id }) => id === searchCase.selection.source_sense_id,
          );
          const targetRelation = sourceSense?.relations.find(
            ({ target, target_sense, type }) => (
              target === searchCase.selection.record_id
              && target_sense === searchCase.selection.sense_id
              && type === searchCase.selection.relation_type
            ),
          );
          const selected = getRecord(database, searchCase.selection.record_id);

          assert.ok(targetRelation, `${searchCase.id} relation target is reachable`);
          assert.ok(selected, `${searchCase.id} selected relation target exists`);
          assert.equal(
            selected.role,
            'reference-only',
            `${searchCase.id} keeps the selected target reference-only`,
          );
          assert.ok(
            selected.senses.some(({ id }) => id === searchCase.selection.sense_id),
            `${searchCase.id} selected target sense exists`,
          );
          assert.equal(searchCase.actual.selected_record_id, selected.id);
        }
      }

      const pendingNormalization = caseById(fixture, 'm4-normalization-hangul-nfd');
      assert.deepEqual(
        findRecordsByExactTerm(database, pendingNormalization.query),
        [{
          id: 'w026',
          record_type: 'entry',
          role: 'start',
          candidate_id: 'w026',
          lemma: '담담하다',
        }],
        'approved NFC normalization reaches the canonical lemma',
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('M4 query responses preserve normalization and match provenance', async () => {
  const outputDirectory = await mkdtemp(path.join(repositoryDirectory, 'tmp-search-query-contract-'));
  const outputPath = path.join(outputDirectory, 'dictionary.sqlite');

  try {
    await buildDictionary({
      inputDirectory: path.join(repositoryDirectory, 'data/canonical'),
      outputPath,
      checkPilotCompleteness: true,
      allowDirty: true,
      repositoryDirectory,
    });

    const database = new DatabaseSync(outputPath, { readOnly: true });
    try {
      for (const searchCase of fixture.cases.filter(({ actual }) => actual.raw_query !== undefined)) {
        const response = findRecordsBySearchTerm(database, searchCase.query);
        assert.equal(response.status, searchCase.actual.status, `${searchCase.id} status`);
        assert.equal(response.rawQuery, searchCase.actual.raw_query, `${searchCase.id} raw query`);
        assert.equal(
          response.normalizedQuery,
          searchCase.actual.normalized_query,
          `${searchCase.id} normalized query`,
        );
        assert.deepEqual(
          response.normalizationRules,
          searchCase.actual.normalization_rules,
          `${searchCase.id} normalization rules`,
        );
        assert.equal(response.reason, searchCase.actual.reason, `${searchCase.id} reason`);
        assert.deepEqual(
          response.matches.map(({ id, match }) => ({
            record_id: id,
            kind: match.kind,
            field: match.field,
            value: match.value,
            normalization_rules: match.normalizationRules,
          })),
          searchCase.actual.matches,
          `${searchCase.id} match provenance`,
        );
      }
    } finally {
      database.close();
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
