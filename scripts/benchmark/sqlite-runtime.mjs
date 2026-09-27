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
import { validatePackagedDictionary } from '../../src/runtime/dictionary-validation.js';

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
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function prepareDatabaseForWorkerReady(database, expectedSourceRevision, recordMemoryPhase = () => {}) {
  const queryOnlyStart = now();
  database.exec('PRAGMA query_only = ON');
  const queryOnly = Number(database.selectValue('PRAGMA query_only'));
  if (queryOnly !== 1) throw new Error('SQLite WASM database did not enter query-only mode');
  const queryOnlySetupMs = elapsed(queryOnlyStart);
  recordMemoryPhase('after_query_only_setup');

  const validationStart = now();
  validatePackagedDictionary(database, { expectedSourceRevision });
  const packagedDictionaryValidationMs = elapsed(validationStart);
  recordMemoryPhase('after_packaged_dictionary_validation');

  const readOnlyProbeStart = now();
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
  const readOnlyProbeMs = elapsed(readOnlyProbeStart);
  recordMemoryPhase('after_read_only_probe');

  return {
    query_only_setup_ms: queryOnlySetupMs,
    packaged_dictionary_validation_ms: packagedDictionaryValidationMs,
    read_only_probe_ms: readOnlyProbeMs,
  };
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
  expectedSourceRevision,
} = {}) {
  if (!databasePath) throw new Error('databasePath is required');
  if (!Array.isArray(queryCases) || queryCases.length === 0) {
    throw new Error('queryCases must contain representative product queries');
  }
  if (!Number.isSafeInteger(iterations) || iterations < 5) {
    throw new Error('iterations must be an integer of at least five');
  }
  if (!/^[0-9a-f]{40}$/.test(expectedSourceRevision ?? '')) {
    throw new Error('expectedSourceRevision must be a full lowercase Git SHA');
  }

  const measurements = [];
  const databaseLifecycleEvents = [];
  let currentDatabase;
  let maxLiveDatabases = 0;
  let coldDatabase;
  let warmDatabase;
  const recordMemory = (phase) => {
    const snapshot = { phase, ...memorySnapshot() };
    measurements.push(snapshot);
    return snapshot;
  };
  const openTrackedDatabase = (sqlite3, bytes, phase) => {
    if (currentDatabase) {
      throw new Error('SQLite WASM runtime benchmark cannot hold two live database instances');
    }
    const database = openWasmDatabase(sqlite3, bytes);
    currentDatabase = database;
    maxLiveDatabases = Math.max(maxLiveDatabases, 1);
    databaseLifecycleEvents.push(`${phase}_open`);
    return database;
  };
  const closeTrackedDatabase = (database, phase) => {
    if (currentDatabase !== database) {
      throw new Error(`SQLite WASM runtime benchmark closed an untracked ${phase} database`);
    }
    try {
      database.close();
    } finally {
      currentDatabase = undefined;
      databaseLifecycleEvents.push(`${phase}_close`);
    }
  };

  try {
    recordMemory('before_wasm_init');
    const wasmInitStart = now();
    const sqlite3 = await sqlite3InitModule();
    const wasmModuleInitMs = elapsed(wasmInitStart);
    recordMemory('after_wasm_init');

    const fileReadStart = now();
    // Share the file Buffer's ArrayBuffer with a plain Uint8Array view. SQLite
    // WASM requires the plain view, and this avoids a second file-sized copy;
    // the extension runtime also holds its response ArrayBuffer while deserializing it.
    const fileBuffer = await readFile(databasePath);
    const bytes = new Uint8Array(
      fileBuffer.buffer,
      fileBuffer.byteOffset,
      fileBuffer.byteLength,
    );
    const fileReadMs = elapsed(fileReadStart);
    const databaseBytes = (await stat(databasePath)).size;
    recordMemory('after_database_read');

    const coldOpenStart = now();
    coldDatabase = openTrackedDatabase(sqlite3, bytes, 'cold');
    const coldDatabaseOpenMs = elapsed(coldOpenStart);
    recordMemory('after_first_database_open');
    const coldReadyComponents = prepareDatabaseForWorkerReady(
      coldDatabase,
      expectedSourceRevision,
      recordMemory,
    );
    const fileMetrics = databaseSizeMetrics(coldDatabase, databaseBytes);

    const queryPaths = queryCases.map((queryCase) => measureQueryPath(
      coldDatabase,
      queryCase,
      iterations,
    ));
    const coldSteadyState = recordMemory('after_queries');
    const coldLoadPeakRss = processMaximumRssMb();

    closeTrackedDatabase(coldDatabase, 'cold');
    coldDatabase = undefined;
    const afterColdClose = recordMemory('after_cold_database_close');

    const warmOpenStart = now();
    warmDatabase = openTrackedDatabase(sqlite3, bytes, 'warm');
    const warmDatabaseOpenMs = elapsed(warmOpenStart);
    const warmReadyComponents = prepareDatabaseForWorkerReady(warmDatabase, expectedSourceRevision);
    const afterWarmOpen = recordMemory('after_warm_worker_ready');
    closeTrackedDatabase(warmDatabase, 'warm');
    warmDatabase = undefined;
    const afterWarmClose = recordMemory('after_warm_database_close');

    const rawOpenMs = Math.round((wasmModuleInitMs + fileReadMs + coldDatabaseOpenMs) * 100) / 100;
    const workerReadyMs = Math.round((rawOpenMs
      + coldReadyComponents.query_only_setup_ms
      + coldReadyComponents.packaged_dictionary_validation_ms
      + coldReadyComponents.read_only_probe_ms) * 100) / 100;
    const warmWorkerReadyMs = Math.round((warmDatabaseOpenMs
      + warmReadyComponents.query_only_setup_ms
      + warmReadyComponents.packaged_dictionary_validation_ms
      + warmReadyComponents.read_only_probe_ms) * 100) / 100;
    const peakObservedRss = Math.max(...measurements.map(({ rss_mb }) => rss_mb));
    return {
      contract_version: 'sqlite-wasm-runtime-benchmark-v3',
      sqlite_wasm_version: sqlite3.version.libVersion,
      database: fileMetrics,
      database_lifecycle: {
        max_live_databases: maxLiveDatabases,
        events: databaseLifecycleEvents,
      },
      startup: {
        readiness_scope: 'SQLite WASM module initialization, packaged database read/open, current worker query-only setup, validatePackagedDictionary, and read-only probe; excludes Chrome process and worker-message startup',
        wasm_module_init_ms: wasmModuleInitMs,
        database_file_read_ms: fileReadMs,
        first_database_open_ms: coldDatabaseOpenMs,
        query_only_setup_ms: coldReadyComponents.query_only_setup_ms,
        packaged_dictionary_validation_ms: coldReadyComponents.packaged_dictionary_validation_ms,
        read_only_probe_ms: coldReadyComponents.read_only_probe_ms,
        raw_open_ms: rawOpenMs,
        worker_ready_ms: workerReadyMs,
        warm_database_reopen_ms: warmDatabaseOpenMs,
        warm_query_only_setup_ms: warmReadyComponents.query_only_setup_ms,
        warm_packaged_dictionary_validation_ms: warmReadyComponents.packaged_dictionary_validation_ms,
        warm_read_only_probe_ms: warmReadyComponents.read_only_probe_ms,
        warm_worker_ready_ms: warmWorkerReadyMs,
        file_cache_note: 'first means a fresh SQLite WASM module in a fresh process; OS disk-cache state is uncontrolled',
      },
      query_paths: queryPaths,
      memory: {
        scope: 'benchmark Node process running the production SQLite WASM module, current worker packaged-dictionary validation, read-only probe, and shared runtime SQL adapter; only one live database instance at a time',
        phase_snapshots: measurements,
        cold_load: {
          peak_rss_mb: coldLoadPeakRss,
          steady_state_rss_mb: coldSteadyState.rss_mb,
          after_close_rss_mb: afterColdClose.rss_mb,
        },
        warm_reopen: {
          baseline_rss_mb: afterColdClose.rss_mb,
          after_open_rss_mb: afterWarmOpen.rss_mb,
          open_ms: warmDatabaseOpenMs,
          after_close_rss_mb: afterWarmClose.rss_mb,
        },
        peak_observed_rss_mb: peakObservedRss,
        process_max_rss_mb: processMaximumRssMb(),
      },
    };
  } finally {
    if (warmDatabase) closeTrackedDatabase(warmDatabase, 'warm');
    if (coldDatabase) closeTrackedDatabase(coldDatabase, 'cold');
  }
}

function argument(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const match = process.argv.find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

async function main() {
  const databasePath = argument('database');
  const queryFile = argument('queries-file');
  const expectedSourceRevision = argument('expected-source-revision');
  if (!databasePath || !queryFile || !expectedSourceRevision) {
    throw new Error('Use --database=<path> --queries-file=<path> --expected-source-revision=<full-git-sha>');
  }
  const queryCases = JSON.parse(await readFile(queryFile, 'utf8'));
  console.log(JSON.stringify(await measureSqliteWasmRuntime({
    databasePath,
    queryCases,
    iterations: Number(argument('iterations', '40')),
    expectedSourceRevision,
  })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
