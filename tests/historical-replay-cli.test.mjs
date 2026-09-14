import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const REPOSITORY_DIRECTORY = path.resolve('.');
const VALIDATION_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/validation');

async function materializeExternalReplayInputs(prefix, stagedSourcePath, semanticAuditSourcePath) {
  const directory = await mkdtemp(path.join(tmpdir(), `typewriter-${prefix}-`));
  const stagedPath = path.join(directory, 'reviewed.jsonl');
  const semanticAuditPath = path.join(directory, 'semantic-audit.json');
  await Promise.all([
    readFile(stagedSourcePath).then((bytes) => writeFile(stagedPath, bytes)),
    readFile(semanticAuditSourcePath).then((bytes) => writeFile(semanticAuditPath, bytes)),
  ]);
  return { directory, stagedPath, semanticAuditPath };
}

async function runValidator(scriptPath, args) {
  return execFileAsync(process.execPath, [scriptPath, ...args], {
    cwd: REPOSITORY_DIRECTORY,
    maxBuffer: 1024 * 1024,
  });
}

test('historical A2 and Wave B CLIs forward the external semantic audit contract', async () => {
  const a2 = await materializeExternalReplayInputs(
    'm5-10a-wave-a2-cli',
    path.join(REPOSITORY_DIRECTORY, 'data/canonical/m5-10a-wave-a2.jsonl'),
    path.join(VALIDATION_DIRECTORY, 'm5-10a-wave-a2-semantic-audit.json'),
  );
  const waveB = await materializeExternalReplayInputs(
    'm5-10-wave-b-cli',
    path.join(REPOSITORY_DIRECTORY, 'data/canonical/m5-10-wave-b.jsonl'),
    path.join(VALIDATION_DIRECTORY, 'm5-10-wave-b-semantic-audit.json'),
  );

  try {
    const [a2Result, waveBResult] = await Promise.all([
      runValidator('scripts/batch/validate-m5-10a-wave-a2.mjs', [
        `--staged=${a2.stagedPath}`,
        `--semantic-audit=${a2.semanticAuditPath}`,
        '--canonical-dir=data/batches/m5-10-wave-b-base-canonical',
        '--canonical-source-dir=data/canonical',
      ]),
      runValidator('scripts/batch/validate-m5-10-wave-b.mjs', [
        `--staged=${waveB.stagedPath}`,
        `--semantic-audit=${waveB.semanticAuditPath}`,
      ]),
    ]);

    assert.match(a2Result.stdout, /Validated m5-10-wave-a2-20260909: 50 validated start\(s\)/u);
    assert.match(waveBResult.stdout, /"batch_id": "m5-10-wave-b-20260909"/u);
  } finally {
    await Promise.all([
      rm(a2.directory, { recursive: true, force: true }),
      rm(waveB.directory, { recursive: true, force: true }),
    ]);
  }
});
