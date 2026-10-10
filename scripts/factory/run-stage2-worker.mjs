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
          "After glosses and sense boundaries are fixed, run relation enrichment for every admitted sense: pnpm run relation:candidates <batch> --out <file>. Inspect roughly 20 candidates per sense where available (more when useful), against actual source and bound target senses. Apply the authoritative docs/relation-editorial-policy.md: direct (유의어) and antonym (반의어) need dictionary-grade lexical accuracy, but true synonyms do NOT need interchangeability in every sentence or identical gloss breadth, register or intensity. Do not demote legitimate synonyms to near or association merely for scope differences. near/mood (말의 결) and scene/sensory/action/association (연상) exist to enrich writer-facing nuance, imagery, feelings and imagination; they are not weaker dictionary categories. Preserve creative connections even when figurative, unconventional, cross-POS, broader/narrower or context-dependent if they have an intelligible writer path; do not reflexively veto for non-substitution or minor meaning distance. A clearly unrelated target without an intelligible rationale, wrong sense binding or invalid target-type contract must be corrected or omitted. For EVERY exploratory relation assign relevance 1..9 as ordinal display priority: 1 highest, 3 strong, 5 useful, 7 contextual, 9 peripheral but worth keeping; 2/4/6/8 intermediate, ties allowed. Relevance is NOT semantic distance or confidence. Before committing, compare EVERY proposed rank with already-authored canonical and proposed relations of the SAME SOURCE SENSE and UI group, and adjust material inversions rather than deleting plausible weaker creative links. Example: if 사람→엄마 is rank 2, new 사람→아빠 should normally be 2 too without a real editorial reason for distinction. 습지→모기/거머리 can be strong association while 습지→원숭이 can be a lower-priority tropical-context association. 습지→늪 and 차분하다→침착하다 deserve dictionary synonym review, not automatic association demotion. Examples illustrate editorial judgment only; do not add word-specific exceptions or mechanical subjective-scoring validators. Respect direction, existing reverse links and provenance; no required symmetry or equal rank across different source senses. Author genuine direct/antonym/near/mood/scene/sensory/action/association relations in reviewed_record.senses[].relations; exploratory relations require relevance, precision relations do not. Reverse links to existing sources belong in relation_amendments. Record relation_decision relations-reviewed or no-relations (with a sense-bound rationale) per sense. Zero relations is valid and never blocks admission; no relation quota.",
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
