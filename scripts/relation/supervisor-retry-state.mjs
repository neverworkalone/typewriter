import { DatabaseSync } from 'node:sqlite';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');

function gitDirectoryAt(repositoryRoot) {
  const gitEntry = path.join(repositoryRoot, '.git');
  const entryStat = lstatSync(gitEntry);
  if (entryStat.isDirectory()) return realpathSync(gitEntry);
  if (!entryStat.isFile()) throw new Error('invalid Git metadata');
  const gitdirMatch = /^gitdir:\s*(.+)\s*$/mu.exec(readFileSync(gitEntry, 'utf8'));
  if (!gitdirMatch) throw new Error('invalid Git worktree metadata');
  return realpathSync(path.resolve(repositoryRoot, gitdirMatch[1]));
}

function commonGitDirectory(repositoryRoot) {
  const gitDirectory = gitDirectoryAt(repositoryRoot);
  let commonDirectory = gitDirectory;
  try {
    commonDirectory = realpathSync(path.resolve(gitDirectory, readFileSync(path.join(gitDirectory, 'commondir'), 'utf8').trim()));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (path.basename(commonDirectory) !== '.git') throw new Error('not a Typewriter Git common directory');
  return commonDirectory;
}

function isRegisteredWorktree(worktree, commonDirectory) {
  const root = realpathSync(path.resolve(worktree));
  const gitEntry = path.join(root, '.git');
  if (!lstatSync(gitEntry).isFile()) return false;
  const gitDirectory = gitDirectoryAt(root);
  const worktreesDirectory = realpathSync(path.join(commonDirectory, 'worktrees'));
  const relativeGitDirectory = path.relative(worktreesDirectory, gitDirectory);
  if (!relativeGitDirectory || relativeGitDirectory === '..' || relativeGitDirectory.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeGitDirectory)) return false;
  const registeredGitEntry = path.resolve(gitDirectory, readFileSync(path.join(gitDirectory, 'gitdir'), 'utf8').trim());
  if (realpathSync(registeredGitEntry) !== realpathSync(gitEntry)) return false;
  const linkedCommonDirectory = realpathSync(path.resolve(gitDirectory,
    readFileSync(path.join(gitDirectory, 'commondir'), 'utf8').trim()));
  return linkedCommonDirectory === commonDirectory;
}

function supervisorDatabasePath(worktree) {
  try {
    // Resolve only from the repository root containing this source file; caller cwd can be a nested, producer-created repo.
    const commonDirectory = commonGitDirectory(REPOSITORY_ROOT);
    if (!isRegisteredWorktree(worktree, commonDirectory)) throw new Error('unregistered Typewriter worktree');
    return path.join(path.dirname(commonDirectory), 'tools/warroom/.local/warroom.db');
  } catch {
    throw new Error('Supervisor retry state is unavailable; technical skip is Supervisor-only');
  }
}

/** Read retry state only from the War Room database anchored to this installed CLI's shared Git repository. */
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
