import { readFileSync } from 'node:fs';

import { sha256Json } from '../validate/semantic-audit.mjs';
import {
  M5_12A_CANDIDATE_IDENTITIES,
  M5_12A_CANDIDATE_SOURCE_ID,
} from './m5-12a-candidate-source.mjs';
import { makeM512ACandidateRecord } from './m5-12a-pipeline.mjs';
import {
  candidateRecordsFromM512ADecisionSource,
  M5_12A_SEMANTIC_DECISION_SOURCE_ID,
  M5_12A_SEMANTIC_DECISION_SOURCE_PATH,
} from './m5-12a-decision-source.mjs';

// This command is intentionally scaffold-only. The durable decision source is
// an authored input and must not be regenerated from candidate data. A
// scaffold may bind identities and hashes, but it cannot manufacture semantic
// decisions, ranks, scores, pass evidence, or admission outcomes.
export function buildM512ASemanticDecisionScaffold(
  identities = M5_12A_CANDIDATE_IDENTITIES,
  authoredCandidateRecords = candidateRecordsFromM512ADecisionSource(
    JSON.parse(readFileSync(M5_12A_SEMANTIC_DECISION_SOURCE_PATH, 'utf8')),
    identities,
  ),
) {
  return {
    schema_version: '1',
    kind: 'm5-12a-semantic-decision-scaffold',
    semantic_decision_source_id: M5_12A_SEMANTIC_DECISION_SOURCE_ID,
    candidate_source: {
      source_id: M5_12A_CANDIDATE_SOURCE_ID,
      identity_sha256: sha256Json(identities),
      identity_count: identities.length,
    },
    candidates: identities.map((identity, index) => {
      const candidate = makeM512ACandidateRecord(identity, authoredCandidateRecords[index]);
      return {
        candidate_record_id: candidate.id,
        candidate_record_sha256: sha256Json(candidate),
        inventory_id: identity.inventory_id,
        sense_id: candidate.senses[0].id,
      };
    }),
  };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const scaffold = buildM512ASemanticDecisionScaffold();
  console.log(JSON.stringify({
    status: 'scaffold-only',
    semantic_decisions_written: false,
    candidate_count: scaffold.candidates.length,
    scaffold_sha256: sha256Json(scaffold),
    note: 'Supply authored decision content in data/batches/m5-12a-semantic-decisions.json; this command never writes that file.',
  }, null, 2));
}
