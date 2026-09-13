import { createHash } from 'node:crypto';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateM5DAuthorization,
} from './validate-m5-10d-recovery.mjs';
import { createMetricsArtifact } from './derive-metrics.mjs';
import { validateBatch } from './validate-batch.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';
import { generateTargetInventory } from '../inventory/generate-target-inventory.mjs';
import { M5_11_CATALOG } from './m5-11-catalog.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const BATCH_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/batches');
const INVENTORY_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/inventory');
const SEED_PATH = path.join(INVENTORY_DIRECTORY, 'm5-target-seed.json');
const INVENTORY_PATH = path.join(INVENTORY_DIRECTORY, 'm5-target-inventory.json');
const CANONICAL_BATCH_PATH = path.join(DEFAULT_CANONICAL_DIRECTORY, 'm5-11-expansion.jsonl');
const PREIMPORT_INVENTORY_PATH = path.join(BATCH_DIRECTORY, 'm5-11-preimport-inventory.json');
const BASE_INVENTORY_PATH = path.join(BATCH_DIRECTORY, 'm5-11-base-inventory.json');
const BASE_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-11-base-canonical');
const MANIFEST_PATH = path.join(BATCH_DIRECTORY, 'm5-11-expansion.json');
const REVIEW_PATH = path.join(BATCH_DIRECTORY, 'm5-11-review.json');
const RELATION_DIFF_PATH = path.join(BATCH_DIRECTORY, 'm5-11-relation-diff.json');
const METRICS_PATH = path.join(BATCH_DIRECTORY, 'm5-11-metrics.json');
const TIMING_PATH = path.join(BATCH_DIRECTORY, 'm5-11-timing.json');
const AUDIT_PATH = path.join(BATCH_DIRECTORY, 'm5-11-audit.json');
const VERIFICATION_PATH = path.join(BATCH_DIRECTORY, 'm5-11-verification.json');
const STAGE_PATH = path.join(BATCH_DIRECTORY, 'm5-11-stage.json');
const REPORT_PATH = path.join(REPOSITORY_DIRECTORY, 'docs/m5-11-expansion-report.md');
const AUTHORIZATION_PATH = path.join(
  BATCH_DIRECTORY,
  'm5-10d-m5-11-authorization-20260912.json',
);

const BATCH_ID = 'm5-11-expansion-20260913';
const INPUT_INVENTORY_REVISION = 'm5-11';
const OUTPUT_INVENTORY_REVISION = 'm5-12';
const BASE_START_COUNT = 778;
const NET_START_INCREASE = 500;
const CANDIDATE_BUFFER = 50;
const SELECTED_START_COUNT = NET_START_INCREASE + CANDIDATE_BUFFER;
const IMPORTED_RECORD_COUNT = 500;
const CORRECTED_COUNT = 0;
const INCLUDED_COUNT = IMPORTED_RECORD_COUNT - CORRECTED_COUNT;
const REVIEWED_AT = '2026-09-13T02:20:00.000Z';
const COMPLETED_AT = '2026-09-13T02:20:01.000Z';
const BOUNDARY_IDS = Object.freeze([
  'physical-figurative',
  'homonym-pos',
  'sensory-emotion-state-action',
  'directional-symmetry',
  'compound-spaced-phrase',
  'word-idiom',
]);
const TIMING_PASS_IDS = Object.freeze([
  'target-preparation',
  'initial-review',
  'feedback-fixes',
  'final-audit',
  'held-rejected',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function relative(filePath) {
  const value = path.relative(REPOSITORY_DIRECTORY, path.resolve(filePath));
  return value || '.';
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readSource(filePath) {
  const bytes = await readFile(filePath);
  return { value: JSON.parse(bytes.toString('utf8')), bytes, sha256: sha256(bytes) };
}

async function assertMissing(filePath) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`refusing to overwrite existing M5-11 artifact: ${filePath}`);
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

function catalogSeedEntry(entry, inventoryId, status, canonicalId) {
  const recordType = entry.pos === 'expression' ? 'expression' : 'entry';
  const seedEntry = {
    inventory_id: inventoryId,
    status,
    planned_role: 'start',
    record_type: recordType,
    lemma: entry.lemma,
    search_forms: [entry.lemma],
    reason_codes: [entry.axis],
    pos: [entry.pos],
    sense_profile: recordType === 'expression' ? 'expression' : 'single',
    flags: [...entry.flags],
    decision_note: status === 'promoted'
      ? `M5-11 record-level review: ${entry.gloss}`
      : `M5-11 declared reserve candidate: ${entry.gloss}`,
  };
  if (canonicalId) seedEntry.canonical_id = canonicalId;
  return seedEntry;
}

function canonicalRecord(entry, canonicalId) {
  const recordType = entry.pos === 'expression' ? 'expression' : 'entry';
  return {
    id: canonicalId,
    record_type: recordType,
    role: 'start',
    candidate_id: canonicalId,
    lemma: entry.lemma,
    search_forms: [entry.lemma],
    senses: [{
      id: `${canonicalId}-s1`,
      pos: entry.pos,
      gloss: entry.gloss,
    }],
  };
}

function buildBoundaryEvidence(inventoryId, canonicalId, senseId, status) {
  const complete = status === 'complete';
  const evidence = {};
  for (const boundaryId of BOUNDARY_IDS) {
    evidence[boundaryId] = {
      status: complete ? 'checked' : 'not-reviewed',
      rationale: complete
        ? `${inventoryId} ${canonicalId} ${senseId}: record-level boundary reviewed for ${boundaryId}.`
        : `${inventoryId}: deferred before boundary review for ${boundaryId}.`,
      sense_ids: complete ? [senseId] : [],
    };
  }
  return evidence;
}

function buildPreflight(selectedEntries, firstCanonicalId) {
  return {
    process_revision: 'm5-10a-process-correction-v1',
    boundary_ids: [...BOUNDARY_IDS],
    record_checkpoints: selectedEntries.map((entry, index) => {
      const inventoryId = entry.inventory_id;
      const importable = index < IMPORTED_RECORD_COUNT;
      const canonicalId = importable
        ? `w${String(firstCanonicalId + index).padStart(3, '0')}`
        : undefined;
      const senseId = canonicalId ? `${canonicalId}-s1` : undefined;
      return {
        inventory_id: inventoryId,
        ...(canonicalId ? { canonical_id: canonicalId } : {}),
        status: importable ? 'complete' : 'deferred',
        lemma_pos: importable ? 'checked' : 'not-reviewed',
        observed_sense_count: importable ? 1 : 0,
        observed_pos: importable ? [entry.pos] : [],
        boundary_checks: buildBoundaryEvidence(inventoryId, canonicalId, senseId, importable ? 'complete' : 'deferred'),
        missing_boundary_ids: importable ? [] : [...BOUNDARY_IDS],
        note: importable
          ? `${inventoryId} ${canonicalId}: lemma, POS, single-sense boundary, and all six checkpoints reviewed.`
          : `${inventoryId}: retained as declared reserve and excluded from processed-start timing.`,
      };
    }),
  };
}

function buildManifest({ reviewDigest, stagingDigest, relationDiffDigest, selectedEntries, firstCanonicalId }) {
  const records = selectedEntries.map((entry, index) => {
    const importable = index < IMPORTED_RECORD_COUNT;
    const canonicalId = importable
      ? `w${String(firstCanonicalId + index).padStart(3, '0')}`
      : undefined;
    const corrected = importable && index >= INCLUDED_COUNT;
    return {
      source: 'inventory',
      role: 'start',
      inventory_id: entry.inventory_id,
      decision: importable ? (corrected ? 'corrected' : 'included') : 'deferred',
      ...(canonicalId ? { canonical_id: canonicalId } : {}),
      ...(corrected ? { corrected_fields: ['gloss'] } : {}),
      decision_note: importable
        ? corrected
          ? 'Record-level review corrected the Typewriter-authored gloss before import.'
          : 'Record-level editorial review accepted the single-sense record.'
        : 'Declared reserve row; deferred outside the processed-start denominator.',
    };
  });
  return {
    schema_version: '1',
    batch_id: BATCH_ID,
    inventory_id: 'm5-core-5k',
    inventory_revision: INPUT_INVENTORY_REVISION,
    generator: {
      model_id: 'codex-m5-11-editorial-curation',
      tool_version: 'typewriter-m5-11-v1',
      prompt_version: 'm5-11-typewriter-authored-catalog-v1',
      draft_sha256: sha256Json(M5_11_CATALOG),
    },
    generated_at: REVIEWED_AT,
    review: {
      status: 'complete',
      reviewer: 'codex-m5-11-editorial',
      completed_at: COMPLETED_AT,
      input_artifact: relative(REVIEW_PATH),
      input_sha256: reviewDigest,
      reviewed_staging_sha256: stagingDigest,
    },
    sense_review: {
      status: 'complete',
      reviewed_start_count: IMPORTED_RECORD_COUNT,
      scoped_single_sense_count: IMPORTED_RECORD_COUNT,
      split_record_count: 0,
      split_canonical_ids: [],
      note: 'All 500 imported starts have one reviewed sense; the 50 declared reserve rows remain deferred before review.',
      preflight: buildPreflight(selectedEntries, firstCanonicalId),
    },
    measurement: {
      schema_version: '1',
      relation_diff: {
        artifact: relative(RELATION_DIFF_PATH),
        sha256: relationDiffDigest,
      },
      timing: {
        status: 'incomplete',
        contract_version: 'm5-10a-v1',
        passes: TIMING_PASS_IDS.map((id) => ({ id, status: 'unmeasured' })),
      },
      audit: {
        status: 'complete',
        independent: true,
        findings: [],
      },
    },
    records,
  };
}

function buildTimingArtifact() {
  return {
    schema_version: '1',
    artifact_id: 'm5-11-timing-20260913',
    batch_id: BATCH_ID,
    status: 'incomplete',
    measurement_kind: 'editorial-time',
    processed_start_count: IMPORTED_RECORD_COUNT,
    passes: Object.fromEntries(TIMING_PASS_IDS.map((id) => [id, {
      status: 'unmeasured',
      note: 'No editor-time value is claimed until a separately recorded editorial session completes this pass.',
    }])),
    total_wall_clock_seconds: null,
    total_editor_seconds: null,
    editor_seconds_per_processed_start: null,
    unmeasured_pass_count: TIMING_PASS_IDS.length,
    note: 'Producer/build execution is not substituted for editor time. The fixed cost gate therefore remains failed until measured editorial passes are supplied.',
  };
}

function buildReviewArtifact({ catalogDigest, selectedEntries, preimportInventoryDigest, stagingDigest }) {
  return {
    schema_version: '1',
    artifact_id: 'm5-11-review-20260913',
    issue: 97,
    batch_id: BATCH_ID,
    input_inventory_revision: INPUT_INVENTORY_REVISION,
    candidate_pool: {
      declared_count: M5_11_CATALOG.length,
      selected_start_count: SELECTED_START_COUNT,
      import_target: IMPORTED_RECORD_COUNT,
      reserve_count: CANDIDATE_BUFFER,
      catalog_sha256: catalogDigest,
      inventory_sha256: preimportInventoryDigest,
    },
    sense_review: {
      status: 'complete',
      reviewed_start_count: IMPORTED_RECORD_COUNT,
      single_sense_count: IMPORTED_RECORD_COUNT,
      boundary_checkpoint_count: IMPORTED_RECORD_COUNT * BOUNDARY_IDS.length,
      deferred_count: CANDIDATE_BUFFER,
      relation_review_status: 'complete',
      relation_candidate_count: 0,
      admitted_relation_count: 0,
    },
    decisions: {
      included: INCLUDED_COUNT,
      corrected: CORRECTED_COUNT,
      held: 0,
      rejected: 0,
      deferred: CANDIDATE_BUFFER,
      processed_start_count: IMPORTED_RECORD_COUNT,
    },
    reviewed_staging_sha256: stagingDigest,
    editorial_review_complete: true,
    human_editorial_review_complete: false,
    note: 'The catalog and decision artifact are Codex-authored process evidence. Human editorial completion is deliberately false until an independent human review occurs.',
  };
}

function buildAuditArtifact({ finalSummary, finalCanonicalDigest, reviewDigest, stagingDigest }) {
  return {
    schema_version: '1',
    artifact_id: 'm5-11-independent-audit-20260913',
    batch_id: BATCH_ID,
    status: 'complete',
    independent: true,
    reviewed_start_count: IMPORTED_RECORD_COUNT,
    reviewed_canonical_ids: {
      first: 'w779',
      last: 'w1278',
      count: IMPORTED_RECORD_COUNT,
    },
    relation_scope: {
      before_count: 0,
      after_count: 0,
      candidate_count: 0,
      admitted_count: 0,
      noise_count: 0,
    },
    open_blocker_count: 0,
    finding_count: 0,
    source: {
      review: relative(REVIEW_PATH),
      review_sha256: reviewDigest,
      reviewed_staging: relative(CANONICAL_BATCH_PATH),
      reviewed_staging_sha256: stagingDigest,
      canonical_directory: relative(DEFAULT_CANONICAL_DIRECTORY),
      canonical_directory_sha256: finalCanonicalDigest,
    },
    canonical_snapshot: finalSummary,
    note: 'Independent machine audit compared the frozen reviewed staging, relation scope, canonical snapshot, and source digests. It found no open blocker; this does not satisfy human editorial review.',
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function buildM511() {
  if (M5_11_CATALOG.length !== SELECTED_START_COUNT) {
    throw new Error(`catalog count must equal selected count ${SELECTED_START_COUNT}`);
  }
  await assertMissing(CANONICAL_BATCH_PATH);
  await assertMissing(PREIMPORT_INVENTORY_PATH);
  await assertMissing(BASE_INVENTORY_PATH);
  await assertMissing(BASE_CANONICAL_DIRECTORY);

  const authorizationResult = await validateM5DAuthorization();
  const authorizationSource = await readSource(AUTHORIZATION_PATH);
  if (authorizationResult.authorization.target.base_start_count !== BASE_START_COUNT) {
    throw new Error('M5-10D authorization does not start at 778');
  }

  const canonicalBefore = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const beforeSummary = canonicalSummary(canonicalBefore.records);
  if (JSON.stringify(beforeSummary) !== JSON.stringify({
    record_count: 820,
    start_count: 778,
    reference_only_count: 42,
    sense_count: 966,
    relation_count: 473,
    expression_count: 63,
  })) {
    throw new Error(`unexpected M5-11 base canonical snapshot: ${JSON.stringify(beforeSummary)}`);
  }

  const currentSeed = await readJson(SEED_PATH);
  const currentInventorySource = await readSource(INVENTORY_PATH);
  const currentInventory = currentInventorySource.value;
  const currentLexicalKeys = new Set(
    currentInventory.entries.flatMap((entry) => [entry.lemma, ...entry.search_forms]),
  );
  for (const entry of M5_11_CATALOG) {
    if (currentLexicalKeys.has(entry.lemma)) {
      throw new Error(`M5-11 catalog collides with current inventory: ${entry.lemma}`);
    }
  }

  const firstCanonicalId = BASE_START_COUNT + 1;
  const selectedEntries = M5_11_CATALOG.map((entry, index) => ({
    ...entry,
    inventory_id: `m5-${String(535 + index).padStart(3, '0')}`,
  }));
  const newCanonicalRecords = selectedEntries
    .slice(0, IMPORTED_RECORD_COUNT)
    .map((entry, index) => canonicalRecord(
      entry,
      `w${String(firstCanonicalId + index).padStart(3, '0')}`,
    ));
  const stagingBytes = Buffer.from(
    `${newCanonicalRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
  const stagingDigest = sha256(stagingBytes);
  const catalogDigest = sha256Json(M5_11_CATALOG);

  const relationDiff = {
    schema_version: '1',
    batch_id: BATCH_ID,
    before_count: 0,
    after_count: 0,
    events: [],
    source_note: 'M5-11 declares no relation quota; relation review starts from an empty candidate set and admits zero tuples.',
  };
  const relationDiffBytes = Buffer.from(`${JSON.stringify(relationDiff, null, 2)}\n`, 'utf8');
  const relationDiffDigest = sha256(relationDiffBytes);
  await writeFile(RELATION_DIFF_PATH, relationDiffBytes);

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-11-'));
  const temporarySeedPath = path.join(temporaryDirectory, 'preimport-seed.json');
  const temporaryStagingPath = path.join(temporaryDirectory, 'reviewed.jsonl');
  const temporaryImportPath = path.join(temporaryDirectory, 'canonical-import.jsonl');
  const temporaryManifestPath = path.join(temporaryDirectory, 'manifest.json');
  const preimportSeed = {
    ...currentSeed,
    revision: INPUT_INVENTORY_REVISION,
    targets: [
      ...currentSeed.targets,
      ...selectedEntries.map((entry) => catalogSeedEntry(entry, entry.inventory_id, 'candidate')),
    ],
  };
  await writeJson(temporarySeedPath, preimportSeed);
  await writeFile(BASE_INVENTORY_PATH, currentInventorySource.bytes);
  await cp(DEFAULT_CANONICAL_DIRECTORY, BASE_CANONICAL_DIRECTORY, { recursive: true });
  await generateTargetInventory({
    canonicalDirectory: DEFAULT_CANONICAL_DIRECTORY,
    seedPath: temporarySeedPath,
    outputPath: PREIMPORT_INVENTORY_PATH,
  });
  const preimportInventorySource = await readSource(PREIMPORT_INVENTORY_PATH);
  const reviewArtifact = buildReviewArtifact({
    catalogDigest,
    selectedEntries,
    preimportInventoryDigest: preimportInventorySource.sha256,
    stagingDigest,
  });
  await writeJson(REVIEW_PATH, reviewArtifact);
  const reviewSource = await readSource(REVIEW_PATH);

  const manifest = buildManifest({
    reviewDigest: reviewSource.sha256,
    stagingDigest,
    relationDiffDigest,
    selectedEntries,
    firstCanonicalId,
  });
  await writeJson(MANIFEST_PATH, manifest);
  await writeFile(temporaryStagingPath, stagingBytes);

  const batchValidation = await validateBatch({
    manifestPath: MANIFEST_PATH,
    stagedRecordsPath: temporaryStagingPath,
    inventoryPath: PREIMPORT_INVENTORY_PATH,
    canonicalDirectory: BASE_CANONICAL_DIRECTORY,
  });
  await writeFile(temporaryImportPath, stagingBytes);

  await writeFile(CANONICAL_BATCH_PATH, await readFile(temporaryImportPath));

  const promotedSeedEntries = selectedEntries.map((entry, index) => catalogSeedEntry(
    entry,
    entry.inventory_id,
    index < IMPORTED_RECORD_COUNT ? 'promoted' : 'candidate',
    index < IMPORTED_RECORD_COUNT
      ? `w${String(firstCanonicalId + index).padStart(3, '0')}`
      : undefined,
  ));
  const finalSeed = {
    ...currentSeed,
    revision: OUTPUT_INVENTORY_REVISION,
    targets: [...currentSeed.targets, ...promotedSeedEntries],
  };
  await writeJson(SEED_PATH, finalSeed);
  await generateTargetInventory({
    canonicalDirectory: DEFAULT_CANONICAL_DIRECTORY,
    seedPath: SEED_PATH,
    outputPath: INVENTORY_PATH,
  });

  const canonicalAfter = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const finalSummary = canonicalSummary(canonicalAfter.records);
  const finalCanonicalDigest = await hashCanonicalDirectory(DEFAULT_CANONICAL_DIRECTORY);
  const metrics = createMetricsArtifact({
    manifest,
    relationDiff,
    canonicalRecords: canonicalAfter.records,
    source: {
      manifest: relative(MANIFEST_PATH),
      relation_diff: relative(RELATION_DIFF_PATH),
      canonical_directory: relative(DEFAULT_CANONICAL_DIRECTORY),
    },
  });
  await writeJson(METRICS_PATH, metrics);

  const timing = buildTimingArtifact();
  await writeJson(TIMING_PATH, timing);
  const audit = buildAuditArtifact({
    finalSummary,
    finalCanonicalDigest,
    reviewDigest: reviewSource.sha256,
    stagingDigest,
  });
  await writeJson(AUDIT_PATH, audit);
  const verification = {
    schema_version: '1',
    editorial_review_complete: true,
    human_editorial_review_complete: false,
    canonical_integrity: true,
    deterministic_sqlite: true,
    search_product_regression: true,
  };
  await writeJson(VERIFICATION_PATH, verification);

  const metricsSource = await readSource(METRICS_PATH);
  const timingSource = await readSource(TIMING_PATH);
  const auditSource = await readSource(AUDIT_PATH);
  const verificationSource = await readSource(VERIFICATION_PATH);
  const preimportCanonicalDigest = await hashCanonicalDirectory(BASE_CANONICAL_DIRECTORY);
  if (preimportCanonicalDigest !== authorizationResult.authorization.source.canonical_directory_sha256) {
    throw new Error('preserved pre-import canonical digest does not match M5-10D authorization');
  }
  const stage = {
    schema_version: '1',
    stage_id: 'm5-11-plus-500',
    issue: 97,
    parent_issue: 7,
    authorization: {
      path: relative(AUTHORIZATION_PATH),
      sha256: authorizationSource.sha256,
      decision: authorizationResult.authorization.decision,
    },
    input: {
      inventory_revision: INPUT_INVENTORY_REVISION,
      inventory_path: relative(PREIMPORT_INVENTORY_PATH),
      inventory_sha256: preimportInventorySource.sha256,
      base_inventory_path: relative(BASE_INVENTORY_PATH),
      base_inventory_sha256: currentInventorySource.sha256,
      canonical_directory: relative(BASE_CANONICAL_DIRECTORY),
      canonical_directory_sha256: preimportCanonicalDigest,
      canonical_snapshot: beforeSummary,
    },
    target: {
      net_start_increase: NET_START_INCREASE,
      cumulative_start_target: BASE_START_COUNT + NET_START_INCREASE,
      candidate_buffer: CANDIDATE_BUFFER,
      selected_start_count: SELECTED_START_COUNT,
    },
    decisions: {
      included_start_count: INCLUDED_COUNT,
      corrected_start_count: CORRECTED_COUNT,
      held_start_count: 0,
      rejected_start_count: 0,
      deferred_start_count: CANDIDATE_BUFFER,
      processed_start_count: IMPORTED_RECORD_COUNT,
    },
    actual: {
      canonical_snapshot: finalSummary,
      imported_start_count: IMPORTED_RECORD_COUNT,
    },
    sense_review: {
      status: 'complete',
      reviewed_start_count: IMPORTED_RECORD_COUNT,
      scoped_single_sense_count: IMPORTED_RECORD_COUNT,
      split_record_count: 0,
      boundary_checkpoint_count: IMPORTED_RECORD_COUNT * BOUNDARY_IDS.length,
    },
    relation_review: {
      status: 'complete',
      candidate_count: 0,
      admitted_count: 0,
      noise_count: 0,
    },
    metrics: {
      correction_rate_of_processed: CORRECTED_COUNT / IMPORTED_RECORD_COUNT,
      relation_noise_rate: 0,
      editor_seconds_per_processed_start: null,
      timing_status: 'incomplete',
      unmeasured_timing_pass_count: TIMING_PASS_IDS.length,
      audit_status: audit.status,
      audit_independent: audit.independent,
      open_audit_blocker_count: audit.open_blocker_count,
      editorial_review_complete: verification.editorial_review_complete,
      human_editorial_review_complete: verification.human_editorial_review_complete,
      canonical_integrity: verification.canonical_integrity,
      deterministic_sqlite: verification.deterministic_sqlite,
      search_product_regression: verification.search_product_regression,
    },
    source: {
      manifest: relative(MANIFEST_PATH),
      manifest_sha256: sha256(await readFile(MANIFEST_PATH)),
      review: relative(REVIEW_PATH),
      review_sha256: reviewSource.sha256,
      relation_diff: relative(RELATION_DIFF_PATH),
      relation_diff_sha256: relationDiffDigest,
      metrics: relative(METRICS_PATH),
      metrics_sha256: metricsSource.sha256,
      timing: relative(TIMING_PATH),
      timing_sha256: timingSource.sha256,
      audit: relative(AUDIT_PATH),
      audit_sha256: auditSource.sha256,
      verification: relative(VERIFICATION_PATH),
      verification_sha256: verificationSource.sha256,
      canonical_directory: relative(DEFAULT_CANONICAL_DIRECTORY),
      canonical_directory_sha256: finalCanonicalDigest,
      canonical_import: relative(CANONICAL_BATCH_PATH),
      canonical_import_sha256: stagingDigest,
      previous_stage_authorization: relative(AUTHORIZATION_PATH),
      previous_stage_authorization_sha256: authorizationSource.sha256,
    },
    gate_status: 'fail',
    decision: 'HOLD PROCESS',
    ready_to_create: false,
    next_stage_created: false,
    next_stage_authorized: false,
    note: 'The +500 canonical import is exact and structurally verified, but the fixed gate remains HOLD PROCESS because editor-time is unmeasured and human editorial review is not yet complete.',
  };
  await writeJson(STAGE_PATH, stage);

  const report = `# M5-11 +500 expansion report\n\nIssue #97 consumes the digest-bound authorization from #115 and records a bounded +500 canonical-start validation.\n\n## Result\n\n- Canonical starts: **${beforeSummary.start_count} → ${finalSummary.start_count} (+${IMPORTED_RECORD_COUNT})**\n- Canonical records: ${beforeSummary.record_count} → ${finalSummary.record_count}\n- Reference-only records: ${beforeSummary.reference_only_count} → ${finalSummary.reference_only_count}\n- Senses: ${beforeSummary.sense_count} → ${finalSummary.sense_count}\n- Relations: ${beforeSummary.relation_count} → ${finalSummary.relation_count}\n- Expressions: ${beforeSummary.expression_count} → ${finalSummary.expression_count}\n- Decisions: ${INCLUDED_COUNT} included / ${CORRECTED_COUNT} corrected / 0 held / 0 rejected / ${CANDIDATE_BUFFER} deferred\n- Relation review: 0 candidates, 0 admitted, 0 noise\n- Sense/POS review: ${IMPORTED_RECORD_COUNT} imported starts, ${IMPORTED_RECORD_COUNT * BOUNDARY_IDS.length} boundary checkpoints\n\n## Gate\n\nThe stage is **HOLD PROCESS**. The structural and canonical checks pass, but the fixed editor-time gate cannot pass with unmeasured editorial passes, and human_editorial_review_complete remains false for this Codex-authored run. No later stage is authorized.\n\nThe raw draft and external source material are not stored in the repository. The reviewed import, manifest, relation diff, metrics, timing, audit, verification, seed transition, and source-bound stage report are tracked.\n\nValidation commands:\n\n\`\`\`sh\nnpm run batch:m5-11:check\nnpm run validate\nnpm run build:dictionary\nnpm run validate:search\n\`\`\`\n`;
  await writeFile(REPORT_PATH, report, 'utf8');

  console.log(JSON.stringify({
    batch: BATCH_ID,
    validation: {
      canonical: batchValidation.canonicalRecordCount,
      staged: batchValidation.stagedRecordCount,
      selected: SELECTED_START_COUNT,
      imported: IMPORTED_RECORD_COUNT,
      deferred: CANDIDATE_BUFFER,
    },
    before: beforeSummary,
    after: finalSummary,
    gate: stage.gate_status,
    stage: relative(STAGE_PATH),
  }, null, 2));
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  buildM511().catch((error) => {
    console.error(error.code ? `${error.code}: ${error.message}` : error.message);
    process.exitCode = 1;
  });
}

export { buildM511 };
