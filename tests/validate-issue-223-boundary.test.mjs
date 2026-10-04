import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, cp, link, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve('.');

// Runs the REAL tracked validator (validateCorpusBatches and its early-continue paths) on a
// temp tree whose data files are hard links (or copies) of the repository, plus injected artifacts.
async function validatorOn(inject) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'typewriter-validator-boundary-')));
  try {
    for (const entry of ['scripts', 'config', 'schema', 'src', 'package.json']) await cp(path.join(ROOT, entry), path.join(temp, entry), { recursive: true });
    await symlink(path.join(ROOT, 'node_modules'), path.join(temp, 'node_modules'));
    for (const directory of ['batches', 'canonical']) {
      await mkdir(path.join(temp, 'data', directory), { recursive: true });
      for (const entry of await readdir(path.join(ROOT, 'data', directory), { withFileTypes: true })) {
        const name = entry.name;
        // Hard links keep this cheap (the validator ignores symlinked files); copy across filesystems.
        const from = path.join(ROOT, 'data', directory, name);
        const to = path.join(temp, 'data', directory, name);
        if (entry.isDirectory()) await cp(from, to, { recursive: true });
        else await link(from, to).catch(() => copyFile(from, to));
      }
    }
    for (const directory of ['inventory', 'validation', 'timing']) await symlink(path.join(ROOT, 'data', directory), path.join(temp, 'data', directory));
    await inject(temp);
    try {
      await run('node', ['scripts/batch/validate-issue-223.mjs', '--no-local-corpus-evidence', '--skip-issue-222', '--no-build'], { cwd: temp, maxBuffer: 64 * 1024 * 1024 });
      return { ok: true, message: '' };
    } catch (error) {
      return { ok: false, message: `${error.stderr ?? ''}${error.stdout ?? ''}` };
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const B16 = 'issue-223-m9-e-corpus-batch-16-20261004';

test('real tracked validator: unchanged tracked batches pass; B16+ review-only, direct canonical insertion and a canonical import without a reviewed batch fail', async () => {
  // Any tracked candidate review works as a template; the variant claims review-only status at B16.
  const b05Review = await readFile(path.join(ROOT, 'data/batches/issue-223-m9-e-corpus-batch-05-candidate-review.json'), 'utf8');
  const record = { id: 'w99999', record_type: 'entry', role: 'start', candidate_id: 'w99999', lemma: '시험삼음말', search_forms: ['시험삼음말'], senses: [{ id: 'w99999-s1', pos: 'noun', gloss: '시험으로 끼워 넣은 말.' }] };

  const [control, reviewOnlyB16, injected, orphan] = await Promise.all([
    // (1) unchanged repository (historical B05-B15 evidence untouched)
    validatorOn(async () => {}),
    // (2) a B16 review-only candidate review without hand-off or semantic input
    validatorOn(async (temp) => {
      const variant = JSON.parse(b05Review);
      variant.batch_id = B16;
      variant.canonical_import_status = 'owner-deferred-review-only';
      await writeFile(path.join(temp, 'data/batches/issue-223-m9-e-corpus-batch-16-candidate-review.json'), JSON.stringify(variant));
    }),
    // (4) a canonical record inserted under an unrelated file name
    validatorOn(async (temp) => {
      await writeFile(path.join(temp, 'data/canonical/zz-anything.jsonl'), `${JSON.stringify(record)}\n`);
    }),
    // (4b) a B16-named canonical import with no reviewed candidate review
    validatorOn(async (temp) => {
      await writeFile(path.join(temp, 'data/canonical/issue-223-m9-e-corpus-batch-16.jsonl'), `${JSON.stringify(record)}\n`);
    }),
  ]);

  assert.equal(control.ok, true, control.message.slice(-600));
  assert.equal(reviewOnlyB16.ok, false);
  assert.match(reviewOnlyB16.message, /only B05 is an owner-directed review-only batch/u);
  assert.equal(injected.ok, false);
  assert.match(injected.message, /CANONICAL_RECORD_OUTSIDE_REVIEWED_BATCH|outside validated corpus batches/u);
  assert.equal(orphan.ok, false);
  assert.match(orphan.message, /canonical import without a reviewed/u);
});
