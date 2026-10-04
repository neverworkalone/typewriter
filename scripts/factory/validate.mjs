import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  parseJsonl,
  validateCandidateBatch,
  validateDecisionRows,
  validateReviewManifest,
} from './contract.mjs';
import { validateDecisionHandoff } from './handoff.mjs';
import { buildCanonicalIndex } from './identity-adapter.mjs';
import { validateLinkedTransition } from './transitions.mjs';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
  for (const file of (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort()) {
    for (const line of (await readFile(path.join(directory, file), 'utf8')).split('\n')) {
      if (line) entries.push(JSON.parse(line));
    }
  }
  return entries;
}

// Validates every factory batch under data/candidates and data/reviews. With no
// batches (nothing produced yet) it passes. `baseManifests` (optional) maps
// `candidate|review:C…` → manifest on merged master and enables linked-transition checks.
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
    const reviewErrors = validateReviewManifest(manifest, {
      candidateManifest: candidate.manifest,
      decisionsText,
      semanticDecisionsText: await readOptional(path.join(directory, 'semantic-decisions.json')),
      handoffText: await readOptional(path.join(directory, 'intake-handoff.json')),
    });
    errors.push(...reviewErrors.map((error) => `${batch}: ${error}`));
    if (typeof decisionsText === 'string') {
      const decisions = parseJsonl(decisionsText, `${batch}/decisions.jsonl`, errors);
      const ids = parseJsonl(candidate.candidatesText ?? '', batch, []).map((row) => row.candidate_id);
      errors.push(...validateDecisionRows(decisions, ids).map((error) => `${batch}: ${error}`));
      // Sense-level compatibility is checked against canonical only while admission is pending.
      if (manifest.status === 'ready') errors.push(...validateDecisionHandoff(decisions, { canonicalIndex }).map((error) => `${batch}: ${error}`));
    }
    reviews.set(batch, manifest);
  }
  for (const [batch, { manifest }] of candidates) {
    const review = reviews.get(batch);
    if (manifest.status === 'complete' && !review) errors.push(`${batch}: candidate complete without a review manifest`);
    if (manifest.status === 'created' && review) errors.push(`${batch}: review exists but candidate is still created`);
    if (base) {
      const before = base.candidate?.[batch] ?? null;
      const reviewBefore = base.review?.[batch] ?? null;
      const changed = JSON.stringify(before) !== JSON.stringify(manifest)
        || JSON.stringify(reviewBefore) !== JSON.stringify(review ?? null);
      if (changed && review) {
        errors.push(...validateLinkedTransition({ candidateBefore: before, candidateAfter: manifest, reviewBefore, reviewAfter: review })
          .map((error) => `${batch}: ${error}`));
      }
    }
  }
  return errors;
}

// Reads manifests for each batch at a git ref (e.g. origin/master) for transition checks.
export function loadBaseManifests(ref, root = REPOSITORY_DIRECTORY) {
  const base = { candidate: {}, review: {} };
  const show = (file) => {
    try {
      return JSON.parse(execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
      return null;
    }
  };
  const list = (directory) => {
    try {
      return execFileSync('git', ['ls-tree', '--name-only', ref, `${directory}/`], { cwd: root, encoding: 'utf8' })
        .split('\n').filter(Boolean).map((entry) => path.basename(entry));
    } catch {
      return [];
    }
  };
  for (const batch of list('data/candidates')) base.candidate[batch] = show(`data/candidates/${batch}/manifest.json`);
  for (const batch of list('data/reviews')) base.review[batch] = show(`data/reviews/${batch}/manifest.json`);
  return base;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseRef = process.env.FACTORY_BASE_REF;
  const errors = await validateFactoryRepository({ base: baseRef ? loadBaseManifests(baseRef) : null });
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('Factory batch contracts valid.');
}
