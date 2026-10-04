import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { analysisInputDigest } from '../scripts/intake/pipeline.mjs';
import {
  CANDIDATE_MANIFEST_CONTRACT,
  REVIEW_MANIFEST_CONTRACT,
  manifestContentDigest,
  sha256Hex,
  validateCandidateBatch,
  validateDecisionRows,
  validateReviewManifest,
} from '../scripts/factory/contract.mjs';
import { partitionByWriterSupport, validateDecisionRow } from '../scripts/factory/handoff.mjs';
import { buildCanonicalIndex, classifyAgainstCanonical, runFactoryIntake } from '../scripts/factory/identity-adapter.mjs';
import { validateCandidateTransition, validateLinkedTransition, validateReviewTransition } from '../scripts/factory/transitions.mjs';
import { validateFactoryRepository } from '../scripts/factory/validate.mjs';
import { validateReviewArtifacts } from '../scripts/factory/artifacts.mjs';
import { toRawCandidate } from '../scripts/factory/identity-adapter.mjs';
import { reviewedCandidateRecord } from '../scripts/factory/artifacts.mjs';
import { sha256Json } from '../scripts/validate/semantic-audit.mjs';
import { authorSemanticReviewBinding } from '../scripts/validate/semantic-decision-row.mjs';
import { buildProductionHandoff } from '../scripts/intake/production-handoff.mjs';

const HEX = (seed) => sha256Hex(seed);
const record = (n, over = {}) => ({
  candidate_id: `C000001-${String(n).padStart(4, '0')}`,
  input: '짠하다',
  pos: 'adjective',
  usage_hint: `provisional usage ${n}`,
  observedForms: ['짠한'],
  evidence: [{ kind: 'corpus-paragraph', ref: `doc-${n}` }],
  holds: [],
  ...over,
});
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
const candidateBatch = (rows = [record(1), record(2)], over = {}) => {
  const candidatesText = jsonl(rows);
  return {
    candidatesText,
    manifest: {
      contract: CANDIDATE_MANIFEST_CONTRACT, task_id: 'T000001', batch_id: 'C000001', candidate_count: rows.length,
      source_adapter: 'corpus-adapter', source_snapshot: 'snap-1', canonical_snapshot_digest: HEX('canon'),
      extractor_version: 'x1', analyzer_version: 'kiwipiepy==0.24.0', candidates_sha256: sha256Hex(candidatesText),
      status: 'created', ...over,
    },
  };
};
const reviewManifest = (over = {}) => ({
  contract: REVIEW_MANIFEST_CONTRACT, batch_id: 'C000001', candidates_sha256: candidateBatch().manifest.candidates_sha256,
  canonical_snapshot_digest: HEX('canon'), decisions_sha256: HEX('d1'), semantic_decisions_sha256: HEX('s'),
  handoff_sha256: HEX('h'), attempt: 1, status: 'ready', history: [], ...over,
});

test('valid candidate batch passes and per-usage ids stay distinct for one lemma and POS', () => {
  const { manifest, candidatesText } = candidateBatch();
  assert.deepEqual(validateCandidateBatch({ manifest, candidatesText }), []);
});

test('candidate batch fails closed on tamper, count, id, evidence-text and hold defects', () => {
  const good = candidateBatch();
  const fails = (batch, fragment) => assert.ok(validateCandidateBatch(batch).some((e) => e.includes(fragment)), fragment);
  fails({ manifest: good.manifest, candidatesText: `${good.candidatesText} ` }, 'candidates_sha256');
  fails(candidateBatch([record(1), record(2)], { candidate_count: 3 }), 'candidate_count');
  fails(candidateBatch([record(1), record(1)]), 'candidate_id must be C000001-0002');
  fails(candidateBatch([record(1, { evidence: [{ kind: 'k', ref: 'r', text: 'raw paragraph' }] })]), 'text-free');
  fails(candidateBatch([record(1, { holds: ['made_up'] })]), 'known hold');
  fails(candidateBatch([record(1, { pos: 'particle' })]), 'pos must');
  fails(candidateBatch([record(1, { evidence: Array.from({ length: 6 }, (_, i) => ({ kind: 'k', ref: `r${i}` })) })]), 'at most 5');
  fails(candidateBatch([record(1)], { analyzer_version: 'kiwipiepy==0.25.0-dev' }), 'pinned');
  const { status, ...incomplete } = good.manifest;
  fails({ manifest: incomplete, candidatesText: good.candidatesText }, 'missing status');
});

test('review manifest requires bindings, rejected_pr and consistent history', () => {
  const candidate = candidateBatch().manifest;
  const texts = { decisionsText: 'd', semanticDecisionsText: 's', handoffText: 'h' };
  const manifest = reviewManifest({ decisions_sha256: sha256Hex('d'), semantic_decisions_sha256: sha256Hex('s'), handoff_sha256: sha256Hex('h') });
  assert.deepEqual(validateReviewManifest(manifest, { candidateManifest: candidate, ...texts }), []);
  assert.ok(validateReviewManifest({ ...manifest, decisions_sha256: HEX('x') }, { candidateManifest: candidate, ...texts }).some((e) => e.includes('decisions.jsonl bytes')));
  assert.ok(validateReviewManifest({ ...manifest, status: 'rejected' }, { candidateManifest: candidate, ...texts }).some((e) => e.includes('rejected_pr')));
  assert.ok(validateReviewManifest({ ...manifest, rejected_pr: 4 }, { candidateManifest: candidate, ...texts }).some((e) => e.includes('only valid while')));
  assert.ok(validateReviewManifest({ ...manifest, candidates_sha256: HEX('z') }, { candidateManifest: candidate, ...texts }).some((e) => e.includes('differs from candidate')));
});

test('decision rows must cover every candidate exactly once in order', () => {
  const ids = ['C000001-0001', 'C000001-0002'];
  assert.deepEqual(validateDecisionRows([{ source_candidate_id: ids[0] }, { source_candidate_id: ids[1] }], ids), []);
  assert.ok(validateDecisionRows([{ source_candidate_id: ids[0] }], ids).some((e) => e.includes('missing decision row')));
  assert.ok(validateDecisionRows([{ source_candidate_id: ids[0] }, { source_candidate_id: ids[0] }], ids).some((e) => e.includes('duplicate')));
});

test('status-only change never alters the manifest content digest', () => {
  const ready = reviewManifest();
  assert.equal(manifestContentDigest(ready), manifestContentDigest({ ...ready, status: 'rejected', rejected_pr: 9, attempt: 2, history: [{ attempt: 1, rejected_pr: 9 }] }));
  assert.notEqual(manifestContentDigest(ready), manifestContentDigest({ ...ready, decisions_sha256: HEX('other') }));
});

test('legal candidate and review transitions pass; unsupported ones fail', () => {
  const created = candidateBatch().manifest;
  const complete = { ...created, status: 'complete' };
  const ready = reviewManifest();
  const done = { ...ready, status: 'complete' };
  const rejected = { ...ready, status: 'rejected', rejected_pr: 17, history: [{ attempt: 1, rejected_pr: 17 }] };
  const rework = { ...ready, attempt: 2, decisions_sha256: HEX('d2'), history: rejected.history };

  assert.deepEqual(validateLinkedTransition({ candidateBefore: created, candidateAfter: complete, reviewAfter: ready }), []);
  assert.deepEqual(validateLinkedTransition({ candidateBefore: complete, candidateAfter: complete, reviewBefore: ready, reviewAfter: done }), []);
  assert.deepEqual(validateLinkedTransition({ candidateBefore: complete, candidateAfter: complete, reviewBefore: ready, reviewAfter: rejected }), []);
  assert.deepEqual(validateLinkedTransition({ candidateBefore: complete, candidateAfter: complete, reviewBefore: rejected, reviewAfter: rework }), []);

  const has = (errors, fragment) => assert.ok(errors.some((e) => e.includes(fragment)), `${fragment}: ${errors}`);
  has(validateLinkedTransition({ candidateBefore: created, candidateAfter: created, reviewAfter: ready }), 'created → complete');
  has(validateLinkedTransition({ candidateBefore: created, candidateAfter: complete, reviewAfter: { ...ready, status: 'complete' } }), 'must start as ready');
  has(validateLinkedTransition({ candidateBefore: created, candidateAfter: complete, reviewBefore: ready, reviewAfter: ready }), 'illegal review transition ready → ready');
  has(validateReviewTransition(done, rejected), 'illegal review transition complete → rejected');
  has(validateReviewTransition(ready, { ...rejected, rejected_pr: undefined }), 'rejected_pr');
  has(validateReviewTransition(rejected, { ...rework, attempt: 3 }), 'advance attempt by exactly one');
  has(validateReviewTransition(rejected, { ...rework, history: [{ attempt: 1, rejected_pr: 99 }] }), 'history may not be rewritten');
  has(validateReviewTransition(rejected, { ...rework, decisions_sha256: rejected.decisions_sha256 }), 'new decisions');
  has(validateReviewTransition(ready, { ...done, decisions_sha256: HEX('edited') }), 'review content');
  has(validateCandidateTransition(created, { ...created, status: 'ready' }), 'illegal candidate transition');
  // An owner-directed `held` has no verifiable authorization contract yet, so it is refused.
  has(validateCandidateTransition(created, { ...created, status: 'held' }), 'illegal candidate transition');
  has(validateCandidateTransition(complete, { ...complete, status: 'held' }), 'illegal candidate transition');
  has(validateCandidateBatch(candidateBatch([record(1)], { status: 'held' })), 'status must be one of');
  has(validateCandidateTransition(created, { ...complete, candidates_sha256: HEX('mutated') }), 'immutable');
  has(validateCandidateTransition(null, complete), 'must start as created');
  has(validateLinkedTransition({ candidateBefore: complete, candidateAfter: { ...complete, status: 'held' }, reviewBefore: ready, reviewAfter: done }), 'Stage 3 transitions must not change the candidate');
});

const ENTRIES = [
  { id: 'w1', record_type: 'entry', lemma: '짠하다', senses: [{ id: 'w1-s1', pos: 'adjective', gloss: 'g' }] },
  { id: 'w2', record_type: 'entry', lemma: '걸음', senses: [{ id: 'w2-s1', pos: 'noun', gloss: 'g' }] },
];
const INDEX = buildCanonicalIndex(ENTRIES);

test('identity adapter keeps same-lemma/POS usages separate and never drops existing lemmas as covered', async () => {
  const P = (lemma, pos) => ({ lemma, pos, form: lemma });
  const table = {
    짠하다: { status: 'ok', analyses: [[P('짠하다', 'adjective')]] },
    걷다: { status: 'ok', analyses: [[P('걷다', 'verb')]] },
    걸음: { status: 'ok', analyses: [[P('걸음', 'noun')]] },
    새말: { status: 'ok', analyses: [[P('새말', 'noun')]] },
  };
  const analyzed = [];
  const analyzer = async (requests) => {
    analyzed.push(...requests.map((r) => r.text));
    return {
      metadata: { service_version: '1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0', top_n: 3 },
      results: requests.map(({ id, text }) => ({ ...table[text], id, input_digest: analysisInputDigest(text) })),
    };
  };
  const candidates = [
    record(1), // existing lemma/POS, usage A
    record(2), // existing lemma/POS, usage B (distinct sense)
    record(3, { input: '걷다', pos: 'verb' }),
    record(4, { input: '걸음', pos: 'verb', holds: ['analysis_ambiguous'] }),
    record(5, { input: '새말', pos: 'noun' }),
  ];
  const { results } = await runFactoryIntake({ candidates, analyzer, canonicalIndex: INDEX });
  assert.deepEqual(results.map((r) => r.source_candidate_id), candidates.map((c) => c.candidate_id));
  assert.deepEqual(results.map((r) => r.route), ['new_sense_on_existing_entry', 'new_sense_on_existing_entry', 'new_entry', 'new_pos_on_existing_lemma', 'new_entry']);
  assert.deepEqual(results.map((r) => r.decision), ['semantic_qa', 'semantic_qa', 'semantic_qa', 'hold', 'semantic_qa']);
  assert.deepEqual(results[3].holds, ['analysis_ambiguous']);
  assert.equal(analyzed.filter((text) => text === '짠하다').length, 1, 'analysis is shared, identities are not');
  assert.equal(classifyAgainstCanonical(record(1), INDEX).route, 'new_sense_on_existing_entry');
  await assert.rejects(runFactoryIntake({ candidates: [record(1), record(1)], analyzer, canonicalIndex: INDEX }), /distinct candidate_id/);
});

test('typed handoff validates the three target kinds against canonical and partitions by writer support', () => {
  const included = (target, reviewed) => ({ source_candidate_id: 'C000001-0001', disposition: 'included', target, reviewed_record: reviewed });
  const newEntry = included({ kind: 'new_entry' }, { lemma: '새말', senses: [{ pos: 'noun', gloss: '새로 만든 말.' }] });
  const newPos = included({ kind: 'new_pos_on_existing_lemma', entry_id: 'w2' }, { lemma: '걸음', senses: [{ pos: 'verb', gloss: '걷는 일.' }] });
  const newSense = included({ kind: 'new_sense_on_existing_entry', entry_id: 'w1', context_sense_id: 'w1-s1' }, { lemma: '짠하다', senses: [{ pos: 'adjective', gloss: '안쓰러워 마음이 아프다.' }] });
  for (const row of [newEntry, newPos, newSense]) assert.deepEqual(validateDecisionRow(row, { canonicalIndex: INDEX }), []);
  assert.deepEqual(partitionByWriterSupport([newEntry, newPos, newSense]), { writable: [newEntry], stage3Required: [newPos, newSense] });

  const has = (row, fragment) => assert.ok(validateDecisionRow(row, { canonicalIndex: INDEX }).some((e) => e.includes(fragment)), fragment);
  has(included({ kind: 'new_entry' }, { lemma: '걸음', senses: [{ pos: 'noun', gloss: 'g' }] }), 'already canonical');
  has(included({ kind: 'new_pos_on_existing_lemma', entry_id: 'w2' }, { lemma: '걸음', senses: [{ pos: 'noun', gloss: 'g' }] }), 'already exists');
  has(included({ kind: 'new_sense_on_existing_entry', entry_id: 'w1' }, { lemma: '짠하다', senses: [{ pos: 'adjective', gloss: 'g' }] }), 'context_sense_id');
  has(included({ kind: 'new_sense_on_existing_entry', entry_id: 'w9', context_sense_id: 'x' }, { lemma: '짠하다', senses: [{ pos: 'adjective', gloss: 'g' }] }), 'existing canonical entry_id');
  has({ source_candidate_id: 'C000001-0001', disposition: 'held' }, 'reason');
  has({ source_candidate_id: 'C000001-0001', disposition: 'maybe' }, 'disposition');
});

test('repository validator passes with no batches and enforces linkage on disk', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-'));
  assert.deepEqual(await validateFactoryRepository({ root, canonicalEntries: ENTRIES }), []);

  const { manifest, candidatesText } = candidateBatch();
  const directory = path.join(root, 'data/candidates/C000001');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(directory, 'candidates.jsonl'), candidatesText);
  assert.deepEqual(await validateFactoryRepository({ root, canonicalEntries: ENTRIES }), []);

  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ ...manifest, status: 'complete' }));
  assert.ok((await validateFactoryRepository({ root, canonicalEntries: ENTRIES })).some((e) => e.includes('complete without a review')));

  await writeFile(path.join(directory, 'candidates.jsonl'), `${candidatesText}\n`);
  assert.ok((await validateFactoryRepository({ root, canonicalEntries: ENTRIES })).some((e) => e.includes('candidates_sha256')));
});


const META = { service_version: '1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0', top_n: 3 };
const analyzer = async (requests) => ({
  metadata: META,
  results: requests.map(({ id, text }) => ({
    status: 'ok', id, input_digest: analysisInputDigest(text), analyses: [[{ lemma: text, pos: 'adjective', form: text }]],
  })),
});
// A full source-bound semantic row for an admitted decision (same row contract as historical batches).
function semanticRow(decision, over = {}) {
  const id = decision.source_candidate_id;
  const record = reviewedCandidateRecord(decision);
  const row = {
    source_candidate_id: id, candidate_record_id: id, candidate_record_sha256: sha256Json(record), decision: decision.disposition,
    decision_rationale: `${id}: the lemma, POS and one-sense gloss form one coherent writer-facing unit.`, gloss_judgment: 'fit',
    sense_reviews: record.senses.map((sense) => ({
      sense_id: sense.id, boundary_action: 'retain', boundary_classification: 'atomic', boundary_decision: 'atomic',
      boundary_rationale: `${id} ${sense.id}: bounded single meaning.`, semantic_rationale: `${id} ${sense.id}: denotes ${sense.gloss}`,
    })),
    ...over,
  };
  row.review_binding = authorSemanticReviewBinding(row, record);
  return row;
}
const semantic = (decisionRows, over = {}) => ({
  schema_version: '1', contract_version: 'lexical-semantic-decision-source-v4', kind: 'separately-authored-semantic-decision-source',
  batch_id: 'C000001', authoring_mode: 'agent-authored-decision', provenance: { human_reviewed: false },
  review: { status: 'complete', reviewer: 'claude-agent', reviewed_candidate_count: 2 },
  decisions: decisionRows.filter((row) => ['included', 'corrected'].includes(row.disposition)).map((row) => semanticRow(row)), ...over,
});
async function reviewFixture(decisionRows) {
  const rows = [record(1), record(2)];
  const handoff = await buildProductionHandoff({ batchId: 'C000001', rawCandidates: rows.map(toRawCandidate), analyzer, adapterId: 'corpus-adapter' });
  return {
    batchId: 'C000001', adapterId: 'corpus-adapter', candidates: rows, decisions: decisionRows,
    semanticDecisionsText: JSON.stringify(semantic(decisionRows)), handoffText: JSON.stringify(handoff),
  };
}
const included = (n) => ({ source_candidate_id: `C000001-000${n}`, disposition: 'included', target: { kind: 'new_entry' }, reviewed_record: { lemma: '짠하다', senses: [{ pos: 'adjective', gloss: 'g' }] } });
const held = (n) => ({ source_candidate_id: `C000001-000${n}`, disposition: 'held', reason: 'unclear' });

test('review artifacts are validated by content and bound to candidates, not only by digest', async () => {
  const good = await reviewFixture([included(1), held(2)]);
  assert.deepEqual(validateReviewArtifacts(good), []);
  const has = (input, fragment) => assert.ok(validateReviewArtifacts(input).some((e) => e.includes(fragment)), `${fragment}: ${validateReviewArtifacts(input)}`);
  has({ ...good, semanticDecisionsText: 's' }, 'not valid JSON');
  has({ ...good, handoffText: 'h' }, 'not valid JSON');
  has({ ...good, handoffText: '{}' }, 'unsupported contract');
  const rows = [included(1), held(2)];
  const withSemantic = (value) => ({ ...good, semanticDecisionsText: JSON.stringify(value) });
  has(withSemantic(semantic(rows, { contract_version: 'v0' })), 'unsupported semantic decision source');
  has(withSemantic(semantic(rows, { batch_id: 'C000009' })), 'different batch');
  has(withSemantic(semantic([])), 'exactly one semantic decision');
  has(withSemantic(semantic([included(1), included(2)])), 'exactly one semantic decision');
  has(withSemantic(semantic(rows, { provenance: { human_reviewed: true } })), 'honest agent authoring');
  has(withSemantic(semantic(rows, { review: { status: 'draft' } })), 'review must be complete');
  // An ID-only row, or one missing judgment fields, must fail the source-bound row contract.
  has(withSemantic(semantic(rows, { decisions: [{ source_candidate_id: 'C000001-0001' }] })), 'does not bind the reviewed record');
  const row = semanticRow(included(1));
  const tampered = (patch) => withSemantic(semantic(rows, { decisions: [{ ...row, ...patch }] }));
  has(tampered({ gloss_judgment: 'reject' }), 'gloss_judgment');
  has(tampered({ decision_rationale: '' }), 'decision_rationale');
  has(tampered({ sense_reviews: [] }), 'sense_reviews');
  has(tampered({ decision: 'corrected' }), 'contradicts the reviewed disposition');
  has(tampered({ review_binding: { ...row.review_binding, decision_evidence_sha256: '0'.repeat(64) } }), 'review binding');
  has(tampered({ sense_reviews: [{ ...row.sense_reviews[0], boundary_rationale: '' }] }), 'boundary_rationale');
  has(tampered({ candidate_record_sha256: '0'.repeat(64) }), 'does not bind the reviewed record');
  const other = JSON.parse(good.handoffText);
  other.batch_id = 'C000009';
  has({ ...good, handoffText: JSON.stringify(other) }, 'different batch');
  const heldOnly = JSON.parse(good.handoffText);
  heldOnly.entries[0] = { ...heldOnly.entries[0], decision: 'hold', holds: ['analysis_error'] };
  has({ ...good, handoffText: JSON.stringify(heldOnly) }, 'intake-handoff.json');
  has({ ...good, decisions: [{ ...included(1), reviewed_record: { lemma: '다른말', senses: [{ pos: 'adjective', gloss: 'g' }] } }, held(2)] }, 'differs from the candidate input');
});

// Real registered-command regression: the CLI compares against the merge-base with master,
// so changes to merged `created` batches, deletions and unauthorized holds fail.
async function gitFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'master');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  const write = async (name, content) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); };
  const batch = candidateBatch();
  await write('data/candidates/C000001/manifest.json', JSON.stringify(batch.manifest));
  await write('data/candidates/C000001/candidates.jsonl', batch.candidatesText);
  git('add', '-A'); git('commit', '-qm', 'stage1');
  git('checkout', '-q', '-b', 'work');
  const run = () => spawnSync(process.execPath, ['scripts/factory/validate.mjs'], {
    cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root, FACTORY_BASE_REF: 'master' },
  });
  return { root, git, write, batch, run };
}

test('registered validator fails closed on merged-batch mutation, deletion, held and unresolved base', async () => {
  const f = await gitFixture();
  assert.equal(f.run().status, 0, f.run().stderr);

  const edited = candidateBatch([record(1), record(2, { evidence: [{ kind: 'corpus-paragraph', ref: 'swapped' }] })]);
  await f.write('data/candidates/C000001/manifest.json', JSON.stringify(edited.manifest));
  await f.write('data/candidates/C000001/candidates.jsonl', edited.candidatesText);
  let result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /immutable/);

  await f.write('data/candidates/C000001/manifest.json', JSON.stringify({ ...f.batch.manifest, status: 'held' }));
  await f.write('data/candidates/C000001/candidates.jsonl', f.batch.candidatesText);
  result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /status must be one of|illegal candidate transition/);

  f.git('checkout', '-q', '--', '.');
  f.git('rm', '-rq', 'data/candidates/C000001');
  result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /deleted/);
  f.git('checkout', '-q', 'HEAD', '--', '.');

  const unresolved = spawnSync(process.execPath, ['scripts/factory/validate.mjs'], {
    cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: f.root, FACTORY_BASE_REF: 'no-such-ref' },
  });
  assert.notEqual(unresolved.status, 0);
  assert.match(unresolved.stderr, /cannot resolve factory base/);
});

test('registered validator accepts a new Stage 1 batch and a complete Stage 2 transition', async () => {
  const f = await gitFixture();
  const second = candidateBatch([record(1)], {});
  second.manifest.batch_id = 'C000002';
  const row = { ...record(1), candidate_id: 'C000002-0001' };
  const text = jsonl([row]);
  await f.write('data/candidates/C000002/manifest.json', JSON.stringify({ ...second.manifest, candidates_sha256: sha256Hex(text) }));
  await f.write('data/candidates/C000002/candidates.jsonl', text);
  assert.equal(f.run().status, 0, f.run().stderr);

  // Stage 2 for C000001: created → complete with a ready review whose artifacts are real.
  const rows = [record(1), record(2)];
  const handoff = await buildProductionHandoff({ batchId: 'C000001', rawCandidates: rows.map(toRawCandidate), analyzer, adapterId: 'corpus-adapter' });
  const decisions = jsonl([held(1), held(2)]);
  const semanticText = `${JSON.stringify(semantic([held(1), held(2)]))}\n`;
  const handoffText = `${JSON.stringify(handoff)}\n`;
  await f.write('data/candidates/C000001/manifest.json', JSON.stringify({ ...f.batch.manifest, status: 'complete' }));
  await f.write('data/reviews/C000001/decisions.jsonl', decisions);
  await f.write('data/reviews/C000001/semantic-decisions.json', semanticText);
  await f.write('data/reviews/C000001/intake-handoff.json', handoffText);
  await f.write('data/reviews/C000001/manifest.json', JSON.stringify(reviewManifest({
    decisions_sha256: sha256Hex(decisions), semantic_decisions_sha256: sha256Hex(semanticText), handoff_sha256: sha256Hex(handoffText),
  })));
  assert.equal(f.run().status, 0, f.run().stderr);

  // Review without the candidate transition is rejected by the linked gate.
  await f.write('data/candidates/C000001/manifest.json', JSON.stringify(f.batch.manifest));
  assert.notEqual(f.run().status, 0);
});
