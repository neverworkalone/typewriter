import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { buildDictionary } from '../build/dictionary.mjs';
import { CI_LEVEL_CATEGORY_ORDER } from '../ci/registry.mjs';
import {
  contextSummary,
  loadCanonicalContext,
} from '../validate/canonical-context.mjs';
import { validateDatasetRecords } from '../validate/dataset-integrity.mjs';
import { validateSharedDictionary } from '../ci/validate-shared-dictionary.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const execFile = promisify(execFileCallback);

function parseSizes(argument = process.argv.find((value) => value.startsWith('--sizes='))) {
  const raw = argument?.slice('--sizes='.length) ?? '10000,100000,500000';
  const sizes = raw.split(',').map((value) => Number(value.trim()));
  if (sizes.some((size) => !Number.isSafeInteger(size) || size < 1)) {
    throw new Error(`--sizes must contain positive integers: ${raw}`);
  }
  return sizes;
}

function parseOptionalScales(argument = process.argv.find((value) => value.startsWith('--sqlite-scale='))) {
  const raw = argument?.slice('--sqlite-scale='.length);
  if (raw === undefined || raw === 'none') return new Set();
  const scales = raw.split(',').map((value) => Number(value.trim()));
  if (scales.some((scale) => !Number.isSafeInteger(scale) || scale < 1)) {
    throw new Error(`--sqlite-scale must contain positive integers or none: ${raw}`);
  }
  return new Set(scales);
}

function syntheticRecord(index) {
  const id = `r${String(index + 1).padStart(6, '0')}`;
  const previousId = index === 0
    ? undefined
    : `r${String(index).padStart(6, '0')}`;
  return {
    id,
    record_type: 'entry',
    role: 'reference-only',
    lemma: `synthetic-${String(index + 1).padStart(6, '0')}`,
    search_forms: [`synthetic-${String(index + 1).padStart(6, '0')}`],
    senses: [{
      id: `${id}-s1`,
      pos: 'noun',
      gloss: `synthetic writer-facing record ${String(index + 1).padStart(6, '0')}`,
      ...(previousId
        ? {
          relations: [{
            target: previousId,
            type: 'near',
            note: 'synthetic benchmark relation',
          }],
        }
        : {}),
    }],
  };
}

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
  };
}

function mergeMemorySnapshots(left, right) {
  if (!left) return right;
  return {
    rss_mb: Math.max(left.rss_mb, right.rss_mb),
    heap_used_mb: Math.max(left.heap_used_mb, right.heap_used_mb),
  };
}

async function writeSyntheticCanonical(filePath, scale) {
  const file = await open(filePath, 'w');
  let buffer = '';
  try {
    for (let index = 0; index < scale; index += 1) {
      buffer += `${JSON.stringify(syntheticRecord(index))}\n`;
      if (buffer.length >= 1024 * 1024) {
        await file.write(buffer);
        buffer = '';
      }
    }
    if (buffer.length > 0) {
      await file.write(buffer);
    }
  } finally {
    await file.close();
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function runProductBuild({ sharedDictionaryPath, outputDirectory }) {
  const vitePath = path.join(REPOSITORY_DIRECTORY, 'node_modules/vite/bin/vite.js');
  await execFile(
    process.execPath,
    [vitePath, 'build', '--config', path.join(REPOSITORY_DIRECTORY, 'vite.config.js')],
    {
      cwd: REPOSITORY_DIRECTORY,
      env: {
        ...process.env,
        TYPEWRITER_ALLOW_DIRTY: 'true',
        TYPEWRITER_BUILD_OUTPUT_DIRECTORY: outputDirectory,
        TYPEWRITER_SHARED_DICTIONARY_PATH: sharedDictionaryPath,
      },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
}

function parseFixedLevelCosts(
  argument = process.argv.find((value) => value.startsWith('--fixed-level-ms=')),
) {
  const raw = argument?.slice('--fixed-level-ms='.length);
  if (raw === undefined || raw === 'none') return undefined;
  const costs = Object.fromEntries(raw.split(',').map((entry) => {
    const [level, value] = entry.split(':');
    const milliseconds = Number(value);
    if (!['fast', 'normal', 'deep'].includes(level)
      || !Number.isFinite(milliseconds)
      || milliseconds < 0) {
      throw new Error(
        `--fixed-level-ms must contain fast|normal|deep non-negative millisecond pairs: ${raw}`,
      );
    }
    return [level, milliseconds];
  }));
  for (const level of ['fast', 'normal', 'deep']) {
    if (!Object.hasOwn(costs, level)) {
      throw new Error(`--fixed-level-ms is missing the ${level} level: ${raw}`);
    }
  }
  return costs;
}

function composeLevelBudgets(corpusCost, fixedLevelCosts) {
  const targetWallClockMs = {
    fast: 60_000,
    normal: 180_000,
    deep: 600_000,
  };
  return Object.fromEntries(Object.entries(targetWallClockMs).map(([level, target]) => {
    const corpusComponentMs = corpusCost[level].wall_clock_ms;
    const conservativeUpperBoundMs = fixedLevelCosts[level] + corpusComponentMs;
    return [level, {
      fixed_level_upper_bound_ms: fixedLevelCosts[level],
      corpus_component_ms: corpusComponentMs,
      conservative_upper_bound_ms: Math.round(conservativeUpperBoundMs * 100) / 100,
      target_wall_clock_ms: target,
      within_target: conservativeUpperBoundMs <= target,
    }];
  }));
}

export async function benchmarkCanonicalValidation({
  sizes = parseSizes(),
  sqliteScale,
  sqliteScales,
  fixedLevelCosts,
} = {}) {
  const selectedSqliteScales = sqliteScales === undefined
    ? (sqliteScale === undefined ? parseOptionalScales() : new Set([sqliteScale]))
    : new Set(sqliteScales);
  const selectedFixedLevelCosts = fixedLevelCosts ?? parseFixedLevelCosts();
  const root = await mkdtemp(path.join(os.tmpdir(), 'typewriter-canonical-benchmark-'));
  const results = [];

  try {
    for (const scale of sizes) {
      const result = {
        scale,
        failure_stage: null,
        error: null,
        sqlite_build_count: 0,
        corpus_cost: {},
      };
      let peakMemory;
      const sampleMemory = () => {
        peakMemory = mergeMemorySnapshots(peakMemory, memorySnapshot());
      };
      const scaleDirectory = path.join(root, String(scale));
      const canonicalDirectory = path.join(scaleDirectory, 'canonical');
      const outputPath = path.join(scaleDirectory, 'dictionary.sqlite');
      await mkdir(canonicalDirectory, { recursive: true });
      const totalStart = now();
      try {
        result.failure_stage = 'generate';
        const generationStart = now();
        await writeSyntheticCanonical(
          path.join(canonicalDirectory, 'synthetic.jsonl'),
          scale,
        );
        result.generate_ms = elapsed(generationStart);
        sampleMemory();

        result.failure_stage = 'load-and-index';
        const loadStart = now();
        const context = await loadCanonicalContext({
          directory: canonicalDirectory,
          contextPath: null,
        });
        result.load_and_index_ms = elapsed(loadStart);
        sampleMemory();

        result.failure_stage = 'global-validation';
        const validationStart = now();
        const indexes = validateDatasetRecords(context.records, {
          context,
          checkPilotCompleteness: false,
          requireSemanticAudit: false,
        });
        result.global_validation_ms = elapsed(validationStart);
        sampleMemory();
        result.validator_result_count = {
          record_count: context.statistics.recordCount,
          sense_count: context.statistics.senseCount,
          relation_count: context.statistics.relationCount,
          indexed_record_count: indexes.recordsById.size,
          indexed_relation_count: indexes.relations.length,
          blocking_finding_count: context.derived.lexicalQuality?.blocking_finding_count ?? 0,
        };
        result.metrics = contextSummary(context).metrics;
        result.context_transport = {
          mode: 'same-process-shared-context',
          serialize_count: context.metrics.canonical_context_serialize_count ?? 0,
          deserialize_count: context.metrics.canonical_context_deserialize_count ?? 0,
          rehydrate_count: context.metrics.canonical_context_rehydrate_count ?? 0,
        };

        if (selectedSqliteScales.has(scale)) {
          result.failure_stage = 'sqlite-build';
          const buildStart = now();
          await buildDictionary({
            inputDirectory: canonicalDirectory,
            outputPath,
            canonicalContext: context,
            repositoryDirectory: REPOSITORY_DIRECTORY,
            allowDirty: true,
          });
          result.sqlite_build_ms = elapsed(buildStart);
          result.sqlite_build_count = context.metrics.sqlite_build_count;
          sampleMemory();

          const fastEnd = now();
          result.corpus_cost.fast = {
            runner_category_order: CI_LEVEL_CATEGORY_ORDER.fast,
            wall_clock_ms: Math.round((fastEnd - totalStart) * 100) / 100,
            canonical_context: 'loaded, indexed, and globally validated once',
            sqlite_build_count: 1,
          };

          const normalStart = now();
          await validateSharedDictionary({
            databasePath: outputPath,
            canonicalContext: context,
          });
          const sharedDigest = await sha256File(outputPath);
          const productOutputDirectory = path.join(scaleDirectory, 'product');
          await runProductBuild({
            sharedDictionaryPath: outputPath,
            outputDirectory: productOutputDirectory,
          });
          const productDictionaryPath = path.join(productOutputDirectory, 'dictionary.sqlite');
          const productDictionaryDigest = await sha256File(productDictionaryPath);
          if (productDictionaryDigest !== sharedDigest) {
            throw new Error('product build did not reuse the shared SQLite artifact');
          }
          const normalEnd = now();
          result.corpus_cost.normal = {
            runner_category_order: CI_LEVEL_CATEGORY_ORDER.normal,
            wall_clock_ms: Math.round((normalEnd - totalStart) * 100) / 100,
            continuation_ms: Math.round((normalEnd - normalStart) * 100) / 100,
            shared_sqlite_artifact_reused: true,
            product_dictionary_digest_matches: true,
            sqlite_build_count: 0,
          };

          const deepStart = now();
          const reproducibleOutputPath = path.join(scaleDirectory, 'dictionary-reproducible.sqlite');
          await buildDictionary({
            inputDirectory: canonicalDirectory,
            outputPath: reproducibleOutputPath,
            canonicalContext: context,
            repositoryDirectory: REPOSITORY_DIRECTORY,
            allowDirty: true,
          });
          const reproducibleDigest = await sha256File(reproducibleOutputPath);
          if (reproducibleDigest !== sharedDigest) {
            throw new Error('independent SQLite build did not reproduce the shared artifact');
          }
          const deepEnd = now();
          result.corpus_cost.deep = {
            runner_category_order: CI_LEVEL_CATEGORY_ORDER.deep,
            wall_clock_ms: Math.round((deepEnd - totalStart) * 100) / 100,
            continuation_ms: Math.round((deepEnd - deepStart) * 100) / 100,
            independent_sqlite_build_count: 1,
            reproducible: true,
          };
          result.sqlite_build_count = context.metrics.sqlite_build_count;
          result.shared_sqlite_sha256 = sharedDigest;
          result.product_dictionary_sha256 = productDictionaryDigest;
          result.reproducible_sqlite_sha256 = reproducibleDigest;
          if (selectedFixedLevelCosts) {
            result.composed_ci_levels = composeLevelBudgets(
              result.corpus_cost,
              selectedFixedLevelCosts,
            );
          }
        }

        result.failure_stage = null;
        result.wall_clock_ms = elapsed(totalStart);
        sampleMemory();
        result.peak_memory = peakMemory;
        result.metrics = contextSummary(context).metrics;
      } catch (error) {
        result.failure_stage = result.failure_stage ?? 'unknown';
        result.error = error.code ? `${error.code}: ${error.message}` : error.message;
        result.wall_clock_ms = elapsed(totalStart);
        sampleMemory();
        result.peak_memory = peakMemory;
      }
      results.push(result);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  return {
    contract_version: 'canonical-validation-benchmark-v2',
    runner_wiring: 'same-process-shared-context-with-level-continuation',
    synthetic_record_shape: 'one reference-only noun sense per record; every record after the first has one near relation to its predecessor',
    sqlite_scales: [...selectedSqliteScales].sort((left, right) => left - right),
    corpus_cost_wiring: {
      fast: 'shared canonical load/index/full synthetic validation plus one shared SQLite build',
      normal: 'shared SQLite validation plus product extension consumer',
      deep: 'independent SQLite rebuild and byte-level reproducibility check',
    },
    fixed_level_costs_ms: selectedFixedLevelCosts ?? null,
    results,
  };
}

async function main() {
  console.log(JSON.stringify(await benchmarkCanonicalValidation(), null, 2));
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
