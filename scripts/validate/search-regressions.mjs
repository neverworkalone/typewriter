import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEARCH_REGRESSION_SCHEMA_VERSION = 1;

export const SEARCH_INPUT_CLASSES = Object.freeze([
  'exact-lemma',
  'exact-search-form',
  'normalization-candidate',
  'no-data',
  'unsupported',
  'editorial-gap',
]);

export const SEARCH_EVALUATIONS = Object.freeze(['baseline', 'pending']);
export const EXPECTED_STATUSES = Object.freeze([
  'ready',
  'empty',
  'unsupported',
  'pending',
]);
export const ACTUAL_STATUSES = Object.freeze(['ready', 'empty', 'error']);
export const SEARCH_PROBLEMS = Object.freeze([
  'none',
  'normalization',
  'no-data',
  'unsupported',
  'editorial',
]);
export const RELATION_TYPES = Object.freeze([
  'direct',
  'near',
  'antonym',
  'mood',
  'scene',
  'sensory',
  'action',
  'association',
]);

const EXPECTED_STATUS_BY_INPUT_CLASS = Object.freeze({
  'exact-lemma': 'ready',
  'exact-search-form': 'ready',
  'normalization-candidate': 'pending',
  'no-data': 'empty',
  unsupported: 'unsupported',
  'editorial-gap': 'pending',
});

const PROBLEM_BY_INPUT_CLASS = Object.freeze({
  'exact-lemma': 'none',
  'exact-search-form': 'none',
  'normalization-candidate': 'normalization',
  'no-data': 'no-data',
  unsupported: 'unsupported',
  'editorial-gap': 'editorial',
});

const FORBIDDEN_SOURCE_FIELDS = new Set([
  'context',
  'example',
  'example_sentence',
  'definition',
  'dictionary_quote',
  'notes',
  'original_sentence',
  'source_sentence',
  'source_text',
]);

const CORPUS_KEYS = new Set(['schema_version', 'corpus_id', 'cases']);
const CASE_KEYS = new Set([
  'id',
  'query',
  'input_class',
  'evaluation',
  'expected',
  'actual',
  'selection',
  'assertions',
  'problem',
  'policy',
]);
const OBSERVATION_KEYS = new Set(['status', 'result_ids', 'selected_record_id']);
const SELECTION_KEYS = new Set([
  'kind',
  'record_id',
  'source_record_id',
  'source_sense_id',
  'sense_id',
  'relation_type',
]);
const RECORD_ASSERTION_KEYS = new Set([
  'kind',
  'record_id',
  'in_results',
  'record_type',
  'role',
  'sense_ids',
  'relation_count',
]);
const RELATION_ASSERTION_KEYS = new Set([
  'kind',
  'source_sense_id',
  'target_record_id',
  'target_sense_id',
  'type',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function addError(errors, location, message) {
  errors.push(`${location}: ${message}`);
}

function validateAllowedKeys(value, allowedKeys, location, errors) {
  if (!isPlainObject(value)) {
    return;
  }

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      addError(errors, `${location}.${key}`, 'unknown field is not allowed');
    }
  }
}

function validateEnum(value, allowed, location, errors) {
  if (!allowed.includes(value)) {
    addError(errors, location, `must be one of: ${allowed.join(', ')}`);
  }
}

function validateUniqueStrings(values, location, errors) {
  if (!Array.isArray(values)) {
    addError(errors, location, 'must be an array');
    return;
  }

  const seen = new Set();
  values.forEach((value, index) => {
    if (!isNonEmptyString(value)) {
      addError(errors, `${location}[${index}]`, 'must be a non-empty string');
      return;
    }

    if (seen.has(value)) {
      addError(errors, location, `contains duplicate value ${JSON.stringify(value)}`);
    }
    seen.add(value);
  });
}

function validateObservation(observation, location, statuses, errors) {
  if (!isPlainObject(observation)) {
    addError(errors, location, 'must be an object');
    return;
  }

  validateAllowedKeys(observation, OBSERVATION_KEYS, location, errors);
  validateEnum(observation.status, statuses, `${location}.status`, errors);
  validateUniqueStrings(observation.result_ids, `${location}.result_ids`, errors);

  if (observation.status === 'ready' && observation.result_ids?.length === 0) {
    addError(errors, location, 'ready observations must contain at least one result');
  }

  if (
    (observation.status === 'empty' || observation.status === 'unsupported' || observation.status === 'error')
    && observation.result_ids?.length > 0
  ) {
    addError(errors, location, `${observation.status} observations must not contain results`);
  }

  if (observation.selected_record_id !== null && !isNonEmptyString(observation.selected_record_id)) {
    addError(errors, `${location}.selected_record_id`, 'must be null or a non-empty string');
  }
}

function validateSelection(selection, expected, actual, location, errors) {
  if (selection === null) {
    if (expected.selected_record_id !== null || actual.selected_record_id !== null) {
      addError(errors, location, 'null selection requires null selected_record_id values');
    }
    return;
  }

  if (!isPlainObject(selection)) {
    addError(errors, location, 'must be null or an object');
    return;
  }

  validateAllowedKeys(selection, SELECTION_KEYS, location, errors);
  validateEnum(selection.kind, ['record', 'relation-target'], `${location}.kind`, errors);
  for (const field of ['record_id']) {
    if (!isNonEmptyString(selection[field])) {
      addError(errors, `${location}.${field}`, 'must be a non-empty string');
    }
  }

  if (selection.kind === 'relation-target') {
    for (const field of ['source_record_id', 'source_sense_id', 'sense_id', 'relation_type']) {
      if (!isNonEmptyString(selection[field])) {
        addError(errors, `${location}.${field}`, 'must be a non-empty string');
      }
    }
    validateEnum(selection.relation_type, RELATION_TYPES, `${location}.relation_type`, errors);
  }

  if (expected.selected_record_id !== selection.record_id) {
    addError(errors, `${location}.record_id`, 'does not match expected.selected_record_id');
  }
  if (actual.selected_record_id !== selection.record_id) {
    addError(errors, `${location}.record_id`, 'does not match actual.selected_record_id');
  }
}

function validateRecordAssertion(assertion, location, resultIds, errors) {
  if (!isPlainObject(assertion)) {
    addError(errors, location, 'must be an object');
    return;
  }

  validateAllowedKeys(assertion, RECORD_ASSERTION_KEYS, location, errors);
  if (assertion.kind !== 'record') {
    addError(errors, `${location}.kind`, 'must be record');
  }
  if (!isNonEmptyString(assertion.record_id)) {
    addError(errors, `${location}.record_id`, 'must be a non-empty string');
  }
  if (typeof assertion.in_results !== 'boolean') {
    addError(errors, `${location}.in_results`, 'must be a boolean');
  } else if (assertion.in_results !== resultIds.includes(assertion.record_id)) {
    addError(errors, `${location}.in_results`, 'contradicts actual.result_ids');
  }

  for (const field of ['record_type', 'role']) {
    if (assertion[field] !== undefined && !isNonEmptyString(assertion[field])) {
      addError(errors, `${location}.${field}`, 'must be a non-empty string when present');
    }
  }

  if (assertion.sense_ids !== undefined) {
    validateUniqueStrings(assertion.sense_ids, `${location}.sense_ids`, errors);
  }

  if (
    assertion.relation_count !== undefined
    && (!Number.isInteger(assertion.relation_count) || assertion.relation_count < 0)
  ) {
    addError(errors, `${location}.relation_count`, 'must be a non-negative integer when present');
  }
}

function validateRelationAssertion(assertion, location, errors) {
  if (!isPlainObject(assertion)) {
    addError(errors, location, 'must be an object');
    return;
  }

  validateAllowedKeys(assertion, RELATION_ASSERTION_KEYS, location, errors);
  if (assertion.kind !== 'relation') {
    addError(errors, `${location}.kind`, 'must be relation');
  }
  for (const field of ['source_sense_id', 'target_record_id', 'target_sense_id', 'type']) {
    if (!isNonEmptyString(assertion[field])) {
      addError(errors, `${location}.${field}`, 'must be a non-empty string');
    }
  }
  validateEnum(assertion.type, RELATION_TYPES, `${location}.type`, errors);
}

function validateAssertions(assertions, location, resultIds, errors) {
  if (!Array.isArray(assertions)) {
    addError(errors, location, 'must be an array');
    return;
  }

  const seen = new Set();
  assertions.forEach((assertion, index) => {
    const assertionLocation = `${location}[${index}]`;
    const key = isPlainObject(assertion)
      ? JSON.stringify([
        assertion.kind,
        assertion.record_id,
        assertion.source_sense_id,
        assertion.target_record_id,
        assertion.target_sense_id,
        assertion.type,
      ])
      : String(index);
    if (seen.has(key)) {
      addError(errors, assertionLocation, 'duplicates another assertion');
    }
    seen.add(key);

    if (assertion?.kind === 'record') {
      validateRecordAssertion(assertion, assertionLocation, resultIds, errors);
    } else if (assertion?.kind === 'relation') {
      validateRelationAssertion(assertion, assertionLocation, errors);
    } else {
      addError(errors, `${assertionLocation}.kind`, 'must be record or relation');
    }
  });
}

function scanForbiddenFields(value, location, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenFields(item, `${location}[${index}]`, errors));
    return;
  }

  if (!isPlainObject(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_SOURCE_FIELDS.has(key)) {
      addError(errors, `${location}.${key}`, 'raw source/example text is not allowed in the regression corpus');
    }
    scanForbiddenFields(child, `${location}.${key}`, errors);
  }
}

export function validateSearchRegressionCorpus(corpus) {
  const errors = [];

  if (!isPlainObject(corpus)) {
    return ['$: must be an object'];
  }

  validateAllowedKeys(corpus, CORPUS_KEYS, '$', errors);
  if (corpus.schema_version !== SEARCH_REGRESSION_SCHEMA_VERSION) {
    addError(errors, '$.schema_version', `must be ${SEARCH_REGRESSION_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(corpus.corpus_id)) {
    addError(errors, '$.corpus_id', 'must be a non-empty string');
  }
  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) {
    addError(errors, '$.cases', 'must contain at least one case');
    return errors;
  }

  const caseIds = new Set();
  const queryClasses = new Set();

  corpus.cases.forEach((searchCase, index) => {
    const location = `$.cases[${index}]`;
    if (!isPlainObject(searchCase)) {
      addError(errors, location, 'must be an object');
      return;
    }

    validateAllowedKeys(searchCase, CASE_KEYS, location, errors);
    if (!isNonEmptyString(searchCase.id)) {
      addError(errors, `${location}.id`, 'must be a non-empty string');
    } else if (caseIds.has(searchCase.id)) {
      addError(errors, `${location}.id`, `duplicates case ${JSON.stringify(searchCase.id)}`);
    } else {
      caseIds.add(searchCase.id);
    }

    if (!isNonEmptyString(searchCase.query) || searchCase.query.includes('\n') || searchCase.query.includes('\r')) {
      addError(errors, `${location}.query`, 'must be a non-empty single-line string');
    }

    validateEnum(searchCase.input_class, SEARCH_INPUT_CLASSES, `${location}.input_class`, errors);
    validateEnum(searchCase.evaluation, SEARCH_EVALUATIONS, `${location}.evaluation`, errors);
    validateEnum(searchCase.problem, SEARCH_PROBLEMS, `${location}.problem`, errors);

    const queryClassKey = `${searchCase.input_class}\u0000${searchCase.query}`;
    if (queryClasses.has(queryClassKey)) {
      addError(errors, location, 'duplicates the same query within the same input class');
    }
    queryClasses.add(queryClassKey);

    const expectedLocation = `${location}.expected`;
    const actualLocation = `${location}.actual`;
    validateObservation(searchCase.expected, expectedLocation, EXPECTED_STATUSES, errors);
    validateObservation(searchCase.actual, actualLocation, ACTUAL_STATUSES, errors);

    const expectedStatus = EXPECTED_STATUS_BY_INPUT_CLASS[searchCase.input_class];
    if (expectedStatus && searchCase.expected?.status !== expectedStatus) {
      addError(errors, `${expectedLocation}.status`, `must be ${expectedStatus} for ${searchCase.input_class}`);
    }
    const expectedProblem = PROBLEM_BY_INPUT_CLASS[searchCase.input_class];
    if (expectedProblem && searchCase.problem !== expectedProblem) {
      addError(errors, `${location}.problem`, `must be ${expectedProblem} for ${searchCase.input_class}`);
    }

    if (searchCase.input_class === 'normalization-candidate' && searchCase.evaluation !== 'pending') {
      addError(errors, `${location}.evaluation`, 'normalization candidates must remain pending');
    }
    if (searchCase.input_class === 'editorial-gap' && searchCase.evaluation !== 'pending') {
      addError(errors, `${location}.evaluation`, 'editorial gaps must remain pending');
    }
    if (searchCase.evaluation === 'baseline') {
      const expectedIds = JSON.stringify(searchCase.expected?.result_ids);
      const actualIds = JSON.stringify(searchCase.actual?.result_ids);
      if (expectedIds !== actualIds) {
        addError(errors, location, 'baseline expected.result_ids and actual.result_ids must agree');
      }
    }

    validateSelection(
      searchCase.selection,
      searchCase.expected || {},
      searchCase.actual || {},
      `${location}.selection`,
      errors,
    );
    validateAssertions(
      searchCase.assertions,
      `${location}.assertions`,
      searchCase.actual?.result_ids || [],
      errors,
    );

    if (!isNonEmptyString(searchCase.policy)) {
      addError(errors, `${location}.policy`, 'must be a non-empty string');
    }
  });

  scanForbiddenFields(corpus, '$', errors);
  return errors;
}

export function assertValidSearchRegressionCorpus(corpus) {
  const errors = validateSearchRegressionCorpus(corpus);
  if (errors.length > 0) {
    const error = new Error(`Search regression corpus is invalid:\n${errors.join('\n')}`);
    error.name = 'SearchRegressionValidationError';
    error.errors = errors;
    throw error;
  }
  return corpus;
}

export async function readSearchRegressionCorpus(filePath) {
  const source = await readFile(filePath, 'utf8');
  return JSON.parse(source);
}

export async function main() {
  const repositoryDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  const filePath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(repositoryDirectory, 'tests/fixtures/search-regressions/m4-baseline.json');
  const corpus = await readSearchRegressionCorpus(filePath);
  assertValidSearchRegressionCorpus(corpus);
  console.log(`Validated ${corpus.cases.length} search regression case(s) in ${filePath}.`);
  return corpus;
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
