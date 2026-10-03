import { readFileSync } from 'node:fs';

// The ledger is the single source of truth for SQLite-build accounting in one
// CI run. Every process (the runner, its in-process checks, spawned commands and
// nested validators) appends events to the same file through
// `markSQLiteBuild` and the process-metrics import hook. Counts are derived
// only from those events and bound to the canonical revision computed from the
// canonical bytes, never from caller-provided labels.

export const CI_PHASE_ENV = 'TYPEWRITER_CI_PHASE';
export const NORMAL_PHASE = 'normal';
export const DEEP_PHASE = 'deep';
const PHASES = new Set([NORMAL_PHASE, DEEP_PHASE]);

export class BuildLedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BuildLedgerError';
  }
}

function fail(message) {
  throw new BuildLedgerError(message);
}

function parseEvent(line, lineNumber) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    fail(`SQLite build ledger line ${lineNumber} is not valid JSON`);
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    fail(`SQLite build ledger line ${lineNumber} is not an object`);
  }
  if (!Number.isInteger(event.pid) || event.pid <= 0) {
    fail(`SQLite build ledger line ${lineNumber} has no valid pid`);
  }
  if (event.type === 'process') {
    if (!Number.isFinite(event.peak_rss_kb) || event.peak_rss_kb < 0) {
      fail(`SQLite build ledger line ${lineNumber} has an invalid process peak RSS`);
    }
    return event;
  }
  if (event.type === 'sqlite-build') {
    if (!Number.isInteger(event.count) || event.count < 1) {
      fail(`SQLite build ledger line ${lineNumber} has an invalid build count`);
    }
    if (event.canonical_revision !== null && typeof event.canonical_revision !== 'string') {
      fail(`SQLite build ledger line ${lineNumber} has an invalid canonical revision`);
    }
    if (typeof event.canonical_directory !== 'string') {
      fail(`SQLite build ledger line ${lineNumber} has no canonical directory`);
    }
    if (!PHASES.has(event.phase)) {
      fail(`SQLite build ledger line ${lineNumber} has an unknown CI phase`);
    }
    return event;
  }
  return fail(`SQLite build ledger line ${lineNumber} has unknown event type`);
}

export function readBuildLedger(ledgerPath) {
  let contents;
  try {
    contents = readFileSync(ledgerPath, 'utf8');
  } catch (error) {
    return fail(`SQLite build ledger is unreadable: ${error.message}`);
  }
  const events = [];
  for (const [index, line] of contents.split('\n').entries()) {
    if (line) events.push(parseEvent(line, index + 1));
  }
  return events;
}

// Scoped counters. `current_revision_*` counts normal-phase builds of the exact
// current canonical revision (the gated quantity). Deep/historical-phase builds
// and builds of other (fixture) revisions are accounted for separately.
export function summarizeBuildLedger(events, { canonicalRevision, parentPid }) {
  if (typeof canonicalRevision !== 'string' || canonicalRevision.length === 0) {
    fail('SQLite build accounting requires the current canonical revision');
  }
  const summary = {
    process_count: 0,
    peak_rss_kb: 0,
    parent_current_revision_sqlite_build_count: 0,
    child_current_revision_sqlite_build_count: 0,
    current_revision_sqlite_build_count: 0,
    deep_current_revision_sqlite_build_count: 0,
    other_revision_sqlite_build_count: 0,
    all_sqlite_build_count: 0,
    parent_all_current_revision_sqlite_build_count: 0,
    child_sqlite_build_count: 0,
  };
  for (const event of events) {
    if (event.type === 'process') {
      summary.process_count += 1;
      summary.peak_rss_kb = Math.max(summary.peak_rss_kb, event.peak_rss_kb);
      continue;
    }
    const isParent = event.pid === parentPid;
    const isCurrent = event.canonical_revision === canonicalRevision;
    summary.all_sqlite_build_count += event.count;
    if (!isParent) summary.child_sqlite_build_count += event.count;
    if (!isCurrent) {
      summary.other_revision_sqlite_build_count += event.count;
      continue;
    }
    if (isParent) summary.parent_all_current_revision_sqlite_build_count += event.count;
    if (event.phase !== NORMAL_PHASE) {
      summary.deep_current_revision_sqlite_build_count += event.count;
      continue;
    }
    summary.current_revision_sqlite_build_count += event.count;
    if (isParent) summary.parent_current_revision_sqlite_build_count += event.count;
    else summary.child_current_revision_sqlite_build_count += event.count;
  }
  return summary;
}

// Per-command guard: a spawned command must (a) leave the ledger readable and
// (b) have registered at least one process through the metrics hook. Otherwise
// a missing hook would silently report zero child builds.
export function assertChildEvidenceAdvanced(before, after, commandLabel) {
  if (after.process_count <= before.process_count) {
    fail(
      `${commandLabel}: no child process metrics were recorded; the SQLite build `
      + 'ledger hook was omitted, so child build counts cannot be trusted',
    );
  }
}

export function assertNoChildCurrentRevisionBuild(summary, commandLabel) {
  if (summary.child_current_revision_sqlite_build_count > 0) {
    fail(
      `${commandLabel}: a child process built the exact current canonical revision `
      + `(${summary.child_current_revision_sqlite_build_count} child build(s)); normal CI `
      + 'must reuse the single shared current-revision SQLite artifact',
    );
  }
}

// Central normal-level invariant. `parentContextBuildCount` is the in-memory
// counter of the shared canonical context and must agree with the ledger.
export function assertSingleCurrentRevisionBuild(summary, {
  stage,
  parentContextBuildCount,
}) {
  const problems = [];
  if (summary.parent_current_revision_sqlite_build_count !== 1) {
    problems.push(
      `parent_current_revision_sqlite_build_count=${summary.parent_current_revision_sqlite_build_count} (expected 1)`,
    );
  }
  if (summary.child_current_revision_sqlite_build_count !== 0) {
    problems.push(
      `child_current_revision_sqlite_build_count=${summary.child_current_revision_sqlite_build_count} (expected 0)`,
    );
  }
  if (summary.current_revision_sqlite_build_count !== 1) {
    problems.push(
      `current_revision_sqlite_build_count=${summary.current_revision_sqlite_build_count} (expected 1)`,
    );
  }
  if (
    parentContextBuildCount !== undefined
    && parentContextBuildCount !== summary.parent_all_current_revision_sqlite_build_count
  ) {
    problems.push(
      `shared context counted ${parentContextBuildCount} parent build(s) but the ledger recorded `
      + `${summary.parent_all_current_revision_sqlite_build_count}`,
    );
  }
  if (problems.length > 0) {
    fail(
      `Normal CI must build SQLite for the exact current canonical revision exactly once `
      + `(${stage}): ${problems.join('; ')}`,
    );
  }
}

export function buildCountEvidence(summary) {
  return {
    parent_current_revision_sqlite_build_count:
      summary.parent_current_revision_sqlite_build_count,
    child_current_revision_sqlite_build_count:
      summary.child_current_revision_sqlite_build_count,
    current_revision_sqlite_build_count: summary.current_revision_sqlite_build_count,
    deep_current_revision_sqlite_build_count:
      summary.deep_current_revision_sqlite_build_count,
    other_revision_sqlite_build_count: summary.other_revision_sqlite_build_count,
    all_sqlite_build_count: summary.all_sqlite_build_count,
    child_sqlite_build_count: summary.child_sqlite_build_count,
  };
}
