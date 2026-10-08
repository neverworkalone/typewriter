import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadCanonicalContext } from '../validate/canonical-context.mjs';
import {
  candidateEvidence, currentCandidatesForDone, inventoryCanonicalSenses, newQueueState, nextPacket, recordOutcomes, retrievePacket, summarizeQueue,
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
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch { state = newQueueState(canonical.canonicalRevision); }

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
  const result = recordOutcomes(state, packetFile.packet, outcomes, { candidates: candidateEvidence(packetFile.candidates) });
  if (result.errors.length) { console.error(result.errors.join('\n')); process.exit(1); }
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({ ...result.state, canonical_revision: canonical.canonicalRevision }, null, 1)}\n`);
  console.log(JSON.stringify(summarizeQueue(rows, result.state, currentCandidatesForDone(canonical, rows, result.state, { index })), null, 2));
} else {
  console.error('usage: status | next [--limit N] [--out file] | record <packet> <outcomes>');
  process.exit(2);
}
