import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkRows, chunkShard, parseAnswer, renderChunk, run, save } from './selection-cli.mjs';
import { claudeUsage, cliArgs } from './selection-run.mjs';

const records = [
  { id: 'w1', lemma: '가', senses: [{ id: 'w1-s1', pos: 'noun', gloss: 'x'.repeat(8) }] },
  { id: 'w2', lemma: '나', homograph_no: 1, senses: [{ id: 'w2-s1', pos: 'verb', gloss: 'y'.repeat(8) }, { id: 'w2-s3', pos: 'verb', gloss: '둘째\n뜻' }] },
  { id: 'w3', lemma: '나', homograph_no: 2, senses: [{ id: 'w3-s1', pos: 'expression', gloss: 'z' }] },
  { id: 'w4', lemma: '다', senses: [{ id: 'w4-s1', pos: 'determiner', gloss: 'q' }] },
];

test('chunks never split records and keep adjacent same-lemma records', () => {
  assert.deepEqual(chunkShard(records, { targetChars: 5 }), [{ start: 0, end: 1 }, { start: 1, end: 3 }, { start: 3, end: 4 }]);
  assert.equal(renderChunk(records, { start: 1, end: 3 }), '2 나1\n 1 v yyyyyyyy\n 2 v 둘째 뜻\n3 나2\n 1 x z\n');
});

test('answer lines bind letters to the real Sense IDs of the same record array', () => {
  const chunk = { start: 0, end: 4 };
  const ok = parseAnswer('1 s\n2 ps\n```\n3 e\n4 p\n```', records, chunk);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(parseAnswer('1 s\n2 p\n2 ps\n3 x\n9 p', records, chunk).errors,
    ['2: 2 Sense(s) need 2 letter(s), got 1', '2: duplicate record line', '3: letters must be p/s/e only (got "x")', '9: record number outside this chunk', '4: missing record line']);
  assert.equal(parseAnswer('이 요청은 처리할 수 없습니다.', records, chunk).lines, 0);
});

test('save writes compact id/d rows in Canonical order; check enforces §5', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'selection-'));
  try {
    await mkdir(path.join(root, 'data/canonical'), { recursive: true });
    await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const dir = path.join(root, 'answers');
    await mkdir(dir);
    await assert.rejects(save(root, '001', dir), /chunk 1: no answer/u);
    await writeFile(path.join(dir, 'c01.answer.txt'), '4 p\n3 e\n2 ps\n1 s\n');
    assert.deepEqual(await save(root, '001', dir), { p: 2, s: 2, e: 1 });
    const text = await readFile(path.join(root, 'data/relation-selection/selection-001.jsonl'), 'utf8');
    assert.equal(text, '{"id":"w1-s1","d":"s"}\n{"id":"w2-s1","d":"p"}\n{"id":"w2-s3","d":"s"}\n{"id":"w3-s1","d":"e"}\n{"id":"w4-s1","d":"p"}\n');
    assert.deepEqual(checkRows(records, text).errors, []);
    const bad = '{"id":"w2-s1","d":"p"}\n{"id":"w1-s1", "d":"s"}\n{"id":"w2-s3","d":"skip"}\n';
    assert.deepEqual(checkRows(records, bad).errors, ['line 1: expected w1-s1, got w2-s1', 'line 2: not compact JSON', 'line 2: expected w2-s1, got w1-s1',
      'line 3: invalid d "skip"', 'missing 2 Sense(s) from w3-s1']);
    const out = [];
    await run(['check', '--shard', '001'], { root, out: (t) => out.push(t) });
    assert.equal(out.join(''), '{"shard":"001","ok":true,"p":2,"s":2,"e":1}\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runner flags and usage follow the War Room answer-only and usage conventions', () => {
  assert.throws(() => cliArgs('--model', {}), /--tools/u);
  assert.deepEqual(cliArgs('--tools <t>\n--strict-mcp-config\n--bare\n--system-prompt <p>', {}), { args: ['--tools', '', '--strict-mcp-config'], systemPrompt: true });
  assert.deepEqual(cliArgs('--tools <t>\n--bare', { ANTHROPIC_API_KEY: 'k' }).args, ['--tools', '', '--bare']);
  assert.deepEqual(claudeUsage({ input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 7 }),
    { input_tokens: 125, cached_input_tokens: 100, cache_write_tokens: 20, output_tokens: 7, reasoning_output_tokens: null });
  assert.equal(claudeUsage({ input_tokens: 5, output_tokens: 7 }).input_tokens, null);
});
