/**
 * Reusable per-batch stage timing ledger (Issue #240, M10-A).
 *
 * Every batch keeps one append-only, text-only JSONL ledger. The command owns
 * all timestamps: `run` wraps a local process and measures it with a
 * monotonic clock; `begin`/`end` bracket stages that run outside this process
 * (a model worker, a human review) and record wall-clock start/end only, so
 * nothing here invents a duration. Concurrent workers are kept as separate
 * spans; aggregation reports their summed worker time apart from the elapsed
 * (interval-union) time. Waits (rate limits, queues) and retries are labelled
 * separately and never merged into active work. Token or cost values are
 * `unavailable` unless a machine-readable source is named.
 *
 *   node scripts/batch/stage-timing.mjs run --batch=ID --stage=ci-fast -- npm run ci:fast
 *   node scripts/batch/stage-timing.mjs begin --batch=ID --stage=authoring --worker=author-1
 *   node scripts/batch/stage-timing.mjs end --batch=ID --id=SPAN [--outcome=ok]
 *   node scripts/batch/stage-timing.mjs amend --batch=ID --id=SPAN --reported-duration-ms=N --reported-duration-source=LABEL
 *   node scripts/batch/stage-timing.mjs publish --batch=ID   (snapshot the ignored working ledger into tracked data/timing/)
 *   node scripts/batch/stage-timing.mjs aggregate --batch=ID [--format=json|markdown]
 */

import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
// Spans are appended while validation runs, and the build provenance refuses a
// dirty worktree, so the live ledger lives in ignored working space and is
// snapshotted into tracked `data/timing/` with `publish` at a commit boundary.
export const TIMING_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/reference/timing');
export const TRACKED_TIMING_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/timing');
export const TIMING_SCHEMA_VERSION = 1;

export const STAGES = Object.freeze([
  'discovery',
  'evidence',
  'authoring',
  'review',
  'admission',
  'derived-refresh',
  'validation',
  'ci-fast',
  'ci-normal',
  'other',
]);
export const OUTCOMES = Object.freeze(['ok', 'failed', 'retry', 'rework']);
export const WAIT_KINDS = Object.freeze(['rate-limit', 'queue', 'other']);
const BATCH_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,95}$/u;

export class StageTimingError extends Error {
  constructor(message, code = 'STAGE_TIMING_ERROR') {
    super(message);
    this.name = 'StageTimingError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new StageTimingError(message, code);
}

export function ledgerPath(batchId, directory = TIMING_DIRECTORY) {
  if (!BATCH_ID_PATTERN.test(batchId ?? '')) {
    fail('--batch must be a lowercase hyphenated batch id', 'INVALID_BATCH');
  }
  return path.join(directory, `${batchId}.jsonl`);
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: REPOSITORY_DIRECTORY,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unavailable';
  }
}

export function environmentLabel() {
  return {
    node: process.version,
    platform: `${os.platform()}-${os.arch()}`,
    cpu_count: os.cpus().length,
  };
}

function requireStage(stage) {
  if (!STAGES.includes(stage)) fail(`--stage must be one of ${STAGES.join(', ')}`, 'INVALID_STAGE');
  return stage;
}

function requireOutcome(outcome = 'ok') {
  if (!OUTCOMES.includes(outcome)) fail(`--outcome must be one of ${OUTCOMES.join(', ')}`, 'INVALID_OUTCOME');
  return outcome;
}

function optionalText(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 160 || /[\r\n]/u.test(value)) {
    fail(`${label} must be a single-line label of at most 160 characters`, 'INVALID_LABEL');
  }
  return value;
}

async function append(batchId, event, directory) {
  await mkdir(directory, { recursive: true });
  await appendFile(ledgerPath(batchId, directory), `${JSON.stringify(event)}\n`, 'utf8');
}

function baseEvent(batchId, options) {
  const kind = options.kind ?? 'work';
  if (!['work', 'wait'].includes(kind)) fail('--kind must be work or wait', 'INVALID_KIND');
  if (kind === 'wait' && !WAIT_KINDS.includes(options.waitKind ?? '')) {
    fail(`a wait span needs --wait-kind (${WAIT_KINDS.join(', ')})`, 'INVALID_WAIT');
  }
  const attempt = options.attempt === undefined ? 1 : Number(options.attempt);
  if (!Number.isSafeInteger(attempt) || attempt < 1) fail('--attempt must be a positive integer', 'INVALID_ATTEMPT');
  return {
    v: TIMING_SCHEMA_VERSION,
    batch_id: batchId,
    stage: requireStage(options.stage),
    kind,
    ...(kind === 'wait' ? { wait_kind: options.waitKind } : {}),
    worker: optionalText(options.worker, '--worker') ?? 'main',
    attempt,
    ...(options.label ? { label: optionalText(options.label, '--label') } : {}),
    ...(options.model ? { model: optionalText(options.model, '--model') } : {}),
    git_sha: gitSha(),
  };
}

export async function beginSpan(batchId, options, directory = TIMING_DIRECTORY) {
  const id = `s-${randomBytes(4).toString('hex')}`;
  await append(batchId, { ...baseEvent(batchId, options), event: 'begin', id, start: new Date().toISOString() }, directory);
  return id;
}

function reportedDuration(options) {
  if (options.reportedDurationMs === undefined) return {};
  const value = Number(options.reportedDurationMs);
  if (!Number.isFinite(value) || value <= 0) fail('--reported-duration-ms must be a positive number', 'INVALID_DURATION');
  return {
    reported_duration_ms: value,
    reported_duration_source: optionalText(options.reportedDurationSource ?? 'unavailable', '--reported-duration-source'),
  };
}

/**
 * A background worker's own machine-reported run time. The recorded end is
 * the moment this process noticed completion, which can lag the worker's real
 * end; an amendment attaches the worker-reported duration to an existing span
 * without rewriting the append-only ledger.
 */
export async function amendSpan(batchId, id, options, directory = TIMING_DIRECTORY) {
  const events = await readLedger(batchId, directory);
  if (!events.some((event) => event.event === 'end' && event.id === id)) fail(`no closed span ${id} in ${batchId}`, 'UNKNOWN_SPAN');
  const reported = reportedDuration(options);
  if (reported.reported_duration_ms === undefined) fail('amend needs --reported-duration-ms', 'INVALID_DURATION');
  await append(batchId, { v: TIMING_SCHEMA_VERSION, event: 'amend', id, ...reported }, directory);
}

export async function endSpan(batchId, id, options = {}, directory = TIMING_DIRECTORY) {
  const spans = await readLedger(batchId, directory);
  const begin = spans.find((event) => event.event === 'begin' && event.id === id);
  if (!begin) fail(`no open span ${id} in ${batchId}`, 'UNKNOWN_SPAN');
  if (spans.some((event) => event.event === 'end' && event.id === id)) fail(`span ${id} is already closed`, 'CLOSED_SPAN');
  const end = new Date();
  await append(batchId, {
    v: TIMING_SCHEMA_VERSION,
    event: 'end',
    id,
    end: end.toISOString(),
    clock: 'wall',
    outcome: requireOutcome(options.outcome),
    ...(options.note ? { note: optionalText(options.note, '--note') } : {}),
    ...reportedDuration(options),
    ...(options.tokens ? { tokens: { value: optionalText(options.tokens, '--tokens'), source: optionalText(options.tokensSource ?? 'unavailable', '--tokens-source') } } : {}),
  }, directory);
  return end.toISOString();
}

export async function runTimed(batchId, options, command, directory = TIMING_DIRECTORY) {
  if (command.length === 0) fail('run needs a command after --', 'MISSING_COMMAND');
  const id = `s-${randomBytes(4).toString('hex')}`;
  const startIso = new Date().toISOString();
  const startTick = performance.now();
  await append(batchId, {
    ...baseEvent(batchId, options),
    event: 'begin',
    id,
    start: startIso,
    command: command.slice(0, 4).join(' ').slice(0, 160),
  }, directory);
  const exitCode = await new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { cwd: REPOSITORY_DIRECTORY, stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('close', (code, signal) => resolve(signal ? 128 : code ?? 1));
  });
  const durationMs = Math.round((performance.now() - startTick) * 1000) / 1000;
  await append(batchId, {
    v: TIMING_SCHEMA_VERSION,
    event: 'end',
    id,
    end: new Date().toISOString(),
    clock: 'monotonic',
    duration_ms: durationMs,
    exit_code: exitCode,
    outcome: exitCode === 0 ? 'ok' : 'failed',
  }, directory);
  return { exitCode, durationMs, id };
}

export async function readLedger(batchId, directory = TIMING_DIRECTORY) {
  let text;
  try {
    text = await readFile(ledgerPath(batchId, directory), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      return fail(`${batchId} ledger line ${index + 1} is not JSON`, 'INVALID_LEDGER');
    }
  });
}

/** Prefer the worker's own reported run time over the observer's end timestamp. */
function applyReportedDuration(span, source) {
  span.recorded_end_ms = span.recorded_end_ms ?? span.end_ms;
  span.reported_duration_ms = source.reported_duration_ms;
  span.reported_duration_source = source.reported_duration_source;
  span.clock = 'reported';
  span.duration_ms = source.reported_duration_ms;
  span.end_ms = span.start_ms + source.reported_duration_ms;
}

/** Pair begin/end events into closed spans and list the still-open ones. */
export function pairSpans(events) {
  const begins = new Map();
  const closed = new Set();
  const spans = [];
  const open = [];
  for (const event of events) {
    if (event.event === 'begin') {
      if (begins.has(event.id)) fail(`duplicate span id ${event.id}`, 'INVALID_LEDGER');
      begins.set(event.id, event);
    } else if (event.event === 'end') {
      const begin = begins.get(event.id);
      if (!begin) fail(`end without begin for ${event.id}`, 'INVALID_LEDGER');
      if (closed.has(event.id)) fail(`span ${event.id} closed twice`, 'INVALID_LEDGER');
      closed.add(event.id);
      const startMs = Date.parse(begin.start);
      const endMs = Date.parse(event.end);
      if (!(endMs >= startMs)) fail(`span ${event.id} ends before it starts`, 'INVALID_LEDGER');
      const span = {
        ...begin,
        ...event,
        event: undefined,
        start_ms: startMs,
        end_ms: endMs,
        duration_ms: event.clock === 'monotonic' ? event.duration_ms : endMs - startMs,
      };
      if (event.reported_duration_ms !== undefined) applyReportedDuration(span, event);
      spans.push(span);
    } else if (event.event === 'amend') {
      const target = spans.find((candidate) => candidate.id === event.id);
      if (!target) fail(`amend without a closed span for ${event.id}`, 'INVALID_LEDGER');
      applyReportedDuration(target, event);
    } else {
      fail(`unknown event type ${event.event}`, 'INVALID_LEDGER');
    }
  }
  for (const begin of begins.values()) if (!closed.has(begin.id)) open.push(begin);
  return { spans, open };
}

export function intervalUnionMs(intervals) {
  const sorted = intervals.filter(([start, end]) => end > start).sort((left, right) => left[0] - right[0]);
  let total = 0;
  let currentStart = null;
  let currentEnd = null;
  for (const [start, end] of sorted) {
    if (currentEnd === null || start > currentEnd) {
      if (currentEnd !== null) total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    } else if (end > currentEnd) {
      currentEnd = end;
    }
  }
  if (currentEnd !== null) total += currentEnd - currentStart;
  return total;
}

const round = (value) => Math.round(value * 1000) / 1000;

/**
 * Elapsed vs. summed time. `active_ms` is the union of work spans (concurrent
 * workers counted once); `worker_ms` is their plain sum; `wait_ms` is the
 * union of declared waits; `unattributed_ms` is wall time covered by no span.
 */
export function aggregateSpans(spans) {
  const work = spans.filter((span) => span.kind === 'work');
  const waits = spans.filter((span) => span.kind === 'wait');
  const interval = (span) => [span.start_ms, span.end_ms];
  const summarize = (list) => ({
    spans: list.length,
    worker_ms: round(list.reduce((sum, span) => sum + span.duration_ms, 0)),
    active_ms: round(intervalUnionMs(list.map(interval))),
    max_span_ms: round(list.reduce((max, span) => Math.max(max, span.duration_ms), 0)),
    failed_spans: list.filter((span) => span.outcome === 'failed').length,
    retry_spans: list.filter((span) => span.attempt > 1 || span.outcome === 'retry' || span.outcome === 'rework').length,
    retry_worker_ms: round(list
      .filter((span) => span.attempt > 1 || span.outcome === 'retry' || span.outcome === 'rework')
      .reduce((sum, span) => sum + span.duration_ms, 0)),
  });
  const stages = {};
  for (const stage of STAGES) {
    const inStage = work.filter((span) => span.stage === stage);
    if (inStage.length > 0) stages[stage] = summarize(inStage);
  }
  const everything = spans.map(interval);
  const wallMs = spans.length === 0
    ? 0
    : Math.max(...spans.map((span) => span.end_ms)) - Math.min(...spans.map((span) => span.start_ms));
  const waitByKind = {};
  for (const kind of WAIT_KINDS) {
    const ofKind = waits.filter((span) => span.wait_kind === kind);
    if (ofKind.length > 0) waitByKind[kind] = { spans: ofKind.length, ms: round(intervalUnionMs(ofKind.map(interval))) };
  }
  const covered = intervalUnionMs(everything);
  return {
    first_start: spans.length === 0 ? null : new Date(Math.min(...spans.map((span) => span.start_ms))).toISOString(),
    last_end: spans.length === 0 ? null : new Date(Math.max(...spans.map((span) => span.end_ms))).toISOString(),
    wall_ms: round(wallMs),
    active_ms: round(intervalUnionMs(work.map(interval))),
    worker_ms: round(work.reduce((sum, span) => sum + span.duration_ms, 0)),
    wait_ms: round(intervalUnionMs(waits.map(interval))),
    wait_by_kind: waitByKind,
    unattributed_ms: round(Math.max(0, wallMs - covered)),
    retry_spans: work.filter((span) => span.attempt > 1 || span.outcome === 'retry' || span.outcome === 'rework').length,
    failed_spans: work.filter((span) => span.outcome === 'failed').length,
    stages,
  };
}

/** Throughput from an admitted-record count: per hour, and minutes per 100. */
export function throughput(totals, netAdmitted) {
  if (!Number.isSafeInteger(netAdmitted) || netAdmitted <= 0) return { net_admitted: netAdmitted ?? null };
  const perHour = (milliseconds) => (milliseconds > 0 ? round((netAdmitted * 3_600_000) / milliseconds) : null);
  const minutesPer100 = (milliseconds) => (milliseconds > 0 ? round((milliseconds / 60_000 / netAdmitted) * 100) : null);
  return {
    net_admitted: netAdmitted,
    per_hour_wall: perHour(totals.wall_ms),
    per_hour_active: perHour(totals.active_ms),
    minutes_per_100_wall: minutesPer100(totals.wall_ms),
    minutes_per_100_active: minutesPer100(totals.active_ms),
  };
}

/**
 * Sum only token values that carry a machine-reported source. Spans without
 * one (every main-agent stage) are counted as unavailable, never estimated.
 */
export function summarizeTokens(spans) {
  const reported = spans.filter((span) => span.tokens && Number.isFinite(Number(span.tokens.value))
    && span.tokens.source && span.tokens.source !== 'unavailable');
  return {
    reported_total: reported.reduce((sum, span) => sum + Number(span.tokens.value), 0),
    reported_spans: reported.length,
    spans_without_token_data: spans.length - reported.length,
    note: 'subagent/worker tokens only where a machine-reported value was recorded; main-agent tokens are unavailable',
  };
}

export async function aggregateBatch(batchId, { netAdmitted, directory = TIMING_DIRECTORY } = {}) {
  const { spans, open } = pairSpans(await readLedger(batchId, directory));
  const totals = aggregateSpans(spans);
  return {
    schema_version: TIMING_SCHEMA_VERSION,
    batch_id: batchId,
    span_count: spans.length,
    open_span_ids: open.map(({ id }) => id),
    totals,
    throughput: throughput(totals, netAdmitted),
    tokens: summarizeTokens(spans),
  };
}

/** Copy the working ledger into tracked space, refusing a ledger with open spans. */
export async function publishLedger(batchId, { directory = TIMING_DIRECTORY, trackedDirectory = TRACKED_TIMING_DIRECTORY } = {}) {
  const events = await readLedger(batchId, directory);
  if (events.length === 0) fail(`no ledger for ${batchId}`, 'UNKNOWN_BATCH');
  const { open } = pairSpans(events);
  if (open.length > 0) fail(`${batchId} has open spans: ${open.map(({ id }) => id).join(', ')}`, 'OPEN_SPANS');
  await mkdir(trackedDirectory, { recursive: true });
  const target = ledgerPath(batchId, trackedDirectory);
  await writeFile(target, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
  return target;
}

export async function listBatchLedgers(directory = TIMING_DIRECTORY) {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -'.jsonl'.length)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

const seconds = (milliseconds) => (milliseconds / 1000).toFixed(1);
export function renderMarkdown(aggregate) {
  const { totals } = aggregate;
  const lines = [
    `### ${aggregate.batch_id}`,
    '',
    `Wall ${seconds(totals.wall_ms)} s · active (union) ${seconds(totals.active_ms)} s · summed worker ${seconds(totals.worker_ms)} s · declared wait ${seconds(totals.wait_ms)} s · unattributed ${seconds(totals.unattributed_ms)} s · retry spans ${totals.retry_spans}`,
    '',
    '| Stage | Spans | Worker s | Active s | Retry spans | Failed |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const stage of STAGES) {
    const row = totals.stages[stage];
    if (row) lines.push(`| ${stage} | ${row.spans} | ${seconds(row.worker_ms)} | ${seconds(row.active_ms)} | ${row.retry_spans} | ${row.failed_spans} |`);
  }
  return `${lines.join('\n')}\n`;
}

/** One row per span: the raw evidence behind every aggregate, in start order. */
export function renderSpansMarkdown(spans) {
  const rows = [...spans].sort((left, right) => left.start_ms - right.start_ms).map((span) => {
    const method = span.clock === 'monotonic' ? 'monotonic' : span.clock === 'reported' ? 'worker-reported' : 'wall-clock';
    return `| ${span.stage} | ${span.label ?? ''} | ${span.worker} | ${span.attempt} | ${span.outcome}${span.kind === 'wait' ? ` (wait: ${span.wait_kind})` : ''} | ${(span.duration_ms / 1000).toFixed(1)} | ${method} |`;
  });
  return ['| Stage | Label | Worker | Attempt | Outcome | Seconds | Method |', '| --- | --- | --- | ---: | --- | ---: | --- |', ...rows].join('\n') + '\n';
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const separator = rest.indexOf('--');
  const optionArgs = separator === -1 ? rest : rest.slice(0, separator);
  const trailing = separator === -1 ? [] : rest.slice(separator + 1);
  const options = {};
  for (const argument of optionArgs) {
    const match = /^--([a-z-]+)=(.*)$/u.exec(argument);
    if (!match) fail(`arguments must use --name=value form (received ${argument})`, 'INVALID_ARGUMENT');
    const key = match[1].replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    options[key] = match[2];
  }
  return { command, options, trailing };
}

async function main(argv) {
  const { command, options, trailing } = parseCli(argv);
  const batchId = options.batch;
  if (command === 'run') {
    const { exitCode, durationMs, id } = await runTimed(batchId, options, trailing);
    process.stderr.write(`[stage-timing] ${id} ${options.stage} exit=${exitCode} ${(durationMs / 1000).toFixed(2)}s\n`);
    return exitCode;
  }
  if (command === 'begin') {
    process.stdout.write(`${await beginSpan(batchId, options)}\n`);
    return 0;
  }
  if (command === 'end') {
    process.stdout.write(`${await endSpan(batchId, options.id, options)}\n`);
    return 0;
  }
  if (command === 'publish') {
    process.stdout.write(`${path.relative(REPOSITORY_DIRECTORY, await publishLedger(batchId))}\n`);
    return 0;
  }
  if (command === 'amend') {
    await amendSpan(batchId, options.id, options);
    return 0;
  }
  if (command === 'aggregate') {
    const netAdmitted = options.netAdmitted === undefined ? undefined : Number(options.netAdmitted);
    const aggregate = await aggregateBatch(batchId, { netAdmitted });
    if (options.format === 'spans') {
      process.stdout.write(renderSpansMarkdown(pairSpans(await readLedger(batchId)).spans));
      return 0;
    }
    process.stdout.write(options.format === 'markdown' ? renderMarkdown(aggregate) : `${JSON.stringify(aggregate, null, 2)}\n`);
    return 0;
  }
  fail('usage: stage-timing.mjs run|begin|end|aggregate --batch=ID ...', 'USAGE');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
