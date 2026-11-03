#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { applySupervisorTechnicalSkip } from './literary-context.mjs';

const OPTIONS = new Set([
  '--checkpoint', '--input', '--diagnostic', '--active', '--view', '--chunk-no', '--retry-attempts', '--expected-head',
]);

function parseArguments(args) {
  const options = {};
  if (args.length % 2 !== 0) throw new Error('invalid arguments');
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!OPTIONS.has(key) || key in options || !args[index + 1]) throw new Error('invalid arguments');
    options[key] = args[index + 1];
  }
  if (Object.keys(options).length !== OPTIONS.size) throw new Error('invalid arguments');
  return options;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  const options = parseArguments(process.argv.slice(2));
  const chunkNo = Number(options['--chunk-no']);
  const retryAttempts = Number(options['--retry-attempts']);
  if (!Number.isSafeInteger(chunkNo) || !Number.isSafeInteger(retryAttempts)) throw new Error('invalid arguments');
  const result = await applySupervisorTechnicalSkip({
    checkpointPath: options['--checkpoint'],
    inputPath: options['--input'],
    diagnosticPath: options['--diagnostic'],
    activePath: options['--active'],
    viewPath: options['--view'],
    chunkNo,
    retryAttempts,
    expectedHead: options['--expected-head'],
    supervisorCliSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  });
  emit(result);
} catch (error) {
  const reasonCode = error?.code === 'LITERARY_TECHNICAL_SKIP_BLOCKED'
    ? error.reasonCode : 'supervisor_skip_operation_failed';
  emit({ status: 'BLOCKED', reason_code: reasonCode });
  process.exitCode = 1;
}
