import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  aggregateBatch,
  amendSpan,
  aggregateSpans,
  beginSpan,
  endSpan,
  intervalUnionMs,
  ledgerPath,
  pairSpans,
  publishLedger,
  publishableEvent,
  readLedger,
  runTimed,
  throughput,
} from './stage-timing.mjs';

const BATCH = 'timing-regression-batch';
const span = (stage, startSeconds, endSeconds, extra = {}) => ({
  stage,
  kind: 'work',
  attempt: 1,
  outcome: 'ok',
  start_ms: startSeconds * 1000,
  end_ms: endSeconds * 1000,
  duration_ms: (endSeconds - startSeconds) * 1000,
  ...extra,
});

test('interval union counts overlapping workers once', () => {
  assert.equal(intervalUnionMs([[0, 10], [5, 20], [30, 40]]), 30);
  assert.equal(intervalUnionMs([[0, 10], [2, 4]]), 10);
  assert.equal(intervalUnionMs([]), 0);
});

test('concurrent workers separate elapsed from summed worker time', () => {
  const totals = aggregateSpans([
    span('authoring', 0, 100, { worker: 'a' }),
    span('authoring', 10, 90, { worker: 'b' }),
    span('review', 100, 160),
  ]);
  assert.equal(totals.wall_ms, 160_000);
  assert.equal(totals.active_ms, 160_000);
  assert.equal(totals.worker_ms, 240_000);
  assert.equal(totals.stages.authoring.active_ms, 100_000);
  assert.equal(totals.stages.authoring.worker_ms, 180_000);
  assert.equal(totals.unattributed_ms, 0);
});

test('waits, retries and unattributed time stay out of active work', () => {
  const totals = aggregateSpans([
    span('authoring', 0, 50),
    { ...span('authoring', 50, 80), kind: 'wait', wait_kind: 'rate-limit', duration_ms: 30_000 },
    span('authoring', 80, 120, { attempt: 2 }),
    span('ci-fast', 200, 220),
  ]);
  assert.equal(totals.active_ms, 110_000);
  assert.equal(totals.wait_ms, 30_000);
  assert.deepEqual(totals.wait_by_kind, { 'rate-limit': { spans: 1, ms: 30_000 } });
  assert.equal(totals.retry_spans, 1);
  assert.equal(totals.stages.authoring.retry_worker_ms, 40_000);
  assert.equal(totals.unattributed_ms, 80_000);
  assert.equal(totals.wall_ms, 220_000);
});

test('throughput is derived only from a positive admitted count', () => {
  const totals = { wall_ms: 7_200_000, active_ms: 3_600_000 };
  assert.deepEqual(throughput(totals, 200), {
    net_admitted: 200,
    per_hour_wall: 100,
    per_hour_active: 200,
    minutes_per_100_wall: 60,
    minutes_per_100_active: 30,
  });
  assert.deepEqual(throughput(totals, 0), { net_admitted: 0 });
  assert.deepEqual(throughput(totals, undefined), { net_admitted: null });
});

test('ledger pairs begin/end events and rejects malformed or invalid input', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stage-timing-'));
  try {
    const first = await beginSpan(BATCH, { stage: 'authoring', worker: 'author-1', model: 'test-model' }, directory);
    await endSpan(BATCH, first, { outcome: 'ok' }, directory);
    await assert.rejects(() => endSpan(BATCH, first, {}, directory), /already closed/u);
    await assert.rejects(() => endSpan(BATCH, 's-missing', {}, directory), /no open span/u);
    await assert.rejects(() => beginSpan(BATCH, { stage: 'not-a-stage' }, directory), /--stage must be one of/u);
    await assert.rejects(() => beginSpan(BATCH, { stage: 'review', kind: 'wait' }, directory), /needs --wait-kind/u);
    await assert.rejects(() => beginSpan(BATCH, { stage: 'review', attempt: '0' }, directory), /positive integer/u);
    await assert.rejects(() => beginSpan('Bad Batch', { stage: 'review' }, directory), /lowercase hyphenated/u);
    const open = await beginSpan(BATCH, { stage: 'review' }, directory);
    const { spans, open: stillOpen } = pairSpans(await readLedger(BATCH, directory));
    assert.equal(spans.length, 1);
    assert.deepEqual(stillOpen.map(({ id }) => id), [open]);
    assert.equal(spans[0].worker, 'author-1');
    const aggregate = await aggregateBatch(BATCH, { netAdmitted: 10, directory });
    assert.deepEqual(aggregate.tokens.reported_total, 0);
    assert.equal(aggregate.tokens.spans_without_token_data, 1);
    assert.deepEqual(aggregate.open_span_ids, [open]);
    await appendFile(ledgerPath(BATCH, directory), 'not json\n');
    await assert.rejects(() => readLedger(BATCH, directory), /not JSON/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('run measures a process on the monotonic clock and records its exit status', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stage-timing-'));
  try {
    const ok = await runTimed(BATCH, { stage: 'validation' }, [process.execPath, '-e', 'setTimeout(() => {}, 30)'], directory);
    const bad = await runTimed(BATCH, { stage: 'validation', attempt: '2' }, [process.execPath, '-e', 'process.exit(3)'], directory);
    assert.equal(ok.exitCode, 0);
    assert.equal(bad.exitCode, 3);
    const { spans } = pairSpans(await readLedger(BATCH, directory));
    assert.equal(spans[0].clock, 'monotonic');
    assert.ok(spans[0].duration_ms >= 25);
    assert.equal(spans[1].outcome, 'failed');
    assert.equal(spans[1].exit_code, 3);
    assert.equal(spans[1].attempt, 2);
    const text = await readFile(ledgerPath(BATCH, directory), 'utf8');
    assert.ok(!/token|cost/iu.test(text), 'no invented token or cost data');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a worker-reported duration amends a closed span without rewriting the ledger', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stage-timing-'));
  try {
    const id = await beginSpan(BATCH, { stage: 'review', worker: 'reviewer-1' }, directory);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await endSpan(BATCH, id, { reportedDurationMs: '5', reportedDurationSource: 'test-source' }, directory);
    const [reported] = pairSpans(await readLedger(BATCH, directory)).spans;
    assert.equal(reported.clock, 'reported');
    assert.equal(reported.duration_ms, 5);
    assert.equal(reported.end_ms - reported.start_ms, 5);
    assert.ok(reported.recorded_end_ms - reported.start_ms >= 15, 'the observed end is preserved');

    const late = await beginSpan(BATCH, { stage: 'review' }, directory);
    await endSpan(BATCH, late, {}, directory);
    const before = await readFile(ledgerPath(BATCH, directory), 'utf8');
    await amendSpan(BATCH, late, { reportedDurationMs: '3', reportedDurationSource: 'test-source' }, directory);
    const after = await readFile(ledgerPath(BATCH, directory), 'utf8');
    assert.ok(after.startsWith(before), 'the ledger is append-only');
    const spans = pairSpans(await readLedger(BATCH, directory)).spans;
    assert.equal(spans.find((span) => span.id === late).duration_ms, 3);
    await assert.rejects(() => amendSpan(BATCH, 's-nope', { reportedDurationMs: '3' }, directory), /no closed span/u);
    await assert.rejects(() => amendSpan(BATCH, late, {}, directory), /needs --reported-duration-ms/u);
    await assert.rejects(() => amendSpan(BATCH, late, { reportedDurationMs: '-4' }, directory), /positive number/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('publish snapshots a complete ledger and refuses one with open spans', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stage-timing-'));
  const tracked = await mkdtemp(path.join(tmpdir(), 'stage-timing-tracked-'));
  try {
    await assert.rejects(() => publishLedger(BATCH, { directory, trackedDirectory: tracked }), /no ledger/u);
    const open = await beginSpan(BATCH, { stage: 'review' }, directory);
    await assert.rejects(() => publishLedger(BATCH, { directory, trackedDirectory: tracked }), /open spans/u);
    await endSpan(BATCH, open, {}, directory);
    const target = await publishLedger(BATCH, { directory, trackedDirectory: tracked });
    assert.equal(await readFile(target, 'utf8'), await readFile(ledgerPath(BATCH, directory), 'utf8'));
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(tracked, { recursive: true, force: true });
  }
});

test('a published ledger keeps only the executable name and refuses absolute paths', async () => {
  assert.equal(publishableEvent({ id: 's-1', command: '/private/tmp/x/discover.sh 12 --flag' }).command, 'discover.sh');
  assert.equal(publishableEvent({ id: 's-2', command: 'npm run ci:normal' }).command, 'npm');
  assert.throws(() => publishableEvent({ id: 's-3', note: 'ran in /Users/someone/repo' }), /absolute path/u);
  assert.throws(() => publishableEvent({ id: 's-4', label: 'x', note: 'see /private/tmp/a' }), /absolute path/u);
  for (const note of ['at /workspace/repo/out', 'in /mnt/data/x', 'see /Volumes/Disk/a', 'on \\\\server\\share\\x', 'C:\\Users\\a\\b', 'D:/work/x', 'file:///srv/x', '~/notes/x']) {
    assert.throws(() => publishableEvent({ id: 's-6', note }), /absolute path/u, note);
  }
  assert.doesNotThrow(() => publishableEvent({ id: 's-5', label: 'ci-normal-checkpoint-11042', note: 'data/reference ok' }));
  const directory = await mkdtemp(path.join(tmpdir(), 'stage-timing-'));
  const tracked = await mkdtemp(path.join(tmpdir(), 'stage-timing-tracked-'));
  try {
    const id = await beginSpan(BATCH, { stage: 'review' }, directory);
    await endSpan(BATCH, id, { note: 'wrote /Users/someone/out.json' }, directory);
    await assert.rejects(() => publishLedger(BATCH, { directory, trackedDirectory: tracked }), /absolute path/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(tracked, { recursive: true, force: true });
  }
});

test('token totals count only machine-reported values and never estimate the rest', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stage-timing-'));
  try {
    const first = await beginSpan(BATCH, { stage: 'authoring', worker: 'a' }, directory);
    await endSpan(BATCH, first, { tokens: '1200', tokensSource: 'test-usage' }, directory);
    const second = await beginSpan(BATCH, { stage: 'review', worker: 'main' }, directory);
    await endSpan(BATCH, second, {}, directory);
    const { tokens } = await aggregateBatch(BATCH, { directory });
    assert.equal(tokens.reported_total, 1200);
    assert.equal(tokens.reported_spans, 1);
    assert.equal(tokens.spans_without_token_data, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
