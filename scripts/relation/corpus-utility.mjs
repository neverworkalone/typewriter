import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { excerptAround, openCorpusIndex } from './literary-context.mjs';

// Small, composable read-only search helpers for the D producer (#1838). They only search the approved paragraph
// corpus index and bound the output. They never decide that a context is the source sense (VERIFIED/NO_VERIFIED),
// never create or drop candidates and never classify relations: the AI reads the returned contexts.
//
// Result status: ZERO_HITS (complete search, nothing found) | COMPLETE (complete search with hits, or a continued
// search with nothing more) | LIMITED (stopped at a sample/char/scan bound; `next_cursor` continues exactly after
// the last paragraph read, so no context is repeated or skipped; `scanRows` caps the paragraphs examined
// per call: for short forms the paragraph_rowid span evaluated by `instr`, even when nothing matches; FTS reserves
// a full result-page budget even when it finds nothing) | SEARCH_FAILED. LIMITED is never "no hits".

export const DEFAULT_MAX_SAMPLES = 8;
export const DEFAULT_MAX_CHARS = 6000;
export const DEFAULT_SNIPPET_CHARS = 240;
export const DEFAULT_SCAN_ROWS = 200_000;
const FTS_MIN_LENGTH = 3;
const BATCH_ROWS = 200;
const SHORT_WINDOW = 20_000; // paragraph_rowid span examined per short-form query
const MIN_MAX_CHARS = 600;
const HEAD_RESERVE = 320; // status line, bounded seen-paragraph cursor and error text of renderContexts
const ITEM_OVERHEAD = 200; // the item label line around the excerpt
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const normalizeForms = (forms) => [...new Set(forms.map((form) => String(form).trim()).filter(Boolean))];

/** Open the approved paragraph corpus index read-only (`query_only`) after its schema check. */
export function openReadonlyDb(databasePath) {
  return openCorpusIndex(databasePath).database;
}

const encodeCursor = (state) => Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');

export class InvalidCursorError extends Error {
  constructor(message) {
    super(`INVALID_CURSOR: ${message}`);
    this.name = 'InvalidCursorError';
    this.code = 'INVALID_CURSOR';
  }
}

function invalidCursor(message) {
  return new InvalidCursorError(message);
}

const corpusIdentity = new WeakMap();
function getCorpusIdentity(database) {
  if (!corpusIdentity.has(database)) {
    const metadata = database.prepare('SELECT * FROM index_metadata LIMIT 65').all();
    corpusIdentity.set(database, { metadata, maxRowid: database.prepare('SELECT max(paragraph_rowid) AS id FROM paragraphs').get().id ?? 0 });
  }
  return corpusIdentity.get(database);
}
function searchId(database, list, boundary) {
  const { metadata, maxRowid } = getCorpusIdentity(database);
  return createHash('sha256').update(JSON.stringify([list, boundary ?? null, metadata, maxRowid])).digest('hex').slice(0, 12);
}
const maxRowidOf = (database) => getCorpusIdentity(database).maxRowid;

/** Corpus range used to bound one CLI search request to roughly one short-form pass. */
export const corpusScanRows = (database) => Math.max(1, maxRowidOf(database));

function decodeCursor(cursor, formsKey, formCount, maxRowid) {
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw invalidCursor('cursor is not a Base64URL token');
  }
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(json, 'utf8').toString('base64url') !== cursor) throw new Error('non-canonical Base64URL');
    const state = JSON.parse(json);
    if (state === null || typeof state !== 'object' || Array.isArray(state)
      || Object.keys(state).some((key) => !['id', 'form', 'after', 'p', 'seen'].includes(key))) throw new Error('invalid cursor fields');
    if (state.id === formsKey && Number.isInteger(state.form) && state.form >= 0 && state.form < formCount
      && Number.isInteger(state.after) && state.after >= 0 && state.after <= maxRowid) {
      // Cursors created before paragraph de-duplication have no `p`; they remain valid and resume safely.
      if (Object.hasOwn(state, 'p') && Object.hasOwn(state, 'seen')) throw new Error('ambiguous seen paragraph IDs');
      let seen;
      if (Object.hasOwn(state, 'p')) {
        if (typeof state.p !== 'string' || state.p !== '' && !/^[0-9a-z]+(?:\.[0-9a-z]+)*$/u.test(state.p)) throw new Error('invalid seen paragraph IDs');
        seen = state.p === '' ? [] : state.p.split('.').map((rowid) => Number.parseInt(rowid, 36));
      } else seen = Object.hasOwn(state, 'seen') ? state.seen : [];
      if (!Array.isArray(seen) || seen.some((rowid) => !Number.isInteger(rowid) || rowid < 1 || rowid > maxRowid)
        || new Set(seen).size !== seen.length) throw new Error('invalid seen paragraph IDs');
      return { ...state, seen };
    }
  } catch (error) {
    if (error instanceof InvalidCursorError) throw error;
    throw invalidCursor('cursor structure is malformed or does not match this exact form list, boundary option and corpus index');
  }
  throw invalidCursor('cursor does not belong to this exact form list, boundary option and corpus index');
}

/** Validate a supplied cursor against cached metadata for an already-open corpus connection. */
export function validateSearchCursor(database, forms, { boundary, cursor }) {
  if (cursor === null || cursor === undefined) return null;
  const list = normalizeForms(forms);
  if (list.length === 0) throw invalidCursor('a cursor requires at least one search form');
  const formsKey = searchId(database, list, boundary);
  return decodeCursor(cursor, formsKey, list.length, maxRowidOf(database));
}

/**
 * First occurrence of `form` in `text` that satisfies the character boundary.
 * boundary: 'both' (no word character on either side), 'left' (particles/endings may follow) or 'none'.
 */
export function findBoundedOccurrence(text, form, boundary) {
  let at = text.indexOf(form);
  while (at >= 0) {
    const before = [...text.slice(0, at)].at(-1);
    const after = [...text.slice(at + form.length)][0];
    const leftOk = boundary === 'none' || !before || !WORD_CHARACTER.test(before);
    const rightOk = boundary !== 'both' || !after || !WORD_CHARACTER.test(after);
    if (leftOk && rightOk) return at;
    at = text.indexOf(form, at + 1);
  }
  return -1;
}

function matchesLaterForm(text, forms, start, boundary) {
  for (let index = start; index < forms.length; index += 1) {
    const form = forms[index];
    const formBoundary = boundary ?? ([...form].length < FTS_MIN_LENGTH ? 'both' : 'none');
    if (findBoundedOccurrence(text, form, formBoundary) >= 0) return true;
  }
  return false;
}

const ROW_COLUMNS = 'p.paragraph_rowid AS rowid, p.form AS text, d.title, d.author';

/**
 * Read the next bounded piece of one form's search after `after`, returning `{ rows, next, done, cost }`.
 * FTS (3+ chars): at most `limit` matching paragraphs and charge a full page budget even when fewer (or no) rows
 * match, so empty indexed searches cannot bypass a multi-form or batch budget. Short forms examine only the
 * `paragraph_rowid` window (after, after + limit] with literal `instr`; `next` is the window end.
 */
function fetchPiece(database, form, after, limit) {
  if ([...form].length >= FTS_MIN_LENGTH) {
    const rows = database.prepare(`SELECT ${ROW_COLUMNS} FROM paragraph_fts f
      JOIN paragraphs p ON p.paragraph_rowid = f.rowid JOIN documents d ON d.document_rowid = p.document_rowid
      WHERE paragraph_fts MATCH ? AND f.rowid > ? ORDER BY f.rowid LIMIT ?`)
      .all(`"${form.replaceAll('"', '""')}"`, after, limit);
    return { rows, next: rows.length ? rows.at(-1).rowid : after, done: rows.length < limit, cost: limit };
  }
  const end = Math.min(after + limit, maxRowidOf(database));
  const rows = database.prepare(`SELECT ${ROW_COLUMNS} FROM paragraphs p
    JOIN documents d ON d.document_rowid = p.document_rowid
    WHERE p.paragraph_rowid > ? AND p.paragraph_rowid <= ? AND instr(p.form, ?) > 0 ORDER BY p.paragraph_rowid`)
    .all(after, end, form);
  return { rows, next: end, done: end >= maxRowidOf(database), cost: Math.max(0, end - after) };
}

/**
 * Search one or more forms with one global budget. Forms are searched in order; the sample, character and scan
 * limits apply to the whole call (not per form or per row), so a nested form × paragraph walk cannot exceed them.
 * Pass the previous `next_cursor` with the same `forms` to read the next contexts.
 */
export function searchContexts(database, forms, {
  maxSamples = DEFAULT_MAX_SAMPLES,
  maxChars = DEFAULT_MAX_CHARS, // bound of the rendered response; UTF-16 code units; values below 600 are raised to 600
  snippetChars = DEFAULT_SNIPPET_CHARS,
  scanRows = DEFAULT_SCAN_ROWS,
  boundary,
  cursor = null,
} = {}) {
  const list = normalizeForms(forms);
  if (list.length === 0) return { status: 'SEARCH_FAILED', error: 'no search form', items: [], next_cursor: null, scanned_rows: 0 };
  const items = [];
  let scanned = 0;
  let seenParagraphs = new Set();
  let formsKey;
  let state;
  try {
    formsKey = searchId(database, list, boundary);
    state = cursor === null || cursor === undefined
      ? { id: formsKey, form: 0, after: 0 }
      : decodeCursor(cursor, formsKey, list.length, maxRowidOf(database));
  } catch (error) {
    if (error instanceof InvalidCursorError) throw error;
    return { status: 'SEARCH_FAILED', error: error.message, items, next_cursor: null, scanned_rows: scanned };
  }
  try {
    seenParagraphs = new Set(state.seen ?? []);
    // maxChars bounds the whole rendered response (renderContexts): header + every item line + excerpt.
    const budget = Math.max(maxChars, MIN_MAX_CHARS);
    const snippet = Math.max(20, Math.min(snippetChars, budget - HEAD_RESERVE - ITEM_OVERHEAD));
    let chars = HEAD_RESERVE;
    for (let formIndex = state.form; formIndex < list.length; formIndex += 1) {
      const form = list[formIndex];
      const formBoundary = boundary ?? ([...form].length < FTS_MIN_LENGTH ? 'both' : 'none');
      let after = formIndex === state.form ? state.after : 0;
      for (;;) {
        const limit = Math.min([...form].length < FTS_MIN_LENGTH ? SHORT_WINDOW : BATCH_ROWS, scanRows - scanned);
        if (limit <= 0) return finish(items, 'LIMITED', formsKey, formIndex, after, scanned, seenParagraphs);
        const piece = fetchPiece(database, form, after, limit);
        scanned += piece.cost;
        for (const row of piece.rows) {
          after = row.rowid;
          const at = findBoundedOccurrence(row.text, form, formBoundary);
          if (at < 0) continue;
          if (seenParagraphs.has(row.rowid)) {
            if (!matchesLaterForm(row.text, list, formIndex + 1, boundary)) seenParagraphs.delete(row.rowid);
            continue;
          }
          const excerpt = excerptAround(row.text, [form], snippet, at, form).text;
          const item = { form: [...form].slice(0, 30).join(''), paragraph_rowid: row.rowid, title: [...(row.title ?? '')].slice(0, 30).join(''), author: [...(row.author ?? '')].slice(0, 30).join(''), excerpt };
          let cost = renderItem(item, items.length).length + 1;
          // The bound is in UTF-16 code units like the rendered string; the excerpt limit counts code points,
          // so shrink even the first item until its real rendering fits.
          for (let chars_ = [...item.excerpt]; items.length === 0 && chars + cost > budget && chars_.length > 0;) {
            chars_ = chars_.slice(0, -Math.max(1, Math.ceil((chars + cost - budget) / 2)));
            item.excerpt = chars_.join('');
            cost = renderItem(item, 0).length + 1;
          }

          if (items.length > 0 && chars + cost > budget) {
            return finish(items, 'LIMITED', formsKey, formIndex, row.rowid - 1, scanned, seenParagraphs);
          }
          items.push(item);
          if (matchesLaterForm(row.text, list, formIndex + 1, boundary)) seenParagraphs.add(row.rowid);
          chars += cost;
          if (items.length >= maxSamples) return finish(items, 'LIMITED', formsKey, formIndex, row.rowid, scanned, seenParagraphs);
        }
        after = piece.next;
        if (piece.done) break;
      }
    }
    return { status: items.length > 0 || cursor ? 'COMPLETE' : 'ZERO_HITS', items, next_cursor: null, scanned_rows: scanned };
  } catch (error) {
    return { status: 'SEARCH_FAILED', error: error.message, items, next_cursor: null, scanned_rows: scanned };
  }
}

function searchRequestKey(forms, options = {}) {
  const {
    maxSamples = DEFAULT_MAX_SAMPLES,
    maxChars = DEFAULT_MAX_CHARS,
    snippetChars = DEFAULT_SNIPPET_CHARS,
    scanRows = DEFAULT_SCAN_ROWS,
    boundary,
    cursor = null,
  } = options;
  return JSON.stringify([forms, maxSamples, maxChars, snippetChars, scanRows, boundary ?? null, cursor]);
}

const copySearchResult = (result) => ({ ...result, items: result.items.map((item) => ({ ...item })) });

/**
 * Create a memory-only, per-chunk reuse function bound to one read-only corpus connection.
 * Exact request pages are reused; LIMITED pages remain distinct by cursor, and SEARCH_FAILED is retried.
 * `reused` concerns search output only: callers must verify every source sense independently.
 */
export function createSearchContextReuse(database) {
  const results = new Map();
  const search = (forms, options = {}) => {
    const list = normalizeForms(forms);
    const key = searchRequestKey(list, options);
    const cached = results.get(key);
    if (cached) return { result: copySearchResult(cached), reused: true };

    const result = searchContexts(database, list, options);
    if (result.status !== 'SEARCH_FAILED') results.set(key, copySearchResult(result));
    return { result: copySearchResult(result), reused: false };
  };
  search.corpusRows = corpusScanRows(database);
  return search;
}

function finish(items, status, id, form, after, scanned, seenParagraphs) {
  const seen = [...seenParagraphs].sort((left, right) => left - right).map((rowid) => rowid.toString(36)).join('.');
  return {
    status, items, scanned_rows: scanned,
    next_cursor: encodeCursor({ id, form, after, ...(seen ? { p: seen } : {}) }),
  };
}

const renderItem = (item, index) => `[${index + 1}] ${item.form} | ${item.title} ${item.author}\n${item.excerpt}`;

/** One bounded text block for the AI to read. Includes the status and, when LIMITED, the cursor to continue. */
export function renderContexts(result) {
  const head = `${result.status} shown=${result.items.length}${result.next_cursor ? ` next_cursor=${result.next_cursor}` : ''}${result.error ? ` error=${[...String(result.error)].slice(0, 50).join('')}` : ''}`;
  return [head, ...result.items.map(renderItem)].join('\n');
}

/**
 * Atomically store a finished chunk as `chunk-NNN.jsonl` (War Room counts these files as completed chunks).
 * `expected` is the chunk's Canonical structure, `[{ record_id, sense_ids: [...] }]`; every row must match it
 * exactly (record IDs and sense IDs, in order, each sense with a `candidates` string array), otherwise nothing is
 * written. The whole file is written to `.tmp` first and renamed into place.
 */
export async function saveChunk(scratchDirectory, chunkNumber, rows, expected) {
  if (!Number.isInteger(chunkNumber) || chunkNumber < 1) throw new Error('chunk number must be a positive integer');
  if (!Array.isArray(expected) || expected.length === 0) throw new Error('expected chunk records are required');
  if (!Array.isArray(rows) || rows.length !== expected.length) throw new Error('chunk must contain every chunk record exactly once');
  rows.forEach((row, index) => {
    const want = expected[index];
    if (row?.record_id !== want.record_id) throw new Error(`chunk row ${index + 1} must be record ${want.record_id} (Canonical order)`);
    const senses = row.senses;
    if (!Array.isArray(senses) || senses.length !== want.sense_ids.length
      || senses.some((sense, at) => sense?.sense_id !== want.sense_ids[at] || !Array.isArray(sense.candidates) || sense.candidates.some((c) => typeof c !== 'string'))) {
      throw new Error(`record ${want.record_id} must list every sense in Canonical order with a candidates array`);
    }
  });
  const target = path.join(scratchDirectory, `chunk-${String(chunkNumber).padStart(3, '0')}.jsonl`);
  await mkdir(scratchDirectory, { recursive: true });
  await writeFile(`${target}.tmp`, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await rename(`${target}.tmp`, target);
  return target;
}
