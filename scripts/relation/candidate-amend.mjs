import { randomUUID } from 'node:crypto';
import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  loadCanonicalLemmaForms,
  parseCandidateJsonl,
  patchCandidateRows,
  serializeCandidateJsonl,
  validateCandidateBatch,
  validateCandidatePaths,
} from './candidate-contract.mjs';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fail(message) {
  throw new Error(message);
}

function parseRemovals(contents, filePath) {
  if (typeof contents !== 'string' || !contents.length) fail(`${filePath} must contain at least one removal row`);
  const lines = contents.split(/\r\n|\n|\r/u);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    fail(`${filePath} contains an empty or blank row`);
  }
  const seen = new Set();
  return lines.map((line, index) => {
    const fields = line.split('\t');
    if (fields.length !== 3 || fields.some((value) => value.length === 0)) {
      fail(`${filePath}:${index + 1} must contain exactly record_id<TAB>sense_id<TAB>candidate`);
    }
    const [recordId, senseId, candidate] = fields;
    const key = JSON.stringify(fields);
    if (seen.has(key)) fail(`${filePath}:${index + 1} duplicates a removal row`);
    seen.add(key);
    return { recordId, senseId, candidate };
  });
}

async function validateScratchInput(inputPath, worktree) {
  const scratchPath = path.resolve(worktree, '.warroom-scratch');
  const resolvedInput = path.resolve(worktree, inputPath);
  const relativeInput = path.relative(scratchPath, resolvedInput);
  if (!relativeInput || relativeInput.startsWith(`..${path.sep}`) || relativeInput === '..' || path.isAbsolute(relativeInput)) {
    fail('input TSV must be inside this worktree .warroom-scratch directory');
  }
  let actualScratch;
  let actualInput;
  try {
    [actualScratch, actualInput] = await Promise.all([realpath(scratchPath), realpath(resolvedInput)]);
  } catch (error) {
    fail(`cannot resolve scratch input: ${error.message}`);
  }
  const actualRelative = path.relative(actualScratch, actualInput);
  if (!actualRelative || actualRelative.startsWith(`..${path.sep}`) || actualRelative === '..' || path.isAbsolute(actualRelative)) {
    fail('input TSV resolves outside this worktree .warroom-scratch directory');
  }
  return actualInput;
}

/** Apply exact removals in memory, validate the complete official Candidate batch, then atomically replace it. */
export async function removeCandidates({ canonicalPath, candidatePath, inputPath, worktree = process.cwd(),
  repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const official = validateCandidatePaths(canonicalPath, candidatePath, { repositoryDirectory });
  const input = await validateScratchInput(inputPath, worktree);
  const [canonicalText, candidateText, inputText] = await Promise.all([
    readFile(canonicalPath, 'utf8'),
    readFile(candidatePath, 'utf8'),
    readFile(input, 'utf8'),
  ]);
  const removals = parseRemovals(inputText, input);
  let rows = parseCandidateJsonl(candidateText, candidatePath);
  const canonicalRows = parseCandidateJsonl(canonicalText, canonicalPath);
  for (const removal of removals) {
    rows = patchCandidateRows(rows, { ...removal, action: 'remove' }).rows;
  }
  const canonicalLemmaForms = await loadCanonicalLemmaForms(repositoryDirectory);
  const summary = validateCandidateBatch(canonicalRows, rows, {
    batch: official.batch,
    canonicalLemmaForms,
    sourceName: canonicalPath,
    candidateName: candidatePath,
  });

  const temporaryPath = path.join(path.dirname(candidatePath), `.candidate-amend-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, serializeCandidateJsonl(rows), { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, candidatePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return {
    removed: removals.length,
    recordCount: summary.recordCount,
    senseCount: summary.senseCount,
    candidateCount: summary.candidateCount,
    beforeCandidateCount: summary.candidateCount + removals.length,
  };
}

function parseArgs(args) {
  if (args[0] !== 'remove') fail('only the remove subcommand is supported');
  const values = {};
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    if (!['--canonical', '--candidate', '--input'].includes(key) || !args[index + 1] || values[key]) {
      fail('usage: node scripts/relation/candidate-amend.mjs remove --canonical <canonical> --candidate <candidate.jsonl> --input .warroom-scratch/fix-remove.tsv');
    }
    values[key] = args[index + 1];
  }
  if (!values['--canonical'] || !values['--candidate'] || !values['--input']) {
    fail('usage: node scripts/relation/candidate-amend.mjs remove --canonical <canonical> --candidate <candidate.jsonl> --input .warroom-scratch/fix-remove.tsv');
  }
  return { canonicalPath: path.resolve(values['--canonical']), candidatePath: path.resolve(values['--candidate']),
    inputPath: values['--input'] };
}

async function main() {
  const result = await removeCandidates(parseArgs(process.argv.slice(2)));
  console.log(`Removed ${result.removed}; ${result.recordCount} records, ${result.senseCount} senses, ${result.candidateCount} candidates.`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
