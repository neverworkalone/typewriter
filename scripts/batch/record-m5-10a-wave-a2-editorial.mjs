import { access, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  A2_PROMOTED_CANONICAL_IDS,
  validateA2EditorialInput,
  validateA2ProvenanceArtifact,
  sha256Bytes,
  sha256ProvenanceSubject,
} from './validate-m5-10a-wave-a2-inputs.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const PROPOSAL_SHA256 = '290a74905da1eea8e816dc7273acca2abe09c9a94e30217c0abb3f3e96717dd8';
const BOUNDARY_IDS = Object.freeze([
  'physical-figurative',
  'homonym-pos',
  'sensory-emotion-state-action',
  'directional-symmetry',
  'compound-spaced-phrase',
  'word-idiom',
]);
const CORRECTED_IDS = new Set([
  'w582', 'w588', 'w595', 'w598', 'w599', 'w603', 'w604', 'w606',
  'w609', 'w617', 'w618', 'w619', 'w620', 'w621', 'w622', 'w628',
]);

const SPLIT_SPECS = Object.freeze({
  w588: [{ boundary: 'homonym-pos', dimension: 'homonym', facets: ['lexical identity', 'use domain'], leftFocus: '불안정한 마음의 상태', rightFocus: '어린이를 위한 노래', difference: '정서 상태와 노래 장르는 서로 바꾸어 쓸 수 없으므로 두 명사 sense를 유지한다.' }],
  w595: [{ boundary: 'physical-figurative', dimension: 'physical', facets: ['body posture', 'attitude'], leftFocus: '몸의 곧은 모양', rightFocus: '흔들리지 않는 태도', difference: '몸의 모양과 의지의 태도는 적용 대상이 달라 한 설명으로 합치지 않는다.' }],
  w598: [{ boundary: 'physical-figurative', dimension: 'usage', facets: ['arrangement', 'concentration'], leftFocus: '정돈된 배열의 변화', rightFocus: '마음과 집중의 이탈', difference: '눈에 보이는 배열과 내면 집중의 변화는 문장 속 대상이 달라 분리한다.' }],
  w599: [{ boundary: 'sensory-emotion-state-action', dimension: 'sensory', facets: ['temperature', 'attitude'], leftFocus: '공기의 서늘한 감각', rightFocus: '망설임 없는 처리 태도', difference: '몸으로 느끼는 온도와 사람의 처리 태도는 서로 다른 장면을 만든다.' }],
  w603: [{ boundary: 'sensory-emotion-state-action', dimension: 'sensory', facets: ['sunlight', 'sound'], leftFocus: '강한 햇볕의 시각 자극', rightFocus: '맑고 세찬 소리의 청각 자극', difference: '빛과 소리는 감각 채널이 달라 두 사용을 분리하되 중복된 빛 sense는 남기지 않는다.' }],
  w604: [{ boundary: 'physical-figurative', dimension: 'figurative', facets: ['surface texture', 'atmosphere'], leftFocus: '수분이 빠진 표면의 질감', rightFocus: '생기 없는 표정과 분위기', difference: '만져지는 거칠음과 비유적인 생기 없음은 대상과 기능이 달라 구분한다.' }],
  w606: [{ boundary: 'sensory-emotion-state-action', dimension: 'sensory', facets: ['mouth sensation', 'speech atmosphere'], leftFocus: '입안의 마르고 답답한 감각', rightFocus: '말과 분위기의 답답한 인상', difference: '신체 감각에서 시작한 표현과 대화 분위기의 평가는 쓰임의 초점이 다르다.' }],
  w609: [{ boundary: 'physical-figurative', dimension: 'usage', facets: ['wind flow', 'carried sign'], leftFocus: '바람이 흐르는 방향', rightFocus: '바람을 타고 전해지는 기척', difference: '실제 바람의 흐름과 그 바람에 실린 징후는 물리적 대상과 해석이 다르다.' }],
  w617: [{ boundary: 'physical-figurative', dimension: 'usage', facets: ['crossing path', 'inner passage'], leftFocus: '공간을 가로질러 이동하는 동작', rightFocus: '생각과 감정이 마음을 스치는 변화', difference: '몸의 이동과 내면의 통과를 같은 동작으로 처리하면 장면의 방향성이 흐려진다.' }],
  w618: [{ boundary: 'physical-figurative', dimension: 'usage', facets: ['physical pull', 'attention pull'], leftFocus: '물체를 자기 쪽으로 당기는 힘', rightFocus: '관심과 마음을 이끄는 영향', difference: '손으로 가하는 힘과 관심을 끄는 영향은 주체와 대상의 관계가 다르다.' }],
  w619: [{ boundary: 'physical-figurative', dimension: 'usage', facets: ['outward force', 'rejection'], leftFocus: '몸이나 물체를 밖으로 밀어내는 동작', rightFocus: '사람이나 생각을 받아들이지 않는 태도', difference: '물리적 밀침과 심리적 거부는 결과는 닮아도 작용 대상과 문맥이 다르다.' }],
  w620: [
    { boundary: 'sensory-emotion-state-action', dimension: 'sensory', facets: ['liquid motion', 'reflected light'], leftFocus: '액체 표면이 잔잔하게 흔들리는 움직임', rightFocus: '빛이 흔들려 보이는 시각 효과', difference: '물질의 움직임과 그 위에 드러나는 빛의 움직임은 관찰 대상이 달라 나눈다.' },
    { boundary: 'sensory-emotion-state-action', dimension: 'emotion', facets: ['visible motion', 'inner motion'], leftFocus: '눈에 보이는 빛의 흔들림', rightFocus: '감정의 가벼운 동요', difference: '빛의 변화와 감정의 변화는 움직임의 비유 방향이 다르므로 별도 sense로 둔다.' },
  ],
  w621: [{ boundary: 'sensory-emotion-state-action', dimension: 'state', facets: ['external force', 'emotion intensity'], leftFocus: '소리와 바람의 세기 감소', rightFocus: '분노와 긴장의 진정', difference: '외부 현상의 약화와 감정의 가라앉음은 변화 대상이 달라 구분한다.' }],
  w622: [{ boundary: 'physical-figurative', dimension: 'usage', facets: ['quantity estimate', 'empathetic understanding'], leftFocus: '수와 분량을 가늠하는 행위', rightFocus: '사정과 마음을 이해하려는 태도', difference: '계산에 가까운 헤아림과 타인의 내면을 이해하는 헤아림은 목적이 다르다.' }],
  w628: [{ boundary: 'word-idiom', dimension: 'idiom', facets: ['breathing', 'relief'], leftFocus: '막힌 호흡이 편해지는 실제 변화', rightFocus: '막힌 상황이 풀리는 비유적 안도', difference: '신체 호흡의 변화와 상황 해결의 관용적 의미는 문장 대체 범위가 다르다.' }],
});

const REVIEW_REASONS = Object.freeze({
  w579: '가장 높은 기쁨의 강도를 가리키는 정서로, 기쁨 일반과 겹치지 않도록 단일 초점으로 잡았다.',
  w580: '타인의 고통을 가엾게 여기는 마음이라는 대상 방향이 분명해 한 정서 sense로 유지했다.',
  w581: '사람이나 집단 사이의 연결을 가리키는 관계 명사로 읽히며 감정과 행동을 별도 sense로 늘리지 않았다.',
  w582: '친밀감은 서로를 가깝고 편안하게 느끼는 마음이므로 거리의 반대 방향이 드러나도록 gloss를 정정했다.',
  w583: '억압에서 벗어난 뒤의 홀가분함이라는 변화 전후가 한 정서 초점으로 수렴한다.',
  w584: '몸과 마음 어느 쪽에도 적용되지만 공통 핵심은 편하지 않은 상태이므로 단일 sense로 두었다.',
  w585: '생각과 상황이 뒤섞여 판단이 어려운 상태라는 중심이 일관되어 추가 분리를 보류했다.',
  w586: '처신하기 곤란한 상황에서 생기는 마음이라는 장면 중심이 하나로 모인다.',
  w587: '스스로를 탓하는 행위와 마음에 초점이 있고 죄책감과는 겹치되 같지 않아 near 관계를 유지했다.',
  w588: '정서의 흔들림과 어린이 노래는 용례가 교차하지 않아 homonym 경계로 두 noun sense를 확정했다.',
  w589: '고요함에 아늑한 정취가 더해진 분위기 형용사로, 고요와의 mood 관계를 단일 sense에 연결했다.',
  w590: '기운이 빠진 몸과 마음의 노곤함이라는 감각·상태가 한 의미축을 이룬다.',
  w591: '기분과 성격의 밝음을 함께 묘사하는 성질이어서 writer-facing 한 adjective sense로 유지했다.',
  w592: '태도와 모양 모두에서 품위와 아름다움이 핵심이므로 하나의 평가 축으로 정리했다.',
  w593: '남의 잘못과 사정을 받아들이는 태도가 핵심이라 행동 목록으로 세분하지 않았다.',
  w594: '감정에 휘둘리지 않고 판단하는 성질이라는 태도 초점이 분명하다.',
  w595: '몸의 곧은 모양과 흔들리지 않는 태도는 적용 대상이 달라 physical/figurative 두 sense로 나눴다.',
  w596: '몸과 소리의 여리고 약한 인상을 공유하는 한 감각 축으로 유지했다.',
  w597: '짜임과 내용의 빈틈이라는 결함 판단이 공통되어 단일 adjective sense가 적절하다.',
  w598: '배열의 흐트러짐과 집중의 이탈은 대상이 달라 physical/figurative 두 sense로 분리했다.',
  w599: '서늘한 감각과 망설임 없는 태도는 문맥 기능이 달라 두 adjective sense로 확정했다.',
  w600: '가볍게 부서지는 촉감이 가루와 살결에 일관되게 적용되어 한 질감 sense로 두었다.',
  w601: '여러 색이 섞인 화려함이라는 시각적 인상이 하나의 묘사축으로 충분하다.',
  w602: '살빛의 어두움과 윤기가 함께 만드는 외관 묘사로 단일 sense를 유지했다.',
  w603: '햇볕과 소리는 다른 감각 장면이지만 제안된 세 번째 빛 설명은 햇볕 sense와 중복되어 제거했다.',
  w604: '메마른 표면과 생기 없는 표정·분위기는 물리/비유 용례가 달라 두 sense로 나눴다.',
  w605: '싱싱하고 맑은 생기라는 감각적 평가가 대상에 따라 흔들리지 않아 단일 sense로 두었다.',
  w606: '입안의 불쾌한 감각과 말·분위기의 답답함은 감각에서 비유로 넘어가는 별도 용례다.',
  w607: '물결 위에 반사된 빛이라는 시각 장면이 단일 명사 sense로 명확해 윤슬 관계를 유지했다.',
  w608: '빛을 받은 물결의 비늘 같은 모양이라는 구체적 장면으로 한 sense에 수렴한다.',
  w609: '바람의 실제 흐름과 바람에 실린 기척은 물리/해석 층위가 달라 두 noun sense로 분리했다.',
  w610: '나무가 우거진 곳을 지나는 길이라는 공간 합성 명사로 단일 장면을 유지했다.',
  w611: '넓게 펼쳐진 들판과 그 주변이라는 공간 지시가 하나의 장면 축이다.',
  w612: '산 사이에 파인 낮은 지형이라는 지형 명사로 별도 비유 sense를 만들지 않았다.',
  w613: '산의 높은 선을 가리키는 지형 명사로 의미 초점이 한 곳에 모인다.',
  w614: '배가 오가는 물가의 자리라는 장소 명사로 단일 장면을 유지했다.',
  w615: '지붕을 이는 구운 흙 재료라는 사물 지시가 분명하다.',
  w616: '발효 음식을 담는 큰 옹기라는 생활 사물의 용도가 핵심이다.',
  w617: '공간을 가로지르는 동작과 생각·감정이 스치는 비유 동작은 대상 층위가 달라 두 sense로 나눴다.',
  w618: '물체를 당기는 물리 작용과 관심을 이끄는 비유 작용은 대상과 방향이 달라 분리했다.',
  w619: '물리적 밀침과 사람·생각을 거부하는 비유가 서로 다른 작용 대상을 가지므로 두 sense로 뒀다.',
  w620: '물결·빛·감정의 흔들림은 관찰 대상이 각각 달라 세 개의 writer-facing sense로 분리했다.',
  w621: '소리·바람의 약화와 감정의 진정은 외부 현상과 내면 상태의 변화라 두 sense로 나눴다.',
  w622: '수를 가늠하는 행위와 사정을 이해하는 태도는 목적이 달라 두 verb sense로 확정했다.',
  w623: '짧게 시선을 돌리는 행동이라는 동작 중심이 하나로 명확하다.',
  w624: '목적지 없이 돌아다니는 움직임과 공간 장면이 한 동작 sense에 결합된다.',
  w625: '끊긴 말을 계속하는 표현으로, 시선이나 관계의 비유로 확장하지 않았다.',
  w626: '결심을 확고하게 만드는 내적 결단 표현으로 한 expression sense를 유지했다.',
  w627: '서로의 시선을 마주하는 관계 장면이 단일 표현 sense로 충분하다.',
  w628: '호흡이 편해지는 실제 변화와 막힌 상황이 풀리는 비유적 안도는 expression 내부의 두 용례다.',
});

const BUFFER_DECISIONS = Object.freeze({
  'm5-357': ['held', '급한 움직임의 무질서라는 행동은 유효하지만 기존 행동군과의 경계 자료가 더 필요해 이번 import에서 보류했다.'],
  'm5-358': ['held', '상태와 태도의 경계가 한 후보 안에서 겹쳐 현재 sense 자료만으로는 안정적인 추가가 어려워 보류했다.'],
  'm5-359': ['held', '먼 거리의 시점과 장면 기능을 더 비교해야 하므로 이번 50개 import에 넣지 않았다.'],
  'm5-360': ['rejected', '후보 행동이 기존 canonical 동작과 겹치고 이번 wave의 writer-facing 증분이 작아 제외했다.'],
  'm5-361': ['rejected', '감정 표현의 경계가 모호하고 단일 gloss로는 독립적인 검색 효용을 확인하기 어려워 제외했다.'],
  'm5-362': ['rejected', '공간 장면 후보가 기존 항목과 중복되어 별도 start로 들이지 않았다.'],
  'm5-363': ['deferred', '표현의 실제 사용 범위는 의미가 있으나 후속 batch에서 문장 단위 대조를 거친 뒤 다시 판단한다.'],
  'm5-364': ['deferred', '현재 후보는 장면과 상태가 함께 얽혀 있어 다음 편집 묶음에서 별도 검토 대상으로 남겼다.'],
});

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

function fileSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function contrastFor(record, spec, index) {
  const left = record.senses[index === 0 ? 0 : index];
  const right = record.senses[index === 0 ? 1 : index + 1];
  const caseId = `${record.id}-${spec.dimension}-${index + 1}`;
  return {
    left_sense_id: left.id,
    right_sense_id: right.id,
    dimension: spec.dimension,
    facets: [...spec.facets, caseId],
    left_observation: `${left.gloss}라는 용례는 ${spec.leftFocus} 쪽으로 읽힌다.`,
    right_observation: `${right.gloss}라는 용례는 ${spec.rightFocus} 쪽으로 읽힌다.`,
    difference: `${spec.difference} 대조 단위 ${caseId}를 별도로 기록했다.`,
  };
}

function boundaryEvidence(record) {
  const specs = SPLIT_SPECS[record.id] ?? [];
  return Object.fromEntries(BOUNDARY_IDS.map((boundaryId) => {
    const matching = specs.filter((spec) => spec.boundary === boundaryId);
    if (matching.length === 0) {
      return [boundaryId, {
        review_status: 'reviewed',
        applicability: 'not-applicable',
        candidate_sense_ids: record.senses.map(({ id }) => id),
        decision: 'keep',
        contrasts: [],
      }];
    }
    return [boundaryId, {
      review_status: 'reviewed',
      applicability: 'applicable',
      candidate_sense_ids: record.senses.map(({ id }) => id),
      decision: 'split',
      contrasts: matching.map((spec, index) => contrastFor(record, spec, index)),
    }];
  }));
}

function buildReviewedRecords(proposal) {
  const reviewedRecords = proposal.map((record) => {
    const reviewed = structuredClone(record);
    if (reviewed.id === 'w582') reviewed.senses[0].gloss = '서로를 가깝고 편안하게 느끼는 마음';
    if (reviewed.id === 'w603') reviewed.senses = reviewed.senses.slice(0, 2);
    return reviewed;
  });
  const editorialRecords = reviewedRecords.map((record, index) => {
    const inventoryId = `m5-${String(index + 307).padStart(3, '0')}`;
    const corrected = CORRECTED_IDS.has(record.id);
    return {
      inventory_id: inventoryId,
      decision: corrected ? 'corrected' : 'included',
      canonical_id: record.id,
      ...(corrected ? { corrected_fields: ['senses'] } : {}),
      decision_note: `${inventoryId} ${record.id} ${record.lemma}: ${REVIEW_REASONS[record.id]}`,
      observed_sense_count: record.senses.length,
      observed_pos: record.senses.map(({ pos }) => pos),
      boundary_evidence: boundaryEvidence(record),
    };
  });
  for (const [inventoryId, [decision, reason]] of Object.entries(BUFFER_DECISIONS)) {
    editorialRecords.push({
      inventory_id: inventoryId,
      decision,
      decision_note: `${inventoryId}: ${reason}`,
      unreviewed_note: `${inventoryId}: ${reason} 후보 본문은 canonical에 반영하지 않았다.`,
    });
  }
  return { reviewedRecords, editorialRecords };
}

async function assertNewSession(sessionPath) {
  try {
    await access(sessionPath);
    throw new Error(`refusing to overwrite an existing editorial session: ${sessionPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function startSession(args) {
  const proposalPath = path.resolve(args.proposal);
  const proposalBytes = await readFile(proposalPath);
  const proposalSha256 = fileSha256(proposalBytes);
  if (proposalSha256 !== PROPOSAL_SHA256) throw new Error(`proposal digest ${proposalSha256} does not match the #110 boundary digest`);
  await assertNewSession(path.resolve(args.session));
  const session = {
    schema_version: '1',
    recorder_version: 'wave-a2-editorial-recorder-v1',
    status: 'in-progress',
    session_id: randomUUID(),
    actor_kind: 'codex',
    actor_id: 'codex-wave-a2-editorial',
    started_at: new Date().toISOString(),
    proposal_path: proposalPath,
    proposal_sha256: proposalSha256,
    note: 'Editorial session has started; no completed review claim is made until the explicit complete action.',
  };
  await writeJson(path.resolve(args.session), session);
  console.log(`Started Codex Wave A2 editorial session ${session.session_id}.`);
  return session;
}

async function completeSession(args) {
  const sessionPath = path.resolve(args.session);
  const session = await readJson(sessionPath);
  if (session.status !== 'in-progress') throw new Error('editorial session must be in-progress before complete');
  const proposalBytes = await readFile(session.proposal_path);
  if (fileSha256(proposalBytes) !== session.proposal_sha256 || session.proposal_sha256 !== PROPOSAL_SHA256) {
    throw new Error('editorial session proposal digest changed before completion');
  }
  const proposal = proposalBytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
  if (proposal.length !== A2_PROMOTED_CANONICAL_IDS.length) throw new Error('editorial proposal must contain exactly 50 starts');
  const { reviewedRecords, editorialRecords } = buildReviewedRecords(proposal);
  const reviewedBytes = Buffer.from(`${reviewedRecords.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  const completedAt = new Date().toISOString();
  const editorial = {
    schema_version: '2',
    input_id: 'm5-10a-wave-a2-editorial-input-20260909',
    batch_id: 'm5-10-wave-a2-20260909',
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
      artifact: 'data/batches/m5-10a-wave-a2-provenance-editorial-20260909.json',
      sha256: null,
      note: 'Codex record-by-record editorial pass. The external builder proposal was reviewed as an unverified input and the reviewed staging digest was frozen here.',
    },
    sense_review: {
      status: 'complete',
      boundary_ids: BOUNDARY_IDS,
      reviewed_start_count: 50,
      scoped_single_sense_count: 35,
      split_record_count: 15,
      split_canonical_ids: [...CORRECTED_IDS]
        .filter((id) => reviewedRecords.find((record) => record.id === id).senses.length > 1)
        .sort(),
      note: 'Fifty starts were read against the final sense inventory; single-sense candidates were retained only after the declared boundary dimensions were checked, and separated usages carry paired observations.',
    },
    proposal_staging: {
      format: 'canonical-jsonl',
      sha256: session.proposal_sha256,
      note: 'Original builder proposal remains external and is retained only as the input boundary for this editorial pass.',
    },
    reviewed_staging_sha256: fileSha256(reviewedBytes),
    records: editorialRecords,
  };
  const artifactPath = path.resolve(REPOSITORY_DIRECTORY, editorial.provenance.artifact);
  editorial.provenance.sha256 = null;
  const artifact = {
    schema_version: '1',
    artifact_id: 'm5-10a-wave-a2-provenance-editorial-20260909',
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
  await writeFile(path.resolve(args.staging), reviewedBytes, 'utf8');
  await writeJson(artifactPath, artifact);
  await writeJson(path.resolve(args.editorial), editorial);
  const canonical = await readCanonicalRecords(path.resolve(args.canonical));
  const staged = await readCanonicalRecords(path.resolve(args.staging));
  validateA2EditorialInput({ input: editorial, canonicalRecords: [...canonical.records, ...staged.records] });
  await validateA2ProvenanceArtifact({
    input: editorial,
    repositoryDirectory: REPOSITORY_DIRECTORY,
    subjectKind: 'editorial',
  });
  const completedSession = {
    ...session,
    status: 'complete',
    completed_at: completedAt,
    reviewed_staging_path: path.resolve(args.staging),
    reviewed_staging_sha256: editorial.reviewed_staging_sha256,
    editorial_input_path: path.resolve(args.editorial),
    editorial_input_sha256: sha256Bytes(Buffer.from(`${JSON.stringify(editorial, null, 2)}\n`, 'utf8')),
    provenance_artifact_path: artifactPath,
    provenance_artifact_sha256: editorial.provenance.sha256,
    note: 'Codex editorial pass completed after all 50 starts and the 8-row buffer were explicitly classified and the result was validated against the canonical input contract.',
  };
  await writeJson(sessionPath, completedSession);
  console.log(JSON.stringify({
    session_id: completedSession.session_id,
    reviewed_staging: path.resolve(args.staging),
    reviewed_staging_sha256: editorial.reviewed_staging_sha256,
    editorial_input: path.resolve(args.editorial),
    provenance_artifact: artifactPath,
  }, null, 2));
  return completedSession;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (!args.action || !['start', 'complete'].includes(args.action)) throw new Error('--action=start or --action=complete is required');
  if (!args.session || !args.proposal) throw new Error('--session and --proposal are required');
  if (args.action === 'start') return startSession(args);
  for (const option of ['staging', 'editorial', 'canonical']) {
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
