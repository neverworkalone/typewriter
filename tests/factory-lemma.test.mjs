import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildTextFreeCandidateEvidence } from '../scripts/reference/run-corpus-lemma-pilot.mjs';
import { validateReviewArtifacts, reviewedCandidateRecord } from '../scripts/factory/artifacts.mjs';
import {
  CANDIDATE_MANIFEST_CONTRACT, PROPOSAL_CONTRACT, REVIEW_MANIFEST_CONTRACT, expectedAnalyzerDigest, sha256Hex, validateCandidateBatch,
} from '../scripts/factory/contract.mjs';
import { buildCanonicalIndex, buildSearchFormSupport, candidateViews, intakeCandidates, toRawCandidate } from '../scripts/factory/identity-adapter.mjs';
import { validateLemmaDecision } from '../scripts/factory/lemma-decisions.mjs';
import { expectedScopes } from '../scripts/factory/scope-declaration.mjs';
import { produceCandidateBatch } from '../scripts/factory/stage1.mjs';
import { validateCandidateTransition } from '../scripts/factory/transitions.mjs';
import { validateFactoryRepository } from '../scripts/factory/validate.mjs';
import { buildProductionHandoff } from '../scripts/intake/production-handoff.mjs';
import { analysisInputDigest } from '../scripts/intake/pipeline.mjs';
import { inspectSenseBoundaryPairs, sha256Json } from '../scripts/validate/semantic-audit.mjs';
import { authorSemanticReviewBinding } from '../scripts/validate/semantic-decision-row.mjs';

const HEX = 'a'.repeat(64);
const METADATA = { service_version: '1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0', top_n: 3, proposal_contract: PROPOSAL_CONTRACT };
const P = (lemma, pos, form = lemma) => ({ lemma, pos, form });
const ANALYSES = {
  짠한: [[P('짠하다', 'adjective', '짠하')]], 짠해서: [[P('짠하다', 'adjective', '짠하')]],
  가는: [[P('가다', 'verb', '가')]], 가서: [[P('가다', 'verb', '가')]], 갈: [[P('가다', 'verb', '가')]],
  걸음: [[P('걸음', 'noun')]],
};
const analyzer = async (requests) => ({
  metadata: METADATA,
  results: requests.map(({ id, text }) => ({ id, input_digest: analysisInputDigest(text), reason: '', ...(ANALYSES[text] ? { status: 'ok', analyses: ANALYSES[text] } : { status: 'unsupported', analyses: [] }) })),
});
// Analyzer for the lemma (citation) forms that the shared hand-off analyzes.
const LEMMA_POS = { 가다: 'verb', 짠하다: 'adjective', 걸음: 'noun' };
const lemmaAnalyzer = async (requests) => ({
  metadata: METADATA,
  results: requests.map(({ id, text }) => ({ id, input_digest: analysisInputDigest(text), reason: '', status: 'ok', analyses: [[P(text, LEMMA_POS[text], text)]] })),
});
const hit = (document, paragraph, surface, extra = {}) => ({
  source_path: 'corpus/x', corpus_id: 'c', document_id: document, document_ordinal: 1, paragraph_id: paragraph,
  paragraph_ordinal: 1, source_category: 'written', source_year: 2025, matched_surface_form: surface, ...extra,
});
const cand = (lemma, pos, hits) => ({
  proposed_lemma: lemma, proposed_pos: pos, coverage_status: 'uncovered', ambiguity_status: 'clear',
  observed_surface_forms: [...new Set(hits.map((h) => h.matched_surface_form))].map((surface) => ({ surface })),
  evidence: { representative_hits: hits },
});
const evidenceDoc = (candidates) => ({
  contract_version: 'm9-corpus-candidate-evidence-v1',
  index: { input_manifest_sha256: HEX, logical_rows_sha256: 'b'.repeat(64) },
  extractor: { extractor_version: 'ex-1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0' },
  candidates,
});
const EVIDENCE = evidenceDoc([
  cand('가다', 'verb', [hit('d1', 'p1', '가는'), hit('d2', 'p1', '가서')].map((h, i) => ({ ...h, usage_group: i ? 'pass' : 'move' }))),
  cand('짠하다', 'adjective', [hit('d3', 'p1', '짠한')]),
]);
const ENTRIES = [
  { id: 'w1', record_type: 'entry', lemma: '걸음', senses: [{ id: 'w1-s1', pos: 'noun', gloss: 'g' }] },
  { id: 'w3', record_type: 'entry', lemma: '가다', senses: [{ id: 'w3-s1', pos: 'verb', gloss: 'g' }] },
];
const INDEX = buildCanonicalIndex(ENTRIES);
const batchOf = (evidence = EVIDENCE, batchId = 'C000002', over = {}) => produceCandidateBatch({
  evidence, analyzer, canonicalEntries: [], canonicalDigest: HEX, batchId, taskId: 'T000001', ...over,
});
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const restamp = (manifest, rows) => {
  const candidatesText = jsonl(rows);
  return { manifest: { ...manifest, candidates_sha256: sha256Hex(candidatesText) }, candidatesText };
};

// A v1 (per-usage) historical batch stays valid beside the lemma batches.
const v1Record = (n, over = {}) => ({
  candidate_id: `C000001-000${n}`, input: '걸음', pos: 'noun', usage_hint: 'h', observedForms: ['걸음'],
  evidence: [{ kind: 'corpus-paragraph', ref: `old-${n}` }], holds: [], ...over,
});
function v1Batch(rows = [v1Record(1), v1Record(2)]) {
  const candidatesText = jsonl(rows);
  return {
    candidatesText,
    manifest: {
      contract: CANDIDATE_MANIFEST_CONTRACT, task_id: 'T000001', batch_id: 'C000001', candidate_count: rows.length, source_adapter: 'corpus-adapter',
      source_snapshot: 's', canonical_snapshot_digest: HEX, extractor_version: 'x', analyzer_version: 'kiwipiepy==0.24.0', proposal_contract: PROPOSAL_CONTRACT,
      analyzer_digest: expectedAnalyzerDigest({ analyzer_version: 'kiwipiepy==0.24.0', proposal_contract: PROPOSAL_CONTRACT }),
      source_evidence_sha256: HEX, candidates_sha256: sha256Hex(candidatesText), status: 'created',
    },
  };
}

test('a valid lemma batch passes; the same validator still accepts the historical v1 shape', async () => {
  const { manifest, candidatesText, rows } = await batchOf();
  assert.deepEqual(rows.map((row) => row.input), ['가다', '짠하다']);
  assert.deepEqual(validateCandidateBatch({ manifest, candidatesText }), []);
  const old = v1Batch();
  assert.deepEqual(validateCandidateBatch(old), []);
});

test('lemma batch fails closed on tampering, stale digests, missing provenance and count mismatches', async () => {
  const { manifest, rows } = await batchOf();
  const check = (mutate, fragment, restampRows = true) => {
    const copy = clone(rows);
    const man = clone(manifest);
    mutate(copy, man);
    const batch = restampRows ? restamp(man, copy) : { manifest: man, candidatesText: jsonl(copy) };
    const errors = validateCandidateBatch(batch);
    assert.ok(errors.some((error) => error.includes(fragment)), `${fragment}: ${errors.join(' | ')}`);
  };
  const good = restamp(manifest, rows);
  assert.ok(validateCandidateBatch({ manifest: good.manifest, candidatesText: `${good.candidatesText} ` }).some((e) => e.includes('candidates_sha256')));
  check((r, m) => { m.candidate_count = 3; }, 'candidate_count');
  check((r, m) => { m.observation_count = 99; }, 'observation_count');
  check((r) => { r[0].observations[0].analysis.input_digest = HEX; }, 'does not bind the observed form');
  check((r) => { r[0].observations[0].analysis.status = 'error'; }, 'analysis must be');
  check((r) => { r[0].observations[0].holds = ['analysis_unsupported']; }, 'unresolved-analysis reasons');
  check((r) => { r[0].observations[0].holds = ['made_up']; }, 'holds must be');
  check((r) => { r[0].observation_digest = HEX; }, 'observation_digest does not match');
  check((r) => { r[0].observations[0].evidence.text = 'raw paragraph'; }, 'text-free');
  check((r) => { r[1].input = '가다'; }, 'repeats within the batch');
  check((r) => { r[0].usage_groups.pop(); }, 'does not name a usage group');
  check((r) => { r[0].observations = r[0].observations.filter((o) => o.group_id.endsWith('g01')); r[0].observation_total = 1; }, 'has no observation');
  check((r) => { r[0].forms.push({ form_id: 'C000002-0001.f03', surface: '갈' }); }, 'has no observation');
  check((r) => { r[0].extra = 1; }, 'unknown field');
  check((r) => { r[0].observations[0].observation_id = 'C000002-0001.o09'; }, 'observation_id must be');
  check((r, m) => { m.selection.deferred_lemma_count = 4; }, 'eligible lemmas must equal');
  check((r, m) => { m.unresolved_observations = [{ surface: 'x', evidence: { kind: 'k', ref: 'r' }, holds: ['analysis_ambiguous'] }]; }, 'unresolved-analysis reason');
  check((r, m) => { delete m.source_evidence_sha256; }, 'missing source_evidence_sha256');
  check((r, m) => { delete m.analyzer_digest; }, 'missing analyzer_digest');
  check((r, m) => { m.analyzer_digest = HEX; }, 'analyzer_digest must bind');
  check((r, m) => { m.lemma_policy = 'usage-rows'; }, 'lemma_policy');
  check((r) => { [r[0], r[1]] = [r[1], r[0]]; r[0].candidate_id = 'C000002-0001'; r[1].candidate_id = 'C000002-0002'; }, 'ordered by lemma');
});

test('repository validator: v1 and v2 coexist; duplicate lemmas, extra files and count mismatches fail closed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-lemma-'));
  const put = async (batch, { manifest, candidatesText }) => {
    const directory = path.join(root, 'data/candidates', batch);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(path.join(directory, 'candidates.jsonl'), candidatesText);
    return directory;
  };
  await put('C000001', v1Batch());
  const second = await batchOf(EVIDENCE, 'C000002');
  const directory = await put('C000002', second);
  assert.deepEqual(await validateFactoryRepository({ root, canonicalEntries: [] }), []);

  // A later batch may not repeat a lemma of ANY earlier batch (v1 headwords included).
  const dup = await batchOf(evidenceDoc([cand('걸음', 'noun', [hit('d9', 'p1', '걸음')])]), 'C000003');
  await put('C000003', dup);
  assert.ok((await validateFactoryRepository({ root, canonicalEntries: [] })).some((e) => e.includes('repeats lemma 걸음 already in C000001-0001')));
  const again = await batchOf(evidenceDoc([cand('짠하다', 'adjective', [hit('d9', 'p1', '짠한')])]), 'C000003');
  await put('C000003', again);
  assert.ok((await validateFactoryRepository({ root, canonicalEntries: [] })).some((e) => e.includes('repeats lemma 짠하다 already in C000002-0002')));
  const { rm } = await import('node:fs/promises');
  await rm(path.join(root, 'data/candidates/C000003'), { recursive: true });
  assert.deepEqual(await validateFactoryRepository({ root, canonicalEntries: [] }), []);

  await writeFile(path.join(directory, 'raw-evidence.json'), '{}');
  assert.ok((await validateFactoryRepository({ root, canonicalEntries: [] })).some((e) => e.includes('C000002: candidate directory must hold exactly')));
  await rm(path.join(directory, 'raw-evidence.json'));
  await writeFile(path.join(root, 'data/candidates/NOTES.md'), 'x');
  assert.ok((await validateFactoryRepository({ root, canonicalEntries: [] })).some((e) => e.includes('only batch directories are allowed')));
  await rm(path.join(root, 'data/candidates/NOTES.md'));

  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ ...second.manifest, candidate_count: 5 }));
  assert.ok((await validateFactoryRepository({ root, canonicalEntries: [] })).some((e) => e.includes('candidate_count')));
});

test('an unauthorized contract migration of a merged batch is refused', async () => {
  const v1 = v1Batch().manifest;
  const v2 = (await batchOf()).manifest;
  const migrated = { ...v2, batch_id: 'C000001' };
  assert.ok(validateCandidateTransition(v1, migrated).some((e) => e.includes('contract migration')));
  assert.ok(validateCandidateTransition(v1, migrated).some((e) => e.includes('immutable')));
  assert.deepEqual(validateCandidateTransition(null, v2), []);
  assert.deepEqual(validateCandidateTransition(v2, { ...v2, status: 'complete' }), []);
});

// ---------------------------------------------------------------------------------------------
// Stage 2 decisions bound to usage groups

async function lemmaFixture() {
  const { manifest, rows } = await batchOf();
  const [go, pang] = rows;
  assert.deepEqual(go.usage_groups.map((g) => g.group_id), ['C000002-0001.g01', 'C000002-0001.g02']);
  const goDecision = (over = {}) => ({
    source_candidate_id: go.candidate_id, disposition: 'included', target: { kind: 'new_sense_on_existing_entry', entry_id: 'w3', context_sense_id: 'w3-s1' },
    reviewed_record: { lemma: '가다', senses: [{ pos: 'verb', gloss: '다른 곳으로 옮겨 가다.' }, { pos: 'verb', gloss: '시간이나 때가 지나가다.' }] },
    group_decisions: [
      { group_id: go.usage_groups[0].group_id, disposition: 'included', reason: '이동의 방향이 분명하다.', sense_indexes: [0] },
      { group_id: go.usage_groups[1].group_id, disposition: 'included', reason: '시간의 흐름을 가리킨다.', sense_indexes: [1] },
    ],
    ...over,
  });
  const pangDecision = (over = {}) => ({
    source_candidate_id: pang.candidate_id, disposition: 'included', target: { kind: 'new_entry' },
    reviewed_record: { lemma: '짠하다', senses: [{ pos: 'adjective', gloss: '안쓰러워 마음이 아프다.' }] },
    group_decisions: [{ group_id: pang.usage_groups[0].group_id, disposition: 'included', reason: '안쓰러운 마음의 결이다.', sense_indexes: [0] }],
    ...over,
  });
  return { manifest, rows, go, pang, goDecision, pangDecision };
}

test('every usage group needs one auditable disposition; sense opportunities cannot silently disappear', async () => {
  const { go, goDecision } = await lemmaFixture();
  const run = (decision, ctx = { canonicalIndex: INDEX }) => validateLemmaDecision(decision, go, ctx);
  assert.deepEqual(run(goDecision()), []);
  const has = (errors, fragment) => assert.ok(errors.some((e) => e.includes(fragment)), `${fragment}: ${errors.join(' | ')}`);
  const groups = goDecision().group_decisions;
  has(run(goDecision({ group_decisions: [groups[0]] })), 'entries for every usage group');
  has(run(goDecision({ group_decisions: undefined })), 'must account for every usage group');
  has(run(goDecision({ group_decisions: [groups[0], { ...groups[1], disposition: 'rejected', sense_indexes: undefined, reason: '' }] })), 'candidate-specific reason');
  // The second group is dropped as rejected, so the second reviewed sense is unclaimed.
  has(run(goDecision({ group_decisions: [groups[0], { group_id: groups[1].group_id, disposition: 'rejected', reason: '근거 부족.' }] })), 'reviewed sense 1 is not claimed');
  has(run(goDecision({ group_decisions: [groups[0], { ...groups[1], sense_indexes: [0] }] })), 'reviewed sense 1 is not claimed');
  has(run(goDecision({ group_decisions: [groups[0], { ...groups[1], sense_indexes: [7] }] })), 'missing sense');
  has(run(goDecision({ reviewed_record: { lemma: '가다', senses: [{ pos: 'noun', gloss: 'g' }, { pos: 'verb', gloss: 'g2' }] } })), 'the group is verb');
  // A held/rejected/deferred candidate cannot keep an included group.
  has(run({ source_candidate_id: go.candidate_id, disposition: 'rejected', reason: 'r', group_decisions: groups }), 'must not include a usage group');
  assert.deepEqual(run({ source_candidate_id: go.candidate_id, disposition: 'deferred', reason: 'r', group_decisions: groups.map((g) => ({ group_id: g.group_id, disposition: 'deferred', reason: 'later' })) }), []);
  has(run(goDecision({ group_decisions: groups.map((g) => ({ ...g, disposition: 'rejected', reason: 'r', sense_indexes: undefined })) })), 'at least one included group');
  has(run(goDecision({ group_decisions: [groups[0], { ...groups[1], disposition: 'rejected', reason: 'r' }] })), 'only an included group carries');
});

test('covered and search_coverage are canonical proofs, never assumptions from spelling or POS', async () => {
  const { go } = await lemmaFixture();
  const [move, pass] = go.usage_groups;
  const existing = { existing_entry_id: 'w3', existing_sense_id: 'w3-s1' };
  const rejectAll = (groupDecisions) => ({ source_candidate_id: go.candidate_id, disposition: 'rejected', reason: '기존 항목이 이미 포괄한다.', group_decisions: groupDecisions });
  const support = (...forms) => buildSearchFormSupport(forms.map((form) => ({ record_id: 'w3', sense_id: 'w3-s1', form, rule_id: 'r' })));
  const has = (errors, fragment) => assert.ok(errors.some((e) => e.includes(fragment)), `${fragment}: ${errors.join(' | ')}`);

  // 가는 is a supported search form of the existing 가다/verb sense; 가서 is not.
  const coveredMove = { group_id: move.group_id, disposition: 'covered', reason: '같은 뜻의 기존 동사 가다.', ...existing };
  const searchPass = { group_id: pass.group_id, disposition: 'search_coverage', reason: '뜻은 같고 형태만 빠졌다.', forms: ['가서'], ...existing };
  assert.deepEqual(validateLemmaDecision(rejectAll([coveredMove, searchPass]), go, { canonicalIndex: INDEX, support: support('가는') }), []);
  // The unsupported form makes `covered` invalid; only the search/morphology route can carry it.
  has(validateLemmaDecision(rejectAll([coveredMove, { ...searchPass, disposition: 'covered', forms: undefined }]), go, { canonicalIndex: INDEX, support: support('가는') }), 'use search_coverage');
  has(validateLemmaDecision(rejectAll([coveredMove, { ...searchPass, forms: ['가는'] }]), go, { canonicalIndex: INDEX, support: support('가는') }), 'exactly the unsupported observed forms');
  has(validateLemmaDecision(rejectAll([coveredMove, { ...searchPass, forms: ['가서'] }]), go, { canonicalIndex: INDEX, support: support('가는', '가서') }), 'exactly the unsupported observed forms');
  has(validateLemmaDecision(rejectAll([{ ...coveredMove, existing_sense_id: 'w9-s1' }, searchPass]), go, { canonicalIndex: INDEX, support: support('가는') }), 'requires an existing verb sense');
  has(validateLemmaDecision(rejectAll([coveredMove, searchPass]), go, { canonicalIndex: INDEX }), 'search-form support index is required');
  has(validateLemmaDecision(rejectAll([{ ...coveredMove, existing_entry_id: 'w1' }, searchPass]), go, { canonicalIndex: INDEX, support: support('가는') }), 'requires an existing verb sense');
});

// Review artifacts for a lemma batch: semantic rows, hand-off and per-group hold resolution.
// Pending reviews must declare the scope of each gloss; the default fixture names, for each sense, the first
// reason word of an excluded observation that its gloss does not use.
function defaultScope(decision, candidate) {
  return expectedScopes(decision, candidate).map(({ admitted, excluded, reasons }, index) => {
    const gloss = decision.reviewed_record.senses[index].gloss;
    const term = reasons.flatMap((reason) => reason.split(/[\s.,]+/u)).find((word) => word.length > 1 && !gloss.includes(word));
    return { admitted_observation_ids: admitted, excluded_observation_ids: excluded, excluded_terms: excluded.length ? [term] : [] };
  });
}
function semanticRow(decision, candidate) {
  const id = decision.source_candidate_id;
  const record = reviewedCandidateRecord(decision);
  const scopes = defaultScope(decision, candidate);
  const row = {
    source_candidate_id: id, candidate_record_id: id, candidate_record_sha256: sha256Json(record), decision: decision.disposition,
    decision_rationale: `${id}: the lemma, POS and glosses form one coherent writer-facing unit.`, gloss_judgment: 'fit',
    sense_reviews: record.senses.map((sense) => ({
      sense_id: sense.id, boundary_action: 'retain', boundary_classification: 'atomic', boundary_decision: 'atomic',
      boundary_rationale: `${id} ${sense.id}: bounded single meaning.`, semantic_rationale: `${id} ${sense.id}: denotes ${sense.gloss}`,
      relation_decision: 'no-relations', relation_count: 0, relation_ids: [], no_relation_rationale: `${id} ${sense.id}: no authored relation tuple.`,
      scope_declaration: scopes[record.senses.indexOf(sense)],
    })),
    boundary_pairs: inspectSenseBoundaryPairs(record).map((pair) => {
      const left = record.senses.find(({ id: senseId }) => senseId === pair.left_sense_id);
      const right = record.senses.find(({ id: senseId }) => senseId === pair.right_sense_id);
      return {
        ...pair,
        decision: 'retain',
        left_gloss_sha256: sha256Json(left.gloss),
        right_gloss_sha256: sha256Json(right.gloss),
        evidence_basis: `${id}: source-bound comparison of both authored senses.`,
        distinguishing_feature: `${id}: the reviewed glosses distinguish these senses.`,
        rationale: `${id}: retain the mechanically classified ${pair.relationship} pair.`,
      };
    }),
  };
  row.review_binding = authorSemanticReviewBinding(row, record);
  return row;
}
const semantic = (decisions, count, rows) => ({
  schema_version: '1', contract_version: 'lexical-semantic-decision-source-v4', kind: 'separately-authored-semantic-decision-source',
  batch_id: 'C000002', authoring_mode: 'agent-authored-decision', provenance: { human_reviewed: false },
  review: { status: 'complete', reviewer: 'claude-agent', reviewed_candidate_count: count },
  decisions: decisions.filter((row) => ['included', 'corrected'].includes(row.disposition)).map((decision) => semanticRow(decision, rows.find((row) => row.candidate_id === decision.source_candidate_id))),
});
async function artifactsFor(rows, decisions) {
  const handoff = await buildProductionHandoff({
    batchId: 'C000002', rawCandidates: intakeCandidates(candidateViews(rows)).map(toRawCandidate), analyzer: lemmaAnalyzer, adapterId: 'corpus-adapter',
  });
  return {
    batchId: 'C000002', adapterId: 'corpus-adapter', candidates: rows, decisions,
    semanticDecisionsText: JSON.stringify(semantic(decisions, rows.length, rows)), handoffText: JSON.stringify(handoff),
  };
}

test('review artifacts bind a lemma candidate: one semantic decision per candidate, multiple senses, hand-off entries per POS', async () => {
  const { rows, goDecision, pangDecision } = await lemmaFixture();
  const decisions = [goDecision(), pangDecision()];
  const good = await artifactsFor(rows, decisions);
  assert.deepEqual(validateReviewArtifacts(good), []);
  const has = (input, fragment) => assert.ok(validateReviewArtifacts(input).some((e) => e.includes(fragment)), `${fragment}: ${validateReviewArtifacts(input).join(' | ')}`);
  has({ ...good, decisions: [goDecision({ reviewed_record: { lemma: '다른말', senses: goDecision().reviewed_record.senses } }), pangDecision()] }, 'differs from the candidate input');
  const handoff = JSON.parse(good.handoffText);
  handoff.entries = handoff.entries.filter((entry) => !entry.key.startsWith('가다'));
  has({ ...good, handoffText: JSON.stringify(handoff) }, 'intake-handoff.json');
});

// A gloss may only describe the observations its included groups claim: the author states the scope and
// the shared contract binds it to the usage-group decisions (admitted gloss vs deferred meaning).
test('a gloss cannot widen to a deferred observation: scope declaration is source-bound and checked', async () => {
  const { rows, go, goDecision, pangDecision } = await lemmaFixture();
  const reason = '시간의 흐름을 가리키는 용법은 별도 판단이 필요해 보류한다.';
  const scoped = (gloss) => goDecision({
    reviewed_record: { lemma: '가다', senses: [{ pos: 'verb', gloss }] },
    group_decisions: [
      { group_id: go.usage_groups[0].group_id, disposition: 'included', reason: '이동의 방향이 분명하다.', sense_indexes: [0] },
      { group_id: go.usage_groups[1].group_id, disposition: 'deferred', reason },
    ],
  });
  const withScope = async (decision, mutate = () => {}) => {
    const decisions = [decision, pangDecision()];
    const base = await artifactsFor(rows, decisions);
    const source = JSON.parse(base.semanticDecisionsText);
    for (const row of source.decisions) {
      const owner = decisions.find((d) => d.source_candidate_id === row.source_candidate_id);
      const candidate = rows.find((r) => r.candidate_id === row.source_candidate_id);
      row.sense_reviews.forEach((review, index) => {
        const { admitted, excluded } = expectedScopes(owner, candidate)[index];
        review.scope_declaration = { admitted_observation_ids: admitted, excluded_observation_ids: excluded, excluded_terms: excluded.length ? ['시간'] : [] };
        mutate(row, review, index);
      });
      row.review_binding = authorSemanticReviewBinding(row, reviewedCandidateRecord(owner));
    }
    return { ...base, decisions, semanticDecisionsText: JSON.stringify(source), requireScopeDeclaration: true };
  };
  const errorsOf = (input) => validateReviewArtifacts(input);
  const has = (input, fragment) => assert.ok(errorsOf(input).some((e) => e.includes(fragment)), `${fragment}: ${errorsOf(input).join(' | ')}`);

  // The gloss stays inside the included observations: accepted.
  assert.deepEqual(errorsOf(await withScope(scoped('다른 곳으로 옮겨 가다.'))), []);
  // The same row widened to the deferred meaning is refused, and the declaration cannot hide it.
  has(await withScope(scoped('다른 곳으로 옮겨 가거나 시간이 지나가다.')), 'the gloss contains the excluded term 시간');
  // The term must be source-bound to the reason that judges the excluded observation.
  has(await withScope(scoped('다른 곳으로 옮겨 가다.'), (row, review) => { review.scope_declaration.excluded_terms = ['전혀없는말']; }), 'does not occur in the reason that judges an excluded observation');
  has(await withScope(scoped('다른 곳으로 옮겨 가다.'), (row, review) => { review.scope_declaration.excluded_terms = []; }), 'require excluded_terms');
  // The declared scope must be exactly what the group decisions admit.
  const claimed = go.observations.filter((o) => o.group_id === go.usage_groups[0].group_id).map((o) => o.observation_id);
  const leaked = go.observations.find((o) => o.group_id === go.usage_groups[1].group_id).observation_id;
  has(await withScope(scoped('다른 곳으로 옮겨 가다.'), (row, review) => { review.scope_declaration.admitted_observation_ids = [...claimed, leaked].sort(); review.scope_declaration.excluded_observation_ids = []; }), 'admitted_observation_ids must be exactly');
  // A pending review must carry the declaration; the field is optional only for already admitted reviews.
  const missing = await withScope(scoped('다른 곳으로 옮겨 가다.'));
  const stripped = JSON.parse(missing.semanticDecisionsText);
  stripped.decisions.forEach((row) => { row.sense_reviews.forEach((review) => { delete review.scope_declaration; }); row.review_binding = authorSemanticReviewBinding(row, reviewedCandidateRecord(missing.decisions.find((d) => d.source_candidate_id === row.source_candidate_id))); });
  has({ ...missing, semanticDecisionsText: JSON.stringify(stripped) }, 'scope_declaration is required');
  assert.deepEqual(errorsOf({ ...missing, semanticDecisionsText: JSON.stringify(stripped), requireScopeDeclaration: false }), []);
  // Without excluded observations the term list must stay empty.
  const pang = rows.find((row) => row.candidate_id === pangDecision().source_candidate_id);
  const full = await withScope(scoped('다른 곳으로 옮겨 가다.'), (row, review) => { if (row.source_candidate_id === pang.candidate_id) review.scope_declaration.excluded_terms = ['시간']; });
  has(full, 'excluded_terms must be empty while no observation is excluded');
});

test('a held observation requires a resolution only in the included group that contains it', async () => {
  const { rows, go, goDecision, pangDecision } = await lemmaFixture();
  const held = clone(rows);
  held[0].observations[1].holds = ['analysis_ambiguous']; // only the second (pass) group's observation
  const groups = goDecision().group_decisions;
  const decisionsFor = (groupDecisions) => [goDecision({ group_decisions: groupDecisions }), pangDecision()];
  const run = (groupDecisions) => validateLemmaDecision(decisionsFor(groupDecisions)[0], held[0], { canonicalIndex: INDEX });
  assert.ok(run(groups).some((e) => e.includes(`${go.usage_groups[1].group_id}: held observations require a hold_resolution`)));
  assert.ok(!run(groups).some((e) => e.includes(go.usage_groups[0].group_id)), 'the clear sibling group is not contaminated');
  assert.deepEqual(run([groups[0], { ...groups[1], hold_resolution: 'C000002-0001.o02 re-read: the reading is unambiguous in context.' }]), []);
  held[0].observations[1].holds = ['analysis_error'].filter(() => false).concat(['no_evidence']);
  assert.ok(validateLemmaDecision(decisionsFor(groups)[0], held[0], { canonicalIndex: INDEX }).some((e) => e.includes('cannot be admitted')));
  const artifacts = await artifactsFor(held.map((row, i) => (i === 0 ? { ...row, observations: row.observations.map((o, j) => (j === 1 ? { ...o, holds: ['analysis_ambiguous'] } : o)) } : row)), decisionsFor([groups[0], { ...groups[1], hold_resolution: 'resolved' }]));
  assert.deepEqual(validateReviewArtifacts(artifacts), []);
});

// ---------------------------------------------------------------------------------------------
// Registered validator on a real git history: a v2 Stage 2 transition, then an unauthorized migration.

test('registered validator accepts a lemma batch Stage 2 transition and refuses a v1 → v2 migration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-lemma-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'master');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  const write = async (name, content) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); };
  const run = () => spawnSync(process.execPath, ['scripts/factory/validate.mjs'], {
    cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root, FACTORY_BASE_REF: 'master' },
  });
  await write('data/canonical/fixture.jsonl', jsonl(ENTRIES));
  const old = v1Batch();
  await write('data/candidates/C000001/manifest.json', JSON.stringify(old.manifest));
  await write('data/candidates/C000001/candidates.jsonl', old.candidatesText);
  const { manifest, candidatesText, rows } = await batchOf();
  await write('data/candidates/C000002/manifest.json', JSON.stringify(manifest));
  await write('data/candidates/C000002/candidates.jsonl', candidatesText);
  git('add', '-A'); git('commit', '-qm', 'stage1');
  git('checkout', '-q', '-b', 'work');
  assert.equal(run().status, 0, run().stderr);

  // Stage 2: C000002 created → complete with a ready review whose artifacts bind the lemma candidates.
  const { goDecision, pangDecision } = await lemmaFixture();
  const decisions = [goDecision(), pangDecision()];
  const artifacts = await artifactsFor(rows, decisions);
  const decisionsText = jsonl(decisions);
  await write('data/candidates/C000002/manifest.json', JSON.stringify({ ...manifest, status: 'complete' }));
  await write('data/reviews/C000002/decisions.jsonl', decisionsText);
  await write('data/reviews/C000002/semantic-decisions.json', `${artifacts.semanticDecisionsText}\n`);
  await write('data/reviews/C000002/intake-handoff.json', `${artifacts.handoffText}\n`);
  const review = {
    contract: REVIEW_MANIFEST_CONTRACT, batch_id: 'C000002', candidates_sha256: manifest.candidates_sha256, canonical_snapshot_digest: HEX,
    decisions_sha256: sha256Hex(decisionsText), semantic_decisions_sha256: sha256Hex(`${artifacts.semanticDecisionsText}\n`),
    handoff_sha256: sha256Hex(`${artifacts.handoffText}\n`), attempt: 1, status: 'ready', history: [],
  };
  await write('data/reviews/C000002/manifest.json', JSON.stringify(review));
  const staged = run();
  assert.equal(staged.status, 0, staged.stderr);

  // A decision that leaves a usage group unaccounted for fails the registered gate.
  const broken = jsonl([{ ...decisions[0], group_decisions: decisions[0].group_decisions.slice(0, 1) }, decisions[1]]);
  await write('data/reviews/C000002/decisions.jsonl', broken);
  await write('data/reviews/C000002/manifest.json', JSON.stringify({ ...review, decisions_sha256: sha256Hex(broken) }));
  const failed = run();
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /entries for every usage group/);
  await write('data/reviews/C000002/decisions.jsonl', decisionsText);
  await write('data/reviews/C000002/manifest.json', JSON.stringify(review));
  assert.equal(run().status, 0, run().stderr);

  // Rewriting the merged v1 batch as v2 is an unauthorized migration.
  const migrated = await batchOf(EVIDENCE, 'C000001');
  await write('data/candidates/C000001/manifest.json', JSON.stringify(migrated.manifest));
  await write('data/candidates/C000001/candidates.jsonl', migrated.candidatesText);
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /contract migration/);
});

// The real extractor's safe-evidence path carries no `usage_group`: two sense opportunities of one
// lemma/POS arrive as ONE pos-default group, and Stage 2 must still adjudicate them separately.
test('real safe-evidence output: two sense opportunities in one group get independent dispositions', async () => {
  const rawHit = (paragraph, surface) => ({
    source_path: 'source.json', corpus_id: 'corpus-1', document_id: 'document-1', document_ordinal: 1, paragraph_id: paragraph,
    paragraph_ordinal: 1, source_category: 'literature', source_year: '2025', matched_surface_form: surface, context: 'RAW CORPUS CONTENT',
  });
  const inventory = {
    ...evidenceDoc([]), orchestration: {}, analysis_cache: {}, evidence_collection: {}, selection: {}, yield: {}, typewriter_surface: {},
    candidates: [{
      proposed_lemma: '가다', proposed_pos: 'verb', coverage_status: 'uncovered', ambiguity_status: 'clear',
      observed_surface_forms: [{ surface: '가는' }, { surface: '가서' }], observed_morpheme_spans: [], typewriter_surface_matches: [],
      evidence: { representative_hits: [rawHit('p1', '가는'), rawHit('p2', '가서')] },
    }],
  };
  const safe = buildTextFreeCandidateEvidence(inventory);
  assert.ok(!JSON.stringify(safe).includes('RAW CORPUS CONTENT'));
  const { rows, manifest, candidatesText } = await batchOf(safe);
  assert.deepEqual(validateCandidateBatch({ manifest, candidatesText }), []);
  const [go] = rows;
  assert.equal(go.usage_groups.length, 1, 'the extractor gives Stage 1 no sense signal');
  assert.deepEqual(go.observations.map((o) => o.observation_id), ['C000002-0001.o01', 'C000002-0001.o02']);

  const [g1] = go.usage_groups;
  const decision = (groupDecisions, over = {}) => ({
    source_candidate_id: go.candidate_id, disposition: 'included', target: { kind: 'new_sense_on_existing_entry', entry_id: 'w3', context_sense_id: 'w3-s1' },
    reviewed_record: { lemma: '가다', senses: [{ pos: 'verb', gloss: '다른 곳으로 옮겨 가다.' }] }, group_decisions: groupDecisions, ...over,
  });
  const split = [
    { group_id: g1.group_id, observation_ids: ['C000002-0001.o01'], disposition: 'included', reason: '이동의 뜻이 분명하다.', sense_indexes: [0] },
    { group_id: g1.group_id, observation_ids: ['C000002-0001.o02'], disposition: 'rejected', reason: '이 근거는 관용적 쓰임이라 별도 뜻으로 두지 않는다.' },
  ];
  assert.deepEqual(validateLemmaDecision(decision(split), go, { canonicalIndex: INDEX }), []);
  const has = (groupDecisions, fragment, over) => assert.ok(
    validateLemmaDecision(decision(groupDecisions, over), go, { canonicalIndex: INDEX }).some((e) => e.includes(fragment)), fragment,
  );
  has([split[0]], 'not judged by any entry');
  has([split[0], { ...split[1], observation_ids: ['C000002-0001.o01'] }], 'more than one entry');
  has([split[0], { ...split[1], observation_ids: ['C000002-0001.o09'] }], 'must name observations of this group');
  has([split[0], { ...split[1], observation_ids: undefined }], 'non-empty, unique observation_ids');
  has([{ ...split[0], observation_ids: undefined }, split[1]], 'non-empty, unique observation_ids');
  // Each opportunity is judged on its own evidence: only the second entry's forms need search support.
  const covered = (id, existing) => ({ group_id: g1.group_id, observation_ids: [id], disposition: 'covered', reason: '기존 뜻과 같다.', existing_entry_id: 'w3', existing_sense_id: 'w3-s1', ...existing });
  const support = buildSearchFormSupport([{ record_id: 'w3', sense_id: 'w3-s1', form: '가는', rule_id: 'r' }]);
  const rejected = { source_candidate_id: go.candidate_id, disposition: 'rejected', reason: '기존 항목이 포괄한다.' };
  assert.ok(validateLemmaDecision({ ...rejected, group_decisions: [covered('C000002-0001.o01'), covered('C000002-0001.o02')] }, go, { canonicalIndex: INDEX, support })
    .some((e) => e.includes('forms 가서 are not supported')));
  assert.deepEqual(validateLemmaDecision({ ...rejected, group_decisions: [covered('C000002-0001.o01'), { ...covered('C000002-0001.o02'), disposition: 'search_coverage', forms: ['가서'] }] }, go, { canonicalIndex: INDEX, support }), []);

  const artifacts = await artifactsFor(rows, [decision(split)]);
  assert.deepEqual(validateReviewArtifacts({ ...artifacts, candidates: rows.slice(0, 1) }).filter((e) => !e.includes('semantic-decisions')), []);
});

test('tracked v2 artifacts can never carry corpus phrases: surfaces and references are bounded single tokens', async () => {
  const unresolvedEvidence = evidenceDoc([cand('가다', 'verb', [hit('d1', 'p1', '가는')]), cand('낯설다', 'adjective', [hit('d2', 'p1', '낯선')])]);
  const { manifest, rows } = await batchOf(unresolvedEvidence);
  assert.deepEqual(manifest.unresolved_observations.map((entry) => entry.surface), ['낯선'], 'a valid unresolved word form passes');
  assert.deepEqual(validateCandidateBatch(restamp(manifest, rows)), []);

  const sentence = '코퍼스 원문 전체가 담긴 문장입니다';
  const forged = (mutate) => {
    const man = clone(manifest);
    const copy = clone(rows);
    mutate(man, copy);
    return restamp(man, copy);
  };
  const cases = [
    [(m) => { m.unresolved_observations[0].surface = sentence; }, 'unresolved_observations[0]: surface must be a single bounded word form'],
    [(m) => { m.unresolved_observations[0].surface = '낯선\n다음줄'; }, 'unresolved_observations[0]: surface must be a single bounded word form'],
    [(m) => { m.unresolved_observations[0].surface = '가'.repeat(25); }, 'unresolved_observations[0]: surface must be a single bounded word form'],
    [(m) => { m.unresolved_observations[0].surface = '낯\u0007선'; }, 'unresolved_observations[0]: surface must be a single bounded word form'],
    [(m) => { m.unresolved_observations[0].evidence.ref = `${sentence} 전체`; }, 'text-free evidence reference required'],
    [(m, r) => { r[0].forms[0].surface = sentence; }, 'forms[0].surface must be a single bounded word form'],
    [(m, r) => { r[0].forms[0].surface = '가'.repeat(25); }, 'forms[0].surface must be a single bounded word form'],
    [(m, r) => { r[0].observations[0].evidence.ref = `d1 ${sentence}`; }, 'evidence must be a text-free reference'],
    [(m, r) => { r[0].observations[0].evidence.ref = 'r'.repeat(201); }, 'evidence must be a text-free reference'],
  ];
  for (const [mutate, fragment] of cases) {
    const errors = validateCandidateBatch(forged(mutate));
    assert.ok(errors.some((error) => error.includes(fragment)), `${fragment}: ${errors.join(' | ')}`);
  }

  // The registered repository validator refuses the forged manifest on disk as well.
  const root = await mkdtemp(path.join(tmpdir(), 'factory-lemma-text-'));
  const directory = path.join(root, 'data/candidates/C000002');
  await mkdir(directory, { recursive: true });
  const bad = forged((m) => { m.unresolved_observations[0].surface = sentence; });
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(bad.manifest));
  await writeFile(path.join(directory, 'candidates.jsonl'), bad.candidatesText);
  assert.ok((await validateFactoryRepository({ root, canonicalEntries: [] })).some((e) => e.includes('surface must be a single bounded word form')));

  // The producer fails closed on phrase-like evidence instead of writing it.
  await assert.rejects(() => batchOf(evidenceDoc([cand('가다', 'verb', [hit('d1', 'p1', '가는 길에 만난 사람')])])), /single bounded word form/);
  await assert.rejects(() => batchOf(evidenceDoc([cand('가다', 'verb', [hit('d1 문장 전체', 'p1', '가는')])])), /opaque token/);
});

// A stale sibling can merge after its CI ran (no server-side merge gate). Merged master must stay
// valid and Stage 3 must skip the review, while the same stale content in a PR is refused.
test('a merged review authored under an older contract is tolerated on master, reported stale, and refused in a PR', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-stale-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'master');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  const write = async (name, content) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); };
  const run = () => spawnSync(process.execPath, ['scripts/factory/validate.mjs'], {
    cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root, FACTORY_BASE_REF: 'master' },
  });
  await write('data/canonical/fixture.jsonl', jsonl(ENTRIES));
  const old = v1Batch();
  await write('data/candidates/C000001/manifest.json', JSON.stringify(old.manifest));
  await write('data/candidates/C000001/candidates.jsonl', old.candidatesText);
  const { manifest, candidatesText, rows } = await batchOf();
  await write('data/candidates/C000002/manifest.json', JSON.stringify(manifest));
  await write('data/candidates/C000002/candidates.jsonl', candidatesText);
  git('add', '-A'); git('commit', '-qm', 'stage1');

  const { goDecision, pangDecision } = await lemmaFixture();
  const decisions = [goDecision(), pangDecision()];
  const artifacts = await artifactsFor(rows, decisions);
  const decisionsText = jsonl(decisions);
  const stripped = JSON.parse(artifacts.semanticDecisionsText);
  stripped.decisions.forEach((row) => {
    row.sense_reviews.forEach((review) => { delete review.scope_declaration; });
    row.review_binding = authorSemanticReviewBinding(row, reviewedCandidateRecord(decisions.find((d) => d.source_candidate_id === row.source_candidate_id)));
  });
  const stage2 = async (semanticText, extra = {}) => {
    const text = `${semanticText}\n`;
    await write('data/candidates/C000002/manifest.json', JSON.stringify({ ...manifest, status: 'complete' }));
    await write('data/reviews/C000002/decisions.jsonl', decisionsText);
    await write('data/reviews/C000002/semantic-decisions.json', text);
    await write('data/reviews/C000002/intake-handoff.json', `${artifacts.handoffText}\n`);
    await write('data/reviews/C000002/manifest.json', JSON.stringify({
      contract: REVIEW_MANIFEST_CONTRACT, batch_id: 'C000002', candidates_sha256: manifest.candidates_sha256, canonical_snapshot_digest: HEX,
      decisions_sha256: sha256Hex(decisionsText), semantic_decisions_sha256: sha256Hex(text),
      handoff_sha256: sha256Hex(`${artifacts.handoffText}\n`), attempt: 1, status: 'ready', history: [], ...extra,
    }));
  };

  // In a PR the stale result is refused (new against the base).
  git('checkout', '-q', '-b', 'pr');
  await stage2(JSON.stringify(stripped));
  const refused = run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /scope_declaration is required/);

  // Once it is on master (merged after its CI ran), master stays valid and the batch is reported stale.
  git('add', '-A'); git('commit', '-qm', 'stale sibling result');
  git('checkout', '-q', 'master'); git('merge', '-q', '--ff-only', 'pr');
  assert.equal(run().status, 0, run().stderr);
  const report = {};
  assert.deepEqual(await validateFactoryRepository({ root, mergedMaster: true, report }), []);
  assert.deepEqual(report.staleContractReviews.map((entry) => entry.batch), ['C000002']);
  assert.match(report.staleContractReviews[0].errors[0], /scope_declaration is required/);

  // A changed review is strict again; the contract repair that adds the declaration is accepted.
  git('checkout', '-q', '-b', 'repair');
  const repairedText = `${artifacts.semanticDecisionsText}\n`;
  await stage2(artifacts.semanticDecisionsText, {
    semantic_decisions_sha256: sha256Hex(repairedText),
    contract_repairs: [{ contract: 'scope_declaration', previous_semantic_decisions_sha256: sha256Hex(`${JSON.stringify(stripped)}\n`), semantic_decisions_sha256: sha256Hex(repairedText) }],
  });
  const repaired = run();
  assert.equal(repaired.status, 0, repaired.stderr);
});
