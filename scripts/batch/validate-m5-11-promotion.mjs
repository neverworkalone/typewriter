import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';
import { validateDatasetRecords } from '../validate/dataset-integrity.mjs';
import { validateTargetInventory } from '../validate/target-inventory.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import { evaluateExpansionGate } from './validate-m5-8-process.mjs';
import { M5_11_BATCH_ID, expectedCanonicalId } from './m5-11-editorial.mjs';
import {
  M5_11_BASE_CANONICAL_SHA256,
  M5_11_BASE_INVENTORY_SHA256,
  M5_11_BASE_SEED_SHA256,
  REPOSITORY_DIRECTORY,
} from './validate-m5-11.mjs';
import {
  M5_11_MACHINE_CHECK_IDS,
} from './validate-m5-11-admission.mjs';

const require = createRequire(import.meta.url);
const DEFAULT_PLAN = require('../../data/batches/m5-8-expansion-plan.json');
const DURABLE_GATE_EVIDENCE_VERSION = 'm5-11-gate-evidence-v1';

const SOURCE_KEYS = Object.freeze([
  'proposal',
  'editorial',
  'editorial_timing',
  'audit',
  'audit_timing',
  'relation_diff',
  'verification',
  'reviewed_import',
  'authorization',
  'base_inventory',
]);
const EXTERNAL_SOURCE_KEYS = new Set(SOURCE_KEYS.slice(0, 8));

const DEFAULT_MANIFEST_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-11-admission.json',
);
const DEFAULT_PROMOTION_EVIDENCE_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-11-promotion.json',
);
const DEFAULT_SEED_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/inventory/m5-target-seed.json',
);
const DEFAULT_INVENTORY_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/inventory/m5-target-inventory.json',
);

export class M511PromotionValidationError extends Error {
  constructor(message, code = 'M5_11_PROMOTION_VALIDATION_ERROR') {
    super(message);
    this.name = 'M511PromotionValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M5_11_PROMOTION_VALIDATION_ERROR') {
  throw new M511PromotionValidationError(message, code);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function canonicalSummary(records) {
  return {
    record_count: records.length,
    start_count: records.filter(({ role }) => role === 'start').length,
    reference_only_count: records.filter(({ role }) => role === 'reference-only').length,
    sense_count: records.reduce((sum, record) => sum + record.senses.length, 0),
    relation_count: records.reduce(
      (sum, record) => sum + record.senses.reduce(
        (inner, sense) => inner + (sense.relations?.length ?? 0),
        0,
      ),
      0,
    ),
    expression_count: records.filter(({ record_type: recordType }) => recordType === 'expression').length,
  };
}

function repositoryPath(value, label) {
  const resolved = path.resolve(REPOSITORY_DIRECTORY, value);
  const relative = path.relative(REPOSITORY_DIRECTORY, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} must remain inside the repository: ${resolved}`, 'REPOSITORY_PATH_REQUIRED');
  }
  return resolved;
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

function sourceRef(manifest, key) {
  const source = manifest.sources?.[key];
  if (!source || source.source_id !== key || typeof source.path !== 'string' || typeof source.sha256 !== 'string') {
    fail(`admission manifest is missing sources.${key}`, 'SOURCE_BINDING_MISMATCH');
  }
  if (!/^[a-f0-9]{64}$/u.test(source.sha256)) {
    fail(`admission manifest source ${key} has an invalid digest`, 'SOURCE_BINDING_MISMATCH');
  }
  if (EXTERNAL_SOURCE_KEYS.has(key) && source.path !== `external:${key}`) {
    fail(`admission manifest source ${key} must use a portable external label`, 'SOURCE_BINDING_MISMATCH');
  }
  if (!EXTERNAL_SOURCE_KEYS.has(key) && (path.isAbsolute(source.path) || source.path.startsWith('../'))) {
    fail(`admission manifest source ${key} must use a repository-relative path`, 'SOURCE_BINDING_MISMATCH');
  }
  return source;
}

function assertDurableSourceSet(manifest, evidence) {
  for (const key of SOURCE_KEYS) {
    const manifestSource = sourceRef(manifest, key);
    const evidenceSource = evidence.sources?.[key];
    if (!evidenceSource
      || evidenceSource.source_id !== key
      || evidenceSource.path !== manifestSource.path
      || evidenceSource.sha256 !== manifestSource.sha256) {
      fail(`promotion evidence source ${key} drifted`, 'SOURCE_BINDING_MISMATCH');
    }
  }
}

function assertSummary(actual, expected, label) {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    fail(`${label} drifted`, 'CANONICAL_COUNT_MISMATCH');
  }
}

function validateDurableTiming(timing, expectedPassIds, field, label) {
  if (!timing || timing.status !== 'complete' || timing.unmeasured_pass_count !== 0) {
    fail(`${label} is not a complete measured timing summary`, 'TIMING_EVIDENCE_MISMATCH');
  }
  if (!Array.isArray(timing.pass_ids)
    || JSON.stringify(timing.pass_ids) !== JSON.stringify(expectedPassIds)
    || !Array.isArray(timing.pass_intervals)
    || timing.pass_intervals.length !== expectedPassIds.length) {
    fail(`${label} pass coverage drifted`, 'TIMING_EVIDENCE_MISMATCH');
  }
  if (!/^[a-f0-9]{64}$/u.test(timing.recording_proof_sha256)) {
    fail(`${label} is missing the recorder proof`, 'TIMING_EVIDENCE_MISMATCH');
  }
  let previousCompletedAt;
  let measuredSeconds = 0;
  for (const [index, pass] of timing.pass_intervals.entries()) {
    if (pass.id !== expectedPassIds[index]
      || !Number.isFinite(pass.wall_clock_seconds)
      || !Number.isFinite(pass.measured_seconds)
      || Date.parse(pass.started_at) > Date.parse(pass.completed_at)) {
      fail(`${label} pass ${index} is not a valid derived interval`, 'TIMING_EVIDENCE_MISMATCH');
    }
    const startedAt = Date.parse(pass.started_at);
    const completedAt = Date.parse(pass.completed_at);
    if (previousCompletedAt !== undefined && startedAt < previousCompletedAt) {
      fail(`${label} pass chronology drifted`, 'TIMING_EVIDENCE_MISMATCH');
    }
    const elapsed = (completedAt - startedAt) / 1000;
    if (Math.abs(elapsed - pass.wall_clock_seconds) > 1e-9
      || Math.abs(pass.measured_seconds - (pass.unit_count === 0 ? 0 : elapsed)) > 1e-9) {
      fail(`${label} pass duration is not recorder-derived`, 'TIMING_EVIDENCE_MISMATCH');
    }
    measuredSeconds += pass.measured_seconds;
    previousCompletedAt = completedAt;
  }
  if (Math.abs(measuredSeconds - timing[field]) > 1e-9) {
    fail(`${label}.${field} is not derived from pass intervals`, 'TIMING_EVIDENCE_MISMATCH');
  }
}

function validateDurableGateEvidence(manifest, evidence) {
  const manifestGateEvidence = manifest.gate_evidence;
  const evidenceGateEvidence = evidence.gate_evidence;
  if (!manifestGateEvidence || !evidenceGateEvidence
    || manifestGateEvidence.evidence_version !== DURABLE_GATE_EVIDENCE_VERSION
    || evidenceGateEvidence.evidence_version !== DURABLE_GATE_EVIDENCE_VERSION) {
    fail('promotion evidence is missing the durable gate evidence contract', 'GATE_EVIDENCE_MISSING');
  }
  if (manifest.gate_evidence_sha256 !== sha256Json(manifestGateEvidence)
    || evidence.gate_evidence_sha256 !== sha256Json(evidenceGateEvidence)
    || manifest.gate_evidence_sha256 !== evidence.gate_evidence_sha256) {
    fail('durable gate evidence digest drifted', 'GATE_EVIDENCE_DIGEST_MISMATCH');
  }
  assertSummary(evidenceGateEvidence, manifestGateEvidence, 'durable gate evidence');
  const gateEvidence = evidenceGateEvidence;
  assertSummary(gateEvidence.base_summary, manifest.base, 'durable gate base summary');
  assertSummary(gateEvidence.final_summary, manifest.actual, 'durable gate final summary');
  assertSummary(gateEvidence.metrics, manifest.metrics, 'durable gate metrics');
  assertSummary(gateEvidence.relation, manifest.relation, 'durable gate relation');
  assertSummary(gateEvidence.timing, manifest.timing, 'durable gate timing');
  assertSummary(gateEvidence.audit, manifest.audit, 'durable gate audit');
  assertSummary(gateEvidence.verification, manifest.verification, 'durable gate verification');
  assertSummary(gateEvidence.gate, manifest.gate, 'durable gate decision');

  const decisions = gateEvidence.decision_counts;
  if (!decisions
    || decisions.included + decisions.corrected !== gateEvidence.imported_start_count
    || decisions.processed_start_count !== decisions.included
      + decisions.corrected + decisions.held + decisions.rejected
    || decisions.processed_start_count + decisions.deferred !== 550
    || decisions.held + decisions.rejected + decisions.deferred !== 50) {
    fail('durable gate decision arithmetic drifted', 'GATE_EVIDENCE_METRICS_MISMATCH');
  }
  if (gateEvidence.imported_start_count !== 500) {
    fail('durable gate imported count drifted', 'GATE_EVIDENCE_METRICS_MISMATCH');
  }

  validateDurableTiming(
    gateEvidence.timing.editorial,
    ['target-preparation', 'initial-review', 'feedback-fixes', 'final-verification', 'held-rejected'],
    'editor_seconds',
    'durable editorial timing',
  );
  validateDurableTiming(
    gateEvidence.timing.audit,
    ['post-freeze-audit'],
    'audit_seconds',
    'durable audit timing',
  );
  const editorialEnd = Date.parse(gateEvidence.timing.editorial.pass_intervals.at(-1).completed_at);
  const auditStart = Date.parse(gateEvidence.timing.audit.pass_intervals[0].started_at);
  if (auditStart < editorialEnd) {
    fail('durable audit timing starts before editorial timing completed', 'TIMING_EVIDENCE_MISMATCH');
  }
  if (gateEvidence.timing.editorial.session_id === gateEvidence.timing.audit.session_id
    || gateEvidence.audit.session_id !== gateEvidence.timing.audit.session_id) {
    fail('durable audit session is not independent', 'AUDIT_EVIDENCE_MISMATCH');
  }

  const verification = gateEvidence.verification;
  if (verification.machine_generated !== true
    || verification.editorial_review_complete !== true
    || verification.human_editorial_review_complete !== true
    || verification.canonical_integrity !== true
    || verification.deterministic_sqlite !== true
    || verification.search_product_regression !== true
    || verification.raw_material_excluded !== true
    || !Array.isArray(verification.checks)
    || JSON.stringify(verification.checks.map(({ id }) => id)) !== JSON.stringify(M5_11_MACHINE_CHECK_IDS)
    || verification.checks.some(({ status, result_sha256 }) => status !== 'pass' || !/^[a-f0-9]{64}$/u.test(result_sha256))) {
    fail('durable machine verification evidence is incomplete', 'VERIFICATION_EVIDENCE_MISMATCH');
  }

  const metrics = {
    correction_rate_of_selected: decisions.corrected / decisions.processed_start_count,
    relation_noise_rate_of_candidates: gateEvidence.relation.noise_rate_of_candidates
      ?? gateEvidence.relation.noise_rate_of_before,
    editor_seconds_per_selected_start: gateEvidence.timing.editorial.editor_seconds
      / decisions.processed_start_count,
    editor_seconds_per_processed_start: gateEvidence.timing.editorial.editor_seconds
      / decisions.processed_start_count,
    editor_time_status: 'measured',
    timing_status: gateEvidence.timing.editorial.status === 'complete'
      && gateEvidence.timing.audit.status === 'complete'
      ? 'complete'
      : 'incomplete',
    unmeasured_timing_pass_count: gateEvidence.timing.editorial.unmeasured_pass_count
      + gateEvidence.timing.audit.unmeasured_pass_count,
    audit_status: gateEvidence.audit.status,
    audit_independent: gateEvidence.audit.independent,
    open_audit_blocker_count: gateEvidence.audit.open_blocker_count,
    editorial_review_complete: verification.editorial_review_complete,
    human_editorial_review_complete: verification.human_editorial_review_complete,
    canonical_integrity: verification.canonical_integrity,
    deterministic_sqlite: verification.deterministic_sqlite,
    search_product_regression: verification.search_product_regression,
  };
  assertSummary(metrics, gateEvidence.metrics, 'durable gate derived metrics');
  const recomputedGate = evaluateExpansionGate(metrics, DEFAULT_PLAN);
  recomputedGate.quality_passes.exact_net_start_increase = gateEvidence.final_summary.start_count
    - gateEvidence.base_summary.start_count === gateEvidence.imported_start_count;
  recomputedGate.gate_status = Object.values(recomputedGate.quality_passes).every(Boolean) ? 'pass' : 'fail';
  recomputedGate.decision = recomputedGate.gate_status === 'pass'
    ? 'APPROVE BOUNDED'
    : DEFAULT_PLAN.gate.failure_decision;
  assertSummary(recomputedGate, gateEvidence.gate, 'durable gate recomputation');

  return gateEvidence;
}

export function validateM511DurableEvidence({ manifest, evidence } = {}) {
  if (!manifest || manifest.schema_version !== '1' || manifest.issue !== 97 || manifest.batch_id !== M5_11_BATCH_ID) {
    fail('admission manifest is not bound to M5-11 issue #97', 'SCOPE_MISMATCH');
  }
  if (manifest.gate?.gate_status !== 'pass' || manifest.gate?.decision !== 'APPROVE BOUNDED') {
    fail('admission manifest does not contain a passing gate', 'GATE_REQUIRED');
  }
  if (!evidence || evidence.schema_version !== '1' || evidence.issue !== 97 || evidence.batch_id !== M5_11_BATCH_ID) {
    fail('promotion evidence is not bound to M5-11 issue #97', 'SCOPE_MISMATCH');
  }
  if (evidence.promotion?.canonical_mutation !== true
    || evidence.promotion?.seed_mutation !== true
    || evidence.promotion?.inventory_mutation !== true
    || evidence.promotion?.explicit !== true) {
    fail('promotion evidence does not record all explicit mutations', 'PROMOTION_STATE_MISMATCH');
  }
  assertDurableSourceSet(manifest, evidence);
  validateDurableGateEvidence(manifest, evidence);
  assertSummary(evidence.gate, manifest.gate, 'promotion gate');
  assertSummary(evidence.actual, manifest.actual, 'promotion final summary');
  assertSummary(evidence.base?.summary, manifest.base, 'promotion base summary');
  assertSummary(evidence.metrics, manifest.metrics, 'promotion metrics');
  assertSummary(evidence.relation, manifest.relation, 'promotion relation evidence');
  assertSummary(evidence.timing, manifest.timing, 'promotion timing evidence');
  assertSummary(evidence.audit, manifest.audit, 'promotion audit evidence');
  assertSummary(evidence.verification, manifest.verification, 'promotion verification evidence');
  if (evidence.authorization !== manifest.authorization) {
    fail('promotion authorization drifted', 'SOURCE_BINDING_MISMATCH');
  }
  if (evidence.base.canonical_directory_sha256 !== M5_11_BASE_CANONICAL_SHA256
    || evidence.base.inventory_sha256 !== M5_11_BASE_INVENTORY_SHA256
    || evidence.base.seed_sha256 !== M5_11_BASE_SEED_SHA256) {
    fail('promotion evidence base digest chain drifted', 'SOURCE_BINDING_MISMATCH');
  }

  const decisions = evidence.decisions;
  if (!decisions || decisions.included + decisions.corrected !== 500
    || decisions.held + decisions.rejected + decisions.deferred !== 50
    || decisions.processed_start_count !== decisions.included
      + decisions.corrected + decisions.held + decisions.rejected
    || decisions.imported_start_count !== 500
    || decisions.processed_start_count + decisions.deferred !== 550) {
    fail('promotion decision arithmetic drifted', 'OUTPUT_COUNT_MISMATCH');
  }
  const target = evidence.target ?? manifest.target;
  assertSummary(target, manifest.target, 'promotion target');
  if (target?.net_start_increase !== 500
    || target?.cumulative_start_target !== 1278
    || target?.candidate_buffer !== 50) {
    fail('promotion target drifted', 'OUTPUT_COUNT_MISMATCH');
  }
  if (evidence.stage?.status !== 'passed'
    || evidence.stage?.target?.net_start_increase !== 500
    || evidence.stage?.target?.cumulative_start_target !== 1278) {
    fail('promotion stage evidence is not the bounded +500 stage', 'PROMOTION_STATE_MISMATCH');
  }
  if (evidence.actual.start_count !== 1278
    || evidence.actual.record_count !== 1320
    || evidence.actual.reference_only_count !== 42
    || evidence.actual.start_count - evidence.base.summary.start_count !== 500
    || evidence.actual.record_count - evidence.base.summary.record_count !== 500) {
    fail('promotion final summary does not prove the +500 admission target', 'CANONICAL_COUNT_MISMATCH');
  }
  if (!evidence.outputs || typeof evidence.outputs !== 'object') {
    fail('promotion evidence is missing durable output evidence', 'OUTPUT_BINDING_MISMATCH');
  }
  return {
    batch_id: M5_11_BATCH_ID,
    gate: evidence.gate,
    summary: evidence.actual,
    sources: evidence.sources,
    outputs: evidence.outputs,
  };
}

export async function validateM511Promotion({
  manifestPath = DEFAULT_MANIFEST_PATH,
  promotionEvidencePath = DEFAULT_PROMOTION_EVIDENCE_PATH,
  currentCanonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  currentSeedPath = DEFAULT_SEED_PATH,
  currentInventoryPath = DEFAULT_INVENTORY_PATH,
} = {}) {
  const resolvedManifestPath = repositoryPath(manifestPath, 'manifest path');
  const resolvedEvidencePath = repositoryPath(promotionEvidencePath, 'promotion evidence path');
  const resolvedCanonicalDirectory = repositoryPath(currentCanonicalDirectory, 'canonical directory');
  const resolvedSeedPath = repositoryPath(currentSeedPath, 'seed path');
  const resolvedInventoryPath = repositoryPath(currentInventoryPath, 'inventory path');
  const manifest = await readJson(resolvedManifestPath, 'M5-11 admission manifest');
  const evidence = await readJson(resolvedEvidencePath, 'M5-11 promotion evidence');

  const durable = validateM511DurableEvidence({ manifest, evidence });

  const canonical = await readCanonicalRecords(resolvedCanonicalDirectory);
  validateDatasetRecords(canonical.records, { checkPilotCompleteness: true });
  const finalRecords = canonical.records.map(({ record }) => record);
  const finalSummary = canonicalSummary(finalRecords);
  assertSummary(finalSummary, durable.summary, 'canonical promotion output');

  const importOutput = evidence.outputs?.canonical_import;
  if (!importOutput || typeof importOutput.path !== 'string' || typeof importOutput.sha256 !== 'string') {
    fail('promotion evidence is missing the canonical import output', 'OUTPUT_BINDING_MISMATCH');
  }
  const resolvedImportPath = repositoryPath(importOutput.path, 'canonical import output');
  const importBytes = await readFile(resolvedImportPath);
  if (sha256(importBytes) !== importOutput.sha256) {
    fail('canonical import output digest drifted', 'OUTPUT_DIGEST_MISMATCH');
  }
  const imported = await readCanonicalRecords(resolvedImportPath);
  const importedRecords = imported.records.map(({ record }) => record);
  if (importedRecords.length !== evidence.decisions.imported_start_count) {
    fail('canonical import output count drifted', 'CANONICAL_COUNT_MISMATCH');
  }
  for (const [index, record] of importedRecords.entries()) {
    const expectedId = expectedCanonicalId(index);
    if (record.id !== expectedId || record.role !== 'start' || record.candidate_id !== expectedId) {
      fail(`canonical import output row ${index} is not deterministically rebased`, 'CANONICAL_ID_MISMATCH');
    }
  }
  const finalById = new Map(finalRecords.map((record) => [record.id, record]));
  for (const record of importedRecords) {
    assertSummary(finalById.get(record.id), record, `promoted canonical ${record.id}`);
  }

  const canonicalDigest = await hashCanonicalDirectory(resolvedCanonicalDirectory);
  if (canonicalDigest !== evidence.outputs.canonical_directory_sha256) {
    fail('canonical directory digest drifted after promotion', 'OUTPUT_DIGEST_MISMATCH');
  }
  const seedBytes = await readFile(resolvedSeedPath);
  if (sha256(seedBytes) !== evidence.outputs.seed?.sha256) {
    fail('promoted seed digest drifted', 'OUTPUT_DIGEST_MISMATCH');
  }
  const seed = JSON.parse(seedBytes.toString('utf8'));
  if (seed.targets.length !== evidence.outputs.seed?.target_count) {
    fail('promoted seed target count drifted', 'OUTPUT_COUNT_MISMATCH');
  }
  const admittedSeedEntries = seed.targets.filter(({ inventory_id: inventoryId }) => {
    const number = Number(inventoryId.slice(3));
    return inventoryId.startsWith('m5-') && number >= 535 && number <= 1084;
  });
  if (admittedSeedEntries.length !== 550) {
    fail('promoted seed does not contain the complete 550-row M5-11 scope', 'OUTPUT_COUNT_MISMATCH');
  }
  const seedStatusCounts = Object.fromEntries(
    ['promoted', 'held', 'rejected', 'deferred'].map((status) => [
      status,
      admittedSeedEntries.filter((entry) => entry.status === status).length,
    ]),
  );
  if (seedStatusCounts.promoted !== 500
    || seedStatusCounts.promoted !== evidence.decisions.included + evidence.decisions.corrected
    || seedStatusCounts.held !== evidence.decisions.held
    || seedStatusCounts.rejected !== evidence.decisions.rejected
    || seedStatusCounts.deferred !== evidence.decisions.deferred
    || seedStatusCounts.held + seedStatusCounts.rejected + seedStatusCounts.deferred !== 50) {
    fail('promoted seed decision arithmetic drifted', 'OUTPUT_COUNT_MISMATCH');
  }
  const inventoryBytes = await readFile(resolvedInventoryPath);
  if (sha256(inventoryBytes) !== evidence.outputs.inventory?.sha256) {
    fail('promoted inventory digest drifted', 'OUTPUT_DIGEST_MISMATCH');
  }
  const inventory = await validateTargetInventory({
    inventoryPath: resolvedInventoryPath,
    canonicalDirectory: resolvedCanonicalDirectory,
    checkPilotCompleteness: true,
  });
  assertSummary({
    record_count: inventory.canonicalRecordCount,
    start_count: inventory.currentStartCount,
    reference_only_count: inventory.currentReferenceOnlyCount,
  }, {
    record_count: durable.summary.record_count,
    start_count: durable.summary.start_count,
    reference_only_count: durable.summary.reference_only_count,
  }, 'promoted inventory snapshot');
  if (inventory.inventoryEntryCount !== evidence.outputs.inventory?.entry_count
    || inventory.canonicalRecordCount !== evidence.outputs.inventory?.canonical_record_count) {
    fail('promoted inventory output counts drifted', 'OUTPUT_COUNT_MISMATCH');
  }

  return {
    batch_id: M5_11_BATCH_ID,
    gate: durable.gate,
    summary: finalSummary,
    inventory,
    outputs: evidence.outputs,
    sources: evidence.sources,
  };
}

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) {
      throw new Error(`arguments must use --name=value form (received ${argument})`);
    }
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const args = parseArguments(process.argv.slice(2));
  validateM511Promotion({
    manifestPath: args.manifest ?? DEFAULT_MANIFEST_PATH,
    promotionEvidencePath: args.evidence ?? DEFAULT_PROMOTION_EVIDENCE_PATH,
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}
