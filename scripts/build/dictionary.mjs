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
import { MEANING_SOURCE_INTEGRITY_QUERIES, assertRecordMeaningCoverage, glossReferenceViolations } from './meaning-source-checks.mjs';
import { compareMeaningIds } from '../../src/runtime/meaning-order.js';
import { projectDirectReverses } from './direct-reverse.mjs';
import { DEFAULT_RELATIONS_DIRECTORY, loadApprovedRelationFiles, loadShardSenseIds, projectAuthoredRelations } from './authored-relations.mjs';
import { projectGlossReferences } from './gloss-arrow-reference.mjs';
import { parseMeaningId, projectMeaningRelations, projectRecordMeanings } from './record-meanings.mjs';
import {
  DATABASE_KIND_KEY,
  DATABASE_KINDS,
  DICTIONARY_VERSION,
  MEANING_INTEGRITY_QUERIES,
} from '../../src/runtime/dictionary-contract.js';
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

/**
 * The product meaning layer (Issues #820, #822): derived from the canonical records alone (one record = one meaning
 * holding all of its senses). Fixture inputs (non-`w<number>` record ids) get an empty layer unless `recordMeanings`
 * asks for the projection.
 */
/**
 * `recordMeanings` is `undefined | boolean`: any other value is rejected, and the official canonical input accepts only
 * `undefined` or `true`, so no falsey value can produce an empty product meaning layer there.
 */
function assertRecordMeaningsOption(inputDirectory, recordMeanings) {
  if (recordMeanings !== undefined && typeof recordMeanings !== 'boolean') {
    throw new BuildError(`recordMeanings must be undefined or a boolean, received ${typeof recordMeanings}`, 'INVALID_OPTION');
  }
  if (recordMeanings === false && path.resolve(inputDirectory) === path.resolve(DEFAULT_CANONICAL_DIRECTORY)) {
    throw new BuildError(
      'the official canonical build always projects record meanings; recordMeanings: false is not allowed',
      'RECORD_MEANINGS_REQUIRED',
    );
  }
}

function loadMeaningLayer({ model, inputDirectory, recordMeanings, authoredFiles = [], shardSenseIds }) {
  const isDefault = path.resolve(inputDirectory) === path.resolve(DEFAULT_CANONICAL_DIRECTORY);
  assertRecordMeaningsOption(inputDirectory, recordMeanings);
  if (!(recordMeanings ?? isDefault)) {
    return { projected: false, meanings: [], relations: [], textRelations: [], stats: projectMeaningRelations({ records: [], meanings: [] }).stats };
  }
  const meanings = projectRecordMeanings(model.records);
  const projection = projectMeaningRelations({ records: model.records, meanings });
  // Issue #834: STDICT `→` references join the original `direct` relations before every `direct` is mirrored.
  const glossed = projectGlossReferences({ records: model.records, meanings, relations: projection.relations });
  const derived = projectDirectReverses({ relations: glossed.relations });
  const stdictRelations = [...glossed.relations, ...derived.relations];
  const authored = projectAuthoredRelations({ files: authoredFiles, records: model.records, meanings, existing: stdictRelations, shardSenseIds });
  const relations = [...stdictRelations, ...authored.relations];
  return {
    projected: true,
    meanings,
    relations,
    textRelations: authored.textRelations,
    glossHolds: glossed.holds,
    stats: {
      ...projection.stats,
      ...glossed.stats,
      ...Object.fromEntries(Object.entries(derived.stats).map(([key, value]) => [`direct_${key}`, value])),
      ...authored.stats,
    },
  };
}

const REMOVED_OPTIONS = ['meaningsDirectory', 'adjudicationDirectory'];

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
    meaning_text_relation_count: meaningLayer.textRelations.length,
    meaning_relation_source_count: meaningLayer.relations.reduce(
      (count, relation) => count + relation.sources.length,
      0,
    ),
    sense_adjudication_count: 0,
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
 * The meanings in stored order, each with its owner record and that record's STDICT homograph number (`null` when the
 * source headword had none). The number is copied, never derived: display order is decided from it at read time.
 */
function storedMeanings(meaningLayer, model) {
  const homographByRecord = new Map(model.records.map((record) => [record.id, record.homograph_no ?? null]));
  return meaningLayer.meanings
    .map((meaning) => {
      const recordId = parseMeaningId(meaning.id).entryId;
      return { ...meaning, record_id: recordId, homograph_no: homographByRecord.get(recordId) ?? null };
    })
    .sort((left, right) => compareMeaningIds(left.id, right.id));
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
      (id, lemma, gloss, record_id, homograph_no)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertMember = database.prepare(
    'INSERT INTO meaning_members (meaning_id, position, sense_id, record_id) VALUES (?, ?, ?, ?)',
  );
  const insertMeaningRelation = database.prepare(
    `INSERT INTO meaning_relations
      (source_meaning_id, position, target_meaning_id, type, note, relevance, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertReverseSource = database.prepare(
    `INSERT INTO meaning_relation_reverse_sources
      (source_meaning_id, relation_position, forward_source_meaning_id, forward_position)
     VALUES (?, ?, ?, ?)`,
  );
  const insertGlossSource = database.prepare(
    `INSERT INTO meaning_relation_gloss_sources
      (source_meaning_id, relation_position, position, source_sense_id, gloss_offset, reference_text,
       target_record_id, target_sense_position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTextRelation = database.prepare(
    `INSERT INTO meaning_text_relations (source_meaning_id, position, text, type, relevance)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertAuthoredSource = database.prepare(
    `INSERT INTO meaning_relation_authored_sources
      (source_meaning_id, relation_position, direction, source_sense_id, target_sense_id, shard, line)
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

  // The shipped tables keep only what the product reads of a source sense (owner record and position; part of speech stays in the Full `senses` table only).
  const sourceSenses = new Map();
  for (const record of model.records) {
    record.senses.forEach((sense, position) => {
      sourceSenses.set(sense.id, { record_id: record.id, position });
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
  for (const meaning of storedMeanings(meaningLayer, model)) {
    insertMeaning.run(
      meaning.id,
      meaning.lemma,
      meaning.gloss,
      meaning.record_id,
      meaning.homograph_no,
    );
    meaning.sense_ids.forEach((senseId, position) => {
      insertMember.run(meaning.id, position, senseId, sourceSense(senseId).record_id);
    });
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
  // `→` gloss evidence follows the relations it supports (Issue #834).
  for (const relation of meaningLayer.relations) {
    (relation.gloss_sources ?? []).forEach((source, position) => {
      insertGlossSource.run(
        relation.source_meaning_id, relation.position, position,
        source.source_sense_id, source.gloss_offset, source.reference_text,
        source.target_record_id, source.target_sense_position,
      );
    });
  }
  // Authored Relations (Issue #928): text-only rows and the approved-file provenance of every authored row.
  for (const relation of meaningLayer.textRelations) {
    insertTextRelation.run(relation.source_meaning_id, relation.position, relation.text, relation.type, relation.relevance);
  }
  for (const relation of meaningLayer.relations) {
    if (!relation.authored_source) continue;
    const source = relation.authored_source;
    insertAuthoredSource.run(
      relation.source_meaning_id, relation.position, source.direction,
      source.source_sense_id, source.target_sense_id, source.shard, source.line,
    );
  }
  // Derived reverse provenance follows every meaning relation it references.
  for (const relation of meaningLayer.relations) {
    if (!relation.reverse_of) continue;
    insertReverseSource.run(
      relation.source_meaning_id, relation.position,
      relation.reverse_of.source_meaning_id, relation.reverse_of.position,
    );
  }
}

export function verifyDatabase(database, { includeSource = false } = {}) {
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
  if (includeSource) {
    for (const [name, violations] of Object.entries(glossReferenceViolations(database))) {
      if (violations !== 0) {
        throw new BuildError(
          `meaning relation provenance check ${name} found ${violations} violation(s)`,
          'MEANING_PROVENANCE_CHECK',
        );
      }
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
  recordMeanings,
  relationsDirectory,
  requireSurfaceFormClassifications,
  requireSurfaceFormCollisionReview,
  ...removedOptions
} = {}) {
  for (const name of REMOVED_OPTIONS) {
    if (name in removedOptions) {
      throw new BuildError(
        `${name} was removed in Issue #822: the dictionary is built from data/canonical alone`,
        'REMOVED_OPTION',
      );
    }
  }
  const resolvedOutputPath = path.resolve(outputPath);
  assertOutputIsGeneratedOutsideCanonical(inputDirectory, resolvedOutputPath);
  assertRecordMeaningsOption(inputDirectory, recordMeanings);

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
  // Approved Relations JSONL feeds the official canonical build; fixture inputs opt in with `relationsDirectory`.
  const authoredFiles = await loadApprovedRelationFiles(relationsDirectory
    ?? (requireExceptionTargets ? DEFAULT_RELATIONS_DIRECTORY : undefined));
  const shardSenseIds = authoredFiles.length > 0 ? await loadShardSenseIds(inputDirectory) : undefined;
  const meaningLayer = loadMeaningLayer({ model, inputDirectory, recordMeanings, authoredFiles, shardSenseIds });
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
      [DATABASE_KIND_KEY]: DATABASE_KINDS.full,
      node_version: process.version,
      sqlite_module: 'node:sqlite',
      sqlite_version: sqliteVersion,
    }, surfaceFormProjection, meaningLayer);
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec(`PRAGMA user_version = ${Number.parseInt(SQLITE_SCHEMA_VERSION, 10)};`);
    database.exec(SQLITE_SCHEMA_SQL);
    database.exec(SQLITE_SOURCE_SCHEMA_SQL);
    database.exec('BEGIN IMMEDIATE;');
    insertModel(database, model, generatedMetadata, surfaceFormProjection.rows, meaningLayer);
    database.exec('COMMIT;');
    verifyDatabase(database, { includeSource: true });
    if (meaningLayer.projected) {
      assertRecordMeaningCoverage(database, (name, count) => {
        throw new BuildError(`record meaning coverage check ${name} found ${count} violation(s)`, 'RECORD_MEANING_COVERAGE');
      });
    }
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
