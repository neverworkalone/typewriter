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
  validateCanonicalSurfaceFormProjection,
} from '../scripts/validate/surface-form-projection.mjs';
import {
  buildSurfaceFormProjection,
  loadSurfaceFormExceptionManifest,
  loadSurfaceFormReviewManifest,
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

function reviewManifest(dispositions = [], reviewedCollisions = {}) {
  return {
    schema_version: 1,
    contract_id: 'm6-3-surface-form-review-v1',
    source_issue: 175,
    dispositions,
    reviewed_collisions: {
      exact_generated: reviewedCollisions.exact_generated ?? [],
      ambiguous_generated: reviewedCollisions.ambiguous_generated ?? [],
    },
  };
}

function reviewCollisionsFrom(collisions) {
  return {
    exact_generated: collisions.exactCollisions.map((collision) => ({
      ...collision,
      reason: 'Exact lookup keeps precedence while every generated candidate remains indexed.',
    })),
    ambiguous_generated: collisions.ambiguousGeneratedForms.map(({ form, candidates }) => ({
      form,
      candidates,
      reason: 'Retain every listed sense-bound candidate without selecting one.',
    })),
  };
}

test('the complete 5K canonical domain has deterministic declared projection coverage', async () => {
  const [canonical, contract, exceptionManifest, review] = await Promise.all([
    readCanonicalRecords(canonicalDirectory, { useSharedContext: false }),
    readFile(contractPath, 'utf8').then(JSON.parse),
    loadSurfaceFormExceptionManifest(),
    loadSurfaceFormReviewManifest(),
  ]);
  const records = canonical.records.map(({ record }) => record);
  const projection = buildSurfaceFormProjection(records, {
    exceptionManifest,
    reviewManifest: review,
    requireExceptionTargets: true,
    requireClassDispositions: true,
    requireCollisionReview: true,
  });
  const declaredPredicateSenseCount = contract.inventory.predicate_sense_counts.verb
    + contract.inventory.predicate_sense_counts.adjective;

  assert.equal(projection.coverage.eligible_sense_count, declaredPredicateSenseCount);
  assert.equal(
    projection.coverage.complete_rule_decision_count,
    projection.coverage.expected_rule_decision_count,
  );
  assert.equal(projection.coverage.exception_binding_count, exceptionManifest.exceptions.length);
  assert.equal(projection.coverage.class_disposition_count, review.dispositions.length);
  assert.equal(
    projection.coverage.exact_collision_form_count,
    review.reviewed_collisions.exact_generated.length,
  );
  assert.equal(
    projection.coverage.ambiguous_generated_form_count,
    review.reviewed_collisions.ambiguous_generated.length,
  );
  assert.ok(projection.coverage.generated_surface_form_count > 0);
  assert.ok(projection.coverage.excluded_rule_count > 0);

  for (const [recordId, senseId, forms] of [
    ['w3592', 'w3592-s1', ['돌아누운', '돌아누울', '돌아누웠다']],
    ['w441', 'w441-s1', ['애달팠다']],
    ['w596', 'w596-s1', ['가냘팠다']],
  ]) {
    for (const form of forms) {
      assert.ok(
        rowsForForm(projection, form).some(
          (row) => row.record_id === recordId && row.sense_id === senseId,
        ),
        `${recordId}/${senseId} generates reviewed form ${form}`,
      );
    }
  }

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

test('future predicate senses require an explicit open-vowel exclusion at admission', async () => {
  const exceptionManifest = await loadSurfaceFormExceptionManifest();
  const records = [
    entry('w9901', '먹다', 'verb'),
    entry('w9902', '기다리다', 'verb'),
  ];
  const recordInfos = records.map((record, index) => ({
    record,
    filePath: 'future-canonical.jsonl',
    lineNumber: index + 1,
  }));
  const context = createCanonicalContext({ records: recordInfos, fileCount: 1 }, {
    canonicalDirectory: path.join(repositoryRoot, 'future-canonical-fixture'),
  });
  assert.throws(
    () => validateDatasetRecords(recordInfos, {
      context,
      lexicalQuality: { blocking_finding_count: 0, blocking_findings: [] },
      requireSurfaceFormProjection: true,
    }),
    (error) => error.code === 'MISSING_PLAIN_PAST_DISPOSITION',
  );

  const review = reviewManifest([{
    class_id: 'm6-3-open-vowel-past-excluded',
    record_id: 'w9902',
    sense_id: 'w9902-s1',
    reason: 'Plain past is unsupported for this open-vowel class; retain other applicable rules.',
  }]);
  context.derived.surfaceFormReviewManifest = review;
  validateDatasetRecords(recordInfos, {
    context,
    lexicalQuality: { blocking_finding_count: 0, blocking_findings: [] },
    requireSurfaceFormProjection: true,
  });
  const projection = context.derived.surfaceFormProjection;
  const forms = new Set(projection.rows.map(({ form, record_id }) => `${record_id}/${form}`));

  for (const form of ['먹는', '먹은', '먹을', '먹었다']) {
    assert.ok(forms.has(`w9901/${form}`), `${form} is projected for a newly added sense`);
  }
  assert.ok(forms.has('w9902/기다리는'));
  assert.deepEqual(projection.exclusions.filter(({ record_id }) => record_id === 'w9902'), [{
    record_id: 'w9902',
    sense_id: 'w9902-s1',
    rule_id: 'predicate-plain-past-registered-exception',
    reason: 'Plain past is unsupported for this open-vowel class; retain other applicable rules.',
  }]);
  assert.equal(
    projection.coverage.complete_rule_decision_count,
    projection.coverage.expected_rule_decision_count,
  );
});

test('risk-coda predicate senses require explicit regular or supported irregular classes', async () => {
  const exceptionManifest = await loadSurfaceFormExceptionManifest();
  assert.throws(
    () => buildSurfaceFormProjection([entry('w9919', '먹다', 'verb')], {
      exceptionManifest,
      requireClassDispositions: true,
      requireCollisionReview: true,
    }),
    (error) => error.code === 'SURFACE_FORM_REVIEW_MANIFEST_REQUIRED',
  );
  const missing = entry('w9920', '싣다', 'verb');
  assert.throws(
    () => buildSurfaceFormProjection([missing], {
      exceptionManifest,
      reviewManifest: reviewManifest(),
      requireClassDispositions: true,
    }),
    (error) => error.code === 'MISSING_PREDICATE_CLASS_DISPOSITION',
  );

  const irregularManifest = {
    schema_version: 1,
    contract_id: 'm6-2-inflection-exceptions-v1',
    source_issue: 174,
    exceptions: [{
      class_id: 'm6-2-d-irregular-verb',
      record_id: missing.id,
      sense_id: `${missing.id}-s1`,
    }],
  };
  const irregular = buildSurfaceFormProjection([missing], {
    exceptionManifest: irregularManifest,
    reviewManifest: reviewManifest(),
    requireClassDispositions: true,
  });
  for (const form of ['실은', '실을', '실었다']) {
    assert.ok(rowsForForm(irregular, form).some(({ record_id }) => record_id === missing.id));
  }

  const excluded = buildSurfaceFormProjection([missing], {
    exceptionManifest: {
      schema_version: 1,
      contract_id: 'm6-2-inflection-exceptions-v1',
      exceptions: [],
    },
    reviewManifest: reviewManifest([{
      class_id: 'm6-3-predicate-excluded',
      record_id: missing.id,
      sense_id: `${missing.id}-s1`,
      reason: 'Predicate class has not been reviewed; exclude all generated forms.',
    }]),
    requireClassDispositions: true,
  });
  assert.deepEqual(rowsForForm(excluded, '싣은'), []);
  assert.equal(excluded.exclusions.length, 4);

  const regular = entry('w9921', '닫다', 'verb');
  const regularReview = reviewManifest([{
    class_id: 'm6-3-regular-d-verb',
    record_id: regular.id,
    sense_id: `${regular.id}-s1`,
    reason: 'Reviewed as regular despite final ㄷ; retain regular rule outputs.',
  }]);
  const regularProjection = buildSurfaceFormProjection([regular], {
    exceptionManifest: {
      schema_version: 1,
      contract_id: 'm6-2-inflection-exceptions-v1',
      exceptions: [],
    },
    reviewManifest: regularReview,
    requireClassDispositions: true,
  });
  for (const form of ['닫은', '닫을', '닫았다']) {
    assert.ok(rowsForForm(regularProjection, form).some(({ record_id }) => record_id === regular.id));
  }
});

test('strict common admission requires the 없다 adjective class independent of its directory', () => {
  const record = entry('w9950', '상관없다', 'adjective');
  const recordInfo = { record, filePath: 'future-canonical.jsonl', lineNumber: 1 };
  const context = createCanonicalContext({ records: [recordInfo], fileCount: 1 }, {
    canonicalDirectory: path.join(repositoryRoot, 'future-eopda-fixture'),
  });
  const exceptionManifest = {
    schema_version: 1,
    contract_id: 'm6-2-inflection-exceptions-v1',
    exceptions: [],
  };
  context.derived.surfaceFormExceptionManifest = exceptionManifest;
  context.derived.surfaceFormReviewManifest = reviewManifest();
  assert.throws(
    () => validateDatasetRecords([recordInfo], {
      context,
      lexicalQuality: { blocking_finding_count: 0, blocking_findings: [] },
      requireSurfaceFormProjection: true,
    }),
    (error) => error.code === 'MISSING_EXCEPTION_CLASS',
  );

  context.derived.surfaceFormExceptionManifest = {
    ...exceptionManifest,
    exceptions: [{
      class_id: 'm6-2-eopda-present-adnominal',
      record_id: record.id,
      sense_id: `${record.id}-s1`,
    }],
  };
  validateDatasetRecords([recordInfo], {
    context,
    lexicalQuality: { blocking_finding_count: 0, blocking_findings: [] },
    requireSurfaceFormProjection: true,
  });
  const projection = context.derived.surfaceFormProjection;
  assert.ok(rowsForForm(projection, '상관없는').some(({ record_id }) => record_id === record.id));
  assert.deepEqual(rowsForForm(projection, '상관없은'), []);
});

test('dedicated projection validator loads and enforces the review manifest', async () => {
  const records = [entry('w9960', '듣다', 'verb'), entry('w9961', '들다', 'verb')];
  const context = { records };
  const exceptionManifest = {
    schema_version: 1,
    contract_id: 'm6-2-inflection-exceptions-v1',
    exceptions: [{
      class_id: 'm6-2-d-irregular-verb',
      record_id: 'w9960',
      sense_id: 'w9960-s1',
    }],
  };
  await assert.rejects(
    () => validateCanonicalSurfaceFormProjection({
      canonicalContext: context,
      exceptionManifest,
      reviewManifestPath: path.join(repositoryRoot, 'missing-surface-form-review.json'),
      requireExceptionTargets: false,
    }),
    (error) => error.code === 'SURFACE_FORM_REVIEW_MANIFEST_UNAVAILABLE',
  );

  const unreviewed = buildSurfaceFormProjection(records, { exceptionManifest });
  const changedReview = reviewManifest([], reviewCollisionsFrom(unreviewed.collisions));
  changedReview.reviewed_collisions.ambiguous_generated = [];
  await assert.rejects(
    () => validateCanonicalSurfaceFormProjection({
      canonicalContext: context,
      exceptionManifest,
      reviewManifest: changedReview,
      requireExceptionTargets: false,
    }),
    (error) => error.code === 'SURFACE_FORM_COLLISION_REVIEW_MISMATCH',
  );
});

test('new exact entry and expression collisions fail until their candidates are reviewed', () => {
  const exceptionManifest = {
    schema_version: 1,
    contract_id: 'm6-2-inflection-exceptions-v1',
    exceptions: [],
  };
  const generated = entry('w9930', '먹다', 'verb');
  const exactEntry = entry('w9931', '식물', 'noun', ['먹는']);
  const exactExpression = {
    id: 'w9932',
    record_type: 'expression',
    role: 'start',
    candidate_id: 'w9932',
    lemma: '먹는',
    search_forms: [],
    senses: [{ id: 'w9932-s1', pos: 'expression', gloss: 'fixture', relations: [] }],
  };
  for (const exactRecord of [exactEntry, exactExpression]) {
    assert.throws(
      () => buildSurfaceFormProjection([generated, exactRecord], {
        exceptionManifest,
        reviewManifest: reviewManifest(),
        requireClassDispositions: true,
        requireCollisionReview: true,
      }),
      (error) => error.code === 'SURFACE_FORM_COLLISION_REVIEW_MISMATCH',
    );
  }
});

test('approved generated ambiguity preserves every reviewed sense candidate', async () => {
  const records = [entry('w9940', '듣다', 'verb'), entry('w9941', '들다', 'verb')];
  const exceptionManifest = {
    schema_version: 1,
    contract_id: 'm6-2-inflection-exceptions-v1',
    exceptions: [{
      class_id: 'm6-2-d-irregular-verb',
      record_id: 'w9940',
      sense_id: 'w9940-s1',
    }],
  };
  const candidateProjection = buildSurfaceFormProjection(records, { exceptionManifest });
  const reviewed = reviewManifest([], reviewCollisionsFrom(candidateProjection.collisions));
  const projection = buildSurfaceFormProjection(records, {
    exceptionManifest,
    reviewManifest: reviewed,
    requireClassDispositions: true,
    requireCollisionReview: true,
  });
  assert.deepEqual(
    rowsForForm(projection, '들었다').map(({ record_id, sense_id }) => `${record_id}/${sense_id}`),
    ['w9940/w9940-s1', 'w9941/w9941-s1'],
  );
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
