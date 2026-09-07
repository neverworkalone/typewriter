import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  REPOSITORY_DIRECTORY,
  validateBatchManifest,
} from './validate-batch.mjs';
import {
  summarizeRelationDiff,
  validateRelationDiff,
} from './relation-diff.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const BATCH_METRICS_SCHEMA = require('../../schema/batch-metrics.schema.json');
const metricsSchemaValidator = new Ajv2020({ allErrors: true }).compile(BATCH_METRICS_SCHEMA);

export const TIMING_PASS_IDS = Object.freeze([
  'target-preparation',
  'initial-review',
  'feedback-fixes',
  'final-audit',
  'held-rejected',
]);

const DECISIONS = Object.freeze(['included', 'corrected', 'held', 'rejected']);

export class BatchMetricsError extends Error {
  constructor(message, code = 'BATCH_METRICS_ERROR') {
    super(message);
    this.name = 'BatchMetricsError';
    this.code = code;
  }
}

function fail(message, code = 'BATCH_METRICS_ERROR') {
  throw new BatchMetricsError(message, code);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`, 'INVALID_VALUE');
  }
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function asRecordInfos(canonicalRecords) {
  if (!Array.isArray(canonicalRecords)) {
    fail('canonicalRecords must be an array', 'INVALID_CANONICAL_INPUT');
  }
  return canonicalRecords.map((item, index) => {
    if (item && typeof item === 'object' && item.record && typeof item.record === 'object') {
      return item;
    }
    if (item && typeof item === 'object') {
      return { record: item, path: '<inline>', line: index + 1 };
    }
    fail(`canonicalRecords[${index}] must contain a record`, 'INVALID_CANONICAL_INPUT');
  });
}

function countRelations(records) {
  const relationTypeCounts = {};
  let senseCount = 0;
  let relationCount = 0;
  let expressionCount = 0;
  for (const record of records) {
    if (record.record_type === 'expression') expressionCount += 1;
    for (const sense of record.senses) {
      senseCount += 1;
      for (const relation of sense.relations ?? []) {
        relationCount += 1;
        relationTypeCounts[relation.type] = (relationTypeCounts[relation.type] ?? 0) + 1;
      }
    }
  }
  return {
    senseCount,
    relationCount,
    expressionCount,
    relationTypeCounts,
  };
}

function deriveDecisions(manifest) {
  const selected = manifest.records.filter(
    (record) => record.source === 'inventory' && record.role === 'start',
  );
  const counts = Object.fromEntries(DECISIONS.map((decision) => [
    decision,
    selected.filter((record) => record.decision === decision).length,
  ]));
  const importable = counts.included + counts.corrected;
  return {
    selection: {
      selected_start_count: selected.length,
    },
    decisions: {
      ...counts,
      importable_start_count: importable,
      correction_rate_of_selected: ratio(counts.corrected, selected.length),
      correction_rate_of_importable: ratio(counts.corrected, importable),
      held_rate: ratio(counts.held, selected.length),
      rejected_rate: ratio(counts.rejected, selected.length),
      held_or_rejected_rate: ratio(counts.held + counts.rejected, selected.length),
      sense_field_correction_count: selected.filter(
        (record) => record.corrected_fields?.includes('senses'),
      ).length,
      relation_field_correction_count: selected.filter(
        (record) => record.corrected_fields?.includes('relations'),
      ).length,
    },
  };
}

function approvedCanonicalRecords(manifest, canonicalRecords) {
  const recordInfos = asRecordInfos(canonicalRecords);
  const recordsById = new Map(recordInfos.map((recordInfo) => [recordInfo.record.id, recordInfo.record]));
  const approved = manifest.records.filter(
    (record) => record.decision === 'included' || record.decision === 'corrected',
  );
  const importedRecords = approved.map((manifestRecord) => {
    const record = recordsById.get(manifestRecord.canonical_id);
    if (!record) {
      fail(
        `manifest canonical_id ${manifestRecord.canonical_id} is missing from canonical records`,
        'MISSING_CANONICAL_RECORD',
      );
    }
    return record;
  });
  return importedRecords;
}

function deriveCanonicalImport(manifest, canonicalRecords) {
  const importedRecords = approvedCanonicalRecords(manifest, canonicalRecords);
  const counts = countRelations(importedRecords);
  return {
    imported_start_count: importedRecords.filter(({ role }) => role === 'start').length,
    imported_reference_only_count: importedRecords.filter(({ role }) => role === 'reference-only').length,
    imported_record_count: importedRecords.length,
    imported_sense_count: counts.senseCount,
    imported_relation_count: counts.relationCount,
    imported_expression_count: counts.expressionCount,
    relation_type_counts: counts.relationTypeCounts,
  };
}

function relationTupleKey(sourceSense, relation) {
  return JSON.stringify([
    sourceSense,
    relation.target,
    relation.target_sense ?? null,
    relation.type,
  ]);
}

function validateRelationDiffAgainstCanonical(relationDiff, importedRecords) {
  const finalRelationTuples = new Set();
  for (const record of importedRecords) {
    for (const sense of record.senses) {
      for (const relation of sense.relations ?? []) {
        finalRelationTuples.add(relationTupleKey(sense.id, relation));
      }
    }
  }

  for (const event of relationDiff.events) {
    if (event.operation === 'add' || event.operation === 'retype' || event.operation === 'retarget') {
      if (!finalRelationTuples.has(relationTupleKey(event.source_sense, event.after))) {
        fail(
          `relation diff event ${event.event_id} after tuple is not present in approved canonical records`,
          'RELATION_AFTER_NOT_CANONICAL',
        );
      }
    }
    if (event.operation === 'remove' || event.operation === 'retype' || event.operation === 'retarget') {
      if (finalRelationTuples.has(relationTupleKey(event.source_sense, event.before))) {
        fail(
          `relation diff event ${event.event_id} before tuple remains in approved canonical records`,
          'RELATION_BEFORE_REMAINS',
        );
      }
    }
  }
}

function deriveTiming(measurement) {
  if (!measurement?.timing) fail('manifest.measurement.timing is required', 'MISSING_TIMING');
  const passes = measurement.timing.passes;
  const passById = new Map();
  for (const pass of passes) {
    if (passById.has(pass.id)) {
      fail(`timing contains duplicate pass ${pass.id}`, 'DUPLICATE_TIMING_PASS');
    }
    passById.set(pass.id, pass);
  }
  const missingPasses = TIMING_PASS_IDS.filter((id) => !passById.has(id));
  if (missingPasses.length > 0) {
    fail(`timing is missing pass(es): ${missingPasses.join(', ')}`, 'MISSING_TIMING_PASS');
  }

  const derivedPasses = {};
  const unmeasuredPasses = [];
  let allComplete = true;
  let totalWallClock = 0;
  let totalEditor = 0;
  for (const id of TIMING_PASS_IDS) {
    const pass = passById.get(id);
    const wallClock = pass.wall_clock_seconds ?? null;
    const editor = pass.editor_seconds ?? null;
    const complete = pass.status === 'complete'
      && Number.isFinite(wallClock)
      && Number.isFinite(editor);
    if (!complete) {
      allComplete = false;
      unmeasuredPasses.push(id);
    } else {
      totalWallClock += wallClock;
      totalEditor += editor;
    }
    derivedPasses[id] = {
      status: pass.status,
      wall_clock_seconds: wallClock,
      editor_seconds: editor,
    };
  }

  if (measurement.timing.status === 'complete' && !allComplete) {
    fail(
      `timing is declared complete but is missing wall-clock/editor measurements for ${unmeasuredPasses.join(', ')}`,
      'INCOMPLETE_TIMING',
    );
  }
  return {
    status: allComplete ? 'complete' : 'incomplete',
    passes: derivedPasses,
    total_wall_clock_seconds: allComplete ? totalWallClock : null,
    total_editor_seconds: allComplete ? totalEditor : null,
    unmeasured_passes: unmeasuredPasses,
  };
}

function deriveAudit(measurement) {
  if (!measurement?.audit) fail('manifest.measurement.audit is required', 'MISSING_AUDIT');
  const findings = measurement.audit.findings;
  const findingIds = new Set();
  const findingCounts = {};
  for (const finding of findings) {
    if (findingIds.has(finding.id)) {
      fail(`audit contains duplicate finding ${finding.id}`, 'DUPLICATE_AUDIT_FINDING');
    }
    findingIds.add(finding.id);
    findingCounts[finding.category] = (findingCounts[finding.category] ?? 0) + 1;
  }
  const openFindings = findings.filter((finding) => finding.status === 'open');
  const openBlockers = openFindings.filter((finding) => finding.severity === 'blocker');
  if (measurement.audit.status === 'complete' && !measurement.audit.independent && openBlockers.length > 0) {
    fail('a non-independent audit cannot report an open blocker as cleared', 'AUDIT_NOT_INDEPENDENT');
  }
  return {
    status: measurement.audit.status,
    independent: measurement.audit.independent,
    finding_count: findings.length,
    open_finding_count: openFindings.length,
    open_blocker_count: openBlockers.length,
    finding_counts: findingCounts,
  };
}

function validateMetricsSchema(metrics) {
  if (metricsSchemaValidator(metrics)) return;
  const error = metricsSchemaValidator.errors?.[0];
  fail(
    error ? `metrics schema validation failed at ${error.instancePath}: ${error.message}` : 'metrics schema validation failed',
    'SCHEMA_ERROR',
  );
}

export function deriveBatchMetrics({ manifest, relationDiff, canonicalRecords } = {}) {
  validateBatchManifest(manifest);
  validateRelationDiff(relationDiff);
  if (relationDiff.batch_id !== manifest.batch_id) {
    fail(
      `relation diff batch_id ${relationDiff.batch_id} does not match ${manifest.batch_id}`,
      'BATCH_ID_DRIFT',
    );
  }
  if (!manifest.measurement) {
    fail('manifest.measurement is required to derive metrics', 'MISSING_MEASUREMENT');
  }
  const unclassifiedEvents = relationDiff.events.filter(
    (event) => event.operation !== 'add' && !event.error_category,
  );
  if (unclassifiedEvents.length > 0) {
    fail(
      `relation diff contains ${unclassifiedEvents.length} unclassified non-add event(s)`,
      'UNCLASSIFIED_RELATION_EVENT',
    );
  }
  const decisions = deriveDecisions(manifest);
  const relationSummary = summarizeRelationDiff(relationDiff);
  const importedRecords = approvedCanonicalRecords(manifest, canonicalRecords);
  validateRelationDiffAgainstCanonical(relationDiff, importedRecords);
  const canonicalImport = deriveCanonicalImport(manifest, canonicalRecords);
  if (canonicalImport.imported_start_count !== decisions.decisions.importable_start_count) {
    fail(
      `canonical imported start count ${canonicalImport.imported_start_count} does not match manifest importable count ${decisions.decisions.importable_start_count}`,
      'CANONICAL_DECISION_COUNT_MISMATCH',
    );
  }
  if (canonicalImport.imported_relation_count !== relationSummary.after_count) {
    fail(
      `canonical imported relation count ${canonicalImport.imported_relation_count} does not match relation diff after_count ${relationSummary.after_count}`,
      'RELATION_AFTER_COUNT_MISMATCH',
    );
  }
  const derived = {
    ...decisions,
    canonical_import: canonicalImport,
    relation_diff: {
      before_count: relationSummary.before_count,
      after_count: relationSummary.after_count,
      added_count: relationSummary.added_count,
      removed_count: relationSummary.removed_count,
      retyped_count: relationSummary.retyped_count,
      retargeted_count: relationSummary.retargeted_count,
      changed_count: relationSummary.changed_count,
      net_removed_count: relationSummary.net_removed_count,
      noise_event_count: relationSummary.noise_event_count,
      noise_rate_of_before: relationSummary.noise_rate_of_before,
      classification_counts: relationSummary.classification_counts,
    },
    timing: deriveTiming(manifest.measurement),
    audit: deriveAudit(manifest.measurement),
  };
  const metrics = {
    schema_version: '2',
    batch_id: manifest.batch_id,
    derived,
  };
  validateMetricsSchema({
    ...metrics,
    source: {
      manifest: 'inline',
      relation_diff: 'inline',
      canonical_directory: 'inline',
    },
  });
  return derived;
}

export function createMetricsArtifact({
  manifest,
  relationDiff,
  canonicalRecords,
  source,
} = {}) {
  requireString(source?.manifest, 'source.manifest');
  requireString(source?.relation_diff, 'source.relation_diff');
  requireString(source?.canonical_directory, 'source.canonical_directory');
  const derived = deriveBatchMetrics({ manifest, relationDiff, canonicalRecords });
  const metrics = {
    schema_version: '2',
    batch_id: manifest.batch_id,
    source,
    derived,
  };
  validateMetricsSchema(metrics);
  return metrics;
}

export function assertMetricsMatch(expected, actual) {
  validateMetricsSchema(expected);
  validateMetricsSchema(actual);
  if (expected.batch_id !== actual.batch_id) {
    fail(`metrics batch_id mismatch: ${actual.batch_id} !== ${expected.batch_id}`, 'BATCH_ID_DRIFT');
  }
  try {
    assert.deepEqual(actual.source, expected.source);
    assert.deepEqual(actual.derived, expected.derived);
  } catch (error) {
    fail(`metrics source or derived values drift from source artifacts: ${error.message}`, 'METRICS_DRIFT');
  }
  return actual;
}

async function readJson(filePath, label) {
  let value;
  try {
    value = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${filePath}`, 'MISSING_INPUT');
    if (error instanceof SyntaxError) fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_JSON');
    throw error;
  }
  return value;
}

function relativeSourcePath(filePath) {
  const relative = path.relative(REPOSITORY_DIRECTORY, path.resolve(filePath));
  return relative || '.';
}

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) {
      fail(`arguments must use --name=value form (received ${argument})`, 'INVALID_ARGUMENT');
    }
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (!args.manifest) fail('--manifest is required', 'MISSING_ARGUMENT');
  const manifest = await readJson(args.manifest, 'batch manifest');
  validateBatchManifest(manifest);
  const relationDiffPath = args['relation-diff']
    ? path.resolve(args['relation-diff'])
    : path.resolve(REPOSITORY_DIRECTORY, manifest.measurement?.relation_diff?.artifact ?? '');
  if (!relationDiffPath || relationDiffPath === REPOSITORY_DIRECTORY) {
    fail('--relation-diff or manifest.measurement.relation_diff.artifact is required', 'MISSING_ARGUMENT');
  }
  const manifestRelationDiffPath = path.resolve(
    REPOSITORY_DIRECTORY,
    manifest.measurement.relation_diff.artifact,
  );
  if (relationDiffPath !== manifestRelationDiffPath) {
    fail(
      `relation diff path ${relationDiffPath} does not match manifest artifact ${manifestRelationDiffPath}`,
      'RELATION_DIFF_PATH_MISMATCH',
    );
  }
  const relationDiffText = await readFile(relationDiffPath, 'utf8');
  let relationDiff;
  try {
    relationDiff = JSON.parse(relationDiffText);
  } catch (error) {
    if (error instanceof SyntaxError) fail(`relation diff is not valid JSON: ${error.message}`, 'INVALID_JSON');
    throw error;
  }
  const expectedRelationDiffSha = manifest.measurement?.relation_diff?.sha256;
  if (expectedRelationDiffSha) {
    const actualRelationDiffSha = createHash('sha256').update(relationDiffText).digest('hex');
    if (actualRelationDiffSha !== expectedRelationDiffSha) {
      fail(
        `relation diff sha256 ${actualRelationDiffSha} does not match manifest ${expectedRelationDiffSha}`,
        'RELATION_DIFF_DIGEST_MISMATCH',
      );
    }
  }
  const canonicalDirectory = path.resolve(args['canonical-dir'] ?? DEFAULT_CANONICAL_DIRECTORY);
  const canonicalResult = await readCanonicalRecords(canonicalDirectory);
  const source = {
    manifest: relativeSourcePath(args.manifest),
    relation_diff: relativeSourcePath(relationDiffPath),
    canonical_directory: relativeSourcePath(canonicalDirectory),
  };
  const metrics = createMetricsArtifact({
    manifest,
    relationDiff,
    canonicalRecords: canonicalResult.records,
    source,
  });

  if (args.check) {
    const existing = await readJson(path.resolve(args.check), 'metrics artifact');
    assertMetricsMatch(metrics, existing);
    console.log(`Metrics match source artifacts for ${metrics.batch_id}.`);
    return existing;
  }
  if (!args.output) fail('--output or --check is required', 'MISSING_ARGUMENT');
  const outputPath = path.resolve(args.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
  console.log(`Wrote derived metrics for ${metrics.batch_id} to ${outputPath}.`);
  return metrics;
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
