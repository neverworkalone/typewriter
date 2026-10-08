import { writeFile } from 'node:fs/promises';

import { loadCanonicalContext } from '../validate/canonical-context.mjs';
import { buildRelationIndex, retrieveRelationCandidates, validateRelationCandidateArtifact } from './candidate-retrieval.mjs';
import { provisionalId, provisionalSource, readReviewedBatchSenses } from './pilot.mjs';

// Relation candidate shortlist for the senses a Stage 2 batch has authored (issue #446 A).
// Usage: pnpm run relation:candidates <batchId> [--out file]
// Reads data/reviews/<batch>/decisions.jsonl on the current branch; every admitted sense is a source, and the
// same-batch senses are valid targets. Candidates only: the authoring agent judges types, relevance and notes.
const [batchId, flag, out] = process.argv.slice(2);
if (!/^C\d{6}$/u.test(batchId || '') || (flag && (flag !== '--out' || !out))) {
  console.error('usage: relation:candidates <batchId> [--out file]');
  process.exit(1);
}
const senses = await readReviewedBatchSenses(batchId);
const canonical = await loadCanonicalContext();
const index = buildRelationIndex(canonical);
const artifact = retrieveRelationCandidates(index, senses.map(provisionalSource));
const errors = validateRelationCandidateArtifact(artifact, index, { expectedSourceIds: senses.map(provisionalId) });
if (errors.length) {
  console.error(`candidate artifact invalid for ${batchId}: ${errors.slice(0, 3).join('; ')}`);
  process.exit(1);
}
const text = `${JSON.stringify(artifact, null, 1)}\n`;
if (out) await writeFile(out, text); else process.stdout.write(text);
