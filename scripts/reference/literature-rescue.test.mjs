import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { buildCanonicalIndex } from '../factory/identity-adapter.mjs';
import { validateLemmaDecision } from '../factory/lemma-decisions.mjs';
import {
  RESCUE_BOUNDS, isRescueEligible, runBoundedLiteratureLookup, summarizeLiteratureRescue, validateLiteratureLookup,
} from '../factory/literature-rescue.mjs';
import { resolveTypewriterCachePaths } from '../typewriter-cache.mjs';
import { assertLiteratureFts5Support, createLiteratureSchema } from './literature-index.mjs';

assertLiteratureFts5Support();
const directories = [];
after(async () => { await Promise.all(directories.map((d) => rm(d, { recursive: true, force: true }))); });
const temp = async () => { const d = await mkdtemp(path.join(tmpdir(), 'typewriter-rescue-')); directories.push(d); return d; };
const sha = (v) => createHash('sha256').update(v).digest('hex');

async function makeDatabase(lines) {
  const databasePath = path.join(await temp(), 'synthetic.sqlite');
  const database = new DatabaseSync(databasePath);
  createLiteratureSchema(database);
  lines.forEach((text, index) => {
    const id = index + 1;
    database.prepare('INSERT INTO source_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, 'novel', `novel/${id}_x.txt`, sha('f' + id), 10, 'utf-8', 0, 'lf', 1, 1, 10, 1, 'ok', '[]');
    database.prepare('INSERT INTO works VALUES (?,?,?,?,?,?,?,?)').run(id, 'novel', id, null, 'T' + id, null, 'filename (unverified)', 0);
    database.prepare('INSERT INTO text_units (file_id, ordinal, kind, block_ordinal, text, eol) VALUES (?,?,?,?,?,?)').run(id, 0, 'text', 1, text, '\n');
  });
  database.exec("INSERT INTO unit_fts(unit_fts) VALUES ('rebuild')");
  for (const [k, v] of Object.entries({ schema_version: '1', builder_version: '1', input_manifest_sha256: 'm'.repeat(64), logical_rows_sha256: 'l'.repeat(64), file_count: String(lines.length), unit_count: '0' })) {
    database.prepare('INSERT INTO index_metadata VALUES (?, ?)').run(k, v);
  }
  database.close();
  return databasePath;
}

const row = (holds = ['analysis_ambiguous'], input = '푸르다') => ({
  candidate_id: 'C000001-0001', input, pos_hypotheses: ['adjective'],
  forms: [{ form_id: 'f1', surface: '푸른' }], usage_groups: [{ group_id: 'g1', pos: 'adjective' }],
  observations: [{ observation_id: 'o1', form_id: 'f1', group_id: 'g1', pos: 'adjective', holds }],
});
async function candidateRoot(candidate) {
  const root = await temp();
  const directory = path.join(root, 'data/candidates/C000001');
  await mkdir(directory, { recursive: true });
  const text = JSON.stringify(candidate) + '\n';
  await writeFile(path.join(directory, 'candidates.jsonl'), text);
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ candidates_sha256: sha(text) }));
  return root;
}
const context = (root) => ({ root, canonicalIndex: buildCanonicalIndex([]), support: new Map() });
const run = async (candidate, options) => {
  const root = await candidateRoot(candidate);
  const outputDirectory = path.join(resolveTypewriterCachePaths().evidence, 'rescue-test-' + sha(root).slice(0, 12));
  directories.push(outputDirectory);
  return runBoundedLiteratureLookup({ batchId: 'C000001', candidateId: 'C000001-0001', reasonClass: 'insufficient_context_evidence', root, context: context(root), outputDirectory, ...options });
};

test('trigger: only evidence insufficiency without a hard hold; other paths are untouched', async () => {
  assert.equal(isRescueEligible(row(), 'insufficient_context_evidence'), true);
  assert.equal(isRescueEligible(row([]), 'insufficient_context_evidence'), true);
  assert.equal(isRescueEligible(row(['proper_noun']), 'insufficient_context_evidence'), false, 'hard hold');
  assert.equal(isRescueEligible(row(), 'figurative_use'), false);
  assert.equal(isRescueEligible(row(), undefined), false);
  const result = await run(row(), { reasonClass: 'invalid_candidate', databasePath: '/nonexistent.sqlite' });
  assert.deepEqual(result, { eligible: false, record: null, files: null });
});

test('useful hit: bounded, text-free record; the author alone decides informed/changed', async () => {
  const databasePath = await makeDatabase(['하늘이 푸른 날이었다.', '푸른 바다가 보였다.']);
  const { eligible, record, files } = await run(row(), { databasePath });
  assert.equal(eligible, true);
  assert.equal(record.status, 'attempted');
  assert.equal(record.location_digests.length, 2);
  assert.ok(record.location_digests.length <= RESCUE_BOUNDS.max_contexts);
  assert.equal(record.informed, false);
  assert.equal(record.deferral_changed_to_included, false);
  assert.ok(files.pack);
  assert.doesNotMatch(JSON.stringify(record), /하늘|바다/u, 'no literary text in the record');
  assert.deepEqual(validateLiteratureLookup({ source_candidate_id: 'x', disposition: 'deferred', literature_lookup: record }), []);
});

test('no hit and an unreadable DB are not evidence and force nothing', async () => {
  const none = await run(row(), { databasePath: await makeDatabase(['전혀 상관없는 문장.']) });
  assert.equal(none.record.status, 'attempted');
  assert.deepEqual(none.record.location_digests, []);
  const missing = await run(row(), { databasePath: path.join(await temp(), 'missing.sqlite') });
  assert.equal(missing.record.status, 'unavailable');
  assert.ok(['database_unavailable', 'lookup_error'].includes(missing.record.reason_code));
  assert.equal(missing.record.informed, false);
  assert.equal(missing.files, null);
});

test('a candidate without usable search forms is skipped', async () => {
  const short = { ...row(), input: '가', forms: [{ form_id: 'f1', surface: '가' }] };
  const result = await run(short, { databasePath: await makeDatabase(['가']) });
  assert.equal(result.record.status, 'skipped');
  assert.equal(result.record.reason_code, 'no_usable_search_forms');
});

const attempted = (extra = {}) => ({
  contract: 'literature-rescue-lookup-v1', trigger: 'insufficient_context_evidence', status: 'attempted', reason_code: null, ...RESCUE_BOUNDS,
  location_digests: ['a'.repeat(64)], context_digests: ['b'.repeat(64)], lookup_ms: 3, informed: true, deferral_changed_to_included: true, ...extra,
});
const decision = (record, disposition = 'included') => ({
  source_candidate_id: 'C000001-0001', disposition, literature_lookup: record,
  group_decisions: [{ group_id: 'g1', disposition: disposition === 'included' ? 'included' : 'deferred' }],
});

test('review record validation: closed, text-free, internally consistent', () => {
  const bad = (record, pattern, d = 'included') => assert.match(validateLiteratureLookup(decision(record, d)).join('\n'), pattern);
  assert.deepEqual(validateLiteratureLookup(decision(attempted())), []);
  assert.deepEqual(validateLiteratureLookup({ source_candidate_id: 'x' }), [], 'historical rows carry none');
  bad({ ...attempted(), quote: '원문' }, /exactly/u);
  bad(attempted({ max_contexts: 8 }), /max_contexts must be 5/u);
  bad(attempted({ match_mode: 'eojeol' }), /match_mode/u);
  bad(attempted({ location_digests: ['원문 인용'] }), /sha256/u);
  bad(attempted({ location_digests: Array(6).fill('a'.repeat(64)), context_digests: Array(6).fill('b'.repeat(64)) }), /at most 5/u);
  bad(attempted({ status: 'unavailable', reason_code: 'database_unavailable', location_digests: [], context_digests: [] }), /informed requires/u);
  bad(attempted({ informed: false }), /without informing evidence/u);
  bad(attempted({ location_digests: [], context_digests: [] }), /informed requires/u);
  bad(attempted(), /requires an admitted candidate/u, 'deferred');
  bad(attempted({ informed: false, deferral_changed_to_included: false, status: 'skipped', reason_code: 'database_unavailable' }), /skipped needs/u);
});

test('production validator rejects an inconsistent lookup record on a real lemma decision', () => {
  const candidate = { candidate_id: 'C000001-0001', input: '푸르다', usage_groups: [{ group_id: 'g1', pos: 'adjective' }], forms: [{ form_id: 'f1', surface: '푸른' }], observations: [{ observation_id: 'o1', form_id: 'f1', group_id: 'g1', pos: 'adjective', holds: [] }] };
  const deferred = { source_candidate_id: 'C000001-0001', disposition: 'deferred', reason: '맥락 부족', group_decisions: [{ group_id: 'g1', disposition: 'deferred', reason: '맥락 부족' }] };
  const none = attempted({ location_digests: [], context_digests: [], informed: false, deferral_changed_to_included: false });
  assert.deepEqual(validateLemmaDecision({ ...deferred, literature_lookup: none }, candidate), []);
  assert.match(validateLemmaDecision({ ...deferred, literature_lookup: attempted() }, candidate).join('\n'), /literature_lookup/u);
  assert.deepEqual(validateLemmaDecision(deferred, candidate), []);
});

test('production report counts lookups, rescues and confirms them only after Stage 3', () => {
  const changed = { source_candidate_id: 'a', literature_lookup: attempted() };
  const noHit = { source_candidate_id: 'b', literature_lookup: attempted({ location_digests: [], context_digests: [], informed: false, deferral_changed_to_included: false }) };
  const down = { source_candidate_id: 'c', literature_lookup: attempted({ status: 'unavailable', reason_code: 'lookup_error', location_digests: [], context_digests: [], lookup_ms: null, informed: false, deferral_changed_to_included: false }) };
  const report = summarizeLiteratureRescue([
    { batchId: 'C1', status: 'ready', decisions: [changed, noHit, down, { source_candidate_id: 'd' }] },
    { batchId: 'C2', status: 'complete', decisions: [changed] },
    { batchId: 'C3', status: 'complete', decisions: [{ source_candidate_id: 'e' }] },
  ]);
  assert.deepEqual(report.map((r) => r.batch_id), ['C1', 'C2']);
  assert.deepEqual([report[0].lookups_attempted, report[0].lookups_unavailable, report[0].changed_to_included, report[0].stage3_admitted, report[0].stage3_pending, report[0].lookup_ms_total], [2, 1, 1, null, 1, 6]);
  assert.deepEqual([report[1].stage3_admitted, report[1].stage3_pending], [1, 0]);
});
