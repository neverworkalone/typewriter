import { access, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_AUDIT_INPUT_PATH,
  DEFAULT_AUDIT_TIMING_INPUT_PATH,
  DEFAULT_EDITORIAL_INPUT_PATH,
  DEFAULT_INVENTORY_PATH,
  DEFAULT_RELATION_DIFF_PATH,
  DEFAULT_TIMING_INPUT_PATH,
  REPOSITORY_DIRECTORY,
  WAVE_B_BATCH_ID,
  validateWaveBAuditDecisionArtifact,
  validateWaveBAuditInput,
  validateWaveBEditorialInput,
  validateWaveBProvenanceArtifact,
  validateWaveBTimingInput,
} from './validate-m5-10-wave-b.mjs';
import { assertExternalStagingPath } from './validate-batch.mjs';
import { DEFAULT_CANONICAL_DIRECTORY, readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SESSION_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-10-wave-b-audit-session.json');
const DEFAULT_DECISION_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-10-wave-b-audit-decisions-20260909.json');
const DEFAULT_PROVENANCE_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-10-wave-b-provenance-audit-20260909.json');
const RECORDER_VERSION = 'wave-b-audit-recorder-v1';
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

async function readEditorial(args) {
  const editorialPath = path.resolve(args.editorial ?? DEFAULT_EDITORIAL_INPUT_PATH);
  const stagingPath = path.resolve(args.staging);
  assertExternalStagingPath(stagingPath);
  const relationPath = path.resolve(args.relation ?? DEFAULT_RELATION_DIFF_PATH);
  const [editorialBytes, stagingBytes, editorial, canonical, staged, inventory, timingBytes, timing, relationBytes] = await Promise.all([
    readBytes(editorialPath, 'Wave B editorial input'),
    readBytes(stagingPath, 'Wave B reviewed staging'),
    readJson(editorialPath, 'Wave B editorial input'),
    readCanonicalRecords(path.resolve(args.canonical ?? DEFAULT_CANONICAL_DIRECTORY)),
    readCanonicalRecords(stagingPath),
    readJson(path.resolve(args.inventory ?? DEFAULT_INVENTORY_PATH), 'Wave B preimport inventory'),
    readBytes(path.resolve(args.timing ?? DEFAULT_TIMING_INPUT_PATH), 'Wave B editorial timing input'),
    readJson(path.resolve(args.timing ?? DEFAULT_TIMING_INPUT_PATH), 'Wave B editorial timing input'),
    readBytes(relationPath, 'Wave B relation diff'),
  ]);
  validateWaveBEditorialInput({ input: editorial, inventoryEntries: inventory.entries, referenceRecords: [...canonical.records, ...staged.records] });
  const stagingSha256 = sha256Bytes(stagingBytes);
  if (editorial.reviewed_staging_sha256 !== stagingSha256) throw new Error('audit staging digest does not match the editorial freeze');
  validateWaveBTimingInput(timing, { timingKind: 'editorial', reviewedStagingSha256: stagingSha256 });
  if (editorial.timing_artifact.path !== repositoryRelativePath(path.resolve(args.timing ?? DEFAULT_TIMING_INPUT_PATH), 'editorial timing artifact')
    || editorial.timing_artifact.sha256 !== sha256Bytes(timingBytes)
    || editorial.timing_artifact.started_at !== timing.passes[0].started_at
    || editorial.timing_artifact.completed_at !== timing.passes.at(-1).completed_at) {
    throw new Error('audit timing input does not match the editorial timing binding');
  }
  return {
    editorial,
    editorialPath,
    editorialBytes,
    stagingPath,
    stagingBytes,
    stagingSha256,
    canonicalRecords: [...canonical.records, ...staged.records],
    timing,
    timingBytes,
    relationPath,
    relationBytes,
  };
}

async function startSession(args) {
  const {
    editorial,
    editorialPath,
    editorialBytes,
    stagingPath,
    stagingSha256,
    timing,
    timingBytes,
    relationPath,
    relationBytes,
  } = await readEditorial(args);
  if (Date.parse(editorial.completed_at) > Date.now()) throw new Error('editorial input completion timestamp is in the future');
  const auditTimingPath = path.resolve(args['audit-timing'] ?? DEFAULT_AUDIT_TIMING_INPUT_PATH);
  const decisionPath = path.resolve(args.decisions ?? DEFAULT_DECISION_PATH);
  const sessionPath = path.resolve(args.session ?? DEFAULT_SESSION_PATH);
  await assertNewFile(auditTimingPath, 'audit timing artifact');
  await assertNewFile(decisionPath, 'audit decision artifact');
  await assertNewFile(sessionPath, 'audit session');
  repositoryRelativePath(auditTimingPath, 'audit timing artifact');
  repositoryRelativePath(decisionPath, 'audit decision artifact');
  const startedAt = await timestampAfter(editorial.completed_at);
  const session = {
    schema_version: '1',
    recorder_version: RECORDER_VERSION,
    status: 'in-progress',
    session_id: randomUUID(),
    actor_kind: 'codex',
    actor_id: 'codex-wave-b-independent-audit',
    started_at: startedAt,
    editorial_input_path: editorialPath,
    editorial_input_sha256: sha256Bytes(editorialBytes),
    reviewed_staging_path: stagingPath,
    reviewed_staging_sha256: stagingSha256,
    timing_input_path: path.resolve(args.timing ?? DEFAULT_TIMING_INPUT_PATH),
    timing_input_sha256: sha256Bytes(timingBytes),
    timing_completed_at: timing.passes.at(-1).completed_at,
    relation_diff_path: relationPath,
    relation_diff_sha256: sha256Bytes(relationBytes),
    audit_timing_input_path: auditTimingPath,
    audit_decisions_path: decisionPath,
    note: 'Wave B independent audit session started after editorial completion; completion requires a separately measured post-freeze pass and supplied audit decisions.',
  };
  await writeJson(sessionPath, session);
  console.log(`Started Wave B independent audit session ${session.session_id}.`);
  return session;
}

async function completeSession(args) {
  const sessionPath = path.resolve(args.session ?? DEFAULT_SESSION_PATH);
  const session = await readJson(sessionPath, 'Wave B audit session');
  if (session.recorder_version !== RECORDER_VERSION || session.status !== 'in-progress') {
    throw new Error('audit session must be an in-progress Wave B recorder session');
  }
  if (!UUID_PATTERN.test(session.session_id)) throw new Error('audit session_id must be a UUID v4');

  const editorialPath = path.resolve(args.editorial ?? DEFAULT_EDITORIAL_INPUT_PATH);
  const editorialBytes = await readBytes(editorialPath, 'Wave B editorial input');
  if (sha256Bytes(editorialBytes) !== session.editorial_input_sha256) throw new Error('editorial input changed during the audit session');
  const editorial = JSON.parse(editorialBytes.toString('utf8'));
  const stagingBytes = await readBytes(session.reviewed_staging_path, 'Wave B reviewed staging');
  if (sha256Bytes(stagingBytes) !== session.reviewed_staging_sha256) throw new Error('frozen reviewed staging changed during the audit');
  const timingBytes = await readBytes(session.timing_input_path, 'Wave B editorial timing input');
  if (sha256Bytes(timingBytes) !== session.timing_input_sha256) throw new Error('editorial timing input changed during the audit session');
  const timing = JSON.parse(timingBytes.toString('utf8'));
  validateWaveBTimingInput(timing, { timingKind: 'editorial', reviewedStagingSha256: session.reviewed_staging_sha256 });
  if (timing.passes.at(-1).completed_at !== session.timing_completed_at) throw new Error('editorial timing completion changed during the audit session');

  const auditTimingPath = path.resolve(args['audit-timing'] ?? session.audit_timing_input_path);
  if (auditTimingPath !== path.resolve(session.audit_timing_input_path)) throw new Error('audit timing artifact path changed during the audit session');
  const auditTimingBytes = await readBytes(auditTimingPath, 'Wave B post-freeze audit timing input');
  const auditTiming = JSON.parse(auditTimingBytes.toString('utf8'));
  validateWaveBTimingInput(auditTiming, {
    timingKind: 'post-freeze-audit',
    reviewedStagingSha256: session.reviewed_staging_sha256,
    auditSessionId: session.session_id,
  });
  if (Date.parse(auditTiming.passes[0].started_at) <= Date.parse(editorial.completed_at)) throw new Error('post-freeze audit timing must start after editorial completion');
  if (Date.parse(auditTiming.passes[0].started_at) < Date.parse(session.started_at)) throw new Error('post-freeze audit timing must start after the audit session');

  const relationPath = path.resolve(args.relation ?? DEFAULT_RELATION_DIFF_PATH);
  if (relationPath !== path.resolve(session.relation_diff_path)) throw new Error('relation diff path changed during the audit session');
  const relationBytes = await readBytes(relationPath, 'Wave B relation diff');
  if (sha256Bytes(relationBytes) !== session.relation_diff_sha256) throw new Error('relation diff changed during the audit session');
  const relationDiff = JSON.parse(relationBytes.toString('utf8'));

  const decisionPath = path.resolve(args.decisions ?? session.audit_decisions_path);
  if (decisionPath !== path.resolve(session.audit_decisions_path)) throw new Error('audit decision artifact path changed during the audit session');
  const decisionBytes = await readBytes(decisionPath, 'Wave B audit decision artifact');
  const decisionArtifact = validateWaveBAuditDecisionArtifact(JSON.parse(decisionBytes.toString('utf8')));
  if (decisionArtifact.session_id !== session.session_id) throw new Error('audit decision artifact must bind the active audit session');
  if (decisionArtifact.actor_kind !== session.actor_kind || decisionArtifact.actor_id !== session.actor_id) throw new Error('audit decision artifact actor does not match the active audit session');
  if (decisionArtifact.editorial_input_id !== editorial.input_id) throw new Error('audit decision artifact must bind the completed editorial input');
  if (decisionArtifact.reviewed_staging_sha256 !== session.reviewed_staging_sha256) throw new Error('audit decision artifact staging digest does not match the frozen staging');
  if (Date.parse(decisionArtifact.created_at) < Date.parse(session.started_at)
    || Date.parse(decisionArtifact.finalized_at) <= Date.parse(auditTiming.passes.at(-1).completed_at)) {
    throw new Error('audit decisions must be supplied and finalized after the post-freeze timing pass');
  }
  const completedAt = await timestampAfter(decisionArtifact.finalized_at);

  const auditPath = path.resolve(args.audit ?? DEFAULT_AUDIT_INPUT_PATH);
  const provenancePath = path.resolve(args.provenance ?? DEFAULT_PROVENANCE_PATH);
  const audit = {
    schema_version: '2',
    audit_id: 'm5-10-wave-b-audit-20260909',
    batch_id: WAVE_B_BATCH_ID,
    source_kind: 'codex-authored',
    provenance: {
      verification_status: 'verified',
      actor_kind: session.actor_kind,
      actor_id: session.actor_id,
      session_id: session.session_id,
      artifact: repositoryRelativePath(provenancePath, 'audit provenance artifact'),
      sha256: null,
      note: 'Wave B audit output is recorded from the separately supplied audit decision artifact over the frozen editorial staging.',
    },
    editorial_input_id: editorial.input_id,
    auditor_id: session.actor_id,
    independent: true,
    created_at: session.started_at,
    completed_at: completedAt,
    reviewed_record_ids: structuredClone(decisionArtifact.reviewed_record_ids),
    reviewed_buffer_inventory_ids: structuredClone(decisionArtifact.reviewed_buffer_inventory_ids),
    relation_reviews: structuredClone(decisionArtifact.relation_reviews),
    editorial_timing_artifact: {
      path: repositoryRelativePath(session.timing_input_path, 'editorial timing artifact'),
      sha256: session.timing_input_sha256,
      started_at: timing.passes[0].started_at,
      completed_at: timing.passes.at(-1).completed_at,
    },
    timing_artifact: {
      path: repositoryRelativePath(auditTimingPath, 'audit timing artifact'),
      sha256: sha256Bytes(auditTimingBytes),
      started_at: auditTiming.passes[0].started_at,
      completed_at: auditTiming.passes.at(-1).completed_at,
      audit_session_id: session.session_id,
      reviewed_staging_sha256: session.reviewed_staging_sha256,
    },
    decision_artifact: {
      path: repositoryRelativePath(decisionPath, 'audit decision artifact'),
      sha256: sha256Bytes(decisionBytes),
      created_at: decisionArtifact.created_at,
      finalized_at: decisionArtifact.finalized_at,
    },
    reviewed_staging_sha256: session.reviewed_staging_sha256,
    status: 'complete',
    findings: structuredClone(decisionArtifact.findings),
    note: decisionArtifact.note,
  };
  const provenance = {
    schema_version: '1',
    artifact_id: 'm5-10-wave-b-provenance-audit-20260909',
    subject_kind: 'audit',
    subject_id: audit.audit_id,
    subject_sha256: sha256ProvenanceSubject(audit),
    session_id: audit.provenance.session_id,
    actor_kind: audit.provenance.actor_kind,
    actor_id: audit.provenance.actor_id,
    started_at: audit.created_at,
    completed_at: audit.completed_at,
  };
  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  audit.provenance.sha256 = sha256Bytes(provenanceBytes);
  validateWaveBAuditInput({ audit, editorialInput: editorial, relationDiff });
  await writeFile(provenancePath, provenanceBytes, 'utf8');
  await writeJson(auditPath, audit);
  await validateWaveBProvenanceArtifact({ input: audit, subjectKind: 'audit' });
  const auditBytes = await readBytes(auditPath, 'Wave B audit input');
  const completedSession = {
    ...session,
    status: 'complete',
    completed_at: completedAt,
    audit_input_path: auditPath,
    audit_input_sha256: sha256Bytes(auditBytes),
    audit_timing_input_sha256: sha256Bytes(auditTimingBytes),
    audit_timing_completed_at: auditTiming.passes.at(-1).completed_at,
    decision_artifact_sha256: sha256Bytes(decisionBytes),
    provenance_artifact_path: provenancePath,
    provenance_artifact_sha256: audit.provenance.sha256,
    note: 'Wave B independent audit completed from supplied findings after the measured post-freeze pass; no audit finding was generated by the recorder.',
  };
  await writeJson(sessionPath, completedSession);
  console.log(JSON.stringify({
    session_id: completedSession.session_id,
    audit_input: repositoryRelativePath(auditPath, 'audit input'),
    decision_artifact: repositoryRelativePath(decisionPath, 'audit decision artifact'),
    provenance_artifact: repositoryRelativePath(provenancePath, 'audit provenance artifact'),
    reviewed_staging_sha256: audit.reviewed_staging_sha256,
  }, null, 2));
  return completedSession;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (!args.action || !['start', 'complete'].includes(args.action)) throw new Error('--action=start or --action=complete is required');
  const required = args.action === 'start'
    ? ['session', 'editorial', 'staging', 'timing', 'audit-timing', 'decisions', 'canonical']
    : ['session', 'editorial', 'staging', 'timing', 'audit-timing', 'decisions', 'audit', 'relation', 'canonical'];
  for (const option of required) if (!args[option]) throw new Error(`--${option} is required for ${args.action}`);
  if (args.action === 'start') return startSession(args);
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
