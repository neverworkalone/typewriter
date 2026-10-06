import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { validateReviewArtifacts } from './artifacts.mjs';
import { canonicalRecordSha256, validateStage3AdmissionManifest } from './admission.mjs';
import {
  parseJsonl,
  sha256Hex,
  validateCandidateBatch,
  validateDecisionRows,
  validateReviewManifest,
} from './contract.mjs';
import { validateDecisionHandoff } from './handoff.mjs';
import { buildCanonicalIndex } from './identity-adapter.mjs';
import { isLemmaRow } from './lemma-contract.mjs';
import { validateLemmaDecision } from './lemma-decisions.mjs';
import { loadSearchFormSupport } from './search-form-support.mjs';
import { canonicalSnapshotDigest, usageKeyOfRow } from './stage1.mjs';
import { validateCandidateTransition, validateLinkedTransition } from './transitions.mjs';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_BASE_REF = 'origin/master';
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function readOptional(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}
// Tracked candidate artifacts are exactly the manifest and the candidate rows; anything else (a
// staging leftover, a raw-evidence copy, a note) is refused so it cannot reach Git.
const CANDIDATE_FILES = ['candidates.jsonl', 'manifest.json'];
async function candidateDirectoryFiles(directory) {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
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
  const currentCanonicalSnapshot = reviewBatches.length ? await canonicalSnapshotDigest(root) : null;
  const canonicalIndex = buildCanonicalIndex(canonicalEntries ?? (reviewBatches.length ? await loadCanonicalEntries(root) : []));
  const canonicalById = new Map((canonicalEntries ?? (reviewBatches.length ? await loadCanonicalEntries(root) : [])).map((record) => [record.id, record]));
  const candidates = new Map();
  for (const name of await candidateDirectoryFiles(path.join(root, 'data/candidates'))) {
    if (!candidateBatches.includes(name)) errors.push(`data/candidates/${name}: only batch directories are allowed`);
  }
  for (const batch of candidateBatches) {
    const files = await candidateDirectoryFiles(path.join(root, 'data/candidates', batch));
    if (JSON.stringify(files) !== JSON.stringify(CANDIDATE_FILES)) errors.push(`${batch}: candidate directory must hold exactly ${CANDIDATE_FILES.join(' and ')}, found ${files.join(', ') || 'nothing'}`);
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
  const seenUsages = new Map();
  const seenLemmas = new Map();
  for (const [batch, { candidatesText }] of [...candidates].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const row of parseJsonl(candidatesText ?? '', batch, [])) {
      if (seenIds.has(row.candidate_id)) errors.push(`${batch}: candidate_id ${row.candidate_id} is not unique across batches`);
      seenIds.add(row.candidate_id);
      if (isLemmaRow(row)) {
        // v2: a headword is produced once; a later batch may not repeat a lemma of any earlier batch.
        const earlier = seenLemmas.get(row.input);
        if (earlier && earlier.batch !== batch) errors.push(`${batch}: ${row.candidate_id} repeats lemma ${row.input} already in ${earlier.id}`);
        else if (!earlier) seenLemmas.set(row.input, { batch, id: row.candidate_id });
        continue;
      }
      const usage = usageKeyOfRow(row);
      if (seenUsages.has(usage)) errors.push(`${batch}: ${row.candidate_id} repeats the usage of ${seenUsages.get(usage)} (same lemma, POS and evidence reference)`);
      else seenUsages.set(usage, row.candidate_id);
      // Historical v1 lemmas count as produced headwords for later lemma-centered batches.
      if (!seenLemmas.has(row.input)) seenLemmas.set(row.input, { batch, id: row.candidate_id });
    }
  }
  const reviews = new Map();
  const reviewArtifacts = new Map();
  // The generated-surface projection is only built when a decision needs a canonical proof.
  let canonicalForSupport;
  const supportFor = async (decisions) => {
    if (!decisions.some((decision) => (decision.group_decisions ?? []).some((entry) => ['covered', 'search_coverage'].includes(entry?.disposition)))) return undefined;
    canonicalForSupport ??= canonicalEntries ?? await loadCanonicalEntries(root);
    return loadSearchFormSupport(canonicalForSupport);
  };
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
      if (manifest.status === 'complete') {
        errors.push(...validateStage3AdmissionManifest(manifest, decisions, canonicalById).map((error) => `${batch}: ${error}`));
      }
      // Stage 3 revalidates a stale ready review against current master only after its Draft exists.
      const canonicalMatchesReview = manifest.canonical_snapshot_digest === currentCanonicalSnapshot;
      if (manifest.status === 'ready' && canonicalMatchesReview) errors.push(...validateDecisionHandoff(decisions, { canonicalIndex }).map((error) => `${batch}: ${error}`));
      if (candidateRows.some(isLemmaRow)) {
        // Canonical proofs (covered / search_coverage) are bound only while admission is pending.
        const proofs = manifest.status === 'ready' && canonicalMatchesReview ? { canonicalIndex, support: await supportFor(decisions) } : {};
        const rowById = new Map(candidateRows.map((row) => [row.candidate_id, row]));
        for (const decision of decisions) {
          const candidate = rowById.get(decision.source_candidate_id);
          if (candidate) errors.push(...validateLemmaDecision(decision, candidate, proofs).map((error) => `${batch}: ${error}`));
        }
      }
      if (typeof semanticDecisionsText === 'string' && typeof handoffText === 'string') {
        errors.push(...validateReviewArtifacts({
          batchId: batch, adapterId: candidate.manifest.source_adapter, candidates: candidateRows, decisions, semanticDecisionsText, handoffText,
        }).map((error) => `${batch}: ${error}`));
      }
    }
    reviews.set(batch, manifest);
    reviewArtifacts.set(batch, { manifest, decisionsText, decisions: typeof decisionsText === 'string' ? parseJsonl(decisionsText, `${batch}/decisions.jsonl`, []) : [] });
  }
  for (const [batch, { manifest }] of candidates) {
    const review = reviews.get(batch) ?? null;
    if (manifest.status === 'complete' && !review) errors.push(`${batch}: candidate complete without a review manifest`);
    if (manifest.status === 'created' && review) errors.push(`${batch}: review exists but candidate is still created`);
  }
  errors.push(...await validateStage3SemanticAuthorityLinks({ root, reviewArtifacts }));
  errors.push(...validateStage3RecordChanges(reviewArtifacts, canonicalById));
  errors.push(...validateStage3RelationMappings(reviewArtifacts, canonicalById));
  if (base) errors.push(...validateAgainstBase({ base, candidates, reviews }));
  return errors;
}

async function validateStage3SemanticAuthorityLinks({ root, reviewArtifacts }) {
  const complete = [...reviewArtifacts].filter(([, { manifest }]) => manifest.status === 'complete');
  if (complete.length === 0) return [];
  const sourceText = await readOptional(path.join(root, 'data/validation/canonical-semantic-decision-source.json'));
  if (sourceText === undefined) return ['complete Stage 3 admissions require the complete canonical semantic decision source'];
  let source;
  try { source = JSON.parse(sourceText); }
  catch { return ['complete canonical semantic decision source is invalid JSON']; }
  const events = new Map((source.factory_admissions ?? []).map((event) => [`${event.batch_id}-a${event.attempt}`, event]));
  const errors = [];
  for (const [batch, { manifest }] of complete) {
    const at = `${batch}:`;
    const authority = manifest.admission?.semantic_authority;
    if (authority?.path !== 'data/validation/canonical-semantic-decision-source.json'
      || authority.source_id !== source.source_id || !/^[0-9a-f]{64}$/u.test(authority.admission_sha256 ?? '')) {
      errors.push(`${at} complete admission must point to its immutable semantic authority event`);
      continue;
    }
    const event = events.get(`${batch}-a${manifest.attempt}`);
    if (!event) { errors.push(`${at} semantic authority event is missing`); continue; }
    const eventWithoutDigest = { ...event };
    delete eventWithoutDigest.sha256;
    if (event.sha256 !== authority.admission_sha256 || event.sha256 !== sha256Hex(JSON.stringify(eventWithoutDigest))) {
      errors.push(`${at} semantic authority event digest does not bind its content`);
    }
    if (event.semantic_decisions_sha256 !== manifest.semantic_decisions_sha256
      || !same(event.entries, manifest.admission.entries)) {
      errors.push(`${at} semantic authority event does not match the reviewed Stage 2 source and admission map`);
    }
    const eventChanges = (event.changes ?? []).map(({ entry_id, operation, path: changePath, source_candidate_ids, added_sense_ids, before_sha256, after_sha256 }) => ({
      entry_id, operation, path: changePath, source_candidate_ids, added_sense_ids, before_sha256, after_sha256,
    }));
    if (!same(eventChanges, manifest.admission.changes)) errors.push(`${at} semantic authority event does not match the canonical change set`);
  }
  return errors;
}

function validateStage3RecordChanges(reviewArtifacts, canonicalById) {
  const changesByRecord = new Map();
  for (const { manifest, decisions } of reviewArtifacts.values()) {
    if (manifest.status !== 'complete' || !Array.isArray(manifest.admission?.changes)) continue;
    const decisionById = new Map(decisions.map((row) => [row.source_candidate_id, row]));
    for (const change of manifest.admission.changes) {
      const list = changesByRecord.get(change.entry_id) ?? [];
      list.push({ ...change, batchId: manifest.batch_id, decisionById });
      changesByRecord.set(change.entry_id, list);
    }
  }
  const errors = [];
  for (const [entryId, changes] of changesByRecord) {
    const canonical = canonicalById.get(entryId);
    if (!canonical) continue;
    const changesBySense = new Map();
    for (const change of changes) {
      for (const senseId of change.added_sense_ids ?? []) {
        if (changesBySense.has(senseId)) errors.push(`${entryId}: Stage 3 admission repeats added sense ${senseId}`);
        changesBySense.set(senseId, change);
      }
    }
    const canonicalSenseIds = new Set(canonical.senses.map((sense) => sense.id));
    for (const senseId of changesBySense.keys()) if (!canonicalSenseIds.has(senseId)) errors.push(`${entryId}: admitted sense ${senseId} is absent from canonical data`);
    const untracked = canonical.senses.filter((sense) => changesBySense.has(sense.id));
    if (untracked.length !== changesBySense.size) continue;
    let projected = { ...canonical, senses: canonical.senses.filter((sense) => !changesBySense.has(sense.id)) };
    const create = changes.find((change) => change.operation === 'create');
    const ordered = [...changes].sort((left, right) => {
      const l = Math.min(...(left.added_sense_ids ?? []).map((id) => Number(id.match(/-s(\d+)$/u)?.[1] ?? 0)));
      const r = Math.min(...(right.added_sense_ids ?? []).map((id) => Number(id.match(/-s(\d+)$/u)?.[1] ?? 0)));
      return l - r || left.batchId.localeCompare(right.batchId);
    });
    if (create) {
      if (changes.filter((change) => change.operation === 'create').length !== 1) errors.push(`${entryId}: canonical record has more than one Stage 3 create operation`);
      const createSenses = new Set(create.added_sense_ids);
      const baseSenses = canonical.senses.filter((sense) => !changesBySense.has(sense.id));
      const initialSenses = canonical.senses.filter((sense) => createSenses.has(sense.id));
      projected = { ...canonical, senses: initialSenses };
      if (baseSenses.length) errors.push(`${entryId}: created factory entry contains untracked canonical senses`);
      const createRecord = { ...canonical, senses: initialSenses };
      if (canonicalRecordSha256(createRecord) !== create.after_sha256) errors.push(`${entryId}: Stage 3 create digest does not match its canonical record`);
      const rest = ordered.filter((change) => change !== create);
      for (const change of rest) {
        if (canonicalRecordSha256(projected) !== change.before_sha256) errors.push(`${entryId}: amendment ${change.batchId} before digest does not follow prior Stage 3 history`);
        const ids = new Set(change.added_sense_ids);
        projected = { ...projected, senses: [...projected.senses, ...canonical.senses.filter((sense) => ids.has(sense.id))] };
        if (canonicalRecordSha256(projected) !== change.after_sha256) errors.push(`${entryId}: amendment ${change.batchId} after digest does not match its canonical senses`);
      }
    } else {
      for (const change of ordered) {
        if (canonicalRecordSha256(projected) !== change.before_sha256) errors.push(`${entryId}: amendment ${change.batchId} before digest does not follow prior Stage 3 history`);
        const ids = new Set(change.added_sense_ids);
        const additions = canonical.senses.filter((sense) => ids.has(sense.id));
        if (additions.length !== ids.size) errors.push(`${entryId}: amendment ${change.batchId} does not add every declared sense`);
        projected = { ...projected, senses: [...projected.senses, ...additions] };
        if (canonicalRecordSha256(projected) !== change.after_sha256) errors.push(`${entryId}: amendment ${change.batchId} after digest does not match its canonical senses`);
      }
    }
    if (JSON.stringify(projected) !== JSON.stringify(canonical)) errors.push(`${entryId}: canonical record contains changes outside source-bound Stage 3 admissions`);
  }
  return errors;
}

function validateStage3RelationMappings(reviewArtifacts, canonicalById) {
  const errors = [];
  const mappings = new Map();
  const aliases = new Map();
  for (const { manifest, decisions } of reviewArtifacts.values()) {
    if (manifest.status !== 'complete') continue;
    const bySource = new Map((manifest.admission?.entries ?? []).map((entry) => [entry.source_candidate_id, entry]));
    for (const row of decisions) {
      const mapping = bySource.get(row.source_candidate_id);
      if (!mapping) continue;
      mappings.set(row.source_candidate_id, mapping);
      if (row.provisional_ref) aliases.set(row.provisional_ref, mapping);
    }
  }
  for (const { manifest, decisions } of reviewArtifacts.values()) {
    if (manifest.status !== 'complete') continue;
    const bySource = new Map((manifest.admission?.entries ?? []).map((entry) => [entry.source_candidate_id, entry]));
    for (const row of decisions) {
      const mapping = bySource.get(row.source_candidate_id);
      if (!mapping) continue;
      const canonical = canonicalById.get(mapping.record_id);
      if (!canonical) continue;
      for (const [index, reviewed] of row.reviewed_record.senses.entries()) {
        const actual = canonical.senses.find((sense) => sense.id === mapping.sense_ids[index]);
        if (!actual) continue;
        const expectedRelations = (reviewed.relations ?? []).map((relation) => {
          const targetMapping = mappings.get(relation.target) ?? aliases.get(relation.target);
          const target = targetMapping?.record_id ?? relation.target;
          const senseKey = relation.target_sense?.replace(/-s\d+$/u, '');
          const senseMapping = mappings.get(senseKey) ?? aliases.get(senseKey);
          const targetSense = senseMapping?.sense_ids?.[Number(relation.target_sense?.match(/-s(\d+)$/u)?.[1] ?? 1) - 1] ?? relation.target_sense;
          return { ...relation, target, ...(relation.target_sense === undefined ? {} : { target_sense: targetSense }) };
        });
        if (JSON.stringify(actual.relations ?? []) !== JSON.stringify(expectedRelations)) {
          errors.push(`${row.source_candidate_id}: canonical relations do not match the source-bound reviewed relations after reference remapping`);
        }
      }
    }
  }
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

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const git = (args, root) => execFileSync('git', args, {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: MAX_GIT_OUTPUT_BYTES,
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim();

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
