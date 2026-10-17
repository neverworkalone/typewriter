import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// Serializes the read-modify-write of the backfill queue state (#676). The state file is replaced atomically, but two
// processes that both read the same state and then each write their own result silently drop the other's approvals.
// Authors may work concurrently; `record` and `apply` hold this lock from reading the state until it is written, so
// every recorded approval is built on the latest state. The lock is a directory (atomic `mkdir`) owned by a live pid.

const POLL_MS = 50;
const lockOwner = (lockPath) => {
  try { return Number(readFileSync(path.join(lockPath, 'owner'), 'utf8')); } catch { return null; }
};
const isAlive = (pid) => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

/** Acquires `<statePath>.lock`; the returned `release` is also run on process exit. Rejects after `timeoutMs`. */
export async function acquireStateLock(statePath, { timeoutMs = 60_000 } = {}) {
  const lockPath = `${statePath}.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockPath);
      writeFileSync(path.join(lockPath, 'owner'), `${process.pid}\n`);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = lockOwner(lockPath);
      // A crashed holder never releases; only a lock whose recorded owner is gone is taken over.
      if (owner !== null && !isAlive(owner)) { rmSync(lockPath, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`backfill state is locked by pid ${owner ?? 'unknown'} (${lockPath}); retry or remove the lock if that process is gone`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    rmSync(lockPath, { recursive: true, force: true });
  };
  process.once('exit', release);
  return release;
}
