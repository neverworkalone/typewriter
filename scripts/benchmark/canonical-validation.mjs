import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
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
const SQLITE_RUNTIME_BENCHMARK_PATH = path.join(SCRIPT_DIRECTORY, 'sqlite-runtime.mjs');
const SYNTHETIC_HANGUL_BASE = 0xac00;
const SYNTHETIC_HANGUL_COUNT = 11172;
const SYNTHETIC_CJK_BASE = 0x4e00;
const SYNTHETIC_CJK_COUNT = 0x9fff - SYNTHETIC_CJK_BASE + 1;
const RELEASE_PACKAGE_NOTICES = [
  'Apache-2.0.txt',
  'LICENSE.md',
  'DATA-LICENSE.md',
  'BRAND.md',
  'THIRD-PARTY-NOTICES.txt',
];

function parseSizes(argument = process.argv.find((value) => value.startsWith('--sizes='))) {
  const raw = argument?.slice('--sizes='.length) ?? '100000,500000,1000000';
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

function syntheticId(index, template) {
  const prefix = template.role === 'start' ? 'w' : 'r';
  return `${prefix}${String(index + 1).padStart(7, '0')}`;
}

function syntheticToken(index) {
  const high = Math.floor(index / SYNTHETIC_HANGUL_COUNT);
  const low = index % SYNTHETIC_HANGUL_COUNT;
  return String.fromCodePoint(SYNTHETIC_HANGUL_BASE + high, SYNTHETIC_HANGUL_BASE + low);
}

function syntheticText(prefix, sourceText, uniqueIndex = undefined) {
  const prefixCharacters = [...prefix];
  let prefixIndex = 0;
  const text = [...sourceText].map((character) => (
    /\s/u.test(character) ? character : prefixCharacters[prefixIndex++] ?? '가'
  ));
  if (text.length === 0) text.push('가');
  if (uniqueIndex !== undefined) {
    const lexicalCharacters = text
      .map((character, index) => (!/\s/u.test(character) ? index : -1))
      .filter((index) => index >= 0);
    const wordEnds = [];
    for (let index = 0; index < text.length; index += 1) {
      if (/\s/u.test(text[index])) continue;
      if (index === text.length - 1 || /\s/u.test(text[index + 1])) wordEnds.push(index);
    }
    for (const index of wordEnds) text[index] = '文';

    const firstCodepoint = Math.floor(uniqueIndex / SYNTHETIC_CJK_COUNT);
    const secondCodepoint = uniqueIndex % SYNTHETIC_CJK_COUNT;
    const firstIndex = lexicalCharacters[0] ?? 0;
    text[firstIndex] = String.fromCodePoint(SYNTHETIC_CJK_BASE + firstCodepoint);
    if (lexicalCharacters.length > 1) {
      text[lexicalCharacters[1]] = String.fromCodePoint(SYNTHETIC_CJK_BASE + secondCodepoint);
    }
  }
  return text.join('');
}

function syntheticLemma(template, token) {
  const hasPredicateSense = template.senses.some(
    ({ pos }) => pos === 'verb' || pos === 'adjective',
  );
  if (hasPredicateSense) return `${token}가다`;
  if (template.record_type === 'expression') return `${token} 가나`;
  return `${token}가나`;
}

export function createSyntheticBenchmarkRecord(index, templates, templateIndexById, scale) {
  const templateIndex = index % templates.length;
  const template = recordOf(templates[templateIndex]);
  const cycle = Math.floor(index / templates.length);
  const id = syntheticId(index, template);
  const token = syntheticToken(index);
  const lemma = syntheticLemma(template, token);
  let alternateFormIndex = 0;
  const searchForms = template.search_forms.map((form) => {
    if (form === template.lemma) return lemma;
    alternateFormIndex += 1;
    const characters = [...lemma];
    const shortened = characters.slice(0, Math.max(1, characters.length - alternateFormIndex)).join('');
    return shortened === lemma ? `${shortened}나` : shortened;
  });

  const senses = template.senses.map((sense, senseIndex) => {
    const relations = [];
    for (const relation of sense.relations ?? []) {
      const targetTemplateIndex = templateIndexById.get(relation.target);
      if (targetTemplateIndex === undefined) {
        throw new Error(`synthetic template relation target is missing: ${relation.target}`);
      }
      if (scale < templates.length && targetTemplateIndex >= scale) continue;
      let targetIndex = cycle * templates.length + targetTemplateIndex;
      if (targetIndex >= scale) targetIndex -= templates.length;
      if (targetIndex < 0 || targetIndex >= scale || targetIndex === index) {
        throw new Error(`synthetic relation target is invalid for record ${id}`);
      }
      const targetTemplate = recordOf(templates[targetTemplateIndex]);
      const targetId = syntheticId(targetIndex, targetTemplate);
      const targetSenseIndex = relation.target_sense
        ? targetTemplate.senses.findIndex(({ id: senseId }) => senseId === relation.target_sense)
        : -1;
      if (relation.target_sense && targetSenseIndex < 0) {
        throw new Error(`synthetic template sense target is missing: ${relation.target_sense}`);
      }
      relations.push({
        target: targetId,
        ...(targetSenseIndex < 0 ? {} : { target_sense: `${targetId}-s${targetSenseIndex + 1}` }),
        type: relation.type,
        note: syntheticText('합성관계', relation.note),
      });
    }
    return {
      id: `${id}-s${senseIndex + 1}`,
      pos: sense.pos,
      gloss: syntheticText('합성자료', sense.gloss, index * 4 + senseIndex),
      ...(relations.length > 0 ? { relations } : {}),
    };
  });

  return {
    id,
    record_type: template.record_type,
    role: template.role,
    ...(template.role === 'start' ? { candidate_id: id } : {}),
    lemma,
    search_forms: searchForms,
    senses,
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
  const templatePairwiseRecord = templateReview.records.find(
    (record) => record.boundary_review?.pairwise?.length > 0,
  );
  const templatePairwise = templatePairwiseRecord?.boundary_review?.pairwise?.[0];
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
    pairwiseEvidence: templatePairwise?.evidence_basis_code
      ?? findCode(templateReview.records, 'evidence_basis_code'),
    pairwiseDistinguishingFeature: templatePairwise?.distinguishing_feature_code
      ?? findCode(templateReview.records, 'distinguishing_feature_code'),
    pairwiseRationale: templatePairwise?.rationale_code
      ?? findCode(templateReview.records, 'rationale_code'),
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
        decision: record.senses.length > 1
          ? templatePairwiseRecord.boundary_review.decision
          : 'retain',
        classification: record.senses.length > 1
          ? templatePairwiseRecord.boundary_review.classification
          : 'atomic',
        evidence: record.senses.map((sense) => ({
          sense_id: sense.id,
          evidence_basis_code: rationaleCodes.boundaryEvidence,
          rationale_code: rationaleCodes.evidenceRationale,
        })),
        ...(record.senses.length > 1
          ? {
            pairwise: record.senses.flatMap((leftSense, leftIndex) => (
              record.senses.slice(leftIndex + 1).map((rightSense) => ({
                left_sense_id: leftSense.id,
                right_sense_id: rightSense.id,
                relationship: templatePairwise.relationship,
                decision: templatePairwise.decision,
                evidence_basis_code: rationaleCodes.pairwiseEvidence,
                distinguishing_feature_code: rationaleCodes.pairwiseDistinguishingFeature,
                rationale_code: rationaleCodes.pairwiseRationale,
              }))
            )),
          }
          : {}),
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

async function writeSyntheticCanonical(filePath, scale, templates, templateIndexById) {
  const file = await open(filePath, 'w');
  let buffer = '';
  try {
    for (let index = 0; index < scale; index += 1) {
      buffer += `${JSON.stringify(createSyntheticBenchmarkRecord(index, templates, templateIndexById, scale))}\n`;
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

function countBy(values) {
  return Object.fromEntries([...values].reduce((counts, value) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
    return counts;
  }, new Map()));
}

function summarizeTemplateShape(records) {
  const normalized = records.map(recordOf);
  const senses = normalized.flatMap(({ senses: recordSenses }) => recordSenses);
  const relations = senses.flatMap(({ relations: senseRelations = [] }) => senseRelations);
  const searchForms = normalized.flatMap(({ search_forms: forms }) => forms);
  const starts = normalized.filter(({ role }) => role === 'start');
  return {
    record_count: normalized.length,
    sense_count: senses.length,
    relation_count: relations.length,
    search_form_count: searchForms.length,
    record_roles: countBy(normalized.map(({ role }) => role)),
    record_types: countBy(normalized.map(({ record_type }) => record_type)),
    senses_per_record: countBy(normalized.map(({ senses: recordSenses }) => recordSenses.length)),
    search_forms_per_record: countBy(normalized.map(({ search_forms: forms }) => forms.length)),
    parts_of_speech: countBy(senses.map(({ pos }) => pos)),
    relation_types: countBy(relations.map(({ type }) => type)),
    records_with_relations: normalized.filter(({ senses: recordSenses }) => (
      recordSenses.some(({ relations: senseRelations = [] }) => senseRelations.length > 0)
    )).length,
    start_records_with_non_lemma_search_forms: starts.filter(({ lemma, search_forms: forms }) => (
      forms.some((form) => form !== lemma)
    )).length,
    non_lemma_search_form_count: starts.reduce((count, { lemma, search_forms: forms }) => (
      count + forms.filter((form) => form !== lemma).length
    ), 0),
    average_lemma_codepoints: Math.round(normalized.reduce(
      (count, { lemma }) => count + [...lemma].length,
      0,
    ) / normalized.length * 100) / 100,
    average_gloss_codepoints: Math.round(senses.reduce(
      (count, { gloss }) => count + [...gloss].length,
      0,
    ) / senses.length * 100) / 100,
  };
}

function selectBenchmarkQueries(context) {
  const records = context.records.map(recordOf);
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const starts = records.filter(({ role }) => role === 'start');
  const exactRecord = starts.find(({ lemma, search_forms: forms }) => forms.includes(lemma));
  const searchFormRecord = starts.find(({ lemma, search_forms: forms }) => (
    forms.some((form) => form !== lemma)
  ));
  const ambiguousRecord = starts.find(({ senses }) => senses.length > 1);
  const surfaceProjection = context.derived?.surfaceFormProjection;
  const exactKeys = new Set(starts.flatMap(({ lemma, search_forms: forms }) => [lemma, ...forms]));
  const generatedRow = surfaceProjection?.rows.find((row) => (
    recordsById.get(row.record_id)?.role === 'start'
    && !exactKeys.has(row.form)
  )) ?? surfaceProjection?.rows.find((row) => (
    recordsById.get(row.record_id)?.role === 'start'
  ));

  if (!exactRecord || !searchFormRecord || !ambiguousRecord || !generatedRow) {
    throw new Error('The benchmark corpus is missing an exact, search-form, generated-surface, or multi-sense query');
  }

  return [
    { category: 'exact-lemma', term: exactRecord.lemma, expected_field: 'lemma' },
    {
      category: 'search-form',
      term: searchFormRecord.search_forms.find((form) => form !== searchFormRecord.lemma),
      expected_field: 'search-form',
    },
    {
      category: 'generated-surface-form',
      term: generatedRow.form,
      expected_field: 'generated-surface-form',
    },
    {
      category: 'ambiguous-multi-sense',
      term: ambiguousRecord.lemma,
      expected_field: ambiguousRecord.search_forms.includes(ambiguousRecord.lemma)
        ? 'lemma'
        : 'search-form',
      record_id: ambiguousRecord.id,
      expected_sense_count: ambiguousRecord.senses.length,
    },
  ];
}

async function measureSqliteWasm({ databasePath, queryCases, queriesPath }) {
  await writeFile(queriesPath, JSON.stringify(queryCases));
  const { stdout } = await execFile(process.execPath, [
    SQLITE_RUNTIME_BENCHMARK_PATH,
    `--database=${databasePath}`,
    `--queries-file=${queriesPath}`,
  ], {
    cwd: REPOSITORY_DIRECTORY,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function listFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(prefix, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await listFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      result.push({ path: relativePath, bytes: (await stat(absolutePath)).size });
    }
  }
  return result;
}

async function packageProductBuild(outputDirectory) {
  for (const publicAsset of ['favicon.ico', 'icon.png']) {
    await rm(path.join(outputDirectory, publicAsset), { force: true });
  }
  const outputFiles = await listFiles(outputDirectory);
  for (const { path: filePath } of outputFiles) {
    if (path.basename(filePath) === '.DS_Store') {
      await rm(path.join(outputDirectory, filePath), { force: true });
    }
  }
  for (const notice of RELEASE_PACKAGE_NOTICES) {
    await copyFile(
      path.join(REPOSITORY_DIRECTORY, notice),
      path.join(outputDirectory, notice),
    );
  }

  const files = await listFiles(outputDirectory);
  if (files.some(({ path: filePath }) => filePath.endsWith('.jsonl') || filePath.startsWith('canonical/'))) {
    throw new Error('synthetic or canonical JSONL leaked into the product package input');
  }
  const archivePath = path.join(path.dirname(outputDirectory), 'typewriter-release.zip');
  await execFile('zip', ['-qr', archivePath, '.', '-x', '*.DS_Store'], {
    cwd: outputDirectory,
    maxBuffer: 1024 * 1024,
  });
  const { stdout } = await execFile('python3', ['-c', [
    'import json, sys, zipfile',
    'archive = zipfile.ZipFile(sys.argv[1])',
    'dictionary = archive.getinfo("dictionary.sqlite")',
    'print(json.dumps({"archive_bytes": __import__("os").path.getsize(sys.argv[1]), "dictionary_uncompressed_bytes": dictionary.file_size, "dictionary_compressed_bytes": dictionary.compress_size, "entry_count": len(archive.infolist())}))',
  ].join('; '), archivePath], {
    maxBuffer: 1024 * 1024,
  });
  const archive = JSON.parse(stdout);
  const dictionaryPath = path.join(outputDirectory, 'dictionary.sqlite');
  const dictionaryBytes = (await stat(dictionaryPath)).size;
  const rawPackageBytes = files.reduce((total, { bytes }) => total + bytes, 0);
  if (archive.dictionary_uncompressed_bytes !== dictionaryBytes) {
    throw new Error('packaged SQLite size does not match the product dictionary');
  }
  return {
    raw_package_bytes: rawPackageBytes,
    zip_package_bytes: archive.archive_bytes,
    zip_entry_count: archive.entry_count,
    dictionary_bytes: dictionaryBytes,
    dictionary_compressed_bytes: archive.dictionary_compressed_bytes,
    dictionary_raw_package_share_percent: Math.round(dictionaryBytes / rawPackageBytes * 10000) / 100,
    dictionary_zip_package_share_percent: Math.round(archive.dictionary_compressed_bytes / archive.archive_bytes * 10000) / 100,
    synthetic_canonical_jsonl_excluded: true,
    package_is_temporary_benchmark_output: true,
  };
}

async function measureProductOutput({ context, databasePath, productDirectory, scaleDirectory }) {
  const outputStart = now();
  const sharedValidationStart = now();
  await validateSharedDictionary({ databasePath, canonicalContext: context });
  const databaseDigest = await sha256File(databasePath);
  const sharedValidationMs = elapsed(sharedValidationStart);
  const productBuildStart = now();
  await runProductBuild({ sharedDictionaryPath: databasePath, outputDirectory: productDirectory });
  const productDictionaryPath = path.join(productDirectory, 'dictionary.sqlite');
  const productDictionaryDigest = await sha256File(productDictionaryPath);
  if (productDictionaryDigest !== databaseDigest) {
    throw new Error('product build did not reuse the shared SQLite artifact');
  }
  const productBuildMs = elapsed(productBuildStart);
  const packageStart = now();
  const packageMetrics = await packageProductBuild(productDirectory);
  const packageBuildMs = elapsed(packageStart);
  const runtimeStart = now();
  const runtimeMetrics = await measureSqliteWasm({
    databasePath: productDictionaryPath,
    queryCases: selectBenchmarkQueries(context),
    queriesPath: path.join(scaleDirectory, 'runtime-query-cases.json'),
  });
  return {
    elapsed_ms: elapsed(outputStart),
    shared_database_validation_ms: sharedValidationMs,
    product_build_ms: productBuildMs,
    package_build_ms: packageBuildMs,
    runtime_measurement_ms: elapsed(runtimeStart),
    shared_sqlite_sha256: databaseDigest,
    product_dictionary_sha256: productDictionaryDigest,
    package: packageMetrics,
    sqlite_wasm_runtime: runtimeMetrics,
  };
}

async function benchmarkRealRelease({
  canonicalDirectory,
  canonicalContext,
  inputPreparationMs,
  canonicalInputBytes,
  benchmarkDirectory,
}) {
  const databasePath = path.join(benchmarkDirectory, 'dictionary.sqlite');
  const productDirectory = path.join(benchmarkDirectory, 'product');
  await mkdir(benchmarkDirectory, { recursive: true });

  const semanticAuditStart = now();
  const { artifact: semanticAudit, decisionSource } = await buildCanonicalSemanticAudit({
    canonicalDirectory,
    canonicalContext,
  });
  canonicalContext.semanticAudit = semanticAudit;
  canonicalContext.semanticDecisionSource = decisionSource;
  const semanticAuditMs = elapsed(semanticAuditStart);

  const normalizationStart = now();
  const normalizedModel = await normalizeCanonicalDirectory(canonicalDirectory, {
    canonicalContext,
    semanticAudit,
  });
  const normalizationMs = elapsed(normalizationStart);

  const buildStart = now();
  const buildSummary = await buildDictionary({
    inputDirectory: canonicalDirectory,
    outputPath: databasePath,
    canonicalContext,
    repositoryDirectory: REPOSITORY_DIRECTORY,
    allowDirty: true,
    semanticAudit,
    normalizedModel,
  });
  const sqliteBuildMs = elapsed(buildStart);

  const product = await measureProductOutput({
    context: canonicalContext,
    databasePath,
    productDirectory,
    scaleDirectory: benchmarkDirectory,
  });
  const buildWallClockMs = Math.round((inputPreparationMs + semanticAuditMs + normalizationMs + sqliteBuildMs) * 100) / 100;
  return {
    data_kind: 'real-current-canonical',
    input_record_count: canonicalContext.records.length,
    input_bytes: canonicalInputBytes,
    input_preparation_ms: inputPreparationMs,
    semantic_audit_ms: semanticAuditMs,
    normalization_ms: normalizationMs,
    sqlite_build_ms: sqliteBuildMs,
    canonical_to_sqlite_wall_clock_ms: buildWallClockMs,
    database_counts: {
      records: buildSummary.recordCount,
      senses: buildSummary.senseCount,
      search_forms: buildSummary.searchFormCount,
      relations: buildSummary.relationCount,
      generated_surface_forms: buildSummary.generatedSurfaceFormCount,
    },
    product_and_runtime: product,
  };
}

async function benchmarkEnvironment() {
  let sourceRevision = null;
  try {
    sourceRevision = (await execFile('git', ['rev-parse', 'HEAD'], {
      cwd: REPOSITORY_DIRECTORY,
      maxBuffer: 1024 * 1024,
    })).stdout.trim();
  } catch {
    // Environment details remain useful if the benchmark runs from a source archive.
  }
  const cpu = os.cpus()[0];
  return {
    measured_at_utc: new Date().toISOString(),
    source_revision: sourceRevision,
    node_version: process.version,
    sqlite_node_version: process.versions.sqlite ?? null,
    platform: process.platform,
    os_release: os.release(),
    architecture: process.arch,
    cpu_model: cpu?.model ?? null,
    logical_cpu_count: os.cpus().length,
    total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
    node_exec_args: process.execArgv,
  };
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
  releasePerformance = process.argv.includes('--release-performance'),
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
  const canonicalDirectory = path.join(REPOSITORY_DIRECTORY, 'data', 'canonical');
  const inputPreparationStart = now();
  const canonicalTemplateContext = await loadCanonicalContext({
    directory: canonicalDirectory,
    contextPath: null,
  });
  const templateInputPreparationMs = elapsed(inputPreparationStart);
  const templates = canonicalTemplateContext.records.map(recordOf);
  const templateIndexById = new Map(templates.map(({ id }, index) => [id, index]));
  const templateProfile = summarizeTemplateShape(templates);
  const canonicalInputBytes = (await listFiles(canonicalDirectory))
    .filter(({ path: filePath }) => filePath.endsWith('.jsonl'))
    .reduce((total, { bytes }) => total + bytes, 0);
  const root = await mkdtemp(path.join(os.tmpdir(), 'typewriter-canonical-benchmark-'));
  const results = [];
  let realReleaseBaseline = null;

  try {
    if (releasePerformance) {
      realReleaseBaseline = await benchmarkRealRelease({
        canonicalDirectory,
        canonicalContext: canonicalTemplateContext,
        inputPreparationMs: templateInputPreparationMs,
        canonicalInputBytes,
        benchmarkDirectory: path.join(root, 'real-5k'),
      });
    }

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
          templates,
          templateIndexById,
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
        result.synthetic_workload_shape = {
          template_record_count: templates.length,
          ...summarizeTemplateShape(context.records),
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
          const buildSummary = await buildDictionary({
            inputDirectory: canonicalDirectory,
            outputPath,
            canonicalContext: context,
            repositoryDirectory: REPOSITORY_DIRECTORY,
            allowDirty: true,
            semanticAudit,
            normalizedModel,
          });
          result.synthetic_workload_shape.generated_surface_form_count = buildSummary.generatedSurfaceFormCount;
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
          const productOutputDirectory = path.join(scaleDirectory, 'product');
          result.failure_stage = 'product-package-runtime';
          result.product_performance = await measureProductOutput({
            context,
            databasePath: outputPath,
            productDirectory: productOutputDirectory,
            scaleDirectory,
          });
          const normalEnd = now();
          result.corpus_cost.normal = {
            runner_category_order: CI_LEVEL_CATEGORY_ORDER.normal,
            wall_clock_ms: corpusElapsed(totalStart, normalEnd, result),
            continuation_ms: Math.round((normalEnd - normalStart) * 100) / 100,
            shared_sqlite_artifact_reused: true,
            product_dictionary_digest_matches: result.product_performance.product_dictionary_sha256
              === result.product_performance.shared_sqlite_sha256,
            sqlite_build_count: 0,
            corpus_phases: [
              'validateSharedDictionary',
              'product_extension_consumer',
              'release_zip_package_measurement',
              'sqlite_wasm_open_and_query_measurement',
            ],
          };

          const deepStart = now();
          const sharedDigest = result.product_performance.shared_sqlite_sha256;
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
          result.shared_sqlite_sha256 = result.product_performance.shared_sqlite_sha256;
          result.product_dictionary_sha256 = result.product_performance.product_dictionary_sha256;
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
    contract_version: 'canonical-validation-benchmark-v5',
    runner_wiring: 'same-process-shared-context-with-real-corpus-phases-and-level-continuation',
    synthetic_record_shape: {
      strategy: 'cycle the real canonical record/sense/search-form/relation shape, then replace IDs and all lexical strings with deterministic synthetic values',
      text_policy: 'preserve per-field Unicode codepoint lengths and record structure; do not copy canonical lemmas, glosses, notes, or IDs into synthetic JSONL',
      canonical_template_profile: templateProfile,
    },
    benchmark_setup: 'synthetic JSONL generation and synthetic authored-decision construction are fixture preparation; the product, package, and SQLite WASM runtime measurements run on temporary synthetic builds',
    runtime_environment: await benchmarkEnvironment(),
    release_performance_baseline: realReleaseBaseline,
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
