import { performance } from 'node:perf_hooks';
import { readFile, stat } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  findRecordsBySearchTerm,
  getRecord,
} from '../../src/runtime/sqlite-query.js';

function now() {
  return performance.now();
}

function elapsed(start) {
  return Math.round((now() - start) * 100) / 100;
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rss_mb: Math.round((memory.rss / 1024 / 1024) * 100) / 100,
    heap_used_mb: Math.round((memory.heapUsed / 1024 / 1024) * 100) / 100,
    external_mb: Math.round((memory.external / 1024 / 1024) * 100) / 100,
    array_buffers_mb: Math.round((memory.arrayBuffers / 1024 / 1024) * 100) / 100,
  };
}

function processMaximumRssMb() {
  const { maxRSS } = process.resourceUsage();
  const bytes = maxRSS * 1024;
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function percentile(sortedValues, fraction) {
  return sortedValues[Math.max(0, Math.ceil(sortedValues.length * fraction) - 1)];
}

function summarizeTimings(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    sample_count: values.length,
    median_ms: Math.round(percentile(sorted, 0.5) * 100) / 100,
    p95_ms: Math.round(percentile(sorted, 0.95) * 100) / 100,
    max_ms: Math.round(sorted.at(-1) * 100) / 100,
  };
}

function openWasmDatabase(sqlite3, bytes) {
  const database = new sqlite3.oo1.DB();
  try {
    const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
    database.checkRc(sqlite3.capi.sqlite3_deserialize(
      database.pointer,
      'main',
      pointer,
      bytes.byteLength,
      bytes.byteLength,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE,
    ));
    database.exec('PRAGMA query_only = ON');
    const queryOnly = Number(database.selectValue('PRAGMA query_only'));
    if (queryOnly !== 1) throw new Error('SQLite WASM database did not enter query-only mode');

    let writeBlocked = false;
    try {
      database.exec(
        "INSERT INTO records (id, record_type, role, lemma) VALUES ('__typewriter_read_only_probe__', 'entry', 'start', '쓰기 금지')",
      );
    } catch {
      writeBlocked = true;
    }
    const persistedWriteCount = Number(database.selectValue(
      "SELECT COUNT(*) FROM records WHERE id = '__typewriter_read_only_probe__'",
    ));
    if (!writeBlocked || persistedWriteCount !== 0) {
      throw new Error('SQLite WASM database failed the runtime read-only probe');
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function databaseSizeMetrics(database, databaseBytes) {
  const indexPages = database.selectObjects(`
    SELECT dbstat.name, SUM(dbstat.pgsize) AS bytes
    FROM dbstat
    INNER JOIN sqlite_master ON sqlite_master.name = dbstat.name
    WHERE sqlite_master.type = 'index'
    GROUP BY dbstat.name
    ORDER BY dbstat.name
  `).map(({ name, bytes }) => ({ name, bytes: Number(bytes) }));
  const objectPages = database.selectObjects(`
    SELECT name, SUM(pgsize) AS bytes
    FROM dbstat
    GROUP BY name
    ORDER BY name
  `).map(({ name, bytes }) => ({ name, bytes: Number(bytes) }));
  return {
    file_bytes: databaseBytes,
    page_size_bytes: Number(database.selectValue('PRAGMA page_size')),
    page_count: Number(database.selectValue('PRAGMA page_count')),
    index_count: Number(database.selectValue("SELECT COUNT(*) FROM sqlite_master WHERE type = 'index'")),
    index_bytes: indexPages.reduce((total, { bytes }) => total + bytes, 0),
    index_pages: indexPages,
    object_pages: objectPages,
  };
}

function measureQueryPath(database, queryCase, iterations) {
  const firstStart = now();
  const firstResponse = findRecordsBySearchTerm(database, queryCase.term);
  const firstQueryMs = elapsed(firstStart);
  if (firstResponse.matches.length === 0) {
    throw new Error(`SQLite WASM benchmark query returned no matches: ${queryCase.category}`);
  }
  if (!firstResponse.matches.some(({ match }) => match?.field === queryCase.expected_field)) {
    throw new Error(`SQLite WASM benchmark query used the wrong path: ${queryCase.category}`);
  }

  const record = queryCase.record_id ? getRecord(database, queryCase.record_id) : null;
  if (queryCase.expected_sense_count !== undefined
    && record?.senses.length !== queryCase.expected_sense_count) {
    throw new Error(`SQLite WASM ambiguous-query fixture drifted: ${queryCase.category}`);
  }

  for (let index = 0; index < 5; index += 1) {
    findRecordsBySearchTerm(database, queryCase.term);
  }
  const repeated = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = now();
    findRecordsBySearchTerm(database, queryCase.term);
    repeated.push(elapsed(start));
  }

  let detailQuery;
  if (queryCase.record_id && queryCase.expected_sense_count !== undefined) {
    const detailTimings = [];
    for (let index = 0; index < iterations; index += 1) {
      const start = now();
      getRecord(database, queryCase.record_id);
      detailTimings.push(elapsed(start));
    }
    detailQuery = summarizeTimings(detailTimings);
  }

  return {
    category: queryCase.category,
    first_query_ms: firstQueryMs,
    repeated_query: summarizeTimings(repeated),
    result_count: firstResponse.matches.length,
    result_match_fields: [...new Set(firstResponse.matches.map(({ match }) => match?.field))].sort(),
    ...(record ? { ambiguous_sense_count: record.senses.length } : {}),
    ...(detailQuery ? { ambiguous_record_load: detailQuery } : {}),
  };
}

export async function measureSqliteWasmRuntime({
  databasePath,
  queryCases,
  iterations = 40,
} = {}) {
  if (!databasePath) throw new Error('databasePath is required');
  if (!Array.isArray(queryCases) || queryCases.length === 0) {
    throw new Error('queryCases must contain representative product queries');
  }
  if (!Number.isSafeInteger(iterations) || iterations < 5) {
    throw new Error('iterations must be an integer of at least five');
  }

  const measurements = [];
  measurements.push({ phase: 'before_wasm_init', ...memorySnapshot() });
  const wasmInitStart = now();
  const sqlite3 = await sqlite3InitModule();
  const wasmModuleInitMs = elapsed(wasmInitStart);
  measurements.push({ phase: 'after_wasm_init', ...memorySnapshot() });

  const fileReadStart = now();
  const bytes = new Uint8Array(await readFile(databasePath));
  const fileReadMs = elapsed(fileReadStart);
  const databaseBytes = (await stat(databasePath)).size;
  measurements.push({ phase: 'after_database_read', ...memorySnapshot() });

  const coldOpenStart = now();
  const coldDatabase = openWasmDatabase(sqlite3, bytes);
  const coldDatabaseOpenMs = elapsed(coldOpenStart);
  measurements.push({ phase: 'after_first_database_open', ...memorySnapshot() });
  const fileMetrics = databaseSizeMetrics(coldDatabase, databaseBytes);

  const queryPaths = queryCases.map((queryCase) => measureQueryPath(
    coldDatabase,
    queryCase,
    iterations,
  ));
  measurements.push({ phase: 'after_queries', ...memorySnapshot() });

  const warmOpenStart = now();
  const warmDatabase = openWasmDatabase(sqlite3, bytes);
  const warmDatabaseOpenMs = elapsed(warmOpenStart);
  measurements.push({ phase: 'after_warm_database_open', ...memorySnapshot() });
  warmDatabase.close();
  coldDatabase.close();

  const coldReadyMs = Math.round((wasmModuleInitMs + fileReadMs + coldDatabaseOpenMs) * 100) / 100;
  const peakObservedRss = Math.max(...measurements.map(({ rss_mb }) => rss_mb));
  return {
    contract_version: 'sqlite-wasm-runtime-benchmark-v1',
    sqlite_wasm_version: sqlite3.version.libVersion,
    database: fileMetrics,
    startup: {
      wasm_module_init_ms: wasmModuleInitMs,
      database_file_read_ms: fileReadMs,
      first_database_open_ms: coldDatabaseOpenMs,
      first_ready_ms: coldReadyMs,
      warm_database_reopen_ms: warmDatabaseOpenMs,
      file_cache_note: 'first means a fresh SQLite WASM module in a fresh process; OS disk-cache state is uncontrolled',
    },
    query_paths: queryPaths,
    memory: {
      scope: 'benchmark Node process running the production SQLite WASM module and shared runtime SQL adapter',
      phase_snapshots: measurements,
      peak_observed_rss_mb: peakObservedRss,
      process_max_rss_mb: processMaximumRssMb(),
    },
  };
}

function argument(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const match = process.argv.find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

async function main() {
  const databasePath = argument('database');
  const queryFile = argument('queries-file');
  if (!databasePath || !queryFile) {
    throw new Error('Use --database=<path> --queries-file=<path>');
  }
  const queryCases = JSON.parse(await readFile(queryFile, 'utf8'));
  console.log(JSON.stringify(await measureSqliteWasmRuntime({
    databasePath,
    queryCases,
    iterations: Number(argument('iterations', '40')),
  })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
