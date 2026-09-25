import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CANONICAL_DIRECTORY,
} from '../validate/canonical-jsonl.mjs';
import { loadCanonicalContext } from '../validate/canonical-context.mjs';
import { validateDatasetDirectory } from '../validate/dataset-integrity.mjs';
import { normalizeCanonicalDirectory } from '../normalize/canonical.mjs';
import { buildDictionary } from '../build/dictionary.mjs';
import {
  findRecordsByExactTerm,
  getMetadata,
  getRecord,
  getSenseRelations,
  readLogicalDatabaseSnapshot,
} from '../build/query.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');

function countRelations(records) {
  return records.reduce(
    (count, record) => count + record.senses.reduce(
      (senseCount, sense) => senseCount + sense.relations.length,
      0,
    ),
    0,
  );
}

function countSearchForms(records) {
  return records.reduce(
    (count, record) => count + record.search_forms.length,
    0,
  );
}

function expectedRowsFromNormalizedModel(model, generatedSurfaceForms) {
  const records = model.records.map((record) => ({
    id: record.id,
    record_type: record.record_type,
    role: record.role,
    candidate_id: record.candidate_id,
    lemma: record.lemma,
  }));
  const searchForms = model.records.flatMap((record) => (
    record.search_forms.map((form, position) => ({
      record_id: record.id,
      position,
      form,
    }))
  ));
  const senses = model.records.flatMap((record) => (
    record.senses.map((sense, position) => ({
      id: sense.id,
      record_id: record.id,
      position,
      pos: sense.pos,
      gloss: sense.gloss,
    }))
  ));
  const relations = model.records.flatMap((record) => (
    record.senses.flatMap((sense) => (
      sense.relations.map((relation, position) => ({
        source_sense_id: sense.id,
        position,
        target_record_id: relation.target,
        target_sense_id: relation.target_sense,
        type: relation.type,
        note: relation.note,
      }))
    ))
  ));

  return {
    records: records.sort((left, right) => left.id.localeCompare(right.id, 'en')),
    search_forms: searchForms.sort((left, right) => (
      left.record_id.localeCompare(right.record_id, 'en')
      || left.position - right.position
    )),
    senses: senses.sort((left, right) => (
      left.record_id.localeCompare(right.record_id, 'en')
      || left.position - right.position
    )),
    relations: relations.sort((left, right) => (
      left.source_sense_id.localeCompare(right.source_sense_id, 'en')
      || left.position - right.position
    )),
    generated_surface_forms: generatedSurfaceForms,
  };
}

function expectedRowsFromCanonicalRecords(canonicalRecords, generatedSurfaceForms) {
  const records = canonicalRecords.map((recordInfo) => recordInfo.record);
  const rows = {
    records: records.map((record) => ({
      id: record.id,
      record_type: record.record_type,
      role: record.role,
      candidate_id: record.candidate_id ?? null,
      lemma: record.lemma,
    })),
    search_forms: records.flatMap((record) => (
      record.search_forms.map((form, position) => ({
        record_id: record.id,
        position,
        form,
      }))
    )),
    senses: records.flatMap((record) => (
      record.senses.map((sense, position) => ({
        id: sense.id,
        record_id: record.id,
        position,
        pos: sense.pos,
        gloss: sense.gloss,
      }))
    )),
    relations: records.flatMap((record) => (
      record.senses.flatMap((sense) => (
        (sense.relations ?? []).map((relation, position) => ({
          source_sense_id: sense.id,
          position,
          target_record_id: relation.target,
          target_sense_id: relation.target_sense ?? null,
          type: relation.type,
          note: relation.note,
        }))
      ))
    )),
    generated_surface_forms: generatedSurfaceForms,
  };

  return {
    records: rows.records.sort((left, right) => left.id.localeCompare(right.id, 'en')),
    search_forms: rows.search_forms.sort((left, right) => (
      left.record_id.localeCompare(right.record_id, 'en')
      || left.position - right.position
    )),
    senses: rows.senses.sort((left, right) => (
      left.record_id.localeCompare(right.record_id, 'en')
      || left.position - right.position
    )),
    relations: rows.relations.sort((left, right) => (
      left.source_sense_id.localeCompare(right.source_sense_id, 'en')
      || left.position - right.position
    )),
    generated_surface_forms: generatedSurfaceForms,
  };
}

export function assertCanonicalModelMatchesRaw(canonicalRecords, model, generatedSurfaceForms = []) {
  assert.deepEqual(
    expectedRowsFromNormalizedModel(model, generatedSurfaceForms),
    expectedRowsFromCanonicalRecords(canonicalRecords, generatedSurfaceForms),
    'normalized model must preserve canonical logical fields',
  );
}

function expectedMetadata(model, surfaceProjection) {
  return {
    record_count: String(model.records.length),
    start_count: String(model.records.filter((record) => record.role === 'start').length),
    reference_only_count: String(
      model.records.filter((record) => record.role === 'reference-only').length,
    ),
    candidate_count: String(
      model.records.filter((record) => record.candidate_id !== null).length,
    ),
    search_form_count: String(countSearchForms(model.records)),
    sense_count: String(
      model.records.reduce((count, record) => count + record.senses.length, 0),
    ),
    relation_count: String(countRelations(model.records)),
    expression_count: String(
      model.records.filter((record) => record.record_type === 'expression').length,
    ),
    generated_surface_form_count: String(surfaceProjection.rows.length),
    surface_form_eligible_sense_count: String(surfaceProjection.coverage.eligible_sense_count),
    surface_form_exclusion_count: String(surfaceProjection.exclusions.length),
  };
}

function assertRepresentativeQueries(database, model) {
  const canonicalRecord = model.records.find((record) => record.id === 'w026');
  assert.ok(canonicalRecord, 'canonical w026 must exist');
  const canonicalSense = canonicalRecord.senses.find((sense) => sense.id === 'w026-s1');
  assert.ok(canonicalSense, 'canonical w026-s1 must exist');
  const canonicalRelation = canonicalSense.relations
    .find((relation) => relation.target === 'r008');
  assert.ok(canonicalRelation, 'canonical w026-s1 -> r008 relation must exist');

  assert.deepEqual(
    findRecordsByExactTerm(database, '담담').map(({ id, lemma }) => ({ id, lemma })),
    [{ id: 'w026', lemma: '담담하다' }],
  );

  const record = getRecord(database, 'w026');
  assert.equal(record.lemma, canonicalRecord.lemma);
  assert.deepEqual(record.search_forms, canonicalRecord.search_forms);

  const relation = getSenseRelations(database, 'w026-s1')
    .find(({ target }) => target === canonicalRelation.target);
  assert.ok(relation, 'SQLite relation target must be queryable');
  assert.equal(relation.target_sense, canonicalRelation.target_sense);
  assert.equal(relation.type, canonicalRelation.type);
  assert.equal(relation.note, canonicalRelation.note);
  assert.equal(relation.target_lemma, '덤덤하다');
}

function assertProvenanceMetadata(metadata, expectedWorktreeState = undefined) {
  assert.equal(metadata.dictionary_version, 'm2-pilot-1');
  assert.equal(metadata.schema_version, '2');
  assert.equal(metadata.normalization_version, '1');
  assert.equal(metadata.build_contract, 'canonical-jsonl -> normalized-v1 -> sqlite-v2');
  assert.equal(metadata.surface_form_projection_version, '1');
  assert.equal(metadata.build_tool_version, '1');
  assert.equal(metadata.node_version, process.version);
  assert.equal(metadata.sqlite_module, 'node:sqlite');
  assert.match(metadata.sqlite_version, /^\d+\.\d+\.\d+$/);
  assert.match(metadata.source_revision, /^[0-9a-f]{40}$/);
  assert.equal(metadata.source_revision_verified, 'true');
  assert.equal(metadata.source_revision_source, 'git-head');
  assert.ok(['clean', 'dirty-allowed'].includes(metadata.worktree_state));
  if (expectedWorktreeState !== undefined) {
    assert.equal(metadata.worktree_state, expectedWorktreeState);
  }
}

function verifyDatabase(database, model, expected, surfaceProjection, worktreeState) {
  const snapshot = readLogicalDatabaseSnapshot(database);
  assert.deepEqual(snapshot.rows.records, expected.records);
  assert.deepEqual(snapshot.rows.search_forms, expected.search_forms);
  assert.deepEqual(snapshot.rows.senses, expected.senses);
  assert.deepEqual(snapshot.rows.relations, expected.relations);
  assert.deepEqual(snapshot.rows.generated_surface_forms, surfaceProjection.rows);

  const metadata = getMetadata(database);
  for (const [key, value] of Object.entries(expectedMetadata(model, surfaceProjection))) {
    assert.equal(metadata[key], value, `metadata ${key}`);
  }
  assertProvenanceMetadata(metadata, worktreeState);
  assertRepresentativeQueries(database, model);
  return snapshot;
}

export function verifyDictionaryArtifact({
  databasePath,
  model,
  canonicalRecords,
  surfaceProjection,
  expectedWorktreeState,
}) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const expected = expectedRowsFromCanonicalRecords(canonicalRecords, surfaceProjection.rows);
    const metadata = getMetadata(database);
    const snapshot = verifyDatabase(
      database,
      model,
      expected,
      surfaceProjection,
      expectedWorktreeState ?? metadata.worktree_state,
    );
    return { metadata, snapshot };
  } finally {
    database.close();
  }
}

export async function runM2Pipeline({
  inputDirectory = DEFAULT_CANONICAL_DIRECTORY,
  repositoryDirectory = REPOSITORY_DIRECTORY,
  allowDirty = false,
  canonicalContext,
  databasePath,
  model: suppliedModel,
  requireSurfaceFormClassifications,
  requireSurfaceFormCollisionReview,
} = {}) {
  const context = canonicalContext ?? await loadCanonicalContext({
    directory: inputDirectory,
  });
  const isDefaultCanonicalDirectory = path.resolve(context.canonicalDirectory)
    === path.resolve(DEFAULT_CANONICAL_DIRECTORY);
  const requireClassDispositions = requireSurfaceFormClassifications
    ?? isDefaultCanonicalDirectory;
  const requireCollisionReview = requireSurfaceFormCollisionReview
    ?? requireClassDispositions;
  if (!requireClassDispositions) {
    // Historical fixtures and synthetic corpora are not the current production
    // revision. Keep their compatibility audit independent of production manifests.
    context.derived ??= {};
    context.derived.surfaceFormExceptionManifest = {
      schema_version: 1,
      contract_id: 'm6-2-inflection-exceptions-v1',
      source_issue: 174,
      exceptions: [],
    };
    context.derived.surfaceFormReviewManifest = {
      schema_version: 1,
      contract_id: 'm6-3-surface-form-review-v1',
      source_issue: 175,
      dispositions: [],
      reviewed_collisions: { exact_generated: [], ambiguous_generated: [] },
    };
  }
  const canonical = {
    fileCount: context.fileCount,
    records: context.records,
  };
  const dataset = await validateDatasetDirectory(inputDirectory, {
    checkPilotCompleteness: true,
    canonicalContext: context,
    semanticAudit: context.semanticAudit,
    requireSurfaceFormProjection: true,
    requireSurfaceFormClassifications: requireClassDispositions,
    requireSurfaceFormCollisionReview: requireCollisionReview,
  });
  const model = suppliedModel ?? await normalizeCanonicalDirectory(inputDirectory, {
    checkPilotCompleteness: true,
    canonicalContext: context,
    semanticAudit: context.semanticAudit,
  });

  assertCanonicalModelMatchesRaw(canonical.records, model);
  assert.equal(canonical.fileCount, dataset.fileCount);
  assert.equal(dataset.recordCount, model.records.length);
  assert.equal(dataset.senseCount, model.records.reduce(
    (count, record) => count + record.senses.length,
    0,
  ));
  assert.equal(dataset.relationCount, countRelations(model.records));
  assert.equal(dataset.candidateCount, model.records.filter(
    (record) => record.candidate_id !== null,
  ).length);
  const surfaceProjection = context.derived.surfaceFormProjection;
  if (!surfaceProjection) {
    throw new Error('Canonical dataset validation did not derive the surface-form projection.');
  }
  assertCanonicalModelMatchesRaw(canonical.records, model, surfaceProjection.rows);

  if (databasePath) {
    const verified = verifyDictionaryArtifact({
      databasePath,
      model,
      canonicalRecords: canonical.records,
      surfaceProjection,
    });
    return {
      ...dataset,
      startCount: model.records.filter((record) => record.role === 'start').length,
      referenceOnlyCount: model.records.filter(
        (record) => record.role === 'reference-only',
      ).length,
      searchFormCount: countSearchForms(model.records),
      expressionCount: model.records.filter(
        (record) => record.record_type === 'expression',
      ).length,
      normalizationVersion: model.normalization_version,
      databaseBuilds: 0,
      sourceRevision: verified.metadata.source_revision,
      worktreeState: verified.metadata.worktree_state,
    };
  }

  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), 'typewriter-m2-pipeline-'),
  );
  const firstPath = path.join(temporaryDirectory, 'first.sqlite');
  const secondPath = path.join(temporaryDirectory, 'second.sqlite');

  try {
    const first = await buildDictionary({
      inputDirectory,
      outputPath: firstPath,
      checkPilotCompleteness: true,
      repositoryDirectory,
      allowDirty,
      canonicalContext: context,
      semanticAudit: context.semanticAudit,
      requireSurfaceFormClassifications: requireClassDispositions,
      requireSurfaceFormCollisionReview: requireCollisionReview,
    });
    const second = await buildDictionary({
      inputDirectory,
      outputPath: secondPath,
      checkPilotCompleteness: true,
      repositoryDirectory,
      allowDirty,
      canonicalContext: context,
      semanticAudit: context.semanticAudit,
      requireSurfaceFormClassifications: requireClassDispositions,
      requireSurfaceFormCollisionReview: requireCollisionReview,
    });
    const expected = expectedRowsFromCanonicalRecords(canonical.records, surfaceProjection.rows);
    const expectedWorktreeState = first.metadata.worktree_state;

    const firstDatabase = new DatabaseSync(firstPath, { readOnly: true });
    const secondDatabase = new DatabaseSync(secondPath, { readOnly: true });
    let firstSnapshot;
    let secondSnapshot;
    try {
      firstSnapshot = verifyDatabase(
        firstDatabase,
        model,
        expected,
        surfaceProjection,
        expectedWorktreeState,
      );
      secondSnapshot = verifyDatabase(
        secondDatabase,
        model,
        expected,
        surfaceProjection,
        expectedWorktreeState,
      );
    } finally {
      firstDatabase.close();
      secondDatabase.close();
    }
    assert.deepEqual(firstSnapshot, secondSnapshot);
    assert.deepEqual(first.metadata, second.metadata);

    return {
      ...dataset,
      startCount: model.records.filter((record) => record.role === 'start').length,
      referenceOnlyCount: model.records.filter(
        (record) => record.role === 'reference-only',
      ).length,
      searchFormCount: countSearchForms(model.records),
      expressionCount: model.records.filter(
        (record) => record.record_type === 'expression',
      ).length,
      normalizationVersion: model.normalization_version,
      databaseBuilds: 2,
      sourceRevision: first.metadata.source_revision,
      worktreeState: first.metadata.worktree_state,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function main() {
  const canonicalContext = process.env.TYPEWRITER_CANONICAL_CONTEXT_PATH
    ? await loadCanonicalContext()
    : undefined;
  const summary = await runM2Pipeline({
    allowDirty: process.argv.includes('--allow-dirty'),
    canonicalContext,
    databasePath: process.env.TYPEWRITER_SHARED_DICTIONARY_PATH,
  });
  console.log(
    `M2 audit passed: ${summary.fileCount} canonical file(s) / ${summary.recordCount} record(s) / ${summary.senseCount} sense(s) / ${summary.relationCount} relation(s), with ${summary.databaseBuilds} reproducible SQLite builds.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
