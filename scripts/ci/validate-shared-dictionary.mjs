import { stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  contextSummary,
  loadCanonicalContext,
} from '../validate/canonical-context.mjs';
import {
  buildSurfaceFormProjection,
  loadSurfaceFormExceptionManifest,
  loadSurfaceFormReviewManifest,
  SURFACE_FORM_PROJECTION_VERSION,
} from '../inflection/surface-form-projection.mjs';

export async function validateSharedDictionary({
  databasePath = process.env.TYPEWRITER_SHARED_DICTIONARY_PATH,
  canonicalContext,
} = {}) {
  if (!databasePath) {
    throw new Error('TYPEWRITER_SHARED_DICTIONARY_PATH is required for shared artifact validation');
  }
  await stat(databasePath);
  const context = canonicalContext ?? await loadCanonicalContext();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get();
    if (integrity?.integrity_check !== 'ok') {
      throw new Error(`shared SQLite integrity check failed: ${JSON.stringify(integrity)}`);
    }
    const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length > 0) {
      throw new Error(`shared SQLite foreign-key check failed: ${JSON.stringify(foreignKeys)}`);
    }
    const userVersion = database.prepare('PRAGMA user_version').get().user_version;
    if (userVersion !== 2) {
      throw new Error(`shared SQLite schema version must be 2, received ${userVersion}`);
    }
    const metadata = Object.fromEntries(
      database.prepare('SELECT key, value FROM metadata ORDER BY key').all()
        .map(({ key, value }) => [key, value]),
    );
    for (const [key, value] of [
      ['record_count', context.statistics.recordCount],
      ['sense_count', context.statistics.senseCount],
      ['relation_count', context.statistics.relationCount],
    ]) {
      if (metadata[key] !== String(value)) {
        throw new Error(`shared SQLite metadata ${key} does not match canonical context`);
      }
    }
    if (metadata.canonical_revision !== context.canonicalRevision) {
      throw new Error('shared SQLite metadata canonical_revision does not match canonical context');
    }
    const exceptionManifest = context.derived.surfaceFormExceptionManifest
      ?? await loadSurfaceFormExceptionManifest();
    context.derived.surfaceFormExceptionManifest = exceptionManifest;
    const reviewManifest = context.derived.surfaceFormReviewManifest
      ?? await loadSurfaceFormReviewManifest();
    context.derived.surfaceFormReviewManifest = reviewManifest;
    const surfaceProjection = buildSurfaceFormProjection(context.records, {
      exceptionManifest,
      reviewManifest,
      requireExceptionTargets: true,
      requireClassDispositions: true,
      requireCollisionReview: true,
    });
    context.derived.surfaceFormProjection = surfaceProjection;
    if (metadata.surface_form_projection_version !== SURFACE_FORM_PROJECTION_VERSION) {
      throw new Error('shared SQLite surface_form_projection_version does not match the supported projection');
    }
    const actualSurfaceRows = database.prepare(
      `SELECT generated_surface_forms.form,
              generated_surface_forms.record_id,
              generated_surface_forms.sense_id,
              generated_surface_forms.rule_id
       FROM generated_surface_forms
       INNER JOIN senses
         ON senses.id = generated_surface_forms.sense_id
        AND senses.record_id = generated_surface_forms.record_id
       ORDER BY generated_surface_forms.record_id, senses.position,
                generated_surface_forms.form, generated_surface_forms.rule_id`,
    ).all();
    if (JSON.stringify(actualSurfaceRows) !== JSON.stringify(surfaceProjection.rows)) {
      throw new Error('shared SQLite generated surface forms do not match the canonical projection');
    }
    if (metadata.generated_surface_form_count !== String(surfaceProjection.rows.length)) {
      throw new Error('shared SQLite generated_surface_form_count does not match canonical projection');
    }
    if (metadata.surface_form_eligible_sense_count !== String(surfaceProjection.coverage.eligible_sense_count)) {
      throw new Error('shared SQLite surface_form_eligible_sense_count does not match canonical projection');
    }
    if (metadata.surface_form_exclusion_count !== String(surfaceProjection.exclusions.length)) {
      throw new Error('shared SQLite surface_form_exclusion_count does not match canonical projection');
    }
    return {
      database_path: path.resolve(databasePath),
      sqlite_user_version: userVersion,
      record_count: Number(metadata.record_count),
      sense_count: Number(metadata.sense_count),
      relation_count: Number(metadata.relation_count),
      generated_surface_form_count: actualSurfaceRows.length,
      surface_form_eligible_sense_count: surfaceProjection.coverage.eligible_sense_count,
      surface_form_exclusion_count: surfaceProjection.exclusions.length,
      sqlite_build_count: context.metrics.sqlite_build_count ?? 0,
      context: contextSummary(context),
    };
  } finally {
    database.close();
  }
}

async function main() {
  console.log(JSON.stringify(await validateSharedDictionary(), null, 2));
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.code ? `${error.code}: ${error.message}` : error.message);
    process.exitCode = 1;
  });
}
