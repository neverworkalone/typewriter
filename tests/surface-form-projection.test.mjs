import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { SQLITE_SCHEMA_SQL } from '../scripts/build/sqlite-schema.mjs';
import { createCanonicalContext } from '../scripts/validate/canonical-context.mjs';
import { validateDatasetRecords } from '../scripts/validate/dataset-integrity.mjs';
import {
  buildSurfaceFormProjection,
  loadSurfaceFormExceptionManifest,
} from '../scripts/inflection/surface-form-projection.mjs';
import {
  findRecordsBySearchTerm,
  getRecord,
} from '../scripts/build/query.mjs';
import { projectSearchResults } from '../src/domain/projection.js';
import { readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalDirectory = path.join(repositoryRoot, 'data/canonical');
const contractPath = path.join(
  repositoryRoot,
  'tests/fixtures/search-regressions/m6-2-inflection-contract.json',
);

function entry(id, lemma, pos, searchForms = []) {
  return {
    id,
    record_type: 'entry',
    role: 'start',
    candidate_id: id,
    lemma,
    search_forms: searchForms,
    senses: [{ id: `${id}-s1`, pos, gloss: 'fixture gloss', relations: [] }],
  };
}

function createSearchDatabase(records, projection) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec(SQLITE_SCHEMA_SQL);
  const insertRecord = database.prepare(
    'INSERT INTO records (id, record_type, role, candidate_id, lemma) VALUES (?, ?, ?, ?, ?)',
  );
  const insertSearchForm = database.prepare(
    'INSERT INTO search_forms (record_id, position, form) VALUES (?, ?, ?)',
  );
  const insertSense = database.prepare(
    'INSERT INTO senses (id, record_id, position, pos, gloss) VALUES (?, ?, ?, ?, ?)',
  );
  const insertSurfaceForm = database.prepare(
    'INSERT INTO generated_surface_forms (form, record_id, sense_id, rule_id) VALUES (?, ?, ?, ?)',
  );

  for (const record of records) {
    insertRecord.run(
      record.id,
      record.record_type,
      record.role,
      record.candidate_id,
      record.lemma,
    );
    record.search_forms.forEach((form, position) => {
      insertSearchForm.run(record.id, position, form);
    });
    record.senses.forEach((sense, position) => {
      insertSense.run(sense.id, record.id, position, sense.pos, sense.gloss);
    });
  }
  for (const row of projection.rows) {
    insertSurfaceForm.run(row.form, row.record_id, row.sense_id, row.rule_id);
  }
  return database;
}

function rowsForForm(projection, form) {
  return projection.rows.filter((row) => row.form === form);
}

test('the complete 5K canonical domain has deterministic declared projection coverage', async () => {
  const [canonical, contract, exceptionManifest] = await Promise.all([
    readCanonicalRecords(canonicalDirectory, { useSharedContext: false }),
    readFile(contractPath, 'utf8').then(JSON.parse),
    loadSurfaceFormExceptionManifest(),
  ]);
  const records = canonical.records.map(({ record }) => record);
  const projection = buildSurfaceFormProjection(records, {
    exceptionManifest,
    requireExceptionTargets: true,
  });
  const declaredPredicateSenseCount = contract.inventory.predicate_sense_counts.verb
    + contract.inventory.predicate_sense_counts.adjective;

  assert.equal(projection.coverage.eligible_sense_count, declaredPredicateSenseCount);
  assert.equal(
    projection.coverage.complete_rule_decision_count,
    projection.coverage.expected_rule_decision_count,
  );
  assert.equal(projection.coverage.exception_binding_count, exceptionManifest.exceptions.length);
  assert.ok(projection.coverage.generated_surface_form_count > 0);
  assert.ok(projection.coverage.excluded_rule_count > 0);

  for (const searchCase of contract.cases.filter(({ corpus_binding }) => corpus_binding === 'canonical')) {
    const actual = rowsForForm(projection, searchCase.query)
      .map(({ record_id, sense_id, rule_id }) => `${record_id}/${sense_id}/${rule_id}`)
      .sort();
    const expected = searchCase.expected_candidates.flatMap((candidate) => (
      candidate.sense_ids.map((senseId) => (
        `${candidate.record_id}/${senseId}/${candidate.rule_ids?.[0] ?? searchCase.rule_ids[0]}`
      ))
    )).sort();
    assert.deepEqual(actual, expected, `${searchCase.id} projection binding`);
  }

  for (const searchCase of contract.cases.filter(({ classification }) => classification === 'unsupported')) {
    assert.deepEqual(rowsForForm(projection, searchCase.query), [], `${searchCase.id} stays unsupported`);
  }
});

test('future predicate senses receive every supported decision or an explicit exclusion', async () => {
  const exceptionManifest = await loadSurfaceFormExceptionManifest();
  const records = [
    entry('w9901', '먹다', 'verb'),
    entry('w9902', '기다리다', 'verb'),
  ];
  const projection = buildSurfaceFormProjection(records, { exceptionManifest });
  const forms = new Set(projection.rows.map(({ form, record_id }) => `${record_id}/${form}`));

  for (const form of ['먹는', '먹은', '먹을', '먹었다']) {
    assert.ok(forms.has(`w9901/${form}`), `${form} is projected for a newly added sense`);
  }
  assert.ok(forms.has('w9902/기다리는'));
  assert.deepEqual(projection.exclusions.filter(({ record_id }) => record_id === 'w9902'), [{
    record_id: 'w9902',
    sense_id: 'w9902-s1',
    rule_id: 'predicate-plain-past-registered-exception',
    reason: 'open-vowel-class-not-registered',
  }]);
  assert.equal(
    projection.coverage.complete_rule_decision_count,
    projection.coverage.expected_rule_decision_count,
  );

  const recordInfos = records.map((record, index) => ({
    record,
    filePath: 'future-canonical.jsonl',
    lineNumber: index + 1,
  }));
  const context = createCanonicalContext({ records: recordInfos, fileCount: 1 }, {
    canonicalDirectory: path.join(repositoryRoot, 'future-canonical-fixture'),
  });
  validateDatasetRecords(recordInfos, {
    context,
    lexicalQuality: { blocking_finding_count: 0, blocking_findings: [] },
    requireSurfaceFormProjection: true,
  });
  assert.deepEqual(context.derived.surfaceFormProjection.rows, projection.rows);
});

test('shared search keeps generated ambiguity, exact precedence, sense scope, and normalization', async () => {
  const records = [
    entry('w010', '바라보다', 'verb'),
    entry('w011', '먹다', 'verb', ['먹었다']),
    entry('w012', '먹다', 'verb'),
    entry('w013', '예쁘다', 'adjective'),
    {
      ...entry('w014', '듣다', 'verb'),
      senses: [
        { id: 'w014-s1', pos: 'verb', gloss: 'listen', relations: [] },
        { id: 'w014-s2', pos: 'noun', gloss: 'hearing', relations: [] },
      ],
    },
    entry('w015', '들다', 'verb'),
    entry('w016', '바라보는', 'noun'),
    entry('w017', '기다리다', 'verb'),
  ];
  const exceptionManifest = {
    schema_version: 1,
    contract_id: 'm6-2-inflection-exceptions-v1',
    source_issue: 174,
    exceptions: [{
      class_id: 'm6-2-d-irregular-verb',
      record_id: 'w014',
      sense_id: 'w014-s1',
    }],
  };
  const projection = buildSurfaceFormProjection(records, { exceptionManifest });
  const database = createSearchDatabase(records, projection);

  try {
    const regular = findRecordsBySearchTerm(database, '예쁜');
    assert.equal(regular.status, 'ready');
    assert.deepEqual(regular.matches.map(({ id }) => id), ['w013']);
    assert.deepEqual(regular.matches[0].match.senseIds, ['w013-s1']);
    assert.deepEqual(regular.matches[0].match.ruleIds, ['adjective-present-adnominal-eun']);

    const collision = findRecordsBySearchTerm(database, '들었다');
    assert.deepEqual(collision.matches.map(({ id }) => id), ['w014', 'w015']);
    assert.deepEqual(collision.matches.map(({ match }) => match.senseIds), [
      ['w014-s1'],
      ['w015-s1'],
    ]);
    assert.deepEqual(collision.matches.map(({ match }) => match.ruleIds), [
      ['predicate-plain-past-registered-exception'],
      ['predicate-plain-past-coda-bearing'],
    ]);
    const generatedProjection = projectSearchResults(
      [getRecord(database, 'w014')],
      collision.matches,
    );
    assert.deepEqual(generatedProjection[0].senses.map(({ id }) => id), ['w014-s1']);
    const exactListen = findRecordsBySearchTerm(database, '듣다');
    const exactProjection = projectSearchResults(
      [getRecord(database, 'w014')],
      exactListen.matches,
    );
    assert.deepEqual(exactProjection[0].senses.map(({ id }) => id), ['w014-s1', 'w014-s2']);

    const precedence = findRecordsBySearchTerm(database, '먹었다');
    assert.deepEqual(precedence.matches.map(({ id }) => id), ['w011', 'w012']);
    assert.equal(precedence.matches[0].match.kind, 'exact-search-form');
    assert.deepEqual(precedence.matches[1].match.senseIds, ['w012-s1']);

    const exactLemmaBeforeGenerated = findRecordsBySearchTerm(database, '바라보는');
    assert.deepEqual(exactLemmaBeforeGenerated.matches.map(({ id }) => id), ['w016', 'w010']);
    assert.equal(exactLemmaBeforeGenerated.matches[0].match.kind, 'exact-lemma');
    assert.equal(exactLemmaBeforeGenerated.matches[1].match.kind, 'generated-surface-form');

    const normalized = findRecordsBySearchTerm(database, `  ${'예쁜'.normalize('NFD')}  `);
    assert.equal(normalized.status, 'ready');
    assert.deepEqual(normalized.normalizationRules, [
      'unicode-nfc',
      'trim-surrounding-whitespace',
    ]);
    assert.equal(normalized.matches[0].match.kind, 'generated-surface-form');
    assert.equal(normalized.matches[0].match.value, '예쁜');

    assert.equal(findRecordsBySearchTerm(database, '기다렸다').status, 'no-match');
    assert.equal(findRecordsBySearchTerm(database, '바라보며').status, 'no-match');
  } finally {
    database.close();
  }
});

test('unknown or misbound irregular exception classes fail closed', () => {
  const record = entry('w9910', '듣다', 'verb');
  const wrongManifest = {
    schema_version: 1,
    contract_id: 'm6-2-inflection-exceptions-v1',
    exceptions: [{
      class_id: 'm6-2-b-irregular-adjective',
      record_id: record.id,
      sense_id: `${record.id}-s1`,
    }],
  };
  assert.throws(
    () => buildSurfaceFormProjection([record], { exceptionManifest: wrongManifest }),
    (error) => error.code === 'EXCEPTION_CLASS_TARGET_MISMATCH',
  );

  const recordInfo = { record, filePath: 'future-canonical.jsonl', lineNumber: 1 };
  const context = createCanonicalContext({ records: [recordInfo], fileCount: 1 }, {
    canonicalDirectory: path.join(repositoryRoot, 'future-canonical-fixture'),
  });
  context.derived.surfaceFormExceptionManifest = wrongManifest;
  assert.throws(
    () => validateDatasetRecords([recordInfo], {
      context,
      lexicalQuality: { blocking_finding_count: 0, blocking_findings: [] },
      requireSurfaceFormProjection: true,
    }),
    (error) => error.code === 'EXCEPTION_CLASS_TARGET_MISMATCH',
  );
});
