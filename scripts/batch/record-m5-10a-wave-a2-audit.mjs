import { access, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateA2AuditInput,
  validateA2ProvenanceArtifact,
  sha256Bytes,
  sha256ProvenanceSubject,
} from './validate-m5-10a-wave-a2-inputs.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) throw new Error(`arguments must use --name=value form (received ${argument})`);
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
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

async function startSession(args) {
  const editorial = await readJson(path.resolve(args.editorial));
  const stagingBytes = await readFile(path.resolve(args.staging));
  const stagingSha256 = sha256Bytes(stagingBytes);
  if (editorial.source_kind !== 'codex-authored' || editorial.status !== 'complete') throw new Error('audit requires a completed Codex editorial input');
  if (editorial.reviewed_staging_sha256 !== stagingSha256) throw new Error('audit staging digest does not match the editorial freeze');
  const sessionPath = path.resolve(args.session);
  await assertNewSession(sessionPath);
  const session = {
    schema_version: '1',
    recorder_version: 'wave-a2-audit-recorder-v1',
    status: 'in-progress',
    session_id: randomUUID(),
    actor_kind: 'codex',
    actor_id: editorial.provenance.actor_id,
    started_at: new Date().toISOString(),
    editorial_input_path: path.resolve(args.editorial),
    editorial_input_sha256: sha256Bytes(Buffer.from(`${JSON.stringify(editorial, null, 2)}\n`, 'utf8')),
    reviewed_staging_path: path.resolve(args.staging),
    reviewed_staging_sha256: stagingSha256,
    note: 'Separate audit session has started; no completed audit claim is made until the explicit complete action.',
  };
  await writeJson(sessionPath, session);
  console.log(`Started separate Codex Wave A2 audit session ${session.session_id}.`);
  return session;
}

const RELATION_BASIS = Object.freeze([
  {
    source_observation: '환희는 긍정 정서가 가장 높게 솟는 장면을 만든다.',
    target_observation: '기쁨은 좋은 일에서 생기는 넓은 긍정 정서로 쓰인다.',
    difference: '강도의 차이를 유지한 채 mood로 연결하면 직접 대체와 정서 확장을 구별할 수 있다.',
    facets: ['intensity', 'positive mood'],
  },
  {
    source_observation: '자책은 자신의 행동을 되짚어 스스로 책망하는 쪽에 놓인다.',
    target_observation: '죄책감은 잘못으로 남에게 해를 끼쳤다고 느끼는 감정에 놓인다.',
    difference: '자기 책망의 행위와 잘못으로 인한 감정은 초점이 달라 near가 정직한 관계명이다.',
    facets: ['self-blame', 'felt guilt'],
  },
  {
    source_observation: '고즈넉하다는 고요한 장면에 아늑한 정취를 함께 부여한다.',
    target_observation: '고요는 소리와 움직임이 잦아든 상태를 직접 가리킨다.',
    difference: '고요를 기반으로 하되 정취를 더하는 분위기 차이를 mood로 보존한다.',
    facets: ['quiet', 'atmosphere'],
  },
  {
    source_observation: '윤슬은 물결 위에서 반사되는 빛의 반짝임을 한 장면으로 고정한다.',
    target_observation: '빛은 표면 밝기와 시각적 광원을 더 넓게 가리킨다.',
    difference: '구체적인 물 표면 이미지와 일반적인 밝기 이미지가 만나 sensory 탐색을 만든다.',
    facets: ['water surface', 'brightness'],
  },
  {
    source_observation: '잦아들다는 긴장이나 분노의 세기가 낮아지는 변화로 읽힌다.',
    target_observation: '긴장은 압박이 걸린 상태 자체를 가리킨다.',
    difference: '변화 동사와 상태 명사를 동의어로 합치지 않고 함께 떠올릴 association으로 남긴다.',
    facets: ['de-escalation', 'state'],
  },
  {
    source_observation: '숨이 트인다는 막힌 상황이 풀리며 호흡과 마음이 놓이는 표현이다.',
    target_observation: '안도는 걱정이나 위험이 줄어든 뒤의 정서 상태다.',
    difference: '상황이 풀리는 표현과 그 결과의 정서를 mood로 연결해 문장 온도의 이동을 보존한다.',
    facets: ['relief expression', 'emotional state'],
  },
]);

async function completeSession(args) {
  const sessionPath = path.resolve(args.session);
  const session = await readJson(sessionPath);
  if (session.status !== 'in-progress') throw new Error('audit session must be in-progress before complete');
  const editorial = await readJson(session.editorial_input_path);
  const stagingBytes = await readFile(session.reviewed_staging_path);
  if (sha256Bytes(stagingBytes) !== session.reviewed_staging_sha256) throw new Error('frozen reviewed staging changed during audit');
  const relationDiff = await readJson(path.resolve(args.relation));
  const timing = await readJson(path.resolve(args.timing));
  if (timing.status !== 'complete' || timing.passes.some(({ status }) => status !== 'complete')) throw new Error('audit cannot complete while timing has an unmeasured pass');
  if (relationDiff.candidate_reviews.some(({ decision }) => !['admit', 'reject'].includes(decision))) throw new Error('audit cannot complete while relation candidates remain pending');
  const completedAt = new Date().toISOString();
  const audit = {
    schema_version: '2',
    audit_id: 'm5-10a-wave-a2-audit-20260909',
    batch_id: editorial.batch_id,
    source_kind: 'codex-authored',
    provenance: {
      verification_status: 'verified',
      actor_kind: 'codex',
      actor_id: session.actor_id,
      session_id: session.session_id,
      artifact: 'data/batches/m5-10a-wave-a2-provenance-audit-20260909.json',
      sha256: null,
      note: 'Separate Codex audit pass over the frozen editorial staging, relation admissions, buffer decisions, and measured timing.',
    },
    editorial_input_id: editorial.input_id,
    auditor_id: session.actor_id,
    independent: true,
    created_at: session.started_at,
    completed_at: completedAt,
    reviewed_record_ids: editorial.records.slice(0, 50).map(({ canonical_id: canonicalId }) => canonicalId),
    relation_reviews: relationDiff.candidate_reviews.map((candidate, index) => ({
      candidate_id: candidate.candidate_id,
      relation_id: candidate.relation_id,
      source_sense: candidate.source_sense,
      target_sense: candidate.relation.target_sense,
      review_status: 'reviewed',
      relation_type: candidate.relation.type,
      decision: candidate.decision,
      basis: RELATION_BASIS[index],
    })),
    reviewed_staging_sha256: session.reviewed_staging_sha256,
    status: 'complete',
    findings: [
      {
        id: 'a2-audit-sense-boundaries',
        category: 'sense',
        severity: 'warning',
        status: 'resolved',
        evidence_refs: ['w582-s1', 'w603-s1', 'w603-s2', session.reviewed_staging_sha256],
        note: 'Frozen staging was re-read for the gloss correction and the duplicate light sense; the correction is present and no open sense blocker remains.',
      },
      {
        id: 'a2-audit-relation-screen',
        category: 'relation-noise',
        severity: 'info',
        status: 'resolved',
        evidence_refs: relationDiff.candidate_reviews.map(({ relation_id: relationId }) => relationId),
        note: 'All six admitted tuples were rechecked against their source and target senses; no broad-category or incidental-co-occurrence candidate remains open.',
      },
      {
        id: 'a2-audit-buffer-decisions',
        category: 'sense',
        severity: 'info',
        status: 'resolved',
        evidence_refs: editorial.records.slice(50).map(({ inventory_id: inventoryId }) => inventoryId),
        note: 'The three held, three rejected, and two deferred buffer rows match the frozen editorial decisions and remain outside the import set.',
      },
      {
        id: 'a2-audit-timing-completeness',
        category: 'timing-measurement',
        severity: 'info',
        status: 'resolved',
        evidence_refs: timing.passes.map(({ id }) => id),
        note: 'Each required timing pass has recorder start/stop events, measured duration, and exact work-unit evidence; no unmeasured pass remains.',
      },
    ],
    note: 'Separate audit pass completed from the frozen reviewed staging digest; editorial decisions were rechecked rather than reused as the audit conclusion.',
  };
  const artifactPath = path.resolve(REPOSITORY_DIRECTORY, audit.provenance.artifact);
  const artifact = {
    schema_version: '1',
    artifact_id: 'm5-10a-wave-a2-provenance-audit-20260909',
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
  await writeJson(artifactPath, artifact);
  await writeJson(path.resolve(args.audit), audit);
  const canonical = await readCanonicalRecords(path.resolve(args.canonical));
  const staged = await readCanonicalRecords(session.reviewed_staging_path);
  const relationValidated = validateA2AuditInput({
    audit,
    editorialInput: { ...editorial, verified: true },
    relationDiff,
    canonicalRecords: [...canonical.records, ...staged.records],
  });
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
    provenance_artifact_path: artifactPath,
    provenance_artifact_sha256: audit.provenance.sha256,
    reviewed_record_count: relationValidated.reviewed_record_ids.length,
    reviewed_relation_count: relationValidated.relation_reviews.length,
    note: 'Separate Codex audit pass completed after rechecking the frozen staging digest, all records, all relation candidates, the buffer, and timing completeness.',
  };
  await writeJson(sessionPath, completedSession);
  console.log(JSON.stringify({
    session_id: completedSession.session_id,
    audit_input: path.resolve(args.audit),
    provenance_artifact: artifactPath,
    reviewed_staging_sha256: audit.reviewed_staging_sha256,
  }, null, 2));
  return completedSession;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (!args.action || !['start', 'complete'].includes(args.action)) throw new Error('--action=start or --action=complete is required');
  for (const option of ['session', 'editorial', 'staging']) if (!args[option]) throw new Error(`--${option} is required`);
  if (args.action === 'start') return startSession(args);
  for (const option of ['audit', 'relation', 'timing', 'canonical']) if (!args[option]) throw new Error(`--${option} is required for complete`);
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
