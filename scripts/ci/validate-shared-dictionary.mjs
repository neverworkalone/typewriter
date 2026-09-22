import { stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  contextSummary,
  loadCanonicalContext,
} from '../validate/canonical-context.mjs';

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
    if (userVersion !== 1) {
      throw new Error(`shared SQLite schema version must be 1, received ${userVersion}`);
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
    return {
      database_path: path.resolve(databasePath),
      sqlite_user_version: userVersion,
      record_count: Number(metadata.record_count),
      sense_count: Number(metadata.sense_count),
      relation_count: Number(metadata.relation_count),
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
