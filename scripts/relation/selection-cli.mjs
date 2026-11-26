// Relation Factory common pre-selection (#10174): one `p`/`s`/`e` decision per Canonical Sense, stored as
// `data/relation-selection/selection-SSS.jsonl` (`{"id":"<sense id>","d":"p|s|e"}`, Canonical order, every Sense).
//
// Binding contract: `view` and `save` read the same one Canonical shard file and cut it with the same `chunkShard`.
// The model sees shard-local record numbers (1-based index into that file's records) and Sense order numbers only;
// `save` joins each answer letter k of record n to `records[n-1].senses[k-1].id` of that same array. No ID is
// reconstructed or guessed, and no hash/receipt/mapping ledger exists.
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DECISIONS = Object.freeze(['p', 's', 'e']);
export const CHUNK_TARGET_CHARS = 12000;
const POS = Object.freeze({
  noun: 'n', verb: 'v', adjective: 'a', adverb: 'ad', determiner: 'd', interjection: 'i', expression: 'x', unclassified: 'u',
});

export class SelectionError extends Error {}

export function assertShard(shard) {
  if (!/^\d{3}$/u.test(shard ?? '') || Number(shard) < 1) throw new SelectionError(`invalid shard ${JSON.stringify(shard)} (expected SSS)`);
  return shard;
}

export const canonicalPath = (root, shard) => path.join(root, 'data/canonical', `stdict-${shard.padStart(4, '0')}.jsonl`);
export const selectionPath = (root, shard) => path.join(root, 'data/relation-selection', `selection-${shard}.jsonl`);

export function parseShardRecords(text, label = 'canonical') {
  return text.split('\n').filter((line) => line.trim()).map((line, index) => {
    const record = JSON.parse(line);
    if (!Array.isArray(record.senses)) throw new SelectionError(`${label}:${index + 1}: record without senses`);
    return record;
  });
}

export async function readShardRecords(root, shard) {
  const file = canonicalPath(root, assertShard(shard));
  return parseShardRecords(await readFile(file, 'utf8'), path.relative(root, file));
}

const glossChars = (record) => record.senses.reduce((sum, sense) => sum + (sense.gloss ?? '').length, 0);

/** Deterministic chunks `[start, end)` over the shard's records: never split a record, keep adjacent same-lemma records. */
export function chunkShard(records, { targetChars = CHUNK_TARGET_CHARS } = {}) {
  const chunks = [];
  let start = 0;
  let size = 0;
  for (let i = 0; i < records.length; i += 1) {
    if (i > start && size >= targetChars && records[i].lemma !== records[i - 1].lemma) {
      chunks.push({ start, end: i });
      start = i;
      size = 0;
    }
    size += glossChars(records[i]);
  }
  if (records.length) chunks.push({ start, end: records.length });
  return chunks;
}

const oneLine = (text) => String(text ?? '').replace(/\s*\n\s*/gu, ' ');

export function renderChunk(records, { start, end }) {
  const lines = [];
  for (let i = start; i < end; i += 1) {
    const record = records[i];
    if (!record.senses.length) continue;
    // Multi-Sense records carry their Sense count (`[11]`) so the answer letter count can be matched.
    lines.push(`${i + 1} ${record.lemma}${record.homograph_no ?? ''}${record.senses.length > 1 ? ` [${record.senses.length}]` : ''}`);
    record.senses.forEach((sense, k) => lines.push(` ${k + 1} ${POS[sense.pos] ?? sense.pos} ${oneLine(sense.gloss)}`));
  }
  return lines.join('\n') + '\n';
}

const DECISION_LINE = /^(\d+)\s+(\S+)$/u;

/**
 * Parse one chunk answer: one `<record number> <letters>` line per record that has Senses.
 * Returns `{ lines, letters, errors }`; `lines` = number of decision-shaped lines found (0 = no decision at all).
 */
export function parseAnswer(text, records, { start, end }) {
  const letters = new Map();
  const seen = new Set();
  const errors = [];
  let lines = 0;
  for (const raw of String(text ?? '').split('\n')) {
    const match = raw.trim().replace(/^`+|`+$/gu, '').trim().match(DECISION_LINE);
    if (!match) continue;
    lines += 1;
    const number = Number(match[1]);
    const value = match[2];
    const record = records[number - 1];
    if (number < start + 1 || number > end || !record?.senses.length) { errors.push(`${number}: record number outside this chunk`); continue; }
    if (seen.has(number)) { errors.push(`${number}: duplicate record line`); continue; }
    seen.add(number);
    if (!/^[pse]+$/u.test(value)) { errors.push(`${number}: letters must be p/s/e only (got ${JSON.stringify(value)})`); continue; }
    if (value.length !== record.senses.length) { errors.push(`${number}: ${record.senses.length} Sense(s) need ${record.senses.length} letter(s), got ${value.length}`); continue; }
    letters.set(number, value);
  }
  for (let i = start; i < end; i += 1) {
    if (records[i].senses.length && !seen.has(i + 1)) errors.push(`${i + 1}: missing record line`);
  }
  return { lines, letters, errors };
}

/** Record numbers named by `parseAnswer` errors (wrong length, bad letters, duplicate, missing). */
export const errorRecords = (errors) => [...new Set(errors.map((error) => Number(error.split(':')[0])))];

/**
 * Format repair: keep the previous answer's lines for records without errors, take only the repaired records' lines
 * from the repair answer. The result is re-checked with the strict `parseAnswer`.
 */
export function mergeRepair(previous, repair, bad) {
  const wanted = new Set(bad);
  const keep = (text, inBad) => String(text ?? '').split('\n').map((raw) => raw.trim().replace(/^`+|`+$/gu, '').trim())
    .filter((line) => { const match = line.match(DECISION_LINE); return match && wanted.has(Number(match[1])) === inBad; });
  return [...keep(previous, false), ...keep(repair, true)].join('\n') + '\n';
}

/** Rows in Canonical order, bound to the real Sense IDs of the same record array. */
export function selectionRows(records, letters) {
  const rows = [];
  records.forEach((record, i) => record.senses.forEach((sense, k) => {
    const d = letters.get(i + 1)?.[k];
    if (!d) throw new SelectionError(`no decision for ${sense.id}`);
    rows.push({ id: sense.id, d });
  }));
  return rows;
}

export const serializeRows = (rows) => rows.map((row) => JSON.stringify({ id: row.id, d: row.d })).join('\n') + (rows.length ? '\n' : '');

export const answerPath = (dir, chunk) => path.join(dir, `c${String(chunk).padStart(2, '0')}.answer.txt`);

/** Read every chunk answer of a shard from `dir`; write the selection file once, only when all chunks are valid. */
export async function save(root, shard, dir) {
  const records = await readShardRecords(root, shard);
  const chunks = chunkShard(records);
  const letters = new Map();
  const problems = [];
  for (const [index, chunk] of chunks.entries()) {
    let text;
    try { text = await readFile(answerPath(dir, index + 1), 'utf8'); }
    catch { problems.push(`chunk ${index + 1}: no answer`); continue; }
    const parsed = parseAnswer(text, records, chunk);
    if (parsed.errors.length) { problems.push(`chunk ${index + 1}: ${parsed.errors.join('; ')}`); continue; }
    for (const [number, value] of parsed.letters) letters.set(number, value);
  }
  if (problems.length) throw new SelectionError(`shard ${shard} not saved:\n${problems.join('\n')}`);
  const rows = selectionRows(records, letters);
  const file = selectionPath(root, shard);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, serializeRows(rows));
  await rename(`${file}.tmp`, file);
  return counts(rows);
}

export function counts(rows) {
  const total = { p: 0, s: 0, e: 0 };
  for (const row of rows) total[row.d] += 1;
  return total;
}

/** #10174 §5 basic check: exact Sense IDs, no duplicate/missing, only `id`/`d`, values p/s/e, Canonical order. */
export function checkRows(records, text) {
  const expected = records.flatMap((record) => record.senses.map((sense) => sense.id));
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const errors = [];
  const rows = [];
  lines.forEach((line, index) => {
    const at = `line ${index + 1}`;
    let row;
    try { row = JSON.parse(line); } catch { errors.push(`${at}: invalid JSON`); return; }
    if (!row || typeof row !== 'object' || Object.keys(row).join(',') !== 'id,d') { errors.push(`${at}: fields must be exactly id,d`); return; }
    if (JSON.stringify(row) !== line) errors.push(`${at}: not compact JSON`);
    if (!DECISIONS.includes(row.d)) errors.push(`${at}: invalid d ${JSON.stringify(row.d)}`);
    if (row.id !== expected[index]) errors.push(`${at}: expected ${expected[index] ?? '(end of shard)'}, got ${row.id}`);
    rows.push(row);
  });
  if (lines.length < expected.length) errors.push(`missing ${expected.length - lines.length} Sense(s) from ${expected[lines.length]}`);
  return { errors, counts: counts(rows.filter((row) => DECISIONS.includes(row.d))) };
}

export function parseShards(spec) {
  const shards = [];
  for (const part of String(spec ?? '').split(',').filter(Boolean)) {
    const [a, b = a] = part.split('-');
    assertShard(a); assertShard(b);
    for (let n = Number(a); n <= Number(b); n += 1) shards.push(String(n).padStart(3, '0'));
  }
  if (!shards.length) throw new SelectionError('no shard given');
  return shards;
}

const usage = `usage:
  relation:select view  --shard SSS [--chunk N]   compact chunk view (no --chunk: chunk count)
  relation:select save  --shard SSS --dir <answers dir>
  relation:select check --shard SSS[-SSS][,SSS...]`;

function option(argv, flag) {
  const position = argv.indexOf(flag);
  const value = position >= 0 ? argv[position + 1] : null;
  return value && !value.startsWith('--') ? value : null;
}

export async function run(argv, { root = REPOSITORY_DIRECTORY, out = (text) => process.stdout.write(text) } = {}) {
  const [command] = argv;
  if (command === 'view') {
    const shard = assertShard(option(argv, '--shard'));
    const records = await readShardRecords(root, shard);
    const chunks = chunkShard(records);
    const chunk = option(argv, '--chunk');
    if (chunk === null) { out(`${chunks.length}\n`); return chunks.length; }
    const selected = chunks[Number(chunk) - 1];
    if (!selected) throw new SelectionError(`shard ${shard} has ${chunks.length} chunk(s)`);
    const text = renderChunk(records, selected);
    out(text);
    return text;
  }
  if (command === 'save') {
    const shard = assertShard(option(argv, '--shard'));
    const dir = option(argv, '--dir');
    if (!dir) throw new SelectionError(`save requires --dir\n${usage}`);
    const result = await save(root, shard, path.resolve(dir));
    out(`${JSON.stringify({ shard, ...result })}\n`);
    return result;
  }
  if (command === 'check') {
    const results = [];
    for (const shard of parseShards(option(argv, '--shard'))) {
      const records = await readShardRecords(root, shard);
      let text;
      try { text = await readFile(selectionPath(root, shard), 'utf8'); }
      catch { results.push({ shard, ok: false, errors: ['selection file missing'] }); continue; }
      const { errors, counts: c } = checkRows(records, text);
      results.push({ shard, ok: !errors.length, ...c, ...(errors.length ? { errors: errors.slice(0, 20) } : {}) });
    }
    for (const result of results) out(`${JSON.stringify(result)}\n`);
    if (results.some((result) => !result.ok)) process.exitCode = 2;
    return results;
  }
  throw new SelectionError(usage);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error?.message ?? String(error));
    process.exitCode = error instanceof SelectionError ? 2 : 1;
  });
}
