#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  addSearchForm,
  exportLiteraryCandidates,
  initializeLiteraryCheckpoint,
  inspectLiteraryIndex,
  loadLiteraryCheckpoint,
  MAX_RESPONSE_CHARS,
  readLiteraryChunk,
  renderChunkText,
  reportLiteraryCheckpointSenses,
  submitLiteraryChunk,
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
  const flags = new Set(['deep']);
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

async function readSubmission(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(SCRATCH_DIRECTORY, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) fail('submission JSON must remain under .warroom-scratch/');
  const fileStat = await stat(filePath);
  if (fileStat.size > 64_000) fail('sweep results JSON exceeds the 64 KB input limit');
  const text = await readFile(filePath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const failure = new Error('literary chunk submission JSON is invalid');
    // Only a numeric position is forwarded; V8's message can quote file content, so it is never echoed.
    const position = Number(/ at position (\d+)/u.exec(error.message)?.[1]);
    if (Number.isSafeInteger(position) && position <= text.length) {
      let line = 1;
      let lineStart = 0;
      for (const match of text.slice(0, position).matchAll(/\r\n|[\n\r]/gu)) {
        line += 1;
        lineStart = match.index + match[0].length;
      }
      failure.syntax = { line, column: position - lineStart + 1 };
    }
    failure.code = 'LITERARY_SUBMISSION_VALIDATION';
    failure.reason = 'submission_schema';
    failure.affected = { sense_id: null, field: 'input', entry_number: null };
    failure.repair_scope = 'correct_submission_shape';
    throw failure;
  }
}

function usage() {
  return [
    'Usage: node scripts/relation/literary-context-cli.mjs <command> [options]',
    'Commands: preflight [--deep], init, chunk, submit, add-form, report, export, validate',
    'All checkpoint, submission, and digest-cache files must remain under .warroom-scratch/.',
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
      only(options, 'db', 'deep');
      const { db } = required(options, 'db');
      result = await inspectLiteraryIndex(db, { scratchDirectory: SCRATCH_DIRECTORY, deep: options.deep === true });
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
      result = { status: 'READY', index: initialized.index_summary, summary: initialized.summary };
      break;
    }
    case 'chunk': {
      only(options, 'db', 'checkpoint', 'limit', 'contexts', 'snippet-chars', 'sense-ids', 'format');
      const format = options.format ?? 'json';
      if (!['json', 'text'].includes(format)) fail('--format must be json or text');
      required(options, 'db', 'checkpoint');
      result = await readLiteraryChunk({
        databasePath: options.db,
        checkpointPath: options.checkpoint,
        senseIds: options['sense-ids'],
        limit: options.limit,
        contexts: options.contexts,
        snippetChars: options['snippet-chars'],
        scratchDirectory: SCRATCH_DIRECTORY,
      });
      if (format === 'text') {
        // Never trimmed: a text view over the budget fails closed instead of dropping senses or excerpts.
        const text = renderChunkText(result);
        if (text.length > MAX_OUTPUT_CHARS) {
          process.stderr.write(`${JSON.stringify({ status: 'OUTPUT_LIMIT', max_chars: MAX_OUTPUT_CHARS, actual_chars: text.length, message: 'Text view exceeds the output budget; nothing was emitted.' })}\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(text);
        return;
      }
      break;
    }
    case 'submit': {
      only(options, 'db', 'checkpoint', 'input');
      required(options, 'db', 'checkpoint', 'input');
      result = await submitLiteraryChunk({
        databasePath: options.db,
        checkpointPath: options.checkpoint,
        submission: await readSubmission(options.input),
        scratchDirectory: SCRATCH_DIRECTORY,
      });
      break;
    }
    case 'add-form': {
      only(options, 'checkpoint', 'sense-id', 'form', 'basis');
      required(options, 'checkpoint', 'sense-id', 'form', 'basis');
      result = await addSearchForm(options.checkpoint, options['sense-id'], options.form, options.basis, { scratchDirectory: SCRATCH_DIRECTORY });
      break;
    }
    case 'report': {
      only(options, 'checkpoint', 'sense-ids');
      const { checkpoint } = await loadLiteraryCheckpoint(required(options, 'checkpoint').checkpoint, { scratchDirectory: SCRATCH_DIRECTORY });
      result = options['sense-ids'] === undefined ? summarizeLiteraryCheckpoint(checkpoint) : reportLiteraryCheckpointSenses(checkpoint, options['sense-ids']);
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
    default:
      fail(`unknown command ${JSON.stringify(command)}\n${usage()}`);
  }
  print(result);
}

main().catch((error) => {
  const errorType = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name) ? error.name : 'Error';
  if (error?.code === 'LITERARY_SUBMISSION_VALIDATION') {
    const reasons = new Set([
      'submission_schema', 'unknown_sense', 'duplicate_sense', 'context_key_not_found',
      'context_key_ambiguous', 'context_key_too_short', 'duplicate_verified',
      'missing_verified', 'missing_search_forms', 'no_literary_hits',
    ]);
    const fields = new Set(['submission', 'senses', 'sense', 'sense_id', 'verified', 'candidates', 'search_forms', 'input']);
    const reason = reasons.has(error.reason) ? error.reason : 'submission_schema';
    const affected = error.affected && typeof error.affected === 'object' ? error.affected : {};
    const senseId = typeof affected.sense_id === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(affected.sense_id)
      ? affected.sense_id
      : null;
    const field = fields.has(affected.field) ? affected.field : 'submission';
    const entryNumber = Number.isSafeInteger(affected.entry_number) && affected.entry_number > 0
      ? affected.entry_number
      : null;
    const issues = (Array.isArray(error.issues) ? error.issues : [{ entry_number: entryNumber, reason, field }])
      .slice(0, 16)
      .map((issue) => ({
        entry_number: Number.isSafeInteger(issue?.entry_number) && issue.entry_number > 0 ? issue.entry_number : null,
        reason: reasons.has(issue?.reason) ? issue.reason : 'submission_schema',
        field: fields.has(issue?.field) ? issue.field : 'submission',
      }));
    const repairScopes = new Set(['correct_submission_shape', 'correct_source_sense_id', 'resubmit_affected_sense', 'stop_and_report']);
    const repairScope = repairScopes.has(error.repair_scope) ? error.repair_scope : 'correct_submission_shape';
    process.stderr.write(`${JSON.stringify({
      status: 'FAILED',
      diagnostic: 'submit_validation',
      error_type: errorType,
      message: 'Chunk submission did not satisfy the approved source-sense context contract.',
      reason,
      affected: { sense_id: senseId, field, entry_number: entryNumber },
      issues,
      ...(error.issues_truncated ? { issues_truncated: true } : {}),
      ...(error.syntax ? { json_syntax: error.syntax } : {}),
      repair_scope: repairScope,
    })}\n`);
    process.exitCode = 1;
    return;
  }

  if (error?.code === 'CANDIDATE_V1_VALIDATION') {
    process.stderr.write(`${JSON.stringify({
      status: 'FAILED',
      diagnostic: 'candidate_validation',
      error_type: errorType,
      message: 'Candidate v1 validation failed; inspect the affected row and resubmit the affected sense.',
      affected: error.affected ?? null,
      repair_scope: error.repair_scope ?? null,
    })}\n`);
    process.exitCode = 1;
    return;
  }

  let diagnostic = 'operation';
  let safeMessage = 'C literary context operation failed; local paths, source text, and secret details were suppressed.';
  let repairScope;
  if (error?.code === 'LITERARY_INDEX_ACCESS') {
    diagnostic = 'index_access';
    safeMessage = 'The approved literary index could not be accessed; stop and report the index setup issue.';
    repairScope = 'stop_and_report';
  } else if (error?.code === 'LITERARY_INDEX_IDENTITY') {
    diagnostic = 'index_identity';
    safeMessage = 'The approved literary index no longer matches this checkpoint; stop and report the index identity change.';
    repairScope = 'stop_and_report';
  } else if (error?.code === 'LITERARY_INDEX_SEARCH') {
    diagnostic = 'index_search';
    safeMessage = 'The approved literary index search failed; stop and report the index search issue.';
    repairScope = 'stop_and_report';
  } else if (/^unsupported literary index schema/iu.test(error?.message ?? '')) {
    diagnostic = 'index_schema';
    safeMessage = 'Unsupported literary index schema; only the approved works/text_units/unit_fts schema version 1 is supported.';
    repairScope = 'stop_and_report';
  } else if (/literary index metadata|provenance digest|index inventory/iu.test(error?.message ?? '')) {
    diagnostic = 'index_metadata';
    safeMessage = 'Literary index metadata or provenance validation failed.';
    repairScope = 'stop_and_report';
  } else if (/FTS|trigram|literal substring/iu.test(error?.message ?? '')) {
    diagnostic = 'index_search';
    safeMessage = 'The approved literary index search contract is unavailable or inconsistent.';
    repairScope = 'stop_and_report';
  }
  process.stderr.write(`${JSON.stringify({ status: 'FAILED', diagnostic, error_type: errorType, message: safeMessage, ...(repairScope ? { repair_scope: repairScope } : {}) })}\n`);
  process.exitCode = 1;
});
