import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadCanonicalContext } from '../validate/canonical-context.mjs';
import {
  BACKFILL_CONTRACT, candidateEvidence, currentCandidatesForDone, packetBoundErrors, inventoryCanonicalSenses, newQueueState, nextPacket, recordOutcomes, retrievePacket, summarizeQueue,
} from './backfill-queue.mjs';
import { buildRelationIndex } from './candidate-retrieval.mjs';

// Usage:
//   node scripts/relation/backfill-queue-cli.mjs status
//   node scripts/relation/backfill-queue-cli.mjs next [--limit N] [--out packet.json]
//   node scripts/relation/backfill-queue-cli.mjs record <packet.json> <outcomes.json>
// State lives outside the repository (default ~/.cache/typewriter/relation-backfill/state.json, or --state <path>).
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const statePath = flag('--state', path.join(os.homedir(), '.cache/typewriter/relation-backfill/state.json'));
const command = args[0];

const canonical = await loadCanonicalContext();
const index = buildRelationIndex(canonical);
const rows = inventoryCanonicalSenses(index);
// Only a missing state file means "first run". An unreadable or corrupt file must stop the command: replacing it
// with an empty state would silently discard every earlier approval on the next write.
let state;
try {
  state = JSON.parse(await readFile(statePath, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') {
    console.error(`backfill state ${statePath} is unreadable or corrupt (${error.message}); refusing to continue. Restore it or move it aside deliberately.`);
    process.exit(1);
  }
  state = newQueueState(canonical.canonicalRevision);
}
if (state?.contract !== BACKFILL_CONTRACT || typeof state.done !== 'object' || state.done === null || Array.isArray(state.done)) {
  console.error(`backfill state ${statePath} does not match ${BACKFILL_CONTRACT}; refusing to continue.`);
  process.exit(1);
}

// Completed reviews are re-checked against today's candidate pool, so a canonical change that surfaces a new
// candidate returns that sense to the queue instead of silently counting as done.
const current = currentCandidatesForDone(canonical, rows, state, { index });

if (command === 'status') {
  console.log(JSON.stringify(summarizeQueue(rows, state, current), null, 2));
} else if (command === 'next') {
  const packet = nextPacket(rows, state, { limit: Number(flag('--limit', '50')), currentCandidates: current });
  const payload = { contract: 'relation-backfill-packet-v1', canonical_revision: canonical.canonicalRevision, packet, candidates: retrievePacket(canonical, packet, { index }) };
  const out = flag('--out');
  if (out) await writeFile(out, `${JSON.stringify(payload, null, 1)}\n`); else console.log(JSON.stringify(payload, null, 1));
} else if (command === 'record') {
  const packetFile = JSON.parse(await readFile(args[1], 'utf8'));
  const outcomes = JSON.parse(await readFile(args[2], 'utf8'));
  // The packet file is only a list of sense ids: rows and candidate evidence are re-derived from the live canonical
  // (and must be the revision the packet was issued for), so an edited packet cannot widen the reviewed pool.
  if (packetFile.canonical_revision !== canonical.canonicalRevision) {
    console.error(`packet was issued for canonical revision ${packetFile.canonical_revision}; run next again on the current revision`);
    process.exit(1);
  }
  // Bound the packet before any retrieval: one record call is one bounded unit, never several.
  const bound = packetBoundErrors(packetFile.packet);
  if (bound.length) { console.error(bound.join('\n')); process.exit(1); }
  const byId = new Map(rows.map((row) => [row.sense_id, row]));
  const packet = packetFile.packet.map((row) => byId.get(row.sense_id)).filter(Boolean);
  if (packet.length !== packetFile.packet.length) { console.error('packet names a sense that is not in the canonical inventory'); process.exit(1); }
  const artifact = retrievePacket(canonical, packet, { index });
  const result = recordOutcomes(state, packet, outcomes, { candidates: candidateEvidence(artifact, index), index, snapshotDigest: artifact.canonical_snapshot_digest });
  if (result.errors.length) { console.error(result.errors.join('\n')); process.exit(1); }
  await mkdir(path.dirname(statePath), { recursive: true });
  // Atomic replace: a crash mid-write leaves the previous complete file in place.
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...result.state, canonical_revision: canonical.canonicalRevision }, null, 1)}\n`);
  await rename(temporary, statePath);
  console.log(JSON.stringify(summarizeQueue(rows, result.state, currentCandidatesForDone(canonical, rows, result.state, { index })), null, 2));
} else {
  console.error('usage: status | next [--limit N] [--out file] | record <packet> <outcomes>');
  process.exit(2);
}
