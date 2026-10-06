import { DatabaseSync } from 'node:sqlite';

import { DEFAULT_INDEX_PATH, assertCorpusPermission } from '../reference/corpus-index.mjs';

// The Written Corpus index has a composite index on
// paragraphs(document_rowid, paragraph_id). Keep documents as the outer input so SQLite can
// probe that index for each matching document instead of scanning the full paragraphs table.
export const CONTEXT_PARAGRAPH_LOOKUP_SQL = `SELECT p.form AS form
  FROM documents AS d
  CROSS JOIN paragraphs AS p ON p.document_rowid = d.document_rowid
  WHERE d.document_id = ? AND p.paragraph_id = ?`;

// Local-only source of bounded original paragraph contexts for the contextual fallback (issue #285).
// It reads the ignored corpus index by the EXACT approved document/paragraph ids of an observation,
// after the corpus permission record is checked. Nothing is sent to a network or written to Git: the
// caller keeps the returned text in memory only (review packs go to ignored data/reference/).
//
// The index is also bound to the evidence it is read for: `expectedSnapshot` (the evidence's
// `corpus:<input manifest digest>:<logical rows digest>`) must equal the digests recorded in the
// opened database's own `index_metadata`. A rebuilt or different index that reuses paragraph ids is
// reported as `snapshot_mismatch` (the caller fails closed), never attributed to the old snapshot.
export function createCorpusContextSource({ databasePath = DEFAULT_INDEX_PATH, permission = assertCorpusPermission, expectedSnapshot } = {}) {
  if (typeof expectedSnapshot !== 'string' || !/^corpus:[0-9a-f]{64}:[0-9a-f]{64}$/u.test(expectedSnapshot)) {
    throw new Error('a corpus context source needs the expected evidence source_snapshot (corpus:<manifest>:<rows>)');
  }
  let database = null;
  return {
    async lookup({ kind, ref }) {
      if (kind !== 'corpus-paragraph') return { status: 'absent' };
      try {
        await permission();
      } catch {
        return { status: 'denied' };
      }
      const at = String(ref).lastIndexOf('#');
      if (at < 1) return { status: 'absent' };
      try {
        database ??= new DatabaseSync(databasePath, { readOnly: true });
        const metadata = Object.fromEntries(database.prepare("SELECT key, value FROM index_metadata WHERE key IN ('input_manifest_sha256', 'logical_rows_sha256')").all().map((row) => [row.key, row.value]));
        if (`corpus:${metadata.input_manifest_sha256}:${metadata.logical_rows_sha256}` !== expectedSnapshot) return { status: 'snapshot_mismatch' };
        const rows = database.prepare(CONTEXT_PARAGRAPH_LOOKUP_SQL).all(ref.slice(0, at), ref.slice(at + 1));
        // An ambiguous or missing id is never guessed: it is "absent".
        return rows.length === 1 && typeof rows[0].form === 'string' ? { status: 'ok', text: rows[0].form } : { status: 'absent' };
      } catch {
        return { status: 'absent' };
      }
    },
    close() {
      database?.close();
      database = null;
    },
  };
}
