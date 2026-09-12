import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_FOLLOW_UP_SOURCE_PATH,
  DEFAULT_PROPOSAL_PATH,
  DEFAULT_WORKLOAD_PATH,
  M5_10D_BATCH_ID,
  M5_10D_CASE_COUNT,
  M5_10D_PROCESS_REVISION,
  M5DRecoveryValidationError,
  deriveM5DFollowUpQueues,
  REPOSITORY_DIRECTORY,
  validateM5DProposal,
  validateM5DFollowUpSource,
  validateM5DWorkload,
  workloadUnitSetSha256,
} from './validate-m5-10d-recovery.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function allCaseIds() {
  return Array.from({ length: M5_10D_CASE_COUNT }, (_, index) => `m5-10d-cal-${String(index + 1).padStart(3, '0')}`);
}

function sourcePath(filePath) {
  const relative = path.relative(REPOSITORY_DIRECTORY, path.resolve(filePath));
  return relative.startsWith('..') || path.isAbsolute(relative) ? path.resolve(filePath) : relative;
}

async function readJson(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    throw new Error(`${label} does not exist: ${filePath}`, { cause: error });
  }
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
}

async function requireMissing(filePath) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`refusing to overwrite pre-existing workload: ${filePath}`);
}

function pass(id, role, unitKind, declarationSource, expectedUnitIds, declaredAt) {
  return {
    id,
    role,
    unit_kind: unitKind,
    declaration_source: declarationSource,
    declared_at: declaredAt,
    expected_unit_ids: expectedUnitIds,
    expected_unit_count: expectedUnitIds.length,
    expected_unit_set_sha256: workloadUnitSetSha256(expectedUnitIds),
    empty_work: expectedUnitIds.length === 0,
    note: `${id} workload was declared from a pre-pass task queue before timing began.`,
  };
}

export async function buildM5DWorkload({
  proposalPath = DEFAULT_PROPOSAL_PATH,
  outputPath = DEFAULT_WORKLOAD_PATH,
  followUpSourcePath = DEFAULT_FOLLOW_UP_SOURCE_PATH,
  provisional = false,
  feedbackIds,
  heldRejectedIds,
  frozenAt = new Date().toISOString(),
} = {}) {
  if (feedbackIds !== undefined || heldRejectedIds !== undefined) {
    throw new M5DRecoveryValidationError('follow-up queues must be derived from the recorder-owned source artifact', 'WORKLOAD_SOURCE_REQUIRED');
  }
  const proposalSource = await readJson(proposalPath, 'M5-10D calibration proposal');
  const canonical = await readCanonicalRecords(path.resolve(SCRIPT_DIRECTORY, '../../data/canonical'));
  const proposalInfo = validateM5DProposal(proposalSource.value, { canonicalRecords: canonical.records });
  const all = proposalInfo.case_ids;
  let followUpSource;
  let feedbackIdsFromSource = [];
  let heldRejectedIdsFromSource = [];
  if (!provisional) {
    followUpSource = await readJson(followUpSourcePath, 'M5-10D follow-up source');
    validateM5DFollowUpSource(followUpSource.value, {
      proposalCaseIds: all,
      proposalSha256: proposalSource.sha256,
      proposalCasesById: proposalInfo.by_case,
    });
    ({ feedback: feedbackIdsFromSource, heldRejected: heldRejectedIdsFromSource } = deriveM5DFollowUpQueues(followUpSource.value));
    if (Date.parse(frozenAt) < Date.parse(followUpSource.value.created_at)) {
      throw new M5DRecoveryValidationError('workload freeze must occur after the follow-up source was recorded', 'WORKLOAD_SOURCE_CHRONOLOGY');
    }
  }
  const workload = {
    schema_version: '1',
    artifact_id: 'm5-10d-workload-20260912',
    issue: 115,
    parent_issue: 7,
    batch_id: M5_10D_BATCH_ID,
    process_revision: M5_10D_PROCESS_REVISION,
    declaration_kind: 'source-declared-before-each-pass',
    declaration_status: provisional ? 'pre-review' : 'frozen',
    frozen_at: frozenAt,
    source: {
      proposal_artifact: 'external:m5-10d-calibration-proposal',
      proposal_sha256: proposalSource.sha256,
      decision_independent: true,
      ...(!provisional ? {
        follow_up_artifact: 'external:m5-10d-follow-up-source',
        follow_up_sha256: followUpSource.sha256,
        follow_up_source_kind: followUpSource.value.source_kind,
        follow_up_timing_session_id: followUpSource.value.timing_session_id,
        follow_up_pass_id: followUpSource.value.source_pass_id,
        follow_up_freeze_event_id: followUpSource.value.freeze_event_id,
      } : {}),
    },
    case_count: M5_10D_CASE_COUNT,
    processed_start_count: M5_10D_CASE_COUNT,
    passes: [
      pass('target-preparation', 'target-preparation', 'calibration-start', 'pre-review-sample', all, frozenAt),
      pass('initial-review', 'semantic-review', 'calibration-start', 'pre-review-sample', all, frozenAt),
      pass('feedback-fixes', 'feedback-fix', 'feedback-fix', 'source-derived-initial-findings', [...feedbackIdsFromSource], frozenAt),
      pass('final-verification', 'final-verification', 'final-verification', 'source-derived-correction-findings', [...feedbackIdsFromSource], frozenAt),
      pass('held-rejected', 'held-rejected', 'held-rejected', 'source-derived-initial-findings', [...heldRejectedIdsFromSource], frozenAt),
      pass('post-freeze-audit', 'post-freeze-audit', 'audit-review', 'frozen-editorial-sample', all, frozenAt),
    ],
    note: provisional
      ? 'M5-10D pre-review workload declares only the fixed target and initial sample. Follow-up queues are intentionally empty until recorder-owned initial findings are frozen.'
      : 'M5-10D workload is frozen from the recorder-owned initial-review source artifact before any follow-up pass. Queue membership is never supplied by a caller or reverse-engineered from final output.',
  };
  const info = validateM5DWorkload(workload, {
    proposalCaseIds: all,
    proposalSha256: proposalSource.sha256,
    proposalCasesById: proposalInfo.by_case,
    followUpSource,
  });
  info.sha256 = undefined;
  await requireMissing(outputPath);
  const bytes = Buffer.from(`${JSON.stringify(workload, null, 2)}\n`, 'utf8');
  await writeFile(outputPath, bytes);
  console.log(JSON.stringify({ output: sourcePath(outputPath), sha256: sha256(bytes), proposal_sha256: proposalSource.sha256 }, null, 2));
  return workload;
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
  buildM5DWorkload({
    ...(args.proposal ? { proposalPath: path.resolve(args.proposal) } : {}),
    ...(args.output ? { outputPath: path.resolve(args.output) } : {}),
    ...(args['follow-up-source'] ? { followUpSourcePath: path.resolve(args['follow-up-source']) } : {}),
    ...(args.provisional !== undefined ? { provisional: !['false', '0', 'no'].includes(args.provisional.toLowerCase()) } : {}),
    ...(args.feedback !== undefined ? { feedbackIds: args.feedback } : {}),
    ...(args['held-rejected'] !== undefined ? { heldRejectedIds: args['held-rejected'] } : {}),
  }).catch((error) => {
    console.error(error.code ? `${error.code}: ${error.message}` : error.message);
    process.exitCode = 1;
  });
}
