import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';
import { validateRelationDiff } from './relation-diff.mjs';
import { REPOSITORY_DIRECTORY } from './validate-batch.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PLAN_SCHEMA = require('../../schema/m5-8-expansion-plan.schema.json');
const REGRESSION_SCHEMA = require('../../schema/m5-8-process-regression.schema.json');
const STAGE_REPORT_SCHEMA = require('../../schema/m5-8-stage-report.schema.json');
const planSchemaValidator = new Ajv2020({ allErrors: true }).compile(PLAN_SCHEMA);
const regressionSchemaValidator = new Ajv2020({ allErrors: true }).compile(REGRESSION_SCHEMA);
const stageReportSchemaValidator = new Ajv2020({ allErrors: true }).compile(STAGE_REPORT_SCHEMA);

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

const EXPECTED_LADDER = Object.freeze([
  { sequence: 1, target_net_start_increase: 100, cumulative_start_target: 528 },
  { sequence: 2, target_net_start_increase: 250, cumulative_start_target: 778 },
  { sequence: 3, target_net_start_increase: 500, cumulative_start_target: 1278 },
  { sequence: 4, target_net_start_increase: 722, cumulative_start_target: 2000 },
  { sequence: 5, target_net_start_increase: 1000, cumulative_start_target: 3000 },
  { sequence: 6, target_net_start_increase: 1000, cumulative_start_target: 4000 },
  { sequence: 7, target_net_start_increase: 1000, cumulative_start_target: 5000 },
]);

const EXPECTED_CANONICAL_BASELINE = Object.freeze({
  record_count: 470,
  start_count: 428,
  reference_only_count: 42,
  sense_count: 557,
  relation_count: 449,
  expression_count: 23,
});

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

export function validateExpansionStage(stage, plan) {
  validateSchema(stage, stageReportSchemaValidator, 'stage', 'M5-8 stage report');
  validateExpansionPlan(plan);
  const plannedStageIndex = plan.ladder.findIndex(({ stage_id: stageId }) => stageId === stage.stage_id);
  const plannedStage = plannedStageIndex === -1 ? null : plan.ladder[plannedStageIndex];
  assertCondition(plannedStage, `stage ${String(stage.stage_id)} is not in the M5-8 ladder`, 'UNKNOWN_STAGE');

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
  const expectedBaseStartCount = plannedStageIndex === 0
    ? plan.canonical_baseline.start_count
    : plan.ladder[plannedStageIndex - 1].cumulative_start_target;
  assertEqual(
    stage.input.canonical_snapshot.start_count,
    expectedBaseStartCount,
    `${stage.stage_id} base count does not match the previous canonical target`,
    'BASE_START_MISMATCH',
  );
  if (plannedStageIndex === 0) {
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
  assertEqual(
    stage.decisions.included_start_count + stage.decisions.corrected_start_count,
    stage.target.net_start_increase,
    `${stage.stage_id} included/corrected starts must equal the target net increase`,
    'NET_START_INCREASE_MISMATCH',
  );
  assertEqual(
    stage.decisions.held_start_count + stage.decisions.rejected_start_count,
    stage.target.candidate_buffer,
    `${stage.stage_id} held/rejected decisions must account for the candidate buffer`,
    'BUFFER_DECISION_MISMATCH',
  );
  assertEqual(
    stage.decisions.included_start_count
      + stage.decisions.corrected_start_count
      + stage.decisions.held_start_count
      + stage.decisions.rejected_start_count,
    stage.target.selected_start_count,
    `${stage.stage_id} decisions must account for every selected start`,
    'DECISION_COUNT_MISMATCH',
  );
  assertEqual(
    stage.actual.imported_start_count,
    stage.decisions.included_start_count + stage.decisions.corrected_start_count,
    `${stage.stage_id} actual imported starts do not match included/corrected decisions`,
    'ACTUAL_IMPORT_MISMATCH',
  );
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
    (stage.decisions.corrected_start_count / stage.target.selected_start_count),
    `${stage.stage_id} correction rate is not derived from decisions`,
    'METRIC_DRIFT',
  );
  assertNear(
    stage.metrics.editor_seconds_per_selected_start,
    stage.metrics.total_editor_seconds / stage.target.selected_start_count,
    `${stage.stage_id} editor time per selected start is not derived from total editor time`,
    'METRIC_DRIFT',
  );

  const baselineRate = plan.gate.relation_noise_baseline.noise_event_count
    / plan.gate.relation_noise_baseline.before_count;
  const qualityPasses = [
    stage.metrics.correction_rate_of_selected <= plan.gate.correction_rate_max,
    stage.metrics.relation_noise_rate_of_before <= plan.gate.relation_noise_rate_max,
    !plan.gate.relation_noise_below_m5_3_baseline_required
      || stage.metrics.relation_noise_rate_of_before < baselineRate,
    stage.metrics.editor_seconds_per_selected_start <= plan.gate.editor_seconds_per_selected_start_max,
    stage.metrics.timing_status === 'complete',
    stage.metrics.unmeasured_timing_pass_count <= plan.gate.unmeasured_timing_passes_max,
    stage.metrics.audit_status === 'complete',
    stage.metrics.audit_independent,
    stage.metrics.open_audit_blocker_count <= plan.gate.open_audit_blockers_max,
    stage.metrics.human_editorial_review_complete,
    stage.metrics.canonical_integrity,
    stage.metrics.deterministic_sqlite,
    stage.metrics.search_product_regression,
  ];
  const expectedGateStatus = qualityPasses.every(Boolean) ? 'pass' : 'fail';
  assertEqual(
    stage.gate_status,
    expectedGateStatus,
    `${stage.stage_id} gate status does not match source-derived metrics`,
    'GATE_STATUS_MISMATCH',
  );
  assertEqual(
    stage.decision,
    stage.gate_status === 'pass' ? 'APPROVE BOUNDED' : plan.gate.failure_decision,
    `${stage.stage_id} decision does not match the gate status`,
    'DECISION_MISMATCH',
  );
  if (stage.gate_status === 'fail') {
    assertEqual(
      stage.next_stage_created,
      false,
      `${stage.stage_id} cannot create the next stage after a failed gate`,
      'NEXT_STAGE_AFTER_FAILURE',
    );
  }

  return {
    stage_id: stage.stage_id,
    imported_start_count: stage.actual.imported_start_count,
    candidate_buffer: stage.target.candidate_buffer,
    gate_status: stage.gate_status,
  };
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
    canonicalRecordInfos: canonical.records,
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
