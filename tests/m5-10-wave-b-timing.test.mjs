import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main as recordWaveBTiming } from '../scripts/batch/record-m5-10-wave-b-timing.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('Wave B timing recorder derives artifact hashes and emits bound work events', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-10-wave-b-timing-'));
  try {
    const sessionPath = path.join(directory, 'timing-session.json');
    const firstInputPath = path.join(directory, 'first-input.json');
    const firstOutputPath = path.join(directory, 'first-output.json');
    const secondOutputPath = path.join(directory, 'second-output.json');
    const firstInput = '{"step":"selected-targets"}\n';
    const firstOutput = '{"step":"boundary-review"}\n';
    const secondOutput = '{"step":"sense-corrections"}\n';
    await writeFile(firstInputPath, firstInput, 'utf8');
    await writeFile(firstOutputPath, firstOutput, 'utf8');
    await writeFile(secondOutputPath, secondOutput, 'utf8');

    await recordWaveBTiming([
      '--action=start',
      '--kind=editorial',
      '--pass=target-preparation',
      `--output=${sessionPath}`,
    ]);
    await recordWaveBTiming([
      '--action=stop',
      '--kind=editorial',
      '--pass=target-preparation',
      `--input=${sessionPath}`,
      `--input-artifact=${firstInputPath}`,
      `--output-artifact=${firstOutputPath}`,
      '--note=first-artifact-transition',
    ]);
    await recordWaveBTiming([
      '--action=start',
      '--kind=editorial',
      '--pass=initial-review',
      `--input=${sessionPath}`,
      `--output=${sessionPath}`,
    ]);
    await assert.rejects(
      recordWaveBTiming([
        '--action=stop',
        '--kind=editorial',
        '--pass=initial-review',
        `--input=${sessionPath}`,
        `--input-artifact=${path.join(directory, 'missing-input.json')}`,
        `--output-artifact=${secondOutputPath}`,
        '--note=missing-artifact-must-fail',
      ]),
      /initial-review input artifact does not exist/u,
    );
    await assert.rejects(
      recordWaveBTiming([
        '--action=stop',
        '--kind=editorial',
        '--pass=initial-review',
        `--input=${sessionPath}`,
        `--input-artifact=${firstInputPath}`,
        `--output-artifact=${secondOutputPath}`,
        '--note=discontinuous-artifact-must-fail',
      ]),
      /must continue the previous pass output artifact/u,
    );
    await recordWaveBTiming([
      '--action=stop',
      '--kind=editorial',
      '--pass=initial-review',
      `--input=${sessionPath}`,
      `--input-artifact=${firstOutputPath}`,
      `--output-artifact=${secondOutputPath}`,
      '--note=second-artifact-transition',
    ]);

    const session = JSON.parse(await readFile(sessionPath, 'utf8'));
    const firstPass = session.passes[0];
    assert.equal(session.recorder_version, 'wave-b-timing-recorder-v2');
    assert.equal(session.recording_source, 'timing-recorder-v2');
    assert.equal(firstPass.work_evidence.before_sha256, sha256(firstInput));
    assert.equal(firstPass.work_evidence.after_sha256, sha256(firstOutput));
    assert.equal(session.passes[1].work_evidence.before_sha256, firstPass.work_evidence.after_sha256);
    assert.equal(session.events.length, 6);
    assert.deepEqual(session.events.map(({ kind }) => kind), ['start', 'work', 'stop', 'start', 'work', 'stop']);
    assert.equal(firstPass.work_evidence.work_event_id, session.events[1].event_id);
    await assert.rejects(
      recordWaveBTiming([
        '--action=stop',
        '--kind=editorial',
        '--pass=feedback-fixes',
        `--input=${sessionPath}`,
        `--before-sha256=${'0'.repeat(64)}`,
        `--input-artifact=${secondOutputPath}`,
        `--output-artifact=${firstInputPath}`,
        '--note=forbidden-precomputed-digest',
      ]),
      /--before-sha256 is not accepted/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
