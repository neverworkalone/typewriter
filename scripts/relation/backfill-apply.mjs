import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { reviewedRelationId } from '../batch/authored-semantic-decision-source.mjs';
import { planRelationBackfill, writePlannedRecords } from '../factory/admission.mjs';
import { sha256Hex } from '../factory/contract.mjs';
import { buildStage3SemanticAuthority, AUTHORITY_PATH } from '../factory/semantic-authority.mjs';
import { refreshStage3ReportCheckpoints } from '../factory/stage3-worker.mjs';
import { sha256Json } from '../validate/semantic-audit.mjs';

// Relation-only canonical backfill (#446 B): the bridge from approved queue outcomes to a canonical PR. It reuses the
// Stage 3 relation amendment planner and semantic-authority writer; no lexical admission is involved. Progress is the
// canonical data itself: an approved tuple that is already present replays as a no-op, so an interrupted run simply
// re-applies whatever is still missing.

export const BACKFILL_PACKET_DIR = 'data/relation-backfill';

/** Approved tuples of the queue state as source-bound amendments, in deterministic (sense id) order. */
export function approvedAmendments(state, index) {
  const amendments = [];
  const stale = [];
  for (const senseId of Object.keys(state.done).sort()) {
    const entry = state.done[senseId];
    if (!entry.approved_relations?.length) continue;
    const sense = index.bySenseId.get(senseId);
    // A removed sense or changed gloss means the review no longer holds; the queue returns it for re-review.
    if (!sense || sha256Json(sense.gloss) !== entry.gloss_sha256) { stale.push(senseId); continue; }
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

// The canonical records as they were before `pending` was applied: tuples that are already present are removed again.
const withoutTuples = (records, pending) => records.map((record) => {
  const mine = pending.filter((item) => item.source_record_id === record.id);
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
const nextPacketId = (events) => `R${String(events.reduce((max, event) => Math.max(max, Number(/^R(\d{6})$/u.exec(event.batch_id ?? '')?.[1] ?? 0)), 0) + 1).padStart(6, '0')}`;

/**
 * Applies every approved-but-absent relation of `state` to the canonical files under `root`. Returns
 * `{ status: 'nothing-to-apply' }` when canonical already holds them all (exact replay), otherwise writes the
 * canonical records, the semantic-authority event and the committed packet file and returns their summary.
 */
export async function applyBackfill({ root, state, index, refreshReports = true }) {
  const { amendments, stale } = approvedAmendments(state, index);
  const { records, recordPathById } = await readCanonicalFiles(root);
  // A conflicting existing tuple is rejected by the shared planner (STAGE3_RELATION_CONFLICT) and stops the run.
  planRelationBackfill({ packetId: 'R000000', amendments, canonicalRecords: records, recordPathById });
  const sourcePath = path.join(root, AUTHORITY_PATH);
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  // A tuple is done only when canonical holds it AND a semantic-authority event records it. The files are written
  // canonical first, so a run interrupted before the event leaves present-but-unrecorded tuples; those are re-applied
  // from the record minus those tuples, which rewrites identical canonical lines and adds the missing event and packet.
  const recorded = new Set((source.factory_admissions ?? []).flatMap((event) => (event.relation_amendments ?? [])
    .filter((entry) => entry.outcome === 'appended').map((entry) => entry.relation_id)));
  const pending = amendments.filter((item) => !recorded.has(reviewedId(item)));
  if (pending.length === 0) return { status: 'nothing-to-apply', stale, already_present: amendments.length };
  const base = withoutTuples(records, pending);

  const packetId = nextPacketId(source.factory_admissions ?? []);
  const plan = planRelationBackfill({ packetId, amendments: pending, canonicalRecords: base, recordPathById });
  const packetText = `${JSON.stringify({ packet_id: packetId, relation_amendments: pending }, null, 1)}\n`;
  plan.reviewManifest = { semantic_decisions_sha256: sha256Hex(packetText), admission: {} };
  const authority = await buildStage3SemanticAuthority({ root, baseCanonicalRecords: base, plan });

  await writePlannedRecords(plan, root);
  await writeFile(sourcePath, authority.sourceText, 'utf8');
  await mkdir(path.join(root, BACKFILL_PACKET_DIR), { recursive: true });
  await writeFile(path.join(root, BACKFILL_PACKET_DIR, `${packetId}.json`), packetText, 'utf8');
  if (refreshReports) refreshStage3ReportCheckpoints(root);
  return {
    status: 'applied', packet_id: packetId, stale, relations_appended: pending.length,
    records_changed: plan.changes.length, packet_file: `${BACKFILL_PACKET_DIR}/${packetId}.json`,
  };
}
