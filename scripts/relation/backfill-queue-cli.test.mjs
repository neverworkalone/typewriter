import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Real queue -> CLI record/read path on the live canonical (derived dynamically, so it stays valid as canonical grows).
const CLI = path.resolve(import.meta.dirname, 'backfill-queue-cli.mjs');
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('CLI record verifies approved targets, preserves them across a restart, and rejects off-pool targets', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'backfill-cli-'));
  try {
    const state = path.join(dir, 'state.json');
    const packetPath = path.join(dir, 'packet.json');
    const next = run(['next', '--limit', '2', '--state', state, '--out', packetPath]);
    assert.equal(next.status, 0, next.stderr);
    const packetFile = JSON.parse(await readFile(packetPath, 'utf8'));
    const [row] = packetFile.packet;
    const [source, second] = packetFile.candidates.sources;
    const pick = source.candidates.find((candidate) => candidate.target.kind === 'canonical');
    assert.ok(pick, 'live canonical offers at least one candidate for the first queued sense');
    const outcome = (relation, rationale = `${row.sense_id}: 후보를 검토했다.`) => [{
      sense_id: row.sense_id, outcome: 'relations-reviewed', rationale,
      relation_amendments: [{
        source_record_id: row.record_id, source_sense_id: row.sense_id, source_gloss_sha256: row.gloss_sha256,
        relation: { type: 'association', note: '필자가 떠올릴 만한 연상이다.', relevance: 4, ...relation },
        rationale: `${row.record_id} ${row.sense_id}: 연상으로 이어진다.`,
      }],
    }];
    const outcomesPath = path.join(dir, 'outcomes.json');
    const record = async (outcomes) => { await writeFile(outcomesPath, JSON.stringify(outcomes)); return run(['record', packetPath, outcomesPath, '--state', state]); };

    const missing = await record(outcome({ target: 'w99999', target_sense: 'w99999-s1' }));
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /not a canonical sense/u);
    const wrongRecord = await record(outcome({ target: row.record_id, target_sense: pick.target.sense_id }));
    assert.notEqual(wrongRecord.status, 0);
    assert.match(wrongRecord.stderr, /does not own target_sense|own source/u);
    const pool = new Set(source.candidates.map((candidate) => candidate.target.sense_id));
    const offPool = second.candidates.find((candidate) => candidate.target.kind === 'canonical' && !pool.has(candidate.target.sense_id) && candidate.target.record_id !== row.record_id);
    assert.ok(offPool, 'the second queued sense offers a canonical target the first never saw');
    const off = await record(outcome({ target: offPool.target.record_id, target_sense: offPool.target.sense_id }));
    assert.notEqual(off.status, 0);
    assert.match(off.stderr, /not among the reviewed candidates/u);
    await assert.rejects(readFile(state, 'utf8'), 'a rejected record never writes state');

    const ok = await record(outcome({ target: pick.target.record_id, target_sense: pick.target.sense_id }));
    assert.equal(ok.status, 0, ok.stderr);
    const saved = JSON.parse(await readFile(state, 'utf8')).done[row.sense_id];
    assert.equal(saved.approved_relations.length, 1);
    assert.equal(saved.approved_relations[0].relation.target_sense, pick.target.sense_id);
    assert.equal(saved.approved_relations[0].relation.relevance, 4);
    assert.equal(saved.canonical_snapshot_digest, packetFile.candidates.canonical_snapshot_digest);

    // Restart: a fresh process reads the preserved state; the completed sense is current and no longer queued.
    const status = JSON.parse(execFileSync(process.execPath, [CLI, 'status', '--state', state], { encoding: 'utf8' }));
    assert.equal(status.completed, 1);
    const again = run(['next', '--limit', '1', '--state', state, '--out', path.join(dir, 'packet2.json')]);
    assert.equal(again.status, 0, again.stderr);
    assert.notEqual(JSON.parse(await readFile(path.join(dir, 'packet2.json'), 'utf8')).packet[0].sense_id, row.sense_id);

    // One record call is one bounded unit: a packet of more than 200 distinct canonical senses is refused before any
    // retrieval, and the existing state stays byte-for-byte as it was.
    const live = await readFile(state, 'utf8');
    const ids = JSON.parse(execFileSync(process.execPath, ['-e', `import('${path.resolve(import.meta.dirname, '../validate/canonical-context.mjs')}').then(async (m) => { const c = await m.loadCanonicalContext(); console.log(JSON.stringify({ rev: c.canonicalRevision, ids: c.records.flatMap((i) => i.record.senses.map((s) => s.id)).slice(0, 201) })); })`], { encoding: 'utf8' }));
    assert.equal(new Set(ids.ids).size, 201);
    const hugePath = path.join(dir, 'huge.json');
    await writeFile(hugePath, JSON.stringify({ canonical_revision: ids.rev, packet: ids.ids.map((sense_id) => ({ sense_id })) }));
    const huge = run(['record', hugePath, outcomesPath, '--state', state]);
    assert.notEqual(huge.status, 0);
    assert.match(huge.stderr, /the bound is 200/u);
    assert.equal(await readFile(state, 'utf8'), live, 'an oversized packet never touches state');

    const nullPath = path.join(dir, 'null.json');
    await writeFile(nullPath, JSON.stringify({ canonical_revision: ids.rev, packet: [null] }));
    const malformed = run(['record', nullPath, outcomesPath, '--state', state]);
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /non-empty sense_id/u);
    assert.doesNotMatch(malformed.stderr, /TypeError/u, 'a malformed row is a contract error, not an exception');
    assert.equal(await readFile(state, 'utf8'), live);

    const rejectInput = async (name, packetBody, outcomesBody, pattern) => {
      const packetFilePath = path.join(dir, `${name}-packet.json`);
      const outcomesFilePath = path.join(dir, `${name}-outcomes.json`);
      await writeFile(packetFilePath, packetBody);
      await writeFile(outcomesFilePath, outcomesBody);
      const result = run(['record', packetFilePath, outcomesFilePath, '--state', state]);
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, pattern, name);
      assert.doesNotMatch(result.stderr, /TypeError|at file:/u, `${name}: an input error, not a runtime exception`);
      assert.equal(await readFile(state, 'utf8'), live, `${name}: state untouched`);
    };
    const goodPacket = JSON.stringify(packetFile);
    await rejectInput('null-packet', 'null', '[]', /object with a packet list/u);
    await rejectInput('array-packet', '[]', '[]', /object with a packet list/u);
    await rejectInput('no-list', JSON.stringify({ canonical_revision: ids.rev }), '[]', /object with a packet list/u);
    await rejectInput('null-outcomes', goodPacket, 'null', /list of outcomes/u);
    await rejectInput('object-outcomes', goodPacket, '{}', /list of outcomes/u);
    await rejectInput('not-json', goodPacket, '{oops', /not JSON/u);

    // A corrupt or unreadable state file must stop the command and must never be replaced by an empty state.
    const before = await readFile(state, 'utf8');
    await writeFile(state, `${before.slice(0, 40)}`);
    const truncated = await readFile(state, 'utf8');
    for (const args of [['status'], ['next', '--limit', '1'], ['record', packetPath, outcomesPath]]) {
      const result = run([...args, '--state', state]);
      assert.notEqual(result.status, 0, args[0]);
      assert.match(result.stderr, /unreadable or corrupt/u);
      assert.equal(await readFile(state, 'utf8'), truncated, 'the damaged file is left exactly as found');
    }
    await writeFile(state, JSON.stringify({ contract: 'something-else', done: {} }));
    assert.match(run(['status', '--state', state]).stderr, /does not match/u);
    await writeFile(state, before);

    // A different relevance is different persistent evidence.
    const otherState = path.join(dir, 'other.json');
    await writeFile(outcomesPath, JSON.stringify(outcome({ target: pick.target.record_id, target_sense: pick.target.sense_id, relevance: 2 })));
    assert.equal(run(['record', packetPath, outcomesPath, '--state', otherState]).status, 0);
    const other = JSON.parse(await readFile(otherState, 'utf8')).done[row.sense_id];
    assert.notEqual(other.approved_relations[0].relation_id, saved.approved_relations[0].relation_id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
