import { access, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  A2_BATCH_ID,
  A2_PROMOTED_CANONICAL_IDS,
  validateA2EditorialDecisionArtifact,
  validateA2EditorialInput,
  validateA2ProvenanceArtifact,
  validateA2TimingInput,
  sha256Bytes,
  sha256ProvenanceSubject,
} from './validate-m5-10a-wave-a2-inputs.mjs';
import {
  M5_10A_SENSE_BOUNDARY_IDS,
  assertExternalStagingPath,
} from './validate-batch.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const PROPOSAL_SHA256 = '290a74905da1eea8e816dc7273acca2abe09c9a94e30217c0abb3f3e96717dd8';
const EDITORIAL_RECORDER_VERSION = 'wave-a2-editorial-recorder-v2';
const A2_DATE = A2_BATCH_ID.slice(-8);
const DEFAULT_PROVENANCE_ARTIFACT = `data/batches/m5-10a-wave-a2-provenance-editorial-${A2_DATE}.json`;

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

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label} does not exist: ${filePath}`);
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON: ${error.message}`);
    throw error;
  }
}

async function readBytes(filePath, label) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label} does not exist: ${filePath}`);
    throw error;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function assertNewSession(sessionPath) {
  try {
    await access(sessionPath);
    throw new Error(`refusing to overwrite an existing editorial session: ${sessionPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function repositoryRelativePath(filePath, label) {
  const relative = path.relative(REPOSITORY_DIRECTORY, path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the repository so its digest can be committed: ${filePath}`);
  }
  return relative;
}

function assertChronologicalTiming(timing) {
  validateA2TimingInput(timing);
  if (timing.status !== 'complete') throw new Error('editorial completion requires complete A2 timing');
  for (let index = 1; index < timing.passes.length; index += 1) {
    const previous = timing.passes[index - 1];
    const current = timing.passes[index];
    if (Date.parse(current.started_at) < Date.parse(previous.completed_at)) {
      throw new Error('editorial timing passes overlap or are out of order');
    }
  }
  return timing.passes.at(-1).completed_at;
}

export function assertEditorialCompletionChronology(timing, completedAt) {
  const timingCompletedAt = assertChronologicalTiming(timing);
  if (Date.parse(timingCompletedAt) > Date.parse(completedAt)) {
    throw new Error('editorial completion cannot precede the final timing stop');
  }
  return timingCompletedAt;
}

export function assertEditorialTimingSessionChronology(timing, sessionStartedAt, completedAt) {
  const timingCompletedAt = assertEditorialCompletionChronology(timing, completedAt);
  const timingStartedAt = timing.passes[0].started_at;
  if (Date.parse(timingStartedAt) < Date.parse(sessionStartedAt)) {
    throw new Error('editorial session must start before the first timing pass');
  }
  return { timingStartedAt, timingCompletedAt };
}

function recordMap(recordInfos) {
  return new Map(recordInfos.map(({ record }) => [record.id, record]));
}

function countSplitRecords(decisionRecords, stagedRecords) {
  const stagedById = recordMap(stagedRecords);
  return decisionRecords
    .slice(0, A2_PROMOTED_CANONICAL_IDS.length)
    .filter(({ decision, canonical_id: canonicalId }) => (
      decision === 'corrected' && (stagedById.get(canonicalId)?.senses.length ?? 0) > 1
    )).length;
}

async function startSession(args) {
  const proposalPath = path.resolve(args.proposal);
  const proposalBytes = await readBytes(proposalPath, 'editorial proposal');
  const proposalSha256 = sha256Bytes(proposalBytes);
  if (proposalSha256 !== PROPOSAL_SHA256) {
    throw new Error(`proposal digest ${proposalSha256} does not match the #110 boundary digest`);
  }
  const sessionPath = path.resolve(args.session);
  await assertNewSession(sessionPath);
  const session = {
    schema_version: '1',
    recorder_version: EDITORIAL_RECORDER_VERSION,
    status: 'in-progress',
    session_id: randomUUID(),
    actor_kind: 'codex',
    actor_id: 'codex-wave-a2-editorial',
    started_at: new Date().toISOString(),
    proposal_path: proposalPath,
    proposal_sha256: proposalSha256,
    note: 'Editorial session started; completion requires separately supplied decisions, a frozen staging file, and stopped timing passes.',
  };
  await writeJson(sessionPath, session);
  console.log(`Started Codex Wave A2 editorial session ${session.session_id}.`);
  return session;
}

async function completeSession(args) {
  const sessionPath = path.resolve(args.session);
  const session = await readJson(sessionPath, 'editorial session');
  if (session.recorder_version !== EDITORIAL_RECORDER_VERSION || session.status !== 'in-progress') {
    throw new Error('editorial session must be an in-progress v2 recorder session');
  }

  const proposalBytes = await readBytes(session.proposal_path, 'editorial proposal');
  if (sha256Bytes(proposalBytes) !== session.proposal_sha256 || session.proposal_sha256 !== PROPOSAL_SHA256) {
    throw new Error('editorial session proposal digest changed before completion');
  }
  const stagingPath = path.resolve(args.staging);
  assertExternalStagingPath(stagingPath);
  const stagingBytes = await readBytes(stagingPath, 'reviewed staging');
  const reviewedStagingSha256 = sha256Bytes(stagingBytes);
  const decisionPath = path.resolve(args.decisions);
  const decisionBytes = await readBytes(decisionPath, 'editorial decision artifact');
  const decisionArtifact = validateA2EditorialDecisionArtifact(JSON.parse(decisionBytes.toString('utf8')));
  if (decisionArtifact.source_kind !== 'codex-authored' || decisionArtifact.actor_kind !== 'codex') {
    throw new Error('editorial recorder v2 requires Codex-authored decision input');
  }
  if (decisionArtifact.session_id !== session.session_id) {
    throw new Error('editorial decision artifact must bind the active editorial session');
  }
  if (decisionArtifact.proposal_staging_sha256 !== session.proposal_sha256) {
    throw new Error('editorial decision artifact proposal digest does not match the session');
  }
  if (decisionArtifact.reviewed_staging_sha256 !== reviewedStagingSha256) {
    throw new Error('editorial decision artifact reviewed staging digest does not match the frozen staging');
  }

  const timingPath = path.resolve(args.timing);
  const timingBytes = await readBytes(timingPath, 'A2 timing input');
  const timing = JSON.parse(timingBytes.toString('utf8'));
  const completedAt = new Date().toISOString();
  const { timingStartedAt, timingCompletedAt } = assertEditorialTimingSessionChronology(
    timing,
    session.started_at,
    completedAt,
  );
  if (Date.parse(decisionArtifact.created_at) < Date.parse(session.started_at)
    || Date.parse(decisionArtifact.created_at) > Date.parse(completedAt)) {
    throw new Error('editorial decisions must be supplied during the active editorial session');
  }
  if (Date.parse(decisionArtifact.finalized_at) < Date.parse(session.started_at)
    || Date.parse(decisionArtifact.finalized_at) < Date.parse(timingCompletedAt)
    || Date.parse(decisionArtifact.finalized_at) > Date.parse(completedAt)) {
    throw new Error('editorial decisions must be finalized after all timing passes stop and before editorial completion');
  }

  const canonical = await readCanonicalRecords(path.resolve(args.canonical));
  const staged = await readCanonicalRecords(stagingPath);
  const stagedById = recordMap(staged.records);
  if (staged.records.length !== A2_PROMOTED_CANONICAL_IDS.length
    || JSON.stringify([...stagedById.keys()].sort()) !== JSON.stringify([...A2_PROMOTED_CANONICAL_IDS].sort())) {
    throw new Error('reviewed staging must contain exactly the 50 promoted canonical records');
  }
  const splitRecordCount = countSplitRecords(decisionArtifact.records, staged.records);
  const editorial = {
    schema_version: '2',
    input_id: `m5-10a-wave-a2-editorial-input-${A2_DATE}`,
    batch_id: A2_BATCH_ID,
    inventory_id: 'm5-core-5k',
    inventory_revision: 'm5-10',
    source_kind: 'codex-authored',
    status: 'complete',
    created_at: session.started_at,
    completed_at: completedAt,
    provenance: {
      verification_status: 'verified',
      actor_kind: 'codex',
      actor_id: session.actor_id,
      session_id: session.session_id,
      artifact: args.provenance
        ? repositoryRelativePath(args.provenance, 'editorial provenance artifact')
        : DEFAULT_PROVENANCE_ARTIFACT,
      sha256: null,
      note: 'Codex editorial output is derived from the separately supplied decision artifact and frozen staging bytes.',
    },
    sense_review: {
      status: 'complete',
      boundary_ids: [...M5_10A_SENSE_BOUNDARY_IDS],
      reviewed_start_count: A2_PROMOTED_CANONICAL_IDS.length,
      scoped_single_sense_count: A2_PROMOTED_CANONICAL_IDS.length - splitRecordCount,
      split_record_count: splitRecordCount,
      split_canonical_ids: decisionArtifact.records
        .slice(0, A2_PROMOTED_CANONICAL_IDS.length)
        .filter(({ decision, canonical_id: canonicalId }) => (
          decision === 'corrected' && (stagedById.get(canonicalId)?.senses.length ?? 0) > 1
        ))
        .map(({ canonical_id: canonicalId }) => canonicalId)
        .sort(),
      note: 'All selected starts were supplied with record-specific decisions and six boundary checks in the separate editorial decision artifact.',
    },
    proposal_staging: {
      format: 'canonical-jsonl',
      sha256: session.proposal_sha256,
      note: 'The external builder proposal is retained only as the input boundary for the separate editorial decisions.',
    },
    timing_artifact: {
      path: repositoryRelativePath(timingPath, 'timing artifact'),
      sha256: sha256Bytes(timingBytes),
      started_at: timingStartedAt,
      completed_at: timingCompletedAt,
    },
    decision_artifact: {
      path: repositoryRelativePath(decisionPath, 'editorial decision artifact'),
      sha256: sha256Bytes(decisionBytes),
      created_at: decisionArtifact.created_at,
      finalized_at: decisionArtifact.finalized_at,
    },
    reviewed_staging_sha256: reviewedStagingSha256,
    records: structuredClone(decisionArtifact.records),
  };
  const artifactPath = path.resolve(REPOSITORY_DIRECTORY, editorial.provenance.artifact);
  const artifact = {
    schema_version: '1',
    artifact_id: `m5-10a-wave-a2-provenance-editorial-${A2_DATE}`,
    subject_kind: 'editorial',
    subject_id: editorial.input_id,
    subject_sha256: sha256ProvenanceSubject(editorial),
    session_id: editorial.provenance.session_id,
    actor_kind: editorial.provenance.actor_kind,
    actor_id: editorial.provenance.actor_id,
    started_at: session.started_at,
    completed_at: completedAt,
  };
  const artifactBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  editorial.provenance.sha256 = sha256Bytes(artifactBytes);
  validateA2EditorialInput({
    input: editorial,
    canonicalRecords: [...canonical.records, ...staged.records],
  });
  await writeFile(artifactPath, artifactBytes, 'utf8');
  await writeJson(path.resolve(args.editorial), editorial);
  await validateA2ProvenanceArtifact({
    input: editorial,
    repositoryDirectory: REPOSITORY_DIRECTORY,
    subjectKind: 'editorial',
  });
  const completedSession = {
    ...session,
    status: 'complete',
    completed_at: completedAt,
    reviewed_staging_path: stagingPath,
    reviewed_staging_sha256: reviewedStagingSha256,
    decision_artifact_path: decisionPath,
    decision_artifact_sha256: sha256Bytes(decisionBytes),
    timing_input_path: timingPath,
    timing_input_sha256: sha256Bytes(timingBytes),
    editorial_input_path: path.resolve(args.editorial),
    editorial_input_sha256: sha256Bytes(Buffer.from(`${JSON.stringify(editorial, null, 2)}\n`, 'utf8')),
    provenance_artifact_path: artifactPath,
    provenance_artifact_sha256: editorial.provenance.sha256,
    note: 'Codex editorial pass completed from separately supplied decisions after all timing passes had stopped; no decision was generated by the recorder.',
  };
  await writeJson(sessionPath, completedSession);
  console.log(JSON.stringify({
    session_id: completedSession.session_id,
    editorial_input: path.resolve(args.editorial),
    decision_artifact: decisionPath,
    reviewed_staging_sha256: reviewedStagingSha256,
    timing_completed_at: timingCompletedAt,
    provenance_artifact: artifactPath,
  }, null, 2));
  return completedSession;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (!args.action || !['start', 'complete'].includes(args.action)) {
    throw new Error('--action=start or --action=complete is required');
  }
  if (!args.session || !args.proposal) throw new Error('--session and --proposal are required');
  if (args.action === 'start') return startSession(args);
  for (const option of ['staging', 'decisions', 'timing', 'editorial', 'canonical']) {
    if (!args[option]) throw new Error(`--${option} is required for complete`);
  }
  return completeSession(args);
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
