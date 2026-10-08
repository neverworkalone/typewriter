import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';

import { assertLiteratureFts5Support, createLiteratureSchema, REPOSITORY_DIRECTORY, searchLiteratureIndex } from './literature-index.mjs';
import {
  assertLocalOutputDirectory,
  DEFAULT_MAX_CONTEXTS,
  EVIDENCE_OUTPUT_DIRECTORY,
  deriveSearchForms,
  classifyMatchSample,
  fetchSubstringUnits,
  DEFAULT_MATCH_MODE,
  expandContext,
  hasEojeolMatch,
  matchOccurrences,
  loadFactoryCandidate,
  MAX_BLOCK_UNITS,
  pilotTriggerReasons,
  renderEvidenceMarkdown,
  retrieveLiteratureEvidence,
  selectRepresentativeHits,
  writeEvidencePack,
} from './literature-evidence.mjs';
import { resolveTypewriterCachePaths } from '../typewriter-cache.mjs';

// Node 24 ships node:sqlite with FTS5; fail loudly instead of skipping if that regresses.
assertLiteratureFts5Support();

const directories = [];
after(async () => { await Promise.all(directories.map((d) => rm(d, { recursive: true, force: true }))); });
const tempDirectory = async () => { const d = await mkdtemp(path.join(tmpdir(), 'typewriter-evidence-')); directories.push(d); return d; };
const sha = (v) => createHash('sha256').update(v).digest('hex');

// Synthetic fixture: files = [{genre, author, blocks: [[line, …], …]}]. Project-authored text only.
async function makeDatabase(files) {
  const directory = await tempDirectory();
  const databasePath = path.join(directory, 'synthetic.sqlite');
  const database = new DatabaseSync(databasePath);
  createLiteratureSchema(database);
  files.forEach((file, index) => {
    const id = index + 1;
    const units = [];
    file.blocks.forEach((block, blockIndex) => {
      if (blockIndex > 0) units.push({ kind: 'blank', block: null, text: '' });
      block.forEach((text) => units.push({ kind: 'text', block: blockIndex + 1, text }));
    });
    database.prepare('INSERT INTO source_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, file.genre, `${file.genre}/${id}_x.txt`, sha('file' + id), 10, 'utf-8', 0, 'lf', 1, 1, 10, units.length, 'ok', '[]');
    database.prepare('INSERT INTO works VALUES (?,?,?,?,?,?,?,?)').run(id, file.genre, id, null, 'T' + id, file.author ?? null, 'filename (unverified)', 0);
    units.forEach((unit, ordinal) => {
      database.prepare('INSERT INTO text_units (file_id, ordinal, kind, block_ordinal, text, eol) VALUES (?,?,?,?,?,?)')
        .run(id, ordinal, unit.kind, unit.block, unit.text, '\n');
    });
  });
  database.exec("INSERT INTO unit_fts(unit_fts) VALUES ('rebuild')");
  for (const [k, v] of Object.entries({ schema_version: '1', builder_version: '1', input_manifest_sha256: 'm'.repeat(64), logical_rows_sha256: 'l'.repeat(64), file_count: String(files.length), unit_count: '0' })) {
    database.prepare('INSERT INTO index_metadata VALUES (?, ?)').run(k, v);
  }
  database.close();
  return databasePath;
}

const forms = (...list) => ({ forms: list.map((form) => ({ form, origin: 'observed' })), skipped: [] });
const ID = { batch_id: 'C000001', candidate_id: 'C000001-0001', lemma: '푸르다' };

async function makeCandidateRoot(rows) {
  const root = await tempDirectory();
  const directory = path.join(root, 'data/candidates/C000001');
  await mkdir(directory, { recursive: true });
  const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(path.join(directory, 'candidates.jsonl'), text);
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ candidates_sha256: sha(text) }));
  return root;
}

const V2 = {
  candidate_id: 'C000001-0001', input: '푸르다', pos_hypotheses: ['adjective'],
  forms: [{ form_id: 'f1', surface: '푸른' }, { form_id: 'f2', surface: '푸르러' }, { form_id: 'f3', surface: '푸' }],
  usage_groups: [{ group_id: 'g1', pos: 'adjective' }], observations: [{ observation_id: 'o1', holds: [] }],
};

test('loads exactly one candidate by batch+candidate id and derives search forms without new morphology', async () => {
  const root = await makeCandidateRoot([V2, { ...V2, candidate_id: 'C000001-0002', input: '다른' }]);
  const row = await loadFactoryCandidate({ batchId: 'C000001', candidateId: 'C000001-0001', root });
  assert.equal(row.input, '푸르다');
  const derived = deriveSearchForms(row, ['푸르니', '푸른']);
  assert.deepEqual(derived.forms.map((f) => [f.form, f.origin]).sort(), [['푸르니', 'supported'], ['푸르다', 'lemma'], ['푸르러', 'observed'], ['푸른', 'observed']]);
  assert.deepEqual(derived.skipped, ['푸']);
  await assert.rejects(loadFactoryCandidate({ batchId: 'C000001', candidateId: 'C000001-0009', root }));
  await assert.rejects(loadFactoryCandidate({ batchId: 'C000001', candidateId: 'C000002-0001', root }), TypeError);
  await writeFile(path.join(root, 'data/candidates/C000001/manifest.json'), JSON.stringify({ candidates_sha256: 'bad' }));
  await assert.rejects(loadFactoryCandidate({ batchId: 'C000001', candidateId: 'C000001-0001', root }), /candidates_sha256/u);
});

test('v1 candidate rows use observedForms; trigger policy reports reasons only', () => {
  const v1 = { candidate_id: 'C000001-0001', input: '가다', pos: 'verb', observedForms: ['가는'], holds: ['analysis_ambiguous'] };
  assert.deepEqual(deriveSearchForms(v1).forms.map((f) => f.form), ['가는', '가다']);
  assert.deepEqual(pilotTriggerReasons(v1), ['held_observation']);
  assert.deepEqual(pilotTriggerReasons(V2, 'new_sense_on_existing_entry'), ['new_sense_on_existing_entry']);
  assert.deepEqual(pilotTriggerReasons({ ...V2, observations: [], usage_groups: [{}, {}] }), ['multiple_usage_groups']);
});

test('module has no network or extra literature-API dependency', async () => {
  const source = await readFile(new URL('./literature-evidence.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/gu)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['../typewriter-cache.mjs', './literature-index.mjs', 'node:crypto', 'node:fs/promises', 'node:path', 'node:sqlite']);
  assert.doesNotMatch(source, /fetch\(|https?:\/\/|node:http|node:net/u);
});

test('de-duplicates unit hits across forms, same-block hits and suppresses same-work repeats', async () => {
  const blockA = ['푸른 하늘이 열렸다', '푸르러 가는 들판', '다음 줄'];
  const files = [
    { genre: 'novel', author: 'A', blocks: [blockA, ['푸른 바다', '푸른 산']] }, // 3 unit hits, 2 blocks
    { genre: 'poem', author: 'B', blocks: [['푸른 별']] },
    { genre: 'essay', author: 'C', blocks: [['푸르러 보인다']] },
  ];
  const databasePath = await makeDatabase(files);
  const { summary, contexts } = retrieveLiteratureEvidence({ databasePath, identity: ID, searchForms: forms('푸른', '푸르러') });
  assert.equal(summary.total_match_units, 6); // '푸른 하늘이…' matches 푸른 only; '푸르러 가는…' separate unit
  assert.equal(summary.distinct_works_matched, 3);
  assert.equal(contexts.length, 3);
  assert.equal(new Set(contexts.map((c) => c.work_id)).size, 3);
  assert.deepEqual(summary.genres_returned, ['essay', 'novel', 'poem']);
  const wider = retrieveLiteratureEvidence({ databasePath, identity: ID, searchForms: forms('푸른', '푸르러'), maxPerWork: 2 });
  assert.equal(wider.contexts.filter((c) => c.work_id === 1).length, 2);
  assert.equal(wider.contexts.filter((c) => c.work_id === 1).every((c, _, a) => a[0].block_ordinal !== undefined), true);
  assert.notEqual(wider.contexts.filter((c) => c.work_id === 1)[0].block_ordinal, wider.contexts.filter((c) => c.work_id === 1)[1].block_ordinal);
});

test('selection is deterministic, bounded and prefers work/genre diversity', () => {
  const hits = Array.from({ length: 40 }, (_, i) => ({
    unit_rowid: i, file_id: (i % 20) + 1, ordinal: i, block_ordinal: i + 1, work_id: (i % 20) + 1,
    author: 'A' + (i % 4), genre: ['poem', 'novel', 'essay'][i % 3], source_sha256: sha('f' + (i % 20)), matched_forms: ['x'],
  }));
  const first = selectRepresentativeHits(hits, { seed: 'a' });
  assert.equal(first.length, DEFAULT_MAX_CONTEXTS);
  assert.deepEqual(first.map((h) => h.unit_rowid), selectRepresentativeHits([...hits].reverse(), { seed: 'a' }).map((h) => h.unit_rowid));
  assert.equal(new Set(first.map((h) => h.work_id)).size, first.length);
  assert.ok(new Set(first.map((h) => h.genre)).size === 3);
  assert.throws(() => selectRepresentativeHits(hits, { maxContexts: 11 }), TypeError);
  assert.throws(() => selectRepresentativeHits(hits, { maxPerWork: 0 }), TypeError);
});

test('no useful evidence is reported without a verdict', async () => {
  const databasePath = await makeDatabase([{ genre: 'poem', blocks: [['아무 상관 없는 줄']] }]);
  const { summary, contexts } = retrieveLiteratureEvidence({ databasePath, identity: ID, searchForms: forms('푸른') });
  assert.equal(contexts.length, 0);
  assert.equal(summary.useful_evidence, false);
  assert.match(summary.no_evidence_note, /not negative evidence/u);
  assert.equal(summary.total_match_units, 0);
  for (const key of ['pos', 'sense', 'disposition', 'decision', 'relation']) assert.equal(key in summary, false);
});

test('context expansion stays within the block and file; large blocks fall back to neighbours', async () => {
  const big = Array.from({ length: MAX_BLOCK_UNITS + 8 }, (_, i) => (i === 10 ? '푸른 표적' : '줄 ' + i));
  const databasePath = await makeDatabase([
    { genre: 'novel', blocks: [['앞 문단'], big, ['뒤 문단']] },
    { genre: 'novel', blocks: [['다른 파일 푸른 줄']] },
  ]);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare("SELECT file_id, ordinal, block_ordinal FROM text_units WHERE text = '푸른 표적'").get();
    const expanded = expandContext(database, row);
    assert.equal(expanded.expansion, 'neighbor_units');
    assert.equal(expanded.units.length, 7);
    assert.ok(expanded.units.every((u) => u.text.startsWith('줄') || u.text === '푸른 표적'));
    assert.equal(expanded.units.filter((u) => u.is_hit).length, 1);
    const small = database.prepare("SELECT file_id, ordinal, block_ordinal FROM text_units WHERE text = '앞 문단'").get();
    assert.deepEqual(expandContext(database, small).units.map((u) => u.text), ['앞 문단']);
    const other = database.prepare("SELECT file_id, ordinal, block_ordinal FROM text_units WHERE text = '다른 파일 푸른 줄'").get();
    assert.deepEqual(expandContext(database, other).units.map((u) => u.text), ['다른 파일 푸른 줄']);
  } finally {
    database.close();
  }
});

test('summary binds DB identity and text-free location digests; text only in the local pack', async () => {
  const databasePath = await makeDatabase([{ genre: 'poem', blocks: [['푸른 합성 시']] }, { genre: 'essay', blocks: [['푸른 합성 글']] }]);
  const result = retrieveLiteratureEvidence({ databasePath, identity: ID, searchForms: forms('푸른') });
  assert.equal(result.summary.literature_index.logical_rows_sha256, 'l'.repeat(64));
  assert.equal(result.summary.literature_index.input_manifest_sha256, 'm'.repeat(64));
  assert.equal(result.summary.selected_location_digests.length, 2);
  assert.ok(result.summary.selected_location_digests.every((d) => /^[0-9a-f]{64}$/u.test(d)));
  assert.doesNotMatch(JSON.stringify(result.summary), /합성 (시|글)/u);
  assert.match(JSON.stringify(result.contexts), /합성 시/u);
  const root = await tempDirectory();
  const cacheRoot = path.join(root, 'machine-cache');
  const files = await writeEvidencePack(result, { outputDirectory: path.join(cacheRoot, 'evidence'), cacheRoot });
  assert.doesNotMatch(await readFile(files.summary, 'utf8'), /합성 (시|글)/u);
  assert.match(await readFile(files.markdown, 'utf8'), /합성 시/u);
  await assert.rejects(() => writeEvidencePack(result, { outputDirectory: path.join(cacheRoot, 'evidence'), cacheRoot }), { code: 'EEXIST' });
});

test('evidence packs can only be written under the shared cache evidence area', async () => {
  const paths = resolveTypewriterCachePaths();
  assert.throws(() => assertLocalOutputDirectory(path.join(REPOSITORY_DIRECTORY, 'data/canonical')),
    /must be below/u);
  assert.throws(() => assertLocalOutputDirectory(path.join(paths.root, 'reviews')),
    /must be below/u);
  assert.ok(EVIDENCE_OUTPUT_DIRECTORY.startsWith(paths.root + path.sep));
  assert.equal(EVIDENCE_OUTPUT_DIRECTORY, paths.evidence);
});

test('existing literature search behaviour is unchanged by retrieval', async () => {
  const databasePath = await makeDatabase([{ genre: 'poem', blocks: [['푸른 시', '둘째 줄']] }]);
  const before = JSON.stringify(searchLiteratureIndex({ databasePath, query: '푸른' }));
  retrieveLiteratureEvidence({ databasePath, identity: ID, searchForms: forms('푸른') });
  assert.equal(JSON.stringify(searchLiteratureIndex({ databasePath, query: '푸른' })), before);
});

test('totals stay exact when the fetch cap is reached; summary and rendering distinguish sampled from total', async () => {
  const files = Array.from({ length: 6 }, (_, i) => ({
    genre: ['poem', 'novel', 'essay'][i % 3],
    blocks: Array.from({ length: 5 }, (_, b) => ['푸른 줄 ' + i + '-' + b, '푸르러 줄 ' + i + '-' + b]),
  })); // 6 works × 5 blocks × 2 lines = 60 matching units
  const databasePath = await makeDatabase(files);
  const capped = retrieveLiteratureEvidence({ databasePath, identity: ID, searchForms: forms('푸른', '푸르러'), hitFetchCap: 7 });
  assert.equal(capped.summary.total_match_units, 60);
  assert.equal(capped.summary.distinct_works_matched, 6);
  assert.equal(capped.summary.sampled_match_units < 60, true);
  assert.equal(capped.summary.fetch_truncated, true);
  assert.deepEqual(capped.summary.per_form.map((f) => [f.unit_matches, f.truncated]), [[30, true], [30, true]]);
  assert.match(renderEvidenceMarkdown(capped), /matches 60 units in 6 works \(selected from a sample of \d+ units in \d+ works; fetch cap reached\)/u);
  const full = retrieveLiteratureEvidence({ databasePath, identity: ID, searchForms: forms('푸른', '푸르러') });
  assert.equal(full.summary.total_match_units, 60);
  assert.equal(full.summary.sampled_match_units, 60);
  assert.equal(full.summary.fetch_truncated, false);
  assert.doesNotMatch(renderEvidenceMarkdown(full), /fetch cap reached/u);
});

test('eojeol mode drops mid-eojeol matches and keeps conjugated and particle-attached forms (#414)', async () => {
  const files = [
    { genre: 'novel', author: 'A', blocks: [['윤선도가 지은 시', '꾀꼬리 소리']] }, // 선도/꼬리 only inside other words
    { genre: 'poem', author: 'B', blocks: [['선도를 달리는 배', '"꼬리를 흔든다', '그 꼬리']] }, // line start, particle, quote, space
    { genre: 'essay', author: 'C', blocks: [['가지고 갔다', '지고 간다']] },
  ];
  const databasePath = await makeDatabase(files);
  assert.equal(DEFAULT_MATCH_MODE, 'substring'); // opt-in until the judged evaluation and an owner decision
  const run = (searchForms, matchMode) => retrieveLiteratureEvidence({ databasePath, identity: ID, searchForms, matchMode });
  const substring = run(forms('선도', '꼬리', '지고'), 'substring').summary;
  const eojeol = run(forms('선도', '꼬리', '지고'), 'eojeol');
  assert.equal(substring.total_match_units, 7);
  assert.equal(eojeol.summary.total_match_units, 4);
  assert.deepEqual(eojeol.summary.per_form.map((f) => [f.form, f.unit_matches]), [['선도', 1], ['꼬리', 2], ['지고', 1]]);
  assert.equal(eojeol.summary.match_mode, 'eojeol');
  const implicit = run(forms('선도', '꼬리', '지고'), undefined).summary;
  assert.equal(implicit.match_mode, 'substring');
  assert.equal(implicit.total_match_units, substring.total_match_units); // no silent behaviour change without an explicit mode
  assert.throws(() => run(forms('선도'), 'prefix'), /matchMode/u);
  // 2-character forms use the non-FTS path; 3+ use FTS; both honour the filter.
  assert.equal(run(forms('가지고'), 'eojeol').summary.total_match_units, 1);
});

test('match positions classify boundary, Hangul, Han and other-letter prefixes', () => {
  assert.deepEqual(matchOccurrences('윤선도 선도', '선도').map((o) => o.class), ['after_hangul', 'boundary']);
  assert.deepEqual(matchOccurrences('尹선도 a선도 1선도 “선도', '선도').map((o) => o.class), ['after_han', 'after_other', 'after_other', 'boundary']);
  assert.equal(hasEojeolMatch('꾀꼬리', '꼬리'), false);
  assert.equal(hasEojeolMatch('꾀꼬리 꼬리를', '꼬리'), true);
  assert.equal(hasEojeolMatch('', '꼬리'), false);
});

test('classifyMatchSample counts units by position and trailing run without text', async () => {
  const databasePath = await makeDatabase([{ genre: 'novel', author: 'A', blocks: [['꾀꼬리', '꼬리', '꼬리를', '꼬리였던것이', '尹꼬리']] }]);
  const census = classifyMatchSample({ databasePath, searchForms: forms('꼬리') });
  assert.deepEqual(census, { units: 5, boundary: 3, after_hangul: 1, after_han: 1, after_other: 0, trailing_0: 1, trailing_1_2: 1, trailing_3_plus: 1 });
});

test('multi-form units are counted once and agree with the retriever (#414 review)', async () => {
  const databasePath = await makeDatabase([{ genre: 'novel', author: 'A', blocks: [['쳐다보다가 봤다', '쳐다보다가 갔다', '봤다 보다']] }]);
  const searchForms = forms('보다', '봤다');
  const units = fetchSubstringUnits({ databasePath, searchForms });
  assert.equal(units.length, 3);
  assert.deepEqual(units.find((u) => u.text === '쳐다보다가 봤다').forms, ['보다', '봤다']);
  const census = classifyMatchSample({ databasePath, searchForms });
  const retrieved = retrieveLiteratureEvidence({ databasePath, identity: ID, searchForms, matchMode: 'eojeol' }).summary;
  assert.equal(census.units, 3);
  assert.equal(census.boundary, retrieved.total_match_units); // 2 kept units
  assert.equal(census.after_hangul, 1);
});

test('dropped multi-form units are classified once by their earliest occurrence, independent of form order (#414 review)', async () => {
  // `보다` follows a Han character (after_han, earliest); `다가` follows Hangul (after_hangul, later). No eojeol-start match.
  const databasePath = await makeDatabase([{ genre: 'novel', author: 'A', blocks: [['尹보다 하다가']] }]);
  const expected = { units: 1, boundary: 0, after_hangul: 0, after_han: 1, after_other: 0, trailing_0: 0, trailing_1_2: 0, trailing_3_plus: 0 };
  assert.deepEqual(classifyMatchSample({ databasePath, searchForms: forms('보다', '다가') }), expected);
  assert.deepEqual(classifyMatchSample({ databasePath, searchForms: forms('다가', '보다') }), expected);
});
