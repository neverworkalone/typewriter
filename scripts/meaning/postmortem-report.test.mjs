import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { initialCodeOf, readMeanings } from './contract.mjs';
import { DEFAULT_CODE, NO_RECORD, POSTMORTEM_CODES, buildReport, renderAll, renderJsonl, reportName } from './postmortem-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MEANING_DIR = path.join(ROOT, 'scripts', 'meaning');
const VERDICTS = ['over_merge_confirmed', 'over_split_confirmed', 'keep_reviewed', 'suspect_hold', 'REPARTITION'];

const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
const record = (id, lemma, glosses) => ({ id, record_type: 'entry', role: 'start', candidate_id: id, lemma, search_forms: [lemma], senses: glosses.map((gloss, i) => ({ id: `${id}-s${i + 1}`, pos: 'noun', gloss })), source: 'stdict' });

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'postmortem-report-'));
  const dirs = {
    meaningsDirectory: path.join(root, 'meanings'),
    adjudicationDirectory: path.join(root, 'adjudication'),
    canonicalDirectory: path.join(root, 'canonical'),
    meaningDirectory: path.join(root, 'scripts'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  writeFileSync(path.join(dirs.canonicalDirectory, 'stdict-0001.jsonl'), jsonl([
    record('w10', '까까', ['첫째 뜻.', '둘째 뜻.']), // same-record merge
    record('w11', '까까', ['셋째 뜻.']), // separate record -> second Meaning of the same lemma
    record('w12', '꼬꼬', ['단일 뜻.']), // single sense, single Meaning: counted, not listed
    record('w13', '꾸꾸', ['하나.']),
    record('w14', '꾸꾸', ['둘.']),
    record('w15', '꾸꾸', ['셋.', '넷.']), // three Meanings, one merged (mixed shape)
  ]));
  writeFileSync(path.join(dirs.meaningsDirectory, 'c02_001.jsonl'), jsonl([
    { id: 'm10', lemma: '까까', gloss: '첫째 뜻. 둘째 뜻.', sense_ids: ['w10-s1', 'w10-s2'] },
    { id: 'm11', lemma: '까까', gloss: '셋째 뜻.', sense_ids: ['w11-s1'] },
    { id: 'm12', lemma: '꼬꼬', gloss: '단일 뜻.', sense_ids: ['w12-s1'] },
    { id: 'm13', lemma: '꾸꾸', gloss: '하나.', sense_ids: ['w13-s1'] },
    { id: 'm14', lemma: '꾸꾸', gloss: '둘.', sense_ids: ['w14-s1'] },
    { id: 'm15', lemma: '꾸꾸', gloss: '셋. 넷.', sense_ids: ['w15-s1', 'w15-s2'] },
  ]));
  return dirs;
}

test('lists every merged Meaning and every split lemma and links the two sets', () => {
  const report = buildReport({ code: 'c02', ...fixture() });
  assert.deepEqual(report.errors, []);
  assert.equal(report.counts.meanings_with_2plus_senses, 2); // m10, m15
  assert.equal(report.counts.lemmas_with_2plus_meanings, 2); // 까까, 꾸꾸
  assert.equal(report.counts.review_lemmas, 2);
  assert.equal(report.counts.lemmas_in_both_sets, 2);
  assert.equal(report.counts.single_sense_single_meaning_lemmas_not_listed, 1); // 꼬꼬
  const [kkakka, kkukku] = report.entries;
  assert.equal(kkakka.lemma, '까까');
  assert.deepEqual(kkakka.groups.map((g) => [g.meaning_id, g.merged, g.senses.map((s) => s.sense_id)]), [['m10', true, ['w10-s1', 'w10-s2']], ['m11', false, ['w11-s1']]]);
  assert.equal(kkakka.groups[0].senses[0].canonical_gloss, '첫째 뜻.');
  assert.equal(kkakka.recorded_reason_status, NO_RECORD);
  assert.equal(kkukku.groups.length, 3); // 3 Meanings, one of them merged
  assert.equal(kkakka.in_merged_set && kkakka.in_split_set, true);
});

test('output is byte-identical on identical input and states no verdict', () => {
  const dirs = fixture();
  const first = renderAll(buildReport({ code: 'c02', ...dirs }), { inputSha: 'a'.repeat(40) });
  const second = renderAll(buildReport({ code: 'c02', ...dirs }), { inputSha: 'a'.repeat(40) });
  assert.deepEqual([...first], [...second]);
  for (const text of first.values()) for (const verdict of VERDICTS) assert.ok(!text.includes(verdict), verdict);
});

test('structural gaps are reported instead of hidden', () => {
  const dirs = fixture();
  writeFileSync(path.join(dirs.meaningsDirectory, 'c02_001.jsonl'), jsonl([{ id: 'm10', lemma: '까까', gloss: '첫째 뜻. 둘째 뜻.', sense_ids: ['w10-s1', 'w10-s2'] }]));
  const report = buildReport({ code: 'c02', ...dirs });
  assert.ok(report.errors.length > 0);
  assert.equal(report.counts.canonical_senses_unaccounted, 6);
});

test('renderJsonl is one JSON object per review lemma', () => {
  assert.equal(renderJsonl({ entries: [] }), '');
  assert.equal(renderJsonl({ entries: [{ lemma: '가' }, { lemma: '나' }] }), '{"lemma":"가"}\n{"lemma":"나"}\n');
});

test('committed C02 report covers every merged Meaning and split lemma from data/meanings', () => {
  const { rows } = readMeanings(path.join(ROOT, 'data', 'meanings'));
  const mine = rows.filter((row) => initialCodeOf(row.lemma) === DEFAULT_CODE);
  const byLemma = new Map();
  for (const row of mine) byLemma.set(row.lemma, [...(byLemma.get(row.lemma) ?? []), row]);
  const expected = new Map();
  for (const [lemma, group] of byLemma) if (group.length >= 2 || group.some((row) => row.sense_ids.length >= 2)) expected.set(lemma, group);

  const sidecar = readFileSync(path.join(MEANING_DIR, `${reportName(DEFAULT_CODE)}.jsonl`), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(sidecar.length, expected.size, 'review lemma count');
  const listedMerged = new Set();
  for (const line of sidecar) {
    const group = expected.get(line.lemma);
    assert.ok(group, `${line.lemma} is not a review lemma`);
    assert.deepEqual(line.groups.map((g) => [g.meaning_id, g.senses.map((s) => s.sense_id)]), group.map((row) => [row.id, row.sense_ids]), line.lemma);
    assert.deepEqual(line.groups.map((g) => g.gloss), group.map((row) => row.gloss));
    for (const g of line.groups) {
      for (const s of g.senses) assert.ok(s.record_id && s.canonical_gloss && s.canonical_shard, `${line.lemma} ${s.sense_id}`);
      if (g.merged) listedMerged.add(g.meaning_id);
    }
  }
  const expectedMerged = new Set(mine.filter((row) => row.sense_ids.length >= 2).map((row) => row.id));
  assert.deepEqual([...listedMerged].sort(), [...expectedMerged].sort());

  const md = readFileSync(path.join(MEANING_DIR, `${reportName(DEFAULT_CODE)}.md`), 'utf8');
  assert.match(md, /기준 master SHA: `[0-9a-f]{40}`/u);
  assert.ok(md.includes('## 2. 병합 목록(A)'));
  assert.ok(md.includes('## 3. 분리 목록(B)'));
  assert.ok(md.includes(`| A. 2개 이상 sense를 가진 Meaning | ${expectedMerged.size.toLocaleString('en-US')} |`));
  assert.ok(md.includes(`| 검토 대상 lemma (A∪B, 중복 제외) | ${expected.size.toLocaleString('en-US')} |`));
  for (const verdict of VERDICTS) assert.ok(!md.includes(verdict), verdict);
});

test('committed C02 report and sidecar regenerate byte-for-byte from the same input', () => {
  const md = readFileSync(path.join(MEANING_DIR, `${reportName(DEFAULT_CODE)}.md`), 'utf8');
  const inputSha = /기준 master SHA: `([0-9a-f]{40})`/u.exec(md)?.[1];
  assert.ok(inputSha, 'input SHA present in committed report');
  const report = buildReport({
    code: DEFAULT_CODE,
    meaningsDirectory: path.join(ROOT, 'data', 'meanings'),
    adjudicationDirectory: path.join(ROOT, 'data', 'adjudication'),
    canonicalDirectory: path.join(ROOT, 'data', 'canonical'),
  });
  assert.deepEqual(report.errors, []);
  const files = renderAll(report, { inputSha });
  for (const [name, content] of files) {
    assert.equal(readFileSync(path.join(MEANING_DIR, name), 'utf8'), content, `${name} is stale`);
  }
  for (const code of POSTMORTEM_CODES) assert.equal(typeof reportName(code), 'string');
});
