// Thin owner-run batch runner for the #10174 pre-selection. One answer-only `claude -p` call per chunk of
// `selection-cli.mjs view`, answers kept per chunk, `save` once per shard when every chunk is valid.
//
//   node scripts/relation/selection-run.mjs --shards 001-010 --effort <owner profile> [--jobs 2] [--model opus] [--work DIR]
//
// Kept on rerun: a chunk with a valid saved answer is not called again; only incomplete chunks run.
// Never written as a decision: refusal, technical failure, decision-less free text (each recorded separately).
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  answerPath, chunkShard, errorRecords, mergeRepair, parseAnswer, parseShards, readShardRecords, renderChunk, REPOSITORY_DIRECTORY, save, selectionPath,
} from './selection-cli.mjs';

const CARD_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'selection-card.md');

function option(argv, flag, fallback = null) {
  const position = argv.indexOf(flag);
  const value = position >= 0 ? argv[position + 1] : null;
  return value && !value.startsWith('--') ? value : fallback;
}

/** Answer-only flags as War Room `_answer_only_args`: tools removed (required), MCP/slash commands off when supported. */
export function cliArgs(helpText, env) {
  const has = (flag) => new RegExp(`(^|\\s)${flag}(\\s|,|=|$)`, 'mu').test(helpText);
  if (!has('--tools')) throw new Error('installed Claude CLI does not support --tools; refusing to run with tools');
  const args = ['--tools', ''];
  for (const flag of ['--strict-mcp-config', '--disable-slash-commands']) if (has(flag)) args.push(flag);
  // --bare needs API-key auth; only when the key is already in the environment (never switch auth for it).
  if (has('--bare') && env.ANTHROPIC_API_KEY) args.push('--bare');
  return { args, systemPrompt: has('--system-prompt') };
}

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/** Same convention as tools/warroom/warroom/usage.py `_claude_usage`: unknown stays null, never 0. */
export function claudeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const fresh = count(u.input_tokens); const read = count(u.cache_read_input_tokens);
  const write = count(u.cache_creation_input_tokens); const out = count(u.output_tokens);
  if (fresh === null || out === null) return null;
  const reason = count(u.output_tokens_details?.thinking_tokens);
  return {
    input_tokens: read === null || write === null ? null : fresh + read + write,
    cached_input_tokens: read, cache_write_tokens: write, output_tokens: out, reasoning_output_tokens: reason,
  };
}

/** Final `result` event and refusal hint of one stream-json run. */
export function readStream(text) {
  let result = null;
  let refusal = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.message?.stop_reason === 'refusal' || event?.stop_reason === 'refusal') refusal = true;
    if (event?.type === 'result') result = event;
  }
  return { result, refusal };
}

export function addUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  return Object.fromEntries(Object.keys(a).map((k) => [k, a[k] === null || b[k] === null ? null : a[k] + b[k]]));
}

function callClaude({ cwd, prompt, args, logFile, env }) {
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (data) => { out += data; });
    child.stderr.on('data', (data) => { err += data; });
    child.on('error', (error) => { err += String(error); });
    child.on('close', async (code) => {
      await writeFile(logFile, out);
      if (err) await writeFile(`${logFile}.err`, err);
      resolve({ code, ...readStream(out) });
    });
    child.stdin.end(prompt);
  });
}

async function runChunk({ records, chunk, index, dir, base, card, flags, model, effort, env, cwd }) {
  const tag = `c${String(index).padStart(2, '0')}`;
  const answerFile = answerPath(dir, index);
  if (existsSync(answerFile) && !parseAnswer(readFileSync(answerFile, 'utf8'), records, chunk).errors.length) {
    return { chunk: index, status: 'kept' };
  }
  const view = renderChunk(records, chunk);
  const pins = ['-p', '--model', model, '--effort', effort, '--output-format', 'stream-json', '--verbose', ...flags.args];
  const started = Date.now();
  const first = await callClaude({
    cwd, env, logFile: path.join(dir, `${tag}.log`),
    args: [...pins, ...(flags.systemPrompt ? ['--system-prompt', card] : [])],
    prompt: flags.systemPrompt ? view : `${card}\n\n---\n\n${view}`,
  });
  let usage = claudeUsage(first.result?.usage);
  let status;
  let note;
  let attempt = first;
  let previous = null;
  let bad = [];
  for (let fix = 0; ; fix += 1) {
    const r = attempt.result;
    if (!r || r.is_error || r.subtype !== 'success') {
      status = attempt.refusal ? 'refusal' : 'failed';
      note = r ? `${r.subtype ?? 'error'}${r.result ? `: ${String(r.result).slice(0, 200)}` : ''}` : `exit ${attempt.code}, no result event`;
      break;
    }
    const text = fix ? mergeRepair(previous, r.result, bad) : r.result;
    const parsed = parseAnswer(text, records, chunk);
    if (!parsed.errors.length) { await writeFile(answerFile, text); status = 'ok'; break; }
    if (!parsed.lines) {
      status = attempt.refusal ? 'refusal' : 'unparsed';
      await writeFile(path.join(dir, `${tag}.unparsed.txt`), r.result ?? '');
      break;
    }
    if (fix >= 1 || !r.session_id) { status = 'format'; note = parsed.errors.slice(0, 10).join('; '); await writeFile(path.join(dir, `${tag}.format.txt`), text); break; }
    // Format repair only: a real decision answer with structural errors, resumed once in the same session; only the
    // records with errors are asked again and merged over the previous answer's valid lines.
    previous = r.result;
    bad = errorRecords(parsed.errors);
    attempt = await callClaude({
      cwd, env, logFile: path.join(dir, `${tag}.fix.log`),
      args: [...pins, '--resume', r.session_id, ...(flags.systemPrompt ? ['--system-prompt', card] : [])],
      prompt: `형식 오류: ${parsed.errors.join('; ')}\n위 record(${bad.join(', ')})만 [Sense 수]에 맞춰 출력 형식대로 다시 출력하라. 다른 record는 출력하지 않는다.`,
    });
    usage = addUsage(usage, claudeUsage(attempt.result?.usage));
  }
  const report = { chunk: index, status, ms: Date.now() - started, usage, ...(note ? { note } : {}) };
  await writeFile(path.join(dir, `${tag}.status.json`), `${JSON.stringify(report)}\n`);
  return report;
}

async function runShard(shard, context) {
  const records = await readShardRecords(context.root, shard);
  const chunks = chunkShard(records);
  const dir = path.join(context.work, shard);
  await mkdir(dir, { recursive: true });
  const reports = [];
  for (const [i, chunk] of chunks.entries()) {
    const report = await runChunk({ ...context, records, chunk, index: i + 1, dir });
    reports.push(report);
    console.log(JSON.stringify({ shard, ...report }));
  }
  const ran = reports.filter((r) => r.status !== 'kept');
  // Only stated usage is summed; runs that reported none are counted, never read as 0.
  const usage = { ...ran.reduce((sum, r) => addUsage(sum, r.usage ?? null), null), usage_missing: ran.filter((r) => !r.usage).length };
  const incomplete = reports.filter((r) => r.status !== 'ok' && r.status !== 'kept');
  if (incomplete.length) {
    console.log(JSON.stringify({ shard, saved: false, chunks: chunks.length, incomplete: incomplete.map((r) => `${r.chunk}:${r.status}`), usage }));
    return false;
  }
  const result = await save(context.root, shard, dir);
  console.log(JSON.stringify({ shard, saved: path.relative(context.root, selectionPath(context.root, shard)), chunks: chunks.length, ...result, usage }));
  return true;
}

export async function main(argv) {
  const shards = parseShards(option(argv, '--shards'));
  const effort = option(argv, '--effort');
  if (!effort) throw new Error('--effort is required (use the owner execution profile)');
  const jobs = Math.max(1, Number(option(argv, '--jobs', '1')) || 1);
  const work = path.resolve(option(argv, '--work', path.join(os.tmpdir(), 'typewriter-selection')));
  await mkdir(work, { recursive: true });
  const help = spawnSync('claude', ['--help'], { encoding: 'utf8' });
  if (help.status !== 0) throw new Error('could not run `claude --help`');
  // One-shot chunk calls: 5m cache write as War Room chunk sessions (#7825).
  const env = { ...process.env, FORCE_PROMPT_CACHING_5M: '1' };
  const context = {
    root: REPOSITORY_DIRECTORY, work, cwd: work, env, model: option(argv, '--model', 'opus'), effort,
    card: await readFile(CARD_PATH, 'utf8'), flags: cliArgs(help.stdout, env),
  };
  const queue = [...shards];
  let failed = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (queue.length) if (!(await runShard(queue.shift(), context))) failed += 1;
  }));
  if (failed) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error?.message ?? String(error)); process.exitCode = 1; });
}
