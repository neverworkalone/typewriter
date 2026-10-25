#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  addCorpusSearchForm,
  exportCorpusCandidates,
  finishCorpusSearch,
  initializeCorpusCheckpoint,
  inspectWrittenCorpusIndex,
  patchCorpusCandidateFile,
  recordCorpusExploration,
  reportCorpusCheckpoint,
  reviewCorpusCandidate,
  reviewCorpusContext,
  scanCorpusBatch,
  searchCorpusSense,
  validateExistingCorpusCandidates,
  CORPUS_RESPONSE_LIMIT,
} from './corpus-context.mjs';

const SCRATCH_DIRECTORY = path.resolve('.warroom-scratch');
const FLAGS = new Set(['independent-read', 'mismatch-confirmed']);

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

async function readResults(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(SCRATCH_DIRECTORY, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('exploration input JSON must stay under .warroom-scratch/');
  if ((await stat(resolved)).size > 64_000) fail('exploration input JSON exceeds the 64 KB limit');
  return JSON.parse(await readFile(resolved, 'utf8'));
}

function print(payload) {
  const serialized = JSON.stringify(payload);
  if (serialized.length > CORPUS_RESPONSE_LIMIT) {
    process.stderr.write(`${JSON.stringify({ status: 'OUTPUT_LIMIT', max_chars: CORPUS_RESPONSE_LIMIT, actual_chars: serialized.length, message: 'Retry with a smaller page. The response was not silently truncated.' })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${serialized}\n`);
}

function usage() {
  return [
    'Usage: node scripts/relation/corpus-context-cli.mjs <command> [options]',
    'Commands: preflight, init, scan, queue, search, add-form, review-context, explore, review-candidate, finish-search, report, export, validate, patch',
    'Private checkpoints and exploration JSON must remain under .warroom-scratch/.',
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
      only(options, 'db');
      required(options, 'db');
      result = await inspectWrittenCorpusIndex(options.db, { scratchDirectory: SCRATCH_DIRECTORY });
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
    case 'queue': {
      only(options, 'checkpoint', 'status', 'offset', 'limit');
      required(options, 'checkpoint', 'status');
      result = await reportCorpusCheckpoint(options.checkpoint, { status: options.status, offset: options.offset ?? 0, limit: options.limit ?? 50 }, { scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'search': {
      only(options, 'db', 'checkpoint', 'sense-id', 'page-size', 'cursor');
      required(options, 'db', 'checkpoint', 'sense-id');
      result = await searchCorpusSense({ databasePath: options.db, checkpointPath: options.checkpoint, senseId: options['sense-id'], pageSize: options['page-size'], cursor: options.cursor, scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'add-form': {
      only(options, 'checkpoint', 'sense-id', 'form', 'basis');
      required(options, 'checkpoint', 'sense-id', 'form', 'basis');
      result = await addCorpusSearchForm(options.checkpoint, { senseId: options['sense-id'], form: options.form, basis: options.basis }, { scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'review-context': {
      only(options, 'checkpoint', 'sense-id', 'locator-key', 'judgment', 'note', 'mismatch-confirmed');
      required(options, 'checkpoint', 'sense-id', 'locator-key', 'judgment', 'note');
      result = await reviewCorpusContext(options.checkpoint, { senseId: options['sense-id'], locatorKey: options['locator-key'], judgment: options.judgment, note: options.note, mismatchConfirmed: options['mismatch-confirmed'] === true }, { scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'explore': {
      only(options, 'checkpoint', 'sense-id', 'locator-key', 'pass', 'results', 'independent-read', 'note');
      required(options, 'checkpoint', 'sense-id', 'locator-key', 'pass', 'results');
      result = await recordCorpusExploration(options.checkpoint, { senseId: options['sense-id'], locatorKey: options['locator-key'], pass: options.pass, results: await readResults(options.results), independentRead: options['independent-read'] === true, note: options.note ?? '' }, { scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'review-candidate': {
      only(options, 'checkpoint', 'sense-id', 'candidate', 'decision', 'kind', 'note');
      required(options, 'checkpoint', 'sense-id', 'candidate', 'decision', 'note');
      result = await reviewCorpusCandidate(options.checkpoint, { senseId: options['sense-id'], candidate: options.candidate, decision: options.decision, kind: options.kind ?? 'word', note: options.note }, { scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'finish-search': {
      only(options, 'checkpoint', 'sense-id', 'note');
      required(options, 'checkpoint', 'sense-id', 'note');
      result = await finishCorpusSearch(options.checkpoint, { senseId: options['sense-id'], note: options.note }, { scratchDirectory: SCRATCH_DIRECTORY });
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
