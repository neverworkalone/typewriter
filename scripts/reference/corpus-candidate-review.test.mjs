import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateCorpusCandidateReviewArtifacts } from './validate-corpus-candidate-review.mjs';
import { validateCorpusCandidateReviewDispositions } from '../validate/corpus-candidate-review.mjs';

function candidate({
  disposition = 'admit',
  basis = 'valid-in-scope-lexical-entry',
  lemma = '상태',
  pos = 'noun',
  analyzerPos = 'NNG',
  ambiguity = 'single_observed_analysis_unverified',
  coverage = 'uncovered',
  matches = [],
  candidateRecordId = 'w9001',
  rationale = '넓은 범주어지만 품사와 표제어 정체가 확인된 어휘 항목이다. 작가 효용은 측정하지 않았다.',
  senseBoundaryEvidence,
  lexicalUnitEvidence,
  posCorrection,
  identityEvidence,
} = {}) {
  return {
    inventory_id: 'm5-9001',
    morphology_proposal: {
      lemma,
      pos,
      analyzer_pos: analyzerPos,
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
      ...(posCorrection ? { pos_correction: posCorrection } : {}),
      ...(identityEvidence ? { identity_evidence: identityEvidence } : {}),
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

test('analyzer POS corrections are admitted only with source-bound editorial evidence', () => {
  const correction = {
    evidence_type: 'reviewed-bounded-contexts-support-corrected-pos',
    analyzer_pos: 'VV',
    analyzer_mapped_pos: 'verb',
    corrected_pos: 'adverb',
    paragraph_ids: ['CORPUS.1.10', 'CORPUS.1.20'],
    rationale: '두 bounded context에서 어쩌다의 용법은 동사가 아니라 부사로 기능한다.',
  };
  const row = candidate({ lemma: '어쩌다', pos: 'adverb', analyzerPos: 'VV', posCorrection: correction });
  assert.deepEqual(validateCorpusCandidateReviewDispositions([row]), { admit: 1, hold: 0, reject: 0 });

  const unbound = candidate({ lemma: '어쩌다', pos: 'adverb', analyzerPos: 'VV' });
  assert.throws(() => validateCorpusCandidateReviewDispositions([unbound]), {
    code: 'CORPUS_CANDIDATE_REVIEW_POS_CORRECTION_EVIDENCE',
  });
  const wrongParagraph = candidate({
    lemma: '어쩌다',
    pos: 'adverb',
    analyzerPos: 'VV',
    posCorrection: { ...correction, paragraph_ids: ['CORPUS.OTHER.1'] },
  });
  assert.throws(() => validateCorpusCandidateReviewDispositions([wrongParagraph]), {
    code: 'CORPUS_CANDIDATE_REVIEW_POS_CORRECTION_EVIDENCE',
  });
});

test('directory validation discovers future M9 artifacts by contract version', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'typewriter-corpus-review-'));
  const batchesDirectory = path.join(repositoryRoot, 'data/batches');
  const futureArtifact = (batchId) => JSON.stringify({
    contract_version: 'm9-corpus-candidate-review-v1',
    batch_id: batchId,
    decisions: [candidate({ lemma: batchId })],
  });

  try {
    await mkdir(path.join(batchesDirectory, 'm9-e'), { recursive: true });
    await writeFile(path.join(batchesDirectory, 'm9-d-review.json'), futureArtifact('m9-d-batch-01'));
    await writeFile(path.join(batchesDirectory, 'm9-e', 'decisions.json'), futureArtifact('m9-e-batch-01'));
    await writeFile(path.join(batchesDirectory, 'unrelated.json'), JSON.stringify({
      contract_version: 'm9-corpus-candidate-selection-v1',
      decisions: [{ editorial_judgment: { disposition_basis: 'writer-usefulness-unmeasured' } }],
    }));

    const result = await validateCorpusCandidateReviewArtifacts({ repositoryRoot });
    assert.equal(result.artifact_count, 2);
    assert.deepEqual(result.artifacts.map(({ batch_id }) => batch_id), [
      'm9-d-batch-01',
      'm9-e-batch-01',
    ]);
    assert.ok(result.artifacts.every(({ admit, hold, reject }) => (
      admit === 1 && hold === 0 && reject === 0
    )));
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
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

test('clear analyzer proposals can be held when bounded contexts undermine the standalone lemma boundary', () => {
  const evidence = {
    evidence_type: 'reviewed-bounded-contexts-undermine-standalone-lemma',
    paragraph_ids: ['CORPUS.1.10', 'CORPUS.1.20'],
    rationale: 'The selected surface occurs as part of a larger verb in both reviewed contexts.',
  };
  const row = candidate({
    disposition: 'hold',
    basis: 'unresolved-identity',
    candidateRecordId: null,
    identityEvidence: evidence,
  });
  assert.deepEqual(validateCorpusCandidateReviewDispositions([row]), { admit: 0, hold: 1, reject: 0 });

  const unbound = candidate({
    disposition: 'hold',
    basis: 'unresolved-identity',
    candidateRecordId: null,
    identityEvidence: { ...evidence, paragraph_ids: ['CORPUS.OTHER.1'] },
  });
  assert.throws(() => validateCorpusCandidateReviewDispositions([unbound]), {
    code: 'CORPUS_CANDIDATE_REVIEW_IDENTITY_EVIDENCE',
  });
});

test('component-only identity holds bind every analyzed form when no exact-start context exists', () => {
  const surfaces = ['사냥터지기', '산지기가', '마구간지기들이'];
  const row = candidate({
    disposition: 'hold',
    basis: 'unresolved-identity',
    lemma: '지기',
    candidateRecordId: null,
    identityEvidence: {
      evidence_type: 'reviewed-analyzed-forms-show-component-only-usage',
      candidate_morpheme_span_surface: '지기',
      observed_surface_forms: surfaces,
      rationale: '표본의 분석 표면형은 모두 다른 어휘 뒤에 결합하며 독립 표제어 경계를 보이지 않는다.',
    },
  });
  row.observed_surface_forms = surfaces.map((surface) => ({ surface }));
  row.observed_morpheme_spans = [{ surface: '지기' }];
  row.bounded_provenance.representative_hits = [];
  assert.deepEqual(validateCorpusCandidateReviewDispositions([row]), { admit: 0, hold: 1, reject: 0 });

  const unbound = candidate({
    disposition: 'hold',
    basis: 'unresolved-identity',
    lemma: '지기',
    candidateRecordId: null,
    identityEvidence: {
      evidence_type: 'reviewed-analyzed-forms-show-component-only-usage',
      candidate_morpheme_span_surface: '지기',
      observed_surface_forms: ['사냥터지기', 'unreviewed'],
      rationale: '표본의 형태소 분석이 독립 표제어 경계를 보이지 않는다.',
    },
  });
  unbound.observed_surface_forms = surfaces.map((surface) => ({ surface }));
  unbound.observed_morpheme_spans = [{ surface: '지기' }];
  unbound.bounded_provenance.representative_hits = [];
  assert.throws(() => validateCorpusCandidateReviewDispositions([unbound]), {
    code: 'CORPUS_CANDIDATE_REVIEW_IDENTITY_EVIDENCE',
  });
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

test('no-exact-start-context identity holds cite every analyzed form and the span, and reject invalid mutations', () => {
  const surfaces = ['살이가', '삶살이를'];
  const build = (mutate = () => {}) => {
    const row = candidate({
      disposition: 'hold',
      basis: 'unresolved-identity',
      lemma: '살이',
      candidateRecordId: null,
      identityEvidence: {
        evidence_type: 'no-exact-start-context-available',
        candidate_morpheme_span_surface: '살이',
        observed_surface_forms: surfaces,
        rationale: '표본에 형태소 시작 위치의 대표 문맥이 없어 표제어 정체를 확정할 수 없다.',
      },
    });
    row.observed_surface_forms = surfaces.map((surface) => ({ surface }));
    row.observed_morpheme_spans = [{ surface: '살이' }];
    row.bounded_provenance.representative_hits = [];
    mutate(row);
    return row;
  };
  assert.deepEqual(validateCorpusCandidateReviewDispositions([build()]), { admit: 0, hold: 1, reject: 0 });
  const invalid = {
    code: 'CORPUS_CANDIDATE_REVIEW_IDENTITY_EVIDENCE',
  };
  assert.throws(() => validateCorpusCandidateReviewDispositions([build((row) => {
    row.editorial_judgment.identity_evidence.observed_surface_forms = ['살이가'];
  })]), invalid, 'form mismatch');
  assert.throws(() => validateCorpusCandidateReviewDispositions([build((row) => {
    row.bounded_provenance.representative_hits = [{ paragraph_id: 'CORPUS.1.10' }];
  })]), invalid, 'unexpected representative hit');
  assert.throws(() => validateCorpusCandidateReviewDispositions([build((row) => {
    row.observed_morpheme_spans = [];
  })]), invalid, 'missing span');
  assert.throws(() => validateCorpusCandidateReviewDispositions([build((row) => {
    row.editorial_judgment.identity_evidence.rationale = ' ';
  })]), invalid, 'blank rationale');
});
