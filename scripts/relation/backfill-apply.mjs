import { readFile, readdir, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

import { reviewedRelationId } from '../batch/authored-semantic-decision-source.mjs';
import { planRelationBackfill, writePlannedRecords } from '../factory/admission.mjs';
import { relationAmendmentErrors } from '../factory/relation-amendments.mjs';
import { sha256Hex } from '../factory/contract.mjs';
import { buildStage3SemanticAuthority, AUTHORITY_PATH } from '../factory/semantic-authority.mjs';
import { refreshStage3ReportCheckpoints } from '../factory/stage3-worker.mjs';
import { sha256Json } from '../validate/semantic-audit.mjs';
import { backfillPacketErrors } from '../factory/validate.mjs';
import { approvalsStillHold } from './backfill-queue.mjs';

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

async function readCanonicalFiles(root) {
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
const nextPacketId = (events) => `R${String(events.reduce((max, event) => Math.max(max, Number(/^R(\d{6})$/u.exec(event.batch_id ?? '')?.[1] ?? 0)), 0) + 1).padStart(6, '0')}`;

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

async function applyPacket({ root, records, recordPathById, packetId, amendments, packetText }) {
  const base = withoutTuples(records, amendments);
  const plan = planRelationBackfill({ packetId, amendments, canonicalRecords: base, recordPathById });
  plan.reviewManifest = { semantic_decisions_sha256: sha256Hex(packetText), admission: {} };
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
