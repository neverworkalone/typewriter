import { access, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  A2_BATCH_ID,
  validateA2AuditDecisionArtifact,
  validateA2AuditInput,
  validateA2EditorialInput,
  validateA2ProvenanceArtifact,
  validateA2TimingInput,
  sha256Bytes,
  sha256ProvenanceSubject,
} from './validate-m5-10a-wave-a2-inputs.mjs';
import { assertExternalStagingPath } from './validate-batch.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const AUDIT_RECORDER_VERSION = 'wave-a2-audit-recorder-v2';
const A2_DATE = A2_BATCH_ID.slice(-8);
const DEFAULT_PROVENANCE_ARTIFACT = `data/batches/m5-10a-wave-a2-provenance-audit-${A2_DATE}.json`;

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
    throw new Error(`refusing to overwrite an existing audit session: ${sessionPath}`);
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

function assertCompleteTiming(timing) {
  validateA2TimingInput(timing);
  if (timing.status !== 'complete') throw new Error('audit completion requires complete A2 timing');
  for (let index = 1; index < timing.passes.length; index += 1) {
    const previous = timing.passes[index - 1];
    const current = timing.passes[index];
    if (Date.parse(current.started_at) < Date.parse(previous.completed_at)) {
      throw new Error('audit timing passes overlap or are out of order');
    }
  }
  return timing.passes.at(-1).completed_at;
}

async function readAndValidateEditorial(args) {
  const editorialPath = path.resolve(args.editorial);
  const stagingPath = path.resolve(args.staging);
  assertExternalStagingPath(stagingPath);
  const [editorial, stagingBytes, canonical, staged] = await Promise.all([
    readJson(editorialPath, 'editorial input'),
    readBytes(stagingPath, 'reviewed staging'),
    readCanonicalRecords(path.resolve(args.canonical)),
    readCanonicalRecords(stagingPath),
  ]);
  validateA2EditorialInput({
    input: editorial,
    canonicalRecords: [...canonical.records, ...staged.records],
  });
  if (editorial.source_kind !== 'codex-authored' || editorial.status !== 'complete') {
    throw new Error('audit requires a completed Codex editorial input');
  }
  const stagingSha256 = sha256Bytes(stagingBytes);
  if (editorial.reviewed_staging_sha256 !== stagingSha256) {
    throw new Error('audit staging digest does not match the editorial freeze');
  }
  return {
    editorial,
    editorialPath,
    editorialBytes: Buffer.from(`${JSON.stringify(editorial, null, 2)}\n`, 'utf8'),
    stagingPath,
    stagingSha256,
    canonicalRecords: [...canonical.records, ...staged.records],
  };
}

async function startSession(args) {
  const {
    editorial,
    editorialPath,
    editorialBytes,
    stagingPath,
    stagingSha256,
  } = await readAndValidateEditorial(args);
  const timingPath = path.resolve(args.timing ?? editorial.timing_artifact.path);
  const timingBytes = await readBytes(timingPath, 'A2 timing input');
  const timing = JSON.parse(timingBytes.toString('utf8'));
  const timingCompletedAt = assertCompleteTiming(timing);
  if (editorial.timing_artifact.path !== repositoryRelativePath(timingPath, 'timing artifact')
    || editorial.timing_artifact.sha256 !== sha256Bytes(timingBytes)
    || editorial.timing_artifact.completed_at !== timingCompletedAt) {
    throw new Error('audit timing input does not match the editorial timing binding');
  }
  if (Date.parse(timingCompletedAt) > Date.parse(editorial.completed_at)) {
    throw new Error('audit cannot start before the editorial timing passes have stopped');
  }
  const decisionsPath = path.resolve(args.decisions);
  try {
    await access(decisionsPath);
    throw new Error(`audit decision artifact must be supplied after audit start: ${decisionsPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const sessionPath = path.resolve(args.session);
  await assertNewSession(sessionPath);
  const session = {
    schema_version: '1',
    recorder_version: AUDIT_RECORDER_VERSION,
    status: 'in-progress',
    session_id: randomUUID(),
    actor_kind: editorial.provenance.actor_kind,
    actor_id: editorial.provenance.actor_id,
    started_at: new Date().toISOString(),
    editorial_input_path: editorialPath,
    editorial_input_sha256: sha256Bytes(editorialBytes),
    reviewed_staging_path: stagingPath,
    reviewed_staging_sha256: stagingSha256,
    timing_input_path: timingPath,
    timing_input_sha256: sha256Bytes(timingBytes),
    timing_completed_at: timingCompletedAt,
    audit_decisions_path: decisionsPath,
    note: 'Separate audit session started; completion requires a separately supplied audit decision artifact over the frozen editorial result.',
  };
  await writeJson(sessionPath, session);
  console.log(`Started separate Codex Wave A2 audit session ${session.session_id}.`);
  return session;
}

async function completeSession(args) {
  const sessionPath = path.resolve(args.session);
  const session = await readJson(sessionPath, 'audit session');
  if (session.recorder_version !== AUDIT_RECORDER_VERSION || session.status !== 'in-progress') {
    throw new Error('audit session must be an in-progress v2 recorder session');
  }
  const editorialPath = path.resolve(args.editorial);
  const editorialBytes = await readBytes(editorialPath, 'editorial input');
  if (sha256Bytes(editorialBytes) !== session.editorial_input_sha256) {
    throw new Error('editorial input changed during the audit session');
  }
  const editorial = JSON.parse(editorialBytes.toString('utf8'));
  const stagingBytes = await readBytes(session.reviewed_staging_path, 'reviewed staging');
  if (sha256Bytes(stagingBytes) !== session.reviewed_staging_sha256) {
    throw new Error('frozen reviewed staging changed during audit');
  }
  const timingBytes = await readBytes(session.timing_input_path, 'A2 timing input');
  if (sha256Bytes(timingBytes) !== session.timing_input_sha256) {
    throw new Error('timing input changed during the audit session');
  }
  const timing = JSON.parse(timingBytes.toString('utf8'));
  const timingCompletedAt = assertCompleteTiming(timing);
  if (timingCompletedAt !== session.timing_completed_at) throw new Error('timing completion changed during the audit session');

  const decisionsPath = path.resolve(args.decisions ?? session.audit_decisions_path);
  if (decisionsPath !== session.audit_decisions_path) throw new Error('audit decision artifact path changed during the audit session');
  const decisionBytes = await readBytes(decisionsPath, 'audit decision artifact');
  const decisionArtifact = validateA2AuditDecisionArtifact(JSON.parse(decisionBytes.toString('utf8')));
  const completedAt = new Date().toISOString();
  if (decisionArtifact.session_id !== session.session_id) {
    throw new Error('audit decision artifact must bind the active audit session');
  }
  if (decisionArtifact.actor_kind !== session.actor_kind || decisionArtifact.actor_id !== session.actor_id) {
    throw new Error('audit decision artifact actor does not match the active audit session');
  }
  if (decisionArtifact.editorial_input_id !== editorial.input_id) {
    throw new Error('audit decision artifact must bind the completed editorial input');
  }
  if (decisionArtifact.reviewed_staging_sha256 !== session.reviewed_staging_sha256) {
    throw new Error('audit decision artifact reviewed staging digest does not match the frozen staging');
  }
  if (Date.parse(decisionArtifact.created_at) < Date.parse(session.started_at)
    || Date.parse(decisionArtifact.created_at) > Date.parse(completedAt)) {
    throw new Error('audit decisions must be supplied during the active audit session');
  }
  if (Date.parse(editorial.completed_at) > Date.parse(session.started_at)) {
    throw new Error('audit session must start after editorial completion');
  }
  if (Date.parse(timingCompletedAt) > Date.parse(session.started_at)) {
    throw new Error('audit session must start after the required timing passes stopped');
  }

  const canonical = await readCanonicalRecords(path.resolve(args.canonical));
  const staged = await readCanonicalRecords(session.reviewed_staging_path);
  const provenanceArtifact = args.provenance
    ? repositoryRelativePath(args.provenance, 'audit provenance artifact')
    : DEFAULT_PROVENANCE_ARTIFACT;
  const independent = session.session_id !== editorial.provenance.session_id
    && provenanceArtifact !== editorial.provenance.artifact;
  if (!independent) throw new Error('audit recorder requires a distinct session and provenance artifact');
  const audit = {
    schema_version: '2',
    audit_id: `m5-10a-wave-a2-audit-${A2_DATE}`,
    batch_id: editorial.batch_id,
    source_kind: session.actor_kind === 'codex' ? 'codex-authored' : 'human-authored',
    provenance: {
      verification_status: 'verified',
      actor_kind: session.actor_kind,
      actor_id: session.actor_id,
      session_id: session.session_id,
      artifact: provenanceArtifact,
      sha256: null,
      note: 'Audit output is derived from the separately supplied audit decision artifact over the frozen editorial staging.',
    },
    editorial_input_id: editorial.input_id,
    auditor_id: session.actor_id,
    independent,
    created_at: session.started_at,
    completed_at: completedAt,
    reviewed_record_ids: structuredClone(decisionArtifact.reviewed_record_ids),
    relation_reviews: structuredClone(decisionArtifact.relation_reviews),
    timing_artifact: {
      path: repositoryRelativePath(session.timing_input_path, 'timing artifact'),
      sha256: session.timing_input_sha256,
      completed_at: timingCompletedAt,
    },
    decision_artifact: {
      path: repositoryRelativePath(decisionsPath, 'audit decision artifact'),
      sha256: sha256Bytes(decisionBytes),
      created_at: decisionArtifact.created_at,
    },
    reviewed_staging_sha256: session.reviewed_staging_sha256,
    status: 'complete',
    findings: structuredClone(decisionArtifact.findings),
    note: decisionArtifact.note,
  };
  const artifactPath = path.resolve(REPOSITORY_DIRECTORY, audit.provenance.artifact);
  const artifact = {
    schema_version: '1',
    artifact_id: `m5-10a-wave-a2-provenance-audit-${A2_DATE}`,
    subject_kind: 'audit',
    subject_id: audit.audit_id,
    subject_sha256: sha256ProvenanceSubject(audit),
    session_id: audit.provenance.session_id,
    actor_kind: audit.provenance.actor_kind,
    actor_id: audit.provenance.actor_id,
    started_at: session.started_at,
    completed_at: completedAt,
  };
  const artifactBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  audit.provenance.sha256 = sha256Bytes(artifactBytes);
  validateA2AuditInput({
    audit,
    editorialInput: { ...editorial, verified: true },
    relationDiff: await readJson(path.resolve(args.relation), 'relation diff'),
    canonicalRecords: [...canonical.records, ...staged.records],
  });
  await writeFile(artifactPath, artifactBytes, 'utf8');
  await writeJson(path.resolve(args.audit), audit);
  await validateA2ProvenanceArtifact({
    input: audit,
    repositoryDirectory: REPOSITORY_DIRECTORY,
    subjectKind: 'audit',
  });
  const completedSession = {
    ...session,
    status: 'complete',
    completed_at: completedAt,
    audit_input_path: path.resolve(args.audit),
    audit_input_sha256: sha256Bytes(Buffer.from(`${JSON.stringify(audit, null, 2)}\n`, 'utf8')),
    decision_artifact_sha256: sha256Bytes(decisionBytes),
    provenance_artifact_path: artifactPath,
    provenance_artifact_sha256: audit.provenance.sha256,
    note: 'Separate Codex audit completed from the supplied audit decisions after rechecking the frozen staging, relation set, and editorial timing result; no audit finding was generated by the recorder.',
  };
  await writeJson(sessionPath, completedSession);
  console.log(JSON.stringify({
    session_id: completedSession.session_id,
    audit_input: path.resolve(args.audit),
    decision_artifact: decisionsPath,
    provenance_artifact: artifactPath,
    reviewed_staging_sha256: audit.reviewed_staging_sha256,
  }, null, 2));
  return completedSession;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (!args.action || !['start', 'complete'].includes(args.action)) {
    throw new Error('--action=start or --action=complete is required');
  }
  for (const option of ['session', 'editorial', 'staging', 'timing', 'decisions']) {
    if (!args[option]) throw new Error(`--${option} is required`);
  }
  if (args.action === 'start') return startSession(args);
  for (const option of ['audit', 'relation', 'canonical']) {
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
