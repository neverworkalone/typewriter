import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  auditCanonicalLexicalQuality,
  buildNominalTermPositions,
  requiresTopicAnalysis,
  LexicalQualityError,
  inspectWriterDomainEvidence,
  inspectGlossQuality,
  inspectGlossConnectors,
  inspectMalformedParticles,
  findAmbiguousParticleFragments,
  findBulkGlossProjectionFindings,
  validateBulkGlossProjection,
  validateLexicalSemanticReview,
  validateLexicalRecord,
} from '../scripts/validate/lexical-quality.mjs';
import { validateLexicalAddition as validateLexicalAdditionImpl } from '../scripts/batch/lexical-admission.mjs';
import { createCanonicalContext } from '../scripts/validate/canonical-context.mjs';
import { validateLexicalProduction } from '../scripts/batch/lexical-production.mjs';
import { productionValueSha256 } from '../scripts/batch/lexical-production-state.mjs';
import {
  buildSemanticCoverageArtifact,
  buildSemanticTopicEvidence,
  canonicalRecordsSha256,
  inspectSenseBoundaryPairs,
  sha256Json,
  validateSemanticAuditCoverage,
} from '../scripts/validate/semantic-audit.mjs';
import {
  DatasetIntegrityError,
  validateDatasetRecords,
  validateDatasetDirectory,
} from '../scripts/validate/dataset-integrity.mjs';
import {
  makeProductionState,
  makeSemanticAudit,
} from './helpers/semantic-audit-fixture.mjs';

const MALFORMED_TOPIC_REGRESSIONS = JSON.parse(readFileSync(
  path.resolve('tests/fixtures/lexical-quality/malformed-topic-regressions.json'),
  'utf8',
));

const FIXTURE_ROOT = path.resolve('tests/fixtures/lexical-quality');
const TOPIC_EVIDENCE_SENSE_ID = 'w-topic-evidence-s1';

function asSurfaceFormTestRecordInfos(records = []) {
  return records.map((recordInfo, index) => (recordInfo?.record
    ? recordInfo
    : { record: recordInfo, source: `surface-form-test:${index + 1}` }));
}

function surfaceFormTestContext(records, {
  exceptions = [],
  dispositions = [],
} = {}) {
  const recordInfos = asSurfaceFormTestRecordInfos(records);
  const context = createCanonicalContext({ records: recordInfos }, {
    canonicalDirectory: path.join(FIXTURE_ROOT, 'surface-form-canonical'),
    source: 'fixture',
  });
  context.derived.surfaceFormExceptionManifest = {
    schema_version: 1,
    contract_id: 'm6-2-inflection-exceptions-v1',
    source_issue: 174,
    exceptions,
  };
  context.derived.surfaceFormReviewManifest = {
    schema_version: 1,
    contract_id: 'm6-3-surface-form-review-v1',
    source_issue: 175,
    dispositions,
    reviewed_collisions: {
      exact_generated: [],
      ambiguous_generated: [],
    },
  };
  return context;
}

// Most tests here exercise lexical policy on small, noncanonical fixtures.
// Give their predicate senses an explicit fixture-only exclusion so the live
// admission path can keep its strict surface-form gate enabled.
function validateLexicalAddition(options = {}) {
  if (options.canonicalContext) return validateLexicalAdditionImpl(options);
  const recordInfos = asSurfaceFormTestRecordInfos(options.prospectiveRecords);
  const dispositions = recordInfos.flatMap(({ record }) => (
    record.role === 'start' && record.record_type === 'entry'
      ? record.senses
        .filter((sense) => ['verb', 'adjective'].includes(sense.pos) && record.lemma.endsWith('다'))
        .map((sense) => ({
          class_id: 'm6-3-predicate-excluded',
          record_id: record.id,
          sense_id: sense.id,
          reason: 'Synthetic lexical-admission fixture does not exercise inflection search.',
        }))
      : []
  ));
  return validateLexicalAdditionImpl({
    ...options,
    canonicalContext: surfaceFormTestContext(recordInfos, { dispositions }),
  });
}

test('live common admission requires surface-form classifications for predicate senses', () => {
  const candidateRecord = {
    id: 'w779',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w779',
    lemma: '맛있다',
    search_forms: ['맛있다'],
    senses: [{
      id: 'w779-s1',
      pos: 'adjective',
      gloss: '음식의 맛이 좋아 먹기에 즐겁다.',
    }],
  };
  const prospectiveRecords = [{ record: candidateRecord, source: 'surface-form-admission-fixture' }];
  const semanticAudit = makeSemanticAudit(prospectiveRecords);
  const productionState = makeProductionState({
    batchId: 'future-surface-form-admission',
    candidateRecords: [candidateRecord],
    reviewedRecords: prospectiveRecords,
    prospectiveRecords,
    semanticAudit,
  });
  const admissionOptions = {
    batchId: 'future-surface-form-admission',
    candidateRecords: [candidateRecord],
    reviewedRecords: prospectiveRecords,
    baseRecords: [],
    prospectiveRecords,
    semanticAudit,
    productionState: productionState.state,
    productionStateSources: productionState.sources,
    productionPayloads: productionState.payloads,
  };

  const unclassifiedContext = surfaceFormTestContext(prospectiveRecords);
  assert.throws(
    () => validateLexicalAdditionImpl({
      ...admissionOptions,
      canonicalContext: unclassifiedContext,
    }),
    (error) => error.code === 'MISSING_EXCEPTION_CLASS',
  );

  const classifiedContext = surfaceFormTestContext(prospectiveRecords, {
    exceptions: [{
      class_id: 'm6-2-itda-present-adnominal',
      record_id: candidateRecord.id,
      sense_id: candidateRecord.senses[0].id,
    }],
  });
  const result = validateLexicalAdditionImpl({
    ...admissionOptions,
    canonicalContext: classifiedContext,
  });
  assert.equal(result.audit.blocking_finding_count, 0);
  assert.ok(classifiedContext.derived.surfaceFormProjection.rows.some(
    ({ form, record_id: recordId, sense_id: senseId }) => (
      form === '맛있는' && recordId === candidateRecord.id && senseId === candidateRecord.senses[0].id
    ),
  ));
});

function topicEvidenceForGloss(gloss, analysis = {}) {
  const record = {
    id: 'w-topic-evidence',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w-topic-evidence',
    lemma: '주제근거',
    search_forms: ['주제근거'],
    senses: [{ id: 'w-topic-evidence-s1', pos: 'noun', gloss }],
  };
  const recordInfos = [{ record, source: 'semantic-review-fixture' }];
  const semanticAudit = makeSemanticAudit(recordInfos, {
    topicAnalyses: { 'w-topic-evidence-s1': analysis },
  });
  return buildSemanticTopicEvidence(recordInfos, semanticAudit);
}

test('the shared audit covers the complete current canonical dictionary', async () => {
  const result = await validateDatasetDirectory(path.resolve('data/canonical'), {
    checkPilotCompleteness: true,
  });
  assert.equal(result.recordCount, 5042);

  const { readCanonicalRecords } = await import('../scripts/validate/canonical-jsonl.mjs');
  const canonical = await readCanonicalRecords(path.resolve('data/canonical'));
  const audit = auditCanonicalLexicalQuality(canonical.records, { throwOnError: false });
  assert.equal(audit.scope, 'complete-canonical');
  assert.equal(audit.blocking_finding_count, 0);
  assert.equal(audit.record_count, 5042);
  assert.equal(audit.sense_count, 5301);
});

test('the shared production boundary rejects bulk gloss projection without a batch allowlist', () => {
  const records = Array.from({ length: 4 }, (_, index) => ({
    id: `w-bulk-${index}`,
    record_type: 'entry',
    role: 'start',
    candidate_id: `w-bulk-${index}`,
    lemma: `후보${index}`,
    search_forms: [`후보${index}`],
    senses: [{
      id: `w-bulk-${index}-s1`,
      pos: 'noun',
      gloss: '같은 뜻풀이를 반복한 후보 의미',
    }],
  }));

  const findings = findBulkGlossProjectionFindings(records, { maxOccurrences: 3 });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'LEXICAL_BULK_GLOSS_PROJECTION');
  assert.throws(
    () => validateBulkGlossProjection(records, { maxOccurrences: 3 }),
    (error) => error.code === 'LEXICAL_BULK_GLOSS_PROJECTION',
  );
  assert.doesNotThrow(() => validateBulkGlossProjection(records.slice(0, 3), { maxOccurrences: 3 }));
});

test('the shared production boundary rejects parameterized gloss templates with unique surfaces', () => {
  const records = ['푸름의 결', '붉음의 결', '고요의 결', '긴장의 결'].map((lemma, index) => {
    const root = lemma.split('의')[0];
    return {
      id: `w-parameterized-${index}`,
      record_type: 'entry',
      role: 'start',
      candidate_id: `w-parameterized-${index}`,
      lemma,
      search_forms: [lemma],
      senses: [{
        id: `w-parameterized-${index}-s1`,
        pos: 'noun',
        gloss: `‘${lemma}’은 표면과 분위기에 드러나는 미세한 차이를 가리키며, ${root}을 정도나 인상의 변화로 묘사할 때 쓴다.`,
      }],
    };
  });

  const findings = findBulkGlossProjectionFindings(records, { maxOccurrences: 3 });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'LEXICAL_PARAMETERIZED_GLOSS_PROJECTION');
  assert.equal(findings[0].kind, 'parameterized-template');
  assert.throws(
    () => validateBulkGlossProjection(records, { maxOccurrences: 3 }),
    (error) => error.code === 'LEXICAL_PARAMETERIZED_GLOSS_PROJECTION',
  );
});

test('the shared production boundary rejects scene and action variations on one gloss scaffold', () => {
  const records = [
    ['문턱에서 멈춘 때', '말의 속도를 낮추는 말이다'],
    ['비가 그친 뒤', '시선의 방향을 바꾸는 말이다'],
    ['낯선 방에 들어선 순간', '인물의 선택을 보여 주는 말이다'],
    ['누군가를 기다리는 장면', '감각의 여운을 남기는 말이다'],
  ].map(([scene, action], index) => ({
    id: `w-scene-action-${index}`,
    record_type: 'entry',
    role: 'start',
    candidate_id: `w-scene-action-${index}`,
    lemma: `장면어${index}`,
    search_forms: [`장면어${index}`],
    senses: [{
      id: `w-scene-action-${index}-s1`,
      pos: 'noun',
      gloss: `‘장면어${index}’이라는 말은 ${scene}에서 ${action}`,
    }],
  }));

  const findings = findBulkGlossProjectionFindings(records, { maxOccurrences: 3 });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'LEXICAL_PARAMETERIZED_GLOSS_PROJECTION');
  assert.equal(findings[0].kind, 'projection-scaffold');
  assert.equal(findings[0].owners.length, 4);
  assert.throws(
    () => validateBulkGlossProjection(records, { maxOccurrences: 3 }),
    (error) => error.code === 'LEXICAL_PARAMETERIZED_GLOSS_PROJECTION',
  );

  const authoredDefinitions = records.map((record, index) => ({
    ...record,
    senses: [{
      ...record.senses[0],
      gloss: [
        '좁은 출입구 앞에 높여 안과 밖의 이동을 가로막는 구조물.',
        '빗물이 그친 뒤 흙과 식물에서 올라오는 냄새.',
        '서로 떨어진 장소를 이어 사람이 건너게 만든 구조물.',
        '손가락으로 눌러 기기를 조작하는 작은 입력 장치.',
      ][index],
    }],
  }));
  assert.doesNotThrow(() => validateBulkGlossProjection(authoredDefinitions, { maxOccurrences: 3 }));
});

test('shared candidate admission rejects conjugated verb forms used as dictionary lemmas', () => {
  const inflected = {
    id: 'w-inflected-verb-lemma',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w-inflected-verb-lemma',
    lemma: '기댔다',
    search_forms: ['기댔다'],
    senses: [{
      id: 'w-inflected-verb-lemma-s1',
      pos: 'verb',
      gloss: '몸의 일부를 다른 물체에 기대어 무게를 실었다.',
    }],
  };
  assert.throws(
    () => validateLexicalRecord(inflected, { mode: 'candidate' }),
    (error) => error.code === 'LEXICAL_INFLECTED_VERB_LEMMA',
  );

  const citationForm = {
    ...inflected,
    id: 'w-citation-verb-lemma',
    candidate_id: 'w-citation-verb-lemma',
    lemma: '기대다',
    search_forms: ['기대다'],
    senses: [{
      id: 'w-citation-verb-lemma-s1',
      pos: 'verb',
      gloss: '몸의 일부를 다른 물체에 대어 무게를 맡기다.',
    }],
  };
  assert.doesNotThrow(() => validateLexicalRecord(citationForm, { mode: 'candidate' }));
  assert.doesNotThrow(() => validateLexicalRecord({
    ...citationForm,
    id: 'w-ida-citation-verb-lemma',
    candidate_id: 'w-ida-citation-verb-lemma',
    lemma: '있다',
    search_forms: ['있다'],
    senses: [{
      id: 'w-ida-citation-verb-lemma-s1',
      pos: 'verb',
      gloss: '어떤 곳이나 상태에 존재하거나 무엇을 가지고 있다.',
    }],
  }, { mode: 'candidate' }));
});

test('the shared production boundary compares definition cores before appended examples', () => {
  const records = ['푸름의 결', '붉음의 결', '고요의 결', '긴장의 결'].map((lemma, index) => {
    const root = lemma.split('의')[0];
    return {
      id: `w-definition-core-${index}`,
      record_type: 'entry',
      role: 'start',
      candidate_id: `w-definition-core-${index}`,
      lemma,
      search_forms: [lemma],
      senses: [{
        id: `w-definition-core-${index}-s1`,
        pos: 'noun',
        gloss: `‘${lemma}’은 표면과 분위기에 드러나는 미세한 차이를 가리키며, ${root}을 문장의 인상으로 포착한다. ${root}이 놓이는 장면은 후보마다 다르다.`,
      }],
    };
  });

  const findings = findBulkGlossProjectionFindings(records, { maxOccurrences: 3 });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'LEXICAL_PARAMETERIZED_GLOSS_PROJECTION');
  assert.equal(findings[0].owners.length, 4);
  assert.throws(
    () => validateBulkGlossProjection(records, { maxOccurrences: 3 }),
    (error) => error.code === 'LEXICAL_PARAMETERIZED_GLOSS_PROJECTION',
  );
});

test('the shared lexical quality rule rejects incompatible nominal particles', () => {
  const malformed = '감정의 결으로 묘사할 때, 젖은 운동화과 맞물리는 장면을 포착한다.';
  const findings = inspectMalformedParticles(malformed);
  assert.deepEqual(
    findings.map(({ token, expected_particle }) => [token, expected_particle]),
    [['결으로', '로'], ['운동화과', '와']],
  );
  assert.deepEqual(inspectMalformedParticles('감정의 결로 묘사할 때, 젖은 운동화와 맞물린다.'), []);
  assert.deepEqual(inspectMalformedParticles('가까이 보이는 곳과 미리 정한 약속'), []);
  assert.deepEqual(inspectGlossQuality(malformed).malformed_particles, findings);
});

test('the shared particle rule covers conjugated and nominal-complement contexts', () => {
  const malformed = '멈춘 엘리베이터과 맞물려 짧은 환기를 남긴다. 젖은 운동화을 배경으로 후회가 번진다. 느린 횡단보도과 맞물려 생각을 가다듬는다.';
  assert.deepEqual(
    inspectMalformedParticles(malformed).map(({ token, expected_particle, next_token }) => [
      token,
      expected_particle,
      next_token,
    ]),
    [
      ['엘리베이터과', '와', '맞물려'],
      ['운동화을', '를', '배경으로'],
      ['횡단보도과', '와', '맞물려'],
    ],
  );
  assert.deepEqual(
    inspectMalformedParticles('멈춘 엘리베이터와 맞물려 젖은 운동화를 배경으로 느린 횡단보도와 맞물려'),
    [],
  );
});

test('the shared particle rule preserves productive adnominal endings before complements', () => {
  for (const gloss of [
    '먹는 방식으로 묘사한다.',
    '읽는 방식으로 설명한다.',
    '있는 방향으로 시선이 움직인다.',
  ]) {
    assert.deepEqual(inspectMalformedParticles(gloss), [], gloss);
  }
});

test('the shared particle rule keeps unverified terminal 이 surfaces open-world', () => {
  const recordInfos = [
    {
      source: 'complete-canonical',
      record: {
        id: 'w990',
        record_type: 'entry',
        role: 'start',
        candidate_id: 'w990',
        lemma: 'lexical-adverb-fixture',
        search_forms: ['lexical-adverb-fixture'],
        senses: [{ id: 'w990-s1', pos: 'adverb', gloss: '가벼이 바라본다.' }],
      },
    },
    {
      source: 'complete-canonical',
      record: {
        id: 'w991',
        record_type: 'entry',
        role: 'start',
        candidate_id: 'w991',
        lemma: 'positive-topic-fixture',
        search_forms: ['positive-topic-fixture'],
        senses: [{ id: 'w991-s1', pos: 'noun', gloss: '바다이 보인다.' }],
      },
    },
    {
      source: 'complete-canonical',
      record: {
        id: 'w992',
        record_type: 'entry',
        role: 'start',
        candidate_id: 'w992',
        lemma: 'mid-sentence-topic-fixture',
        search_forms: ['mid-sentence-topic-fixture'],
        senses: [{ id: 'w992-s1', pos: 'noun', gloss: '문장에서는 바다이 보인다.' }],
      },
    },
  ];
  assert.deepEqual(inspectMalformedParticles('가벼이 바라본다.'), []);
  assert.deepEqual(inspectMalformedParticles('바다이 보인다.'), []);
  assert.deepEqual(inspectMalformedParticles('문장에서는 바다이 보인다.'), []);

  const semanticAudit = makeSemanticAudit(recordInfos, {
    topicAnalyses: {
      'w991-s1': {
        state: 'noun-topic',
        topic: '바다',
        particle: '이',
        predicate: '보인다',
      },
      'w992-s1': {
        state: 'noun-topic',
        topic: '바다',
        particle: '이',
        predicate: '보인다',
      },
    },
  });
  const audit = auditCanonicalLexicalQuality(recordInfos, {
    throwOnError: false,
    topicEvidence: buildSemanticTopicEvidence(recordInfos, semanticAudit),
  });
  assert.deepEqual(
    audit.blocking_findings
      .filter(({ code }) => code === 'LEXICAL_MALFORMED_PARTICLE')
      .map(({ record_id, observation }) => [record_id, observation.token, observation.expected_particle]),
    [
      ['w991', '바다이', '가'],
      ['w992', '바다이', '가'],
    ],
  );
});

test('the shared particle rule still rejects nominal 은/는 outside adnominal ambiguity', () => {
  for (const [gloss, token, expectedParticle] of [
    ['운동화은 보인다.', '운동화은', '는'],
    ['책는 보인다.', '책는', '은'],
  ]) {
    assert.deepEqual(
      inspectMalformedParticles(gloss).map(({ token: findingToken, expected_particle }) => [
        findingToken,
        expected_particle,
      ]),
      [[token, expectedParticle]],
      gloss,
    );
  }

  assert.deepEqual(
    inspectMalformedParticles('먹는 방식으로 묘사한다.', {
      nominalTerms: new Map([['먹', new Set(['noun'])]]),
    }),
    [],
  );
});

test('the complete canonical audit catches missed particle surface contexts', () => {
  const recordInfos = [
    ['w980', '멈춘 엘리베이터과 맞물려 장면을 그린다.'],
    ['w981', '젖은 운동화을 배경으로 장면을 그린다.'],
    ['w982', '느린 횡단보도과 맞물려 장면을 그린다.'],
    ['w983', '운동화은 보인다.'],
    ['w984', '먹는 방식으로 묘사한다.'],
  ].map(([id, gloss]) => ({
    source: 'complete-canonical',
    record: {
      id,
      record_type: 'entry',
      role: 'start',
      candidate_id: id,
      lemma: `particle-${id}`,
      search_forms: [`particle-${id}`],
      senses: [{ id: `${id}-s1`, pos: 'noun', gloss }],
    },
  }));
  const audit = auditCanonicalLexicalQuality(recordInfos, { throwOnError: false });
  assert.deepEqual(
    audit.blocking_findings
      .filter(({ code }) => code === 'LEXICAL_MALFORMED_PARTICLE')
      .map(({ record_id, observation }) => [record_id, observation.token, observation.expected_particle]),
    [
      ['w980', '엘리베이터과', '와'],
      ['w981', '운동화을', '를'],
      ['w982', '횡단보도과', '와'],
      ['w983', '운동화은', '는'],
    ],
  );
});

test('the complete canonical audit preserves adnominal homographs with inflectional evidence', () => {
  const recordInfos = [
    {
      source: 'complete-canonical',
      record: {
        id: 'w985',
        record_type: 'entry',
        role: 'start',
        candidate_id: 'w985',
        lemma: '먹',
        search_forms: ['먹'],
        senses: [{ id: 'w985-s1', pos: 'noun', gloss: '먹은 흔적을 남긴다.' }],
      },
    },
    {
      source: 'complete-canonical',
      record: {
        id: 'w986',
        record_type: 'entry',
        role: 'start',
        candidate_id: 'w986',
        lemma: '먹다',
        search_forms: ['먹다'],
        senses: [{ id: 'w986-s1', pos: 'verb', gloss: '음식을 삼키는 행위다.' }],
      },
    },
    {
      source: 'complete-canonical',
      record: {
        id: 'w987',
        record_type: 'entry',
        role: 'start',
        candidate_id: 'w987',
        lemma: 'homograph-particle',
        search_forms: ['homograph-particle'],
        senses: [{ id: 'w987-s1', pos: 'noun', gloss: '먹는 방식으로 묘사한다.' }],
      },
    },
  ];
  const audit = auditCanonicalLexicalQuality(recordInfos, { throwOnError: false });
  assert.deepEqual(
    audit.blocking_findings.filter(({ code }) => code === 'LEXICAL_MALFORMED_PARTICLE'),
    [],
  );
  assert.deepEqual(
    [...buildNominalTermPositions(recordInfos).get('먹')].sort(),
    ['noun', 'verb'],
  );
});

test('the complete canonical audit stays open-world when a competing stem is not admitted', () => {
  const recordInfos = [
    {
      source: 'complete-canonical',
      record: {
        id: 'w988',
        record_type: 'entry',
        role: 'start',
        candidate_id: 'w988',
        lemma: '먹',
        search_forms: ['먹'],
        senses: [{ id: 'w988-s1', pos: 'noun', gloss: '먹은 흔적을 남긴다.' }],
      },
    },
    {
      source: 'complete-canonical',
      record: {
        id: 'w989',
        record_type: 'entry',
        role: 'start',
        candidate_id: 'w989',
        lemma: 'open-world-particle',
        search_forms: ['open-world-particle'],
        senses: [{ id: 'w989-s1', pos: 'noun', gloss: '먹는 방식으로 묘사한다.' }],
      },
    },
  ];
  const audit = auditCanonicalLexicalQuality(recordInfos, { throwOnError: false });
  assert.deepEqual(
    audit.blocking_findings.filter(({ code }) => code === 'LEXICAL_MALFORMED_PARTICLE'),
    [],
  );
});

test('bound noun-topic evidence resolves an ambiguous 은/는 before a noun-like complement', () => {
  const gloss = '문장에서는 운동화은 배경으로 장면을 그린다.';
  const quality = inspectGlossQuality(gloss, {
    topicEvidence: topicEvidenceForGloss(gloss, {
      state: 'noun-topic',
      topic: '운동화',
      particle: '은',
      predicate: '배경으로',
    }),
    senseId: TOPIC_EVIDENCE_SENSE_ID,
  });
  assert.deepEqual(
    quality.malformed_particles.map(({ token, expected_particle }) => [token, expected_particle]),
    [['운동화은', '는']],
  );
});

test('token-span ambiguity drives semantic-audit topic evidence requirements', () => {
  const records = [
    ['w-topic-span-adnominal', '문장에서는 운동화은 배경으로 장면을 그린다.'],
    ['w-topic-span-terminal-i', '문장에서는 바다이 보인다.'],
    ['w-topic-span-valid-adnominal', '먹는 방식으로 묘사한다.'],
  ].map(([id, gloss]) => ({
    id,
    record_type: 'entry',
    role: 'start',
    candidate_id: id,
    lemma: id,
    search_forms: [id],
    senses: [{ id: `${id}-s1`, pos: 'noun', gloss }],
  }));
  const recordInfos = records.map((record) => ({ record, source: 'topic-span-regression' }));
  assert.equal(requiresTopicAnalysis(records[0].senses[0].gloss), true);
  assert.equal(requiresTopicAnalysis(records[1].senses[0].gloss), true);
  assert.equal(requiresTopicAnalysis(records[2].senses[0].gloss), true);

  const semanticAudit = makeSemanticAudit(recordInfos, {
    topicAnalyses: {
      'w-topic-span-adnominal-s1': {
        state: 'noun-topic',
        topic: '운동화',
        particle: '은',
        predicate: '배경으로',
      },
      'w-topic-span-terminal-i-s1': {
        state: 'noun-topic',
        topic: '바다',
        particle: '이',
        predicate: '보인다',
      },
      'w-topic-span-valid-adnominal-s1': {
        state: 'adnominal',
        topic: '먹',
        particle: '는',
        predicate: '방식으로',
      },
    },
  });
  assert.doesNotThrow(() => buildSemanticTopicEvidence(recordInfos, semanticAudit));

  const missingEvidence = structuredClone(semanticAudit);
  delete missingEvidence.review.records
    .find(({ record_id: recordId }) => recordId === 'w-topic-span-adnominal')
    .sense_reviews[0].review_basis.topic_analysis;
  assert.throws(
    () => buildSemanticTopicEvidence(recordInfos, missingEvidence),
    (error) => error.code === 'SEMANTIC_AUDIT_INCOMPLETE',
  );
});

test('semantic-audit topic evidence covers every ambiguous span in one gloss', () => {
  const record = {
    id: 'w-topic-span-multi',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w-topic-span-multi',
    lemma: '복합주제',
    search_forms: ['복합주제'],
    senses: [{
      id: 'w-topic-span-multi-s1',
      pos: 'noun',
      gloss: '문장에서는 운동화은 배경으로 바다이 보인다.',
    }],
  };
  const recordInfos = [{ record, source: 'topic-span-multi-regression' }];
  assert.equal(findAmbiguousParticleFragments(record.senses[0].gloss).length, 2);

  const semanticAudit = makeSemanticAudit(recordInfos, {
    topicAnalyses: {
      'w-topic-span-multi-s1': [
        {
          state: 'adnominal',
          topic: '운동화',
          particle: '은',
          predicate: '배경으로',
        },
        {
          state: 'noun-topic',
          topic: '바다',
          particle: '이',
          predicate: '보인다',
        },
      ],
    },
  });
  const reviewBasis = semanticAudit.review.records[0].sense_reviews[0].review_basis;
  assert.deepEqual(
    reviewBasis.topic_analyses.map(({ token_index: tokenIndex }) => tokenIndex),
    [1, 3],
  );
  assert.doesNotThrow(() => buildSemanticTopicEvidence(recordInfos, semanticAudit));

  const missingSpanEvidence = structuredClone(semanticAudit);
  missingSpanEvidence.review.records[0].sense_reviews[0].review_basis.topic_analyses.pop();
  assert.throws(
    () => buildSemanticTopicEvidence(recordInfos, missingSpanEvidence),
    (error) => error.code === 'SEMANTIC_AUDIT_INCOMPLETE'
      && error.message.includes('exactly one analysis per ambiguous particle span'),
  );
});

test('topic evidence lookup stays span-exact for repeated ambiguous surfaces', () => {
  const record = {
    id: 'w-topic-span-repeated',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w-topic-span-repeated',
    lemma: '반복주제',
    search_forms: ['반복주제'],
    senses: [{
      id: 'w-topic-span-repeated-s1',
      pos: 'noun',
      gloss: '문장에서는 운동화은 배경으로 운동화은 배경으로 장면을 그린다.',
    }],
  };
  const recordInfos = [{ record, source: 'topic-span-repeated-regression' }];
  const semanticAudit = makeSemanticAudit(recordInfos, {
    topicAnalyses: {
      'w-topic-span-repeated-s1': [
        {
          state: 'adnominal',
          topic: '운동화',
          particle: '은',
          predicate: '배경으로',
        },
        {
          state: 'noun-topic',
          topic: '운동화',
          particle: '은',
          predicate: '배경으로',
        },
      ],
    },
  });
  const topicEvidence = buildSemanticTopicEvidence(recordInfos, semanticAudit);
  const audit = auditCanonicalLexicalQuality(recordInfos, {
    throwOnError: false,
    topicEvidence,
  });

  assert.deepEqual(
    audit.blocking_findings
      .filter(({ code }) => code === 'LEXICAL_MALFORMED_PARTICLE')
      .map(({ sense_id: senseId, observation }) => [senseId, observation.token_index]),
    [['w-topic-span-repeated-s1', 3]],
  );
});

test('the complete canonical audit catches a repeated template completed by a later batch', () => {
  const recordInfos = ['기존의 결', '새로운 결', '또 다른 결', '마지막 결'].map((lemma, index) => ({
    source: index === 0 ? 'base' : 'prospective-batch',
    record: {
      id: `w-cross-batch-${index}`,
      record_type: 'entry',
      role: 'start',
      candidate_id: `w-cross-batch-${index}`,
      lemma,
      search_forms: [lemma],
      senses: [{
        id: `w-cross-batch-${index}-s1`,
        pos: 'noun',
        gloss: `‘${lemma}’은 표면과 분위기에 드러나는 미세한 차이를 가리키며, ${lemma.split('의')[0]}을 문장의 인상으로 포착한다. 서로 다른 장면 예시를 붙인 후보 의미다.`,
      }],
    },
  }));
  const audit = auditCanonicalLexicalQuality(recordInfos, { throwOnError: false });
  assert.ok(audit.blocking_findings.some(({ code }) => code === 'LEXICAL_PARAMETERIZED_GLOSS_PROJECTION'));
});

test('the shared production boundary keeps genuinely distinct gloss definitions', () => {
  const records = [
    ['푸름의 결', '색이 옅고 짙어지는 정도가 시야에 남는 인상을 가리킨다.'],
    ['붉음의 결', '붉은 기운이 피부와 천에 번지는 속도를 묘사할 때 쓴다.'],
    ['고요의 결', '소리가 끊긴 뒤 공간에 남은 안정된 상태를 드러낸다.'],
    ['긴장의 결', '말을 고르기 전 몸이 먼저 굳는 반응을 포착한다.'],
  ].map(([lemma, gloss], index) => ({
    id: `w-distinct-${index}`,
    record_type: 'entry',
    role: 'start',
    candidate_id: `w-distinct-${index}`,
    lemma,
    search_forms: [lemma],
    senses: [{ id: `w-distinct-${index}-s1`, pos: 'noun', gloss }],
  }));

  assert.doesNotThrow(() => validateBulkGlossProjection(records, { maxOccurrences: 3 }));
});

test('the shared lexical audit rejects malformed topic fragments without a record allowlist', () => {
  const record = {
    id: 'w9999',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w9999',
    lemma: '바닥',
    search_forms: ['바닥'],
    senses: [{ id: 'w9999-s1', pos: 'noun', gloss: '바닥은 깔개' }],
  };
  const recordInfos = [{ record, source: 'synthetic' }];
  const semanticAudit = makeSemanticAudit(recordInfos, {
    topicAnalyses: {
      'w9999-s1': {
        state: 'noun-topic',
        topic: '바닥',
        particle: '은',
        predicate: '깔개',
      },
    },
  });
  const audit = auditCanonicalLexicalQuality(recordInfos, {
    throwOnError: false,
    topicEvidence: buildSemanticTopicEvidence(recordInfos, semanticAudit),
  });
  assert.equal(audit.blocking_findings[0].code, 'LEXICAL_MALFORMED_GLOSS');
  assert.equal(audit.blocking_findings[0].sense_id, 'w9999-s1');
  assert.equal(inspectGlossQuality('바다는 넓다').malformed_structure, false);
});

test('malformed gloss detection does not confuse productive adnominal forms with topic particles', () => {
  for (const gloss of [
    '달리는 사람',
    '흐르는 물',
    '빛나는 별',
    '움직이는 물체',
    '작은 사람',
    '넓은 곳',
    '붙잡은 사람',
    '가로막은 벽',
    '지은 집',
    '그은 선',
    '부은 얼굴',
    '나은 결과',
  ]) {
    const quality = inspectGlossQuality(gloss);
    assert.equal(quality.malformed_structure, false, gloss);
    assert.equal(quality.malformed_fragment, false, gloss);
  }

  for (const gloss of ['바닥은 깔개', '걱정은 마음']) {
    const topic = gloss.split(/은|는/u)[0];
    const quality = inspectGlossQuality(gloss, {
      topicEvidence: topicEvidenceForGloss(gloss, {
        state: 'noun-topic',
        topic,
        particle: gloss.includes('은') ? '은' : '는',
        predicate: gloss.slice(topic.length + 1).trim(),
      }),
      senseId: TOPIC_EVIDENCE_SENSE_ID,
    });
    assert.equal(quality.topic_state, 'noun-topic', gloss);
    assert.equal(quality.malformed_structure, true, gloss);
    assert.equal(quality.malformed_fragment, true, gloss);
  }
});

test('historical malformed gloss examples remain covered by the generalized rule', () => {
  for (const fixture of MALFORMED_TOPIC_REGRESSIONS) {
    const quality = inspectGlossQuality(fixture.gloss, {
      topicEvidence: topicEvidenceForGloss(fixture.gloss, fixture.topic_analysis),
      senseId: TOPIC_EVIDENCE_SENSE_ID,
    });
    assert.equal(quality.topic_state, 'noun-topic', fixture.name);
    assert.equal(quality.malformed_structure, true, fixture.name);
    assert.equal(quality.malformed_fragment, true, fixture.name);
  }
});

test('topic classifier keeps evidence states conservative for unseen forms and homographs', () => {
  const nounVerbHomograph = new Map([
    ['차', new Set(['noun', 'verb'])],
  ]);
  const cases = [
    {
      gloss: '붙잡은 사람',
      expectedState: 'unsupported',
      expectedMalformed: false,
    },
    {
      gloss: '지은 집',
      expectedState: 'unsupported',
      expectedMalformed: false,
    },
    {
      gloss: '차는 사람',
      nominalTerms: nounVerbHomograph,
      expectedState: 'ambiguous',
      expectedMalformed: false,
    },
    {
      gloss: '걱정는 마음',
      nominalTerms: ['걱정'],
      topicEvidence: topicEvidenceForGloss('걱정는 마음', {
        state: 'noun-topic',
        topic: '걱정',
        particle: '는',
        predicate: '마음',
      }),
      expectedState: 'noun-topic',
      expectedMalformed: true,
    },
    {
      gloss: '바닥은 깔개',
      nominalTerms: ['바닥'],
      topicEvidence: topicEvidenceForGloss('바닥은 깔개', {
        state: 'noun-topic',
        topic: '바닥',
        particle: '은',
        predicate: '깔개',
      }),
      expectedState: 'noun-topic',
      expectedMalformed: true,
    },
  ];
  for (const item of cases) {
    const quality = inspectGlossQuality(item.gloss, {
      nominalTerms: item.nominalTerms,
      topicEvidence: item.topicEvidence,
      senseId: item.topicEvidence ? TOPIC_EVIDENCE_SENSE_ID : undefined,
    });
    assert.equal(quality.topic_state, item.expectedState, item.gloss);
    assert.equal(quality.malformed_structure, item.expectedMalformed, item.gloss);
  }

  const openWorldRecords = [{
    record: {
      id: 'w-open-world',
      record_type: 'entry',
      role: 'start',
      candidate_id: 'w-open-world',
      lemma: '사',
      search_forms: ['사'],
      senses: [{ id: 'w-open-world-s1', pos: 'noun', gloss: '사람을 세는 단위' }],
    },
    source: 'synthetic-open-world',
  }];
  const openWorldQuality = inspectGlossQuality('사는 사람', {
    nominalTerms: buildNominalTermPositions(openWorldRecords),
  });
  assert.equal(openWorldQuality.topic_state, 'ambiguous');
  assert.equal(openWorldQuality.malformed_structure, false);
});

test('candidate preflight stays conservative before complete admission', () => {
  const valid = {
    id: 'w-future-gloss-valid',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w-future-gloss-valid',
    lemma: '미래관형형',
    search_forms: ['미래관형형'],
    senses: [{ id: 'w-future-gloss-valid-s1', pos: 'noun', gloss: '빛나는 별' }],
  };
  const malformed = {
    ...valid,
    id: 'w-future-gloss-invalid',
    candidate_id: 'w-future-gloss-invalid',
    lemma: '바닥',
    search_forms: ['바닥'],
    senses: [{ id: 'w-future-gloss-invalid-s1', pos: 'noun', gloss: '바닥은 깔개' }],
  };
  const malformedNeun = {
    ...valid,
    id: 'w-future-gloss-invalid-neun',
    candidate_id: 'w-future-gloss-invalid-neun',
    lemma: '걱정',
    search_forms: ['걱정'],
    senses: [{ id: 'w-future-gloss-invalid-neun-s1', pos: 'noun', gloss: '걱정는 마음' }],
  };
  assert.doesNotThrow(() => validateLexicalRecord(valid, { mode: 'candidate' }));
  for (const candidate of [malformed, malformedNeun]) {
    assert.doesNotThrow(() => validateLexicalRecord(candidate, {
      mode: 'candidate',
      nominalTerms: [candidate.lemma],
    }));
  }
});

test('prospective admission uses conservative lexical POS context', () => {
  const nounCar = {
    id: 'w001',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w001',
    lemma: '차',
    search_forms: ['차'],
    senses: [{ id: 'w001-s1', pos: 'noun', gloss: '사람이나 물건을 싣는 탈것' }],
  };
  const verbCar = {
    id: 'w002',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w002',
    lemma: '차다',
    search_forms: ['차다'],
    senses: [{ id: 'w002-s1', pos: 'verb', gloss: '발로 물건을 힘껏 내지르다' }],
  };
  const validCandidate = {
    id: 'w779',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w779',
    lemma: '동형어검증',
    search_forms: ['동형어검증'],
    senses: [{ id: 'w779-s1', pos: 'noun', gloss: '차는 사람' }],
  };
  const baseRecords = [nounCar, verbCar].map((record) => ({ record, source: 'base' }));
  const prospectiveRecords = [
    ...baseRecords,
    { record: validCandidate, source: 'prospective' },
  ];
  const semanticAudit = makeSemanticAudit(prospectiveRecords);
  const productionState = makeProductionState({
    batchId: 'future-batch-homograph',
    candidateRecords: [validCandidate],
    reviewedRecords: [validCandidate],
    baseRecords,
    prospectiveRecords,
    semanticAudit,
  });
  const result = validateLexicalAddition({
    batchId: 'future-batch-homograph',
    candidateRecords: [validCandidate],
    reviewedRecords: [validCandidate],
    baseRecords,
    prospectiveRecords,
    semanticAudit,
    productionState: productionState.state,
    productionStateSources: productionState.sources,
    productionPayloads: productionState.payloads,
  });
  assert.equal(result.audit.blocking_finding_count, 0);

  const openWorldNoun = {
    id: 'w003',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w003',
    lemma: '사',
    search_forms: ['사'],
    senses: [{ id: 'w003-s1', pos: 'noun', gloss: '사람을 세는 단위' }],
  };
  const openWorldCandidate = {
    id: 'w781',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w781',
    lemma: '오픈월드관형형',
    search_forms: ['오픈월드관형형'],
    senses: [{ id: 'w781-s1', pos: 'noun', gloss: '사는 사람' }],
  };
  const openWorldBaseRecords = [{ record: openWorldNoun, source: 'base' }];
  const openWorldProspectiveRecords = [
    ...openWorldBaseRecords,
    { record: openWorldCandidate, source: 'prospective' },
  ];
  const openWorldSemanticAudit = makeSemanticAudit(openWorldProspectiveRecords);
  const openWorldProductionState = makeProductionState({
    batchId: 'future-batch-open-world',
    candidateRecords: [openWorldCandidate],
    reviewedRecords: [openWorldCandidate],
    baseRecords: openWorldBaseRecords,
    prospectiveRecords: openWorldProspectiveRecords,
    semanticAudit: openWorldSemanticAudit,
  });
  assert.doesNotThrow(() => validateLexicalAddition({
    batchId: 'future-batch-open-world',
    candidateRecords: [openWorldCandidate],
    reviewedRecords: [openWorldCandidate],
    baseRecords: openWorldBaseRecords,
    prospectiveRecords: openWorldProspectiveRecords,
    semanticAudit: openWorldSemanticAudit,
    productionState: openWorldProductionState.state,
    productionStateSources: openWorldProductionState.sources,
    productionPayloads: openWorldProductionState.payloads,
  }));

  const malformedCandidate = {
    ...validCandidate,
    id: 'w780',
    candidate_id: 'w780',
    lemma: '걱정',
    search_forms: ['걱정'],
    senses: [{ id: 'w780-s1', pos: 'noun', gloss: '걱정는 마음' }],
  };
  const malformedBaseInfos = [
    ...baseRecords,
    { record: malformedCandidate, source: 'prospective' },
  ];
  const malformedAudit = makeSemanticAudit(malformedBaseInfos, {
    topicAnalyses: {
      'w780-s1': {
        state: 'noun-topic',
        topic: '걱정',
        particle: '는',
        predicate: '마음',
      },
    },
  });
  const malformedProductionState = makeProductionState({
    batchId: 'future-batch-malformed-topic',
    candidateRecords: [malformedCandidate],
    reviewedRecords: [malformedCandidate],
    baseRecords,
    prospectiveRecords: malformedBaseInfos,
    semanticAudit: malformedAudit,
    topicAnalyses: {
      'w780-s1': {
        state: 'noun-topic',
        topic: '걱정',
        particle: '는',
        predicate: '마음',
      },
    },
  });
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-malformed-topic',
      candidateRecords: [malformedCandidate],
      reviewedRecords: [malformedCandidate],
      baseRecords,
      prospectiveRecords: malformedBaseInfos,
      semanticAudit: malformedAudit,
      productionState: malformedProductionState.state,
      productionStateSources: malformedProductionState.sources,
      productionPayloads: malformedProductionState.payloads,
    }),
    (error) => error.code === 'LEXICAL_MALFORMED_GLOSS',
  );

  const disconnectedSemanticAudit = structuredClone(malformedAudit);
  delete disconnectedSemanticAudit.review.records
    .find(({ record_id: recordId }) => recordId === malformedCandidate.id)
    .sense_reviews[0].review_basis.topic_analysis;
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-malformed-topic',
      candidateRecords: [malformedCandidate],
      reviewedRecords: [malformedCandidate],
      baseRecords,
      prospectiveRecords: malformedBaseInfos,
      semanticAudit: disconnectedSemanticAudit,
      productionState: malformedProductionState.state,
      productionStateSources: malformedProductionState.sources,
      productionPayloads: malformedProductionState.payloads,
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_BINDING',
  );
});

test('topic evidence remains bound to the reviewed sense', () => {
  const malformedRecord = {
    id: 'w-topic-malformed',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w-topic-malformed',
    lemma: '차',
    search_forms: ['차'],
    senses: [{ id: 'w-topic-malformed-s1', pos: 'noun', gloss: '차는 차량' }],
  };
  const adnominalRecord = {
    id: 'w-topic-adnominal',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w-topic-adnominal',
    lemma: '차형태',
    search_forms: ['차형태'],
    senses: [{ id: 'w-topic-adnominal-s1', pos: 'noun', gloss: '차는 사람' }],
  };
  const recordInfos = [malformedRecord, adnominalRecord].map((record) => ({
    record,
    source: 'topic-projection-fixture',
  }));
  const semanticAudit = makeSemanticAudit(recordInfos, {
    topicAnalyses: {
      'w-topic-malformed-s1': {
        state: 'noun-topic',
        topic: '차',
        particle: '는',
        predicate: '차량',
      },
      'w-topic-adnominal-s1': {
        state: 'adnominal',
        topic: '차',
        particle: '는',
        predicate: '사람',
      },
    },
  });
  const topicEvidence = buildSemanticTopicEvidence(recordInfos, semanticAudit);
  const audit = auditCanonicalLexicalQuality(recordInfos, {
    throwOnError: false,
    topicEvidence,
  });

  assert.deepEqual(
    audit.blocking_findings
      .filter(({ code }) => code === 'LEXICAL_MALFORMED_GLOSS')
      .map(({ sense_id }) => sense_id),
    ['w-topic-malformed-s1'],
  );
  const adnominalQuality = inspectGlossQuality('차는 사람', {
    nominalTerms: buildNominalTermPositions(recordInfos),
    topicEvidence,
    senseId: 'w-topic-adnominal-s1',
  });
  assert.equal(adnominalQuality.topic_state, 'adnominal');
  assert.equal(adnominalQuality.malformed_structure, false);

  const disconnectedSemanticAudit = structuredClone(semanticAudit);
  delete disconnectedSemanticAudit.review.records
    .find(({ record_id: recordId }) => recordId === adnominalRecord.id)
    .sense_reviews[0].review_basis.topic_analysis;
  assert.throws(
    () => buildSemanticTopicEvidence(recordInfos, disconnectedSemanticAudit),
    (error) => error.code === 'SEMANTIC_AUDIT_INCOMPLETE',
  );
});

test('authored distinct and retain cannot override high-confidence usage or paraphrase frames', () => {
  const cases = [
    {
      lemma: '도구용례',
      glosses: ['종이를 자르는 도구', '천을 자르는 도구'],
      relationship: 'usage-variant',
    },
    {
      lemma: '한음절동작',
      glosses: ['국물을 뜨는 도구', '물을 뜨는 자루 달린 도구'],
      relationship: 'usage-variant',
    },
    {
      lemma: '겹침표현',
      glosses: ['남의 마음을 함께 느끼는 일', '처지를 함께 느끼는 일'],
      relationship: 'overlapping',
    },
    {
      lemma: '문맥분할',
      glosses: ['글에서 중심이 되는 생각', '말에서 중심이 되는 생각'],
      relationship: 'usage-variant',
    },
  ];
  for (const [index, item] of cases.entries()) {
    const id = `w-semantic-frame-${index + 1}`;
    const record = {
      id,
      record_type: 'entry',
      role: 'start',
      candidate_id: id,
      lemma: item.lemma,
      search_forms: [item.lemma],
      senses: item.glosses.map((gloss, senseIndex) => ({
        id: `${id}-s${senseIndex + 1}`,
        pos: 'noun',
        gloss,
      })),
    };
    assert.equal(inspectSenseBoundaryPairs(record)[0].relationship, item.relationship);
    const infos = [{ record, source: 'synthetic' }];
    const audit = makeSemanticAudit(infos, {
      boundaryDecisions: {
        [id]: { decision: 'split', classification: 'separated' },
      },
    });
    assert.throws(
      () => validateSemanticAuditCoverage(infos, audit),
      (error) => error.code === 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER',
    );
  }
});

test('generic tool heads do not turn unrelated action frames into usage variants', () => {
  const record = {
    id: 'w-tool-negative-control',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w-tool-negative-control',
    lemma: '열쇠',
    search_forms: ['열쇠'],
    senses: [
      { id: 'w-tool-negative-control-s1', pos: 'noun', gloss: '문을 여는 도구' },
      { id: 'w-tool-negative-control-s2', pos: 'noun', gloss: '문제를 푸는 도구' },
    ],
  };
  const infos = [{ record, source: 'synthetic' }];
  assert.equal(inspectSenseBoundaryPairs(record)[0].relationship, 'distinct');
  const audit = makeSemanticAudit(infos, {
    boundaryDecisions: {
      [record.id]: { decision: 'split', classification: 'separated' },
    },
  });
  assert.doesNotThrow(() => validateSemanticAuditCoverage(infos, audit));
});

test('the independent boundary audit uses authored pair decisions for any record', () => {
  const makeRecord = (glosses) => ({
    id: 'w-boundary-regression',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w-boundary-regression',
    lemma: '경계회귀',
    search_forms: ['경계회귀'],
    senses: glosses.map((gloss, index) => ({
      id: `w-boundary-regression-s${index + 1}`,
      pos: 'noun',
      gloss,
    })),
  });

  for (const glosses of [
    ['같은 뜻을 설명한다', '같은 뜻을 설명한다'],
    ['붉은 꽃', '붉은 꽃 피어남'],
  ]) {
    const record = makeRecord(glosses);
    const infos = [{ record, source: 'future-candidate' }];
    const audit = makeSemanticAudit(infos, {
      boundaryDecisions: {
        [record.id]: { decision: 'split', classification: 'separated' },
      },
    });
    const pair = audit.review.records[0].boundary_review.pairwise[0];
    assert.throws(
      () => validateSemanticAuditCoverage(infos, audit),
      (error) => error.code === 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER',
    );
    pair.relationship = glosses[0] === glosses[1] ? 'duplicate' : 'nested';
    pair.decision = 'merge';
    assert.throws(
      () => validateSemanticAuditCoverage(infos, audit),
      (error) => error.code === 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER',
    );
  }
});

test('usage-variant pair decisions are explicit and do not depend on pair count', () => {
  const record = {
    id: 'w-boundary-usage-variant',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w-boundary-usage-variant',
    lemma: '용례변주',
    search_forms: ['용례변주'],
    senses: [
      { id: 'w-boundary-usage-variant-s1', pos: 'noun', gloss: '손으로 만지는 표면의 감각.' },
      { id: 'w-boundary-usage-variant-s2', pos: 'noun', gloss: '말에서 드러나는 표면적인 인상.' },
    ],
  };
  const infos = [{ record, source: 'future-candidate' }];
  const audit = makeSemanticAudit(infos, {
    boundaryDecisions: {
      [record.id]: { decision: 'split', classification: 'separated' },
    },
  });
  const boundary = audit.review.records[0].boundary_review;
  boundary.pairwise[0].relationship = 'usage-variant';
  assert.equal(boundary.decision, 'split');
  assert.doesNotThrow(() => validateSemanticAuditCoverage(infos, audit));
  assert.equal(inspectSenseBoundaryPairs(record)[0].relationship, 'distinct');
});

test('the boundary audit rejects evidence that claims independence but uses the current sense count', () => {
  const record = {
    id: 'w-boundary-independence',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w-boundary-independence',
    lemma: '독립검수',
    search_forms: ['독립검수'],
    senses: [{ id: 'w-boundary-independence-s1', pos: 'noun', gloss: '내용을 따로 살피는 검수.' }],
  };
  const infos = [{ record, source: 'future-candidate' }];
  const audit = makeSemanticAudit(infos);
  audit.review.records[0].boundary_review.independence.independent_of_sense_count = false;
  assert.throws(
    () => validateSemanticAuditCoverage(infos, audit),
    (error) => error.code === 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER',
  );
});

test('the common-domain rule accepts coordinated senses without an ID exception', async () => {
  const result = await validateDatasetDirectory(
    path.join(FIXTURE_ROOT, 'valid/common-domain.jsonl'),
  );
  assert.equal(result.recordCount, 2);
  assert.equal(result.senseCount, 2);
});

test('writer-domain evidence respects lexical token boundaries and Korean inflections', () => {
  for (const gloss of [
    '향상시키는 성질',
    '방향을 정하다',
    '향후 계획',
    '목표를 향하고 있다',
    '검색 결과를 찾다',
    '탐색하다',
    '어색하고 거리감이 있다',
    '향하는 방향',
  ]) {
    assert.deepEqual(inspectWriterDomainEvidence(gloss).axes, [], gloss);
  }

  for (const [gloss, axis] of [
    ['향이 은은하다', 'smell'],
    ['향을 맡다', 'smell'],
    ['향으로 퍼지다', 'smell'],
    ['좋은 향이다', 'smell'],
    ['향에서는 은은하다', 'smell'],
    ['향기로운 냄새', 'smell'],
    ['향긋한 냄새', 'smell'],
    ['색이 선명하다', 'visual'],
    ['색으로 물들다', 'visual'],
    ['색으로는 선명하다', 'visual'],
    ['선명한 색이다', 'visual'],
    ['색깔이 선명하다', 'visual'],
    ['빛나는 모습', 'visual'],
    ['정서적 연결감', 'affective'],
    ['소리에도 주의를 기울이다', 'sound'],
  ]) {
    assert.deepEqual(inspectWriterDomainEvidence(gloss).axes, [axis], gloss);
  }

  for (const collisionGloss of [
    '기분이나 집중력을 향상시키는 성질',
    '기분이나 목표를 향하고 있는 상태',
  ]) {
    const observations = inspectGlossConnectors(collisionGloss);
    assert.equal(observations.length, 1, collisionGloss);
    assert.equal(observations[0].classification, 'unclassified-coordination', collisionGloss);
    assert.equal(observations[0].right_axis, null, collisionGloss);
  }
});

test('the token-aware domain rule is reused by a future lexical admission', () => {
  const candidateRecord = {
    id: 'w779',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w779',
    lemma: '토큰경계말',
    search_forms: ['토큰경계말'],
    senses: [{
      id: 'w779-s1',
      pos: 'adjective',
      gloss: '기분이나 집중력을 향상시키는 성질',
    }],
  };
  const baseRecord = {
    id: 'w778',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w778',
    lemma: '기존경계말',
    search_forms: ['기존경계말'],
    senses: [{ id: 'w778-s1', pos: 'noun', gloss: '기존의 의미를 가리키는 말' }],
  };
  const baseRecords = [{ record: baseRecord, source: 'base' }];
  const reviewedRecords = [{ record: candidateRecord, source: 'future-review' }];
  const prospectiveRecords = [...baseRecords, ...reviewedRecords];
  const semanticAudit = makeSemanticAudit(prospectiveRecords);
  const productionState = makeProductionState({
    batchId: 'future-token-aware-domain',
    candidateRecords: [candidateRecord],
    reviewedRecords,
    baseRecords,
    prospectiveRecords,
    semanticAudit,
  });

  assert.doesNotThrow(() => validateLexicalAddition({
    batchId: 'future-token-aware-domain',
    candidateRecords: [candidateRecord],
    reviewedRecords,
    baseRecords,
    prospectiveRecords,
    semanticAudit,
    productionState: productionState.state,
    productionStateSources: productionState.sources,
    productionPayloads: productionState.payloads,
  }));
});

test('composed nominal particles still block a merged domain in future admission', () => {
  const candidateRecord = {
    id: 'w781',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w781',
    lemma: '복합조사말',
    search_forms: ['복합조사말'],
    senses: [{
      id: 'w781-s1',
      pos: 'adjective',
      gloss: '기분이나 향에서는 느낌이 달라진다',
    }],
  };
  const baseRecord = {
    id: 'w780',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w780',
    lemma: '복합조사기존말',
    search_forms: ['복합조사기존말'],
    senses: [{ id: 'w780-s1', pos: 'noun', gloss: '기존의 의미를 가리키는 말' }],
  };
  const baseRecords = [{ record: baseRecord, source: 'base' }];
  const reviewedRecords = [{ record: candidateRecord, source: 'future-review' }];
  const prospectiveRecords = [...baseRecords, ...reviewedRecords];
  const semanticAudit = makeSemanticAudit(prospectiveRecords);
  const productionState = makeProductionState({
    batchId: 'future-composed-particle-domain',
    candidateRecords: [candidateRecord],
    reviewedRecords,
    baseRecords,
    prospectiveRecords,
    semanticAudit,
  });

  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-composed-particle-domain',
      candidateRecords: [candidateRecord],
      reviewedRecords,
      baseRecords,
      prospectiveRecords,
      semanticAudit,
      productionState: productionState.state,
      productionStateSources: productionState.sources,
      productionPayloads: productionState.payloads,
    }),
    (error) => error.code === 'LEXICAL_MERGED_SENSE_GLOSS',
  );
});

test('the complete-canonical audit rejects a merged sensory and affective sense', async () => {
  await assert.rejects(
    validateDatasetDirectory(path.join(FIXTURE_ROOT, 'invalid/merged-sense.jsonl')),
    (error) => {
      assert.ok(error instanceof DatasetIntegrityError);
      assert.equal(error.code, 'LEXICAL_MERGED_SENSE_GLOSS');
      assert.match(error.message, /맛이나 분위기/u);
      return true;
    },
  );
});

test('the shared audit rejects placeholder glosses for any batch', async () => {
  await assert.rejects(
    validateDatasetDirectory(path.join(FIXTURE_ROOT, 'invalid/placeholder.jsonl')),
    (error) => {
      assert.ok(error instanceof DatasetIntegrityError);
      assert.equal(error.code, 'LEXICAL_PLACEHOLDER_GLOSS');
      return true;
    },
  );
});

test('the shared audit rejects duplicate lemmas and search forms without a batch exception', () => {
  const records = ['w904', 'w905'].map((id) => ({
    record: {
      id,
      record_type: 'entry',
      role: 'start',
      candidate_id: id,
      lemma: '중복표제어',
      search_forms: ['중복표제어'],
      senses: [{ id: `${id}-s1`, pos: 'noun', gloss: '서로 겹치는 표제어 의미.' }],
    },
    source: 'synthetic',
  }));
  const audit = auditCanonicalLexicalQuality(records, { throwOnError: false });
  assert.deepEqual(
    audit.blocking_findings.map(({ code }) => code).sort(),
    ['LEXICAL_DUPLICATE_LEMMA', 'LEXICAL_DUPLICATE_SEARCH_FORM'],
  );
});

test('record-type and POS classification are common admission invariants', () => {
  const expressionWithEntryPos = {
    id: 'w903',
    record_type: 'expression',
    role: 'start',
    candidate_id: 'w903',
    lemma: '표현오류',
    search_forms: ['표현오류'],
    senses: [{ id: 'w903-s1', pos: 'noun', gloss: '표현 분류가 잘못된 후보' }],
  };
  assert.throws(
    () => validateLexicalRecord(expressionWithEntryPos, { mode: 'canonical', label: 'future-batch record' }),
    (error) => error instanceof LexicalQualityError && error.code === 'LEXICAL_EXPRESSION_POS',
  );
});

test('a later batch ID uses the same producer and prospective-dictionary gate', () => {
  const invalid = {
    id: 'candidate-future-001',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'candidate-future-001',
    lemma: '다음어',
    search_forms: ['다음어'],
    senses: [{ id: 'candidate-future-001-s1', pos: 'adjective', gloss: '빛이나 소리가 선명하다' }],
  };
  const baseRecords = [{
    id: 'w001',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w001',
    lemma: '기존말',
    search_forms: ['기존말'],
    senses: [{ id: 'w001-s1', pos: 'noun', gloss: '기존 의미' }],
  }];
  const baseRecordInfos = baseRecords.map((record) => ({ record, source: 'base' }));
  const baseAudit = makeSemanticAudit(baseRecordInfos);
  const invalidProductionState = makeProductionState({
    batchId: 'future-batch-2040',
    candidateRecords: [invalid],
    baseRecords: baseRecordInfos,
    prospectiveRecords: baseRecordInfos,
    semanticAudit: baseAudit,
  });
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-2040',
      candidateRecords: [invalid],
      baseRecords: baseRecordInfos,
      prospectiveRecords: baseRecordInfos,
      semanticAudit: baseAudit,
      productionState: invalidProductionState.state,
      productionStateSources: invalidProductionState.sources,
      productionPayloads: invalidProductionState.payloads,
    }),
    /distinct writer domains/u,
  );

  const valid = {
    ...invalid,
    id: 'w779',
    candidate_id: 'w779',
    senses: [{ id: 'w779-s1', pos: 'adjective', gloss: '맛이나 냄새가 은은하다' }],
  };
  const admitted = valid;
  const prospectiveRecordInfos = [
    ...baseRecordInfos,
    { record: admitted, source: 'prospective' },
  ];
  const validProductionState = makeProductionState({
    batchId: 'future-batch-2040',
    candidateRecords: [valid],
    reviewedRecords: [admitted],
    baseRecords: baseRecordInfos,
    prospectiveRecords: prospectiveRecordInfos,
    semanticAudit: makeSemanticAudit(prospectiveRecordInfos),
  });
  const result = validateLexicalAddition({
    batchId: 'future-batch-2040',
    candidateRecords: [valid],
    reviewedRecords: [admitted],
    baseRecords: baseRecordInfos,
    prospectiveRecords: prospectiveRecordInfos,
    semanticAudit: makeSemanticAudit(prospectiveRecordInfos),
    productionState: validProductionState.state,
    productionStateSources: validProductionState.sources,
    productionPayloads: validProductionState.payloads,
  });
  assert.equal(result.pipeline_version, 'lexical-admission-v1');
  assert.equal(result.batch_id, 'future-batch-2040');
  assert.equal(result.audit.blocking_finding_count, 0);
});

test('a partial prospective dataset cannot bypass the complete-base contract', () => {
  const baseRecords = [{
    id: 'w001',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w001',
    lemma: '기존말',
    search_forms: ['기존말'],
    senses: [{ id: 'w001-s1', pos: 'noun', gloss: '기존 의미' }],
  }];
  const baseRecordInfos = baseRecords.map((record) => ({ record, source: 'base' }));
  const newRecord = {
    id: 'w779',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w779',
    lemma: '새말',
    search_forms: ['새말'],
    senses: [{ id: 'w779-s1', pos: 'noun', gloss: '새 의미' }],
  };
  const partial = [{ record: newRecord, source: 'partial' }];
  const completeProspective = [
    ...baseRecordInfos,
    { record: newRecord, source: 'prospective' },
  ];
  const partialProductionState = makeProductionState({
    batchId: 'future-batch-2041',
    reviewedRecords: [newRecord],
    baseRecords: baseRecordInfos,
    prospectiveRecords: completeProspective,
    semanticAudit: makeSemanticAudit(completeProspective),
  });
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-2041',
      reviewedRecords: [newRecord],
      baseRecords,
      prospectiveRecords: partial,
      semanticAudit: makeSemanticAudit(partial),
      productionState: partialProductionState.state,
      productionStateSources: partialProductionState.sources,
      productionPayloads: partialProductionState.payloads,
    }),
    /missing base record w001|does not preserve base record w001|producer-owned prospective output|producer-owned audit input/u,
  );
  assert.throws(
    () => validateDatasetRecords(baseRecordInfos, { requireSemanticAudit: true }),
    /semantic-audit coverage/u,
  );
});

test('common admission rejects prospective values that are not derived from reviewed values', () => {
  const baseRecord = {
    id: 'w001',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w001',
    lemma: '기존말',
    search_forms: ['기존말'],
    senses: [{ id: 'w001-s1', pos: 'noun', gloss: '기존 의미' }],
  };
  const reviewedRecord = {
    id: 'w779',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w779',
    lemma: '검수말',
    search_forms: ['검수말'],
    senses: [{ id: 'w779-s1', pos: 'noun', gloss: '검수된 의미' }],
  };
  const driftedRecord = {
    ...reviewedRecord,
    lemma: '검수말변조',
    search_forms: ['검수말변조'],
  };
  const baseInfos = [{ record: baseRecord, source: 'base' }];
  const completeProspective = [
    ...baseInfos,
    { record: reviewedRecord, source: 'prospective' },
  ];
  const productionState = makeProductionState({
    batchId: 'future-batch-lineage',
    reviewedRecords: [reviewedRecord],
    baseRecords: baseInfos,
    prospectiveRecords: completeProspective,
    semanticAudit: makeSemanticAudit(completeProspective),
  });
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-lineage',
      reviewedRecords: [reviewedRecord],
      baseRecords: [baseRecord],
      prospectiveRecords: [baseRecord, driftedRecord],
      semanticAudit: makeSemanticAudit([
        { record: baseRecord, source: 'base' },
        { record: driftedRecord, source: 'prospective' },
      ]),
      productionState: productionState.state,
      productionStateSources: productionState.sources,
      productionPayloads: productionState.payloads,
    }),
    /base dataset transformed only by selected\/reviewed records|producer-owned prospective output|producer-owned audit input/u,
  );

  const producerSelectedRecord = {
    ...reviewedRecord,
    id: 'w780',
    candidate_id: 'w780',
    lemma: '생산검수말',
    search_forms: ['생산검수말'],
    senses: [{ id: 'w780-s1', pos: 'noun', gloss: '생산 검수 의미' }],
  };
  const producerProspective = [
    ...baseInfos,
    { record: producerSelectedRecord, source: 'prospective' },
  ];
  const producerSemanticAudit = makeSemanticAudit(producerProspective);
  const producerState = makeProductionState({
    batchId: 'future-batch-cross-wired',
    candidateRecords: [producerSelectedRecord],
    reviewedRecords: [producerSelectedRecord],
    baseRecords: baseInfos,
    prospectiveRecords: producerProspective,
    semanticAudit: producerSemanticAudit,
  });
  const substitutedRecord = {
    ...reviewedRecord,
    id: 'w781',
    candidate_id: 'w781',
    lemma: '대체검수말',
    search_forms: ['대체검수말'],
    senses: [{ id: 'w781-s1', pos: 'noun', gloss: '대체 검수 의미' }],
  };
  const substitutedProspective = [
    ...baseInfos,
    { record: substitutedRecord, source: 'prospective' },
  ];
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-cross-wired',
      candidateRecords: [producerSelectedRecord],
      reviewedRecords: [substitutedRecord],
      baseRecords: baseInfos,
      prospectiveRecords: substitutedProspective,
      semanticAudit: makeSemanticAudit(substitutedProspective),
      productionState: producerState.state,
      productionStateSources: producerState.sources,
      productionPayloads: producerState.payloads,
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_BINDING',
  );
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-cross-wired',
      candidateRecords: [substitutedRecord],
      reviewedRecords: [producerSelectedRecord],
      baseRecords: baseInfos,
      prospectiveRecords: producerProspective,
      semanticAudit: producerSemanticAudit,
      productionState: producerState.state,
      productionStateSources: producerState.sources,
      productionPayloads: producerState.payloads,
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_BINDING',
  );
});

function productionReview({ candidateRecord, reviewedRecord, gloss, boundaryDecision }) {
  const record = reviewedRecord ?? candidateRecord;
  const sense = record.senses[0];
  const evidence = inspectWriterDomainEvidence(gloss);
  const decisionSourceId = `future-batch:${record.id}:decision-source`;
  const sourceSha256 = sha256Json({
    candidate_record_sha256: sha256Json(candidateRecord),
    reviewed_record_sha256: sha256Json(record),
    decision: 'included',
    selection_rank: 1,
    selection_score: 1,
  });
  return {
    status: 'complete',
    decision_source: {
      kind: 'separately-authored-semantic-decision-source',
      contract_version: 'lexical-semantic-decision-source-v1',
      source_id: decisionSourceId,
      path: `tests/fixtures/${record.id}-decision-source.json`,
      authoring_mode: 'agent-authored-decision',
      source_sha256: sourceSha256,
    },
    authored_decision: {
      source_sha256: sourceSha256,
      decision_source_id: decisionSourceId,
      candidate_record_id: candidateRecord.id,
      candidate_record_sha256: sha256Json(candidateRecord),
      reviewed_record_sha256: sha256Json(record),
      decision: 'included',
      selection_rank: 1,
      selection_score: 1,
      rationale: `${candidateRecord.id} was selected from the separately authored fixture decision source.`,
      sense_evidence: record.senses.map((reviewedSense) => ({
        sense_id: reviewedSense.id,
        gloss_sha256: sha256Json(reviewedSense.gloss),
        basis: `${record.id} ${reviewedSense.id} gloss and writer-facing use were explicitly reviewed.`,
      })),
      relation_evidence: record.senses.map((reviewedSense) => {
        const relationCount = reviewedSense.relations?.length ?? 0;
        return {
          sense_id: reviewedSense.id,
          relation_count: relationCount,
          decision: relationCount === 0 ? 'no-relations' : 'relations-reviewed',
          basis: `${record.id} ${reviewedSense.id} relation outcome was explicitly reviewed.`,
        };
      }),
    },
    sense_boundary: {
      status: 'pass',
      decision_source_id: decisionSourceId,
      review_id: `future-batch:${record.id}:boundary`,
      method: 'gloss-and-usage-pairwise-v2',
      independence: {
        independent_of_sense_count: true,
        source: 'separately-authored-future-boundary-decision',
        decision_source_id: decisionSourceId,
        decision_source_version: 'lexical-semantic-boundary-decisions-v1',
      },
      findings: [{
        sense_id: sense.id,
        action: 'retain',
        classification: 'atomic',
        rationale: `future-batch ${sense.id} semantic boundary was reviewed`,
        semantic_evidence: {
          status: 'pass',
          gloss_sha256: createHash('sha256').update(JSON.stringify(gloss), 'utf8').digest('hex'),
          observed_domain_axes: evidence.axes,
          domain_evidence: evidence.matches,
          connector_observations: inspectGlossConnectors(gloss),
          rationale: `future-batch ${sense.id} observed domain axes were reviewed`,
          boundary_decision: boundaryDecision,
          decision_source_id: decisionSourceId,
        },
      }],
      pairwise: [],
      rationale: `future-batch ${record.id} boundary was authored independently of the current sense count`,
    },
    pos: {
      status: 'pass',
      decision: 'verified',
      observed_pos: [sense.pos],
      decision_source_id: decisionSourceId,
      rationale: 'future-batch POS was reviewed',
    },
    expression: {
      status: 'pass',
      decision: 'verified',
      expected_record_type: 'entry',
      observed_record_type: record.record_type,
      decision_source_id: decisionSourceId,
      rationale: 'future-batch expression classification was reviewed',
    },
    relation: {
      status: 'pass',
      decision_source_id: decisionSourceId,
      per_sense: [{
        sense_id: sense.id,
        decision: 'no-relations',
        decision_source_id: decisionSourceId,
        relation_count: 0,
        relation_ids: [],
        no_relation_rationale: `future-batch ${sense.id} has no relation tuple after review`,
      }],
    },
    selection: {
      status: 'selected',
      rank: 1,
      score: 1,
      rationale: 'future-batch selected by verification and coverage',
    },
  };
}

test('shared semantic admission blocks a source POS that conflicts with independent adverb evidence', () => {
  const nounCandidate = {
    id: 'w-adverb-as-noun',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w-adverb-as-noun',
    lemma: '불현듯',
    search_forms: ['불현듯'],
    senses: [{
      id: 'w-adverb-as-noun-s1',
      pos: 'noun',
      gloss: '생각이나 느낌이 뜻밖에 갑자기 떠오르는 모양.',
    }],
  };
  const conflictingReview = productionReview({
    candidateRecord: nounCandidate,
    gloss: nounCandidate.senses[0].gloss,
    boundaryDecision: 'atomic',
  });
  conflictingReview.pos.observed_pos = ['adverb'];
  assert.throws(
    () => validateLexicalSemanticReview(conflictingReview, {
      decision: 'included',
      candidateRecord: nounCandidate,
      catalogCount: 1,
      requireSemanticEvidence: true,
      requireIndependentDecisionEvidence: true,
    }),
    (error) => error.name === 'AssertionError' && error.message.includes('observed_pos'),
  );

  const verifiedCandidate = {
    ...nounCandidate,
    id: 'w-correct-adverb-source',
    candidate_id: 'w-correct-adverb-source',
    senses: [{ ...nounCandidate.senses[0], id: 'w-correct-adverb-source-s1', pos: 'adverb' }],
  };
  const verifiedReview = productionReview({
    candidateRecord: verifiedCandidate,
    gloss: verifiedCandidate.senses[0].gloss,
    boundaryDecision: 'atomic',
  });
  assert.doesNotThrow(() => validateLexicalSemanticReview(verifiedReview, {
    decision: 'included',
    candidateRecord: verifiedCandidate,
    catalogCount: 1,
    requireSemanticEvidence: true,
    requireIndependentDecisionEvidence: true,
  }));
});

function multiSenseProductionReview(record, { relationship = 'distinct', pairDecision = 'retain' } = {}) {
  const decisionSourceId = `future-batch:${record.id}:decision-source`;
  const pair = inspectSenseBoundaryPairs(record)[0];
  const left = record.senses[0];
  const right = record.senses[1];
  const leftGlossSha256 = createHash('sha256').update(JSON.stringify(left.gloss), 'utf8').digest('hex');
  const rightGlossSha256 = createHash('sha256').update(JSON.stringify(right.gloss), 'utf8').digest('hex');
  const sourceSha256 = sha256Json({
    candidate_record_sha256: sha256Json(record),
    reviewed_record_sha256: sha256Json(record),
    decision: 'included',
    selection_rank: 1,
    selection_score: 1,
  });
  return {
    status: 'complete',
    decision_source: {
      kind: 'separately-authored-semantic-decision-source',
      contract_version: 'lexical-semantic-decision-source-v1',
      source_id: decisionSourceId,
      path: `tests/fixtures/${record.id}-decision-source.json`,
      authoring_mode: 'agent-authored-decision',
      source_sha256: sourceSha256,
    },
    authored_decision: {
      source_sha256: sourceSha256,
      decision_source_id: decisionSourceId,
      candidate_record_id: record.id,
      candidate_record_sha256: sha256Json(record),
      reviewed_record_sha256: sha256Json(record),
      decision: 'included',
      selection_rank: 1,
      selection_score: 1,
      rationale: `${record.id} was selected from the separately authored fixture decision source.`,
      sense_evidence: record.senses.map((reviewedSense) => ({
        sense_id: reviewedSense.id,
        gloss_sha256: sha256Json(reviewedSense.gloss),
        basis: `${record.id} ${reviewedSense.id} gloss and writer-facing use were explicitly reviewed.`,
      })),
      relation_evidence: record.senses.map((reviewedSense) => {
        const relationCount = reviewedSense.relations?.length ?? 0;
        return {
          sense_id: reviewedSense.id,
          relation_count: relationCount,
          decision: relationCount === 0 ? 'no-relations' : 'relations-reviewed',
          basis: `${record.id} ${reviewedSense.id} relation outcome was explicitly reviewed.`,
        };
      }),
    },
    sense_boundary: {
      status: 'pass',
      decision_source_id: decisionSourceId,
      review_id: `future-batch:${record.id}:boundary`,
      method: 'gloss-and-usage-pairwise-v2',
      independence: {
        independent_of_sense_count: true,
        source: 'separately-authored-future-boundary-decision',
        decision_source_id: decisionSourceId,
        decision_source_version: 'lexical-semantic-boundary-decisions-v1',
      },
      findings: record.senses.map((sense) => ({
        sense_id: sense.id,
        action: 'split',
        classification: 'separated',
        rationale: `${record.id} ${sense.id} was reviewed from the authored pair decision`,
        semantic_evidence: {
          status: 'pass',
          gloss_sha256: createHash('sha256').update(JSON.stringify(sense.gloss), 'utf8').digest('hex'),
          observed_domain_axes: [],
          domain_evidence: [],
          connector_observations: [],
          rationale: `${record.id} ${sense.id} semantic evidence was authored`,
          boundary_decision: 'split',
          decision_source_id: decisionSourceId,
        },
      })),
      pairwise: [{
        left_sense_id: pair.left_sense_id,
        right_sense_id: pair.right_sense_id,
        relationship,
        decision: pairDecision,
        left_gloss_sha256: leftGlossSha256,
        right_gloss_sha256: rightGlossSha256,
        evidence_basis: 'both glosses were explicitly compared by the reviewer',
        distinguishing_feature: 'the pair has an authored writer-facing distinction',
        decision_source_id: decisionSourceId,
        rationale: `${record.id} ${left.id} ${right.id} pair cites ${leftGlossSha256.slice(0, 12)} and ${rightGlossSha256.slice(0, 12)}.`,
      }],
      rationale: `${record.id} pair boundary was authored independently of the current sense count`,
    },
    pos: {
      status: 'pass',
      decision: 'verified',
      observed_pos: ['noun', 'noun'],
      decision_source_id: decisionSourceId,
      rationale: `${record.id} POS was explicitly verified`,
    },
    expression: {
      status: 'pass',
      decision: 'verified',
      expected_record_type: 'entry',
      observed_record_type: 'entry',
      decision_source_id: decisionSourceId,
      rationale: `${record.id} record type was explicitly verified`,
    },
    relation: {
      status: 'pass',
      decision_source_id: decisionSourceId,
      per_sense: record.senses.map((sense) => ({
        sense_id: sense.id,
        decision: 'no-relations',
        decision_source_id: decisionSourceId,
        relation_count: 0,
        relation_ids: [],
        no_relation_rationale: `${record.id} ${sense.id} has no relation tuple after authored review`,
      })),
    },
    selection: {
      status: 'selected',
      rank: 1,
      score: 1,
      rationale: `${record.id} selected by authored verification and coverage`,
    },
  };
}

test('shared admission regressions keep semantic bindings, search policy, and per-sense coverage merge-blocking', () => {
  const singleSenseRecord = {
    id: 'w-common-admission-binding',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w-common-admission-binding',
    lemma: '공통입력결속',
    search_forms: ['공통입력결속'],
    senses: [{
      id: 'w-common-admission-binding-s1',
      pos: 'noun',
      gloss: '공통 admission binding regression 의미를 검증한다.',
    }],
  };
  const copiedEvidence = productionReview({
    candidateRecord: singleSenseRecord,
    gloss: singleSenseRecord.senses[0].gloss,
    boundaryDecision: 'atomic',
  });
  copiedEvidence.authored_decision.candidate_record_sha256 = '0'.repeat(64);
  assert.throws(
    () => validateLexicalSemanticReview(copiedEvidence, {
      decision: 'included',
      candidateRecord: singleSenseRecord,
      catalogCount: 1,
      requireSemanticEvidence: true,
      requireIndependentDecisionEvidence: true,
    }),
    (error) => error.code === 'LEXICAL_SEMANTIC_BINDING',
  );

  const whitespaceAliasRecord = {
    ...singleSenseRecord,
    id: 'w-common-admission-search-policy',
    candidate_id: 'w-common-admission-search-policy',
    lemma: '공통 검색어',
    search_forms: ['공통 검색어', '공통검색어'],
    senses: [{
      id: 'w-common-admission-search-policy-s1',
      pos: 'noun',
      gloss: '공통 검색어의 writer-facing 의미를 검증한다.',
    }],
  };
  assert.throws(
    () => validateLexicalRecord(whitespaceAliasRecord, { mode: 'candidate' }),
    (error) => error.code === 'LEXICAL_SEARCH_FORM_COLLAPSED_ALIAS',
  );

  const multiSenseRecord = {
    ...singleSenseRecord,
    id: 'w-common-admission-coverage',
    candidate_id: 'w-common-admission-coverage',
    lemma: '공통 의미 경계',
    search_forms: ['공통 의미 경계'],
    senses: [
      {
        id: 'w-common-admission-coverage-s1',
        pos: 'noun',
        gloss: '공통 의미 경계의 첫 번째 쓰임을 검증한다.',
      },
      {
        id: 'w-common-admission-coverage-s2',
        pos: 'noun',
        gloss: '공통 의미 경계의 두 번째 쓰임을 검증한다.',
      },
    ],
  };
  const incompleteCoverage = multiSenseProductionReview(multiSenseRecord);
  incompleteCoverage.authored_decision.sense_evidence.pop();
  assert.throws(
    () => validateLexicalSemanticReview(incompleteCoverage, {
      decision: 'included',
      candidateRecord: multiSenseRecord,
      catalogCount: 1,
      requireSemanticEvidence: true,
      requireIndependentDecisionEvidence: true,
    }),
    /must cover every reviewed sense/u,
  );
});

test('the common production review cannot override mechanical duplicate or nested pairs', () => {
  for (const glosses of [
    ['같은 뜻을 설명한다', '같은 뜻을 설명한다'],
    ['붉은 꽃', '붉은 꽃 피어남'],
  ]) {
    const record = {
      id: 'w-common-boundary-regression',
      record_type: 'entry',
      role: 'start',
      candidate_id: 'w-common-boundary-regression',
      lemma: '공통경계회귀',
      search_forms: ['공통경계회귀'],
      senses: glosses.map((gloss, index) => ({
        id: `w-common-boundary-regression-s${index + 1}`,
        pos: 'noun',
        gloss,
      })),
    };
    assert.throws(
      () => validateLexicalSemanticReview(multiSenseProductionReview(record), {
        decision: 'included',
        candidateRecord: record,
        catalogCount: 1,
        requireSemanticEvidence: true,
      }),
      (error) => error.code === 'LEXICAL_SEMANTIC_BOUNDARY_BLOCKER',
    );
  }
});

test('the common production review cannot override mechanical usage or paraphrase pairs', () => {
  const cases = [
    ['종이를 자르는 도구', '천을 자르는 도구', 'usage-variant'],
    ['남의 마음을 함께 느끼는 일', '처지를 함께 느끼는 일', 'overlapping'],
    ['글에서 중심이 되는 생각', '말에서 중심이 되는 생각', 'usage-variant'],
  ];
  for (const [index, [leftGloss, rightGloss, relationship]] of cases.entries()) {
    const record = {
      id: `w-common-frame-regression-${index + 1}`,
      record_type: 'entry',
      role: 'start',
      candidate_id: `w-common-frame-regression-${index + 1}`,
      lemma: `공통프레임회귀${index + 1}`,
      search_forms: [`공통프레임회귀${index + 1}`],
      senses: [leftGloss, rightGloss].map((gloss, senseIndex) => ({
        id: `w-common-frame-regression-${index + 1}-s${senseIndex + 1}`,
        pos: 'noun',
        gloss,
      })),
    };
    assert.equal(inspectSenseBoundaryPairs(record)[0].relationship, relationship);
    assert.throws(
      () => validateLexicalSemanticReview(multiSenseProductionReview(record, {
        relationship,
      }), {
        decision: 'included',
        candidateRecord: record,
        catalogCount: 1,
        requireSemanticEvidence: true,
      }),
      (error) => error.code === 'LEXICAL_SEMANTIC_BOUNDARY_BLOCKER',
    );
  }
});

test('the shared production review catches 과/와 and connector-free merged domains', () => {
  const baseRecords = [{
    id: 'w001',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w001',
    lemma: '기존말',
    search_forms: ['기존말'],
    senses: [{ id: 'w001-s1', pos: 'noun', gloss: '기존 의미' }],
  }];
  for (const [index, gloss] of ['맛과 분위기가 이어진다', '맛 분위기가 이어진다'].entries()) {
    const candidateRecord = {
      id: `w${779 + index}`,
      record_type: 'entry',
      role: 'start',
      candidate_id: `w${779 + index}`,
      lemma: `미래말${index + 1}`,
      search_forms: [`미래말${index + 1}`],
      senses: [{ id: `w${779 + index}-s1`, pos: 'adjective', gloss }],
    };
    const reviewedRecord = {
      ...candidateRecord,
      id: `w${779 + index}`,
      candidate_id: `w${779 + index}`,
      senses: [{ id: `w${779 + index}-s1`, pos: 'adjective', gloss }],
    };
    const baseInfos = baseRecords.map((record) => ({ record, source: 'base' }));
    const prospectiveInfos = [...baseInfos, { record: reviewedRecord, source: 'prospective' }];
    const semanticAudit = makeSemanticAudit(prospectiveInfos);
    const productionState = makeProductionState({
      batchId: `future-batch-204${index + 2}`,
      candidateRecords: [candidateRecord],
      reviewedRecords: [reviewedRecord],
      baseRecords: baseInfos,
      prospectiveRecords: prospectiveInfos,
      semanticAudit,
    });
    assert.throws(
      () => validateLexicalProduction({
        batchId: `future-batch-204${index + 2}`,
        candidateRecords: [candidateRecord],
        reviews: [{
          candidate_id: candidateRecord.id,
          decision: 'included',
          reviewed_record: reviewedRecord,
          semantic_review: productionReview({
            candidateRecord,
            reviewedRecord,
            gloss,
            boundaryDecision: 'atomic',
          }),
        }],
        baseRecords: baseInfos,
        prospectiveRecords: prospectiveInfos,
        semanticAudit,
        productionState: productionState.state,
        productionStateSources: productionState.sources,
        productionPayloads: productionState.payloads,
        catalogCount: 1,
        expectedSelectedCount: 1,
      }),
      /multiple writer domains|semantic review must split/u,
    );
  }
});

test('a later batch cannot bypass the shared generation and review stages', () => {
  assert.throws(
    () => validateLexicalProduction({
      batchId: 'future-batch-2044',
      candidateRecords: [{ id: 'proposal-1' }],
      reviews: [],
    }),
    /reviews must cover every candidate record/u,
  );
});

test('a semantic audit becomes stale when gloss, POS, or relation content changes', () => {
  const base = {
    id: 'w901',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w901',
    lemma: '감사기준',
    search_forms: ['감사기준'],
    senses: [{
      id: 'w901-s1',
      pos: 'noun',
      gloss: '검증 가능한 의미 기준.',
    }],
  };
  const baseInfos = [{ record: base, source: 'base' }];
  const audit = makeSemanticAudit(baseInfos);
  const mutations = [
    (record) => ({
      ...record,
      senses: [{ ...record.senses[0], gloss: '검증 가능한 수정 의미 기준.' }],
    }),
    (record) => ({
      ...record,
      senses: [{ ...record.senses[0], pos: 'adjective' }],
    }),
    (record) => ({
      ...record,
      senses: [{
        ...record.senses[0],
        relations: [{ target: 'w902', type: 'near', note: '검증 관계' }],
      }],
    }),
  ];
  for (const mutate of mutations) {
    const prospective = [{ record: mutate(structuredClone(base)), source: 'prospective' }];
    assert.throws(
      () => validateSemanticAuditCoverage(prospective, audit),
      /does not match|mismatch|drifted/u,
    );
  }
});

test('deterministic coverage alone cannot satisfy the semantic review contract', () => {
  const record = {
    id: 'w902',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w902',
    lemma: '검수범위',
    search_forms: ['검수범위'],
    senses: [{ id: 'w902-s1', pos: 'noun', gloss: '명시적으로 검수할 범위.' }],
  };
  const infos = [{ record, source: 'prospective' }];
  const coverageOnly = buildSemanticCoverageArtifact(infos);
  assert.throws(
    () => validateSemanticAuditCoverage(infos, coverageOnly),
    /contract version|semantic audit\.coverage|review/u,
  );
  assert.equal(Object.hasOwn(coverageOnly.records[0].sense_coverage[0], 'sense_boundary'), false);
});

test('reviewed existing-record correction passes while an unreviewed replacement fails', () => {
  const base = {
    id: 'w903',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w903',
    lemma: '교정대상',
    search_forms: ['교정대상'],
    senses: [{ id: 'w903-s1', pos: 'noun', gloss: '기존 의미.' }],
  };
  const corrected = {
    ...base,
    senses: [{ id: 'w903-s1', pos: 'noun', gloss: '검수 후 확정한 의미.' }],
  };
  const baseInfos = [{ record: base, source: 'base' }];
  const prospectiveInfos = [{ record: corrected, source: 'prospective' }];
  const changes = [{
    record_id: corrected.id,
    decision: 'corrected',
    base_record_sha256: createHash('sha256').update(JSON.stringify(base), 'utf8').digest('hex'),
    prospective_record_sha256: createHash('sha256').update(JSON.stringify(corrected), 'utf8').digest('hex'),
    rationale: 'w903 was explicitly corrected and re-reviewed before replacement.',
  }];
  const audit = makeSemanticAudit(prospectiveInfos, { changes });
  const correctionProductionState = makeProductionState({
    batchId: 'future-batch-correction',
    reviewedRecords: [{ record: corrected, decision: 'corrected' }],
    baseRecords: baseInfos,
    prospectiveRecords: prospectiveInfos,
    semanticAudit: audit,
  });
  const admitted = validateLexicalAddition({
    batchId: 'future-batch-correction',
    baseRecords: baseInfos,
    reviewedRecords: [{ record: corrected, decision: 'corrected' }],
    prospectiveRecords: prospectiveInfos,
    semanticAudit: audit,
    productionState: correctionProductionState.state,
    productionStateSources: correctionProductionState.sources,
    productionPayloads: correctionProductionState.payloads,
  });
  assert.equal(admitted.reviewed_count, 1);
  assert.equal(
    correctionProductionState.payloads.semantic_review.output.review_rows[0].decision,
    'corrected',
  );
  const includedProductionState = makeProductionState({
    batchId: 'future-batch-correction-decision-lineage',
    reviewedRecords: [{ record: corrected, decision: 'included' }],
    baseRecords: baseInfos,
    prospectiveRecords: prospectiveInfos,
    semanticAudit: audit,
  });
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-correction-decision-lineage',
      baseRecords: baseInfos,
      reviewedRecords: [{ record: corrected, decision: 'corrected' }],
      prospectiveRecords: prospectiveInfos,
      semanticAudit: audit,
      productionState: includedProductionState.state,
      productionStateSources: includedProductionState.sources,
      productionPayloads: includedProductionState.payloads,
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_BINDING',
  );
  const substitutedBase = {
    ...base,
    senses: [{ id: 'w903-s1', pos: 'noun', gloss: '검수와 무관한 다른 기존 의미.' }],
  };
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-correction',
      baseRecords: [{ record: substitutedBase, source: 'base' }],
      reviewedRecords: [{ record: corrected, decision: 'corrected' }],
      prospectiveRecords: prospectiveInfos,
      semanticAudit: audit,
      productionState: correctionProductionState.state,
      productionStateSources: correctionProductionState.sources,
      productionPayloads: correctionProductionState.payloads,
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_BINDING',
  );
  const substitutedSemanticAudit = makeSemanticAudit(prospectiveInfos, {
    artifactId: 'future-batch-correction-substituted-audit',
    changes,
  });
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-correction',
      baseRecords: baseInfos,
      reviewedRecords: [{ record: corrected, decision: 'corrected' }],
      prospectiveRecords: prospectiveInfos,
      semanticAudit: substitutedSemanticAudit,
      productionState: correctionProductionState.state,
      productionStateSources: correctionProductionState.sources,
      productionPayloads: correctionProductionState.payloads,
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_BINDING',
  );
  const staleLexicalAuditProductionState = makeProductionState({
    batchId: 'future-batch-correction',
    reviewedRecords: [{ record: corrected, decision: 'corrected' }],
    baseRecords: baseInfos,
    prospectiveRecords: prospectiveInfos,
    semanticAudit: audit,
    producerLexicalAudit: {
      ...correctionProductionState.lexicalAudit,
      scope: 'future-batch-correction:stale-producer-audit',
    },
  });
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-correction',
      baseRecords: baseInfos,
      reviewedRecords: [{ record: corrected, decision: 'corrected' }],
      prospectiveRecords: prospectiveInfos,
      semanticAudit: audit,
      productionState: staleLexicalAuditProductionState.state,
      productionStateSources: staleLexicalAuditProductionState.sources,
      productionPayloads: staleLexicalAuditProductionState.payloads,
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_BINDING',
  );
  const staleGateProductionState = makeProductionState({
    batchId: 'future-batch-correction',
    reviewedRecords: [{ record: corrected, decision: 'corrected' }],
    baseRecords: baseInfos,
    prospectiveRecords: prospectiveInfos,
    semanticAudit: audit,
    producerGateDigest: productionValueSha256({ status: 'admitted', gate: 'stale' }),
  });
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-correction',
      baseRecords: baseInfos,
      reviewedRecords: [{ record: corrected, decision: 'corrected' }],
      prospectiveRecords: prospectiveInfos,
      semanticAudit: audit,
      productionState: staleGateProductionState.state,
      productionStateSources: staleGateProductionState.sources,
      productionPayloads: staleGateProductionState.payloads,
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_BINDING',
  );
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-correction',
      baseRecords: baseInfos,
      reviewedRecords: [],
      prospectiveRecords: prospectiveInfos,
      semanticAudit: audit,
      productionState: correctionProductionState.state,
      productionStateSources: correctionProductionState.sources,
      productionPayloads: correctionProductionState.payloads,
    }),
    /does not preserve base record w903|corrected|producer-owned selection output/u,
  );
});
