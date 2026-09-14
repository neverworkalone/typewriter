import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';
import { DEFAULT_SEMANTIC_AUDIT_PATH } from '../validate/semantic-audit.mjs';
import { validateLexicalAddition } from './lexical-admission.mjs';
import { productionSourceBytes } from './lexical-production-state.mjs';
import {
  generateTargetInventory,
} from '../inventory/generate-target-inventory.mjs';
import {
  validateTargetInventory,
} from '../validate/target-inventory.mjs';
import {
  hashCanonicalDirectory,
} from './validate-m5-8-process.mjs';
import {
  M5_11_CATALOG,
} from './m5-11-catalog.mjs';
import {
  M5_11_AGENT_GATE_DECISION,
  M5_11_BATCH_ID,
  sha256Json,
} from './m5-11-editorial.mjs';
import {
  M5_11_BASE_CANONICAL_SHA256,
  M5_11_BASE_INVENTORY_SHA256,
  M5_11_BASE_SEED_SHA256,
  REPOSITORY_DIRECTORY,
} from './validate-m5-11.mjs';
import {
  validateM511Admission,
} from './validate-m5-11-admission.mjs';

const DEFAULT_MANIFEST_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-11-admission.json',
);
const DEFAULT_CANONICAL_IMPORT_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/canonical/m5-11-expansion.jsonl',
);
const DEFAULT_SEED_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/inventory/m5-target-seed.json',
);
const DEFAULT_INVENTORY_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/inventory/m5-target-inventory.json',
);
const DEFAULT_PROMOTION_EVIDENCE_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-11-promotion.json',
);

const IMPORTABLE_DECISIONS = new Set(['included', 'corrected']);
const RESERVE_DECISIONS = new Set(['held', 'rejected', 'deferred']);

export class M511PromotionError extends Error {
  constructor(message, code = 'M5_11_PROMOTION_ERROR') {
    super(message);
    this.name = 'M511PromotionError';
    this.code = code;
  }
}

function fail(message, code = 'M5_11_PROMOTION_ERROR') {
  throw new M511PromotionError(message, code);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function unique(values) {
  return [...new Set(values)];
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

function senseProfile(record) {
  if (record.record_type === 'expression') return 'expression';
  const positions = unique(record.senses.map(({ pos }) => pos));
  if (record.senses.length > 1 && positions.length > 1) return 'boundary';
  if (record.senses.length > 1) return 'polysemy';
  return 'single';
}

function seedFlags(record, catalogEntry) {
  return unique([
    ...catalogEntry.flags,
    ...(record.record_type === 'expression' ? ['expression-unit'] : []),
    ...(record.senses.length > 1 ? ['polysemy'] : []),
  ]);
}

function decisionNote(decision, inventoryId) {
  const note = decision.decision_note ?? decision.note;
  if (typeof note !== 'string' || note.trim().length === 0) {
    fail(
      `decision ${inventoryId} must carry an explicit decision_note before promotion`,
      'DECISION_NOTE_REQUIRED',
    );
  }
  return note;
}

function recordForDecision(decisionResult, proposalRow) {
  return decisionResult.record ?? proposalRow.candidate_record;
}

function seedEntryForDecision({ catalogEntry, proposalRow, decisionResult }) {
  const decision = decisionResult.decision;
  const inventoryId = catalogEntry.inventory_id;
  if (decision.inventory_id !== inventoryId || proposalRow.inventory_id !== inventoryId) {
    fail(`promotion source order drifted at ${inventoryId}`, 'PROMOTION_SCOPE_MISMATCH');
  }

  const isImported = IMPORTABLE_DECISIONS.has(decision.decision);
  const isReserve = RESERVE_DECISIONS.has(decision.decision);
  if (!isImported && !isReserve) {
    fail(`unsupported promotion decision ${decision.decision} for ${inventoryId}`, 'PROMOTION_DECISION_INVALID');
  }

  const record = recordForDecision(decisionResult, proposalRow);
  if (!record || typeof record !== 'object') {
    fail(`promotion decision ${inventoryId} has no record body`, 'PROMOTION_RECORD_MISSING');
  }
  if (record.lemma !== proposalRow.candidate_lemma && decision.decision !== 'corrected') {
    fail(`non-corrected decision ${inventoryId} drifted from the proposal lemma`, 'PROMOTION_SOURCE_MISMATCH');
  }

  const entry = {
    inventory_id: inventoryId,
    status: isImported ? 'promoted' : decision.decision,
    planned_role: isImported || decision.decision === 'held' ? 'start' : null,
    record_type: record.record_type,
    lemma: record.lemma,
    search_forms: [...record.search_forms],
    reason_codes: [catalogEntry.axis],
    pos: unique(record.senses.map(({ pos }) => pos)),
    sense_profile: senseProfile(record),
    flags: seedFlags(record, catalogEntry),
    decision_note: decisionNote(decision, inventoryId),
  };

  if (isImported) {
    if (!decisionResult.record) {
      fail(`imported decision ${inventoryId} is missing the reviewed canonical record`, 'PROMOTION_RECORD_MISSING');
    }
    entry.canonical_id = decisionResult.record.id;
  }

  return entry;
}

export function buildM511PromotionSeed({
  seed,
  catalog = M5_11_CATALOG,
  proposalRows,
  editorialDecisions,
} = {}) {
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) {
    fail('M5 seed must be an object', 'SEED_SHAPE_ERROR');
  }
  if (!Array.isArray(seed.targets)) fail('M5 seed.targets must be an array', 'SEED_SHAPE_ERROR');
  if (!Array.isArray(proposalRows) || proposalRows.length !== catalog.length) {
    fail('promotion proposal rows must cover the complete catalog', 'PROMOTION_SCOPE_MISMATCH');
  }
  if (!Array.isArray(editorialDecisions) || editorialDecisions.length !== catalog.length) {
    fail('promotion decisions must cover the complete catalog', 'PROMOTION_SCOPE_MISMATCH');
  }

  const existingIds = new Set(seed.targets.map(({ inventory_id: inventoryId }) => inventoryId));
  const additions = catalog.map((catalogEntry, index) => {
    if (existingIds.has(catalogEntry.inventory_id)) {
      fail(
        `M5-11 inventory ${catalogEntry.inventory_id} already exists in the seed; promotion is not replayable`,
        'PROMOTION_ALREADY_APPLIED',
      );
    }
    const entry = seedEntryForDecision({
      catalogEntry,
      proposalRow: proposalRows[index],
      decisionResult: editorialDecisions[index],
    });
    existingIds.add(entry.inventory_id);
    return entry;
  });

  return {
    ...seed,
    targets: [...seed.targets, ...additions],
  };
}

export function createM511ImportBytes(records) {
  if (!Array.isArray(records)) fail('reviewed records must be an array', 'PROMOTION_RECORD_SHAPE_ERROR');
  return Buffer.from(
    records.length === 0
      ? ''
      : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
}

function repositoryPath(value, label) {
  const resolved = path.resolve(REPOSITORY_DIRECTORY, value);
  const relative = path.relative(REPOSITORY_DIRECTORY, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} must remain inside the repository: ${resolved}`, 'REPOSITORY_PATH_REQUIRED');
  }
  return resolved;
}

function sourceFromManifest(manifest, key, { optional = false } = {}) {
  const source = manifest.sources?.[key];
  if (!source && optional) return undefined;
  if (!source || source.source_id !== key || typeof source.path !== 'string' || typeof source.sha256 !== 'string') {
    fail(`admission manifest is missing sources.${key}`, 'MANIFEST_SOURCE_MISSING');
  }
  return source;
}

function assertManifestSource(result, manifest, key) {
  const expected = sourceFromManifest(manifest, key);
  const actual = result.sources[key];
  if (!actual || actual.sha256 !== expected.sha256) {
    fail(`admission manifest source ${key} drifted`, 'MANIFEST_SOURCE_MISMATCH');
  }
}

function requireExternalPath(value, key) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`promotion requires the external --${key} source path`, 'EXTERNAL_INPUT_REQUIRED');
  }
  return value;
}

function assertNoMutationManifest(manifest) {
  if (manifest.schema_version !== '1' || manifest.issue !== 97 || manifest.batch_id !== M5_11_BATCH_ID) {
    fail('admission manifest is not bound to M5-11 issue #97', 'MANIFEST_SCOPE_MISMATCH');
  }
  if (manifest.gate?.gate_status !== 'pass'
    || !['APPROVE BOUNDED', M5_11_AGENT_GATE_DECISION].includes(manifest.gate?.decision)) {
    fail(
      'only a passing APPROVE BOUNDED admission manifest (or APPROVE AUTOMATED BOUNDED for M5-11A) may be promoted',
      'PROMOTION_GATE_REQUIRED',
    );
  }
  if (manifest.promotion?.canonical_mutation !== false
    || manifest.promotion?.seed_mutation !== false
    || manifest.promotion?.inventory_mutation !== false) {
    fail('admission manifest has already been consumed or has an invalid promotion guard', 'PROMOTION_ALREADY_APPLIED');
  }
}

async function readJson(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${filePath}`, 'MISSING_INPUT');
    throw error;
  }
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_JSON');
  }
}

async function assertMissing(filePath, label) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  fail(`${label} already exists; promotion is not replayable: ${filePath}`, 'PROMOTION_ALREADY_APPLIED');
}

function assertResultMatchesManifest(result, manifest) {
  assert.deepEqual(result.base_summary, manifest.base, 'admission base summary drifted');
  assert.deepEqual(result.final_summary, manifest.actual, 'admission final summary drifted');
  assert.deepEqual(result.decision_counts, {
    included: manifest.decisions.included,
    corrected: manifest.decisions.corrected,
    held: manifest.decisions.held,
    rejected: manifest.decisions.rejected,
    deferred: manifest.decisions.deferred,
  }, 'admission decision counts drifted');
  assert.deepEqual(result.gate, manifest.gate, 'admission gate drifted');
  assert.deepEqual(result.verification, manifest.verification, 'admission verification drifted');
  assert.deepEqual(result.gate_evidence, manifest.gate_evidence, 'admission durable gate evidence drifted');
  if (sha256Json(result.gate_evidence) !== manifest.gate_evidence_sha256) {
    fail('admission durable gate evidence digest drifted', 'MANIFEST_SOURCE_MISMATCH');
  }
}

async function buildProspectiveState({
  currentCanonicalDirectory,
  currentSeedPath,
  result,
  importPath,
  semanticAudit,
} = {}) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-11-promotion-'));
  const temporaryCanonicalDirectory = path.join(temporaryDirectory, 'canonical');
  const temporarySeedPath = path.join(temporaryDirectory, 'm5-target-seed.json');
  const temporaryInventoryPath = path.join(temporaryDirectory, 'm5-target-inventory.json');

  try {
    const baseCanonical = await readCanonicalRecords(currentCanonicalDirectory);
    await cp(currentCanonicalDirectory, temporaryCanonicalDirectory, { recursive: true });
    const importBytes = createM511ImportBytes(result.imported_records);
    await writeFile(path.join(temporaryCanonicalDirectory, path.basename(importPath)), importBytes);

    const currentSeedSource = await readJson(currentSeedPath, 'current M5 seed');
    const promotedSeed = buildM511PromotionSeed({
      seed: currentSeedSource.value,
      catalog: M5_11_CATALOG,
      proposalRows: result.proposal_rows,
      editorialDecisions: result.editorial_decisions,
    });
    const seedBytes = Buffer.from(`${JSON.stringify(promotedSeed, null, 2)}\n`, 'utf8');
    await writeFile(temporarySeedPath, seedBytes);

    const generatedInventory = await generateTargetInventory({
      canonicalDirectory: temporaryCanonicalDirectory,
      seedPath: temporarySeedPath,
      generatedFromCanonicalDirectory: currentCanonicalDirectory,
      generatedFromSeedPath: currentSeedPath,
      canonicalScopeDirectory: currentCanonicalDirectory,
      outputPath: temporaryInventoryPath,
    });
    const inventoryValidation = await validateTargetInventory({
      inventoryPath: temporaryInventoryPath,
      canonicalDirectory: temporaryCanonicalDirectory,
      checkPilotCompleteness: true,
    });
    const canonical = await readCanonicalRecords(temporaryCanonicalDirectory);
    const canonicalRecords = canonical.records.map(({ record }) => record);
    if (!result.production_state) {
      fail('M5-11 promotion requires the shared production state from the passing admission gate', 'MISSING_PRODUCTION_STATE');
    }
    const productionStateSources = {
      candidate_intake: result.sources?.proposal?.bytes,
      semantic_review: result.sources?.editorial?.bytes,
      selection: result.sources?.editorial?.bytes,
      prospective_canonical: productionSourceBytes(canonicalRecords),
      audit: result.sources?.semantic_audit?.bytes,
      admission: result.sources?.authorization?.bytes ?? result.sources?.reviewed_import?.bytes,
    };
    validateLexicalAddition({
      batchId: M5_11_BATCH_ID,
      baseRecords: baseCanonical.records,
      reviewedRecords: result.imported_records,
      prospectiveRecords: canonical.records,
      semanticAudit,
      productionState: result.production_state,
      productionStateSources,
      checkPilotCompleteness: true,
      reviewedLabel: 'M5-11 promotion reviewed records',
      prospectiveLabel: 'M5-11 promotion prospective canonical records',
    });
    const canonicalDigest = await hashCanonicalDirectory(temporaryCanonicalDirectory);
    const inventoryBytes = await readFile(temporaryInventoryPath);

    return {
      importBytes,
      importSha256: sha256(importBytes),
      seedBytes,
      seedSha256: sha256(seedBytes),
      inventoryBytes,
      inventorySha256: sha256(inventoryBytes),
      canonicalDigest,
      canonicalSummary: canonicalSummary(canonicalRecords),
      inventory: generatedInventory,
      inventoryValidation,
      seedTargetCount: promotedSeed.targets.length,
      canonicalRecords,
      temporaryDirectory,
    };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function promoteM511({
  manifestPath = DEFAULT_MANIFEST_PATH,
  currentCanonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  currentSeedPath = DEFAULT_SEED_PATH,
  currentInventoryPath = DEFAULT_INVENTORY_PATH,
  canonicalImportPath = DEFAULT_CANONICAL_IMPORT_PATH,
  promotionEvidencePath = DEFAULT_PROMOTION_EVIDENCE_PATH,
  proposalPath,
  editorialDecisionPath,
  editorialTimingPath,
  auditPath,
  auditTimingPath,
  relationDiffPath,
  verificationPath,
  semanticAuditPath,
  reviewedImportPath,
} = {}) {
  const resolvedManifestPath = repositoryPath(manifestPath, 'manifest path');
  const resolvedCurrentCanonicalDirectory = repositoryPath(
    currentCanonicalDirectory,
    'current canonical directory',
  );
  const resolvedCurrentSeedPath = repositoryPath(currentSeedPath, 'current seed path');
  const resolvedCurrentInventoryPath = repositoryPath(currentInventoryPath, 'current inventory path');
  const manifestSource = await readJson(resolvedManifestPath, 'M5-11 admission manifest');
  const manifest = manifestSource.value;
  assertNoMutationManifest(manifest);

  const resolvedCanonicalImportPath = repositoryPath(canonicalImportPath, 'canonical import path');
  const resolvedEvidencePath = repositoryPath(promotionEvidencePath, 'promotion evidence path');
  if (path.dirname(resolvedCanonicalImportPath) !== resolvedCurrentCanonicalDirectory) {
    fail('canonical import must be a direct child of the current canonical directory', 'REPOSITORY_PATH_REQUIRED');
  }
  await assertMissing(resolvedCanonicalImportPath, 'canonical import');
  await assertMissing(resolvedEvidencePath, 'promotion evidence');

  const proposalSource = sourceFromManifest(manifest, 'proposal');
  const editorialSource = sourceFromManifest(manifest, 'editorial');
  const editorialTimingSource = sourceFromManifest(manifest, 'editorial_timing', { optional: true });
  const auditSource = sourceFromManifest(manifest, 'audit', { optional: true });
  const auditTimingSource = sourceFromManifest(manifest, 'audit_timing', { optional: true });
  const relationDiffSource = sourceFromManifest(manifest, 'relation_diff');
  const verificationSource = sourceFromManifest(manifest, 'verification');
  const semanticAuditSource = sourceFromManifest(manifest, 'semantic_audit');
  const reviewedImportSource = sourceFromManifest(manifest, 'reviewed_import');
  const authorizationSource = sourceFromManifest(manifest, 'authorization');
  const baseInventorySource = sourceFromManifest(manifest, 'base_inventory');
  const externalPaths = {
    proposal: requireExternalPath(proposalPath, 'proposal'),
    editorial: requireExternalPath(editorialDecisionPath, 'editorial'),
    ...(editorialTimingSource ? {
      editorial_timing: requireExternalPath(editorialTimingPath, 'editorial-timing'),
    } : {}),
    ...(auditSource ? { audit: requireExternalPath(auditPath, 'audit') } : {}),
    ...(auditTimingSource ? {
      audit_timing: requireExternalPath(auditTimingPath, 'audit-timing'),
    } : {}),
    relation_diff: requireExternalPath(relationDiffPath, 'relation-diff'),
    verification: requireExternalPath(verificationPath, 'verification'),
    semantic_audit: requireExternalPath(semanticAuditPath, 'semantic-audit'),
    reviewed_import: requireExternalPath(reviewedImportPath, 'output'),
  };

  const result = await validateM511Admission({
    proposalPath: externalPaths.proposal,
    editorialDecisionPath: externalPaths.editorial,
    editorialTimingPath: externalPaths.editorial_timing,
    auditPath: externalPaths.audit,
    auditTimingPath: externalPaths.audit_timing,
    relationDiffPath: externalPaths.relation_diff,
    verificationPath: externalPaths.verification,
    semanticAuditPath: externalPaths.semantic_audit,
    reviewedImportPath: externalPaths.reviewed_import,
    authorizationPath: authorizationSource.path,
    baseInventoryPath: baseInventorySource.path,
    currentCanonicalDirectory: resolvedCurrentCanonicalDirectory,
    currentInventoryPath: resolvedCurrentInventoryPath,
    currentSeedPath: resolvedCurrentSeedPath,
    expectedImportedCount: manifest.target.net_start_increase,
    expectedCumulativeStartCount: manifest.target.cumulative_start_target,
    candidateBuffer: manifest.target.candidate_buffer,
  });

  for (const key of [
    'proposal',
    'editorial',
    'relation_diff',
    'verification',
    'semantic_audit',
    'reviewed_import',
    'authorization',
    'base_inventory',
  ]) {
    assertManifestSource(result, manifest, key);
  }
  for (const key of ['editorial_timing', 'audit', 'audit_timing']) {
    if (manifest.sources?.[key]) assertManifestSource(result, manifest, key);
  }
  assertResultMatchesManifest(result, manifest);

  const currentCanonicalDigest = await hashCanonicalDirectory(resolvedCurrentCanonicalDirectory);
  if (currentCanonicalDigest !== M5_11_BASE_CANONICAL_SHA256) {
    fail('current canonical is not the retained 778-start snapshot', 'UNAUTHORIZED_PROMOTION');
  }
  const currentSeedBytes = await readFile(resolvedCurrentSeedPath);
  const currentInventoryBytes = await readFile(resolvedCurrentInventoryPath);
  const originalSemanticAuditBytes = await readFile(DEFAULT_SEMANTIC_AUDIT_PATH);
  const semanticAuditBytes = await readFile(externalPaths.semantic_audit);
  if (sha256(semanticAuditBytes) !== semanticAuditSource.sha256) {
    fail('external semantic audit digest does not match the admission manifest', 'SOURCE_BINDING_MISMATCH');
  }
  if (sha256(currentSeedBytes) !== M5_11_BASE_SEED_SHA256) {
    fail('current seed is not the retained pre-import snapshot', 'UNAUTHORIZED_PROMOTION');
  }
  if (sha256(currentInventoryBytes) !== M5_11_BASE_INVENTORY_SHA256) {
    fail('current inventory is not the retained pre-import snapshot', 'UNAUTHORIZED_PROMOTION');
  }

  const prospective = await buildProspectiveState({
    currentCanonicalDirectory: resolvedCurrentCanonicalDirectory,
    currentSeedPath: resolvedCurrentSeedPath,
    result,
    importPath: resolvedCanonicalImportPath,
    semanticAudit: result.semantic_audit,
  });

  assert.deepEqual(prospective.canonicalSummary, result.final_summary, 'prospective canonical summary drifted');
  if (prospective.canonicalSummary.start_count !== 1278
    || prospective.canonicalSummary.record_count !== 1320) {
    fail('prospective canonical does not reach the M5-11 +500 target', 'CANONICAL_COUNT_MISMATCH');
  }

  const promotion = {
    schema_version: '1',
    artifact_id: 'm5-11-promotion-20260914',
    issue: 97,
    parent_issue: 7,
    batch_id: M5_11_BATCH_ID,
    gate: result.gate,
    target: {
      net_start_increase: 500,
      cumulative_start_target: 1278,
      candidate_buffer: 50,
      selected_start_count: 550,
    },
    base: {
      canonical_directory_sha256: currentCanonicalDigest,
      inventory_sha256: sha256(currentInventoryBytes),
      seed_sha256: sha256(currentSeedBytes),
      summary: result.base_summary,
    },
    actual: result.final_summary,
    metrics: result.metrics,
    relation: result.relation,
    timing: result.timing,
    audit: result.audit,
    verification: result.verification,
    gate_evidence: result.gate_evidence,
    gate_evidence_sha256: sha256Json(result.gate_evidence),
    authorization: result.authorization,
    decisions: {
      ...result.decision_counts,
      processed_start_count: result.processed_start_count,
      imported_start_count: result.imported_records.length,
    },
    sources: manifest.sources,
    outputs: {
      canonical_import: {
        path: path.relative(REPOSITORY_DIRECTORY, resolvedCanonicalImportPath),
        sha256: prospective.importSha256,
        record_count: result.imported_records.length,
        first_canonical_id: result.imported_records[0]?.id,
        last_canonical_id: result.imported_records.at(-1)?.id,
      },
      seed: {
        path: path.relative(REPOSITORY_DIRECTORY, resolvedCurrentSeedPath),
        sha256: prospective.seedSha256,
        target_count: prospective.seedTargetCount,
      },
      inventory: {
        path: path.relative(REPOSITORY_DIRECTORY, resolvedCurrentInventoryPath),
        sha256: prospective.inventorySha256,
        entry_count: prospective.inventoryValidation.inventoryEntryCount,
        canonical_record_count: prospective.inventoryValidation.canonicalRecordCount,
        current_start_count: prospective.inventoryValidation.currentStartCount,
        current_reference_only_count: prospective.inventoryValidation.currentReferenceOnlyCount,
      },
      semantic_audit: {
        path: path.relative(REPOSITORY_DIRECTORY, DEFAULT_SEMANTIC_AUDIT_PATH),
        sha256: sha256(semanticAuditBytes),
        record_count: result.final_summary.record_count,
        sense_count: result.final_summary.sense_count,
      },
    },
    stage: {
      stage_id: 'm5-11-plus-500',
      status: 'passed',
      target: {
        net_start_increase: 500,
        cumulative_start_target: 1278,
        candidate_buffer: 50,
        selected_start_count: 550,
      },
      actual: result.final_summary,
      source_digests: Object.fromEntries(
        Object.entries(result.sources).map(([key, source]) => [key, source.sha256]),
      ),
    },
    promotion: {
      canonical_mutation: true,
      seed_mutation: true,
      inventory_mutation: true,
      explicit: true,
      note: 'All external sources were revalidated against the passing admission manifest before promotion.',
    },
  };

  const originalSeedBytes = currentSeedBytes;
  const originalInventoryBytes = currentInventoryBytes;
  let importWritten = false;
  let seedWritten = false;
  let inventoryWritten = false;
  let semanticAuditWritten = false;
  let evidenceWritten = false;
  try {
    await writeFile(resolvedCanonicalImportPath, prospective.importBytes);
    importWritten = true;
    await writeFile(DEFAULT_SEMANTIC_AUDIT_PATH, semanticAuditBytes);
    semanticAuditWritten = true;
    await writeFile(resolvedCurrentSeedPath, prospective.seedBytes);
    seedWritten = true;
    await writeFile(resolvedCurrentInventoryPath, prospective.inventoryBytes);
    inventoryWritten = true;
    await writeFile(resolvedEvidencePath, `${JSON.stringify(promotion, null, 2)}\n`, 'utf8');
    evidenceWritten = true;

    const finalCanonicalDigest = await hashCanonicalDirectory(resolvedCurrentCanonicalDirectory);
    const finalSeedDigest = sha256(await readFile(resolvedCurrentSeedPath));
    const finalInventoryDigest = sha256(await readFile(resolvedCurrentInventoryPath));
    const finalSemanticAuditDigest = sha256(await readFile(DEFAULT_SEMANTIC_AUDIT_PATH));
    if (finalCanonicalDigest !== prospective.canonicalDigest
      || finalSeedDigest !== prospective.seedSha256
      || finalInventoryDigest !== prospective.inventorySha256
      || finalSemanticAuditDigest !== sha256(semanticAuditBytes)) {
      fail('promoted output digest does not match the prevalidated state', 'PROMOTION_DIGEST_MISMATCH');
    }
    promotion.outputs.canonical_directory_sha256 = finalCanonicalDigest;
    promotion.outputs.seed.sha256 = finalSeedDigest;
    promotion.outputs.inventory.sha256 = finalInventoryDigest;
    promotion.outputs.semantic_audit.sha256 = finalSemanticAuditDigest;
    await writeFile(resolvedEvidencePath, `${JSON.stringify(promotion, null, 2)}\n`, 'utf8');

    return {
      promotion,
      manifestPath: resolvedManifestPath,
      promotionEvidencePath: resolvedEvidencePath,
      canonicalImportPath: resolvedCanonicalImportPath,
      canonicalDigest: finalCanonicalDigest,
      seedDigest: finalSeedDigest,
      inventoryDigest: finalInventoryDigest,
    };
  } catch (error) {
    if (evidenceWritten) await rm(resolvedEvidencePath, { force: true });
    if (inventoryWritten) await writeFile(resolvedCurrentInventoryPath, originalInventoryBytes);
    if (seedWritten) await writeFile(resolvedCurrentSeedPath, originalSeedBytes);
    if (semanticAuditWritten) await writeFile(DEFAULT_SEMANTIC_AUDIT_PATH, originalSemanticAuditBytes);
    if (importWritten) await rm(resolvedCanonicalImportPath, { force: true });
    throw error;
  } finally {
    await rm(prospective.temporaryDirectory, { recursive: true, force: true });
  }
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
  promoteM511({
    manifestPath: args.manifest ?? DEFAULT_MANIFEST_PATH,
    canonicalImportPath: args['canonical-import'] ?? DEFAULT_CANONICAL_IMPORT_PATH,
    promotionEvidencePath: args.evidence ?? DEFAULT_PROMOTION_EVIDENCE_PATH,
    proposalPath: args.proposal,
    editorialDecisionPath: args.editorial,
    editorialTimingPath: args['editorial-timing'],
    auditPath: args.audit,
    auditTimingPath: args['audit-timing'],
    relationDiffPath: args['relation-diff'],
    verificationPath: args.verification,
    semanticAuditPath: args['semantic-audit'],
    reviewedImportPath: args.output,
  })
    .then(({ promotion, promotionEvidencePath }) => {
      console.log(JSON.stringify({
        promotion_evidence_path: promotionEvidencePath,
        actual: promotion.actual,
        outputs: promotion.outputs,
      }, null, 2));
    })
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}
