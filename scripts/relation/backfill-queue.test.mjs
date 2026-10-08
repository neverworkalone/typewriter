import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inventoryCanonicalSenses, MAX_PACKET_SIZE, newQueueState, nextPacket, orderInventory, recordOutcomes, retrievePacket, summarizeQueue,
} from './backfill-queue.mjs';
import { buildRelationIndex } from './candidate-retrieval.mjs';

const entry = (id, lemma, gloss, relations = []) => ({
  id, record_type: 'entry', role: 'start', candidate_id: id, lemma, search_forms: [lemma],
  senses: [{ id: `${id}-s1`, pos: 'noun', gloss, ...(relations.length ? { relations } : {}) }],
});
const canonical = {
  canonicalRevision: 'b'.repeat(64),
  records: [
    entry('w1', '반향', '벽에 부딪힌 소리가 되돌아와 겹쳐 들리는 현상.', [{ target: 'w2', target_sense: 'w2-s1', type: 'near', note: 'n', relevance: 3 }]),
    entry('w2', '메아리', '산이나 벽에 부딪혀 되돌아오는 소리.'),
    entry('w3', '울림', '소리가 퍼지며 되돌아와 오래 남는 떨림.', [{ target: 'w2', target_sense: 'w2-s1', type: 'near', note: 'n', relevance: 2 }]),
    entry('w4', '고요', '아무 소리도 없이 잠잠한 상태.'),
  ],
};
const index = buildRelationIndex(canonical);
const rows = inventoryCanonicalSenses(index);
const outcome = (row, over = {}) => ({
  sense_id: row.sense_id, outcome: 'relations-reviewed', rationale: `${row.sense_id}: 후보를 검토했다.`,
  relation_amendments: [{
    source_record_id: row.record_id, source_sense_id: row.sense_id, source_gloss_sha256: row.gloss_sha256,
    relation: { target: 'w4', target_sense: 'w4-s1', type: 'association', note: '소리가 사라진 뒤의 정적이 이어진다.', relevance: 5 },
    rationale: `${row.record_id} ${row.sense_id}: 정적으로 이어진다.`,
  }], ...over,
});

test('inventory is deterministic; demand orders work and an empty relation list is never a defect', () => {
  assert.deepEqual(inventoryCanonicalSenses(buildRelationIndex(canonical)), rows);
  const order = orderInventory(rows).map((row) => row.sense_id);
  assert.equal(order[0], 'w2-s1', 'the most-pointed-at sense comes first');
  assert.deepEqual(order, orderInventory([...rows].reverse()).map((row) => row.sense_id));
  assert.ok(rows.every((row) => !('defect' in row) && !('missing' in row)));
  assert.match(summarizeQueue(rows, newQueueState('x')).note, /not defects/u);
});

test('packets are bounded and resumable: recorded senses leave the queue, the rest stay in order', () => {
  const state = newQueueState(canonical.canonicalRevision);
  const first = nextPacket(rows, state, { limit: 2 });
  assert.equal(first.length, 2);
  assert.throws(() => nextPacket(rows, state, { limit: MAX_PACKET_SIZE + 1 }), /limit must be/u);
  const reviewed = recordOutcomes(state, first, [outcome(first[0]), { sense_id: first[1].sense_id, outcome: 'no-relations', rationale: `${first[1].sense_id}: 정직하게 이을 후보가 없다.` }]);
  assert.deepEqual(reviewed.errors, []);
  const second = nextPacket(rows, reviewed.state, { limit: 10 });
  assert.deepEqual(second.map((row) => row.sense_id), orderInventory(rows).slice(2).map((row) => row.sense_id));
  assert.equal(summarizeQueue(rows, reviewed.state).completed, 2);
  assert.deepEqual(summarizeQueue(rows, reviewed.state).outcomes, { 'no-relations': 1, 'relations-reviewed': 1 });
});

test('outcomes obey the production relation contract, bound to the sense and its current gloss', () => {
  const state = newQueueState(canonical.canonicalRevision);
  const packet = nextPacket(rows, state, { limit: 1 });
  const row = packet[0];
  const bad = (over) => recordOutcomes(state, packet, [outcome(row, over)]).errors.join('\n');
  const tuple = (relation) => ({ relation_amendments: [{ ...outcome(row).relation_amendments[0], relation }] });
  assert.match(bad(tuple({ target: 'w4', target_sense: 'w4-s1', type: 'association', note: 'n' })), /relevance 1-9/u);
  assert.match(bad(tuple({ target: 'w4', target_sense: 'w4-s1', type: 'direct', note: 'n', relevance: 4 })), /must not carry relevance/u);
  assert.match(bad(tuple({ target: 'w4', target_sense: 'w4-s1', type: 'synonym', note: 'n' })), /not a supported relation type/u);
  assert.match(bad({ rationale: '근거만 있다.' }), /rationale must cite the sense/u);
  assert.match(bad({ outcome: 'no-relations' }), /no-relations carries amendments/u);
  assert.match(bad({ relation_amendments: [] }), /needs amendments/u);
  const stale = { relation_amendments: [{ ...outcome(row).relation_amendments[0], source_gloss_sha256: 'f'.repeat(64) }] };
  assert.match(bad(stale), /current gloss digest/u);
  assert.match(recordOutcomes(state, packet, [outcome({ ...row, sense_id: 'w99-s1' })]).errors.join('\n'), /not part of the supplied packet/u);
});

test('a sense whose gloss changed after review returns to the queue', () => {
  let state = newQueueState(canonical.canonicalRevision);
  const packet = nextPacket(rows, state, { limit: 1 });
  state = recordOutcomes(state, packet, [outcome(packet[0])]).state;
  const changed = rows.map((row) => (row.sense_id === packet[0].sense_id ? { ...row, gloss_sha256: 'c'.repeat(64) } : row));
  assert.ok(nextPacket(changed, state, { limit: 10 }).some((row) => row.sense_id === packet[0].sense_id));
  assert.ok(!nextPacket(rows, state, { limit: 10 }).some((row) => row.sense_id === packet[0].sense_id));
});

test('packets are fed by the production retriever and its fail-closed artifact validator', () => {
  const packet = nextPacket(rows, newQueueState(canonical.canonicalRevision), { limit: 3 });
  const artifact = retrievePacket(canonical, packet, { index });
  assert.equal(artifact.contract, 'relation-candidate-retrieval-v1');
  assert.equal(artifact.authority, 'candidates_only');
  assert.deepEqual(artifact.sources.map((source) => source.source.sense_id), packet.map((row) => row.sense_id));
});
