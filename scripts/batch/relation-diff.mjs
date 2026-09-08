import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const RELATION_DIFF_SCHEMA = require('../../schema/relation-diff.schema.json');

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

export const RELATION_ERROR_CATEGORIES = Object.freeze([
  'incidental-co-occurrence',
  'generic-result-or-reaction',
  'arbitrary-modifier-or-place',
  'broad-common-category',
  'unsupported-cross-sensory',
  'sense-target-type-error',
]);

const relationDiffSchemaValidator = new Ajv2020({
  allErrors: true,
}).compile(RELATION_DIFF_SCHEMA);

export class RelationDiffError extends Error {
  constructor(message, code = 'RELATION_DIFF_ERROR') {
    super(message);
    this.name = 'RelationDiffError';
    this.code = code;
  }
}

function fail(message, code = 'RELATION_DIFF_ERROR') {
  throw new RelationDiffError(message, code);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`, 'INVALID_VALUE');
  }
  if (value !== value.trim()) {
    fail(`${label} must not have leading or trailing whitespace`, 'UNTRIMMED_VALUE');
  }
  if (value.normalize('NFC') !== value) {
    fail(`${label} must be NFC-normalized`, 'NON_NFC_VALUE');
  }
}

function requireRelationType(value, label) {
  requireString(value, label);
  if (!RELATION_TYPES.includes(value)) {
    fail(`${label} must be a supported relation type`, 'INVALID_RELATION_TYPE');
  }
}

function relationSourceSense(value, label) {
  requireString(value, label);
  if (!/^[wr][0-9]{3,}-s[1-9][0-9]*$/u.test(value)) {
    fail(`${label} must be a canonical sense ID`, 'INVALID_SOURCE_SENSE');
  }
}

function normalizeRelation(relation, index, side) {
  if (!relation || typeof relation !== 'object' || Array.isArray(relation)) {
    fail(`${side}[${index}] must be an object`, 'INVALID_RELATION');
  }
  const allowed = new Set(['id', 'source_sense', 'target', 'target_sense', 'type']);
  for (const key of Object.keys(relation)) {
    if (!allowed.has(key)) {
      fail(`${side}[${index}] contains unsupported field ${key}`, 'UNKNOWN_FIELD');
    }
  }
  for (const key of ['id', 'source_sense', 'target', 'type']) {
    requireString(relation[key], `${side}[${index}].${key}`);
  }
  relationSourceSense(relation.source_sense, `${side}[${index}].source_sense`);
  requireRelationType(relation.type, `${side}[${index}].type`);
  if (Object.hasOwn(relation, 'target_sense')) {
    requireString(relation.target_sense, `${side}[${index}].target_sense`);
    if (!/^[wr][0-9]{3,}-s[1-9][0-9]*$/u.test(relation.target_sense)) {
      fail(`${side}[${index}].target_sense must be a canonical sense ID`, 'INVALID_TARGET_SENSE');
    }
  }
  return structuredClone(relation);
}

function normalizeSnapshot(snapshot, side) {
  const relations = Array.isArray(snapshot) ? snapshot : snapshot?.relations;
  if (!Array.isArray(relations)) {
    fail(`${side} snapshot must be an array or an object with relations`, 'INVALID_SNAPSHOT');
  }
  const normalized = relations.map((relation, index) => normalizeRelation(relation, index, side));
  const ids = new Set();
  for (const relation of normalized) {
    if (ids.has(relation.id)) {
      fail(`${side} snapshot contains duplicate relation id ${relation.id}`, 'DUPLICATE_RELATION_ID');
    }
    ids.add(relation.id);
  }
  return normalized;
}

function relationValue(relation, key) {
  return relation[key] ?? null;
}

function eventId(batchId, index) {
  return `${batchId}-event-${String(index + 1).padStart(4, '0')}`;
}

function relationIdOrder(left, right) {
  return left.localeCompare(right, 'en');
}

export function compareRelationSnapshots({
  batchId,
  before,
  after,
  sourceNote,
  candidateReviews,
} = {}) {
  requireString(batchId, 'batchId');
  const beforeRelations = normalizeSnapshot(before, 'before');
  const afterRelations = normalizeSnapshot(after, 'after');
  const beforeById = new Map(beforeRelations.map((relation) => [relation.id, relation]));
  const afterById = new Map(afterRelations.map((relation) => [relation.id, relation]));
  const relationIds = [...new Set([...beforeById.keys(), ...afterById.keys()])]
    .sort(relationIdOrder);
  const events = [];

  for (const relationId of relationIds) {
    const beforeRelation = beforeById.get(relationId);
    const afterRelation = afterById.get(relationId);
    if (!beforeRelation) {
      events.push({
        event_id: eventId(batchId, events.length),
        relation_id: relationId,
        operation: 'add',
        source_sense: afterRelation.source_sense,
        after: stripSnapshotId(afterRelation),
      });
      continue;
    }
    if (!afterRelation) {
      events.push({
        event_id: eventId(batchId, events.length),
        relation_id: relationId,
        operation: 'remove',
        source_sense: beforeRelation.source_sense,
        before: stripSnapshotId(beforeRelation),
      });
      continue;
    }
    if (beforeRelation.source_sense !== afterRelation.source_sense) {
      fail(
        `relation ${relationId} changes source_sense; model it as remove plus add`,
        'SOURCE_SENSE_CHANGED',
      );
    }
    const changedFields = ['target', 'target_sense', 'type']
      .filter((field) => relationValue(beforeRelation, field) !== relationValue(afterRelation, field));
    if (changedFields.length === 0) continue;

    const operation = changedFields.includes('target') || changedFields.includes('target_sense')
      ? 'retarget'
      : 'retype';
    events.push({
      event_id: eventId(batchId, events.length),
      relation_id: relationId,
      operation,
      source_sense: beforeRelation.source_sense,
      before: stripSnapshotId(beforeRelation),
      after: stripSnapshotId(afterRelation),
      changed_fields: changedFields,
    });
  }

  const diff = {
    schema_version: '1',
    batch_id: batchId,
    before_count: beforeRelations.length,
    after_count: afterRelations.length,
    events,
  };
  if (sourceNote !== undefined) {
    requireString(sourceNote, 'sourceNote');
    diff.source_note = sourceNote;
  }
  if (candidateReviews !== undefined) {
    diff.candidate_reviews = structuredClone(candidateReviews);
  }
  validateRelationDiff(diff);
  return diff;
}

function stripSnapshotId(relation) {
  const { id: _id, source_sense: _sourceSense, ...withoutId } = relation;
  return withoutId;
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
    'relationDiff',
  );
}

function validateRelationDiffSchema(diff) {
  if (relationDiffSchemaValidator(diff)) return;
  const error = relationDiffSchemaValidator.errors?.[0];
  const detail = error
    ? `${schemaErrorPath(error)} ${error.message}`
    : 'relation diff does not match the relation diff schema';
  fail(`relation diff schema validation failed: ${detail}`, 'SCHEMA_ERROR');
}

function requireEventRelation(event, field, operation) {
  if (!event[field]) {
    fail(`${operation} event requires ${field}`, 'MISSING_RELATION_SIDE');
  }
}

function validateCandidateRelation(relation, index) {
  if (!relation || typeof relation !== 'object' || Array.isArray(relation)) {
    fail(`candidate_reviews[${index}].relation must be an object`, 'INVALID_RELATION');
  }
  requireString(relation.target, `candidate_reviews[${index}].relation.target`);
  if (!/^[wr][0-9]{3,}$/u.test(relation.target)) {
    fail(
      `candidate_reviews[${index}].relation.target must be a canonical record ID`,
      'INVALID_TARGET',
    );
  }
  requireRelationType(relation.type, `candidate_reviews[${index}].relation.type`);
  if (Object.hasOwn(relation, 'target_sense')) {
    requireString(
      relation.target_sense,
      `candidate_reviews[${index}].relation.target_sense`,
    );
    if (!/^[wr][0-9]{3,}-s[1-9][0-9]*$/u.test(relation.target_sense)) {
      fail(
        `candidate_reviews[${index}].relation.target_sense must be a canonical sense ID`,
        'INVALID_TARGET_SENSE',
      );
    }
  }
}

function validateCandidateReviews(diff, eventByRelationId, eventCounts) {
  const reviews = diff.candidate_reviews;
  if (!reviews) {
    if (diff.before_count === 0 && diff.after_count > 0) {
      fail(
        'pure-add relation diffs require source-bound candidate_reviews',
        'MISSING_CANDIDATE_REVIEWS',
      );
    }
    return;
  }

  const candidateIds = new Set();
  const relationIds = new Set();
  let admittedCount = 0;
  for (const [index, review] of reviews.entries()) {
    if (candidateIds.has(review.candidate_id)) {
      fail(
        `candidate_reviews contains duplicate candidate_id ${review.candidate_id}`,
        'DUPLICATE_CANDIDATE_ID',
      );
    }
    candidateIds.add(review.candidate_id);
    if (relationIds.has(review.relation_id)) {
      fail(
        `candidate_reviews contains duplicate relation_id ${review.relation_id}`,
        'DUPLICATE_CANDIDATE_RELATION_ID',
      );
    }
    relationIds.add(review.relation_id);
    requireString(review.candidate_id, `candidate_reviews[${index}].candidate_id`);
    requireString(review.relation_id, `candidate_reviews[${index}].relation_id`);
    relationSourceSense(review.source_sense, `candidate_reviews[${index}].source_sense`);
    validateCandidateRelation(review.relation, index);
    requireString(review.review_note, `candidate_reviews[${index}].review_note`);

    const event = eventByRelationId.get(review.relation_id);
    if (review.decision === 'admit') {
      admittedCount += 1;
      if (!event || event.operation !== 'add') {
        fail(
          `admitted candidate ${review.candidate_id} must map to an add event`,
          'CANDIDATE_EVENT_MISMATCH',
        );
      }
      if (event.source_sense !== review.source_sense
        || JSON.stringify(event.after) !== JSON.stringify(review.relation)) {
        fail(
          `admitted candidate ${review.candidate_id} does not match its add event`,
          'CANDIDATE_EVENT_MISMATCH',
        );
      }
    } else if (event) {
      fail(
        `rejected candidate ${review.candidate_id} must not appear in relation events`,
        'REJECTED_CANDIDATE_EVENT',
      );
    }
  }

  if (diff.before_count === 0
    && (eventCounts.add !== admittedCount || eventCounts.remove > 0
      || eventCounts.retype > 0 || eventCounts.retarget > 0)) {
    fail(
      'pure-add candidate_reviews must account for every add event and no other operation',
      'CANDIDATE_EVENT_COVERAGE',
    );
  }
}

export function validateRelationDiff(diff) {
  validateRelationDiffSchema(diff);
  const eventIds = new Set();
  const relationIds = new Set();
  const counts = { add: 0, remove: 0, retype: 0, retarget: 0 };

  for (const event of diff.events) {
    if (eventIds.has(event.event_id)) {
      fail(`relation diff contains duplicate event_id ${event.event_id}`, 'DUPLICATE_EVENT_ID');
    }
    eventIds.add(event.event_id);
    if (relationIds.has(event.relation_id)) {
      fail(`relation diff contains duplicate relation_id ${event.relation_id}`, 'DUPLICATE_RELATION_ID');
    }
    relationIds.add(event.relation_id);
    counts[event.operation] += 1;

    if (event.operation === 'add') {
      requireEventRelation(event, 'after', event.operation);
      if (Object.hasOwn(event, 'before') || Object.hasOwn(event, 'changed_fields')) {
        fail('add event must contain only an after relation', 'INVALID_EVENT_SHAPE');
      }
    } else if (event.operation === 'remove') {
      requireEventRelation(event, 'before', event.operation);
      if (Object.hasOwn(event, 'after') || Object.hasOwn(event, 'changed_fields')) {
        fail('remove event must contain only a before relation', 'INVALID_EVENT_SHAPE');
      }
    } else {
      requireEventRelation(event, 'before', event.operation);
      requireEventRelation(event, 'after', event.operation);
      const actualChangedFields = ['target', 'target_sense', 'type']
        .filter((field) => relationValue(event.before, field) !== relationValue(event.after, field));
      if (actualChangedFields.length === 0
        || JSON.stringify(actualChangedFields) !== JSON.stringify(event.changed_fields)) {
        fail(
          `${event.operation} event ${event.event_id} has inconsistent changed_fields`,
          'CHANGED_FIELDS_MISMATCH',
        );
      }
      const expectedOperation = actualChangedFields.includes('target')
        || actualChangedFields.includes('target_sense')
        ? 'retarget'
        : 'retype';
      if (event.operation !== expectedOperation) {
        fail(
          `${event.operation} event ${event.event_id} should be ${expectedOperation}`,
          'OPERATION_MISMATCH',
        );
      }
    }
  }

  const expectedAfterCount = diff.before_count - counts.remove + counts.add;
  if (expectedAfterCount !== diff.after_count) {
    fail(
      `relation diff count mismatch: expected after_count ${expectedAfterCount}, received ${diff.after_count}`,
      'COUNT_MISMATCH',
    );
  }
  const eventByRelationId = new Map(diff.events.map((event) => [event.relation_id, event]));
  validateCandidateReviews(diff, eventByRelationId, counts);
  return diff;
}

export function summarizeRelationDiff(diff) {
  validateRelationDiff(diff);
  const counts = Object.fromEntries(
    ['add', 'remove', 'retype', 'retarget'].map((operation) => [
      operation,
      diff.events.filter((event) => event.operation === operation).length,
    ]),
  );
  const classificationCounts = {};
  for (const event of diff.events) {
    if (event.error_category) {
      classificationCounts[event.error_category] = (classificationCounts[event.error_category] ?? 0) + 1;
    }
  }
  const classifiedEventNoiseCount = diff.events.filter(
    (event) => event.operation === 'remove' && event.error_category,
  ).length;
  const rejectedCandidateCount = diff.candidate_reviews?.filter(
    ({ decision }) => decision === 'reject',
  ).length ?? 0;
  for (const review of diff.candidate_reviews ?? []) {
    if (review.decision === 'reject') {
      classificationCounts[review.error_category] = (classificationCounts[review.error_category] ?? 0) + 1;
    }
  }
  const noiseEventCount = diff.candidate_reviews
    ? rejectedCandidateCount
    : classifiedEventNoiseCount;
  const summary = {
    before_count: diff.before_count,
    after_count: diff.after_count,
    added_count: counts.add,
    removed_count: counts.remove,
    retyped_count: counts.retype,
    retargeted_count: counts.retarget,
    changed_count: counts.retype + counts.retarget,
    net_removed_count: counts.remove - counts.add,
    noise_event_count: noiseEventCount,
    noise_rate_of_before: diff.before_count === 0
      ? 0
      : classifiedEventNoiseCount / diff.before_count,
    classification_counts: classificationCounts,
  };
  if (diff.candidate_reviews) {
    const admittedCandidateCount = diff.candidate_reviews.filter(
      ({ decision }) => decision === 'admit',
    ).length;
    summary.candidate_count = diff.candidate_reviews.length;
    summary.admitted_candidate_count = admittedCandidateCount;
    summary.rejected_candidate_count = rejectedCandidateCount;
    summary.noise_denominator_count = diff.candidate_reviews.length;
    summary.noise_rate_of_candidates = diff.candidate_reviews.length === 0
      ? 0
      : rejectedCandidateCount / diff.candidate_reviews.length;
  }
  return summary;
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
  const beforePath = args.before;
  const afterPath = args.after;
  const outputPath = args.output;
  if (!beforePath || !afterPath || !outputPath || !args['batch-id']) {
    fail('--before, --after, --output, and --batch-id are required', 'MISSING_ARGUMENT');
  }
  const before = await readJson(beforePath, 'before snapshot');
  const after = await readJson(afterPath, 'after snapshot');
  const diff = compareRelationSnapshots({
    batchId: args['batch-id'],
    before,
    after,
    sourceNote: args['source-note'],
  });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(diff, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summarizeRelationDiff(diff), null, 2));
  return diff;
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
