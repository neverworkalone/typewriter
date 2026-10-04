import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { planStage3Admission, applyStage3FileChanges, Stage3AdmissionError } from '../scripts/factory/admission.mjs';
import {
  claimNextStage3Batch,
  createStage3Draft,
  eligibleStage3Batches,
  processStage3Attempt,
  recoverStage3Attempt,
  releaseStage3Claim,
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

test('atomic claim race picks another ready batch and opens metadata Draft PR before preflight', async () => {
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
    async createStage3ClaimRef(batchId) { events.push(`claim:${batchId}`); return batchId !== 'C000001'; },
    async createPullRequest(payload) { events.push(`draft:${payload.draft}`); assert.match(payload.body, /Stage 3 attempt: C000002-a1/u); return { number: 52, html_url: 'https://example.test/52' }; },
  };
  const git = {
    async fetchMaster() {}, resolveRef() { return 'head'; }, originRemote() { return 'https://github.com/o/r.git'; },
    createBranch(name) { events.push(`branch:${name}`); },
    async writeStarterAndPush({ batchId }) { events.push(`starter:${batchId}`); },
  };
  const claim = await claimNextStage3Batch({ github, git, loadSnapshot: async () => snapshot, log: () => {} });
  assert.equal(claim.batchId, 'C000002');
  assert.equal(claim.prNumber, 52);
  assert.deepEqual(events.slice(0, 4), [
    'claim:C000001', 'claim:C000002', 'branch:codex/stage3/C000002-a1', 'starter:C000002',
  ]);
  assert.equal(events[4], 'draft:true');
});

test('two same-login sessions racing one ready batch create exactly one claim and starter PR', async () => {
  const events = [];
  const snapshot = {
    validated: true,
    candidates: [{ batchId: 'C000001', manifest: { status: 'complete' }, rows: [], files: [] }],
    reviews: [{ batchId: 'C000001', manifest: { status: 'ready', attempt: 1 }, decisions: [], files: [] }],
  };
  let listings = 0;
  let openListingBarrier;
  const bothListed = new Promise((resolve) => { openListingBarrier = resolve; });
  let claimed = false;
  const github = {
    async getBranchHead() { return 'head'; },
    async listStage3ClaimRefs() { listings += 1; if (listings === 2) openListingBarrier(); await bothListed; return []; },
    async listPullRequests() { return []; },
    async createStage3ClaimRef() { if (claimed) return false; claimed = true; events.push('claim'); return true; },
    async createPullRequest() { events.push('draft'); return { number: 53, html_url: 'https://example.test/53' }; },
  };
  const git = {
    async fetchMaster() {}, resolveRef() { return 'head'; }, originRemote() { return 'https://github.com/o/r.git'; },
    createBranch() { events.push('branch'); },
    async writeStarterAndPush() { events.push('starter'); },
  };
  const results = await Promise.all([
    claimNextStage3Batch({ github, git, loadSnapshot: async () => snapshot, log: () => {} }),
    claimNextStage3Batch({ github, git, loadSnapshot: async () => snapshot, log: () => {} }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(events.sort(), ['branch', 'claim', 'draft', 'starter']);
  assert.equal(eligibleStage3Batches(snapshot, ['refs/heads/stage3-claims/C000001-a1']).length, 0);
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
  const github = {
    async listStage3ClaimRefs() { return [{ ref: claimRef }]; },
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
  assert.deepEqual(createCalls, [92]);
  await assert.rejects(() => recoverStage3Attempt({
    github: { ...github, async listPullRequests() { return [
      { number: 95, state: 'closed', merged: false, body: `Claim ref: ${claimRef}`, head: { ref: 'codex/stage3/C000001-a1' } },
    ]; } },
    git: {}, batchId: 'C000001', attempt: 1,
  }), /without a recorded lexical-rejection disposition/u);
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
  let deleted = false;
  const claim = { batchId: 'C000001', attempt: 1, claimRef: 'refs/heads/stage3-claims/C000001-a1', branchName: 'codex/stage3/C000001-a1', prState: 'admission' };
  const github = {
    async getPullRequest() { return { number: 100, merged: true, base: { ref: 'master' }, head: { ref: claim.branchName } }; },
    async getBranchHead() { return 'master-sha'; },
    async deleteStage3ClaimRef() { deleted = true; },
  };
  const git = { async fetchMaster() {}, resolveRef() { return 'master-sha'; } };
  const released = await releaseStage3Claim({ github, git, claim, pullRequest: { number: 100 }, loadSnapshot: async () => ({ reviews: [{ batchId: 'C000001', manifest: { status: 'complete', attempt: 1, admission: { admission_pr: 100 } } }] }) });
  assert.equal(released, true);
  assert.equal(deleted, true);
});
