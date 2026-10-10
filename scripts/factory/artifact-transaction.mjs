import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, jsonText } from './permanent-trash.mjs';

async function optional(file) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function replace(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.transaction-tmp`;
  await writeFile(temporary, text, 'utf8');
  await rename(temporary, file);
}

// Git cannot atomically rename several independent paths. Persist a complete
// before/after journal first, recover each path idempotently, then validate the
// whole transaction. An interrupted transaction must be resumed before commit.
export async function publishArtifacts({ root, files, journalDirectory, validate = async () => [] }) {
  for (const relative of files.keys()) {
    if (!relative.startsWith('data/') || !path.resolve(root, relative).startsWith(`${root}${path.sep}`)) throw new Error('transaction path must stay inside repository data');
  }
  const journalPath = path.join(journalDirectory, 'transaction.json');
  const planDigest = digest(JSON.stringify([...files]));
  await mkdir(journalDirectory, { recursive: true });
  const existing = await optional(journalPath);
  let journal;
  if (existing) {
    journal = JSON.parse(existing);
    if (journal.plan_sha256 !== planDigest || journal.root !== root) throw new Error('unfinished artifact transaction has different inputs; recover it before another run');
  } else {
    const entries = [];
    for (const [relative, after] of files) {
      entries.push({ path: relative, before: await optional(path.join(root, relative)), after });
    }
    journal = { root, plan_sha256: planDigest, entries };
    await replace(journalPath, jsonText(journal));
  }
  try {
    for (const entry of journal.entries) {
      const file = path.join(root, entry.path);
      const current = await optional(file);
      if (current !== entry.before && current !== entry.after) throw new Error(`transaction input changed: ${entry.path}`);
      if (current !== entry.after) await replace(file, entry.after);
    }
    const errors = await validate();
    if (errors.length) throw new Error(errors.join('\n'));
  } catch (error) {
    for (const entry of [...journal.entries].reverse()) {
      const file = path.join(root, entry.path);
      if (await optional(file) !== entry.after) continue;
      if (entry.before === null) await rm(file, { force: true });
      else await replace(file, entry.before);
    }
    // New empty batch directories must not appear as invalid batches after rollback.
    for (const entry of journal.entries.filter((item) => item.before === null && /^data\/candidates\/C\d{6}\//.test(item.path))) {
      try { await rmdir(path.dirname(path.join(root, entry.path))); } catch { /* other files still exist */ }
    }
    throw error;
  }
  await rm(journalDirectory, { recursive: true, force: true });
}

export async function recoverArtifacts({ root, journalDirectory, validate }) {
  const text = await optional(path.join(journalDirectory, 'transaction.json'));
  if (!text) return null;
  const journal = JSON.parse(text);
  if (journal.root !== root) throw new Error('transaction belongs to another checkout');
  const files = new Map(journal.entries.map((entry) => [entry.path, entry.after]));
  await publishArtifacts({ root, files, journalDirectory, validate });
  return files;
}
