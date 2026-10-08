import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { deferralCategory } from './literature-evidence-selfcheck.mjs';

// The #391 replay cohort, shared by the replay and the #414 boundary measurement: every historical
// `deferred` decision plus a deterministic sample of clear (included, existing-entry) decisions.

const COMPARISON_SAMPLE = 40;
const sha = (value) => createHash('sha256').update(value).digest('hex');

export async function collectReplayCohort(root) {
  const deferred = [];
  const clear = [];
  for (const batch of (await readdir(path.join(root, 'data/reviews'))).sort()) {
    let text;
    try { text = await readFile(path.join(root, 'data/reviews', batch, 'decisions.jsonl'), 'utf8'); } catch { continue; }
    for (const line of text.split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      if (row.disposition === 'deferred') deferred.push({ batch, id: row.source_candidate_id, category: deferralCategory(row.reason) });
      else if (row.disposition === 'included' && row.target?.kind !== 'new_entry') clear.push({ batch, id: row.source_candidate_id, category: 'clear_included' });
    }
  }
  clear.sort((a, b) => (sha(a.id) < sha(b.id) ? -1 : 1));
  return [...deferred, ...clear.slice(0, COMPARISON_SAMPLE)];
}
