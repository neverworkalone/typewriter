import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  Stage3AdmissionError, planStage3Admission, validateStage3AdmissionManifest,
} from '../scripts/factory/admission.mjs';
import { walkStage3History } from '../scripts/factory/validate.mjs';
import { canonicalRecordSha256 } from '../scripts/factory/admission.mjs';
import { validateDecisionRow } from '../scripts/factory/handoff.mjs';
import { buildStage3SemanticAuthority } from '../scripts/factory/semantic-authority.mjs';
import { reviewedCandidateRecord } from '../scripts/factory/artifacts.mjs';
import {
  buildSemanticAuditFromDecisionSource, canonicalRecordsBeforeFactoryAdmissions, inspectSenseBoundaryPairs,
  isAdditiveFactoryAmendment, readAuthoredBatchDecisionSources, sha256Json,
} from '../scripts/validate/semantic-audit.mjs';
import { authorSemanticReviewBinding } from '../scripts/validate/semantic-decision-row.mjs';

const digest = 'a'.repeat(64);
const GLOSS = '빛이 흐리지 않고 밝다.';
const source = () => ({
  id: 'w00001', record_type: 'entry', role: 'start', candidate_id: 'w00001', lemma: '맑다', search_forms: ['맑다'],
  senses: [{ id: 'w00001-s1', pos: 'adjective', gloss: GLOSS }, { id: 'w00001-s2', pos: 'adjective', gloss: '소리가 또렷하고 깨끗하다.' }],
});
const NEW_ID = 'C000001-0001';
const amendment = (overrides = {}) => ({
  source_record_id: 'w00001', source_sense_id: 'w00001-s1', source_gloss_sha256: sha256Json(GLOSS),
  relation: { target: NEW_ID, target_sense: `${NEW_ID}-s1`, type: 'near', note: '가깝지만 바꿔 쓸 수는 없다.', relevance: 6 },
  rationale: 'w00001 w00001-s1: 새 뜻에서 거꾸로 떠오르는 가까운 결이다.',
  ...overrides,
});
const decision = (extra = {}) => ({
  source_candidate_id: NEW_ID, disposition: 'included', target: { kind: 'new_entry' },
  reviewed_record: { lemma: '새롭다', senses: [{ pos: 'adjective', gloss: '새로운 풀이.' }] },
  relation_amendments: [amendment()],
  ...extra,
});
function plan(decisions, canonicalRecords = [source()]) {
  return planStage3Admission({
    batchId: 'C000001', attempt: 1, admissionPr: 1,
    candidateManifest: { batch_id: 'C000001', status: 'complete', candidates_sha256: digest },
    reviewManifest: { batch_id: 'C000001', status: 'ready', attempt: 1, candidates_sha256: digest, semantic_decisions_sha256: digest },
    candidates: decisions.map((row) => ({ candidate_id: row.source_candidate_id })),
    decisions, canonicalRecords, recordPathById: new Map(canonicalRecords.map((record) => [record.id, 'data/canonical/base.jsonl'])),
    baseCanonicalSnapshotDigest: digest,
  });
}
const lexicalCode = (code) => (error) => error instanceof Stage3AdmissionError && error.category === 'lexical' && error.code === code;

test('an existing source sense gains a relation to a newly allocated target id, and nothing else changes', () => {
  const original = source();
  const result = plan([decision()], [original]);
  const change = result.changes.find((item) => item.entry_id === 'w00001');
  assert.equal(change.operation, 'append_relations');
  const newId = result.entries[0].record_id;
  const amended = result.records.get('w00001').record;
  assert.deepEqual(amended.senses[0].relations, [
    { target: newId, target_sense: `${newId}-s1`, type: 'near', note: '가깝지만 바꿔 쓸 수는 없다.', relevance: 6 },
  ]);
  assert.deepEqual({ ...amended, senses: amended.senses.map(({ relations, ...rest }) => rest) },
    { ...original, senses: original.senses });
  assert.equal(amended.senses[1].relations, undefined);
  assert.equal(isAdditiveFactoryAmendment(original, amended, 'append_relations', result.relationAmendments), true);
  assert.deepEqual(change.added_relation_ids, [result.relationAmendments[0].relation_id]);
  assert.equal(result.relationAmendments[0].outcome, 'appended');
});

test('no reverse edge is synthesized on the new target', () => {
  const result = plan([decision()]);
  const created = result.records.get(result.entries[0].record_id).record;
  assert.equal(created.senses.every((sense) => sense.relations === undefined), true);
  assert.equal(result.changes.filter((change) => change.operation === 'append_relations').length, 1);
});

test('a same-batch provisional reference resolves to the allocated target', () => {
  const row = decision({ provisional_ref: 'prov-new', relation_amendments: [amendment({ relation: { ...amendment().relation, target: 'prov-new', target_sense: 'prov-new-s1' } })] });
  const result = plan([row]);
  const newId = result.entries[0].record_id;
  assert.equal(result.records.get('w00001').record.senses[0].relations[0].target, newId);
});

test('an unrelated concurrent append does not make a safe amendment stale', () => {
  const latest = source();
  latest.senses[0].relations = [{ target: 'w00009', type: 'direct', note: '다른 배치가 먼저 추가했다.' }];
  latest.senses.push({ id: 'w00001-s3', pos: 'noun', gloss: '다른 배치가 추가한 새 뜻.' });
  latest.search_forms = ['맑다', '맑은'];
  const result = plan([decision()], [latest, { id: 'w00009', record_type: 'entry', role: 'start', candidate_id: 'w00009', lemma: '밝다', search_forms: ['밝다'], senses: [{ id: 'w00009-s1', pos: 'adjective', gloss: '빛이 환하다.' }] }]);
  const amended = result.records.get('w00001').record;
  assert.equal(amended.senses[0].relations.length, 2);
  assert.equal(amended.senses[0].relations[0].target, 'w00009');
  assert.deepEqual(amended.search_forms, ['맑다', '맑은']);
  assert.equal(amended.senses.length, 3);
});

test('a changed source gloss or a missing source sense makes the enrichment stale', () => {
  const changed = source();
  changed.senses[0].gloss = '의미가 바뀐 뜻풀이.';
  assert.throws(() => plan([decision()], [changed]), lexicalCode('STAGE3_STALE_RELATION_SOURCE'));
  const missing = source();
  missing.senses.shift();
  assert.throws(() => plan([decision()], [missing]), lexicalCode('STAGE3_STALE_RELATION_SOURCE'));
  assert.throws(() => plan([decision()], []), lexicalCode('STAGE3_STALE_RELATION_SOURCE'));
});

test('an exact tuple already present is an idempotent no-op; a conflicting one is not rewritten', () => {
  const first = plan([decision()]);
  const newId = first.entries[0].record_id;
  const latest = source();
  latest.senses[0].relations = [{ target: newId, target_sense: `${newId}-s1`, type: 'near', note: '가깝지만 바꿔 쓸 수는 없다.', relevance: 6 }];
  const noop = plan([decision()], [latest]);
  assert.equal(noop.relationAmendments[0].outcome, 'already_present');
  assert.equal(noop.records.has('w00001'), false);
  assert.equal(noop.changes.some((change) => change.operation === 'append_relations'), false);
  latest.senses[0].relations[0].relevance = 3;
  assert.throws(() => plan([decision()], [latest]), lexicalCode('STAGE3_RELATION_CONFLICT'));
});

test('a source record the batch also changes, or an unresolved target, fails closed', () => {
  const sameBatch = decision({ target: { kind: 'new_sense_on_existing_entry', entry_id: 'w00001', context_sense_id: 'w00001-s1' }, reviewed_record: { lemma: '맑다', senses: [{ pos: 'adjective', gloss: '날씨가 흐리지 않고 화창하다.' }] } });
  assert.throws(() => plan([sameBatch]), lexicalCode('STAGE3_RELATION_SOURCE_CONFLICT'));
  const unresolved = decision({ relation_amendments: [amendment({ relation: { ...amendment().relation, target: 'w99999', target_sense: 'w99999-s1' } })] });
  assert.throws(() => plan([unresolved]), lexicalCode('STAGE3_RELATION_TARGET'));
});

test('Stage 2 amendment shape is validated for every admitted decision and refused on non-admitted rows', () => {
  const at = (row) => validateDecisionRow(row, { canonicalIndex: new Map() });
  assert.deepEqual(at(decision()), []);
  const bad = (overrides) => at(decision({ relation_amendments: [amendment(overrides)] })).join('\n');
  assert.match(bad({ relation: { ...amendment().relation, relevance: undefined } }), /requires relevance 1-9/u);
  assert.match(bad({ relation: { ...amendment().relation, relevance: 10 } }), /requires relevance 1-9/u);
  assert.match(bad({ relation: { target: NEW_ID, type: 'direct', note: 'n', relevance: 5 } }), /must not carry relevance/u);
  assert.match(bad({ relation: { ...amendment().relation, type: 'synonym' } }), /not a supported relation type/u);
  assert.match(bad({ source_sense_id: 'w00002-s1' }), /sense of source_record_id/u);
  assert.match(bad({ source_gloss_sha256: 'x' }), /sha256/u);
  assert.match(bad({ rationale: '근거만 있고 출처가 없다.' }), /source-bound/u);
  assert.match(bad({ relation: { ...amendment().relation, target: 'w00001' } }), /own source/u);
  assert.match(at(decision({ relation_amendments: [amendment(), amendment()] })).join('\n'), /repeats another amendment/u);
  assert.match(at({ source_candidate_id: NEW_ID, disposition: 'held', reason: '근거 부족', relation_amendments: [amendment()] }).join('\n'), /must not carry relation_amendments/u);
});

// Production path: real canonical revision + real semantic authority + the complete source-bound audit.
async function realCanonical() {
  const records = [];
  const paths = new Map();
  for (const name of (await readdir('data/canonical')).filter((file) => file.endsWith('.jsonl'))) {
    for (const line of (await readFile(path.join('data/canonical', name), 'utf8')).split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      records.push(record);
      paths.set(record.id, `data/canonical/${name}`);
    }
  }
  return { records, paths };
}

test('a reverse amendment on a real canonical record passes the authority and the complete semantic audit', async () => {
  const { records, paths } = await realCanonical();
  const ledger = JSON.parse(await readFile('data/validation/canonical-semantic-decision-source.json', 'utf8'));
  const touched = new Set((ledger.factory_admissions ?? []).flatMap((event) => event.changes.map((change) => change.entry_id)));
  const existing = records.find((record) => !touched.has(record.id) && record.senses.length === 1 && record.senses[0].pos === 'noun');
  const sense = existing.senses[0];
  const id = 'C900001-0001';
  const decisionRow = {
    source_candidate_id: id, disposition: 'included', target: { kind: 'new_entry' },
    reviewed_record: { lemma: '합성시험낱말', senses: [{ pos: 'noun', gloss: '합성 시험에서 쓰는 첫째 뜻풀이.' }] },
    relation_amendments: [{
      source_record_id: existing.id, source_sense_id: sense.id, source_gloss_sha256: sha256Json(sense.gloss),
      relation: { target: id, target_sense: `${id}-s1`, type: 'association', note: '새 낱말에서 거꾸로 떠오르는 연상이다.', relevance: 4 },
      rationale: `${existing.id} ${sense.id}: 합성 시험의 역방향 연상 근거.`,
    }],
  };
  const record = reviewedCandidateRecord(decisionRow);
  const row = {
    source_candidate_id: id, candidate_record_id: id, candidate_record_sha256: sha256Json(record), decision: 'included',
    decision_rationale: `${id}: 합성 시험 결정.`, gloss_judgment: 'fit',
    sense_reviews: record.senses.map((item) => ({
      sense_id: item.id, boundary_action: 'retain', boundary_classification: 'atomic', boundary_decision: 'atomic',
      boundary_rationale: `${id} ${item.id}: 한 가지 뜻으로 한정된다.`, semantic_rationale: `${id} ${item.id}: ${item.gloss}`,
      relation_decision: 'no-relations', relation_count: 0, relation_ids: [], no_relation_rationale: `${id} ${item.id}: 관계 없음.`,
    })),
    boundary_pairs: inspectSenseBoundaryPairs(record).map(() => { throw new Error('single-sense record has no pairs'); }),
  };
  row.review_binding = authorSemanticReviewBinding(row, record);
  const admission = planStage3Admission({
    batchId: 'C900001', attempt: 1, admissionPr: 1,
    candidateManifest: { batch_id: 'C900001', status: 'complete', candidates_sha256: digest },
    reviewManifest: { batch_id: 'C900001', status: 'ready', attempt: 1, candidates_sha256: digest, semantic_decisions_sha256: digest },
    candidates: [{ candidate_id: id }], decisions: [decisionRow], canonicalRecords: records, recordPathById: paths, baseCanonicalSnapshotDigest: digest,
  });
  const authority = await buildStage3SemanticAuthority({
    root: process.cwd(), baseCanonicalRecords: records, plan: admission, semanticDecisions: { decisions: [row] }, semanticDecisionsText: '{}',
  });
  const after = records.map((item) => admission.records.get(item.id)?.record ?? item)
    .concat([...admission.records.values()].filter((update) => !update.before).map((update) => update.record));
  const batchDecisionSources = await readAuthoredBatchDecisionSources();
  assert.doesNotThrow(() => buildSemanticAuditFromDecisionSource(after, authority.sourceObject, {
    baseRecords: after, batchDecisionSources, artifactId: 'test-reverse-relation-audit',
  }));
  const event = authority.sourceEvent;
  assert.equal(event.relation_amendments[0].outcome, 'appended');
  assert.equal(event.changes.find((change) => change.entry_id === existing.id).operation, 'append_relations');
  const restored = canonicalRecordsBeforeFactoryAdmissions(after, authority.sourceObject);
  assert.deepEqual(restored.find((item) => (item.record ?? item).id === existing.id), records.find((item) => item.id === existing.id));
  const manifest = { ...admission.reviewManifest, admission: {
    ...admission.reviewManifest.admission, canonical_snapshot_digest: digest,
    semantic_authority: { path: 'data/validation/canonical-semantic-decision-source.json', source_id: authority.sourceObject.source_id, admission_sha256: event.sha256 },
  } };
  assert.deepEqual(validateStage3AdmissionManifest(manifest, [decisionRow], new Map(after.map((item) => [item.id, item]))), []);
  const tampered = structuredClone(manifest);
  tampered.admission.relation_amendments[0].outcome = 'already_present';
  assert.match(validateStage3AdmissionManifest(tampered, [decisionRow], new Map(after.map((item) => [item.id, item]))).join('\n'), /outcome does not match/u);
});

// Operation-specific invariants (shared by the ledger restore, the promotion check and the factory history walk).
const rel = (target, note = '관계') => ({ target, type: 'direct', note });
test('each operation may change only what it declares, and a mixed history is verified exactly', () => {
  const original = source();
  const withSense = { ...original, senses: [...original.senses, { id: 'w00001-s3', pos: 'noun', gloss: '추가된 새 뜻.' }] };
  const unrecorded = structuredClone(withSense);
  unrecorded.senses[0].relations = [rel('w00009')];
  const recorded = structuredClone(withSense);
  recorded.senses[0].relations = [rel('w00007')];
  const tuple = { source_candidate_id: NEW_ID, source_record_id: 'w00001', source_sense_id: 'w00001-s1', relation_id: 'rel-x', relation: rel('w00007'), outcome: 'appended' };

  assert.equal(isAdditiveFactoryAmendment(original, withSense, 'append_senses'), true);
  assert.equal(isAdditiveFactoryAmendment(original, unrecorded, 'append_senses'), false);
  assert.equal(isAdditiveFactoryAmendment(original, recorded, 'append_relations', [tuple]), false, 'senses may not be added by a relation amendment');
  assert.equal(isAdditiveFactoryAmendment(withSense, recorded, 'append_relations', [tuple]), true);
  assert.equal(isAdditiveFactoryAmendment(withSense, recorded, 'append_relations', []), false, 'an unrecorded suffix is refused');
  assert.equal(isAdditiveFactoryAmendment(withSense, recorded, 'append_relations', [{ ...tuple, relation: rel('w00008') }]), false);

  const changes = (afterSenses) => [
    { batchId: 'C000001', operation: 'append_senses', added_sense_ids: ['w00001-s3'], before_sha256: canonicalRecordSha256(original), after_sha256: canonicalRecordSha256(afterSenses), relationAmendments: [] },
    { batchId: 'C000002', operation: 'append_relations', added_relation_ids: ['rel-x'], before_sha256: canonicalRecordSha256(withSense), after_sha256: canonicalRecordSha256(recorded), relationAmendments: [tuple] },
  ];
  assert.deepEqual(walkStage3History('w00001', recorded, changes(withSense)), []);
  const smuggled = structuredClone(unrecorded);
  smuggled.senses[0].relations.push(rel('w00007'));
  const bad = [changes(unrecorded)[0], { ...changes(unrecorded)[1], before_sha256: canonicalRecordSha256(unrecorded), after_sha256: canonicalRecordSha256(smuggled) }];
  assert.match(walkStage3History('w00001', smuggled, bad).join('\n'), /before digest does not follow/u);
  assert.match(walkStage3History('w00001', structuredClone(smuggled), changes(withSense)).join('\n'), /outside source-bound/u);
});

test('hostile amendment JSON yields contract errors, never exceptions, on every shared Stage 2 and Stage 3 path', () => {
  const hostile = [null, 0, 12, true, [], ['x'], {}, { toString: 123 }, { toString: null }, { toString: () => 'w00001' }];
  const paths = [
    (item, value) => ({ ...item, source_record_id: value }),
    (item, value) => ({ ...item, source_sense_id: value }),
    (item, value) => ({ ...item, source_gloss_sha256: value }),
    (item, value) => ({ ...item, rationale: value }),
    (item, value) => ({ ...item, relation: value }),
    (item, value) => ({ ...item, relation: { ...item.relation, target: value } }),
    (item, value) => ({ ...item, relation: { ...item.relation, target_sense: value } }),
    (item, value) => ({ ...item, relation: { ...item.relation, type: value } }),
    (item, value) => ({ ...item, relation: { ...item.relation, note: value } }),
    (item, value) => ({ ...item, relation: { ...item.relation, relevance: value } }),
  ];
  for (const mutate of paths) {
    for (const value of hostile) {
      const row = decision({ relation_amendments: [mutate(amendment(), value)] });
      // Every JSON round-trip variant: the validator must only ever see plain data.
      const rows = [row, JSON.parse(JSON.stringify(row))];
      for (const candidate of rows) {
        const errors = validateDecisionRow(candidate, { canonicalIndex: new Map() });
        assert.ok(errors.length > 0 || JSON.stringify(candidate) === JSON.stringify(decision()), 'invalid amendment must be reported');
        assert.ok(errors.every((error) => typeof error === 'string'));
        if (errors.length) assert.throws(() => plan([candidate]), lexicalCode('STAGE3_CANONICAL_CONFLICT'));
      }
    }
  }
  for (const value of hostile) {
    assert.ok(Array.isArray(validateDecisionRow({ ...decision(), source_candidate_id: value }, { canonicalIndex: new Map() })));
    assert.ok(Array.isArray(validateDecisionRow(decision({ relation_amendments: value }), { canonicalIndex: new Map() })));
  }
  assert.deepEqual(validateDecisionRow(decision(), { canonicalIndex: new Map() }), []);
});

test('two admitted decisions proposing one tuple: first appends, second is an idempotent no-op, through the real authority, audit and validators', async () => {
  const { records, paths } = await realCanonical();
  const ledger = JSON.parse(await readFile('data/validation/canonical-semantic-decision-source.json', 'utf8'));
  const touched = new Set((ledger.factory_admissions ?? []).flatMap((event) => event.changes.map((change) => change.entry_id)));
  const existing = records.find((record) => !touched.has(record.id) && record.senses.length === 1 && record.senses[0].pos === 'noun');
  const sense = existing.senses[0];
  const idA = 'C900001-0001';
  const idB = 'C900001-0002';
  const amend = (rationale) => [{
    source_record_id: existing.id, source_sense_id: sense.id, source_gloss_sha256: sha256Json(sense.gloss),
    relation: { target: idA, target_sense: `${idA}-s1`, type: 'association', note: '새 낱말에서 거꾸로 떠오르는 연상이다.', relevance: 4 },
    rationale: `${existing.id} ${sense.id}: ${rationale}`,
  }];
  const decisions = [
    { source_candidate_id: idA, disposition: 'included', target: { kind: 'new_entry' }, reviewed_record: { lemma: '합성시험낱말', senses: [{ pos: 'noun', gloss: '합성 시험에서 쓰는 첫째 뜻풀이.' }] }, relation_amendments: amend('첫째 후보의 근거.') },
    { source_candidate_id: idB, disposition: 'included', target: { kind: 'new_entry' }, reviewed_record: { lemma: '합성시험단어', senses: [{ pos: 'noun', gloss: '합성 시험에서 쓰는 또 다른 단일 뜻풀이.' }] }, relation_amendments: amend('둘째 후보의 근거.') },
  ];
  const rowFor = (decisionRow) => {
    const id = decisionRow.source_candidate_id;
    const record = reviewedCandidateRecord(decisionRow);
    const row = {
      source_candidate_id: id, candidate_record_id: id, candidate_record_sha256: sha256Json(record), decision: 'included',
      decision_rationale: `${id}: 합성 시험 결정.`, gloss_judgment: 'fit',
      sense_reviews: record.senses.map((item) => ({
        sense_id: item.id, boundary_action: 'retain', boundary_classification: 'atomic', boundary_decision: 'atomic',
        boundary_rationale: `${id} ${item.id}: 한 가지 뜻으로 한정된다.`, semantic_rationale: `${id} ${item.id}: ${item.gloss}`,
        relation_decision: 'no-relations', relation_count: 0, relation_ids: [], no_relation_rationale: `${id} ${item.id}: 관계 없음.`,
      })),
      boundary_pairs: [],
    };
    row.review_binding = authorSemanticReviewBinding(row, record);
    return row;
  };
  const admission = planStage3Admission({
    batchId: 'C900001', attempt: 1, admissionPr: 1,
    candidateManifest: { batch_id: 'C900001', status: 'complete', candidates_sha256: digest },
    reviewManifest: { batch_id: 'C900001', status: 'ready', attempt: 1, candidates_sha256: digest, semantic_decisions_sha256: digest },
    candidates: decisions.map((row) => ({ candidate_id: row.source_candidate_id })), decisions, canonicalRecords: records, recordPathById: paths, baseCanonicalSnapshotDigest: digest,
  });
  assert.deepEqual(admission.relationAmendments.map((item) => item.outcome), ['appended', 'already_present']);
  assert.equal(admission.records.get(existing.id).record.senses[0].relations.length, 1);
  const authority = await buildStage3SemanticAuthority({
    root: process.cwd(), baseCanonicalRecords: records, plan: admission, semanticDecisions: { decisions: decisions.map(rowFor) }, semanticDecisionsText: '{}',
  });
  const after = records.map((item) => admission.records.get(item.id)?.record ?? item)
    .concat([...admission.records.values()].filter((update) => !update.before).map((update) => update.record));
  const batchDecisionSources = await readAuthoredBatchDecisionSources();
  assert.doesNotThrow(() => buildSemanticAuditFromDecisionSource(after, authority.sourceObject, {
    baseRecords: after, batchDecisionSources, artifactId: 'test-duplicate-reverse-relation',
  }));
  const manifest = { ...admission.reviewManifest, admission: {
    ...admission.reviewManifest.admission, canonical_snapshot_digest: digest,
    semantic_authority: { path: 'data/validation/canonical-semantic-decision-source.json', source_id: authority.sourceObject.source_id, admission_sha256: authority.sourceEvent.sha256 },
  } };
  const byId = new Map(after.map((item) => [item.id, item]));
  assert.deepEqual(validateStage3AdmissionManifest(manifest, decisions, byId), []);
  const flipped = (mutate) => { const copy = structuredClone(manifest); mutate(copy.admission.relation_amendments); return validateStage3AdmissionManifest(copy, decisions, byId).join('\n'); };
  assert.match(flipped((list) => { list[1].outcome = 'appended'; }), /outcome does not match|added_relation_ids differ/u);
  assert.match(flipped((list) => { list[0].outcome = 'already_present'; }), /outcome does not match|added_relation_ids differ/u);
});
