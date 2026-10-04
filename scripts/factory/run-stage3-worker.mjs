import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { createGitHubClient, githubToken, repositoryFromRemote } from './github-client.mjs';
import { loadFactorySnapshot } from './stage2-worker.mjs';
import {
  Stage3WorkerError,
  claimNextStage3Batch,
  createStage3Draft,
  createStage3GitRepository,
  eligibleStage3Batches,
  processStage3Attempt,
  createRejectionStatusPullRequest,
  recoverStage3Attempt,
  releaseStage3Claim,
  runStage3Session,
  waitForStage3PullRequest,
} from './stage3-worker.mjs';

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
    } else if (argument === '--resume-batch' || argument.startsWith('--resume-batch=')) {
      const value = argument === '--resume-batch' ? argv[++index] : argument.slice('--resume-batch='.length);
      if (!value || value.startsWith('--')) throw new Error('--resume-batch requires C000001 batch id');
      options.resumeBatch = value;
    } else if (argument === '--attempt' || argument.startsWith('--attempt=')) {
      const value = argument === '--attempt' ? argv[++index] : argument.slice('--attempt='.length);
      if (!value || value.startsWith('--')) throw new Error('--attempt requires a positive integer');
      options.resumeAttempt = Number(value);
    } else throw new Error('unknown argument ' + argument);
  }
  if (!['codex', 'claude'].includes(options.agent)) throw new Error('--agent must be codex or claude');
  if (options.repositoryFullName && !/^[^/]+\/[^/]+$/u.test(options.repositoryFullName)) throw new Error('--repo must be owner/name');
  if ((options.resumeBatch === undefined) !== (options.resumeAttempt === undefined)) throw new Error('--resume-batch and --attempt must be supplied together');
  if (options.resumeBatch !== undefined && !/^C\d{6}$/u.test(options.resumeBatch)) throw new Error('--resume-batch must be C followed by six digits');
  if (options.resumeAttempt !== undefined && (!Number.isInteger(options.resumeAttempt) || options.resumeAttempt < 1)) throw new Error('--attempt must be a positive integer');
  return options;
}

export const HELP = [
  'Run the serial Stage 3 admission worker until master has no unclaimed ready reviews.',
  '',
  'Usage: npm run factory:stage3 -- --agent codex|claude [--repo owner/name] [--dry-run]',
  '       npm run factory:stage3 -- --agent codex|claude --resume-batch C000001 --attempt 1',
  '',
  'Each attempt claims one ready review, commits an attempt marker, and opens a real Draft PR before preflight.',
  'The worker revalidates against latest master, prepares canonical JSONL, and marks that same PR ready only after the required gates pass.',
  'A lexical conflict closes the admission PR and opens a status-only rejected PR that cites its actual number.',
  'Interrupted attempts are resumed only when the exact batch and attempt are supplied with --resume-batch and --attempt.',
].join('\n');

function claimFromSnapshot(snapshot, { batchId, attempt, agent, branchName, baseSha, prNumber, prState, admissionPr }) {
  const review = snapshot.reviews.find((entry) => entry.batchId === batchId);
  const candidate = snapshot.candidates.find((entry) => entry.batchId === batchId);
  if (!review || !candidate || review.manifest.attempt !== attempt || review.manifest.status !== 'ready') {
    throw new Stage3WorkerError(`${batchId}-a${attempt} cannot resume against the current master factory snapshot`);
  }
  return {
    batchId, attempt, agent, branchName, prNumber, prState, admissionPr,
    claimRef: `refs/heads/stage3-claims/${batchId}-a${attempt}`,
    baseSha: baseSha || snapshot.headSha,
    rejectionBranchName: `${agent}/stage3-status/${batchId}-a${attempt}`,
    candidates: candidate.rows,
    candidateManifest: candidate.manifest,
    candidateFiles: candidate.files,
    reviewManifest: review.manifest,
    decisions: review.decisions,
    decisionsText: review.decisionsText,
    semanticDecisionsText: review.semanticDecisionsText,
    handoffText: review.handoffText,
    reviewFiles: review.files,
    canonicalEntries: snapshot.canonicalEntries,
  };
}

async function resumeStage3Cli({
  options, github, git, root, snapshot, loadSnapshot, interactive, log,
  createDraft = createStage3Draft, processAttempt = processStage3Attempt,
}) {
  const { resumeBatch: batchId, resumeAttempt: attempt, agent } = options;
  const recovered = await recoverStage3Attempt({
    github, git, root, agent, batchId, attempt, log,
    ...(options.dryRun ? { createRejection: async ({ admissionPr }) => ({ admissionPr }) } : {}),
  });
  if (options.dryRun) {
    const result = { status: 'recovery-dry-run', ...recovered };
    log(JSON.stringify(result));
    return result;
  }
  if (recovered.status === 'admission-merged' || recovered.status === 'rejection-merged') {
    const released = await releaseStage3Claim({
      github, git, claim: recovered, pullRequest: { number: recovered.prNumber }, loadSnapshot,
    });
    const result = { status: released ? 'recovered-merged-attempt' : 'claim-preserved', ...recovered };
    log(JSON.stringify(result));
    return result;
  }

  let claim;
  if (recovered.status === 'restore-starter' || recovered.status === 'restore-draft') {
    claim = claimFromSnapshot(snapshot, { ...recovered, agent, prState: 'draft' });
    if (recovered.status === 'restore-draft') {
      await git.refreshBranch(recovered.branchName);
      git.rebaseOnMaster();
      await git.pushRebasedBranch(recovered.branchName);
      claim.baseSha = git.resolveRef('origin/master');
    }
    claim = await createDraft({
      github, git, claim, existingStarter: recovered.status === 'restore-draft', log,
    });
  } else if (recovered.status === 'create-rejection' && recovered.prNumber) {
    // The recovery helper created the missing status-only PR and returned its real number.
    claim = recovered;
  } else if (recovered.status === 'create-rejection') {
    claim = claimFromSnapshot(snapshot, { ...recovered, agent, prState: 'starter' });
  } else {
    claim = claimFromSnapshot(snapshot, { ...recovered, agent });
  }

  if (recovered.status === 'resume-admission' && recovered.draft) {
    await git.refreshBranch(recovered.branchName);
    claim = await processAttempt({ github, git, root, claim, log });
  } else if (['restore-starter', 'restore-draft'].includes(recovered.status)) {
    // A recovered starter is only a checkpoint before preflight. Whether recovery had to
    // recreate the branch or found its remote starter, the newly opened Draft must enter
    // the same canonical preflight/admission-or-rejection path as a fresh attempt.
    claim = await processAttempt({ github, git, root, claim, log });
  } else if (recovered.status === 'create-rejection' && !recovered.prNumber) {
    claim = await createRejectionStatusPullRequest({
      github, git, root,
      claim: { ...claim, rejectionBranchName: `${agent}/stage3-status/${batchId}-a${attempt}` },
      admissionPr: recovered.admissionPr, log,
    });
  }

  const outcome = await interactive.waitForMerge(claim, claim);
  if (outcome.status !== 'merged') {
    const result = { status: outcome.status, batchId, attempt, prNumber: claim.prNumber };
    log(JSON.stringify(result));
    return result;
  }
  const released = await releaseStage3Claim({ github, git, claim, pullRequest: claim, outcome, loadSnapshot });
  const result = { status: released ? 'recovered-merged-attempt' : 'claim-preserved', batchId, attempt, prNumber: claim.prNumber };
  log(JSON.stringify(result));
  return result;
}

export function createInteractiveStage3Callbacks({ github, input = process.stdin, output = process.stdout, sleep } = {}) {
  const prompts = createInterface({ input, output, terminal: false });
  const ask = async (message) => {
    output.write(JSON.stringify(message) + '\n');
    let line;
    try { line = await prompts.question(''); } catch {
      throw new Stage3WorkerError('stdin closed while a Stage 3 PR is pending; preserving its claim and PR', {
        batchId: message.claim?.batchId, attempt: message.claim?.attempt, claimCreated: true, prNumber: message.pullRequest?.number,
      });
    }
    let reply;
    try { reply = JSON.parse(line); } catch {
      throw new Stage3WorkerError('primary context must reply with one JSON object per Stage 3 hand-off', {
        batchId: message.claim?.batchId, attempt: message.claim?.attempt, claimCreated: true, prNumber: message.pullRequest?.number,
      });
    }
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Stage3WorkerError('Stage 3 reply must be a JSON object');
    return reply;
  };
  return {
    async waitForMerge(claim, pr) {
      return waitForStage3PullRequest({
        github, prNumber: pr.prNumber, sleep,
        onPending: async (snapshot) => {
          const reply = await ask({
            event: 'STAGE3_PR_PENDING', claim,
            pullRequest: snapshot.pullRequest,
            reviews: snapshot.reviews ?? [],
            inlineComments: snapshot.inlineComments ?? [],
            conversationComments: snapshot.conversationComments ?? [],
            combinedStatus: snapshot.combinedStatus ?? null,
            checkRuns: snapshot.checkRuns ?? [],
            instructions: 'Check this exact PR head, every review submission, inline and conversation comment, and CI result. Apply accepted implementation fixes to this same branch and push them, or report why feedback is stale or outside scope. Reply {"action":"continue"} to wait another five minutes, or {"action":"stop"} to stop without claiming another batch.',
          });
          if (reply.action === 'stop') return { status: 'stopped-by-primary' };
          if (reply.action !== 'continue') throw new Stage3WorkerError('expected action continue or stop while the Stage 3 PR is open', {
            batchId: claim.batchId, attempt: claim.attempt, claimCreated: true, prNumber: pr.prNumber,
          });
        },
      });
    },
    close() { prompts.close(); },
  };
}

export async function runStage3Cli(argv, {
  root = ROOT, env = process.env, log = console.log,
  makeGit = createStage3GitRepository, makeGithub = createGitHubClient,
  loadSnapshot = loadFactorySnapshot, callbacks,
  createDraft = createStage3Draft, processAttempt = processStage3Attempt,
} = {}) {
  const options = parseArguments(argv);
  if (options.help) { log(HELP); return { status: 'help' }; }
  const git = makeGit({ root });
  const repositoryFullName = options.repositoryFullName || repositoryFromRemote(git.originRemote());
  const github = makeGithub({ repositoryFullName, token: githubToken({ env }) });
  await git.fetchMaster();
  const headSha = await github.getBranchHead('master');
  if (git.resolveRef('origin/master') !== headSha) throw new Stage3WorkerError('local origin/master does not match GitHub master');
  const snapshot = await loadSnapshot({ git, headSha });
  if (options.resumeBatch !== undefined) {
    const interactive = options.dryRun
      ? callbacks || { waitForMerge: async () => { throw new Stage3WorkerError('dry-run cannot wait for a PR'); } }
      : callbacks || createInteractiveStage3Callbacks({ github, input: process.stdin, output: process.stdout });
    try {
      return await resumeStage3Cli({
        options, github, git, root, snapshot, loadSnapshot, interactive, log,
        createDraft, processAttempt,
      });
    } finally {
      interactive.close?.();
    }
  }
  const [claimRefs, openPullRequests] = await Promise.all([github.listStage3ClaimRefs(), github.listPullRequests('open')]);
  const candidate = eligibleStage3Batches(snapshot, claimRefs, openPullRequests)[0];
  if (options.dryRun) {
    const result = candidate
      ? { status: 'dry-run', batchId: candidate.batchId, attempt: candidate.attempt, baseSha: headSha }
      : { status: 'no-unclaimed-ready-reviews', baseSha: headSha };
    log(JSON.stringify(result));
    return result;
  }
  const interactive = callbacks || createInteractiveStage3Callbacks({ github, input: process.stdin, output: process.stdout });
  try {
    const completed = await runStage3Session({
      claimNext: () => claimNextStage3Batch({ github, git, agent: options.agent, loadSnapshot, log }),
      processClaim: (claim) => processStage3Attempt({ github, git, root, claim, log }),
      waitForMerge: interactive.waitForMerge,
      releaseClaim: (claim, pullRequest, outcome) => releaseStage3Claim({ github, git, claim, pullRequest, outcome, loadSnapshot }),
      report: log,
    });
    const result = { status: 'session-finished', resolvedAttemptCount: completed.length, completed };
    log(JSON.stringify(result));
    return result;
  } finally {
    interactive.close?.();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runStage3Cli(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    if (error.claimCreated) console.error('Stage 3 claim remains in place; do not delete or adopt it automatically.');
    process.exitCode = 1;
  });
}
