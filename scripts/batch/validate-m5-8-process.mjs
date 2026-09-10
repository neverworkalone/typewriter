import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';
import {
  assertMetricsMatch,
  createMetricsArtifact,
} from './derive-metrics.mjs';
import { validateRelationDiff } from './relation-diff.mjs';
import {
  REPOSITORY_DIRECTORY,
  validateBatchManifest,
} from './validate-batch.mjs';
import { loadAndValidateRepairAuthorization } from './repair-authorization.mjs';
import { validateRelationScreen } from './relation-screen.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PLAN_SCHEMA = require('../../schema/m5-8-expansion-plan.schema.json');
const REGRESSION_SCHEMA = require('../../schema/m5-8-process-regression.schema.json');
const STAGE_REPORT_SCHEMA = require('../../schema/m5-8-stage-report.schema.json');
const STAGE_VERIFICATION_SCHEMA = require('../../schema/m5-8-stage-verification.schema.json');
const planSchemaValidator = new Ajv2020({ allErrors: true }).compile(PLAN_SCHEMA);
const regressionSchemaValidator = new Ajv2020({ allErrors: true }).compile(REGRESSION_SCHEMA);
const stageReportSchemaValidator = new Ajv2020({ allErrors: true }).compile(STAGE_REPORT_SCHEMA);
const stageVerificationSchemaValidator = new Ajv2020({ allErrors: true }).compile(STAGE_VERIFICATION_SCHEMA);

export const DEFAULT_PLAN_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-8-expansion-plan.json',
);
export const DEFAULT_FIXTURE_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../tests/fixtures/m5-8-process-regressions.json',
);
export const DEFAULT_RELATION_DIFF_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-7-recalibration-relation-diff.json',
);
const SOURCE_ARTIFACT_VALIDATION_VERSION = 'm5-8-source-artifacts-v1';

const EXPECTED_LADDER = Object.freeze([
  { sequence: 1, target_net_start_increase: 100, cumulative_start_target: 528 },
  { sequence: 2, target_net_start_increase: 250, cumulative_start_target: 778 },
  { sequence: 3, target_net_start_increase: 500, cumulative_start_target: 1278 },
  { sequence: 4, target_net_start_increase: 722, cumulative_start_target: 2000 },
  { sequence: 5, target_net_start_increase: 1000, cumulative_start_target: 3000 },
  { sequence: 6, target_net_start_increase: 1000, cumulative_start_target: 4000 },
  { sequence: 7, target_net_start_increase: 1000, cumulative_start_target: 5000 },
]);

const EXPECTED_REPAIR_RESUME = Object.freeze({
  parent_stage_id: 'm5-8-stage-02-plus-250',
  composite_net_start_increase: 250,
  composite_cumulative_start_target: 778,
  wave_a: {
    stage_id: 'm5-9a-wave-a-plus-50',
    target_net_start_increase: 50,
    cumulative_start_target: 578,
    previous_stage_id: 'm5-8-stage-01-plus-100',
    requires_repair_authorization: true,
  },
  wave_b: {
    stage_id: 'm5-9a-wave-b-plus-200',
    target_net_start_increase: 200,
    cumulative_start_target: 778,
    previous_wave_id: 'm5-9a-wave-a-plus-50',
    requires_repair_authorization: false,
  },
  rejoin_stage: {
    stage_id: 'm5-8-stage-03-plus-500',
    previous_stage_id: 'm5-9a-wave-b-plus-200',
    required_previous_cumulative_start_target: 778,
    requires_wave_b_pass: true,
  },
});

const EXPECTED_CANONICAL_BASELINE = Object.freeze({
  record_count: 470,
  start_count: 428,
  reference_only_count: 42,
  sense_count: 557,
  relation_count: 449,
  expression_count: 23,
});

function isM58BaselineRecord({ record }) {
  return record.role === 'reference-only'
    || (record.id.startsWith('w') && Number(record.id.slice(1)) <= 428);
}

const EXPECTED_PHASE_ORDER = Object.freeze([
  'target-preparation',
  'sense-review',
  'relation-review',
  'independent-audit',
  'gate-and-promotion',
]);

const EXPECTED_M5_3_RELATION_BASELINE = Object.freeze({
  noise_event_count: 51,
  before_count: 139,
});

const A2_REPAIR_STAGE = Object.freeze({
  stage_id: 'm5-10a-wave-a2-plus-50',
  target_net_start_increase: 50,
  cumulative_start_target: 628,
  previous_stage_id: 'm5-9a-wave-a-plus-50',
  requires_repair_authorization: true,
});

const EXPECTED_SENSE_REGRESSIONS = Object.freeze([
  { canonical_id: 'w405', expected_sense_count: 2, expected_pos: ['adjective', 'adjective'] },
  { canonical_id: 'w406', expected_sense_count: 1, expected_pos: ['verb'] },
  { canonical_id: 'w410', expected_sense_count: 3, expected_pos: ['adjective', 'adjective', 'adjective'] },
  { canonical_id: 'w420', expected_sense_count: 2, expected_pos: ['verb', 'verb'] },
  { canonical_id: 'w421', expected_sense_count: 2, expected_pos: ['verb', 'verb'] },
]);

export class M58ProcessValidationError extends Error {
  constructor(message, code = 'M58_PROCESS_VALIDATION_ERROR') {
    super(message);
    this.name = 'M58ProcessValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M58_PROCESS_VALIDATION_ERROR') {
  throw new M58ProcessValidationError(message, code);
}

function assertEqual(actual, expected, message, code = 'M58_PROCESS_VALIDATION_ERROR') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`, code);
  }
}

function assertNear(actual, expected, message, code = 'M58_PROCESS_VALIDATION_ERROR') {
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || Math.abs(actual - expected) > 1e-9) {
    fail(`${message}: expected ${expected}, received ${actual}`, code);
  }
}

function assertCondition(condition, message, code = 'M58_PROCESS_VALIDATION_ERROR') {
  if (!condition) fail(message, code);
}

function sortedValues(values) {
  return [...values].sort();
}

function schemaErrorPath(error, root) {
  const pathParts = error.instancePath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (error.keyword === 'required') pathParts.push(error.params.missingProperty);
  if (error.keyword === 'additionalProperties') pathParts.push(error.params.additionalProperty);
  return pathParts.reduce(
    (result, part) => (/^\d+$/u.test(part) ? `${result}[${part}]` : `${result}.${part}`),
    root,
  );
}

function validateSchema(value, validator, root, label) {
  if (validator(value)) return;
  const error = validator.errors?.[0];
  const detail = error
    ? `${schemaErrorPath(error, root)} ${error.message}`
    : `${root} does not match its schema`;
  fail(`${label} schema validation failed: ${detail}`, 'SCHEMA_ERROR');
}

export function validateExpansionPlan(plan) {
  validateSchema(plan, planSchemaValidator, 'plan', 'M5-8 expansion plan');

  assertEqual(plan.workflow.phase_order, EXPECTED_PHASE_ORDER, 'plan phase order drift', 'PHASE_ORDER_DRIFT');
  assertEqual(plan.canonical_baseline, EXPECTED_CANONICAL_BASELINE, 'canonical baseline drift', 'BASELINE_DRIFT');
  assertEqual(
    plan.gate.relation_noise_baseline,
    EXPECTED_M5_3_RELATION_BASELINE,
    'M5-3 relation-noise baseline drift',
    'GATE_DRIFT',
  );
  assertEqual(
    plan.repair_resume,
    EXPECTED_REPAIR_RESUME,
    'repair resume wave contract drift',
    'REPAIR_RESUME_DRIFT',
  );

  const seenSequences = new Set();
  const seenStageIds = new Set();
  let cumulativeStartCount = plan.canonical_baseline.start_count;
  for (const [index, stage] of plan.ladder.entries()) {
    const expected = EXPECTED_LADDER[index];
    assertCondition(!seenSequences.has(stage.sequence), `duplicate ladder sequence ${stage.sequence}`, 'DUPLICATE_STAGE');
    assertCondition(!seenStageIds.has(stage.stage_id), `duplicate ladder stage ${stage.stage_id}`, 'DUPLICATE_STAGE');
    seenSequences.add(stage.sequence);
    seenStageIds.add(stage.stage_id);
    assertEqual(stage.sequence, expected.sequence, `ladder stage ${index + 1} sequence drift`, 'LADDER_DRIFT');
    assertEqual(
      stage.target_net_start_increase,
      expected.target_net_start_increase,
      `${stage.stage_id} target drift`,
      'LADDER_DRIFT',
    );
    cumulativeStartCount += stage.target_net_start_increase;
    assertEqual(
      stage.cumulative_start_target,
      cumulativeStartCount,
      `${stage.stage_id} cumulative target does not equal the base plus net increases`,
      'CUMULATIVE_TARGET_MISMATCH',
    );
    assertEqual(
      stage.cumulative_start_target,
      expected.cumulative_start_target,
      `${stage.stage_id} cumulative target drift`,
      'LADDER_DRIFT',
    );
  }

  return {
    plan_id: plan.plan_id,
    phase_order: [...plan.workflow.phase_order],
    partition: {
      ...plan.workflow.partition,
      rework_boundaries: [...plan.workflow.partition.rework_boundaries],
    },
    stage_report: {
      ...plan.workflow.stage_report,
      required_sections: [...plan.workflow.stage_report.required_sections],
      source_artifacts: [...plan.workflow.stage_report.source_artifacts],
    },
    ladder: plan.ladder.map((stage) => ({ ...stage })),
    repair_resume: structuredClone(plan.repair_resume),
    gate: { ...plan.gate },
  };
}

export function validateReviewCheckpoint(checkpoint) {
  assertCondition(checkpoint && typeof checkpoint === 'object', 'review checkpoint must be an object', 'INVALID_CHECKPOINT');
  assertCondition(
    ['not-started', 'in-review', 'complete', 'held', 'rejected'].includes(checkpoint.sense_status),
    `invalid sense checkpoint status ${String(checkpoint.sense_status)}`,
    'INVALID_CHECKPOINT',
  );
  assertCondition(
    ['not-started', 'in-review', 'complete'].includes(checkpoint.relation_status),
    `invalid relation checkpoint status ${String(checkpoint.relation_status)}`,
    'INVALID_CHECKPOINT',
  );
  assertCondition(
    Number.isInteger(checkpoint.relation_output_count) && checkpoint.relation_output_count >= 0,
    'relation_output_count must be a non-negative integer',
    'INVALID_CHECKPOINT',
  );

  if (checkpoint.sense_status !== 'complete') {
    assertEqual(
      checkpoint.relation_status,
      'not-started',
      'relation review cannot start before sense/POS review is complete',
      'RELATION_BEFORE_SENSE',
    );
    assertEqual(
      checkpoint.relation_output_count,
      0,
      'relation output must remain empty before sense/POS review is complete',
      'RELATION_BEFORE_SENSE',
    );
  }
  if (checkpoint.relation_status === 'not-started') {
    assertEqual(
      checkpoint.relation_output_count,
      0,
      'relation output must be empty while relation review is not started',
      'RELATION_OUTPUT_BEFORE_REVIEW',
    );
  }

  return {
    sense_status: checkpoint.sense_status,
    relation_status: checkpoint.relation_status,
    relation_output_count: checkpoint.relation_output_count,
  };
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function sha256File(filePath) {
  return sha256Bytes(await readFile(filePath));
}

function resolveSourcePath(sourcePath, label) {
  assertCondition(
    typeof sourcePath === 'string' && sourcePath.trim().length > 0,
    `${label} must be a non-empty path`,
    'SOURCE_PATH_MISMATCH',
  );
  return path.resolve(REPOSITORY_DIRECTORY, sourcePath);
}

async function readSourceFile(filePath, label) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(`${label} does not exist: ${filePath}`, 'MISSING_SOURCE_ARTIFACT');
    }
    if (error.code === 'EISDIR') {
      fail(`${label} must be a file: ${filePath}`, 'INVALID_SOURCE_ARTIFACT');
    }
    throw error;
  }
}

async function readSourceJson(filePath, label) {
  const bytes = await readSourceFile(filePath, label);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_SOURCE_JSON');
    }
    throw error;
  }
  return { value, sha256: sha256Bytes(bytes) };
}

async function collectCanonicalFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(`canonical directory does not exist: ${directory}`, 'MISSING_SOURCE_ARTIFACT');
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectCanonicalFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
  return files;
}

export async function hashCanonicalDirectory(directory) {
  let directoryStat;
  try {
    directoryStat = await stat(directory);
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(`canonical directory does not exist: ${directory}`, 'MISSING_SOURCE_ARTIFACT');
    }
    throw error;
  }
  if (!directoryStat.isDirectory()) {
    fail(`canonical source is not a directory: ${directory}`, 'INVALID_SOURCE_ARTIFACT');
  }

  const files = (await collectCanonicalFiles(directory)).sort();
  const digest = createHash('sha256');
  for (const filePath of files) {
    const relativePath = path.relative(directory, filePath);
    digest.update(relativePath, 'utf8');
    digest.update(Buffer.from([0]));
    digest.update(await readSourceFile(filePath, `canonical file ${relativePath}`));
    digest.update(Buffer.from([0]));
  }
  return digest.digest('hex');
}

async function readCanonicalSource(directory) {
  const canonicalSha256 = await hashCanonicalDirectory(directory);
  let canonicalResult;
  try {
    canonicalResult = await readCanonicalRecords(directory);
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(`canonical directory does not exist: ${directory}`, 'MISSING_SOURCE_ARTIFACT');
    }
    throw error;
  }
  return { ...canonicalResult, sha256: canonicalSha256 };
}

function stageMetricsFromArtifacts(metricsArtifact, verification) {
  const { decisions, relation_diff: relationDiff, timing, audit } = metricsArtifact.derived;
  const processedStartCount = metricsArtifact.derived.selection.processed_start_count
    ?? metricsArtifact.derived.selection.selected_start_count;
  const totalEditorSeconds = timing.total_editor_seconds;
  const hasEditorialReviewFlag = Object.hasOwn(verification, 'editorial_review_complete');
  const metrics = {
    correction_rate_of_selected: decisions.correction_rate_of_selected,
    relation_noise_rate_of_before: relationDiff.noise_rate_of_before,
    ...(relationDiff.candidate_count !== undefined
      ? {
        relation_noise_candidate_count: relationDiff.candidate_count,
        relation_noise_rate_of_candidates: relationDiff.noise_rate_of_candidates,
      }
      : {}),
    total_wall_clock_seconds: timing.total_wall_clock_seconds,
    measured_wall_clock_seconds: timing.measured_wall_clock_seconds,
    total_editor_seconds: totalEditorSeconds,
    measured_editor_seconds: timing.measured_editor_seconds,
    editor_seconds_per_selected_start: totalEditorSeconds === null || processedStartCount === 0
      ? null
      : totalEditorSeconds / processedStartCount,
    ...(timing.measurement_kind === 'producer-throughput'
      ? {
        measurement_kind: timing.measurement_kind,
        producer_seconds_per_selected_start_max: timing.producer_seconds_per_selected_start_max,
        total_producer_seconds: timing.total_producer_seconds,
        measured_producer_seconds: timing.measured_producer_seconds,
        producer_seconds_per_selected_start: timing.total_producer_seconds === null || processedStartCount === 0
          ? null
          : timing.total_producer_seconds / processedStartCount,
        editor_time_status: timing.editor_time_status,
      }
      : {}),
    timing_status: timing.status,
    unmeasured_timing_pass_count: timing.unmeasured_passes.length,
    audit_status: audit.status,
    audit_independent: audit.independent,
    open_audit_blocker_count: audit.open_blocker_count,
    ...(hasEditorialReviewFlag
      ? { editorial_review_complete: verification.editorial_review_complete }
      : {}),
    ...(Object.hasOwn(verification, 'human_editorial_review_complete')
      ? { human_editorial_review_complete: verification.human_editorial_review_complete }
      : {}),
    canonical_integrity: verification.canonical_integrity,
    deterministic_sqlite: verification.deterministic_sqlite,
    search_product_regression: verification.search_product_regression,
  };
  return metrics;
}

function stageDecisionsFromArtifacts(metricsArtifact) {
  const { decisions } = metricsArtifact.derived;
  if (metricsArtifact.derived.canonical_import.import_status === 'proposed') {
    return {
      included_start_count: 0,
      corrected_start_count: 0,
      held_start_count: decisions.held,
      rejected_start_count: decisions.rejected,
      deferred_start_count: decisions.deferred ?? 0,
      proposed_start_count: decisions.importable_start_count,
    };
  }
  return {
    included_start_count: decisions.included,
    corrected_start_count: decisions.corrected,
    held_start_count: decisions.held,
    rejected_start_count: decisions.rejected,
    deferred_start_count: decisions.deferred ?? 0,
  };
}

function proposalDecisionsFromArtifacts(metricsArtifact) {
  if (metricsArtifact.derived.canonical_import.import_status !== 'proposed') return undefined;
  const { decisions } = metricsArtifact.derived;
  return {
    included_start_count: decisions.included,
    corrected_start_count: decisions.corrected,
    held_start_count: decisions.held,
    rejected_start_count: decisions.rejected,
    deferred_start_count: decisions.deferred ?? 0,
  };
}

export async function loadExpansionStageSources(
  stage,
  { canonicalDirectoryOverride } = {},
) {
  validateSchema(stage, stageReportSchemaValidator, 'stage', 'M5-8 stage report');

  const sourcePaths = {
    manifest: resolveSourcePath(stage.source.manifest, 'stage.source.manifest'),
    metrics: resolveSourcePath(stage.source.metrics, 'stage.source.metrics'),
    relation_diff: resolveSourcePath(stage.source.relation_diff, 'stage.source.relation_diff'),
    ...(stage.source.relation_screen
      ? { relation_screen: resolveSourcePath(stage.source.relation_screen, 'stage.source.relation_screen') }
      : {}),
    canonical_directory: resolveSourcePath(
      stage.source.canonical_directory,
      'stage.source.canonical_directory',
    ),
    verification: resolveSourcePath(stage.source.verification, 'stage.source.verification'),
  };
  const canonicalReadDirectory = canonicalDirectoryOverride ?? sourcePaths.canonical_directory;
  const [manifestArtifact, metricsArtifact, relationDiffArtifact, verificationArtifact, canonical, relationScreenArtifact] = await Promise.all([
    readSourceJson(sourcePaths.manifest, 'stage manifest'),
    readSourceJson(sourcePaths.metrics, 'stage metrics artifact'),
    readSourceJson(sourcePaths.relation_diff, 'stage relation diff'),
    readSourceJson(sourcePaths.verification, 'stage verification artifact'),
    readCanonicalSource(canonicalReadDirectory),
    sourcePaths.relation_screen
      ? readSourceJson(sourcePaths.relation_screen, 'stage relation screen artifact')
      : Promise.resolve(undefined),
  ]);

  validateBatchManifest(manifestArtifact.value);
  validateRelationDiff(relationDiffArtifact.value);
  validateSchema(
    verificationArtifact.value,
    stageVerificationSchemaValidator,
    'stage verification',
    'M5-8 stage verification',
  );

  const manifestRelationDiffPath = resolveSourcePath(
    manifestArtifact.value.measurement?.relation_diff?.artifact,
    'manifest.measurement.relation_diff.artifact',
  );
  assertEqual(
    manifestRelationDiffPath,
    sourcePaths.relation_diff,
    'stage relation diff path does not match the manifest artifact',
    'SOURCE_PATH_MISMATCH',
  );
  assertEqual(
    relationDiffArtifact.sha256,
    manifestArtifact.value.measurement.relation_diff.sha256,
    'relation diff digest does not match the manifest',
    'RELATION_DIFF_DIGEST_MISMATCH',
  );
  if (relationScreenArtifact) {
    validateRelationScreen(
      relationScreenArtifact.value,
      relationDiffArtifact.value,
      {
        relationDiffPath: path.relative(REPOSITORY_DIRECTORY, sourcePaths.relation_diff),
        relationDiffSha256: relationDiffArtifact.sha256,
      },
    );
  }

  const metricsSource = metricsArtifact.value.source;
  for (const [key, label] of [
    ['manifest', 'metrics.source.manifest'],
    ['relation_diff', 'metrics.source.relation_diff'],
    ['canonical_directory', 'metrics.source.canonical_directory'],
  ]) {
    assertEqual(
      resolveSourcePath(metricsSource[key], label),
      sourcePaths[key],
      `${label} does not match the stage source`,
      'SOURCE_PATH_MISMATCH',
    );
  }

  const regeneratedMetrics = createMetricsArtifact({
    manifest: manifestArtifact.value,
    relationDiff: relationDiffArtifact.value,
    canonicalRecords: canonical.records,
    source: metricsSource,
  });
  assertMetricsMatch(metricsArtifact.value, regeneratedMetrics);

  const actualDigests = {
    manifest_sha256: manifestArtifact.sha256,
    metrics_sha256: metricsArtifact.sha256,
    relation_diff_sha256: relationDiffArtifact.sha256,
    canonical_sha256: canonical.sha256,
    verification_sha256: verificationArtifact.sha256,
  };
  if (relationScreenArtifact) {
    actualDigests.relation_screen_sha256 = relationScreenArtifact.sha256;
  }
  for (const [key, actualDigest] of Object.entries(actualDigests)) {
    assertEqual(
      actualDigest,
      stage.source[key],
      `${key} does not match the stage source artifact`,
      'SOURCE_DIGEST_MISMATCH',
    );
  }

  const proposalDecisions = proposalDecisionsFromArtifacts(metricsArtifact.value);
  return {
    validation: SOURCE_ARTIFACT_VALIDATION_VERSION,
    paths: sourcePaths,
    digests: actualDigests,
    inventory_revision: manifestArtifact.value.inventory_revision,
    selected_start_count: metricsArtifact.value.derived.selection.selected_start_count,
    processed_start_count: metricsArtifact.value.derived.selection.processed_start_count
      ?? metricsArtifact.value.derived.selection.selected_start_count,
    decisions: stageDecisionsFromArtifacts(metricsArtifact.value),
    ...(proposalDecisions ? { proposal_decisions: proposalDecisions } : {}),
    imported_start_count: metricsArtifact.value.derived.canonical_import.imported_start_count,
    canonical_snapshot: canonicalSummary(canonical.records),
    metrics: stageMetricsFromArtifacts(metricsArtifact.value, verificationArtifact.value),
  };
}

function validateLoadedStageSources(stage, sourceArtifacts) {
  assertCondition(
    sourceArtifacts && typeof sourceArtifacts === 'object',
    'stage source artifacts must be loaded and validated before stage arithmetic',
    'SOURCE_ARTIFACTS_REQUIRED',
  );
  assertEqual(
    sourceArtifacts.validation,
    SOURCE_ARTIFACT_VALIDATION_VERSION,
    'stage source artifacts were not validated by the M5-8 source loader',
    'SOURCE_ARTIFACTS_UNVERIFIED',
  );

  for (const key of ['manifest', 'metrics', 'relation_diff', 'canonical_directory', 'verification']) {
    assertEqual(
      resolveSourcePath(stage.source[key], `stage.source.${key}`),
      resolveSourcePath(sourceArtifacts.paths?.[key], `loaded source.${key}`),
      `stage.source.${key} does not match the loaded source path`,
      'SOURCE_PATH_MISMATCH',
    );
  }
  for (const key of [
    'manifest_sha256',
    'metrics_sha256',
    'relation_diff_sha256',
    'canonical_sha256',
    'verification_sha256',
  ]) {
    assertEqual(
      stage.source[key],
      sourceArtifacts.digests?.[key],
      `stage.source.${key} does not match the loaded source digest`,
      'SOURCE_DIGEST_MISMATCH',
    );
  }
  if (stage.source.relation_screen) {
    assertEqual(
      resolveSourcePath(stage.source.relation_screen, 'stage.source.relation_screen'),
      resolveSourcePath(sourceArtifacts.paths?.relation_screen, 'loaded source.relation_screen'),
      'stage.source.relation_screen does not match the loaded source path',
      'SOURCE_PATH_MISMATCH',
    );
    assertEqual(
      stage.source.relation_screen_sha256,
      sourceArtifacts.digests?.relation_screen_sha256,
      'stage.source.relation_screen_sha256 does not match the loaded source digest',
      'SOURCE_DIGEST_MISMATCH',
    );
  }

  assertEqual(
    stage.input.inventory_revision,
    sourceArtifacts.inventory_revision,
    `${stage.stage_id} input inventory revision drifted from the manifest`,
    'SOURCE_INVENTORY_REVISION_MISMATCH',
  );
  assertEqual(
    stage.target.selected_start_count,
    sourceArtifacts.selected_start_count,
    `${stage.stage_id} selected count drifted from the manifest metrics`,
    'SOURCE_SELECTION_DRIFT',
  );
  assertEqual(
    stage.decisions,
    sourceArtifacts.decisions,
    `${stage.stage_id} decisions drifted from the manifest metrics`,
    'SOURCE_DECISION_DRIFT',
  );
  if (stage.proposal_decisions !== undefined) {
    assertEqual(
      stage.proposal_decisions,
      sourceArtifacts.proposal_decisions,
      `${stage.stage_id} proposal decisions drifted from the manifest metrics`,
      'SOURCE_PROPOSAL_DECISION_DRIFT',
    );
  } else {
    assertCondition(
      sourceArtifacts.proposal_decisions === undefined,
      `${stage.stage_id} unexpectedly contains proposal decisions`,
      'SOURCE_PROPOSAL_DECISION_DRIFT',
    );
  }
  assertEqual(
    stage.actual.imported_start_count,
    sourceArtifacts.imported_start_count,
    `${stage.stage_id} imported start count drifted from the canonical import`,
    'SOURCE_IMPORT_DRIFT',
  );
  assertEqual(
    stage.actual.canonical_snapshot,
    sourceArtifacts.canonical_snapshot,
    `${stage.stage_id} canonical snapshot drifted from the canonical directory`,
    'SOURCE_CANONICAL_SNAPSHOT_DRIFT',
  );
  assertEqual(
    stage.metrics,
    sourceArtifacts.metrics,
    `${stage.stage_id} metrics drifted from source artifacts`,
    'SOURCE_METRIC_DRIFT',
  );
}

function resolveStageContext(stage, plan) {
  const ladderIndex = plan.ladder.findIndex(({ stage_id: stageId }) => stageId === stage.stage_id);
  if (ladderIndex !== -1) {
    const previousStageId = ladderIndex === 0 ? null : plan.ladder[ladderIndex - 1].stage_id;
    const isRepairRejoin = stage.stage_id === plan.repair_resume.rejoin_stage.stage_id;
    return {
      kind: isRepairRejoin ? 'ladder-rejoin' : 'ladder',
      contract: plan.ladder[ladderIndex],
      ladderIndex,
      previousStageId,
      previousStageIds: previousStageId === null
        ? []
        : [
          previousStageId,
          ...(isRepairRejoin ? [plan.repair_resume.rejoin_stage.previous_stage_id] : []),
        ],
      repairRejoin: isRepairRejoin ? plan.repair_resume.rejoin_stage : undefined,
      baseStartCount: ladderIndex === 0
        ? plan.canonical_baseline.start_count
        : plan.ladder[ladderIndex - 1].cumulative_start_target,
    };
  }

  const parentStageIndex = plan.ladder.findIndex(
    ({ stage_id: stageId }) => stageId === plan.repair_resume.parent_stage_id,
  );
  const { wave_a: waveA, wave_b: waveB } = plan.repair_resume;
  if (stage.stage_id === A2_REPAIR_STAGE.stage_id) {
    return {
      kind: 'repair-wave-a2',
      contract: A2_REPAIR_STAGE,
      ladderIndex: parentStageIndex,
      previousStageId: A2_REPAIR_STAGE.previous_stage_id,
      previousStageIds: [A2_REPAIR_STAGE.previous_stage_id],
      baseStartCount: A2_REPAIR_STAGE.cumulative_start_target - A2_REPAIR_STAGE.target_net_start_increase,
    };
  }
  if (stage.stage_id === waveA.stage_id) {
    return {
      kind: 'repair-wave-a',
      contract: waveA,
      ladderIndex: parentStageIndex,
      previousStageId: waveA.previous_stage_id,
      previousStageIds: [waveA.previous_stage_id],
      baseStartCount: plan.ladder[parentStageIndex - 1].cumulative_start_target,
    };
  }
  if (stage.stage_id === waveB.stage_id) {
    return {
      kind: 'repair-wave-b',
      contract: waveB,
      ladderIndex: parentStageIndex,
      previousStageId: waveB.previous_wave_id,
      previousStageIds: [waveB.previous_wave_id],
      baseStartCount: waveA.cumulative_start_target,
    };
  }
  assertCondition(
    false,
    `stage ${String(stage.stage_id)} is not in the M5-8 ladder or repair resume waves`,
    'UNKNOWN_STAGE',
  );
}

async function validatePreviousStageReport(stage, plan, stageContext, visitedStageIds) {
  if (!stageContext.previousStageId) {
    assertCondition(
      !stage.input.previous_stage_report,
      `${stage.stage_id} cannot reference a previous stage report`,
      'UNEXPECTED_PREVIOUS_STAGE',
    );
    assertCondition(
      !stage.input.repair_authorization,
      `${stage.stage_id} cannot reference a repair authorization without a previous stage report`,
      'UNEXPECTED_REPAIR_AUTHORIZATION',
    );
    return;
  }

  const reference = stage.input.previous_stage_report;
  assertCondition(
    reference,
    `${stage.stage_id} must reference the previous stage report`,
    'MISSING_PREVIOUS_STAGE',
  );
  const previousPath = resolveSourcePath(reference.path, `${stage.stage_id}.input.previous_stage_report.path`);
  assertCondition(
    !visitedStageIds.has(previousPath),
    `${stage.stage_id} previous-stage report chain contains a cycle`,
    'STAGE_CHAIN_CYCLE',
  );
  const previousArtifact = await readSourceJson(previousPath, 'previous stage report');
  assertEqual(
    previousArtifact.sha256,
    reference.sha256,
    `${stage.stage_id} previous stage report digest mismatch`,
    'STAGE_CHAIN_DIGEST_MISMATCH',
  );
  const previousStage = previousArtifact.value;
  validateSchema(previousStage, stageReportSchemaValidator, 'previous_stage', 'previous M5-8 stage report');
  assertCondition(
    stageContext.previousStageIds.includes(previousStage.stage_id),
    `${stage.stage_id} previous stage report does not match the allowed process chain`,
    'STAGE_CHAIN_MISMATCH',
  );
  if (stageContext.kind === 'repair-wave-a' || stageContext.kind === 'repair-wave-a2') {
    assertEqual(
      previousStage.gate_status,
      'fail',
      `${stage.stage_id} repair wave must directly resume the failed stage`,
      'REPAIR_PREVIOUS_STAGE_GATE_FAILURE',
    );
    const repairReference = stage.input.repair_authorization;
    assertCondition(
      repairReference,
      `${stage.stage_id} must reference a valid repair authorization`,
      'MISSING_REPAIR_AUTHORIZATION',
    );
    const repairPath = resolveSourcePath(
      repairReference.path,
      `${stage.stage_id}.input.repair_authorization.path`,
    );
    const repairAuthorization = await loadAndValidateRepairAuthorization({
      authorizationPath: repairPath,
      authorizationSha256: repairReference.sha256,
      failedStage: previousStage,
      failedStagePath: previousPath,
      failedStageSha256: previousArtifact.sha256,
    });
    assertEqual(
      stage.target.net_start_increase,
      repairAuthorization.net_start_increase,
      `${stage.stage_id} target exceeds the repair authorization wave scope`,
      'REPAIR_TARGET_MISMATCH',
    );
    assertEqual(
      stage.target.cumulative_start_target,
      repairAuthorization.cumulative_start_target,
      `${stage.stage_id} cumulative target does not match the repair authorization`,
      'REPAIR_TARGET_MISMATCH',
    );
  } else if (stageContext.kind === 'repair-wave-b') {
    assertEqual(
      previousStage.gate_status,
      'pass',
      `${stage.stage_id} requires a passed Wave A report`,
      'STAGE_CHAIN_GATE_FAILURE',
    );
    assertEqual(
      previousStage.decision,
      'APPROVE BOUNDED',
      `${stage.stage_id} previous Wave A was not approved`,
      'STAGE_CHAIN_GATE_FAILURE',
    );
    assertEqual(
      previousStage.next_stage_authorized,
      true,
      `${stage.stage_id} previous Wave A did not authorize Wave B`,
      'STAGE_CHAIN_PROMOTION_MISMATCH',
    );
    assertCondition(
      !stage.input.repair_authorization,
      `${stage.stage_id} must not reuse repair authorization after Wave A`,
      'UNEXPECTED_REPAIR_AUTHORIZATION',
    );
  } else if (stageContext.repairRejoin
    && previousStage.stage_id === stageContext.repairRejoin.previous_stage_id) {
    assertEqual(
      previousStage.gate_status,
      'pass',
      `${stage.stage_id} requires a passed Wave B report before rejoining the ladder`,
      'REPAIR_REJOIN_GATE_FAILURE',
    );
    assertEqual(
      previousStage.decision,
      'APPROVE BOUNDED',
      `${stage.stage_id} cannot rejoin after an unapproved Wave B report`,
      'REPAIR_REJOIN_GATE_FAILURE',
    );
    assertEqual(
      previousStage.next_stage_authorized,
      true,
      `${stage.stage_id} requires Wave B to authorize ladder re-entry`,
      'REPAIR_REJOIN_PROMOTION_MISMATCH',
    );
    assertEqual(
      previousStage.target.cumulative_start_target,
      stageContext.repairRejoin.required_previous_cumulative_start_target,
      `${stage.stage_id} Wave B target does not complete the composite stage-2 target`,
      'REPAIR_REJOIN_TARGET_MISMATCH',
    );
    assertEqual(
      previousStage.actual.canonical_snapshot.start_count,
      stageContext.repairRejoin.required_previous_cumulative_start_target,
      `${stage.stage_id} Wave B output does not complete the composite stage-2 target`,
      'REPAIR_REJOIN_TARGET_MISMATCH',
    );
    assertCondition(
      !stage.input.repair_authorization,
      `${stage.stage_id} must not carry repair authorization after Wave B`,
      'UNEXPECTED_REPAIR_AUTHORIZATION',
    );
  } else if (previousStage.gate_status === 'pass') {
    assertCondition(
      !stage.input.repair_authorization,
      `${stage.stage_id} must not use repair authorization after a passed stage`,
      'UNEXPECTED_REPAIR_AUTHORIZATION',
    );
    assertEqual(
      previousStage.decision,
      'APPROVE BOUNDED',
      `${stage.stage_id} previous stage was not approved`,
      'STAGE_CHAIN_GATE_FAILURE',
    );
    assertEqual(
      previousStage.next_stage_authorized,
      true,
      `${stage.stage_id} previous stage did not authorize the next stage`,
      'STAGE_CHAIN_PROMOTION_MISMATCH',
    );
  } else {
    const repairReference = stage.input.repair_authorization;
    assertCondition(
      repairReference,
      `${stage.stage_id} must reference a valid repair authorization after a failed stage`,
      'MISSING_REPAIR_AUTHORIZATION',
    );
    const repairPath = resolveSourcePath(
      repairReference.path,
      `${stage.stage_id}.input.repair_authorization.path`,
    );
    const repairAuthorization = await loadAndValidateRepairAuthorization({
      authorizationPath: repairPath,
      authorizationSha256: repairReference.sha256,
      failedStage: previousStage,
      failedStagePath: previousPath,
      failedStageSha256: previousArtifact.sha256,
    });
    assertEqual(
      stage.target.net_start_increase,
      repairAuthorization.net_start_increase,
      `${stage.stage_id} exceeds the repair authorization wave scope`,
      'REPAIR_TARGET_MISMATCH',
    );
    assertEqual(
      stage.target.cumulative_start_target,
      repairAuthorization.cumulative_start_target,
      `${stage.stage_id} does not target the authorized repair wave`,
      'REPAIR_TARGET_MISMATCH',
    );
  }
  assertEqual(
    previousStage.actual.canonical_snapshot,
    stage.input.canonical_snapshot,
    `${stage.stage_id} input snapshot does not match the previous stage output`,
    'STAGE_CHAIN_INPUT_MISMATCH',
  );

  await validateExpansionStageInternal(
    previousStage,
    plan,
    new Set([...visitedStageIds, previousPath]),
  );
}

export function evaluateExpansionGate(metrics, plan) {
  const relationNoiseRate = metrics.relation_noise_rate_of_candidates
    ?? metrics.relation_noise_rate_of_before;
  const editorialReviewComplete = metrics.editorial_review_complete
    ?? metrics.human_editorial_review_complete;
  const producerThroughput = metrics.measurement_kind === 'producer-throughput';
  const measuredRate = producerThroughput
    ? metrics.producer_seconds_per_selected_start
    : metrics.editor_seconds_per_selected_start;
  const rateLimit = producerThroughput
    ? metrics.producer_seconds_per_selected_start_max
    : plan.gate.editor_seconds_per_selected_start_max;
  const editorTimePass = Number.isFinite(metrics.editor_seconds_per_selected_start)
    && metrics.editor_seconds_per_selected_start <= plan.gate.editor_seconds_per_selected_start_max
    && (!producerThroughput || metrics.editor_time_status === 'measured');
  const baselineRate = plan.gate.relation_noise_baseline.noise_event_count
    / plan.gate.relation_noise_baseline.before_count;
  const qualityPasses = {
    correction_rate: metrics.correction_rate_of_selected <= plan.gate.correction_rate_max,
    relation_noise_rate: relationNoiseRate <= plan.gate.relation_noise_rate_max,
    relation_noise_below_baseline: !plan.gate.relation_noise_below_m5_3_baseline_required
      || relationNoiseRate < baselineRate,
    ...(producerThroughput
      ? {
        producer_seconds_per_selected_start: Number.isFinite(measuredRate)
          && Number.isFinite(rateLimit)
          && measuredRate <= rateLimit,
        editor_seconds_per_selected_start: editorTimePass,
      }
      : {
        editor_seconds_per_selected_start: editorTimePass,
      }),
    timing_complete: metrics.timing_status === 'complete',
    unmeasured_timing_passes: metrics.unmeasured_timing_pass_count <= plan.gate.unmeasured_timing_passes_max,
    audit_complete: metrics.audit_status === 'complete',
    audit_independent: metrics.audit_independent,
    open_audit_blockers: metrics.open_audit_blocker_count <= plan.gate.open_audit_blockers_max,
    editorial_review_complete: editorialReviewComplete,
    canonical_integrity: metrics.canonical_integrity,
    deterministic_sqlite: metrics.deterministic_sqlite,
    search_product_regression: metrics.search_product_regression,
  };
  const gate_status = Object.values(qualityPasses).every(Boolean) ? 'pass' : 'fail';
  return {
    quality_passes: qualityPasses,
    gate_status,
    decision: gate_status === 'pass' ? 'APPROVE BOUNDED' : plan.gate.failure_decision,
  };
}

function validateExpansionStageValues(stage, plan, stageContext, sourceArtifacts) {
  const plannedStage = stageContext.contract;
  validateLoadedStageSources(stage, sourceArtifacts);

  assertEqual(
    stage.target.net_start_increase,
    plannedStage.target_net_start_increase,
    `${stage.stage_id} target does not match the plan`,
    'LADDER_DRIFT',
  );
  assertEqual(
    stage.target.cumulative_start_target,
    plannedStage.cumulative_start_target,
    `${stage.stage_id} cumulative target does not match the plan`,
    'CUMULATIVE_TARGET_MISMATCH',
  );
  const expectedBaseStartCount = stageContext.baseStartCount;
  assertEqual(
    stage.input.canonical_snapshot.start_count,
    expectedBaseStartCount,
    `${stage.stage_id} base count does not match the previous canonical target`,
    'BASE_START_MISMATCH',
  );
  if (stageContext.ladderIndex === 0) {
    assertEqual(
      stage.input.inventory_revision,
      plan.base_inventory_revision,
      `${stage.stage_id} input inventory revision does not match the M5-8 baseline`,
      'INVENTORY_REVISION_MISMATCH',
    );
    assertEqual(
      stage.input.canonical_snapshot,
      plan.canonical_baseline,
      `${stage.stage_id} input canonical snapshot drift`,
      'BASELINE_DRIFT',
    );
  }
  assertEqual(
    stage.target.selected_start_count,
    stage.target.net_start_increase + stage.target.candidate_buffer,
    `${stage.stage_id} selected count must include the declared candidate buffer`,
    'BUFFER_SELECTION_MISMATCH',
  );
  const proposedStartCount = stage.decisions.proposed_start_count ?? 0;
  const proposalStage = proposedStartCount > 0;
  assertEqual(
    stage.decisions.included_start_count
      + stage.decisions.corrected_start_count
      + proposedStartCount,
    stage.target.net_start_increase,
    `${stage.stage_id} imported/proposed starts must equal the target net increase`,
    'NET_START_INCREASE_MISMATCH',
  );
  const usedBuffer = stage.decisions.held_start_count + stage.decisions.rejected_start_count;
  assertCondition(
    usedBuffer <= stage.target.candidate_buffer,
    `${stage.stage_id} held/rejected decisions exceed the maximum candidate buffer`,
    'BUFFER_EXHAUSTED',
  );
  assertEqual(
    stage.decisions.deferred_start_count,
    stage.target.candidate_buffer - usedBuffer,
    `${stage.stage_id} deferred count must equal the unused candidate buffer`,
    'BUFFER_UNUSED_MISMATCH',
  );
  assertEqual(
    stage.buffer,
    {
      available_count: stage.target.candidate_buffer,
      used_count: usedBuffer,
      unused_count: stage.decisions.deferred_start_count,
    },
    `${stage.stage_id} buffer accounting is inconsistent`,
    'BUFFER_ACCOUNTING_MISMATCH',
  );
  assertEqual(
    stage.decisions.included_start_count
      + stage.decisions.corrected_start_count
      + stage.decisions.held_start_count
      + stage.decisions.rejected_start_count
      + proposedStartCount
      + stage.decisions.deferred_start_count,
    stage.target.selected_start_count,
    `${stage.stage_id} decisions must account for every selected start`,
    'DECISION_COUNT_MISMATCH',
  );
  const processedStartCount = stage.decisions.included_start_count
    + stage.decisions.corrected_start_count
    + stage.decisions.held_start_count
    + stage.decisions.rejected_start_count
    + proposedStartCount;
  assertEqual(
    processedStartCount,
    sourceArtifacts.processed_start_count,
    `${stage.stage_id} processed start count drifted from the manifest metrics`,
    'SOURCE_DECISION_DRIFT',
  );
  assertEqual(
    stage.actual.imported_start_count,
    stage.decisions.included_start_count + stage.decisions.corrected_start_count,
    `${stage.stage_id} actual imported starts do not match imported decisions`,
    'ACTUAL_IMPORT_MISMATCH',
  );
  if (proposalStage) {
    assertCondition(
      stage.proposal_decisions !== undefined,
      `${stage.stage_id} proposal decisions are required while proposals are pending`,
      'PROPOSAL_DECISION_MISSING',
    );
    const proposalProcessedStartCount = stage.proposal_decisions.included_start_count
      + stage.proposal_decisions.corrected_start_count
      + stage.proposal_decisions.held_start_count
      + stage.proposal_decisions.rejected_start_count;
    assertEqual(
      stage.proposal_decisions.included_start_count + stage.proposal_decisions.corrected_start_count,
      proposedStartCount,
      `${stage.stage_id} proposal decisions do not account for the pending target`,
      'PROPOSAL_DECISION_MISMATCH',
    );
    assertEqual(
      stage.metrics.correction_rate_of_selected,
      stage.proposal_decisions.corrected_start_count / proposalProcessedStartCount,
      `${stage.stage_id} correction rate is not derived from proposal decisions`,
      'METRIC_DRIFT',
    );
    assertEqual(
      stage.actual.canonical_snapshot.start_count,
      stage.input.canonical_snapshot.start_count + stage.actual.imported_start_count,
      `${stage.stage_id} pending stage actual canonical start count drifted from the base`,
      'CANONICAL_START_MISMATCH',
    );
  } else {
    assertEqual(
      stage.input.canonical_snapshot.start_count + stage.actual.imported_start_count,
      stage.target.cumulative_start_target,
      `${stage.stage_id} actual cumulative starts do not match the target`,
      'CUMULATIVE_START_MISMATCH',
    );
    assertEqual(
      stage.actual.canonical_snapshot.start_count,
      stage.target.cumulative_start_target,
      `${stage.stage_id} actual canonical start count does not match the target`,
      'CANONICAL_START_MISMATCH',
    );
    assertEqual(
      stage.metrics.correction_rate_of_selected,
      (stage.decisions.corrected_start_count / processedStartCount),
      `${stage.stage_id} correction rate is not derived from processed decisions`,
      'METRIC_DRIFT',
    );
  }
  if (stage.metrics.total_editor_seconds === null) {
    assertEqual(
      stage.metrics.editor_seconds_per_selected_start,
      null,
      `${stage.stage_id} incomplete timing must not report a complete editor rate`,
      'METRIC_DRIFT',
    );
  } else {
    assertNear(
      stage.metrics.editor_seconds_per_selected_start,
      stage.metrics.total_editor_seconds / processedStartCount,
      `${stage.stage_id} editor time per processed start is not derived from total editor time`,
      'METRIC_DRIFT',
    );
  }

  const gate = evaluateExpansionGate(stage.metrics, plan);
  assertEqual(
    stage.gate_status,
    gate.gate_status,
    `${stage.stage_id} gate status does not match source-derived metrics`,
    'GATE_STATUS_MISMATCH',
  );
  assertEqual(
    stage.decision,
    gate.decision,
    `${stage.stage_id} decision does not match the gate status`,
    'DECISION_MISMATCH',
  );
  if (stage.stage_id === 'm5-10a-wave-a2-plus-50') {
    assertEqual(
      stage.ready_to_create,
      stage.gate_status === 'pass',
      `${stage.stage_id} ready_to_create must reflect gate readiness only`,
      'NEXT_STAGE_READINESS_MISMATCH',
    );
    assertEqual(
      stage.next_stage_created,
      false,
      `${stage.stage_id} cannot claim a created next-stage task without a real reference`,
      'NEXT_STAGE_CREATED_WITHOUT_REFERENCE',
    );
    assertEqual(
      stage.next_stage_authorized,
      false,
      `${stage.stage_id} cannot authorize a next stage without a separately authorized task`,
      'NEXT_STAGE_AUTHORIZATION_MISMATCH',
    );
    assertEqual(
      stage.correction_plan.status,
      stage.gate_status === 'fail' ? 'required' : 'not-required',
      `${stage.stage_id} correction plan status does not match the gate`,
      'CORRECTION_PLAN_STATUS_MISMATCH',
    );
    if (stage.gate_status === 'pass') {
      assertEqual(
        stage.correction_plan.expected_saving_editor_seconds,
        0,
        `${stage.stage_id} passing result cannot claim a pending correction saving`,
        'CORRECTION_PLAN_CONTRADICTION',
      );
      const correctionPlanText = [
        stage.correction_plan.cause,
        stage.correction_plan.planned_change,
        stage.correction_plan.next_validation.note,
      ].join(' ');
      assertCondition(
        !/\bHOLD\b|re-evaluat|do not import|authorize Wave B/iu.test(correctionPlanText),
        `${stage.stage_id} passing result contains an operative HOLD or re-evaluation directive`,
        'CORRECTION_PLAN_CONTRADICTION',
      );
      assertCondition(
        /^No retry is required by this passing result\b/iu.test(stage.correction_plan.next_validation.note),
        `${stage.stage_id} passing result must declare that no retry is required`,
        'CORRECTION_PLAN_CONTRADICTION',
      );
    } else {
      assertCondition(
        stage.correction_plan.expected_saving_editor_seconds > 0,
        `${stage.stage_id} failed result must declare a positive correction saving`,
        'CORRECTION_PLAN_CONTRADICTION',
      );
    }
    const breakdownEditorSeconds = stage.correction_plan.measured_breakdown
      .reduce((total, item) => total + item.editor_seconds, 0);
    assertCondition(
      breakdownEditorSeconds > 0 && breakdownEditorSeconds <= stage.metrics.total_editor_seconds,
      `${stage.stage_id} correction plan breakdown is outside the measured editor total`,
      'CORRECTION_PLAN_METRIC_MISMATCH',
    );
    assertNear(
      stage.correction_plan.measured_breakdown
        .reduce((total, item) => total + item.share_of_total, 0),
      breakdownEditorSeconds / stage.metrics.total_editor_seconds,
      `${stage.stage_id} correction plan shares do not match measured editor seconds`,
      'CORRECTION_PLAN_METRIC_MISMATCH',
    );
  }
  if (stage.gate_status === 'fail') {
    assertEqual(
      stage.next_stage_authorized,
      false,
      `${stage.stage_id} cannot authorize the next stage after a failed gate`,
      'NEXT_STAGE_AFTER_FAILURE',
    );
  }
  if (stage.next_stage_authorized) {
    assertEqual(
      stage.gate_status,
      'pass',
      `${stage.stage_id} cannot authorize the next stage after a failed gate`,
      'NEXT_STAGE_AFTER_FAILURE',
    );
    assertEqual(
      stage.next_stage_created,
      true,
      `${stage.stage_id} must have a created next-stage issue before authorization`,
      'NEXT_STAGE_AUTHORIZATION_MISMATCH',
    );
  }

  return {
    stage_id: stage.stage_id,
    imported_start_count: stage.actual.imported_start_count,
    candidate_buffer: stage.target.candidate_buffer,
    gate_status: stage.gate_status,
  };
}

async function validateExpansionStageInternal(
  stage,
  plan,
  visitedStageIds = new Set(),
  sourceOptions = {},
) {
  validateSchema(stage, stageReportSchemaValidator, 'stage', 'M5-8 stage report');
  validateExpansionPlan(plan);
  assertCondition(
    !visitedStageIds.has(stage.stage_id),
    `${stage.stage_id} stage report chain contains a cycle`,
    'STAGE_CHAIN_CYCLE',
  );
  const nextVisitedStageIds = new Set(visitedStageIds);
  nextVisitedStageIds.add(stage.stage_id);
  const stageContext = resolveStageContext(stage, plan);

  const loadedSources = await loadExpansionStageSources(stage, sourceOptions);
  await validatePreviousStageReport(stage, plan, stageContext, nextVisitedStageIds);
  return validateExpansionStageValues(stage, plan, stageContext, loadedSources);
}

export async function validateExpansionStage(stage, plan, sourceOptions = {}) {
  return validateExpansionStageInternal(stage, plan, new Set(), sourceOptions);
}

function canonicalSummary(recordInfos) {
  const records = recordInfos.map(({ record }) => record);
  return {
    record_count: records.length,
    start_count: records.filter((record) => record.role === 'start').length,
    reference_only_count: records.filter((record) => record.role === 'reference-only').length,
    sense_count: records.reduce((count, record) => count + record.senses.length, 0),
    relation_count: records.reduce(
      (count, record) => count + record.senses.reduce(
        (senseCount, sense) => senseCount + (sense.relations?.length ?? 0),
        0,
      ),
      0,
    ),
    expression_count: records.filter((record) => record.record_type === 'expression').length,
  };
}

function relationShape(relation) {
  return {
    target: relation.target,
    target_sense: relation.target_sense ?? null,
    type: relation.type,
  };
}

function senseRegressionShape(regressionCase) {
  return {
    canonical_id: regressionCase.canonical_id,
    expected_sense_count: regressionCase.expected_sense_count,
    expected_pos: regressionCase.expected_pos,
  };
}

function validateM57RegressionFixture(fixture, canonicalRecordInfos, relationDiff) {
  validateSchema(fixture, regressionSchemaValidator, 'fixture', 'M5-8 process regression');
  validateRelationDiff(relationDiff);

  assertEqual(
    sortedValues(fixture.sense_cases.map(({ canonical_id: canonicalId }) => canonicalId)),
    sortedValues(EXPECTED_SENSE_REGRESSIONS.map(({ canonical_id: canonicalId }) => canonicalId)),
    'M5-7 sense regression fixture does not cover the fixed sense cases',
    'SENSE_FIXTURE_COVERAGE',
  );
  assertEqual(
    fixture.sense_cases.map(senseRegressionShape).sort((left, right) => left.canonical_id.localeCompare(right.canonical_id)),
    [...EXPECTED_SENSE_REGRESSIONS].sort((left, right) => left.canonical_id.localeCompare(right.canonical_id)),
    'M5-7 sense regression fixture expectations drifted',
    'SENSE_REGRESSION',
  );

  const canonicalById = new Map(
    canonicalRecordInfos.map(({ record }) => [record.id, record]),
  );
  for (const regressionCase of fixture.sense_cases) {
    const record = canonicalById.get(regressionCase.canonical_id);
    assertCondition(record, `${regressionCase.case_id} canonical record is missing`, 'MISSING_CANONICAL_RECORD');
    assertEqual(
      record.senses.length,
      regressionCase.expected_sense_count,
      `${regressionCase.case_id} sense count drift`,
      'SENSE_REGRESSION',
    );
    assertEqual(
      record.senses.map((sense) => sense.pos),
      regressionCase.expected_pos,
      `${regressionCase.case_id} POS drift`,
      'SENSE_REGRESSION',
    );
  }

  const eventsByRelationId = new Map(
    (relationDiff.events ?? []).map((event) => [event.relation_id, event]),
  );
  const removeEvents = (relationDiff.events ?? []).filter((event) => event.operation === 'remove');
  const expectedRelationIds = new Set();
  for (const regressionCase of fixture.relation_cases) {
    const event = eventsByRelationId.get(regressionCase.relation_id);
    assertCondition(event, `${regressionCase.case_id} relation event is missing`, 'MISSING_RELATION_EVENT');
    expectedRelationIds.add(regressionCase.relation_id);
    assertEqual(event.operation, 'remove', `${regressionCase.case_id} must remain a removal regression`, 'RELATION_REGRESSION');
    assertEqual(event.source_sense, regressionCase.source_sense, `${regressionCase.case_id} source sense drift`, 'RELATION_REGRESSION');
    assertEqual(event.before && relationShape(event.before), regressionCase.before, `${regressionCase.case_id} candidate drift`, 'RELATION_REGRESSION');
    assertEqual(event.error_category, regressionCase.failure_category, `${regressionCase.case_id} failure category drift`, 'RELATION_REGRESSION');

    const sourceRecordId = regressionCase.source_sense.slice(0, regressionCase.source_sense.lastIndexOf('-s'));
    const sourceRecord = canonicalById.get(sourceRecordId);
    assertCondition(sourceRecord, `${regressionCase.case_id} source record is missing`, 'MISSING_CANONICAL_RECORD');
    const sourceSense = sourceRecord.senses.find((sense) => sense.id === regressionCase.source_sense);
    assertCondition(sourceSense, `${regressionCase.case_id} source sense is missing`, 'MISSING_CANONICAL_SENSE');
    assertEqual(
      sourceSense.relations?.length ?? 0,
      regressionCase.expected_final_relation_count,
      `${regressionCase.case_id} final relation count drift`,
      'RELATION_REGRESSION',
    );
    assertCondition(
      !(sourceSense.relations ?? []).some((relation) => JSON.stringify(relationShape(relation)) === JSON.stringify(regressionCase.before)),
      `${regressionCase.case_id} rejected relation still appears in canonical data`,
      'RELATION_REGRESSION',
    );
  }
  assertEqual(
    sortedValues(expectedRelationIds),
    sortedValues(removeEvents.map((event) => event.relation_id)),
    'M5-7 relation regression fixture does not cover exactly the removed events',
    'RELATION_FIXTURE_COVERAGE',
  );

  return {
    fixture_id: fixture.fixture_id,
    sense_case_count: fixture.sense_cases.length,
    relation_case_count: fixture.relation_cases.length,
  };
}

export function validateM58Process({ plan, fixture, canonicalRecordInfos, relationDiff }) {
  const planResult = validateExpansionPlan(plan);
  assertEqual(
    canonicalSummary(canonicalRecordInfos),
    EXPECTED_CANONICAL_BASELINE,
    'canonical snapshot changed during M5-8 process work',
    'CANONICAL_COUNT_CHANGED',
  );
  const regressionResult = validateM57RegressionFixture(fixture, canonicalRecordInfos, relationDiff);
  return { plan: planResult, regressions: regressionResult };
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${filePath}`, 'MISSING_INPUT');
    if (error instanceof SyntaxError) fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_JSON');
    throw error;
  }
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
  const planPath = path.resolve(args.plan ?? DEFAULT_PLAN_PATH);
  if (args.stage) {
    const [plan, stage] = await Promise.all([
      readJson(planPath, 'M5-8 expansion plan'),
      readJson(path.resolve(args.stage), 'M5-8 stage report'),
    ]);
    const result = await validateExpansionStage(stage, plan);
    console.log(
      `Validated ${result.stage_id}: ${result.imported_start_count} imported start(s), candidate buffer ${result.candidate_buffer}, gate ${result.gate_status}.`,
    );
    return result;
  }

  const fixturePath = path.resolve(args.fixture ?? DEFAULT_FIXTURE_PATH);
  const canonicalDirectory = path.resolve(args['canonical-dir'] ?? DEFAULT_CANONICAL_DIRECTORY);
  const relationDiffPath = path.resolve(args['relation-diff'] ?? DEFAULT_RELATION_DIFF_PATH);
  const [plan, fixture, canonical, relationDiff] = await Promise.all([
    readJson(planPath, 'M5-8 expansion plan'),
    readJson(fixturePath, 'M5-8 process regression fixture'),
    readCanonicalRecords(canonicalDirectory),
    readJson(relationDiffPath, 'M5-7 relation diff'),
  ]);

  const relativeRelationDiffPath = path.relative(REPOSITORY_DIRECTORY, relationDiffPath);
  assertEqual(
    relativeRelationDiffPath,
    fixture.relation_diff_artifact,
    'relation diff path binding is invalid',
    'RELATION_DIFF_PATH_MISMATCH',
  );
  const canonicalArtifactPath = path.resolve(REPOSITORY_DIRECTORY, fixture.canonical_artifact);
  const canonicalInputPaths = new Set(
    canonical.records.map(({ filePath }) => path.resolve(filePath)),
  );
  assertCondition(
    canonicalInputPaths.has(canonicalArtifactPath),
    `canonical input does not include the fixture artifact ${fixture.canonical_artifact}`,
    'CANONICAL_ARTIFACT_MISMATCH',
  );

  const result = validateM58Process({
    plan,
    fixture,
    canonicalRecordInfos: canonical.records.filter(isM58BaselineRecord),
    relationDiff,
  });
  console.log(
    `Validated ${result.plan.ladder.length}-stage M5-8 ladder, ${result.regressions.sense_case_count} sense regressions, and ${result.regressions.relation_case_count} relation regressions with no canonical count change.`,
  );
  return result;
}

const isMainModule =
  process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
