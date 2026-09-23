// Kept as the historical CLI path, but semantic decisions are not rebuildable.
// The durable decision artifact is authored input: this command only validates
// its source bindings and canonical serialization before downstream selection.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildM513CandidateRecords } from './m5-13-candidate-source.mjs';
import {
  M5_13_SEMANTIC_DECISION_SOURCE_PATH,
  readM513DecisionSource,
  serializeM513DecisionSource,
  validateM513DecisionSource,
} from './m5-13-decision-source.mjs';

export function validateM513SemanticSource({ source, sourceBytes, candidateRecords } = {}) {
  const validated = validateM513DecisionSource({ source, sourceBytes, candidateRecords });
  const serialized = serializeM513DecisionSource(source);
  if (!serialized.bytes.equals(sourceBytes)) {
    throw new Error('M5-13 semantic decision source must already be canonically serialized; validation never rewrites it');
  }
  return { ...validated, serialized };
}

async function main() {
  const { source, sourceBytes } = await readM513DecisionSource();
  const candidateRecords = buildM513CandidateRecords();
  const validated = validateM513SemanticSource({ source, sourceBytes, candidateRecords });
  console.log(JSON.stringify({
    path: path.relative(process.cwd(), M5_13_SEMANTIC_DECISION_SOURCE_PATH),
    source_id: source.source_id,
    candidate_count: source.decisions.length,
    decision_counts: validated.counts,
    selected_count: validated.selection.selected.length,
    reserve_count: validated.selection.reserve.length,
    excluded_count: validated.selection.excluded.length,
    artifact_sha256: validated.artifactSha256,
    wrote_decisions: false,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
