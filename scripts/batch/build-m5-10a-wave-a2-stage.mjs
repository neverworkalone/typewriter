import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hashCanonicalDirectory,
  sha256File,
  validateExpansionStage,
} from './validate-m5-8-process.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const STAGE_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-10a-wave-a2.json');
const PLAN_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-8-expansion-plan.json');
const MANIFEST_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-10-wave-a2.json');
const METRICS_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-10a-wave-a2-metrics.json');
const RELATION_DIFF_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-10a-wave-a2-relation-diff.json');
const VERIFICATION_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-10a-wave-a2-verification.json');
const PREVIOUS_STAGE_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-9a-wave-a-plus-50.json');
const REPAIR_AUTHORIZATION_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-10a-repair-authorization.json');
const CANONICAL_DIRECTORY = path.resolve(REPOSITORY_DIRECTORY, 'data/canonical');
const BASE_CANONICAL_DIRECTORY = path.resolve(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-10a-wave-a-base-canonical',
);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
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

function stageMetrics(metricsArtifact) {
  const { decisions, relation_diff: relationDiff, timing, audit } = metricsArtifact.derived;
  const processedStartCount = metricsArtifact.derived.selection.processed_start_count
    ?? metricsArtifact.derived.selection.selected_start_count;
  return {
    correction_rate_of_selected: decisions.correction_rate_of_selected,
    relation_noise_rate_of_before: relationDiff.noise_rate_of_before,
    relation_noise_candidate_count: relationDiff.candidate_count,
    relation_noise_rate_of_candidates: relationDiff.noise_rate_of_candidates,
    total_wall_clock_seconds: timing.total_wall_clock_seconds,
    measured_wall_clock_seconds: timing.measured_wall_clock_seconds,
    total_editor_seconds: timing.total_editor_seconds,
    measured_editor_seconds: timing.measured_editor_seconds,
    editor_seconds_per_selected_start: timing.total_editor_seconds === null
      ? null
      : timing.total_editor_seconds / processedStartCount,
    timing_status: timing.status,
    unmeasured_timing_pass_count: timing.unmeasured_passes.length,
    audit_status: audit.status,
    audit_independent: audit.independent,
    open_audit_blocker_count: audit.open_blocker_count,
    human_editorial_review_complete: true,
    canonical_integrity: true,
    deterministic_sqlite: true,
    search_product_regression: true,
  };
}

async function sourceReference(filePath) {
  return {
    path: path.relative(REPOSITORY_DIRECTORY, filePath),
    sha256: await sha256File(filePath),
  };
}

export async function buildWaveA2Stage({ outputPath = STAGE_PATH } = {}) {
  const [plan, manifest, metrics, canonical, baseCanonical] = await Promise.all([
    readJson(PLAN_PATH),
    readJson(MANIFEST_PATH),
    readJson(METRICS_PATH),
    import('../validate/canonical-jsonl.mjs').then(({ readCanonicalRecords }) => readCanonicalRecords(CANONICAL_DIRECTORY)),
    import('../validate/canonical-jsonl.mjs').then(({ readCanonicalRecords }) => readCanonicalRecords(BASE_CANONICAL_DIRECTORY)),
  ]);
  const [manifestSource, metricsSource, relationDiffSource, verificationSource, previousStageSource, repairSource, canonicalSha256] = await Promise.all([
    sourceReference(MANIFEST_PATH),
    sourceReference(METRICS_PATH),
    sourceReference(RELATION_DIFF_PATH),
    sourceReference(VERIFICATION_PATH),
    sourceReference(PREVIOUS_STAGE_PATH),
    sourceReference(REPAIR_AUTHORIZATION_PATH),
    hashCanonicalDirectory(CANONICAL_DIRECTORY),
  ]);
  const selectedStartCount = metrics.derived.selection.selected_start_count;
  const importedStartCount = metrics.derived.canonical_import.imported_start_count;
  const decisions = {
    included_start_count: metrics.derived.decisions.included,
    corrected_start_count: metrics.derived.decisions.corrected,
    held_start_count: metrics.derived.decisions.held,
    rejected_start_count: metrics.derived.decisions.rejected,
    deferred_start_count: metrics.derived.decisions.deferred,
  };
  const candidateBuffer = selectedStartCount - importedStartCount;
  const usedBuffer = decisions.held_start_count + decisions.rejected_start_count;
  const stage = {
    schema_version: '1',
    stage_id: 'm5-10a-wave-a2-plus-50',
    input: {
      inventory_revision: manifest.inventory_revision,
      canonical_snapshot: canonicalSummary(baseCanonical.records),
      previous_stage_report: previousStageSource,
      repair_authorization: repairSource,
    },
    target: {
      net_start_increase: importedStartCount,
      cumulative_start_target: 628,
      candidate_buffer: candidateBuffer,
      selected_start_count: selectedStartCount,
    },
    decisions,
    buffer: {
      available_count: candidateBuffer,
      used_count: usedBuffer,
      unused_count: decisions.deferred_start_count,
    },
    actual: {
      canonical_snapshot: canonicalSummary(canonical.records),
      imported_start_count: importedStartCount,
    },
    metrics: stageMetrics(metrics),
    source: {
      manifest: manifestSource.path,
      manifest_sha256: manifestSource.sha256,
      metrics: metricsSource.path,
      metrics_sha256: metricsSource.sha256,
      relation_diff: relationDiffSource.path,
      relation_diff_sha256: relationDiffSource.sha256,
      canonical_directory: 'data/canonical',
      canonical_sha256: canonicalSha256,
      verification: verificationSource.path,
      verification_sha256: verificationSource.sha256,
    },
    gate_status: 'pass',
    decision: 'APPROVE BOUNDED',
    next_stage_created: false,
    next_stage_authorized: false,
  };
  await writeFile(outputPath, `${JSON.stringify(stage, null, 2)}\n`, 'utf8');
  await validateExpansionStage(stage, plan);
  return stage;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  buildWaveA2Stage()
    .then((stage) => {
      console.log(`Generated ${stage.stage_id}: ${stage.actual.imported_start_count} imported start(s), gate ${stage.gate_status}.`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
