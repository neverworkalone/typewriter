import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { canonicalSnapshotDigest } from './stage1.mjs';
import { planStage3Admission, applyStage3FileChanges, Stage3AdmissionError } from './admission.mjs';
import { planSurfaceFormDispositions, writeSurfaceFormDispositions } from './surface-form-dispositions.mjs';
import { stage3SurfaceFormJudgments } from './surface-form-judgments.mjs';
import { buildStage3SemanticAuthority } from './semantic-authority.mjs';
import { loadFactorySnapshot } from './stage2-worker.mjs';
import { validateReviewArtifacts } from './artifacts.mjs';
import { validateFactoryRepository, loadBaseManifests } from './validate.mjs';

const MASTER = 'master';
const CLAIM_PREFIX = 'refs/heads/stage3-claims/';
const MARKER_NAME = (batchId, attempt) => `data/reviews/${batchId}/attempt-a${attempt}.json`;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export class Stage3WorkerError extends Error {
  constructor(message, { batchId, attempt, claimCreated = false, prNumber, category = 'systemic' } = {}) {
    super(message);
    this.name = 'Stage3WorkerError';
    this.batchId = batchId;
    this.attempt = attempt;
    this.claimCreated = claimCreated;
    this.prNumber = prNumber;
    this.category = category;
  }
}

function gitRun(root, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (error) {
    if (allowFailure && [1, 128].includes(error.status)) return null;
    const detail = String(error.stderr || error.message || '').trim();
    throw new Error('git ' + args.join(' ') + ' failed' + (detail ? ': ' + detail : ''));
  }
}

export function createStage3GitRepository({ root = process.cwd() } = {}) {
  return {
    root,
    async fetchMaster() { gitRun(root, ['fetch', 'origin', 'master:refs/remotes/origin/master']); },
    resolveRef(ref) { return gitRun(root, ['rev-parse', ref + '^{commit}']); },
    branchBaseSha() { return gitRun(root, ['merge-base', 'HEAD', 'origin/master']); },
    listFiles(ref) {
      const listing = gitRun(root, ['ls-tree', '-r', '--name-only', ref, '--', 'data/candidates', 'data/reviews', 'data/canonical', 'data/validation/canonical-semantic-decision-source.json']);
      return listing ? listing.split('\n').filter(Boolean) : [];
    },
    show(ref, file) {
      return execFileSync('git', ['show', ref + ':' + file], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    },
    createBranch(branchName, baseSha) {
      const status = gitRun(root, ['status', '--porcelain', '--untracked-files=all']);
      if (status) throw new Error('working tree must be clean before creating a Stage 3 branch');
      if (gitRun(root, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branchName], { allowFailure: true }) !== null) throw new Error('local branch already exists: ' + branchName);
      if (gitRun(root, ['ls-remote', '--heads', 'origin', 'refs/heads/' + branchName])) throw new Error('remote branch already exists: ' + branchName);
      gitRun(root, ['switch', '-c', branchName, baseSha]);
    },
    async writeStarterAndPush({ branchName, batchId, attempt, claimRef }) {
      const file = path.join(root, MARKER_NAME(batchId, attempt));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ batch_id: batchId, attempt, claim_ref: claimRef }, null, 2) + '\n', 'utf8');
      gitRun(root, ['add', MARKER_NAME(batchId, attempt)]);
      gitRun(root, ['commit', '-m', `[Stage 3] Start ${batchId} attempt ${attempt}`]);
      gitRun(root, ['push', '-u', 'origin', branchName]);
      return gitRun(root, ['rev-parse', 'HEAD']);
    },
    remoteBranchExists(branchName) {
      return Boolean(gitRun(root, ['ls-remote', '--heads', 'origin', 'refs/heads/' + branchName]));
    },
    async fetchRemoteBranch(branchName) {
      gitRun(root, ['fetch', 'origin', branchName + ':refs/remotes/origin/' + branchName]);
    },
    restorePullRequestBranch(prNumber, branchName, expectedHeadSha) {
      const status = gitRun(root, ['status', '--porcelain', '--untracked-files=all']);
      if (status) throw new Error('working tree must be clean before restoring a Stage 3 admission branch');
      const remote = gitRun(root, ['ls-remote', '--heads', 'origin', 'refs/heads/' + branchName]);
      if (remote) {
        const remoteSha = remote.split(/\s+/u)[0];
        if (remoteSha !== expectedHeadSha) throw new Error('remote admission branch does not match its closed PR head');
        return remoteSha;
      }
      const local = gitRun(root, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branchName], { allowFailure: true });
      if (local === null) {
        gitRun(root, ['fetch', 'origin', `refs/pull/${prNumber}/head:refs/heads/${branchName}`]);
      }
      const localSha = gitRun(root, ['rev-parse', 'refs/heads/' + branchName + '^{commit}']);
      if (localSha !== expectedHeadSha) throw new Error('restored admission branch does not match its closed PR head');
      gitRun(root, ['push', '-u', 'origin', 'refs/heads/' + branchName + ':refs/heads/' + branchName]);
      return localSha;
    },
    deleteBranch(branchName) {
      gitRun(root, ['push', 'origin', '--delete', branchName]);
    },
    pushRebasedBranch(branchName) {
      gitRun(root, ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/' + branchName]);
    },
    async commitAndPush({ branchName, message, files }) {
      gitRun(root, ['add', '--', ...files]);
      gitRun(root, ['commit', '-m', message]);
      gitRun(root, ['push', 'origin', 'HEAD:refs/heads/' + branchName]);
      return gitRun(root, ['rev-parse', 'HEAD']);
    },
    async commitPrepared({ message, files }) {
      gitRun(root, ['add', '--', ...files]);
      gitRun(root, ['commit', '-m', message]);
      return gitRun(root, ['rev-parse', 'HEAD']);
    },
    async pushPrepared(branchName) {
      gitRun(root, ['push', 'origin', 'HEAD:refs/heads/' + branchName]);
    },
    isAncestor(ancestor, descendant) {
      return gitRun(root, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true }) !== null;
    },
    rebaseOnMaster() {
      gitRun(root, ['fetch', 'origin', 'master:refs/remotes/origin/master']);
      gitRun(root, ['rebase', 'origin/master']);
    },
    async refreshBranch(branchName) {
      if (gitRun(root, ['status', '--porcelain', '--untracked-files=all'])) {
        throw new Error('Stage 3 recovery requires a clean worktree; preserve uncommitted work');
      }
      gitRun(root, ['fetch', 'origin', branchName + ':refs/remotes/origin/' + branchName]);
      const current = gitRun(root, ['branch', '--show-current']);
      if (current !== branchName) gitRun(root, ['switch', branchName]);
      const remoteRef = 'refs/remotes/origin/' + branchName;
      if (this.isAncestor(remoteRef, 'HEAD')) return; // Keep a local, not-yet-pushed admission checkpoint.
      gitRun(root, ['merge', '--ff-only', remoteRef]);
    },
    async restoreMaster() {
      const current = gitRun(root, ['branch', '--show-current']);
      if (current !== MASTER) gitRun(root, ['switch', MASTER]);
    },
    async deleteLocalBranch(branchName) {
      const current = gitRun(root, ['branch', '--show-current']);
      if (current === branchName) await this.restoreMaster();
      gitRun(root, ['branch', '-D', branchName], { allowFailure: true });
    },
    originRemote() { return gitRun(root, ['remote', 'get-url', 'origin']); },
    root,
  };
}

function naturalOrder(left, right) { return left.batchId.localeCompare(right.batchId, 'en', { numeric: true }); }
function branchNameFor(agent, batchId, attempt) {
  if (!['codex', 'claude'].includes(agent)) throw new Stage3WorkerError('agent must be codex or claude');
  return `${agent}/stage3/${batchId}-a${attempt}`;
}
function rejectionBranchName(agent, batchId, attempt) { return `${agent}/stage3-status/${batchId}-a${attempt}`; }
const claimRefFor = (batchId, attempt) => CLAIM_PREFIX + batchId + '-a' + attempt;

// Every path that starts or resumes an admission (new claim, --resume-batch recovery, a draft with
// a complete checkpoint) must refuse a review authored under an older shared contract: a complete
// checkpoint is no longer a pending review, so only this strict check can still see the staleness.
export function assertStage3ContractCurrent(claim, snapshot) {
  const at = `${claim.batchId}-a${claim.attempt}`;
  const advice = 'needs a contract repair (a systemic re-binding of the ready review, not a rejection) before it can be admitted';
  if ((snapshot?.staleContractBatches ?? []).includes(claim.batchId)) throw new Stage3WorkerError(`${at} ${advice}`, { batchId: claim.batchId, attempt: claim.attempt });
  if (claim.reviewManifest?.status === 'complete') return;
  if (!Array.isArray(claim.candidates) || typeof claim.semanticDecisionsText !== 'string' || typeof claim.handoffText !== 'string' || !Array.isArray(claim.decisions) || !claim.candidateManifest) return;
  const errors = validateReviewArtifacts({
    batchId: claim.batchId, adapterId: claim.candidateManifest.source_adapter, candidates: claim.candidates, decisions: claim.decisions,
    semanticDecisionsText: claim.semanticDecisionsText, handoffText: claim.handoffText, requireScopeDeclaration: true,
  });
  if (errors.some((error) => error.includes('scope_declaration is required'))) throw new Stage3WorkerError(`${at} ${advice}`, { batchId: claim.batchId, attempt: claim.attempt });
}

export function eligibleStage3Batches(snapshot, claimRefs = [], openPullRequests = []) {
  if (!snapshot?.validated || !Array.isArray(snapshot.reviews) || !Array.isArray(snapshot.candidates)) {
    throw new Stage3WorkerError('validated latest-master factory snapshot is required');
  }
  const claimed = new Set(claimRefs.map((value) => typeof value === 'string' ? value : value.ref).filter(Boolean));
  const open = openPullRequests.map((value) => value.pullRequest ?? value);
  const candidatesById = new Map(snapshot.candidates.map((entry) => [entry.batchId, entry]));
  // A ready review authored under an older shared contract needs a contract repair (a systemic
  // re-binding, never a rejection) before it can be admitted; the serial agent moves to the next one.
  const stale = new Set(snapshot.staleContractBatches ?? []);
  return snapshot.reviews.flatMap((review) => {
    if (stale.has(review.batchId)) return [];
    const candidate = candidatesById.get(review.batchId);
    if (!candidate || candidate.manifest.status !== 'complete' || review.manifest.status !== 'ready') return [];
    const attempt = review.manifest.attempt;
    const claimRef = claimRefFor(review.batchId, attempt);
    const linkedOpenPr = open.some((pr) => {
      const head = pr.head?.ref ?? '';
      const body = pr.body ?? '';
      return head.endsWith(`/stage3/${review.batchId}-a${attempt}`)
        || head.endsWith(`/stage3-status/${review.batchId}-a${attempt}`)
        || body.includes(claimRef)
        || body.includes(`Stage 3 attempt: ${review.batchId}-a${attempt}`);
    });
    if (claimed.has(claimRef) || linkedOpenPr) return [];
    return [{ ...review, candidate, attempt, claimRef }];
  }).sort(naturalOrder);
}

function isStage3PullRequest(pr) {
  const head = pr.head?.ref ?? '';
  const body = pr.body ?? '';
  return head.includes('/stage3/') || head.includes('/stage3-status/')
    || body.includes('Claim ref: ' + CLAIM_PREFIX)
    || body.includes('Stage 3 attempt: C');
}

export function hasStage3Activity({ activeLock, claimRefs = [], openPullRequests = [] } = {}) {
  return Boolean(activeLock)
    || claimRefs.some((value) => String(typeof value === 'string' ? value : value.ref ?? '').startsWith(CLAIM_PREFIX))
    || openPullRequests.map((value) => value.pullRequest ?? value).some((pr) => pr.state !== 'closed' && isStage3PullRequest(pr));
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
  if (remoteSha !== localSha) throw new Stage3WorkerError('local origin/master does not match GitHub master; refusing a stale Stage 3 attempt');
  return { headSha: remoteSha, snapshot: await loadSnapshot({ git, headSha: remoteSha }) };
}

function draftBody({ batchId, attempt, claimRef, baseSha, branchName }) {
  return [
    `Stage 3 admission attempt for ${batchId}.`,
    `Stage 3 attempt: ${batchId}-a${attempt}`,
    `Claim ref: ${claimRef}`,
    `Master snapshot: ${baseSha}`,
    `Branch: ${branchName}`,
    'The draft is opened before canonical preflight so its actual PR number can be recorded if Stage 2 evidence conflicts with current master.',
  ].join('\n');
}

export async function createStage3Draft({ github, git, claim, existingStarter = false, log = () => {} } = {}) {
  const { batchId, attempt, claimRef, baseSha, branchName } = claim;
  try {
    if (!existingStarter) {
      git.createBranch(branchName, baseSha);
      await git.writeStarterAndPush({ branchName, batchId, attempt, claimRef });
    }
    const pullRequest = await github.createPullRequest({
      title: `[Stage 3] Admit ${batchId} attempt ${attempt}`,
      body: draftBody(claim), head: branchName, base: MASTER, draft: true,
    });
    if (!Number.isInteger(pullRequest?.number)) throw new Stage3WorkerError('GitHub did not return the actual Stage 3 draft PR number', { ...claim, claimCreated: true });
    const result = { ...claim, prNumber: pullRequest.number, prUrl: pullRequest.html_url, prState: 'draft' };
    log(JSON.stringify(result));
    return result;
  } catch (error) {
    if (error instanceof Stage3WorkerError && error.claimCreated) throw error;
    throw new Stage3WorkerError(`Stage 3 claim ${batchId}-a${attempt} was created; preserve the ref and recover its starter attempt manually: ${error.message}`, {
      ...claim, claimCreated: true,
    });
  }
}

export async function claimNextStage3Batch({
  github, git, agent = 'codex', loadSnapshot = loadFactorySnapshot, log = () => {}, ownerToken = randomUUID,
} = {}) {
  const { headSha, snapshot } = await currentMaster({ github, git, loadSnapshot });
  const [claimRefs, openPullRequests, activeLock] = await Promise.all([
    github.listStage3ClaimRefs(), github.listPullRequests('open'), github.getStage3ActiveLock(),
  ]);
  if (hasStage3Activity({ activeLock, claimRefs, openPullRequests })) {
    log(activeLock
      ? `Stage 3 is globally locked by ${activeLock.batchId}-a${activeLock.attempt}; waiting for explicit recovery or merge.`
      : 'Stage 3 has a claim or open attempt without a matching global lock; preserving state for explicit recovery.');
    return null;
  }
  const candidates = eligibleStage3Batches(snapshot, claimRefs, openPullRequests);
  const candidate = candidates[0];
  if (!candidate) return null;
  const { batchId, attempt } = candidate;
  const claimRef = claimRefFor(batchId, attempt);
  let lock;
  try {
    lock = await github.createStage3ActiveLock({ batchId, attempt, baseSha: headSha, ownerToken: ownerToken() });
  } catch (error) {
    throw new Stage3WorkerError(`Stage 3 global lock acquisition for ${batchId}-a${attempt} has an uncertain outcome; inspect refs before continuing: ${error.message}`, {
      batchId, attempt, claimCreated: true,
    });
  }
  if (!lock) {
    log('another Stage 3 session acquired the global lock; this session will not select another batch.');
    return null;
  }
  try {
    if (!await github.createStage3ClaimRef(batchId, attempt, headSha)) {
      throw new Stage3WorkerError(`Stage 3 global lock belongs to ${batchId}-a${attempt}, but its batch claim already exists; preserve both refs for explicit recovery`, {
        batchId, attempt, claimCreated: true,
      });
    }
  } catch (error) {
    if (error instanceof Stage3WorkerError) throw error;
    throw new Stage3WorkerError(`Stage 3 global lock for ${batchId}-a${attempt} remains held; batch-claim creation has an uncertain outcome: ${error.message}`, {
      batchId, attempt, claimCreated: true,
    });
  }
  const claim = {
    batchId, attempt, claimRef, baseSha: headSha, agent, activeLock: lock,
    branchName: branchNameFor(agent, batchId, attempt),
    rejectionBranchName: rejectionBranchName(agent, batchId, attempt),
    candidates: candidate.candidate.rows,
    candidateManifest: candidate.candidate.manifest,
    candidateFiles: candidate.candidate.files,
    reviewManifest: candidate.manifest,
    decisions: candidate.decisions,
    decisionsText: candidate.decisionsText,
    semanticDecisionsText: candidate.semanticDecisionsText,
    handoffText: candidate.handoffText,
    reviewFiles: candidate.files,
    canonicalEntries: snapshot.canonicalEntries,
  };
  return createStage3Draft({ github, git, claim, log });
}

function canonicalRecordLocations(git, headSha) {
  const rows = [];
  const pathById = new Map();
  for (const file of git.listFiles(headSha).filter((name) => /^data\/canonical\/[^/]+\.jsonl$/u.test(name)).sort()) {
    const content = git.show(headSha, file);
    for (const [index, line] of content.split('\n').entries()) {
      if (!line) continue;
      const record = JSON.parse(line);
      if (pathById.has(record.id)) throw new Stage3WorkerError(`latest canonical contains duplicate id ${record.id}`);
      pathById.set(record.id, { file, line: index + 1 });
      rows.push(record);
    }
  }
  return { rows, pathById };
}

export async function preflightStage3Admission({ root, git, claim, admissionPr } = {}) {
  const { rows: canonicalRecords, pathById } = canonicalRecordLocations(git, claim.baseSha);
  const reviewManifestPath = path.join(root, 'data/reviews', claim.batchId, 'manifest.json');
  const reviewManifest = JSON.parse(await readFile(reviewManifestPath, 'utf8'));
  const candidateManifest = JSON.parse(await readFile(path.join(root, 'data/candidates', claim.batchId, 'manifest.json'), 'utf8'));
  const decisionsText = await readFile(path.join(root, 'data/reviews', claim.batchId, 'decisions.jsonl'), 'utf8');
  const decisions = decisionsText.trimEnd().split('\n').map((line) => JSON.parse(line));
  const semanticDecisionsText = await readFile(path.join(root, 'data/reviews', claim.batchId, 'semantic-decisions.json'), 'utf8');
  const semanticDecisions = JSON.parse(semanticDecisionsText);
  const candidatesText = await readFile(path.join(root, 'data/candidates', claim.batchId, 'candidates.jsonl'), 'utf8');
  const candidates = candidatesText.trimEnd().split('\n').map((line) => JSON.parse(line));
  const baseCanonicalSnapshotDigest = await canonicalSnapshotDigest(root);
  const plan = planStage3Admission({
    batchId: claim.batchId, attempt: claim.attempt, admissionPr, candidateManifest, reviewManifest,
    candidates, decisions, canonicalRecords, recordPathById: new Map([...pathById].map(([id, value]) => [id, value.file])),
    baseCanonicalSnapshotDigest,
  });
  return { plan, reviewManifestPath, canonicalSnapshotBefore: baseCanonicalSnapshotDigest, canonicalRecords, semanticDecisions, semanticDecisionsText };
}

export async function applyStage3Admission({ root, git, claim, prepared } = {}) {
  const { plan, reviewManifestPath } = prepared;
  const semanticAuthority = await buildStage3SemanticAuthority({
    root, baseCanonicalRecords: prepared.canonicalRecords, plan,
    semanticDecisions: prepared.semanticDecisions, semanticDecisionsText: prepared.semanticDecisionsText,
  });
  const projected = new Map(prepared.canonicalRecords.map((record) => [record.id, record]));
  for (const [id, update] of plan.records) projected.set(id, update.record);
  const surfacePlan = await planSurfaceFormDispositions({ root, records: [...projected.values()], judgments: stage3SurfaceFormJudgments(plan.decisions) });
  await applyStage3FileChanges(plan, { root, reviewManifestPath });
  const surfaceFiles = await writeSurfaceFormDispositions(surfacePlan);
  await writeFile(path.join(root, semanticAuthority.sourcePath), semanticAuthority.sourceText, 'utf8');
  const digest = await canonicalSnapshotDigest(root);
  plan.reviewManifest.admission.canonical_snapshot_digest = digest;
  await writeFile(reviewManifestPath, JSON.stringify(plan.reviewManifest, null, 2) + '\n', 'utf8');
  const marker = path.join(root, MARKER_NAME(claim.batchId, claim.attempt));
  await rm(marker, { force: true });
  const reportFiles = refreshStage3ReportCheckpoints(root);
  return { ...prepared, semanticAuthority, plan, files: [...new Set([...reportFiles, ...surfaceFiles, ...plan.changes.map((change) => change.path), semanticAuthority.sourcePath, `data/reviews/${claim.batchId}/manifest.json`, MARKER_NAME(claim.batchId, claim.attempt)])] };
}

// Existing M9 reports contain live canonical/search/SQLite checkpoint fields.
// Refresh them through their ordinary source-bound report producers before pinning CI's tree.
export function refreshStage3ReportCheckpoints(root, run = execFileSync) {
  for (const script of ['inventory:issue-210:write', 'batch:issue-219:report', 'batch:issue-220:report', 'batch:issue-222:report']) {
    run('pnpm', ['run', script], { cwd: root, stdio: 'inherit' });
  }
  return [
    'docs/issue-210-historical-exclusion-report.md', 'data/inventory/issue-210-recovery-inventory.json',
    'docs/issue-222-m9-d-scale-coverage.md', 'data/validation/issue-222-m9-d-scale-coverage-report.json',
    'docs/issue-219-m9-a-recovery.md', 'data/validation/issue-219-m9-lexical-batch-report.json',
    'docs/issue-220-m9-b-checkpoint.md', 'data/validation/issue-220-m9-b-checkpoint-report.json',
  ];
}

export function runStage3PreflightCi(root, run = execFileSync) {
  run('pnpm', ['run', 'ci:normal'], { cwd: root, stdio: 'inherit' });
}

export async function validatePreparedStage3Admission({ root, git, claim, prepared, runGates = true } = {}) {
  const base = loadBaseManifests('origin/master', root);
  const errors = await validateFactoryRepository({ root, base });
  if (errors.length) throw new Stage3WorkerError('Stage 3 factory and transition validation failed:\n' + errors.join('\n'), {
    batchId: claim.batchId, attempt: claim.attempt, claimCreated: true, prNumber: claim.prNumber,
  });
  if (runGates) {
    try {
      runStage3PreflightCi(root);
    } catch (error) {
      throw new Stage3WorkerError('complete canonical CI failed during Stage 3 preflight; preserve the draft as a systemic blocker', {
        batchId: claim.batchId, attempt: claim.attempt, claimCreated: true, prNumber: claim.prNumber,
      });
    }
  }
  return prepared;
}

function statusManifestForRejection(manifest, admissionPr) {
  if (manifest.status !== 'ready' || manifest.admission !== undefined) throw new Stage3WorkerError('only the current ready review may enter rejection recovery');
  return {
    ...manifest,
    status: 'rejected',
    rejected_pr: admissionPr,
    history: [...manifest.history, { attempt: manifest.attempt, rejected_pr: admissionPr }],
  };
}

async function verifySupersededRejection({ github, git, rejection, admission, batchId, attempt, claimRef, reviewManifest }) {
  const branchName = rejection?.head?.ref;
  const manifestPath = `data/reviews/${batchId}/manifest.json`;
  if (!['codex', 'claude'].some((agent) => branchName === rejectionBranchName(agent, batchId, attempt))
    || rejection.base?.ref !== MASTER
    || !String(rejection.body ?? '').includes(`Claim ref: ${claimRef}`)
    || !String(rejection.body ?? '').includes(`Closed admission draft: #${admission.number}`)) {
    throw new Stage3WorkerError(`status PR #${rejection.number} is not the linked status-only rejection for ${batchId}-a${attempt}`, {
      batchId, attempt, claimCreated: true, prNumber: rejection.number,
    });
  }
  const files = await github.getPullRequestFiles(rejection.number);
  if (!Array.isArray(files) || files.length !== 1 || files[0]?.filename !== manifestPath) {
    throw new Stage3WorkerError(`status PR #${rejection.number} is not limited to ${manifestPath}`, {
      batchId, attempt, claimCreated: true, prNumber: rejection.number,
    });
  }
  if (typeof git.fetchRemoteBranch !== 'function') throw new Stage3WorkerError('Git adapter cannot verify the existing status branch', { batchId, attempt, claimCreated: true, prNumber: rejection.number });
  await git.fetchRemoteBranch(branchName);
  const remoteRef = `origin/${branchName}`;
  if (rejection.head?.sha && git.resolveRef(remoteRef) !== rejection.head.sha) {
    throw new Stage3WorkerError(`status PR #${rejection.number} head changed during retry recovery`, {
      batchId, attempt, claimCreated: true, prNumber: rejection.number,
    });
  }
  let branchManifest;
  try { branchManifest = JSON.parse(git.show(remoteRef, manifestPath)); } catch (error) {
    throw new Stage3WorkerError(`status PR #${rejection.number} branch has no readable review manifest: ${error.message}`, {
      batchId, attempt, claimCreated: true, prNumber: rejection.number,
    });
  }
  if (!same(branchManifest, statusManifestForRejection(reviewManifest, admission.number))) {
    throw new Stage3WorkerError(`status PR #${rejection.number} no longer represents the exact rejected state for ${batchId}-a${attempt}`, {
      batchId, attempt, claimCreated: true, prNumber: rejection.number,
    });
  }
  const rejectionCode = stage3RejectionCode(admission.body);
  const statusCodes = [...String(rejection.body ?? '').matchAll(/^Stage 3 rejection code: ([A-Z0-9_]+)\.$/gmu)].map((match) => match[1]);
  if (!rejectionCode || statusCodes.length > 1 || (statusCodes.length === 1 && statusCodes[0] !== rejectionCode)) {
    throw new Stage3WorkerError(`status PR #${rejection.number} does not bind the admission PR's rejection code`, {
      batchId, attempt, claimCreated: true, prNumber: rejection.number,
    });
  }
  return { branchName, manifestPath, rejectionCode };
}

/** Supersedes one exact unmerged rejection PR so its still-ready attempt can be retried. */
export async function supersedeStage3RejectionForRetry({
  github, git, snapshot, batchId, attempt, rejectionPrNumber, dryRun = false, log = () => {},
} = {}) {
  const claimRef = claimRefFor(batchId, attempt);
  const [claimRefs, activeLock, allPullRequests, remoteMaster] = await Promise.all([
    github.listStage3ClaimRefs(), github.getStage3ActiveLock(), github.listPullRequests('all'), github.getBranchHead(MASTER),
  ]);
  if (!snapshot?.validated || git.resolveRef('origin/master') !== remoteMaster || snapshot.headSha !== remoteMaster) {
    throw new Stage3WorkerError('retry recovery requires the validated snapshot to match current GitHub master', { batchId, attempt, claimCreated: true });
  }
  const hasClaim = claimRefs.some((ref) => (typeof ref === 'string' ? ref : ref.ref) === claimRef);
  const otherClaims = claimRefs.filter((ref) => {
    const name = (typeof ref === 'string' ? ref : ref.ref) || '';
    return name.startsWith(CLAIM_PREFIX) && name !== claimRef;
  });
  if (!activeLock || activeLock.batchId !== batchId || activeLock.attempt !== attempt || !hasClaim || otherClaims.length) {
    throw new Stage3WorkerError(`${claimRef} does not exclusively own the matching Stage 3 lock and claim`, { batchId, attempt, claimCreated: hasClaim });
  }
  const stage3PullRequests = allPullRequests.filter(isStage3PullRequest);
  const admissionBranches = ['codex', 'claude'].map((agent) => branchNameFor(agent, batchId, attempt));
  const statusBranches = ['codex', 'claude'].map((agent) => rejectionBranchName(agent, batchId, attempt));
  const exactBodyLine = (pr, line) => String(pr.body ?? '').split(/\r?\n/u).some((entry) => entry === line);
  const attemptPullRequests = stage3PullRequests.filter((pr) => admissionBranches.includes(pr.head?.ref)
    || statusBranches.includes(pr.head?.ref)
    || exactBodyLine(pr, `Claim ref: ${claimRef}`)
    || exactBodyLine(pr, `Stage 3 attempt: ${batchId}-a${attempt}`));
  const admissionPullRequests = attemptPullRequests.filter((pr) => admissionBranches.includes(pr.head?.ref));
  const statusPullRequests = attemptPullRequests.filter((pr) => statusBranches.includes(pr.head?.ref));
  if (attemptPullRequests.length !== 2 || admissionPullRequests.length !== 1 || statusPullRequests.length !== 1) {
    throw new Stage3WorkerError(`retry recovery found ambiguous PR history for ${batchId}-a${attempt}; preserving all PRs and refs`, {
      batchId, attempt, claimCreated: true, prNumber: rejectionPrNumber,
    });
  }
  const admission = admissionPullRequests[0];
  const rejection = statusPullRequests[0];
  if (rejection.number !== rejectionPrNumber) {
    throw new Stage3WorkerError(`PR #${rejectionPrNumber} is not the unique status PR for ${batchId}-a${attempt}; preserving all PRs and refs`, {
      batchId, attempt, claimCreated: true, prNumber: rejectionPrNumber,
    });
  }
  const openStage3Pulls = stage3PullRequests.filter((pr) => pr.state === 'open');
  const rejectionOpen = rejection?.state === 'open';
  const admissionOpen = admission?.state === 'open';
  const alreadySuperseded = admissionOpen && rejection?.state === 'closed';
  const expectedOpenCount = rejectionOpen || admissionOpen ? 1 : 0;
  if (openStage3Pulls.length !== expectedOpenCount
    || (rejectionOpen && openStage3Pulls[0]?.number !== rejectionPrNumber)
    || (admissionOpen && openStage3Pulls[0]?.number !== admission.number)
    || (rejectionOpen && admissionOpen)) {
    throw new Stage3WorkerError('retry recovery found another open Stage 3 PR; preserving all PRs and refs', {
      batchId, attempt, claimCreated: true, prNumber: rejectionPrNumber,
    });
  }
  if (!admission || !['open', 'closed'].includes(admission.state) || admission.merged || admission.merged_at
    || !/^Stage 3 disposition: lexical-rejection \([A-Z0-9_]+\)\.$/mu.test(admission.body ?? '')
    || !(admission.body ?? '').includes(`Claim ref: ${claimRef}`)
    || admission.base?.ref !== MASTER || admission.draft !== true) {
    throw new Stage3WorkerError(`${batchId}-a${attempt} has no matching closed lexical-rejection Draft PR to reopen`, {
      batchId, attempt, claimCreated: true, prNumber: admission?.number,
    });
  }
  if (!rejection || rejection.number !== rejectionPrNumber || !['open', 'closed'].includes(rejection.state)
    || rejection.merged || rejection.merged_at || rejection.base?.ref !== MASTER) {
    throw new Stage3WorkerError(`PR #${rejectionPrNumber} is not the open, unmerged status PR for ${batchId}-a${attempt}`, {
      batchId, attempt, claimCreated: true, prNumber: rejectionPrNumber,
    });
  }
  const review = snapshot.reviews?.find((entry) => entry.batchId === batchId);
  const candidate = snapshot.candidates?.find((entry) => entry.batchId === batchId);
  if (!review || !candidate || review.manifest.status !== 'ready' || review.manifest.attempt !== attempt
    || review.manifest.admission !== undefined || !candidate.manifest || candidate.manifest.status !== 'complete') {
    throw new Stage3WorkerError(`${batchId}-a${attempt} is no longer the same ready attempt on master`, {
      batchId, attempt, claimCreated: true, prNumber: rejectionPrNumber,
    });
  }
  const verifiedStatus = await verifySupersededRejection({ github, git, rejection, admission, batchId, attempt, claimRef, reviewManifest: review.manifest });
  if (dryRun) return { status: alreadySuperseded ? 'retry-already-superseded' : 'retry-ready', batchId, attempt, admissionPr: admission.number, rejectionPr: rejectionPrNumber, claimRef };

  try {
    const restoredSha = git.restorePullRequestBranch(admission.number, admission.head.ref, admission.head.sha);
    if (restoredSha !== admission.head.sha) throw new Error('restored admission branch SHA does not match its closed Draft PR');
  } catch (error) {
    throw new Stage3WorkerError(`could not restore admission PR #${admission.number} branch; status PR remains open: ${error.message}`, {
      batchId, attempt, claimCreated: true, prNumber: admission.number,
    });
  }

  if (!alreadySuperseded) {
    if (rejectionOpen) await github.closePullRequest(rejectionPrNumber);
    try {
      if (!admissionOpen) await github.reopenPullRequest(admission.number);
      const reopened = await github.getPullRequest(admission.number);
      if (reopened?.state !== 'open' || reopened?.draft !== true || reopened?.head?.ref !== admission.head.ref) {
        throw new Error('GitHub did not reopen the same admission Draft PR');
      }
    } catch (error) {
      if (rejectionOpen) {
        try { await github.reopenPullRequest(rejectionPrNumber); } catch { /* Preserve the original recovery error. */ }
      }
      throw new Stage3WorkerError(`superseded status PR #${rejectionPrNumber}; could not safely reopen admission PR #${admission.number}: ${error.message}`, {
        batchId, attempt, claimCreated: true, prNumber: admission.number,
      });
    }
    log(`Superseded status PR #${rejectionPrNumber} and reopened admission Draft PR #${admission.number} for ${batchId}-a${attempt}.`);
  } else {
    log(`Verified admission Draft PR #${admission.number} is already reopened and status PR #${rejectionPrNumber} is closed.`);
  }
  return {
    status: 'retry-ready', batchId, attempt, admissionPr: admission.number, rejectionPr: rejectionPrNumber,
    rejectionBranchName: verifiedStatus.branchName, supersededRejectionCode: verifiedStatus.rejectionCode, claimRef,
  };
}

const stage3RejectionCodes = (body) => [...String(body ?? '').matchAll(/^Stage 3 disposition: lexical-rejection \(([A-Z0-9_]+)\)\.$/gmu)].map((match) => match[1]);
const stage3RejectionCode = (body) => {
  const codes = stage3RejectionCodes(body);
  return codes.length === 1 ? codes[0] : undefined;
};

function recordLexicalRejection(pr, error, claim) {
  const marker = `Stage 3 disposition: lexical-rejection (${error.code ?? 'STAGE3_LEXICAL_BLOCK'}).`;
  const body = pr.body ?? '';
  const previousCodes = stage3RejectionCodes(body);
  if (previousCodes.length > 1) {
    throw new Stage3WorkerError('admission Draft contains multiple lexical-rejection codes; preserve it for owner recovery', {
      batchId: claim.batchId, attempt: claim.attempt, claimCreated: true, prNumber: pr.number,
    });
  }
  const previousCode = previousCodes[0];
  const currentCode = error.code ?? 'STAGE3_LEXICAL_BLOCK';
  if (previousCode && previousCode !== currentCode) {
    throw new Stage3WorkerError(`retry produced ${currentCode}, but the existing Draft records ${previousCode}; preserve both PRs and inspect the changed blocker`, {
      batchId: claim.batchId, attempt: claim.attempt, claimCreated: true, prNumber: pr.number,
    });
  }
  return previousCode ? body : `${body}${body.endsWith('\n') || body.length === 0 ? '' : '\n'}\n${marker}`;
}

export async function createRejectionStatusPullRequest({ github, git, root, claim, admissionPr, rejectionCode, log = () => {} } = {}) {
  const branchName = claim.rejectionBranchName ?? rejectionBranchName(claim.agent ?? 'codex', claim.batchId, claim.attempt);
  const manifestPath = `data/reviews/${claim.batchId}/manifest.json`;
  try {
    await git.fetchMaster();
    const baseSha = git.resolveRef('origin/master');
    const absolute = path.join(root, manifestPath);
    const manifest = JSON.parse(await readFile(absolute, 'utf8'));
    const rejected = statusManifestForRejection(manifest, admissionPr);
    if (claim.supersededRejectionPr !== undefined) {
      if (claim.supersededRejectionCode !== rejectionCode) {
        throw new Stage3WorkerError(`retry rejection code ${rejectionCode} differs from superseded code ${claim.supersededRejectionCode}`, {
          ...claim, claimCreated: true, prNumber: claim.supersededRejectionPr,
        });
      }
      const prior = await github.getPullRequest(claim.supersededRejectionPr);
      const admission = await github.getPullRequest(admissionPr);
      if (prior.state !== 'closed' || prior.merged || prior.merged_at || admission.state !== 'closed' || admission.merged || admission.merged_at) {
        throw new Stage3WorkerError('superseded Stage 3 PRs are not in the expected closed, unmerged state', {
          ...claim, claimCreated: true, prNumber: claim.supersededRejectionPr,
        });
      }
      const priorStatus = await verifySupersededRejection({
        github, git, rejection: prior, admission, batchId: claim.batchId, attempt: claim.attempt,
        claimRef: claim.claimRef, reviewManifest: manifest,
      });
      if (priorStatus.rejectionCode !== rejectionCode) {
        throw new Stage3WorkerError(`closed status PR #${prior.number} records ${priorStatus.rejectionCode}; retry produced ${rejectionCode}`, {
          ...claim, claimCreated: true, prNumber: prior.number,
        });
      }
      if (!same(JSON.parse(git.show(`origin/${branchName}`, manifestPath)), rejected)) {
        throw new Stage3WorkerError(`closed status PR #${prior.number} does not match the retry's exact rejection state`, {
          ...claim, claimCreated: true, prNumber: prior.number,
        });
      }
      const reopened = await github.reopenPullRequest(prior.number);
      if (reopened?.state !== 'open' || reopened?.head?.ref !== branchName) {
        throw new Stage3WorkerError(`GitHub did not reopen the unchanged status PR #${prior.number}`, {
          ...claim, claimCreated: true, prNumber: prior.number,
        });
      }
      log(`Reopened unchanged status PR #${prior.number} for ${claim.batchId}-a${claim.attempt}.`);
      return { ...claim, admissionPr, branchName, prNumber: prior.number, prUrl: prior.html_url, prState: 'rejection-status' };
    }
    git.createBranch(branchName, baseSha);
    await writeFile(absolute, JSON.stringify(rejected, null, 2) + '\n', 'utf8');
    await git.commitAndPush({ branchName, message: `[Stage 3] Reject ${claim.batchId} attempt ${claim.attempt}`, files: [manifestPath] });
    const pullRequest = await github.createPullRequest({
      title: `[Stage 3] Return ${claim.batchId} attempt ${claim.attempt} to Stage 2`,
      body: [
        `Status-only rejection for ${claim.batchId} attempt ${claim.attempt}.`,
        `Claim ref: ${claim.claimRef}`,
        `Closed admission draft: #${admissionPr}`,
        `Stage 3 rejection code: ${rejectionCode ?? 'STAGE3_LEXICAL_BLOCK'}.`,
        'This PR changes only the review manifest to rejected and records the closed admission PR number.',
      ].join('\n'),
      head: branchName, base: MASTER, draft: false,
    });
    if (!Number.isInteger(pullRequest?.number)) throw new Stage3WorkerError('GitHub did not return the rejection status PR number', { ...claim, claimCreated: true });
    log(JSON.stringify({ batchId: claim.batchId, attempt: claim.attempt, admissionPr, rejectionPr: pullRequest.number, branchName }));
    return { ...claim, admissionPr, branchName, prNumber: pullRequest.number, prUrl: pullRequest.html_url, prState: 'rejection-status' };
  } catch (error) {
    if (error instanceof Stage3WorkerError && error.claimCreated) throw error;
    throw new Stage3WorkerError(`closed admission PR #${admissionPr}; preserve claim ${claim.claimRef} and recover the rejection status PR: ${error.message}`, {
      ...claim, claimCreated: true, prNumber: admissionPr,
    });
  }
}

export async function processStage3Attempt({
  github, git, root, claim, runGates = true, log = () => {},
  prepare = preflightStage3Admission, apply = applyStage3Admission, validate = validatePreparedStage3Admission,
} = {}) {
  assertStage3ContractCurrent(claim);
  const draftPr = await github.getPullRequest(claim.prNumber);
  if (draftPr.state !== 'open' || draftPr.draft !== true || draftPr.base?.ref !== MASTER || draftPr.head?.ref !== claim.branchName) {
    throw new Stage3WorkerError('Stage 3 must preflight the actual open draft PR for this claim', { ...claim, claimCreated: true, prNumber: claim.prNumber });
  }
  let prepared;
  try {
    await git.fetchMaster();
    const localMaster = git.resolveRef('origin/master');
    const remoteMaster = await github.getBranchHead(MASTER);
    if (localMaster !== remoteMaster) throw new Stage3WorkerError('local origin/master does not match GitHub master before preflight', { ...claim, claimCreated: true });
    const branchBaseSha = git.branchBaseSha?.() ?? claim.baseSha;
    if (localMaster !== branchBaseSha) {
      git.rebaseOnMaster();
      await git.pushRebasedBranch(claim.branchName);
      claim.baseSha = localMaster;
      log(`Rebased ${claim.batchId}-a${claim.attempt} to latest master ${localMaster}.`);
    }
    const reviewManifestPath = path.join(root, 'data/reviews', claim.batchId, 'manifest.json');
    const currentReview = JSON.parse(await readFile(reviewManifestPath, 'utf8'));
    if (currentReview.status === 'complete') {
      const marker = path.join(root, MARKER_NAME(claim.batchId, claim.attempt));
      if (currentReview.attempt !== claim.attempt || currentReview.admission?.admission_pr !== claim.prNumber
        || await readFile(marker, 'utf8').then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error))) {
        throw new Stage3WorkerError('interrupted Stage 3 branch has an incomplete or mismatched admission result; preserving its Draft PR', {
          ...claim, claimCreated: true, prNumber: claim.prNumber,
        });
      }
      const localCheckpoint = draftPr.head?.sha && git.resolveRef('HEAD') !== draftPr.head.sha;
      if (localCheckpoint && !git.isAncestor?.(draftPr.head.sha, 'HEAD')) {
        throw new Stage3WorkerError('local recovery branch does not match the exact open Draft PR head', {
          ...claim, claimCreated: true, prNumber: claim.prNumber,
        });
      }
      prepared = { plan: null, recoveredCompleteAdmission: true };
      await validate({ root, git, claim, prepared, runGates });
      if (localCheckpoint) await git.pushPrepared(claim.branchName);
      const pullRequest = await github.markPullRequestReady(claim.prNumber);
      log(`Recovered the completed Stage 3 admission on PR #${claim.prNumber} for ${claim.batchId}.`);
      return { ...claim, prNumber: claim.prNumber, prState: 'admission', pullRequest, prepared };
    }
    prepared = await prepare({ root, git, claim, admissionPr: claim.prNumber });
    const applied = await apply({ root, git, claim, prepared });
    // Pin the prospective revision locally so the strict builder sees a clean, reproducible tree.
    // Failed gates preserve this local checkpoint and the remote metadata-only Draft.
    await git.commitPrepared({ message: `[Stage 3] Admit ${claim.batchId} attempt ${claim.attempt}`, files: applied.files });
    await validate({ root, git, claim, prepared: applied, runGates });
    await git.pushPrepared(claim.branchName);
    const pullRequest = await github.markPullRequestReady(claim.prNumber);
    log(`Stage 3 admission PR #${claim.prNumber} for ${claim.batchId} is ready for review.`);
    return { ...claim, prNumber: claim.prNumber, prState: 'admission', pullRequest, prepared: applied };
  } catch (error) {
    if (!(error instanceof Stage3AdmissionError) || error.category !== 'lexical') throw error;
    await github.updatePullRequestBody(claim.prNumber, recordLexicalRejection(draftPr, error, claim));
    await github.closePullRequest(claim.prNumber);
    await git.deleteBranch?.(claim.branchName);
    await git.deleteLocalBranch?.(claim.branchName);
    return createRejectionStatusPullRequest({
      github, git, root, claim, admissionPr: claim.prNumber,
      rejectionCode: error.code ?? 'STAGE3_LEXICAL_BLOCK', log,
    });
  }
}

export async function recoverStage3Attempt({ github, git, agent = 'codex', batchId, attempt, log = () => {} } = {}) {
  const claimRef = claimRefFor(batchId, attempt);
  const [claimRefs, activeLock, allPulls] = await Promise.all([
    github.listStage3ClaimRefs(), github.getStage3ActiveLock(), github.listPullRequests('all'),
  ]);
  const hasClaim = claimRefs.some((ref) => (typeof ref === 'string' ? ref : ref.ref) === claimRef);
  if (!activeLock || activeLock.batchId !== batchId || activeLock.attempt !== attempt) {
    throw new Stage3WorkerError(`${claimRef} does not own the global Stage 3 lock; preserve all refs for owner-directed recovery`, { batchId, attempt, claimCreated: hasClaim });
  }
  const otherClaims = claimRefs.filter((ref) => {
    const name = (typeof ref === 'string' ? ref : ref.ref) || '';
    return name.startsWith(CLAIM_PREFIX) && name !== claimRef;
  });
  if (otherClaims.length) throw new Stage3WorkerError(`${claimRef} owns the global lock but other Stage 3 claim refs exist; preserve the ambiguity`, { batchId, attempt, claimCreated: true });
  if (!hasClaim) log(`${claimRef} is missing while its global lock remains; recovery will recreate the claim under that lock.`);
  const allStage3Pulls = allPulls.filter(isStage3PullRequest);
  const matches = allStage3Pulls.filter((pr) => (pr.body ?? '').includes(claimRef)
    || pr.head?.ref?.endsWith(`/stage3/${batchId}-a${attempt}`)
    || pr.head?.ref?.endsWith(`/stage3-status/${batchId}-a${attempt}`));
  const foreignOpen = allStage3Pulls.find((pr) => pr.state === 'open' && !matches.includes(pr));
  if (foreignOpen) throw new Stage3WorkerError(`${claimRef} owns the global lock while unrelated Stage 3 PR #${foreignOpen.number} is also open; preserve both attempts`, { batchId, attempt, claimCreated: true, prNumber: foreignOpen.number });
  const admission = matches.find((pr) => pr.head?.ref?.endsWith(`/stage3/${batchId}-a${attempt}`));
  const rejection = matches.find((pr) => pr.head?.ref?.endsWith(`/stage3-status/${batchId}-a${attempt}`));
  if (matches.filter((pr) => pr.state === 'open').length > 1) throw new Stage3WorkerError(`${claimRef} has multiple open PRs; owner-directed recovery must resolve the ambiguity`, { batchId, attempt, claimCreated: true });
  if (admission?.state === 'open') {
    if (rejection?.state === 'open') throw new Stage3WorkerError(`${claimRef} has both an admission and rejection PR open`, { batchId, attempt, claimCreated: true });
    return { status: 'resume-admission', batchId, attempt, claimRef, activeLock, claimMissing: !hasClaim, branchName: admission.head.ref,
      baseSha: admission.base?.sha || activeLock.baseSha, prNumber: admission.number, draft: admission.draft === true, prState: 'admission' };
  }
  if (rejection?.state === 'open') return {
    status: 'await-rejection', batchId, attempt, claimRef, activeLock, claimMissing: !hasClaim, branchName: rejection.head.ref,
    prNumber: rejection.number, admissionPr: admission?.number, prState: 'rejection-status',
  };
  if (rejection && !(rejection.merged || rejection.merged_at) && rejection.state === 'closed') {
    throw new Stage3WorkerError(`${claimRef} rejection status PR #${rejection.number} is closed without merging; preserve the claim for owner-directed recovery`, { batchId, attempt, claimCreated: true, prNumber: rejection.number });
  }
  if (admission && !(admission.merged || admission.merged_at) && admission.state === 'closed' && !rejection) {
    if (!/^Stage 3 disposition: lexical-rejection \([A-Z0-9_]+\)\.$/mu.test(admission.body ?? '')) {
      throw new Stage3WorkerError(`${claimRef} admission PR #${admission.number} is closed without a recorded lexical-rejection disposition; preserve it for owner review`, {
        batchId, attempt, claimCreated: true, prNumber: admission.number,
      });
    }
    const rejectionCode = stage3RejectionCode(admission.body);
    if (!rejectionCode) throw new Stage3WorkerError(`${claimRef} closed admission PR #${admission.number} has ambiguous lexical-rejection codes; preserve it for owner recovery`, {
      batchId, attempt, claimCreated: true, prNumber: admission.number,
    });
    return {
      status: 'create-rejection', batchId, attempt, claimRef, agent, activeLock, claimMissing: !hasClaim,
      rejectionBranchName: rejectionBranchName(agent, batchId, attempt), admissionPr: admission.number, rejectionCode,
    };
  }
  if (admission?.merged || admission?.merged_at) return { status: 'admission-merged', batchId, attempt, claimRef, activeLock, claimMissing: !hasClaim, branchName: admission.head.ref, prNumber: admission.number, prState: 'admission' };
  if (rejection?.merged || rejection?.merged_at) return {
    status: 'rejection-merged', batchId, attempt, claimRef, activeLock, claimMissing: !hasClaim, branchName: rejection.head.ref,
    prNumber: rejection.number, admissionPr: admission?.number, prState: 'rejection-status',
  };
  const branchName = branchNameFor(agent, batchId, attempt);
  if (typeof git.remoteBranchExists === 'function' && await git.remoteBranchExists(branchName)) {
    return { status: 'restore-draft', batchId, attempt, claimRef, activeLock, claimMissing: !hasClaim, baseSha: activeLock.baseSha, branchName, prNumber: null, prState: 'starter' };
  }
  return { status: 'restore-starter', batchId, attempt, claimRef, activeLock, claimMissing: !hasClaim, baseSha: activeLock.baseSha, branchName, prNumber: null, prState: 'starter' };
}

export async function releaseStage3Claim({ github, git, claim, pullRequest, outcome, loadSnapshot = loadFactorySnapshot } = {}) {
  const pr = await github.getPullRequest(pullRequest.number ?? claim.prNumber);
  if (!pr.merged && !pr.merged_at) return false;
  if (pr.base?.ref !== MASTER || pr.head?.ref !== claim.branchName) {
    throw new Stage3WorkerError('merged Stage 3 PR does not match the claimed branch and master base', { ...claim, claimCreated: true });
  }
  await git.fetchMaster();
  const masterSha = await github.getBranchHead(MASTER);
  if (git.resolveRef('origin/master') !== masterSha) throw new Stage3WorkerError('local origin/master is stale after Stage 3 PR merge; preserving claim', { ...claim, claimCreated: true });
  const snapshot = await loadSnapshot({ git, headSha: masterSha });
  const review = snapshot.reviews.find((entry) => entry.batchId === claim.batchId);
  if (!review) throw new Stage3WorkerError('merged Stage 3 result is absent from master; preserving claim', { ...claim, claimCreated: true });
  if (claim.prState === 'rejection-status' || outcome?.status === 'rejected') {
    if (review.manifest.status !== 'rejected' || review.manifest.rejected_pr !== claim.admissionPr || review.manifest.attempt !== claim.attempt) {
      throw new Stage3WorkerError('master does not contain the linked rejection status; preserving claim', { ...claim, claimCreated: true });
    }
  } else {
    if (review.manifest.status !== 'complete' || review.manifest.attempt !== claim.attempt
      || review.manifest.admission?.admission_pr !== pullRequest.number) {
      throw new Stage3WorkerError('master does not contain this merged canonical admission; preserving claim', { ...claim, claimCreated: true });
    }
  }
  const activeLock = await github.getStage3ActiveLock();
  if (!activeLock || activeLock.batchId !== claim.batchId || activeLock.attempt !== claim.attempt
    || (claim.activeLock?.sha && activeLock.sha !== claim.activeLock.sha)) {
    throw new Stage3WorkerError('the Stage 3 global lock no longer belongs to this merged attempt; preserving refs', { ...claim, claimCreated: true });
  }
  if (typeof git.remoteBranchExists === 'function' && await git.remoteBranchExists(claim.branchName)) {
    await git.deleteBranch?.(claim.branchName);
  }
  await git.deleteLocalBranch?.(claim.branchName);
  const claimRefExists = (await github.listStage3ClaimRefs()).some((ref) => (typeof ref === 'string' ? ref : ref.ref) === claim.claimRef);
  if (claimRefExists) await github.deleteStage3ClaimRef(claim.batchId, claim.attempt);
  if (!await github.deleteStage3ActiveLock(activeLock.sha)) {
    throw new Stage3WorkerError('Stage 3 result is merged, but the matching global lock could not be safely released', { ...claim, claimCreated: true });
  }
  return true;
}

export async function waitForStage3PullRequest({ github, prNumber, intervalMs = 300_000, onPending = async () => {}, sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)) } = {}) {
  while (true) {
    const snapshot = await github.getPullRequestSnapshot(prNumber);
    const pr = snapshot.pullRequest;
    if (pr.merged === true || pr.merged_at) return { status: 'merged', pullRequest: pr, snapshot };
    if (pr.state === 'closed') return { status: 'closed-unmerged', pullRequest: pr, snapshot };
    const decision = await onPending(snapshot);
    if (decision?.status) return { ...decision, pullRequest: pr, snapshot };
    await sleep(intervalMs);
  }
}

export async function runStage3Session({ claimNext, processClaim, waitForMerge, releaseClaim, report = () => {} } = {}) {
  const completed = [];
  while (true) {
    const claim = await claimNext();
    if (!claim) { report('No unclaimed ready Stage 3 reviews remain.'); return completed; }
    const attempt = claim.prState === 'draft' ? await processClaim(claim) : claim;
    const pullRequest = attempt;
    const outcome = await waitForMerge(attempt, pullRequest);
    if (outcome.status !== 'merged') {
      throw new Stage3WorkerError(`Stage 3 PR #${pullRequest.prNumber} ended as ${outcome.status}; stopping without claiming another review`, {
        batchId: claim.batchId, attempt: claim.attempt, claimCreated: true, prNumber: pullRequest.prNumber,
      });
    }
    const released = await releaseClaim(attempt, pullRequest, outcome);
    if (released !== true) throw new Stage3WorkerError(`Stage 3 PR #${pullRequest.prNumber} merged but its claim was not safely released`, { ...attempt, claimCreated: true });
    completed.push({ claim: attempt, pullRequest });
    report(`Resolved Stage 3 PR #${pullRequest.prNumber} for ${attempt.batchId}; claim released.`);
  }
}

export { MARKER_NAME, claimRefFor, branchNameFor, rejectionBranchName };
