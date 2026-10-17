import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { initialCodeOf, readMeanings } from './contract.mjs';
import { NO_RECORD, POSTMORTEM_CODES, buildPostmortem, renderAll, renderJsonl, reportName } from './postmortem.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MEANING_DIR = path.join(ROOT, 'scripts', 'meaning');

const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
const entry = (id, lemma, glosses) => ({ id, record_type: 'entry', role: 'start', candidate_id: id, lemma, search_forms: [lemma], senses: glosses.map((gloss, i) => ({ id: `${id}-s${i + 1}`, pos: 'noun', gloss })), source: 'stdict' });

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'postmortem-'));
  const dirs = { meaningsDirectory: path.join(root, 'meanings'), adjudicationDirectory: path.join(root, 'adjudication'), canonicalDirectory: path.join(root, 'canonical') };
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  writeFileSync(path.join(dirs.canonicalDirectory, 'stdict-0001.jsonl'), jsonl([
    entry('w10', '가가', ['첫째 뜻.', '둘째 뜻.']), // same-record merge
    entry('w11', '가가', ['셋째 뜻.']), // separate record, separate Meaning
    entry('w12', '나나', ['단일 뜻.']), // single sense, single Meaning: counted, not listed
    entry('w13', '다다', ['하나.']),
    entry('w14', '다다', ['둘.']),
    entry('w15', '다다', ['셋.', '넷.']), // 3 Meanings, one of them merged (mixed)
    entry('w16', '가가', ['중복.']),
  ]));
  writeFileSync(path.join(dirs.meaningsDirectory, 'c01_001.jsonl'), jsonl([
    { id: 'm10', lemma: '가가', gloss: '첫째 뜻. 둘째 뜻.', sense_ids: ['w10-s1', 'w10-s2'] },
    { id: 'm11', lemma: '가가', gloss: '셋째 뜻.', sense_ids: ['w11-s1'] },
  ]));
  writeFileSync(path.join(dirs.meaningsDirectory, 'c03_001.jsonl'), jsonl([{ id: 'm12', lemma: '나나', gloss: '단일 뜻.', sense_ids: ['w12-s1'] }]));
  writeFileSync(path.join(dirs.meaningsDirectory, 'c04_001.jsonl'), jsonl([
    { id: 'm13', lemma: '다다', gloss: '하나.', sense_ids: ['w13-s1'] },
    { id: 'm14', lemma: '다다', gloss: '둘.', sense_ids: ['w14-s1'] },
    { id: 'm15', lemma: '다다', gloss: '셋. 넷.', sense_ids: ['w15-s1', 'w15-s2'] },
  ]));
  writeFileSync(path.join(dirs.adjudicationDirectory, 'c01_001.jsonl'), jsonl([{ sense_id: 'w16-s1', lemma: '가가', decision: 'drop', reason: 'duplicate', duplicate_of: 'w10-s1' }]));
  return dirs;
}

test('postmortem lists every merged Meaning and every split lemma, linking both sets', () => {
  const result = buildPostmortem(fixture());
  assert.deepEqual(result.errors, []);
  const c01 = result.reports.get('c01');
  assert.equal(c01.counts.meanings_with_2plus_senses, 1);
  assert.equal(c01.counts.lemmas_with_2plus_meanings, 1);
  assert.equal(c01.counts.review_lemmas, 1);
  assert.equal(c01.counts.lemmas_in_both_sets, 1);
  const [lemma] = c01.entries;
  assert.equal(lemma.lemma, '가가');
  assert.deepEqual(lemma.groups.map((g) => [g.meaning_id, g.merged, g.senses.map((s) => s.sense_id)]), [['m10', true, ['w10-s1', 'w10-s2']], ['m11', false, ['w11-s1']]]);
  assert.equal(lemma.groups[0].senses[0].canonical_gloss, '첫째 뜻.');
  assert.equal(lemma.recorded_reason_status, NO_RECORD);
  const c03 = result.reports.get('c03');
  assert.equal(c03.counts.review_lemmas, 0);
  assert.equal(c03.counts.single_sense_single_meaning_lemmas_not_listed, 1);
  const c04 = result.reports.get('c04');
  assert.equal(c04.counts.meanings, 3);
  assert.equal(c04.entries[0].groups.length, 3);
  assert.equal(c04.counts.meanings_with_2plus_senses, 1);
  assert.equal(c01.counts.canonical_senses_adjudicated_drop, 1);
  assert.equal(c01.counts.canonical_senses_unaccounted, 0);
});

test('postmortem output is byte-identical on identical input and never states a verdict', () => {
  const dirs = fixture();
  const first = renderAll(buildPostmortem(dirs), { inputSha: 'a'.repeat(40) });
  const second = renderAll(buildPostmortem(dirs), { inputSha: 'a'.repeat(40) });
  assert.deepEqual([...first], [...second]);
  for (const text of first.values()) {
    for (const forbidden of ['over_merge_confirmed', 'over_split_confirmed', 'keep_reviewed', 'suspect_hold', 'REPARTITION']) assert.ok(!text.includes(forbidden), forbidden);
  }
});

test('structural gaps are reported instead of hidden', () => {
  const dirs = fixture();
  writeFileSync(path.join(dirs.meaningsDirectory, 'c01_001.jsonl'), jsonl([{ id: 'm10', lemma: '가가', gloss: '첫째 뜻. 둘째 뜻.', sense_ids: ['w10-s1', 'w10-s2'] }]));
  const result = buildPostmortem(dirs);
  assert.ok(result.errors.length > 0);
  assert.equal(result.reports.get('c01').counts.canonical_senses_unaccounted, 1);
});

test('committed post-mortem reports match an independent recount of data/meanings', () => {
  const { rows } = readMeanings(path.join(ROOT, 'data', 'meanings'));
  const index = readFileSync(path.join(MEANING_DIR, 'issue-764-postmortem.md'), 'utf8');
  assert.match(index, /기준 master SHA: `[0-9a-f]{40}`/u);
  for (const code of POSTMORTEM_CODES) {
    const mine = rows.filter((row) => initialCodeOf(row.lemma) === code);
    const byLemma = new Map();
    for (const row of mine) byLemma.set(row.lemma, [...(byLemma.get(row.lemma) ?? []), row]);
    const expected = new Map();
    for (const [lemma, group] of byLemma) {
      if (group.length >= 2 || group.some((row) => row.sense_ids.length >= 2)) expected.set(lemma, group);
    }
    const lines = readFileSync(path.join(MEANING_DIR, `${reportName(code)}.jsonl`), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(lines.length, expected.size, `${code} review lemma count`);
    for (const line of lines) {
      const group = expected.get(line.lemma);
      assert.ok(group, `${code} ${line.lemma} unexpected`);
      assert.deepEqual(line.groups.map((g) => [g.meaning_id, g.senses.map((s) => s.sense_id)]), group.map((row) => [row.id, row.sense_ids]), `${code} ${line.lemma}`);
      assert.deepEqual(line.groups.map((g) => g.gloss), group.map((row) => row.gloss));
      for (const g of line.groups) for (const s of g.senses) assert.ok(s.canonical_gloss && s.record_id && s.canonical_shard);
    }
    const md = readFileSync(path.join(MEANING_DIR, `${reportName(code)}.md`), 'utf8');
    assert.ok(md.includes(`| A. 2개 이상 sense를 가진 Meaning | ${mine.filter((row) => row.sense_ids.length >= 2).length.toLocaleString('en-US')} |`), `${code} A count`);
    assert.ok(md.includes(`| 검토 대상 lemma (A∪B, 중복 제외) | ${expected.size.toLocaleString('en-US')} |`), `${code} review lemma count in md`);
  }
});

test('renderJsonl is one JSON object per review lemma and empty for none', () => {
  assert.equal(renderJsonl({ entries: [] }), '');
  assert.equal(renderJsonl({ entries: [{ lemma: 'a' }, { lemma: 'b' }] }), '{"lemma":"a"}\n{"lemma":"b"}\n');
});

test('every initial report and sidecar exists', () => {
  const names = new Set(readdirSync(MEANING_DIR));
  for (const code of POSTMORTEM_CODES) {
    assert.ok(names.has(`${reportName(code)}.md`), code);
    assert.ok(names.has(`${reportName(code)}.jsonl`), code);
  }
  assert.ok(names.has('issue-764-postmortem.md'));
});
