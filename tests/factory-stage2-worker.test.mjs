import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createGitHubClient, repositoryFromRemote } from '../scripts/factory/github-client.mjs';
import { CANDIDATE_MANIFEST_CONTRACT, PROPOSAL_CONTRACT, expectedAnalyzerDigest, sha256Hex } from '../scripts/factory/contract.mjs';
import { isStage2TrackingIssue, trackingIssueBody, trackingIssueTitle } from '../scripts/factory/stage2-issue.mjs';
import { createInteractiveStage2Callbacks, runStage2Cli } from '../scripts/factory/run-stage2-worker.mjs';
import {
  Stage2WorkerError,
  claimNextStage2Batch,
  createGitRepository,
  eligibleBatches,
  loadFactorySnapshot,
  releaseClaimAfterMerge,
  runStage2Session,
  waitForPullRequestMerge,
} from '../scripts/factory/stage2-worker.mjs';

const SHA = 'a'.repeat(40);
const DIGEST = (value) => sha256Hex(value);
const record = (batchId, ref) => ({
  candidate_id: batchId + '-0001',
  input: '짠하다',
  pos: 'adjective',
  usage_hint: 'a provisional usage',
  observedForms: ['짠한'],
  evidence: [{ kind: 'corpus-paragraph', ref }],
  holds: [],
});
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

function candidateArtifacts(batchId, { status = 'created', ref = batchId } = {}) {
  const candidatesText = jsonl([record(batchId, ref)]);
  const manifest = {
    contract: CANDIDATE_MANIFEST_CONTRACT,
    task_id: 'T000001',
    batch_id: batchId,
    candidate_count: 1,
    source_adapter: 'corpus-adapter',
    source_snapshot: 'snapshot-' + batchId,
    canonical_snapshot_digest: DIGEST('canonical'),
    extractor_version: 'test',
    analyzer_version: 'kiwipiepy==0.24.0',
    proposal_contract: PROPOSAL_CONTRACT,
    analyzer_digest: expectedAnalyzerDigest({ analyzer_version: 'kiwipiepy==0.24.0', proposal_contract: PROPOSAL_CONTRACT }),
    source_evidence_sha256: DIGEST('evidence-' + batchId),
    candidates_sha256: sha256Hex(candidatesText),
    status,
  };
  return { manifest, candidatesText };
}

function snapshotGit(batches) {
  const files = new Map();
  for (const [batchId, artifacts] of Object.entries(batches)) {
    files.set('data/candidates/' + batchId + '/manifest.json', JSON.stringify(artifacts.manifest) + '\n');
    files.set('data/candidates/' + batchId + '/candidates.jsonl', artifacts.candidatesText);
  }
  return {
    files,
    async fetchMaster() {},
    resolveRef() { return SHA; },
    listFiles() { return [...files.keys()]; },
    show(_ref, file) {
      if (!files.has(file)) throw new Error('missing ' + file);
      return files.get(file);
    },
    createBranch(branchName, baseSha) {
      this.branches.push({ branchName, baseSha });
    },
    branches: [],
    originRemote() { return 'https://github.com/neverworkalone/typewriter.git'; },
  };
}

function queueSnapshot(batchIds) {
  return {
    headSha: SHA,
    validated: true,
    candidates: batchIds.map((batchId) => {
      const artifacts = candidateArtifacts(batchId);
      return {
        batchId, manifest: artifacts.manifest, candidatesText: artifacts.candidatesText,
        rows: [record(batchId, batchId)],
      };
    }),
    reviews: [],
  };
}

class FakeGitHub {
  constructor({ raceInitialReads = false } = {}) {
    this.refs = new Map();
    this.issues = [];
    this.pullRequests = new Map();
    this.events = [];
    this.nextIssue = 300;
    this.claimAttempts = [];
    this.deletedClaims = [];
    this.raceInitialReads = raceInitialReads;
    this.listCalls = 0;
    this.releaseListBarrier = null;
    this.listBarrier = new Promise((resolve) => { this.releaseListBarrier = resolve; });
  }

  async getBranchHead() { return SHA; }
  async listClaimRefs() {
    this.listCalls += 1;
    if (this.raceInitialReads && this.listCalls <= 2) {
      if (this.listCalls === 2) this.releaseListBarrier();
      await this.listBarrier;
      return [];
    }
    return [...this.refs.keys()].map((ref) => ({ ref }));
  }
  async createClaimRef(batchId, sha) {
    const ref = 'refs/heads/stage2-claims/' + batchId;
    if (this.refs.has(ref)) {
      this.claimAttempts.push({ batchId, won: false });
      this.events.push('claim-lost:' + batchId);
      return false;
    }
    this.refs.set(ref, sha);
    this.claimAttempts.push({ batchId, won: true });
    this.events.push('claim-won:' + batchId);
    return true;
  }
  async findIssuesForClaim(claimRef) { return this.issues.filter((issue) => isStage2TrackingIssue(issue, claimRef)); }
  async createIssue(issue) {
    const created = { ...issue, number: this.nextIssue++, state: 'open' };
    this.issues.push(created);
    this.events.push('issue:' + created.number + ':' + issue.body.match(/C\d{6}/u)?.[0]);
    return created;
  }
  async updateIssue(number, update) {
    const issue = this.issues.find((item) => item.number === number);
    Object.assign(issue, update);
    this.events.push('issue-state:' + number + ':' + update.state);
    return issue;
  }
  async addIssueComment(number, comment) {
    this.events.push('issue-comment:' + number);
    this.issues.find((item) => item.number === number).comments = [
      ...(this.issues.find((item) => item.number === number).comments || []), comment,
    ];
  }
  async deleteClaimRef(batchId) {
    this.deletedClaims.push(batchId);
    this.refs.delete('refs/heads/stage2-claims/' + batchId);
    this.events.push('claim-released:' + batchId);
  }
  async getPullRequest(number) {
    const result = this.pullRequests.get(number);
    if (Array.isArray(result)) {
      const next = result.length > 1 ? result.shift() : result[0];
      this.events.push('pr:' + number + ':' + next.state + ':' + (next.merged ? 'merged' : 'pending'));
      return next;
    }
    this.events.push('pr:' + number + ':' + result.state + ':' + (result.merged ? 'merged' : 'pending'));
    return result;
  }
}

const runClaim = (github, git, options = {}) => claimNextStage2Batch({
  github, git, agent: 'codex', loadSnapshot: options.loadSnapshot || loadFactorySnapshot, log: () => {},
});

test('GitHub claim creation is an atomic REST ref operation and 422 is a lost race', async () => {
  const calls = [];
  let responseMessage = 'Reference already exists';
  const github = createGitHubClient({
    repositoryFullName: 'neverworkalone/typewriter',
    token: 'test-token',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ message: responseMessage }), {
        status: 422, headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(await github.createClaimRef('C000001', SHA), false);
  assert.equal(calls[0].url, 'https://api.github.com/repos/neverworkalone/typewriter/git/refs');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: 'refs/heads/stage2-claims/C000001', sha: SHA });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
  assert.equal(repositoryFromRemote('git@github.com:neverworkalone/typewriter.git'), 'neverworkalone/typewriter');
  responseMessage = 'Validation Failed';
  await assert.rejects(github.createClaimRef('C000001', SHA), /Validation Failed/u);
});

test('Stage 3 global lock uses a unique Git commit and a singleton atomic ref', async () => {
  const calls = [];
  const lockSha = 'b'.repeat(40);
  const ownerToken = 'deafbeef-0000-4000-8000-000000000001';
  let existing = false;
  const github = createGitHubClient({
    repositoryFullName: 'neverworkalone/typewriter',
    token: 'test-token',
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      calls.push({ path: parsed.pathname, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (parsed.pathname.endsWith('/git/commits/' + SHA)) {
        return new Response(JSON.stringify({ sha: SHA, tree: { sha: 'c'.repeat(40) } }), { status: 200 });
      }
      if (parsed.pathname.endsWith('/git/commits') && init.method === 'POST') {
        return new Response(JSON.stringify({ sha: lockSha }), { status: 201 });
      }
      if (parsed.pathname.endsWith('/git/refs') && init.method === 'POST') {
        existing = true;
        return new Response(JSON.stringify({ message: 'Reference already exists' }), { status: 422 });
      }
      if (parsed.pathname.endsWith('/git/ref/heads/stage3-active')) {
        return new Response(JSON.stringify({ object: { sha: lockSha } }), { status: 200 });
      }
      if (parsed.pathname.endsWith('/git/commits/' + lockSha)) {
        return new Response(JSON.stringify({ message: [
          'Typewriter Stage 3 active lock', '', 'batch_id=C000001', 'attempt=2',
          'base_sha=' + SHA, 'owner=' + ownerToken,
        ].join('\n') }), { status: 200 });
      }
      if (parsed.pathname.endsWith('/git/refs/heads/stage3-active') && init.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ message: 'unexpected route' }), { status: 500 });
    },
  });
  const claim = { batchId: 'C000001', attempt: 2, baseSha: SHA, ownerToken };
  assert.equal(await github.createStage3ActiveLock(claim), false);
  assert.equal(existing, true);
  assert.equal(calls[1].body.message.includes('owner=' + ownerToken), true);
  assert.deepEqual(calls[2].body, { ref: 'refs/heads/stage3-active', sha: lockSha });
  const activeLock = await github.getStage3ActiveLock();
  assert.deepEqual(activeLock, {
    ref: 'refs/heads/stage3-active', sha: lockSha, batchId: 'C000001', attempt: 2,
    baseSha: SHA, ownerToken,
  });
  assert.equal(await github.deleteStage3ActiveLock('wrong-sha'), false);
  assert.equal(await github.deleteStage3ActiveLock(lockSha), true);
});

test('GitHub PR snapshots include reviews, inline and conversation comments, and exact-head CI', async () => {
  const requested = [];
  const github = createGitHubClient({
    repositoryFullName: 'neverworkalone/typewriter',
    token: 'test-token',
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requested.push(parsed.pathname);
      let data = {};
      if (parsed.pathname.endsWith('/pulls/91')) data = { number: 91, state: 'open', head: { sha: SHA } };
      else if (parsed.pathname.endsWith('/reviews')) data = [{ id: 1, state: 'CHANGES_REQUESTED' }];
      else if (parsed.pathname.endsWith('/pulls/91/comments')) data = [{ id: 2, body: 'inline' }];
      else if (parsed.pathname.endsWith('/issues/91/comments')) data = [{ id: 3, body: 'conversation' }];
      else if (parsed.pathname.endsWith('/status')) data = { state: 'failure', statuses: [] };
      else if (parsed.pathname.endsWith('/check-runs')) data = { check_runs: [{ name: 'ci:normal', conclusion: 'failure' }] };
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const snapshot = await github.getPullRequestSnapshot(91);
  assert.equal(snapshot.pullRequest.number, 91);
  assert.equal(snapshot.reviews[0].state, 'CHANGES_REQUESTED');
  assert.equal(snapshot.inlineComments[0].body, 'inline');
  assert.equal(snapshot.conversationComments[0].body, 'conversation');
  assert.equal(snapshot.combinedStatus.state, 'failure');
  assert.equal(snapshot.checkRuns[0].name, 'ci:normal');
  assert.equal(requested.length, 6);
});

test('Stage 3 retry inspects status-only PR files and reopens only the named pull request', async () => {
  const calls = [];
  const github = createGitHubClient({
    repositoryFullName: 'neverworkalone/typewriter',
    token: 'test-token',
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      calls.push({ path: parsed.pathname, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      const data = parsed.pathname.endsWith('/pulls/375/files')
        ? [{ filename: 'data/reviews/C000004/manifest.json' }]
        : { number: 375, state: 'open' };
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const files = await github.getPullRequestFiles(375);
  const reopened = await github.reopenPullRequest(375);
  assert.deepEqual(files.map(({ filename }) => filename), ['data/reviews/C000004/manifest.json']);
  assert.deepEqual(reopened, { number: 375, state: 'open' });
  assert.deepEqual(calls, [
    { path: '/repos/neverworkalone/typewriter/pulls/375/files', method: 'GET', body: null },
    { path: '/repos/neverworkalone/typewriter/pulls/375', method: 'PATCH', body: { state: 'open' } },
  ]);
});

test('two concurrent workers get one C000001 winner and the loser atomically falls back to C000002', async () => {
  const gitA = snapshotGit({ C000001: candidateArtifacts('C000001'), C000002: candidateArtifacts('C000002') });
  const gitB = snapshotGit({ C000001: candidateArtifacts('C000001'), C000002: candidateArtifacts('C000002') });
  const github = new FakeGitHub({ raceInitialReads: true });
  const [first, second] = await Promise.all([runClaim(github, gitA), runClaim(github, gitB)]);

  assert.deepEqual([first.batchId, second.batchId].sort(), ['C000001', 'C000002']);
  assert.equal(github.claimAttempts.filter((entry) => entry.batchId === 'C000001' && entry.won).length, 1);
  assert.equal(github.claimAttempts.filter((entry) => entry.batchId === 'C000001' && !entry.won).length, 1);
  assert.equal(github.issues.filter((issue) => issue.body.includes('C000001')).length, 1);
  assert.equal(github.issues.filter((issue) => issue.body.includes('C000002')).length, 1);
  assert.equal(gitA.branches.length + gitB.branches.length, 2);
  assert.ok([...gitA.branches, ...gitB.branches].every((branch) => branch.baseSha === SHA));
});

test('a claim ref with no Issue remains untouched and cannot create an Issue or branch', async () => {
  const git = snapshotGit({ C000001: candidateArtifacts('C000001') });
  const github = new FakeGitHub();
  github.refs.set('refs/heads/stage2-claims/C000001', SHA);
  const result = await runClaim(github, git);
  assert.equal(result, null);
  assert.equal(github.refs.has('refs/heads/stage2-claims/C000001'), true);
  assert.equal(github.issues.length, 0);
  assert.equal(git.branches.length, 0);
});

test('invalid merged candidate manifests fail closed before any claim or Issue', async () => {
  const invalid = candidateArtifacts('C000001');
  invalid.manifest.status = 'claimed';
  const git = snapshotGit({ C000001: invalid });
  const github = new FakeGitHub();
  await assert.rejects(runClaim(github, git), Stage2WorkerError);
  assert.equal(github.claimAttempts.length, 0);
  assert.equal(github.issues.length, 0);
  assert.equal(git.branches.length, 0);
});

test('rejected reviews take priority, reuse their Issue, reopen it, and use a new rework branch', async () => {
  const created = candidateArtifacts('C000002');
  const complete = candidateArtifacts('C000001', { status: 'complete' });
  const snapshot = {
    headSha: SHA,
    validated: true,
    candidates: [
      { batchId: 'C000002', manifest: created.manifest, candidatesText: created.candidatesText, rows: [record('C000002', 'C000002')] },
      { batchId: 'C000001', manifest: complete.manifest, candidatesText: complete.candidatesText, rows: [record('C000001', 'C000001')] },
    ],
    reviews: [{ batchId: 'C000001', manifest: { status: 'rejected', attempt: 1, rejected_pr: 77 } }],
  };
  assert.deepEqual(eligibleBatches(snapshot).map((entry) => entry.batchId), ['C000001', 'C000002']);
  const git = snapshotGit({});
  const github = new FakeGitHub();
  github.issues.push({
    number: 42, state: 'closed',
    title: trackingIssueTitle('C000001'),
    body: trackingIssueBody({ batchId: 'C000001', claimRef: 'refs/heads/stage2-claims/C000001', baseSha: SHA, attempt: 1 }),
  });
  const claim = await runClaim(github, git, { loadSnapshot: async () => snapshot });
  assert.equal(claim.batchId, 'C000001');
  assert.equal(claim.attempt, 2);
  assert.equal(claim.issueNumber, 42);
  assert.equal(claim.rejectedPr, 77);
  assert.equal(claim.branchName, 'codex/stage2/42-C000001-r2');
  assert.equal(github.issues.length, 1);
  assert.equal(github.issues[0].state, 'open');
  assert.match(github.issues[0].comments[0], /attempt 2/u);
  assert.equal(git.branches[0].baseSha, SHA);
});

test('claim cleanup stays merge-gated and also requires the result state on current master', async () => {
  const github = new FakeGitHub();
  const git = snapshotGit({});
  const claim = { batchId: 'C000001', attempt: 1, branchName: 'codex/stage2/42-C000001' };
  github.pullRequests.set(91, { number: 91, state: 'open', merged: false, base: { ref: 'master' }, head: { ref: claim.branchName } });
  const loadSnapshot = async () => ({
    candidates: [{ batchId: 'C000001', manifest: { status: 'complete' } }],
    reviews: [{ batchId: 'C000001', manifest: { status: 'ready', attempt: 1 } }],
  });
  assert.equal(await releaseClaimAfterMerge({ github, git, claim, prNumber: 91, loadSnapshot }), false);
  assert.deepEqual(github.deletedClaims, []);

  github.pullRequests.set(91, { number: 91, state: 'closed', merged: true, base: { ref: 'master' }, head: { ref: claim.branchName } });
  await assert.rejects(releaseClaimAfterMerge({
    github, git, claim, prNumber: 91,
    loadSnapshot: async () => ({ candidates: [{ batchId: 'C000001', manifest: { status: 'created' } }], reviews: [] }),
  }), /does not contain this merged Stage 2 result/u);
  assert.deepEqual(github.deletedClaims, []);
  assert.equal(await releaseClaimAfterMerge({ github, git, claim, prNumber: 91, loadSnapshot }), true);
  assert.deepEqual(github.deletedClaims, ['C000001']);
});

test('one session fixes the same open PR, waits for each merge, and stops at an empty queue', async () => {
  const github = new FakeGitHub();
  const events = github.events;
  github.pullRequests.set(91, [
    { number: 91, state: 'open', merged: false, ci: 'failure', review: 'changes_requested' },
    { number: 91, state: 'open', merged: false, ci: 'success', review: 'changes_requested' },
    { number: 91, state: 'closed', merged: true },
  ]);
  github.pullRequests.set(92, { number: 92, state: 'closed', merged: true });
  const claims = [
    { batchId: 'C000001', issueNumber: 42, branchName: 'codex/stage2/42-C000001' },
    { batchId: 'C000002', issueNumber: 43, branchName: 'codex/stage2/43-C000002' },
  ];
  let claimIndex = 0;
  const complete = await runStage2Session({
    claimNext: async () => {
      events.push('claim-next');
      return claims[claimIndex++] || null;
    },
    startResultPr: async (claim) => {
      events.push('start:' + claim.batchId + ':' + claim.branchName);
      return { number: claim.batchId === 'C000001' ? 91 : 92 };
    },
    waitForMerge: async (claim, pr) => waitForPullRequestMerge({
      github, prNumber: pr.number, sleep: async (duration) => events.push('wait:' + duration),
      onPending: async (pullRequest) => {
        events.push('pending:' + claim.branchName + ':' + pullRequest.ci + ':' + pullRequest.review);
      },
    }),
    releaseClaim: async (claim, pr, outcome) => {
      assert.equal(outcome.status, 'merged');
      events.push('release:' + claim.batchId + ':' + pr.number);
      return true;
    },
    report: (message) => events.push('report:' + message),
  });
  assert.equal(complete.length, 2);
  assert.equal(events.filter((event) => event === 'claim-next').length, 3);
  const mergeFirst = events.indexOf('pr:91:closed:merged');
  const releaseFirst = events.indexOf('release:C000001:91');
  const startSecond = events.indexOf('start:C000002:codex/stage2/43-C000002');
  assert.ok(events.includes('pending:codex/stage2/42-C000001:failure:changes_requested'));
  assert.ok(events.includes('pending:codex/stage2/42-C000001:success:changes_requested'));
  assert.ok(events.includes('wait:300000'));
  assert.ok(mergeFirst < releaseFirst && releaseFirst < startSecond);
  assert.ok(events.some((event) => event.startsWith('report:No unclaimed')));
  assert.equal(events.filter((event) => event.startsWith('wait:')).length, 2);
});

test('the CLI entrypoint runs one merge-gated session across two batches and then stops', async () => {
  const github = new FakeGitHub();
  github.pullRequests.set(401, [
    {
      number: 401, state: 'open', merged: false, ci: 'failure', review: 'changes_requested',
      head: { ref: 'codex/stage2/300-C000001' },
    },
    { number: 401, state: 'closed', merged: true, base: { ref: 'master' }, head: { ref: 'codex/stage2/300-C000001' } },
  ]);
  github.pullRequests.set(402, [
    { number: 402, state: 'closed', merged: true, base: { ref: 'master' }, head: { ref: 'codex/stage2/301-C000002' } },
  ]);
  const snapshot = queueSnapshot(['C000001', 'C000002']);
  const git = snapshotGit({});
  const events = github.events;
  let nextPr = 401;
  const result = await runStage2Cli([], {
    env: { GH_TOKEN: 'fake-token' },
    makeGit: () => git,
    makeGithub: () => github,
    loadSnapshot: async () => snapshot,
    log: (line) => events.push('output:' + line),
    sessionCallbacks: {
      async startResultPr(claim) {
        events.push('author-and-open-pr:' + claim.batchId + ':' + claim.branchName);
        return { number: nextPr++ };
      },
      async waitForMerge(claim, pullRequest) {
        const outcome = await waitForPullRequestMerge({
          github, prNumber: pullRequest.number,
          sleep: async (duration) => events.push('sleep:' + duration),
          onPending: async (snapshot) => events.push(
            'same-branch-feedback:' + claim.branchName + ':' + snapshot.ci + ':' + snapshot.review,
          ),
        });
        if (outcome.status === 'merged') {
          const candidate = snapshot.candidates.find((entry) => entry.batchId === claim.batchId);
          candidate.manifest.status = 'complete';
          snapshot.reviews.push({ batchId: claim.batchId, manifest: { status: 'ready', attempt: claim.attempt } });
        }
        return outcome;
      },
    },
  });

  assert.equal(result.status, 'session-finished');
  assert.equal(result.mergedBatchCount, 2);
  assert.ok(events.includes('same-branch-feedback:codex/stage2/300-C000001:failure:changes_requested'));
  assert.ok(events.includes('sleep:300000'));
  assert.deepEqual(github.deletedClaims, ['C000001', 'C000002']);
  const firstMerge = events.indexOf('pr:401:closed:merged');
  const firstRelease = events.indexOf('claim-released:C000001');
  const secondClaim = events.indexOf('claim-won:C000002');
  const secondIssue = events.findIndex((event) => event.startsWith('issue:301:C000002'));
  const secondPr = events.indexOf('author-and-open-pr:C000002:codex/stage2/301-C000002');
  assert.ok(firstMerge >= 0 && firstMerge < firstRelease && firstRelease < secondClaim && secondClaim < secondPr);
  assert.equal(events.filter((event) => event.startsWith('author-and-open-pr:')).length, 2);
  assert.ok(events.some((event) => event.includes('No unclaimed Stage 2 batches remain.')));
  assert.ok(secondIssue >= 0 && secondPr > secondIssue);
});

test('interactive primary-context hand-offs return a result PR and same-branch feedback action', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => { written += chunk.toString(); });
  let prRead = 0;
  const callbacks = createInteractiveStage2Callbacks({
    input, output, sleep: async () => {},
    github: {
      async getPullRequestSnapshot() {
        prRead += 1;
        return prRead === 1
          ? {
            pullRequest: { number: 501, state: 'open', merged: false },
            reviews: [{ state: 'CHANGES_REQUESTED' }],
            inlineComments: [{ body: 'fix this on the same branch' }],
            conversationComments: [],
            combinedStatus: { state: 'failure' },
            checkRuns: [{ name: 'ci:normal', conclusion: 'failure' }],
          }
          : { pullRequest: { number: 501, state: 'closed', merged: true } };
      },
    },
  });
  const claim = { batchId: 'C000001', issueNumber: 71, branchName: 'codex/stage2/71-C000001' };
  const readEvent = async (lineIndex) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const lines = written.trimEnd().split('\n');
      if (lines.length > lineIndex) return JSON.parse(lines[lineIndex]);
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('interactive hand-off was not written');
  };

  try {
    const createdPromise = callbacks.startResultPr(claim);
    const authorEvent = await readEvent(0);
    assert.equal(authorEvent.event, 'AUTHOR_STAGE2_RESULT');
    assert.ok(authorEvent.instructions.some((line) => line.includes('relation:candidates') && line.includes('no-relations')));
    assert.ok(authorEvent.instructions.some((line) => line.includes('hypernym/hyponym') && line.includes('never near')), 'near is reserved for close meanings, not is-a links');
    assert.ok(authorEvent.instructions.some((line) => line.includes('actual bound target sense gloss') && line.includes('reverse link')), 'near is judged on the actual target sense and already-authored reverse links are checked');
    assert.ok(authorEvent.instructions.some((line) => line.includes('same-root or same-event rationale alone does not make near') && line.includes('a noun names an event, state or quality') && line.includes('derivational relationship')), 'shared roots and named events alone do not make nominalized or derived forms near substitutes');
    assert.ok(authorEvent.instructions.some((line) => line.includes('different root does not rescue') && line.includes('attempt versus an achieved result') && line.includes('미온 to 미지근함') && line.includes('향내 to 향기')), 'predicate, result and scope shifts are association even with different roots, with source-bound negative and positive examples');
    assert.ok(authorEvent.instructions.some((line) => line.includes('reverse link is an authored direct') && line.includes('감촉 to 촉감') && line.includes('달콤함 to 단맛') && line.includes('without relevance')), 'a new non-direct link against an authored reverse direct needs a stated sense-bound difference, and an equal-extent pair is direct');
    assert.ok(authorEvent.instructions.some((line) => line.includes('when no reverse link exists at all') && line.includes('write the substitution sentence once for every near') && line.includes('멈추다 to 그치다') && line.includes('플랫폼 to 승강장') && line.includes('공책 to 노트') && line.includes('다락방 to 다락') && line.includes('another sense of the lemma, whole-lemma usage') && line.includes('omitted when its reverse is an authored near') && line.includes('쓸어내리다 needs 가슴을') && line.includes('a noun pair is shown with the two nouns themselves') && line.includes('or the reverse, is association') && line.includes('near is only for glosses that overlap while each carries a qualifier the other lacks') && line.includes('a near must carry both a sentence that works and a contrast sentence') && line.includes('바라다보다 to 바라보다') && line.includes('is not direct (기차역 to 정거장 is left out') && line.includes('one sentence that works is not proof of the same extent') && line.includes('처소 to 거주지')), 'a near is kept only when a named difference inside the two bound glosses breaks the substitution, with direct and near controls');
    assert.ok(authorEvent.instructions.every((line) => !/(broader|wider)[^;]{0,80}(narrower|narrow)[^;]{0,40}stays near/u.test(line) && !line.includes('stays near or association')), 'the instruction must not allow a broader or narrower pair to stay near');
    assert.ok(authorEvent.instructions.some((line) => line.includes('differs in vehicle, place, body part or scene') && line.includes('정거장 to 정류장') && line.includes('own gloss and part of speech of the target sense') && line.includes('pnpm run relation:near-review') && line.includes('read-only listing') && line.includes('same extent') && line.includes('다락방 to 다락') && line.includes('whether or not any reverse link exists') && line.includes('총성 to 총소리') && line.includes('훈기 to 온기') && line.includes('죄책감 to 자책') && line.includes('even when another target of the same source was already lowered') && line.includes('omit the new forward link instead of authoring a contradiction') && line.includes('separate source-preserving correction') && line.includes('미지근함 to 미온') && line.includes('do not repeat that near in the new direction') && line.includes('every new association whose opposite link is an authored near') && line.includes('자부심 to 뿌듯하다') && line.includes('기쁨 to 웃다 action') && line.includes('공책 to 노트') && line.includes('its notes as well as its types') && line.includes('only-in-source and only-in-target gloss words') && line.includes('in the words of its own gloss') && line.includes('사그라지다 to 사그라들다') && line.includes('taken from the source gloss only') && line.includes('단정하다 to 말끔하다') && line.includes('when the extent is in doubt choose association')), 'a shared domain with a different vehicle, place or kind is association, with a rail-versus-bus negative control and a same-meaning rail positive control');
    assert.ok(authorEvent.instructions.some((line) => line.includes('same-source-sense consistency pass') && line.includes('소아 to 아이') && line.includes('선서 to 서약') && line.includes('기쁨 to 웃다')), 'sibling targets of one source are compared and direction-specific types are preserved');
    input.write(JSON.stringify({ action: 'created', pr_number: 501 }) + '\n');
    const pullRequest = await createdPromise;
    assert.equal(pullRequest.number, 501);

    const mergePromise = callbacks.waitForMerge(claim, pullRequest);
    const pendingEvent = await readEvent(1);
    assert.equal(pendingEvent.event, 'STAGE2_PR_PENDING');
    assert.equal(pendingEvent.claim.branchName, claim.branchName);
    assert.equal(pendingEvent.reviews[0].state, 'CHANGES_REQUESTED');
    assert.equal(pendingEvent.inlineComments[0].body, 'fix this on the same branch');
    assert.equal(pendingEvent.combinedStatus.state, 'failure');
    assert.equal(pendingEvent.checkRuns[0].name, 'ci:normal');
    input.write(JSON.stringify({ action: 'continue' }) + '\n');
    assert.equal((await mergePromise).status, 'merged');
    assert.equal(prRead, 2);
  } finally {
    callbacks.close();
    input.destroy();
    output.destroy();
  }
});

test('closed unmerged result PR stops the session before a second claim', async () => {
  let claims = 0;
  await assert.rejects(runStage2Session({
    claimNext: async () => (claims++ === 0 ? { batchId: 'C000001', issueNumber: 42 } : null),
    startResultPr: async () => ({ number: 91 }),
    waitForMerge: async () => ({ status: 'closed-unmerged' }),
    releaseClaim: async () => true,
  }), /stopping without claiming another batch/u);
  assert.equal(claims, 1);
});

test('only a genuine Stage 2 tracking Issue is prior-issue evidence; a bare claim-ref mention is ignored', async () => {
  const claimRef = 'refs/heads/stage2-claims/C000001';
  const genuine = { title: trackingIssueTitle('C000001'), body: trackingIssueBody({ batchId: 'C000001', claimRef, baseSha: SHA, attempt: 1 }) };
  assert.equal(isStage2TrackingIssue(genuine, claimRef), true);
  assert.equal(isStage2TrackingIssue({ ...genuine, body: genuine.body.replace(/\n/gu, '\r\n') }, claimRef), true);
  const mention = { title: '[Lexical Factory] Design', body: 'Example:\n\n```text\n' + claimRef + '\n```\nClaim ref: ' + claimRef + ' is illustrative.' };
  assert.equal(isStage2TrackingIssue(mention, claimRef), false);
  assert.equal(isStage2TrackingIssue({ ...genuine, title: '[Stage 2] C000001 notes' }, claimRef), false);
  assert.equal(isStage2TrackingIssue({ ...genuine, body: 'Claim ref: ' + claimRef }, claimRef), false);
  assert.equal(isStage2TrackingIssue({ ...genuine, pull_request: {} }, claimRef), false);
  assert.equal(isStage2TrackingIssue(genuine, 'refs/heads/stage2-claims/C000002'), false);

  const git = snapshotGit({ C000001: candidateArtifacts('C000001') });
  const github = new FakeGitHub();
  github.issues.push({ number: 5, state: 'closed', ...mention });
  const claim = await runClaim(github, git);
  assert.equal(claim.batchId, 'C000001');
  assert.equal(github.issues.length, 2);
  assert.equal(github.issues[0].state, 'closed');

  const prior = new FakeGitHub();
  prior.issues.push({ number: 9, state: 'open', ...genuine });
  await assert.rejects(runClaim(prior, snapshotGit({ C000001: candidateArtifacts('C000001') })), /owner-directed recovery/u);
  assert.equal(prior.refs.has(claimRef), true);
});

test('the production Git adapter and snapshot loader accept the committed relation backfill packets and still fail closed on a missing or altered one', async () => {
  // A semantic-authority backfill event is bound to its committed packet file (#446). The real tracked data goes through the
  // real `createGitRepository` adapter, so a path the adapter does not list (or the loader does not stage) is caught here.
  const root = new URL('..', import.meta.url).pathname;
  const git = createGitRepository({ root });
  const packets = git.listFiles('HEAD').filter((file) => /^data\/relation-backfill\/R\d{6}\.json$/u.test(file));
  assert.ok(packets.length >= 1, 'the production adapter lists the committed relation backfill packets');
  const snapshot = await loadFactorySnapshot({ git, headSha: 'HEAD' });
  assert.equal(snapshot.validated, true);

  const withoutPacket = { ...git, listFiles: (ref) => git.listFiles(ref).filter((file) => file !== packets[0]) };
  await assert.rejects(loadFactorySnapshot({ git: withoutPacket, headSha: 'HEAD' }), /has no committed packet file/u);

  const alteredPacket = { ...git, show: (ref, file) => (file === packets[0] ? git.show(ref, file) + ' ' : git.show(ref, file)) };
  await assert.rejects(loadFactorySnapshot({ git: alteredPacket, headSha: 'HEAD' }), /does not match its semantic authority event digest/u);
});
