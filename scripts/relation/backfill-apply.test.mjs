import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCanonicalSemanticAudit, canonicalRecordsBeforeFactoryAdmissions, continuesPreviousChange, preRelevanceRecordSha256, restorePreFactoryDecisionSource, readSemanticAuditArtifact, sha256Json, validateFactoryAdmissionLedger, validateSemanticAuditCoverage } from '../validate/semantic-audit.mjs';
import { validateDatasetDirectory, validateDatasetRecords } from '../validate/dataset-integrity.mjs';
import { loadCanonicalContext, readCanonicalContext, writeCanonicalContext } from '../validate/canonical-context.mjs';
import { reviewedRelationId } from '../batch/authored-semantic-decision-source.mjs';
import { validateFactoryRepository } from '../factory/validate.mjs';
import { planRelationBackfill, targetMeaningSha256, writePlannedRecords } from '../factory/admission.mjs';
import { approvedAmendments, applyBackfill, applyRelationCorrections, nextPacketId, packetTextFor } from './backfill-apply.mjs';
import { inventoryCanonicalSenses, newQueueState } from './backfill-queue.mjs';
import { buildRelationIndex } from './candidate-retrieval.mjs';
import { copyShardedAuthority, readShardedJson } from '../../tests/helpers/sharded-authority.mjs';

// #446 B through the real production path: real canonical records, the real semantic authority and the real ledger
// validator, applied in a scratch copy of the data files (the repository is never written).

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUTHORITY = 'data/validation/canonical-semantic-decision-source.json';

async function scratchRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'backfill-apply-'));
  await mkdir(path.join(root, 'data/validation'), { recursive: true });
  await cp(path.join(REPO, 'data/canonical'), path.join(root, 'data/canonical'), { recursive: true });
  await copyShardedAuthority(path.join(REPO, AUTHORITY), path.join(root, AUTHORITY));
  // Factory batches are only read; link them instead of copying.
  for (const dir of ['data/candidates', 'data/reviews']) await symlink(path.join(REPO, dir), path.join(root, dir));
  // Packets already committed for earlier backfills belong to the copied ledger; a test applies on top of them.
  await cp(path.join(REPO, 'data/relation-backfill'), path.join(root, 'data/relation-backfill'), { recursive: true }).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
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

// Keep the regression tied to the immutable pre-#396 admission and first backfill, even after later batches append a
// newer ledger change for that record. Check the real authority transition with the shared continuity rule instead of
// depending on a relevance-only digest mismatch still existing in today's canonical.
test('a historical backfill in the real ledger continues a pre-relevance admission', async () => {
  const authority = (await readShardedJson(path.join(REPO, AUTHORITY)));
  const events = authority.factory_admissions ?? [];
  let transition;
  for (let eventIndex = 1; eventIndex < events.length && !transition; eventIndex += 1) {
    const event = events[eventIndex];
    if (!/^R\d{6}$/u.test(event.batch_id ?? '')) continue;
    for (const change of event.changes ?? []) {
      if (change.operation !== 'append_relations' || !change.previous_record || !change.previous_semantic_review) continue;
      let previous;
      let previousEvent;
      for (let earlierIndex = eventIndex - 1; earlierIndex >= 0 && !previous; earlierIndex -= 1) {
        const match = (events[earlierIndex].changes ?? []).find((candidate) => candidate.entry_id === change.entry_id);
        if (match) { previous = match; previousEvent = events[earlierIndex]; }
      }
      if (!previous || sha256Json(change.previous_record) === previous.after_sha256
        || preRelevanceRecordSha256(change.previous_record) !== previous.after_sha256) continue;
      if (sha256Json({ ...change.previous_semantic_review, record_sha256: previous.after_sha256 }) !== previous.semantic_review_sha256) continue;
      transition = { event, change, previousEvent, previous };
      break;
    }
  }
  assert.ok(transition, 'the real factory ledger contains a first relation backfill across pre-relevance drift');

  const { change, previous } = transition;
  assert.equal(continuesPreviousChange(change, previous), true);
  const rewritten = structuredClone(change);
  rewritten.previous_record.senses[0].gloss += ' (rewritten)';
  assert.equal(continuesPreviousChange(rewritten, previous), false, 'the same real transition still rejects non-relevance drift');
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

// A record with pre-relevance correction history, amended by a relation-only backfill, through the shared consumers
// (complete-canonical coverage and dataset validation): the ledger travels with the audit, and a rewritten correction
// digest still breaks the chain.
test('a relation-only backfill of a record with correction history passes the shared audit consumers and still rejects a rewritten correction', async () => {
  const canonical = await loadCanonicalContext();
  const index = buildRelationIndex(canonical);
  const authority = (await readShardedJson(path.join(REPO, AUTHORITY)));
  const corrected = new Set(authority.authored_review.review_pass.correction_history.map((item) => item.record_id));
  const source = index.senses.find((sense) => corrected.has(sense.record_id));
  assert.ok(source, 'the live canonical has a record with correction history');
  const related = new Set(source.relations.map((relation) => relation.target_sense));
  const target = index.senses.find((sense) => sense.record_id !== source.record_id && !related.has(sense.sense_id));
  const relation = { target: target.record_id, target_sense: target.sense_id, type: 'association', note: '회귀 시험용 연상이다.', relevance: 4 };
  const state = newQueueState(canonical.canonicalRevision);
  state.done[source.sense_id] = approvedEntry(index, source.sense_id, relation, `${source.record_id} ${source.sense_id}: 회귀 시험용 근거.`);
  const root = await scratchRoot();
  try {
    assert.equal((await applyBackfill({ root, state, index, refreshReports: false })).status, 'applied');
    const build = async (decisionSourcePath) => buildCanonicalSemanticAudit({
      canonicalDirectory: path.join(root, 'data/canonical'), decisionSourcePath,
    });
    const built = await build(path.join(root, AUTHORITY));
    assert.doesNotThrow(() => validateSemanticAuditCoverage(built.canonical.records, built.artifact, { baseRecords: built.canonical.records }));
    assert.doesNotThrow(() => validateDatasetRecords(built.canonical.records, { semanticAudit: built.artifact, requireSemanticAudit: true }));

    // The same behavior holds for a context serialized to disk and read back (the in-memory ledger is restored).
    const context = await loadCanonicalContext({ directory: path.join(root, 'data/canonical') });
    context.semanticAudit = built.artifact;
    context.semanticDecisionSource = built.decisionSource;
    const contextPath = path.join(root, 'context.json');
    await writeCanonicalContext(context, contextPath);
    const reread = await readCanonicalContext(contextPath);
    assert.doesNotThrow(() => validateSemanticAuditCoverage(reread.records, reread.semanticAudit, { baseRecords: reread.records }));
    assert.doesNotThrow(() => validateDatasetRecords(reread.records, { semanticAudit: reread.semanticAudit, requireSemanticAudit: true, context: reread }));

    // A separately saved audit JSON has no in-memory ledger: bare coverage rejects it, the dataset consumer restores the validated ledger.
    const auditPath = path.join(root, 'saved-audit.json');
    await writeFile(auditPath, JSON.stringify(built.artifact));
    const saved = await readSemanticAuditArtifact(auditPath);
    assert.throws(() => validateSemanticAuditCoverage(built.canonical.records, saved, { baseRecords: built.canonical.records }), /correction_history and source-bound Stage 3 admission history/u);
    await assert.doesNotReject(() => validateDatasetDirectory(path.join(root, 'data/canonical'), {
      semanticAuditPath: auditPath, decisionSourcePath: path.join(root, AUTHORITY), requireSemanticAudit: true,
    }));

    // A serialized context whose stored ledger event digest was altered is rejected on rehydration, not trusted.
    const brokenContext = JSON.parse(await readFile(contextPath, 'utf8'));
    brokenContext.semantic_decision_source.factory_admissions.at(-1).sha256 = 'd'.repeat(64);
    const brokenContextPath = path.join(root, 'broken-context.json');
    await writeFile(brokenContextPath, JSON.stringify(brokenContext));
    await assert.rejects(() => readCanonicalContext(brokenContextPath), /sha256|bind|digest/u);

    // A tampered before digest on the amendment, resealed so the ledger itself must reject it.
    const forged = (await readShardedJson(path.join(root, AUTHORITY)));
    const event = forged.factory_admissions.at(-1);
    event.changes.find((change) => change.entry_id === source.record_id).before_sha256 = 'e'.repeat(64);
    delete event.sha256;
    event.sha256 = sha256Json(event);
    const forgedPath = path.join(root, 'forged-authority.json');
    await writeFile(forgedPath, JSON.stringify(forged, null, 2));
    await assert.rejects(() => build(forgedPath).then((result) => validateSemanticAuditCoverage(result.canonical.records, result.artifact, { baseRecords: result.canonical.records })), /does not bind/u);

    // A rewritten correction digest, resealed (authored review digest) so the audit reaches the correction chain.
    const rewritten = (await readShardedJson(path.join(root, AUTHORITY)));
    const correction = rewritten.authored_review.review_pass.correction_history.find((item) => item.record_id === source.record_id);
    correction.after_record_sha256 = 'f'.repeat(64);
    rewritten.authored_review_sha256 = sha256Json(rewritten.authored_review);
    const tamperedPath = path.join(root, 'tampered-authority.json');
    await writeFile(tamperedPath, JSON.stringify(rewritten, null, 2));
    await assert.rejects(
      () => build(tamperedPath).then((result) => validateSemanticAuditCoverage(result.canonical.records, result.artifact, { baseRecords: result.canonical.records })),
      /correction_history and source-bound Stage 3 admission history/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
