import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

function supervisorDatabasePath(worktree) {
  try {
    const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const commonDirectory = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: path.resolve(worktree),
      env: gitEnvironment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!path.isAbsolute(commonDirectory)) {
      throw new Error('not a Typewriter Git common directory');
    }
    const realCommonDirectory = realpathSync(commonDirectory);
    if (path.basename(realCommonDirectory) !== '.git') throw new Error('not a Typewriter Git common directory');
    const repositoryRoot = path.dirname(realCommonDirectory);
    return path.join(repositoryRoot, 'tools/warroom/.local/warroom.db');
  } catch {
    throw new Error('Supervisor retry state is unavailable; technical skip is Supervisor-only');
  }
}

/** Read retry state only from the War Room database anchored to this worktree's shared Git repository. */
export function readSupervisorRetryBudget({ method, model, shard, batch, worktree, retryKeyForBatchId, retryKind, minimum }) {
  if (typeof retryKeyForBatchId !== 'function' || !Number.isSafeInteger(minimum) || minimum < 1) {
    throw new Error('Supervisor retry state is unavailable; technical skip is Supervisor-only');
  }
  let database;
  try {
    database = new DatabaseSync(supervisorDatabasePath(worktree), { readOnly: true });
    const owner = database.prepare(
      'SELECT id, method, producer, shard, batch, worktree, session_id FROM batches '
      + 'WHERE method=? AND producer=? AND shard=? AND batch=? AND worktree=?',
    ).get(method, model, String(shard), String(batch), path.resolve(worktree));
    if (!owner || owner.method !== method || owner.producer !== model || owner.shard !== String(shard)
      || owner.batch !== String(batch) || path.resolve(owner.worktree) !== path.resolve(worktree)
      || typeof owner.session_id !== 'string' || !owner.session_id) {
      throw new Error('Supervisor retry state is not bound to this active batch and worktree');
    }
    const id = Number(owner.id);
    const retryKey = retryKeyForBatchId(id);
    if (!Number.isSafeInteger(id) || id < 1 || typeof retryKey !== 'string' || !retryKey) {
      throw new Error('Supervisor retry state is unavailable; technical skip is Supervisor-only');
    }
    const saved = database.prepare('SELECT value FROM kv WHERE key=?').get(retryKey);
    const attempts = Number(saved?.value);
    if (!Number.isSafeInteger(attempts) || attempts < minimum) {
      throw new Error('Supervisor has not exhausted the same-session retry budget');
    }
    const latest = database.prepare(
      'SELECT kind, session_id, ended_at FROM runs WHERE batch_id=? ORDER BY id DESC LIMIT 1',
    ).get(id);
    if (!latest || latest.kind !== retryKind || latest.session_id !== owner.session_id || latest.ended_at === null) {
      throw new Error('The latest same-session retry has not completed');
    }
    const completed = database.prepare(
      'SELECT COUNT(*) AS count FROM runs WHERE batch_id=? AND kind=? AND session_id=? AND ended_at IS NOT NULL',
    ).get(id, retryKind, owner.session_id).count;
    if (completed < attempts) throw new Error('Supervisor retry counter is ahead of completed retry runs');
    return attempts;
  } catch (error) {
    if (error.message?.includes('Supervisor ') || error.message?.includes('same-session retry')) throw error;
    throw new Error('Supervisor retry state could not be verified');
  } finally {
    database?.close();
  }
}
