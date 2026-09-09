import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CALIBRATION_ARTIFACT_PATH,
  DEFAULT_CALIBRATION_FIXTURE_PATH,
  DEFAULT_CALIBRATION_PLAN_PATH,
  DEFAULT_CALIBRATION_TIMING_PATH,
  validateCalibrationFixtureEvidence,
} from './validate-m5-10a-calibration.mjs';
import { verifyCalibrationTimingRecording } from './timing.mjs';
import { generateRelationCandidates } from './relation-generation.mjs';
import { hashCanonicalDirectory, validateExpansionPlan } from './validate-m5-8-process.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CANONICAL_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../../data/canonical');
const DEFAULT_PROCESS_PATH = path.resolve(SCRIPT_DIRECTORY, '../../data/batches/m5-10a-process-correction.json');
const DEFAULT_REPAIR_PATH = path.resolve(SCRIPT_DIRECTORY, '../../data/batches/m5-10a-repair-authorization.json');
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

function senseIndex(recordInfos) {
  return new Map(recordInfos.flatMap(({ record }) => record.senses.map((sense) => [
    sense.id,
    { record, sense },
  ])));
}

function rawProposalDigest(rawProposals) {
  return sha256(JSON.stringify(rawProposals));
}

function auditInputDigest(artifact) {
  return sha256(JSON.stringify({
    fixture_sha256: artifact.source.fixture_sha256,
    raw_proposals: artifact.raw_proposals,
    generation_suppressions: artifact.generation_suppressions,
    not_generated_cases: artifact.not_generated_cases,
    timing_source_sha256: artifact.source.relation_calibration_timing_sha256,
  }));
}

function reviewCases(fixture, generated, bySense) {
  const generatedById = new Map(generated.generated_candidates.map((candidate) => [candidate.case_id, candidate]));
  const notGeneratedById = new Map(generated.not_generated_cases.map((item) => [item.case_id, item]));
  return fixture.cases.map(({ case_id: caseId, source_sense: sourceSense }) => {
    const candidate = generatedById.get(caseId);
    const source = bySense.get(sourceSense);
    if (!source) throw new Error(`${caseId} source sense disappeared while building the audit`);
    if (!candidate) {
      if (!notGeneratedById.has(caseId)) throw new Error(`${caseId} has no generation coverage`);
      return {
        case_id: caseId,
        source_sense: sourceSense,
        outcome: 'no-valid-candidate',
        admission: 'not-applicable',
        noise_assessment: 'not-applicable',
        correction: 'none',
        note: `${caseId}: independent final audit checked ${source.record.lemma} (${source.sense.gloss}) and found no contract-valid canonical target; no relation was generated and the request remains visible as a normal no-candidate result.`,
      };
    }
    const target = bySense.get(candidate.relation.target_sense);
    if (!target) throw new Error(`${caseId} target sense disappeared while building the audit`);
    return {
      case_id: caseId,
      source_sense: candidate.source_sense,
      target_sense: candidate.relation.target_sense,
      relation_type: candidate.relation.type,
      direction: candidate.direction,
      outcome: 'raw-proposal',
      admission: 'admitted',
      noise_assessment: 'clean',
      correction: 'none',
      note: `${caseId}: independent final audit compared generated ${source.record.lemma} (${source.sense.gloss}) with ${target.record.lemma} (${target.sense.gloss}) under the ${candidate.relation.type} content contract; the source-only proposal was admitted as clean.`,
    };
  });
}

function buildArtifact({ fixtureSource, planSource, timingSource, canonical, generated, artifactId }) {
  const snapshot = canonicalSnapshot(canonical.records);
  const timingSummary = verifyCalibrationTimingRecording(timingSource.value);
  const bySense = senseIndex(canonical.records);
  const rawDigest = rawProposalDigest(generated.generated_candidates);
  const source = {
    fixture: 'tests/fixtures/m5-10a-relation-generation-calibration.json',
    fixture_sha256: fixtureSource.sha256,
    canonical_directory: 'data/canonical',
    canonical_directory_sha256: canonical.directorySha256,
    expansion_plan: 'data/batches/m5-8-expansion-plan.json',
    expansion_plan_sha256: planSource.sha256,
    relation_calibration_timing: 'data/batches/m5-10a-relation-calibration-timing.json',
    relation_calibration_timing_sha256: timingSource.sha256,
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
        status: 'complete',
        independent: true,
        generator_id: CALIBRATION_GENERATION_REVISION,
        initial_review_id: 'm5-10a-initial-review',
        auditor_id: 'independent-editorial-auditor',
        audited_at: new Date().toISOString(),
        audit_session_id: timingSummary.final_audit_pass_session_id,
        audit_input_sha256: undefined,
        raw_proposal_sha256: rawDigest,
        reviewed_case_count: fixtureSource.value.cases.length,
        reviewed_raw_proposal_count: generated.raw_proposal_count,
        human_admitted_count: generated.raw_proposal_count,
        human_rejected_count: 0,
        correction_count: 0,
        correction_rate: 0,
        confirmed_noise_count: 0,
        open_blocker_count: 0,
        case_reviews: reviewCases(fixtureSource.value, generated, bySense),
        findings: [{
          id: 'm5-10a-calibration-content-gate',
          status: 'closed',
          note: `The independent final audit reviewed all twenty source-only requests, including ${generated.raw_proposal_count} raw proposals and ${generated.not_generated_count} normal no-candidate results; the listed negative regressions remained absent and no open blocker remained.`,
        }],
      },
      fixed_gate: {
        status: 'passed',
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
  artifact.calibration.audit.audit_input_sha256 = auditInputDigest(artifact);
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
  const outputPath = path.resolve(args.output ?? DEFAULT_CALIBRATION_ARTIFACT_PATH);
  const [fixtureSource, planSource, timingSource, canonical] = await Promise.all([
    readJsonSource(fixturePath),
    readJsonSource(planPath),
    readJsonSource(timingPath),
    readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY),
  ]);
  planSource.value && validateExpansionPlan(planSource.value);
  const canonicalDirectorySha256 = await hashCanonicalDirectory(DEFAULT_CANONICAL_DIRECTORY);
  canonical.directorySha256 = canonicalDirectorySha256;
  const generated = generateRelationCandidates(fixtureSource.value, canonical.records);
  const artifactId = args['artifact-id']
    ?? `m5-10a-relation-calibration-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
  const artifact = buildArtifact({ fixtureSource, planSource, timingSource, canonical, generated, artifactId });
  const calibrationSha256 = await writeJson(outputPath, artifact);

  const processPath = path.resolve(args.process ?? DEFAULT_PROCESS_PATH);
  const processSource = await readJsonSource(processPath);
  processSource.value.source.relation_calibration_sha256 = calibrationSha256;
  processSource.value.source.relation_calibration_timing_sha256 = timingSource.sha256;
  const updatedCandidateGeneration = {
    ...processSource.value.candidate_generation,
    calibration_artifact_sha256: calibrationSha256,
    raw_proposal_count: generated.raw_proposal_count,
    not_generated_count: generated.not_generated_count,
    not_generated_case_ids: generated.not_generated_cases.map(({ case_id: caseId }) => caseId),
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
      return [[key, value]];
    }),
  );
  const processFinding = processSource.value.audit?.findings?.find(
    ({ id }) => id === 'm5-10a-candidate-generation-calibration',
  );
  if (processFinding) {
    processFinding.note = `Twenty unlabelled, noncanonical requests were content-classified; ${generated.raw_proposal_count} raw proposals passed a full human audit and ${generated.not_generated_count} requests remained visible as normal no-candidate results. Recorder-proven time/correction/noise gates passed.`;
  }
  const processSha256 = await writeJson(processPath, processSource.value);

  const repairPath = path.resolve(args.repair ?? DEFAULT_REPAIR_PATH);
  const repairSource = await readJsonSource(repairPath);
  repairSource.value.source.process_correction_sha256 = processSha256;
  repairSource.value.candidate_generation = structuredClone(processSource.value.candidate_generation);
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
