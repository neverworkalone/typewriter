import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  M9_EXPRESSION_LEXICAL_UNIT_REVIEW_CONTRACT_VERSION,
  candidateRecordsFromAuthoredSemanticDecisionSource,
  serializeAuthoredSemanticDecisionSource,
  validateAuthoredDecisionDisposition,
  validateAuthoredSemanticDecisionSource,
} from '../scripts/batch/authored-semantic-decision-source.mjs';
import { selectReviewedCandidates } from '../scripts/batch/lexical-selection.mjs';
import {
  AUTHORED_SEMANTIC_REVIEW_BINDING_CONTRACT_VERSION,
  authorSemanticReviewBinding,
  compactAuthoredSemanticDecisionRow,
  SOURCE_BOUND_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
} from '../scripts/validate/semantic-decision-row.mjs';
import { validateLexicalProduction } from '../scripts/batch/lexical-production.mjs';
import { SQLITE_SCHEMA_SQL } from '../scripts/build/sqlite-schema.mjs';
import { SearchSession } from '../src/domain/search-session.js';
import {
  SQLITE_SCHEMA_VERSION,
} from '../src/runtime/dictionary-contract.js';
import {
  findRecordsBySearchTerm,
  getMeaningRecord,
} from '../src/runtime/sqlite-query.js';
import { sha256Json } from '../scripts/validate/semantic-audit.mjs';
import {
  makeProductionState,
  makeSemanticAudit,
} from './helpers/semantic-audit-fixture.mjs';

const CANDIDATE_CONFIG = Object.freeze({
  label: 'synthetic searchable-start regression',
  errorPrefix: 'SEARCHABLE_START',
});

function makeReferenceCandidate() {
  return {
    id: 'w9901',
    record_type: 'entry',
    role: 'reference-only',
    lemma: '공통예시표제어',
    search_forms: ['공통예시표제어'],
    senses: [{
      id: 'w9901-s1',
      pos: 'noun',
      gloss: '일반적으로 쓰이는 합성 명사 예시.',
    }],
  };
}

function makeCommonGeneralCandidate(id, lemma, gloss) {
  return {
    ...makeReferenceCandidate(),
    id,
    role: 'start',
    candidate_id: id,
    lemma,
    search_forms: [lemma],
    senses: [{ id: `${id}-s1`, pos: 'noun', gloss }],
  };
}

function makeSingleSenseBoundaryReview(record, decisionSourceId, {
  sentenceFrame,
  relationType,
  targetClass,
}) {
  const sense = record.senses[0];
  return {
    status: 'pass',
    sense_id: sense.id,
    gloss_sha256: sha256Json(sense.gloss),
    decision_source_id: decisionSourceId,
    decision: 'retain',
    frame_observations: [{
      gloss_excerpt: sense.gloss,
      gloss_start: 0,
      sentence_frame: sentenceFrame,
      writer_route: { relation_type: relationType, target_class: targetClass },
    }],
    rationale: `${record.id} ${sense.id} exact gloss span was checked in a writer-facing frame.`,
  };
}

function sourceForCandidate(candidate) {
  const candidateRecords = [candidate];
  return {
    candidate_records: candidateRecords,
    candidate_records_sha256: sha256Json(candidateRecords),
  };
}

function seedDatabase(database) {
  database.exec(`PRAGMA foreign_keys = ON; PRAGMA user_version = ${SQLITE_SCHEMA_VERSION};`);
  database.exec(SQLITE_SCHEMA_SQL);
  database.exec(`
    INSERT INTO records VALUES ('w001', 'entry', 'start', 'w001', '기준어');
    INSERT INTO records VALUES ('r002', 'entry', 'reference-only', NULL, '공통표제어');
    INSERT INTO records VALUES ('r003', 'entry', 'reference-only', NULL, '다듬다');
    INSERT INTO records VALUES ('w004', 'entry', 'start', 'w004', '다듬은말');
    INSERT INTO search_forms VALUES ('w001', 0, '기준어');
    INSERT INTO search_forms VALUES ('r002', 0, '공통표제어'), ('r002', 1, '보통말');
    INSERT INTO search_forms VALUES ('r003', 0, '다듬다');
    INSERT INTO search_forms VALUES ('w004', 0, '다듬은말'), ('w004', 1, '다듬은');
    INSERT INTO meanings VALUES
      ('m001', '기준어', '검색 출발점', 'w001', NULL),
      ('m002', '공통표제어', '관계 대상이며 관계는 아직 없음', 'r002', NULL),
      ('m003', '다듬다', '관계 대상이며 표면형 규칙을 따름', 'r003', NULL),
      ('m004', '다듬은말', '정확 검색어와 generated form이 충돌할 때의 precedence 대상', 'w004', NULL);
    INSERT INTO meaning_members VALUES
      ('m001', 0, 'w001-s1', 'w001'), ('m002', 0, 'r002-s1', 'r002'),
      ('m003', 0, 'r003-s1', 'r003'), ('m004', 0, 'w004-s1', 'w004');
    INSERT INTO meaning_relations VALUES
      ('m001', 0, 'm002', 'near', '기준어에서 연결된 보통말', 3, 'stdict-sense-projection'),
      ('m001', 1, 'm003', 'action', '기준어에서 이어지는 동작', 4, 'stdict-sense-projection');
    INSERT INTO generated_surface_forms VALUES
      ('다듬는', 'r003', 'r003-s1', 0, 'verb-present-adnominal-neun'),
      ('다듬은', 'r003', 'r003-s1', 0, 'verb-past-adnominal-eun');
  `);
}

test('a valid relation-target entry with no relations is admitted and selected without a writer-usefulness gate', () => {
  const candidate = makeReferenceCandidate();
  const identity = {
    candidate_record_id: candidate.id,
    lemma: candidate.lemma,
    record_type: candidate.record_type,
    pos: 'noun',
    axis: 'X',
  };

  assert.deepEqual(
    candidateRecordsFromAuthoredSemanticDecisionSource(
      sourceForCandidate(candidate),
      [identity],
      CANDIDATE_CONFIG,
    ),
    [candidate],
  );

  const selection = selectReviewedCandidates([
    {
      candidate_record_id: candidate.id,
      decision: 'included',
      rank: 1,
      selection_axis: identity.axis,
      gloss_judgment: 'fit',
      writer_use: 'common word with low vividness',
      relation_count: 0,
    },
    {
      candidate_record_id: 'held-unresolved-pos',
      decision: 'held',
      hold_basis: 'unresolved-sense',
      rank: 2,
      selection_axis: identity.axis,
      gloss_judgment: 'needs-context',
      decision_rationale: 'part of speech is unresolved',
    },
    {
      candidate_record_id: 'rejected-duplicate',
      decision: 'rejected',
      rejection_basis: 'duplicate-identity',
      rank: 3,
      selection_axis: identity.axis,
      gloss_judgment: 'reject',
      decision_rationale: 'duplicates an existing lexical identity',
    },
  ], {
    capacity: 1,
    coverageField: 'selection_axis',
    eligibilityField: 'gloss_judgment',
    eligibilityValue: 'fit',
  });

  assert.equal(selection.status, 'pass');
  assert.deepEqual(selection.selected.map(({ candidate_record_id: id }) => id), [candidate.id]);
  assert.deepEqual(selection.excluded, ['held-unresolved-pos', 'rejected-duplicate']);
  assert.doesNotThrow(() => validateAuthoredDecisionDisposition({
    decision: 'rejected',
    rejection_basis: 'duplicate-identity',
  }));
  assert.doesNotThrow(() => validateAuthoredDecisionDisposition({
    decision: 'held',
    gloss_judgment: 'needs-context',
    hold_basis: 'unresolved-sense',
  }));
  assert.throws(
    () => validateAuthoredDecisionDisposition({
      decision: 'rejected',
      gloss_judgment: 'reject',
      rejection_basis: 'low-writer-usefulness',
    }, 'low-usefulness rejection', CANDIDATE_CONFIG),
    (error) => error.code === 'SEARCHABLE_START_DECISION_SOURCE_REJECTION_BASIS',
  );
  assert.throws(
    () => validateAuthoredDecisionDisposition({
      decision: 'held',
      gloss_judgment: 'needs-context',
      hold_basis: 'low-writer-usefulness',
    }, 'low-usefulness hold', CANDIDATE_CONFIG),
    (error) => error.code === 'SEARCHABLE_START_DECISION_SOURCE_HOLD_BASIS',
  );
  assert.doesNotThrow(() => validateAuthoredDecisionDisposition({
    decision: 'rejected',
    rejection_basis: 'not-a-lexical-unit',
  }));
  assert.doesNotThrow(() => validateAuthoredDecisionDisposition({
    decision: 'rejected',
    rejection_basis: 'unsupported-scope',
  }));
  assert.throws(
    () => validateAuthoredDecisionDisposition({
      decision: 'held',
      gloss_judgment: 'needs-context',
    }, 'hold without an unresolved basis', CANDIDATE_CONFIG),
    (error) => error.code === 'SEARCHABLE_START_DECISION_SOURCE_HOLD_BASIS',
  );
  for (const basis of ['low-writer-usefulness', 'low-vividness', 'common-general-term', 'zero-relations', 'axis-deficiency']) {
    assert.throws(
      () => validateAuthoredDecisionDisposition({
        decision: 'held',
        gloss_judgment: 'needs-context',
        hold_basis: basis,
        writer_use: 'common and general, with low vividness',
        selection_axis: 'Q',
        relation_count: 0,
      }, `unsupported hold basis ${basis}`, CANDIDATE_CONFIG),
      (error) => error.code === 'SEARCHABLE_START_DECISION_SOURCE_HOLD_BASIS',
    );
    assert.throws(
      () => validateAuthoredDecisionDisposition({
        decision: 'rejected',
        gloss_judgment: 'reject',
        rejection_basis: basis,
        writer_use: 'common and general, with low vividness',
        selection_axis: 'Q',
        relation_count: 0,
      }, `unsupported rejection basis ${basis}`, CANDIDATE_CONFIG),
      (error) => error.code === 'SEARCHABLE_START_DECISION_SOURCE_REJECTION_BASIS',
    );
  }

  const duplicateSource = sourceForCandidate({
    ...candidate,
    senses: candidate.senses.map((sense, index) => ({
      ...sense,
      id: `${candidate.id}-s${index + 1}`,
    })),
  });
  duplicateSource.candidate_records.push(duplicateSource.candidate_records[0]);
  duplicateSource.candidate_records_sha256 = sha256Json(duplicateSource.candidate_records);
  assert.throws(
    () => candidateRecordsFromAuthoredSemanticDecisionSource(
      duplicateSource,
      [identity],
      CANDIDATE_CONFIG,
    ),
    (error) => error.code === 'SEARCHABLE_START_CANDIDATE_SOURCE_SCOPE',
  );

  const unresolvedPos = {
    ...candidate,
    senses: [{ ...candidate.senses[0], pos: 'pronoun' }],
  };
  assert.throws(
    () => candidateRecordsFromAuthoredSemanticDecisionSource(
      sourceForCandidate(unresolvedPos),
      [identity],
      CANDIDATE_CONFIG,
    ),
    (error) => error.code === 'SEARCHABLE_START_CANDIDATE_SOURCE_BINDING',
  );
});

test('active shared production constrains mixed common-general zero-relation dispositions', () => {
  const candidates = [
    makeCommonGeneralCandidate('w9910', '공통예시어', '일상에서 흔히 쓰이는 일반적인 사물 이름.'),
    makeCommonGeneralCandidate('w9911', '보통예시어', '보통 대화에서 자주 쓰이는 일반적인 낱말.'),
    makeCommonGeneralCandidate('w9912', '평범예시어', '일반적인 상황에서 널리 쓰이는 평범한 표현.'),
    makeCommonGeneralCandidate('w9913', '일상예시어', '일상적인 환경에서 흔히 쓰이는 보통 개념어.'),
  ];
  const selectedCandidate = candidates[0];
  const decisionRows = [
    { candidate_record_id: 'w9910', decision: 'included' },
    { candidate_record_id: 'w9911', decision: 'held', hold_basis: 'unresolved-sense' },
    { candidate_record_id: 'w9912', decision: 'rejected', rejection_basis: 'duplicate-identity' },
    { candidate_record_id: 'w9913', decision: 'rejected', rejection_basis: 'not-a-lexical-unit' },
  ];
  decisionRows[0].sense_reviews = [{
    sense_id: selectedCandidate.senses[0].id,
    single_sense_boundary_review: makeSingleSenseBoundaryReview(
      selectedCandidate,
      'searchable-start-common-general-dispositions:decision-source',
      {
        sentenceFrame: '그 사물은 일상에서 흔히 쓰이는 물건이다.',
        relationType: 'direct',
        targetClass: 'common everyday object',
      },
    ),
  }];
  const baseRecord = {
    id: 'w9909',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w9909',
    lemma: '기준예시어',
    search_forms: ['기준예시어'],
    senses: [{ id: 'w9909-s1', pos: 'noun', gloss: '회귀 검증의 기준이 되는 의미.' }],
  };
  const baseRecords = [{ record: baseRecord, source: 'base-canonical' }];
  const prospectiveRecords = [
    ...baseRecords,
    { record: selectedCandidate, source: 'prospective-canonical' },
  ];
  const semanticAudit = makeSemanticAudit(prospectiveRecords, {
    artifactId: 'searchable-start-common-general-dispositions',
  });
  const production = makeProductionState({
    batchId: 'searchable-start-common-general-dispositions',
    artifactId: 'searchable-start-common-general-dispositions',
    candidateRecords: candidates,
    reviewedRecords: [selectedCandidate],
    decisionRows,
    baseRecords,
    prospectiveRecords,
    semanticAudit,
  });
  const canonicalContext = {
    records: prospectiveRecords,
    canonicalDirectory: 'synthetic-common-general-dispositions',
    derived: {
      surfaceFormExceptionManifest: {
        schema_version: 1,
        contract_id: 'm6-2-inflection-exceptions-v1',
        exceptions: [],
      },
      surfaceFormReviewManifest: {
        schema_version: 1,
        contract_id: 'm6-3-searchable-predicate-review-v2',
        source_issue: 209,
        dispositions: [],
        reviewed_collisions: { exact_generated: [], ambiguous_generated: [] },
      },
    },
  };
  const producerArgs = {
    batchId: 'searchable-start-common-general-dispositions',
    candidateRecords: candidates,
    reviews: production.payloads.semantic_review.output.review_rows,
    baseRecords,
    prospectiveRecords,
    semanticAudit,
    productionState: production.state,
    productionStateSources: production.sources,
    productionPayloads: production.payloads,
    canonicalContext,
    catalogCount: candidates.length,
    expectedSelectedCount: 1,
  };

  assert.equal(selectedCandidate.senses[0].relations?.length ?? 0, 0);
  const admitted = validateLexicalProduction(producerArgs);
  assert.equal(admitted.selected_count, 1);
  assert.equal(admitted.production_payloads.admission.output.status, 'admitted');

  for (const [decision, field, expectedCode] of [
    ['held', 'hold_basis', 'LEXICAL_PRODUCTION_DECISION_HOLD_BASIS'],
    ['rejected', 'rejection_basis', 'LEXICAL_PRODUCTION_DECISION_REJECTION_BASIS'],
  ]) {
    for (const invalidBasis of [
      undefined,
      'low-writer-usefulness',
      'low-vividness',
      'common-general-term',
      'zero-relations',
      'axis-deficiency',
    ]) {
      const invalidReviews = structuredClone(producerArgs.reviews);
      const row = invalidReviews.find((entry) => entry.decision === decision);
      if (invalidBasis === undefined) {
        delete row[field];
        delete row.semantic_review.authored_decision[field];
      } else {
        row[field] = invalidBasis;
        row.semantic_review.authored_decision[field] = invalidBasis;
      }
      assert.throws(
        () => validateLexicalProduction({ ...producerArgs, reviews: invalidReviews }),
        (error) => error.code === expectedCode,
        `${decision} cannot exclude this common/general/zero-relation candidate with ${String(invalidBasis)}`,
      );
      assert.throws(
        () => validateLexicalProduction({
          ...producerArgs,
          reviews: invalidReviews,
          allowReplay: true,
          historicalReplay: true,
        }),
        (error) => error.code === expectedCode,
        `historicalReplay cannot bypass ${decision} basis validation for ${String(invalidBasis)}`,
      );
    }
  }

  const changedBasisReviews = structuredClone(producerArgs.reviews);
  const changedHold = changedBasisReviews.find((entry) => entry.decision === 'held');
  changedHold.hold_basis = 'unresolved-identity';
  assert.throws(
    () => validateLexicalProduction({ ...producerArgs, reviews: changedBasisReviews }),
    (error) => error.code === 'LEXICAL_PRODUCTION_DECISION_BASIS_BINDING',
    'valid but changed basis values remain bound to the independent authored review',
  );
});

test('native and WASM SQLite search relation targets by lemma, form, and supported generated surface form', async () => {
  const sqlite3 = await sqlite3InitModule();
  const native = new DatabaseSync(':memory:');
  const wasm = new sqlite3.oo1.DB();

  try {
    seedDatabase(native);
    seedDatabase(wasm);
    for (const term of ['공통표제어', '보통말', '다듬는']) {
      assert.deepEqual(
        findRecordsBySearchTerm(wasm, term),
        findRecordsBySearchTerm(native, term),
        `native and WASM search should agree for ${term}`,
      );
      const response = findRecordsBySearchTerm(wasm, term);
      assert.equal(response.status, 'ready');
      assert.equal(response.matches[0].role, 'reference-only');
    }

    const emptyRelationTarget = getMeaningRecord(wasm, 'r002');
    assert.deepEqual(emptyRelationTarget.senses[0].relations, []);
    assert.equal(findRecordsBySearchTerm(wasm, '공통표제어').matches[0].id, 'r002');
    assert.deepEqual(
      getMeaningRecord(wasm, 'w001').senses[0].relations.map(({ target }) => target),
      ['r002', 'r003'],
      'relation-target navigation remains available for directly searchable records',
    );

    const session = new SearchSession({
      runtime: {
        search: async (term) => findRecordsBySearchTerm(wasm, term),
        getMeaningRecord: async (recordId) => getMeaningRecord(wasm, recordId),
      },
    });
    const state = await session.searchExact('공통표제어');
    assert.equal(state.results[0].id, 'r002');
    assert.equal(state.results[0].role, 'reference-only');
    assert.equal(state.results[0].hasRelations, false);

    const precedence = findRecordsBySearchTerm(wasm, '다듬은');
    assert.deepEqual(precedence.matches.map(({ id }) => id), ['w004', 'r003']);
    assert.deepEqual(precedence.matches.map(({ match }) => match.kind), [
      'exact-search-form',
      'generated-surface-form',
    ]);
  } finally {
    wasm.close();
    native.close();
  }
});
