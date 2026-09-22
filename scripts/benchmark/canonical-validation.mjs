import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
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
import {
  DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
  SEMANTIC_DECISION_SOURCE_KIND,
  buildCanonicalSemanticAudit,
  buildSemanticTopicEvidence,
  cachedSha256Json,
  canonicalRecordsSha256,
  createCanonicalAuditCache,
} from '../validate/semantic-audit.mjs';
import { validateDatasetRecords } from '../validate/dataset-integrity.mjs';
import { auditCanonicalLexicalQuality } from '../validate/lexical-quality.mjs';
import { normalizeCanonicalDirectory } from '../normalize/canonical.mjs';
import { validateSharedDictionary } from '../ci/validate-shared-dictionary.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const execFile = promisify(execFileCallback);
const SYNTHETIC_RELATION_PERIOD = 1000;
const SYNTHETIC_RELATION_SLOTS = 238;

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
      ...(previousId && index % SYNTHETIC_RELATION_PERIOD < SYNTHETIC_RELATION_SLOTS
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

function recordOf(recordInfo) {
  return recordInfo?.record ?? recordInfo;
}

function createSyntheticDecisionSource(recordInfos, template, scale, hashCache) {
  const records = recordInfos.map(recordOf);
  const canonicalDigest = hashCache?.canonicalDigest ?? canonicalRecordsSha256(recordInfos);
  const sourceId = `synthetic-canonical-benchmark-${scale}`;
  const templateReview = template.authored_review;
  const templatePass = templateReview.review_pass;
  const templateRecord = templateReview.records.find((record) => record.boundary_review);
  const templateEvidence = templateRecord?.boundary_review?.evidence?.find(Boolean);
  const templateSense = templateRecord?.sense_reviews?.find(Boolean);
  const findCode = (value, fieldName) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findCode(item, fieldName);
        if (found) return found;
      }
      return undefined;
    }
    if (!value || typeof value !== 'object') return undefined;
    if (typeof value[fieldName] === 'string') return value[fieldName];
    for (const child of Object.values(value)) {
      const found = findCode(child, fieldName);
      if (found) return found;
    }
    return undefined;
  };
  const rationaleCodes = {
    boundaryEvidence: templateEvidence?.evidence_basis_code
      ?? findCode(templateReview.records, 'evidence_basis_code'),
    evidenceRationale: templateEvidence?.rationale_code
      ?? findCode(templateReview.records, 'rationale_code'),
    boundaryRationale: templateRecord?.boundary_review?.rationale_code
      ?? findCode(templateReview.records, 'rationale_code'),
    relationRationale: templateSense?.relation_rationale_code
      ?? findCode(templateReview.records, 'relation_rationale_code'),
    noRelationRationale: templateSense?.no_relation_rationale_code
      ?? findCode(templateReview.records, 'no_relation_rationale_code'),
  };
  const senseCount = records.reduce((count, record) => count + record.senses.length, 0);
  const authoredReview = {
    schema_version: templateReview.schema_version,
    contract_version: templateReview.contract_version,
    artifact_id: `${sourceId}-review`,
    scope: 'complete-canonical',
    review_mode: templateReview.review_mode,
    review_pass: {
      ...structuredClone(templatePass),
      id: `${sourceId}-review-pass`,
      reviewer: 'synthetic-benchmark',
      record_count: records.length,
      sense_count: senseCount,
      open_finding_count: 0,
      correction_count: 0,
      correction_history: [],
      boundary_decision_history: [],
    },
    source: {
      kind: 'canonical-jsonl-record-values',
      canonical_records_sha256: canonicalDigest,
    },
    decision_source: {
      kind: SEMANTIC_DECISION_SOURCE_KIND,
      contract_version: templateReview.decision_source.contract_version,
      source_id: sourceId,
      path: `benchmark://${sourceId}`,
    },
    record_count: records.length,
    sense_count: senseCount,
    records: records.map((record) => ({
      record_id: record.id,
      record_sha256: cachedSha256Json(record, hashCache),
      boundary_review: {
        decision: 'retain',
        classification: 'atomic',
        evidence: record.senses.map((sense) => ({
          sense_id: sense.id,
          evidence_basis_code: rationaleCodes.boundaryEvidence,
          rationale_code: rationaleCodes.evidenceRationale,
        })),
        rationale_code: rationaleCodes.boundaryRationale,
      },
      sense_reviews: record.senses.map((sense) => {
        const hasRelations = (sense.relations?.length ?? 0) > 0;
        return {
          sense_id: sense.id,
          relation_decision: hasRelations ? 'relations-reviewed' : 'no-relations',
          ...(hasRelations
            ? {}
            : { no_relation_rationale_code: rationaleCodes.noRelationRationale }),
        };
      }),
    })),
    changes: [],
    rationale_templates: structuredClone(templateReview.rationale_templates ?? []),
  };

  return {
    schema_version: template.schema_version,
    contract_version: template.contract_version,
    kind: template.kind,
    source_id: sourceId,
    authoring_mode: template.authoring_mode,
    scope: 'complete-canonical',
    source: {
      kind: 'canonical-jsonl-record-values',
      canonical_records_sha256: canonicalDigest,
    },
    authored_review_sha256: cachedSha256Json(authoredReview, hashCache),
    authored_review: authoredReview,
  };
}

function now() {
  return performance.now();
}

function elapsed(start) {
  return Math.round((now() - start) * 100) / 100;
}

function corpusElapsed(totalStart, end, result) {
  const totalWallClockMs = (end - totalStart) * 1;
  const fixturePreparationMs = (result.generate_ms ?? 0) + (result.synthetic_decision_source_ms ?? 0);
  return Math.round(Math.max(0, totalWallClockMs - fixturePreparationMs) * 100) / 100;
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

function parseFixedLevelEvidencePath(
  argument = process.argv.find((value) => value.startsWith('--fixed-level-evidence=')),
) {
  const raw = argument?.slice('--fixed-level-evidence='.length);
  if (raw === undefined || raw === 'none') return undefined;
  return path.resolve(REPOSITORY_DIRECTORY, raw);
}

function validateFixedLevelEvidence(evidence, sourcePath = '<inline evidence>') {
  if (!evidence || evidence.contract_version !== 'ci-level-evidence-v1') {
    throw new Error(`${sourcePath}: unsupported fixed-level evidence contract`);
  }
  for (const level of ['fast', 'normal', 'deep']) {
    const entry = evidence.levels?.[level];
    if (!entry
      || !Number.isFinite(entry.observed_wall_clock_ms)
      || !Number.isFinite(entry.corpus_baseline_wall_clock_ms)
      || !Number.isFinite(entry.fixed_remainder_observed_wall_clock_ms)
      || !Number.isFinite(entry.fixed_remainder_upper_bound_ms)
      || entry.observed_wall_clock_ms < 0
      || entry.corpus_baseline_wall_clock_ms < 0
      || entry.fixed_remainder_observed_wall_clock_ms < 0
      || entry.fixed_remainder_upper_bound_ms < entry.fixed_remainder_observed_wall_clock_ms) {
      throw new Error(`${sourcePath}: ${level} must contain exact-head wall-clock, corpus baseline, and fixed remainder evidence`);
    }
  }
  return evidence;
}

async function loadFixedLevelEvidence(inlineEvidence) {
  if (inlineEvidence !== undefined) return validateFixedLevelEvidence(inlineEvidence);
  const evidencePath = parseFixedLevelEvidencePath();
  if (!evidencePath) return undefined;
  let evidence;
  try {
    evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  } catch (error) {
    throw new Error(`unable to read fixed-level evidence ${evidencePath}: ${error.message}`);
  }
  return validateFixedLevelEvidence(evidence, evidencePath);
}

function composeLevelBudgets(corpusCost, fixedLevelEvidence) {
  const targetWallClockMs = {
    fast: 60_000,
    normal: 180_000,
    deep: 600_000,
  };
  return Object.fromEntries(Object.entries(targetWallClockMs).map(([level, target]) => {
    const corpusComponentMs = corpusCost[level].wall_clock_ms;
    const fixedLevelEvidenceMs = fixedLevelEvidence.levels[level].fixed_remainder_upper_bound_ms;
    const conservativeUpperBoundMs = fixedLevelEvidenceMs + corpusComponentMs;
    return [level, {
      fixed_level_observed_ms: fixedLevelEvidence.levels[level].observed_wall_clock_ms,
      fixed_remainder_observed_ms: fixedLevelEvidence.levels[level].fixed_remainder_observed_wall_clock_ms,
      fixed_remainder_upper_bound_ms: fixedLevelEvidenceMs,
      fixed_remainder_source_corpus_baseline_ms: fixedLevelEvidence.levels[level].corpus_baseline_wall_clock_ms,
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
  fixedLevelEvidence,
} = {}) {
  const selectedSqliteScales = sqliteScales === undefined
    ? (sqliteScale === undefined ? parseOptionalScales() : new Set([sqliteScale]))
    : new Set(sqliteScales);
  const selectedFixedLevelEvidence = await loadFixedLevelEvidence(
    fixedLevelEvidence
      ?? (fixedLevelCosts
        ? {
          contract_version: 'ci-level-evidence-v1',
          measurement: 'inline caller-supplied level upper bounds',
          levels: Object.fromEntries(
            Object.entries(fixedLevelCosts).map(([level, milliseconds]) => [level, {
              observed_wall_clock_ms: milliseconds,
              corpus_baseline_wall_clock_ms: 0,
              fixed_remainder_observed_wall_clock_ms: milliseconds,
              fixed_remainder_upper_bound_ms: milliseconds,
            }]),
          ),
        }
        : undefined),
  );
  const semanticDecisionSourceTemplate = JSON.parse(
    await readFile(DEFAULT_SEMANTIC_DECISION_SOURCE_PATH, 'utf8'),
  );
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

        result.failure_stage = 'semantic-audit';
        const semanticAuditStart = now();
        const semanticAuditCache = createCanonicalAuditCache(context.records);
        context.semanticAuditCache = semanticAuditCache;
        const syntheticSourceStart = now();
        const syntheticDecisionSource = createSyntheticDecisionSource(
          context.records,
          semanticDecisionSourceTemplate,
          scale,
          semanticAuditCache,
        );
        result.synthetic_decision_source_ms = elapsed(syntheticSourceStart);
        const { artifact: semanticAudit, decisionSource } = await buildCanonicalSemanticAudit({
          canonicalDirectory,
          canonicalContext: context,
          decisionSource: syntheticDecisionSource,
          hashCache: semanticAuditCache,
          batchDecisionSourcePaths: [],
        });
        context.semanticAudit = semanticAudit;
        context.semanticDecisionSource = decisionSource;
        result.semantic_audit_ms = elapsed(semanticAuditStart);
        sampleMemory();

        result.failure_stage = 'topic-evidence';
        const topicEvidenceStart = now();
        const topicEvidence = buildSemanticTopicEvidence(
          context.records,
          semanticAudit,
          { hashCache: context.semanticAuditCache },
        );
        context.derived.topicEvidence = topicEvidence;
        result.topic_evidence_ms = elapsed(topicEvidenceStart);
        sampleMemory();

        result.failure_stage = 'lexical-quality';
        const lexicalQualityStart = now();
        const lexicalQuality = auditCanonicalLexicalQuality(
          context.records,
          {
            context,
            topicEvidence,
            scope: 'complete-canonical',
            throwOnError: false,
          },
        );
        context.derived.lexicalQuality = lexicalQuality;
        result.lexical_quality_ms = elapsed(lexicalQualityStart);
        sampleMemory();

        result.failure_stage = 'global-validation';
        const validationStart = now();
        const indexes = validateDatasetRecords(context.records, {
          context,
          checkPilotCompleteness: false,
          semanticAudit,
          requireSemanticAudit: false,
          lexicalQuality,
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
          result.failure_stage = 'normalize';
          const normalizeStart = now();
          const normalizedModel = await normalizeCanonicalDirectory(canonicalDirectory, {
            checkPilotCompleteness: false,
            canonicalContext: context,
            semanticAudit,
          });
          result.normalize_ms = elapsed(normalizeStart);
          sampleMemory();

          result.failure_stage = 'sqlite-build';
          const buildStart = now();
          await buildDictionary({
            inputDirectory: canonicalDirectory,
            outputPath,
            canonicalContext: context,
            repositoryDirectory: REPOSITORY_DIRECTORY,
            allowDirty: true,
            semanticAudit,
            normalizedModel,
          });
          result.sqlite_build_ms = elapsed(buildStart);
          result.sqlite_build_count = context.metrics.sqlite_build_count;
          sampleMemory();

          const fastEnd = now();
          result.corpus_cost.fast = {
            runner_category_order: CI_LEVEL_CATEGORY_ORDER.fast,
            wall_clock_ms: corpusElapsed(totalStart, fastEnd, result),
            canonical_context: 'loaded, indexed, and globally validated once',
            sqlite_build_count: 1,
            corpus_phases: [
              'load_and_index',
              'buildCanonicalSemanticAudit',
              'buildSemanticTopicEvidence',
              'auditCanonicalLexicalQuality',
              'validateDatasetRecords',
              'normalizeCanonicalDirectory',
              'buildDictionary',
            ],
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
            wall_clock_ms: corpusElapsed(totalStart, normalEnd, result),
            continuation_ms: Math.round((normalEnd - normalStart) * 100) / 100,
            shared_sqlite_artifact_reused: true,
            product_dictionary_digest_matches: true,
            sqlite_build_count: 0,
            corpus_phases: [
              'validateSharedDictionary',
              'product_extension_consumer',
            ],
          };

          const deepStart = now();
          const reproducibleOutputPath = path.join(scaleDirectory, 'dictionary-reproducible.sqlite');
          await buildDictionary({
            inputDirectory: canonicalDirectory,
            outputPath: reproducibleOutputPath,
            canonicalContext: context,
            repositoryDirectory: REPOSITORY_DIRECTORY,
            allowDirty: true,
            semanticAudit,
            normalizedModel,
          });
          const reproducibleSecondOutputPath = path.join(
            scaleDirectory,
            'dictionary-reproducible-second.sqlite',
          );
          await buildDictionary({
            inputDirectory: canonicalDirectory,
            outputPath: reproducibleSecondOutputPath,
            canonicalContext: context,
            repositoryDirectory: REPOSITORY_DIRECTORY,
            allowDirty: true,
            semanticAudit,
            normalizedModel,
          });
          const reproducibleDigest = await sha256File(reproducibleOutputPath);
          const reproducibleSecondDigest = await sha256File(reproducibleSecondOutputPath);
          if (reproducibleDigest !== sharedDigest || reproducibleSecondDigest !== sharedDigest) {
            throw new Error('independent SQLite builds did not reproduce the shared artifact');
          }
          const deepEnd = now();
          result.corpus_cost.deep = {
            runner_category_order: CI_LEVEL_CATEGORY_ORDER.deep,
            wall_clock_ms: corpusElapsed(totalStart, deepEnd, result),
            continuation_ms: Math.round((deepEnd - deepStart) * 100) / 100,
            independent_sqlite_build_count: 2,
            reproducible: true,
            corpus_phases: [
              'independent_buildDictionary_1',
              'independent_buildDictionary_2',
              'byte_identical_digest_check',
            ],
          };
          result.sqlite_build_count = context.metrics.sqlite_build_count;
          result.shared_sqlite_sha256 = sharedDigest;
          result.product_dictionary_sha256 = productDictionaryDigest;
          result.reproducible_sqlite_sha256 = reproducibleDigest;
          result.reproducible_second_sqlite_sha256 = reproducibleSecondDigest;
          if (selectedFixedLevelEvidence) {
            result.composed_ci_levels = composeLevelBudgets(
              result.corpus_cost,
              selectedFixedLevelEvidence,
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
    contract_version: 'canonical-validation-benchmark-v4',
    runner_wiring: 'same-process-shared-context-with-real-corpus-phases-and-level-continuation',
    synthetic_record_shape: 'one reference-only noun sense per record; 23.8% of non-initial records have one near relation to their predecessor',
    benchmark_setup: 'synthetic JSONL generation and synthetic authored-decision construction are excluded from corpus cost because they are fixture preparation, not CI runner gates',
    sqlite_scales: [...selectedSqliteScales].sort((left, right) => left - right),
    corpus_cost_wiring: {
      fast: 'real session load/index plus semantic audit/topic evidence/lexical quality/full dataset validation/normalization and one shared SQLite build; fixture generation is excluded',
      normal: 'shared SQLite validation plus product extension consumer',
      deep: 'two independent SQLite rebuilds and byte-level reproducibility checks',
    },
    fixed_level_evidence: selectedFixedLevelEvidence ?? null,
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
