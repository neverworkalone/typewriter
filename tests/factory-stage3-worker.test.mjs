import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applySurfaceFormDispositions, planSurfaceFormDispositions } from '../scripts/factory/surface-form-dispositions.mjs';
import { finalBoundary, buildStage3SemanticAuthority } from '../scripts/factory/semantic-authority.mjs';
import { reviewedCandidateRecord } from '../scripts/factory/artifacts.mjs';
import {
  buildSemanticAuditFromDecisionSource, inspectSenseBoundaryPairs, readAuthoredBatchDecisionSources, sha256Json,
} from '../scripts/validate/semantic-audit.mjs';
import { authorSemanticReviewBinding } from '../scripts/validate/semantic-decision-row.mjs';

import { planStage3Admission, applyStage3FileChanges, Stage3AdmissionError } from '../scripts/factory/admission.mjs';
import {
  applyStage3Admission,
  claimNextStage3Batch,
  createStage3Draft,
  eligibleStage3Batches,
  processStage3Attempt,
  recoverStage3Attempt,
  releaseStage3Claim,
  runStage3PreflightCi,
  runStage3Session,
} from '../scripts/factory/stage3-worker.mjs';
import { parseArguments, runStage3Cli } from '../scripts/factory/run-stage3-worker.mjs';

const digest = 'a'.repeat(64);
const baseRecord = {
  id: 'w00001', record_type: 'entry', role: 'start', candidate_id: 'w00001', lemma: '맑다', search_forms: ['맑다'],
  senses: [{ id: 'w00001-s1', pos: 'adjective', gloss: '빛이 흐리지 않고 밝다.' }],
};
const candidate = (n, lemma = '새롭다') => ({ candidate_id: `C000001-000${n}`, input: lemma, pos: 'adjective' });
const decision = ({ n = 1, lemma = '새롭다', target = { kind: 'new_entry' }, senses = [{ pos: 'adjective', gloss: '새로운 풀이.' }], relations } = {}) => ({
  source_candidate_id: `C000001-000${n}`,
  disposition: 'included',
  target,
  reviewed_record: { lemma, senses: senses.map((sense) => ({ ...sense, ...(relations ? { relations } : {}) })) },
});
const manifests = (decisions) => ({
  candidateManifest: { batch_id: 'C000001', status: 'complete', candidates_sha256: digest },
  reviewManifest: {
    contract: 'lexical-factory-review-v1', batch_id: 'C000001', attempt: 1, status: 'ready', history: [],
    candidates_sha256: digest, canonical_snapshot_digest: digest, decisions_sha256: digest,
    semantic_decisions_sha256: digest, handoff_sha256: digest,
  },
});
function plan(decisions, canonicalRecords = [baseRecord]) {
  const ids = [...new Set(decisions.map((row) => row.source_candidate_id))];
  const { candidateManifest, reviewManifest } = manifests(decisions);
  return planStage3Admission({
    batchId: 'C000001', attempt: 1, admissionPr: 451, candidateManifest, reviewManifest,
    candidates: ids.map((id, index) => ({ candidate_id: id, input: decisions[index].reviewed_record.lemma, pos: 'adjective' })),
    decisions, canonicalRecords, recordPathById: new Map([['w00001', 'data/canonical/base.jsonl']]),
    baseCanonicalSnapshotDigest: digest,
  });
}

test('Stage 3 preflight runs one normal CI command with its nested fast checkpoint', () => {
  const commands = [];
  runStage3PreflightCi('/repo', (file, args, options) => commands.push({ file, args, options }));
  assert.deepEqual(commands, [{
    file: 'npm', args: ['run', 'ci:normal'], options: { cwd: '/repo', stdio: 'inherit' },
  }]);
});

test('Stage 3 deterministically allocates entry ids and remaps candidate and provisional references', () => {
  const first = decision({ n: 1, lemma: '새롭다', relations: [{ type: 'near', target: 'C000001-0002', target_sense: 'C000001-0002-s1' }] });
  const second = decision({ n: 2, lemma: '단단하다', target: { kind: 'new_entry' }, relations: [{ type: 'near', target: 'tmp-1', target_sense: 'tmp-1-s1' }] });
  first.provisional_ref = 'tmp-1';
  second.provisional_ref = 'tmp-2';
  const result = plan([first, second]);
  assert.deepEqual(result.entries, [
    { source_candidate_id: 'C000001-0001', record_id: 'w00002', sense_ids: ['w00002-s1'] },
    { source_candidate_id: 'C000001-0002', record_id: 'w00003', sense_ids: ['w00003-s1'] },
  ]);
  assert.deepEqual(result.records.get('w00002').record.senses[0].relations, [{ type: 'near', target: 'w00003', target_sense: 'w00003-s1' }]);
  assert.deepEqual(result.records.get('w00003').record.senses[0].relations, [{ type: 'near', target: 'w00002', target_sense: 'w00002-s1' }]);
});

test('Stage 3 appends new POS and new sense without replacing canonical identity', () => {
  const addedPos = decision({
    n: 1, lemma: '맑다', target: { kind: 'new_pos_on_existing_lemma', entry_id: 'w00001' },
    senses: [{ pos: 'verb', gloss: '흐린 물질을 걷어 내다.' }],
  });
  const posPlan = plan([addedPos]);
  const posUpdate = posPlan.records.get('w00001');
  assert.equal(posUpdate.record.id, 'w00001');
  assert.equal(posUpdate.record.candidate_id, 'w00001');
  assert.deepEqual(posUpdate.record.senses.map(({ id, pos }) => [id, pos]), [
    ['w00001-s1', 'adjective'], ['w00001-s2', 'verb'],
  ]);

  const addedSense = decision({
    n: 1, lemma: '맑다', target: { kind: 'new_sense_on_existing_entry', entry_id: 'w00001', context_sense_id: 'w00001-s1' },
    senses: [{ pos: 'adjective', gloss: '마음이나 태도가 맑고 깨끗하다.' }],
  });
  assert.equal(plan([addedSense]).records.get('w00001').record.senses.at(-1).id, 'w00001-s2');
});

test('latest canonical lexical conflicts are typed as lexical, not systemic', () => {
  const conflict = decision({ n: 1, lemma: '맑다' });
  assert.throws(() => plan([conflict]), (error) => error instanceof Stage3AdmissionError && error.category === 'lexical' && error.code === 'STAGE3_CANONICAL_CONFLICT');
});

test('eligibility excludes claimed batches and open admission or rejection status PRs', () => {
  const snapshot = { validated: true, candidates: [{ batchId: 'C000001', manifest: { status: 'complete' } }], reviews: [{ batchId: 'C000001', manifest: { status: 'ready', attempt: 2 } }] };
  assert.equal(eligibleStage3Batches(snapshot).length, 1);
  assert.equal(eligibleStage3Batches(snapshot, ['refs/heads/stage3-claims/C000001-a2']).length, 0);
  assert.equal(eligibleStage3Batches(snapshot, [], [{ head: { ref: 'codex/stage3/C000001-a2' } }]).length, 0);
  assert.equal(eligibleStage3Batches(snapshot, [], [{ head: { ref: 'claude/stage3-status/C000001-a2' } }]).length, 0);
});

test('a batch claim conflict does not fall through to a different ready review', async () => {
  const events = [];
  const snapshot = {
    validated: true,
    candidates: ['C000001', 'C000002'].map((batchId) => ({ batchId, manifest: { status: 'complete' }, rows: [], files: [] })),
    reviews: ['C000001', 'C000002'].map((batchId) => ({ batchId, manifest: { status: 'ready', attempt: 1 }, decisions: [], files: [] })),
  };
  const github = {
    async getBranchHead() { return 'head'; },
    async listStage3ClaimRefs() { return []; },
    async listPullRequests() { return []; },
    async getStage3ActiveLock() { return null; },
    async createStage3ActiveLock({ batchId, attempt, baseSha, ownerToken }) {
      events.push(`lock:${batchId}`);
      return { ref: 'refs/heads/stage3-active', sha: 'lock-sha', batchId, attempt, baseSha, ownerToken };
    },
    async createStage3ClaimRef(batchId) { events.push(`claim:${batchId}`); return batchId !== 'C000001'; },
    async createPullRequest(payload) { events.push(`draft:${payload.draft}`); assert.match(payload.body, /Stage 3 attempt: C000002-a1/u); return { number: 52, html_url: 'https://example.test/52' }; },
  };
  const git = {
    async fetchMaster() {}, resolveRef() { return 'head'; }, originRemote() { return 'https://github.com/o/r.git'; },
    createBranch(name) { events.push(`branch:${name}`); },
    async writeStarterAndPush({ batchId }) { events.push(`starter:${batchId}`); },
  };
  await assert.rejects(() => claimNextStage3Batch({ github, git, loadSnapshot: async () => snapshot, log: () => {}, ownerToken: () => 'owner-token-0001' }), /claim already exists/u);
  assert.deepEqual(events, ['lock:C000001', 'claim:C000001']);
});

test('a claim or open Stage 3 PR blocks every other ready batch', async () => {
  const snapshot = {
    validated: true,
    candidates: ['C000001', 'C000002'].map((batchId) => ({ batchId, manifest: { status: 'complete' } })),
    reviews: ['C000001', 'C000002'].map((batchId) => ({ batchId, manifest: { status: 'ready', attempt: 1 } })),
  };
  const makeGit = () => ({ async fetchMaster() {}, resolveRef() { return 'head'; } });
  const cases = [
    { claimRefs: ['refs/heads/stage3-claims/C000001-a1'], pulls: [] },
    { claimRefs: [], pulls: [{ state: 'open', body: 'Stage 3 attempt: C000001-a1', head: { ref: 'codex/stage3/C000001-a1' } }] },
    { claimRefs: [], pulls: [{ state: 'open', body: 'Stage 3 attempt: C000001-a1', head: { ref: 'claude/stage3-status/C000001-a1' } }] },
    { claimRefs: [], pulls: [], activeLock: { batchId: 'C000001', attempt: 1, sha: 'lock-sha' } },
  ];
  for (const scenario of cases) {
    let lockCreates = 0;
    const github = {
      async getBranchHead() { return 'head'; },
      async listStage3ClaimRefs() { return scenario.claimRefs; },
      async listPullRequests() { return scenario.pulls; },
      async getStage3ActiveLock() { return scenario.activeLock || null; },
      async createStage3ActiveLock() { lockCreates += 1; return { sha: 'unexpected' }; },
    };
    const result = await claimNextStage3Batch({ github, git: makeGit(), loadSnapshot: async () => snapshot, log: () => {} });
    assert.equal(result, null);
    assert.equal(lockCreates, 0);
  }
});

test('concurrent sessions selecting different ready batches produce exactly one global active attempt', async () => {
  const events = [];
  const snapshotFor = (batchId) => ({
    validated: true,
    candidates: [{ batchId, manifest: { status: 'complete' }, rows: [], files: [] }],
    reviews: [{ batchId, manifest: { status: 'ready', attempt: 1 }, decisions: [], files: [] }],
    canonicalEntries: [],
  });
  let listings = 0;
  let openListingBarrier;
  const bothListed = new Promise((resolve) => { openListingBarrier = resolve; });
  let activeLock = null;
  const github = {
    async getBranchHead() { return 'head'; },
    async listStage3ClaimRefs() { listings += 1; if (listings === 2) openListingBarrier(); await bothListed; return []; },
    async listPullRequests() { return []; },
    async getStage3ActiveLock() { return null; },
    async createStage3ActiveLock(value) {
      if (activeLock) return false;
      activeLock = { ref: 'refs/heads/stage3-active', sha: `lock-${value.batchId}`, ...value };
      events.push(`lock:${value.batchId}`);
      return activeLock;
    },
    async createStage3ClaimRef(batchId) { events.push(`claim:${batchId}`); return true; },
    async createPullRequest(payload) { events.push(`draft:${payload.body.match(/C\d{6}-a1/u)?.[0]}`); return { number: 53, html_url: 'https://example.test/53' }; },
  };
  const makeGit = () => ({
    async fetchMaster() {}, resolveRef() { return 'head'; }, originRemote() { return 'https://github.com/o/r.git'; },
    createBranch(name) { events.push(`branch:${name}`); },
    async writeStarterAndPush({ batchId }) { events.push(`starter:${batchId}`); },
  });
  const results = await Promise.all([
    claimNextStage3Batch({ github, git: makeGit(), loadSnapshot: async () => snapshotFor('C000001'), log: () => {}, ownerToken: () => 'owner-token-0001' }),
    claimNextStage3Batch({ github, git: makeGit(), loadSnapshot: async () => snapshotFor('C000002'), log: () => {}, ownerToken: () => 'owner-token-0002' }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(events.filter((event) => event.startsWith('lock:')).length, 1);
  assert.equal(events.filter((event) => event.startsWith('claim:')).length, 1);
  assert.equal(events.filter((event) => event.startsWith('draft:')).length, 1);
  assert.equal(new Set(events.filter((event) => event.startsWith('lock:') || event.startsWith('claim:')).map((event) => event.split(':')[1])).size, 1);
});

test('Draft PR exists before lexical preflight failure, then creates a separate rejection PR with actual number', async () => {
  const events = [];
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage3-rejection-'));
  try {
    const reviewPath = path.join(root, 'data/reviews/C000001/manifest.json');
    await mkdir(path.dirname(reviewPath), { recursive: true });
    const { reviewManifest } = manifests([]);
    await writeFile(reviewPath, JSON.stringify(reviewManifest));
    const claim = { batchId: 'C000001', attempt: 1, claimRef: 'refs/heads/stage3-claims/C000001-a1', branchName: 'codex/stage3/C000001-a1', rejectionBranchName: 'codex/stage3-status/C000001-a1', baseSha: 'head', prNumber: 75 };
    const github = {
      async getPullRequest() { return { number: 75, state: 'open', draft: true, base: { ref: 'master' }, head: { ref: claim.branchName } }; },
      async getBranchHead() { return 'head'; },
      async updatePullRequestBody(number, body) { events.push(`disposition:${number}`); assert.match(body, /Stage 3 disposition: lexical-rejection/u); },
      async closePullRequest(number) { events.push(`close:${number}`); },
      async createPullRequest(payload) { events.push(`status-pr:${payload.body}`); return { number: 76, html_url: 'https://example.test/76' }; },
    };
    const git = {
      async fetchMaster() {}, resolveRef() { return 'head'; }, createBranch() { events.push('status-branch'); },
      async commitAndPush({ files }) { assert.deepEqual(files, ['data/reviews/C000001/manifest.json']); },
      async deleteBranch(branch) { events.push(`delete:${branch}`); },
    };
    const result = await processStage3Attempt({
      github, git, root, claim, runGates: false,
      prepare: async () => { events.push('preflight'); throw new Stage3AdmissionError('new lemma now exists on master', { category: 'lexical' }); },
    });
    assert.equal(result.prState, 'rejection-status');
    assert.equal(result.admissionPr, 75);
    assert.equal(result.prNumber, 76);
    assert.deepEqual(events.slice(0, 5), ['preflight', 'disposition:75', 'close:75', `delete:${claim.branchName}`, 'status-branch']);
    const manifest = JSON.parse(await readFile(reviewPath, 'utf8'));
    assert.equal(manifest.status, 'rejected');
    assert.equal(manifest.rejected_pr, 75);
    assert.deepEqual(manifest.history, [{ attempt: 1, rejected_pr: 75 }]);
    assert.match(events[5], /Closed admission draft: #75/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery reuses an open admission PR and creates status only when it is missing', async () => {
  const claimRef = 'refs/heads/stage3-claims/C000001-a1';
  const activeLock = { ref: 'refs/heads/stage3-active', sha: 'lock-sha', batchId: 'C000001', attempt: 1, baseSha: 'head', ownerToken: 'owner-token-0001' };
  const github = {
    async listStage3ClaimRefs() { return [{ ref: claimRef }]; },
    async getStage3ActiveLock() { return activeLock; },
    async listPullRequests() { return [
    { number: 91, state: 'open', merged: false, body: `Claim ref: ${claimRef}`, head: { ref: 'codex/stage3/C000001-a1' } },
    ]; },
  };
  assert.equal((await recoverStage3Attempt({ github, git: {}, batchId: 'C000001', attempt: 1 })).prNumber, 91);

  const pendingStatus = await recoverStage3Attempt({
    github: { ...github, async listPullRequests() { return [
      { number: 91, state: 'closed', merged: false, body: `Claim ref: ${claimRef}`, head: { ref: 'codex/stage3/C000001-a1' } },
      { number: 94, state: 'open', merged: false, body: `Claim ref: ${claimRef}`, head: { ref: 'codex/stage3-status/C000001-a1' } },
    ]; } },
    git: {}, batchId: 'C000001', attempt: 1,
  });
  assert.equal(pendingStatus.status, 'await-rejection');
  assert.equal(pendingStatus.prNumber, 94);
  await assert.rejects(() => recoverStage3Attempt({
    github: { ...github, async listPullRequests() { return [
      { number: 91, state: 'closed', merged: false, body: `Claim ref: ${claimRef}`, head: { ref: 'codex/stage3/C000001-a1' } },
      { number: 94, state: 'closed', merged: false, body: `Claim ref: ${claimRef}`, head: { ref: 'codex/stage3-status/C000001-a1' } },
    ]; } },
    git: {}, batchId: 'C000001', attempt: 1,
  }), /closed without merging/u);

  const createCalls = [];
  const result = await recoverStage3Attempt({
    github: { ...github, async listPullRequests() { return [{ number: 92, state: 'closed', merged: false, body: `Claim ref: ${claimRef}\n\nStage 3 disposition: lexical-rejection (STAGE3_CANONICAL_CONFLICT).`, head: { ref: 'codex/stage3/C000001-a1' } }]; } },
    git: {}, root: '/tmp', batchId: 'C000001', attempt: 1,
    createRejection: async ({ admissionPr }) => { createCalls.push(admissionPr); return { prNumber: 93 }; },
  });
  assert.equal(result.status, 'create-rejection');
  assert.equal(result.admissionPr, 92);
  assert.deepEqual(createCalls, []);
  await assert.rejects(() => recoverStage3Attempt({
    github: { ...github, async listPullRequests() { return [
      { number: 95, state: 'closed', merged: false, body: `Claim ref: ${claimRef}`, head: { ref: 'codex/stage3/C000001-a1' } },
    ]; } },
    git: {}, batchId: 'C000001', attempt: 1,
  }), /without a recorded lexical-rejection disposition/u);
});

test('an owned global lock recovers a crash before the per-batch claim was written', async () => {
  const activeLock = { ref: 'refs/heads/stage3-active', sha: 'lock-sha', batchId: 'C000001', attempt: 1, baseSha: 'base-sha', ownerToken: 'owner-token-0001' };
  const recovered = await recoverStage3Attempt({
    github: {
      async listStage3ClaimRefs() { return []; },
      async getStage3ActiveLock() { return activeLock; },
      async listPullRequests() { return []; },
    },
    git: { async remoteBranchExists() { return false; } },
    batchId: 'C000001', attempt: 1,
    log: () => {},
  });
  assert.equal(recovered.status, 'restore-starter');
  assert.equal(recovered.claimMissing, true);
  assert.equal(recovered.baseSha, 'base-sha');
  assert.equal(recovered.activeLock.sha, 'lock-sha');
});

test('resume restores a missing per-batch ref under the existing global lock before opening a Draft', async () => {
  const events = [];
  const batchId = 'C000001';
  const attempt = 1;
  const claimRef = `refs/heads/stage3-claims/${batchId}-a${attempt}`;
  const activeLock = { ref: 'refs/heads/stage3-active', sha: 'lock-sha', batchId, attempt, baseSha: 'master-sha', ownerToken: 'owner-token-0001' };
  const snapshot = {
    headSha: 'master-sha', validated: true,
    candidates: [{ batchId, manifest: { status: 'complete' }, rows: [], files: [] }],
    reviews: [{ batchId, manifest: { status: 'ready', attempt }, decisions: [], files: [] }],
    canonicalEntries: [],
  };
  const github = {
    async getBranchHead() { return 'master-sha'; },
    async listStage3ClaimRefs() { events.push('list-claims'); return []; },
    async getStage3ActiveLock() { return activeLock; },
    async listPullRequests() { return []; },
    async createStage3ClaimRef(batch, n, sha) { events.push(`restore-claim:${batch}-a${n}:${sha}`); return true; },
  };
  const git = {
    async fetchMaster() {}, resolveRef() { return 'master-sha'; }, originRemote() { return 'https://github.com/o/r.git'; },
    async remoteBranchExists() { return false; },
  };
  const result = await runStage3Cli(['--resume-batch', batchId, '--attempt', String(attempt)], {
    env: { GH_TOKEN: 'fixture-token' }, makeGit: () => git, makeGithub: () => github,
    loadSnapshot: async () => snapshot,
    createDraft: async ({ claim }) => { events.push('draft'); return { ...claim, prNumber: 102, prState: 'draft' }; },
    processAttempt: async ({ claim }) => { events.push('preflight'); return { ...claim, prState: 'admission' }; },
    callbacks: { async waitForMerge() { return { status: 'stopped-by-primary' }; }, close() {} },
    log: () => {},
  });
  assert.equal(result.status, 'stopped-by-primary');
  assert.ok(events.indexOf(`restore-claim:${batchId}-a${attempt}:master-sha`) < events.indexOf('draft'));
  assert.ok(events.indexOf('draft') < events.indexOf('preflight'));
  assert.equal(events.includes('delete-active-lock'), false);
});

test('successful admission removes the starter before commit and ready transition', async () => {
  const events = [];
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage3-ready-'));
  try {
    const marker = path.join(root, 'data/reviews/C000001/attempt-a1.json');
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, '{}');
    await writeFile(path.join(root, 'data/reviews/C000001/manifest.json'), JSON.stringify(manifests([]).reviewManifest));
    const claim = { batchId: 'C000001', attempt: 1, claimRef: 'refs/heads/stage3-claims/C000001-a1', branchName: 'codex/stage3/C000001-a1', baseSha: 'head', prNumber: 81 };
    const github = {
      async getPullRequest() { return { number: 81, state: 'open', draft: true, base: { ref: 'master' }, head: { ref: claim.branchName } }; },
      async getBranchHead() { return 'head'; },
      async markPullRequestReady() { events.push('ready'); return { number: 81, isDraft: false }; },
    };
    const git = {
      async fetchMaster() {}, resolveRef() { return 'head'; },
      async commitAndPush({ files }) { assert.equal(files.includes('data/reviews/C000001/attempt-a1.json'), false); events.push('commit-push'); },
    };
    await processStage3Attempt({
      github, git, root, claim, runGates: false,
      prepare: async () => ({ plan: {}, files: [] }),
      apply: async () => { await rm(marker, { force: true }); return { files: ['data/canonical/factory-C000001-a1.jsonl'] }; },
      validate: async () => { assert.equal(await readFile(marker, 'utf8').then(() => true, () => false), false); events.push('validate'); },
      log: () => {},
    });
    assert.deepEqual(events, ['validate', 'commit-push', 'ready']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('restart after admission commit validates the exact pushed tree and marks the Draft ready without reapplying', async () => {
  const events = [];
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage3-restart-complete-'));
  try {
    const reviewPath = path.join(root, 'data/reviews/C000001/manifest.json');
    await mkdir(path.dirname(reviewPath), { recursive: true });
    await writeFile(reviewPath, JSON.stringify({
      ...manifests([]).reviewManifest, status: 'complete',
      admission: { admission_pr: 82 },
    }));
    const claim = { batchId: 'C000001', attempt: 1, branchName: 'codex/stage3/C000001-a1', baseSha: 'head', prNumber: 82 };
    const github = {
      async getPullRequest() { return { number: 82, state: 'open', draft: true, base: { ref: 'master' }, head: { ref: claim.branchName, sha: 'pr-head' } }; },
      async getBranchHead() { return 'head'; },
      async markPullRequestReady() { events.push('ready'); return { number: 82, isDraft: false }; },
    };
    const git = {
      async fetchMaster() {}, resolveRef(ref) { return ref === 'HEAD' ? 'pr-head' : 'head'; }, branchBaseSha() { return 'head'; },
    };
    const result = await processStage3Attempt({
      github, git, root, claim, runGates: false,
      prepare: async () => { throw new Error('a committed admission must not be reapplied'); },
      apply: async () => { throw new Error('a committed admission must not be reapplied'); },
      validate: async ({ prepared }) => { assert.equal(prepared.recoveredCompleteAdmission, true); events.push('validate'); },
      log: () => {},
    });
    assert.equal(result.prState, 'admission');
    assert.deepEqual(events, ['validate', 'ready']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resume command requires one explicit batch and attempt', () => {
  assert.deepEqual(parseArguments(['--resume-batch', 'C000019', '--attempt', '2']), {
    agent: 'codex', dryRun: false, resumeBatch: 'C000019', resumeAttempt: 2,
  });
  assert.throws(() => parseArguments(['--resume-batch', 'C000019']), /supplied together/u);
  assert.throws(() => parseArguments(['--resume-batch', 'C000019', '--attempt', '0']), /positive integer/u);
});

for (const { label, remoteBranchExists } of [
  { label: 'missing starter branch', remoteBranchExists: false },
  { label: 'pushed starter branch without a PR', remoteBranchExists: true },
]) {
  test(`resume recovery preflights a newly opened Draft when the ${label}`, async () => {
    const events = [];
    const batchId = 'C000001';
    const attempt = 1;
    const claimRef = `refs/heads/stage3-claims/${batchId}-a${attempt}`;
    const snapshot = {
      headSha: 'master-sha', validated: true,
      candidates: [{ batchId, manifest: { status: 'complete' }, rows: [{ candidate_id: 'C000001-0001' }], files: ['candidate.json'] }],
      reviews: [{ batchId, manifest: { status: 'ready', attempt }, decisions: [{ source_candidate_id: 'C000001-0001' }], files: ['review.json'] }],
      canonicalEntries: [],
    };
    const git = {
      async fetchMaster() { events.push('fetch-master'); },
      resolveRef() { return 'master-sha'; },
      originRemote() { return 'https://github.com/o/r.git'; },
      async remoteBranchExists(branch) { events.push(`remote-branch:${branch}`); return remoteBranchExists; },
      async refreshBranch(branch) { events.push(`refresh:${branch}`); },
      rebaseOnMaster() { events.push('rebase'); },
      async pushRebasedBranch(branch) { events.push(`push-rebased:${branch}`); },
    };
    const github = {
      async getBranchHead(branch) { assert.equal(branch, 'master'); return 'master-sha'; },
      async listStage3ClaimRefs() { return [claimRef]; },
      async getStage3ActiveLock() { return { ref: 'refs/heads/stage3-active', sha: 'lock-sha', batchId, attempt, baseSha: 'master-sha', ownerToken: 'owner-token-0001' }; },
      async listPullRequests(state) { assert.equal(state, 'all'); return []; },
    };
    const callbacks = {
      async waitForMerge(claim) { events.push(`wait:${claim.prNumber}`); return { status: 'stopped-by-primary' }; },
      close() { events.push('close-callbacks'); },
    };
    const result = await runStage3Cli(['--resume-batch', batchId, '--attempt', String(attempt)], {
      env: { GH_TOKEN: 'fixture-token' },
      makeGit: () => git,
      makeGithub: () => github,
      loadSnapshot: async () => snapshot,
      createDraft: async ({ claim, existingStarter }) => {
        events.push(`draft:${existingStarter}`);
        return { ...claim, prNumber: 101, prUrl: 'https://example.test/101', prState: 'draft' };
      },
      processAttempt: async ({ claim }) => { events.push(`preflight:${claim.prNumber}`); return { ...claim, prState: 'admission' }; },
      callbacks,
      log: () => {},
    });
    assert.equal(result.status, 'stopped-by-primary');
    assert.ok(events.includes(`remote-branch:codex/stage3/${batchId}-a${attempt}`));
    assert.ok(events.includes(`draft:${remoteBranchExists}`));
    assert.ok(events.indexOf(`preflight:101`) > events.findIndex((event) => event.startsWith('draft:')));
    assert.ok(events.includes('wait:101'));
    if (remoteBranchExists) {
      assert.ok(events.indexOf(`refresh:codex/stage3/${batchId}-a${attempt}`) < events.indexOf('rebase'));
      assert.ok(events.indexOf('rebase') < events.indexOf(`push-rebased:codex/stage3/${batchId}-a${attempt}`));
      assert.ok(events.indexOf(`push-rebased:codex/stage3/${batchId}-a${attempt}`) < events.indexOf('draft:true'));
    } else {
      assert.equal(events.includes('rebase'), false);
    }
  });
}

test('serial session waits for the current PR merge before claiming the next batch', async () => {
  const events = [];
  let next = 0;
  const result = await runStage3Session({
    async claimNext() { next += 1; events.push(`claim:${next}`); return next <= 2 ? { batchId: `C00000${next}`, attempt: 1, prState: 'draft', prNumber: next } : null; },
    async processClaim(claim) { events.push(`process:${claim.batchId}`); return { ...claim, prState: 'admission' }; },
    async waitForMerge(claim) { events.push(`wait:${claim.batchId}`); return { status: 'merged' }; },
    async releaseClaim(claim) { events.push(`release:${claim.batchId}`); return true; },
  });
  assert.equal(result.length, 2);
  assert.deepEqual(events, [
    'claim:1', 'process:C000001', 'wait:C000001', 'release:C000001',
    'claim:2', 'process:C000002', 'wait:C000002', 'release:C000002', 'claim:3',
  ]);
});

test('release requires the claimed admission PR to be merged and its state on master', async () => {
  const deleted = [];
  let merged = false;
  const activeLock = { ref: 'refs/heads/stage3-active', sha: 'lock-sha', batchId: 'C000001', attempt: 1, baseSha: 'head', ownerToken: 'owner-token-0001' };
  const claim = { batchId: 'C000001', attempt: 1, claimRef: 'refs/heads/stage3-claims/C000001-a1', branchName: 'codex/stage3/C000001-a1', prState: 'admission', activeLock };
  const github = {
    async getPullRequest() { return { number: 100, merged, base: { ref: 'master' }, head: { ref: claim.branchName } }; },
    async getBranchHead() { return 'master-sha'; },
    async getStage3ActiveLock() { return activeLock; },
    async listStage3ClaimRefs() { return [{ ref: claim.claimRef }]; },
    async deleteStage3ClaimRef() { deleted.push('claim'); },
    async deleteStage3ActiveLock(sha) { assert.equal(sha, activeLock.sha); deleted.push('global'); return true; },
  };
  const git = { async fetchMaster() {}, resolveRef() { return 'master-sha'; } };
  assert.equal(await releaseStage3Claim({ github, git, claim, pullRequest: { number: 100 } }), false);
  assert.deepEqual(deleted, []);
  merged = true;
  const released = await releaseStage3Claim({ github, git, claim, pullRequest: { number: 100 }, loadSnapshot: async () => ({ reviews: [{ batchId: 'C000001', manifest: { status: 'complete', attempt: 1, admission: { admission_pr: 100 } } }] }) });
  assert.equal(released, true);
  assert.deepEqual(deleted, ['claim', 'global']);
});

test('recovery after a merged PR tolerates a deleted attempt ref and releases only its matching lock', async () => {
  const claimRef = 'refs/heads/stage3-claims/C000001-a1';
  const activeLock = { ref: 'refs/heads/stage3-active', sha: 'lock-sha', batchId: 'C000001', attempt: 1, baseSha: 'head', ownerToken: 'owner-token-0001' };
  const pull = { number: 101, state: 'closed', merged: true, body: `Claim ref: ${claimRef}`, base: { ref: 'master' }, head: { ref: 'codex/stage3/C000001-a1' } };
  let deletedLock = false;
  const github = {
    async listStage3ClaimRefs() { return []; },
    async getStage3ActiveLock() { return activeLock; },
    async listPullRequests() { return [pull]; },
    async getPullRequest() { return pull; },
    async getBranchHead() { return 'master-sha'; },
    async deleteStage3ActiveLock(sha) { assert.equal(sha, activeLock.sha); deletedLock = true; return true; },
  };
  const git = { async fetchMaster() {}, resolveRef() { return 'master-sha'; } };
  const recovered = await recoverStage3Attempt({ github, git, batchId: 'C000001', attempt: 1 });
  assert.equal(recovered.status, 'admission-merged');
  assert.equal(recovered.claimMissing, true);
  assert.equal(await releaseStage3Claim({
    github, git, claim: recovered, pullRequest: { number: 101 },
    loadSnapshot: async () => ({ reviews: [{ batchId: 'C000001', manifest: { status: 'complete', attempt: 1, admission: { admission_pr: 101 } } }] }),
  }), true);
  assert.equal(deletedLock, true);
});

test('rejection status keeps the global lock until its real status PR is merged', async () => {
  const activeLock = { ref: 'refs/heads/stage3-active', sha: 'lock-sha', batchId: 'C000001', attempt: 1, baseSha: 'head', ownerToken: 'owner-token-0001' };
  const claim = {
    batchId: 'C000001', attempt: 1, claimRef: 'refs/heads/stage3-claims/C000001-a1',
    branchName: 'codex/stage3-status/C000001-a1', prState: 'rejection-status', admissionPr: 75, activeLock,
  };
  let merged = false;
  const released = [];
  const github = {
    async getPullRequest() { return { number: 102, merged, base: { ref: 'master' }, head: { ref: claim.branchName } }; },
    async getBranchHead() { return 'master-sha'; },
    async getStage3ActiveLock() { return activeLock; },
    async listStage3ClaimRefs() { return [{ ref: claim.claimRef }]; },
    async deleteStage3ClaimRef() { released.push('claim'); },
    async deleteStage3ActiveLock() { released.push('global'); return true; },
  };
  const git = { async fetchMaster() {}, resolveRef() { return 'master-sha'; } };
  assert.equal(await releaseStage3Claim({ github, git, claim, pullRequest: { number: 102 } }), false);
  assert.deepEqual(released, []);
  merged = true;
  assert.equal(await releaseStage3Claim({
    github, git, claim, pullRequest: { number: 102 }, outcome: { status: 'rejected' },
    loadSnapshot: async () => ({ reviews: [{ batchId: 'C000001', manifest: { status: 'rejected', attempt: 1, rejected_pr: 75 } }] }),
  }), true);
  assert.deepEqual(released, ['claim', 'global']);
});

test('a multi-sense canonical record is a split, separated boundary whether its senses are new or amended', () => {
  const retained = { boundaryAction: 'retain', candidateClassification: 'atomic' };
  assert.deepEqual(finalBoundary({ senseCount: 1, ...retained }), { finalDecision: 'retain', finalClassification: 'atomic' });
  assert.deepEqual(finalBoundary({ senseCount: 2, ...retained }), { finalDecision: 'split', finalClassification: 'separated' });
  assert.deepEqual(finalBoundary({ senseCount: 3, ...retained, priorClassification: 'coordinated' }), { finalDecision: 'split', finalClassification: 'coordinated' });
  assert.deepEqual(finalBoundary({ senseCount: 2, boundaryAction: 'retain', candidateClassification: 'coordinated' }), { finalDecision: 'split', finalClassification: 'coordinated' });
});

// Production path for a new multi-sense entry: plan -> buildStage3SemanticAuthority -> the same complete
// source-bound semantic audit that ci:normal applies. Synthetic lemma; reads (never writes) the real canonical revision.
test('a new two-sense entry is admitted by the semantic authority and passes the complete semantic audit', async () => {
  const canonicalRecords = [];
  const recordPathById = new Map();
  for (const name of (await readdir('data/canonical')).filter((file) => file.endsWith('.jsonl'))) {
    for (const line of (await readFile(path.join('data/canonical', name), 'utf8')).split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      canonicalRecords.push(record);
      recordPathById.set(record.id, 'data/canonical/' + name);
    }
  }
  const id = 'C900001-0001';
  const decision = {
    source_candidate_id: id, disposition: 'included', target: { kind: 'new_entry' },
    reviewed_record: { lemma: '합성시험낱말', senses: [{ pos: 'noun', gloss: '합성 시험에서 쓰는 첫째 뜻풀이.' }, { pos: 'noun', gloss: '합성 시험에서 쓰는 전혀 다른 둘째 뜻풀이.' }] },
  };
  const record = reviewedCandidateRecord(decision);
  const row = {
    source_candidate_id: id, candidate_record_id: id, candidate_record_sha256: sha256Json(record), decision: 'included',
    decision_rationale: id + ': 합성 시험 결정.', gloss_judgment: 'fit',
    sense_reviews: record.senses.map((sense) => ({
      sense_id: sense.id, boundary_action: 'retain', boundary_classification: 'atomic', boundary_decision: 'atomic',
      boundary_rationale: id + ' ' + sense.id + ': 한 가지 뜻으로 한정된다.', semantic_rationale: id + ' ' + sense.id + ': ' + sense.gloss,
      relation_decision: 'no-relations', relation_count: 0, relation_ids: [], no_relation_rationale: id + ' ' + sense.id + ': 관계 없음.',
    })),
    boundary_pairs: inspectSenseBoundaryPairs(record).map((pair) => {
      const gloss = (senseId) => record.senses.find((sense) => sense.id === senseId).gloss;
      return {
        left_sense_id: pair.left_sense_id, right_sense_id: pair.right_sense_id, relationship: pair.relationship, decision: 'retain',
        left_gloss_sha256: sha256Json(gloss(pair.left_sense_id)), right_gloss_sha256: sha256Json(gloss(pair.right_sense_id)),
        evidence_basis: id + ': 두 뜻은 서로 다른 쓰임이다.', distinguishing_feature: id + ': 쓰임이 다르다.', rationale: id + ': 별개의 뜻으로 유지한다.',
      };
    }),
  };
  row.review_binding = authorSemanticReviewBinding(row, record);
  const digest = 'a'.repeat(64);
  const plan = planStage3Admission({
    batchId: 'C900001', attempt: 1, admissionPr: 1,
    candidateManifest: { batch_id: 'C900001', status: 'complete', candidates_sha256: digest },
    reviewManifest: { batch_id: 'C900001', status: 'ready', attempt: 1, candidates_sha256: digest, semantic_decisions_sha256: digest },
    candidates: [{ candidate_id: id }], decisions: [decision], canonicalRecords, recordPathById, baseCanonicalSnapshotDigest: digest,
  });
  const authority = await buildStage3SemanticAuthority({
    root: process.cwd(), baseCanonicalRecords: canonicalRecords, plan, semanticDecisions: { decisions: [row] }, semanticDecisionsText: '{}',
  });
  const entryId = plan.entries[0].record_id;
  const reviewed = authority.sourceObject.authored_review.records.find((review) => review.record_id === entryId);
  assert.equal(reviewed.boundary_review.decision, 'split');
  assert.equal(reviewed.boundary_review.classification, 'separated');
  assert.equal(reviewed.boundary_review.pairwise.length, 1);
  assert.equal(reviewed.boundary_review.pairwise[0].decision, 'retain');
  assert.equal(reviewed.sense_reviews.length, 2);
  assert.deepEqual(reviewed.boundary_review.evidence.map((item) => item.sense_id), [entryId + '-s1', entryId + '-s2']);
  const afterRecords = canonicalRecords.map((existing) => plan.records.get(existing.id)?.record ?? existing)
    .concat([...plan.records.values()].filter((update) => !update.before).map((update) => update.record));
  const batchDecisionSources = await readAuthoredBatchDecisionSources();
  assert.doesNotThrow(() => buildSemanticAuditFromDecisionSource(afterRecords, authority.sourceObject, {
    baseRecords: afterRecords, batchDecisionSources, artifactId: 'test-complete-semantic-audit',
  }));
});

async function surfaceFormRoot(records) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'surface-form-dispositions-'));
  await mkdir(path.join(root, 'data/canonical'), { recursive: true });
  await mkdir(path.join(root, 'data/validation'), { recursive: true });
  await writeFile(path.join(root, 'data/canonical/x.jsonl'), records.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(path.join(root, 'data/validation/m6-2-inflection-exceptions.json'), JSON.stringify({ schema_version: 1, contract_id: 'm6-2-inflection-exceptions-v1', source_issue: 174, exceptions: [] }, null, 2) + '\n');
  await writeFile(path.join(root, 'data/validation/m6-3-surface-form-review.json'), JSON.stringify({
    schema_version: 1, contract_id: 'm6-3-searchable-predicate-review-v2', source_issue: 209, dispositions: [], reviewed_collisions: { exact_generated: [], ambiguous_generated: [] },
  }, null, 2) + '\n');
  return root;
}
const predicate = (id, lemma, pos = 'verb') => ({ id, record_type: 'entry', role: 'start', candidate_id: id, lemma, search_forms: [lemma], senses: [{ id: id + '-s1', pos, gloss: '뜻풀이.' }] });

test('Stage 3 adds the rule-dictated sense-bound surface-form disposition for new predicate senses, idempotently', async () => {
  const root = await surfaceFormRoot([predicate('w1', '그러다'), predicate('w2', '걸음', 'noun')]);
  try {
    assert.deepEqual(await applySurfaceFormDispositions({ root }), ['data/validation/m6-3-surface-form-review.json']);
    const review = JSON.parse(await readFile(path.join(root, 'data/validation/m6-3-surface-form-review.json'), 'utf8'));
    assert.deepEqual(review.dispositions.map(({ class_id, record_id, sense_id }) => ({ class_id, record_id, sense_id })), [
      { class_id: 'm6-3-open-vowel-past-excluded', record_id: 'w1', sense_id: 'w1-s1' },
    ]);
    assert.deepEqual(await applySurfaceFormDispositions({ root }), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a surface-form gap that needs a reviewer judgment fails as a lexical blocker instead of being guessed', async () => {
  const root = await surfaceFormRoot([predicate('w1', '좋다', 'adjective')]);
  try {
    await assert.rejects(applySurfaceFormDispositions({ root }), (error) => error.category === 'lexical' && error.code === 'STAGE3_SURFACE_FORM_JUDGMENT');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Stage 3 reviews the generated-form ambiguity a multi-sense predicate creates, with the fixed retain-all policy', async () => {
  const record = { ...predicate('w1', '같다', 'adjective'), senses: [{ id: 'w1-s1', pos: 'adjective', gloss: '첫째 뜻풀이.' }, { id: 'w1-s2', pos: 'adjective', gloss: '둘째 뜻풀이.' }] };
  const root = await surfaceFormRoot([record]);
  try {
    assert.deepEqual(await applySurfaceFormDispositions({ root }), ['data/validation/m6-3-surface-form-review.json']);
    const { reviewed_collisions: reviewed } = JSON.parse(await readFile(path.join(root, 'data/validation/m6-3-surface-form-review.json'), 'utf8'));
    const ambiguous = reviewed.ambiguous_generated.find(({ form }) => form === '같은');
    assert.deepEqual(ambiguous.candidates.map(({ sense_id }) => sense_id), ['w1-s1', 'w1-s2']);
    assert.match(ambiguous.reason, /Retain every listed sense-bound candidate/u);
    assert.deepEqual(reviewed.ambiguous_generated.map(({ form }) => form), [...reviewed.ambiguous_generated.map(({ form }) => form)].sort());
    assert.deepEqual(await applySurfaceFormDispositions({ root }), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Stage 3 extends an existing collision review when a later sense joins its candidate set, keeping its reason', async () => {
  const one = { ...predicate('w1', '같다', 'adjective'), senses: [{ id: 'w1-s1', pos: 'adjective', gloss: '첫째 뜻풀이.' }, { id: 'w1-s2', pos: 'adjective', gloss: '둘째 뜻풀이.' }] };
  const root = await surfaceFormRoot([one]);
  try {
    await applySurfaceFormDispositions({ root });
    const file = path.join(root, 'data/validation/m6-3-surface-form-review.json');
    const reviewed = JSON.parse(await readFile(file, 'utf8'));
    reviewed.reviewed_collisions.ambiguous_generated.find(({ form }) => form === '같은').reason = 'Reviewer wording kept.';
    await writeFile(file, JSON.stringify(reviewed, null, 2) + '\n');
    const three = { ...one, senses: [...one.senses, { id: 'w1-s3', pos: 'adjective', gloss: '셋째 뜻풀이.' }] };
    await writeFile(path.join(root, 'data/canonical/x.jsonl'), JSON.stringify(three) + '\n');
    assert.deepEqual(await applySurfaceFormDispositions({ root }), ['data/validation/m6-3-surface-form-review.json']);
    const next = JSON.parse(await readFile(file, 'utf8')).reviewed_collisions.ambiguous_generated.find(({ form }) => form === '같은');
    assert.deepEqual(next.candidates.map(({ sense_id }) => sense_id), ['w1-s1', 'w1-s2', 'w1-s3']);
    assert.equal(next.reason, 'Reviewer wording kept.');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('planning surface-form dispositions from projected records writes nothing, so a judgment gap leaves the worktree untouched', async () => {
  const root = await surfaceFormRoot([predicate('w1', '그러다')]);
  try {
    const canonicalFile = path.join(root, 'data/canonical/x.jsonl');
    const before = await Promise.all([canonicalFile, path.join(root, 'data/validation/m6-3-surface-form-review.json'), path.join(root, 'data/validation/m6-2-inflection-exceptions.json')].map((file) => readFile(file, 'utf8')));
    const projected = [predicate('w1', '그러다'), predicate('w2', '그러다'), predicate('w3', '좋다', 'adjective')];
    await assert.rejects(planSurfaceFormDispositions({ root, records: projected }), (error) => error.code === 'STAGE3_SURFACE_FORM_JUDGMENT');
    const plan = await planSurfaceFormDispositions({ root, records: projected.slice(0, 2) });
    assert.deepEqual(plan.map(({ path: relativePath }) => relativePath), ['data/validation/m6-3-surface-form-review.json']);
    const after = await Promise.all([canonicalFile, path.join(root, 'data/validation/m6-3-surface-form-review.json'), path.join(root, 'data/validation/m6-2-inflection-exceptions.json')].map((file) => readFile(file, 'utf8')));
    assert.deepEqual(after, before, 'planning never writes');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Real applyStage3Admission: a surface-form judgment gap must stop it before any canonical or manifest write.
test('applyStage3Admission leaves the worktree untouched when a surface-form judgment gap is found', async () => {
  const canonicalRecords = [];
  const recordPathById = new Map();
  for (const name of (await readdir('data/canonical')).filter((file) => file.endsWith('.jsonl'))) {
    for (const line of (await readFile(path.join('data/canonical', name), 'utf8')).split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      canonicalRecords.push(record);
      recordPathById.set(record.id, 'data/canonical/' + name);
    }
  }
  const id = 'C900001-0001';
  // A verb whose final coda needs a reviewer's regular/irregular judgment cannot be decided by the rule.
  const decision = {
    source_candidate_id: id, disposition: 'included', target: { kind: 'new_entry' },
    reviewed_record: { lemma: '합성놓다', senses: [{ pos: 'verb', gloss: '합성 시험에서 쓰는 단일 뜻풀이.' }] },
  };
  const record = reviewedCandidateRecord(decision);
  const row = {
    source_candidate_id: id, candidate_record_id: id, candidate_record_sha256: sha256Json(record), decision: 'included',
    decision_rationale: id + ': 합성 시험 결정.', gloss_judgment: 'fit',
    sense_reviews: record.senses.map((sense) => ({
      sense_id: sense.id, boundary_action: 'retain', boundary_classification: 'atomic', boundary_decision: 'atomic',
      boundary_rationale: id + ' ' + sense.id + ': 한 가지 뜻으로 한정된다.', semantic_rationale: id + ' ' + sense.id + ': ' + sense.gloss,
      relation_decision: 'no-relations', relation_count: 0, relation_ids: [], no_relation_rationale: id + ' ' + sense.id + ': 관계 없음.',
    })),
    boundary_pairs: inspectSenseBoundaryPairs(record).map(() => { throw new Error('single sense has no pairs'); }),
  };
  row.review_binding = authorSemanticReviewBinding(row, record);
  const digest = 'a'.repeat(64);
  const plan = planStage3Admission({
    batchId: 'C900001', attempt: 1, admissionPr: 1,
    candidateManifest: { batch_id: 'C900001', status: 'complete', candidates_sha256: digest },
    reviewManifest: { batch_id: 'C900001', status: 'ready', attempt: 1, candidates_sha256: digest, semantic_decisions_sha256: digest },
    candidates: [{ candidate_id: id }], decisions: [decision], canonicalRecords, recordPathById, baseCanonicalSnapshotDigest: digest,
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage3-apply-gap-'));
  try {
    for (const file of ['data/validation/canonical-semantic-decision-source.json', 'data/validation/m6-2-inflection-exceptions.json', 'data/validation/m6-3-surface-form-review.json']) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), await readFile(file, 'utf8'));
    }
    await mkdir(path.join(root, 'data/canonical'), { recursive: true });
    await mkdir(path.join(root, 'data/reviews/C900001'), { recursive: true });
    const reviewManifestPath = path.join(root, 'data/reviews/C900001/manifest.json');
    await writeFile(reviewManifestPath, '{"status":"ready"}\n');
    const snapshot = async () => JSON.stringify([
      await readdir(path.join(root, 'data/canonical')),
      ...await Promise.all([reviewManifestPath, ...['m6-2-inflection-exceptions.json', 'm6-3-surface-form-review.json', 'canonical-semantic-decision-source.json'].map((name) => path.join(root, 'data/validation', name))]
        .map((file) => readFile(file, 'utf8'))),
    ]);
    const before = await snapshot();
    // The projected canonical revision is used for planning, but the base records are never rewritten here.
    await assert.rejects(
      applyStage3Admission({
        root, claim: { batchId: 'C900001', attempt: 1 },
        prepared: { plan, reviewManifestPath, canonicalRecords, semanticDecisions: { decisions: [row] }, semanticDecisionsText: '{}' },
      }),
      (error) => error.category === 'lexical' && error.code === 'STAGE3_SURFACE_FORM_JUDGMENT',
    );
    assert.equal(await snapshot(), before, 'no canonical, manifest or authority file changed');

    // Same gap through processStage3Attempt with the real apply step: the draft is rejected from a clean tree.
    const events = [];
    const claim = { batchId: 'C000001', attempt: 1, claimRef: 'refs/heads/stage3-claims/C000001-a1', branchName: 'codex/stage3/C000001-a1', rejectionBranchName: 'codex/stage3-status/C000001-a1', baseSha: 'head', prNumber: 75 };
    const processManifestPath = path.join(root, 'data/reviews/C000001/manifest.json');
    await mkdir(path.dirname(processManifestPath), { recursive: true });
    await writeFile(processManifestPath, JSON.stringify(manifests([]).reviewManifest));
    const snapshotSync = () => JSON.stringify([
      readdirSync(path.join(root, 'data/canonical')),
      ...[processManifestPath, ...['m6-2-inflection-exceptions.json', 'm6-3-surface-form-review.json', 'canonical-semantic-decision-source.json'].map((name) => path.join(root, 'data/validation', name))]
        .map((file) => readFileSync(file, 'utf8')),
    ]);
    const processBefore = snapshotSync();
    const github = {
      async getPullRequest() { return { number: 75, state: 'open', draft: true, base: { ref: 'master' }, head: { ref: claim.branchName } }; },
      async getBranchHead() { return 'head'; },
      async updatePullRequestBody() { events.push('disposition'); },
      async closePullRequest() { events.push('close'); },
      async createPullRequest(payload) { events.push('status-pr'); return { number: 76, html_url: 'https://example.test/76' }; },
    };
    const git = {
      async fetchMaster() {}, resolveRef() { return 'head'; },
      // The rejection-status branch is created only from an unchanged worktree.
      createBranch() { events.push(snapshotSync() === processBefore ? 'status-branch:clean' : 'status-branch:DIRTY'); },
      async commitAndPush() {}, async deleteBranch() {},
    };
    const result = await processStage3Attempt({
      github, git, root, claim, runGates: false,
      prepare: async () => ({ plan, reviewManifestPath, canonicalRecords, semanticDecisions: { decisions: [row] }, semanticDecisionsText: '{}' }),
    });
    assert.equal(result.prState, 'rejection-status');
    assert.equal(result.prNumber, 76);
    assert.deepEqual(events.slice(0, 4), ['disposition', 'close', 'status-branch:clean', 'status-pr']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
