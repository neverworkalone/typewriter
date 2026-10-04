import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createGitHubClient, githubToken, repositoryFromRemote } from './github-client.mjs';
import { claimNextStage2Batch, createGitRepository, eligibleBatches, loadFactorySnapshot } from './stage2-worker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function parseArguments(argv) {
  const options = { agent: 'codex', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--agent' || argument.startsWith('--agent=')) {
      const value = argument === '--agent' ? argv[++index] : argument.slice('--agent='.length);
      if (!value || value.startsWith('--')) throw new Error('--agent requires codex or claude');
      options.agent = value;
    } else if (argument === '--repo' || argument.startsWith('--repo=')) {
      const value = argument === '--repo' ? argv[++index] : argument.slice('--repo='.length);
      if (!value || value.startsWith('--')) throw new Error('--repo requires owner/name');
      options.repositoryFullName = value;
    } else throw new Error('unknown argument ' + argument);
  }
  if (!['codex', 'claude'].includes(options.agent)) throw new Error('--agent must be codex or claude');
  if (options.repositoryFullName && !/^[^/]+\/[^/]+$/u.test(options.repositoryFullName)) {
    throw new Error('--repo must be owner/name');
  }
  return options;
}

export const HELP = [
  'Claim one eligible Stage 2 batch from the latest merged master.',
  '',
  'Usage: npm run factory:stage2 -- --agent codex|claude [--repo owner/name] [--dry-run]',
  '',
  'The command creates the GitHub claim ref before creating or reopening the tracking Issue.',
  'It then creates a local branch based on the verified master SHA and prints the batch hand-off.',
].join('\n');

export async function runStage2Cli(argv, {
  root = ROOT, env = process.env, log = console.log,
  makeGit = createGitRepository, makeGithub = createGitHubClient,
} = {}) {
  const options = parseArguments(argv);
  if (options.help) {
    log(HELP);
    return { status: 'help' };
  }
  const git = makeGit({ root });
  const repositoryFullName = options.repositoryFullName || repositoryFromRemote(git.originRemote());
  const github = makeGithub({ repositoryFullName, token: githubToken({ env }) });

  if (options.dryRun) {
    await git.fetchMaster();
    const headSha = await github.getBranchHead('master');
    if (git.resolveRef('origin/master') !== headSha) throw new Error('local origin/master does not match GitHub master');
    const snapshot = await loadFactorySnapshot({ git, headSha });
    const candidate = eligibleBatches(snapshot, await github.listClaimRefs())[0];
    const result = candidate
      ? { status: 'dry-run', batchId: candidate.batchId, attempt: candidate.attempt, rework: candidate.rework, baseSha: headSha }
      : { status: 'no-unclaimed-batches', baseSha: headSha };
    log(JSON.stringify(result));
    return result;
  }

  const claim = await claimNextStage2Batch({ github, git, agent: options.agent, log });
  if (!claim) {
    const result = { status: 'no-unclaimed-batches' };
    log(JSON.stringify(result));
    return result;
  }
  const result = {
    status: 'claimed',
    ...claim,
    next: 'Perform full Stage 2 authoring and QA in this primary agent context, create one result PR that closes the tracking Issue, then wait for that PR to merge before another claim.',
  };
  log(JSON.stringify(result));
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runStage2Cli(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    if (error.claimCreated) console.error('Claim ref remains in place; do not delete or adopt it automatically.');
    process.exitCode = 1;
  });
}
