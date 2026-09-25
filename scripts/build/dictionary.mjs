import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  ValidationError,
} from '../validate/canonical-jsonl.mjs';
import {
  loadCanonicalContext,
  markSQLiteBuild,
} from '../validate/canonical-context.mjs';
import { normalizeCanonicalDirectory } from '../normalize/canonical.mjs';
import {
  BUILD_TOOL_VERSION,
  resolveBuildProvenance,
} from './provenance.mjs';
import { SQLITE_SCHEMA_SQL, SQLITE_SCHEMA_VERSION } from './sqlite-schema.mjs';
import {
  buildOrReuseSurfaceFormProjection,
  loadSurfaceFormExceptionManifest,
  loadSurfaceFormReviewManifest,
  SURFACE_FORM_PROJECTION_VERSION,
} from '../inflection/surface-form-projection.mjs';

export const DICTIONARY_VERSION = 'm2-pilot-1';
export const DEFAULT_DICTIONARY_OUTPUT = path.resolve(
  'artifacts/dictionary.sqlite',
);

export class BuildError extends Error {
  constructor(message, code = 'BUILD_ERROR') {
    super(message);
    this.name = 'BuildError';
    this.code = code;
  }
}

function countRelations(records) {
  return records.reduce(
    (count, record) =>
      count +
      record.senses.reduce(
        (senseCount, sense) => senseCount + sense.relations.length,
        0,
      ),
    0,
  );
}

function assertOutputIsGeneratedOutsideCanonical(inputDirectory, outputPath) {
  const canonicalPath = path.resolve(inputDirectory);
  const resolvedOutputPath = path.resolve(outputPath);
  const relativeOutputPath = path.relative(canonicalPath, resolvedOutputPath);
  const isInsideCanonical =
    relativeOutputPath === '' ||
    (!relativeOutputPath.startsWith('..') && !path.isAbsolute(relativeOutputPath));

  if (isInsideCanonical) {
    throw new BuildError(
      `generated SQLite output must be outside canonical input: ${resolvedOutputPath}`,
      'OUTPUT_INSIDE_CANONICAL',
    );
  }
}

function metadataEntries(model, metadata, surfaceProjection) {
  const counts = {
    record_count: model.records.length,
    start_count: model.records.filter((record) => record.role === 'start').length,
    reference_only_count: model.records.filter(
      (record) => record.role === 'reference-only',
    ).length,
    candidate_count: model.records.filter(
      (record) => record.candidate_id !== null,
    ).length,
    search_form_count: model.records.reduce(
      (count, record) => count + record.search_forms.length,
      0,
    ),
    sense_count: model.records.reduce(
      (count, record) => count + record.senses.length,
      0,
    ),
    relation_count: countRelations(model.records),
    generated_surface_form_count: surfaceProjection.rows.length,
    surface_form_eligible_sense_count: surfaceProjection.coverage.eligible_sense_count,
    surface_form_exclusion_count: surfaceProjection.exclusions.length,
    expression_count: model.records.filter(
      (record) => record.record_type === 'expression',
    ).length,
  };

  const values = {
    ...metadata,
    build_contract: 'canonical-jsonl -> normalized-v1 -> sqlite-v2',
    surface_form_projection_version: SURFACE_FORM_PROJECTION_VERSION,
    build_tool_version: BUILD_TOOL_VERSION,
    dictionary_version: DICTIONARY_VERSION,
    normalization_version: model.normalization_version,
    schema_version: SQLITE_SCHEMA_VERSION,
    ...counts,
  };

  return Object.entries(values)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => {
      if (value === undefined || value === null) {
        throw new BuildError(
          `metadata ${key} must not be null or undefined`,
          'INVALID_METADATA',
        );
      }

      return [key, String(value)];
    });
}

function insertModel(database, model, metadata, surfaceFormRows) {
  const insertMetadata = database.prepare(
    'INSERT INTO metadata (key, value) VALUES (?, ?)',
  );
  const insertRecord = database.prepare(
    'INSERT INTO records (id, record_type, role, candidate_id, lemma) VALUES (?, ?, ?, ?, ?)',
  );
  const insertSearchForm = database.prepare(
    'INSERT INTO search_forms (record_id, position, form) VALUES (?, ?, ?)',
  );
  const insertSense = database.prepare(
    'INSERT INTO senses (id, record_id, position, pos, gloss) VALUES (?, ?, ?, ?, ?)',
  );
  const insertGeneratedSurfaceForm = database.prepare(
    'INSERT INTO generated_surface_forms (form, record_id, sense_id, rule_id) VALUES (?, ?, ?, ?)',
  );
  const insertRelation = database.prepare(
    `INSERT INTO relations
      (source_sense_id, position, target_record_id, target_sense_id, type, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (const [key, value] of metadata) {
    insertMetadata.run(key, value);
  }

  for (const record of model.records) {
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

  for (const row of surfaceFormRows) {
    insertGeneratedSurfaceForm.run(
      row.form,
      row.record_id,
      row.sense_id,
      row.rule_id,
    );
  }

  // Insert relations after every record and sense so forward references are
  // supported while SQLite still enforces the relation graph.
  for (const record of model.records) {
    for (const sense of record.senses) {
      sense.relations.forEach((relation, position) => {
        insertRelation.run(
          sense.id,
          position,
          relation.target,
          relation.target_sense,
          relation.type,
          relation.note,
        );
      });
    }
  }
}

function verifyDatabase(database) {
  const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyErrors.length > 0) {
    throw new BuildError(
      `SQLite foreign-key check failed: ${JSON.stringify(foreignKeyErrors)}`,
      'FOREIGN_KEY_CHECK',
    );
  }

  const integrity = database.prepare('PRAGMA integrity_check').get();
  if (!integrity || integrity.integrity_check !== 'ok') {
    throw new BuildError(
      `SQLite integrity check failed: ${JSON.stringify(integrity)}`,
      'INTEGRITY_CHECK',
    );
  }
}

export async function buildDictionary({
  inputDirectory = DEFAULT_CANONICAL_DIRECTORY,
  outputPath = DEFAULT_DICTIONARY_OUTPUT,
  metadata = {},
  checkPilotCompleteness = false,
  repositoryDirectory = process.cwd(),
  sourceRevision,
  allowDirty = false,
  canonicalContext,
  semanticAudit,
  normalizedModel,
  requireSurfaceFormClassifications,
  requireSurfaceFormCollisionReview,
} = {}) {
  const resolvedOutputPath = path.resolve(outputPath);
  assertOutputIsGeneratedOutsideCanonical(inputDirectory, resolvedOutputPath);

  const context = canonicalContext ?? await loadCanonicalContext({
    directory: inputDirectory,
  });
  const model = normalizedModel ?? await normalizeCanonicalDirectory(inputDirectory, {
    checkPilotCompleteness,
    canonicalContext: context,
    semanticAudit,
  });
  const exceptionManifest = context.derived?.surfaceFormExceptionManifest
    ?? await loadSurfaceFormExceptionManifest();
  context.derived.surfaceFormExceptionManifest = exceptionManifest;
  const requireExceptionTargets = path.resolve(inputDirectory)
    === path.resolve(DEFAULT_CANONICAL_DIRECTORY);
  const requireClassDispositions = requireSurfaceFormClassifications
    ?? requireExceptionTargets;
  const requireCollisionReview = requireSurfaceFormCollisionReview
    ?? requireClassDispositions;
  const reviewManifest = context.derived?.surfaceFormReviewManifest
    ?? (requireClassDispositions ? await loadSurfaceFormReviewManifest() : undefined);
  if (reviewManifest) context.derived.surfaceFormReviewManifest = reviewManifest;
  const surfaceFormProjection = buildOrReuseSurfaceFormProjection(context.records, {
    context,
    exceptionManifest,
    reviewManifest,
    requireExceptionTargets,
    requireClassDispositions,
    requireCollisionReview,
  });
  const provenance = await resolveBuildProvenance({
    repositoryDirectory,
    sourceRevision,
    allowDirty,
  });

  await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await rm(resolvedOutputPath, { force: true });

  let database;
  let generatedMetadata;
  try {
    database = new DatabaseSync(resolvedOutputPath);
    const sqliteVersion = database
      .prepare('SELECT sqlite_version() AS version')
      .get().version;
    generatedMetadata = metadataEntries(model, {
      ...metadata,
      ...(context.canonicalRevision
        ? { canonical_revision: context.canonicalRevision }
        : {}),
      ...provenance,
      node_version: process.version,
      sqlite_module: 'node:sqlite',
      sqlite_version: sqliteVersion,
    }, surfaceFormProjection);
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec(
      `PRAGMA user_version = ${Number.parseInt(SQLITE_SCHEMA_VERSION, 10)};`,
    );
    database.exec(SQLITE_SCHEMA_SQL);
    database.exec('BEGIN IMMEDIATE;');
    insertModel(database, model, generatedMetadata, surfaceFormProjection.rows);
    database.exec('COMMIT;');
    verifyDatabase(database);
  } catch (error) {
    if (database) {
      try {
        database.exec('ROLLBACK;');
      } catch {
        // The transaction may already have been committed or never started.
      }
      database.close();
      database = undefined;
    }
    await rm(resolvedOutputPath, { force: true });

    if (error instanceof ValidationError || error instanceof BuildError) {
      throw error;
    }

    throw new BuildError(error.message, 'SQLITE_BUILD_ERROR');
  }

  database.close();
  markSQLiteBuild(context);

  return {
    outputPath: resolvedOutputPath,
    recordCount: model.records.length,
    searchFormCount: model.records.reduce(
      (count, record) => count + record.search_forms.length,
      0,
    ),
    senseCount: model.records.reduce(
      (count, record) => count + record.senses.length,
      0,
    ),
    relationCount: countRelations(model.records),
    generatedSurfaceFormCount: surfaceFormProjection.rows.length,
    surfaceFormExclusionCount: surfaceFormProjection.exclusions.length,
    surfaceFormCoverage: surfaceFormProjection.coverage,
    metadata: Object.fromEntries(generatedMetadata),
  };
}

export async function main() {
  const summary = await buildDictionary({
    checkPilotCompleteness: !process.argv.includes('--no-pilot-regression'),
    allowDirty: process.argv.includes('--allow-dirty'),
  });
  console.log(
    `Built ${summary.outputPath}: ${summary.recordCount} record(s) / ${summary.senseCount} sense(s) / ${summary.relationCount} relation(s).`,
  );

  return summary;
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
