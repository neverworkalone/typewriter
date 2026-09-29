import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCorpusCandidateReviewDispositions } from '../validate/corpus-candidate-review.mjs';

function candidate({
  disposition = 'admit',
  basis = 'valid-in-scope-lexical-entry',
  lemma = '상태',
  pos = 'noun',
  ambiguity = 'single_observed_analysis_unverified',
  coverage = 'uncovered',
  matches = [],
  candidateRecordId = 'w9001',
  rationale = '넓은 범주어지만 품사와 표제어 정체가 확인된 어휘 항목이다. 작가 효용은 측정하지 않았다.',
  senseBoundaryEvidence,
  lexicalUnitEvidence,
} = {}) {
  return {
    inventory_id: 'm5-9001',
    morphology_proposal: {
      lemma,
      pos,
      analyzer_pos: 'NNG',
      ambiguity_status: ambiguity,
      pos_interpretation_count_in_sample: 1,
      ambiguous_observed_surface_count_in_sample: ambiguity === 'single_observed_analysis_unverified' ? 0 : 1,
      oov_morpheme_occurrences_in_sample: 0,
    },
    coverage_status: coverage,
    typewriter_surface_matches: matches,
    bounded_provenance: {
      representative_hits: [
        { paragraph_id: 'CORPUS.1.10' },
        { paragraph_id: 'CORPUS.1.20' },
      ],
    },
    editorial_judgment: {
      disposition,
      disposition_basis: basis,
      rationale,
      candidate_record_id: disposition === 'admit' ? candidateRecordId : null,
      ...(senseBoundaryEvidence ? { sense_boundary_evidence: senseBoundaryEvidence } : {}),
      ...(lexicalUnitEvidence ? { lexical_unit_evidence: lexicalUnitEvidence } : {}),
    },
  };
}

test('broad, common, relation-free valid entries are admitted without writer-use evidence', () => {
  const row = candidate({
    rationale: '흔하고 넓은 범주어이며 writer-use evidence is NOT_MEASURED; 관계는 아직 없다.',
  });
  row.relation_count = 0;
  row.writer_usefulness = 'NOT_MEASURED';
  assert.deepEqual(validateCorpusCandidateReviewDispositions([row]), { admit: 1, hold: 0, reject: 0 });
});

test('writer usefulness alone cannot hold or reject a morphologically clear entry', () => {
  for (const disposition of ['hold', 'reject']) {
    const row = candidate({
      disposition,
      basis: 'writer-usefulness-unmeasured',
      candidateRecordId: null,
      rationale: '구별된 writer route와 writer usefulness evidence가 측정되지 않았다.',
    });
    assert.throws(() => validateCorpusCandidateReviewDispositions([row]), {
      code: disposition === 'hold'
        ? 'CORPUS_CANDIDATE_REVIEW_HOLD_BASIS'
        : 'CORPUS_CANDIDATE_REVIEW_REJECTION_BASIS',
    });
  }
});

test('actual morphology, sense, and canonical-collision evidence can hold a candidate', () => {
  const morphology = candidate({
    disposition: 'hold',
    basis: 'unresolved-identity',
    candidateRecordId: null,
    ambiguity: 'held_lemma_has_multiple_pos_interpretations',
  });
  morphology.morphology_proposal.pos_interpretation_count_in_sample = 2;
  const sense = candidate({
    disposition: 'hold',
    basis: 'unresolved-sense',
    candidateRecordId: null,
    senseBoundaryEvidence: {
      evidence_type: 'distinct-sense-directions-in-reviewed-bounded-contexts',
      directions: [
        { label: 'elapsed-time', paragraph_ids: ['CORPUS.1.10'] },
        { label: 'degree-or-extent', paragraph_ids: ['CORPUS.1.20'] },
      ],
    },
  });
  const collision = candidate({
    disposition: 'hold',
    basis: 'search-collision',
    candidateRecordId: null,
    coverage: 'search_form_collision',
    matches: [{ match_kind: 'curated_search_form', record_id: 'w1' }],
  });
  assert.deepEqual(
    validateCorpusCandidateReviewDispositions([morphology, sense, collision]),
    { admit: 0, hold: 3, reject: 0 },
  );
});

test('sense holds must bind distinct directions to distinct reviewed bounded contexts', () => {
  const row = candidate({
    disposition: 'hold',
    basis: 'unresolved-sense',
    candidateRecordId: null,
    senseBoundaryEvidence: {
      evidence_type: 'distinct-sense-directions-in-reviewed-bounded-contexts',
      directions: [
        { label: 'time', paragraph_ids: ['CORPUS.1.10'] },
        { label: 'degree', paragraph_ids: ['CORPUS.1.10'] },
      ],
    },
  });
  assert.throws(() => validateCorpusCandidateReviewDispositions([row]), { code: 'CORPUS_CANDIDATE_REVIEW_SENSE_EVIDENCE' });
});

test('missing or unknown morphology metadata cannot be presented as a real identity blocker', () => {
  const row = candidate({
    disposition: 'hold',
    basis: 'unresolved-identity',
    candidateRecordId: null,
    ambiguity: 'not-reviewed',
  });
  row.morphology_proposal.ambiguous_observed_surface_count_in_sample = 0;
  assert.throws(() => validateCorpusCandidateReviewDispositions([row]), { code: 'CORPUS_CANDIDATE_REVIEW_IDENTITY_EVIDENCE' });
});

test('rejections need a demonstrated duplicate, nonlexical unit, or out-of-scope identity', () => {
  const duplicate = candidate({
    disposition: 'reject',
    basis: 'duplicate-identity',
    candidateRecordId: null,
    coverage: 'exact_canonical_lemma',
    matches: [{ match_kind: 'canonical_lemma', canonical_lemma: '상태', record_id: 'w1' }],
  });
  assert.deepEqual(validateCorpusCandidateReviewDispositions([duplicate]), { admit: 0, hold: 0, reject: 1 });

  const unsupported = candidate({
    disposition: 'reject',
    basis: 'unsupported-scope',
    candidateRecordId: null,
    pos: 'particle',
  });
  unsupported.morphology_proposal.analyzer_pos = 'JKS';
  assert.deepEqual(validateCorpusCandidateReviewDispositions([unsupported]), { admit: 0, hold: 0, reject: 1 });
});
