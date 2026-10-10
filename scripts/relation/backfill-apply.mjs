import { readFile, readdir, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

import { reviewedRelationId } from '../batch/authored-semantic-decision-source.mjs';
import { canonicalRecordSha256, planRelationBackfill, planRelationCorrections, targetMeaningSha256, writePlannedRecords } from '../factory/admission.mjs';
import { relationAmendmentErrors } from '../factory/relation-amendments.mjs';
import { CORRECTION_FIELD, canonicalTuple, correctionSettled, relationCorrectionErrors, revertRelationCorrections, sameTuple } from '../factory/relation-corrections.mjs';
import { sha256Hex } from '../factory/contract.mjs';
import { buildStage3SemanticAuthority, AUTHORITY_PATH } from '../factory/semantic-authority.mjs';
import { refreshStage3ReportCheckpoints } from '../factory/stage3-worker.mjs';
import { canonicalRecordsSha256, sha256Json } from '../validate/semantic-audit.mjs';
import { backfillPacketErrors } from '../factory/validate.mjs';
import { approvalsStillHold } from './backfill-queue.mjs';
import { buildRelationIndex } from './candidate-retrieval.mjs';

// Relation-only canonical backfill (#446 B): the bridge from approved queue outcomes to a canonical PR. It reuses the
// Stage 3 relation amendment planner and semantic-authority writer; no lexical admission is involved. Progress is the
// canonical data itself. The committed packet file is written FIRST and doubles as the intent record: a packet with no
// semantic-authority event is an interrupted apply and is finished by running `apply` again. A tuple that is merely
// already present (no packet claims it) is an exact-tuple no-op, exactly as in Stage 3.

export const BACKFILL_PACKET_DIR = 'data/relation-backfill';

/** Approved tuples of the queue state as source-bound amendments, in deterministic (sense id) order. */
export function approvedAmendments(state, index) {
  const amendments = [];
  const stale = [];
  for (const senseId of Object.keys(state.done).sort()) {
    const entry = state.done[senseId];
    if (!entry.approved_relations?.length) continue;
    const sense = index.bySenseId.get(senseId);
    // The same check the queue uses: a removed sense, changed source gloss, or a target whose owner or meaning changed
    // since the review means the approval no longer holds, so nothing is written and the queue returns it for re-review.
    if (!sense || !approvalsStillHold({ sense_id: senseId, gloss_sha256: sha256Json(sense.gloss) }, entry, index)) { stale.push(senseId); continue; }
    for (const { relation, rationale } of entry.approved_relations) {
      amendments.push({
        source_record_id: sense.record_id, source_sense_id: senseId, source_gloss_sha256: entry.gloss_sha256, relation, rationale,
      });
    }
  }
  return { amendments, stale };
}

export async function readCanonicalFiles(root) {
  const dir = path.join(root, 'data/canonical');
  const records = [];
  const recordPathById = new Map();
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.jsonl')).sort()) {
    for (const line of (await readFile(path.join(dir, name), 'utf8')).split('\n')) {
      if (!line) continue;
      const record = JSON.parse(line);
      records.push(record);
      recordPathById.set(record.id, `data/canonical/${name}`);
    }
  }
  return { records, recordPathById };
}

// The canonical records as they were before `packet` was applied: only the packet's own tuples are removed again.
const withoutTuples = (records, packet) => records.map((record) => {
  const mine = packet.filter((item) => item.source_record_id === record.id);
  if (!mine.length) return record;
  return { ...record, senses: record.senses.map((sense) => {
    const drop = mine.filter((item) => item.source_sense_id === sense.id).map((item) => reviewedId(item));
    if (!drop.length || !sense.relations) return sense;
    const kept = sense.relations.filter((relation) => !drop.includes(reviewedRelationId(sense.id, relation)));
    const { relations, ...rest } = sense;
    return kept.length ? { ...rest, relations: kept } : rest;
  }) };
});
const reviewedId = (item) => reviewedRelationId(item.source_sense_id, item.relation);
const meaningOf = (index, senseId) => {
  const sense = index.bySenseId.get(senseId);
  return sense ? sha256Json([sense.lemma, sense.gloss]) : null;
};

/**
 * The intent packet: the amendments plus, per approved tuple, the target meaning digest the reviewer saw. The digest
 * lives beside the amendments (their shape is the shared Stage 3 contract) so an interrupted apply can be resumed
 * only while the target still means what it meant when it was approved.
 */
export function packetTextFor(packetId, amendments, state) {
  const targetMeaning = {};
  for (const item of amendments) {
    const reviewedTarget = state.done[item.source_sense_id].reviewed_candidates.find((candidate) => candidate.id === item.relation.target_sense);
    targetMeaning[reviewedId(item)] = reviewedTarget.meaning_sha256;
  }
  return `${JSON.stringify({ packet_id: packetId, relation_amendments: amendments, target_meaning_sha256: targetMeaning }, null, 1)}\n`;
}

const isPresent = (records, item) => records.some((record) => record.id === item.source_record_id
  && record.senses.some((sense) => sense.id === item.source_sense_id && (sense.relations ?? []).some((relation) => reviewedRelationId(sense.id, relation) === reviewedId(item))));

const BACKFILL_EVENT = /^R\d{6}$/u;
export const nextPacketId = (events) => `R${String(events.reduce((max, event) => Math.max(max, Number(/^R(\d{6})$/u.exec(event.batch_id ?? '')?.[1] ?? 0)), 0) + 1).padStart(6, '0')}`;

async function readPackets(root) {
  const dir = path.join(root, BACKFILL_PACKET_DIR);
  let names;
  try { names = await readdir(dir); } catch (error) { if (error?.code === 'ENOENT') return new Map(); throw error; }
  const packets = new Map();
  for (const name of names.filter((file) => /^R\d{6}\.json$/u.test(file)).sort()) packets.set(name.slice(0, 7), await readFile(path.join(dir, name), 'utf8'));
  return packets;
}

const readAuthority = async (root) => JSON.parse(await readFile(path.join(root, AUTHORITY_PATH), 'utf8'));

// Packet first (intent), then canonical, then the authority event; the event is what marks the packet complete.
// Write beside the target and rename, so an interruption leaves either the old file or the complete new one.
async function writeAtomic(target, text) {
  await writeFile(`${target}.tmp`, text, 'utf8');
  await rename(`${target}.tmp`, target);
}

// The canonical records as they were before a correction packet: its applied corrections are undone again.
const withoutCorrections = (records, corrections) => records.map((record) => revertRelationCorrections(record,
  corrections.map((item) => ({ ...item, outcome: 'amended' }))));

// Resuming a correction packet rebuilds "the canonical before this packet" from the packet itself. That rebuild is only
// sound when it lands exactly on the canonical the semantic authority recorded before the packet: any other result (for
// example the same target relation retyped by someone else since, which the rebuild would paper over by re-inserting the
// old tuple) is a change the packet never reviewed, so it fails closed instead of being corrected.
function assertRebuiltBaseIsRecorded(base, source, packetId) {
  if (canonicalRecordsSha256(base.map((record) => ({ record }))) !== source.source?.canonical_records_sha256) {
    throw new Error(`packet ${packetId}: canonical changed after the packet was written (the pre-packet state it rebuilds is not the recorded one); remove the unwritten packet and re-review`);
  }
}

async function applyPacket({ root, records, recordPathById, packetId, amendments, corrections, packetText }) {
  const base = corrections ? withoutCorrections(records, corrections) : withoutTuples(records, amendments);
  const plan = corrections
    ? planRelationCorrections({ packetId, corrections, canonicalRecords: base, recordPathById })
    : planRelationBackfill({ packetId, amendments, canonicalRecords: base, recordPathById });
  plan.reviewManifest = { semantic_decisions_sha256: sha256Hex(packetText), admission: {} };
  if (corrections) assertRebuiltBaseIsRecorded(base, await readAuthority(root), packetId);
  const authority = await buildStage3SemanticAuthority({ root, baseCanonicalRecords: base, plan });
  await mkdir(path.join(root, BACKFILL_PACKET_DIR), { recursive: true });
  await writeAtomic(path.join(root, BACKFILL_PACKET_DIR, `${packetId}.json`), packetText);
  await writePlannedRecords(plan, root);
  await writeAtomic(path.join(root, AUTHORITY_PATH), authority.sourceText);
  return plan;
}

/**
 * Applies the approved relations of `state` that canonical does not yet hold to the canonical files under `root`,
 * after first finishing any interrupted packet. Returns `nothing-to-apply` when every approved tuple is already
 * present and recorded; otherwise `applied` with the packet ids written or resumed.
 */
export async function applyBackfill({ root, state, index, refreshReports = true }) {
  const { amendments, stale } = approvedAmendments(state, index);
  const files = async () => ({ ...(await readCanonicalFiles(root)), source: await readAuthority(root) });
  let { records, recordPathById, source } = await files();
  const packets = await readPackets(root);
  const events = (source.factory_admissions ?? []).filter((event) => BACKFILL_EVENT.test(event.batch_id));
  const recorded = new Set(events.map((event) => event.batch_id));
  // A recorded packet must be the exact file its event was bound to; a missing or altered packet fails closed.
  const bound = backfillPacketErrors(events, packets);
  if (bound.length) throw new Error(bound.join('; '));
  const written = [];
  for (const [id, text] of packets) {
    if (recorded.has(id)) continue;
    let packet;
    try { packet = JSON.parse(text); } catch { throw new Error(`interrupted packet ${id} is not valid JSON; inspect it before re-running`); }
    if (packet?.packet_id === id && packet[CORRECTION_FIELD] !== undefined) {
      // A correction packet carries its own positions, so resuming needs no index: the planner re-checks every binding.
      const found = relationCorrectionErrors(packet, id);
      if (found.length) throw new Error(found.join('; '));
      await applyPacket({ root, records, recordPathById, packetId: id, corrections: packet[CORRECTION_FIELD], packetText: text });
      written.push(id);
      ({ records, recordPathById, source } = await files());
      continue;
    }
    const problems = packet?.packet_id === id && Array.isArray(packet.relation_amendments) && packet.target_meaning_sha256 && typeof packet.target_meaning_sha256 === 'object'
      ? relationAmendmentErrors({ relation_amendments: packet.relation_amendments }, id) : [`interrupted packet ${id} is malformed`];
    if (problems.length) throw new Error(problems.join('; '));
    // Resuming writes whatever the intent has not written yet, so each such tuple must still mean what it meant when
    // it was approved; tuples already in canonical are only being recorded.
    for (const item of packet.relation_amendments) {
      if (isPresent(records, item)) continue;
      if (packet.target_meaning_sha256[reviewedId(item)] !== meaningOf(index, item.relation.target_sense)) {
        throw new Error(`interrupted packet ${id}: the target ${item.relation.target_sense} of ${item.source_sense_id} changed meaning since approval; remove the unwritten packet and re-review`);
      }
    }
    await applyPacket({ root, records, recordPathById, packetId: id, amendments: packet.relation_amendments, packetText: text });
    written.push(id);
    ({ records, recordPathById, source } = await files());
  }

  // A conflicting existing tuple is rejected by the shared planner; an exact tuple that is already present is a no-op.
  const probe = planRelationBackfill({ packetId: 'R000000', amendments, canonicalRecords: records, recordPathById });
  const missing = new Set(probe.relationAmendments.filter((entry) => entry.outcome === 'appended').map((entry) => entry.authored_relation_id));
  const pending = amendments.filter((item) => missing.has(reviewedId(item)));
  let recordsChanged = 0;
  if (pending.length) {
    const packetId = nextPacketId(source.factory_admissions ?? []);
    const packetText = packetTextFor(packetId, pending, state);
    recordsChanged = (await applyPacket({ root, records, recordPathById, packetId, amendments: pending, packetText })).changes.length;
    written.push(packetId);
  }
  if (written.length === 0) return { status: 'nothing-to-apply', stale, already_present: amendments.length };
  if (refreshReports) refreshStage3ReportCheckpoints(root);
  return { status: 'applied', stale, packets: written, relations_appended: pending.length, records_changed: recordsChanged };
}

/**
 * Turns reviewed correction proposals into packet items against the current canonical records (#501). A proposal is
 * `{ source_sense_id, previous_relation, target_meaning_sha256, relation, rationale }`: the exact tuple the reviewer saw,
 * the digest of the target sense's `[lemma, gloss]` they judged it against, and its replacement (null removes it). The source record, gloss digest and the item's position are derived here, in application order.
 * A proposal whose replacement is already exactly in place is settled and yields no item; any other mismatch is stale.
 */
export function correctionItemsFor(records, proposals) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const working = new Map();
  const items = [];
  for (const proposal of proposals) {
    const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!object(proposal) || !object(proposal.previous_relation) || (proposal.relation !== null && !object(proposal.relation))) {
      throw new Error('a correction proposal needs source_sense_id, previous_relation, target_meaning_sha256, relation (a tuple, or null to remove) and rationale');
    }
    const recordId = /^([wr]\d+)-s\d+$/u.exec(proposal.source_sense_id ?? '')?.[1];
    const record = records.find(({ id }) => id === recordId);
    const sense = record?.senses.find(({ id }) => id === proposal.source_sense_id);
    if (!sense) throw new Error(`${proposal.source_sense_id}: the source sense does not exist; re-review the correction`);
    const relations = working.get(sense.id) ?? [...(sense.relations ?? [])];
    working.set(sense.id, relations);
    const position = relations.findIndex((relation) => sameTuple(relation, proposal.previous_relation));
    const replacement = proposal.relation === null ? null : canonicalTuple(proposal.relation);
    if (position < 0) {
      if (!correctionSettled(relations, proposal.previous_relation, replacement)) throw new Error(`${sense.id}: the relation to ${proposal.previous_relation.target_sense} is no longer the reviewed ${proposal.previous_relation.type} tuple; re-review the correction`);
      continue;
    }
    // The reviewer's digest of the target meaning must still describe the target, or the judgment was made on other words.
    const targetMeaning = targetMeaningSha256(byId, proposal.previous_relation.target_sense);
    if (targetMeaning === null || proposal.target_meaning_sha256 !== targetMeaning) {
      throw new Error(`${sense.id}: the target ${proposal.previous_relation.target_sense} does not have the meaning that was reviewed (target_meaning_sha256); re-review the correction`);
    }
    items.push({
      source_record_id: record.id,
      source_sense_id: sense.id,
      source_gloss_sha256: canonicalRecordSha256(sense.gloss),
      target_meaning_sha256: targetMeaning,
      previous_relation: structuredClone(relations[position]),
      relation: replacement,
      position,
      rationale: proposal.rationale,
    });
    if (replacement === null) relations.splice(position, 1);
    else relations[position] = replacement;
  }
  return items;
}

/** What a reviewer needs to cite for a correction: each relation of the sense with its target's meaning digest. */
export function relationMeanings(records, senseId) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const sense = records.flatMap((record) => record.senses).find(({ id }) => id === senseId);
  return (sense?.relations ?? []).map((relation) => ({ relation, target_meaning_sha256: targetMeaningSha256(byId, relation.target_sense) }));
}

/**
 * Applies reviewed relation corrections (retype, renote, re-rank, remove) to canonical under `root` as one backfill
 * packet: the committed packet is the intent record, then canonical, then the semantic-authority event, exactly as for
 * an appended backfill. An interrupted packet is finished first; proposals already in effect are a no-op.
 */
export async function applyRelationCorrections({ root, proposals, refreshReports = true }) {
  // An interrupted appended-relation packet is finished first, and resuming it re-checks its approved target meaning,
  // so the index is the current canonical (the same state a normal backfill apply would resume against).
  const current = await readCanonicalFiles(root);
  const probe = await applyBackfill({ root, state: { done: {} }, index: buildRelationIndex({ records: current.records }), refreshReports: false });
  let { records, recordPathById, source } = { ...(await readCanonicalFiles(root)), source: await readAuthority(root) };
  const items = correctionItemsFor(records, proposals);
  const found = relationCorrectionErrors({ [CORRECTION_FIELD]: items.length ? items : undefined }, 'proposals');
  if (!items.length) {
    if (probe.status === 'applied' && refreshReports) refreshStage3ReportCheckpoints(root);
    return { status: probe.status === 'applied' ? 'applied' : 'nothing-to-apply', packets: probe.packets ?? [], corrections_applied: 0 };
  }
  if (found.length) throw new Error(found.join('; '));
  const packetId = nextPacketId(source.factory_admissions ?? []);
  const packetText = `${JSON.stringify({ packet_id: packetId, [CORRECTION_FIELD]: items }, null, 1)}\n`;
  const plan = await applyPacket({ root, records, recordPathById, packetId, corrections: items, packetText });
  if (refreshReports) refreshStage3ReportCheckpoints(root);
  return { status: 'applied', packets: [...(probe.packets ?? []), packetId], corrections_applied: items.length, records_changed: plan.changes.length };
}
