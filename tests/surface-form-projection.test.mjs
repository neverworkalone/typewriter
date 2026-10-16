import { canonicalRecordsBeforeFactoryAdmissions, readSemanticDecisionSourceArtifact } from '../scripts/validate/semantic-audit.mjs';
import { projectHistoricalSurfaceFormReview } from '../scripts/batch/historical-canonical.mjs';
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
  buildOrReuseSurfaceFormProjection,
  buildSurfaceFormProjection,
  loadSurfaceFormExceptionManifest,
  loadSurfaceFormReviewManifest,
} from '../scripts/inflection/surface-form-projection.mjs';
import {
  findRecordsBySearchTerm,
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
  const insertSurfaceForm = database.prepare(
    'INSERT INTO generated_surface_forms (form, record_id, sense_id, sense_position, rule_id) VALUES (?, ?, ?, ?, ?)',
  );
  const sensePosition = new Map(records.flatMap((record) => (
    record.senses.map((sense, position) => [sense.id, position])
  )));

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
  }
  for (const row of projection.rows) {
    insertSurfaceForm.run(row.form, row.record_id, row.sense_id, sensePosition.get(row.sense_id), row.rule_id);
  }
  return database;
}

function rowsForForm(projection, form) {
  return projection.rows.filter((row) => row.form === form);
}

function reviewManifest(dispositions = [], reviewedCollisions = {}) {
  return {
    schema_version: 1,
    contract_id: 'm6-3-searchable-predicate-review-v2',
    source_issue: 209,
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
    () => validateDatasetRecords(context.records, {
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
  validateDatasetRecords(context.records, {
    context,
    lexicalQuality: { blocking_finding_count: 0, blocking_findings: [] },
    requireSurfaceFormProjection: true,
  });
  const projection = context.derived.surfaceFormProjection;
  assert.ok(rowsForForm(projection, '상관없는').some(({ record_id }) => record_id === record.id));
  assert.deepEqual(rowsForForm(projection, '상관없은'), []);
});

test('strict common admission requires and applies the 있다 adjective class', () => {
  const record = entry('w9951', '맛있다', 'adjective');
  const recordInfo = { record, filePath: 'future-canonical.jsonl', lineNumber: 1 };
  const context = createCanonicalContext({ records: [recordInfo], fileCount: 1 }, {
    canonicalDirectory: path.join(repositoryRoot, 'future-itda-fixture'),
  });
  const exceptionManifest = {
    schema_version: 1,
    contract_id: 'm6-2-inflection-exceptions-v1',
    exceptions: [],
  };
  context.derived.surfaceFormExceptionManifest = exceptionManifest;
  context.derived.surfaceFormReviewManifest = reviewManifest();

  assert.throws(
    () => validateDatasetRecords(context.records, {
      context,
      lexicalQuality: { blocking_finding_count: 0, blocking_findings: [] },
      requireSurfaceFormProjection: true,
    }),
    (error) => error.code === 'MISSING_EXCEPTION_CLASS',
  );

  context.derived.surfaceFormExceptionManifest = {
    ...exceptionManifest,
    exceptions: [{
      class_id: 'm6-2-itda-present-adnominal',
      record_id: record.id,
      sense_id: `${record.id}-s1`,
    }],
  };
  validateDatasetRecords(context.records, {
    context,
    lexicalQuality: { blocking_finding_count: 0, blocking_findings: [] },
    requireSurfaceFormProjection: true,
  });
  const projection = context.derived.surfaceFormProjection;
  assert.ok(rowsForForm(projection, '맛있는').some(({ record_id }) => record_id === record.id));
  assert.deepEqual(rowsForForm(projection, '맛있은'), []);
  const reusedProjection = buildOrReuseSurfaceFormProjection(context.records, {
    context,
    exceptionManifest: context.derived.surfaceFormExceptionManifest,
    reviewManifest: context.derived.surfaceFormReviewManifest,
    requireClassDispositions: true,
    requireCollisionReview: true,
  });
  assert.strictEqual(reusedProjection, projection);
  assert.equal(context.metrics.surface_form_projection_build_count, 1);
});

test('synthetic corpora above production size do not inherit the production review manifest', () => {
  const records = Array.from({ length: 5_001 }, (_, index) => {
    const id = `r${String(index + 1).padStart(5, '0')}`;
    return {
      id,
      record_type: 'entry',
      role: 'reference-only',
      lemma: `synthetic-${String(index + 1).padStart(5, '0')}`,
      search_forms: [`synthetic-${String(index + 1).padStart(5, '0')}`],
      senses: [{
        id: `${id}-s1`,
        pos: 'noun',
        gloss: `synthetic benchmark record ${index + 1}`,
        relations: [],
      }],
    };
  });
  const recordInfos = records.map((record, index) => ({
    record,
    filePath: 'synthetic-benchmark.jsonl',
    lineNumber: index + 1,
  }));
  assert.doesNotThrow(() => validateDatasetRecords(recordInfos, {
    requireTopicAnalysis: false,
  }));
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
      [records.find(({ id }) => id === 'w014')],
      collision.matches,
    );
    assert.deepEqual(generatedProjection[0].senses.map(({ id }) => id), ['w014-s1']);
    const exactListen = findRecordsBySearchTerm(database, '듣다');
    const exactProjection = projectSearchResults(
      [records.find(({ id }) => id === 'w014')],
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

// Official-source (licensed) predicate senses carry no sense-by-sense dispositions: the shared rule applies
// what it dictates and generates nothing a reviewer would have had to judge. Authored records keep the gate.
const licensed = (record) => ({ ...record, source: 'stdict' });
const strictBuild = (records, dispositions = [], exceptions = []) => buildSurfaceFormProjection(records, {
  exceptionManifest: { schema_version: 1, contract_id: 'm6-2-inflection-exceptions-v1', exceptions },
  reviewManifest: reviewManifest(dispositions),
  requireExceptionTargets: true,
  requireClassDispositions: true,
});
const gateFixtures = () => [
  entry('w9960', '상관없다', 'adjective'),
  entry('w9961', '맛있다', 'adjective'),
  entry('w9962', '좋다', 'adjective'),
  entry('w9963', '입다', 'verb'),
  entry('w9964', '지키다', 'verb'),
  entry('w9965', '먹다', 'verb'),
];

test('official-source predicates pass the strict gate without per-sense dispositions', () => {
  const projection = strictBuild(gateFixtures().map(licensed));
  const formsOf = (id) => projection.rows.filter(({ record_id: recordId }) => recordId === id);
  assert.ok(rowsForForm(projection, '상관없는').some(({ record_id: id }) => id === 'w9960'));
  assert.deepEqual(rowsForForm(projection, '상관없은'), []);
  assert.ok(rowsForForm(projection, '맛있는').some(({ record_id: id }) => id === 'w9961'));
  assert.ok(rowsForForm(projection, '먹는').some(({ record_id: id }) => id === 'w9965'));
  // Unreviewed risk coda: nothing is guessed, and exact lemma lookup is unaffected.
  assert.deepEqual(formsOf('w9962'), []);
  assert.deepEqual(formsOf('w9963'), []);
  // Unsupported open-vowel plain past is skipped while the other forms remain.
  assert.ok(rowsForForm(projection, '지키는').some(({ record_id: id }) => id === 'w9964'));
  assert.ok(!formsOf('w9964').some(({ rule_id: rule }) => rule.startsWith('predicate-plain-past')));
  assert.ok(projection.exclusions.some(({ record_id: id }) => id === 'w9962'));
});

test('the same predicates without the official-source marker still need explicit dispositions', () => {
  for (const [index, code] of [[0, 'MISSING_EXCEPTION_CLASS'], [2, 'MISSING_PREDICATE_CLASS_DISPOSITION'], [4, 'MISSING_PLAIN_PAST_DISPOSITION']]) {
    assert.throws(() => strictBuild([gateFixtures()[index]]), (error) => error.code === code);
  }
});

test('explicit manifests on official-source predicates still win and are still validated', () => {
  const records = gateFixtures().map(licensed);
  const regular = strictBuild(records, [{
    class_id: 'm6-3-regular-h-adjective', record_id: 'w9962', sense_id: 'w9962-s1', reason: 'Reviewed regular class.',
  }]);
  assert.ok(regular.rows.some(({ record_id: id }) => id === 'w9962'));
  assert.throws(() => strictBuild(records, [{
    class_id: 'm6-3-regular-h-adjective', record_id: 'w9963', sense_id: 'w9963-s1', reason: 'Wrong coda.',
  }]), (error) => error.code === 'SURFACE_FORM_REVIEW_CLASS_TARGET_MISMATCH');
  assert.throws(() => strictBuild(records, [], [{
    class_id: 'm6-2-b-irregular-adjective', record_id: 'w9999', sense_id: 'w9999-s1',
  }]), (error) => error.code === 'MISSING_EXCEPTION_RECORD');
});

test('collisions among official-source records need no per-form review, authored ones still do', () => {
  const build = (records) => buildSurfaceFormProjection(records, {
    exceptionManifest: { schema_version: 1, contract_id: 'm6-2-inflection-exceptions-v1', exceptions: [] },
    reviewManifest: reviewManifest(),
    requireExceptionTargets: true,
    requireClassDispositions: true,
    requireCollisionReview: true,
  });
  // `먹는` is generated for the verb and is also the exact lemma of a noun; `보다` and `보다` homographs generate the same `본`.
  const pair = (marked) => [entry('w9970', '먹다', 'verb'), entry('w9971', '먹는', 'noun'), entry('w9972', '보다', 'verb'), entry('w9973', '보다', 'verb')]
    .map((record) => (marked ? licensed(record) : record));
  const official = build(pair(true));
  assert.ok(official.collisions.exactCollisions.length > 0 && official.collisions.ambiguousGeneratedForms.length > 0, 'the collisions are still detected and reported');
  for (const code of ['SURFACE_FORM_COLLISION_REVIEW_MISMATCH']) {
    assert.throws(() => build(pair(false)), (error) => error.code === code, 'the same collisions among authored records need a review');
    assert.throws(() => build([...pair(true).slice(0, 3), entry('w9974', '보다', 'verb')]), (error) => error.code === code, 'one authored candidate restores the review');
  }
});
