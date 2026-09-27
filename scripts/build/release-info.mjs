import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readPackagedDictionaryMetadata(packageDirectory) {
  const database = new DatabaseSync(path.join(packageDirectory, 'dictionary.sqlite'), {
    readOnly: true,
  });
  try {
    return Object.fromEntries(
      database.prepare('SELECT key, value FROM metadata ORDER BY key').all()
        .map(({ key, value }) => [key, value]),
    );
  } finally {
    database.close();
  }
}

export function createPackageReleaseInfo({
  projectRoot,
  packageDirectory,
  dictionaryMetadata = readPackagedDictionaryMetadata(packageDirectory),
} = {}) {
  const manifestBytes = readFileSync(path.join(packageDirectory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const packageMetadata = JSON.parse(
    readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  const databaseBytes = readFileSync(path.join(packageDirectory, 'dictionary.sqlite'));
  const lockfileBytes = readFileSync(path.join(projectRoot, 'package-lock.json'));

  return {
    format_version: 1,
    application: {
      name: packageMetadata.name,
      version: packageMetadata.version,
    },
    extension: {
      manifest_version: manifest.manifest_version,
      version: manifest.version,
    },
    dictionary: {
      version: dictionaryMetadata.dictionary_version,
      schema_version: dictionaryMetadata.schema_version,
      canonical_source_revision: dictionaryMetadata.source_revision,
      database_sha256: sha256(databaseBytes),
    },
    source: {
      revision: dictionaryMetadata.source_revision,
      revision_verified: dictionaryMetadata.source_revision_verified === 'true',
      worktree_state: dictionaryMetadata.worktree_state,
      build_tool_version: dictionaryMetadata.build_tool_version,
      node_version: dictionaryMetadata.node_version,
      sqlite_version: dictionaryMetadata.sqlite_version,
    },
    build_inputs: {
      manifest_sha256: sha256(manifestBytes),
      package_lock_sha256: sha256(lockfileBytes),
    },
  };
}
