import { access, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_EDITORIAL_INPUT_PATH,
  DEFAULT_INVENTORY_PATH,
  DEFAULT_TIMING_INPUT_PATH,
  REPOSITORY_DIRECTORY,
  WAVE_B_BATCH_ID,
  WAVE_B_IMPORTED_START_COUNT,
  WAVE_B_INVENTORY_ID,
  WAVE_B_INVENTORY_REVISION,
  WAVE_B_IMPORTED_CANONICAL_IDS,
  validateWaveBEditorialDecisionArtifact,
  validateWaveBEditorialInput,
  validateWaveBProvenanceArtifact,
  validateWaveBTimingDecisionWork,
  validateWaveBTimingInput,
} from './validate-m5-10-wave-b.mjs';
import { assertExternalStagingPath } from './validate-batch.mjs';
import { DEFAULT_CANONICAL_DIRECTORY, readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const DEFAULT_PROPOSAL_PATH = '/private/tmp/typewriter-m5-10-wave-b-proposal.jsonl';
const DEFAULT_SESSION_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-10-wave-b-editorial-session.json');
const DEFAULT_DECISION_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-10-wave-b-editorial-decisions-20260909.json');
const DEFAULT_PROVENANCE_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-10-wave-b-provenance-editorial-20260909.json');
const RECORDER_VERSION = 'wave-b-editorial-recorder-v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256ProvenanceSubject(input) {
  const subject = structuredClone(input);
  subject.provenance.sha256 = null;
  return sha256Bytes(Buffer.from(JSON.stringify(subject), 'utf8'));
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

async function assertNewFile(filePath, label) {
  try {
    await access(filePath);
    throw new Error(`refusing to overwrite an existing ${label}: ${filePath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function repositoryRelativePath(filePath, label) {
  const relative = path.relative(REPOSITORY_DIRECTORY, path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the repository: ${filePath}`);
  }
  return relative;
}

function timestampAfter(timestamp) {
  const threshold = Date.parse(timestamp);
  return new Promise((resolve) => {
    const poll = () => {
      const candidate = new Date().toISOString();
      if (Date.parse(candidate) > threshold) {
        resolve(candidate);
        return;
      }
      setTimeout(poll, 1);
    };
    poll();
  });
}

function recordMap(recordInfos) {
  return new Map(recordInfos.map((recordInfo) => {
    const record = recordInfo.record ?? recordInfo;
    return [record.id, record];
  }));
}

async function startSession(args) {
  const proposalPath = path.resolve(args.proposal ?? DEFAULT_PROPOSAL_PATH);
  assertExternalStagingPath(proposalPath);
  const proposalBytes = await readBytes(proposalPath, 'Wave B proposal');
  const sessionPath = path.resolve(args.session ?? DEFAULT_SESSION_PATH);
  await assertNewFile(sessionPath, 'editorial session');
  const session = {
    schema_version: '1',
    recorder_version: RECORDER_VERSION,
    status: 'in-progress',
    session_id: randomUUID(),
    actor_kind: 'codex',
    actor_id: 'codex-wave-b-editorial',
    started_at: new Date().toISOString(),
    proposal_path: proposalPath,
    proposal_sha256: sha256Bytes(proposalBytes),
    note: 'Wave B editorial session started; completion requires separately supplied decisions, frozen staging, and stopped timing passes.',
  };
  await writeJson(sessionPath, session);
  console.log(`Started Wave B editorial session ${session.session_id}.`);
  return session;
}

async function completeSession(args) {
  const sessionPath = path.resolve(args.session ?? DEFAULT_SESSION_PATH);
  const session = await readJson(sessionPath, 'Wave B editorial session');
  if (session.recorder_version !== RECORDER_VERSION || session.status !== 'in-progress') {
    throw new Error('editorial session must be an in-progress Wave B recorder session');
  }
  if (!UUID_PATTERN.test(session.session_id)) throw new Error('editorial session_id must be a UUID v4');

  const proposalBytes = await readBytes(session.proposal_path, 'Wave B proposal');
  if (sha256Bytes(proposalBytes) !== session.proposal_sha256 || !SHA256_PATTERN.test(session.proposal_sha256)) {
    throw new Error('Wave B proposal digest changed during the editorial session');
  }

  const stagingPath = path.resolve(args.staging);
  assertExternalStagingPath(stagingPath);
  const stagingBytes = await readBytes(stagingPath, 'Wave B reviewed staging');
  const reviewedStagingSha256 = sha256Bytes(stagingBytes);
  const staged = await readCanonicalRecords(stagingPath);
  const stagedIds = staged.records.map(({ record }) => record.id);
  if (stagedIds.length !== WAVE_B_IMPORTED_START_COUNT
    || JSON.stringify(stagedIds) !== JSON.stringify(WAVE_B_IMPORTED_CANONICAL_IDS)) {
    throw new Error('Wave B reviewed staging must contain exactly the 150 imported canonical records in order');
  }

  const decisionPath = path.resolve(args.decisions ?? DEFAULT_DECISION_PATH);
  const decisionBytes = await readBytes(decisionPath, 'Wave B editorial decision artifact');
  const decisionArtifact = validateWaveBEditorialDecisionArtifact(JSON.parse(decisionBytes.toString('utf8')));
  if (decisionArtifact.session_id !== session.session_id) throw new Error('editorial decision artifact must bind the active editorial session');
  if (decisionArtifact.actor_kind !== session.actor_kind || decisionArtifact.actor_id !== session.actor_id) {
    throw new Error('editorial decision artifact actor does not match the active editorial session');
  }
  if (decisionArtifact.proposal_staging_sha256 !== session.proposal_sha256) throw new Error('editorial decision proposal digest does not match the session');
  if (decisionArtifact.reviewed_staging_sha256 !== reviewedStagingSha256) throw new Error('editorial decision staging digest does not match the frozen staging');

  const timingPath = path.resolve(args.timing ?? DEFAULT_TIMING_INPUT_PATH);
  const timingBytes = await readBytes(timingPath, 'Wave B editorial timing input');
  const timing = JSON.parse(timingBytes.toString('utf8'));
  validateWaveBTimingInput(timing, { timingKind: 'editorial', reviewedStagingSha256 });
  const timingStartedAt = timing.passes[0].started_at;
  const timingCompletedAt = timing.passes.at(-1).completed_at;
  if (Date.parse(session.started_at) > Date.parse(timingStartedAt)) throw new Error('editorial session must start before the first timing pass');
  if (Date.parse(decisionArtifact.created_at) < Date.parse(session.started_at)) throw new Error('editorial decision was supplied before the session started');
  if (Date.parse(decisionArtifact.finalized_at) > Date.parse(timingStartedAt)) throw new Error('editorial decisions must be finalized before the timed work pass begins');
  const completedAt = await timestampAfter(decisionArtifact.finalized_at);

  const editorialPath = path.resolve(args.editorial ?? DEFAULT_EDITORIAL_INPUT_PATH);
  const provenancePath = path.resolve(args.provenance ?? DEFAULT_PROVENANCE_PATH);
  const editorialArtifactPath = repositoryRelativePath(editorialPath, 'editorial input');
  const provenanceArtifactPath = repositoryRelativePath(provenancePath, 'editorial provenance artifact');
  const canonical = await readCanonicalRecords(path.resolve(args.canonical ?? DEFAULT_CANONICAL_DIRECTORY));
  const inventory = await readJson(path.resolve(args.inventory ?? DEFAULT_INVENTORY_PATH), 'Wave B preimport inventory');
  const reviewedRecords = decisionArtifact.records.slice(0, WAVE_B_IMPORTED_START_COUNT);
  const splitCanonicalIds = reviewedRecords
    .filter(({ observed_sense_count: senseCount }) => senseCount > 1)
    .map(({ canonical_id: canonicalId }) => canonicalId);
  const scopedSingleSenseCount = reviewedRecords.filter(({ observed_sense_count: senseCount }) => senseCount === 1).length;
  const editorial = {
    schema_version: '2',
    input_id: 'm5-10-wave-b-editorial-input-20260909',
    batch_id: WAVE_B_BATCH_ID,
    inventory_id: WAVE_B_INVENTORY_ID,
    inventory_revision: WAVE_B_INVENTORY_REVISION,
    source_kind: 'codex-authored',
    status: 'complete',
    created_at: session.started_at,
    completed_at: completedAt,
    provenance: {
      verification_status: 'verified',
      actor_kind: session.actor_kind,
      actor_id: session.actor_id,
      session_id: session.session_id,
      artifact: provenanceArtifactPath,
      sha256: null,
      note: 'Wave B editorial output is recorded from the separately supplied decision artifact and frozen staging bytes.',
    },
    sense_review: {
      status: 'complete',
      boundary_ids: ['physical-figurative', 'homonym-pos', 'sensory-emotion-state-action', 'directional-symmetry', 'compound-spaced-phrase', 'word-idiom'],
      reviewed_start_count: WAVE_B_IMPORTED_START_COUNT,
      scoped_single_sense_count: scopedSingleSenseCount,
      split_record_count: splitCanonicalIds.length,
      split_canonical_ids: splitCanonicalIds,
      note: 'All 150 imported starts are covered by record-level sense/POS and boundary decisions; six known homonym/polysemy regressions are split and held/deferred buffer rows remain outside the completed sense-review scope.',
    },
    proposal_staging: {
      format: 'canonical-jsonl',
      sha256: session.proposal_sha256,
      record_count: decisionArtifact.records.length,
      note: 'The external proposal is retained only as a digest-bound input boundary; raw proposal bytes are not committed.',
    },
    timing_artifact: {
      path: repositoryRelativePath(timingPath, 'editorial timing artifact'),
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
  validateWaveBTimingDecisionWork({ timingInput: timing, editorialInput: { records: editorial.records } });
  const provenance = {
    schema_version: '1',
    artifact_id: 'm5-10-wave-b-provenance-editorial-20260909',
    subject_kind: 'editorial',
    subject_id: editorial.input_id,
    subject_sha256: sha256ProvenanceSubject(editorial),
    session_id: editorial.provenance.session_id,
    actor_kind: editorial.provenance.actor_kind,
    actor_id: editorial.provenance.actor_id,
    started_at: editorial.created_at,
    completed_at: editorial.completed_at,
  };
  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  editorial.provenance.sha256 = sha256Bytes(provenanceBytes);
  validateWaveBEditorialInput({
    input: editorial,
    inventoryEntries: inventory.entries,
    referenceRecords: [...canonical.records, ...staged.records],
  });
  await writeFile(provenancePath, provenanceBytes, 'utf8');
  await writeJson(editorialPath, editorial);
  await validateWaveBProvenanceArtifact({ input: editorial, subjectKind: 'editorial' });
  const editorialBytes = await readBytes(editorialPath, 'Wave B editorial input');
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
    editorial_input_path: editorialPath,
    editorial_input_sha256: sha256Bytes(editorialBytes),
    provenance_artifact_path: provenancePath,
    provenance_artifact_sha256: editorial.provenance.sha256,
    note: 'Wave B editorial pass completed from decisions prepared after session start and bound to recorder-created record-level work rows inside the timed passes.',
  };
  await writeJson(sessionPath, completedSession);
  console.log(JSON.stringify({
    session_id: completedSession.session_id,
    editorial_input: editorialArtifactPath,
    decision_artifact: repositoryRelativePath(decisionPath, 'editorial decision artifact'),
    provenance_artifact: provenanceArtifactPath,
    reviewed_staging_sha256: reviewedStagingSha256,
    timing_completed_at: timingCompletedAt,
  }, null, 2));
  return completedSession;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (!args.action || !['start', 'complete'].includes(args.action)) throw new Error('--action=start or --action=complete is required');
  if (args.action === 'start') {
    for (const option of ['session', 'proposal']) if (!args[option]) throw new Error(`--${option} is required for start`);
    return startSession(args);
  }
  for (const option of ['session', 'staging', 'decisions', 'timing', 'editorial', 'canonical', 'inventory']) {
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
