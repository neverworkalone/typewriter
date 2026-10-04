import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { validateReviewArtifacts } from './artifacts.mjs';
import {
  parseJsonl,
  validateCandidateBatch,
  validateDecisionRows,
  validateReviewManifest,
} from './contract.mjs';
import { validateDecisionHandoff } from './handoff.mjs';
import { buildCanonicalIndex } from './identity-adapter.mjs';
import { validateCandidateTransition, validateLinkedTransition } from './transitions.mjs';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_BASE_REF = 'origin/master';

async function readOptional(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}
const subdirectories = async (directory) => {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

export async function loadCanonicalEntries(root) {
  const directory = path.join(root, 'data/canonical');
  const entries = [];
  let names;
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return entries;
    throw error;
  }
  for (const file of names) {
    for (const line of (await readFile(path.join(directory, file), 'utf8')).split('\n')) {
      if (line) entries.push(JSON.parse(line));
    }
  }
  return entries;
}

// Validates every factory batch under data/candidates and data/reviews. `base` (manifests of
// the merge-base with merged master) enables transition, immutability and deletion checks;
// the CLI always supplies it and fails closed when the base cannot be resolved.
export async function validateFactoryRepository({ root = REPOSITORY_DIRECTORY, base = null, canonicalEntries } = {}) {
  const errors = [];
  const candidateBatches = await subdirectories(path.join(root, 'data/candidates'));
  const reviewBatches = await subdirectories(path.join(root, 'data/reviews'));
  const canonicalIndex = buildCanonicalIndex(canonicalEntries ?? (reviewBatches.length ? await loadCanonicalEntries(root) : []));
  const candidates = new Map();
  for (const batch of candidateBatches) {
    const directory = path.join(root, 'data/candidates', batch);
    const manifestText = await readOptional(path.join(directory, 'manifest.json'));
    if (manifestText === undefined) { errors.push(`${batch}: candidates manifest.json missing`); continue; }
    const manifest = JSON.parse(manifestText);
    if (manifest.batch_id !== batch) errors.push(`${batch}: batch_id ${manifest.batch_id} does not match its directory`);
    const candidatesText = await readOptional(path.join(directory, 'candidates.jsonl'));
    errors.push(...validateCandidateBatch({ manifest, candidatesText }).map((error) => `${batch}: ${error}`));
    candidates.set(batch, { manifest, candidatesText });
  }
  const seenIds = new Set();
  for (const [batch, { candidatesText }] of candidates) {
    for (const row of parseJsonl(candidatesText ?? '', batch, [])) {
      if (seenIds.has(row.candidate_id)) errors.push(`${batch}: candidate_id ${row.candidate_id} is not unique across batches`);
      seenIds.add(row.candidate_id);
    }
  }
  const reviews = new Map();
  for (const batch of reviewBatches) {
    const directory = path.join(root, 'data/reviews', batch);
    const manifestText = await readOptional(path.join(directory, 'manifest.json'));
    if (manifestText === undefined) { errors.push(`${batch}: review manifest.json missing`); continue; }
    const manifest = JSON.parse(manifestText);
    const candidate = candidates.get(batch);
    if (!candidate) { errors.push(`${batch}: review without a candidate batch`); continue; }
    const decisionsText = await readOptional(path.join(directory, 'decisions.jsonl'));
    const semanticDecisionsText = await readOptional(path.join(directory, 'semantic-decisions.json'));
    const handoffText = await readOptional(path.join(directory, 'intake-handoff.json'));
    errors.push(...validateReviewManifest(manifest, {
      candidateManifest: candidate.manifest, decisionsText, semanticDecisionsText, handoffText,
    }).map((error) => `${batch}: ${error}`));
    if (typeof decisionsText === 'string') {
      const decisions = parseJsonl(decisionsText, `${batch}/decisions.jsonl`, errors);
      const candidateRows = parseJsonl(candidate.candidatesText ?? '', batch, []);
      errors.push(...validateDecisionRows(decisions, candidateRows.map((row) => row.candidate_id)).map((error) => `${batch}: ${error}`));
      // Sense-level compatibility is checked against canonical only while admission is pending.
      if (manifest.status === 'ready') errors.push(...validateDecisionHandoff(decisions, { canonicalIndex }).map((error) => `${batch}: ${error}`));
      if (typeof semanticDecisionsText === 'string' && typeof handoffText === 'string') {
        errors.push(...validateReviewArtifacts({
          batchId: batch, adapterId: candidate.manifest.source_adapter, candidates: candidateRows, decisions, semanticDecisionsText, handoffText,
        }).map((error) => `${batch}: ${error}`));
      }
    }
    reviews.set(batch, manifest);
  }
  for (const [batch, { manifest }] of candidates) {
    const review = reviews.get(batch) ?? null;
    if (manifest.status === 'complete' && !review) errors.push(`${batch}: candidate complete without a review manifest`);
    if (manifest.status === 'created' && review) errors.push(`${batch}: review exists but candidate is still created`);
  }
  if (base) errors.push(...validateAgainstBase({ base, candidates, reviews }));
  return errors;
}

// Candidate transitions are checked independently of any review, and any batch present on the
// base but missing now (deleted) fails: merged manifests/evidence are immutable.
function validateAgainstBase({ base, candidates, reviews }) {
  const errors = [];
  for (const batch of Object.keys(base.candidate)) {
    if (!candidates.has(batch)) errors.push(`${batch}: merged candidate batch was deleted`);
  }
  for (const batch of Object.keys(base.review)) {
    if (!reviews.has(batch)) errors.push(`${batch}: merged review was deleted`);
  }
  for (const [batch, { manifest }] of candidates) {
    const candidateBefore = base.candidate[batch] ?? null;
    const review = reviews.get(batch) ?? null;
    const reviewBefore = base.review[batch] ?? null;
    const same = JSON.stringify(candidateBefore) === JSON.stringify(manifest)
      && JSON.stringify(reviewBefore) === JSON.stringify(review);
    if (same) continue;
    const found = review === null
      ? validateCandidateTransition(candidateBefore, manifest)
      : validateLinkedTransition({ candidateBefore, candidateAfter: manifest, reviewBefore, reviewAfter: review });
    errors.push(...found.map((error) => `${batch}: ${error}`));
  }
  return errors;
}

const git = (args, root) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// Manifests of the merge-base of `ref` and HEAD (the state this change builds on).
export function loadBaseManifests(ref, root = REPOSITORY_DIRECTORY) {
  const baseCommit = git(['merge-base', ref, 'HEAD'], root);
  const show = (file) => JSON.parse(git(['show', `${baseCommit}:${file}`], root));
  const list = (directory) => git(['ls-tree', '--name-only', baseCommit, `${directory}/`], root)
    .split('\n').filter(Boolean).map((entry) => path.basename(entry));
  const base = { candidate: {}, review: {}, commit: baseCommit };
  for (const batch of list('data/candidates')) base.candidate[batch] = show(`data/candidates/${batch}/manifest.json`);
  for (const batch of list('data/reviews')) base.review[batch] = show(`data/reviews/${batch}/manifest.json`);
  return base;
}

// `FACTORY_BASE_REF=none` is the only way to skip the comparison (explicit, never default).
export async function runCli({ root = process.env.FACTORY_ROOT ?? REPOSITORY_DIRECTORY, ref = process.env.FACTORY_BASE_REF ?? DEFAULT_BASE_REF } = {}) {
  let base = null;
  if (ref !== 'none') {
    try {
      base = loadBaseManifests(ref, root);
    } catch {
      return [`cannot resolve factory base ${ref} (fetch master, or set FACTORY_BASE_REF); refusing to skip transition checks`];
    }
  }
  return validateFactoryRepository({ root, base });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = await runCli();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('Factory batch contracts valid.');
}
