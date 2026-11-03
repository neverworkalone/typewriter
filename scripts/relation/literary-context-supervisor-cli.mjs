#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { applySupervisorTechnicalSkip } from './literary-context.mjs';

const OPTIONS = new Set([
  '--checkpoint', '--input', '--diagnostic', '--active', '--view', '--chunk-no', '--supervisor-store',
  '--batch-id', '--branch', '--session-id', '--run-id', '--expected-head',
]);
const OPTIONAL_OPTIONS = new Set(['--task']);   // a parallel task number (War Room C 4-way chunks)

function parseArguments(args) {
  const options = {};
  if (args.length % 2 !== 0) throw new Error('invalid arguments');
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!(OPTIONS.has(key) || OPTIONAL_OPTIONS.has(key)) || key in options || !args[index + 1]) throw new Error('invalid arguments');
    options[key] = args[index + 1];
  }
  if ([...OPTIONS].some((key) => !(key in options))) throw new Error('invalid arguments');
  return options;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  const options = parseArguments(process.argv.slice(2));
  const chunkNo = Number(options['--chunk-no']);
  const batchId = Number(options['--batch-id']);
  const runId = Number(options['--run-id']);
  if (!Number.isSafeInteger(chunkNo) || !Number.isSafeInteger(batchId) || !Number.isSafeInteger(runId)) {
    throw new Error('invalid arguments');
  }
  const result = await applySupervisorTechnicalSkip({
    checkpointPath: options['--checkpoint'],
    inputPath: options['--input'],
    diagnosticPath: options['--diagnostic'],
    activePath: options['--active'],
    viewPath: options['--view'],
    chunkNo,
    supervisorStorePath: options['--supervisor-store'],
    batchId,
    branch: options['--branch'],
    sessionId: options['--session-id'],
    runId,
    expectedHead: options['--expected-head'],
    taskNo: options['--task'],
    supervisorCliSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  });
  emit(result);
} catch (error) {
  const reasonCode = error?.code === 'LITERARY_TECHNICAL_SKIP_BLOCKED'
    ? error.reasonCode : 'supervisor_skip_operation_failed';
  emit({ status: 'BLOCKED', reason_code: reasonCode });
  process.exitCode = 1;
}
