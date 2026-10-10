import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCanonicalSemanticAudit, canonicalRecordsBeforeFactoryAdmissions, sha256Json, validateFactoryAdmissionLedger, validateSemanticAuditCoverage } from '../validate/semantic-audit.mjs';
import { validateDatasetRecords } from '../validate/dataset-integrity.mjs';
import { loadCanonicalContext } from '../validate/canonical-context.mjs';
import { validateFactoryRepository } from '../factory/validate.mjs';
import { planRelationCorrections, targetMeaningSha256, writePlannedRecords } from '../factory/admission.mjs';
import { relationCorrectionErrors, revertRelationCorrections } from '../factory/relation-corrections.mjs';
import { reviewedRelationId } from '../batch/authored-semantic-decision-source.mjs';
import { planRelationBackfill } from '../factory/admission.mjs';
import { applyRelationCorrections, approvedAmendments, correctionItemsFor, nextPacketId, packetTextFor } from './backfill-apply.mjs';
import { newQueueState } from './backfill-queue.mjs';
import { buildRelationIndex } from './candidate-retrieval.mjs';

// #501 through the real production path: real canonical records, the real semantic authority and the real ledger and
// audit validators, applied in a scratch copy of the data files (the repository is never written). Nothing here is
// fixed to a particular word: the senses are picked from whatever the live canonical holds.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUTHORITY = 'data/validation/canonical-semantic-decision-source.json';

async function scratchRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'relation-correction-'));
  await mkdir(path.join(root, 'data/validation'), { recursive: true });
  await cp(path.join(REPO, 'data/canonical'), path.join(root, 'data/canonical'), { recursive: true });
  await cp(path.join(REPO, AUTHORITY), path.join(root, AUTHORITY));
  for (const dir of ['data/candidates', 'data/reviews']) await symlink(path.join(REPO, dir), path.join(root, dir));
  await cp(path.join(REPO, 'data/relation-backfill'), path.join(root, 'data/relation-backfill'), { recursive: true }).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
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
const readAuthority = async (root) => JSON.parse(await readFile(path.join(root, AUTHORITY), 'utf8'));
const recordPaths = async (root) => {
  const map = new Map();
  for (const name of await readdir(path.join(root, 'data/canonical'))) {
    for (const line of (await readFile(path.join(root, 'data/canonical', name), 'utf8')).split('\n')) if (line) map.set(JSON.parse(line).id, `data/canonical/${name}`);
  }
  return map;
};
// The records as they were before every factory admission and backfill: a correction must not change that history.
const rewoundRecords = (records, authority) => canonicalRecordsBeforeFactoryAdmissions(records.map((record) => ({ record })), authority).map(({ record }) => record);
const senseOf = (records, senseId) => records.flatMap((record) => record.senses).find((sense) => sense.id === senseId);

// A relation of the live canonical that is exploratory and sits on a sense with more than one relation, so a retype and
// a removal both leave the sense with relations; and one sole relation to prove a removal that empties the sense.
function pick(records, { sole = false } = {}) {
  for (const record of records) {
    for (const sense of record.senses) {
      const relations = sense.relations ?? [];
      if (sole ? relations.length !== 1 : relations.length < 2) continue;
      const at = relations.findIndex((relation) => relation.type === 'near');
      if (at >= 0) return { record, sense, relation: relations[at], at, meaning: targetMeaningSha256(new Map(records.map((item) => [item.id, item])), relations[at].target_sense) };
    }
  }
  throw new Error('the live canonical has no suitable relation');
}

const retype = (picked, extra = {}) => ({
  source_sense_id: picked.sense.id,
  previous_relation: picked.relation,
  target_meaning_sha256: picked.meaning,
  relation: { ...picked.relation, type: 'association', note: '회귀 시험용 연상으로 유형을 바로잡는다.', relevance: 4, ...extra },
  rationale: `${picked.record.id} ${picked.sense.id}: 회귀 시험용 근거로 유형을 바로잡는다.`,
});

test('a retype is written once as a source-preserving correction event that the real ledger and audit accept, and replays as a no-op', async () => {
  const root = await scratchRoot();
  try {
    const before = await readRecords(root);
    const picked = pick(before);
    // The scratch root lacks some unrelated data files, so compare against its own baseline.
    const baseline = await validateFactoryRepository({ root });
    const baselineAuthority = await readAuthority(root);
    const result = await applyRelationCorrections({ root, proposals: [retype(picked)], refreshReports: false });
    assert.equal(result.status, 'applied');
    assert.equal(result.corrections_applied, 1);
    assert.equal(result.records_changed, 1);

    // Only that relation changed, in place: same position, same target, every other field and relation untouched.
    const after = await readRecords(root);
    const changed = after.filter((record, i) => JSON.stringify(record) !== JSON.stringify(before[i]));
    assert.deepEqual(changed.map((record) => record.id), [picked.record.id]);
    const relations = senseOf(after, picked.sense.id).relations;
    assert.equal(relations[picked.at].type, 'association');
    assert.equal(relations[picked.at].target_sense, picked.relation.target_sense);
    assert.deepEqual(relations.filter((_, i) => i !== picked.at), picked.sense.relations.filter((_, i) => i !== picked.at));

    // The ledger keeps the replaced tuple, its position and the rationale digest, bound to the packet file.
    const authority = await readAuthority(root);
    const event = authority.factory_admissions.at(-1);
    assert.match(event.batch_id, /^R\d{6}$/u);
    assert.deepEqual(event.entries, []);
    assert.equal(event.changes[0].operation, 'amend_relations');
    assert.deepEqual(event.relation_corrections[0].previous_relation, picked.relation);
    assert.equal(event.relation_corrections[0].position, picked.at);
    assert.equal(event.relation_corrections[0].outcome, 'amended');
    const packetText = await readFile(path.join(root, `data/relation-backfill/${event.batch_id}.json`), 'utf8');
    assert.equal(JSON.parse(packetText).relation_corrections[0].previous_relation.note, picked.relation.note);
    validateFactoryAdmissionLedger(authority, after.map((record) => ({ record })), 'correction test');

    // Rewinding the ledger lands exactly on the record as it was before the correction.
    assert.deepEqual(event.changes[0].previous_record, before.find((record) => record.id === picked.record.id));
    assert.deepEqual(rewoundRecords(after, authority), rewoundRecords(before, baselineAuthority), 'the full rewind is unchanged by the correction');

    // The shared factory repository validation and the complete-canonical audit both hold.
    assert.deepEqual(await validateFactoryRepository({ root }), baseline, 'the correction adds no factory finding');
    const built = await buildCanonicalSemanticAudit({ canonicalDirectory: path.join(root, 'data/canonical'), decisionSourcePath: path.join(root, AUTHORITY) });
    assert.doesNotThrow(() => validateSemanticAuditCoverage(built.canonical.records, built.artifact, { baseRecords: built.canonical.records }));
    assert.doesNotThrow(() => validateDatasetRecords(built.canonical.records, { semanticAudit: built.artifact, requireSemanticAudit: true }));

    // Exact replay is idempotent; a different replacement for a relation that was already corrected is stale.
    assert.equal((await applyRelationCorrections({ root, proposals: [retype(picked)], refreshReports: false })).status, 'nothing-to-apply');
    assert.equal((await readAuthority(root)).factory_admissions.length, authority.factory_admissions.length);
    await assert.rejects(applyRelationCorrections({ root, proposals: [retype(picked, { note: '다른 설명이다.' })], refreshReports: false }), /no longer the reviewed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('removing a relation keeps its position in the ledger and rewinds exactly, including when it empties the sense', async () => {
  for (const sole of [false, true]) {
    const root = await scratchRoot();
    try {
      const before = await readRecords(root);
      const baselineAuthority = await readAuthority(root);
      const picked = pick(before, { sole });
      const proposal = { ...retype(picked), relation: null };
      assert.equal((await applyRelationCorrections({ root, proposals: [proposal], refreshReports: false })).status, 'applied');
      const after = await readRecords(root);
      const sense = senseOf(after, picked.sense.id);
      assert.deepEqual(sense.relations ?? [], picked.sense.relations.filter((_, i) => i !== picked.at));
      assert.equal('relations' in sense, !sole, 'a sense left without relations carries no empty relations array');
      const authority = await readAuthority(root);
      assert.equal(authority.factory_admissions.at(-1).relation_corrections[0].relation, null);
      assert.deepEqual(authority.factory_admissions.at(-1).changes[0].previous_record, before.find((record) => record.id === picked.record.id));
      assert.deepEqual(rewoundRecords(after, authority), rewoundRecords(before, baselineAuthority), 'the full rewind is unchanged by the correction');
      const built = await buildCanonicalSemanticAudit({ canonicalDirectory: path.join(root, 'data/canonical'), decisionSourcePath: path.join(root, AUTHORITY) });
      assert.doesNotThrow(() => validateSemanticAuditCoverage(built.canonical.records, built.artifact, { baseRecords: built.canonical.records }));
      assert.equal((await applyRelationCorrections({ root, proposals: [proposal], refreshReports: false })).status, 'nothing-to-apply');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('a run interrupted after the packet (and optionally the canonical write) is finished, never duplicated or undone', async () => {
  for (const removal of [false, true]) {
    for (const writeCanonical of [false, true]) {
      const root = await scratchRoot();
      try {
        const before = await readRecords(root);
        const picked = pick(before);
        const proposal = removal ? { ...retype(picked), relation: null } : retype(picked);
        const items = correctionItemsFor(before, [proposal]);
        const id = nextPacketId((await readAuthority(root)).factory_admissions);
        const packetText = `${JSON.stringify({ packet_id: id, relation_corrections: items }, null, 1)}\n`;
        await mkdir(path.join(root, 'data/relation-backfill'), { recursive: true });
        await writeFile(path.join(root, `data/relation-backfill/${id}.json`), packetText);
        if (writeCanonical) await writePlannedRecords(planRelationCorrections({ packetId: id, corrections: items, canonicalRecords: before, recordPathById: await recordPaths(root) }), root);
        const events = (await readAuthority(root)).factory_admissions.length;

        const result = await applyRelationCorrections({ root, proposals: [proposal], refreshReports: false });
        assert.equal(result.status, 'applied');
        assert.deepEqual(result.packets, [id]);
        assert.equal((await readAuthority(root)).factory_admissions.length, events + 1);
        assert.equal(await readFile(path.join(root, `data/relation-backfill/${id}.json`), 'utf8'), packetText, 'the intent packet is kept as written');
        const sense = senseOf(await readRecords(root), picked.sense.id);
        assert.equal((sense.relations ?? []).length, picked.sense.relations.length - (removal ? 1 : 0));
        const built = await buildCanonicalSemanticAudit({ canonicalDirectory: path.join(root, 'data/canonical'), decisionSourcePath: path.join(root, AUTHORITY) });
        assert.doesNotThrow(() => validateSemanticAuditCoverage(built.canonical.records, built.artifact, { baseRecords: built.canonical.records }));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});

test('a stale or unbound correction is rejected before anything is written', async () => {
  const root = await scratchRoot();
  try {
    const records = await readRecords(root);
    const picked = pick(records);
    const events = (await readAuthority(root)).factory_admissions.length;
    const untouched = async () => {
      assert.deepEqual(await readRecords(root), records);
      assert.equal((await readAuthority(root)).factory_admissions.length, events);
    };
    // The reviewer saw a different note than canonical holds.
    await assert.rejects(applyRelationCorrections({ root, proposals: [{ ...retype(picked), previous_relation: { ...picked.relation, note: '검토자가 보지 않은 설명이다.' } }], refreshReports: false }), /no longer the reviewed/u);
    // The target is part of the relation's identity and cannot move.
    await assert.rejects(applyRelationCorrections({ root, proposals: [retype(picked, { target_sense: 'w1-s1' })], refreshReports: false }), /keep the target/u);
    // The rationale must cite the source sense, and a no-op or unsupported replacement is refused.
    await assert.rejects(applyRelationCorrections({ root, proposals: [{ ...retype(picked), rationale: '근거가 출처를 말하지 않는다.' }], refreshReports: false }), /source-bound/u);
    await assert.rejects(applyRelationCorrections({ root, proposals: [{ ...retype(picked), relation: picked.relation }], refreshReports: false }), /identical to previous_relation/u);
    await assert.rejects(applyRelationCorrections({ root, proposals: [retype(picked, { type: 'synonym' })], refreshReports: false }), /not a supported relation type/u);
    await assert.rejects(applyRelationCorrections({ root, proposals: [{ ...retype(picked), source_sense_id: 'w99999-s1' }], refreshReports: false }), /does not exist/u);
    await untouched();

    // The planner binds the source sense's gloss, so a changed meaning makes an approved item stale.
    const items = correctionItemsFor(records, [retype(picked)]);
    const stale = structuredClone(items);
    stale[0].source_gloss_sha256 = 'a'.repeat(64);
    assert.throws(() => planRelationCorrections({ packetId: 'R999998', corrections: stale, canonicalRecords: records, recordPathById: new Map() }), /changed meaning since it was reviewed/u);
    const moved = structuredClone(items);
    moved[0].position += 1;
    assert.throws(() => planRelationCorrections({ packetId: 'R999998', corrections: moved, canonicalRecords: records, recordPathById: new Map() }), /no longer holds the relation it corrects/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the correction contract rejects malformed packets and rewinds only applied corrections', async () => {
  const records = (await loadCanonicalContext()).records.map((info) => info.record ?? info);
  const picked = pick(records);
  const [item] = correctionItemsFor(records, [retype(picked)]);
  assert.deepEqual(relationCorrectionErrors({ relation_corrections: [item] }, 'packet'), []);
  assert.deepEqual(relationCorrectionErrors({}, 'packet'), []);
  for (const bad of [
    [],
    [{ ...item, extra: 1 }],
    [{ ...item, position: -1 }],
    [{ ...item, position: undefined }],
    [{ ...item, relation: undefined }],
    [{ ...item, target_meaning_sha256: undefined }],
    [{ ...item, target_meaning_sha256: 'x' }],
    [{ ...item, previous_relation: { ...item.previous_relation, target_sense: undefined } }],
    [item, item],
  ]) assert.notDeepEqual(relationCorrectionErrors({ relation_corrections: bad }, 'packet'), []);

  // Rewinding: the replacement goes back to the exact previous tuple; an item that never applied changes nothing.
  const applied = { ...item, outcome: 'amended' };
  const record = records.find(({ id }) => id === item.source_record_id);
  const changed = { ...record, senses: record.senses.map((sense) => (sense.id !== item.source_sense_id ? sense
    : { ...sense, relations: sense.relations.map((relation, i) => (i === item.position ? item.relation : relation)) })) };
  assert.deepEqual(revertRelationCorrections(changed, [applied]), record);
  assert.equal(revertRelationCorrections(record, [{ ...applied, outcome: 'already_applied' }]), record);
  assert.deepEqual(revertRelationCorrections(record, [applied]), record, 'an unapplied correction is skipped');
  assert.equal(sha256Json(revertRelationCorrections(changed, [applied])), sha256Json(record));
});

// An appended-relation packet left interrupted by an earlier backfill apply is finished before a correction, resuming it
// against the current canonical target meaning (the intent packet is real: planned and rendered by the production code).
test('a correction first finishes an interrupted appended-relation packet while its target meaning holds, and stays fail-closed when it changed', async () => {
  const canonical = await loadCanonicalContext();
  const index = buildRelationIndex(canonical);
  const source = index.senses.find((sense) => sense.relations.some((relation) => relation.relevance !== undefined));
  const related = new Set(source.relations.map((relation) => relation.target_sense));
  const target = index.senses.find((sense) => sense.record_id !== source.record_id && !related.has(sense.sense_id));
  const relation = { target: target.record_id, target_sense: target.sense_id, type: 'association', note: '회귀 시험용 연상이다.', relevance: 5 };
  const state = newQueueState(canonical.canonicalRevision);
  state.done[source.sense_id] = {
    outcome: 'relations-reviewed', gloss_sha256: sha256Json(source.gloss), rationale: 'x', relation_count: 1,
    approved_relations: [{ relation_id: reviewedRelationId(source.sense_id, relation), relation, rationale: `${source.record_id} ${source.sense_id}: 회귀 시험용 근거.` }],
    reviewed_candidates: [{ id: target.sense_id, meaning_sha256: sha256Json([target.lemma, target.gloss]) }],
  };
  const pickedBefore = pick(canonical.records.map((info) => info.record ?? info));
  for (const targetChanged of [false, true]) {
    const root = await scratchRoot();
    try {
      const records = await readRecords(root);
      const id = nextPacketId((await readAuthority(root)).factory_admissions);
      const { amendments } = approvedAmendments(state, index);
      await mkdir(path.join(root, 'data/relation-backfill'), { recursive: true });
      await writeFile(path.join(root, `data/relation-backfill/${id}.json`), packetTextFor(id, amendments, state));
      assert.ok(planRelationBackfill({ packetId: id, amendments, canonicalRecords: records, recordPathById: await recordPaths(root) }).relationAmendments.length);
      if (targetChanged) {
        // The target's meaning changed after approval: the file keeps its bytes but the gloss in canonical differs.
        const dir = path.join(root, 'data/canonical');
        for (const name of await readdir(dir)) {
          const text = await readFile(path.join(dir, name), 'utf8');
          const next = text.split('\n').map((line) => {
            if (!line) return line;
            const record = JSON.parse(line);
            if (record.id !== target.record_id) return line;
            return JSON.stringify({ ...record, senses: record.senses.map((sense) => (sense.id === target.sense_id ? { ...sense, gloss: `${sense.gloss} (뜻이 바뀜)` } : sense)) });
          }).join('\n');
          if (next !== text) await writeFile(path.join(dir, name), next);
        }
      }
      const proposal = retype(pickedBefore);
      const events = (await readAuthority(root)).factory_admissions.length;
      if (targetChanged) {
        await assert.rejects(applyRelationCorrections({ root, proposals: [proposal], refreshReports: false }), /changed meaning since approval/u);
        assert.equal((await readAuthority(root)).factory_admissions.length, events, 'nothing is recorded');
      } else {
        const result = await applyRelationCorrections({ root, proposals: [proposal], refreshReports: false });
        assert.equal(result.status, 'applied');
        assert.equal(result.packets.length, 2, 'the interrupted packet is finished, then the correction is written');
        assert.equal(result.packets[0], id);
        assert.equal((await readAuthority(root)).factory_admissions.length, events + 2);
        assert.equal(senseOf(await readRecords(root), source.sense_id).relations.filter((item) => item.target_sense === target.sense_id).length, 1);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

// The type and note were judged against the target as the reviewer saw it: with the source gloss and the previous tuple
// unchanged, a target whose meaning changed makes the correction stale at first apply and at resume, and the bound
// meaning still lets an unchanged target through.
const changeTargetGloss = async (root, senseId) => {
  const dir = path.join(root, 'data/canonical');
  for (const name of await readdir(dir)) {
    const text = await readFile(path.join(dir, name), 'utf8');
    const next = text.split('\n').map((line) => {
      if (!line) return line;
      const record = JSON.parse(line);
      if (!record.senses.some((sense) => sense.id === senseId)) return line;
      return JSON.stringify({ ...record, senses: record.senses.map((sense) => (sense.id === senseId ? { ...sense, gloss: `${sense.gloss} (뜻이 바뀜)` } : sense)) });
    }).join('\n');
    if (next !== text) await writeFile(path.join(dir, name), next);
  }
};

test('a correction is bound to the reviewed target meaning at first apply and at resume', async () => {
  // First apply: the reviewer cited a digest of a target meaning that canonical no longer holds.
  const root = await scratchRoot();
  try {
    const records = await readRecords(root);
    const picked = pick(records);
    const events = (await readAuthority(root)).factory_admissions.length;
    await assert.rejects(applyRelationCorrections({ root, proposals: [{ ...retype(picked), target_meaning_sha256: 'b'.repeat(64) }], refreshReports: false }), /does not have the meaning that was reviewed/u);
    await changeTargetGloss(root, picked.relation.target_sense);
    await assert.rejects(applyRelationCorrections({ root, proposals: [retype(picked)] , refreshReports: false }), /does not have the meaning that was reviewed/u);
    assert.equal((await readAuthority(root)).factory_admissions.length, events, 'nothing is recorded');
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  // Resume: the intent packet was committed, then the target meaning changed before the apply finished.
  for (const targetChanged of [false, true]) {
    const resumeRoot = await scratchRoot();
    try {
      const records = await readRecords(resumeRoot);
      const picked = pick(records);
      const proposal = retype(picked);
      const items = correctionItemsFor(records, [proposal]);
      const id = nextPacketId((await readAuthority(resumeRoot)).factory_admissions);
      await mkdir(path.join(resumeRoot, 'data/relation-backfill'), { recursive: true });
      await writeFile(path.join(resumeRoot, `data/relation-backfill/${id}.json`), `${JSON.stringify({ packet_id: id, relation_corrections: items }, null, 1)}\n`);
      const events = (await readAuthority(resumeRoot)).factory_admissions.length;
      if (targetChanged) {
        await changeTargetGloss(resumeRoot, picked.relation.target_sense);
        const before = await readRecords(resumeRoot);
        await assert.rejects(applyRelationCorrections({ root: resumeRoot, proposals: [proposal], refreshReports: false }), /changed meaning since it was reviewed/u);
        assert.deepEqual(await readRecords(resumeRoot), before, 'canonical is untouched');
        assert.equal((await readAuthority(resumeRoot)).factory_admissions.length, events);
      } else {
        assert.equal((await applyRelationCorrections({ root: resumeRoot, proposals: [proposal], refreshReports: false })).status, 'applied');
        const event = (await readAuthority(resumeRoot)).factory_admissions.at(-1);
        assert.equal(event.relation_corrections[0].target_meaning_sha256, picked.meaning, 'the ledger keeps the reviewed meaning digest');
      }
    } finally {
      await rm(resumeRoot, { recursive: true, force: true });
    }
  }
});

// A removal is settled only when the relation is really gone. The same target kept under another type (or with another
// note) means the reviewed tuple was changed, not removed: the producer and the planner share that judgment.
test('a removal of a relation that was retyped meanwhile is stale at first apply and in the planner, while a real removal replays as a no-op', async () => {
  const root = await scratchRoot();
  try {
    const original = await readRecords(root);
    const picked = pick(original);
    const removal = { ...retype(picked), relation: null };
    // Positive control: the reviewed tuple is still there, so the removal applies.
    // Negative: another review already retyped the same target relation, then a stale removal of the old tuple arrives.
    assert.equal((await applyRelationCorrections({ root, proposals: [retype(picked)], refreshReports: false })).status, 'applied');
    const events = (await readAuthority(root)).factory_admissions.length;
    const retyped = await readRecords(root);
    await assert.rejects(applyRelationCorrections({ root, proposals: [removal], refreshReports: false }), /no longer the reviewed/u);
    assert.equal((await readAuthority(root)).factory_admissions.length, events, 'nothing is recorded');
    assert.deepEqual(await readRecords(root), retyped, 'canonical is untouched');

    // The planner (packet resume) reaches the same conclusion from a packet item built before the retype.
    const items = correctionItemsFor(original, [removal]);
    assert.throws(() => planRelationCorrections({ packetId: 'R999998', corrections: items, canonicalRecords: retyped, recordPathById: new Map() }), /no longer holds the relation it corrects/u);

    // Removing the retyped tuple really removes it; replaying that removal is then an idempotent no-op.
    const current = { ...removal, previous_relation: retyped.flatMap((record) => record.senses).find((sense) => sense.id === picked.sense.id).relations[picked.at] };
    assert.equal((await applyRelationCorrections({ root, proposals: [current], refreshReports: false })).status, 'applied');
    assert.equal((await applyRelationCorrections({ root, proposals: [current], refreshReports: false })).status, 'nothing-to-apply');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Resuming a stored correction packet rebuilds the pre-packet canonical from the packet, so a record that is neither
// the pre-packet nor the post-packet state (the same target relation changed in the meantime) must fail closed instead
// of being "restored" and then corrected. This goes through the on-disk intent packet and the real resume path.
const rewriteRelation = async (root, senseId, at, change) => {
  const dir = path.join(root, 'data/canonical');
  for (const name of await readdir(dir)) {
    const text = await readFile(path.join(dir, name), 'utf8');
    const next = text.split('\n').map((line) => {
      if (!line) return line;
      const record = JSON.parse(line);
      if (!record.senses.some((sense) => sense.id === senseId)) return line;
      return JSON.stringify({ ...record, senses: record.senses.map((sense) => (sense.id !== senseId ? sense
        : { ...sense, relations: sense.relations.map((relation, i) => (i === at ? { ...relation, ...change } : relation)) })) });
    }).join('\n');
    if (next !== text) await writeFile(path.join(dir, name), next);
  }
};

test('resuming a stored correction packet fails closed when the same target relation changed since it was written', async () => {
  for (const removal of [true, false]) {
    for (const change of [{ type: 'mood', note: '다른 검토가 바꾼 설명이다.', relevance: 6 }, { note: '같은 유형의 다른 설명이다.' }]) {
      const root = await scratchRoot();
      try {
        const records = await readRecords(root);
        const picked = pick(records);
        const proposal = removal ? { ...retype(picked), relation: null } : retype(picked);
        const items = correctionItemsFor(records, [proposal]);
        const id = nextPacketId((await readAuthority(root)).factory_admissions);
        await mkdir(path.join(root, 'data/relation-backfill'), { recursive: true });
        await writeFile(path.join(root, `data/relation-backfill/${id}.json`), `${JSON.stringify({ packet_id: id, relation_corrections: items }, null, 1)}\n`);
        await rewriteRelation(root, picked.sense.id, picked.at, change);
        const changed = await readRecords(root);
        const events = (await readAuthority(root)).factory_admissions.length;
        await assert.rejects(applyRelationCorrections({ root, proposals: [proposal], refreshReports: false }), /canonical changed after the packet was written|no longer (holds|the reviewed)/u);
        assert.deepEqual(await readRecords(root), changed, 'canonical is untouched');
        assert.equal((await readAuthority(root)).factory_admissions.length, events, 'nothing is recorded');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});
