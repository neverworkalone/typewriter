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

test('Wave B timing recorder derives scope from recorder-created work-log rows', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-10-wave-b-timing-'));
  try {
    const sessionPath = path.join(directory, 'timing-session.json');
    const firstInputPath = path.join(directory, 'seed.jsonl');
    const firstOutputPath = path.join(directory, 'first-output.jsonl');
    const secondOutputPath = path.join(directory, 'second-output.jsonl');
    const preparedOutputPath = path.join(directory, 'prepared-output.jsonl');
    const firstInput = '{"kind":"seed","source":"self-authored"}\n';
    await writeFile(firstInputPath, firstInput, 'utf8');
    await writeFile(preparedOutputPath, '{"kind":"summary","count":1}\n', 'utf8');

    await assert.rejects(
      recordWaveBTiming([
        '--action=start',
        '--kind=editorial',
        '--pass=target-preparation',
        `--output=${sessionPath}`,
        `--input-artifact=${firstInputPath}`,
        `--output-artifact=${preparedOutputPath}`,
      ]),
      /pre-existing timing output artifact/u,
    );

    await recordWaveBTiming([
      '--action=start',
      '--kind=editorial',
      '--pass=target-preparation',
      `--output=${sessionPath}`,
      `--input-artifact=${firstInputPath}`,
      `--output-artifact=${firstOutputPath}`,
    ]);
    await recordWaveBTiming([
      '--action=work',
      '--pass=target-preparation',
      `--input=${sessionPath}`,
      '--unit-id=m5-001',
      '--unit-kind=selected-target',
      '--work-json={"inventory_id":"m5-001","operation":"select"}',
    ]);
    await recordWaveBTiming([
      '--action=stop',
      '--kind=editorial',
      '--pass=target-preparation',
      `--input=${sessionPath}`,
    ]);
    await recordWaveBTiming([
      '--action=start',
      '--kind=editorial',
      '--pass=initial-review',
      `--input=${sessionPath}`,
      `--output=${sessionPath}`,
      `--input-artifact=${firstOutputPath}`,
      `--output-artifact=${secondOutputPath}`,
    ]);
    await assert.rejects(
      recordWaveBTiming([
        '--action=work',
        '--pass=initial-review',
        `--input=${sessionPath}`,
        '--unit-id=m5-001:physical-figurative',
        '--unit-kind=boundary-check',
        '--work-record=/missing/work-record.json',
      ]),
      /work record does not exist/u,
    );
    await assert.rejects(
      recordWaveBTiming([
        '--action=work',
        '--kind=editorial',
        '--pass=initial-review',
        `--input=${sessionPath}`,
        '--unit-id=m5-001:physical-figurative',
        '--unit-kind=boundary-check',
        '--work-json={"inventory_id":"m5-001","operation":"review"}',
        `--unit-count=1`,
      ]),
      /--unit-count is not accepted/u,
    );
    await recordWaveBTiming([
      '--action=work',
      '--pass=initial-review',
      `--input=${sessionPath}`,
      '--unit-id=m5-001:physical-figurative',
      '--unit-kind=boundary-check',
      '--work-json={"inventory_id":"m5-001","boundary_id":"physical-figurative","operation":"review"}',
    ]);
    await recordWaveBTiming([
      '--action=stop',
      '--kind=editorial',
      '--pass=initial-review',
      `--input=${sessionPath}`,
    ]);

    const session = JSON.parse(await readFile(sessionPath, 'utf8'));
    const firstPass = session.passes[0];
    assert.equal(session.recorder_version, 'wave-b-timing-recorder-v4');
    assert.equal(session.recording_source, 'timing-recorder-v4');
    assert.equal(firstPass.work_evidence.before_sha256, sha256(firstInput));
    assert.equal(firstPass.work_evidence.unit_count, 1);
    assert.deepEqual(firstPass.work_evidence.unit_ids, ['m5-001']);
    assert.equal(firstPass.work_evidence.work_log.path, firstPass.work_evidence.output_artifact.path);
    assert.equal(session.passes[1].work_evidence.before_sha256, firstPass.work_evidence.after_sha256);
    assert.equal(session.events.length, 6);
    assert.deepEqual(session.events.map(({ kind }) => kind), ['start', 'work', 'stop', 'start', 'work', 'stop']);
    assert.equal(firstPass.work_evidence.work_event_ids[0], session.events[1].event_id);
    assert.equal(session.events[1].unit_id, 'm5-001');
    assert.ok(Date.parse(session.events[1].at) >= Date.parse(firstPass.started_at));
    assert.ok(Date.parse(session.events[1].at) <= Date.parse(firstPass.completed_at));
    await assert.rejects(
      recordWaveBTiming([
        '--action=work',
        '--kind=editorial',
        '--pass=feedback-fixes',
        `--input=${sessionPath}`,
        `--before-sha256=${'0'.repeat(64)}`,
        '--unit-id=w629',
        '--unit-kind=sense-correction',
        '--work-json={"operation":"correct"}',
      ]),
      /--before-sha256 is not accepted/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
