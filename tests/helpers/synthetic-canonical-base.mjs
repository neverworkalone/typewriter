import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { planStage3Admission } from '../../scripts/factory/admission.mjs';
import { reviewedCandidateRecord } from '../../scripts/factory/artifacts.mjs';
import { buildStage3SemanticAuthority } from '../../scripts/factory/semantic-authority.mjs';
import { reviewedRelationId } from '../../scripts/batch/authored-semantic-decision-source.mjs';
import { inspectSenseBoundaryPairs, sha256Json } from '../../scripts/validate/semantic-audit.mjs';
import { authorSemanticReviewBinding } from '../../scripts/validate/semantic-decision-row.mjs';

const DIGEST = 'a'.repeat(64);

// Synthetic entries admitted through the real Stage 3 plan and semantic authority, so tests that
// need an existing canonical base exercise the production path without any production dataset.
const BASE_ENTRIES = [
  { lemma: '합성기둥', senses: [{ gloss: '건물이나 구조물을 받쳐 세운 곧은 부분.', relations: [{ to: 1, type: 'near', note: '둘 다 단단히 서 있는 것이지만 바꿔 쓸 수는 없다.', relevance: 5 }, { to: 3, type: 'association', note: '기둥을 보며 떠올릴 수 있는 시간감이다.', relevance: 2 }] }, { gloss: '어떤 조직의 중심이 되어 지탱하는 사람.' }] },
  { lemma: '합성바위', senses: [{ gloss: '산이나 들에 놓인 큰 돌덩이.', relations: [{ to: 2, type: 'near', note: '둘 다 풍경 속의 단단한 사물이지만 바꿔 쓸 수는 없다.', relevance: 3 }] }] },
  { lemma: '합성지붕', senses: [{ gloss: '집이나 건물의 맨 위를 덮는 덮개.' }] },
  { lemma: '합성순간', senses: [{ gloss: '짧은 시간 동안.' }] },
];

function decisionRow(id, record, relationIdsBySense) {
  const row = {
    source_candidate_id: id, candidate_record_id: id, candidate_record_sha256: sha256Json(record), decision: 'included',
    decision_rationale: `${id}: 합성 시험 결정.`, gloss_judgment: 'fit',
    sense_reviews: record.senses.map((sense) => {
      const relationIds = relationIdsBySense.get(sense.id) ?? [];
      return {
        sense_id: sense.id, boundary_action: 'retain', boundary_classification: 'atomic', boundary_decision: 'atomic',
        boundary_rationale: `${id} ${sense.id}: 한 가지 뜻으로 한정된다.`, semantic_rationale: `${id} ${sense.id}: ${sense.gloss}`,
        ...(relationIds.length === 0
          ? { relation_decision: 'no-relations', relation_count: 0, relation_ids: [], no_relation_rationale: `${id} ${sense.id}: 관계 없음.` }
          : {
            relation_decision: 'relations-reviewed', relation_count: relationIds.length, relation_ids: relationIds,
            relation_rationale: `${id} ${sense.id}: 관계 탐색 후 근거 있는 관계만 남겼다.`,
          }),
      };
    }),
    boundary_pairs: inspectSenseBoundaryPairs(record).map((pair) => {
      const gloss = (senseId) => record.senses.find((sense) => sense.id === senseId).gloss;
      return {
        left_sense_id: pair.left_sense_id, right_sense_id: pair.right_sense_id, relationship: pair.relationship, decision: 'retain',
        left_gloss_sha256: sha256Json(gloss(pair.left_sense_id)), right_gloss_sha256: sha256Json(gloss(pair.right_sense_id)),
        evidence_basis: `${id}: 두 뜻은 서로 다른 쓰임이다.`, distinguishing_feature: `${id}: 쓰임이 다르다.`, rationale: `${id}: 별개의 뜻으로 유지한다.`,
      };
    }),
  };
  row.review_binding = authorSemanticReviewBinding(row, record);
  return row;
}

/**
 * A temporary repository root whose canonical semantic authority already covers a small synthetic
 * canonical base (one two-sense and three one-sense noun entries). Returns the root, the base records
 * and their record paths.
 */
export async function syntheticCanonicalBase({ batchId = 'C900000' } = {}) {
  const idOf = (index) => `${batchId}-${String(index + 1).padStart(4, '0')}`;
  const decisions = BASE_ENTRIES.map((entry, index) => ({
    source_candidate_id: idOf(index), disposition: 'included', target: { kind: 'new_entry' },
    reviewed_record: {
      lemma: entry.lemma,
      senses: entry.senses.map((sense) => ({
        pos: 'noun', gloss: sense.gloss,
        ...(sense.relations ? { relations: sense.relations.map(({ to, type, note, relevance }) => ({ type, target: idOf(to), target_sense: `${idOf(to)}-s1`, note, relevance })) } : {}),
      })),
    },
  }));
  const rows = decisions.map((decision) => {
    const record = reviewedCandidateRecord(decision);
    const relationIdsBySense = new Map(record.senses.map((sense, index) => [sense.id,
      (decision.reviewed_record.senses[index].relations ?? []).map((relation) => reviewedRelationId(sense.id, relation))]));
    return decisionRow(decision.source_candidate_id, record, relationIdsBySense);
  });
  const plan = planStage3Admission({
    batchId, attempt: 1, admissionPr: 1,
    candidateManifest: { batch_id: batchId, status: 'complete', candidates_sha256: DIGEST },
    reviewManifest: { batch_id: batchId, status: 'ready', attempt: 1, candidates_sha256: DIGEST, semantic_decisions_sha256: DIGEST },
    candidates: decisions.map((decision) => ({ candidate_id: decision.source_candidate_id })), decisions,
    canonicalRecords: [], recordPathById: new Map(), baseCanonicalSnapshotDigest: DIGEST,
  });
  const authority = await buildStage3SemanticAuthority({
    root: process.cwd(), baseCanonicalRecords: [], plan, semanticDecisions: { decisions: rows }, semanticDecisionsText: '{}',
  });
  const canonicalRecords = [...plan.records.values()].map((update) => update.record);
  const file = `data/canonical/factory-${batchId}-a1.jsonl`;
  const recordPathById = new Map(canonicalRecords.map((record) => [record.id, file]));

  const root = await mkdtemp(path.join(os.tmpdir(), 'synthetic-canonical-base-'));
  await mkdir(path.join(root, 'data/validation'), { recursive: true });
  await writeFile(path.join(root, 'data/validation/canonical-semantic-decision-source.json'), `${JSON.stringify(authority.sourceObject, null, 2)}\n`);
  for (const name of ['m6-2-inflection-exceptions.json', 'm6-3-surface-form-review.json']) {
    await cp(path.join('data/validation', name), path.join(root, 'data/validation', name));
  }
  await mkdir(path.join(root, 'data/canonical'), { recursive: true });
  await writeFile(path.join(root, file), `${canonicalRecords.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return { root, canonicalRecords, recordPathById };
}
