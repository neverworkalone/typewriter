import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../build/dictionary.mjs';
import { DEFAULT_CANONICAL_DIRECTORY, readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

export class SharedDatabaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SharedDatabaseError';
  }
}

async function readSharedDatabaseRevision(databasePath) {
  try {
    await stat(databasePath);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return database
        .prepare("SELECT value FROM metadata WHERE key = 'canonical_revision'")
        .get()?.value;
    } finally {
      database.close();
    }
  } catch (error) {
    throw new SharedDatabaseError(
      `Shared SQLite artifact ${databasePath} is unreadable: ${error.message}`,
    );
  }
}

/**
 * Databases of the exact current canonical revision for a validator.
 *
 * Inside a CI run the runner publishes one shared artifact built once from the
 * current canonical revision (TYPEWRITER_SHARED_DICTIONARY_PATH). Validators
 * reuse it after binding it to `canonicalRevision`, which the caller computed
 * from the canonical bytes it read itself; a mismatch fails closed and never
 * falls back to another build. Standalone (manual) runs have no shared artifact
 * and build `independentBuilds` databases so the two-build reproducibility proof
 * stays available outside normal CI.
 */
export async function prepareCurrentRevisionDatabases({
  canonicalRevision,
  temporaryDirectory,
  repositoryDirectory,
  independentBuilds = 2,
  checkPilotCompleteness = false,
  sharedDatabasePath = process.env.TYPEWRITER_SHARED_DICTIONARY_PATH,
}) {
  if (typeof canonicalRevision !== 'string' || canonicalRevision.length === 0) {
    throw new SharedDatabaseError('A canonical revision is required to bind the SQLite artifact');
  }
  if (sharedDatabasePath) {
    const revision = await readSharedDatabaseRevision(sharedDatabasePath);
    if (revision !== canonicalRevision) {
      throw new SharedDatabaseError(
        'Shared SQLite artifact canonical_revision does not match the canonical revision '
        + 'read by this validator',
      );
    }
    return { databasePaths: [sharedDatabasePath], reusedSharedArtifact: true };
  }
  const databasePaths = [];
  for (const name of ['first', 'second'].slice(0, independentBuilds)) {
    const outputPath = path.join(temporaryDirectory, `${name}.sqlite`);
    await buildDictionary({
      inputDirectory: DEFAULT_CANONICAL_DIRECTORY,
      outputPath,
      checkPilotCompleteness,
      allowDirty: true,
      repositoryDirectory,
    });
    databasePaths.push(outputPath);
  }
  return { databasePaths, reusedSharedArtifact: false };
}

/**
 * One current-revision database for a search/product test. Reuses the CI shared
 * artifact when present (bound to the revision of the canonical bytes read here)
 * and otherwise builds one database in a fresh directory under `temporaryRoot`.
 * `outputDirectory` is null when the shared artifact is reused; callers remove it
 * only when it is set.
 */
export async function openCurrentRevisionDatabasePath({
  temporaryRoot,
  prefix,
  repositoryDirectory,
}) {
  const { canonicalRevision } = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const outputDirectory = await mkdtemp(path.join(temporaryRoot, prefix));
  const { databasePaths, reusedSharedArtifact } = await prepareCurrentRevisionDatabases({
    canonicalRevision,
    temporaryDirectory: outputDirectory,
    repositoryDirectory,
    independentBuilds: 1,
    checkPilotCompleteness: true,
  });
  if (reusedSharedArtifact) {
    await rm(outputDirectory, { recursive: true, force: true });
  }
  return {
    databasePath: databasePaths[0],
    outputDirectory: reusedSharedArtifact ? null : outputDirectory,
  };
}
