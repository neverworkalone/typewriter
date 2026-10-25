import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadCanonicalLemmaForms, normalizeCandidate, validateCandidateBatch } from './candidate-contract.mjs';

export const CANDIDATE_WORKBENCH_CONTRACT = 'candidate-workbench-v2';
const LEGACY_CONTRACT = 'candidate-workbench-v1';
export const DEFAULT_CANDIDATE_CHUNK_SIZE = 25;
export const MIN_CANDIDATE_CHUNK_SIZE = 25;
export const MAX_CANDIDATE_CHUNK_SIZE = 50;
export const MAX_CANDIDATE_WORKBENCH_STDOUT_BYTES = 64 * 1024;
export const MAX_CANDIDATE_WORKBENCH_STDOUT_CHARS = 32 * 1024;
export const MAX_CANDIDATE_WORKBENCH_PAGE_SIZE = 25;
export const DEFAULT_CANDIDATE_WORKBENCH_PAGE_SIZE = MAX_CANDIDATE_WORKBENCH_PAGE_SIZE;
const BATCH_SIZE = 500;
// A single read item (one record) larger than this is split by sense so it still fits one stdout page.
const MAX_ITEM_CHARS = 12000;
const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseJsonl(contents, filePath) {
  if (typeof contents !== 'string') fail(`${filePath} must contain text`);
  const lines = contents.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  if (lines.some((line) => line.length === 0)) fail(`${filePath} contains a blank JSONL line`);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${filePath}:${index + 1} is not valid JSON: ${error.message}`);
    }
  });
}

function serializeJsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
}

export function serializeWorkbenchOutput(
  value,
  maxBytes = MAX_CANDIDATE_WORKBENCH_STDOUT_BYTES,
  maxChars = MAX_CANDIDATE_WORKBENCH_STDOUT_CHARS,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CANDIDATE_WORKBENCH_STDOUT_BYTES) {
    fail(`stdout maxBytes must be an integer from 1 to ${MAX_CANDIDATE_WORKBENCH_STDOUT_BYTES}`);
  }
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > MAX_CANDIDATE_WORKBENCH_STDOUT_CHARS) {
    fail(`stdout maxChars must be an integer from 1 to ${MAX_CANDIDATE_WORKBENCH_STDOUT_CHARS}`);
  }
  let serialized;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (error) {
    fail(`cannot serialize workbench stdout safely: ${error.message}`);
  }
  const output = `${serialized}\n`;
  const byteCount = Buffer.byteLength(output, 'utf8');
  const characterCount = Array.from(output).length;
  if (byteCount > maxBytes || characterCount > maxChars) {
    fail(`workbench stdout safety cap exceeded (${byteCount}/${maxBytes} bytes, ${characterCount}/${maxChars} characters); use a paginated read command and continue with its returned offset`);
  }
  return output;
}

function normalizePageOptions(offset, limit, maxBytes, maxChars) {
  const pageOffset = Number(offset ?? 0);
  const pageLimit = Number(limit ?? DEFAULT_CANDIDATE_WORKBENCH_PAGE_SIZE);
  const outputLimit = Number(maxBytes ?? MAX_CANDIDATE_WORKBENCH_STDOUT_BYTES);
  const characterLimit = Number(maxChars ?? MAX_CANDIDATE_WORKBENCH_STDOUT_CHARS);
  if (!Number.isSafeInteger(pageOffset) || pageOffset < 0) fail('offset must be a non-negative integer');
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > MAX_CANDIDATE_WORKBENCH_PAGE_SIZE) {
    fail(`limit must be an integer from 1 to ${MAX_CANDIDATE_WORKBENCH_PAGE_SIZE}`);
  }
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 256 || outputLimit > MAX_CANDIDATE_WORKBENCH_STDOUT_BYTES) {
    fail(`maxBytes must be an integer from 256 to ${MAX_CANDIDATE_WORKBENCH_STDOUT_BYTES}`);
  }
  if (!Number.isSafeInteger(characterLimit) || characterLimit < 256 || characterLimit > MAX_CANDIDATE_WORKBENCH_STDOUT_CHARS) {
    fail(`maxChars must be an integer from 256 to ${MAX_CANDIDATE_WORKBENCH_STDOUT_CHARS}`);
  }
  return { offset: pageOffset, limit: pageLimit, maxBytes: outputLimit, maxChars: characterLimit };
}

/** Return a complete-item page with stable offset continuation and hard stdout byte/character caps. */
export function paginateCandidateWorkbenchItems(items, { offset, limit, maxBytes, maxChars, metadata = {} } = {}) {
  if (!Array.isArray(items)) fail('paginated workbench items must be an array');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('page metadata must be an object');
  const page = normalizePageOptions(offset, limit, maxBytes, maxChars);
  if (page.offset > items.length) fail(`offset ${page.offset} is beyond total ${items.length}`);
  const build = (pageItems) => {
    const nextOffset = page.offset + pageItems.length;
    return {
      ...metadata,
      total: items.length,
      offset: page.offset,
      limit: page.limit,
      returned: pageItems.length,
      has_more: nextOffset < items.length,
      next_offset: nextOffset < items.length ? nextOffset : null,
      items: pageItems,
    };
  };
  const fits = (candidatePage) => {
    const output = `${JSON.stringify(candidatePage, null, 2)}\n`;
    return Buffer.byteLength(output, 'utf8') <= page.maxBytes && Array.from(output).length <= page.maxChars;
  };
  if (!fits(build([]))) fail('workbench page metadata exceeds the output limit; increase --max-bytes or --max-chars');
  const pageItems = [];
  const requestedEnd = Math.min(page.offset + page.limit, items.length);
  for (let index = page.offset; index < requestedEnd; index += 1) {
    if (!fits(build([...pageItems, items[index]]))) {
      if (pageItems.length === 0) fail(`workbench page item ${index} exceeds the configured output limits; no partial item was returned`);
      break;
    }
    pageItems.push(items[index]);
  }
  return build(pageItems);
}

function emitJson(value) {
  writeWorkbenchStdout(value);
}

/** Create a per-process stdout writer that bounds both one call and the full command. */
export function createCandidateWorkbenchStdoutWriter({
  maxBytes = MAX_CANDIDATE_WORKBENCH_STDOUT_BYTES,
  maxChars = MAX_CANDIDATE_WORKBENCH_STDOUT_CHARS,
  write,
} = {}) {
  const writeChunk = write ?? ((output) => process.stdout.write(output));
  let writtenBytes = 0;
  let writtenChars = 0;
  return (value) => {
    const output = serializeWorkbenchOutput(value, maxBytes, maxChars);
    const nextBytes = writtenBytes + Buffer.byteLength(output, 'utf8');
    const nextChars = writtenChars + Array.from(output).length;
    if (nextBytes > maxBytes || nextChars > maxChars) {
      fail(`workbench stdout safety cap exceeded (${nextBytes}/${maxBytes} bytes, ${nextChars}/${maxChars} characters); no additional output was written`);
    }
    writeChunk(output);
    writtenBytes = nextBytes;
    writtenChars = nextChars;
    return { writtenBytes, writtenChars };
  };
}

const writeWorkbenchStdout = createCandidateWorkbenchStdoutWriter();

function hasExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function normalizeShard(value) {
  if (!/^\d{1,3}$/u.test(String(value ?? ''))) fail('shard must be an integer from 001 to 428');
  const shard = String(Number(value)).padStart(3, '0');
  if (Number(shard) < 1 || Number(shard) > 428) fail('shard must be an integer from 001 to 428');
  return shard;
}

function normalizeBatch(value) {
  if (!['01', '1', '02', '2'].includes(String(value ?? ''))) fail('batch must be 01 or 02');
  return String(value).padStart(2, '0');
}

function normalizeMethod(value) {
  const method = String(value ?? '');
  if (!['a', 'b'].includes(method)) fail('Candidate workbench supports method a or b only');
  return method;
}

function normalizeModel(value) {
  if (!/^[a-z0-9_-]+$/u.test(String(value ?? ''))) fail('model must be a lowercase filename identifier');
  return String(value);
}

function assertScratchPath(repositoryDirectory, requestedPath, label = 'path') {
  if (!requestedPath) fail(`${label} is required`);
  const resolved = path.resolve(repositoryDirectory, requestedPath);
  const relative = path.relative(repositoryDirectory, resolved);
  const firstSegment = relative.split(path.sep)[0];
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..'
    || path.isAbsolute(relative) || firstSegment !== '.warroom-scratch') {
    fail(`${label} must be inside ${path.join(repositoryDirectory, '.warroom-scratch')}`);
  }
  return resolved;
}

async function writeFileAtomic(filePath, contents, { replace = true } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { flag: 'wx' });
  try {
    if (!replace) {
      try {
        const current = await readFile(filePath, 'utf8');
        if (current === contents) return { changed: false };
        fail(`${filePath} already exists with different contents; choose a new path or pass --replace`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await rename(temporaryPath, filePath);
    return { changed: true };
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readCanonicalShard(shard, repositoryDirectory) {
  const canonicalPath = path.resolve(repositoryDirectory, 'data/canonical', `stdict-${shard.padStart(4, '0')}.jsonl`);
  let contents;
  try {
    contents = await readFile(canonicalPath, 'utf8');
  } catch (error) {
    fail(`cannot read Canonical shard ${canonicalPath}: ${error.message}`);
  }
  const rows = parseJsonl(contents, canonicalPath);
  if (rows.length === 0) fail(`${canonicalPath} contains no Canonical records`);
  return { canonicalPath, rows };
}

function selectCanonicalBatch(rows, batch, canonicalPath) {
  const offset = (Number(batch) - 1) * BATCH_SIZE;
  const selected = rows.slice(offset, offset + BATCH_SIZE);
  if (selected.length === 0) fail(`${canonicalPath} has no records for batch ${batch}`);
  const recordIds = new Set();
  for (const [index, row] of selected.entries()) {
    const location = `${canonicalPath} batch record ${index + 1}`;
    if (typeof row?.id !== 'string' || row.id.length === 0) fail(`${location} has no string record id`);
    if (recordIds.has(row.id)) fail(`${location} repeats record_id ${JSON.stringify(row.id)}`);
    recordIds.add(row.id);
    if (typeof row.lemma !== 'string' || row.lemma.length === 0) fail(`${location} has no string lemma`);
    if (!Array.isArray(row.senses) || row.senses.length === 0) fail(`${location} must contain its Canonical senses`);
    const senseIds = new Set();
    for (const sense of row.senses) {
      if (typeof sense?.id !== 'string' || sense.id.length === 0 || senseIds.has(sense.id)) {
        fail(`${location} has a missing or repeated sense id`);
      }
      senseIds.add(sense.id);
    }
  }
  return { rows: selected, firstRecordIndex: offset + 1 };
}

const chunkName = (number) => `chunk-${String(number).padStart(3, '0')}.jsonl`;

function makeChunks(records, chunkSize) {
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CANDIDATE_CHUNK_SIZE || chunkSize > MAX_CANDIDATE_CHUNK_SIZE) {
    fail(`chunk-size must be an integer from ${MIN_CANDIDATE_CHUNK_SIZE} to ${MAX_CANDIDATE_CHUNK_SIZE}`);
  }
  const chunks = [];
  for (let start = 0; start < records.length; start += chunkSize) {
    const chunkRows = records.slice(start, start + chunkSize);
    chunks.push({
      number: chunks.length + 1,
      file: chunkName(chunks.length + 1),
      start_index: start,
      record_ids: chunkRows.map((row) => row.id),
      sense_count: chunkRows.reduce((count, row) => count + row.senses.length, 0),
    });
  }
  return chunks;
}

function assertCheckpointShape(checkpoint) {
  if (checkpoint?.contract === LEGACY_CONTRACT) {
    fail('this scratch directory holds a v1 workbench checkpoint; run prepare again with the same arguments to migrate its saved candidates');
  }
  if (checkpoint?.contract !== CANDIDATE_WORKBENCH_CONTRACT
    || !hasExactKeys(checkpoint, ['contract', 'batch', 'source', 'chunks'])
    || !hasExactKeys(checkpoint.batch, ['shard', 'batch', 'method', 'model'])
    || !hasExactKeys(checkpoint.source, ['canonical_path', 'canonical_sha256', 'first_record_index', 'record_count', 'sense_count', 'chunk_size'])
    || !Array.isArray(checkpoint.chunks)) {
    fail('unsupported or malformed Candidate workbench checkpoint');
  }
}

async function loadCheckpoint(scratchDirectory, repositoryDirectory) {
  const resolvedScratch = assertScratchPath(repositoryDirectory, scratchDirectory, 'scratch-dir');
  const checkpointPath = path.join(resolvedScratch, 'checkpoint.json');
  const contents = await readOptional(checkpointPath);
  if (contents === null) fail(`checkpoint not found at ${checkpointPath}; run prepare first`);
  let checkpoint;
  try {
    checkpoint = JSON.parse(contents);
  } catch (error) {
    fail(`cannot read checkpoint ${checkpointPath}: ${error.message}`);
  }
  assertCheckpointShape(checkpoint);
  return { scratchDirectory: resolvedScratch, checkpointPath, checkpoint };
}

function chunkOf(checkpoint, requestedChunk) {
  const number = Number(requestedChunk);
  const chunk = Number.isInteger(number) ? checkpoint.chunks.find((item) => item.number === number) : undefined;
  if (!chunk) fail(`chunk ${requestedChunk} is outside this batch; expected 1..${checkpoint.chunks.length}`);
  return chunk;
}

const sourcePathOf = (scratchDirectory, chunk) => path.join(scratchDirectory, 'source', chunk.file);
const candidatePathOf = (scratchDirectory, chunk) => path.join(scratchDirectory, 'candidates', chunk.file);

async function readSourceChunk(scratchDirectory, chunk) {
  const sourcePath = sourcePathOf(scratchDirectory, chunk);
  const contents = await readOptional(sourcePath);
  if (contents === null) fail(`source chunk ${sourcePath} is missing; run prepare again`);
  return parseJsonl(contents, sourcePath);
}

async function readSavedChunk(scratchDirectory, chunk) {
  const candidatePath = candidatePathOf(scratchDirectory, chunk);
  const contents = await readOptional(candidatePath);
  return contents === null ? null : parseJsonl(contents, candidatePath);
}

function chunkSummary(checkpoint, chunk, saved) {
  const firstRecord = checkpoint.source.first_record_index + chunk.start_index;
  return {
    number: chunk.number,
    file: chunk.file,
    firstRecord,
    lastRecord: firstRecord + chunk.record_ids.length - 1,
    firstRecordId: chunk.record_ids[0],
    lastRecordId: chunk.record_ids.at(-1),
    recordCount: chunk.record_ids.length,
    senseCount: chunk.sense_count,
    saved,
  };
}

/** Prepare a batch once; an existing v2 checkpoint is reused as-is, and a v1 checkpoint's saved candidates are carried over. */
export async function prepareCandidateBatch({
  shard: requestedShard,
  batch: requestedBatch,
  method: requestedMethod,
  model: requestedModel,
  scratchDirectory: requestedScratchDirectory,
  chunkSize: requestedChunkSize,
  repositoryDirectory = REPOSITORY_DIRECTORY,
} = {}) {
  const shard = normalizeShard(requestedShard);
  const batch = normalizeBatch(requestedBatch);
  const method = normalizeMethod(requestedMethod);
  const model = normalizeModel(requestedModel);
  const scratchDirectory = assertScratchPath(repositoryDirectory, requestedScratchDirectory, 'scratch-dir');
  const checkpointPath = path.join(scratchDirectory, 'checkpoint.json');

  let legacy = null;
  const existing = await readOptional(checkpointPath);
  if (existing !== null) {
    const parsed = JSON.parse(existing);
    if (parsed?.contract !== LEGACY_CONTRACT) {
      assertCheckpointShape(parsed);
      const same = parsed.batch.shard === shard && parsed.batch.batch === batch
        && parsed.batch.method === method && parsed.batch.model === model;
      if (!same) fail('checkpoint shard/batch/method/model does not match the requested Candidate queue');
      if (requestedChunkSize !== undefined && requestedChunkSize !== parsed.source.chunk_size) {
        fail(`checkpoint uses ${parsed.source.chunk_size}-record chunks; resume with that size or use a separate scratch directory`);
      }
      return describePrepared(scratchDirectory, parsed, checkpointPath, true);
    }
    if (parsed.batch?.shard !== shard || parsed.batch?.batch !== batch
      || parsed.batch?.method !== method || parsed.batch?.model !== model) {
      fail('checkpoint shard/batch/method/model does not match the requested Candidate queue');
    }
    legacy = parsed;
  }

  const { canonicalPath, rows: canonicalRows } = await readCanonicalShard(shard, repositoryDirectory);
  const { rows: sourceRows, firstRecordIndex } = selectCanonicalBatch(canonicalRows, batch, canonicalPath);
  const chunkSize = requestedChunkSize ?? legacy?.source.chunk_size ?? DEFAULT_CANDIDATE_CHUNK_SIZE;
  const chunks = makeChunks(sourceRows, chunkSize);
  const sourceHash = sha256(serializeJsonl(sourceRows));
  if (legacy && legacy.source?.canonical_sha256 !== sourceHash) {
    fail('Canonical batch changed since this v1 checkpoint was prepared; its candidates were preserved in place and not migrated. Re-explore against the current source in a new scratch directory.');
  }
  for (const chunk of chunks) {
    await writeFileAtomic(sourcePathOf(scratchDirectory, chunk), serializeJsonl(sourceRows.slice(chunk.start_index, chunk.start_index + chunk.record_ids.length)));
  }
  if (legacy) await migrateLegacyCandidates(scratchDirectory, legacy, sourceRows, chunks);

  const checkpoint = {
    contract: CANDIDATE_WORKBENCH_CONTRACT,
    batch: { shard, batch, method, model },
    source: {
      canonical_path: path.relative(repositoryDirectory, canonicalPath).split(path.sep).join('/'),
      canonical_sha256: sourceHash,
      first_record_index: firstRecordIndex,
      record_count: sourceRows.length,
      sense_count: sourceRows.reduce((count, record) => count + record.senses.length, 0),
      chunk_size: chunkSize,
    },
    chunks,
  };
  if (legacy) await rename(checkpointPath, path.join(scratchDirectory, 'checkpoint.v1.json'));
  await writeFileAtomic(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  return describePrepared(scratchDirectory, checkpoint, checkpointPath, false);
}

async function migrateLegacyCandidates(scratchDirectory, legacy, sourceRows, chunks) {
  const oldRecords = new Map(legacy.records.map((record) => [record.record_id, record]));
  const savedOld = new Set(legacy.chunks.filter((chunk) => chunk.candidate_sha256 !== null).map((chunk) => chunk.number));
  for (const chunk of chunks) {
    if (!savedOld.has(chunk.number)) continue;
    const rows = sourceRows.slice(chunk.start_index, chunk.start_index + chunk.record_ids.length).map((source) => {
      const old = new Map((oldRecords.get(source.id)?.senses ?? []).map((sense) => [sense.sense_id, sense.candidates]));
      return { record_id: source.id, senses: source.senses.map((sense) => ({ sense_id: sense.id, candidates: old.get(sense.id) ?? [] })) };
    });
    await writeFileAtomic(candidatePathOf(scratchDirectory, chunk), serializeJsonl(rows));
  }
}

async function describePrepared(scratchDirectory, checkpoint, checkpointPath, resumed) {
  const chunks = [];
  for (const chunk of checkpoint.chunks) {
    chunks.push(chunkSummary(checkpoint, chunk, (await readOptional(candidatePathOf(scratchDirectory, chunk))) !== null));
  }
  return {
    checkpointPath,
    resumed,
    recordCount: checkpoint.source.record_count,
    senseCount: checkpoint.source.sense_count,
    chunks,
  };
}

/** Light status: which chunks are saved. Nothing is re-read or re-validated. */
export async function readCandidateStatus({ scratchDirectory, repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const workspace = await loadCheckpoint(scratchDirectory, repositoryDirectory);
  const prepared = await describePrepared(workspace.scratchDirectory, workspace.checkpoint, workspace.checkpointPath, true);
  const unsaved = prepared.chunks.filter((chunk) => !chunk.saved).map((chunk) => chunk.number);
  return { ...workspace.checkpoint.batch, recordCount: prepared.recordCount, senseCount: prepared.senseCount, chunkCount: prepared.chunks.length, unsavedChunks: unsaved };
}

function splitSenses(record, senses, candidatesBySense) {
  const item = {
    record_id: record.id,
    canonical_record: {
      ...record,
      senses: candidatesBySense ? senses.map((sense) => ({ ...sense, candidates: candidatesBySense.get(sense.id) ?? [] })) : senses,
    },
  };
  if (senses.length === 1 || JSON.stringify(item).length <= MAX_ITEM_CHARS) return [item];
  const middle = Math.ceil(senses.length / 2);
  return [
    ...splitSenses(record, senses.slice(0, middle), candidatesBySense),
    ...splitSenses(record, senses.slice(middle), candidatesBySense),
  ];
}

/** Read one chunk: each Canonical record once with all its senses; saved candidates ride along under their sense. */
export async function readCandidateChunkPage({ scratchDirectory, chunk: requestedChunk, offset = 0, limit, maxBytes, maxChars, repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const workspace = await loadCheckpoint(scratchDirectory, repositoryDirectory);
  const chunk = chunkOf(workspace.checkpoint, requestedChunk);
  const sourceRows = await readSourceChunk(workspace.scratchDirectory, chunk);
  const saved = await readSavedChunk(workspace.scratchDirectory, chunk);
  const savedByRecord = new Map((saved ?? []).map((row) => [row.record_id, new Map(row.senses.map((sense) => [sense.sense_id, sense.candidates]))]));
  const firstRecord = workspace.checkpoint.source.first_record_index + chunk.start_index;
  const items = sourceRows.flatMap((record, index) => splitSenses(record, record.senses, saved ? savedByRecord.get(record.id) : null)
    .map((item) => ({ record_index: firstRecord + index, ...item })));
  return paginateCandidateWorkbenchItems(items, {
    offset,
    limit,
    maxBytes,
    maxChars,
    metadata: {
      shard: workspace.checkpoint.batch.shard,
      batch: workspace.checkpoint.batch.batch,
      chunk: chunk.number,
      saved: saved !== null,
      recordCount: sourceRows.length,
      senseCount: chunk.sense_count,
    },
  });
}

function assertCandidateList(candidates, location) {
  if (!Array.isArray(candidates)) fail(`${location} candidates must be an array`);
  const seen = new Set();
  for (const [index, candidate] of candidates.entries()) {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.trim() !== candidate) {
      fail(`${location} candidate ${index + 1} must be a non-empty trimmed string`);
    }
    const normalized = normalizeCandidate(candidate);
    if (seen.has(normalized)) fail(`${location} duplicates candidate ${JSON.stringify(candidate)}`);
    seen.add(normalized);
  }
}

/** Check a complete chunk's rows against its own source records: exact record/sense IDs and candidate format. */
function validateChunkRows(inputRows, sourceRows, chunkNumber) {
  const label = `chunk ${String(chunkNumber).padStart(3, '0')}`;
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  const seen = new Set();
  for (const [index, row] of inputRows.entries()) {
    const location = `${label} input line ${index + 1}`;
    if (!hasExactKeys(row, ['record_id', 'senses']) || typeof row.record_id !== 'string' || !Array.isArray(row.senses)) {
      fail(`${location} must contain only a string record_id and a senses array`);
    }
    const source = sourceById.get(row.record_id);
    if (!source) fail(`${location} record_id ${row.record_id} is outside ${label}`);
    if (seen.has(row.record_id)) fail(`${location} repeats record_id ${row.record_id}`);
    seen.add(row.record_id);
    const senseIds = new Set();
    for (const sense of row.senses) {
      if (!hasExactKeys(sense, ['sense_id', 'candidates']) || typeof sense.sense_id !== 'string') {
        fail(`${location} record_id ${row.record_id} senses must contain only sense_id and candidates`);
      }
      if (senseIds.has(sense.sense_id)) fail(`${location} repeats sense_id ${sense.sense_id}`);
      senseIds.add(sense.sense_id);
      assertCandidateList(sense.candidates, `${location} record_id ${row.record_id} sense_id ${sense.sense_id}`);
    }
    const expected = source.senses.map((sense) => sense.id);
    const missing = expected.filter((id) => !senseIds.has(id));
    const unexpected = [...senseIds].filter((id) => !expected.includes(id));
    if (missing.length || unexpected.length) {
      fail(`${location} sense_id mismatch for record_id ${row.record_id}; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`);
    }
  }
  const missingRecords = sourceRows.map((row) => row.id).filter((id) => !seen.has(id));
  if (missingRecords.length) fail(`${label} is missing record_id(s): ${missingRecords.join(', ')}`);
}

/** Write one complete chunk (replacing any earlier save of it), in Canonical order. */
export async function saveCandidateChunk({ scratchDirectory, chunk: requestedChunk, inputPath, repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const workspace = await loadCheckpoint(scratchDirectory, repositoryDirectory);
  const chunk = chunkOf(workspace.checkpoint, requestedChunk);
  const sourceRows = await readSourceChunk(workspace.scratchDirectory, chunk);
  const resolvedInput = assertScratchPath(repositoryDirectory, inputPath, 'input');
  const inputRows = parseJsonl(await readFile(resolvedInput, 'utf8'), resolvedInput);
  validateChunkRows(inputRows, sourceRows, chunk.number);
  const inputById = new Map(inputRows.map((row) => [row.record_id, row]));
  const rows = sourceRows.map((source) => {
    const input = inputById.get(source.id);
    const bySense = new Map(input.senses.map((sense) => [sense.sense_id, sense.candidates]));
    return { record_id: source.id, senses: source.senses.map((sense) => ({ sense_id: sense.id, candidates: bySense.get(sense.id) })) };
  });
  await writeFileAtomic(candidatePathOf(workspace.scratchDirectory, chunk), serializeJsonl(rows));
  return {
    chunk: chunk.number,
    recordCount: rows.length,
    senseCount: chunk.sense_count,
    candidateCount: rows.reduce((count, row) => count + row.senses.reduce((inner, sense) => inner + sense.candidates.length, 0), 0),
  };
}

/**
 * Local edit of already-saved chunks. Input rows: {record_id, sense_id, remove?: string[], add?: string[]}.
 * Removals must match an existing candidate exactly; everything is applied in memory and written once per touched chunk.
 */
export async function patchCandidateSenses({ scratchDirectory, inputPath, repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const workspace = await loadCheckpoint(scratchDirectory, repositoryDirectory);
  const resolvedInput = assertScratchPath(repositoryDirectory, inputPath, 'input');
  const patches = parseJsonl(await readFile(resolvedInput, 'utf8'), resolvedInput);
  const loaded = new Map();
  let removed = 0;
  let added = 0;
  for (const [index, patch] of patches.entries()) {
    const location = `${resolvedInput}:${index + 1}`;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
      || Object.keys(patch).some((key) => !['record_id', 'sense_id', 'remove', 'add'].includes(key))
      || typeof patch.record_id !== 'string' || typeof patch.sense_id !== 'string') {
      fail(`${location} must contain a string record_id and sense_id plus optional remove/add arrays`);
    }
    for (const field of ['remove', 'add']) {
      if (patch[field] !== undefined && (!Array.isArray(patch[field]) || patch[field].some((item) => typeof item !== 'string'))) {
        fail(`${location} ${field} must be an array of strings`);
      }
    }
    const chunk = workspace.checkpoint.chunks.find((item) => item.record_ids.includes(patch.record_id));
    if (!chunk) fail(`${location} record_id ${patch.record_id} is not in this batch`);
    if (!loaded.has(chunk.number)) {
      const rows = await readSavedChunk(workspace.scratchDirectory, chunk);
      if (rows === null) fail(`${location} chunk ${chunk.number} has not been saved; save-chunk it first`);
      loaded.set(chunk.number, { chunk, rows });
    }
    const sense = loaded.get(chunk.number).rows.find((row) => row.record_id === patch.record_id)
      ?.senses.find((item) => item.sense_id === patch.sense_id);
    if (!sense) fail(`${location} unknown record_id ${patch.record_id} / sense_id ${patch.sense_id}`);
    for (const candidate of patch.remove ?? []) {
      const at = sense.candidates.indexOf(candidate);
      if (at < 0) fail(`${location} candidate ${JSON.stringify(candidate)} is not present on ${patch.record_id}/${patch.sense_id}`);
      sense.candidates.splice(at, 1);
      removed += 1;
    }
    sense.candidates.push(...(patch.add ?? []));
    added += (patch.add ?? []).length;
    assertCandidateList(sense.candidates, `${location} ${patch.record_id}/${patch.sense_id}`);
  }
  for (const { chunk, rows } of loaded.values()) {
    await writeFileAtomic(candidatePathOf(workspace.scratchDirectory, chunk), serializeJsonl(rows));
  }
  return { patchCount: patches.length, removed, added, chunks: [...loaded.keys()] };
}

/** Assemble the saved chunks in Canonical order and run the full Candidate v1 batch validator once. */
export async function mergeCandidateBatch({ scratchDirectory, outPath, replace = false, repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const workspace = await loadCheckpoint(scratchDirectory, repositoryDirectory);
  const { checkpoint } = workspace;
  const candidateRows = [];
  const unsaved = [];
  for (const chunk of checkpoint.chunks) {
    const rows = await readSavedChunk(workspace.scratchDirectory, chunk);
    if (rows === null) unsaved.push(String(chunk.number).padStart(3, '0'));
    else candidateRows.push(...rows);
  }
  if (unsaved.length) fail(`cannot merge: candidate output is not saved for chunk(s) ${unsaved.join(', ')}; save each complete chunk, including senses with no candidates`);

  const { canonicalPath, rows: canonicalRows } = await readCanonicalShard(checkpoint.batch.shard, repositoryDirectory);
  const { rows: sourceRows } = selectCanonicalBatch(canonicalRows, checkpoint.batch.batch, canonicalPath);
  if (sha256(serializeJsonl(sourceRows)) !== checkpoint.source.canonical_sha256) {
    fail('Canonical batch changed since prepare; candidate data was preserved. Re-prepare in a new scratch directory and re-save the affected chunks.');
  }
  const canonicalLemmaForms = await loadCanonicalLemmaForms(repositoryDirectory);
  const validation = validateCandidateBatch(canonicalRows, candidateRows, {
    batch: checkpoint.batch.batch,
    canonicalLemmaForms,
    sourceName: canonicalPath,
    candidateName: 'Candidate workbench output',
  });
  const resolvedOutput = path.resolve(repositoryDirectory, outPath ?? '');
  const relativeOutput = path.relative(repositoryDirectory, resolvedOutput);
  const inScratch = relativeOutput.split(path.sep)[0] === '.warroom-scratch'
    && !relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== '..' && !path.isAbsolute(relativeOutput);
  const candidatePathMatch = /^data\/relation-candidates\/(\d{3})\/(\d{3})_(01|02)_([a-d])_([a-z0-9_-]+)\.jsonl$/u.exec(relativeOutput.split(path.sep).join('/'));
  if (!inScratch && !candidatePathMatch) fail('out must be inside .warroom-scratch or a correctly named data/relation-candidates/<SSS>/<SSS>_<BB>_<method>_<model>.jsonl path');
  const { shard, batch, method, model } = checkpoint.batch;
  if (candidatePathMatch && (candidatePathMatch[1] !== shard || candidatePathMatch[2] !== shard || candidatePathMatch[3] !== batch
    || candidatePathMatch[4] !== method || candidatePathMatch[5] !== model)) {
    fail(`out path ${relativeOutput} does not match checkpoint batch ${shard}_${batch}`);
  }
  const write = await writeFileAtomic(resolvedOutput, serializeJsonl(candidateRows), { replace });
  return { path: resolvedOutput, validation, changed: write.changed };
}

export async function inspectCanonicalRecord({ shard: requestedShard, recordId, repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const shard = normalizeShard(requestedShard);
  if (typeof recordId !== 'string' || recordId.length === 0) fail('record-id is required');
  const { canonicalPath, rows } = await readCanonicalShard(shard, repositoryDirectory);
  const matches = rows.filter((row) => row.id === recordId);
  if (matches.length === 0) fail(`record_id ${recordId} is not present in ${canonicalPath}`);
  if (matches.length > 1) fail(`record_id ${recordId} is ambiguous in ${canonicalPath}`);
  return { path: canonicalPath, record: matches[0] };
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) fail(`unexpected argument ${token}`);
    const name = token.slice(2);
    if (name === 'replace') {
      options[name] = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) fail(`${token} requires a value`);
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

function usage() {
  return [
    'usage:',
    '  node scripts/relation/candidate-workbench.mjs prepare --shard SSS --batch BB --method a|b --model <id> --scratch-dir .warroom-scratch/<batch> [--chunk-size 25..50]',
    '  node scripts/relation/candidate-workbench.mjs read-chunk --scratch-dir <dir> --chunk N [--offset N] [--limit 1..25] [--max-bytes N] [--max-chars N]',
    '  node scripts/relation/candidate-workbench.mjs save-chunk --scratch-dir <dir> --chunk N --input <candidate-chunk.jsonl>',
    '  node scripts/relation/candidate-workbench.mjs patch --scratch-dir <dir> --input <patches.jsonl>',
    '  node scripts/relation/candidate-workbench.mjs status --scratch-dir <dir>',
    '  node scripts/relation/candidate-workbench.mjs merge --scratch-dir <dir> --out <candidate.jsonl> [--replace]',
    '  node scripts/relation/candidate-workbench.mjs inspect --shard SSS --record-id <id>',
  ].join('\n');
}

function requireOption(options, name) {
  if (!options[name]) fail(`--${name} is required`);
  return options[name];
}

const numberOption = (options, name) => (options[name] === undefined ? undefined : Number(options[name]));

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const scratchDirectory = () => requireOption(options, 'scratch-dir');
  if (command === 'prepare') {
    emitJson(await prepareCandidateBatch({
      shard: requireOption(options, 'shard'),
      batch: requireOption(options, 'batch'),
      method: requireOption(options, 'method'),
      model: requireOption(options, 'model'),
      scratchDirectory: scratchDirectory(),
      chunkSize: numberOption(options, 'chunk-size'),
    }));
    return;
  }
  if (command === 'read-chunk') {
    emitJson(await readCandidateChunkPage({
      scratchDirectory: scratchDirectory(),
      chunk: Number(requireOption(options, 'chunk')),
      offset: numberOption(options, 'offset') ?? 0,
      limit: numberOption(options, 'limit'),
      maxBytes: numberOption(options, 'max-bytes'),
      maxChars: numberOption(options, 'max-chars'),
    }));
    return;
  }
  if (command === 'save-chunk') {
    emitJson(await saveCandidateChunk({ scratchDirectory: scratchDirectory(), chunk: Number(requireOption(options, 'chunk')), inputPath: requireOption(options, 'input') }));
    return;
  }
  if (command === 'patch') {
    emitJson(await patchCandidateSenses({ scratchDirectory: scratchDirectory(), inputPath: requireOption(options, 'input') }));
    return;
  }
  if (command === 'status') {
    emitJson(await readCandidateStatus({ scratchDirectory: scratchDirectory() }));
    return;
  }
  if (command === 'merge') {
    const result = await mergeCandidateBatch({ scratchDirectory: scratchDirectory(), outPath: requireOption(options, 'out'), replace: options.replace });
    emitJson({ path: result.path, changed: result.changed, validation: result.validation });
    return;
  }
  if (command === 'inspect') {
    emitJson((await inspectCanonicalRecord({ shard: requireOption(options, 'shard'), recordId: requireOption(options, 'record-id') })).record);
    return;
  }
  fail(`${usage()}\nunknown command: ${command ?? '(missing)'}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  console.log = (...args) => emitJson(args.length === 1 ? args[0] : args);
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
