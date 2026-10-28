#!/usr/bin/env node

// Stage 1 Method D, one 25-record chunk at a time (Issue #2034; production contract: #1156).
//
//   prepare (War Room Supervisor only)  render one chunk's bounded search view, decide nothing semantic
//   search / search-batch (AI, optional) more contexts for senses of the active chunk
//   save    (AI, once per chunk)        validate a compact decisions file, then store chunk-NNN.jsonl atomically
//
// The CLI reuses the existing read-only search helpers (corpus-utility.mjs) and the Candidate v1 rules
// (candidate-contract.mjs). It never claims that a context is the exact source sense: VERIFIED / NO_VERIFIED are
// the AI's reading, and the semantic review stays with the independent PR review.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  isThousandsCommaFragment,
  loadCanonicalLemmaForms,
  normalizeCandidate,
  sourceLemmaRepeatMessage,
} from './candidate-contract.mjs';
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_SAMPLES,
  DEFAULT_SCAN_ROWS,
  DEFAULT_SNIPPET_CHARS,
  InvalidCursorError,
  corpusScanRows,
  createSearchContextReuse,
  openReadonlyDb,
  renderContexts,
  saveChunk,
  searchContexts,
  validateSearchCursor,
} from './corpus-utility.mjs';

export const CHUNK_RECORDS = 25;
export const BATCH_RECORDS = 500;
export const INITIAL_CONTEXTS = 4; // #1156 PASS A starts with 1-4 distinct contexts
export const INITIAL_SNIPPET_CHARS = 220;
export const MAX_CALL_CONTEXTS = 16; // per `search` call; the per-sense reading guide of 16 lives in the AI card
export const MAX_BATCH_OUTPUT_BYTES = 48 * 1024;
export const DEFAULT_REQUEST_SCAN_BUDGET_ROWS = 5_000_000; // synthetic search adapters only; production derives the corpus range
export const BATCH_SCAN_BUDGET_PASSES = 4; // bounds one search-batch command independently of each request's budget
// Pagination safety stop in addition to the deterministic scan budget. Reaching it preserves the real cursor as LIMITED.
export const MAX_FOLLOWUP_CALLS = 1000;
const MAX_VARIANT_FORM_LENGTH = 12;
const HANGUL_FORM = /^[가-힣]+$/u;
const SENSE_REF = /^s[1-9]\d*$/u;
const DECISION_LINE = /^(s[1-9]\d*)\s+([VNZ])(?:\s+(.*))?$/u;

function fail(message) {
  throw new Error(message);
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const chunkFile = (number) => `chunk-${String(number).padStart(3, '0')}.jsonl`;

// ---- Canonical batch / chunk ------------------------------------------------------------------------------------
export async function loadBatchRecords(canonicalPath, shard, batch) {
  const text = await readFile(canonicalPath, 'utf8');
  const rows = text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      const row = JSON.parse(line);
      if (typeof row?.id !== 'string' || typeof row.lemma !== 'string' || !Array.isArray(row.senses)) fail('not a Canonical record');
      return row;
    } catch (error) {
      return fail(`${canonicalPath}:${index + 1}: ${error.message}`);
    }
  });
  const batchNumber = Number(batch);
  if (![1, 2].includes(batchNumber)) fail('batch must be 01 or 02');
  const records = rows.slice((batchNumber - 1) * BATCH_RECORDS, batchNumber * BATCH_RECORDS);
  const lastPartial = String(shard) === '428' && batchNumber === 2 && records.length === 83;
  if (records.length !== BATCH_RECORDS && !lastPartial) fail(`Canonical batch has ${records.length} records; expected ${BATCH_RECORDS}`);
  return records;
}

export const totalChunks = (records) => Math.ceil(records.length / CHUNK_RECORDS);

export function chunkRecords(records, chunkNumber) {
  if (!Number.isInteger(chunkNumber) || chunkNumber < 1 || chunkNumber > totalChunks(records)) {
    fail(`chunk must be 1..${totalChunks(records)}`);
  }
  return records.slice((chunkNumber - 1) * CHUNK_RECORDS, chunkNumber * CHUNK_RECORDS);
}

export const recordForms = (record) => [...new Set([record.lemma, ...(Array.isArray(record.search_forms) ? record.search_forms : [])]
  .filter((form) => typeof form === 'string' && form.trim().length > 0)
  .map((form) => form.normalize('NFC').trim()))];

const HADA_SHARED_SUFFIXES = Object.freeze(['해', '해서', '했다', '하여', '하고', '하면', '한', '할']);
const HADA_VERB_SUFFIXES = Object.freeze(['하는', '한다']);

/**
 * The deliberately small, observed -하다 prefetch set for an explicit prepare opt-in.
 * It uses only Canonical Hangul lemma/search forms and POS, and never generates forms of two syllables or fewer.
 */
export function hadaPrefetchForms(record) {
  const poses = new Set((Array.isArray(record.senses) ? record.senses : []).map((sense) => sense?.pos));
  if (!poses.has('verb') && !poses.has('adjective')) return [];
  const bases = recordForms(record);
  const suffixes = [...HADA_SHARED_SUFFIXES, ...(poses.has('verb') ? HADA_VERB_SUFFIXES : [])];
  const generated = [];
  for (const base of bases) {
    const match = /^([가-힣]+)하다$/u.exec(base);
    if (!match) continue;
    for (const suffix of suffixes) {
      const form = `${match[1]}${suffix}`;
      if ([...form].length <= 2 || bases.includes(form)) continue;
      generated.push(form);
    }
  }
  return [...new Set(generated)];
}

// ---- bounded collection of distinct contexts -------------------------------------------------------------------
/**
 * Continue LIMITED pages until the requested number of distinct paragraph contexts is collected, the approved search
 * completes, or the request's deterministic scan budget is spent. The aggregate result keeps the real final cursor and
 * all contexts already found; an external cursor can never prove a fresh ZERO_HITS.
 */
export function searchForContexts(search, forms, options = {}, {
  maxCalls = MAX_FOLLOWUP_CALLS,
  maxScanRows = search.corpusRows ?? DEFAULT_REQUEST_SCAN_BUDGET_ROWS,
} = {}) {
  const cursorIn = options.cursor ?? null;
  const seen = new Set(cursorIn ? [cursorIn] : []);
  const requested = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const budget = Math.max(0, Math.floor(maxScanRows));
  let scannedRows = 0;
  let items = [];
  let cursor = cursorIn;
  let followups = 0;
  let lastResult = null;
  const failed = (error) => ({
    result: { status: 'SEARCH_FAILED', error, items, next_cursor: null, scanned_rows: scannedRows },
    followups, cursorIn,
  });

  while (true) {
    const remaining = budget - scannedRows;
    if (remaining <= 0) {
      if (lastResult?.status === 'LIMITED' && lastResult.next_cursor) {
        return { result: { ...lastResult, status: 'LIMITED', items, scanned_rows: scannedRows }, followups, cursorIn };
      }
      if (lastResult) return { result: { ...lastResult, items, scanned_rows: scannedRows }, followups, cursorIn };
      return { result: { status: 'DEFERRED', items: [], next_cursor: null, scanned_rows: 0 }, followups, cursorIn };
    }
    const scanRows = Math.min(options.scanRows ?? DEFAULT_SCAN_ROWS, remaining);
    const pageOptions = {
      ...options,
      cursor,
      maxSamples: Math.max(1, requested - items.length),
      scanRows,
    };
    const page = search(forms, pageOptions)?.result;
    if (!page || !['ZERO_HITS', 'COMPLETE', 'LIMITED', 'SEARCH_FAILED'].includes(page.status) || !Array.isArray(page.items)) {
      return failed('search returned an invalid result');
    }
    scannedRows += Math.min(scanRows, Math.max(0, page.scanned_rows ?? scanRows));
    const pageIds = new Set(items.map((item) => item.paragraph_rowid).filter(Number.isInteger));
    for (const item of page.items) {
      if (Number.isInteger(item.paragraph_rowid) && pageIds.has(item.paragraph_rowid)) continue;
      if (Number.isInteger(item.paragraph_rowid)) pageIds.add(item.paragraph_rowid);
      items.push(item);
    }
    lastResult = page;

    if (page.status === 'SEARCH_FAILED') {
      return { result: { ...page, items, next_cursor: null, scanned_rows: scannedRows }, followups, cursorIn };
    }
    if (page.status === 'ZERO_HITS') {
      const status = items.length === 0 && cursorIn === null ? 'ZERO_HITS' : 'COMPLETE';
      return { result: { ...page, status, items, next_cursor: null, scanned_rows: scannedRows }, followups, cursorIn };
    }
    if (page.status === 'COMPLETE') {
      const status = items.length === 0 && cursorIn === null ? 'ZERO_HITS' : 'COMPLETE';
      return { result: { ...page, status, items, next_cursor: null, scanned_rows: scannedRows }, followups, cursorIn };
    }

    if (typeof page.next_cursor !== 'string' || page.next_cursor.length === 0) return failed('LIMITED search returned no cursor');
    if (seen.has(page.next_cursor)) return failed('search follow-up made no progress');
    if (items.length >= requested || scannedRows >= budget || followups >= maxCalls) {
      return { result: { ...page, status: 'LIMITED', items, scanned_rows: scannedRows }, followups, cursorIn };
    }
    seen.add(page.next_cursor);
    cursor = page.next_cursor;
    followups += 1;
  }
}

const isComplete = (status) => status === 'ZERO_HITS' || status === 'COMPLETE';
const searchKey = (forms, boundary) => JSON.stringify([forms, boundary ?? null]);
const requestKey = (forms, boundary, options) => JSON.stringify([
  forms, boundary ?? null, options.cursor ?? null, options.maxSamples ?? DEFAULT_MAX_SAMPLES,
  options.maxChars ?? DEFAULT_MAX_CHARS, options.snippetChars ?? DEFAULT_SNIPPET_CHARS,
  options.scanRows ?? DEFAULT_SCAN_ROWS,
]);
const entryOf = (recordId, forms, boundary, result, source, cursorIn = null, exactRequestKey = null) => ({
  record_id: recordId,
  key: searchKey(forms, boundary),
  ...(exactRequestKey === null ? {} : { request_key: exactRequestKey }),
  forms,
  boundary: boundary ?? null,
  status: result.status,
  hits: result.items.length,
  complete: isComplete(result.status),
  cursor_in: cursorIn,
  cursor_out: result.next_cursor ?? null,
  source,
});

/**
 * Per record from the recorded searches: cumulative hits per search, and whether every search ended complete. A page
 * that started from a cursor counts only when that cursor is the recorded `cursor_out` of an earlier proven page of
 * the same search (a search with no recorded start is never a proven complete zero).
 */
export function recordEvidence(entries, recordId) {
  const byKey = new Map();
  const seenRequests = new Set();
  for (const entry of entries.filter((item) => item.record_id === recordId)) {
    if (entry.request_key !== undefined && entry.status !== 'SEARCH_FAILED') {
      if (seenRequests.has(entry.request_key)) continue;
      seenRequests.add(entry.request_key);
    }
    const current = byKey.get(entry.key) ?? { hits: 0, complete: false, proven: new Map() };
    const proven = entry.cursor_in ? current.proven.get(entry.cursor_in) === true : true;
    if (entry.cursor_out) current.proven.set(entry.cursor_out, proven);
    byKey.set(entry.key, { hits: current.hits + entry.hits, complete: entry.complete && proven, proven: current.proven });
  }
  const searches = [...byKey.values()];
  return {
    searches: searches.length,
    hits: searches.reduce((sum, item) => sum + item.hits, 0),
    allComplete: searches.length > 0 && searches.every((item) => item.complete),
  };
}

// ---- automatic ZERO_HITS (mechanical evidence only; everything else is `Z?` for the AI) ----------------------------
const spacedVariants = (form) => [...form].slice(1).map((_, at) => `${[...form].slice(0, at + 1).join('')} ${[...form].slice(at + 1).join('')}`);

/**
 * A record may be an automatic Z only when this mechanically holds: every sense is a noun, every search form is a
 * plain Hangul string of 3+ syllables (substring search, so attached particles cannot hide a hit) and no longer than
 * MAX_VARIANT_FORM_LENGTH, and the form list plus every single-space spelling of it completed with no hit.
 * Verbs, adjectives, roots, short or non-Hangul forms are never decided here.
 */
export const autoZCandidate = (record, forms) => record.senses.length > 0 && record.senses.every((sense) => sense.pos === 'noun')
  && forms.length > 0 && forms.every((form) => HANGUL_FORM.test(form) && [...form].length >= 3 && [...form].length <= MAX_VARIANT_FORM_LENGTH);

// ---- view ---------------------------------------------------------------------------------------------------------
function renderBlock(entry) {
  return `search: forms=${entry.forms.join(',')}${entry.boundary ? ` boundary=${entry.boundary}` : ''}\n${renderContexts(entry.result)}`;
}

/**
 * Build the whole chunk: searches (shared by all senses of a record), the AI view, and the chunk's sense map.
 * Pure over an opened corpus connection, so it is testable without a SQLite file.
 */
export function buildChunk({ records, shard, batch, chunkNumber, total, search, hadaPrefetch = false }) {
  const senses = [];
  const entries = [];
  const failed = [];
  const blocks = [];
  const autoZ = [];
  for (const record of records) {
    const canonicalForms = recordForms(record);
    const forms = [...canonicalForms, ...(hadaPrefetch ? hadaPrefetchForms(record) : [])];
    const mainOptions = { maxSamples: INITIAL_CONTEXTS, snippetChars: INITIAL_SNIPPET_CHARS };
    const main = searchForContexts(search, forms, mainOptions);
    const shown = [{ forms, boundary: null, result: main.result }];
    entries.push(entryOf(record.id, forms, null, main.result, 'prepare', main.cursorIn, requestKey(forms, null, mainOptions)));
    let auto = false;
    if (main.result.status === 'SEARCH_FAILED') failed.push(record.id);
    else if (main.result.status === 'ZERO_HITS' && autoZCandidate(record, forms)) {
      const variants = forms.flatMap(spacedVariants);
      const spacedOptions = { maxSamples: INITIAL_CONTEXTS, snippetChars: INITIAL_SNIPPET_CHARS };
      const spaced = searchForContexts(search, variants, spacedOptions);
      entries.push(entryOf(record.id, variants, null, spaced.result, 'prepare', spaced.cursorIn, requestKey(variants, null, spacedOptions)));
      if (spaced.result.status === 'SEARCH_FAILED') failed.push(record.id);
      else if (spaced.result.status === 'ZERO_HITS') auto = true;
      else shown.push({ forms: variants, boundary: null, result: spaced.result });
    }
    const first = senses.length + 1;
    for (const sense of record.senses) senses.push({ ref: `s${senses.length + 1}`, record_id: record.id, sense_id: sense.id, pos: sense.pos, gloss: sense.gloss ?? '', auto });
    if (auto) autoZ.push(...senses.slice(first - 1).map((item) => item.ref));
    else blocks.push({ record, canonicalForms, shown, refs: senses.slice(first - 1) });
  }
  const aiSenses = senses.filter((item) => !item.auto);
  const head = `batch=${shard}_${batch} chunk=${String(chunkNumber).padStart(3, '0')}/${String(total).padStart(3, '0')} `
    + `records=${records.length} senses=${senses.length} ai_senses=${aiSenses.length}`
    + `${autoZ.length ? ` auto_z=${autoZ.join(',')}` : ''}`;
  const body = blocks.map(({ record, canonicalForms, shown, refs }) => {
    const lines = [`## ${record.id} ${record.lemma} | search_forms: ${canonicalForms.join(', ')}`];
    for (const block of shown) lines.push(renderBlock(block));
    const zero = shown.every((block) => block.result.status === 'ZERO_HITS');
    if (zero) lines.push('Z?: 검색은 0건으로 완료됐으나 검색형 충분성은 AI가 판단한다 (활용형·표기 변형이 더 필요하면 `search`).');
    for (const item of refs) lines.push(`${item.ref} ${item.sense_id} [${item.pos}] ${item.gloss}`);
    return lines.join('\n');
  });
  return { view: `${[head, ...body].join('\n\n')}\n`, senses, entries, failed, autoZ };
}

// ---- scratch layout -------------------------------------------------------------------------------------------------
export const scratchDirectory = (shard, batch, root = '.warroom-scratch') => path.join(root, `d-${shard}_${batch}`);
const chunkPaths = (directory, number) => {
  const n = String(number).padStart(3, '0');
  return {
    active: path.join(directory, `active-${n}.json`),
    view: path.join(directory, `view-${n}.txt`),
    searches: path.join(directory, `search-${n}.jsonl`),
    decisions: path.join(directory, `decision-${n}.txt`),
    rejected: path.join(directory, `rejected-${n}.json`),
  };
};
const legacyFiles = new Set(['active-chunk.json', 'active-chunk.txt', 'searches.jsonl', 'decisions.txt', 'save-rejected.json']);
const MAX_REJECTED_ERRORS = 40;
const MAX_REJECTED_ERROR_CHARS = 300;

async function writeAtomic(target, text) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(`${target}.tmp`, text);
  await rename(`${target}.tmp`, target);
}

const expectedOf = (records) => records.map((record) => ({ record_id: record.id, sense_ids: record.senses.map((sense) => sense.id) }));
const emptyRows = (records) => records.map((record) => ({ record_id: record.id, senses: record.senses.map((sense) => ({ sense_id: sense.id, candidates: [] })) }));

export async function prepareChunk({ canonicalPath, shard, batch, chunkNumber, databasePath, model, head, directory = scratchDirectory(shard, batch), hadaPrefetch = false }) {
  const records = await loadBatchRecords(canonicalPath, shard, batch);
  const total = totalChunks(records);
  const chunk = chunkRecords(records, chunkNumber);
  const files = await readdir(directory).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  if (files.some((name) => legacyFiles.has(name) || name.startsWith('active-chunk.') || name.startsWith('searches.jsonl.')))
    fail('legacy D scratch files are present; preserving them without automatic migration or deletion');
  const activeArtifacts = files.filter((name) => name.startsWith('active-'));
  if (activeArtifacts.some((name) => !/^active-\d{3}\.json$/u.test(name))) fail('active D metadata filename is invalid; preserving scratch files');
  const activeFiles = activeArtifacts;
  if (activeFiles.length > 0) fail('an active D chunk already exists; it must be resumed or safely finalized first');
  const filesForChunk = chunkPaths(directory, chunkNumber);
  if (existsSync(path.join(directory, chunkFile(chunkNumber)))) fail(`${chunkFile(chunkNumber)} is already saved; it is never overwritten`);
  const temporary = [filesForChunk.active, filesForChunk.view, filesForChunk.searches, filesForChunk.decisions,
    filesForChunk.rejected].flatMap((file) => [file, `${file}.tmp`]);
  if (temporary.some((file) => existsSync(file)) || files.some((name) => name.startsWith(`view-${String(chunkNumber).padStart(3, '0')}.p`)))
    fail(`temporary files for chunk ${String(chunkNumber).padStart(3, '0')} already exist; preserving them`);
  const database = openReadonlyDb(databasePath);
  const built = buildChunk({ records: chunk, shard, batch, chunkNumber, total, search: createSearchContextReuse(database), hadaPrefetch });
  database.close?.();
  const base = { chunk_no: chunkNumber, total_chunks: total, records: chunk.length, senses: built.senses.length, auto_z: built.autoZ };
  if (built.failed.length > 0) return { status: 'SEARCH_FAILED', failed_records: built.failed, ...base };
  if (built.senses.every((item) => item.auto)) {
    // Every sense is a mechanically proven ZERO_HITS: no AI is needed for this chunk.
    await saveChunk(directory, chunkNumber, emptyRows(chunk), expectedOf(chunk));
    return { status: 'AUTO_COMPLETE', ...base };
  }
  const meta = {
    shard: String(shard), batch: String(batch), model, git_head: head, canonical: canonicalPath, ...base,
    view_sha256: sha256(built.view), view_bytes: Buffer.byteLength(built.view),
    records: chunk.map((record) => ({ record_id: record.id, lemma: record.lemma, sense_ids: record.senses.map((sense) => sense.id) })),
    senses: built.senses,
  };
  await mkdir(directory, { recursive: true });
  const boundEntries = built.entries.map((entry) => ({ ...entry, chunk_no: chunkNumber, view_sha256: meta.view_sha256 }));
  await writeAtomic(filesForChunk.view, built.view);
  await writeAtomic(filesForChunk.searches, boundEntries.map((entry) => JSON.stringify(entry)).join('\n') + (boundEntries.length ? '\n' : ''));
  await writeAtomic(filesForChunk.active, JSON.stringify(meta));
  return { status: 'READY', view_sha256: meta.view_sha256, view_bytes: meta.view_bytes, ai_senses: built.senses.filter((item) => !item.auto).length, ...base };
}

// ---- active chunk (AI-side commands) -----------------------------------------------------------------------------
async function findActive(root = '.warroom-scratch') {
  const directories = (await readdir(root).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter((name) => /^d-\d{3}_0[12]$/u.test(name));
  const found = [];
  const inactiveLegacy = [];
  const inactiveInvalidActive = [];
  for (const name of directories) {
    const directory = path.join(root, name);
    const files = await readdir(directory).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const activeFiles = files.filter((file) => /^active-\d{3}\.json$/u.test(file));
    const legacyActive = files.includes('active-chunk.json');
    const invalidActiveFiles = files.filter((file) => file.startsWith('active-')
      && !/^active-\d{3}\.json$/u.test(file) && !file.startsWith('active-chunk.'));
    const activeMarkers = activeFiles.length + Number(legacyActive);
    const hasLegacy = files.some((file) => legacyFiles.has(file) || file.startsWith('active-chunk.') || file.startsWith('searches.jsonl.'));
    if (activeMarkers > 0) found.push({ directory, file: activeFiles[0], folder: name, activeFiles, legacyActive, invalidActiveFiles, files });
    else {
      if (hasLegacy) inactiveLegacy.push(name);
      if (invalidActiveFiles.length > 0) inactiveInvalidActive.push(name);
    }
  }
  const activeCount = found.reduce((count, item) => count + item.activeFiles.length + Number(item.legacyActive), 0);
  if (activeCount > 1) fail('more than one active D chunk');
  if (found.length === 0) {
    if (inactiveLegacy.length > 0) fail('legacy D scratch files are present; preserving them without automatic migration or deletion');
    if (inactiveInvalidActive.length > 0) fail('active D metadata filename is invalid; preserving scratch files');
    fail('no active D chunk');
  }
  const { directory, file, folder, activeFiles, legacyActive, invalidActiveFiles, files: activeDirectoryFiles } = found[0];
  if (invalidActiveFiles.length > 0) fail('active D metadata filename is invalid; preserving scratch files');
  if (legacyActive || activeDirectoryFiles.some((name) => legacyFiles.has(name) || name.startsWith('active-chunk.') || name.startsWith('searches.jsonl.')))
    fail('legacy D scratch files are present; preserving them without automatic migration or deletion');
  if (activeFiles.length !== 1) fail('active D metadata filename is invalid; preserving scratch files');
  let meta;
  try {
    meta = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
  } catch (error) {
    fail(`active D metadata is unreadable: ${error.message}`);
  }
  const number = Number(/^active-(\d{3})\.json$/u.exec(file)?.[1]);
  if (!Number.isInteger(number) || number < 1 || !meta || typeof meta !== 'object' || Array.isArray(meta)
    || meta.chunk_no !== number || !Number.isInteger(meta.total_chunks) || number > meta.total_chunks
    || String(meta.shard) !== folder.slice(2, 5) || String(meta.batch) !== folder.slice(6, 8)
    || typeof meta.view_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(meta.view_sha256)
    || !Number.isInteger(meta.view_bytes) || typeof meta.git_head !== 'string' || !/^[a-f0-9]{40}$/u.test(meta.git_head))
    fail('active D metadata does not match its exact chunk path; preserving scratch files');
  const files = chunkPaths(directory, number);
  let view;
  try {
    view = await readFile(files.view);
  } catch (error) {
    fail(`active D view for chunk ${String(number).padStart(3, '0')} is unreadable: ${error.message}`);
  }
  if (view.byteLength !== meta.view_bytes || sha256(view) !== meta.view_sha256)
    fail('active D view does not match its recorded SHA-256; preserving scratch files');
  return { directory, meta, files };
}

const readEntries = async (directory, meta) => {
  const files = chunkPaths(directory, meta.chunk_no);
  let text;
  try {
    text = await readFile(files.searches, 'utf8');
  } catch (error) {
    fail(`search evidence for chunk ${String(meta.chunk_no).padStart(3, '0')} is unreadable: ${error.message}`);
  }
  const entries = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (entries.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry)
    || entry.chunk_no !== meta.chunk_no || entry.view_sha256 !== meta.view_sha256))
    fail('search evidence does not match the active chunk and view SHA-256; preserving scratch files');
  return entries;
};

async function readCursorEntries(directory, meta, ref) {
  try {
    return await readEntries(directory, meta);
  } catch {
    throw cursorInputError(ref, 'recorded search evidence is unreadable');
  }
}

function cursorInputError(ref, reason, guidance = 'preserve') {
  const nextStep = guidance === 'no-pending'
    ? 'check the last recorded status and exact forms/order/boundary; next is available only for an unconsumed LIMITED search'
    : guidance === 'duplicate'
      ? 'an unfinished LIMITED search already exists; continue it with next under the same condition, or start only a different condition without a cursor'
      : guidance === 'batch'
        ? 'keep one request per record and search condition in this batch; identical senses can share that request'
        : 'do not retry or restart this condition; preserve the evidence and report the conflict';
  return new InvalidCursorError(`${ref}: ${reason}; ${nextStep}; no search executed; no evidence recorded`);
}

/** Resolve only an unconsumed, source-recorded LIMITED cursor for this exact record and search condition. */
export function resolveRecordedCursor({ cursor, recordId, forms, boundary, entries, ref = 'cursor' }) {
  const requestedCursor = cursor === '' ? null : cursor ?? null;
  if (requestedCursor !== null && typeof requestedCursor !== 'string') throw cursorInputError(ref, 'cursor must be a string or null');
  if (!Array.isArray(entries) || entries.some((entry) => entry === null || typeof entry !== 'object' || Array.isArray(entry))) {
    throw cursorInputError(ref, 'recorded search evidence contains a malformed row');
  }
  const key = searchKey(forms, boundary);
  const matching = entries.filter((entry) => entry?.record_id === recordId
    && (entry?.key === key || Array.isArray(entry?.forms) && JSON.stringify(entry.forms) === JSON.stringify(forms)
      && (entry.boundary ?? null) === (boundary ?? null)));
  const issued = new Map();
  const active = new Set();

  for (const entry of matching) {
    if (entry.key !== key || !Array.isArray(entry.forms) || JSON.stringify(entry.forms) !== JSON.stringify(forms)
      || (entry.boundary ?? null) !== (boundary ?? null)) {
      throw cursorInputError(ref, 'recorded search evidence does not match the exact forms and boundary');
    }
    if (!['ZERO_HITS', 'COMPLETE', 'LIMITED', 'SEARCH_FAILED'].includes(entry.status)
      || !['prepare', 'search'].includes(entry.source) || !Number.isInteger(entry.hits) || entry.hits < 0
      || !Object.hasOwn(entry, 'cursor_in') || entry.cursor_in !== null && typeof entry.cursor_in !== 'string'
      || !Object.hasOwn(entry, 'cursor_out') || entry.cursor_out !== null && typeof entry.cursor_out !== 'string') {
      throw cursorInputError(ref, 'recorded search evidence is incomplete or has an unknown status');
    }
    if (entry.status === 'SEARCH_FAILED') {
      // A failed first-page attempt issued no cursor. Ignore it for both retry and
      // continuation resolution so a later successful LIMITED chain can proceed.
      if (entry.cursor_in === null) continue;
      throw cursorInputError(ref, 'a continuation of this cursor chain has recorded SEARCH_FAILED evidence');
    }

    const input = entry.cursor_in;
    if (entry.status === 'ZERO_HITS' && input !== null) {
      throw cursorInputError(ref, 'a continued search cannot be recorded as ZERO_HITS');
    }
    if (input !== null) {
      if (!active.has(input)) throw cursorInputError(ref, 'recorded cursor chain is missing, consumed, or ambiguous');
      active.delete(input);
    }
    if (entry.status === 'LIMITED') {
      if (entry.complete !== false || typeof entry.cursor_out !== 'string' || entry.cursor_out.length === 0
        || entry.cursor_out === input || issued.has(entry.cursor_out)) {
        throw cursorInputError(ref, 'recorded LIMITED cursor evidence is not trustworthy');
      }
      issued.set(entry.cursor_out, { active: true });
      active.add(entry.cursor_out);
    } else if (entry.complete !== true || entry.cursor_out !== null) {
      throw cursorInputError(ref, 'recorded completed search evidence is not trustworthy');
    }
  }

  if (active.size > 1) {
    throw cursorInputError(ref, 'more than one unfinished cursor chain matches this record and exact search condition');
  }
  if (requestedCursor === null) {
    if (active.size > 0) {
      throw cursorInputError(ref, 'a recorded LIMITED search for this record and exact search condition is still unfinished', 'duplicate');
    }
    return null;
  }
  if (requestedCursor === 'next') {
    if (active.size === 0) throw cursorInputError(ref, 'there is no recorded unfinished LIMITED search for this record and exact search condition', 'no-pending');
    return active.values().next().value;
  }
  if (!active.has(requestedCursor)) throw cursorInputError(ref, 'cursor does not exactly match an unconsumed recorded LIMITED.cursor_out for this record and search condition');
  return requestedCursor;
}

function validateRequestedCursor(database, cursor, forms, boundary, ref) {
  try {
    validateSearchCursor(database, forms, { boundary, cursor });
  } catch (error) {
    if (error instanceof InvalidCursorError) throw cursorInputError(ref, error.message.replace(/^INVALID_CURSOR:\s*/u, ''));
    throw error;
  }
}

/** Append one source-sense-independent evidence row per record and exact successful request. */
async function appendSearchEvidence(directory, meta, entries, priorEntries = undefined) {
  if (entries.length === 0) return 0;
  const files = chunkPaths(directory, meta.chunk_no);
  const prior = priorEntries ?? await readEntries(directory, meta);
  const seen = new Set(prior.filter((entry) => entry.request_key !== undefined && entry.status !== 'SEARCH_FAILED')
    .map((entry) => JSON.stringify([entry.record_id, entry.request_key])));
  const append = [];
  for (const entry of entries) {
    const identity = JSON.stringify([entry.record_id, entry.request_key]);
    if (entry.status !== 'SEARCH_FAILED' && seen.has(identity)) continue;
    append.push({ ...entry, chunk_no: meta.chunk_no, view_sha256: meta.view_sha256 });
    if (entry.status !== 'SEARCH_FAILED') seen.add(identity);
  }
  if (append.length > 0) await appendFile(files.searches, `${append.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return append.length;
}

const normalizedSearchForms = (forms) => [...new Set(forms
  .map((form) => String(form).normalize('NFC').trim()).filter(Boolean))];

const searchOptions = (contexts, boundary, cursor) => ({
  maxSamples: contexts,
  snippetChars: INITIAL_SNIPPET_CHARS,
  maxChars: Math.min(24_000, Math.max(6000, contexts * 600)),
  boundary,
  cursor: cursor ?? null,
});

/** Resolve and deduplicate all same-condition searches before they reach the approved read-only index. */
export function buildSearchBatch({ requests, meta, records, search, priorEntries = [], validateCursor, maxOutputBytes = MAX_BATCH_OUTPUT_BYTES }) {
  if (!Array.isArray(requests) || requests.length === 0) fail('search-batch needs a non-empty requests array');
  const senses = new Map(meta.senses.map((item) => [item.ref, item]));
  const canonical = new Map(records.map((record) => [record.id, record]));
  const groups = new Map();
  const resolved = [];
  const recordConditions = new Map();
  const allowed = new Set(['sense', 'forms', 'boundary', 'cursor', 'contexts']);

  requests.forEach((request, index) => {
    const requestId = `r${index + 1}`;
    if (request === null || typeof request !== 'object' || Array.isArray(request)) fail(`${requestId} must be an object`);
    const unexpected = Object.keys(request).filter((key) => !allowed.has(key));
    if (unexpected.length > 0) fail(`${requestId} has unsupported field(s): ${unexpected.join(', ')}`);
    if (typeof request.sense !== 'string' || !SENSE_REF.test(request.sense)) fail(`${requestId}.sense must be an active sN reference`);
    const sense = senses.get(request.sense);
    if (!sense) fail(`${request.sense} is not a sense of the active chunk`);
    if (sense.auto) fail(`${request.sense} is an automatic ZERO_HITS sense of this chunk; it is not searched`);
    const record = canonical.get(sense.record_id);
    if (!record) fail(`${request.sense} has no Canonical record in the active chunk`);

    let forms;
    if (request.forms === undefined) forms = recordForms(record);
    else {
      if (!Array.isArray(request.forms) || request.forms.some((form) => typeof form !== 'string')) {
        fail(`${requestId}.forms must be an array of strings`);
      }
      forms = normalizedSearchForms(request.forms);
    }
    if (forms.length === 0) fail(`${requestId}.forms must contain at least one non-empty search form`);
    const boundary = request.boundary;
    if (boundary !== undefined && !['left', 'none', 'both'].includes(boundary)) fail(`${requestId}.boundary must be left, none or both`);
    const requestedCursor = request.cursor === '' ? null : request.cursor ?? null;
    if (requestedCursor !== null && typeof requestedCursor !== 'string') fail(`${requestId}.cursor must be a string or null`);
    const contexts = request.contexts ?? INITIAL_CONTEXTS;
    if (!Number.isInteger(contexts) || contexts < 1 || contexts > MAX_CALL_CONTEXTS) {
      fail(`${requestId}.contexts must be 1..${MAX_CALL_CONTEXTS}`);
    }
    const cursor = resolveRecordedCursor({ cursor: requestedCursor, recordId: record.id, forms, boundary, entries: priorEntries, ref: request.sense });
    if (cursor !== null) {
      if (typeof validateCursor !== 'function') throw cursorInputError(request.sense, 'corpus cursor validation is required');
      validateCursor(cursor, forms, boundary, request.sense);
    }
    const options = searchOptions(contexts, boundary, cursor);
    const exactRequestKey = requestKey(forms, boundary, options);
    const recordCondition = JSON.stringify([record.id, searchKey(forms, boundary)]);
    const previousRequest = recordConditions.get(recordCondition);
    if (previousRequest && previousRequest !== exactRequestKey) {
      throw cursorInputError(request.sense, 'this batch contains multiple requests for the same record and search condition', 'batch');
    }
    recordConditions.set(recordCondition, exactRequestKey);
    let group = groups.get(exactRequestKey);
    if (!group) {
      group = {
        result_id: `q${groups.size + 1}`, exactRequestKey, forms, boundary, cursor,
        contexts, options, requesters: [], originalRequests: [],
      };
      groups.set(exactRequestKey, group);
    }
    const requester = { request_id: requestId, sense: request.sense, record_id: sense.record_id };
    group.requesters.push(requester);
    group.originalRequests.push({ ...request, ...(Array.isArray(request.forms) ? { forms: [...request.forms] } : {}) });
    resolved.push({ ...requester, result_id: group.result_id });
  });

  const evidence = [];
  const corpusRows = Math.max(1, Math.floor(search.corpusRows ?? DEFAULT_REQUEST_SCAN_BUDGET_ROWS));
  const scanBudgetRows = corpusRows * BATCH_SCAN_BUDGET_PASSES;
  let scannedRows = 0;
  const resultById = new Map();
  const results = [...groups.values()].map((group) => {
    const remainingBatchRows = scanBudgetRows - scannedRows;
    if (remainingBatchRows <= 0) {
      const deferred = {
        result_id: group.result_id,
        shared_by: group.requesters,
        forms: group.forms,
        boundary: group.boundary ?? null,
        cursor_in: null,
        cursor_out: null,
        contexts_limit: group.contexts,
        status: 'DEFERRED',
        hits: 0,
        scanned_rows: 0,
        contexts: [],
        retry_requests: group.originalRequests,
      };
      resultById.set(group.result_id, 'DEFERRED');
      return deferred;
    }
    const maxScanRows = Math.min(corpusRows, remainingBatchRows);
    const { result, cursorIn } = searchForContexts(search, group.forms, group.options, { maxScanRows });
    scannedRows += result.scanned_rows ?? 0;
    resultById.set(group.result_id, result.status);
    if (result.status !== 'DEFERRED') {
      const recordsSeen = new Set();
      for (const requester of group.requesters) {
        if (recordsSeen.has(requester.record_id)) continue;
        recordsSeen.add(requester.record_id);
        evidence.push(entryOf(requester.record_id, group.forms, group.boundary, result, 'search', cursorIn, group.exactRequestKey));
      }
    }
    return {
      result_id: group.result_id,
      shared_by: group.requesters,
      forms: group.forms,
      boundary: group.boundary ?? null,
      cursor_in: cursorIn,
      cursor_out: result.next_cursor ?? null,
      contexts_limit: group.contexts,
      status: result.status,
      hits: result.items.length,
      scanned_rows: result.scanned_rows ?? 0,
      ...(result.error ? { error: [...String(result.error)].slice(0, 200).join('') } : {}),
      contexts: result.items,
      ...(result.status === 'DEFERRED' ? { retry_requests: group.originalRequests } : {}),
    };
  });
  const output = {
    status: results.some((result) => result.status === 'SEARCH_FAILED') ? 'SEARCH_FAILED'
      : results.some((result) => result.status === 'DEFERRED') ? 'PARTIAL' : 'OK',
    request_count: requests.length,
    result_count: results.length,
    deferred_count: results.filter((result) => result.status === 'DEFERRED').reduce((sum, result) => sum + result.retry_requests.length, 0),
    scan_budget_rows: scanBudgetRows,
    scanned_rows: scannedRows,
    requests: resolved.map((request) => ({ ...request, status: resultById.get(request.result_id) })),
    results,
  };
  const bytes = Buffer.byteLength(`${JSON.stringify(output)}\n`);
  if (bytes > maxOutputBytes) {
    fail(`search-batch response is ${bytes} bytes; limit is ${maxOutputBytes}. Split the request into fewer senses or lower contexts, then retry. No search evidence was recorded.`);
  }
  return { output, evidence };
}

export async function searchBatchActive({ requests, databasePath, root = '.warroom-scratch', maxOutputBytes = MAX_BATCH_OUTPUT_BYTES }) {
  const { directory, meta } = await findActive(root);
  const rows = await loadBatchRecords(meta.canonical, meta.shard, meta.batch);
  const activeRecords = new Set(meta.records.map((record) => record.record_id));
  const records = rows.filter((record) => activeRecords.has(record.id));
  const priorEntries = await readCursorEntries(directory, meta, 'search-batch');
  const database = openReadonlyDb(databasePath);
  let batch;
  try {
    batch = buildSearchBatch({
      requests, meta, records, search: createSearchContextReuse(database), priorEntries: priorEntries ?? [],
      validateCursor: (cursor, forms, boundary, ref) => validateRequestedCursor(database, cursor, forms, boundary, ref),
      maxOutputBytes,
    });
  } finally {
    database.close?.();
  }
  await appendSearchEvidence(directory, meta, batch.evidence, priorEntries);
  return batch.output;
}

export async function searchActive({ ref, forms, boundary, cursor, contexts, databasePath, root }) {
  const { directory, meta, files } = await findActive(root);
  const sense = meta.senses.find((item) => item.ref === ref);
  if (!sense) fail(`${ref} is not a sense of the active chunk`);
  if (sense.auto) fail(`${ref} is an automatic ZERO_HITS sense of this chunk; it is not searched`);
  const record = meta.records.find((item) => item.record_id === sense.record_id);
  const rows = await loadBatchRecords(meta.canonical, meta.shard, meta.batch);
  const source = rows.find((item) => item.id === record.record_id);
  const list = normalizedSearchForms(forms ?? recordForms(source));
  const count = contexts ?? INITIAL_CONTEXTS;
  if (!Number.isInteger(count) || count < 1 || count > MAX_CALL_CONTEXTS) fail(`--contexts must be 1..${MAX_CALL_CONTEXTS}`);
  if (boundary !== undefined && !['left', 'none', 'both'].includes(boundary)) fail('--boundary must be left, none or both');
  const requestedCursor = cursor === '' ? null : cursor ?? null;
  const priorEntries = await readCursorEntries(directory, meta, ref);
  const resolvedCursor = resolveRecordedCursor({ cursor: requestedCursor, recordId: record.record_id, forms: list, boundary, entries: priorEntries ?? [], ref });
  const database = openReadonlyDb(databasePath);
  let result;
  let cursorIn;
  const options = searchOptions(count, boundary, resolvedCursor);
  try {
    if (resolvedCursor !== null) validateRequestedCursor(database, resolvedCursor, list, boundary, ref);
    const search = (searchForms, searchOpts) => ({ result: searchContexts(database, searchForms, searchOpts) });
    search.corpusRows = corpusScanRows(database);
    ({ result, cursorIn } = searchForContexts(search, list, options));
  } finally {
    database.close?.();
  }
  const exactRequestKey = requestKey(list, boundary, options);
  await appendFile(files.searches, `${JSON.stringify({ ...entryOf(record.record_id, list, boundary, result, 'search', cursorIn, exactRequestKey),
    chunk_no: meta.chunk_no, view_sha256: meta.view_sha256 })}\n`);
  return { result, text: renderContexts(result) };
}

// ---- save -----------------------------------------------------------------------------------------------------------
/** Parse decisions text into {decisions: Map(ref -> {kind, candidates, line}), errors}. */
export function parseDecisions(text) {
  const decisions = new Map();
  const errors = [];
  text.split(/\r?\n/u).forEach((raw, index) => {
    const line = raw.trim();
    if (line.length === 0) return;
    const match = DECISION_LINE.exec(line);
    if (!match) return errors.push(`line ${index + 1}: expected "sN V cand|cand", "sN V", "sN N" or "sN Z"`);
    const [, ref, kind, rest] = match;
    if (decisions.has(ref)) return errors.push(`line ${index + 1}: ${ref} appears more than once`);
    let candidates = [];
    if (kind === 'V' && rest !== undefined) {
      candidates = rest.split('|').map((item) => normalizeCandidate(item));
      if (candidates.some((item) => item.length === 0)) errors.push(`line ${index + 1}: ${ref} has an empty candidate`);
    } else if (rest !== undefined && rest.trim().length > 0) errors.push(`line ${index + 1}: ${ref} ${kind} takes no candidates`);
    decisions.set(ref, { kind, candidates, line: index + 1 });
  });
  return { decisions, errors };
}

/**
 * Local, fail-closed checks of the whole chunk at once (every error of every sense is reported together):
 * each non-automatic sense exactly once; V needs recorded contexts; N needs recorded contexts but no candidates; Z needs
 * every recorded search of the record complete with 0 hits (whether more forms were needed is the AI's and the
 * reviewer's judgment); candidates follow the Candidate v1 form rules.
 */
export function checkDecisions({ meta, records, entries, decisions, lemmaForms }) {
  const errors = [];
  const hitBearingZ = []; // Z refused because a recorded search of the record has hits: re-judging alone cannot fix it
  const bySense = new Map(meta.senses.map((item) => [item.ref, item]));
  for (const ref of decisions.keys()) {
    if (!bySense.has(ref)) errors.push(`${ref}: unknown sense (this chunk has s1..s${meta.senses.length})`);
    else if (bySense.get(ref).auto) errors.push(`${ref}: automatic ZERO_HITS sense; omit it`);
  }
  const rows = records.map((record) => ({ record_id: record.id, senses: [] }));
  const rowOf = new Map(rows.map((row) => [row.record_id, row]));
  for (const item of meta.senses) {
    const record = records.find((entry) => entry.id === item.record_id);
    const sourceSense = record.senses.find((sense) => sense.id === item.sense_id);
    const decision = item.auto ? { kind: 'Z', candidates: [] } : decisions.get(item.ref);
    if (!decision) {
      errors.push(`${item.ref}: missing (every non-automatic sense needs one line)`);
      continue;
    }
    if (!item.auto) {
      const evidence = recordEvidence(entries, item.record_id);
      if ((decision.kind === 'V' || decision.kind === 'N') && evidence.hits === 0) {
        errors.push(`${item.ref}: ${decision.kind} needs at least one recorded search with contexts (none: use Z when a complete search found nothing, otherwise search more)`);
      }
      if (decision.kind === 'Z' && !(evidence.allComplete && evidence.hits === 0)) {
        errors.push(`${item.ref}: Z needs every recorded search of this record to be complete with 0 hits (a LIMITED or hit-bearing search cannot support Z)`);
        if (evidence.hits > 0) hitBearingZ.push(item.ref);
      }
    }
    const seen = new Set();
    for (const candidate of decision.candidates) {
      const normalized = normalizeCandidate(candidate);
      if (seen.has(normalized)) errors.push(`${item.ref}: duplicate candidate ${JSON.stringify(candidate)}`);
      seen.add(normalized);
      const repeat = sourceLemmaRepeatMessage(candidate, record, lemmaForms);
      if (repeat !== undefined) errors.push(`${item.ref}: ${repeat}`);
      else if (isThousandsCommaFragment(candidate, sourceSense.gloss)) errors.push(`${item.ref}: candidate ${JSON.stringify(candidate)} is a fragment of a thousands-comma number in the gloss`);
    }
    rowOf.get(item.record_id).senses.push({ sense_id: item.sense_id, candidates: decision.candidates });
  }
  return { errors, rows, hitBearingZ };
}

export async function saveActive({ inputPath, root }) {
  const { directory, meta, files } = await findActive(root);
  if (path.resolve(inputPath) !== path.resolve(files.decisions))
    fail(`save input must be the decision file for active chunk ${String(meta.chunk_no).padStart(3, '0')}; no other chunk file is read`);
  const target = path.join(directory, chunkFile(meta.chunk_no));
  if (existsSync(target)) fail(`${chunkFile(meta.chunk_no)} is already saved; it is never overwritten`);
  for (let number = 1; number < meta.chunk_no; number += 1) {
    if (!existsSync(path.join(directory, chunkFile(number)))) fail(`${chunkFile(number)} is missing; chunks are saved in order`);
  }
  const all = await loadBatchRecords(meta.canonical, meta.shard, meta.batch);
  const records = chunkRecords(all, meta.chunk_no);
  if (JSON.stringify(records.map((record) => [record.id, record.senses.map((sense) => sense.id)]))
    !== JSON.stringify(meta.records.map((record) => [record.record_id, record.sense_ids]))) {
    fail('the Canonical records of this chunk changed since prepare');
  }
  const { decisions, errors: parseErrors } = parseDecisions(await readFile(inputPath, 'utf8'));
  const lemmaForms = await loadCanonicalLemmaForms();
  const entries = await readEntries(directory, meta);
  const { errors, rows, hitBearingZ } = checkDecisions({ meta, records, entries, decisions, lemmaForms });
  const all_errors = [...parseErrors, ...errors];
  if (all_errors.length > 0) {
    // A recorded SEARCH_FAILED means the evidence itself is broken: re-judging is never an automatic repair.
    const searchFailed = entries.some((entry) => entry.status === 'SEARCH_FAILED');
    // One diagnostic bound to this active chunk, for the War Room Supervisor (never read from tool logs). It holds only
    // the rejection reasons, never the view or search contexts. A hit-bearing Z cannot be repaired by editing decisions.
    await writeAtomic(files.rejected, JSON.stringify({
      diagnostic: 'save_rejected', chunk_no: meta.chunk_no, view_sha256: meta.view_sha256, git_head: meta.git_head,
      repair_scope: hitBearingZ.length > 0 || searchFailed ? 'stop_and_report' : 'decisions',
      senses: [...new Set(all_errors.map((message) => /^(s[1-9]\d*):/u.exec(message)?.[1]).filter(Boolean))],
      errors: all_errors.slice(0, MAX_REJECTED_ERRORS).map((message) => message.slice(0, MAX_REJECTED_ERROR_CHARS)),
      error_count: all_errors.length,
    }));
    const error = new Error(`save rejected (${all_errors.length}); nothing was stored:\n${all_errors.join('\n')}`);
    error.exitCode = 2;
    throw error;
  }
  await saveChunk(directory, meta.chunk_no, rows, expectedOf(records));
  return { status: 'SAVED', chunk_no: meta.chunk_no, records: rows.length, senses: meta.senses.length };
}

// ---- command line -----------------------------------------------------------------------------------------------------
function parseArguments(args) {
  const options = {};
  const positional = [];
  const booleanOptions = new Set(['hada-prefetch']);
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith('--')) {
      positional.push(item);
      continue;
    }
    const key = item.slice(2);
    if (!/^[a-z][a-z0-9-]*$/u.test(key)) fail(`invalid option ${item}`);
    if (options[key] !== undefined) fail(`${item} was provided more than once`);
    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${item} requires a value`);
    options[key] = value;
    index += 1;
  }
  return { options, positional };
}

function only(options, ...allowed) {
  const unexpected = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) fail(`unsupported option(s): ${unexpected.map((key) => `--${key}`).join(', ')}`);
}

const need = (options, name) => options[name] ?? fail(`--${name} is required`);

async function main(argv) {
  const [command, ...rest] = argv;
  const { options, positional } = parseArguments(rest);
  if (command === 'prepare') {
    only(options, 'canonical', 'shard', 'batch', 'chunk', 'db', 'model', 'head', 'dir', 'hada-prefetch');
    if (positional.length) fail('prepare takes options only');
    const out = await prepareChunk({
      canonicalPath: need(options, 'canonical'), shard: need(options, 'shard'), batch: need(options, 'batch'),
      chunkNumber: Number(need(options, 'chunk')), databasePath: need(options, 'db'), model: need(options, 'model'),
      head: need(options, 'head'), directory: options.dir, hadaPrefetch: options['hada-prefetch'] === true,
    });
    console.log(JSON.stringify(out));
    return out.status === 'SEARCH_FAILED' ? 3 : 0;
  }
  if (command === 'search') {
    only(options, 'forms', 'boundary', 'cursor', 'contexts');
    if (positional.length !== 1 || !SENSE_REF.test(positional[0])) fail('usage: search <s-id> [--forms a,b] [--boundary left|none|both] [--cursor C|next] [--contexts 1..16]');
    const databasePath = process.env.TYPEWRITER_APPROVED_CORPUS_DB || fail('TYPEWRITER_APPROVED_CORPUS_DB is not set');
    const { result, text } = await searchActive({
      ref: positional[0], forms: options.forms?.split(',').map((item) => item.trim()).filter(Boolean), boundary: options.boundary,
      cursor: options.cursor, contexts: options.contexts === undefined ? undefined : Number(options.contexts), databasePath,
    });
    console.log(text);
    return result.status === 'SEARCH_FAILED' ? 3 : 0;
  }
  if (command === 'search-batch') {
    only(options, 'dir');
    if (positional.length) fail('search-batch reads one JSON request from stdin and takes no positional arguments');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 256 * 1024) fail('search-batch input exceeds 256 KiB; split the request into fewer senses');
      chunks.push(chunk);
    }
    let input;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      fail(`search-batch stdin must be one JSON object: ${error.message}`);
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('search-batch stdin must be a JSON object with a requests array');
    const unexpected = Object.keys(input).filter((key) => key !== 'requests');
    if (unexpected.length > 0) fail(`search-batch input has unsupported field(s): ${unexpected.join(', ')}`);
    const databasePath = process.env.TYPEWRITER_APPROVED_CORPUS_DB || fail('TYPEWRITER_APPROVED_CORPUS_DB is not set');
    const output = await searchBatchActive({ requests: input.requests, databasePath, root: options.dir });
    console.log(JSON.stringify(output));
    return output.status === 'SEARCH_FAILED' ? 3 : 0;
  }
  if (command === 'save') {
    only(options, 'in');
    if (positional.length) fail('save takes options only');
    console.log(JSON.stringify(await saveActive({ inputPath: need(options, 'in') })));
    return 0;
  }
  return fail('usage: d-chunk-cli.mjs prepare|search|search-batch|save');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  });
}
