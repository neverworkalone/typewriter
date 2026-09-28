import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  candidateRecordsFromAuthoredSemanticDecisionSource,
  validateAuthoredDecisionDisposition,
} from '../scripts/batch/authored-semantic-decision-source.mjs';
import { selectReviewedCandidates } from '../scripts/batch/lexical-selection.mjs';
import { SQLITE_SCHEMA_SQL } from '../scripts/build/sqlite-schema.mjs';
import { SearchSession } from '../src/domain/search-session.js';
import {
  SQLITE_SCHEMA_VERSION,
} from '../src/runtime/dictionary-contract.js';
import {
  findRecordsBySearchTerm,
  getRecord,
  getSenseRelations,
} from '../src/runtime/sqlite-query.js';
import { sha256Json } from '../scripts/validate/semantic-audit.mjs';

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
    INSERT INTO senses VALUES
      ('w001-s1', 'w001', 0, 'noun', '검색 출발점'),
      ('r002-s1', 'r002', 0, 'noun', '관계 대상이며 관계는 아직 없음'),
      ('r003-s1', 'r003', 0, 'verb', '관계 대상이며 표면형 규칙을 따름'),
      ('w004-s1', 'w004', 0, 'noun', '정확 검색어와 generated form이 충돌할 때의 precedence 대상');
    INSERT INTO relations VALUES
      ('w001-s1', 0, 'r002', 'r002-s1', 'near', '기준어에서 연결된 보통말'),
      ('w001-s1', 1, 'r003', 'r003-s1', 'action', '기준어에서 이어지는 동작');
    INSERT INTO generated_surface_forms VALUES
      ('다듬는', 'r003', 'r003-s1', 'verb-present-adnominal-neun'),
      ('다듬은', 'r003', 'r003-s1', 'verb-past-adnominal-eun');
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
      rank: 2,
      selection_axis: identity.axis,
      gloss_judgment: 'needs-context',
      decision_rationale: 'part of speech is unresolved',
    },
    {
      candidate_record_id: 'rejected-duplicate',
      decision: 'rejected',
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
  }));
  assert.throws(
    () => validateAuthoredDecisionDisposition({
      decision: 'rejected',
      gloss_judgment: 'reject',
      rejection_basis: 'low-writer-usefulness',
    }, 'low-usefulness rejection', CANDIDATE_CONFIG),
    (error) => error.code === 'SEARCHABLE_START_DECISION_SOURCE_REJECTION_BASIS',
  );

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

    const emptyRelationTarget = getRecord(wasm, 'r002');
    assert.deepEqual(emptyRelationTarget.senses[0].relations, []);
    assert.equal(findRecordsBySearchTerm(wasm, '공통표제어').matches[0].id, 'r002');
    assert.deepEqual(
      getSenseRelations(wasm, 'w001-s1').map(({ target }) => target),
      ['r002', 'r003'],
      'relation-target navigation remains available for directly searchable records',
    );

    const session = new SearchSession({
      runtime: {
        search: async (term) => findRecordsBySearchTerm(wasm, term),
        getRecord: async (recordId) => getRecord(wasm, recordId),
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
