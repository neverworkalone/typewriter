import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadCanonicalContext } from '../validate/canonical-context.mjs';
import { buildRelationIndex, retrieveRelationCandidates, validateRelationCandidateArtifact } from './candidate-retrieval.mjs';
import { provisionalId, provisionalSource, readReviewedBatchSenses } from './pilot.mjs';

// Relation candidate shortlist for the senses a Stage 2 batch has authored (issue #446 A).
// Usage: pnpm run relation:candidates <batchId> [--out file]
// Reads data/reviews/<batch>/decisions.jsonl on the current branch; every admitted sense is a source, and the
// same-batch senses are valid targets. Candidates only: the authoring agent judges types, relevance and notes.

// The same admitted dispositions as Stage 2 lemma decisions and Stage 3 admission.
export const ADMITTED = new Set(['included', 'corrected']);

export async function stage2CandidateArtifact(batchId, { repo, index }) {
  const senses = await readReviewedBatchSenses(batchId, repo, ADMITTED);
  const artifact = retrieveRelationCandidates(index, senses.map(provisionalSource));
  const errors = validateRelationCandidateArtifact(artifact, index, { expectedSourceIds: senses.map(provisionalId) });
  if (errors.length) throw new Error(`candidate artifact invalid for ${batchId}: ${errors.slice(0, 3).join('; ')}`);
  return artifact;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [batchId, flag, out] = process.argv.slice(2);
  if (!/^C\d{6}$/u.test(batchId || '') || (flag && (flag !== '--out' || !out))) {
    console.error('usage: relation:candidates <batchId> [--out file]');
    process.exit(1);
  }
  const index = buildRelationIndex(await loadCanonicalContext());
  const text = `${JSON.stringify(await stage2CandidateArtifact(batchId, { index }), null, 1)}\n`;
  if (out) await writeFile(out, text); else process.stdout.write(text);
}
