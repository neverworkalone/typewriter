import assert from 'node:assert/strict';
import test from 'node:test';

import {
  packetBoundErrors, ReviewContext, isReviewCurrent, candidateEvidence, currentCandidatesForDone, inventoryCanonicalSenses, MAX_PACKET_SIZE, newQueueState, nextPacket, orderInventory, recordOutcomes, retrievePacket, summarizeQueue,
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
const reviewed = (cn, packet) => candidateEvidence(retrievePacket(cn, packet, { index: buildRelationIndex(cn) }), buildRelationIndex(cn));
const current = (cn, state, rs = inventoryCanonicalSenses(buildRelationIndex(cn))) => currentCandidatesForDone(cn, rs, state);
const record = (state, packet, outcomes, cn = canonical, candidates = reviewed(cn, packet)) => recordOutcomes(
  state, packet, outcomes, { candidates, index: buildRelationIndex(cn), snapshotDigest: cn.canonicalRevision },
);
const targetOf = (row) => {
  const id = reviewed(canonical, [row]).get(row.sense_id)[0].id;
  return { target: buildRelationIndex(canonical).bySenseId.get(id).record_id, target_sense: id };
};
const outcome = (row, over = {}) => ({
  sense_id: row.sense_id, outcome: 'relations-reviewed', rationale: `${row.sense_id}: 후보를 검토했다.`,
  relation_amendments: [{
    source_record_id: row.record_id, source_sense_id: row.sense_id, source_gloss_sha256: row.gloss_sha256,
    relation: { ...targetOf(row), type: 'association', note: '소리가 사라진 뒤의 정적이 이어진다.', relevance: 5 },
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
  const done = record(state, first, [outcome(first[0]), { sense_id: first[1].sense_id, outcome: 'no-relations', rationale: `${first[1].sense_id}: 정직하게 이을 후보가 없다.` }]);
  assert.deepEqual(done.errors, []);
  const second = nextPacket(rows, done.state, { limit: 10, currentCandidates: current(canonical, done.state) });
  assert.deepEqual(second.map((row) => row.sense_id), orderInventory(rows).slice(2).map((row) => row.sense_id));
  const summary = summarizeQueue(rows, done.state, current(canonical, done.state));
  assert.equal(summary.completed, 2);
  assert.deepEqual(summary.outcomes, { 'no-relations': 1, 'relations-reviewed': 1 });
});

test('outcomes obey the production relation contract, bound to the sense and its current gloss', () => {
  const state = newQueueState(canonical.canonicalRevision);
  const packet = nextPacket(rows, state, { limit: 1 });
  const row = packet[0];
  const bad = (over) => record(state, packet, [outcome(row, over)]).errors.join('\n');
  const tuple = (relation) => ({ relation_amendments: [{ ...outcome(row).relation_amendments[0], relation: { ...targetOf(row), ...relation } }] });
  assert.match(bad(tuple({ type: 'association', note: 'n' })), /relevance 1-9/u);
  assert.match(bad(tuple({ type: 'direct', note: 'n', relevance: 4 })), /must not carry relevance/u);
  assert.match(bad(tuple({ type: 'synonym', note: 'n' })), /not a supported relation type/u);
  assert.match(bad({ rationale: '근거만 있다.' }), /rationale must cite the sense/u);
  assert.match(bad({ outcome: 'no-relations' }), /no-relations carries amendments/u);
  assert.match(bad({ relation_amendments: [] }), /needs amendments/u);
  const stale = { relation_amendments: [{ ...outcome(row).relation_amendments[0], source_gloss_sha256: 'f'.repeat(64) }] };
  assert.match(bad(stale), /current gloss digest/u);
  assert.match(record(state, packet, [{ ...outcome(row), sense_id: 'w99-s1' }]).errors.join('\n'), /not part of the supplied packet/u);
});

test('a review is re-queued when its gloss changed or the canonical now offers a candidate it never saw', () => {
  let state = newQueueState(canonical.canonicalRevision);
  const packet = nextPacket(rows, state, { limit: 1 });
  const id = packet[0].sense_id;
  assert.equal(record(state, packet, [outcome(packet[0])], canonical, new Map()).errors.length, 1, 'the reviewed pool must be supplied');
  state = record(state, packet, [outcome(packet[0])]).state;
  const pending = (rs, cn, cur = current(cn, state, rs)) => nextPacket(rs, state, { limit: 10, currentCandidates: cur }).some((row) => row.sense_id === id);
  assert.equal(pending(rows, canonical), false, 'unchanged gloss and pool stay done');
  const changed = rows.map((row) => (row.sense_id === id ? { ...row, gloss_sha256: 'c'.repeat(64) } : row));
  assert.equal(pending(changed, canonical), true);
  // Revision B: another canonical addition surfaces a new candidate for the same, unchanged sense.
  const revisionB = { ...canonical, canonicalRevision: 'c'.repeat(64), records: [...canonical.records, entry('w5', '잔향', '소리가 멈춘 뒤에도 남아 되돌아오는 울림.')] };
  const rowsB = inventoryCanonicalSenses(buildRelationIndex(revisionB));
  assert.equal(rowsB.find((row) => row.sense_id === id).gloss_sha256, rows.find((row) => row.sense_id === id).gloss_sha256, 'gloss is unchanged');
  assert.ok(candidateEvidence(retrievePacket(revisionB, packet, { index: buildRelationIndex(revisionB) }), buildRelationIndex(revisionB)).get(id).some((candidate) => candidate.id === 'w5-s1'), 'the new candidate is offered');
  assert.equal(pending(rowsB, revisionB), true, 'the unreviewed candidate returns the sense to the queue');
  assert.equal(summarizeQueue(rowsB, state, current(revisionB, state, rowsB)).completed, 0, 'status no longer counts the stale review');
  assert.equal(pending(rowsB, revisionB, new ReviewContext([], buildRelationIndex(revisionB))), true, 'without a current pool the old review fails closed');
});

test('packets are fed by the production retriever and its fail-closed artifact validator', () => {
  const packet = nextPacket(rows, newQueueState(canonical.canonicalRevision), { limit: 3 });
  const artifact = retrievePacket(canonical, packet, { index });
  assert.equal(artifact.contract, 'relation-candidate-retrieval-v1');
  assert.equal(artifact.authority, 'candidates_only');
  assert.deepEqual(artifact.sources.map((source) => source.source.sense_id), packet.map((row) => row.sense_id));
});

test('a review stays current only while the full reviewed candidate evidence holds', () => {
  let state = newQueueState(canonical.canonicalRevision);
  const packet = nextPacket(rows, state, { limit: 1 });
  const [row] = packet;
  state = record(state, packet, [outcome(row)]).state;
  const entry = state.done[row.sense_id];
  const original = entry.reviewed_candidates;
  assert.ok(original.length >= 2, 'fixture has several candidates to vary');
  assert.ok(original.every((c) => c.id && c.pos && Array.isArray(c.signals)), 'evidence keeps identity, POS and signals');
  const idx = buildRelationIndex(canonical);
  const ctx = (current) => new ReviewContext([[row.sense_id, current]], idx);
  const check = (current) => isReviewCurrent(row, entry, ctx(current));
  const edit = (index, change) => original.map((c, i) => (i === index ? { ...c, ...change } : c));
  assert.equal(check(structuredClone(original)), true, 'identical evidence (same revision or no-op change) stays done');
  assert.equal(check(original.slice(1)), true, 'a candidate that disappeared does not invalidate the review');
  assert.equal(check(edit(0, { pos: 'verb' })), false, 'same target ids, different POS');
  assert.equal(check(edit(0, { signals: [...original[0].signals, 'literature_cooccurrence'] })), false, 'same target ids, different signals');
  assert.equal(check(edit(0, { signals: [] })), false);
  assert.equal(check(edit(0, { literature: ['f'.repeat(64)] })), false, 'different literature evidence');
  assert.equal(check(edit(0, { record_id: 'w99' })), false, 'different record identity');
  assert.equal(check(edit(0, { meaning_sha256: 'e'.repeat(64) })), false, 'same signals, edited target lemma/gloss');
  assert.equal(check([original[1], original[0], ...original.slice(2)]), false, 'same target ids, different rank order');
  assert.equal(check([...original, { id: 'w9-s1', record_id: 'w9', pos: 'noun', signals: ['gloss_overlap'], literature: [] }]), false, 'a new candidate');
  const summary = (current) => summarizeQueue(rows, state, ctx(current)).completed;
  assert.equal(summary(structuredClone(original)), 1);
  assert.equal(summary(edit(0, { pos: 'verb' })), 0, 'status drops the stale completion');
  assert.ok(nextPacket(rows, state, { limit: 10, currentCandidates: ctx(edit(0, { pos: 'verb' })) }).some((r) => r.sense_id === row.sense_id), 'next re-offers it');
});

test('approved relations are verified against canonical and the reviewed pool, then preserved verbatim', () => {
  const state = newQueueState(canonical.canonicalRevision);
  const packet = nextPacket(rows, state, { limit: 1 });
  const row = packet[0];
  const good = outcome(row);
  const withRelation = (relation) => outcome(row, { relation_amendments: [{ ...good.relation_amendments[0], relation: { ...good.relation_amendments[0].relation, ...relation } }] });
  const errorsOf = (candidate) => record(state, packet, [candidate]).errors.join('\n');
  assert.equal(errorsOf(good), '');
  assert.match(errorsOf(withRelation({ target: 'w99999', target_sense: 'w99999-s1' })), /not a canonical sense/u);
  const offPool = buildRelationIndex(canonical).senses.map((s) => s.sense_id).find((id) => !reviewed(canonical, packet).get(row.sense_id).some((c) => c.id === id) && id !== row.sense_id);
  assert.ok(offPool, 'fixture has a canonical sense outside the pool');
  assert.match(errorsOf(withRelation({ target: offPool.replace(/-s\d+$/u, ''), target_sense: offPool })), /not among the reviewed candidates/u);
  const wrongRecord = withRelation({ target: 'w4' });
  assert.match(errorsOf(wrongRecord), /does not own target_sense/u);
  assert.match(errorsOf(withRelation({ target_sense: undefined })), /not a canonical sense/u);

  const saved = record(state, packet, [good]).state.done[row.sense_id];
  assert.equal(saved.approved_relations.length, 1);
  assert.deepEqual(saved.approved_relations[0].relation, good.relation_amendments[0].relation);
  assert.equal(saved.approved_relations[0].rationale, good.relation_amendments[0].rationale);
  assert.equal(saved.canonical_snapshot_digest, canonical.canonicalRevision);
  assert.equal(saved.rationale, good.rationale);
  // Same count, different relevance/target/rationale -> different persistent evidence.
  const other = record(state, packet, [withRelation({ relevance: 2 })]).state.done[row.sense_id];
  assert.notEqual(other.approved_relations[0].relation_id, saved.approved_relations[0].relation_id);
  // The state survives a JSON restart intact; tampering with the preserved approvals invalidates the completion.
  const restored = JSON.parse(JSON.stringify(record(state, packet, [good]).state));
  const cands = new ReviewContext([[row.sense_id, saved.reviewed_candidates]], buildRelationIndex(canonical));
  assert.equal(isReviewCurrent(row, restored.done[row.sense_id], cands), true);
  const tampered = structuredClone(restored.done[row.sense_id]);
  tampered.approved_relations[0].relation.relevance = 1;
  assert.equal(isReviewCurrent(row, tampered, cands), false, 'edited approval no longer matches its id');
  const stripped = { ...restored.done[row.sense_id], approved_relations: [] };
  assert.equal(isReviewCurrent(row, stripped, cands), false, 'a count without the preserved tuples is not a completed review');
});

test('an approved target that left canonical (or changed owner) makes the review stale; one merely gone from the pool does not', () => {
  const state0 = newQueueState(canonical.canonicalRevision);
  const packet = nextPacket(rows, state0, { limit: 1 });
  const row = packet[0];
  const state = record(state0, packet, [outcome(row)]).state;
  const approved = state.done[row.sense_id].approved_relations[0].relation;
  const without = (id) => ({ ...canonical, canonicalRevision: 'd'.repeat(64), records: canonical.records.filter((r) => !r.senses.some((s) => s.id === id)) });
  const status = (cn) => summarizeQueue(rows, state, currentCandidatesForDone(cn, rows, state)).completed;
  const next = (cn) => nextPacket(rows, state, { limit: 10, currentCandidates: currentCandidatesForDone(cn, rows, state) }).some((r) => r.sense_id === row.sense_id);
  assert.equal(status(canonical), 1);
  // Revision B deletes the approved target: the stale completion is hidden from status and re-offered by next.
  const deleted = without(approved.target_sense);
  assert.equal(status(deleted), 0);
  assert.equal(next(deleted), true);
  // The target still exists but the relation is now canonical, so retrieval no longer offers it: still done.
  const related = {
    ...canonical,
    canonicalRevision: 'e'.repeat(64),
    records: canonical.records.map((r) => (r.id !== row.record_id ? r : {
      ...r, senses: r.senses.map((s) => (s.id !== row.sense_id ? s : { ...s, relations: [{ target: approved.target, target_sense: approved.target_sense, type: 'association', note: n(), relevance: 4 }] })),
    })),
  };
  function n() { return '이미 반영된 관계이다.'; }
  const offered = candidateEvidence(retrievePacket(related, packet, { index: buildRelationIndex(related) }), buildRelationIndex(related)).get(row.sense_id);
  assert.ok(!offered.some((c) => c.id === approved.target_sense), 'the approved target is no longer a candidate');
  assert.equal(status(related), 1);
  assert.equal(next(related), false);
  // The approved target's lemma/gloss was edited and it is no longer a candidate: the approval is stale.
  const edited = { ...related, canonicalRevision: '9'.repeat(64), records: related.records.map((r) => ({ ...r, senses: r.senses.map((s) => (s.id === approved.target_sense ? { ...s, gloss: '완전히 달라진 뜻풀이.' } : s)) })) };
  assert.equal(status(edited), 0);
  assert.equal(next(edited), true);
  // The target id now belongs to a different record: fail closed.
  const reowned = { ...canonical, canonicalRevision: 'f'.repeat(64), records: canonical.records.map((r) => ({ ...r, senses: r.senses.map((s) => (s.id === approved.target_sense ? { ...s, id: `${r.id}-s9` } : s)) })) };
  assert.equal(status(reowned), 0);
});

test('a packet is one bounded unit: oversized, empty and repeated-sense packets are rejected without recording', () => {
  const state = newQueueState(canonical.canonicalRevision);
  const big = Array.from({ length: MAX_PACKET_SIZE + 1 }, (_, i) => ({ ...rows[0], sense_id: `w${i}-s1` }));
  assert.match(packetBoundErrors(big).join('\n'), /bound is 200/u);
  assert.match(packetBoundErrors([]).join('\n'), /non-empty/u);
  assert.match(packetBoundErrors([rows[0], rows[0]]).join('\n'), /repeats a sense/u);
  for (const bad of [[null], [undefined], ['w1-s1'], [[]], [{}], [{ sense_id: '' }], [{ sense_id: 7 }], [rows[0], null]]) {
    assert.match(packetBoundErrors(bad).join('\n'), /non-empty sense_id/u);
    const rejected = recordOutcomes(state, bad, [], { candidates: new Map(), index: buildRelationIndex(canonical), snapshotDigest: 'x' });
    assert.equal(rejected.state, state, 'a malformed row yields errors, never an exception or a state change');
  }
  assert.deepEqual(packetBoundErrors(Array.from({ length: MAX_PACKET_SIZE }, (_, i) => ({ sense_id: `w${i}-s1` }))), []);
  const result = recordOutcomes(state, big, [], { candidates: new Map(), index: buildRelationIndex(canonical), snapshotDigest: 'x' });
  assert.equal(result.state, state);
  assert.match(result.errors.join('\n'), /bound is 200/u);
});

test('malformed outcomes are contract errors that leave state untouched', () => {
  const state = newQueueState(canonical.canonicalRevision);
  const packet = nextPacket(rows, state, { limit: 1 });
  for (const bad of [null, {}, 'x', 7]) {
    const result = record(state, packet, bad);
    assert.equal(result.state, state);
    assert.match(result.errors.join('\n'), /outcomes must be a list/u);
  }
  for (const entry of [null, 'x', [], { sense_id: 7 }, {}]) {
    const result = record(state, packet, [entry]);
    assert.equal(result.state, state);
    assert.match(result.errors.join('\n'), /each outcome must be an object/u);
  }
});

test('malformed relation_amendments are contract errors, never exceptions, and leave state untouched', () => {
  const state = newQueueState(canonical.canonicalRevision);
  const packet = nextPacket(rows, state, { limit: 1 });
  const row = packet[0];
  const base = outcome(row);
  for (const bad of [{}, 'x', 7, null]) {
    const result = record(state, packet, [{ ...base, relation_amendments: bad }]);
    assert.equal(result.state, state);
    assert.match(result.errors.join('\n'), /relation_amendments must be a list|needs amendments/u, String(bad));
  }
  for (const item of [null, 'x', 7, [], {}, { ...base.relation_amendments[0], relation: null }, { ...base.relation_amendments[0], relation: 'near' }]) {
    const result = record(state, packet, [{ ...base, relation_amendments: [item] }]);
    assert.equal(result.state, state, JSON.stringify(item));
    assert.ok(result.errors.length > 0);
  }
});
