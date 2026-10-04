import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { canonicalSnapshotDigest } from './stage1.mjs';
import { planStage3Admission, applyStage3FileChanges, Stage3AdmissionError } from './admission.mjs';
import { buildStage3SemanticAuthority } from './semantic-authority.mjs';
import { loadFactorySnapshot } from './stage2-worker.mjs';
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
    rebaseOnMaster() {
      gitRun(root, ['fetch', 'origin', 'master:refs/remotes/origin/master']);
      gitRun(root, ['rebase', 'origin/master']);
    },
    async refreshBranch(branchName) {
      gitRun(root, ['fetch', 'origin', branchName + ':refs/remotes/origin/' + branchName]);
      const current = gitRun(root, ['branch', '--show-current']);
      if (current !== branchName) gitRun(root, ['switch', branchName]);
      gitRun(root, ['reset', '--hard', 'refs/remotes/origin/' + branchName]);
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

export function eligibleStage3Batches(snapshot, claimRefs = [], openPullRequests = []) {
  if (!snapshot?.validated || !Array.isArray(snapshot.reviews) || !Array.isArray(snapshot.candidates)) {
    throw new Stage3WorkerError('validated latest-master factory snapshot is required');
  }
  const claimed = new Set(claimRefs.map((value) => typeof value === 'string' ? value : value.ref).filter(Boolean));
  const open = openPullRequests.map((value) => value.pullRequest ?? value);
  const candidatesById = new Map(snapshot.candidates.map((entry) => [entry.batchId, entry]));
  return snapshot.reviews.flatMap((review) => {
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
  await applyStage3FileChanges(plan, { root, reviewManifestPath });
  await writeFile(path.join(root, semanticAuthority.sourcePath), semanticAuthority.sourceText, 'utf8');
  const digest = await canonicalSnapshotDigest(root);
  plan.reviewManifest.admission.canonical_snapshot_digest = digest;
  await writeFile(reviewManifestPath, JSON.stringify(plan.reviewManifest, null, 2) + '\n', 'utf8');
  const marker = path.join(root, MARKER_NAME(claim.batchId, claim.attempt));
  await rm(marker, { force: true });
  return { ...prepared, semanticAuthority, plan, files: [...new Set([...plan.changes.map((change) => change.path), semanticAuthority.sourcePath, `data/reviews/${claim.batchId}/manifest.json`, MARKER_NAME(claim.batchId, claim.attempt)])] };
}

export function runStage3PreflightCi(root, run = execFileSync) {
  run('npm', ['run', 'ci:normal'], { cwd: root, stdio: 'inherit' });
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

function recordLexicalRejection(pr, error) {
  const marker = `Stage 3 disposition: lexical-rejection (${error.code ?? 'STAGE3_LEXICAL_BLOCK'}).`;
  const body = pr.body ?? '';
  return body.includes('Stage 3 disposition: lexical-rejection (')
    ? body
    : `${body}${body.endsWith('\n') || body.length === 0 ? '' : '\n'}\n${marker}`;
}

export async function createRejectionStatusPullRequest({ github, git, root, claim, admissionPr, log = () => {} } = {}) {
  const branchName = claim.rejectionBranchName ?? rejectionBranchName(claim.agent ?? 'codex', claim.batchId, claim.attempt);
  const manifestPath = `data/reviews/${claim.batchId}/manifest.json`;
  try {
    await git.fetchMaster();
    const baseSha = git.resolveRef('origin/master');
    git.createBranch(branchName, baseSha);
    const absolute = path.join(root, manifestPath);
    const manifest = JSON.parse(await readFile(absolute, 'utf8'));
    const rejected = statusManifestForRejection(manifest, admissionPr);
    await writeFile(absolute, JSON.stringify(rejected, null, 2) + '\n', 'utf8');
    await git.commitAndPush({ branchName, message: `[Stage 3] Reject ${claim.batchId} attempt ${claim.attempt}`, files: [manifestPath] });
    const pullRequest = await github.createPullRequest({
      title: `[Stage 3] Return ${claim.batchId} attempt ${claim.attempt} to Stage 2`,
      body: [
        `Status-only rejection for ${claim.batchId} attempt ${claim.attempt}.`,
        `Claim ref: ${claim.claimRef}`,
        `Closed admission draft: #${admissionPr}`,
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
      if (draftPr.head?.sha && git.resolveRef('HEAD') !== draftPr.head.sha) {
        throw new Stage3WorkerError('local recovery branch does not match the exact open Draft PR head', {
          ...claim, claimCreated: true, prNumber: claim.prNumber,
        });
      }
      prepared = { plan: null, recoveredCompleteAdmission: true };
      await validate({ root, git, claim, prepared, runGates });
      const pullRequest = await github.markPullRequestReady(claim.prNumber);
      log(`Recovered the completed Stage 3 admission on PR #${claim.prNumber} for ${claim.batchId}.`);
      return { ...claim, prNumber: claim.prNumber, prState: 'admission', pullRequest, prepared };
    }
    prepared = await prepare({ root, git, claim, admissionPr: claim.prNumber });
    const applied = await apply({ root, git, claim, prepared });
    await validate({ root, git, claim, prepared: applied, runGates });
    await git.commitAndPush({ branchName: claim.branchName, message: `[Stage 3] Admit ${claim.batchId} attempt ${claim.attempt}`, files: applied.files });
    const pullRequest = await github.markPullRequestReady(claim.prNumber);
    log(`Stage 3 admission PR #${claim.prNumber} for ${claim.batchId} is ready for review.`);
    return { ...claim, prNumber: claim.prNumber, prState: 'admission', pullRequest, prepared: applied };
  } catch (error) {
    if (!(error instanceof Stage3AdmissionError) || error.category !== 'lexical') throw error;
    await github.updatePullRequestBody(claim.prNumber, recordLexicalRejection(draftPr, error));
    await github.closePullRequest(claim.prNumber);
    await git.deleteBranch?.(claim.branchName);
    await git.deleteLocalBranch?.(claim.branchName);
    return createRejectionStatusPullRequest({ github, git, root, claim, admissionPr: claim.prNumber, log });
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
  if (rejection && !rejection.merged && rejection.state === 'closed') {
    throw new Stage3WorkerError(`${claimRef} rejection status PR #${rejection.number} is closed without merging; preserve the claim for owner-directed recovery`, { batchId, attempt, claimCreated: true, prNumber: rejection.number });
  }
  if (admission && !admission.merged && admission.state === 'closed' && !rejection) {
    if (!/^Stage 3 disposition: lexical-rejection \([A-Z0-9_]+\)\.$/mu.test(admission.body ?? '')) {
      throw new Stage3WorkerError(`${claimRef} admission PR #${admission.number} is closed without a recorded lexical-rejection disposition; preserve it for owner review`, {
        batchId, attempt, claimCreated: true, prNumber: admission.number,
      });
    }
    return {
      status: 'create-rejection', batchId, attempt, claimRef, agent, activeLock, claimMissing: !hasClaim,
      rejectionBranchName: rejectionBranchName(agent, batchId, attempt), admissionPr: admission.number,
    };
  }
  if (admission?.merged) return { status: 'admission-merged', batchId, attempt, claimRef, activeLock, claimMissing: !hasClaim, branchName: admission.head.ref, prNumber: admission.number, prState: 'admission' };
  if (rejection?.merged) return {
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
