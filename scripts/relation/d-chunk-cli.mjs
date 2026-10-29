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
  candidateV1ContentIssue,
  loadCanonicalLemmaForms,
  normalizeCandidate,
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

const evidenceFields = (entry) => JSON.stringify([
  entry.key, entry.forms, entry.boundary ?? null, entry.status, entry.hits, entry.complete,
  entry.cursor_in, entry.cursor_out,
]);

/**
 * Interpret one record's exact ordered forms/boundary condition from its recorded cursor chain. Completion is trusted
 * only when every continuation consumes the preceding recorded cursor and the chain has one terminal page.
 */
export function recordedCondition({ recordId, forms, boundary, entries, ref = 'search' }) {
  if (!Array.isArray(entries)) throw cursorInputError(ref, 'recorded search evidence is not an array');
  const key = searchKey(forms, boundary);
  const forRecord = entries.filter((entry) => entry?.record_id === recordId);
  for (const entry of forRecord) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !Array.isArray(entry.forms) || entry.forms.length === 0
      || entry.forms.some((form) => typeof form !== 'string' || form.length === 0 || form !== form.normalize('NFC').trim())
      || JSON.stringify(entry.forms) !== JSON.stringify(normalizedSearchForms(entry.forms))
      || entry.key !== searchKey(entry.forms, entry.boundary)
      || entry.boundary !== null && !['left', 'none', 'both'].includes(entry.boundary)
      || !['ZERO_HITS', 'COMPLETE', 'LIMITED', 'SEARCH_FAILED'].includes(entry.status)
      || !['prepare', 'search'].includes(entry.source)
      || !Number.isInteger(entry.hits) || entry.hits < 0
      || entry.complete !== isComplete(entry.status)
      || !Object.hasOwn(entry, 'cursor_in') || entry.cursor_in !== null && typeof entry.cursor_in !== 'string'
      || !Object.hasOwn(entry, 'cursor_out') || entry.cursor_out !== null && typeof entry.cursor_out !== 'string'
      || entry.request_key !== undefined && typeof entry.request_key !== 'string') {
      throw cursorInputError(ref, 'recorded search evidence is incomplete or malformed');
    }
    if (entry.status === 'ZERO_HITS' && (entry.hits !== 0 || entry.cursor_in !== null)) {
      throw cursorInputError(ref, 'recorded ZERO_HITS evidence is inconsistent');
    }
    if (entry.status === 'SEARCH_FAILED' && entry.complete !== false) {
      throw cursorInputError(ref, 'recorded SEARCH_FAILED evidence is inconsistent');
    }
  }
  const matching = forRecord.filter((entry) => entry.key === key
    || JSON.stringify(entry.forms) === JSON.stringify(forms) && (entry.boundary ?? null) === (boundary ?? null));
  for (const entry of matching) {
    if (entry.key !== key || JSON.stringify(entry.forms) !== JSON.stringify(forms)
      || (entry.boundary ?? null) !== (boundary ?? null)) {
      throw cursorInputError(ref, 'recorded search evidence does not match the exact forms and boundary');
    }
  }

  const unique = [];
  const byRequest = new Map();
  const exactRows = new Set();
  for (const entry of matching) {
    const fingerprint = evidenceFields(entry);
    const exactIdentity = `${entry.request_key ?? ''}\0${fingerprint}`;
    if (exactRows.has(exactIdentity)) continue;
    exactRows.add(exactIdentity);
    if (entry.request_key !== undefined && entry.status !== 'SEARCH_FAILED') {
      const prior = byRequest.get(entry.request_key);
      if (prior !== undefined) {
        if (prior !== fingerprint) throw cursorInputError(ref, 'duplicate request evidence conflicts');
        continue;
      }
      byRequest.set(entry.request_key, fingerprint);
    }
    unique.push(entry);
  }

  const active = new Map();
  const issued = new Set();
  let chain = null;
  let completed = null;
  let failedStart = false;
  for (const entry of unique) {
    if (entry.status === 'SEARCH_FAILED') {
      if (entry.cursor_in === null) {
        failedStart = true;
        continue;
      }
      if (!active.has(entry.cursor_in)) throw cursorInputError(ref, 'recorded cursor chain is missing, consumed, or ambiguous');
      throw cursorInputError(ref, 'a continuation of this cursor chain has recorded SEARCH_FAILED evidence');
    }
    if (entry.cursor_in === null) {
      if (chain !== null || active.size > 0 || completed !== null) {
        throw cursorInputError(ref, 'multiple successful cursor chains match this record and exact search condition');
      }
      chain = { hits: 0, sources: new Set() };
    } else {
      if (!active.has(entry.cursor_in) || chain === null) {
        throw cursorInputError(ref, 'recorded cursor chain is missing, consumed, or ambiguous');
      }
      active.delete(entry.cursor_in);
    }
    chain.hits += entry.hits;
    chain.sources.add(entry.source);
    if (entry.status === 'LIMITED') {
      if (entry.complete !== false || typeof entry.cursor_out !== 'string' || entry.cursor_out.length === 0
        || entry.cursor_out === entry.cursor_in || issued.has(entry.cursor_out)) {
        throw cursorInputError(ref, 'recorded LIMITED cursor evidence is not trustworthy');
      }
      issued.add(entry.cursor_out);
      active.set(entry.cursor_out, true);
    } else {
      if (entry.complete !== true || entry.cursor_out !== null) {
        throw cursorInputError(ref, 'recorded completed search evidence is not trustworthy');
      }
      completed = { status: entry.status, hits: chain.hits, sources: [...chain.sources] };
      chain = null;
    }
  }

  if (active.size > 1) throw cursorInputError(ref, 'more than one unfinished cursor chain matches this record and exact search condition');
  if (active.size === 1) {
    return { status: 'LIMITED', recorded_status: 'LIMITED', recorded_hits: chain?.hits ?? 0,
      cursor: active.keys().next().value, complete: false, searches: 1 };
  }
  if (completed !== null) {
    return { status: completed.status, recorded_status: completed.status, recorded_hits: completed.hits,
      cursor: null, complete: true, searches: 1, context_source: [...completed.sources]
        .map((source) => source === 'prepare' ? 'view' : 'search_response').join('+') };
  }
  if (failedStart) return { status: 'SEARCH_FAILED', recorded_status: 'SEARCH_FAILED', recorded_hits: 0,
    cursor: null, complete: false, searches: 1 };
  return { status: 'UNRECORDED', recorded_status: null, recorded_hits: 0, cursor: null, complete: false, searches: 0 };
}

/** Per-record decision evidence, using the same exact cursor-chain proof as search continuation. */
export function recordEvidence(entries, recordId) {
  const forRecord = entries.filter((entry) => entry?.record_id === recordId);
  const conditions = new Map();
  for (const entry of forRecord) {
    if (!Array.isArray(entry.forms)) {
      throw cursorInputError(recordId, 'recorded search evidence is missing its forms');
    }
    const key = searchKey(entry.forms, entry.boundary);
    if (entry.key !== key) throw cursorInputError(recordId, 'recorded search evidence key does not match its forms and boundary');
    conditions.set(key, { forms: entry.forms, boundary: entry.boundary ?? null });
  }
  const searches = [...conditions.values()].map((condition) => recordedCondition({
    recordId, ...condition, entries, ref: recordId,
  }));
  const hits = searches.reduce((sum, item) => sum + item.recorded_hits, 0);
  const allComplete = searches.length > 0 && searches.every((item) => item.complete);
  const failed = searches.some((item) => item.status === 'SEARCH_FAILED');
  return {
    searches: searches.length,
    hits,
    allComplete,
    failed,
    status: failed ? 'SEARCH_FAILED' : hits > 0 ? 'HITS' : allComplete ? 'ZERO_HITS' : 'INCOMPLETE',
    conditions: searches,
  };
}

const decisionState = (evidence) => ({
  state: evidence.failed ? 'SEARCH_FAILED'
    : evidence.hits > 0 ? 'V_N_ALLOWED'
      : evidence.allComplete ? 'Z_ALLOWED' : 'SEARCH_MORE',
  searches: evidence.searches,
  recorded_hits: evidence.hits,
  all_complete: evidence.allComplete,
});

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
    + `${aiSenses.length ? ` decide=${aiSenses.map((item) => item.ref).join(',')}` : ''}`
    + `${autoZ.length ? ` auto_z=${autoZ.join(',')}` : ''}`;
  const body = blocks.map(({ record, canonicalForms, shown, refs }) => {
    const lines = [`## ${record.id} ${record.lemma} | search_forms: ${canonicalForms.join(', ')}`];
    for (const block of shown) lines.push(renderBlock(block));
    const evidence = recordEvidence(entries, record.id);
    if (evidence.failed) lines.push('증거 상태: SEARCH_FAILED — 검색 실패를 보고하고 이 record는 판정·저장하지 않는다.');
    else if (evidence.allComplete && evidence.hits === 0) {
      lines.push('증거 상태: 모든 검색 완료·누적 0 hit — Z 형식 허용; 검색형 충분성은 AI가 판단한다.');
    } else if (evidence.hits > 0) {
      lines.push(`증거 상태: 누적 hit=${evidence.hits} — V/N 형식 허용; 출발 Sense의 VERIFIED 판독은 AI가 한다.`);
    } else lines.push('증거 상태: 미완료 — Z 형식 불가; 필요한 검색을 계속한다.');
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

/** Resolve only an unconsumed, source-recorded LIMITED cursor for this exact record and search condition. */
export function resolveRecordedCursor({ cursor, recordId, forms, boundary, entries, ref = 'cursor' }) {
  const requestedCursor = cursor === '' ? null : cursor ?? null;
  if (requestedCursor !== null && typeof requestedCursor !== 'string') throw cursorInputError(ref, 'cursor must be a string or null');
  const condition = recordedCondition({ recordId, forms, boundary, entries, ref });
  if (requestedCursor === null) {
    if (condition.status === 'LIMITED') {
      throw cursorInputError(ref, 'a recorded LIMITED search for this record and exact search condition is still unfinished', 'duplicate');
    }
    return null;
  }
  if (requestedCursor === 'next') {
    if (condition.status !== 'LIMITED') {
      const conditionText = `recorded_status=${condition.recorded_status ?? 'UNRECORDED'} recorded_hits=${condition.recorded_hits} forms=${JSON.stringify(forms)} boundary=${JSON.stringify(boundary ?? null)}`;
      throw cursorInputError(ref, `${condition.status === 'UNRECORDED' ? 'there is no recorded search' : 'there is no unfinished search'} for this condition (${conditionText})`, 'no-pending');
    }
    return condition.cursor;
  }
  if (condition.status !== 'LIMITED' || condition.cursor !== requestedCursor) {
    throw cursorInputError(ref, 'cursor does not exactly match an unconsumed recorded LIMITED.cursor_out for this record and search condition');
  }
  return condition.cursor;
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
  const allowed = new Set(['sense', 'forms', 'boundary', 'cursor', 'contexts', 'reread']);

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
    if (request.reread !== undefined && typeof request.reread !== 'boolean') fail(`${requestId}.reread must be a boolean`);
    const reread = request.reread === true;
    if (reread && requestedCursor !== null) fail(`${requestId}.reread cannot be combined with a cursor`);
    const contexts = request.contexts ?? INITIAL_CONTEXTS;
    if (!Number.isInteger(contexts) || contexts < 1 || contexts > MAX_CALL_CONTEXTS) {
      fail(`${requestId}.contexts must be 1..${MAX_CALL_CONTEXTS}`);
    }
    const condition = recordedCondition({ recordId: record.id, forms, boundary, entries: priorEntries, ref: request.sense });
    if (reread && !condition.complete) {
      throw cursorInputError(request.sense, `reread requires a proven completed condition (status=${condition.recorded_status ?? condition.status}, hits=${condition.recorded_hits})`);
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
    const mode = reread ? 'reread' : condition.complete ? 'cached' : 'search';
    const groupKey = JSON.stringify([mode, mode === 'cached' ? record.id : null, exactRequestKey]);
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        result_id: `q${groups.size + 1}`, exactRequestKey, groupKey, mode, forms, boundary, cursor,
        contexts, options, requesters: [], originalRequests: [], condition,
      };
      groups.set(groupKey, group);
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
    if (group.mode === 'cached') {
      resultById.set(group.result_id, 'ALREADY_COMPLETE');
      return {
        result_id: group.result_id,
        shared_by: group.requesters,
        forms: group.forms,
        boundary: group.boundary ?? null,
        cursor_in: null,
        cursor_out: null,
        contexts_limit: group.contexts,
        status: 'ALREADY_COMPLETE',
        recorded_status: group.condition.recorded_status,
        recorded_hits: group.condition.recorded_hits,
        scanned_rows: 0,
        contexts: [],
        context_source: group.condition.context_source,
      };
    }
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
    const outputStatus = group.mode === 'reread' && result.status !== 'SEARCH_FAILED'
      ? 'REREAD' : result.status;
    resultById.set(group.result_id, outputStatus);
    if (result.status !== 'DEFERRED' && group.mode === 'search') {
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
      cursor_out: group.mode === 'reread' ? null : result.next_cursor ?? null,
      contexts_limit: group.contexts,
      status: outputStatus,
      ...(group.mode === 'reread' ? { search_status: result.status, context_source: 'reread' } : {}),
      hits: result.items.length,
      scanned_rows: result.scanned_rows ?? 0,
      ...(result.error ? { error: [...String(result.error)].slice(0, 200).join('') } : {}),
      contexts: result.items,
      ...(result.status === 'DEFERRED' ? { retry_requests: group.originalRequests } : {}),
    };
  });
  const requestStates = new Map();
  for (const request of resolved) {
    const recordEntries = [...priorEntries, ...evidence];
    requestStates.set(request.request_id, decisionState(recordEvidence(recordEntries, request.record_id)));
  }
  const output = {
    status: results.some((result) => result.status === 'SEARCH_FAILED') ? 'SEARCH_FAILED'
      : results.some((result) => result.status === 'DEFERRED') ? 'PARTIAL' : 'OK',
    request_count: requests.length,
    result_count: results.length,
    already_complete_count: resolved.filter((request) => resultById.get(request.result_id) === 'ALREADY_COMPLETE').length,
    deferred_count: results.filter((result) => result.status === 'DEFERRED').reduce((sum, result) => sum + result.retry_requests.length, 0),
    scan_budget_rows: scanBudgetRows,
    scanned_rows: scannedRows,
    requests: resolved.map((request) => ({ ...request, status: resultById.get(request.result_id), decision_state: requestStates.get(request.request_id) })),
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

export async function searchActive({ ref, forms, boundary, cursor, contexts, reread = false, databasePath, root }) {
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
  if (typeof reread !== 'boolean') fail('--reread must be a boolean');
  if (reread && requestedCursor !== null) fail('--reread cannot be combined with --cursor');
  const priorEntries = await readCursorEntries(directory, meta, ref);
  const condition = recordedCondition({ recordId: record.record_id, forms: list, boundary, entries: priorEntries, ref });
  if (reread && !condition.complete) {
    throw cursorInputError(ref, `reread requires a proven completed condition (status=${condition.recorded_status ?? condition.status}, hits=${condition.recorded_hits})`);
  }
  const resolvedCursor = resolveRecordedCursor({ cursor: requestedCursor, recordId: record.record_id, forms: list, boundary, entries: priorEntries ?? [], ref });
  const currentDecisionState = () => decisionState(recordEvidence(priorEntries, record.record_id));
  if (condition.complete && !reread) {
    const result = {
      status: 'ALREADY_COMPLETE',
      recorded_status: condition.recorded_status,
      recorded_hits: condition.recorded_hits,
      items: [],
      next_cursor: null,
      scanned_rows: 0,
    };
    const text = `${renderContexts(result)}\ncontext_source=${condition.context_source}\nCompleted evidence contains no readable contexts; reuse the prior view/search response, or request reread only after context loss.`;
    return { result, text, decision_state: currentDecisionState(), context_source: condition.context_source };
  }
  const database = openReadonlyDb(databasePath);
  let result;
  let cursorIn;
  const options = searchOptions(count, boundary, reread ? null : resolvedCursor);
  try {
    if (resolvedCursor !== null) validateRequestedCursor(database, resolvedCursor, list, boundary, ref);
    const search = (searchForms, searchOpts) => ({ result: searchContexts(database, searchForms, searchOpts) });
    search.corpusRows = corpusScanRows(database);
    ({ result, cursorIn } = searchForContexts(search, list, options));
  } finally {
    database.close?.();
  }
  if (reread) {
    const searchStatus = result.status;
    result = { ...result, status: searchStatus === 'SEARCH_FAILED' ? 'SEARCH_FAILED' : 'REREAD',
      search_status: searchStatus, next_cursor: null };
    const text = `${renderContexts(result)}\nsearch_status=${searchStatus}\ncontext_source=reread\nReread adds no search evidence; hit totals and decision state are unchanged.`;
    return { result, text, decision_state: currentDecisionState(), context_source: 'reread' };
  }
  const exactRequestKey = requestKey(list, boundary, options);
  const evidence = { ...entryOf(record.record_id, list, boundary, result, 'search', cursorIn, exactRequestKey),
    chunk_no: meta.chunk_no, view_sha256: meta.view_sha256 };
  await appendSearchEvidence(directory, meta, [evidence], priorEntries);
  const updatedEntries = [...priorEntries, evidence];
  return { result, text: renderContexts(result), decision_state: decisionState(recordEvidence(updatedEntries, record.record_id)) };
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
  const failedEvidence = new Set();
  const evidenceByRecord = new Map();
  for (const record of records) {
    try {
      evidenceByRecord.set(record.id, { evidence: recordEvidence(entries, record.id) });
    } catch (error) {
      evidenceByRecord.set(record.id, { error: error.message });
      failedEvidence.add(record.id);
    }
  }
  const bySense = new Map(meta.senses.map((item) => [item.ref, item]));
  for (const ref of decisions.keys()) {
    if (!bySense.has(ref)) errors.push(`${ref}: unknown sense (this chunk has s1..s${meta.senses.length})`);
    else if (bySense.get(ref).auto) errors.push(`${ref}: automatic ZERO_HITS sense; omit it`);
  }
  const rows = records.map((record) => ({ record_id: record.id, senses: [] }));
  const rowOf = new Map(rows.map((row) => [row.record_id, row]));
  const removedCandidates = [];
  for (const item of meta.senses) {
    const record = records.find((entry) => entry.id === item.record_id);
    const sourceSense = record.senses.find((sense) => sense.id === item.sense_id);
    const decision = item.auto ? { kind: 'Z', candidates: [] } : decisions.get(item.ref);
    if (!decision) {
      errors.push(`${item.ref}: missing (every non-automatic sense needs one line)`);
      continue;
    }
    if (!item.auto) {
      const evidenceResult = evidenceByRecord.get(item.record_id);
      if (evidenceResult?.error) {
        errors.push(`${item.ref}: search evidence integrity error (${evidenceResult.error}); stop and report`);
      } else {
        const evidence = evidenceResult.evidence;
        const state = decisionState(evidence);
        const detail = `decision_state=${state.state} searches=${state.searches} recorded_hits=${state.recorded_hits} all_complete=${state.all_complete}`;
        if (state.state === 'SEARCH_FAILED') {
          errors.push(`${item.ref}: SEARCH_FAILED evidence prevents a normal decision (${detail}); stop and report`);
        } else if ((decision.kind === 'V' || decision.kind === 'N') && evidence.hits === 0) {
          errors.push(`${item.ref}: ${decision.kind} needs at least one recorded search hit (none: use Z only when all conditions are complete, otherwise search more; ${detail})`);
        }
        if (decision.kind === 'Z' && !(evidence.allComplete && evidence.hits === 0)) {
          errors.push(`${item.ref}: Z needs every recorded search of this record complete with 0 hits (a LIMITED, failed, or hit-bearing search cannot support Z; ${detail})`);
          if (evidence.hits > 0) hitBearingZ.push(item.ref);
        }
      }
    }
    const seen = new Set();
    const candidates = [];
    for (const candidate of decision.candidates) {
      const normalized = normalizeCandidate(candidate);
      if (seen.has(normalized)) {
        removedCandidates.push({ ref: item.ref, candidate, kind: 'duplicate_normalized' });
        continue;
      }
      seen.add(normalized);
      const issue = candidateV1ContentIssue(candidate, record, sourceSense, lemmaForms);
      if (issue !== undefined) {
        removedCandidates.push({ ref: item.ref, candidate, kind: issue.kind });
        continue;
      }
      candidates.push(candidate);
    }
    rowOf.get(item.record_id).senses.push({ sense_id: item.sense_id, candidates });
  }
  return { errors, rows, hitBearingZ, removedCandidates, failedEvidence };
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
  const { errors, rows, hitBearingZ, removedCandidates, failedEvidence } = checkDecisions({ meta, records, entries, decisions, lemmaForms });
  const all_errors = [...parseErrors, ...errors];
  if (all_errors.length > 0) {
    // A recorded SEARCH_FAILED means the evidence itself is broken: re-judging is never an automatic repair.
    const searchFailed = failedEvidence.size > 0 || entries.some((entry) => entry.status === 'SEARCH_FAILED');
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
  return { status: 'SAVED', chunk_no: meta.chunk_no, records: rows.length, senses: meta.senses.length,
    removed_candidates: removedCandidates };
}

// ---- command line -----------------------------------------------------------------------------------------------------
function parseArguments(args) {
  const options = {};
  const positional = [];
  const booleanOptions = new Set(['hada-prefetch', 'reread']);
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
    only(options, 'forms', 'boundary', 'cursor', 'contexts', 'reread');
    if (positional.length !== 1 || !SENSE_REF.test(positional[0])) fail('usage: search <s-id> [--forms a,b] [--boundary left|none|both] [--cursor C|next] [--contexts 1..16] [--reread]');
    const databasePath = process.env.TYPEWRITER_APPROVED_CORPUS_DB || fail('TYPEWRITER_APPROVED_CORPUS_DB is not set');
    const { result, text } = await searchActive({
      ref: positional[0], forms: options.forms?.split(',').map((item) => item.trim()).filter(Boolean), boundary: options.boundary,
      cursor: options.cursor, contexts: options.contexts === undefined ? undefined : Number(options.contexts), reread: options.reread === true, databasePath,
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
