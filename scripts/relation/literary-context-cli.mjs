#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  addSearchForm,
  exportLiteraryCandidates,
  finishLiterarySearch,
  getLiteraryContextPage,
  initializeLiteraryCheckpoint,
  inspectLiteraryIndex,
  listLiterarySearchQueue,
  loadLiteraryCheckpoint,
  MAX_RESPONSE_CHARS,
  patchLiteraryCandidateFile,
  recordLiterarySweep,
  reviewLiteraryCandidate,
  reviewLiteraryContext,
  scanLiteraryBatch,
  searchLiterarySense,
  summarizeLiteraryCheckpoint,
  validateExistingLiteraryCandidates,
} from './literary-context.mjs';

const SCRATCH_DIRECTORY = path.resolve('.warroom-scratch');
const MAX_OUTPUT_CHARS = MAX_RESPONSE_CHARS;

function fail(message) {
  throw new Error(message);
}

function parseArguments(args) {
  const options = {};
  const flags = new Set(['independent-read']);
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith('--')) fail(`unexpected argument ${JSON.stringify(item)}`);
    const key = item.slice(2);
    if (!/^[a-z][a-z0-9-]*$/u.test(key)) fail(`invalid option ${item}`);
    if (flags.has(key)) {
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
  return Object.fromEntries(names.map((name) => [name, options[name]]));
}

function only(options, ...allowed) {
  const unexpected = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) fail(`unsupported option(s): ${unexpected.map((key) => `--${key}`).join(', ')}`);
}

function print(payload) {
  let serialized = JSON.stringify(payload);
  if (serialized.length > MAX_OUTPUT_CHARS && Array.isArray(payload.items)) {
    const items = [...payload.items];
    while (items.length > 0 && serialized.length > MAX_OUTPUT_CHARS) {
      items.pop();
      payload.items = items;
      payload.returned = items.length;
      payload.has_more = true;
      payload.truncated = true;
      payload.next_offset = payload.offset + items.length;
      serialized = JSON.stringify(payload);
    }
  }
  if (serialized.length > MAX_OUTPUT_CHARS) {
    process.stderr.write(`${JSON.stringify({ status: 'OUTPUT_LIMIT', max_chars: MAX_OUTPUT_CHARS, actual_chars: serialized.length, message: 'Reduce page size or snippet size; no file-list or full-ledger output was emitted.' })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${serialized}\n`);
}

async function readResults(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(SCRATCH_DIRECTORY, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) fail('sweep input JSON must remain under .warroom-scratch/');
  const fileStat = await stat(filePath);
  if (fileStat.size > 64_000) fail('sweep results JSON exceeds the 64 KB input limit');
  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/relation/literary-context-cli.mjs <command> [options]',
    'Commands: preflight, init, scan, queue, search, finish-search, context, add-form, review-context, sweep, review-candidate, report, export, validate, patch',
    'All checkpoint, excerpt, locator, and digest-cache files must remain under .warroom-scratch/.',
    'Run with --help for this compact command list.',
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
      const { db } = required(options, 'db');
      result = await inspectLiteraryIndex(db, { scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'init': {
      only(options, 'canonical', 'shard', 'batch', 'model', 'db', 'checkpoint');
      required(options, 'canonical', 'shard', 'batch', 'model', 'db', 'checkpoint');
      const initialized = await initializeLiteraryCheckpoint({
        canonicalPath: options.canonical,
        shard: options.shard,
        batch: options.batch,
        model: options.model,
        databasePath: options.db,
        checkpointPath: options.checkpoint,
        scratchDirectory: SCRATCH_DIRECTORY,
      });
      const { path: _privateDatabasePath, ...index } = initialized.checkpoint.index;
      result = { status: 'READY', checkpoint: path.relative(process.cwd(), initialized.path), index, summary: initialized.summary };
      break;
    }
    case 'scan': {
      only(options, 'db', 'checkpoint');
      required(options, 'db', 'checkpoint');
      result = await scanLiteraryBatch({ databasePath: options.db, checkpointPath: options.checkpoint, scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'queue': {
      only(options, 'checkpoint', 'status', 'offset', 'limit');
      required(options, 'checkpoint', 'status');
      result = await listLiterarySearchQueue(options.checkpoint, { status: options.status, offset: options.offset ?? 0, limit: options.limit ?? 50 }, { scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'search': {
      only(options, 'db', 'checkpoint', 'sense-id', 'page-size', 'snippet-chars', 'cursor');
      required(options, 'db', 'checkpoint', 'sense-id');
      result = await searchLiterarySense({
        databasePath: options.db,
        checkpointPath: options.checkpoint,
        senseId: options['sense-id'],
        pageSize: options['page-size'],
        snippetChars: options['snippet-chars'],
        cursor: options.cursor,
        scratchDirectory: SCRATCH_DIRECTORY,
      });
      break;
    }
    case 'finish-search': {
      only(options, 'checkpoint', 'sense-id', 'note');
      required(options, 'checkpoint', 'sense-id', 'note');
      result = await finishLiterarySearch(options.checkpoint, { senseId: options['sense-id'], note: options.note }, { scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'context': {
      only(options, 'checkpoint', 'sense-id', 'locator-key', 'offset', 'chars');
      required(options, 'checkpoint', 'sense-id', 'locator-key');
      result = await getLiteraryContextPage(options.checkpoint, {
        senseId: options['sense-id'],
        locatorKey: options['locator-key'],
        offset: options.offset ?? 0,
        chars: options.chars ?? 1000,
      }, { scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'add-form': {
      only(options, 'checkpoint', 'sense-id', 'form', 'basis');
      required(options, 'checkpoint', 'sense-id', 'form', 'basis');
      result = await addSearchForm(options.checkpoint, options['sense-id'], options.form, options.basis, { scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'review-context': {
      only(options, 'checkpoint', 'sense-id', 'locator-key', 'judgment', 'note');
      required(options, 'checkpoint', 'sense-id', 'locator-key', 'judgment', 'note');
      result = await reviewLiteraryContext(options.checkpoint, {
        senseId: options['sense-id'], locatorKey: options['locator-key'], judgment: options.judgment, note: options.note,
      }, { scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'sweep': {
      only(options, 'checkpoint', 'sense-id', 'locator-key', 'sweep', 'results', 'independent-read');
      required(options, 'checkpoint', 'sense-id', 'locator-key', 'sweep', 'results');
      result = await recordLiterarySweep(options.checkpoint, {
        senseId: options['sense-id'], locatorKey: options['locator-key'], sweep: options.sweep,
        results: await readResults(options.results), independentRead: options['independent-read'] === true,
      }, { scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'review-candidate': {
      only(options, 'checkpoint', 'sense-id', 'candidate', 'decision', 'kind', 'note');
      required(options, 'checkpoint', 'sense-id', 'candidate', 'decision', 'note');
      if (options.decision === 'KEEP') required(options, 'kind');
      result = await reviewLiteraryCandidate(options.checkpoint, {
        senseId: options['sense-id'], candidate: options.candidate, decision: options.decision,
        kind: options.kind, note: options.note,
      }, { scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'report': {
      only(options, 'checkpoint');
      const { checkpoint } = await loadLiteraryCheckpoint(required(options, 'checkpoint').checkpoint, { scratchDirectory: SCRATCH_DIRECTORY });
      result = summarizeLiteraryCheckpoint(checkpoint);
      break;
    }
    case 'export': {
      only(options, 'checkpoint', 'canonical', 'output');
      required(options, 'checkpoint', 'canonical', 'output');
      result = await exportLiteraryCandidates({
        checkpointPath: options.checkpoint,
        canonicalPath: options.canonical,
        outputPath: options.output,
        repositoryDirectory: process.cwd(),
        scratchDirectory: SCRATCH_DIRECTORY,
      });
      break;
    }
    case 'validate': {
      only(options, 'checkpoint', 'canonical', 'candidate');
      required(options, 'checkpoint', 'canonical', 'candidate');
      result = await validateExistingLiteraryCandidates({
        checkpointPath: options.checkpoint,
        canonicalPath: options.canonical,
        candidatePath: options.candidate,
        repositoryDirectory: process.cwd(),
        scratchDirectory: SCRATCH_DIRECTORY,
      });
      if (result.status !== 'VALID') process.exitCode = 1;
      break;
    }
    case 'patch': {
      only(options, 'checkpoint', 'canonical', 'candidate-file', 'record-id', 'sense-id', 'action', 'candidate', 'replacement', 'reason');
      required(options, 'checkpoint', 'canonical', 'candidate-file', 'record-id', 'sense-id', 'action', 'candidate', 'reason');
      if (options.action === 'replace') required(options, 'replacement');
      result = await patchLiteraryCandidateFile({
        checkpointPath: options.checkpoint,
        canonicalPath: options.canonical,
        candidatePath: options['candidate-file'],
        recordId: options['record-id'],
        senseId: options['sense-id'],
        action: options.action,
        candidate: options.candidate,
        replacement: options.replacement,
        reason: options.reason,
        repositoryDirectory: process.cwd(),
        scratchDirectory: SCRATCH_DIRECTORY,
      });
      if (result.status !== 'VALID') process.exitCode = 1;
      break;
    }
    default:
      fail(`unknown command ${JSON.stringify(command)}\n${usage()}`);
  }
  print(result);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: 'FAILED', error_type: error.name, message: error.message.slice(0, 1000) })}\n`);
  process.exitCode = 1;
});
