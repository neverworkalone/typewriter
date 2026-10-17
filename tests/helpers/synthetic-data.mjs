import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic stand-ins for repository data files, so tests of the CI classifier do not depend on
// any production dataset being present.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const SAMPLE_CANONICAL_PATH = path.join(ROOT, 'tests/fixtures/canonical-sample/sample.jsonl');

/** First record line of the shared synthetic canonical sample. */
export const sampleCanonicalRecordLine = () => readFileSync(SAMPLE_CANONICAL_PATH, 'utf8').split('\n')[0];

/** A valid relation-correction packet for the sample records, with the given packet id. */
export function syntheticRelationPacket(packetId) {
  const relation = { target: 'r001', target_sense: 'r001-s1', type: 'near', relevance: 3 };
  return {
    packet_id: packetId,
    relation_corrections: [{
      source_record_id: 'w001',
      source_sense_id: 'w001-s1',
      source_record_sha256: 'c'.repeat(64),
      source_gloss_sha256: 'a'.repeat(64),
      target_meaning_sha256: 'b'.repeat(64),
      previous_relation: { ...relation, note: '기쁨은 즐거움과 가까우나 중심이 조금 다르다.' },
      relation: { ...relation, type: 'association', note: '기쁨은 즐거움과 바꿔 쓸 수는 없지만 이어서 떠올릴 수 있는 정서다.' },
      position: 0,
      rationale: 'w001-s1과 r001-s1은 가까운 정서이지만 중심이 달라 near가 아니라 association이 맞다. AI 자체 점검이며 독립 검토가 아니다.',
    }],
  };
}
