import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadCanonicalLemmaForms, validateCandidateFiles } from './candidate-contract.mjs';
import { GIT_MAX_BUFFER } from '../ci/git-limits.mjs';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CANDIDATE_ROOT = 'data/relation-candidates/';

function fail(message) {
  throw new Error(message);
}

function readGit(args, cwd, runGit) {
  return runGit(args, cwd);
}

function decodePaths(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('Candidate diff path list is not valid UTF-8');
  }
  return text.split('\0').filter(Boolean);
}

function validateRepositoryPath(repositoryPath) {
  return repositoryPath.startsWith(CANDIDATE_ROOT)
    && !repositoryPath.includes('\\')
    && !repositoryPath.split('/').some((part) => part === '' || part === '.' || part === '..');
}

/** Validate every added or modified Candidate v1 file in an exact PR diff. */
export async function validateChangedCandidateFiles(baseSha, headSha, {
  repositoryDirectory = REPOSITORY_DIRECTORY,
  runGit = (args, cwd) => execFileSync('git', args, {
    cwd,
    encoding: 'buffer',
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
} = {}) {
  if (!/^[0-9a-f]{40}$/iu.test(baseSha ?? '') || !/^[0-9a-f]{40}$/iu.test(headSha ?? '')) {
    fail('Candidate validation requires exact 40-character base and head commit SHAs');
  }

  const diff = readGit([
    'diff', '--no-renames', '--diff-filter=ACMRT', '--name-only', '-z',
    `${baseSha}...${headSha}`, '--', CANDIDATE_ROOT,
  ], repositoryDirectory, runGit);
  const candidatePaths = [...new Set(decodePaths(diff))];
  const results = [];
  const canonicalLemmaForms = candidatePaths.length > 0
    ? await loadCanonicalLemmaForms(repositoryDirectory)
    : undefined;

  for (const candidateRelativePath of candidatePaths) {
    if (!validateRepositoryPath(candidateRelativePath)) {
      fail(`Candidate diff contains an invalid repository path: ${candidateRelativePath}`);
    }

    const candidateName = path.posix.basename(candidateRelativePath);
    const filenameShard = /^(\d{3})_/u.exec(candidateName)?.[1] ?? '000';
    const canonicalPath = path.resolve(
      repositoryDirectory,
      'data/canonical',
      `stdict-${filenameShard.padStart(4, '0')}.jsonl`,
    );
    const candidatePath = path.resolve(repositoryDirectory, candidateRelativePath);
    const result = await validateCandidateFiles(canonicalPath, candidatePath, { repositoryDirectory, canonicalLemmaForms });
    results.push({ path: candidateRelativePath, ...result });
  }

  return results;
}

async function main() {
  const [, , baseArgument, headArgument, ...extra] = process.argv;
  if (extra.length > 0) fail('usage: node scripts/relation/validate-candidate-changes.mjs [<base-sha> <head-sha>]');
  const baseSha = baseArgument ?? process.env.BASE_SHA;
  const headSha = headArgument ?? process.env.HEAD_SHA;

  if (!baseSha && !headSha && process.env.GITHUB_EVENT_NAME !== 'pull_request') {
    console.log('Candidate v1 changed-file validation skipped: exact PR revisions are unavailable.');
    return;
  }

  const results = await validateChangedCandidateFiles(baseSha, headSha);
  if (results.length === 0) {
    console.log('Candidate v1 changed-file validation: no added or modified Candidate files.');
    return;
  }
  for (const result of results) {
    console.log(`Candidate v1 valid: ${result.path}, ${result.recordCount} records, ${result.senseCount} senses, ${result.candidateCount} candidates, ${result.emptySenseCount} empty senses, 0 source-lemma candidates.`);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
