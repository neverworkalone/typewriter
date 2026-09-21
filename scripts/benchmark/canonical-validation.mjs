import { performance } from 'node:perf_hooks';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildDictionary } from '../build/dictionary.mjs';
import {
  contextSummary,
  loadCanonicalContext,
} from '../validate/canonical-context.mjs';
import { validateDatasetRecords } from '../validate/dataset-integrity.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');

function parseSizes(argument = process.argv.find((value) => value.startsWith('--sizes='))) {
  const raw = argument?.slice('--sizes='.length) ?? '10000,100000,500000';
  const sizes = raw.split(',').map((value) => Number(value.trim()));
  if (sizes.some((size) => !Number.isSafeInteger(size) || size < 1)) {
    throw new Error(`--sizes must contain positive integers: ${raw}`);
  }
  return sizes;
}

function parseOptionalScale(argument = process.argv.find((value) => value.startsWith('--sqlite-scale='))) {
  const raw = argument?.slice('--sqlite-scale='.length);
  if (raw === undefined || raw === 'none') return undefined;
  const scale = Number(raw);
  if (!Number.isSafeInteger(scale) || scale < 1) {
    throw new Error(`--sqlite-scale must be a positive integer or none: ${raw}`);
  }
  return scale;
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

export async function benchmarkCanonicalValidation({
  sizes = parseSizes(),
  sqliteScale = parseOptionalScale(),
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'typewriter-canonical-benchmark-'));
  const results = [];

  try {
    for (const scale of sizes) {
      const result = {
        scale,
        failure_stage: null,
        error: null,
        sqlite_build_count: 0,
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

        if (sqliteScale === scale) {
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
    contract_version: 'canonical-validation-benchmark-v1',
    synthetic_record_shape: 'one reference-only noun sense per record; every record after the first has one near relation to its predecessor',
    sqlite_scale: sqliteScale ?? null,
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
