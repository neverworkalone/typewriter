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
  expandContext,
  loadFactoryCandidate,
  MAX_BLOCK_UNITS,
  pilotTriggerReasons,
  retrieveLiteratureEvidence,
  selectRepresentativeHits,
  writeEvidencePack,
} from './literature-evidence.mjs';

let fts5Error;
try { assertLiteratureFts5Support(); } catch (error) { fts5Error = error; }
if (fts5Error && process.env.TYPEWRITER_REQUIRE_FTS5 === '1') throw fts5Error;
const needsFts5 = { skip: fts5Error ? fts5Error.message : false };

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
  assert.deepEqual(imports, ['./literature-index.mjs', 'node:crypto', 'node:fs/promises', 'node:path', 'node:sqlite']);
  assert.doesNotMatch(source, /fetch\(|https?:\/\/|node:http|node:net/u);
});

test('de-duplicates unit hits across forms, same-block hits and suppresses same-work repeats', needsFts5, async () => {
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

test('no useful evidence is reported without a verdict', needsFts5, async () => {
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

test('summary binds DB identity and text-free location digests; text only in the local pack', needsFts5, async () => {
  const databasePath = await makeDatabase([{ genre: 'poem', blocks: [['푸른 합성 시']] }, { genre: 'essay', blocks: [['푸른 합성 글']] }]);
  const result = retrieveLiteratureEvidence({ databasePath, identity: ID, searchForms: forms('푸른') });
  assert.equal(result.summary.literature_index.logical_rows_sha256, 'l'.repeat(64));
  assert.equal(result.summary.literature_index.input_manifest_sha256, 'm'.repeat(64));
  assert.equal(result.summary.selected_location_digests.length, 2);
  assert.ok(result.summary.selected_location_digests.every((d) => /^[0-9a-f]{64}$/u.test(d)));
  assert.doesNotMatch(JSON.stringify(result.summary), /합성 (시|글)/u);
  assert.match(JSON.stringify(result.contexts), /합성 시/u);
  const root = await tempDirectory();
  await mkdir(path.join(root, 'data/reference'), { recursive: true });
  const files = await writeEvidencePack(result, { outputDirectory: path.join(root, 'data/reference/literature-evidence'), root });
  assert.doesNotMatch(await readFile(files.summary, 'utf8'), /합성 (시|글)/u);
  assert.match(await readFile(files.markdown, 'utf8'), /합성 시/u);
});

test('evidence packs can only be written under ignored data/reference', async () => {
  assert.throws(() => assertLocalOutputDirectory(path.join(REPOSITORY_DIRECTORY, 'data/canonical')), /data\/reference/u);
  assert.throws(() => assertLocalOutputDirectory(path.join(REPOSITORY_DIRECTORY, 'data/reference/../reviews')), /data\/reference/u);
  // `.gitignore` (not `git check-ignore`, which fails for a symlinked data/reference in a worktree).
  const rules = (await readFile(path.join(REPOSITORY_DIRECTORY, '.gitignore'), 'utf8')).split('\n').map((line) => line.trim());
  assert.ok(rules.includes('data/reference/'), 'data/reference/ must be git-ignored');
  assert.ok(EVIDENCE_OUTPUT_DIRECTORY.startsWith(path.join(REPOSITORY_DIRECTORY, 'data/reference') + path.sep));
});

test('existing literature search behaviour is unchanged by retrieval', needsFts5, async () => {
  const databasePath = await makeDatabase([{ genre: 'poem', blocks: [['푸른 시', '둘째 줄']] }]);
  const before = JSON.stringify(searchLiteratureIndex({ databasePath, query: '푸른' }));
  retrieveLiteratureEvidence({ databasePath, identity: ID, searchForms: forms('푸른') });
  assert.equal(JSON.stringify(searchLiteratureIndex({ databasePath, query: '푸른' })), before);
});
