import sqlite3InitModule from './vendor/sqlite3.mjs';
import { assertProofPayload } from './proof-contract.mjs';

let proofPromise;

async function loadDatabase() {
  const sqlite3 = await sqlite3InitModule();
  const response = await fetch(new URL('./dictionary.sqlite', self.location.href));
  if (!response.ok) {
    throw new Error(`Could not fetch packaged dictionary (${response.status})`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const database = new sqlite3.oo1.DB();
  const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
  const resultCode = sqlite3.capi.sqlite3_deserialize(
    database.pointer,
    'main',
    pointer,
    bytes.byteLength,
    bytes.byteLength,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE,
  );
  database.checkRc(resultCode);
  database.exec('PRAGMA query_only = ON');

  return { bytes, database, sqlite3 };
}

async function runProof() {
  if (!proofPromise) {
    proofPromise = loadDatabase();
  }

  const { bytes, database, sqlite3 } = await proofPromise;
  try {
    const queryOnly = database.selectValue('PRAGMA query_only');
    const lemma = database.selectObjects(
      `SELECT id, record_type, role, candidate_id, lemma
       FROM records WHERE lemma = ?`,
      ['담담하다'],
    );
    const searchForm = database.selectObjects(
      `SELECT records.id, records.lemma
       FROM records
       INNER JOIN search_forms ON search_forms.record_id = records.id
       WHERE search_forms.form = ?`,
      ['담담'],
    );
    const relation = database.selectObjects(
      `SELECT relations.type, relations.note,
              relations.target_record_id AS target,
              relations.target_sense_id AS target_sense,
              target_records.lemma AS target_lemma
       FROM relations
       INNER JOIN records AS target_records
         ON target_records.id = relations.target_record_id
       WHERE relations.source_sense_id = ?
       ORDER BY relations.position`,
      ['w026-s1'],
    );

    let writeBlocked = false;
    try {
      database.exec(
        "INSERT INTO records (id, record_type, role, lemma) VALUES ('proof-write', 'entry', 'start', '금지')",
      );
    } catch {
      writeBlocked = true;
    }

    const persistedCount = database.selectValue(
      "SELECT COUNT(*) FROM records WHERE id = 'proof-write'",
    );
    if (!writeBlocked || persistedCount !== 0) {
      throw new Error('packaged dictionary accepted or persisted a write');
    }

    const payload = {
      ok: true,
      sqlite_version: sqlite3.version.libVersion,
      database_bytes: bytes.byteLength,
      query_only: queryOnly,
      lemma,
      search_form: searchForm,
      relation,
      write_blocked: writeBlocked,
      persisted_write_count: persistedCount,
    };
    return assertProofPayload(payload);
  } finally {
    database.close();
  }
}

self.addEventListener('message', async (event) => {
  if (event.data?.type !== 'run-proof') {
    return;
  }

  try {
    self.postMessage({ type: 'proof-result', ...(await runProof()) });
  } catch (error) {
    self.postMessage({
      type: 'proof-result',
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
});
