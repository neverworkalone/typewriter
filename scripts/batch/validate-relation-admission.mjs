import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import { REPOSITORY_DIRECTORY } from './validate-batch.mjs';

const require = createRequire(import.meta.url);
const REGRESSION_SCHEMA = require('../../schema/relation-admission-regression.schema.json');
const regressionSchemaValidator = new Ajv2020({ allErrors: true }).compile(REGRESSION_SCHEMA);

export const DEFAULT_FIXTURE_PATH = path.resolve(
  REPOSITORY_DIRECTORY,
  'tests/fixtures/relation-admission/m5-5-regressions.json',
);
export const DEFAULT_SOURCE_ARTIFACT = path.resolve(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-5-recalibration-relation-diff.json',
);

export class RelationAdmissionRegressionError extends Error {
  constructor(message, code = 'RELATION_ADMISSION_REGRESSION_ERROR') {
    super(message);
    this.name = 'RelationAdmissionRegressionError';
    this.code = code;
  }
}

function fail(message, code = 'RELATION_ADMISSION_REGRESSION_ERROR') {
  throw new RelationAdmissionRegressionError(message, code);
}

function schemaErrorPath(error) {
  const pathParts = error.instancePath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (error.keyword === 'required') pathParts.push(error.params.missingProperty);
  if (error.keyword === 'additionalProperties') pathParts.push(error.params.additionalProperty);
  return pathParts.reduce(
    (result, part) => (/^\d+$/u.test(part) ? `${result}[${part}]` : `${result}.${part}`),
    'fixture',
  );
}

function validateFixtureSchema(fixture) {
  if (regressionSchemaValidator(fixture)) return;
  const error = regressionSchemaValidator.errors?.[0];
  fail(
    error
      ? `${schemaErrorPath(error)} ${error.message}`
      : 'relation admission regression fixture does not match its schema',
    'SCHEMA_ERROR',
  );
}

function relationShape(relation) {
  return {
    target: relation.target,
    target_sense: relation.target_sense ?? null,
    type: relation.type,
  };
}

function assertEqual(actual, expected, message) {
  try {
    assert.deepEqual(actual, expected);
  } catch (error) {
    fail(`${message}: ${error.message}`, 'SOURCE_BINDING_MISMATCH');
  }
}

function eventIndex(relationDiff) {
  const events = new Map();
  for (const event of relationDiff.events ?? []) {
    if (events.has(event.event_id)) {
      fail(`relation diff contains duplicate event ${event.event_id}`, 'DUPLICATE_SOURCE_EVENT');
    }
    events.set(event.event_id, event);
  }
  return events;
}

function validateRemovalCases(fixture, relationDiff, events) {
  const removeEvents = relationDiff.events.filter((event) => event.operation === 'remove');
  if (removeEvents.length !== fixture.removed_error_count) {
    fail(
      `fixture expects ${fixture.removed_error_count} removed errors, source has ${removeEvents.length}`,
      'REMOVAL_COUNT_MISMATCH',
    );
  }

  const caseEventIds = new Set();
  for (const regressionCase of fixture.cases) {
    if (caseEventIds.has(regressionCase.source_event_id)) {
      fail(`fixture repeats source event ${regressionCase.source_event_id}`, 'DUPLICATE_REGRESSION_CASE');
    }
    caseEventIds.add(regressionCase.source_event_id);
    const event = events.get(regressionCase.source_event_id);
    if (!event) fail(`fixture source event is missing: ${regressionCase.source_event_id}`, 'MISSING_SOURCE_EVENT');
    if (event.operation !== 'remove') {
      fail(`${regressionCase.source_event_id} is not a remove event`, 'SOURCE_OPERATION_MISMATCH');
    }
    assertEqual(regressionCase.source_sense, event.source_sense, `${regressionCase.case_id} source sense drift`);
    assertEqual(regressionCase.candidate, relationShape(event.before), `${regressionCase.case_id} candidate drift`);
    assertEqual(
      regressionCase.failure_category,
      event.error_category,
      `${regressionCase.case_id} failure category drift`,
    );
    if (regressionCase.expected_action !== 'omit') {
      fail(`${regressionCase.case_id} must remain an omit regression`, 'INVALID_REGRESSION_ACTION');
    }
  }

  const sourceRemoveIds = new Set(removeEvents.map((event) => event.event_id));
  assertEqual(caseEventIds, sourceRemoveIds, 'fixture does not cover exactly the source remove events');
}

function validateCorrectionCases(fixture, events) {
  const correctionEventIds = new Set();
  for (const correctionCase of fixture.corrections) {
    if (correctionEventIds.has(correctionCase.source_event_id)) {
      fail(`fixture repeats correction event ${correctionCase.source_event_id}`, 'DUPLICATE_CORRECTION_CASE');
    }
    correctionEventIds.add(correctionCase.source_event_id);
    const event = events.get(correctionCase.source_event_id);
    if (!event) fail(`fixture correction event is missing: ${correctionCase.source_event_id}`, 'MISSING_SOURCE_EVENT');
    if (event.operation !== correctionCase.operation) {
      fail(`${correctionCase.source_event_id} operation drift`, 'SOURCE_OPERATION_MISMATCH');
    }
    assertEqual(correctionCase.source_sense, event.source_sense, `${correctionCase.case_id} source sense drift`);
    assertEqual(correctionCase.before, relationShape(event.before), `${correctionCase.case_id} before drift`);
    assertEqual(correctionCase.after, relationShape(event.after), `${correctionCase.case_id} after drift`);
    assertEqual(
      correctionCase.failure_category,
      event.error_category,
      `${correctionCase.case_id} failure category drift`,
    );
    if (correctionCase.expected_action !== 'retarget-after-editor-review') {
      fail(`${correctionCase.case_id} has an invalid correction action`, 'INVALID_CORRECTION_ACTION');
    }
  }
}

export function validateRelationAdmissionRegression(fixture, relationDiff) {
  validateFixtureSchema(fixture);
  if (!relationDiff || typeof relationDiff !== 'object') {
    fail('relationDiff must be an object', 'INVALID_SOURCE_ARTIFACT');
  }
  if (relationDiff.batch_id !== 'm5-5-recalibration-20260907') {
    fail(`unexpected source batch ${relationDiff.batch_id}`, 'SOURCE_BATCH_MISMATCH');
  }
  const events = eventIndex(relationDiff);
  validateRemovalCases(fixture, relationDiff, events);
  validateCorrectionCases(fixture, events);

  const categories = new Set([
    ...fixture.cases.map(({ failure_category }) => failure_category),
    ...fixture.corrections.map(({ failure_category }) => failure_category),
  ]);
  if (categories.size !== 6) {
    fail('fixture must retain all six relation admission failure categories', 'INCOMPLETE_CATEGORY_COVERAGE');
  }

  return {
    fixture_id: fixture.fixture_id,
    removed_error_count: fixture.cases.length,
    correction_case_count: fixture.corrections.length,
    failure_categories: [...categories].sort(),
  };
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
  const fixturePath = path.resolve(args.fixture ?? DEFAULT_FIXTURE_PATH);
  const sourcePath = path.resolve(args.source ?? DEFAULT_SOURCE_ARTIFACT);
  const [fixture, relationDiff] = await Promise.all([
    readJson(fixturePath, 'relation admission fixture'),
    readJson(sourcePath, 'relation diff source artifact'),
  ]);
  const relativeSourcePath = path.relative(REPOSITORY_DIRECTORY, sourcePath);
  if (relativeSourcePath !== fixture.source_artifact) {
    fail(
      `fixture source_artifact ${fixture.source_artifact} does not match ${relativeSourcePath}`,
      'SOURCE_PATH_MISMATCH',
    );
  }
  const result = validateRelationAdmissionRegression(fixture, relationDiff);
  console.log(
    `Validated ${result.removed_error_count} removal regressions and ${result.correction_case_count} correction regression(s) for ${result.fixture_id}.`,
  );
  return result;
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
