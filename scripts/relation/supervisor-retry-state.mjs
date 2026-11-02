import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

/** Read the retry budget written by the War Room Supervisor, never a count supplied by the producer. */
export function readSupervisorRetryBudget({ databasePath, batchId, method, model, shard, batch, worktree,
  retryKey, retryKind, minimum }) {
  const id = Number(batchId);
  if (!path.isAbsolute(databasePath ?? '') || !Number.isSafeInteger(id) || id < 1) {
    throw new Error('Supervisor retry state is unavailable; technical skip is Supervisor-only');
  }
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const owner = database.prepare(
      'SELECT id, method, producer, shard, batch, worktree, session_id FROM batches WHERE id=?',
    ).get(id);
    if (!owner || owner.method !== method || owner.producer !== model || owner.shard !== String(shard)
      || owner.batch !== String(batch) || path.resolve(owner.worktree) !== path.resolve(worktree)
      || typeof owner.session_id !== 'string' || !owner.session_id) {
      throw new Error('Supervisor retry state is not bound to this active batch and worktree');
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
