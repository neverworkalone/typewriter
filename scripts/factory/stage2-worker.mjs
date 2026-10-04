import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { validateFactoryRepository } from './validate.mjs';
import { parseJsonl } from './contract.mjs';

const MASTER = 'master';
const CLAIM_PREFIX = 'refs/heads/stage2-claims/';

export class Stage2WorkerError extends Error {
  constructor(message, { batchId, claimCreated = false, issueNumber } = {}) {
    super(message);
    this.name = 'Stage2WorkerError';
    this.batchId = batchId;
    this.claimCreated = claimCreated;
    this.issueNumber = issueNumber;
  }
}

function gitRun(root, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (error) {
    if (allowFailure && error.status === 1) return null;
    const detail = String(error.stderr || error.message || '').trim();
    throw new Error('git ' + args.join(' ') + ' failed' + (detail ? ': ' + detail : ''));
  }
}

export function createGitRepository({ root = process.cwd() } = {}) {
  return {
    root,
    async fetchMaster() {
      gitRun(root, ['fetch', 'origin', 'master:refs/remotes/origin/master']);
    },
    resolveRef(ref) {
      return gitRun(root, ['rev-parse', ref + '^{commit}']);
    },
    listFiles(ref) {
      const listing = gitRun(root, ['ls-tree', '-r', '--name-only', ref, '--', 'data/candidates', 'data/reviews', 'data/canonical', 'data/validation/canonical-semantic-decision-source.json']);
      return listing ? listing.split('\n').filter(Boolean) : [];
    },
    show(ref, file) {
      return execFileSync('git', ['show', ref + ':' + file], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
      });
    },
    createBranch(branchName, baseSha) {
      const status = gitRun(root, ['status', '--porcelain', '--untracked-files=all']);
      if (status) throw new Error('working tree must be clean before creating a Stage 2 branch');
      if (gitRun(root, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branchName], { allowFailure: true }) !== null) {
        throw new Error('local branch already exists: ' + branchName);
      }
      if (gitRun(root, ['ls-remote', '--heads', 'origin', 'refs/heads/' + branchName])) {
        throw new Error('remote branch already exists: ' + branchName);
      }
      gitRun(root, ['switch', '-c', branchName, baseSha]);
    },
    originRemote() {
      return gitRun(root, ['remote', 'get-url', 'origin']);
    },
  };
}

function parseJson(text, label) {
  try { return JSON.parse(text); } catch (error) {
    throw new Stage2WorkerError(label + ' is invalid JSON: ' + error.message);
  }
}

function parseCanonicalEntries(text, label) {
  const entries = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      throw new Stage2WorkerError(label + ':' + (index + 1) + ' is invalid JSON');
    }
  }
  return entries;
}

const pathRule = {
  candidate: /^data\/candidates\/(C\d{6})\/(manifest\.json|candidates\.jsonl)$/u,
  review: /^data\/reviews\/(C\d{6})\/(manifest\.json|decisions\.jsonl|semantic-decisions\.json|intake-handoff\.json)$/u,
  canonical: /^data\/canonical\/[^/]+\.jsonl$/u,
};

export async function loadFactorySnapshot({ git, headSha }) {
  const files = git.listFiles(headSha);
  const candidateFiles = new Map();
  const reviewFiles = new Map();
  const canonicalPaths = [];
  for (const file of files) {
    const candidate = file.match(pathRule.candidate);
    const review = file.match(pathRule.review);
    if (candidate) {
      if (!candidateFiles.has(candidate[1])) candidateFiles.set(candidate[1], new Map());
      candidateFiles.get(candidate[1]).set(candidate[2], file);
    } else if (review) {
      if (!reviewFiles.has(review[1])) reviewFiles.set(review[1], new Map());
      reviewFiles.get(review[1]).set(review[2], file);
    } else if (pathRule.canonical.test(file)) canonicalPaths.push(file);
    else if (file.startsWith('data/candidates/') || file.startsWith('data/reviews/')) {
      throw new Stage2WorkerError('unrecognized factory artifact path on master: ' + file);
    }
  }

  const sourceFiles = new Map();
  const canonicalEntries = [];
  const semanticAuthorityPath = 'data/validation/canonical-semantic-decision-source.json';
  if (files.includes(semanticAuthorityPath)) sourceFiles.set(semanticAuthorityPath, git.show(headSha, semanticAuthorityPath));
  for (const [batchId, paths] of candidateFiles) {
    if (paths.size !== 2 || !paths.has('manifest.json') || !paths.has('candidates.jsonl')) {
      throw new Stage2WorkerError(batchId + ' has an incomplete candidate artifact set');
    }
    for (const file of paths.values()) sourceFiles.set(file, git.show(headSha, file));
  }
  for (const [batchId, paths] of reviewFiles) {
    const expected = ['manifest.json', 'decisions.jsonl', 'semantic-decisions.json', 'intake-handoff.json'];
    if (paths.size !== expected.length || expected.some((name) => !paths.has(name))) {
      throw new Stage2WorkerError(batchId + ' has an incomplete review artifact set');
    }
    for (const file of paths.values()) sourceFiles.set(file, git.show(headSha, file));
  }
  for (const file of canonicalPaths.sort()) {
    const text = git.show(headSha, file);
    sourceFiles.set(file, text);
    canonicalEntries.push(...parseCanonicalEntries(text, file));
  }

  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-stage2-master-'));
  try {
    for (const [file, content] of sourceFiles) {
      const target = path.join(root, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }
    const errors = await validateFactoryRepository({ root, canonicalEntries });
    if (errors.length) throw new Stage2WorkerError('merged master factory data failed validation:\n' + errors.join('\n'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const candidates = [];
  const candidatesByBatch = new Map();
  for (const [batchId, paths] of candidateFiles) {
    const manifest = parseJson(sourceFiles.get(paths.get('manifest.json')), batchId + '/manifest.json');
    const candidatesText = sourceFiles.get(paths.get('candidates.jsonl'));
    const errors = [];
    const rows = parseJsonl(candidatesText, batchId + '/candidates.jsonl', errors);
    if (errors.length) throw new Stage2WorkerError(errors.join('\n'));
    const candidate = { batchId, manifest, candidatesText, rows, files: Object.fromEntries(paths) };
    candidates.push(candidate);
    candidatesByBatch.set(batchId, candidate);
  }
  const reviews = [];
  for (const [batchId, paths] of reviewFiles) {
    const manifest = parseJson(sourceFiles.get(paths.get('manifest.json')), batchId + '/manifest.json');
    const decisionsText = sourceFiles.get(paths.get('decisions.jsonl'));
    const errors = [];
    const decisions = parseJsonl(decisionsText, batchId + '/decisions.jsonl', errors);
    if (errors.length) throw new Stage2WorkerError(errors.join('\n'));
    reviews.push({
      batchId, manifest, decisions, decisionsText,
      semanticDecisionsText: sourceFiles.get(paths.get('semantic-decisions.json')),
      handoffText: sourceFiles.get(paths.get('intake-handoff.json')),
      files: Object.fromEntries(paths), candidate: candidatesByBatch.get(batchId),
    });
  }
  return { headSha, candidates, reviews, canonicalEntries, validated: true };
}

function naturalBatchOrder(left, right) {
  return left.batchId.localeCompare(right.batchId, 'en', { numeric: true });
}

export function eligibleBatches(snapshot, claimRefs = []) {
  if (!snapshot || !Array.isArray(snapshot.candidates) || !Array.isArray(snapshot.reviews)) {
    throw new Stage2WorkerError('validated master snapshot is required');
  }
  const claimed = new Set(claimRefs.map((value) => typeof value === 'string' ? value : value.ref).filter(Boolean));
  const reviews = new Map(snapshot.reviews.map((entry) => [entry.batchId, entry.manifest]));
  const rework = [];
  const created = [];
  for (const candidate of snapshot.candidates) {
    const review = reviews.get(candidate.batchId);
    const ref = CLAIM_PREFIX + candidate.batchId;
    if (claimed.has(ref)) continue;
    if (review && review.status === 'rejected' && candidate.manifest.status === 'complete') rework.push({
      ...candidate, review, rework: true, attempt: review.attempt + 1, rejectedPr: review.rejected_pr,
    });
    else if (!review && candidate.manifest.status === 'created') created.push({
      ...candidate, review: null, rework: false, attempt: 1, rejectedPr: null,
    });
  }
  return [...rework.sort(naturalBatchOrder), ...created.sort(naturalBatchOrder)];
}

async function currentMaster({ github, git, loadSnapshot }) {
  await git.fetchMaster();
  let remoteSha = await github.getBranchHead(MASTER);
  let localSha = git.resolveRef('origin/master');
  if (remoteSha !== localSha) {
    await git.fetchMaster();
    remoteSha = await github.getBranchHead(MASTER);
    localSha = git.resolveRef('origin/master');
  }
  if (remoteSha !== localSha) throw new Stage2WorkerError('local origin/master does not match GitHub master; refusing to claim from a stale snapshot');
  return { headSha: remoteSha, snapshot: await loadSnapshot({ git, headSha: remoteSha }) };
}

function issueBody({ batchId, claimRef, baseSha, attempt, rejectedPr }) {
  const lines = [
    'Tracks full Stage 2 lexical authoring and source-bound semantic QA for ' + batchId + '.',
    '',
    'Claim ref: ' + claimRef,
    'Master snapshot: ' + baseSha,
    'Implementation scope: #265',
    'Attempt: ' + attempt,
    'Result PR: the Stage 2 result PR should close this tracking issue when merged.',
  ];
  if (rejectedPr) lines.push('Prior rejected admission PR: #' + rejectedPr);
  return lines.join('\n');
}

function branchNameFor(agent, issueNumber, batchId, attempt) {
  if (!['codex', 'claude'].includes(agent)) throw new Stage2WorkerError('agent must be codex or claude');
  const base = agent + '/stage2/' + issueNumber + '-' + batchId;
  return attempt > 1 ? base + '-r' + attempt : base;
}

export async function claimNextStage2Batch({
  github, git, agent = 'codex', loadSnapshot = loadFactorySnapshot, log = () => {},
} = {}) {
  const { headSha, snapshot } = await currentMaster({ github, git, loadSnapshot });
  const claimRefs = await github.listClaimRefs();
  const candidates = eligibleBatches(snapshot, claimRefs);
  if (!candidates.length) return null;

  for (const candidate of candidates) {
    const { batchId } = candidate;
    const claimRef = CLAIM_PREFIX + batchId;
    const claimed = await github.createClaimRef(batchId, headSha);
    if (!claimed) {
      log('claim raced for ' + batchId + '; trying the next eligible batch');
      claimRefs.push({ ref: claimRef });
      continue;
    }

    let issueNumber;
    try {
      const matchingIssues = await github.findIssuesForClaim(claimRef);
      if (candidate.rework) {
        if (matchingIssues.length !== 1) {
          throw new Stage2WorkerError(
            'rework claim ' + batchId + ' must resolve to exactly one prior tracking issue; found ' + matchingIssues.length,
            { batchId, claimCreated: true },
          );
        }
        const issue = matchingIssues[0];
        issueNumber = issue.number;
        if (issue.state === 'closed') await github.updateIssue(issueNumber, { state: 'open' });
      } else {
        if (matchingIssues.length) {
          throw new Stage2WorkerError(
            'new claim ' + batchId + ' found an older issue citing the claim ref; owner-directed recovery is required',
            { batchId, claimCreated: true, issueNumber: matchingIssues[0].number },
          );
        }
        const issue = await github.createIssue({
          title: '[Stage 2] ' + batchId + ' lexical authoring and QA',
          body: issueBody({ batchId, claimRef, baseSha: headSha, attempt: candidate.attempt, rejectedPr: candidate.rejectedPr }),
        });
        issueNumber = issue.number;
      }

      const branchName = branchNameFor(agent, issueNumber, batchId, candidate.attempt);
      git.createBranch(branchName, headSha);
      if (candidate.rework) {
        await github.addIssueComment(issueNumber, [
          'Stage 2 rework attempt ' + candidate.attempt + ' claimed for ' + batchId + '.',
          'Claim ref: ' + claimRef,
          'Master snapshot: ' + headSha,
          'Branch: ' + branchName,
          'Prior rejected admission PR: #' + candidate.rejectedPr,
        ].join('\n'));
      }
      const result = {
        batchId, attempt: candidate.attempt, issueNumber, branchName, baseSha: headSha, claimRef,
        rework: candidate.rework, rejectedPr: candidate.rejectedPr, candidatesSha256: candidate.manifest.candidates_sha256,
      };
      log(JSON.stringify(result));
      return result;
    } catch (error) {
      if (error instanceof Stage2WorkerError && error.claimCreated) throw error;
      throw new Stage2WorkerError(
        'claim ' + batchId + ' was created; preserve it and resolve this interrupted attempt manually: ' + error.message,
        { batchId, claimCreated: true, issueNumber },
      );
    }
  }
  return null;
}

export async function waitForPullRequestMerge({
  github, prNumber, intervalMs = 300_000, onPending = async () => {}, sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
} = {}) {
  while (true) {
    const snapshot = typeof github.getPullRequestSnapshot === 'function'
      ? await github.getPullRequestSnapshot(prNumber)
      : await github.getPullRequest(prNumber);
    const pullRequest = snapshot.pullRequest || snapshot;
    if (pullRequest.merged === true || pullRequest.merged_at) return { status: 'merged', pullRequest, snapshot };
    if (pullRequest.state === 'closed') return { status: 'closed-unmerged', pullRequest, snapshot };
    const decision = await onPending(snapshot);
    if (decision?.status) return { ...decision, pullRequest, snapshot };
    await sleep(intervalMs);
  }
}

export async function releaseClaimAfterMerge({ github, git, claim, prNumber, loadSnapshot = loadFactorySnapshot } = {}) {
  const pullRequest = await github.getPullRequest(prNumber);
  if (pullRequest.merged !== true && !pullRequest.merged_at) return false;
  if (pullRequest.base?.ref !== MASTER || pullRequest.head?.ref !== claim.branchName) {
    throw new Stage2WorkerError('merged result PR does not match the claimed branch and master base', { batchId: claim.batchId });
  }
  const { snapshot } = await currentMaster({ github, git, loadSnapshot });
  const candidate = snapshot.candidates.find((entry) => entry.batchId === claim.batchId);
  const review = snapshot.reviews.find((entry) => entry.batchId === claim.batchId);
  if (!candidate || candidate.manifest.status !== 'complete' || !review || review.manifest.status !== 'ready'
    || review.manifest.attempt !== claim.attempt) {
    throw new Stage2WorkerError('master does not contain this merged Stage 2 result; preserving claim ref', { batchId: claim.batchId });
  }
  await github.deleteClaimRef(claim.batchId);
  return true;
}

// The primary agent supplies the authoring and feedback handling callbacks. Awaiting each result
// PR's merge is the gate that prevents a second claim/Issue/branch in the same session.
export async function runStage2Session({
  claimNext, startResultPr, waitForMerge, releaseClaim, report = () => {},
} = {}) {
  const completed = [];
  while (true) {
    const claim = await claimNext();
    if (!claim) {
      report('No unclaimed Stage 2 batches remain.');
      return completed;
    }
    const pullRequest = await startResultPr(claim);
    if (!pullRequest || !Number.isInteger(pullRequest.number)) {
      throw new Stage2WorkerError('Stage 2 authoring must return its result PR number', { batchId: claim.batchId, claimCreated: true, issueNumber: claim.issueNumber });
    }
    const outcome = await waitForMerge(claim, pullRequest);
    if (outcome.status !== 'merged') {
      throw new Stage2WorkerError(
        'Stage 2 PR #' + pullRequest.number + ' ended as ' + outcome.status + '; stopping without claiming another batch',
        { batchId: claim.batchId, claimCreated: true, issueNumber: claim.issueNumber },
      );
    }
    const released = await releaseClaim(claim, pullRequest, outcome);
    if (released !== true) {
      throw new Stage2WorkerError('Stage 2 PR #' + pullRequest.number + ' merged but the claim was not safely released', {
        batchId: claim.batchId, claimCreated: true, issueNumber: claim.issueNumber,
      });
    }
    completed.push({ claim, pullRequest });
    report('Merged Stage 2 PR #' + pullRequest.number + ' for ' + claim.batchId + '; claim released.');
  }
}
