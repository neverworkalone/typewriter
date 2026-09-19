import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDictionary } from '../build/dictionary.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import {
  buildCanonicalSemanticAudit,
  canonicalRecordsSha256,
  readSemanticAuditArtifact,
  serializeSemanticAuditArtifact,
  validateSemanticAuditCoverage,
} from '../validate/semantic-audit.mjs';
import {
  buildTargetInventory,
  serializeTargetInventory,
} from '../inventory/generate-target-inventory.mjs';
import { validateTargetInventory } from '../validate/target-inventory.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import {
  M5_11_BATCH_ID,
  sha256Json,
} from './m5-11-editorial.mjs';
import { validateM511Promotion } from './validate-m5-11-promotion.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const DEFAULT_CORRECTION_MANIFEST_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/validation/canonical-semantic-correction-manifest.json',
);
const ADMISSION_PATH = path.join(REPOSITORY_DIRECTORY, 'data/batches/m5-11-admission.json');
const PROMOTION_PATH = path.join(REPOSITORY_DIRECTORY, 'data/batches/m5-11-promotion.json');
const CANONICAL_IMPORT_PATH = path.join(REPOSITORY_DIRECTORY, 'data/canonical/m5-11-expansion.jsonl');
const INVENTORY_PATH = path.join(REPOSITORY_DIRECTORY, 'data/inventory/m5-target-inventory.json');
const SEED_PATH = path.join(REPOSITORY_DIRECTORY, 'data/inventory/m5-target-seed.json');
const SEMANTIC_AUDIT_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/validation/canonical-semantic-audit.json',
);

const OUTPUT_DIGEST_KEYS = Object.freeze([
  'canonical_import_sha256',
  'inventory_sha256',
  'canonical_directory_sha256',
  'semantic_audit_sha256',
]);

class M511EvidenceRefreshError extends Error {
  constructor(message, code = 'M5_11_EVIDENCE_REFRESH_ERROR') {
    super(message);
    this.name = 'M511EvidenceRefreshError';
    this.code = code;
  }
}

function fail(message, code = 'M5_11_EVIDENCE_REFRESH_ERROR') {
  throw new M511EvidenceRefreshError(message, code);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_JSON');
    throw error;
  }
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

function completeCanonicalReview(semanticAudit) {
  const reviewPass = semanticAudit.review?.review_pass;
  if (!reviewPass) fail('semantic audit is missing the complete review pass', 'SEMANTIC_AUDIT_MISSING');
  return {
    artifact_id: semanticAudit.review.artifact_id ?? null,
    contract_version: semanticAudit.review.contract_version ?? null,
    review_pass_id: reviewPass.id,
    status: reviewPass.status,
    reviewer: reviewPass.reviewer,
    record_count: reviewPass.record_count,
    sense_count: reviewPass.sense_count,
    open_finding_count: reviewPass.open_finding_count,
    correction_count: reviewPass.correction_count,
    boundary_decision_source_version: reviewPass.boundary_decision_source_version,
    canonical_records_sha256: semanticAudit.source?.canonical_records_sha256 ?? null,
    review_sha256: sha256Json(semanticAudit.review),
  };
}

function updateVerification(previousVerification, {
  finalSummary,
  prospectiveCanonicalSha256,
  semanticAuditSummary,
  canonicalReview,
  sqliteObservation,
}) {
  const verification = structuredClone(previousVerification);
  const machineCheckEvidence = structuredClone(verification.machine_check_evidence);
  const oldSemanticObservation = machineCheckEvidence['semantic-quality'];
  if (!oldSemanticObservation) fail('M5-11 verification is missing semantic-quality machine evidence');

  const canonicalIntegrity = {
    ...machineCheckEvidence['canonical-integrity'],
    final_summary: finalSummary,
    prospective_canonical_sha256: prospectiveCanonicalSha256,
    semantic_audit: semanticAuditSummary,
  };
  const semanticObservation = {
    ...oldSemanticObservation,
    semantic_audit: semanticAuditSummary,
    complete_canonical_review: canonicalReview,
  };
  machineCheckEvidence['canonical-integrity'] = canonicalIntegrity;
  machineCheckEvidence['deterministic-sqlite'] = sqliteObservation;
  machineCheckEvidence['semantic-quality'] = semanticObservation;

  verification.prospective_canonical_sha256 = prospectiveCanonicalSha256;
  verification.final_canonical_summary = finalSummary;
  verification.machine_check_evidence = machineCheckEvidence;
  verification.checks = verification.checks.map((check) => {
    const checkEvidence = machineCheckEvidence[check.id];
    if (!checkEvidence) fail(`M5-11 verification is missing machine evidence for ${check.id}`);
    const resultSha256 = check.id === 'canonical-integrity'
      ? sha256Json({
        finalSummary: checkEvidence.final_summary,
        prospectiveCanonicalSha256: checkEvidence.prospective_canonical_sha256,
      })
      : sha256Json(checkEvidence);
    return { ...check, result_sha256: resultSha256 };
  });
  return verification;
}

function assertOutputSet(value, label) {
  if (!value || typeof value !== 'object') fail(`${label} is missing`, 'SOURCE_BINDING_MISMATCH');
  for (const key of OUTPUT_DIGEST_KEYS) {
    if (!/^[a-f0-9]{64}$/u.test(value[key] ?? '')) {
      fail(`${label}.${key} is not a SHA-256 digest`, 'SOURCE_BINDING_MISMATCH');
    }
  }
}

function assertOldOutputBindings(manifest, promotion, correctionManifest) {
  assertOutputSet(correctionManifest.base_outputs, 'correction manifest.base_outputs');
  assertOutputSet(correctionManifest.prospective_outputs, 'correction manifest.prospective_outputs');
  for (const key of OUTPUT_DIGEST_KEYS) {
    if (key === 'canonical_import_sha256') {
      if (manifest.sources?.reviewed_import?.sha256 !== correctionManifest.base_outputs[key]
        || promotion.sources?.reviewed_import?.sha256 !== correctionManifest.base_outputs[key]
        || promotion.outputs?.canonical_import?.sha256 !== correctionManifest.base_outputs[key]
        || promotion.stage?.source_digests?.reviewed_import !== correctionManifest.base_outputs[key]) {
        fail(`old M5-11 ${key} binding is not the correction manifest base`, 'SOURCE_BINDING_MISMATCH');
      }
    }
    if (key === 'semantic_audit_sha256'
      && (manifest.sources?.semantic_audit?.sha256 !== correctionManifest.base_outputs[key]
        || promotion.sources?.semantic_audit?.sha256 !== correctionManifest.base_outputs[key])) {
      fail(`old M5-11 ${key} binding is not the correction manifest base`, 'SOURCE_BINDING_MISMATCH');
    }
    if (key === 'inventory_sha256' && promotion.outputs?.inventory?.sha256 !== correctionManifest.base_outputs[key]) {
      fail(`old M5-11 ${key} binding is not the correction manifest base`, 'SOURCE_BINDING_MISMATCH');
    }
    if (key === 'canonical_directory_sha256'
      && promotion.outputs?.canonical_directory_sha256 !== correctionManifest.base_outputs[key]) {
      fail(`old M5-11 ${key} binding is not the correction manifest base`, 'SOURCE_BINDING_MISMATCH');
    }
  }
}

function assertGateEvidenceBindings(manifest, promotion) {
  if (manifest.gate_evidence_sha256 !== sha256Json(manifest.gate_evidence)
    || promotion.gate_evidence_sha256 !== sha256Json(promotion.gate_evidence)
    || manifest.gate_evidence_sha256 !== promotion.gate_evidence_sha256
    || JSON.stringify(manifest.gate_evidence) !== JSON.stringify(promotion.gate_evidence)) {
    fail('M5-11 durable gate evidence is not internally bound before refresh', 'GATE_EVIDENCE_DIGEST_MISMATCH');
  }
}

function hasProspectiveOutputBindings(manifest, promotion, correctionManifest) {
  const prospective = correctionManifest.prospective_outputs;
  return manifest.sources?.reviewed_import?.sha256 === prospective.canonical_import_sha256
    && promotion.sources?.reviewed_import?.sha256 === prospective.canonical_import_sha256
    && promotion.outputs?.canonical_import?.sha256 === prospective.canonical_import_sha256
    && promotion.stage?.source_digests?.reviewed_import === prospective.canonical_import_sha256
    && manifest.sources?.semantic_audit?.sha256 === prospective.semantic_audit_sha256
    && promotion.sources?.semantic_audit?.sha256 === prospective.semantic_audit_sha256
    && promotion.outputs?.semantic_audit?.sha256 === prospective.semantic_audit_sha256
    && promotion.outputs?.inventory?.sha256 === prospective.inventory_sha256
    && promotion.outputs?.canonical_directory_sha256 === prospective.canonical_directory_sha256;
}

function hasStaleProspectiveOutputBindings(manifest, promotion, correctionManifest) {
  const prospective = correctionManifest.prospective_outputs;
  const previousSemanticAuditDigests = [
    manifest.sources?.semantic_audit?.sha256,
    promotion.sources?.semantic_audit?.sha256,
    promotion.outputs?.semantic_audit?.sha256,
  ];
  return manifest.sources?.reviewed_import?.sha256 === prospective.canonical_import_sha256
    && promotion.sources?.reviewed_import?.sha256 === prospective.canonical_import_sha256
    && promotion.outputs?.canonical_import?.sha256 === prospective.canonical_import_sha256
    && promotion.stage?.source_digests?.reviewed_import === prospective.canonical_import_sha256
    && previousSemanticAuditDigests.every((digest) => /^[a-f0-9]{64}$/u.test(digest ?? ''))
    && new Set(previousSemanticAuditDigests).size === 1
    && previousSemanticAuditDigests[0] !== prospective.semantic_audit_sha256
    && promotion.outputs?.inventory?.sha256 === prospective.inventory_sha256
    && promotion.outputs?.canonical_directory_sha256 === prospective.canonical_directory_sha256;
}

function assertOutputBindings(manifest, promotion, correctionManifest) {
  if (hasProspectiveOutputBindings(manifest, promotion, correctionManifest)) {
    assertGateEvidenceBindings(manifest, promotion);
    return 'prospective';
  }
  if (hasStaleProspectiveOutputBindings(manifest, promotion, correctionManifest)) {
    assertGateEvidenceBindings(manifest, promotion);
    return 'stale-prospective';
  }
  assertOldOutputBindings(manifest, promotion, correctionManifest);
  return 'base';
}

async function buildSqliteObservation() {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-11-evidence-refresh-'));
  const temporarySqlitePath = path.join(temporaryDirectory, 'dictionary.sqlite');
  try {
    const build = await buildDictionary({
      inputDirectory: path.join(REPOSITORY_DIRECTORY, 'data/canonical'),
      outputPath: temporarySqlitePath,
      metadata: {
        source_revision: M5_11_BATCH_ID,
        source_revision_source: 'post-merge-semantic-correction-refresh',
        source_revision_verified: 'false',
      },
      checkPilotCompleteness: true,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      allowDirty: true,
    });
    const database = new DatabaseSync(temporarySqlitePath, { readOnly: true });
    try {
      const integrity = database.prepare('PRAGMA integrity_check').get();
      const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
      const counts = {
        records: database.prepare('SELECT COUNT(*) AS count FROM records').get().count,
        starts: database.prepare("SELECT COUNT(*) AS count FROM records WHERE role = 'start'").get().count,
        references: database.prepare("SELECT COUNT(*) AS count FROM records WHERE role = 'reference-only'").get().count,
        senses: database.prepare('SELECT COUNT(*) AS count FROM senses').get().count,
        relations: database.prepare('SELECT COUNT(*) AS count FROM relations').get().count,
      };
      return {
        build: {
          recordCount: build.recordCount,
          senseCount: build.senseCount,
          relationCount: build.relationCount,
        },
        integrity: integrity.integrity_check,
        foreign_key_errors: foreignKeys,
        counts,
      };
    } finally {
      database.close();
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function updateDurableEvidence(manifest, promotion, {
  correctionManifestPath,
  correctionManifest,
  summary,
  outputDigests,
  semanticAuditSummary,
  canonicalReview,
  sqliteObservation,
}) {
  const updatedManifest = structuredClone(manifest);
  const updatedPromotion = structuredClone(promotion);
  const sources = structuredClone(updatedManifest.sources);
  sources.reviewed_import.sha256 = outputDigests.canonical_import_sha256;
  sources.semantic_audit.sha256 = outputDigests.semantic_audit_sha256;

  const verification = updateVerification(updatedManifest.verification, {
    finalSummary: summary,
    prospectiveCanonicalSha256: outputDigests.canonical_records_sha256,
    semanticAuditSummary,
    canonicalReview,
    sqliteObservation,
  });
  const gateEvidence = structuredClone(updatedManifest.gate_evidence);
  gateEvidence.final_summary = summary;
  gateEvidence.verification = verification;
  const gateEvidenceSha256 = sha256Json(gateEvidence);

  updatedManifest.actual = summary;
  updatedManifest.verification = verification;
  updatedManifest.gate_evidence = gateEvidence;
  updatedManifest.gate_evidence_sha256 = gateEvidenceSha256;
  updatedManifest.sources = sources;
  updatedManifest.correction_source = {
    kind: 'separately-authored-correction-manifest',
    path: path.relative(REPOSITORY_DIRECTORY, correctionManifestPath),
    sha256: sha256Json(correctionManifest),
    source_revision: correctionManifest.source_revision,
  };

  updatedPromotion.actual = summary;
  updatedPromotion.verification = verification;
  updatedPromotion.gate_evidence = structuredClone(gateEvidence);
  updatedPromotion.gate_evidence_sha256 = gateEvidenceSha256;
  updatedPromotion.sources = structuredClone(sources);
  updatedPromotion.outputs = {
    ...updatedPromotion.outputs,
    canonical_import: {
      ...updatedPromotion.outputs.canonical_import,
      sha256: outputDigests.canonical_import_sha256,
    },
    inventory: {
      ...updatedPromotion.outputs.inventory,
      sha256: outputDigests.inventory_sha256,
      entry_count: outputDigests.inventoryEntryCount,
      canonical_record_count: summary.record_count,
      current_start_count: summary.start_count,
      current_reference_only_count: summary.reference_only_count,
    },
    canonical_directory_sha256: outputDigests.canonical_directory_sha256,
    semantic_audit: {
      path: 'data/validation/canonical-semantic-audit.json',
      sha256: outputDigests.semantic_audit_sha256,
      record_count: summary.record_count,
      sense_count: summary.sense_count,
    },
  };
  updatedPromotion.stage.actual = summary;
  updatedPromotion.stage.source_digests.reviewed_import = outputDigests.canonical_import_sha256;
  updatedPromotion.correction_source = updatedManifest.correction_source;

  return { manifest: updatedManifest, promotion: updatedPromotion };
}

export async function refreshM511DerivedEvidence({
  correctionManifestPath = DEFAULT_CORRECTION_MANIFEST_PATH,
  admissionPath = ADMISSION_PATH,
  promotionPath = PROMOTION_PATH,
  canonicalImportPath = CANONICAL_IMPORT_PATH,
  inventoryPath = INVENTORY_PATH,
  semanticAuditPath = SEMANTIC_AUDIT_PATH,
} = {}) {
  const [correctionManifest, manifest, promotion, canonicalImportBytes] = await Promise.all([
    readJson(correctionManifestPath, 'correction manifest'),
    readJson(admissionPath, 'M5-11 admission evidence'),
    readJson(promotionPath, 'M5-11 promotion evidence'),
    readFile(canonicalImportPath),
  ]);
  const bindingState = assertOutputBindings(manifest, promotion, correctionManifest);
  const canonicalDirectory = path.join(REPOSITORY_DIRECTORY, 'data/canonical');
  const canonical = await readCanonicalRecords(canonicalDirectory);
  let inventory;
  let inventoryBytes;
  if (path.resolve(inventoryPath) === path.resolve(INVENTORY_PATH)) {
    inventory = await buildTargetInventory({
      canonicalDirectory,
      seedPath: SEED_PATH,
    });
    inventoryBytes = serializeTargetInventory(inventory);
  } else {
    inventoryBytes = await readFile(inventoryPath);
    inventory = JSON.parse(inventoryBytes.toString('utf8'));
  }
  let semanticAudit;
  let semanticAuditBytes;
  if (path.resolve(semanticAuditPath) === path.resolve(SEMANTIC_AUDIT_PATH)) {
    semanticAudit = (await buildCanonicalSemanticAudit({
      canonicalDirectory,
    })).artifact;
    semanticAuditBytes = serializeSemanticAuditArtifact(semanticAudit);
  } else {
    semanticAudit = await readSemanticAuditArtifact(semanticAuditPath);
    semanticAuditBytes = await readFile(semanticAuditPath);
  }
  const canonicalRecordsDigest = canonicalRecordsSha256(canonical.records);
  if (canonicalRecordsDigest !== correctionManifest.prospective_canonical_records_sha256) {
    fail('complete canonical input does not match the correction manifest prospective digest', 'SOURCE_BINDING_MISMATCH');
  }
  const outputDigests = {
    canonical_import_sha256: sha256(canonicalImportBytes),
    inventory_sha256: sha256(inventoryBytes),
    semantic_audit_sha256: sha256(semanticAuditBytes),
    canonical_directory_sha256: await hashCanonicalDirectory(path.join(REPOSITORY_DIRECTORY, 'data/canonical')),
    canonical_records_sha256: canonicalRecordsDigest,
  };
  for (const key of OUTPUT_DIGEST_KEYS) {
    if (outputDigests[key] !== correctionManifest.prospective_outputs[key]) {
      fail(`current ${key} does not match the correction manifest prospective output`, 'SOURCE_BINDING_MISMATCH');
    }
  }
  const records = canonical.records.map(({ record }) => record);
  const summary = canonicalSummary(records);
  const semanticAuditSummary = validateSemanticAuditCoverage(canonical.records, semanticAudit, {
    label: 'post-merge canonical semantic audit',
  });
  const canonicalReview = completeCanonicalReview(semanticAudit);
  const inventoryValidation = await validateTargetInventory({
    inventory,
    canonicalDirectory,
    checkPilotCompleteness: true,
  });
  const sqliteObservation = await buildSqliteObservation();
  assert.deepEqual(sqliteObservation.counts, {
    records: summary.record_count,
    starts: summary.start_count,
    references: summary.reference_only_count,
    senses: summary.sense_count,
    relations: summary.relation_count,
  });
  outputDigests.inventoryEntryCount = inventoryValidation.inventoryEntryCount;

  const updated = updateDurableEvidence(manifest, promotion, {
    correctionManifestPath,
    correctionManifest,
    summary,
    outputDigests,
    semanticAuditSummary,
    canonicalReview,
    sqliteObservation,
  });
  const originalAdmission = await readFile(admissionPath);
  const originalPromotion = await readFile(promotionPath);
  try {
    await writeFile(admissionPath, `${JSON.stringify(updated.manifest, null, 2)}\n`, 'utf8');
    await writeFile(promotionPath, `${JSON.stringify(updated.promotion, null, 2)}\n`, 'utf8');
    await validateM511Promotion({
      manifestPath: admissionPath,
      promotionEvidencePath: promotionPath,
      semanticAuditPath,
    });
  } catch (error) {
    await writeFile(admissionPath, originalAdmission);
    await writeFile(promotionPath, originalPromotion);
    throw error;
  }
  return {
    status: 'refreshed',
    binding_state: bindingState,
    summary,
    semantic_audit: semanticAuditSummary,
    output_digests: outputDigests,
    inventory_entry_count: inventoryValidation.inventoryEntryCount,
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
  refreshM511DerivedEvidence({
    correctionManifestPath: args.corrections ?? DEFAULT_CORRECTION_MANIFEST_PATH,
    admissionPath: args.admission ?? ADMISSION_PATH,
    promotionPath: args.promotion ?? PROMOTION_PATH,
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}
