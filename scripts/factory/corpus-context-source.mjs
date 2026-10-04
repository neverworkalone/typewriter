import { DatabaseSync } from 'node:sqlite';

import { DEFAULT_INDEX_PATH, assertCorpusPermission } from '../reference/corpus-index.mjs';

// Local-only source of bounded original paragraph contexts for the contextual fallback (issue #285).
// It reads the ignored corpus index by the EXACT approved document/paragraph ids of an observation,
// after the corpus permission record is checked. Nothing is sent to a network or written to Git: the
// caller keeps the returned text in memory only (review packs go to ignored data/reference/).
export function createCorpusContextSource({ databasePath = DEFAULT_INDEX_PATH, permission = assertCorpusPermission } = {}) {
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
        const rows = database.prepare(`SELECT p.form AS form FROM paragraphs AS p JOIN documents AS d ON d.document_rowid = p.document_rowid
          WHERE d.document_id = ? AND p.paragraph_id = ?`).all(ref.slice(0, at), ref.slice(at + 1));
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
