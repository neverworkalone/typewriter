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
import { M5_13_CANDIDATE_IDENTITIES } from '../scripts/batch/m5-13-candidate-source.mjs';
import {
  M5_13_DECISION_SOURCE_CONFIG,
} from '../scripts/batch/m5-13-decision-source.mjs';
import { selectReviewedCandidates } from '../scripts/batch/lexical-selection.mjs';
import {
  AUTHORED_SEMANTIC_REVIEW_BINDING_CONTRACT_VERSION,
  authorSemanticReviewBinding,
  compactAuthoredSemanticDecisionRow,
  SOURCE_BOUND_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
} from '../scripts/validate/semantic-decision-row.mjs';
import { validateLexicalProduction } from '../scripts/batch/lexical-production.mjs';
import { verifyGrandfatheredHistoricalDispositions } from '../scripts/batch/historical-disposition-source.mjs';
import {
  candidateRecordsFromM513DecisionSource,
  readM513DecisionSource,
} from '../scripts/batch/m5-13-decision-source.mjs';
import {
  candidateRecordsFromM512ADecisionSource,
  readM512ADecisionSource,
} from '../scripts/batch/m5-12a-decision-source.mjs';
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

async function makeSourceBoundDispositionFixture() {
  const sourceBytes = await readFile(M5_13_DECISION_SOURCE_CONFIG.sourcePath);
  const original = JSON.parse(sourceBytes.toString('utf8'));
  const originalRowsByDecision = (decision) => original.decisions.filter((row) => row.decision === decision);
  const rows = [
    structuredClone(originalRowsByDecision('included')[0]),
    structuredClone(originalRowsByDecision('held')[0]),
    structuredClone(originalRowsByDecision('included')[1]),
    structuredClone(originalRowsByDecision('included')[2]),
  ];
  const identityById = new Map(M5_13_CANDIDATE_IDENTITIES.map((identity) => [identity.candidate_record_id, identity]));
  const sourceCandidatesById = new Map(original.candidate_records.map((candidate) => [candidate.id, candidate]));
  const identities = rows.map((row) => identityById.get(row.candidate_record_id));
  const candidates = identities.map((identity) => sourceCandidatesById.get(identity.candidate_record_id));

  rows.forEach((row, index) => {
    const identity = identities[index];
    const candidate = candidates[index];
    row.rank = index + 1;
    row.review_pass_id = M5_13_DECISION_SOURCE_CONFIG.verificationPassId;
    delete row.score;
    delete row.hold_basis;
    delete row.rejection_basis;
    if (index === 1) {
      row.decision = 'held';
      row.gloss_judgment = 'needs-context';
      row.hold_basis = 'unresolved-sense';
    } else if (index === 2 || index === 3) {
      row.decision = 'rejected';
      row.gloss_judgment = 'reject';
      row.rejection_basis = index === 2 ? 'duplicate-identity' : 'not-a-lexical-unit';
      row.decision_rationale = `${identity.inventory_id} ${candidate.id}: synthetic ${row.rejection_basis} regression disposition.`;
    }
    if (index === 0) {
      row.sense_reviews[0].single_sense_boundary_review = makeSingleSenseBoundaryReview(
        candidate,
        original.source_id,
        {
          sentenceFrame: '그는 기대한 만큼 채워진 결과에 흡족했다.',
          relationType: 'mood',
          targetClass: 'satisfaction after expectations are met',
        },
      );
    }
  });

  const source = structuredClone(original);
  source.contract_version = SOURCE_BOUND_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION;
  source.review_binding_contract_version = AUTHORED_SEMANTIC_REVIEW_BINDING_CONTRACT_VERSION;
  source.candidate_records = candidates;
  source.candidate_records_sha256 = sha256Json(candidates);
  source.candidate_source.identity_sha256 = sha256Json(identities);
  source.candidate_source.identity_count = identities.length;
  source.selection = {
    ...source.selection,
    capacity: identities.length,
    imported: 1,
    reserve: identities.length - 1,
  };
  source.review = {
    ...source.review,
    candidate_count: identities.length,
    reviewed_candidate_count: identities.length,
    correction_passes: [],
    decision_counts: { included: 1, corrected: 0, held: 1, rejected: 2, deferred: 0 },
    counts: { included: 1, corrected: 0, held: 1, rejected: 2, deferred: 0 },
  };
  source.decisions = rows.map(compactAuthoredSemanticDecisionRow);
  for (const row of source.decisions) {
    const candidate = sourceCandidatesById.get(row.candidate_record_id);
    row.review_binding = authorSemanticReviewBinding(row, candidate);
  }
  const serialized = serializeAuthoredSemanticDecisionSource(source);
  const config = {
    ...M5_13_DECISION_SOURCE_CONFIG,
    selectionCount: identities.length,
    importCount: 1,
    reserveCount: identities.length - 1,
  };
  return { ...serialized, config, identities, candidates };
}

function makeExpressionLexicalUnitReviewFixture(fixture) {
  const identities = structuredClone(fixture.identities);
  const candidates = structuredClone(fixture.candidates);
  const source = structuredClone(fixture.source);
  const rowByCandidateId = new Map(source.decisions.map((row) => [row.candidate_record_id, row]));
  for (const [index, lemma] of [[0, '등을 돌리다'], [3, '역무실 옆 계단']]) {
    const identity = identities[index];
    const candidate = candidates[index];
    identity.lemma = lemma;
    identity.record_type = 'expression';
    identity.pos = 'expression';
    identity.source_basis.lexical_unit = lemma;
    candidate.lemma = lemma;
    candidate.record_type = 'expression';
    candidate.search_forms = [lemma];
    candidate.senses = candidate.senses.map((sense) => ({ ...sense, pos: 'expression' }));
    const row = rowByCandidateId.get(candidate.id);
    row.candidate_record_sha256 = sha256Json(candidate);
    row.lexical_unit_review = index === 0
      ? {
        contract_version: M9_EXPRESSION_LEXICAL_UNIT_REVIEW_CONTRACT_VERSION,
        judgment: 'fixed-or-lexicalized-unit',
        rationale: `${identity.inventory_id} ${candidate.id} ${lemma}: the existing Typewriter expression record supplies a fixed-unit precedent.`,
        evidence: [{
          source: 'data/batches/m5-9-postimport-canonical/pilot.jsonl',
          observation: 'The curated pilot records the exact expression 등을 돌리다 as a multi-sense fixed phrase.',
        }],
      }
      : {
        contract_version: M9_EXPRESSION_LEXICAL_UNIT_REVIEW_CONTRACT_VERSION,
        judgment: 'compositional-phrase',
        rationale: `${identity.inventory_id} ${candidate.id} ${lemma}: this is a freely composed location phrase; the place relation is supplied by 옆 and 계단 rather than a fixed lexical unit.`,
        evidence: [],
      };
    row.decision_rationale = `${identity.inventory_id} ${candidate.id}: source-bound fixture for ${lemma}.`;
    row.sense_reviews = row.sense_reviews.map((senseReview) => ({
      ...senseReview,
      semantic_rationale: `${lemma} is represented by the fixture candidate sense.`,
    }));
  }
  source.candidate_records = candidates;
  source.candidate_records_sha256 = sha256Json(candidates);
  source.candidate_source.identity_sha256 = sha256Json(identities);
  source.candidate_source.identity_count = identities.length;
  source.selection = { ...source.selection, imported: 1, reserve: 0 };
  source.review = {
    ...source.review,
    expression_lexical_unit_review_contract_version: M9_EXPRESSION_LEXICAL_UNIT_REVIEW_CONTRACT_VERSION,
  };
  for (const row of source.decisions) {
    const candidate = candidates.find(({ id }) => id === row.candidate_record_id);
    row.review_binding = authorSemanticReviewBinding(row, candidate);
  }
  const serialized = serializeAuthoredSemanticDecisionSource(source);
  const config = {
    ...fixture.config,
    importCount: 1,
    importCountFromDecisions: true,
    noAdmissionQuota: true,
    reserveCount: 0,
    expressionLexicalUnitReviewContractVersion: M9_EXPRESSION_LEXICAL_UNIT_REVIEW_CONTRACT_VERSION,
  };
  return { ...serialized, config, identities, candidates };
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
      ('w001-s1', 0, 'r002', 'r002-s1', 'near', '기준어에서 연결된 보통말', 3),
      ('w001-s1', 1, 'r003', 'r003-s1', 'action', '기준어에서 이어지는 동작', 4);
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

test('a source-bound unresolved hold and lexical rejections are excluded before shared zero-relation admission', async () => {
  const fixture = await makeSourceBoundDispositionFixture();
  const validation = validateAuthoredSemanticDecisionSource({
    source: fixture.source,
    sourceBytes: fixture.bytes,
    identities: fixture.identities,
    candidateRecords: fixture.candidates,
    config: fixture.config,
  });
  assert.deepEqual(validation.counts, {
    included: 1,
    corrected: 0,
    held: 1,
    rejected: 2,
    deferred: 0,
  });
  assert.equal(validation.selection.selected.length, 1);
  assert.deepEqual(validation.selection.excluded, fixture.source.decisions.slice(1).map(({ candidate_record_id: id }) => id));
  assert.equal(validation.rows[1].hold_basis, 'unresolved-sense');
  assert.equal(validation.rows[2].rejection_basis, 'duplicate-identity');
  assert.equal(validation.rows[3].rejection_basis, 'not-a-lexical-unit');

  const candidates = candidateRecordsFromAuthoredSemanticDecisionSource(
    fixture.source,
    fixture.identities,
    fixture.config,
  );
  const selectedCandidateId = validation.selection.selected[0].candidate_record_id;
  const selectedCandidate = candidates.find(({ id }) => id === selectedCandidateId);
  assert.ok(selectedCandidate);
  assert.equal(selectedCandidate.senses[0].relations?.length ?? 0, 0);

  const baseRecord = {
    id: 'w9900',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w9900',
    lemma: '기준어',
    search_forms: ['기준어'],
    senses: [{ id: 'w9900-s1', pos: 'noun', gloss: '기준이 되는 합성 회귀 예시.' }],
  };
  const baseRecords = [{ record: baseRecord, source: 'base-canonical' }];
  const prospectiveRecords = [
    ...baseRecords,
    { record: selectedCandidate, source: 'prospective-canonical' },
  ];
  const semanticAudit = makeSemanticAudit(prospectiveRecords, {
    artifactId: 'searchable-start-shared-admission',
  });
  const production = makeProductionState({
    batchId: 'searchable-start-shared-admission',
    artifactId: 'searchable-start-shared-admission',
    candidateRecords: candidates,
    reviewedRecords: [selectedCandidate],
    decisionRows: validation.rows,
    baseRecords,
    prospectiveRecords,
    semanticAudit,
  });
  const canonicalContext = {
    records: prospectiveRecords,
    canonicalDirectory: 'synthetic-searchable-start',
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
  const admitted = validateLexicalProduction({
    batchId: 'searchable-start-shared-admission',
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
  });
  assert.equal(admitted.selected_count, 1);
  assert.equal(admitted.production_payloads.admission.output.status, 'admitted');

  const validReviewRows = production.payloads.semantic_review.output.review_rows;
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
      const invalidReviewRows = structuredClone(validReviewRows);
      const row = invalidReviewRows.find((entry) => entry.decision === decision);
      if (invalidBasis === undefined) {
        delete row[field];
        delete row.semantic_review.authored_decision[field];
      } else {
        row[field] = invalidBasis;
        row.semantic_review.authored_decision[field] = invalidBasis;
      }
      assert.throws(
        () => validateLexicalProduction({
          batchId: 'searchable-start-shared-admission',
          candidateRecords: candidates,
          reviews: invalidReviewRows,
          baseRecords,
          prospectiveRecords,
          semanticAudit,
          productionState: production.state,
          productionStateSources: production.sources,
          productionPayloads: production.payloads,
          canonicalContext,
          catalogCount: candidates.length,
          expectedSelectedCount: 1,
        }),
        (error) => error.code === expectedCode,
        `${decision} cannot exclude a common, general, zero-relation candidate with ${String(invalidBasis)}`,
      );
    }
  }

  const unboundReviewRows = structuredClone(validReviewRows);
  const unboundProductionHold = unboundReviewRows.find((entry) => entry.decision === 'held');
  unboundProductionHold.hold_basis = 'unresolved-identity';
  assert.throws(
    () => validateLexicalProduction({
      batchId: 'searchable-start-shared-admission',
      candidateRecords: candidates,
      reviews: unboundReviewRows,
      baseRecords,
      prospectiveRecords,
      semanticAudit,
      productionState: production.state,
      productionStateSources: production.sources,
      productionPayloads: production.payloads,
      canonicalContext,
      catalogCount: candidates.length,
      expectedSelectedCount: 1,
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_DECISION_BASIS_BINDING',
    'a valid but changed production hold basis must remain bound to the independent semantic review',
  );

  for (const [decision, field, invalidBasis, expectedCode] of [
    ...['low-writer-usefulness', 'low-vividness', 'common-general-term', 'zero-relations', 'axis-deficiency']
      .flatMap((basis) => [
        ['held', 'hold_basis', basis, 'M5_13_DECISION_SOURCE_HOLD_BASIS'],
        ['rejected', 'rejection_basis', basis, 'M5_13_DECISION_SOURCE_REJECTION_BASIS'],
      ]),
  ]) {
    const invalid = structuredClone(fixture.source);
    const row = invalid.decisions.find((entry) => entry.decision === decision);
    const candidate = invalid.candidate_records.find(({ id }) => id === row.candidate_record_id);
    row[field] = invalidBasis;
    row.review_binding = authorSemanticReviewBinding(row, candidate);
    const serialized = serializeAuthoredSemanticDecisionSource(invalid);
    assert.throws(
      () => validateAuthoredSemanticDecisionSource({
        source: serialized.source,
        sourceBytes: serialized.bytes,
        identities: fixture.identities,
        candidateRecords: fixture.candidates,
        config: fixture.config,
      }),
      (error) => error.code === expectedCode,
    );
  }

  const unboundBasis = structuredClone(fixture.source);
  const unboundHold = unboundBasis.decisions.find(({ decision }) => decision === 'held');
  unboundHold.hold_basis = 'unresolved-identity';
  const reserializedUnbound = serializeAuthoredSemanticDecisionSource(unboundBasis);
  assert.throws(
    () => validateAuthoredSemanticDecisionSource({
      source: reserializedUnbound.source,
      sourceBytes: reserializedUnbound.bytes,
      identities: fixture.identities,
      candidateRecords: fixture.candidates,
      config: fixture.config,
    }),
    (error) => error.code === 'M5_13_DECISION_SOURCE_BINDING',
    'a valid but changed hold basis must remain covered by the authored review binding',
  );
});

test('M9 expression admission requires a source-bound fixedness judgment and keeps compositional phrases out', async () => {
  const baseFixture = await makeSourceBoundDispositionFixture();
  const fixture = makeExpressionLexicalUnitReviewFixture(baseFixture);
  const validateFixture = (serialized) => validateAuthoredSemanticDecisionSource({
    source: serialized.source,
    sourceBytes: serialized.bytes,
    identities: fixture.identities,
    candidateRecords: fixture.candidates,
    config: fixture.config,
  });

  const validation = validateFixture(fixture);
  assert.equal(validation.selection.selected.length, 1);
  assert.equal(validation.selection.reserve.length, 0);
  assert.equal(validation.selection.selected[0].candidate_record_id, fixture.candidates[0].id);
  assert.equal(validation.rows[3].decision, 'rejected');
  assert.equal(validation.rows[3].rejection_basis, 'not-a-lexical-unit');

  const oldBlanketAdmission = structuredClone(fixture.source);
  const compositional = oldBlanketAdmission.decisions.find(({ candidate_record_id: id }) => id === fixture.candidates[3].id);
  compositional.decision = 'included';
  compositional.gloss_judgment = 'fit';
  delete compositional.rejection_basis;
  compositional.decision_rationale = `${fixture.identities[3].inventory_id} ${fixture.candidates[3].id}: deliberately attempts to admit a compositional phrase.`;
  oldBlanketAdmission.selection = { ...oldBlanketAdmission.selection, imported: 2 };
  oldBlanketAdmission.review = {
    ...oldBlanketAdmission.review,
    decision_counts: { included: 2, corrected: 0, held: 1, rejected: 1, deferred: 0 },
    counts: { included: 2, corrected: 0, held: 1, rejected: 1, deferred: 0 },
  };
  for (const row of oldBlanketAdmission.decisions) {
    const candidate = fixture.candidates.find(({ id }) => id === row.candidate_record_id);
    row.review_binding = authorSemanticReviewBinding(row, candidate);
  }
  const invalidSerialized = serializeAuthoredSemanticDecisionSource(oldBlanketAdmission);
  assert.throws(
    () => validateFixture(invalidSerialized),
    (error) => error.code === 'M5_13_EXPRESSION_LEXICAL_UNIT_REVIEW',
    'the prior blanket admission must fail before shared lexical admission',
  );

  const missingFixedness = structuredClone(fixture.source);
  const fixedExpression = missingFixedness.decisions.find(({ candidate_record_id: id }) => id === fixture.candidates[0].id);
  delete fixedExpression.lexical_unit_review;
  fixedExpression.review_binding = authorSemanticReviewBinding(fixedExpression, fixture.candidates[0]);
  const missingReviewSerialized = serializeAuthoredSemanticDecisionSource(missingFixedness);
  assert.throws(
    () => validateFixture(missingReviewSerialized),
    (error) => error.code === 'M5_13_EXPRESSION_LEXICAL_UNIT_REVIEW',
    'a supported fixed expression cannot be admitted without the independent fixedness judgment',
  );

  const m9SourceWithoutCallerContract = structuredClone(fixture.source);
  m9SourceWithoutCallerContract.issue = 220;
  m9SourceWithoutCallerContract.parent_issue = 218;
  m9SourceWithoutCallerContract.batch_id = 'm9-future-batch-without-caller-contract';
  const m9FixedExpression = m9SourceWithoutCallerContract.decisions.find(
    ({ candidate_record_id: id }) => id === fixture.candidates[0].id,
  );
  delete m9FixedExpression.lexical_unit_review;
  m9FixedExpression.review_binding = authorSemanticReviewBinding(m9FixedExpression, fixture.candidates[0]);
  const m9ConfigWithoutContract = {
    ...fixture.config,
    issue: 220,
    parentIssue: 218,
    batchId: m9SourceWithoutCallerContract.batch_id,
  };
  delete m9ConfigWithoutContract.expressionLexicalUnitReviewContractVersion;
  const m9WithoutFixedness = serializeAuthoredSemanticDecisionSource(m9SourceWithoutCallerContract);
  assert.throws(
    () => validateAuthoredSemanticDecisionSource({
      source: m9WithoutFixedness.source,
      sourceBytes: m9WithoutFixedness.bytes,
      identities: fixture.identities,
      candidateRecords: fixture.candidates,
      config: m9ConfigWithoutContract,
    }),
    (error) => error.code === 'M5_13_EXPRESSION_LEXICAL_UNIT_REVIEW',
    'an M9 child cannot omit expression fixedness by leaving the config option unset',
  );

  const m9SourceWithoutHeaderContract = structuredClone(fixture.source);
  m9SourceWithoutHeaderContract.issue = 220;
  m9SourceWithoutHeaderContract.parent_issue = 218;
  m9SourceWithoutHeaderContract.batch_id = 'm9-future-batch-without-review-header-contract';
  delete m9SourceWithoutHeaderContract.review.expression_lexical_unit_review_contract_version;
  const m9WithoutReviewHeader = serializeAuthoredSemanticDecisionSource(m9SourceWithoutHeaderContract);
  assert.throws(
    () => validateAuthoredSemanticDecisionSource({
      source: m9WithoutReviewHeader.source,
      sourceBytes: m9WithoutReviewHeader.bytes,
      identities: fixture.identities,
      candidateRecords: fixture.candidates,
      config: { ...m9ConfigWithoutContract, batchId: m9SourceWithoutHeaderContract.batch_id },
    }),
    (error) => error.code === 'M5_13_EXPRESSION_LEXICAL_UNIT_REVIEW',
    'an M9 child must declare the shared fixedness contract in its review metadata',
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

test('historicalReplay exempts only rows bound to exact grandfathered M5 decision sources', async () => {
  const sourceFile = await readM513DecisionSource();
  const candidates = candidateRecordsFromM513DecisionSource(sourceFile.source);
  const reviews = sourceFile.source.decisions.map((row) => ({
    candidate_id: row.candidate_record_id,
    inventory_id: row.inventory_id,
    decision: row.decision,
    semantic_review: {},
  }));
  const historicalDispositionSource = {
    sourcePath: 'data/batches/m5-13-semantic-decisions.json',
    sourceBytes: sourceFile.sourceBytes,
  };
  const grandfatheredIds = verifyGrandfatheredHistoricalDispositions({
    batchId: sourceFile.source.batch_id,
    candidateRecords: candidates,
    reviews,
    historicalDispositionSource,
  });
  assert.equal(grandfatheredIds.size, 46);
  assert.ok(grandfatheredIds.has('w2252'));

  const changedReview = structuredClone(reviews);
  changedReview.find(({ candidate_id: id }) => id === 'w2252').decision = 'included';
  assert.throws(
    () => verifyGrandfatheredHistoricalDispositions({
      batchId: sourceFile.source.batch_id,
      candidateRecords: candidates,
      reviews: changedReview,
      historicalDispositionSource,
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_HISTORICAL_SOURCE_BINDING',
  );

  const alteredSourceBytes = Buffer.from(`${sourceFile.sourceBytes.toString('utf8')} `, 'utf8');
  assert.equal(verifyGrandfatheredHistoricalDispositions({
    batchId: sourceFile.source.batch_id,
    candidateRecords: candidates,
    reviews,
    historicalDispositionSource: {
      ...historicalDispositionSource,
      sourceBytes: alteredSourceBytes,
    },
  }).size, 0);

  const m512aSourceFile = await readM512ADecisionSource();
  const m512aCandidates = candidateRecordsFromM512ADecisionSource(
    m512aSourceFile.source,
  );
  const m512aReviews = m512aSourceFile.source.decisions.map((row) => ({
    candidate_id: row.candidate_record_id,
    inventory_id: row.inventory_id,
    decision: row.decision,
    semantic_review: {},
  }));
  const m512aGrandfatheredIds = verifyGrandfatheredHistoricalDispositions({
    batchId: m512aSourceFile.source.batch_id,
    candidateRecords: m512aCandidates,
    reviews: m512aReviews,
    historicalDispositionSource: {
      sourcePath: 'data/batches/m5-12a-semantic-decisions.json',
      sourceBytes: m512aSourceFile.sourceBytes,
    },
  });
  assert.equal(m512aGrandfatheredIds.size, 50);
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
