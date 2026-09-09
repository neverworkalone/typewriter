import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMetricsArtifact } from './derive-metrics.mjs';
import {
  createWaveBManifest,
  createWaveBStageMetrics,
  DEFAULT_AUTHORIZATION_PATH,
  DEFAULT_AUDIT_INPUT_PATH,
  DEFAULT_AUDIT_TIMING_INPUT_PATH,
  DEFAULT_BASE_CANONICAL_DIRECTORY,
  DEFAULT_EDITORIAL_INPUT_PATH,
  DEFAULT_INVENTORY_PATH,
  DEFAULT_METRICS_PATH,
  DEFAULT_OUTPUT_PATH,
  DEFAULT_PLAN_PATH,
  DEFAULT_RELATION_DIFF_PATH,
  DEFAULT_STAGE_PATH,
  DEFAULT_TIMING_INPUT_PATH,
  DEFAULT_VERIFICATION_PATH,
  REPOSITORY_DIRECTORY,
  WAVE_B_BATCH_ID,
  WAVE_B_BASE_START_COUNT,
  WAVE_B_CUMULATIVE_START_COUNT,
  WAVE_B_IMPORTED_CANONICAL_IDS,
  WAVE_B_IMPORTED_START_COUNT,
  WAVE_B_INVENTORY_REVISION,
  WAVE_B_SELECTED_START_COUNT,
  WAVE_B_STAGE_ID,
  validateWaveBAuditDecisionArtifact,
  validateWaveBAuditInput,
  validateWaveB,
  validateWaveBEditorialDecisionArtifact,
  validateWaveBEditorialInput,
  validateWaveBProvenanceArtifact,
  validateWaveBTimingInput,
} from './validate-m5-10-wave-b.mjs';
import { evaluateExpansionGate, hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import { validateRelationDiff } from './relation-diff.mjs';
import { DEFAULT_CANONICAL_DIRECTORY, readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const BATCH_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/batches');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJsonSource(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label} does not exist: ${filePath}`);
    throw error;
  }
  try {
    return { value: JSON.parse(bytes.toString('utf8')), bytes, sha256: sha256(bytes), path: filePath };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function relativeSourcePath(filePath) {
  const relative = path.relative(REPOSITORY_DIRECTORY, path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`source path must be inside the repository: ${filePath}`);
  }
  return relative;
}

function recordOf(recordInfo) {
  return recordInfo.record ?? recordInfo;
}

function mergeReferenceRecords(...recordLists) {
  const byId = new Map();
  for (const recordList of recordLists) {
    for (const recordInfo of recordList) {
      const record = recordOf(recordInfo);
      const existing = byId.get(record.id);
      if (existing && JSON.stringify(recordOf(existing)) !== JSON.stringify(record)) {
        throw new Error(`conflicting Wave B reference record ${record.id}`);
      }
      if (!existing) byId.set(record.id, recordInfo);
    }
  }
  return [...byId.values()];
}

function canonicalSummary(recordInfos) {
  const records = recordInfos.map(recordOf);
  return {
    record_count: records.length,
    start_count: records.filter(({ role }) => role === 'start').length,
    reference_only_count: records.filter(({ role }) => role === 'reference-only').length,
    sense_count: records.reduce((sum, record) => sum + record.senses.length, 0),
    relation_count: records.reduce((sum, record) => sum + record.senses.reduce((inner, sense) => inner + (sense.relations?.length ?? 0), 0), 0),
    expression_count: records.filter(({ record_type: recordType }) => recordType === 'expression').length,
  };
}

function assertDeep(actual, expected, message) {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function assertAuthorization(authorization, previousStageSource, proposalSha256) {
  assertDeep(authorization.schema_version, '1', 'Wave B authorization schema version drifted');
  assertDeep(authorization.issue, 96, 'Wave B authorization issue drifted');
  assertDeep(authorization.parent_issue, 7, 'Wave B authorization parent issue drifted');
  assertDeep(authorization.source_kind, 'user-request', 'Wave B authorization source kind drifted');
  assertDeep(authorization.decision, 'AUTHORIZE WAVE B', 'Wave B authorization decision drifted');
  assertDeep(authorization.previous_gate?.path, 'data/batches/m5-10a-wave-a2.json', 'Wave B authorization previous gate path drifted');
  assertDeep(authorization.previous_gate?.sha256, previousStageSource.sha256, 'Wave B authorization previous gate digest drifted');
  assertDeep(authorization.previous_gate?.actual_start_count, WAVE_B_BASE_START_COUNT, 'Wave B authorization previous count drifted');
  assertDeep(authorization.previous_gate?.gate_status, 'pass', 'Wave B authorization previous gate is not passing');
  assertDeep(authorization.wave, {
    stage_id: WAVE_B_STAGE_ID,
    net_start_increase: WAVE_B_IMPORTED_START_COUNT,
    cumulative_start_target: WAVE_B_CUMULATIVE_START_COUNT,
    selected_start_count: WAVE_B_SELECTED_START_COUNT,
    candidate_buffer: 20,
  }, 'Wave B authorization scope drifted');
  assertDeep(authorization.proposal_sha256, proposalSha256, 'Wave B authorization proposal digest drifted');
  assertDeep(authorization.canonical_mutation, false, 'Wave B authorization must preserve the proposal boundary');
  if (typeof authorization.note !== 'string' || authorization.note.trim().length === 0) throw new Error('Wave B authorization note is missing');
}

function assertVerification(verification) {
  assertDeep(verification.schema_version, '1', 'Wave B verification schema version drifted');
  assertDeep(verification.batch_id, WAVE_B_BATCH_ID, 'Wave B verification batch_id drifted');
  for (const key of ['editorial_review_complete', 'canonical_integrity', 'deterministic_sqlite', 'search_product_regression']) {
    assertDeep(verification[key], true, `Wave B verification ${key} failed`);
  }
  assertDeep(verification.human_editorial_review_complete, false, 'Wave B human review attribution drifted');
  if (!Array.isArray(verification.checks) || verification.checks.some(({ status }) => status !== 'pass')) {
    throw new Error('Wave B verification checks must all be explicit passes');
  }
  if (typeof verification.note !== 'string' || verification.note.trim().length === 0) throw new Error('Wave B verification note is missing');
}

function assertDecisionBindings(editorial, audit, editorialDecisionSource, auditDecisionSource) {
  validateWaveBEditorialDecisionArtifact(editorialDecisionSource.value);
  validateWaveBAuditDecisionArtifact(auditDecisionSource.value);
  assertDeep(editorialDecisionSource.value.input_id, editorial.input_id, 'editorial decision input binding drifted');
  assertDeep(editorialDecisionSource.value.records, editorial.records, 'editorial input does not match the supplied decision artifact');
  assertDeep(editorialDecisionSource.value.session_id, editorial.provenance.session_id, 'editorial decision session binding drifted');
  assertDeep(auditDecisionSource.value.audit_id, audit.audit_id, 'audit decision audit binding drifted');
  assertDeep(auditDecisionSource.value.editorial_input_id, editorial.input_id, 'audit decision editorial binding drifted');
  assertDeep(auditDecisionSource.value.findings, audit.findings, 'audit input does not match the supplied audit findings');
  assertDeep(auditDecisionSource.value.session_id, audit.provenance.session_id, 'audit decision session binding drifted');
}

function assertReviewedStaging(staged, stagedBytes, editorial) {
  assertDeep(sha256(stagedBytes), editorial.reviewed_staging_sha256, 'reviewed staging digest drifted from editorial input');
  assertDeep(staged.records.map(recordOf).map(({ id }) => id), WAVE_B_IMPORTED_CANONICAL_IDS, 'reviewed staging canonical scope drifted');
}

export async function buildArtifacts({
  proposalPath,
  stagedRecordsPath,
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  baseCanonicalDirectory = DEFAULT_BASE_CANONICAL_DIRECTORY,
  editorialInputPath = DEFAULT_EDITORIAL_INPUT_PATH,
  auditInputPath = DEFAULT_AUDIT_INPUT_PATH,
  timingInputPath = DEFAULT_TIMING_INPUT_PATH,
  auditTimingInputPath = DEFAULT_AUDIT_TIMING_INPUT_PATH,
  relationDiffPath = DEFAULT_RELATION_DIFF_PATH,
  inventoryPath = DEFAULT_INVENTORY_PATH,
  verificationPath = DEFAULT_VERIFICATION_PATH,
  authorizationPath = DEFAULT_AUTHORIZATION_PATH,
  planPath = DEFAULT_PLAN_PATH,
  outputPath = DEFAULT_OUTPUT_PATH,
  metricsPath = DEFAULT_METRICS_PATH,
  stagePath = DEFAULT_STAGE_PATH,
} = {}) {
  if (!stagedRecordsPath) throw new Error('Wave B build requires --staged=<external-reviewed-shard.jsonl>');
  const resolvedStagingPath = path.resolve(stagedRecordsPath);
  const [editorialSource, auditSource, timingSource, auditTimingSource, relationDiffSource, inventorySource, verificationSource, authorizationSource, planSource, canonical, baseCanonical, staged] = await Promise.all([
    readJsonSource(path.resolve(editorialInputPath), 'Wave B editorial input'),
    readJsonSource(path.resolve(auditInputPath), 'Wave B audit input'),
    readJsonSource(path.resolve(timingInputPath), 'Wave B editorial timing input'),
    readJsonSource(path.resolve(auditTimingInputPath), 'Wave B post-freeze audit timing input'),
    readJsonSource(path.resolve(relationDiffPath), 'Wave B relation diff'),
    readJsonSource(path.resolve(inventoryPath), 'Wave B preimport inventory'),
    readJsonSource(path.resolve(verificationPath), 'Wave B verification'),
    readJsonSource(path.resolve(authorizationPath), 'Wave B authorization'),
    readJsonSource(path.resolve(planPath), 'M5-8 expansion plan'),
    readCanonicalRecords(path.resolve(canonicalDirectory)),
    readCanonicalRecords(path.resolve(baseCanonicalDirectory)),
    readCanonicalRecords(resolvedStagingPath),
  ]);
  const stagedBytes = await readFile(resolvedStagingPath);
  const editorial = editorialSource.value;
  const audit = auditSource.value;
  validateWaveBEditorialInput({
    input: editorial,
    inventoryEntries: inventorySource.value.entries,
    referenceRecords: mergeReferenceRecords(canonical.records, staged.records),
  });
  validateWaveBAuditInput({ audit, editorialInput: editorial, relationDiff: relationDiffSource.value });
  const editorialDecisionSource = await readJsonSource(
    path.resolve(REPOSITORY_DIRECTORY, editorial.decision_artifact.path),
    'Wave B editorial decision artifact',
  );
  const auditDecisionSource = await readJsonSource(
    path.resolve(REPOSITORY_DIRECTORY, audit.decision_artifact.path),
    'Wave B audit decision artifact',
  );
  assertDeep(editorialDecisionSource.sha256, editorial.decision_artifact.sha256, 'editorial decision artifact digest drifted');
  assertDeep(auditDecisionSource.sha256, audit.decision_artifact.sha256, 'audit decision artifact digest drifted');
  assertDecisionBindings(editorial, audit, editorialDecisionSource, auditDecisionSource);
  assertReviewedStaging(staged, stagedBytes, editorial);
  validateWaveBTimingInput(timingSource.value, { timingKind: 'editorial', reviewedStagingSha256: editorial.reviewed_staging_sha256, auditSessionId: audit.provenance.session_id });
  validateWaveBTimingInput(auditTimingSource.value, { timingKind: 'post-freeze-audit', reviewedStagingSha256: editorial.reviewed_staging_sha256, auditSessionId: audit.provenance.session_id });
  if (editorial.timing_artifact.path !== relativeSourcePath(timingInputPath) || editorial.timing_artifact.sha256 !== timingSource.sha256) throw new Error('editorial timing source binding drifted');
  if (audit.timing_artifact.path !== relativeSourcePath(auditTimingInputPath) || audit.timing_artifact.sha256 !== auditTimingSource.sha256) throw new Error('audit timing source binding drifted');
  if (audit.editorial_timing_artifact.path !== relativeSourcePath(timingInputPath) || audit.editorial_timing_artifact.sha256 !== timingSource.sha256) throw new Error('audit editorial timing source binding drifted');
  validateRelationDiff(relationDiffSource.value);
  assertDeep(relationDiffSource.value.batch_id, WAVE_B_BATCH_ID, 'Wave B relation diff batch_id drifted');
  assertDeep({ before_count: relationDiffSource.value.before_count, after_count: relationDiffSource.value.after_count, event_count: relationDiffSource.value.events.length }, { before_count: 0, after_count: 0, event_count: 0 }, 'Wave B relation diff must remain empty');
  await Promise.all([
    validateWaveBProvenanceArtifact({ input: editorial, subjectKind: 'editorial' }),
    validateWaveBProvenanceArtifact({ input: audit, subjectKind: 'audit' }),
  ]);
  assertVerification(verificationSource.value);
  const previousStagePath = path.join(BATCH_DIRECTORY, 'm5-10a-wave-a2.json');
  const previousStageSource = await readJsonSource(previousStagePath, 'Wave A2 stage report');
  assertAuthorization(authorizationSource.value, previousStageSource, editorial.proposal_staging.sha256);
  const canonicalSha256 = await hashCanonicalDirectory(canonicalDirectory);
  assertDeep(canonicalSummary(baseCanonical.records), { record_count: 670, start_count: 628, reference_only_count: 42, sense_count: 809, relation_count: 473, expression_count: 43 }, 'Wave B base canonical snapshot drifted');

  const manifest = createWaveBManifest({
    editorialInput: editorial,
    auditInput: audit,
    timingInput: timingSource.value,
    auditTimingInput: auditTimingSource.value,
    relationDiffSource: { path: relativeSourcePath(relationDiffPath), sha256: relationDiffSource.sha256, value: relationDiffSource.value },
    editorialInputSource: { path: relativeSourcePath(editorialInputPath), sha256: editorialSource.sha256 },
    auditInputSource: { path: relativeSourcePath(auditInputPath), sha256: auditSource.sha256 },
    timingInputSource: { path: relativeSourcePath(timingInputPath), sha256: timingSource.sha256 },
    auditTimingInputSource: { path: relativeSourcePath(auditTimingInputPath), sha256: auditTimingSource.sha256 },
  });
  await writeJson(outputPath, manifest);
  const manifestSource = await readJsonSource(outputPath, 'Wave B manifest');
  const metrics = createMetricsArtifact({
    manifest,
    relationDiff: relationDiffSource.value,
    canonicalRecords: canonical.records,
    source: {
      manifest: relativeSourcePath(outputPath),
      relation_diff: relativeSourcePath(relationDiffPath),
      canonical_directory: relativeSourcePath(canonicalDirectory),
    },
  });
  await writeJson(metricsPath, metrics);
  const metricsSource = await readJsonSource(metricsPath, 'Wave B metrics');
  const stageMetrics = createWaveBStageMetrics(metrics, verificationSource.value);
  const gate = evaluateExpansionGate(stageMetrics, planSource.value);
  const stage = {
    schema_version: '1',
    stage_id: WAVE_B_STAGE_ID,
    input: {
      inventory_revision: WAVE_B_INVENTORY_REVISION,
      canonical_snapshot: canonicalSummary(baseCanonical.records),
      previous_stage_report: { path: 'data/batches/m5-10a-wave-a2.json', sha256: previousStageSource.sha256 },
      authorization: { path: relativeSourcePath(authorizationPath), sha256: authorizationSource.sha256 },
    },
    target: { net_start_increase: WAVE_B_IMPORTED_START_COUNT, cumulative_start_target: WAVE_B_CUMULATIVE_START_COUNT, candidate_buffer: 20, selected_start_count: WAVE_B_SELECTED_START_COUNT },
    decisions: {
      included_start_count: metrics.derived.decisions.included,
      corrected_start_count: metrics.derived.decisions.corrected,
      held_start_count: metrics.derived.decisions.held,
      rejected_start_count: metrics.derived.decisions.rejected,
      deferred_start_count: metrics.derived.decisions.deferred,
    },
    buffer: { available_count: 20, used_count: 10, unused_count: 10 },
    actual: { canonical_snapshot: canonicalSummary(canonical.records), imported_start_count: WAVE_B_IMPORTED_START_COUNT },
    metrics: stageMetrics,
    source: {
      manifest: relativeSourcePath(outputPath),
      manifest_sha256: manifestSource.sha256,
      metrics: relativeSourcePath(metricsPath),
      metrics_sha256: metricsSource.sha256,
      relation_diff: relativeSourcePath(relationDiffPath),
      relation_diff_sha256: relationDiffSource.sha256,
      canonical_directory: relativeSourcePath(canonicalDirectory),
      canonical_sha256: canonicalSha256,
      verification: relativeSourcePath(verificationPath),
      verification_sha256: verificationSource.sha256,
      previous_stage_report: { path: 'data/batches/m5-10a-wave-a2.json', sha256: previousStageSource.sha256 },
      authorization: { path: relativeSourcePath(authorizationPath), sha256: authorizationSource.sha256 },
    },
    gate_status: gate.gate_status,
    decision: gate.decision,
    ready_to_create: false,
    next_stage_created: false,
    next_stage_authorized: false,
    note: 'Wave B is the final +150 bounded import for #96; no later stage is created or authorized by this result.',
  };
  await writeJson(stagePath, stage);
  const validation = await validateWaveB({
    manifestPath: outputPath,
    editorialInputPath,
    auditInputPath,
    timingInputPath,
    auditTimingInputPath,
    relationDiffPath,
    metricsPath,
    stagePath,
    verificationPath,
    inventoryPath,
    canonicalDirectory,
    baseCanonicalDirectory,
    planPath,
    authorizationPath,
    stagedRecordsPath: resolvedStagingPath,
    proposalPath,
  });
  return { manifest, metrics, stage, validation };
}

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) throw new Error(`arguments must use --name=value form (received ${argument})`);
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  const args = parseArguments(process.argv.slice(2));
  buildArtifacts({
    proposalPath: args.proposal,
    stagedRecordsPath: args.staged,
    canonicalDirectory: args['canonical-dir'] ?? DEFAULT_CANONICAL_DIRECTORY,
    baseCanonicalDirectory: args['base-canonical-dir'] ?? DEFAULT_BASE_CANONICAL_DIRECTORY,
  })
    .then((result) => console.log(`Built ${result.manifest.batch_id}; gate=${result.stage.gate_status}; imported=${result.stage.actual.imported_start_count}.`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
