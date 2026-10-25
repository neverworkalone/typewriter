#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  addCorpusSearchForm,
  exportCorpusCandidates,
  initializeCorpusCheckpoint,
  inspectWrittenCorpusIndex,
  patchCorpusCandidateFile,
  readCorpusContexts,
  reportCorpusCheckpoint,
  scanCorpusBatch,
  submitCorpusResults,
  validateExistingCorpusCandidates,
  CORPUS_RESPONSE_LIMIT,
  CORPUS_SUBMIT_LIMIT,
} from './corpus-context.mjs';

const SCRATCH_DIRECTORY = path.resolve('.warroom-scratch');
const FLAGS = new Set(['verify-binary']);

function fail(message) {
  throw new Error(message);
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith('--')) fail(`unexpected argument ${JSON.stringify(item)}`);
    const key = item.slice(2);
    if (!/^[a-z][a-z0-9-]*$/u.test(key)) fail(`invalid option ${item}`);
    if (FLAGS.has(key)) {
      if (options[key]) fail(`${item} was provided more than once`);
      options[key] = true;
      continue;
    }
    if (options[key] !== undefined) fail(`${item} was provided more than once`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${item} requires a value`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function required(options, ...names) {
  for (const name of names) if (!options[name]) fail(`--${name} is required`);
}

function only(options, ...allowed) {
  const unexpected = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) fail(`unsupported option(s): ${unexpected.map((key) => `--${key}`).join(', ')}`);
}

async function readSubmission(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(SCRATCH_DIRECTORY, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('submission JSON must stay under .warroom-scratch/');
  if ((await stat(resolved)).size > CORPUS_SUBMIT_LIMIT) fail('submission JSON exceeds the 256 KB limit');
  return JSON.parse(await readFile(resolved, 'utf8'));
}

function print(payload) {
  const serialized = JSON.stringify(payload);
  if (serialized.length > CORPUS_RESPONSE_LIMIT) {
    process.stderr.write(`${JSON.stringify({ status: 'OUTPUT_LIMIT', max_chars: CORPUS_RESPONSE_LIMIT, actual_chars: serialized.length, message: 'Request fewer senses or contexts. The response was not silently truncated.' })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${serialized}\n`);
}

function usage() {
  return [
    'Usage: node scripts/relation/corpus-context-cli.mjs <command> [options]',
    'Commands: preflight, init, scan, read, submit, add-form, report, export, validate, patch',
    'Private checkpoints and submission JSON must remain under .warroom-scratch/.',
  ].join('\n');
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const options = parseArguments(args);
  let result;
  switch (command) {
    case 'preflight': {
      only(options, 'db', 'verify-binary');
      required(options, 'db');
      result = await inspectWrittenCorpusIndex(options.db, { scratchDirectory: SCRATCH_DIRECTORY, verifyBinary: options['verify-binary'] === true });
      break;
    }
    case 'init': {
      only(options, 'canonical', 'shard', 'batch', 'model', 'db', 'checkpoint');
      required(options, 'canonical', 'shard', 'batch', 'model', 'db', 'checkpoint');
      result = await initializeCorpusCheckpoint({ canonicalPath: options.canonical, shard: options.shard, batch: options.batch, model: options.model, databasePath: options.db, checkpointPath: options.checkpoint, scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'scan': {
      only(options, 'db', 'checkpoint');
      required(options, 'db', 'checkpoint');
      result = await scanCorpusBatch({ databasePath: options.db, checkpointPath: options.checkpoint, scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'read': {
      only(options, 'db', 'checkpoint', 'sense-id', 'offset', 'count');
      required(options, 'db', 'checkpoint');
      result = await readCorpusContexts({ databasePath: options.db, checkpointPath: options.checkpoint, senseId: options['sense-id'], offset: options.offset, count: options.count, scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'submit': {
      only(options, 'checkpoint', 'results');
      required(options, 'checkpoint', 'results');
      result = await submitCorpusResults(options.checkpoint, await readSubmission(options.results), { scratchDirectory: SCRATCH_DIRECTORY });
      if (result.status === 'REJECTED') process.exitCode = 1;
      break;
    }
    case 'add-form': {
      only(options, 'checkpoint', 'sense-id', 'form', 'basis');
      required(options, 'checkpoint', 'sense-id', 'form', 'basis');
      result = await addCorpusSearchForm(options.checkpoint, { senseId: options['sense-id'], form: options.form, basis: options.basis }, { scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'report': {
      only(options, 'checkpoint', 'status', 'offset', 'limit');
      required(options, 'checkpoint');
      result = await reportCorpusCheckpoint(options.checkpoint, { status: options.status, offset: options.offset ?? 0, limit: options.limit ?? 50 }, { scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'export': {
      only(options, 'checkpoint', 'canonical', 'output');
      required(options, 'checkpoint', 'canonical', 'output');
      result = await exportCorpusCandidates({ checkpointPath: options.checkpoint, canonicalPath: options.canonical, outputPath: options.output, scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'validate': {
      only(options, 'checkpoint', 'canonical', 'candidate');
      required(options, 'checkpoint', 'canonical', 'candidate');
      result = await validateExistingCorpusCandidates({ checkpointPath: options.checkpoint, canonicalPath: options.canonical, candidatePath: options.candidate, scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'patch': {
      only(options, 'checkpoint', 'canonical', 'candidate', 'record-id', 'sense-id', 'action', 'text', 'replacement', 'reason');
      required(options, 'checkpoint', 'canonical', 'candidate', 'record-id', 'sense-id', 'action', 'text', 'reason');
      result = await patchCorpusCandidateFile({ checkpointPath: options.checkpoint, canonicalPath: options.canonical, candidatePath: options.candidate, recordId: options['record-id'], senseId: options['sense-id'], action: options.action, candidate: options.text, replacement: options.replacement, reason: options.reason, scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    default:
      fail(`unknown command ${JSON.stringify(command)}\n${usage()}`);
  }
  print(result);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: 'ERROR', message: error.message })}\n`);
  process.exitCode = 1;
});
