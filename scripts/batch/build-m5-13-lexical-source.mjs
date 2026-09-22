import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import { canonicalRecordsSha256 } from '../validate/semantic-audit.mjs';
import { M5_13_LEXICAL_UNIT_POOL } from './m5-13-lexical-units.mjs';

const REPOSITORY_DIRECTORY = path.resolve(new URL('../..', import.meta.url).pathname);
const SOURCE_PATH = path.join(REPOSITORY_DIRECTORY, 'data/batches/m5-13-lexical-unit-source.json');
const CURRENT_IMPORT = path.join(REPOSITORY_DIRECTORY, 'data/canonical/m5-13-expansion.jsonl');
const CURRENT_SEED = path.join(REPOSITORY_DIRECTORY, 'data/inventory/m5-target-seed.json');
const SOURCE_ID = 'm5-13-typewriter-authored-lexical-units-20260922-r3';
const TARGET_COUNTS = Object.freeze({ E: 160, Q: 160, S: 160, C: 160, A: 180, O: 140, X: 140 });
const AXIS_GLOSS_LEADS = Object.freeze({
  E: '감정과 기분의 변화를 한 장면 안에서 좁혀 읽는',
  Q: '상태와 질감의 차이를 문장 안에서 구체화하는',
  S: '소리와 감각이 몸과 주변에 남기는 결을 포착하는',
  C: '공간과 장면의 배치를 눈앞에 세우는',
  A: '행동과 움직임의 방향을 장면 속에서 보여 주는',
  O: '사물과 표면의 모양을 손에 잡히게 하는',
  X: '행동과 장면의 관계를 자연스럽게 이어 주는',
});
const WRITER_SCENE_CUES = Object.freeze([
  '인물의 표정이 바뀌는 순간',
  '말이 끊긴 뒤의 정적',
  '손이 어떤 물건에 닿는 장면',
  '한 사람이 문턱 앞에 멈춘 때',
  '낯선 장소를 처음 바라보는 순간',
  '오래된 기억이 되살아나는 장면',
  '누군가의 이름을 부르기 직전',
  '비가 그친 뒤 주변을 살피는 때',
  '한 문장을 고쳐 쓰는 장면',
  '사람이 떠난 자리를 돌아보는 순간',
  '대답을 기다리며 숨을 고르는 때',
  '빛이 바뀌어 사물이 달라 보이는 장면',
  '길을 잃고 방향을 다시 잡는 순간',
  '서로의 거리를 의식하는 장면',
  '하루의 끝을 조용히 정리하는 때',
  '아직 오지 않은 일을 상상하는 순간',
  '젖은 옷과 신발을 내려놓는 장면',
  '창밖의 움직임을 오래 바라보는 때',
  '작은 소리에 고개를 돌리는 순간',
  '한 손을 내밀었다가 거두는 장면',
  '계절이 바뀌는 기척을 느끼는 때',
  '사라진 물건의 자리를 찾는 순간',
  '낯익은 목소리를 멀리서 듣는 장면',
  '아무도 없는 방에 혼자 들어서는 때',
  '한 걸음 다가가거나 물러나는 순간',
  '오래 닫혀 있던 문을 여는 장면',
  '한숨 뒤에 다시 말을 잇는 때',
  '사진 속 장면을 실제와 겹쳐 보는 순간',
  '사소한 흔적 하나를 발견하는 장면',
  '마음속 결심을 행동으로 옮기는 때',
  '남겨진 물건을 손에 들어 보는 순간',
  '여러 사람 사이에서 시선을 고르는 장면',
  '어제의 말을 다시 떠올리는 때',
  '먼 곳에서 돌아와 주변을 확인하는 순간',
  '불이 켜진 공간과 어두운 공간을 오가는 장면',
  '몸의 작은 반응을 알아차리는 때',
  '끝내 하지 못한 말을 삼키는 순간',
  '비어 있는 자리에 오래 머무는 장면',
  '다음 장면으로 넘어가기 직전',
]);
const WRITER_GLOSS_ACTIONS = Object.freeze([
  '그 결을 짧게 붙잡는 말이다',
  '변화의 방향을 드러내는 말이다',
  '장면의 속도를 늦춰 읽게 하는 말이다',
  '인물의 움직임을 구체화하는 말이다',
  '눈앞의 인상을 선명하게 만드는 말이다',
  '말하지 않은 부분의 여운을 남기는 말이다',
  '한순간의 차이를 구별해 주는 말이다',
  '장면의 안과 밖을 이어 주는 말이다',
  '감각의 흔적을 문장에 남기는 말이다',
  '인물과 사물 사이의 거리를 보여 주는 말이다',
  '멈춤과 이어짐을 함께 읽게 하는 말이다',
  '작은 방향 전환을 포착하는 말이다',
  '장면에 머무는 시간을 조절하는 말이다',
  '몸과 주변의 반응을 맞물려 보여 주는 말이다',
  '흐릿한 인상을 한 점에 모으는 말이다',
  '장면에 놓인 순서를 의식하게 하는 말이다',
  '앞선 장면의 흔적을 되돌려 읽는 말이다',
  '다음 행동의 가능성을 열어 두는 말이다',
  '인물의 선택이 남긴 결을 보여 주는 말이다',
  '시선이 머무는 곳을 바꾸어 놓는 말이다',
  '익숙한 장면을 낯설게 만드는 말이다',
  '낯선 장면에 발을 딛게 하는 말이다',
  '감정의 세기를 과장하지 않고 드러내는 말이다',
  '한 장면의 중심과 주변을 나누는 말이다',
  '사라지는 것과 남는 것을 함께 보여 주는 말이다',
  '행동의 전후를 자연스럽게 연결하는 말이다',
  '표면 아래의 움직임을 짚어 주는 말이다',
  '문장에 빈틈과 여지를 남기는 말이다',
  '장면의 방향을 독자가 따라가게 하는 말이다',
]);

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceUnit(unit, index) {
  const scene = WRITER_SCENE_CUES[index % WRITER_SCENE_CUES.length];
  const action = WRITER_GLOSS_ACTIONS[
    Math.floor(index / WRITER_SCENE_CUES.length) % WRITER_GLOSS_ACTIONS.length
  ];
  return {
    source_unit_id: `m5-13-source-unit-${String(index + 1).padStart(4, '0')}`,
    lemma: unit.lemma,
    axis: unit.axis,
    flags: [...unit.flags],
    record_type: unit.record_type,
    pos: unit.pos,
    source_kind: unit.source_kind,
    writer_use: `검수 메모: ${scene}에서 ${unit.axis} writer-facing lexical unit으로 실제 대체 가능성과 장면 효용을 확인한다.`,
    writer_gloss: `‘${unit.lemma}’이라는 말은 ${scene}에서 ${AXIS_GLOSS_LEADS[unit.axis]} ${action}.`,
  };
}

const { records } = await readCanonicalRecords(path.join(REPOSITORY_DIRECTORY, 'data/canonical'));
const baseRecords = records.filter(({ filePath }) => path.resolve(filePath) !== path.resolve(CURRENT_IMPORT));
const seedBytes = await readFile(CURRENT_SEED);
const seed = JSON.parse(seedBytes);
const baseForms = new Set([
  ...baseRecords.flatMap(({ record }) => [record.lemma, ...record.search_forms]),
  ...seed.targets.flatMap(({ lemma, search_forms: searchForms }) => [lemma, ...searchForms]),
]);
const selected = [];
const seen = new Set();
for (const [axis, targetCount] of Object.entries(TARGET_COUNTS)) {
  for (const unit of M5_13_LEXICAL_UNIT_POOL) {
    if (unit.axis !== axis || baseForms.has(unit.lemma) || seen.has(unit.lemma)) continue;
    seen.add(unit.lemma);
    selected.push(unit);
    if (selected.filter((candidate) => candidate.axis === axis).length === targetCount) break;
  }
  const actual = selected.filter((candidate) => candidate.axis === axis).length;
  if (actual !== targetCount) throw new Error(`M5-13 ${axis} source has ${actual} free lexical units; expected ${targetCount}`);
}

const units = selected.map(sourceUnit);
const sourceWithoutDigest = {
  schema_version: '1',
  contract_version: 'lexical-candidate-source-v1',
  kind: 'typewriter-authored-lexical-unit-source',
  source_id: SOURCE_ID,
  authoring_mode: 'agent-generated-from-explicit-typewriter-unit-pool',
  base_canonical_records_sha256: canonicalRecordsSha256(baseRecords),
  base_seed_sha256: sha256Bytes(seedBytes),
  pool_sha256: sha256Json(M5_13_LEXICAL_UNIT_POOL.map(({ lemma, axis, record_type, pos, source_kind, writer_use }) => ({ lemma, axis, record_type, pos, source_kind, writer_use }))),
  axis_counts: TARGET_COUNTS,
  candidate_count: units.length,
  units,
};
const source = {
  ...sourceWithoutDigest,
  artifact_sha256: sha256Json(sourceWithoutDigest),
};
await writeFile(SOURCE_PATH, `${JSON.stringify(source, null, 2)}\n`);
console.log(JSON.stringify({ path: path.relative(REPOSITORY_DIRECTORY, SOURCE_PATH), candidate_count: units.length, artifact_sha256: source.artifact_sha256 }, null, 2));
