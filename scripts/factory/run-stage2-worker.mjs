import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { createGitHubClient, githubToken, repositoryFromRemote } from './github-client.mjs';
import {
  Stage2WorkerError,
  claimNextStage2Batch,
  createGitRepository,
  eligibleBatches,
  loadFactorySnapshot,
  releaseClaimAfterMerge,
  runStage2Session,
  waitForPullRequestMerge,
} from './stage2-worker.mjs';

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
  'Run the serial Stage 2 worker until master has no unclaimed batches.',
  '',
  'Usage: pnpm run factory:stage2 --agent codex|claude [--repo owner/name] [--dry-run]',
  '',
  'The command claims a batch, then pauses for the active primary agent to complete full QA and create its result PR.',
  'It monitors that PR, releases the claim only after the result is present on master, and then claims the next batch.',
  'Respond to each JSON hand-off on stdin with the requested JSON reply; no other agent or model is started.',
].join('\n');

export function createInteractiveStage2Callbacks({
  github, input = process.stdin, output = process.stdout, sleep,
} = {}) {
  const prompts = createInterface({ input, output, terminal: false });
  const ask = async (message) => {
    output.write(JSON.stringify(message) + '\n');
    const context = {
      batchId: message.claim?.batchId,
      claimCreated: Boolean(message.claim),
      issueNumber: message.claim?.issueNumber,
    };
    let line;
    try {
      line = await prompts.question('');
    } catch {
      throw new Stage2WorkerError('stdin closed during the Stage 2 session; preserving the current claim', context);
    }
    let reply;
    try { reply = JSON.parse(line); } catch {
      throw new Stage2WorkerError('primary context must reply with one JSON object per hand-off', context);
    }
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
      throw new Stage2WorkerError('primary context reply must be a JSON object', context);
    }
    return reply;
  };
  return {
    async startResultPr(claim) {
      const reply = await ask({
        event: 'AUTHOR_STAGE2_RESULT',
        claim,
        instructions: [
          'Complete full lexical authoring and source-bound semantic QA on the current branch.',
          'Before finalizing a usage-group deferral whose only remaining reason is insufficient contextual evidence (no hard hold), run one bounded lookup: pnpm run factory:literature-rescue lookup <batch> <candidate> <group>. Judge the actual contexts yourself; record the text-free result as literature_lookup on that group_decisions entry (informed / deferral_changed_to_included are yours to set). No hit or an unavailable lookup is not negative evidence.',
          'After glosses and sense boundaries are fixed, run relation enrichment for every admitted sense: pnpm run relation:candidates <batch> --out <file>. Review roughly 20 candidates per sense where available (more when useful), judge each yourself, and author genuine direct (유의어), antonym (반의어), near/mood (말의 결; near is only for closely meaning-adjacent alternatives, so hypernym/hyponym "X is a kind of Y" links, part-whole and domain membership are association or omitted, never near; judge near from the actual bound target sense gloss and part of speech, never from shared gloss words, so a wider or narrower extent, a literal versus figurative sense, a state versus an action or attitude, or a cause versus an act is association; before finalizing, run a bounded same-source-sense consistency pass: compare every retained near against the other near and association links authored from that same source sense, especially differences of broad versus narrow extent, formal or public qualifiers, literal versus figurative use, and action versus state, e.g. if 소아 to 아동 is association because 아동 also covers adolescents, then 소아 to 아이 needs the same reasoning, while 소아 to 어린이 can stay near, and if 선서 to 맹세 is association because 맹세 lacks the public element, 선서 to 서약 must be judged the same way; when classifications differ, state the specific difference or correct them; when a reverse link between the same two senses is already authored, check that the two rationales do not contradict each other about whether the words are substitutable (one direction near and the other association for the same reason is a contradiction), while legitimately direction-specific types such as 기쁨 to 웃다 action versus 웃다 to 기쁨 mood stay as authored, and never create or retype a reverse link only for symmetry) and scene/sensory/action/association (연상) relations in reviewed_record.senses[].relations with relevance where required; reverse links to existing senses go in relation_amendments. Record relation_decision relations-reviewed or no-relations (with a sense-bound rationale) per sense. Zero relations is a valid outcome and never blocks admission; there is no relation quota.',
          'Run the shared validators and prospective canonical preflight without editing canonical JSONL.',
          'Commit and push the result branch, then create exactly one result PR that closes the tracking Issue.',
          'Reply with {"action":"created","pr_number":123} after the PR exists, or {"action":"stop"} to stop safely.',
        ],
      });
      if (reply.action === 'stop') {
        throw new Stage2WorkerError('primary context stopped after claiming ' + claim.batchId, {
          batchId: claim.batchId, claimCreated: true, issueNumber: claim.issueNumber,
        });
      }
      if (reply.action !== 'created' || !Number.isInteger(reply.pr_number) || reply.pr_number < 1) {
        throw new Stage2WorkerError('expected action created with a numeric pr_number', {
          batchId: claim.batchId, claimCreated: true, issueNumber: claim.issueNumber,
        });
      }
      return { number: reply.pr_number, url: reply.url };
    },
    async waitForMerge(claim, pullRequest) {
      return waitForPullRequestMerge({
        github, prNumber: pullRequest.number, sleep,
        onPending: async (snapshot) => {
          const reply = await ask({
            event: 'STAGE2_PR_PENDING',
            claim,
            pullRequest: snapshot.pullRequest || snapshot,
            reviews: snapshot.reviews || [],
            inlineComments: snapshot.inlineComments || [],
            conversationComments: snapshot.conversationComments || [],
            combinedStatus: snapshot.combinedStatus || null,
            checkRuns: snapshot.checkRuns || [],
            instructions: 'Check the current head, review batch, comments, and CI. Apply accepted fixes to this same branch, push them, then reply {"action":"continue"} to wait another five minutes, or {"action":"stop"} to end without claiming another batch.',
          });
          if (reply.action === 'stop') {
            return { status: 'stopped-by-primary' };
          }
          if (reply.action !== 'continue') throw new Stage2WorkerError('expected action continue or stop while the result PR is open', {
            batchId: claim.batchId, claimCreated: true, issueNumber: claim.issueNumber,
          });
        },
      });
    },
    close() {
      prompts.close();
    },
  };
}

export async function runStage2Cli(argv, {
  root = ROOT, env = process.env, log = console.log,
  makeGit = createGitRepository, makeGithub = createGitHubClient,
  loadSnapshot = loadFactorySnapshot, sessionCallbacks,
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
    const snapshot = await loadSnapshot({ git, headSha });
    const candidate = eligibleBatches(snapshot, await github.listClaimRefs())[0];
    const result = candidate
      ? { status: 'dry-run', batchId: candidate.batchId, attempt: candidate.attempt, rework: candidate.rework, baseSha: headSha }
      : { status: 'no-unclaimed-batches', baseSha: headSha };
    log(JSON.stringify(result));
    return result;
  }

  const callbacks = sessionCallbacks || createInteractiveStage2Callbacks({ github, input: process.stdin, output: process.stdout });
  try {
    const completed = await runStage2Session({
      claimNext: () => claimNextStage2Batch({ github, git, agent: options.agent, loadSnapshot, log }),
      startResultPr: callbacks.startResultPr,
      waitForMerge: callbacks.waitForMerge,
      releaseClaim: (claim, pullRequest) => releaseClaimAfterMerge({
        github, git, claim, prNumber: pullRequest.number, loadSnapshot,
      }),
      report: log,
    });
    const result = { status: 'session-finished', mergedBatchCount: completed.length, completed };
    log(JSON.stringify(result));
    return result;
  } finally {
    callbacks.close?.();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runStage2Cli(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    if (error.claimCreated) console.error('Claim ref remains in place; do not delete or adopt it automatically.');
    process.exitCode = 1;
  });
}
