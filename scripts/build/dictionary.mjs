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
import { SQLITE_SCHEMA_SQL, SQLITE_SCHEMA_VERSION, SQLITE_SOURCE_SCHEMA_SQL } from './sqlite-schema.mjs';
import { MEANING_SOURCE_INTEGRITY_QUERIES } from './meaning-source-checks.mjs';
import { loadMeaningData, canonicalSensesFromContext, parseMeaningId } from '../meaning/contract.mjs';
import { compareMeaningRank, countMeaningRelations } from '../../src/runtime/meaning-ranking.js';
import { projectMeaningRelations } from '../meaning/project.mjs';
import { DICTIONARY_VERSION, MEANING_INTEGRITY_QUERIES } from '../../src/runtime/dictionary-contract.js';
import {
  buildOrReuseSurfaceFormProjection,
  loadSurfaceFormExceptionManifest,
  loadSurfaceFormReviewManifest,
  SURFACE_FORM_PROJECTION_VERSION,
} from '../inflection/surface-form-projection.mjs';

export { DICTIONARY_VERSION };
export const DEFAULT_DICTIONARY_OUTPUT = path.resolve(
  'artifacts/dictionary.sqlite',
);

const DEFAULT_MEANINGS_DIRECTORY = path.resolve('data/meanings');
const DEFAULT_ADJUDICATION_DIRECTORY = path.resolve('data/adjudication');

/**
 * The product meaning layer: the whole `data/meanings` corpus (validated complete against canonical) for the default
 * canonical input; fixture inputs get an empty layer unless a meaning directory is supplied explicitly.
 */
function loadMeaningLayer({ model, context, inputDirectory, meaningsDirectory, adjudicationDirectory }) {
  const isDefault = path.resolve(inputDirectory) === path.resolve(DEFAULT_CANONICAL_DIRECTORY);
  const meaningDir = meaningsDirectory ?? (isDefault ? DEFAULT_MEANINGS_DIRECTORY : null);
  if (!meaningDir) {
    return { meanings: [], adjudications: [], relations: [], stats: projectMeaningRelations({ records: [], meanings: [] }).stats };
  }
  const loaded = loadMeaningData({
    meaningsDirectory: meaningDir,
    adjudicationDirectory: adjudicationDirectory ?? DEFAULT_ADJUDICATION_DIRECTORY,
    senses: canonicalSensesFromContext(context),
    complete: true,
  });
  if (loaded.errors.length > 0) {
    throw new BuildError(
      `meaning data is invalid: ${loaded.errors.slice(0, 10).join('; ')}`,
      'INVALID_MEANING_DATA',
    );
  }
  const projection = projectMeaningRelations({
    records: model.records,
    meanings: loaded.meanings,
    adjudications: loaded.adjudications,
  });
  return {
    meanings: loaded.meanings,
    adjudications: loaded.adjudications,
    relations: projection.relations,
    stats: projection.stats,
  };
}

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

function metadataEntries(model, metadata, surfaceProjection, meaningLayer) {
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
    meaning_count: meaningLayer.meanings.length,
    meaning_member_count: meaningLayer.meanings.reduce(
      (count, meaning) => count + meaning.sense_ids.length,
      0,
    ),
    meaning_relation_count: meaningLayer.relations.length,
    meaning_relation_source_count: meaningLayer.relations.reduce(
      (count, relation) => count + relation.sources.length,
      0,
    ),
    sense_adjudication_count: meaningLayer.adjudications.length,
    ...Object.fromEntries(
      Object.entries(meaningLayer.stats).map(([key, value]) => [`meaning_projection_${key}`, value]),
    ),
    expression_count: model.records.filter(
      (record) => record.record_type === 'expression',
    ).length,
  };

  const values = {
    ...metadata,
    build_contract: `canonical-jsonl -> normalized-v1 -> sqlite-v${SQLITE_SCHEMA_VERSION}`,
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

/**
 * Precompute the display ranking so the runtime only sorts by `display_rank`: relation counts per meaning
 * (distinct targets) and a dense total order. Returned in rank order so the stored rows are deterministic.
 */
function rankMeanings(meaningLayer) {
  const relationsBySource = new Map();
  for (const relation of meaningLayer.relations) {
    const list = relationsBySource.get(relation.source_meaning_id) ?? [];
    list.push(relation);
    relationsBySource.set(relation.source_meaning_id, list);
  }
  return meaningLayer.meanings
    .map((meaning) => {
      const { lexical, exploratory } = countMeaningRelations(relationsBySource.get(meaning.id) ?? []);
      return {
        ...meaning,
        record_id: parseMeaningId(meaning.id).entryId,
        lexical_relation_count: lexical,
        exploratory_relation_count: exploratory,
      };
    })
    .sort(compareMeaningRank)
    .map((meaning, index) => ({ ...meaning, display_rank: index + 1 }));
}

function insertModel(database, model, metadata, surfaceFormRows, meaningLayer) {
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
    'INSERT INTO generated_surface_forms (form, record_id, sense_id, sense_position, rule_id) VALUES (?, ?, ?, ?, ?)',
  );
  const insertRelation = database.prepare(
    `INSERT INTO relations
      (source_sense_id, position, target_record_id, target_sense_id, type, note, relevance)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertMeaning = database.prepare(
    `INSERT INTO meanings
      (id, lemma, gloss, pos, record_id, lexical_relation_count, exploratory_relation_count, display_rank)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMember = database.prepare(
    'INSERT INTO meaning_members (meaning_id, position, sense_id, record_id) VALUES (?, ?, ?, ?)',
  );
  const insertAdjudication = database.prepare(
    'INSERT INTO sense_adjudications (sense_id, reason, record_id, duplicate_of_sense_id) VALUES (?, ?, ?, ?)',
  );
  const insertMeaningRelation = database.prepare(
    `INSERT INTO meaning_relations
      (source_meaning_id, position, target_meaning_id, type, note, relevance, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMeaningRelationSource = database.prepare(
    `INSERT INTO meaning_relation_sources
      (source_meaning_id, relation_position, position, source_sense_id, source_position,
       source_redirected, target_redirected)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const [key, value] of metadata) {
    insertMetadata.run(key, value);
  }

  // The shipped tables keep only what the product reads of a source sense (owner record, position, part of speech).
  const sourceSenses = new Map();
  for (const record of model.records) {
    record.senses.forEach((sense, position) => {
      sourceSenses.set(sense.id, { record_id: record.id, position, pos: sense.pos });
    });
  }
  const sourceSense = (senseId) => {
    const sense = sourceSenses.get(senseId);
    if (!sense) throw new BuildError(`meaning layer references unknown sense ${senseId}`, 'INVALID_MEANING_DATA');
    return sense;
  };

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
      sourceSense(row.sense_id).position,
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
          relation.relevance ?? null,
        );
      });
    }
  }

  // The meaning layer references senses and the original relation rows, so it follows them.
  for (const meaning of rankMeanings(meaningLayer)) {
    insertMeaning.run(
      meaning.id,
      meaning.lemma,
      meaning.gloss,
      sourceSense(meaning.sense_ids[0]).pos,
      meaning.record_id,
      meaning.lexical_relation_count,
      meaning.exploratory_relation_count,
      meaning.display_rank,
    );
    meaning.sense_ids.forEach((senseId, position) => {
      insertMember.run(meaning.id, position, senseId, sourceSense(senseId).record_id);
    });
  }
  for (const item of meaningLayer.adjudications) {
    insertAdjudication.run(item.sense_id, item.reason, sourceSense(item.sense_id).record_id, item.duplicate_of ?? null);
  }
  for (const relation of meaningLayer.relations) {
    insertMeaningRelation.run(
      relation.source_meaning_id,
      relation.position,
      relation.target_meaning_id,
      relation.type,
      relation.note,
      relation.relevance,
      relation.origin,
    );
    relation.sources.forEach((source, position) => {
      insertMeaningRelationSource.run(
        relation.source_meaning_id,
        relation.position,
        position,
        source.source_sense_id,
        source.source_position,
        source.source_redirected,
        source.target_redirected,
      );
    });
  }
}

const DEPLOYED_TABLE_COPIES = [
  ['metadata', 'key, value', 'key'],
  ['records', 'id, record_type, role, candidate_id, lemma', 'id'],
  ['search_forms', 'record_id, position, form', 'record_id, position'],
  ['generated_surface_forms', 'form, record_id, sense_id, sense_position, rule_id', 'form, record_id, sense_id'],
  ['meanings', 'id, lemma, gloss, pos, record_id, lexical_relation_count, exploratory_relation_count, display_rank', 'id'],
  ['meaning_members', 'meaning_id, position, sense_id, record_id', 'meaning_id, position'],
  ['sense_adjudications', 'sense_id, reason, record_id, duplicate_of_sense_id', 'sense_id'],
  ['meaning_relations', 'source_meaning_id, position, target_meaning_id, type, note, relevance, origin', 'source_meaning_id, position'],
];

/** Copy the product tables from the verified staging database, in primary-key order so the output is deterministic. */
function copyDeployedTables(database, stagingPath) {
  database.prepare('ATTACH DATABASE ? AS staging').run(stagingPath);
  database.exec('BEGIN IMMEDIATE;');
  for (const [table, columns, order] of DEPLOYED_TABLE_COPIES) {
    database.exec(`INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM staging.${table} ORDER BY ${order};`);
  }
  database.exec('COMMIT;');
  database.exec('DETACH DATABASE staging;');
}

function verifyDatabase(database, { includeSource = false } = {}) {
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

  const queries = includeSource
    ? { ...MEANING_INTEGRITY_QUERIES, ...MEANING_SOURCE_INTEGRITY_QUERIES }
    : MEANING_INTEGRITY_QUERIES;
  for (const [name, sql] of Object.entries(queries)) {
    const violations = Number(Object.values(database.prepare(sql).get())[0]);
    if (violations !== 0) {
      throw new BuildError(
        `meaning relation provenance check ${name} found ${violations} violation(s)`,
        'MEANING_PROVENANCE_CHECK',
      );
    }
  }
}

export async function buildDictionary({
  inputDirectory = DEFAULT_CANONICAL_DIRECTORY,
  outputPath = DEFAULT_DICTIONARY_OUTPUT,
  metadata = {},
  repositoryDirectory = process.cwd(),
  sourceRevision,
  allowDirty = false,
  canonicalContext,
  semanticAudit,
  normalizedModel,
  meaningsDirectory,
  adjudicationDirectory,
  requireSurfaceFormClassifications,
  requireSurfaceFormCollisionReview,
  stagingOutputPath,
  keepStaging = false,
} = {}) {
  const resolvedOutputPath = path.resolve(outputPath);
  assertOutputIsGeneratedOutsideCanonical(inputDirectory, resolvedOutputPath);

  const context = canonicalContext ?? await loadCanonicalContext({
    directory: inputDirectory,
  });
  const model = normalizedModel ?? await normalizeCanonicalDirectory(inputDirectory, {
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
  const meaningLayer = loadMeaningLayer({
    model,
    context,
    inputDirectory,
    meaningsDirectory,
    adjudicationDirectory,
  });
  const provenance = await resolveBuildProvenance({
    repositoryDirectory,
    sourceRevision,
    allowDirty,
  });

  const stagingPath = path.resolve(stagingOutputPath ?? `${resolvedOutputPath}.staging`);
  if (stagingPath === resolvedOutputPath) {
    throw new BuildError('staging SQLite output must differ from the dictionary output', 'INVALID_STAGING_PATH');
  }
  assertOutputIsGeneratedOutsideCanonical(inputDirectory, stagingPath);

  await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await rm(resolvedOutputPath, { force: true });
  await rm(stagingPath, { force: true });

  let database;
  let generatedMetadata;
  try {
    database = new DatabaseSync(stagingPath);
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
    }, surfaceFormProjection, meaningLayer);
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec(SQLITE_SCHEMA_SQL);
    database.exec(SQLITE_SOURCE_SCHEMA_SQL);
    database.exec('BEGIN IMMEDIATE;');
    insertModel(database, model, generatedMetadata, surfaceFormProjection.rows, meaningLayer);
    database.exec('COMMIT;');
    verifyDatabase(database, { includeSource: true });
    database.close();
    database = undefined;

    // Only the verified meaning layer ships; the STDICT source senses/relations stay in the staging database.
    database = new DatabaseSync(resolvedOutputPath);
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec(
      `PRAGMA user_version = ${Number.parseInt(SQLITE_SCHEMA_VERSION, 10)};`,
    );
    database.exec(SQLITE_SCHEMA_SQL);
    copyDeployedTables(database, stagingPath);
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
    await rm(stagingPath, { force: true });

    if (error instanceof ValidationError || error instanceof BuildError) {
      throw error;
    }

    throw new BuildError(error.message, 'SQLITE_BUILD_ERROR');
  }

  database.close();
  if (!keepStaging) await rm(stagingPath, { force: true });
  markSQLiteBuild(context);

  return {
    outputPath: resolvedOutputPath,
    stagingPath: keepStaging ? stagingPath : null,
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
    meaningCount: meaningLayer.meanings.length,
    meaningRelationCount: meaningLayer.relations.length,
    meaningProjection: meaningLayer.stats,
    generatedSurfaceFormCount: surfaceFormProjection.rows.length,
    surfaceFormExclusionCount: surfaceFormProjection.exclusions.length,
    surfaceFormCoverage: surfaceFormProjection.coverage,
    metadata: Object.fromEntries(generatedMetadata),
  };
}

export async function main() {
  const summary = await buildDictionary({
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
