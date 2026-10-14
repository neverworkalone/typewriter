import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCanonicalSemanticAudit, canonicalRecordsBeforeFactoryAdmissions, continuesPreviousChange, preRelevanceRecordSha256, restorePreFactoryDecisionSource, readSemanticAuditArtifact, sha256Json, validateFactoryAdmissionLedger, validateSemanticAuditCoverage } from '../validate/semantic-audit.mjs';
import { validateDatasetDirectory, validateDatasetRecords } from '../validate/dataset-integrity.mjs';
import { loadCanonicalContext as loadCanonicalContextFrom, readCanonicalContext, writeCanonicalContext } from '../validate/canonical-context.mjs';
import { reviewedRelationId } from '../batch/authored-semantic-decision-source.mjs';
import { validateFactoryRepository } from '../factory/validate.mjs';
import { planRelationBackfill, targetMeaningSha256, writePlannedRecords } from '../factory/admission.mjs';
import { approvedAmendments, applyBackfill, applyRelationCorrections, completedPacketId, correctionItemsFor, nextPacketId, packetTextFor } from './backfill-apply.mjs';
import { inventoryCanonicalSenses, newQueueState } from './backfill-queue.mjs';
import { buildRelationIndex } from './candidate-retrieval.mjs';
import { copyShardedAuthority, readShardedJson } from '../../tests/helpers/sharded-authority.mjs';
import { syntheticCanonicalBase } from '../../tests/helpers/synthetic-canonical-base.mjs';

// #446 B through the real production path: a synthetic canonical base admitted by the real Stage 3 authority, and the real
// ledger validator, applied in a scratch copy of the data files (nothing in the repository is written).

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUTHORITY = 'data/validation/canonical-semantic-decision-source.json';

const BASE = await syntheticCanonicalBase();
const loadCanonicalContext = () => loadCanonicalContextFrom({ directory: path.join(BASE.root, 'data/canonical') });

async function scratchRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'backfill-apply-'));
  await mkdir(path.join(root, 'data/validation'), { recursive: true });
  await cp(path.join(BASE.root, 'data/canonical'), path.join(root, 'data/canonical'), { recursive: true });
  await copyShardedAuthority(path.join(BASE.root, AUTHORITY), path.join(root, AUTHORITY));
  for (const name of ['m6-2-inflection-exceptions.json', 'm6-3-surface-form-review.json']) await cp(path.join(BASE.root, 'data/validation', name), path.join(root, 'data/validation', name));
  for (const dir of ['data/candidates', 'data/reviews', 'data/relation-backfill']) await mkdir(path.join(root, dir), { recursive: true });
  return root;
}

// The packet id the next apply allocates, so tests hold whatever backfills the real ledger already contains.
const nextId = async (root) => nextPacketId((await readShardedJson(path.join(root, AUTHORITY))).factory_admissions ?? []);

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
    const authority = (await readShardedJson(path.join(root, AUTHORITY)));
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
    assert.equal((await readShardedJson(path.join(root, AUTHORITY))).factory_admissions.length, authority.factory_admissions.length);

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
  const ledger = await readShardedJson(path.join(BASE.root, AUTHORITY));
  const created = ledger.factory_admissions[0].changes.find((change) => change.operation === 'create');
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

async function planOnDisk(root, state, index, packetId = null) {
  packetId ??= await nextId(root);
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

const authorityEvents = async (root) => (await readShardedJson(path.join(root, AUTHORITY))).factory_admissions.length;

test('a run interrupted after the packet (and optionally the canonical write) is finished by running apply again', async () => {
  const canonical = await loadCanonicalContext();
  const index = buildRelationIndex(canonical);
  const { source, target, state } = oneApproval(canonical, index);
  for (const writeCanonical of [false, true]) {
    const root = await scratchRoot();
    try {
      const baseline = await validateFactoryRepository({ root });
      const { plan, packet } = await planOnDisk(root, state, index);
      const id = await nextId(root);
      await mkdir(path.join(root, 'data/relation-backfill'), { recursive: true });
      await writeFile(path.join(root, `data/relation-backfill/${id}.json`), packet);
      if (writeCanonical) await writePlannedRecords(plan, root);
      // An interrupted atomic write leaves only a partial temp file, which is never read as a packet.
      await writeFile(path.join(root, 'data/relation-backfill/R999999.json.tmp'), '{"packet_id": "R0000');
      const eventsBefore = await authorityEvents(root);

      const result = await applyBackfill({ root, state, index, refreshReports: false });
      assert.deepEqual(result.packets, [id]);
      assert.equal(await authorityEvents(root), eventsBefore + 1);
      assert.equal(await readFile(path.join(root, `data/relation-backfill/${id}.json`), 'utf8'), packet, 'the intent packet is kept as written');
      const sense = (await readRecords(root)).find((record) => record.id === source.record_id).senses.find((item) => item.id === source.sense_id);
      assert.equal(sense.relations.filter((item) => item.target_sense === target.sense_id).length, 1, 'the tuple is not duplicated');
      assert.deepEqual(await validateFactoryRepository({ root }), baseline);
      assert.equal((await applyBackfill({ root, state, index, refreshReports: false })).status, 'nothing-to-apply');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('an approval retyped by a committed correction is not resurrected, while an independent type for the same target is still written', async () => {
  const canonical = await loadCanonicalContext();
  const index = buildRelationIndex(canonical);
  const { source, target, state } = oneApproval(canonical, index);
  const approved = state.done[source.sense_id].approved_relations[0].relation;
  const root = await scratchRoot();
  try {
    assert.equal((await applyBackfill({ root, state, index, refreshReports: false })).status, 'applied');
    const applied = await readRecords(root);
    const meaning = targetMeaningSha256(new Map(applied.map((record) => [record.id, record])), target.sense_id);
    const direct = { target: target.record_id, target_sense: target.sense_id, type: 'direct', note: approved.note };
    const proposal = {
      source_sense_id: source.sense_id, previous_relation: approved, target_meaning_sha256: meaning, relation: direct,
      rationale: `${source.record_id} ${source.sense_id}: 회귀 시험용 근거로 유형을 바로잡는다.`,
    };
    const correction = await applyRelationCorrections({ root, proposals: [proposal], refreshReports: false });
    assert.equal(correction.status, 'applied');
    const retyped = await readRecords(root);
    const eventsBefore = await authorityEvents(root);
    // The old approval (the association tuple) is gone from canonical but must not come back beside the direct one.
    const replay = await applyBackfill({ root, state, index: buildRelationIndex({ ...canonical, records: retyped }), refreshReports: false });
    assert.equal(replay.status, 'nothing-to-apply');
    assert.deepEqual(await readRecords(root), retyped);
    assert.equal(await authorityEvents(root), eventsBefore);

    // A review made after that correction, approving the same tuple again, is a newer decision and is written and recorded.
    const rereviewed = structuredClone(state);
    rereviewed.done[source.sense_id].recorded_after_packet = correction.packets.at(-1);
    const again = await applyBackfill({ root, state: rereviewed, index: buildRelationIndex({ ...canonical, records: retyped }), refreshReports: false });
    assert.equal(again.status, 'applied');
    assert.equal(again.relations_appended, 1);
    assert.equal(await authorityEvents(root), eventsBefore + 1);
    const restored = await readRecords(root);

    // Positive control: an independently approved different type for the same target is a separate tuple and is written.
    const independent = newQueueState(canonical.canonicalRevision);
    const near = { target: target.record_id, target_sense: target.sense_id, type: 'near', note: '회귀 시험용 말의 결이다.', relevance: 4 };
    independent.done[source.sense_id] = approvedEntry(index, source.sense_id, near, `${source.record_id} ${source.sense_id}: 회귀 시험용 근거.`);
    const result = await applyBackfill({ root, state: independent, index: buildRelationIndex({ ...canonical, records: restored }), refreshReports: false });
    assert.equal(result.status, 'applied');
    assert.equal(result.relations_appended, 1);
    const sense = (await readRecords(root)).find((record) => record.id === source.record_id).senses.find(({ id }) => id === source.sense_id);
    assert.deepEqual(sense.relations.filter((relation) => relation.target_sense === target.sense_id).map((relation) => relation.type).sort(), ['association', 'direct', 'near']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the review marker ignores an interrupted correction packet, so resuming it still retires the older approval', async () => {
  const canonical = await loadCanonicalContext();
  const index = buildRelationIndex(canonical);
  const { source, target, state } = oneApproval(canonical, index);
  const approved = state.done[source.sense_id].approved_relations[0].relation;
  const root = await scratchRoot();
  try {
    assert.equal((await applyBackfill({ root, state, index, refreshReports: false })).status, 'applied');
    const applied = await readRecords(root);
    const direct = { target: target.record_id, target_sense: target.sense_id, type: 'direct', note: approved.note };
    const items = correctionItemsFor(applied, [{
      source_sense_id: source.sense_id, previous_relation: approved, relation: direct,
      target_meaning_sha256: targetMeaningSha256(new Map(applied.map((record) => [record.id, record])), target.sense_id),
      rationale: `${source.record_id} ${source.sense_id}: 회귀 시험용 근거로 유형을 바로잡는다.`,
    }]);
    // Only the intent file exists: no canonical change and no authority event, as after a crash.
    const interrupted = await nextId(root);
    const dir = path.join(root, 'data/relation-backfill');
    await writeFile(path.join(dir, `${interrupted}.json`), `${JSON.stringify({ packet_id: interrupted, relation_corrections: items }, null, 1)}\n`);
    const marker = await completedPacketId(root);
    assert.notEqual(marker, interrupted);
    // A review recorded now (same canonical revision) carries the completed marker, never the unfinished file's id.
    const reviewed = structuredClone(state);
    reviewed.done[source.sense_id].recorded_after_packet = marker;
    const result = await applyBackfill({ root, state: reviewed, index: buildRelationIndex({ ...canonical, records: applied }), refreshReports: false });
    assert.deepEqual(result.packets, [interrupted]);
    const sense = (await readRecords(root)).find((record) => record.id === source.record_id).senses.find(({ id }) => id === source.sense_id);
    assert.deepEqual(sense.relations.filter((relation) => relation.target_sense === target.sense_id).map((relation) => relation.type), ['direct']);
  } finally {
    await rm(root, { recursive: true, force: true });
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
    await assert.rejects(readFile(path.join(root, `data/relation-backfill/${await nextId(root)}.json`)), /ENOENT/u);
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
    const id = await nextId(root);
    await mkdir(path.join(root, 'data/relation-backfill'), { recursive: true });
    await writeFile(path.join(root, `data/relation-backfill/${id}.json.tmp`), '{"packet_id": "R0000');
    const result = await applyBackfill({ root, state, index, refreshReports: false });
    assert.deepEqual(result.packets, [id]);
    JSON.parse(await readFile(path.join(root, `data/relation-backfill/${id}.json`), 'utf8'));
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
    await writeFile(path.join(root, `data/relation-backfill/${await nextId(root)}.json`), packet);
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

test('an unclassified source is never written: a stored approval is skipped and an unwritten packet is refused, an eligible source still applies', async () => {
  const canonical = await loadCanonicalContext();
  const index = buildRelationIndex(canonical);
  const { state } = oneApproval(canonical, index);
  const [sourceId] = Object.keys(state.done);
  const unclassified = buildRelationIndex({ ...canonical, records: canonical.records.map((info) => ({ ...info, record: { ...info.record,
    senses: info.record.senses.map((sense) => (sense.id === sourceId ? { ...sense, pos: 'unclassified' } : sense)) } })) });
  const root = await scratchRoot();
  try {
    const recordsBefore = await readRecords(root);
    const eventsBefore = await authorityEvents(root);
    const skipped = await applyBackfill({ root, state, index: unclassified, refreshReports: false });
    assert.equal(skipped.status, 'nothing-to-apply');
    assert.deepEqual(skipped.stale, [sourceId]);
    const { packet } = await planOnDisk(root, state, index);
    await writeFile(path.join(root, `data/relation-backfill/${await nextId(root)}.json`), packet);
    await assert.rejects(applyBackfill({ root, state, index: unclassified, refreshReports: false }), /unclassified sense/u);
    assert.deepEqual(await readRecords(root), recordsBefore);
    assert.equal(await authorityEvents(root), eventsBefore);
    assert.equal((await applyBackfill({ root, state, index, refreshReports: false })).status, 'applied', 'positive control: eligible source resumes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unrecorded packet whose canonical write already happened is not completed for an unclassified source', async () => {
  const canonical = await loadCanonicalContext();
  const index = buildRelationIndex(canonical);
  const { state } = oneApproval(canonical, index);
  const [sourceId] = Object.keys(state.done);
  const unclassified = buildRelationIndex({ ...canonical, records: canonical.records.map((info) => ({ ...info, record: { ...info.record,
    senses: info.record.senses.map((sense) => (sense.id === sourceId ? { ...sense, pos: 'unclassified' } : sense)) } })) });
  const root = await scratchRoot();
  try {
    const { plan, packet } = await planOnDisk(root, state, index);
    await writeFile(path.join(root, `data/relation-backfill/${await nextId(root)}.json`), packet);
    await writePlannedRecords(plan, root);
    const eventsBefore = await authorityEvents(root);
    await assert.rejects(applyBackfill({ root, state, index: unclassified, refreshReports: false }), /unclassified sense/u);
    assert.equal(await authorityEvents(root), eventsBefore, 'no completion event for an unclassified source');
    assert.equal((await applyBackfill({ root, state, index, refreshReports: false })).status, 'applied', 'positive control: eligible source completes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
