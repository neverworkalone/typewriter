import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  RELATION_ERROR_CATEGORIES,
  validateRelationDiff,
} from './relation-diff.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const RELATION_SCREEN_SCHEMA = require('../../schema/m5-9-relation-screen.schema.json');
const relationScreenSchemaValidator = new Ajv2020({ allErrors: true }).compile(RELATION_SCREEN_SCHEMA);

export const RELATION_SCREEN_PROCESS_REVISION = 'm5-9a-relation-admission-v1';
export const DEFAULT_RELATION_SCREEN_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-9a-relation-screen.json',
);

export class RelationScreenValidationError extends Error {
  constructor(message, code = 'RELATION_SCREEN_VALIDATION_ERROR') {
    super(message);
    this.name = 'RelationScreenValidationError';
    this.code = code;
  }
}

function fail(message, code = 'RELATION_SCREEN_VALIDATION_ERROR') {
  throw new RelationScreenValidationError(message, code);
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
    'relationScreen',
  );
}

function validateSchema(value) {
  if (relationScreenSchemaValidator(value)) return;
  const error = relationScreenSchemaValidator.errors?.[0];
  fail(
    error
      ? `relation screen schema validation failed at ${schemaErrorPath(error)} ${error.message}`
      : 'relation screen schema validation failed',
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

function assertEqual(actual, expected, message, code = 'SOURCE_BINDING_MISMATCH') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`, code);
  }
}

function assertSetEqual(actual, expected, message, code = 'SOURCE_BINDING_MISMATCH') {
  const actualValues = [...actual].sort();
  const expectedValues = [...expected].sort();
  assertEqual(actualValues, expectedValues, message, code);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`, 'INVALID_VALUE');
  }
}

function validatePolicy(artifact) {
  assertEqual(
    artifact.process_revision,
    RELATION_SCREEN_PROCESS_REVISION,
    'relation screen process revision drifted',
    'PROCESS_REVISION_MISMATCH',
  );
  assertEqual(
    artifact.policy.default_relation_output,
    'empty',
    'relation output must default to empty',
    'RELATION_OUTPUT_POLICY_MISMATCH',
  );
  assertEqual(artifact.policy.quota, 'none', 'relation quota must remain disabled', 'RELATION_QUOTA_POLICY_MISMATCH');
  assertEqual(
    artifact.policy.candidate_fields,
    ['source_sense', 'target_sense', 'direction', 'type', 'writer_use_note'],
    'relation candidate fields drifted',
    'CANDIDATE_FIELD_POLICY_MISMATCH',
  );
  assertEqual(
    artifact.policy.pre_screen_method,
    'tuple-and-semantic-review',
    'relation pre-screen must use tuple and semantic review',
    'PRESCREEN_METHOD_MISMATCH',
  );
  assertEqual(
    artifact.policy.pre_screen_failure_categories,
    RELATION_ERROR_CATEGORIES,
    'relation pre-screen failure categories drifted',
    'PRESCREEN_CATEGORY_MISMATCH',
  );
}

function validateCandidate(candidate, sourceReview, eventByRelationId, index) {
  const label = `relationScreen.candidates[${index}]`;
  requireString(candidate.writer_use_note, `${label}.writer_use_note`);
  assertEqual(
    candidate.direction,
    { from: candidate.source_sense, to: candidate.relation.target_sense },
    `${label} direction is not bound to its source and target senses`,
    'DIRECTION_MISMATCH',
  );
  assertEqual(
    candidate.relation,
    relationShape(sourceReview.relation),
    `${label} relation tuple drifted from the source candidate`,
  );
  assertEqual(candidate.source_sense, sourceReview.source_sense, `${label} source sense drifted`);
  assertEqual(candidate.relation_id, sourceReview.relation_id, `${label} relation ID drifted`);

  if (candidate.pre_screen.source_sense_locked !== true
    || candidate.pre_screen.target_sense_locked !== true) {
    fail(
      `${label} must lock both source and target senses before pre-screening`,
      'SENSES_NOT_LOCKED',
    );
  }
  const expectedSemanticResult = candidate.pre_screen.decision === 'pass'
    ? 'stable-writer-use'
    : 'not-stable-writer-use';
  assertEqual(
    candidate.pre_screen.semantic_result,
    expectedSemanticResult,
    `${label} pre-screen semantic result does not match its decision`,
    'PRESCREEN_DECISION_MISMATCH',
  );

  const event = eventByRelationId.get(candidate.relation_id);
  if (candidate.pre_screen.decision === 'reject') {
    if (sourceReview.decision !== 'reject') {
      fail(
        `${label} pre-screen rejected a candidate that the source admitted`,
        'PRESCREEN_FALSE_NEGATIVE',
      );
    }
    assertEqual(
      candidate.pre_screen.error_category,
      sourceReview.error_category,
      `${label} pre-screen failure category drifted`,
      'PRESCREEN_CATEGORY_DRIFT',
    );
    if (event) {
      fail(`${label} pre-screen rejected candidate appears in final relation events`, 'PRESCREEN_EVENT_LEAK');
    }
    assertEqual(
      candidate.human_admission,
      {
        status: 'not-reviewed',
        decision: 'not-reviewed',
        reason: candidate.human_admission.reason,
      },
      `${label} pre-screen rejection must remain outside human admission`,
      'ADMISSION_BOUNDARY_MISMATCH',
    );
    return;
  }

  if (sourceReview.decision !== 'admit') {
    fail(
      `${label} pre-screen passed a known rejected regression candidate`,
      'PRESCREEN_FALSE_POSITIVE',
    );
  }
  if (!event || event.operation !== 'add') {
    fail(`${label} admitted candidate has no add event`, 'ADMISSION_EVENT_MISMATCH');
  }
  assertEqual(
    relationShape(event.after),
    candidate.relation,
    `${label} admitted candidate does not match its add event`,
    'ADMISSION_EVENT_MISMATCH',
  );
  assertEqual(
    candidate.human_admission,
    {
      status: 'reviewed',
      decision: 'admit',
      reason: sourceReview.review_note,
    },
    `${label} human admission reason or decision drifted from the source review`,
    'ADMISSION_SOURCE_MISMATCH',
  );
}

export function validateRelationScreen(
  artifact,
  relationDiff,
  {
    relationDiffPath,
    relationDiffSha256,
  } = {},
) {
  validateSchema(artifact);
  validateRelationDiff(relationDiff);
  validatePolicy(artifact);

  if (relationDiffPath !== undefined) {
    assertEqual(
      artifact.source.relation_diff,
      relationDiffPath,
      'relation screen source path does not match the loaded relation diff',
      'SOURCE_PATH_MISMATCH',
    );
  }
  if (relationDiffSha256 !== undefined) {
    assertEqual(
      artifact.source.relation_diff_sha256,
      relationDiffSha256,
      'relation screen source digest does not match the loaded relation diff',
      'SOURCE_DIGEST_MISMATCH',
    );
  }

  if (!relationDiff.candidate_reviews) {
    fail('relation screen source must contain candidate_reviews', 'MISSING_SOURCE_CANDIDATES');
  }

  const sourceByCandidateId = new Map(
    relationDiff.candidate_reviews.map((candidate) => [candidate.candidate_id, candidate]),
  );
  const eventByRelationId = new Map(
    relationDiff.events.map((event) => [event.relation_id, event]),
  );
  const candidateIds = new Set();
  const relationIds = new Set();
  for (const [index, candidate] of artifact.candidates.entries()) {
    if (candidateIds.has(candidate.candidate_id)) {
      fail(`relation screen repeats candidate ${candidate.candidate_id}`, 'DUPLICATE_CANDIDATE_ID');
    }
    if (relationIds.has(candidate.relation_id)) {
      fail(`relation screen repeats relation ${candidate.relation_id}`, 'DUPLICATE_RELATION_ID');
    }
    candidateIds.add(candidate.candidate_id);
    relationIds.add(candidate.relation_id);
    const sourceReview = sourceByCandidateId.get(candidate.candidate_id);
    if (!sourceReview) {
      fail(`relation screen candidate ${candidate.candidate_id} is not in the source diff`, 'SOURCE_CANDIDATE_MISSING');
    }
    validateCandidate(candidate, sourceReview, eventByRelationId, index);
  }

  assertSetEqual(
    candidateIds,
    new Set(sourceByCandidateId.keys()),
    'relation screen must cover every source-bound candidate',
    'CANDIDATE_COVERAGE_MISMATCH',
  );

  const preScreenRejected = artifact.candidates.filter(({ pre_screen: preScreen }) => preScreen.decision === 'reject');
  const preScreenPassed = artifact.candidates.filter(({ pre_screen: preScreen }) => preScreen.decision === 'pass');
  const humanAdmitted = artifact.candidates.filter(
    ({ human_admission: admission }) => admission.decision === 'admit',
  );
  const humanRejected = artifact.candidates.filter(
    ({ human_admission: admission }) => admission.decision === 'reject',
  );
  const addEvents = relationDiff.events.filter(({ operation }) => operation === 'add');
  assertSetEqual(
    new Set(humanAdmitted.map(({ relation_id: relationId }) => relationId)),
    new Set(addEvents.map(({ relation_id: relationId }) => relationId)),
    'human-admitted relations must be exactly the final add events',
    'FINAL_RELATION_COVERAGE_MISMATCH',
  );

  return {
    artifact_id: artifact.artifact_id,
    process_revision: artifact.process_revision,
    proposal_count: artifact.candidates.length,
    pre_screened_count: artifact.candidates.length,
    pre_screen_pass_count: preScreenPassed.length,
    pre_screen_rejected_count: preScreenRejected.length,
    human_admission_denominator: preScreenPassed.length,
    human_admission_reviewed_count: preScreenPassed.filter(
      ({ human_admission: admission }) => admission.status === 'reviewed',
    ).length,
    human_admitted_count: humanAdmitted.length,
    human_rejected_count: humanRejected.length,
    final_relation_count: addEvents.length,
    failure_category_counts: Object.fromEntries(
      [...new Set(preScreenRejected.map(({ pre_screen: preScreen }) => preScreen.error_category))]
        .sort()
        .map((category) => [
          category,
          preScreenRejected.filter(({ pre_screen: preScreen }) => preScreen.error_category === category).length,
        ]),
    ),
  };
}
