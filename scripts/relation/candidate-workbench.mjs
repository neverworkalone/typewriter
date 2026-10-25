import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadCanonicalLemmaForms, normalizeCandidate, validateCandidateBatch } from './candidate-contract.mjs';

export const CANDIDATE_WORKBENCH_CONTRACT = 'candidate-workbench-v1';
export const DEFAULT_CANDIDATE_CHUNK_SIZE = 25;
export const MIN_CANDIDATE_CHUNK_SIZE = 25;
export const MAX_CANDIDATE_CHUNK_SIZE = 50;
export const MAX_CANDIDATE_WORKBENCH_STDOUT_BYTES = 64 * 1024;
export const MAX_CANDIDATE_WORKBENCH_STDOUT_CHARS = 32 * 1024;
export const DEFAULT_CANDIDATE_WORKBENCH_PAGE_SIZE = 10;
export const MAX_CANDIDATE_WORKBENCH_PAGE_SIZE = 25;
const BATCH_SIZE = 500;
const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  return JSON.stringify(value);
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
    fail(`workbench stdout safety cap exceeded (${byteCount}/${maxBytes} bytes, ${characterCount}/${maxChars} characters); use a paginated read command and continue with next_offset`);
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
  const emptyPage = {
    ...metadata,
    total: items.length,
    offset: page.offset,
    limit: page.limit,
    returned: 0,
    truncated: page.offset < items.length,
    has_more: page.offset < items.length,
    next_offset: page.offset < items.length ? page.offset : null,
    items: [],
  };
  const emptyPageOutput = `${JSON.stringify(emptyPage, null, 2)}\n`;
  if (Buffer.byteLength(emptyPageOutput, 'utf8') > page.maxBytes || Array.from(emptyPageOutput).length > page.maxChars) {
    fail('workbench page metadata exceeds the output limit; increase --max-bytes or --max-chars');
  }
  const pageItems = [];
  const requestedEnd = Math.min(page.offset + page.limit, items.length);
  for (let index = page.offset; index < requestedEnd; index += 1) {
    const candidateItems = [...pageItems, items[index]];
    const nextOffset = page.offset + candidateItems.length;
    const candidatePage = {
      ...metadata,
      total: items.length,
      offset: page.offset,
      limit: page.limit,
      returned: candidateItems.length,
      truncated: nextOffset < items.length,
      has_more: nextOffset < items.length,
      next_offset: nextOffset < items.length ? nextOffset : null,
      items: candidateItems,
    };
    const candidateOutput = `${JSON.stringify(candidatePage, null, 2)}\n`;
    if (Buffer.byteLength(candidateOutput, 'utf8') > page.maxBytes || Array.from(candidateOutput).length > page.maxChars) {
      if (pageItems.length === 0) {
        fail(`workbench page item ${index} exceeds the configured output limits; no partial item was returned`);
      }
      break;
    }
    pageItems.push(items[index]);
  }
  const nextOffset = page.offset + pageItems.length;
  return {
    ...metadata,
    total: items.length,
    offset: page.offset,
    limit: page.limit,
    returned: pageItems.length,
    truncated: nextOffset < items.length,
    has_more: nextOffset < items.length,
    next_offset: nextOffset < items.length ? nextOffset : null,
    items: pageItems,
  };
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
        if (current === contents) {
          await rm(temporaryPath, { force: true });
          return { changed: false };
        }
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

async function writeImmutable(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, contents, { flag: 'wx' });
    return { changed: true };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const current = await readFile(filePath, 'utf8');
    if (current !== contents) fail(`${filePath} exists with different contents; refusing to overwrite scratch data`);
    return { changed: false };
  }
}

function validateCanonicalRows(rows, canonicalPath) {
  if (!Array.isArray(rows) || rows.length === 0) fail(`${canonicalPath} contains no Canonical records`);
  const recordIds = new Set();
  for (const [rowIndex, row] of rows.entries()) {
    const location = `${canonicalPath}:${rowIndex + 1}`;
    if (typeof row?.id !== 'string' || row.id.length === 0) fail(`${location} has no string record id`);
    if (recordIds.has(row.id)) fail(`${location} repeats record_id ${JSON.stringify(row.id)}`);
    if (typeof row.lemma !== 'string' || row.lemma.length === 0) fail(`${location} has no string lemma`);
    if (!Array.isArray(row.senses) || row.senses.length === 0) fail(`${location} must contain its Canonical senses`);
    const senseIds = new Set();
    for (const [senseIndex, sense] of row.senses.entries()) {
      const senseLocation = `${location} sense ${senseIndex + 1}`;
      if (typeof sense?.id !== 'string' || sense.id.length === 0) fail(`${senseLocation} has no string sense id`);
      if (senseIds.has(sense.id)) fail(`${senseLocation} repeats sense_id ${JSON.stringify(sense.id)}`);
      if (typeof sense.gloss !== 'string') fail(`${senseLocation} ${sense.id} has no string source gloss`);
      senseIds.add(sense.id);
    }
    recordIds.add(row.id);
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
  validateCanonicalRows(rows, canonicalPath);
  return { canonicalPath, rows };
}

function selectCanonicalBatch(rows, batch, canonicalPath) {
  const offset = (Number(batch) - 1) * BATCH_SIZE;
  const selected = rows.slice(offset, offset + BATCH_SIZE);
  if (selected.length === 0) fail(`${canonicalPath} has no records for batch ${batch}`);
  return { rows: selected, firstRecordIndex: offset + 1 };
}

function makeChunks(records, chunkSize) {
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CANDIDATE_CHUNK_SIZE || chunkSize > MAX_CANDIDATE_CHUNK_SIZE) {
    fail(`chunk-size must be an integer from ${MIN_CANDIDATE_CHUNK_SIZE} to ${MAX_CANDIDATE_CHUNK_SIZE}`);
  }
  const chunks = [];
  for (let start = 0; start < records.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, records.length);
    const chunkRows = records.slice(start, end);
    chunks.push({
      number: chunks.length + 1,
      file: `chunk-${String(chunks.length + 1).padStart(3, '0')}.jsonl`,
      start_index: start,
      end_index: end,
      record_ids: chunkRows.map((row) => row.id),
      sense_count: chunkRows.reduce((count, row) => count + row.senses.length, 0),
      candidate_sha256: null,
    });
  }
  return chunks;
}

function candidateRowsForChunk(records, chunk) {
  const recordsById = new Map(records.map((record) => [record.record_id, record]));
  return chunk.record_ids.map((recordId) => {
    const record = recordsById.get(recordId);
    if (!record) fail(`chunk ${chunk.number} has no checkpoint record_id ${recordId}`);
    return {
      record_id: record.record_id,
      senses: record.senses.map((sense) => ({ sense_id: sense.sense_id, candidates: sense.candidates })),
    };
  });
}

function compareBatchIdentity(previous, currentRecords, shard, batch, method, model) {
  if (previous?.contract !== CANDIDATE_WORKBENCH_CONTRACT) fail('unsupported Candidate workbench checkpoint contract');
  if (previous.batch?.shard !== shard || previous.batch?.batch !== batch
    || previous.batch?.method !== method || previous.batch?.model !== model) {
    fail('checkpoint shard/batch/method/model does not match the requested Candidate queue');
  }
  const oldRecords = new Map(previous.records.map((record) => [record.record_id, record]));
  const currentIds = new Set(currentRecords.map((record) => record.id));
  const missingRecords = previous.records.map((record) => record.record_id).filter((id) => !currentIds.has(id));
  const newRecords = currentRecords.map((record) => record.id).filter((id) => !oldRecords.has(id));
  if (missingRecords.length || newRecords.length || previous.records.length !== currentRecords.length) {
    fail(`Canonical batch membership changed; missing record_id(s): ${missingRecords.join(', ') || 'none'}; new record_id(s): ${newRecords.join(', ') || 'none'}. Checkpoint and candidate data were preserved; reconcile this batch explicitly.`);
  }
  if (previous.records.some((record, index) => record.record_id !== currentRecords[index]?.id)) {
    fail('Canonical batch record order changed; checkpoint and candidate data were preserved for explicit reconciliation.');
  }
  for (const source of currentRecords) {
    const oldRecord = oldRecords.get(source.id);
    const oldSenseIds = new Set(oldRecord.senses.map((sense) => sense.sense_id));
    const currentSenseIds = new Set(source.senses.map((sense) => sense.id));
    const missing = oldRecord.senses.map((sense) => sense.sense_id).filter((id) => !currentSenseIds.has(id));
    const added = source.senses.map((sense) => sense.id).filter((id) => !oldSenseIds.has(id));
    if (missing.length || added.length || oldRecord.senses.length !== source.senses.length) {
      fail(`Canonical sense membership changed for record_id ${source.id}; missing sense_id(s): ${missing.join(', ') || 'none'}; new sense_id(s): ${added.join(', ') || 'none'}. Checkpoint and candidate data were preserved; reconcile this record explicitly.`);
    }
  }
}

function freshRecords(sourceRows, firstRecordIndex, method, previousRecords = []) {
  const previousByRecord = new Map(previousRecords.map((record) => [record.record_id, record]));
  return sourceRows.map((source, index) => {
    const previous = previousByRecord.get(source.id);
    const previousSenses = new Map((previous?.senses ?? []).map((sense) => [sense.sense_id, sense]));
    return {
      record_id: source.id,
      source_index: firstRecordIndex + index,
      lemma: source.lemma,
      senses: source.senses.map((sourceSense) => {
        const prior = previousSenses.get(sourceSense.id);
        const candidates = prior?.candidates ?? [];
        const candidateSet = new Set(candidates.map(normalizeCandidate));
        const state = {
          sense_id: sourceSense.id,
          candidates,
          reviewed: (prior?.reviewed ?? []).filter((review) => candidateSet.has(normalizeCandidate(review.candidate))),
        };
        if (method === 'b') {
          state.explored_fingerprint = prior?.explored_fingerprint ?? null;
        } else {
          state.explored_passes = {
            primary_fingerprint: prior?.explored_passes?.primary_fingerprint ?? null,
            secondary_fingerprint: prior?.explored_passes?.secondary_fingerprint ?? null,
          };
        }
        return state;
      }),
    };
  });
}

function canonicalSenseFingerprint(record, sense) {
  return sha256(stableJson({
    record_id: record.id,
    lemma: record.lemma,
    sense,
  }));
}

function candidateContextFingerprint(record, sense, candidate) {
  return sha256(stableJson({ record_id: record.id, lemma: record.lemma, sense, candidate }));
}

function assertCheckpointShape(checkpoint) {
  if (checkpoint?.contract !== CANDIDATE_WORKBENCH_CONTRACT
    || !hasExactKeys(checkpoint, ['contract', 'batch', 'source', 'chunks', 'records'])
    || !hasExactKeys(checkpoint.batch, ['shard', 'batch', 'method', 'model'])
    || !hasExactKeys(checkpoint.source, ['canonical_path', 'canonical_sha256', 'first_record_index', 'record_count', 'sense_count', 'chunk_size', 'chunk_directory'])
    || !Array.isArray(checkpoint.records) || !Array.isArray(checkpoint.chunks)) {
    fail('unsupported or malformed Candidate workbench checkpoint');
  }
  if (!/^\d{3}$/u.test(checkpoint.batch.shard ?? '') || !['01', '02'].includes(checkpoint.batch.batch)
    || !['a', 'b'].includes(checkpoint.batch.method) || !/^[a-z0-9_-]+$/u.test(checkpoint.batch.model ?? '')) {
    fail('checkpoint batch metadata is malformed');
  }
  if (typeof checkpoint.source.canonical_path !== 'string'
    || !/^[a-f0-9]{64}$/u.test(checkpoint.source.canonical_sha256 ?? '')
    || !Number.isInteger(checkpoint.source.first_record_index) || checkpoint.source.first_record_index < 1
    || !Number.isInteger(checkpoint.source.record_count) || checkpoint.source.record_count < 1 || checkpoint.source.record_count > BATCH_SIZE
    || !Number.isInteger(checkpoint.source.sense_count) || checkpoint.source.sense_count < 1
    || !Number.isInteger(checkpoint.source.chunk_size)
    || typeof checkpoint.source.chunk_directory !== 'string') {
    fail('checkpoint Canonical source metadata is malformed');
  }
  const recordIds = new Set();
  for (const [recordIndex, record] of checkpoint.records.entries()) {
    if (!hasExactKeys(record, ['record_id', 'source_index', 'lemma', 'senses'])
      || typeof record.record_id !== 'string' || !Number.isInteger(record.source_index)
      || typeof record.lemma !== 'string' || !Array.isArray(record.senses)) {
      fail(`checkpoint record ${recordIndex + 1} is malformed`);
    }
    if (recordIds.has(record.record_id)) fail(`checkpoint repeats record_id ${record.record_id}`);
    recordIds.add(record.record_id);
    const senseIds = new Set();
    for (const [senseIndex, sense] of record.senses.entries()) {
      const expectedSenseKeys = checkpoint.batch.method === 'b'
        ? ['sense_id', 'candidates', 'reviewed', 'explored_fingerprint']
        : ['sense_id', 'candidates', 'reviewed', 'explored_passes'];
      if (!hasExactKeys(sense, expectedSenseKeys)
        || typeof sense.sense_id !== 'string' || !Array.isArray(sense.candidates) || !Array.isArray(sense.reviewed)
        || (checkpoint.batch.method === 'b'
          ? (sense.explored_fingerprint !== null && !/^[a-f0-9]{64}$/u.test(sense.explored_fingerprint ?? ''))
          : (!hasExactKeys(sense.explored_passes, ['primary_fingerprint', 'secondary_fingerprint'])
            || ['primary_fingerprint', 'secondary_fingerprint'].some((pass) => (
              sense.explored_passes[pass] !== null && !/^[a-f0-9]{64}$/u.test(sense.explored_passes[pass] ?? '')
            ))))) {
        fail(`checkpoint record_id ${record.record_id} sense ${senseIndex + 1} is malformed`);
      }
      if (senseIds.has(sense.sense_id)) fail(`checkpoint record_id ${record.record_id} repeats sense_id ${sense.sense_id}`);
      senseIds.add(sense.sense_id);
      const candidates = new Set();
      for (const candidate of sense.candidates) {
        if (typeof candidate !== 'string' || candidate.length === 0 || candidate.trim() !== candidate) {
          fail(`checkpoint record_id ${record.record_id} sense_id ${sense.sense_id} contains an invalid candidate`);
        }
        const normalized = normalizeCandidate(candidate);
        if (candidates.has(normalized)) fail(`checkpoint record_id ${record.record_id} sense_id ${sense.sense_id} repeats candidate ${JSON.stringify(candidate)}`);
        candidates.add(normalized);
      }
      const reviewedCandidates = new Set();
      for (const review of sense.reviewed) {
        if (!hasExactKeys(review, ['candidate', 'fingerprint']) || typeof review.candidate !== 'string'
          || !candidates.has(normalizeCandidate(review.candidate)) || !/^[a-f0-9]{64}$/u.test(review.fingerprint ?? '')) {
          fail(`checkpoint record_id ${record.record_id} sense_id ${sense.sense_id} contains malformed review state`);
        }
        if (reviewedCandidates.has(review.candidate)) fail(`checkpoint record_id ${record.record_id} sense_id ${sense.sense_id} repeats review state for ${JSON.stringify(review.candidate)}`);
        reviewedCandidates.add(review.candidate);
      }
    }
  }
  for (const [index, chunk] of checkpoint.chunks.entries()) {
    if (!hasExactKeys(chunk, ['number', 'file', 'start_index', 'end_index', 'record_ids', 'sense_count', 'candidate_sha256', 'sha256'])
      || chunk.number !== index + 1 || typeof chunk.file !== 'string'
      || !Number.isInteger(chunk.start_index) || !Number.isInteger(chunk.end_index)
      || !Array.isArray(chunk.record_ids) || !Number.isInteger(chunk.sense_count)
      || !/^[a-f0-9]{64}$/u.test(chunk.sha256 ?? '')
      || (chunk.candidate_sha256 !== null && !/^[a-f0-9]{64}$/u.test(chunk.candidate_sha256 ?? ''))) {
      fail(`checkpoint chunk ${index + 1} is malformed`);
    }
  }
}

function validateCheckpointForSource(checkpoint, sourceRows, firstRecordIndex) {
  const sourceSenseCount = sourceRows.reduce((count, record) => count + record.senses.length, 0);
  if (checkpoint.source.first_record_index !== firstRecordIndex
    || checkpoint.source.record_count !== sourceRows.length
    || checkpoint.source.sense_count !== sourceSenseCount
    || checkpoint.records.length !== sourceRows.length) {
    fail('checkpoint record/sense counts or batch boundary do not match the Canonical source');
  }
  const expectedChunks = makeChunks(sourceRows, checkpoint.source.chunk_size);
  if (checkpoint.chunks.length !== expectedChunks.length) fail('checkpoint chunk count does not match the Canonical batch');
  const recordsById = new Map(checkpoint.records.map((record) => [record.record_id, record]));
  for (const [index, source] of sourceRows.entries()) {
    const state = recordsById.get(source.id);
    if (!state) fail(`checkpoint is missing record_id ${source.id}`);
    if (state.source_index !== firstRecordIndex + index || state.lemma !== source.lemma) {
      fail(`checkpoint source mapping does not match record_id ${source.id}; expected source index ${firstRecordIndex + index} and lemma ${JSON.stringify(source.lemma)}`);
    }
    if (state.senses.length !== source.senses.length) fail(`checkpoint sense count mismatch for record_id ${source.id}; expected ${source.senses.length}, actual ${state.senses.length}`);
    for (const [senseIndex, sourceSense] of source.senses.entries()) {
      if (state.senses[senseIndex]?.sense_id !== sourceSense.id) {
        fail(`checkpoint sense mapping mismatch for record_id ${source.id}; expected sense_id ${sourceSense.id}, actual ${state.senses[senseIndex]?.sense_id ?? '(missing)'}`);
      }
    }
  }
  for (const [index, chunk] of checkpoint.chunks.entries()) {
    const expected = expectedChunks[index];
    if (chunk.number !== expected.number || chunk.file !== expected.file
      || chunk.start_index !== expected.start_index || chunk.end_index !== expected.end_index
      || stableJson(chunk.record_ids) !== stableJson(expected.record_ids)
      || chunk.sense_count !== expected.sense_count) {
      fail(`checkpoint chunk ${index + 1} does not match its Canonical record boundary`);
    }
    if (chunk.candidate_sha256 !== null
      && sha256(serializeJsonl(candidateRowsForChunk(checkpoint.records, chunk))) !== chunk.candidate_sha256) {
      fail(`checkpoint candidate state hash mismatch in chunk ${index + 1}`);
    }
  }
}

function buildStatus(checkpoint, canonicalRows) {
  const sourceById = new Map(canonicalRows.map((record) => [record.id, record]));
  let candidateCount = 0;
  let reviewedCount = 0;
  let pendingCount = 0;
  let staleCount = 0;
  let emptySenseCount = 0;
  let exploredSenseCount = 0;
  let incompleteSenseCount = 0;
  let staleSenseCount = 0;
  let primaryExploredSenseCount = 0;
  let secondaryExploredSenseCount = 0;
  let incompletePrimarySenseCount = 0;
  let stalePrimarySenseCount = 0;
  let incompleteSecondarySenseCount = 0;
  let staleSecondarySenseCount = 0;
  for (const recordState of checkpoint.records) {
    const source = sourceById.get(recordState.record_id);
    if (!source) fail(`checkpoint record_id ${recordState.record_id} is absent from current Canonical input`);
    const sourceSenses = new Map(source.senses.map((sense) => [sense.id, sense]));
    for (const senseState of recordState.senses) {
      const sourceSense = sourceSenses.get(senseState.sense_id);
      if (!sourceSense) fail(`checkpoint record_id ${source.id} has stale sense_id ${senseState.sense_id}`);
      const sourceFingerprint = canonicalSenseFingerprint(source, sourceSense);
      if (checkpoint.batch.method === 'b') {
        if (senseState.explored_fingerprint === sourceFingerprint) exploredSenseCount += 1;
        else if (senseState.explored_fingerprint !== null) staleSenseCount += 1;
        else incompleteSenseCount += 1;
      } else {
        const primary = senseState.explored_passes.primary_fingerprint;
        const secondary = senseState.explored_passes.secondary_fingerprint;
        const primaryCurrent = primary === sourceFingerprint;
        const secondaryCurrent = secondary === sourceFingerprint;
        if (primaryCurrent) primaryExploredSenseCount += 1;
        else {
          incompletePrimarySenseCount += 1;
          if (primary !== null) stalePrimarySenseCount += 1;
        }
        if (secondaryCurrent) secondaryExploredSenseCount += 1;
        else {
          incompleteSecondarySenseCount += 1;
          if (secondary !== null) staleSecondarySenseCount += 1;
        }
        if (!primaryCurrent || !secondaryCurrent) incompleteSenseCount += 1;
        if (primaryCurrent && secondaryCurrent) exploredSenseCount += 1;
        if ((primary !== null && !primaryCurrent) || (secondary !== null && !secondaryCurrent)) staleSenseCount += 1;
      }
      if (senseState.candidates.length === 0) emptySenseCount += 1;
      for (const candidate of senseState.candidates) {
        candidateCount += 1;
        const fingerprint = candidateContextFingerprint(source, sourceSense, candidate);
        const reviewsForCandidate = senseState.reviewed.filter((review) => review.candidate === candidate);
        if (reviewsForCandidate.some((review) => review.fingerprint === fingerprint)) reviewedCount += 1;
        else if (reviewsForCandidate.length > 0) staleCount += 1;
        else pendingCount += 1;
      }
    }
  }
  const recordCount = checkpoint.records.length;
  const senseCount = checkpoint.records.reduce((count, record) => count + record.senses.length, 0);
  const completedChunkCount = checkpoint.chunks.filter((chunk) => chunk.candidate_sha256 !== null).length;
  const status = {
    shard: checkpoint.batch.shard,
    batch: checkpoint.batch.batch,
    recordCount,
    senseCount,
    candidateCount,
    emptySenseCount,
    reviewedCount,
    pendingReviewCount: pendingCount,
    staleReviewCount: staleCount,
    chunkCount: checkpoint.chunks.length,
    exploredSenseCount,
    incompleteSenseCount,
    staleSenseCount,
    completedChunkCount,
    incompleteChunkCount: checkpoint.chunks.length - completedChunkCount,
  };
  if (checkpoint.batch.method === 'a') {
    status.primaryExploredSenseCount = primaryExploredSenseCount;
    status.secondaryExploredSenseCount = secondaryExploredSenseCount;
    status.incompletePrimarySenseCount = incompletePrimarySenseCount;
    status.stalePrimarySenseCount = stalePrimarySenseCount;
    status.incompleteSecondarySenseCount = incompleteSecondarySenseCount;
    status.staleSecondarySenseCount = staleSecondarySenseCount;
  }
  return status;
}

function chunkGenerationName(sourceHash, chunkSize) {
  return `${sourceHash.slice(0, 16)}-${String(chunkSize).padStart(2, '0')}`;
}

/** Prepare/reopen a bounded Canonical batch without dropping candidate or review state. */
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
  const { canonicalPath, rows: canonicalRows } = await readCanonicalShard(shard, repositoryDirectory);
  const { rows: sourceRows, firstRecordIndex } = selectCanonicalBatch(canonicalRows, batch, canonicalPath);
  const sourceHash = sha256(serializeJsonl(sourceRows));
  const checkpointPath = path.join(scratchDirectory, 'checkpoint.json');
  let previousCheckpoint;
  try {
    previousCheckpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
    assertCheckpointShape(previousCheckpoint);
    compareBatchIdentity(previousCheckpoint, sourceRows, shard, batch, method, model);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const chunkSize = requestedChunkSize ?? previousCheckpoint?.source.chunk_size ?? DEFAULT_CANDIDATE_CHUNK_SIZE;
  if (previousCheckpoint && chunkSize !== previousCheckpoint.source.chunk_size) {
    fail(`checkpoint uses ${previousCheckpoint.source.chunk_size}-record chunks; resume with that size or use a separate scratch directory. Candidate state was preserved.`);
  }
  const chunks = makeChunks(sourceRows, chunkSize);

  const mergedRecords = freshRecords(sourceRows, firstRecordIndex, method, previousCheckpoint?.records ?? []);
  if (previousCheckpoint) {
    const oldChunkDirectory = assertScratchPath(
      repositoryDirectory,
      path.resolve(scratchDirectory, previousCheckpoint.source.chunk_directory),
      'checkpoint chunk directory',
    );
    for (const oldChunk of previousCheckpoint.chunks) {
      if (oldChunk.candidate_sha256 !== null
        && sha256(serializeJsonl(candidateRowsForChunk(previousCheckpoint.records, oldChunk))) !== oldChunk.candidate_sha256) {
        fail(`checkpoint candidate state hash mismatch in chunk ${oldChunk.number}; existing candidate state was preserved`);
      }
      const oldPath = assertScratchPath(repositoryDirectory, path.join(oldChunkDirectory, oldChunk.file), 'checkpoint source chunk');
      let oldContents;
      try {
        oldContents = await readFile(oldPath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        continue;
      }
      if (sha256(oldContents) !== oldChunk.sha256) {
        fail(`${oldPath} was changed after preparation; it was preserved. Restore the Canonical source chunk before refreshing this checkpoint.`);
      }
    }
  }

  const generation = chunkGenerationName(sourceHash, chunkSize);
  const chunkDirectory = path.join(scratchDirectory, 'canonical', generation);
  await mkdir(chunkDirectory, { recursive: true });
  for (const chunk of chunks) {
    const canonicalChunk = sourceRows.slice(chunk.start_index, chunk.end_index);
    const chunkContents = serializeJsonl(canonicalChunk);
    chunk.sha256 = sha256(chunkContents);
    await writeImmutable(path.join(chunkDirectory, chunk.file), chunkContents);
    const previousChunk = previousCheckpoint?.chunks.find((item) => item.number === chunk.number);
    if (previousChunk?.candidate_sha256 !== null && previousChunk?.candidate_sha256 !== undefined
      && stableJson(previousChunk.record_ids) === stableJson(chunk.record_ids)) {
      chunk.candidate_sha256 = sha256(serializeJsonl(candidateRowsForChunk(mergedRecords, chunk)));
    }
  }

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
      chunk_directory: path.relative(scratchDirectory, chunkDirectory).split(path.sep).join('/'),
    },
    chunks,
    records: mergedRecords,
  };

  await writeFileAtomic(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  return {
    checkpointPath,
    chunkDirectory,
    status: buildStatus(checkpoint, sourceRows),
    chunks: chunks.map(({ number, file, start_index, end_index, record_ids, sense_count }) => ({
      number,
      file,
      firstRecord: firstRecordIndex + start_index,
      lastRecord: firstRecordIndex + end_index - 1,
      firstRecordId: record_ids[0],
      lastRecordId: record_ids.at(-1),
      recordCount: end_index - start_index,
      senseCount: sense_count,
    })),
    sourceChanged: Boolean(previousCheckpoint && previousCheckpoint.source.canonical_sha256 !== sourceHash),
  };
}

async function loadWorkspace(scratchDirectory, repositoryDirectory = REPOSITORY_DIRECTORY) {
  const resolvedScratch = assertScratchPath(repositoryDirectory, scratchDirectory, 'scratch-dir');
  const checkpointPath = path.join(resolvedScratch, 'checkpoint.json');
  let checkpoint;
  try {
    checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') fail(`checkpoint not found at ${checkpointPath}; run prepare first`);
    fail(`cannot read checkpoint ${checkpointPath}: ${error.message}`);
  }
  assertCheckpointShape(checkpoint);
  const { canonicalPath, rows: fullRows } = await readCanonicalShard(checkpoint.batch.shard, repositoryDirectory);
  const { rows: sourceRows, firstRecordIndex } = selectCanonicalBatch(fullRows, checkpoint.batch.batch, canonicalPath);
  const sourceHash = sha256(serializeJsonl(sourceRows));
  if (sourceHash !== checkpoint.source.canonical_sha256) {
    fail(`Canonical source changed since preparation; run prepare again to refresh source chunks and invalidate affected candidate reviews. No candidate state was changed.`);
  }
  compareBatchIdentity(checkpoint, sourceRows, checkpoint.batch.shard, checkpoint.batch.batch, checkpoint.batch.method, checkpoint.batch.model);
  if (checkpoint.source.canonical_path !== path.relative(repositoryDirectory, canonicalPath).split(path.sep).join('/')) {
    fail('checkpoint Canonical path does not match the selected shard');
  }
  validateCheckpointForSource(checkpoint, sourceRows, firstRecordIndex);
  return { scratchDirectory: resolvedScratch, checkpointPath, checkpoint, canonicalPath, canonicalRows: fullRows, sourceRows, firstRecordIndex };
}

function expectedChunkSource(workspace, chunkNumber, repositoryDirectory) {
  if (!Number.isInteger(chunkNumber) || chunkNumber < 1) fail('chunk must be a positive integer');
  const chunk = workspace.checkpoint.chunks.find((item) => item.number === chunkNumber);
  if (!chunk) fail(`chunk ${String(chunkNumber).padStart(3, '0')} is outside this batch; expected 1..${workspace.checkpoint.chunks.length}`);
  const chunkDirectory = assertScratchPath(
    repositoryDirectory,
    path.resolve(workspace.scratchDirectory, workspace.checkpoint.source.chunk_directory),
    'checkpoint chunk directory',
  );
  const chunkPath = path.join(chunkDirectory, chunk.file);
  const chunkRows = workspace.sourceRows.slice(chunk.start_index, chunk.end_index);
  return { chunk, chunkPath, chunkRows };
}

/** Read Canonical source material one exact sense at a time without losing source fields. */
export async function readCandidateChunkPage({ scratchDirectory, chunk: requestedChunk, offset = 0, limit, maxBytes, maxChars, repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const workspace = await loadWorkspace(scratchDirectory, repositoryDirectory);
  const chunkNumber = Number(requestedChunk);
  const { chunk, chunkPath, chunkRows } = expectedChunkSource(workspace, chunkNumber, repositoryDirectory);
  const recordedChunk = await readFile(chunkPath, 'utf8').catch((error) => fail(`cannot read source chunk ${chunkPath}: ${error.message}`));
  if (sha256(recordedChunk) !== chunk.sha256) fail(`source chunk ${chunkPath} changed after prepare; no source output was returned`);
  const items = chunkRows.flatMap((record, recordOffset) => record.senses.map((sense, senseOffset) => ({
    record_index: workspace.firstRecordIndex + chunk.start_index + recordOffset,
    record_id: record.id,
    sense_index: senseOffset + 1,
    sense_count: record.senses.length,
    sense_id: sense.id,
    canonical_record: { ...record, senses: [sense] },
  })));
  return paginateCandidateWorkbenchItems(items, {
    offset,
    limit,
    maxBytes,
    maxChars,
    metadata: {
      shard: workspace.checkpoint.batch.shard,
      batch: workspace.checkpoint.batch.batch,
      chunk: chunk.number,
      recordCount: chunkRows.length,
      senseCount: chunk.sense_count,
    },
  });
}

function candidateInputIndex(inputRows, chunkRows, chunkNumber) {
  const expectedRecords = new Map(chunkRows.map((row) => [row.id, row]));
  const inputRecords = new Map();
  for (const [inputIndex, row] of inputRows.entries()) {
    const location = `chunk ${String(chunkNumber).padStart(3, '0')} input line ${inputIndex + 1}`;
    if (!hasExactKeys(row, ['record_id', 'senses'])) fail(`${location} must contain only record_id and senses`);
    if (typeof row.record_id !== 'string') fail(`${location} has no string record_id`);
    if (inputRecords.has(row.record_id)) fail(`${location} repeats record_id ${row.record_id}`);
    const source = expectedRecords.get(row.record_id);
    if (!source) fail(`${location} record_id ${row.record_id} is outside chunk ${String(chunkNumber).padStart(3, '0')}`);
    if (!Array.isArray(row.senses)) fail(`${location} senses must be an array`);
    const inputSenses = new Map();
    for (const [senseIndex, sense] of row.senses.entries()) {
      const senseLocation = `${location} record_id ${row.record_id} sense ${senseIndex + 1}`;
      if (!hasExactKeys(sense, ['sense_id', 'candidates'])) fail(`${senseLocation} must contain only sense_id and candidates`);
      if (typeof sense.sense_id !== 'string') fail(`${senseLocation} has no string sense_id`);
      if (inputSenses.has(sense.sense_id)) fail(`${senseLocation} repeats sense_id ${sense.sense_id}`);
      if (!Array.isArray(sense.candidates)) fail(`${senseLocation} candidates must be an array`);
      const duplicateCandidates = new Set();
      for (const [candidateIndex, candidate] of sense.candidates.entries()) {
        const candidateLocation = `${senseLocation} candidate ${candidateIndex + 1}`;
        if (typeof candidate !== 'string' || candidate.length === 0 || candidate.trim() !== candidate) {
          fail(`${candidateLocation} must be a non-empty trimmed string`);
        }
        const normalized = normalizeCandidate(candidate);
        if (duplicateCandidates.has(normalized)) fail(`${candidateLocation} duplicates candidate ${JSON.stringify(candidate)} for record_id ${row.record_id} sense_id ${sense.sense_id}`);
        duplicateCandidates.add(normalized);
      }
      inputSenses.set(sense.sense_id, sense.candidates);
    }
    const expectedSenseIds = new Set(source.senses.map((sense) => sense.id));
    const missingSenses = source.senses.map((sense) => sense.id).filter((id) => !inputSenses.has(id));
    const unexpectedSenses = [...inputSenses.keys()].filter((id) => !expectedSenseIds.has(id));
    if (missingSenses.length || unexpectedSenses.length || inputSenses.size !== source.senses.length) {
      fail(`${location} sense_id mismatch for record_id ${row.record_id}; missing: ${missingSenses.join(', ') || 'none'}; unexpected: ${unexpectedSenses.join(', ') || 'none'}`);
    }
    inputRecords.set(row.record_id, inputSenses);
  }
  const missingRecords = chunkRows.map((row) => row.id).filter((id) => !inputRecords.has(id));
  const unexpectedRecords = [...inputRecords.keys()].filter((id) => !expectedRecords.has(id));
  if (missingRecords.length || unexpectedRecords.length || inputRecords.size !== chunkRows.length) {
    fail(`chunk ${String(chunkNumber).padStart(3, '0')} record_id mismatch; missing: ${missingRecords.join(', ') || 'none'}; unexpected: ${unexpectedRecords.join(', ') || 'none'}`);
  }
  return inputRecords;
}

/** Save one complete bounded chunk, addressing every record and sense by its explicit source IDs. */
export async function saveCandidateChunk({ scratchDirectory, chunk: requestedChunk, inputPath, repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const workspace = await loadWorkspace(scratchDirectory, repositoryDirectory);
  const chunkNumber = Number(requestedChunk);
  const { chunk, chunkPath, chunkRows } = expectedChunkSource(workspace, chunkNumber, repositoryDirectory);
  const recordedChunk = await readFile(chunkPath, 'utf8').catch((error) => fail(`cannot read source chunk ${chunkPath}: ${error.message}`));
  if (sha256(recordedChunk) !== chunk.sha256) fail(`source chunk ${chunkPath} changed after prepare; candidate state was not modified`);
  const resolvedInput = assertScratchPath(repositoryDirectory, inputPath, 'input');
  const inputRows = parseJsonl(await readFile(resolvedInput, 'utf8'), resolvedInput);
  const inputByRecord = candidateInputIndex(inputRows, chunkRows, chunkNumber);
  const stateByRecord = new Map(workspace.checkpoint.records.map((record) => [record.record_id, record]));

  for (const source of chunkRows) {
    const state = stateByRecord.get(source.id);
    const inputSenses = inputByRecord.get(source.id);
    for (const sourceSense of source.senses) {
      const senseState = state.senses.find((sense) => sense.sense_id === sourceSense.id);
      const incomingCandidates = inputSenses.get(sourceSense.id);
      const existingByNormalized = new Map(senseState.candidates.map((candidate) => [normalizeCandidate(candidate), candidate]));
      for (const candidate of incomingCandidates) {
        const normalized = normalizeCandidate(candidate);
        const existing = existingByNormalized.get(normalized);
        if (existing && existing !== candidate) {
          fail(`candidate ${JSON.stringify(candidate)} on record_id ${source.id} sense_id ${sourceSense.id} normalizes to existing candidate ${JSON.stringify(existing)}; resolve the duplicate explicitly`);
        }
        if (!existing) {
          senseState.candidates.push(candidate);
          existingByNormalized.set(normalized, candidate);
        }
      }
      const candidateSet = new Set(senseState.candidates);
      senseState.reviewed = senseState.reviewed.filter((review) => candidateSet.has(review.candidate));
    }
  }

  workspace.checkpoint.records = workspace.checkpoint.records.map((record) => stateByRecord.get(record.record_id));
  workspace.checkpoint.chunks[chunk.number - 1].candidate_sha256 = sha256(serializeJsonl(candidateRowsForChunk(workspace.checkpoint.records, chunk)));
  await writeFileAtomic(workspace.checkpointPath, `${JSON.stringify(workspace.checkpoint, null, 2)}\n`);
  return {
    chunk: chunk.number,
    firstRecord: workspace.checkpoint.source.first_record_index + chunk.start_index,
    lastRecord: workspace.checkpoint.source.first_record_index + chunk.end_index - 1,
    recordCount: chunk.end_index - chunk.start_index,
    senseCount: chunk.sense_count,
    status: buildStatus(workspace.checkpoint, workspace.sourceRows),
  };
}

/** Replace one sense's candidate list without rebuilding its chunk or disturbing peer senses. */
export async function updateCandidateSense({ scratchDirectory, recordId, senseId, candidates, repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const workspace = await loadWorkspace(scratchDirectory, repositoryDirectory);
  if (typeof recordId !== 'string' || typeof senseId !== 'string') fail('record_id and sense_id are required');
  if (!Array.isArray(candidates)) fail(`candidates must be an array for record_id ${recordId} sense_id ${senseId}`);
  const seen = new Set();
  for (const [index, candidate] of candidates.entries()) {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.trim() !== candidate) {
      fail(`record_id ${recordId} sense_id ${senseId} candidate ${index + 1} must be a non-empty trimmed string`);
    }
    const normalized = normalizeCandidate(candidate);
    if (seen.has(normalized)) fail(`record_id ${recordId} sense_id ${senseId} duplicates candidate ${JSON.stringify(candidate)}`);
    seen.add(normalized);
  }
  const stateRecord = workspace.checkpoint.records.find((record) => record.record_id === recordId);
  const stateSense = stateRecord?.senses.find((sense) => sense.sense_id === senseId);
  if (!stateSense) fail(`unknown record_id ${recordId} / sense_id ${senseId}; candidates were not changed`);
  const candidateSet = new Set(candidates);
  const omitted = stateSense.candidates.filter((candidate) => !candidateSet.has(candidate));
  if (omitted.length > 0) {
    fail(`patch-sense cannot remove existing candidate(s) ${omitted.map((candidate) => JSON.stringify(candidate)).join(', ')}; use remove-candidate after confirming each is ineligible`);
  }
  stateSense.candidates = [...candidates];
  stateSense.reviewed = stateSense.reviewed.filter((review) => candidateSet.has(review.candidate));
  const chunk = workspace.checkpoint.chunks.find((item) => item.record_ids.includes(recordId));
  if (chunk?.candidate_sha256 !== null && chunk?.candidate_sha256 !== undefined) {
    chunk.candidate_sha256 = sha256(serializeJsonl(candidateRowsForChunk(workspace.checkpoint.records, chunk)));
  }
  await writeFileAtomic(workspace.checkpointPath, `${JSON.stringify(workspace.checkpoint, null, 2)}\n`);
  return { record_id: recordId, sense_id: senseId, candidateCount: candidates.length, status: buildStatus(workspace.checkpoint, workspace.sourceRows) };
}

/** Mark one or more senses explored after both B scenes have actually been completed for their current source. */
export async function markCandidateSensesExplored({ scratchDirectory, inputPath, pass, repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const workspace = await loadWorkspace(scratchDirectory, repositoryDirectory);
  const method = workspace.checkpoint.batch.method;
  if (method === 'a' && !['primary', 'secondary'].includes(pass)) {
    fail('A exploration receipt requires pass=primary or pass=secondary');
  }
  if (method === 'b' && pass !== undefined) fail('B exploration uses its existing two-scene receipt; --pass is only for method a');
  const resolvedInput = assertScratchPath(repositoryDirectory, inputPath, 'input');
  const rows = parseJsonl(await readFile(resolvedInput, 'utf8'), resolvedInput);
  const seen = new Set();
  const stateByRecord = new Map(workspace.checkpoint.records.map((record) => [record.record_id, record]));
  const sourceByRecord = new Map(workspace.sourceRows.map((record) => [record.id, record]));
  let markedCount = 0;
  for (const [index, row] of rows.entries()) {
    const location = `${resolvedInput}:${index + 1}`;
    if (!hasExactKeys(row, ['record_id', 'sense_id']) || typeof row.record_id !== 'string' || typeof row.sense_id !== 'string') {
      fail(`${location} must contain only string record_id and sense_id`);
    }
    const key = `${row.record_id}\0${row.sense_id}`;
    if (seen.has(key)) fail(`${location} repeats record_id ${row.record_id} sense_id ${row.sense_id}`);
    seen.add(key);
    const stateRecord = stateByRecord.get(row.record_id);
    const stateSense = stateRecord?.senses.find((sense) => sense.sense_id === row.sense_id);
    const sourceRecord = sourceByRecord.get(row.record_id);
    const sourceSense = sourceRecord?.senses.find((sense) => sense.id === row.sense_id);
    if (!stateSense || !sourceSense) fail(`${location} references unknown record_id ${row.record_id} / sense_id ${row.sense_id}`);
    const fingerprint = canonicalSenseFingerprint(sourceRecord, sourceSense);
    if (method === 'b') {
      stateSense.explored_fingerprint = fingerprint;
    } else {
      if (pass === 'secondary' && stateSense.explored_passes.primary_fingerprint !== fingerprint) {
        fail(`${location} cannot mark the A secondary pass before the current source sense has a primary pass`);
      }
      stateSense.explored_passes[`${pass}_fingerprint`] = fingerprint;
    }
    markedCount += 1;
  }
  await writeFileAtomic(workspace.checkpointPath, `${JSON.stringify(workspace.checkpoint, null, 2)}\n`);
  return { markedCount, status: buildStatus(workspace.checkpoint, workspace.sourceRows) };
}

/** Remove one candidate only after its current source-sense meaning/form review confirms it is ineligible. */
export async function removeCandidate({ scratchDirectory, recordId, senseId, candidate, confirmedIneligible, repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const workspace = await loadWorkspace(scratchDirectory, repositoryDirectory);
  if (confirmedIneligible !== true) fail('remove-candidate requires confirmedIneligible=true after an explicit Stage 1 ineligible judgment');
  if (typeof recordId !== 'string' || typeof senseId !== 'string' || typeof candidate !== 'string' || candidate.length === 0) {
    fail('record_id, sense_id, and exact candidate are required');
  }
  const stateRecord = workspace.checkpoint.records.find((record) => record.record_id === recordId);
  const stateSense = stateRecord?.senses.find((sense) => sense.sense_id === senseId);
  const sourceRecord = workspace.sourceRows.find((record) => record.id === recordId);
  const sourceSense = sourceRecord?.senses.find((sense) => sense.id === senseId);
  if (!stateSense || !sourceSense) fail(`unknown record_id ${recordId} / sense_id ${senseId}; candidates were not changed`);
  const candidateIndex = stateSense.candidates.indexOf(candidate);
  if (candidateIndex < 0) fail(`candidate ${JSON.stringify(candidate)} is not active for record_id ${recordId} sense_id ${senseId}`);
  const expectedFingerprint = candidateContextFingerprint(sourceRecord, sourceSense, candidate);
  const review = stateSense.reviewed.find((item) => item.candidate === candidate && item.fingerprint === expectedFingerprint);
  if (!review) fail(`candidate ${JSON.stringify(candidate)} needs a current AI meaning/form review before removal`);
  stateSense.candidates.splice(candidateIndex, 1);
  stateSense.reviewed = stateSense.reviewed.filter((item) => item.candidate !== candidate);
  const chunk = workspace.checkpoint.chunks.find((item) => item.record_ids.includes(recordId));
  if (chunk?.candidate_sha256 !== null && chunk?.candidate_sha256 !== undefined) {
    chunk.candidate_sha256 = sha256(serializeJsonl(candidateRowsForChunk(workspace.checkpoint.records, chunk)));
  }
  await writeFileAtomic(workspace.checkpointPath, `${JSON.stringify(workspace.checkpoint, null, 2)}\n`);
  return { record_id: recordId, sense_id: senseId, removed: candidate, status: buildStatus(workspace.checkpoint, workspace.sourceRows) };
}

function pendingReviewRows(workspace) {
  const sourceById = new Map(workspace.sourceRows.map((record) => [record.id, record]));
  const result = [];
  for (const stateRecord of workspace.checkpoint.records) {
    const sourceRecord = sourceById.get(stateRecord.record_id);
    const pendingSenses = [];
    for (const stateSense of stateRecord.senses) {
      const sourceSense = sourceRecord.senses.find((sense) => sense.id === stateSense.sense_id);
      const fingerprint = (candidate) => candidateContextFingerprint(sourceRecord, sourceSense, candidate);
      const pending = stateSense.candidates.filter((candidate) => !stateSense.reviewed.some((review) => review.candidate === candidate && review.fingerprint === fingerprint(candidate)));
      if (pending.length > 0) pendingSenses.push({ sense_id: stateSense.sense_id, candidates: pending });
    }
    if (pendingSenses.length > 0) {
      result.push({
        canonical_record: { ...sourceRecord, senses: sourceRecord.senses.filter((sense) => pendingSenses.some((pending) => pending.sense_id === sense.id)) },
        review: pendingSenses,
      });
    }
  }
  return result;
}

/** Page through unchecked candidates as separate sense-bound items; never dump a whole review ledger. */
export async function readPendingCandidateReviewPage({ scratchDirectory, offset = 0, limit, maxBytes, maxChars, repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const workspace = await loadWorkspace(scratchDirectory, repositoryDirectory);
  const sourceById = new Map(workspace.sourceRows.map((record) => [record.id, record]));
  const items = [];
  for (const stateRecord of workspace.checkpoint.records) {
    const sourceRecord = sourceById.get(stateRecord.record_id);
    for (const stateSense of stateRecord.senses) {
      const sourceSense = sourceRecord.senses.find((sense) => sense.id === stateSense.sense_id);
      const pending = stateSense.candidates.filter((candidate) => {
        const fingerprint = candidateContextFingerprint(sourceRecord, sourceSense, candidate);
        return !stateSense.reviewed.some((review) => review.candidate === candidate && review.fingerprint === fingerprint);
      });
      for (const [candidateIndex, candidate] of pending.entries()) {
        items.push({
          record_id: sourceRecord.id,
          lemma: sourceRecord.lemma,
          sense_id: sourceSense.id,
          candidate,
          pending_index: candidateIndex + 1,
          pending_count_for_sense: pending.length,
          canonical_record: { ...sourceRecord, senses: [sourceSense] },
        });
      }
    }
  }
  return paginateCandidateWorkbenchItems(items, {
    offset,
    limit,
    maxBytes,
    maxChars,
    metadata: {
      shard: workspace.checkpoint.batch.shard,
      batch: workspace.checkpoint.batch.batch,
      method: workspace.checkpoint.batch.method,
      model: workspace.checkpoint.batch.model,
    },
  });
}

/** Export only unchecked/invalidated candidates, with their complete source sense rows. */
export async function exportPendingCandidateReviews({ scratchDirectory, outPath, replace = false, repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const workspace = await loadWorkspace(scratchDirectory, repositoryDirectory);
  const resolvedOutput = assertScratchPath(repositoryDirectory, outPath, 'out');
  const pending = pendingReviewRows(workspace);
  const status = buildStatus(workspace.checkpoint, workspace.sourceRows);
  const contents = serializeJsonl(pending);
  const write = await writeFileAtomic(resolvedOutput, contents, { replace });
  return { path: resolvedOutput, rows: pending.length, candidateCount: status.pendingReviewCount + status.staleReviewCount, changed: write.changed };
}

/** Export only source senses that still need their required method-specific exploration. */
export async function exportPendingCandidateExploration({ scratchDirectory, outPath, replace = false, repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const workspace = await loadWorkspace(scratchDirectory, repositoryDirectory);
  const resolvedOutput = assertScratchPath(repositoryDirectory, outPath, 'out');
  const stateById = new Map(workspace.checkpoint.records.map((record) => [record.record_id, record]));
  const pending = [];
  for (const sourceRecord of workspace.sourceRows) {
    const stateRecord = stateById.get(sourceRecord.id);
    const senses = [];
    for (const sourceSense of sourceRecord.senses) {
      const stateSense = stateRecord.senses.find((sense) => sense.sense_id === sourceSense.id);
      const fingerprint = canonicalSenseFingerprint(sourceRecord, sourceSense);
      if (workspace.checkpoint.batch.method === 'b') {
        if (stateSense.explored_fingerprint === fingerprint) continue;
        senses.push({
          sense_id: sourceSense.id,
          current_candidates: stateSense.candidates,
          status: stateSense.explored_fingerprint === null ? 'PENDING' : 'STALE',
        });
      } else {
        const primary = stateSense.explored_passes.primary_fingerprint;
        const secondary = stateSense.explored_passes.secondary_fingerprint;
        if (primary !== fingerprint) {
          senses.push({ sense_id: sourceSense.id, pass: 'primary', status: primary === null ? 'PENDING' : 'STALE' });
        } else if (secondary !== fingerprint) {
          senses.push({ sense_id: sourceSense.id, pass: 'secondary', status: secondary === null ? 'PENDING' : 'STALE' });
        }
      }
    }
    if (senses.length > 0) {
      pending.push({
        canonical_record: { ...sourceRecord, senses: sourceRecord.senses.filter((sense) => senses.some((item) => item.sense_id === sense.id)) },
        senses,
      });
    }
  }
  const contents = serializeJsonl(pending);
  const write = await writeFileAtomic(resolvedOutput, contents, { replace });
  return { path: resolvedOutput, recordCount: pending.length, senseCount: pending.reduce((count, row) => count + row.senses.length, 0), changed: write.changed };
}

/** Page through exact source senses that still need an exploration pass. */
export async function readPendingCandidateExplorationPage({ scratchDirectory, offset = 0, limit, maxBytes, maxChars, repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const workspace = await loadWorkspace(scratchDirectory, repositoryDirectory);
  const stateById = new Map(workspace.checkpoint.records.map((record) => [record.record_id, record]));
  const items = [];
  for (const sourceRecord of workspace.sourceRows) {
    const stateRecord = stateById.get(sourceRecord.id);
    for (const sourceSense of sourceRecord.senses) {
      const stateSense = stateRecord.senses.find((sense) => sense.sense_id === sourceSense.id);
      const fingerprint = canonicalSenseFingerprint(sourceRecord, sourceSense);
      let pass;
      let status;
      if (workspace.checkpoint.batch.method === 'b') {
        if (stateSense.explored_fingerprint === fingerprint) continue;
        pass = 'both-scenes';
        status = stateSense.explored_fingerprint === null ? 'PENDING' : 'STALE';
      } else if (stateSense.explored_passes.primary_fingerprint !== fingerprint) {
        pass = 'primary';
        status = stateSense.explored_passes.primary_fingerprint === null ? 'PENDING' : 'STALE';
      } else if (stateSense.explored_passes.secondary_fingerprint !== fingerprint) {
        pass = 'secondary';
        status = stateSense.explored_passes.secondary_fingerprint === null ? 'PENDING' : 'STALE';
      } else {
        continue;
      }
      items.push({
        record_id: sourceRecord.id,
        lemma: sourceRecord.lemma,
        sense_id: sourceSense.id,
        pass,
        status,
        current_candidate_count: stateSense.candidates.length,
        canonical_record: { ...sourceRecord, senses: [sourceSense] },
      });
    }
  }
  return paginateCandidateWorkbenchItems(items, {
    offset,
    limit,
    maxBytes,
    maxChars,
    metadata: {
      shard: workspace.checkpoint.batch.shard,
      batch: workspace.checkpoint.batch.batch,
      method: workspace.checkpoint.batch.method,
      model: workspace.checkpoint.batch.model,
    },
  });
}

/** Record an explicit editorial pass for a subset of currently active candidates. */
export async function markCandidateReviews({ scratchDirectory, inputPath, repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const workspace = await loadWorkspace(scratchDirectory, repositoryDirectory);
  const resolvedInput = assertScratchPath(repositoryDirectory, inputPath, 'input');
  const reviewRows = parseJsonl(await readFile(resolvedInput, 'utf8'), resolvedInput);
  const seen = new Set();
  const stateByRecord = new Map(workspace.checkpoint.records.map((record) => [record.record_id, record]));
  const sourceByRecord = new Map(workspace.sourceRows.map((record) => [record.id, record]));
  let markedCount = 0;
  for (const [index, row] of reviewRows.entries()) {
    const location = `${resolvedInput}:${index + 1}`;
    if (!hasExactKeys(row, ['record_id', 'sense_id', 'reviewed_candidates'])) fail(`${location} must contain only record_id, sense_id, and reviewed_candidates`);
    if (typeof row.record_id !== 'string' || typeof row.sense_id !== 'string' || !Array.isArray(row.reviewed_candidates)) fail(`${location} has invalid record_id, sense_id, or reviewed_candidates`);
    const key = `${row.record_id}\0${row.sense_id}`;
    if (seen.has(key)) fail(`${location} repeats record_id ${row.record_id} sense_id ${row.sense_id}`);
    seen.add(key);
    const stateRecord = stateByRecord.get(row.record_id);
    const sourceRecord = sourceByRecord.get(row.record_id);
    const stateSense = stateRecord?.senses.find((sense) => sense.sense_id === row.sense_id);
    const sourceSense = sourceRecord?.senses.find((sense) => sense.id === row.sense_id);
    if (!stateSense || !sourceSense) fail(`${location} references unknown record_id ${row.record_id} / sense_id ${row.sense_id}`);
    const candidates = new Set(stateSense.candidates);
    const reviewedHere = new Set();
    for (const [candidateIndex, candidate] of row.reviewed_candidates.entries()) {
      if (typeof candidate !== 'string' || candidate.trim() !== candidate || candidate.length === 0) fail(`${location} reviewed_candidates[${candidateIndex}] must be a non-empty trimmed string`);
      if (!candidates.has(candidate)) fail(`${location} candidate ${JSON.stringify(candidate)} is not active for record_id ${row.record_id} sense_id ${row.sense_id}`);
      if (reviewedHere.has(candidate)) fail(`${location} repeats reviewed candidate ${JSON.stringify(candidate)}`);
      reviewedHere.add(candidate);
    }
    for (const candidate of reviewedHere) {
      const fingerprint = candidateContextFingerprint(sourceRecord, sourceSense, candidate);
      const previous = stateSense.reviewed.find((review) => review.candidate === candidate);
      if (previous) previous.fingerprint = fingerprint;
      else stateSense.reviewed.push({ candidate, fingerprint });
      markedCount += 1;
    }
  }
  await writeFileAtomic(workspace.checkpointPath, `${JSON.stringify(workspace.checkpoint, null, 2)}\n`);
  return { markedCount, status: buildStatus(workspace.checkpoint, workspace.sourceRows) };
}

/** Rebuild Candidate JSONL in Canonical order and run the established full-batch Candidate v1 validator. */
export async function mergeCandidateBatch({ scratchDirectory, outPath, replace = false, repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const workspace = await loadWorkspace(scratchDirectory, repositoryDirectory);
  const status = buildStatus(workspace.checkpoint, workspace.sourceRows);
  if (status.incompleteChunkCount > 0) {
    const incomplete = workspace.checkpoint.chunks.filter((chunk) => chunk.candidate_sha256 === null).map((chunk) => String(chunk.number).padStart(3, '0'));
    fail(`cannot merge: candidate output is not saved for chunk(s) ${incomplete.join(', ')}; save each complete chunk, including senses with no candidates`);
  }
  if (status.incompleteSenseCount > 0 || status.staleSenseCount > 0) {
    const sourceById = new Map(workspace.sourceRows.map((record) => [record.id, record]));
    if (workspace.checkpoint.batch.method === 'b') {
      const needsExploration = workspace.checkpoint.records.flatMap((record) => record.senses.flatMap((sense) => {
        const sourceRecord = sourceById.get(record.record_id);
        const sourceSense = sourceRecord.senses.find((item) => item.id === sense.sense_id);
        return sense.explored_fingerprint === canonicalSenseFingerprint(sourceRecord, sourceSense)
          ? []
          : [`${record.record_id}/${sense.sense_id}`];
      }));
      fail(`cannot merge: complete both B scenes for the pending source sense(s) ${needsExploration.join(', ')}; then mark-explored`);
    }
    const needsExploration = workspace.checkpoint.records.flatMap((record) => record.senses.flatMap((sense) => {
      const sourceRecord = sourceById.get(record.record_id);
      const sourceSense = sourceRecord.senses.find((item) => item.id === sense.sense_id);
      const fingerprint = canonicalSenseFingerprint(sourceRecord, sourceSense);
      if (sense.explored_passes.primary_fingerprint !== fingerprint) return [`${record.record_id}/${sense.sense_id}:primary`];
      if (sense.explored_passes.secondary_fingerprint !== fingerprint) return [`${record.record_id}/${sense.sense_id}:secondary`];
      return [];
    }));
    fail(`cannot merge: complete A's independent primary and secondary exploration for the pending source sense(s) ${needsExploration.join(', ')}; use mark-explored --pass primary, then --pass secondary`);
  }
  if (status.pendingReviewCount > 0 || status.staleReviewCount > 0) {
    fail(`cannot merge: ${status.pendingReviewCount} candidate(s) need AI meaning/form review and ${status.staleReviewCount} have stale review state; use review-pending, then mark-reviewed`);
  }
  const candidateRows = [...workspace.checkpoint.records]
    .sort((left, right) => left.source_index - right.source_index)
    .map((recordState) => ({
      record_id: recordState.record_id,
      senses: recordState.senses.map((senseState) => ({
        sense_id: senseState.sense_id,
        candidates: senseState.candidates,
      })),
    }));
  const canonicalLemmaForms = await loadCanonicalLemmaForms(repositoryDirectory);
  const validation = validateCandidateBatch(workspace.canonicalRows, candidateRows, {
    batch: workspace.checkpoint.batch.batch,
    canonicalLemmaForms,
    sourceName: workspace.canonicalPath,
    candidateName: 'Candidate workbench output',
  });
  const contents = serializeJsonl(candidateRows);
  const resolvedOutput = path.resolve(repositoryDirectory, outPath ?? '');
  const relativeOutput = path.relative(repositoryDirectory, resolvedOutput);
  const inScratch = relativeOutput.split(path.sep)[0] === '.warroom-scratch'
    && !relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== '..' && !path.isAbsolute(relativeOutput);
  const candidatePathMatch = /^data\/relation-candidates\/(\d{3})\/(\d{3})_(01|02)_([a-d])_([a-z0-9_-]+)\.jsonl$/u.exec(relativeOutput.split(path.sep).join('/'));
  if (!inScratch && !candidatePathMatch) fail('out must be inside .warroom-scratch or a correctly named data/relation-candidates/<SSS>/<SSS>_<BB>_<method>_<model>.jsonl path');
  if (candidatePathMatch && (
    candidatePathMatch[1] !== workspace.checkpoint.batch.shard
    || candidatePathMatch[2] !== workspace.checkpoint.batch.shard
    || candidatePathMatch[3] !== workspace.checkpoint.batch.batch
    || candidatePathMatch[4] !== workspace.checkpoint.batch.method
    || candidatePathMatch[5] !== workspace.checkpoint.batch.model
  )) {
    fail(`out path ${relativeOutput} does not match checkpoint batch ${workspace.checkpoint.batch.shard}_${workspace.checkpoint.batch.batch}`);
  }
  const write = await writeFileAtomic(resolvedOutput, contents, { replace });
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
    if (['replace'].includes(name)) {
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
    '  node scripts/relation/candidate-workbench.mjs read-review-page --scratch-dir <dir> [--offset N] [--limit 1..25] [--max-bytes N] [--max-chars N]',
    '  node scripts/relation/candidate-workbench.mjs read-exploration-page --scratch-dir <dir> [--offset N] [--limit 1..25] [--max-bytes N] [--max-chars N]',
    '  node scripts/relation/candidate-workbench.mjs save-chunk --scratch-dir <dir> --chunk N --input <candidate-chunk.jsonl>',
    '  node scripts/relation/candidate-workbench.mjs patch-sense --scratch-dir <dir> --input <sense-candidates.json>',
    '  node scripts/relation/candidate-workbench.mjs remove-candidate --scratch-dir <dir> --input <confirmed-ineligible.json>',
    '  node scripts/relation/candidate-workbench.mjs review-pending --scratch-dir <dir> --out <review.jsonl> [--replace]',
    '  node scripts/relation/candidate-workbench.mjs exploration-pending --scratch-dir <dir> --out <exploration.jsonl> [--replace]',
    '  node scripts/relation/candidate-workbench.mjs mark-reviewed --scratch-dir <dir> --input <review-receipts.jsonl>',
    '  node scripts/relation/candidate-workbench.mjs mark-explored --scratch-dir <dir> --input <explored-senses.jsonl> [--pass primary|secondary for A]',
    '  node scripts/relation/candidate-workbench.mjs status --scratch-dir <dir>',
    '  node scripts/relation/candidate-workbench.mjs merge --scratch-dir <dir> --out <candidate.jsonl> [--replace]',
    '  node scripts/relation/candidate-workbench.mjs inspect --shard SSS --record-id <id>',
  ].join('\n');
}

function requireOption(options, name) {
  if (!options[name]) fail(`--${name} is required`);
  return options[name];
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === 'prepare') {
    const result = await prepareCandidateBatch({
      shard: requireOption(options, 'shard'),
      batch: requireOption(options, 'batch'),
      method: requireOption(options, 'method'),
      model: requireOption(options, 'model'),
      scratchDirectory: requireOption(options, 'scratch-dir'),
      chunkSize: options['chunk-size'] === undefined ? undefined : Number(options['chunk-size']),
    });
    emitJson({
      checkpoint: result.checkpointPath,
      chunk_directory: result.chunkDirectory,
      source_changed: result.sourceChanged,
      status: result.status,
      chunks: result.chunks,
    });
    return;
  }
  if (command === 'read-chunk') {
    const result = await readCandidateChunkPage({
      scratchDirectory: requireOption(options, 'scratch-dir'),
      chunk: Number(requireOption(options, 'chunk')),
      offset: options.offset === undefined ? 0 : Number(options.offset),
      limit: options.limit === undefined ? undefined : Number(options.limit),
      maxBytes: options['max-bytes'] === undefined ? undefined : Number(options['max-bytes']),
      maxChars: options['max-chars'] === undefined ? undefined : Number(options['max-chars']),
    });
    emitJson(result);
    return;
  }
  if (command === 'read-review-page') {
    const result = await readPendingCandidateReviewPage({
      scratchDirectory: requireOption(options, 'scratch-dir'),
      offset: options.offset === undefined ? 0 : Number(options.offset),
      limit: options.limit === undefined ? undefined : Number(options.limit),
      maxBytes: options['max-bytes'] === undefined ? undefined : Number(options['max-bytes']),
      maxChars: options['max-chars'] === undefined ? undefined : Number(options['max-chars']),
    });
    emitJson(result);
    return;
  }
  if (command === 'read-exploration-page') {
    const result = await readPendingCandidateExplorationPage({
      scratchDirectory: requireOption(options, 'scratch-dir'),
      offset: options.offset === undefined ? 0 : Number(options.offset),
      limit: options.limit === undefined ? undefined : Number(options.limit),
      maxBytes: options['max-bytes'] === undefined ? undefined : Number(options['max-bytes']),
      maxChars: options['max-chars'] === undefined ? undefined : Number(options['max-chars']),
    });
    emitJson(result);
    return;
  }
  if (command === 'save-chunk') {
    const result = await saveCandidateChunk({ scratchDirectory: requireOption(options, 'scratch-dir'), chunk: Number(requireOption(options, 'chunk')), inputPath: requireOption(options, 'input') });
    emitJson(result);
    return;
  }
  if (command === 'patch-sense') {
    const inputPath = assertScratchPath(REPOSITORY_DIRECTORY, requireOption(options, 'input'), 'input');
    let input;
    try {
      input = JSON.parse(await readFile(inputPath, 'utf8'));
    } catch (error) {
      fail(`cannot read sense candidate update ${inputPath}: ${error.message}`);
    }
    if (!hasExactKeys(input, ['record_id', 'sense_id', 'candidates'])) fail(`${inputPath} must contain only record_id, sense_id, and candidates`);
    const result = await updateCandidateSense({ scratchDirectory: requireOption(options, 'scratch-dir'), recordId: input.record_id, senseId: input.sense_id, candidates: input.candidates });
    emitJson(result);
    return;
  }
  if (command === 'remove-candidate') {
    const inputPath = assertScratchPath(REPOSITORY_DIRECTORY, requireOption(options, 'input'), 'input');
    let input;
    try {
      input = JSON.parse(await readFile(inputPath, 'utf8'));
    } catch (error) {
      fail(`cannot read confirmed-ineligible candidate ${inputPath}: ${error.message}`);
    }
    if (!hasExactKeys(input, ['record_id', 'sense_id', 'candidate', 'confirmed_ineligible'])) fail(`${inputPath} must contain only record_id, sense_id, candidate, and confirmed_ineligible`);
    const result = await removeCandidate({
      scratchDirectory: requireOption(options, 'scratch-dir'),
      recordId: input.record_id,
      senseId: input.sense_id,
      candidate: input.candidate,
      confirmedIneligible: input.confirmed_ineligible,
    });
    emitJson(result);
    return;
  }
  if (command === 'review-pending') {
    const result = await exportPendingCandidateReviews({ scratchDirectory: requireOption(options, 'scratch-dir'), outPath: requireOption(options, 'out'), replace: options.replace });
    emitJson(result);
    return;
  }
  if (command === 'exploration-pending') {
    const result = await exportPendingCandidateExploration({ scratchDirectory: requireOption(options, 'scratch-dir'), outPath: requireOption(options, 'out'), replace: options.replace });
    emitJson(result);
    return;
  }
  if (command === 'mark-reviewed') {
    const result = await markCandidateReviews({ scratchDirectory: requireOption(options, 'scratch-dir'), inputPath: requireOption(options, 'input') });
    emitJson(result);
    return;
  }
  if (command === 'mark-explored') {
    const result = await markCandidateSensesExplored({ scratchDirectory: requireOption(options, 'scratch-dir'), inputPath: requireOption(options, 'input'), pass: options.pass });
    emitJson(result);
    return;
  }
  if (command === 'status') {
    const workspace = await loadWorkspace(requireOption(options, 'scratch-dir'));
    emitJson(buildStatus(workspace.checkpoint, workspace.sourceRows));
    return;
  }
  if (command === 'merge') {
    const result = await mergeCandidateBatch({ scratchDirectory: requireOption(options, 'scratch-dir'), outPath: requireOption(options, 'out'), replace: options.replace });
    emitJson({ path: result.path, changed: result.changed, validation: result.validation });
    return;
  }
  if (command === 'inspect') {
    const result = await inspectCanonicalRecord({ shard: requireOption(options, 'shard'), recordId: requireOption(options, 'record-id') });
    emitJson(result.record);
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
