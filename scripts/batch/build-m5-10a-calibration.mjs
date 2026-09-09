import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CALIBRATION_ARTIFACT_PATH,
  DEFAULT_CALIBRATION_AUDIT_PATH,
  DEFAULT_CALIBRATION_CANONICAL_DIRECTORY,
  DEFAULT_CALIBRATION_FIXTURE_PATH,
  DEFAULT_CALIBRATION_PLAN_PATH,
  DEFAULT_CALIBRATION_TIMING_PATH,
  evaluateCalibrationGate,
  validateCalibrationFixtureEvidence,
  validateCalibrationAuditInput,
} from './validate-m5-10a-calibration.mjs';
import { verifyCalibrationTimingRecording } from './timing.mjs';
import { generateRelationCandidates } from './relation-generation.mjs';
import { hashCanonicalDirectory, validateExpansionPlan } from './validate-m5-8-process.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CANONICAL_DIRECTORY = DEFAULT_CALIBRATION_CANONICAL_DIRECTORY;
const DEFAULT_PROCESS_PATH = path.resolve(SCRIPT_DIRECTORY, '../../data/batches/m5-10a-process-correction.json');
const DEFAULT_REPAIR_PATH = path.resolve(SCRIPT_DIRECTORY, '../../data/batches/m5-10a-repair-authorization.json');
const CALIBRATION_AUDIT_PATH = 'data/batches/m5-10a-relation-calibration-audit.json';
const CALIBRATION_GENERATION_REVISION = 'm5-10a-relation-generation-v3';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJsonSource(filePath) {
  const bytes = await readFile(filePath);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
}

function canonicalSnapshot(recordInfos) {
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

function rawProposalDigest(rawProposals) {
  return sha256(JSON.stringify(rawProposals));
}

function buildArtifact({ fixtureSource, planSource, timingSource, auditSource, canonical, generated, auditResult, gateResult, artifactId }) {
  const snapshot = canonicalSnapshot(canonical.records);
  const timingSummary = verifyCalibrationTimingRecording(timingSource.value);
  const source = {
    fixture: 'tests/fixtures/m5-10a-relation-generation-calibration.json',
    fixture_sha256: fixtureSource.sha256,
    canonical_directory: 'data/batches/m5-10a-wave-a-base-canonical',
    canonical_directory_sha256: canonical.directorySha256,
    expansion_plan: 'data/batches/m5-8-expansion-plan.json',
    expansion_plan_sha256: planSource.sha256,
    relation_calibration_timing: 'data/batches/m5-10a-relation-calibration-timing.json',
    relation_calibration_timing_sha256: timingSource.sha256,
    relation_calibration_audit: CALIBRATION_AUDIT_PATH,
    relation_calibration_audit_sha256: auditSource.sha256,
  };
  const artifact = {
    schema_version: '1',
    artifact_id: artifactId,
    process_revision: CALIBRATION_GENERATION_REVISION,
    canonical_mutation: false,
    source,
    canonical_snapshot: snapshot,
    calibration: {
      case_count: fixtureSource.value.cases.length,
      preflight: validateCalibrationFixtureEvidence(fixtureSource.value, canonical.records),
      generation: {
        request_count: generated.request_count,
        raw_proposal_count: generated.raw_proposal_count,
        generation_suppressed_count: generated.generation_suppressed_count,
        not_generated_count: generated.not_generated_count,
        not_generated_case_ids: generated.not_generated_cases.map(({ case_id: caseId }) => caseId),
        pre_screen_noise_count: generated.pre_screen_noise_count,
        noise_rate_of_raw_proposals: generated.noise_rate_of_raw_proposals,
        suppressed_category_counts: generated.suppressed_category_counts,
      },
      timing: {
        status: timingSummary.status,
        timing_source: 'data/batches/m5-10a-relation-calibration-timing.json',
        timing_source_sha256: timingSource.sha256,
        processed_start_count: timingSummary.processed_start_count,
        editor_seconds: timingSummary.editor_seconds,
        editor_seconds_per_processed_start: timingSummary.editor_seconds_per_processed_start,
        unmeasured_pass_count: timingSummary.unmeasured_pass_count,
        machine_validation_excluded_from_editor_seconds: true,
        final_audit_pass_session_id: timingSummary.final_audit_pass_session_id,
        final_audit_case_count: timingSummary.final_audit_work_evidence.case_count,
        final_audit_case_ids: timingSummary.final_audit_work_evidence.case_ids,
        final_audit_raw_proposal_sha256: timingSummary.final_audit_work_evidence.raw_proposal_sha256,
      },
      audit: {
        ...auditResult,
      },
      fixed_gate: {
        status: gateResult.status,
        relation_noise_rate_max: planSource.value.gate.relation_noise_rate_max,
        editor_seconds_per_processed_start_max: planSource.value.gate.editor_seconds_per_selected_start_max,
        correction_rate_max: planSource.value.gate.correction_rate_max,
        unmeasured_timing_passes_max: planSource.value.gate.unmeasured_timing_passes_max,
        open_audit_blockers_max: planSource.value.gate.open_audit_blockers_max,
      },
    },
    raw_proposals: generated.generated_candidates,
    generation_suppressions: generated.suppressed_candidates,
    not_generated_cases: generated.not_generated_cases,
  };
  return artifact;
}

async function writeJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await writeFile(filePath, bytes);
  return sha256(bytes);
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

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const fixturePath = path.resolve(args.fixture ?? DEFAULT_CALIBRATION_FIXTURE_PATH);
  const planPath = path.resolve(args.plan ?? DEFAULT_CALIBRATION_PLAN_PATH);
  const timingPath = path.resolve(args.timing ?? DEFAULT_CALIBRATION_TIMING_PATH);
  const auditPath = path.resolve(args.audit ?? DEFAULT_CALIBRATION_AUDIT_PATH);
  const outputPath = path.resolve(args.output ?? DEFAULT_CALIBRATION_ARTIFACT_PATH);
  const [fixtureSource, planSource, timingSource, auditSource, canonical] = await Promise.all([
    readJsonSource(fixturePath),
    readJsonSource(planPath),
    readJsonSource(timingPath),
    readJsonSource(auditPath),
    readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY),
  ]);
  planSource.value && validateExpansionPlan(planSource.value);
  const canonicalDirectorySha256 = await hashCanonicalDirectory(DEFAULT_CANONICAL_DIRECTORY);
  canonical.directorySha256 = canonicalDirectorySha256;
  const generated = generateRelationCandidates(fixtureSource.value, canonical.records);
  const timingSummary = verifyCalibrationTimingRecording(timingSource.value);
  const timingAuditSummary = {
    ...timingSummary,
    final_audit_case_count: timingSummary.final_audit_work_evidence.case_count,
    final_audit_case_ids: timingSummary.final_audit_work_evidence.case_ids,
    final_audit_raw_proposal_sha256: timingSummary.final_audit_work_evidence.raw_proposal_sha256,
  };
  const rawDigest = rawProposalDigest(generated.generated_candidates);
  const auditResult = validateCalibrationAuditInput({
    audit: auditSource.value,
    auditSourceSha256: auditSource.sha256,
    fixture: fixtureSource.value,
    generated,
    timing: timingAuditSummary,
    expectedRawProposalSha256: rawDigest,
  });
  const limits = {
    relation_noise_rate_max: planSource.value.gate.relation_noise_rate_max,
    editor_seconds_per_processed_start_max: planSource.value.gate.editor_seconds_per_selected_start_max,
    correction_rate_max: planSource.value.gate.correction_rate_max,
    unmeasured_timing_passes_max: planSource.value.gate.unmeasured_timing_passes_max,
    open_audit_blockers_max: planSource.value.gate.open_audit_blockers_max,
  };
  const gateResult = evaluateCalibrationGate({
    generated: { ...generated, noise_rate_of_raw_proposals: auditResult.noise_rate_of_raw_proposals },
    timing: timingSummary,
    audit: auditResult,
    limits,
  });
  if (gateResult.status !== 'passed') {
    throw new Error(`calibration audit did not pass the fixed gate: ${gateResult.failures.join('; ')}`);
  }
  const artifactId = args['artifact-id']
    ?? `m5-10a-relation-calibration-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
  const artifact = buildArtifact({ fixtureSource, planSource, timingSource, auditSource, canonical, generated, auditResult, gateResult, artifactId });
  const calibrationSha256 = await writeJson(outputPath, artifact);

  const processPath = path.resolve(args.process ?? DEFAULT_PROCESS_PATH);
  const processSource = await readJsonSource(processPath);
  processSource.value.source.relation_calibration_sha256 = calibrationSha256;
  processSource.value.source.relation_calibration_timing_sha256 = timingSource.sha256;
  processSource.value.source.relation_calibration_audit = CALIBRATION_AUDIT_PATH;
  processSource.value.source.relation_calibration_audit_sha256 = auditSource.sha256;
  const updatedCandidateGeneration = {
    ...processSource.value.candidate_generation,
    calibration_artifact_sha256: calibrationSha256,
    raw_proposal_count: generated.raw_proposal_count,
    not_generated_count: generated.not_generated_count,
    not_generated_case_ids: generated.not_generated_cases.map(({ case_id: caseId }) => caseId),
    audited_noise_count: auditResult.confirmed_noise_count,
    audited_noise_rate_of_raw_proposals: auditResult.noise_rate_of_raw_proposals,
    correction_rate: auditResult.correction_rate,
    editor_seconds_per_processed_start: verifyCalibrationTimingRecording(timingSource.value).editor_seconds_per_processed_start,
    timing_source_sha256: timingSource.sha256,
  };
  processSource.value.candidate_generation = Object.fromEntries(
    Object.entries(updatedCandidateGeneration).flatMap(([key, value]) => {
      if (key === 'not_generated_count' || key === 'not_generated_case_ids') return [];
      if (key === 'pre_screen_noise_count') {
        return [
          ['not_generated_count', updatedCandidateGeneration.not_generated_count],
          ['not_generated_case_ids', updatedCandidateGeneration.not_generated_case_ids],
          [key, value],
        ];
      }
      if (key === 'editor_seconds_per_processed_start') {
        return [
          ['audited_noise_count', updatedCandidateGeneration.audited_noise_count],
          ['audited_noise_rate_of_raw_proposals', updatedCandidateGeneration.audited_noise_rate_of_raw_proposals],
          [key, value],
        ];
      }
      if (key === 'audited_noise_count' || key === 'audited_noise_rate_of_raw_proposals') return [];
      return [[key, value]];
    }),
  );
  const processFinding = processSource.value.audit?.findings?.find(
    ({ id }) => id === 'm5-10a-candidate-generation-calibration',
  );
  if (processFinding) {
    processFinding.note = `Twenty unlabelled, noncanonical requests were independently audited; ${auditResult.human_admitted_count} raw proposals were admitted, ${auditResult.confirmed_noise_count} were classified as noise, ${auditResult.correction_count} required correction, and ${generated.not_generated_count} requests remained visible as normal no-candidate results. Recorder-proven time, correction, and noise gates passed.`;
  }
  const processSha256 = await writeJson(processPath, processSource.value);

  const repairPath = path.resolve(args.repair ?? DEFAULT_REPAIR_PATH);
  const repairSource = await readJsonSource(repairPath);
  repairSource.value.source.process_correction_sha256 = processSha256;
  repairSource.value.candidate_generation = structuredClone(processSource.value.candidate_generation);
  const repairFinding = repairSource.value.audit?.findings?.find(
    ({ id }) => id === 'm5-10a-candidate-generation-calibration',
  );
  if (repairFinding) repairFinding.note = processFinding?.note ?? repairFinding.note;
  await writeJson(repairPath, repairSource.value);
  console.log(`Built ${path.relative(process.cwd(), outputPath)} with ${generated.raw_proposal_count} raw proposal(s) and ${generated.not_generated_count} no-candidate result(s).`);
  return artifact;
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
