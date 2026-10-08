import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalRecordsBeforeFactoryAdmissions, restorePreFactoryDecisionSource, sha256Json, validateFactoryAdmissionLedger } from '../validate/semantic-audit.mjs';
import { loadCanonicalContext } from '../validate/canonical-context.mjs';
import { reviewedRelationId } from '../batch/authored-semantic-decision-source.mjs';
import { validateFactoryRepository } from '../factory/validate.mjs';
import { planRelationBackfill, writePlannedRecords } from '../factory/admission.mjs';
import { approvedAmendments, applyBackfill, packetTextFor } from './backfill-apply.mjs';
import { inventoryCanonicalSenses, newQueueState } from './backfill-queue.mjs';
import { buildRelationIndex } from './candidate-retrieval.mjs';

// #446 B through the real production path: real canonical records, the real semantic authority and the real ledger
// validator, applied in a scratch copy of the data files (the repository is never written).

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUTHORITY = 'data/validation/canonical-semantic-decision-source.json';

async function scratchRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'backfill-apply-'));
  await mkdir(path.join(root, 'data/validation'), { recursive: true });
  await cp(path.join(REPO, 'data/canonical'), path.join(root, 'data/canonical'), { recursive: true });
  await cp(path.join(REPO, AUTHORITY), path.join(root, AUTHORITY));
  // Factory batches are only read; link them instead of copying.
  for (const dir of ['data/candidates', 'data/reviews']) await symlink(path.join(REPO, dir), path.join(root, dir));
  return root;
}

const readRecords = async (root) => {
  const dir = path.join(root, 'data/canonical');
  const records = [];
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.jsonl')).sort()) {
    for (const line of (await readFile(path.join(dir, name), 'utf8')).split('\n')) if (line) records.push(JSON.parse(line));
  }
  return records;
};

// A queue entry as `record` stores it: the approved tuple bound to the source gloss and to the target's reviewed meaning.
function approvedEntry(index, sourceSenseId, relation, rationale) {
  const source = index.bySenseId.get(sourceSenseId);
  const target = index.bySenseId.get(relation.target_sense);
  return {
    outcome: 'relations-reviewed', gloss_sha256: sha256Json(source.gloss), rationale: 'x', relation_count: 1,
    approved_relations: [{ relation_id: reviewedRelationId(sourceSenseId, relation), relation, rationale }],
    reviewed_candidates: [{ id: relation.target_sense, meaning_sha256: sha256Json([target.lemma, target.gloss]) }],
  };
}

// A source sense whose relations already carry #396 relevance (the realistic pilot-record case) and an unrelated target.
function pickPair(index) {
  const source = index.senses.find((sense) => sense.relations.some((relation) => relation.relevance !== undefined));
  const related = new Set(source.relations.map((relation) => relation.target_sense));
  const target = index.senses.find((sense) => sense.record_id !== source.record_id && !related.has(sense.sense_id));
  return { source, target };
}

test('an approved relation is written once as a candidate-less backfill event that the real ledger accepts, and replays as a no-op', async () => {
  const canonical = await loadCanonicalContext();
  const index = buildRelationIndex(canonical);
  const row = inventoryCanonicalSenses(index);
  const { source, target } = pickPair(index);
  const sourceRow = row.find((item) => item.sense_id === source.sense_id);
  const relation = { target: target.record_id, target_sense: target.sense_id, type: 'association', note: '회귀 시험용 연상이다.', relevance: 5 };
  const rationale = `${source.record_id} ${source.sense_id}: 회귀 시험용 근거.`;
  const state = newQueueState(canonical.canonicalRevision);
  state.done[source.sense_id] = approvedEntry(index, source.sense_id, relation, `${source.record_id} ${source.sense_id}: 회귀 시험용 근거.`);
  const root = await scratchRoot();
  try {
    const before = await readRecords(root);
    const result = await applyBackfill({ root, state, index, refreshReports: false });
    assert.equal(result.status, 'applied');
    assert.equal(result.records_changed, 1);

    // Only the approved tuple was appended; nothing else in canonical changed, existing relations keep their order.
    const after = await readRecords(root);
    const changed = after.filter((record, i) => JSON.stringify(record) !== JSON.stringify(before[i]));
    assert.deepEqual(changed.map((record) => record.id), [source.record_id]);
    const oldSense = before.find((record) => record.id === source.record_id).senses.find((sense) => sense.id === source.sense_id);
    const newSense = changed[0].senses.find((sense) => sense.id === source.sense_id);
    assert.deepEqual(newSense.relations, [...oldSense.relations, relation]);

    // The real ledger validator accepts the event, and a relevance-free pre-factory snapshot still restores.
    const authority = JSON.parse(await readFile(path.join(root, AUTHORITY), 'utf8'));
    const event = authority.factory_admissions.at(-1);
    assert.match(event.batch_id, /^R\d{6}$/u);
    assert.deepEqual(event.entries, []);
    validateFactoryAdmissionLedger(authority, after.map((record) => ({ record })), 'backfill test');
    // The frozen pre-factory snapshot predates #396 relevance; rewinding the ledger must still land on it.
    const stripped = canonicalRecordsBeforeFactoryAdmissions(after.map((record) => ({ record })), authority).map(({ record }) => ({
      record: { ...record, senses: record.senses.map(({ relations, ...rest }) => (relations
        ? { ...rest, relations: relations.map(({ relevance, ...tuple }) => tuple) } : rest)) },
    }));
    assert.doesNotThrow(() => restorePreFactoryDecisionSource(authority, stripped));

    // Exact replay is idempotent: the applied tuple is present, so nothing is written or recorded again.
    const replay = await applyBackfill({ root, state, index: buildRelationIndex({ ...canonical, records: after }), refreshReports: false });
    assert.equal(replay.status, 'nothing-to-apply');
    assert.equal(JSON.parse(await readFile(path.join(root, AUTHORITY), 'utf8')).factory_admissions.length, authority.factory_admissions.length);

    // A different note for the same target is a conflict and is rejected, not rewritten.
    const conflicting = structuredClone(state);
    conflicting.done[source.sense_id] = approvedEntry(index, source.sense_id, { ...relation, note: '다른 설명이다.' }, rationale);
    await assert.rejects(
      applyBackfill({ root, state: conflicting, index: buildRelationIndex({ ...canonical, records: after }), refreshReports: false }),
      /does not rewrite existing relations/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a backfill onto a Stage 3-created record still passes the real factory history and relation checks', async () => {
  const canonical = await loadCanonicalContext();
  const index = buildRelationIndex(canonical);
  const manifest = JSON.parse(await readFile(path.join(REPO, 'data/reviews/C000003/manifest.json'), 'utf8'));
  const created = manifest.admission.changes.find((change) => change.operation === 'create');
  const source = index.senses.find((sense) => sense.record_id === created.entry_id);
  const target = index.senses.find((sense) => sense.record_id !== source.record_id && !source.relations.some((relation) => relation.target_sense === sense.sense_id));
  const relation = { target: target.record_id, target_sense: target.sense_id, type: 'association', note: '회귀 시험용 연상이다.', relevance: 5 };
  const state = newQueueState(canonical.canonicalRevision);
  state.done[source.sense_id] = approvedEntry(index, source.sense_id, relation, `${source.record_id} ${source.sense_id}: 회귀 시험용 근거.`);
  const root = await scratchRoot();
  try {
    // The scratch root lacks some unrelated data files, so compare against its own baseline: the backfill adds nothing.
    const baseline = await validateFactoryRepository({ root });
    assert.equal((await applyBackfill({ root, state, index, refreshReports: false })).status, 'applied');
    assert.deepEqual(await validateFactoryRepository({ root }), baseline);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function oneApproval(canonical, index) {
  const { source, target } = pickPair(index);
  const relation = { target: target.record_id, target_sense: target.sense_id, type: 'association', note: '회귀 시험용 연상이다.', relevance: 5 };
  const state = newQueueState(canonical.canonicalRevision);
  state.done[source.sense_id] = approvedEntry(index, source.sense_id, relation, `${source.record_id} ${source.sense_id}: 회귀 시험용 근거.`);
  return { source, target, state };
}

async function planOnDisk(root, state, index, packetId = 'R000001') {
  const records = await readRecords(root);
  const recordPathById = new Map();
  for (const name of await readdir(path.join(root, 'data/canonical'))) {
    for (const line of (await readFile(path.join(root, 'data/canonical', name), 'utf8')).split('\n')) if (line) recordPathById.set(JSON.parse(line).id, `data/canonical/${name}`);
  }
  const { amendments } = approvedAmendments(state, index);
  const plan = planRelationBackfill({ packetId, amendments, canonicalRecords: records, recordPathById });
  const packet = packetTextFor(packetId, amendments, state);
  return { plan, packet, amendments };
}

const authorityEvents = async (root) => JSON.parse(await readFile(path.join(root, AUTHORITY), 'utf8')).factory_admissions.length;

test('a run interrupted after the packet (and optionally the canonical write) is finished by running apply again', async () => {
  const canonical = await loadCanonicalContext();
  const index = buildRelationIndex(canonical);
  const { source, target, state } = oneApproval(canonical, index);
  for (const writeCanonical of [false, true]) {
    const root = await scratchRoot();
    try {
      const baseline = await validateFactoryRepository({ root });
      const { plan, packet } = await planOnDisk(root, state, index);
      await mkdir(path.join(root, 'data/relation-backfill'), { recursive: true });
      await writeFile(path.join(root, 'data/relation-backfill/R000001.json'), packet);
      if (writeCanonical) await writePlannedRecords(plan, root);
      // An interrupted atomic write leaves only a partial temp file, which is never read as a packet.
      await writeFile(path.join(root, 'data/relation-backfill/R000002.json.tmp'), '{"packet_id": "R0000');
      const eventsBefore = await authorityEvents(root);

      const result = await applyBackfill({ root, state, index, refreshReports: false });
      assert.deepEqual(result.packets, ['R000001']);
      assert.equal(await authorityEvents(root), eventsBefore + 1);
      assert.equal(await readFile(path.join(root, 'data/relation-backfill/R000001.json'), 'utf8'), packet, 'the intent packet is kept as written');
      const sense = (await readRecords(root)).find((record) => record.id === source.record_id).senses.find((item) => item.id === source.sense_id);
      assert.equal(sense.relations.filter((item) => item.target_sense === target.sense_id).length, 1, 'the tuple is not duplicated');
      assert.deepEqual(await validateFactoryRepository({ root }), baseline);
      assert.equal((await applyBackfill({ root, state, index, refreshReports: false })).status, 'nothing-to-apply');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('an exact tuple that is already present without any packet is a no-op, not an interrupted apply', async () => {
  const canonical = await loadCanonicalContext();
  const index = buildRelationIndex(canonical);
  const { state } = oneApproval(canonical, index);
  const root = await scratchRoot();
  try {
    // Another canonical change added the identical tuple before this approval was applied.
    const { plan } = await planOnDisk(root, state, index);
    await writePlannedRecords(plan, root);
    const recordsBefore = await readRecords(root);
    const eventsBefore = await authorityEvents(root);
    assert.equal((await applyBackfill({ root, state, index, refreshReports: false })).status, 'nothing-to-apply');
    assert.deepEqual(await readRecords(root), recordsBefore);
    assert.equal(await authorityEvents(root), eventsBefore);
    await assert.rejects(readFile(path.join(root, 'data/relation-backfill/R000001.json')), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a partial temp packet from an interrupted write is ignored, and a backfill event whose packet file is missing fails closed', async () => {
  const canonical = await loadCanonicalContext();
  const index = buildRelationIndex(canonical);
  const { state } = oneApproval(canonical, index);
  const root = await scratchRoot();
  try {
    // A previous run died while writing the packet: only the partial temp file exists, so a normal apply still works.
    await mkdir(path.join(root, 'data/relation-backfill'), { recursive: true });
    await writeFile(path.join(root, 'data/relation-backfill/R000001.json.tmp'), '{"packet_id": "R0000');
    const result = await applyBackfill({ root, state, index, refreshReports: false });
    assert.deepEqual(result.packets, ['R000001']);
    JSON.parse(await readFile(path.join(root, 'data/relation-backfill/R000001.json'), 'utf8'));
    await rm(path.join(root, 'data/relation-backfill', `${result.packets[0]}.json`));
    await assert.rejects(applyBackfill({ root, state, index, refreshReports: false }), /has no committed packet file/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an approval whose target meaning changed since review is stale: nothing is written, the queue re-reviews it', async () => {
  const canonical = await loadCanonicalContext();
  const index = buildRelationIndex(canonical);
  const { state, target } = oneApproval(canonical, index);
  const changed = buildRelationIndex({ ...canonical, records: canonical.records.map((info) => (info.record.id !== target.record_id ? info
    : { ...info, record: { ...info.record, senses: info.record.senses.map((sense) => (sense.id === target.sense_id ? { ...sense, gloss: `${sense.gloss} (뜻이 바뀜)` } : sense)) } })) });
  const root = await scratchRoot();
  try {
    const recordsBefore = await readRecords(root);
    const eventsBefore = await authorityEvents(root);
    const result = await applyBackfill({ root, state, index: changed, refreshReports: false });
    assert.equal(result.status, 'nothing-to-apply');
    assert.equal(result.stale.length, 1);
    assert.deepEqual(await readRecords(root), recordsBefore);
    assert.equal(await authorityEvents(root), eventsBefore);
    // Positive control: with the reviewed target meaning unchanged the same approval is applied.
    assert.equal((await applyBackfill({ root, state, index, refreshReports: false })).status, 'applied');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an altered committed packet no longer matches its event: apply and the factory validator both reject it', async () => {
  const canonical = await loadCanonicalContext();
  const index = buildRelationIndex(canonical);
  const { state } = oneApproval(canonical, index);
  const root = await scratchRoot();
  try {
    const baseline = await validateFactoryRepository({ root });
    const { packets: [id] } = await applyBackfill({ root, state, index, refreshReports: false });
    assert.deepEqual(await validateFactoryRepository({ root }), baseline, 'the genuine packet validates');
    const file = path.join(root, 'data/relation-backfill', `${id}.json`);
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('회귀 시험용 근거', '회귀 시험용 근거!'));
    await assert.rejects(applyBackfill({ root, state, index, refreshReports: false }), /does not match its semantic authority event/u);
    assert.ok((await validateFactoryRepository({ root })).some((error) => /does not match its semantic authority event/u.test(error)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resuming an interrupted packet re-checks the approved target meaning: a changed target is refused, an unchanged one resumes', async () => {
  const canonical = await loadCanonicalContext();
  const index = buildRelationIndex(canonical);
  const { state, target } = oneApproval(canonical, index);
  const changed = buildRelationIndex({ ...canonical, records: canonical.records.map((info) => (info.record.id !== target.record_id ? info
    : { ...info, record: { ...info.record, senses: info.record.senses.map((sense) => (sense.id === target.sense_id ? { ...sense, gloss: `${sense.gloss} (뜻이 바뀜)` } : sense)) } })) });
  const root = await scratchRoot();
  try {
    const { packet } = await planOnDisk(root, state, index);
    await mkdir(path.join(root, 'data/relation-backfill'), { recursive: true });
    await writeFile(path.join(root, 'data/relation-backfill/R000001.json'), packet);
    const recordsBefore = await readRecords(root);
    const eventsBefore = await authorityEvents(root);
    await assert.rejects(applyBackfill({ root, state, index: changed, refreshReports: false }), /changed meaning since approval/u);
    assert.deepEqual(await readRecords(root), recordsBefore);
    assert.equal(await authorityEvents(root), eventsBefore);
    assert.equal((await applyBackfill({ root, state, index, refreshReports: false })).status, 'applied', 'positive control: unchanged meaning resumes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
