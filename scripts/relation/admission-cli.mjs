import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ADMISSION_TYPES,
  assertStage2SourceGloss,
  createReverseCandidateFormLookup,
  approvedPeersForSense,
  assertShard,
  batchScope,
  findGlossNamedDrops,
  loadAllApprovedDrops,
  orphanedCandidateDrops,
  candidateInventory,
  legacyCandidateFormsForRecord,
  loadApprovedRelations,
  loadOptionalDropJsonl,
  loadOptionalRelationJsonl,
  loadShard,
  mergeCandidates,
  normalizeCandidate,
  partScope,
  assertStage2Part,
  stage2PartSize,
  prepareShard,
  relationCandidateKeys,
  sameSpellingTargets,
  shardDropPath,
  shardRelationPath,
  ACTION_TARGET_POS,
  validateRelationRows,
  verifyAccounting,
  AdmissionVerifyError,
} from './admission.mjs';
import { parseCandidateJsonl } from './candidate-contract.mjs';
import { parseDropJsonl, parseRelationJsonl, serializeDropJsonl, serializeRelationJsonl } from './persisted-jsonl.mjs';

const USAGE = `usage:
  node scripts/relation/admission-cli.mjs prepare --shard 001 [--batch 01] [--out <file.json>] [--allow-partial]
  node scripts/relation/admission-cli.mjs prepare --shard 001 --batch 01 --part 01 [--checkpoint <file.json>] [--allow-partial]
  node scripts/relation/admission-cli.mjs read-chunk --checkpoint <file.json> [--max-candidates 250] [--source-sense-id <id> --candidate <text>] [--format json|compact] [--out <file>]
  node scripts/relation/admission-cli.mjs read-chunk --checkpoint <file.json> --optional [--format json|compact] [--page <n>] [--page-size <n>] [--out <file>]
  node scripts/relation/admission-cli.mjs plan-chunks --checkpoint <file.json> --target 250 --out <plan.json>
  node scripts/relation/admission-cli.mjs read-chunk --checkpoint <file.json> --task <plan.json> <task-id> --format compact --out <view>
  node scripts/relation/admission-cli.mjs save-chunk --checkpoint <file.json> --task <plan.json> <task-id> --in <decisions> --expect-view-sha256 <sha> [--supervisor-fallback]
  node scripts/relation/admission-cli.mjs close-plan --checkpoint <file.json> --plan <plan.json>
  node scripts/relation/admission-cli.mjs inspect --checkpoint <file.json> --source-sense-id <id>[,<id>...] [--candidate <text> | --select <file.json>] [--format json|compact] [--page <n>] [--page-size <n>] [--out <file>]
  node scripts/relation/admission-cli.mjs save-chunk --checkpoint <file.json> --in <decisions> [--format json|compact]
  node scripts/relation/admission-cli.mjs save-chunk --checkpoint <file.json> --in <decisions> --format compact --supervisor-fallback
  node scripts/relation/admission-cli.mjs save-optional --checkpoint <file.json> --in <decisions>
  node scripts/relation/admission-cli.mjs complete-optional --checkpoint <file.json>
  node scripts/relation/admission-cli.mjs cancel-revision --checkpoint <file.json> --chunk-id <exact>
  node scripts/relation/admission-cli.mjs merge --checkpoint <file.json>
  node scripts/relation/admission-cli.mjs prepare-merge --checkpoint <file.json> [--diff-from <sha> --diff-to <sha>] --json
  node scripts/relation/admission-cli.mjs amend --checkpoint <file.json> --in <decisions>
  node scripts/relation/admission-cli.mjs preflight --checkpoint <file.json> --json [--limit <n>] [--offset <n>]
  node scripts/relation/admission-cli.mjs repair --checkpoint <file.json> --in <repair.json> --json [--check]
  node scripts/relation/admission-cli.mjs reconcile --shard 001 [--batch 01 [--part 01]] --diff-from <sha> --diff-to <sha> [--dry-run] --json
  node scripts/relation/admission-cli.mjs affected-shards --from <sha> --to <sha> --json
  node scripts/relation/admission-cli.mjs affected-shards-batch --from-sha <sha>... --to <sha> --json
  node scripts/relation/admission-cli.mjs verify --shard 001 [--batch 01 [--part 01]] [--checkpoint <file.json>] [--allow-partial] [--relations-only --json] [--json]`;

const CHECKPOINT_VERSION = 1;
const SOURCE_MIRROR_TYPE_TIER_POLICY = 'source-mirror-v1';
const DEFAULT_CHUNK_CANDIDATES = 250;
const CHUNK_FORMATS = ['json', 'compact'];
const CHECKPOINT_DIRECTORY = '.warroom-scratch';
const INSPECT_PAGE_SIZE = 40;
const INSPECT_PAGE_MAX_BYTES = 36_000;
const INSPECT_PAGE_MAX_CHARS = 28_000;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysOf = (value) => Object.keys(value).sort().join(',');
const isTier = (value) => Number.isInteger(value) && value >= 1 && value <= 9;
const usesSourceMirrorTypeTier = (checkpoint) => checkpoint.type_tier_policy === SOURCE_MIRROR_TYPE_TIER_POLICY;

/** Deterministic completion of an input decision; `notes` collects `{field, rule}` for every value the CLI supplied. */
function normalizeInputDecision(checkpoint, decision, candidate = null, notes = null) {
  let current = decision;
  if (candidate !== null && isPlainObject(decision) && decision.disposition === 'relation'
      && !Object.hasOwn(decision, 'target_resolution') && !Object.hasOwn(decision, 'checked_target_sense_ids')
      && typeof decision.target_record_id === 'string' && typeof decision.target_sense_id === 'string'
      && (candidate.same_spelling_targets ?? []).some((target) => target.record_id === decision.target_record_id
        && target.senses.some((sense) => sense.sense_id === decision.target_sense_id))) {
    current = { ...decision, target_resolution: 'exact' };
    notes?.push({ field: 'target_resolution', rule: 'exact_target_resolution_completed' });
  }
  if (!usesSourceMirrorTypeTier(checkpoint) || current?.disposition !== 'relation' || current.target_resolution !== 'exact') return current;
  if (Object.hasOwn(current, 'reverse_type') || Object.hasOwn(current, 'reverse_relevance')) {
    throw new Error('new-policy exact ID decisions must omit reverse_type and reverse_relevance; the CLI derives both from type/relevance');
  }
  notes?.push({ field: 'reverse_type', rule: 'source_mirror_reverse_derived' });
  return { ...current, reverse_type: current.type, reverse_relevance: current.relevance };
}

function presentedDecision(checkpoint, decision) {
  if (!usesSourceMirrorTypeTier(checkpoint) || !isPlainObject(decision)
      || decision.disposition !== 'relation' || decision.target_resolution !== 'exact') return decision;
  const { reverse_type, reverse_relevance, ...sourceDecision } = decision;
  return sourceDecision;
}

function defaultCheckpointPath(shard, batch, part, root) {
  return path.join(root, CHECKPOINT_DIRECTORY, `relation-admission-${shard}-${batch}-${part}.json`);
}

function resolveRootPath(root, file) {
  return path.isAbsolute(file) ? file : path.resolve(root, file);
}

async function writeJsonAtomically(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`);
  await rename(temporary, file);
}

async function writeTextAtomically(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, file);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function readFileState(file) {
  try {
    const bytes = await readFile(file);
    return { exists: true, bytes, sha256: sha256(bytes) };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, bytes: Buffer.alloc(0), sha256: null };
    throw error;
  }
}

function sameFileState(left, right) {
  return left.exists === right.exists && left.bytes.equals(right.bytes);
}

async function writeFileStateAtomically(file, state) {
  if (!state.exists) {
    try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return;
  }
  await writeTextAtomically(file, state.bytes);
}

/**
 * Structured decision validation. Every independent check runs; checks that depend on an undecidable branch
 * (for example the exact/no_exact_match target checks when `target_resolution` itself is wrong) are `unevaluated`.
 */
function decisionProblems(item, candidate, decision, { allowSupervisorFailureDrop = false, pathPrefix = 'decision', storedDecision = false } = {}) {
  const problems = [];
  const unevaluated = [];
  const label = `${item.sense_id}/${candidate.text}`;
  const pathOf = (field) => (field ? `${pathPrefix}.${field}` : pathPrefix);
  const add = (field, condition, text) => problems.push({ field_path: pathOf(field), condition, message: `${label}: ${text}` });
  const skip = (field, condition) => unevaluated.push({ field_path: pathOf(field), condition });
  const keyCheck = (expectedKeys, text) => {
    const expected = expectedKeys.split(',');
    const actual = Object.keys(decision);
    for (const key of expected) if (!actual.includes(key)) add(key, 'required', text);
    for (const key of actual) if (!expected.includes(key)) add(key, 'forbidden', text);
  };
  const result = () => ({ problems, unevaluated });
  if (!isPlainObject(decision)) { add('', 'shape', 'decision must be an object'); return result(); }
  if (decision.source_sense_id !== item.sense_id) add('source_sense_id', 'enum', 'decision must retain the exact source sense and candidate');
  if (decision.candidate !== candidate.text) add('candidate', 'enum', 'decision must retain the exact source sense and candidate');
  if (candidate.already_accounted === true && decision.disposition !== 'relation') {
    add('disposition', 'enum', 'an optional additional link must target an unlinked same-spelling sense');
  } else if (candidate.already_accounted === true && decision.target_resolution !== 'exact') {
    add('target_resolution', Object.hasOwn(decision, 'target_resolution') ? 'enum' : 'required',
      'an optional additional link must target an unlinked same-spelling sense');
  }
  if (decision.disposition === 'drop') {
    keyCheck('candidate,disposition,reason,source_sense_id', 'Drop decision has unexpected or missing fields');
    if (typeof decision.reason !== 'string' || !decision.reason.trim()) add('reason', 'required', 'Drop needs a reason');
    else {
      const reason = decision.reason.trim();
      if (reason === 'z') add('reason', 'reserved_reason', 'Drop reason "z" is reserved for deterministic orphan reconciliation');
      else if (reason !== 'x' && reason !== 'e' && !(allowSupervisorFailureDrop && reason === 'f')) {
        add('reason', 'enum', 'new Stage 2 Drop reason must be "x" or "e"');
      }
    }
    return result();
  }
  if (decision.disposition !== 'relation') {
    add('disposition', 'enum', 'disposition must be relation or drop');
    skip('', 'branch');
    return result();
  }
  if (!ADMISSION_TYPES.includes(decision.type)) {
    add('type', Object.hasOwn(decision, 'type') ? 'enum' : 'required', `type must be one of ${ADMISSION_TYPES.join('/')}`);
  }
  if (!isTier(decision.relevance)) {
    add('relevance', Object.hasOwn(decision, 'relevance') ? 'range' : 'required', 'relevance must be an integer 1..9');
  }
  const availableTargetSenseIds = candidate.same_spelling_targets.flatMap((target) => target.senses.map((sense) => sense.sense_id)).sort();

  if (decision.target_resolution === 'exact') {
    keyCheck('candidate,disposition,relevance,reverse_relevance,reverse_type,source_sense_id,target_record_id,target_resolution,target_sense_id,type',
      'exact ID decision has unexpected or missing fields');
    const target = candidate.same_spelling_targets.find((record) => record.record_id === decision.target_record_id);
    if (!target || !target.senses.some((sense) => sense.sense_id === decision.target_sense_id)) {
      add('target_sense_id', 'not_supplied_target', 'exact target must be one of the supplied same-spelling senses');
    }
    // #5178: every new or changed decision is checked; an already stored one stays readable so it can be amended.
    const targetPos = target?.senses.find((sense) => sense.sense_id === decision.target_sense_id)?.pos;
    if (!storedDecision && decision.type === 'action' && targetPos !== undefined && !ACTION_TARGET_POS.includes(targetPos)) {
      add('type', 'action_target_pos', `action target ${decision.target_record_id}/${decision.target_sense_id} has pos ${targetPos}; expected ${ACTION_TARGET_POS.join(' or ')}`);
    }
    if (decision.target_record_id === item.record_id) add('target_record_id', 'forbidden', 'an ID relation cannot target its own record');
    if (candidate.already_accounted === true) {
      const usedTargetSenseIds = new Set([
        ...candidate.existing_target_sense_ids,
        ...(candidate.additional_relations ?? []).map((relation) => relation.target_sense_id),
      ]);
      if (!candidate.unlinked_target_sense_ids.includes(decision.target_sense_id)
          || usedTargetSenseIds.has(decision.target_sense_id)) {
        add('target_sense_id', 'not_supplied_target', 'optional link must choose a not-yet-linked target sense');
      }
    }
    if (!ADMISSION_TYPES.includes(decision.reverse_type)) {
      add('reverse_type', Object.hasOwn(decision, 'reverse_type') ? 'enum' : 'required', `reverse_type must be one of ${ADMISSION_TYPES.join('/')}`);
    }
    if (!isTier(decision.reverse_relevance)) {
      add('reverse_relevance', Object.hasOwn(decision, 'reverse_relevance') ? 'range' : 'required', 'reverse_relevance must be an integer 1..9');
    }
    return result();
  }

  if (availableTargetSenseIds.length === 0) {
    keyCheck('candidate,disposition,relevance,source_sense_id,type', 'omit target-resolution fields when no same-spelling target exists');
    return result();
  }
  if (decision.target_resolution !== 'no_exact_match') {
    add('target_resolution', Object.hasOwn(decision, 'target_resolution') ? 'enum' : 'required', 'target_resolution must be exact or no_exact_match');
    skip('target_sense_id', 'exact_branch');
    skip('checked_target_sense_ids', 'no_exact_match_branch');
    return result();
  }
  if (!Array.isArray(decision.checked_target_sense_ids) || decision.checked_target_sense_ids.some((id) => typeof id !== 'string')) {
    add('checked_target_sense_ids', Object.hasOwn(decision, 'checked_target_sense_ids') ? 'shape' : 'required',
      'text-only with same-spelling targets needs checked_target_sense_ids');
    skip('checked_target_sense_ids', 'checked_set_mismatch');
  } else {
    const checkedTargetSenseIds = [...decision.checked_target_sense_ids].sort();
    if (new Set(checkedTargetSenseIds).size !== checkedTargetSenseIds.length
        || JSON.stringify(checkedTargetSenseIds) !== JSON.stringify(availableTargetSenseIds)) {
      add('checked_target_sense_ids', 'checked_set_mismatch', 'check every same-spelling target sense exactly once');
    }
  }
  keyCheck('candidate,checked_target_sense_ids,disposition,relevance,source_sense_id,target_resolution,type',
    'text-only decision must explicitly omit target IDs and reverse fields');
  return result();
}

function validateDecision(item, candidate, decision, allowSupervisorFailureDrop = false, storedDecision = false) {
  const { problems } = decisionProblems(item, candidate, decision, { allowSupervisorFailureDrop, storedDecision });
  if (problems.length) throw new Error(problems[0].message);
}

function validateCheckpoint(checkpoint, identity = {}) {
  if (!isPlainObject(checkpoint) || checkpoint.version !== CHECKPOINT_VERSION) throw new Error('unsupported or malformed Stage 2 checkpoint');
  if (checkpoint.type_tier_policy !== undefined && checkpoint.type_tier_policy !== SOURCE_MIRROR_TYPE_TIER_POLICY) {
    throw new Error('checkpoint has an unsupported Type/Tier direction policy');
  }
  if (!/^\d{3}$/u.test(checkpoint.shard ?? '') || !['01', '02'].includes(checkpoint.batch) || typeof checkpoint.part !== 'string') {
    throw new Error('checkpoint must identify one shard, batch and Part');
  }
  // #3385: every checkpoint-reading command passes here, so the Shard's Part layout is enforced for all of them.
  assertStage2Part(checkpoint.shard, checkpoint.batch, checkpoint.part);
  const expectedPartSize = stage2PartSize(checkpoint.shard);
  if (checkpoint.part_size === undefined ? expectedPartSize !== 100 : checkpoint.part_size !== expectedPartSize) {
    throw new Error(`checkpoint part_size must be ${expectedPartSize} for shard ${checkpoint.shard}; re-prepare this Part`);
  }
  if (checkpoint.base_revision !== undefined && checkpoint.base_revision !== null
      && (typeof checkpoint.base_revision !== 'string' || !/^[a-f0-9]{40}$/u.test(checkpoint.base_revision))) {
    throw new Error('checkpoint base_revision must be a Git commit ID when present');
  }
  for (const key of ['shard', 'batch', 'part']) {
    if (identity[key] !== undefined && identity[key] !== checkpoint[key]) throw new Error(`checkpoint ${key} does not match this command`);
  }
  if (!Array.isArray(checkpoint.items) || !Number.isInteger(checkpoint.next_chunk_number) || checkpoint.next_chunk_number < 1) {
    throw new Error('checkpoint is missing its items or chunk cursor');
  }
  if (typeof checkpoint.complete !== 'boolean') throw new Error('checkpoint must record whether all Stage 1 inputs are complete');
  if (checkpoint.optional_review_complete !== undefined && typeof checkpoint.optional_review_complete !== 'boolean') {
    throw new Error('checkpoint optional_review_complete must be a boolean when present');
  }
  if (checkpoint.amend_revision !== undefined && (!Number.isInteger(checkpoint.amend_revision) || checkpoint.amend_revision < 0)) {
    throw new Error('checkpoint amend_revision must be a non-negative integer when present');
  }
  if (checkpoint.repair_receipts !== undefined && (!Array.isArray(checkpoint.repair_receipts) || checkpoint.repair_receipts.some((receipt) =>
    !isPlainObject(receipt) || keysOf(receipt) !== 'candidate_keys,fingerprint,request_id,supervisor_nonce'
      || !/^[a-f0-9]{64}$/u.test(receipt.request_id ?? '') || !/^[a-f0-9]{64}$/u.test(receipt.fingerprint ?? '')
      || !/^[a-f0-9]{64}$/u.test(receipt.supervisor_nonce ?? '')
      || !Array.isArray(receipt.candidate_keys) || receipt.candidate_keys.some((key) => typeof key !== 'string' || !key.includes('\u0000'))
      || new Set(receipt.candidate_keys).size !== receipt.candidate_keys.length
      || JSON.stringify(receipt.candidate_keys) !== JSON.stringify([...receipt.candidate_keys].sort())))) {
    throw new Error('checkpoint repair receipts are malformed');
  }
  const seen = new Set();
  const seenSenses = new Set();
  for (const item of checkpoint.items) {
    if (!isPlainObject(item) || !Array.isArray(item.candidates) || typeof item.sense_id !== 'string') throw new Error('checkpoint contains an invalid source sense');
    if (item.candidates.length > 0) assertStage2SourceGloss(item.sense_id, item.gloss, item.reference_gloss);
    if (seenSenses.has(item.sense_id)) throw new Error(`checkpoint repeats source sense ${item.sense_id}`);
    seenSenses.add(item.sense_id);
    let hasPending = false;
    for (const candidate of item.candidates) {
      if (!isPlainObject(candidate) || typeof candidate.text !== 'string' || !Array.isArray(candidate.same_spelling_targets)) throw new Error(`${item.sense_id}: checkpoint contains an invalid candidate`);
      if (candidate.already_accounted === true) {
        const availableIds = candidate.same_spelling_targets.flatMap((target) => target.senses.map((sense) => sense.sense_id)).sort();
        const coveredIds = candidate.existing_target_sense_ids;
        const unlinkedIds = candidate.unlinked_target_sense_ids;
        if (!Array.isArray(coveredIds) || !Array.isArray(unlinkedIds) || !Array.isArray(candidate.additional_relations)
            || candidate.decision?.disposition !== 'existing'
            || new Set([...coveredIds, ...unlinkedIds]).size !== coveredIds.length + unlinkedIds.length
            || JSON.stringify([...coveredIds, ...unlinkedIds].sort()) !== JSON.stringify(availableIds)) {
          throw new Error(`${item.sense_id}/${candidate.text}: checkpoint contains invalid existing-coverage context`);
        }
      } else if (candidate.already_accounted !== undefined || candidate.existing_target_sense_ids !== undefined
          || candidate.unlinked_target_sense_ids !== undefined || candidate.additional_relations !== undefined) {
        throw new Error(`${item.sense_id}/${candidate.text}: optional-link fields require existing ID coverage`);
      }
      const key = `${item.sense_id}\u0000${candidate.text}`;
      if (seen.has(key)) throw new Error(`checkpoint repeats ${item.sense_id}/${candidate.text}`);
      seen.add(key);
      if (candidate.decision === null) hasPending = true;
      else {
        if (hasPending) throw new Error(`${item.sense_id}: saved decisions must form a prefix so a large sense can resume exactly`);
      }
    }
  }
  if (checkpoint.pending_chunk !== null && !isPlainObject(checkpoint.pending_chunk)) throw new Error('checkpoint pending_chunk must be an object or null');
  if (checkpoint.pending_chunk) {
    const { pending_chunk: pending } = checkpoint;
    const revision = pending.revision === true;
    const expectedKeys = revision ? 'candidate_count,chunk_id,revision,slices' : 'candidate_count,chunk_id,slices';
    if (keysOf(pending) !== expectedKeys || !Array.isArray(pending.slices) || pending.slices.length === 0
        || pending.chunk_id !== `${checkpoint.shard}-${checkpoint.batch}-${checkpoint.part}-${String(checkpoint.next_chunk_number).padStart(3, '0')}`) {
      throw new Error('checkpoint contains an invalid pending chunk');
    }
    if (revision && checkpoint.merged) throw new Error('a merged checkpoint cannot have a revision chunk');
    const pendingSenses = new Set();
    let pendingCount = 0;
    for (const slice of pending.slices) {
      if (!isPlainObject(slice)) throw new Error('checkpoint contains a malformed pending slice');
      const item = checkpoint.items.find((entry) => entry.sense_id === slice.sense_id);
      const firstUndecided = item?.candidates.findIndex((candidate) => candidate.decision === null) ?? -1;
      if (!item || keysOf(slice) !== 'end,sense_id,start' || pendingSenses.has(slice.sense_id)
          || !Number.isInteger(slice.start) || !Number.isInteger(slice.end)
          || slice.start < 0 || slice.end > item.candidates.length
          || (revision
            ? slice.end !== slice.start + 1 || slice.end > item.candidates.length || item.candidates[slice.start]?.decision === null
            : slice.start !== firstUndecided || slice.end <= slice.start || slice.end > item.candidates.length)) {
        throw new Error(`checkpoint contains an invalid pending slice for ${slice.sense_id}`);
      }
      pendingSenses.add(slice.sense_id);
      pendingCount += slice.end - slice.start;
    }
    if (pendingCount !== pending.candidate_count) throw new Error('checkpoint pending chunk candidate count does not match its slices');
  }
  if (checkpoint.merged && (checkpoint.pending_chunk || checkpoint.items.some((item) => item.candidates.some((candidate) => candidate.decision === null)))) {
    throw new Error('checkpoint cannot be merged while decisions are missing');
  }
  if (checkpoint.premerge !== undefined) {
    const manifest = checkpoint.premerge;
    const fileMeta = (value) => isPlainObject(value) && typeof value.exists === 'boolean'
      && (value.exists ? typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256) : value.sha256 === null);
    if (!isPlainObject(manifest) || !['preparing', 'ready'].includes(manifest.status)
        || manifest.identity !== `${checkpoint.shard}/${checkpoint.batch}/${checkpoint.part}`
        || !fileMeta(manifest.relations) || !fileMeta(manifest.drops)
        || (manifest.relation_diff !== undefined && manifest.relation_diff !== null
          && (!isPlainObject(manifest.relation_diff)
            || Object.keys(manifest.relation_diff).sort().join(',') !== 'from,to'
            || ![manifest.relation_diff.from, manifest.relation_diff.to].every((sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/u.test(sha))))) {
      throw new Error('checkpoint contains invalid premerge snapshot metadata');
    }
  }
  if (checkpoint.optional_review_complete === true) assertOptionalComplete(checkpoint);
  return checkpoint;
}

function validateCheckpointDecisions(checkpoint) {
  for (const item of checkpoint.items) {
    for (const candidate of item.candidates) {
      if (candidate.decision === null) throw new Error(`${item.sense_id}/${candidate.text}: decision is missing`);
      if (candidate.already_accounted === true) {
        if (candidate.decision.disposition !== 'existing') throw new Error(`${item.sense_id}/${candidate.text}: existing coverage cannot be replaced by a required decision`);
        const seenTargets = new Set(candidate.existing_target_sense_ids);
        for (const [index, relation] of candidate.additional_relations.entries()) {
          validateDecision(item, { ...candidate, additional_relations: candidate.additional_relations.slice(0, index) }, relation, false, true);
          if (usesSourceMirrorTypeTier(checkpoint) && relation.target_resolution === 'exact'
              && (relation.reverse_type !== relation.type || relation.reverse_relevance !== relation.relevance)) {
            throw new Error(`${item.sense_id}/${candidate.text}: new-policy optional ID relations must mirror source type/relevance`);
          }
          if (seenTargets.has(relation.target_sense_id)) throw new Error(`${item.sense_id}/${candidate.text}: checkpoint repeats optional target sense ${relation.target_sense_id}`);
          seenTargets.add(relation.target_sense_id);
        }
      } else {
        validateDecision(item, candidate, candidate.decision,
          candidate.decision?.disposition === 'drop' && candidate.decision.reason === 'f', true);
        if (usesSourceMirrorTypeTier(checkpoint) && candidate.decision.target_resolution === 'exact'
            && (candidate.decision.reverse_type !== candidate.decision.type
              || candidate.decision.reverse_relevance !== candidate.decision.relevance)) {
          throw new Error(`${item.sense_id}/${candidate.text}: new-policy ID relations must mirror source type/relevance`);
        }
      }
    }
  }
}

async function readCheckpoint(file, identity = {}) {
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`cannot read checkpoint ${file}: ${error.message}`); }
  return validateCheckpoint(parsed, identity);
}

function decisionRows(checkpoint) {
  const relations = [];
  const relationCandidates = [];
  const drops = [];
  for (const item of checkpoint.items) {
    for (const candidate of item.candidates) {
      const decision = candidate.decision;
      const appendRelation = (relationDecision) => {
        if (relationDecision.target_resolution === 'exact') {
          relations.push({
            source_record_id: item.record_id,
            source_sense_id: item.sense_id,
            target_record_id: relationDecision.target_record_id,
            target_sense_id: relationDecision.target_sense_id,
            type: relationDecision.type,
            relevance: relationDecision.relevance,
            reverse_type: relationDecision.reverse_type,
            reverse_relevance: relationDecision.reverse_relevance,
            candidate_assignment_version: 1,
            candidate_forms: [candidate.text],
            reverse_candidate_forms: [],
          });
        } else {
          relations.push({
            source_record_id: item.record_id,
            source_sense_id: item.sense_id,
            text: candidate.text,
            type: relationDecision.type,
            relevance: relationDecision.relevance,
          });
        }
        relationCandidates.push(`${item.sense_id}\u0000${candidate.text}`);
      };
      if (candidate.already_accounted === true) {
        for (const relation of candidate.additional_relations) appendRelation(relation);
      } else if (decision.disposition === 'drop') {
        drops.push({ source_record_id: item.record_id, source_sense_id: item.sense_id, candidate: candidate.text, reason: decision.reason.trim() });
      } else {
        appendRelation(decision);
      }
    }
  }
  return { relations, relationCandidates, drops };
}

function stableRow(row) {
  return JSON.stringify(Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right))));
}

function gitText(args, root, { missing = false } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (result.error) throw new Error(`git ${args.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0) {
    if (missing && /exists on disk, but not in|does not exist in/u.test(result.stderr ?? '')) return '';
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 400)}`);
  }
  return result.stdout;
}

function assertRelationDiffRange(from, to, root) {
  if (![from, to].every((sha) => /^[a-f0-9]{40}$/u.test(sha ?? ''))) {
    throw new Error('Relation deletion comparison requires 40-character lowercase commit IDs');
  }
  gitText(['cat-file', '-e', `${from}^{commit}`], root);
  gitText(['cat-file', '-e', `${to}^{commit}`], root);
  gitText(['merge-base', '--is-ancestor', from, to], root);
}

function deletedIdRelationRowsBetween(from, to, root) {
  assertRelationDiffRange(from, to, root);
  return changedRelationRowsBetween(from, to, root).removed.filter((row) => !('text' in row));
}

function compareRelationRows(beforeText, afterText, beforeLabel, afterLabel) {
  const beforeRows = beforeText.trim() ? parseRelationJsonl(beforeText, beforeLabel) : [];
  const afterRows = afterText.trim() ? parseRelationJsonl(afterText, afterLabel) : [];
  const remaining = new Map();
  for (const row of afterRows) remaining.set(stableRow(row), (remaining.get(stableRow(row)) ?? 0) + 1);
  const removed = [];
  for (const row of beforeRows) {
    const key = stableRow(row);
    const count = remaining.get(key) ?? 0;
    if (count > 0) remaining.set(key, count - 1);
    else removed.push(row);
  }
  const beforeCounts = new Map();
  for (const row of beforeRows) beforeCounts.set(stableRow(row), (beforeCounts.get(stableRow(row)) ?? 0) + 1);
  const added = [];
  for (const row of afterRows) {
    const key = stableRow(row);
    const count = beforeCounts.get(key) ?? 0;
    if (count > 0) beforeCounts.set(key, count - 1);
    else added.push(row);
  }
  return { removed, added };
}

function changedRelationRowsBetween(from, to, root) {
  if (![from, to].every((sha) => /^[a-f0-9]{40}$/u.test(sha))) throw new Error('affected-shards requires 40-character lowercase commit IDs');
  const paths = gitText(['diff', '--name-only', '--no-renames', from, to], root).split(/\r?\n/u).filter(Boolean);
  const removed = [];
  const added = [];
  for (const file of paths.filter((item) => /^data\/relations\/relation-\d{3}\.jsonl$/u.test(item))) {
    const beforeText = gitText(['show', `${from}:${file}`], root, { missing: true });
    const afterText = gitText(['show', `${to}:${file}`], root, { missing: true });
    const diff = compareRelationRows(beforeText, afterText, `${from}:${file}`, `${to}:${file}`);
    removed.push(...diff.removed);
    added.push(...diff.added);
  }
  return { paths, removed, added, rows: [...removed, ...added] };
}

async function canonicalSenseShardIndex(root) {
  const canonicalDirectory = path.join(root, 'data/canonical');
  const names = (await readdir(canonicalDirectory)).filter((name) => /^stdict-\d{4}\.jsonl$/u.test(name)).sort();
  const senseShard = new Map();
  for (const name of names) {
    const match = /^stdict-(\d{4})\.jsonl$/u.exec(name);
    const shard = Number(match[1]);
    const file = path.join(canonicalDirectory, name);
    for (const record of parseCandidateJsonl(await readFile(file, 'utf8'), file)) {
      for (const sense of record.senses) senseShard.set(sense.id, String(shard).padStart(3, '0'));
    }
  }
  return senseShard;
}

async function affectedRelationShards(from, to, root) {
  const { rows } = changedRelationRowsBetween(from, to, root);
  const senseShard = await canonicalSenseShardIndex(root);
  const affected = new Set();
  for (const row of rows) {
    for (const senseId of ['source_sense_id', ...('text' in row ? [] : ['target_sense_id'])].map((key) => row[key])) {
      const shard = senseShard.get(senseId);
      if (!shard) throw new Error(`cannot map changed Relation sense ${senseId} to its Canonical shard`);
      affected.add(shard);
    }
  }
  return [...affected].sort();
}

async function affectedRelationShardsMany(fromShas, to, root) {
  const senseShard = await canonicalSenseShardIndex(root);
  const byFrom = [];
  for (const from of fromShas) {
    const { rows } = changedRelationRowsBetween(from, to, root);
    const affected = new Set();
    for (const row of rows) {
      for (const senseId of ['source_sense_id', ...('text' in row ? [] : ['target_sense_id'])].map((key) => row[key])) {
        const shard = senseShard.get(senseId);
        if (!shard) throw new Error(`cannot map changed Relation sense ${senseId} to its Canonical shard`);
        affected.add(shard);
      }
    }
    byFrom.push({ from, shards: [...affected].sort() });
  }
  return byFrom;
}

function currentGitHead(root) {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const value = result.status === 0 ? result.stdout.trim() : '';
  return /^[a-f0-9]{40}$/u.test(value) ? value : null;
}

function sameRows(left, right) {
  return left.length === right.length && left.every((row, index) => stableRow(row) === stableRow(right[index]));
}

function idPairKey(sourceSenseId, targetSenseId) {
  return `${sourceSenseId}\u0000${targetSenseId}`;
}

function isConsistentReciprocalIdRelation(left, right) {
  return !('text' in left) && !('text' in right)
    && left.source_record_id === right.target_record_id
    && left.source_sense_id === right.target_sense_id
    && left.target_record_id === right.source_record_id
    && left.target_sense_id === right.source_sense_id
    && left.type === right.reverse_type
    && left.relevance === right.reverse_relevance
    && left.reverse_type === right.type
    && left.reverse_relevance === right.relevance;
}

function coalesceOrthographicAliasRelations(checkpoint, relations, relationCandidates) {
  const checkpointCandidates = new Map();
  for (const item of checkpoint.items) for (const candidate of item.candidates) {
    checkpointCandidates.set(`${item.sense_id}\u0000${candidate.text}`, candidate);
  }

  const selectedRelations = [];
  const selectedCandidates = [];
  const relationIndexByPair = new Map();
  for (const [index, relation] of relations.entries()) {
    const candidateKey = relationCandidates[index];
    if ('text' in relation) {
      selectedRelations.push(relation);
      selectedCandidates.push(candidateKey);
      continue;
    }

    const pair = idPairKey(relation.source_sense_id, relation.target_sense_id);
    const currentCandidate = checkpointCandidates.get(candidateKey);
    // Distinct words that happen to target one sense stay distinct; only spacing/hyphenation variants coalesce.
    const orthographicForm = normalizeCandidate(currentCandidate?.text ?? '').replace(/[\s-]/gu, '');
    const groupKey = `${pair}\u0000${orthographicForm}`;
    const selectedIndex = relationIndexByPair.get(groupKey);
    if (selectedIndex === undefined) {
      relationIndexByPair.set(groupKey, selectedRelations.length);
      selectedRelations.push(relation);
      selectedCandidates.push(candidateKey);
      continue;
    }

    const mergedCandidateForms = [...new Set([...selectedRelations[selectedIndex].candidate_forms, ...relation.candidate_forms])];
    const mergedReverseCandidateForms = [...new Set([...selectedRelations[selectedIndex].reverse_candidate_forms, ...relation.reverse_candidate_forms])];
    const selectedCandidate = checkpointCandidates.get(selectedCandidates[selectedIndex]);
    const usesCanonicalSpelling = (candidate) => {
      const targetLemma = candidate?.same_spelling_targets
        .find((target) => target.record_id === relation.target_record_id)?.lemma;
      return typeof targetLemma === 'string' && normalizeCandidate(candidate.text) === normalizeCandidate(targetLemma);
    };
    // One meaning pair can be reached through multiple spacing/hyphenation aliases. The relation row
    // represents the target meaning, so prefer its canonical headword decision when aliases disagree;
    // otherwise retain the first candidate in the stable Stage 1 order.
    if (usesCanonicalSpelling(currentCandidate) && !usesCanonicalSpelling(selectedCandidate)) {
      selectedRelations[selectedIndex] = relation;
      selectedCandidates[selectedIndex] = candidateKey;
    }
    selectedRelations[selectedIndex] = {
      ...selectedRelations[selectedIndex],
      candidate_forms: mergedCandidateForms,
      reverse_candidate_forms: mergedReverseCandidateForms,
    };
  }
  return { relations: selectedRelations, relationCandidates: selectedCandidates };
}

function coalesceIdenticalSensePairRelations(relations, relationCandidates) {
  const selectedRelations = [];
  const selectedCandidates = [];
  const relationIndexByPair = new Map();
  for (const [index, relation] of relations.entries()) {
    const candidateKey = relationCandidates[index];
    if ('text' in relation) {
      selectedRelations.push(relation);
      selectedCandidates.push(candidateKey);
      continue;
    }

    const pair = idPairKey(relation.source_sense_id, relation.target_sense_id);
    const selectedIndex = relationIndexByPair.get(pair);
    if (selectedIndex === undefined) {
      relationIndexByPair.set(pair, selectedRelations.length);
      selectedRelations.push(relation);
      selectedCandidates.push(candidateKey);
      continue;
    }

    const selected = selectedRelations[selectedIndex];
    const sameClassification = selected.source_record_id === relation.source_record_id
      && selected.target_record_id === relation.target_record_id
      && selected.type === relation.type
      && selected.reverse_type === relation.reverse_type;
    if (!sameClassification) {
      // Preserve conflicting decisions so the common merge-conflict gate can reject them.
      selectedRelations.push(relation);
      selectedCandidates.push(candidateKey);
      continue;
    }

    // One ID row represents this exact sense pair. When distinct candidate forms assign
    // different priorities to the same relation types, retain the strongest priority
    // (the lower relevance number) independently in each direction.
    selectedRelations[selectedIndex] = {
      ...selected,
      relevance: Math.min(selected.relevance, relation.relevance),
      reverse_relevance: Math.min(selected.reverse_relevance, relation.reverse_relevance),
      candidate_forms: [...new Set([...selected.candidate_forms, ...relation.candidate_forms])],
      reverse_candidate_forms: [...new Set([...selected.reverse_candidate_forms, ...relation.reverse_candidate_forms])],
    };
  }
  return { relations: selectedRelations, relationCandidates: selectedCandidates };
}

function collectMergeConflicts(checkpoint, existingRelations, existingDrops, newRelations, newRelationCandidates, newDrops, index,
  otherRelationRows = [], { mergeOtherReciprocals = false } = {}) {
  // The materializer must be safe to run repeatedly from a pre-merge snapshot. Do not let a reciprocal
  // relation update alias and mutate the input rows supplied by its caller.
  const baseRelations = existingRelations.map((row) => ({
    ...row,
    ...(Array.isArray(row.candidate_forms) ? { candidate_forms: [...row.candidate_forms] } : {}),
    ...(Array.isArray(row.reverse_candidate_forms) ? { reverse_candidate_forms: [...row.reverse_candidate_forms] } : {}),
  }));
  const baseDrops = existingDrops.map((row) => ({ ...row }));
  const exactRelations = new Set(baseRelations.map(stableRow));
  const exactDrops = new Set(baseDrops.map(stableRow));
  const idPairs = new Map();
  const otherIdPairs = new Map();
  const textPairs = new Set();
  const drops = new Set(baseDrops.map((row) => `${row.source_sense_id}\u0000${normalizeCandidate(row.candidate)}`));
  const sourceCandidatesForPair = new Map();
  const existingIdCandidates = new Set();
  const existingIdCandidateRelations = new Map();
  const checkpointCandidates = new Map();
  const addSourceCandidateForPair = (pair, candidateKey) => {
    const candidates = sourceCandidatesForPair.get(pair) ?? new Set();
    candidates.add(candidateKey);
    sourceCandidatesForPair.set(pair, candidates);
  };
  const markExistingIdCandidates = (row) => {
    const assignments = relationCandidateKeys(row, null, index);
    for (const assignment of [...assignments.forward, ...assignments.reverse,
      ...assignments.reverseAliases, ...assignments.deferredForward]) {
      const key = `${assignment.senseId}\u0000${normalizeCandidate(assignment.candidate)}`;
      existingIdCandidates.add(key);
      const relations = existingIdCandidateRelations.get(key) ?? [];
      relations.push(row);
      existingIdCandidateRelations.set(key, relations);
    }
  };
  for (const item of checkpoint.items) for (const candidate of item.candidates) {
    const candidateKey = `${item.sense_id}\u0000${candidate.text}`;
    checkpointCandidates.set(candidateKey, candidate);
    for (const decision of [candidate.decision, ...(candidate.additional_relations ?? [])]) {
      if (decision?.target_resolution === 'exact') addSourceCandidateForPair(idPairKey(item.sense_id, decision.target_sense_id), candidateKey);
    }
  }
  for (const row of baseRelations) {
    if ('text' in row) textPairs.add(`${row.source_sense_id}\u0000${normalizeCandidate(row.text)}`);
    else {
      idPairs.set(idPairKey(row.source_sense_id, row.target_sense_id), row);
      idPairs.set(idPairKey(row.target_sense_id, row.source_sense_id), row);
      markExistingIdCandidates(row);
    }
  }
  for (const row of otherRelationRows) {
    if ('text' in row) continue;
    otherIdPairs.set(idPairKey(row.source_sense_id, row.target_sense_id), row);
    otherIdPairs.set(idPairKey(row.target_sense_id, row.source_sense_id), row);
    markExistingIdCandidates(row);
  }
  const appendRelations = [];
  const conflicts = [];
  const addConflict = (code, candidateKeys, rows, message) => conflicts.push({
    code,
    candidate_keys: [...new Set(candidateKeys)].sort(),
    relations: rows.filter(Boolean).map((row) => JSON.parse(JSON.stringify(row))),
    message,
  });
  const orthographicCoalesced = coalesceOrthographicAliasRelations(checkpoint, newRelations, newRelationCandidates);
  const coalesced = coalesceIdenticalSensePairRelations(orthographicCoalesced.relations, orthographicCoalesced.relationCandidates);
  for (const [rowIndex, row] of coalesced.relations.entries()) {
    const candidateKey = coalesced.relationCandidates[rowIndex];
    if (exactRelations.has(stableRow(row))) continue;
    if ('text' in row) {
      const key = `${row.source_sense_id}\u0000${normalizeCandidate(row.text)}`;
      if (textPairs.has(key) || drops.has(key) || existingIdCandidates.has(key)) {
        addConflict('candidate-already-decided', [candidateKey], [], `cannot merge duplicate or already-decided candidate ${row.source_sense_id}/${row.text}`);
        continue;
      }
      textPairs.add(key);
    } else {
      const key = idPairKey(row.source_sense_id, row.target_sense_id);
      const reverse = idPairKey(row.target_sense_id, row.source_sense_id);
      const otherPair = otherIdPairs.get(key) ?? otherIdPairs.get(reverse);
      if (otherPair) {
        if (mergeOtherReciprocals && isConsistentReciprocalIdRelation(otherPair, row)) {
          if ([0, 1].includes(otherPair.candidate_assignment_version)) {
            otherPair.candidate_forms = [...new Set([...(otherPair.candidate_forms ?? []), ...row.reverse_candidate_forms])];
            otherPair.reverse_candidate_forms = [...new Set([...(otherPair.reverse_candidate_forms ?? []), ...row.candidate_forms])];
          } else {
            const target = index.byId.get(otherPair.target_record_id);
            otherPair.candidate_assignment_version = 0;
            otherPair.candidate_forms = target ? legacyCandidateFormsForRecord(target, index) : [];
            otherPair.reverse_candidate_forms = [...new Set(row.candidate_forms)];
          }
          continue;
        }
        const relatedCandidates = new Set([
          ...(sourceCandidatesForPair.get(key) ?? []),
          ...(sourceCandidatesForPair.get(reverse) ?? []),
        ]);
        relatedCandidates.add(candidateKey);
        addConflict('id-pair-conflict', [...relatedCandidates], [otherPair, row],
          `cannot merge duplicate or reverse-duplicate ID relation ${row.source_sense_id}/${row.target_sense_id}; the pair is already owned by another shard`);
        continue;
      }
      const existingPair = idPairs.get(key) ?? idPairs.get(reverse);
      if (existingPair) {
        const sameOrientation = existingPair.source_record_id === row.source_record_id
          && existingPair.source_sense_id === row.source_sense_id
          && existingPair.target_record_id === row.target_record_id
          && existingPair.target_sense_id === row.target_sense_id;
        if (!sameOrientation && isConsistentReciprocalIdRelation(existingPair, row)) {
          if ([0, 1].includes(existingPair.candidate_assignment_version)) {
            existingPair.candidate_forms = [...new Set([
              ...(Array.isArray(existingPair.candidate_forms) ? existingPair.candidate_forms : []),
              ...row.reverse_candidate_forms,
            ])];
            existingPair.reverse_candidate_forms = [...new Set([
              ...(Array.isArray(existingPair.reverse_candidate_forms) ? existingPair.reverse_candidate_forms : []),
              ...row.candidate_forms,
            ])];
          } else {
            // Materialize the old inferred forward forms and record the new reciprocal selection separately.
            const target = index.byId.get(existingPair.target_record_id);
            existingPair.candidate_assignment_version = 0;
            existingPair.candidate_forms = target ? legacyCandidateFormsForRecord(target, index) : [];
            existingPair.reverse_candidate_forms = [...new Set(row.candidate_forms)];
          }
          continue;
        }
        const relatedCandidates = sourceCandidatesForPair.get(key) ?? new Set([candidateKey]);
        relatedCandidates.add(candidateKey);
        addConflict('id-pair-conflict', [...relatedCandidates], [existingPair, row],
          `cannot merge duplicate or reverse-duplicate ID relation ${row.source_sense_id}/${row.target_sense_id}`);
        continue;
      }
      const candidateKeys = sourceCandidatesForPair.get(key) ?? new Set([candidateKey]);
      let candidateConflict = false;
      for (const sourceCandidateKey of candidateKeys) {
        if (drops.has(sourceCandidateKey)) {
          addConflict('candidate-already-decided', [sourceCandidateKey], [row], `cannot merge an ID relation already marked Drop for ${sourceCandidateKey.replace('\u0000', '/')}`);
          candidateConflict = true;
        }
        if (textPairs.has(sourceCandidateKey)) {
          addConflict('candidate-already-decided', [sourceCandidateKey], [row], `cannot merge an ID relation already text-only for ${sourceCandidateKey.replace('\u0000', '/')}`);
          candidateConflict = true;
        }
      }
      if (candidateConflict) continue;
      idPairs.set(key, row);
      idPairs.set(reverse, row);
      exactRelations.add(stableRow(row));
    }
    appendRelations.push(row);
  }
  const appendDrops = [];
  for (const row of newDrops) {
    if (exactDrops.has(stableRow(row))) continue;
    const key = `${row.source_sense_id}\u0000${normalizeCandidate(row.candidate)}`;
    if (drops.has(key) || textPairs.has(key) || existingIdCandidates.has(key)) {
      addConflict('candidate-already-decided', [key], [], `cannot merge duplicate or already-decided candidate ${row.source_sense_id}/${row.candidate}`);
      continue;
    }
    drops.add(key);
    appendDrops.push(row);
  }
  for (const [key, candidate] of checkpointCandidates) {
    if (candidate.decision.disposition === 'drop' && existingIdCandidates.has(key)) {
      const approved = existingIdCandidateRelations.get(key) ?? [];
      addConflict('candidate-already-decided', [key], approved,
        `cannot merge a Drop already answered by an approved ID relation ${key.replace('\u0000', '/')}`);
    }
  }
  conflicts.sort((left, right) => left.code.localeCompare(right.code) || left.candidate_keys.join('\n').localeCompare(right.candidate_keys.join('\n')) || left.message.localeCompare(right.message));
  return { relations: [...baseRelations, ...appendRelations], drops: [...baseDrops, ...appendDrops], conflicts };
}

function assertNoMergeConflicts(checkpoint, existingRelations, existingDrops, newRelations, newRelationCandidates, newDrops, index,
  otherRelationRows = []) {
  const result = collectMergeConflicts(checkpoint, existingRelations, existingDrops, newRelations, newRelationCandidates, newDrops,
    index, otherRelationRows);
  if (result.conflicts.length) throw new Error(result.conflicts[0].message);
  return { relations: result.relations, drops: result.drops };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, shard: null, batch: null, part: null, out: null, checkpoint: null, input: null, supervisorFallback: null,
    maxCandidates: DEFAULT_CHUNK_CANDIDATES, allowPartial: false, json: false, relationsOnly: false, sourceSenseId: null, candidateText: null,
    selectPath: null, format: null, optional: false, chunkId: null, page: 1, pageSize: INSPECT_PAGE_SIZE, limit: 20, offset: 0,
    diffFrom: null, diffTo: null, refreshPremerge: false, dryRun: false, check: false, from: null, fromShas: [], to: null,
    taskPlan: null, planFile: null, taskId: null, target: DEFAULT_CHUNK_CANDIDATES, expectViewSha256: null };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--shard') options.shard = rest[++index];
    else if (flag === '--batch') options.batch = rest[++index];
    else if (flag === '--part') options.part = rest[++index];
    else if (flag === '--out') options.out = rest[++index];
    else if (flag === '--checkpoint') options.checkpoint = rest[++index];
    else if (flag === '--in') options.input = rest[++index];
    else if (flag === '--supervisor-fallback') options.supervisorFallback = true;
    else if (flag === '--max-candidates') options.maxCandidates = Number(rest[++index]);
    else if (flag === '--source-sense-id') options.sourceSenseId = rest[++index];
    else if (flag === '--candidate') options.candidateText = rest[++index];
    else if (flag === '--select') options.selectPath = rest[++index];
    else if (flag === '--optional') options.optional = true;
    else if (flag === '--chunk-id') options.chunkId = rest[++index];
    else if (flag === '--page') options.page = Number(rest[++index]);
    else if (flag === '--page-size') options.pageSize = Number(rest[++index]);
    else if (flag === '--limit') options.limit = Number(rest[++index]);
    else if (flag === '--offset') options.offset = Number(rest[++index]);
    else if (flag === '--allow-partial') options.allowPartial = true;
    else if (flag === '--relations-only') options.relationsOnly = true;
    else if (flag === '--json') options.json = true;
    else if (flag === '--format') options.format = rest[++index];
    else if (flag === '--diff-from') options.diffFrom = rest[++index];
    else if (flag === '--diff-to') options.diffTo = rest[++index];
    else if (flag === '--refresh') options.refreshPremerge = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--check') options.check = true;
    else if (flag === '--task') { options.taskPlan = rest[++index]; options.taskId = rest[++index]; }
    else if (flag === '--plan') options.planFile = rest[++index];
    else if (flag === '--target') options.target = Number(rest[++index]);
    else if (flag === '--expect-view-sha256') options.expectViewSha256 = rest[++index];
    else if (flag === '--from') options.from = rest[++index];
    else if (flag === '--from-sha') options.fromShas.push(rest[++index]);
    else if (flag === '--to') options.to = rest[++index];
    else throw new Error(`unknown argument ${flag}\n${USAGE}`);
  }
  if (options.format !== null && !['inspect', 'read-chunk', 'save-chunk'].includes(command)) throw new Error(`--format is only valid for inspect/read-chunk/save-chunk\n${USAGE}`);
  if (options.format !== null && !['json', 'compact'].includes(options.format)) throw new Error(`--format must be json or compact\n${USAGE}`);
  if (options.format === 'compact' && command === 'read-chunk' && !options.optional && options.sourceSenseId !== null) {
    throw new Error(`--format compact covers primary chunks only; read a revision as JSON\n${USAGE}`);
  }
  if (options.taskPlan !== null) {
    if (!['read-chunk', 'save-chunk'].includes(command) || !options.taskPlan || !options.taskId) throw new Error(`--task <plan> <task-id> is only valid for read-chunk/save-chunk\n${USAGE}`);
    if (options.format !== null && options.format !== 'compact') throw new Error(`--task requires --format compact\n${USAGE}`);
    if (options.optional || options.sourceSenseId !== null || options.candidateText !== null) throw new Error(`--task cannot be combined with --optional or a source candidate filter\n${USAGE}`);
    options.format = 'compact';
  }
  options.format ??= 'json';
  if (options.expectViewSha256 !== null && !(command === 'save-chunk' && options.taskPlan !== null)) throw new Error(`--expect-view-sha256 is only valid for save-chunk --task\n${USAGE}`);
  if (command === 'save-chunk' && options.taskPlan !== null && !/^[a-f0-9]{64}$/u.test(options.expectViewSha256 ?? '')) throw new Error(`save-chunk --task requires --expect-view-sha256 <64 hex>\n${USAGE}`);
  if (command === 'plan-chunks' && (!Number.isInteger(options.target) || options.target < 1)) throw new Error(`--target must be a positive integer\n${USAGE}`);
  if (command === 'close-plan' && !options.planFile) throw new Error(`close-plan requires --plan\n${USAGE}`);
  if (options.planFile !== null && command !== 'close-plan') throw new Error(`--plan is only valid for close-plan\n${USAGE}`);
  if (command === 'plan-chunks' && !options.out) throw new Error(`plan-chunks requires --out\n${USAGE}`);
  if (options.target !== DEFAULT_CHUNK_CANDIDATES && command !== 'plan-chunks') throw new Error(`--target is only valid for plan-chunks\n${USAGE}`);
  if (options.supervisorFallback !== null
      && (command !== 'save-chunk' || options.format !== 'compact')) {
    throw new Error('--supervisor-fallback requires save-chunk --format compact\n' + USAGE);
  }
  if (!['prepare', 'plan-chunks', 'close-plan', 'inspect', 'read-chunk', 'save-chunk', 'save-optional', 'complete-optional', 'cancel-revision', 'merge', 'prepare-merge', 'amend', 'preflight', 'repair', 'reconcile', 'affected-shards', 'affected-shards-batch', 'verify'].includes(command)) throw new Error(USAGE);
  if (['prepare', 'verify', 'reconcile'].includes(command)) assertShard(options.shard);
  if (options.batch !== null && !['01', '02'].includes(options.batch)) throw new Error(`--batch must be 01 or 02\n${USAGE}`);
  if (options.part !== null) {
    if (options.shard === null) throw new Error(`--part requires --shard\n${USAGE}`);
    try { assertStage2Part(options.shard, options.batch ?? '01', options.part); } catch (error) { throw new Error(`${error.message}\n${USAGE}`); }
  }
  if (options.part !== null && options.batch === null) throw new Error(`--part requires --batch\n${USAGE}`);
  if (options.part !== null && !['prepare', 'verify', 'reconcile'].includes(command)) throw new Error(`--part is only valid for prepare/verify/reconcile\n${USAGE}`);
  if (!Number.isInteger(options.maxCandidates) || options.maxCandidates < 1) throw new Error(`--max-candidates must be a positive integer\n${USAGE}`);
  if (['plan-chunks', 'close-plan', 'inspect', 'read-chunk', 'save-chunk', 'save-optional', 'complete-optional', 'cancel-revision', 'merge', 'prepare-merge', 'amend', 'preflight', 'repair'].includes(command) && !options.checkpoint) throw new Error(`${command} requires --checkpoint\n${USAGE}`);
  if (['save-chunk', 'save-optional', 'amend', 'repair'].includes(command) && !options.input) throw new Error(`${command} requires --in\n${USAGE}`);
  if (command === 'cancel-revision' && !options.chunkId) throw new Error(`cancel-revision requires --chunk-id\n${USAGE}`);
  if (['inspect', 'read-chunk'].includes(command) && (!Number.isInteger(options.page) || options.page < 1)) throw new Error(`--page must be a positive integer\n${USAGE}`);
  if (['inspect', 'read-chunk'].includes(command) && (!Number.isInteger(options.pageSize) || options.pageSize < 1)) throw new Error(`--page-size must be a positive integer\n${USAGE}`);
  if ((options.page !== 1 || options.pageSize !== INSPECT_PAGE_SIZE) && !['inspect', 'read-chunk'].includes(command)) throw new Error(`--page/--page-size is only valid for inspect/read-chunk\n${USAGE}`);
  if (options.optional && command !== 'read-chunk') throw new Error(`--optional is only valid for read-chunk\n${USAGE}`);
  if ((options.limit !== 20 || options.offset !== 0) && command !== 'preflight') throw new Error(`--limit/--offset are only valid for preflight\n${USAGE}`);
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error(`--limit must be an integer 1..100\n${USAGE}`);
  if (!Number.isInteger(options.offset) || options.offset < 0) throw new Error(`--offset must be a non-negative integer\n${USAGE}`);
  if (options.chunkId && command !== 'cancel-revision') throw new Error(`--chunk-id is only valid for cancel-revision\n${USAGE}`);
  const hasDiff = options.diffFrom !== null || options.diffTo !== null;
  if (hasDiff && !['prepare-merge', 'reconcile'].includes(command)) throw new Error(`--diff-from/--diff-to are only valid for prepare-merge/reconcile\n${USAGE}`);
  if (hasDiff && ![options.diffFrom, options.diffTo].every((sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/u.test(sha))) {
    throw new Error('--diff-from and --diff-to must both be 40-character lowercase commit SHAs');
  }
  if ((options.from !== null || options.to !== null) && !['affected-shards', 'affected-shards-batch'].includes(command)) throw new Error(`--from/--to are only valid for affected-shards\n${USAGE}`);
  if (options.fromShas.length && command !== 'affected-shards-batch') throw new Error(`--from-sha is only valid for affected-shards-batch\n${USAGE}`);
  if (command === 'affected-shards' && (![options.from, options.to].every((sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/u.test(sha)))) {
    throw new Error(`affected-shards requires --from and --to 40-character lowercase commit IDs\n${USAGE}`);
  }
  if (command === 'affected-shards-batch' && (!options.fromShas.length
      || options.fromShas.some((sha) => !/^[a-f0-9]{40}$/u.test(sha))
      || new Set(options.fromShas).size !== options.fromShas.length
      || !/^[a-f0-9]{40}$/u.test(options.to ?? ''))) {
    throw new Error(`affected-shards-batch requires unique --from-sha values and a 40-character --to commit ID\n${USAGE}`);
  }
  if (options.refreshPremerge && command !== 'prepare-merge') throw new Error(`--refresh is only valid for prepare-merge\n${USAGE}`);
  if (command === 'reconcile' && !hasDiff) throw new Error(`reconcile requires --diff-from and --diff-to\n${USAGE}`);
  if (options.relationsOnly && (command !== 'verify' || !options.json || options.allowPartial)) {
    throw new Error('--relations-only requires verify --json and cannot be combined with --allow-partial');
  }
  if (options.check && command !== 'repair') throw new Error(`--check is only valid for repair\n${USAGE}`);
  if (options.dryRun && command !== 'reconcile') throw new Error(`--dry-run is only valid for reconcile\n${USAGE}`);
  if (options.json && !['verify', 'prepare-merge', 'preflight', 'repair', 'reconcile', 'affected-shards', 'affected-shards-batch'].includes(command)) throw new Error(`--json is only valid for verify/prepare-merge/preflight/repair/reconcile/affected-shards\n${USAGE}`);
  if (['prepare-merge', 'preflight', 'repair', 'reconcile', 'affected-shards', 'affected-shards-batch'].includes(command) && !options.json) throw new Error(`${command} requires --json\n${USAGE}`);
  if (options.allowPartial && !['prepare', 'verify'].includes(command)) throw new Error(`--allow-partial is only valid for prepare/verify\n${USAGE}`);
  if (command === 'inspect' && (typeof options.sourceSenseId !== 'string' || !options.sourceSenseId)) {
    throw new Error(`inspect requires --source-sense-id\n${USAGE}`);
  }
  if (options.selectPath !== null && command !== 'inspect') throw new Error(`--select is only valid for inspect\n${USAGE}`);
  if (options.selectPath !== null && !options.selectPath) throw new Error(`--select requires a JSON file path\n${USAGE}`);
  if (options.selectPath !== null && options.candidateText !== null) throw new Error('--select and --candidate cannot be used together');
  if (options.selectPath !== null && options.format !== 'compact') throw new Error('--select requires --format compact');
  if ((options.sourceSenseId !== null || options.candidateText !== null)
      && !(command === 'inspect' || (command === 'read-chunk' && !options.optional
        && typeof options.sourceSenseId === 'string' && options.sourceSenseId
        && typeof options.candidateText === 'string' && options.candidateText))) {
    throw new Error(`--source-sense-id and --candidate must be used with inspect, or together with read-chunk\n${USAGE}`);
  }
  if (options.optional && (options.sourceSenseId !== null || options.candidateText !== null)) throw new Error(`--optional cannot be combined with a source candidate filter\n${USAGE}`);
  if (command === 'prepare' && options.part && options.out) throw new Error('Part prepare writes its checkpoint; use --checkpoint instead of --out');
  if (options.out && !['plan-chunks', 'inspect', 'read-chunk', 'preflight'].includes(command)) throw new Error(`--out is only valid for plan-chunks/inspect/read-chunk/preflight\n${USAGE}`);
  return options;
}

function requireComplete(inventory, allowPartial) {
  if (inventory.missing.length === 0) return;
  const message = `shard Stage 1 inputs are incomplete; missing batch/producer: ${inventory.missing.join(', ')}`;
  if (!allowPartial) throw new Error(`${message}. Do not substitute other AI output; pass --allow-partial only for tooling checks.`);
  console.error(`PARTIAL: ${message}`);
}

export async function run(argv, { root } = {}) {
  const options = parseArgs(argv);
  const timing = options.command === 'verify' ? createVerifyTiming(options) : null;
  try {
    const result = await runCommand(options, root, timing);
    timing?.finish('success');
    return result;
  } catch (error) {
    timing?.finish('failed');
    throw error;
  }
}

function createVerifyTiming(options) {
  const started = performance.now();
  const stages = [];
  const active = [];
  return {
    checkpoint() { options.timingCheckpoint = true; },
    start(stage) { active.push({ stage, started: performance.now() }); },
    end() {
      const entry = active.pop();
      stages.push({ stage: entry.stage, elapsed_ms: Math.round(performance.now() - entry.started), status: 'success' });
    },
    finish(status) {
      while (active.length) {
        const entry = active.pop();
        stages.push({ stage: entry.stage, elapsed_ms: Math.round(performance.now() - entry.started), status: 'failed' });
      }
      stages.push({ stage: 'total', elapsed_ms: Math.round(performance.now() - started), status });
      console.error(`verify_timing ${JSON.stringify({ shard: options.shard, batch: options.batch, part: options.part,
        checkpoint: Boolean(options.timingCheckpoint), stages })}`);
    },
  };
}

async function runCommand(options, root, timing) {
  const repositoryRoot = root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  if (options.command === 'affected-shards') {
    const payload = { version: 1, ok: true, from: options.from, to: options.to,
      shards: await affectedRelationShards(options.from, options.to, repositoryRoot) };
    console.log(JSON.stringify(payload));
    return payload;
  }
  if (options.command === 'affected-shards-batch') {
    const payload = { version: 1, ok: true, to: options.to,
      by_from: await affectedRelationShardsMany(options.fromShas, options.to, repositoryRoot) };
    console.log(JSON.stringify(payload));
    return payload;
  }
  if (options.command === 'reconcile') {
    const result = await reconcileScope({ shard: options.shard, batch: options.batch, part: options.part,
      diffFrom: options.diffFrom, diffTo: options.diffTo, dryRun: options.dryRun, root: repositoryRoot });
    console.log(JSON.stringify(result));
    return result;
  }
  const checkpointPath = options.checkpoint
    ? resolveRootPath(repositoryRoot, options.checkpoint)
    : options.part && ['prepare', 'verify'].includes(options.command)
        ? defaultCheckpointPath(options.shard, options.batch, options.part, repositoryRoot)
        : null;

  if (options.command === 'preflight') {
    const checkpoint = await readCheckpoint(checkpointPath);
    const payload = await preflightCheckpoint(checkpoint, checkpointPath, repositoryRoot, options.limit, options.offset, Boolean(options.out));
    if (options.out) {
      const destination = resolveRootPath(repositoryRoot, options.out);
      await writeFile(destination, `${JSON.stringify(payload)}\n`);
    } else console.log(JSON.stringify(payload));
    return payload;
  }
  if (options.command === 'prepare-merge') {
    const checkpoint = await readCheckpoint(checkpointPath);
    assertPrimaryComplete(checkpoint);
    assertOptionalComplete(checkpoint);
    if (checkpoint.merged) throw new Error('cannot prepare a merged Part for merge');
    const prepared = await ensurePremerge(checkpoint, checkpointPath, repositoryRoot, {
      diffFrom: options.diffFrom, diffTo: options.diffTo,
      refresh: options.refreshPremerge,
    });
    const payload = { version: 1, ok: true, shard: checkpoint.shard, batch: checkpoint.batch, part: checkpoint.part,
      premerge: checkpoint.premerge, relations: prepared.relations.exists, drops: prepared.drops.exists };
    console.log(JSON.stringify(payload));
    return payload;
  }
  if (options.command === 'repair') {
    const result = await applyRepair(await readCheckpoint(checkpointPath), checkpointPath, options.input, repositoryRoot, { check: options.check });
    const payload = { version: 1, ...result };
    console.log(JSON.stringify(payload));
    return payload;
  }

  if (options.command === 'inspect') {
    const checkpoint = await readCheckpoint(checkpointPath);
    const ids = options.sourceSenseId.split(',').map((value) => value.trim());
    if (ids.some((value) => !value)) throw new Error('--source-sense-id contains an empty ID');
    return inspectCheckpoint(checkpoint, options.out, repositoryRoot, ids, options.candidateText, options.selectPath,
      options.format, options.page, options.pageSize);
  }
  if (options.command === 'plan-chunks') return planChunks(await readCheckpoint(checkpointPath), checkpointPath, options.target, options.out, repositoryRoot);
  if (options.command === 'close-plan') {
    const checkpoint = await readCheckpoint(checkpointPath);
    return closeTaskPlan(checkpoint, checkpointPath, await readTaskPlan(checkpoint, options.planFile, repositoryRoot));
  }
  if (options.command === 'read-chunk' || options.command === 'save-chunk') {
    const checkpoint = await readCheckpoint(checkpointPath);
    if (options.taskPlan !== null) {
      const plan = await readTaskPlan(checkpoint, options.taskPlan, repositoryRoot);
      if (options.command === 'read-chunk') return readTaskChunk(checkpoint, checkpointPath, plan, options.taskId, options.out, repositoryRoot);
      return saveTaskChunk(checkpoint, checkpointPath, plan, options.taskId, options.input, repositoryRoot, options.expectViewSha256, options.supervisorFallback);
    }
    if (options.command === 'read-chunk') return readChunk(checkpoint, checkpointPath, options.maxCandidates, options.out, repositoryRoot,
      options.sourceSenseId, options.candidateText, options.format, options.optional, options.page, options.pageSize);
    return saveChunk(checkpoint, checkpointPath, options.input, repositoryRoot, options.format, options.supervisorFallback);
  }
  if (options.command === 'save-optional') {
    const result = await saveOptional(await readCheckpoint(checkpointPath), checkpointPath, options.input, repositoryRoot);
    console.log(JSON.stringify(result));
    return result;
  }
  if (options.command === 'complete-optional') {
    const result = await completeOptional(await readCheckpoint(checkpointPath), checkpointPath);
    console.log(JSON.stringify(result));
    return result;
  }
  if (options.command === 'cancel-revision') {
    const result = await cancelRevision(await readCheckpoint(checkpointPath), checkpointPath, options.chunkId);
    console.log(JSON.stringify(result));
    return result;
  }
  if (options.command === 'amend') {
    const result = await amendCheckpoint(await readCheckpoint(checkpointPath), checkpointPath, options.input, repositoryRoot);
    console.log(JSON.stringify(result));
    return result;
  }
  if (options.command === 'merge') return mergeCheckpoint(await readCheckpoint(checkpointPath), checkpointPath, repositoryRoot);
  if (options.command === 'prepare' && options.part && existsSync(checkpointPath)) {
    const checkpoint = await readCheckpoint(checkpointPath, { shard: options.shard, batch: options.batch, part: options.part });
    console.log(`Resuming shard ${options.shard} batch ${options.batch} part ${options.part}: ${checkpointProgress(checkpoint)} -> ${checkpointPath}`);
    return checkpoint;
  }
  let verifiedCheckpoint = null;
  let verifiedAmendJournal = null;
  if (options.command === 'verify' && options.part && existsSync(checkpointPath)) {
    timing?.checkpoint();
    timing?.start('checkpoint_load');
    verifiedCheckpoint = await readCheckpoint(checkpointPath, { shard: options.shard, batch: options.batch, part: options.part });
    if (!verifiedCheckpoint.merged || verifiedCheckpoint.pending_chunk || verifiedCheckpoint.items.some((item) => item.candidates.some((candidate) => candidate.decision === null))) {
      throw new Error(`Part checkpoint is incomplete or not merged: ${checkpointProgress(verifiedCheckpoint)}`);
    }
    validateCheckpointDecisions(verifiedCheckpoint);
    if ((verifiedCheckpoint.amend_revision ?? 0) > 0) {
      const journalPath = checkpointPath.replace(/\.json$/u, '.amend-state.json');
      const journal = await readAmendJournal(journalPath);
      if (!journal) throw new Error('amended Part checkpoint has no amend recovery evidence');
      verifiedAmendJournal = journal;
      const oldCheckpoint = checkpointFromJournal(journal.old_checkpoint_b64);
      const newCheckpoint = checkpointFromJournal(journal.new_checkpoint_b64);
      if (!/^[a-f0-9]{64}$/u.test(journal.request_sha256)
          || oldCheckpoint.shard !== verifiedCheckpoint.shard || oldCheckpoint.batch !== verifiedCheckpoint.batch
          || oldCheckpoint.part !== verifiedCheckpoint.part || newCheckpoint.shard !== verifiedCheckpoint.shard
          || newCheckpoint.batch !== verifiedCheckpoint.batch || newCheckpoint.part !== verifiedCheckpoint.part
          || newCheckpoint.amend_revision !== verifiedCheckpoint.amend_revision
          || !sameFileState(await readFileState(checkpointPath), bytesState(checkpointBytes(newCheckpoint)))) {
        throw new Error('latest amend recovery evidence does not match the current checkpoint');
      }
    }
  }

  if (verifiedCheckpoint) timing?.end();
  timing?.start('load_shard');
  const loaded = await loadShard(options.shard, repositoryRoot, { batch: options.batch });
  timing?.end();
  const { canonicalRows, index } = loaded;
  if (options.relationsOnly) {
    const [relationRows, dropRows, otherRelationRows] = await Promise.all([
      loadOptionalRelationJsonl(shardRelationPath(options.shard, repositoryRoot)),
      loadOptionalDropJsonl(shardDropPath(options.shard, repositoryRoot)),
      loadApprovedRelations(repositoryRoot, { exceptShard: options.shard }),
    ]);
    const shardSenseIds = new Set(canonicalRows.flatMap((record) => record.senses.map((sense) => sense.id)));
    validateRelationRows({ relationRows, dropRows, index, shardSenseIds, otherRelationRows });
    const payload = { version: 1, ok: true, scope: 'relation-integrity', shard: options.shard,
      counts: { relations: relationRows.length, drops: dropRows.length } };
    console.log(JSON.stringify(payload));
    return payload;
  }
  // --batch selects and fully validates one 500-record Stage 1 input set; --part narrows only Stage 2 editing/accounting.
  const scoped = options.part
    ? partScope(canonicalRows, loaded.candidateFiles, options.batch, options.part, options.shard)
    : options.batch
      ? batchScope(canonicalRows, loaded.candidateFiles, options.batch)
      : { scopeRows: canonicalRows, files: loaded.candidateFiles };
  const { scopeRows } = scoped;
  const candidateFiles = scoped.files;
  const inventory = options.batch ? candidateInventory(candidateFiles.map((file) => file.name), { batches: [options.batch] }) : loaded.inventory;
  requireComplete(inventory, options.allowPartial);
  timing?.start('load_approved_relations');
  const others = await loadApprovedRelations(repositoryRoot, { exceptShard: options.shard });
  timing?.end();

  if (options.command === 'prepare') {
    // A re-run must not re-offer what is already decided: this shard's own approved rows and real Drops count too.
    const own = await loadOptionalRelationJsonl(shardRelationPath(options.shard, repositoryRoot));
    const ownDrops = await loadOptionalDropJsonl(shardDropPath(options.shard, repositoryRoot));
    const result = prepareShard({
      canonicalRows,
      candidateFiles,
      approvedRelationRows: [...others, ...own],
      dropRows: ownDrops,
      index,
      scopeRows,
      includePartiallyCovered: Boolean(options.part),
    });
    if (options.part) {
      const checkpoint = {
        version: CHECKPOINT_VERSION,
        type_tier_policy: SOURCE_MIRROR_TYPE_TIER_POLICY,
        shard: options.shard,
        batch: options.batch,
        part: options.part,
        part_size: stage2PartSize(options.shard),
        base_revision: currentGitHead(repositoryRoot),
        complete: inventory.missing.length === 0,
        stats: result.stats,
        next_chunk_number: 1,
        pending_chunk: null,
        optional_review_complete: false,
        merged: false,
        items: result.items.map((item) => ({
          ...item,
          approved_peers: approvedPeersForSense(item.sense_id, [...others, ...own], index),
          candidates: item.candidates.map((candidate) => {
            const alreadyAccounted = candidate.already_accounted === true;
            return {
              text: candidate.text,
              producers: candidate.producers,
              same_spelling_targets: sameSpellingTargets(index, candidate.text),
              ...(alreadyAccounted ? {
                already_accounted: true,
                existing_target_sense_ids: candidate.existing_target_sense_ids,
                unlinked_target_sense_ids: candidate.unlinked_target_sense_ids,
                additional_relations: [],
              } : {}),
              decision: alreadyAccounted ? { disposition: 'existing' } : null,
            };
          }),
        })),
      };
      validateCheckpoint(checkpoint, { shard: options.shard, batch: options.batch, part: options.part });
      await writeJsonAtomically(checkpointPath, checkpoint);
      console.log(`Prepared shard ${options.shard} batch ${options.batch} part ${options.part}: ${JSON.stringify(result.stats)} -> ${checkpointPath}`);
      return checkpoint;
    }
    const payload = {
      shard: options.shard,
      batch: options.batch,
      ...(options.part ? { part: options.part } : {}),
      complete: inventory.missing.length === 0,
      missing: inventory.missing,
      stats: result.stats,
      items: result.items,
    };
    if (options.out) {
      await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
      await writeFile(options.out, `${JSON.stringify(payload)}\n`);
    }
    console.log(`Prepared shard ${options.shard}${options.batch ? ` batch ${options.batch}` : ''}${options.part ? ` part ${options.part}` : ''}: ${JSON.stringify(result.stats)}${options.out ? ` -> ${options.out}` : ''}`);
    return payload;
  }

  timing?.start('relation_validation');
  const relationRows = await loadOptionalRelationJsonl(shardRelationPath(options.shard, repositoryRoot));
  const dropRows = await loadOptionalDropJsonl(shardDropPath(options.shard, repositoryRoot));
  const shardSenseIds = new Set(canonicalRows.flatMap((record) => record.senses.map((sense) => sense.id)));
  validateRelationRows({ relationRows, dropRows, index, shardSenseIds, otherRelationRows: others,
    actionTargetPosSenseIds: options.part ? new Set(scopeRows.flatMap((record) => record.senses.map((sense) => sense.id))) : null });
  timing?.end();
  timing?.start('accounting');
  const counts = verifyAccounting({ canonicalRows, candidateFiles, relationRows, dropRows, otherRelationRows: others, index, scopeRows });
  timing?.end();
  if (verifiedCheckpoint) {
    timing?.start('checkpoint_merged');
    assertCheckpointMerged(verifiedCheckpoint, [...relationRows, ...others], dropRows);
    timing?.end();
    if (verifiedCheckpoint.premerge) {
      timing?.start('premerge_read');
      const baseline = await readReadyPremerge(verifiedCheckpoint, checkpointPath);
      timing?.end();
      timing?.start('materialize_part');
      const expected = verifiedAmendJournal?.version === 2
        ? await materializeWithForeign(verifiedCheckpoint, repositoryRoot, baseline,
          Object.fromEntries(Object.entries(verifiedAmendJournal.foreign).map(([name, entry]) => [name, entry.baseline])))
        : await materializePart(verifiedCheckpoint, repositoryRoot, baseline, null, timing);
      timing?.end();
      timing?.start('output_compare');
      const [actualRelations, actualDrops] = await Promise.all([
        readFileState(shardRelationPath(options.shard, repositoryRoot)),
        readFileState(shardDropPath(options.shard, repositoryRoot)),
      ]);
      if (!sameFileState(actualRelations, expected.relations) || !sameFileState(actualDrops, expected.drops)) {
        throw new Error('merged Part outputs do not match byte-for-byte materialize(premerge, checkpoint)');
      }
      if (verifiedAmendJournal?.version === 2 && expected.files.some((file) => !sameFileState(file.actual, expected.foreign[file.name]))) {
        throw new Error('foreign Relation outputs do not match byte-for-byte materialize(premerge, checkpoint)');
      }
      timing?.end();
    }
  }
  if (options.json) {
    console.log(JSON.stringify({ version: 1, ok: true, counts }));
    return counts;
  }
  console.log(`Relation Admission accounting valid for shard ${options.shard}${options.batch ? ` batch ${options.batch}` : ''}${options.part ? ` part ${options.part}` : ''}: ${JSON.stringify(counts)}`);
  return counts;
}

function checkpointProgress(checkpoint) {
  const total = checkpoint.items.reduce((sum, item) => sum + item.candidates.length, 0);
  const decided = checkpoint.items.reduce((sum, item) => sum + item.candidates.filter((candidate) => candidate.decision !== null).length, 0);
  return `${decided}/${total} candidates decided`;
}

function checkpointProgressPayload(checkpoint) {
  const total = checkpoint.items.reduce((sum, item) => sum + item.candidates.length, 0);
  const decided = total - checkpoint.items.reduce((sum, item) => sum + item.candidates.filter((candidate) => candidate.decision === null).length, 0);
  return { decided, total };
}

function pendingChunkPayload(checkpoint, pending) {
  return {
    chunk_id: pending.chunk_id,
    ...(pending.revision === true ? { revision: true } : {}),
    shard: checkpoint.shard,
    batch: checkpoint.batch,
    part: checkpoint.part,
    candidate_count: pending.candidate_count,
    continuation: pending.slices.map((slice) => {
      const item = checkpoint.items.find((entry) => entry.sense_id === slice.sense_id);
      return {
        source_sense_id: item.sense_id,
        candidate_start: slice.start,
        candidate_end: slice.end,
        candidate_total: item.candidates.length,
        continues_from_previous: slice.start > 0,
        continues_in_next: slice.end < item.candidates.length,
      };
    }),
    items: pending.slices.map((slice) => {
      const item = checkpoint.items.find((entry) => entry.sense_id === slice.sense_id);
      return {
        record_id: item.record_id,
        sense_id: item.sense_id,
        lemma: item.lemma,
        pos: item.pos,
        gloss: item.gloss,
        ...(item.reference_gloss === undefined ? {} : { reference_gloss: item.reference_gloss }),
        approved_peers: item.approved_peers,
        candidate_start: slice.start,
        candidate_end: slice.end,
        candidate_total: item.candidates.length,
        continues_from_previous: slice.start > 0,
        continues_in_next: slice.end < item.candidates.length,
        candidates: item.candidates.slice(slice.start, slice.end).map((candidate) => ({
          text: candidate.text,
          producers: candidate.producers,
          same_spelling_targets: candidate.same_spelling_targets,
          ...(candidate.already_accounted === true ? {
            already_accounted: true,
            existing_target_sense_ids: candidate.existing_target_sense_ids,
            unlinked_target_sense_ids: candidate.unlinked_target_sense_ids,
            additional_relations: candidate.additional_relations.map((decision) => presentedDecision(checkpoint, decision)),
          } : {}),
          ...(candidate.decision === null ? {} : { previous_decision: presentedDecision(checkpoint, candidate.decision) }),
        })),
      };
    }),
  };
}

/**
 * The aliases one primary chunk's compact view and its compact decisions share, derived only from the checkpoint.
 * Every same-spelling target sense appears once as `T<n>`, every candidate as `c<n>`; nothing is truncated.
 */
function compactChunkModel(checkpoint, pending) {
  if (pending.revision === true) throw new Error(`active chunk ${pending.chunk_id} is a revision; use the JSON format`);
  const targets = new Map();
  const candidates = [];
  const sources = pending.slices.map((slice) => {
    const item = checkpoint.items.find((entry) => entry.sense_id === slice.sense_id);
    const rows = item.candidates.slice(slice.start, slice.end).map((candidate) => {
      const aliases = candidate.same_spelling_targets.flatMap((target) => target.senses.map((sense) => {
        if (!targets.has(sense.sense_id)) {
          targets.set(sense.sense_id, { alias: `T${targets.size + 1}`, record_id: target.record_id, lemma: target.lemma, sense_id: sense.sense_id, pos: sense.pos, gloss: sense.gloss });
        }
        return targets.get(sense.sense_id).alias;
      }));
      const row = { alias: `c${candidates.length + 1}`, item, candidate, targets: aliases };
      candidates.push(row);
      return row;
    });
    return { slice, item, rows };
  });
  return { sources, candidates, targets };
}

function compactField(value) {
  const text = String(value);
  if (/[\t\r\n]/u.test(text)) throw new Error(`compact chunk field cannot contain a tab or line break: ${JSON.stringify(text)}`);
  return text;
}

const compactLine = (...fields) => fields.map(compactField).join('\t');

function compactSavedDecision(decision, checkpoint) {
  if (decision.disposition === 'drop') return ['drop', decision.reason];
  if (decision.disposition === 'existing') return ['existing'];
  if (decision.target_resolution === 'exact') {
    return usesSourceMirrorTypeTier(checkpoint)
      ? ['relation', decision.type, decision.relevance, decision.target_sense_id]
      : ['relation', decision.type, decision.relevance, decision.target_sense_id, decision.reverse_type, decision.reverse_relevance];
  }
  return ['relation', decision.type, decision.relevance, 'text-only'];
}

export const COMPACT_DECISION_GRAMMAR = [
  'chunk <chunk_id>                                  first line',
  'c<n> R <type> <tier> T<k> <reverse_type> <reverse_tier>   exact target sense T<k>',
  'c<n> R <type> <tier> none T<a>,T<b>,...           text-only; list every target alias of c<n>',
  'c<n> R <type> <tier>                              text-only; c<n> has no targets (-)',
  'c<n> D x|e                                         unrelated/wrong Sense | no independent expression value',
];

const SOURCE_MIRROR_COMPACT_DECISION_GRAMMAR = [
  'chunk <chunk_id>                                  first line',
  'c<n> R <type> <tier> T<k>                         exact target sense T<k>; reverse values are derived by the CLI',
  'c<n> R <type> <tier> none T<a>,T<b>,...           text-only; list every target alias of c<n>',
  'c<n> R <type> <tier>                              text-only; c<n> has no targets (-)',
  'c<n> D x|e                                         unrelated/wrong Sense | no independent expression value',
];

function renderCompactChunk(checkpoint, pending) {
  const model = compactChunkModel(checkpoint, pending);
  const lines = [
    `# Stage 2 chunk ${pending.chunk_id} · shard ${checkpoint.shard} batch ${checkpoint.batch} part ${checkpoint.part} · ${pending.candidate_count} candidates`,
    '# T<k>\ttarget_sense_id\ttarget_record_id\tlemma\tpos\tfull gloss',
    '# S\tsource_sense_id\tsource_record_id\tlemma\tpos\tfull gloss\tcandidates <start>-<end>/<total>',
    '# P\tapproved peer: type\trelevance\ttarget_sense_id lemma pos gloss | text',
    '# Q\tsaved decision of an earlier candidate of the same source sense',
    '# c<n>\tcandidate\tproducers\tsame-spelling target aliases (- = none)',
    ...(usesSourceMirrorTypeTier(checkpoint) ? SOURCE_MIRROR_COMPACT_DECISION_GRAMMAR : COMPACT_DECISION_GRAMMAR)
      .map((rule) => `# decision: ${rule}`),
    '',
    '## targets',
    ...[...model.targets.values()].map((target) => compactLine(target.alias, target.sense_id, target.record_id, target.lemma, target.pos, target.gloss)),
  ];
  for (const { slice, item, rows } of model.sources) {
    lines.push('', compactLine('S', item.sense_id, item.record_id, item.lemma, item.pos, item.reference_gloss === undefined ? item.gloss : `${item.gloss} ⇒ ${item.reference_gloss}`, `candidates ${slice.start + 1}-${slice.end}/${item.candidates.length}`));
    for (const peer of item.approved_peers ?? []) {
      lines.push(compactLine('P', peer.type, peer.relevance, 'text' in peer ? peer.text : `${peer.target_sense_id} ${peer.target_lemma} ${peer.target_pos} ${peer.target_gloss}`));
    }
    for (const candidate of item.candidates.slice(0, slice.start)) lines.push(compactLine('Q', candidate.text, ...compactSavedDecision(candidate.decision, checkpoint)));
    for (const row of rows) lines.push(compactLine(row.alias, row.candidate.text, row.candidate.producers.join(','), row.targets.length ? row.targets.join(',') : '-'));
  }
  return `${lines.join('\n')}\n`;
}

function compactTier(value, where) {
  if (typeof value !== 'string' || !/^[1-9]$/u.test(value)) throw new Error(`${where}: tier must be a single digit 1..9`);
  return Number(value);
}

/**
 * Expand compact decision lines into the exact decision objects `validateDecision` already checks.
 * Grammar problems are collected per line (`errors`, keyed by candidate) instead of stopping at the first one.
 */
function parseCompactDecisions(text, checkpoint, pending) {
  const model = compactChunkModel(checkpoint, pending);
  const byAlias = new Map(model.candidates.map((row) => [row.alias, row]));
  const targetByAlias = new Map([...model.targets.values()].map((target) => [target.alias, target]));
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const errors = [];
  const header = (lines.shift() ?? '').split(/\s+/u);
  if (header.length !== 2 || header[0] !== 'chunk' || header[1] !== pending.chunk_id) {
    errors.push({ alias: null, message: `compact decisions must start with "chunk ${pending.chunk_id}"` });
  }
  const decisions = [];
  for (const line of lines) {
    const [alias, kind, ...fields] = line.split(/\s+/u);
    const row = byAlias.get(alias);
    if (!row) {
      errors.push({ alias: /^c\d+$/u.test(alias) ? alias : null, message: `compact decision "${line}" names no candidate of chunk ${pending.chunk_id}` });
      continue;
    }
    try {
      const base = { source_sense_id: row.item.sense_id, candidate: row.candidate.text };
      if (kind === 'D') {
        decisions.push({ ...base, disposition: 'drop', reason: line.slice(alias.length).trim().slice(kind.length).trim() });
        continue;
      }
      if (kind !== 'R') throw new Error(`${alias}: decision kind must be R or D`);
      const target = (targetAlias) => {
        const found = targetByAlias.get(targetAlias);
        if (!found) throw new Error(`${alias}: unknown target alias ${targetAlias}`);
        return found;
      };
      const [type, tier, ...rest] = fields;
      const relation = { ...base, disposition: 'relation', type, relevance: compactTier(tier, alias) };
      if (rest.length === 0) decisions.push(relation);
      else if (rest.length === 2 && rest[0] === 'none') {
        decisions.push({ ...relation, target_resolution: 'no_exact_match', checked_target_sense_ids: rest[1].split(',').map((name) => target(name).sense_id) });
      } else if (usesSourceMirrorTypeTier(checkpoint) && rest.length === 1) {
        const exact = target(rest[0]);
        decisions.push({ ...relation, target_resolution: 'exact', target_record_id: exact.record_id, target_sense_id: exact.sense_id });
      } else if (!usesSourceMirrorTypeTier(checkpoint) && rest.length === 3) {
        const exact = target(rest[0]);
        decisions.push({ ...relation, target_resolution: 'exact', target_record_id: exact.record_id, target_sense_id: exact.sense_id, reverse_type: rest[1], reverse_relevance: compactTier(rest[2], `${alias} reverse`) });
      } else throw new Error(usesSourceMirrorTypeTier(checkpoint)
        ? `${alias}: exact relations use only T<k>; the CLI derives reverse type/Tier`
        : `${alias}: relation needs 2, 4 or 5 fields after R`);
    } catch (error) {
      errors.push({ alias, message: error.message });
    }
  }
  return { decisions, errors, model };
}

/** The compact rows a candidate may use, given its own same-spelling target aliases. */
function compactHint(row, checkpoint) {
  if (row.targets.length === 0) return `${row.alias} R <type> <tier> | ${row.alias} D x|e`;
  const exact = usesSourceMirrorTypeTier(checkpoint)
    ? `${row.alias} R <type> <tier> T<k>`
    : `${row.alias} R <type> <tier> T<k> <reverse_type> <reverse_tier>`;
  return `${exact} (T<k> one of ${row.targets.join(',')}) | ${row.alias} R <type> <tier> none ${row.targets.join(',')} | ${row.alias} D x|e`;
}

function stableDigest(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function remainingOptionalLinks(checkpoint) {
  return checkpoint.items.flatMap((item) => item.candidates
    .filter((candidate) => candidate.already_accounted === true && candidate.decision?.disposition === 'existing')
    .map((candidate) => {
      const linked = new Set([
        ...candidate.existing_target_sense_ids,
        ...candidate.additional_relations.map((relation) => relation.target_sense_id),
      ]);
      return {
        item,
        candidate,
        existing_target_sense_ids: candidate.existing_target_sense_ids,
        unlinked_target_sense_ids: candidate.unlinked_target_sense_ids.filter((senseId) => !linked.has(senseId)),
      };
    })
    .filter((entry) => entry.unlinked_target_sense_ids.length > 0));
}

function optionalReviewState(checkpoint) {
  const candidates = checkpoint.items.flatMap((item) => item.candidates
    .filter((candidate) => candidate.already_accounted === true)
    .map((candidate) => ({
      source_sense_id: item.sense_id,
      candidate: candidate.text,
      existing_target_sense_ids: candidate.existing_target_sense_ids,
      unlinked_target_sense_ids: candidate.unlinked_target_sense_ids,
      additional_relations: candidate.additional_relations,
    })));
  return usesSourceMirrorTypeTier(checkpoint)
    ? { type_tier_policy: checkpoint.type_tier_policy, candidates }
    : candidates;
}

function optionalReviewDigest(checkpoint) {
  return stableDigest({
    part: [checkpoint.shard, checkpoint.batch, checkpoint.part],
    candidates: optionalReviewState(checkpoint),
  });
}

function assertOptionalComplete(checkpoint) {
  if (checkpoint.optional_review_complete !== true || typeof checkpoint.optional_review_digest !== 'string'
      || !/^[a-f0-9]{64}$/u.test(checkpoint.optional_review_digest)
      || checkpoint.optional_review_state_sha256 !== stableDigest(optionalReviewState(checkpoint))) {
    throw new Error('checkpoint optional-link completion evidence is missing or does not match its saved decisions');
  }
}

function requestedCheckpointCandidates(checkpoint, sourceSenseIds, candidateText = null) {
  const requested = [...new Set(sourceSenseIds)];
  if (requested.length !== sourceSenseIds.length) throw new Error('source sense IDs must not repeat');
  const missing = requested.filter((senseId) => !checkpoint.items.some((item) => item.sense_id === senseId));
  if (missing.length) throw new Error(`checkpoint has no source sense(s): ${missing.join(', ')}`);
  const items = checkpoint.items.filter((item) => requested.includes(item.sense_id));
  const allCandidates = items.flatMap((item) => item.candidates.map((candidate) => ({ item, candidate })));
  const candidates = allCandidates.filter(({ candidate }) => candidateText === null || candidate.text === candidateText);
  if (candidateText !== null && candidates.length === 0) throw new Error(`checkpoint has no candidate ${requested.join(',')}/${candidateText}`);
  return { items, allCandidates, candidates, senseIds: [...requested].sort() };
}

async function selectedCheckpointCandidates(checkpoint, sourceSenseIds, selectPath, root) {
  const selected = requestedCheckpointCandidates(checkpoint, sourceSenseIds);
  if (selectPath === null) return selected;
  let selection;
  try {
    selection = JSON.parse(await readFile(resolveRootPath(root, selectPath), 'utf8'));
  } catch (error) {
    throw new Error(`cannot read --select JSON: ${error.message}`);
  }
  if (!isPlainObject(selection) || keysOf(selection) !== 'candidates' || !Array.isArray(selection.candidates)) {
    throw new Error('--select must contain exactly a candidates array');
  }
  const requested = new Set(selected.senseIds);
  const pairsBySense = new Map();
  const exactPairs = new Set();
  for (const pair of selection.candidates) {
    if (!isPlainObject(pair) || keysOf(pair) !== 'candidate,source_sense_id'
        || typeof pair.source_sense_id !== 'string' || !pair.source_sense_id
        || typeof pair.candidate !== 'string' || !pair.candidate) {
      throw new Error('--select candidates must contain exactly source_sense_id and candidate strings');
    }
    if (!requested.has(pair.source_sense_id)) throw new Error(`--select Sense is outside --source-sense-id: ${pair.source_sense_id}`);
    const key = `${pair.source_sense_id}\u0000${pair.candidate}`;
    if (exactPairs.has(key)) throw new Error(`--select repeats ${pair.source_sense_id}/${pair.candidate}`);
    exactPairs.add(key);
    if (!selected.allCandidates.some(({ item, candidate }) => item.sense_id === pair.source_sense_id && candidate.text === pair.candidate)) {
      throw new Error(`checkpoint has no selected candidate ${pair.source_sense_id}/${pair.candidate}`);
    }
    if (!pairsBySense.has(pair.source_sense_id)) pairsBySense.set(pair.source_sense_id, new Set());
    pairsBySense.get(pair.source_sense_id).add(pair.candidate);
  }
  const candidates = selected.allCandidates.filter(({ item, candidate }) =>
    !pairsBySense.has(item.sense_id) || pairsBySense.get(item.sense_id).has(candidate.text));
  return { ...selected, candidates, selective: true };
}

function inspectDigest(checkpoint, selected) {
  return stableDigest({
    part: [checkpoint.shard, checkpoint.batch, checkpoint.part],
    ...(checkpoint.type_tier_policy ? { type_tier_policy: checkpoint.type_tier_policy } : {}),
    sense_ids: selected.senseIds,
    candidates: selected.allCandidates.map(({ item, candidate }) => ({
      source_sense_id: item.sense_id,
      candidate: candidate.text,
      decision: candidate.decision,
      additional_relations: candidate.additional_relations ?? [],
      optional: candidate.already_accounted === true ? {
        existing_target_sense_ids: candidate.existing_target_sense_ids,
        unlinked_target_sense_ids: candidate.unlinked_target_sense_ids,
      } : null,
    })),
    optional_review_complete: checkpoint.optional_review_complete === true,
    optional_review_digest: checkpoint.optional_review_digest ?? null,
  });
}

function inspectModel(selected) {
  const targets = new Map();
  const aliasByCandidate = new Map();
  for (const [index, { item, candidate }] of (selected.allCandidates ?? selected.candidates).entries()) {
    aliasByCandidate.set(`${item.sense_id}\u0000${candidate.text}`, `c${index + 1}`);
  }
  for (const { item, candidate } of (selected.allCandidates ?? selected.candidates)) {
    for (const target of candidate.same_spelling_targets) {
      for (const sense of target.senses) {
        if (!targets.has(sense.sense_id)) {
          targets.set(sense.sense_id, {
            alias: `T${targets.size + 1}`,
            record_id: target.record_id,
            lemma: target.lemma,
            sense_id: sense.sense_id,
            pos: sense.pos,
            gloss: sense.gloss,
          });
        }
      }
    }
  }
  const candidates = selected.candidates.map(({ item, candidate }) => {
    const targetAliases = [];
    for (const target of candidate.same_spelling_targets) {
      for (const sense of target.senses) {
        targetAliases.push(targets.get(sense.sense_id).alias);
      }
    }
    return { alias: aliasByCandidate.get(`${item.sense_id}\u0000${candidate.text}`), item, candidate, targetAliases };
  });
  return { candidates, targets };
}

function targetAliasFor(targets, senseId) {
  const target = targets.get(senseId);
  if (!target) throw new Error(`inspect context has no target sense ${senseId}`);
  return target.alias;
}

function compactCurrentDecision(row, model, checkpoint) {
  const { candidate } = row;
  const decision = candidate.decision;
  if (decision === null) return `# current ${row.alias}: pending`;
  if (decision.disposition === 'existing') {
    const optional = candidate.additional_relations.map((relation) => {
      const target = targetAliasFor(model.targets, relation.target_sense_id);
      return usesSourceMirrorTypeTier(checkpoint)
        ? `R ${relation.type} ${relation.relevance} ${target}`
        : `R ${relation.type} ${relation.relevance} ${target} ${relation.reverse_type} ${relation.reverse_relevance}`;
    });
    return `# current ${row.alias}: existing${optional.length ? `; optional ${optional.join(' | ')}` : ''}`;
  }
  if (decision.disposition === 'drop') return `# current ${row.alias}: D ${decision.reason}`;
  if (decision.target_resolution === 'exact') {
    const exact = `# current ${row.alias}: R ${decision.type} ${decision.relevance} ${targetAliasFor(model.targets, decision.target_sense_id)}`;
    return usesSourceMirrorTypeTier(checkpoint) ? exact : `${exact} ${decision.reverse_type} ${decision.reverse_relevance}`;
  }
  if (decision.target_resolution === 'no_exact_match') {
    const checked = decision.checked_target_sense_ids.map((senseId) => targetAliasFor(model.targets, senseId));
    return `# current ${row.alias}: R ${decision.type} ${decision.relevance} none ${checked.join(',')}`;
  }
  return `# current ${row.alias}: R ${decision.type} ${decision.relevance}`;
}

function renderInspect(checkpoint, selected, digest, page, pageSize) {
  const model = inspectModel(selected);
  const totalPages = Math.max(1, Math.ceil(model.candidates.length / pageSize));
  if (page > totalPages) throw new Error(`inspect page ${page} is outside 1..${totalPages}`);
  const rows = model.candidates.slice((page - 1) * pageSize, page * pageSize);
  const usedTargets = new Set(rows.flatMap((row) => row.targetAliases));
  const lines = [
    `inspect ${selected.senseIds.join(',')} @${digest}`,
    `# shard ${checkpoint.shard} batch ${checkpoint.batch} part ${checkpoint.part} · page ${page}/${totalPages} · candidates ${rows.length}/${model.candidates.length}`,
    `# optional_review_complete ${checkpoint.optional_review_complete === true}`,
    '# T<k> target_sense_id target_record_id lemma pos full_gloss',
    ...[...model.targets.values()].filter((target) => usedTargets.has(target.alias)
      || rows.some((row) => row.candidate.decision?.target_sense_id === target.sense_id
        || row.candidate.decision?.checked_target_sense_ids?.includes(target.sense_id)
        || row.candidate.additional_relations?.some((relation) => relation.target_sense_id === target.sense_id)))
      .map((target) => [target.alias, target.sense_id, target.record_id, target.lemma, target.pos, target.gloss].map(compactField).join('\t')),
  ];
  let lastSenseId = null;
  for (const row of rows) {
    if (row.item.sense_id !== lastSenseId) {
      lastSenseId = row.item.sense_id;
      lines.push('', ['S', row.item.sense_id, row.item.record_id, row.item.lemma, row.item.pos,
        row.item.reference_gloss === undefined ? row.item.gloss : `${row.item.gloss} ⇒ ${row.item.reference_gloss}`].map(compactField).join('\t'));
      for (const peer of row.item.approved_peers ?? []) {
        lines.push(['P', peer.type, peer.relevance, 'text' in peer ? peer.text
          : `${peer.target_sense_id} ${peer.target_lemma} ${peer.target_pos} ${peer.target_gloss}`].map(compactField).join('\t'));
      }
    }
    lines.push([row.alias, row.candidate.text, row.candidate.producers.join(','), row.targetAliases.join(',') || '-'].map(compactField).join('\t'));
    lines.push(compactCurrentDecision(row, model, checkpoint));
  }
  return `${lines.join('\n')}\n`;
}

function compactReviewSummary(row) {
  const decision = row.candidate.decision;
  if (decision === null) return ['pending', '-'];
  if (decision.disposition === 'drop') return ['D'];
  if (decision.disposition === 'relation') {
    const group = ['near', 'mood'].includes(decision.type) ? '말의 결' : '연상';
    return [`${decision.type}/${decision.relevance}`, group];
  }
  if (decision.disposition === 'existing') {
    const targetIds = new Set(row.candidate.same_spelling_targets.flatMap((target) => target.senses.map((sense) => sense.sense_id)));
    const peers = [...new Map((row.item.approved_peers ?? [])
      .filter((peer) => (peer.target_sense_id && targetIds.has(peer.target_sense_id)) || peer.text === row.candidate.text)
      .map((peer) => [`${peer.type}\u0000${peer.relevance}`, [peer.type, peer.relevance]])).values()];
    if (peers.length) return peers.sort(([leftType, leftTier], [rightType, rightTier]) =>
      leftType.localeCompare(rightType) || leftTier - rightTier)
      .map(([type, tier]) => `${type}/${tier} ${['near', 'mood'].includes(type) ? '말의 결' : '연상'}`).join('; ');
    return ['existing', '-'];
  }
  return ['pending', '-'];
}

function selectedInspectDetailPage(checkpoint, selected, digest, rows, page, totalPages) {
  const model = inspectModel({ ...selected, candidates: rows });
  const usedTargets = new Set(rows.flatMap((row) => row.targetAliases));
  const lines = [
    `inspect ${selected.senseIds.join(',')} @${digest}`,
    `# shard ${checkpoint.shard} batch ${checkpoint.batch} part ${checkpoint.part} · page ${page}/${totalPages} · candidates ${rows.length}/${selected.candidates.length}`,
    '# optional_review_complete ' + (checkpoint.optional_review_complete === true),
    '# T<k> target_sense_id target_record_id lemma pos full_gloss',
    ...[...model.targets.values()].filter((target) => usedTargets.has(target.alias)
      || rows.some((row) => row.candidate.decision?.target_sense_id === target.sense_id
        || row.candidate.decision?.checked_target_sense_ids?.includes(target.sense_id)
        || row.candidate.additional_relations?.some((relation) => relation.target_sense_id === target.sense_id)))
      .map((target) => [target.alias, target.sense_id, target.record_id, target.lemma, target.pos, target.gloss].map(compactField).join('\t')),
  ];
  let lastSenseId = null;
  for (const row of model.candidates) {
    if (row.item.sense_id !== lastSenseId) {
      lastSenseId = row.item.sense_id;
      lines.push('', ['S', row.item.sense_id, row.item.record_id, row.item.lemma, row.item.pos,
        row.item.reference_gloss === undefined ? row.item.gloss : `${row.item.gloss} ⇒ ${row.item.reference_gloss}`].map(compactField).join('\t'));
      for (const peer of row.item.approved_peers ?? []) {
        lines.push(['P', peer.type, peer.relevance, 'text' in peer ? peer.text
          : `${peer.target_sense_id} ${peer.target_lemma} ${peer.target_pos} ${peer.target_gloss}`].map(compactField).join('\t'));
      }
    }
    lines.push([row.alias, row.candidate.text, row.candidate.producers.join(','), row.targetAliases.join(',') || '-'].map(compactField).join('\t'));
    lines.push(compactCurrentDecision(row, model, checkpoint));
  }
  return `${lines.join('\n')}\n`;
}

function selectedInspectQPage(checkpoint, senseIds, digest, rows, page, totalPages, pageIndex, totalRows) {
  const lines = [
    `inspect ${senseIds.join(',')} @${digest}`,
    `# shard ${checkpoint.shard} batch ${checkpoint.batch} part ${checkpoint.part} · page ${page}/${totalPages} · Q summary ${pageIndex}/${totalRows}`,
    '# Q<candidate alias> candidate type/tier UI-group | Drop',
    ...rows.map((row) => ['Q', row.alias, row.candidate.text, ...compactReviewSummary(row)].map(compactField).join('\t')),
  ];
  return `${lines.join('\n')}\n`;
}

function selectedInspectPages(checkpoint, selected, digest, pageSize) {
  const fullModel = inspectModel({ ...selected, candidates: selected.allCandidates });
  const detailedKeys = new Set(selected.candidates.map(({ item, candidate }) => `${item.sense_id}\u0000${candidate.text}`));
  const qRows = fullModel.candidates.filter(({ item, candidate }) => !detailedKeys.has(`${item.sense_id}\u0000${candidate.text}`));
  const detailPages = [];
  for (let offset = 0; offset < selected.candidates.length; offset += pageSize) {
    detailPages.push(selected.candidates.slice(offset, offset + pageSize));
  }
  const qPages = [];
  let offset = 0;
  while (offset < qRows.length) {
    const pageRows = [];
    while (offset < qRows.length) {
      const candidateRows = [...pageRows, qRows[offset]];
      const candidatePage = selectedInspectQPage(checkpoint, selected.senseIds, digest, candidateRows,
        999999, 999999, qPages.length + 1, qRows.length);
      if (Buffer.byteLength(candidatePage, 'utf8') > INSPECT_PAGE_MAX_BYTES || candidatePage.length > INSPECT_PAGE_MAX_CHARS) break;
      pageRows.push(qRows[offset]);
      offset += 1;
    }
    if (!pageRows.length) throw new Error('one inspect Q summary row exceeds its output limit; use the full-sense inspect path');
    qPages.push(pageRows);
  }
  if (detailPages.length === 0) throw new Error('inspect selection contains no detailed candidates');
  const totalPages = detailPages.length + qPages.length;
  const pages = detailPages.map((rows, index) => selectedInspectDetailPage(checkpoint, selected, digest, rows, index + 1, totalPages));
  for (let index = 0; index < qPages.length; index += 1) {
    pages.push(selectedInspectQPage(checkpoint, selected.senseIds, digest, qPages[index], detailPages.length + index + 1,
      totalPages, index + 1, qRows.length));
  }
  pages.forEach((pageText) => assertBoundedInspectPage(pageText, 'inspect'));
  return pages;
}

async function inspectSelectedCheckpoint(checkpoint, out, root, selected, digest, page, pageSize) {
  let pages;
  try {
    pages = selectedInspectPages(checkpoint, selected, digest, pageSize);
  } catch (error) {
    if (String(error.message).includes('page exceeds its output limit') ||
        String(error.message).includes('one inspect Q summary row exceeds its output limit')) {
      pages = partitionInspectLines(checkpoint, selected, digest, pageSize);
    } else {
      throw error;
    }
  }
  if (page > pages.length) throw new Error(`inspect page ${page} is outside 1..${pages.length}`);
  const text = pages[page - 1];
  await writeOutput(out, root, text);
  return { digest, page, total_pages: pages.length, text };
}

function optionalDigest(checkpoint, links = remainingOptionalLinks(checkpoint)) {
  return stableDigest({
    part: [checkpoint.shard, checkpoint.batch, checkpoint.part],
    ...(checkpoint.type_tier_policy ? { type_tier_policy: checkpoint.type_tier_policy } : {}),
    optional_review_complete: checkpoint.optional_review_complete === true,
    links: links.map(({ item, candidate, existing_target_sense_ids, unlinked_target_sense_ids }) => ({
      source_sense_id: item.sense_id,
      candidate: candidate.text,
      existing_target_sense_ids,
      unlinked_target_sense_ids,
      additional_relations: candidate.additional_relations,
    })),
  });
}

function optionalModel(links) {
  const candidates = links.map(({ item, candidate }) => ({ item, candidate }));
  return inspectModel({ candidates, allCandidates: candidates, senseIds: [] });
}

function renderOptional(checkpoint, links, digest, page, pageSize) {
  const model = optionalModel(links);
  const totalPages = Math.max(1, Math.ceil(model.candidates.length / pageSize));
  if (page > totalPages) throw new Error(`optional page ${page} is outside 1..${totalPages}`);
  const rows = model.candidates.slice((page - 1) * pageSize, page * pageSize);
  const linksByCandidate = new Map(links.map((entry) => [`${entry.item.sense_id}\u0000${entry.candidate.text}`, entry]));
  const usedTargets = new Set(rows.flatMap((row) => row.targetAliases));
  const targetLines = [...model.targets.values()].filter((target) => usedTargets.has(target.alias))
    .map((target) => [target.alias, target.sense_id, target.record_id, target.lemma, target.pos, target.gloss].map(compactField).join('\t'));
  const lines = [
    `links @${digest}`,
    `# shard ${checkpoint.shard} batch ${checkpoint.batch} part ${checkpoint.part} · page ${page}/${totalPages} · optional candidates ${rows.length}/${model.candidates.length}`,
    '# T<k> target_sense_id target_record_id lemma pos full_gloss',
    '# S source_sense_id record_id lemma pos full_gloss',
    '# c<n> candidate unlinked target aliases',
    usesSourceMirrorTypeTier(checkpoint)
      ? '# answer each candidate once: c<n> skip OR one or more c<n> R <type> <tier> T<k> (reverse type/Tier are derived by the CLI)'
      : '# answer each candidate once: c<n> skip OR one or more c<n> R <type> <tier> T<k> <reverse_type> <reverse_tier>',
    ...targetLines,
  ];
  for (const row of rows) {
    if (!lines.some((line) => line.startsWith(`S\t${row.item.sense_id}\t`))) {
      lines.push('', ['S', row.item.sense_id, row.item.record_id, row.item.lemma, row.item.pos,
        row.item.reference_gloss === undefined ? row.item.gloss : `${row.item.gloss} ⇒ ${row.item.reference_gloss}`].map(compactField).join('\t'));
    }
    const entry = linksByCandidate.get(`${row.item.sense_id}\u0000${row.candidate.text}`);
    const available = new Set(entry.unlinked_target_sense_ids);
    const linked = [...entry.existing_target_sense_ids, ...entry.candidate.additional_relations.map((relation) => relation.target_sense_id)];
    lines.push([row.alias, row.candidate.text,
      'unlinked=' + [...available].map((senseId) => targetAliasFor(model.targets, senseId)).join(','),
      'linked=' + [...new Set(linked)].map((senseId) => targetAliasFor(model.targets, senseId)).join(',')].map(compactField).join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

async function writeOutput(out, root, text) {
  if (out) await writeTextAtomically(resolveRootPath(root, out), text);
  else console.log(text.trimEnd());
}

function assertBoundedInspectPage(text, label) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > INSPECT_PAGE_MAX_BYTES || text.length > INSPECT_PAGE_MAX_CHARS) {
    throw new Error(`${label} page exceeds its output limit (${bytes} bytes, ${text.length} characters); retry with a smaller --page-size`);
  }
}

// Oversized context is partitioned into complete rows, never truncated. Each page
// belongs to the same inspection snapshot and retains its original aliases.
function partitionInspectLines(checkpoint, selected, digest) {
  const model = inspectModel(selected);
  const lines = [];
  const seenTargets = new Set();
  const seenSenses = new Set();
  for (const row of model.candidates) {
    const text = selectedInspectDetailPage(checkpoint, selected, digest, [row], 1, 1);
    let includePeers = false;
    for (const line of text.split('\n').slice(4)) {
      if (!line) continue;
      if (/^T\d+\t/u.test(line)) {
        const alias = line.split('\t', 1)[0];
        if (seenTargets.has(alias)) continue;
        seenTargets.add(alias);
      } else if (line.startsWith('S\t')) {
        const sense = line.split('\t')[1];
        includePeers = !seenSenses.has(sense);
        if (!includePeers) continue;
        seenSenses.add(sense);
      } else if (line.startsWith('P\t') && !includePeers) continue;
      lines.push(line);
    }
  }
  if (selected.selective) {
    const keys = new Set(selected.candidates.map(({ item, candidate }) => `${item.sense_id}\u0000${candidate.text}`));
    for (const row of inspectModel({ ...selected, candidates: selected.allCandidates }).candidates) {
      if (!keys.has(`${row.item.sense_id}\u0000${row.candidate.text}`)) {
        lines.push(['Q', row.alias, row.candidate.text, ...compactReviewSummary(row)].map(compactField).join('\t'));
      }
    }
  }
  const header = (page, total) => `inspect ${selected.senseIds.join(',')} @${digest}\n` +
    `# shard ${checkpoint.shard} batch ${checkpoint.batch} part ${checkpoint.part} · page ${page}/${total} · context fragments\n` +
    `# optional_review_complete ${checkpoint.optional_review_complete === true}\n` +
    '# F row-id part/total JSON-string: concatenate decoded fragments to reconstruct the complete row\n';
  const boundedLines = [];
  for (const [index, line] of lines.entries()) {
    const single = header(999999, 999999) + line + '\n';
    if (Buffer.byteLength(single, 'utf8') <= INSPECT_PAGE_MAX_BYTES && single.length <= INSPECT_PAGE_MAX_CHARS) {
      boundedLines.push(line);
    } else {
      const chars = Array.from(line);
      const count = Math.ceil(chars.length / 4000);
      for (let i = 0; i < count; i += 1) {
        boundedLines.push(`F\t${index + 1}\t${i + 1}/${count}\t${JSON.stringify(chars.slice(i * 4000, (i + 1) * 4000).join(''))}`);
      }
    }
  }
  const groups = [[]];
  for (const line of boundedLines) {
    let group = groups.at(-1);
    let text = header(999999, 999999) + [...group, line].join('\n') + '\n';
    if (Buffer.byteLength(text, 'utf8') > INSPECT_PAGE_MAX_BYTES || text.length > INSPECT_PAGE_MAX_CHARS) {
      if (!group.length) throw new Error('inspect context row exceeds output limit and cannot be partitioned');
      group = []; groups.push(group);
      text = header(999999, 999999) + line + '\n';
      if (Buffer.byteLength(text, 'utf8') > INSPECT_PAGE_MAX_BYTES || text.length > INSPECT_PAGE_MAX_CHARS) {
        throw new Error('inspect context row exceeds output limit and cannot be partitioned');
      }
    }
    group.push(line);
  }
  return groups.map((group, i) => header(i + 1, groups.length) + group.join('\n') + '\n');
}

function assertPrimaryComplete(checkpoint) {
  if (!checkpoint.complete) throw new Error('Stage 1 inputs are incomplete for this Part');
  if (checkpoint.pending_chunk) throw new Error(`save the active chunk ${checkpoint.pending_chunk.chunk_id} first`);
  if (checkpoint.items.some((item) => item.candidates.some((candidate) => candidate.decision === null))) {
    throw new Error(`primary decisions are incomplete: ${checkpointProgress(checkpoint)}`);
  }
}

// A conservative per-page bound, calculated from individual values rather than
// rendering or serializing every page. Shared objects (notably peers) are
// measured once. Overestimates only choose the lossless fragmented path.
function inspectNeedsPartition(checkpoint, selected, model, pageSize) {
  const cache = new WeakMap();
  function size(value) {
    if (value === undefined) return [0, 0];
    if (value === null || typeof value !== 'object') {
      const text = JSON.stringify(value);
      return [Buffer.byteLength(text, 'utf8'), text.length];
    }
    if (cache.has(value)) return cache.get(value);
    let bytes = 2; let chars = 2;
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      const [b, c] = size(child);
      const name = Array.isArray(value) ? '' : JSON.stringify(key) + ':';
      bytes += Buffer.byteLength(name, 'utf8') + b + 1;
      chars += name.length + c + 1;
    }
    const result = [bytes, chars];
    cache.set(value, result);
    return result;
  }
  const scope = size([checkpoint.shard, checkpoint.batch, checkpoint.part, selected.senseIds, 'x'.repeat(64)]);
  let bytes = scope[0] + 1024; let chars = scope[1] + 1024;
  for (const [index, row] of model.candidates.entries()) {
    if (index && index % pageSize === 0) { bytes = scope[0] + 1024; chars = scope[1] + 1024; }
    const item = row.item;
    const source = size([item.sense_id, item.record_id, item.lemma, item.pos, item.gloss,
      item.reference_gloss, item.approved_peers ?? []]);
    const candidate = size(row.candidate);
    const aliasAllowance = 256 + row.targetAliases.length * 32;
    bytes += source[0] + candidate[0] + aliasAllowance;
    chars += source[1] + candidate[1] + aliasAllowance;
    if (bytes > INSPECT_PAGE_MAX_BYTES || chars > INSPECT_PAGE_MAX_CHARS) return true;
  }
  return false;
}

function inspectJsonItem(checkpoint, row) {
  return {
    alias: row.alias, source_sense_id: row.item.sense_id, source_record_id: row.item.record_id,
    lemma: row.item.lemma, pos: row.item.pos, gloss: row.item.gloss,
    ...(row.item.reference_gloss === undefined ? {} : { reference_gloss: row.item.reference_gloss }),
    approved_peers: row.item.approved_peers ?? [], candidate: row.candidate.text,
    producers: row.candidate.producers, same_spelling_targets: row.candidate.same_spelling_targets,
    decision: presentedDecision(checkpoint, row.candidate.decision),
    additional_relations: (row.candidate.additional_relations ?? []).map((decision) => presentedDecision(checkpoint, decision)),
    ...(row.candidate.already_accounted === true ? {
      already_accounted: true, existing_target_sense_ids: row.candidate.existing_target_sense_ids,
      unlinked_target_sense_ids: row.candidate.unlinked_target_sense_ids,
    } : {}),
  };
}

async function inspectCheckpoint(checkpoint, out, root, sourceSenseIds, candidateText, selectPath, format, page, pageSize) {
  const selected = selectPath === null
    ? requestedCheckpointCandidates(checkpoint, sourceSenseIds, candidateText)
    : await selectedCheckpointCandidates(checkpoint, sourceSenseIds, selectPath, root);
  const digest = inspectDigest(checkpoint, selected);
  if (selected.selective && format === 'compact') {
    return inspectSelectedCheckpoint(checkpoint, out, root, selected, digest, page, pageSize);
  }
  const model = inspectModel(selected);
  let totalPages = Math.max(1, Math.ceil(model.candidates.length / pageSize));
  const oversized = inspectNeedsPartition(checkpoint, selected, model, pageSize);
  if (format === 'compact') {
    if (oversized) {
      const pages = partitionInspectLines(checkpoint, selected, digest, pageSize);
      totalPages = pages.length;
      if (page > totalPages) throw new Error(`inspect page ${page} is outside 1..${totalPages}`);
      const text = pages[page - 1];
      await writeOutput(out, root, text);
      return { digest, page, total_pages: totalPages, text };
    }
  }
  if (format === 'compact') {
    if (page > totalPages) throw new Error(`inspect page ${page} is outside 1..${totalPages}`);
    const text = renderInspect(checkpoint, selected, digest, page, pageSize);
    assertBoundedInspectPage(text, 'inspect');
    await writeOutput(out, root, text);
    return { digest, page, total_pages: totalPages, text };
  }
  const payload = {
    inspect: true,
    shard: checkpoint.shard,
    batch: checkpoint.batch,
    part: checkpoint.part,
    source_sense_ids: selected.senseIds,
    digest,
    page,
    total_pages: totalPages,
    total_candidates: model.candidates.length,
    optional_review_complete: checkpoint.optional_review_complete === true,
    items: oversized ? [] : model.candidates.slice((page - 1) * pageSize, page * pageSize)
      .map((row) => inspectJsonItem(checkpoint, row)),
  };
  // The normal JSON shape remains unchanged for small views. For an oversized
  // view, concatenate `json_fragment` in page order and parse it as JSON.
  if (oversized) {
    const complete = JSON.stringify({ ...payload, page: 1, total_pages: 1,
      items: model.candidates.map((row) => inspectJsonItem(checkpoint, row)) });
    const chars = Array.from(complete);
    const fragments = [];
    // At most six JSON characters per code point, even for escaped controls.
    for (let i = 0; i < chars.length; i += 4000) fragments.push(chars.slice(i, i + 4000).join(''));
    if (page > fragments.length) throw new Error(`inspect page ${page} is outside 1..${fragments.length}`);
    const result = { inspect: true, digest, page, total_pages: fragments.length, json_fragment: fragments[page - 1] };
    const text = `${JSON.stringify(result)}\n`;
    assertBoundedInspectPage(text, 'inspect');
    await writeOutput(out, root, text);
    return result;
  }
  if (page > totalPages) throw new Error(`inspect page ${page} is outside 1..${totalPages}`);
  const text = `${JSON.stringify(payload)}\n`;
  assertBoundedInspectPage(text, 'inspect');
  await writeOutput(out, root, text);
  return payload;
}

async function readOptional(checkpoint, out, root, format, page, pageSize) {
  assertPrimaryComplete(checkpoint);
  if (checkpoint.merged) throw new Error('cannot read optional links after the Part has merged');
  if (checkpoint.optional_review_complete === true) assertOptionalComplete(checkpoint);
  const links = remainingOptionalLinks(checkpoint);
  const digest = optionalDigest(checkpoint, links);
  const model = optionalModel(links);
  const totalPages = Math.max(1, Math.ceil(model.candidates.length / pageSize));
  if (page > totalPages) throw new Error(`optional page ${page} is outside 1..${totalPages}`);
  if (format === 'compact') {
    const text = links.length === 0
      ? `# no optional links · ${checkpoint.shard}/${checkpoint.batch}/${checkpoint.part} · ${checkpoint.optional_review_complete === true ? 'complete' : 'review required'}\nlinks @${digest}\n`
      : renderOptional(checkpoint, links, digest, page, pageSize);
    assertBoundedInspectPage(text, 'optional-link');
    await writeOutput(out, root, text);
    return { complete: true, optional_review_complete: checkpoint.optional_review_complete === true,
      shard: checkpoint.shard, batch: checkpoint.batch, part: checkpoint.part, digest, page, total_pages: totalPages,
      links: links.length, text };
  }
  const pageEntries = model.candidates.slice((page - 1) * pageSize, page * pageSize).map((row) => {
    const entry = links.find((link) => link.item.sense_id === row.item.sense_id && link.candidate.text === row.candidate.text);
    return {
      alias: row.alias,
      source_sense_id: row.item.sense_id,
      source_record_id: row.item.record_id,
      lemma: row.item.lemma,
      pos: row.item.pos,
      gloss: row.item.gloss,
      ...(row.item.reference_gloss === undefined ? {} : { reference_gloss: row.item.reference_gloss }),
      candidate: row.candidate.text,
      existing_target_sense_ids: entry.existing_target_sense_ids,
      additional_relations: row.candidate.additional_relations.map((decision) => presentedDecision(checkpoint, decision)),
      unlinked_target_sense_ids: entry.unlinked_target_sense_ids,
      same_spelling_targets: row.candidate.same_spelling_targets,
    };
  });
  const payload = {
    complete: true,
    optional_review_complete: checkpoint.optional_review_complete === true,
    shard: checkpoint.shard,
    batch: checkpoint.batch,
    part: checkpoint.part,
    digest,
    page,
    total_pages: totalPages,
    total_candidates: model.candidates.length,
    links: pageEntries,
  };
  const text = `${JSON.stringify(payload)}\n`;
  assertBoundedInspectPage(text, 'optional-link');
  await writeOutput(out, root, text);
  return payload;
}

async function completeOptional(checkpoint, checkpointPath) {
  assertPrimaryComplete(checkpoint);
  if (checkpoint.merged) throw new Error('cannot mark optional links complete after the Part has merged');
  if (checkpoint.optional_review_complete === true) {
    assertOptionalComplete(checkpoint);
    return { optional_review_complete: true, already_complete: true, checkpoint: checkpointPath };
  }
  const links = remainingOptionalLinks(checkpoint);
  if (links.length > 0) throw new Error(`optional-link review still has ${links.length} candidate(s); use save-optional`);
  checkpoint.optional_review_digest = optionalDigest(checkpoint, links);
  checkpoint.optional_review_state_sha256 = stableDigest(optionalReviewState(checkpoint));
  checkpoint.optional_review_complete = true;
  await writeJsonAtomically(checkpointPath, checkpoint);
  return { optional_review_complete: true, links: 0, checkpoint: checkpointPath };
}

function parseOptionalDecisions(text, checkpoint, links, digest) {
  const model = optionalModel(links);
  const byAlias = new Map(model.candidates.map((row) => [row.alias, row]));
  const targetByAlias = new Map([...model.targets.values()].map((target) => [target.alias, target]));
  const meaningful = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const errors = [];
  const header = (meaningful.shift() ?? '').split(/\s+/u);
  if (header.length !== 2 || header[0] !== 'links' || header[1] !== `@${digest}`) {
    errors.push(`optional decisions must start with "links @${digest}"`);
  }
  const decisions = new Map();
  for (const line of meaningful) {
    const [alias, kind, ...fields] = line.split(/\s+/u);
    const row = byAlias.get(alias);
    if (!row) { errors.push(`${alias}: names no optional candidate`); continue; }
    const current = decisions.get(alias) ?? { skip: false, relations: [] };
    try {
      if (kind === 'skip' && fields.length === 0) {
        if (current.skip || current.relations.length) throw new Error('skip cannot repeat or mix with Relation rows');
        current.skip = true;
      } else if (kind === 'R' && (usesSourceMirrorTypeTier(checkpoint) ? fields.length === 3 : fields.length === 5)) {
        if (current.skip) throw new Error('skip cannot mix with Relation rows');
        const [type, tierText, targetAlias, reverseType, reverseTierText] = fields;
        const target = targetByAlias.get(targetAlias);
        if (!target) throw new Error(`unknown target alias ${targetAlias}`);
        const relation = normalizeInputDecision(checkpoint, {
          source_sense_id: row.item.sense_id,
          candidate: row.candidate.text,
          disposition: 'relation',
          target_resolution: 'exact',
          target_record_id: target.record_id,
          target_sense_id: target.sense_id,
          type,
          relevance: compactTier(tierText, alias),
          ...(!usesSourceMirrorTypeTier(checkpoint) ? {
            reverse_type: reverseType,
            reverse_relevance: compactTier(reverseTierText, `${alias} reverse`),
          } : {}),
        });
        if (current.relations.some((saved) => saved.target_sense_id === target.sense_id)) throw new Error(`repeats target ${target.sense_id}`);
        validateDecision(row.item, { ...row.candidate, additional_relations: [...row.candidate.additional_relations, ...current.relations] }, relation);
        current.relations.push(relation);
      } else throw new Error(usesSourceMirrorTypeTier(checkpoint)
        ? 'use skip or R <type> <tier> T<k>; the CLI derives reverse type/Tier'
        : 'use skip or R <type> <tier> T<k> <reverse_type> <reverse_tier>');
      decisions.set(alias, current);
    } catch (error) { errors.push(`${alias}: ${error.message}`); }
  }
  for (const row of model.candidates) {
    const decision = decisions.get(row.alias);
    if (!decision) errors.push(`${row.alias}: missing optional candidate decision`);
    else if (decision.skip && decision.relations.length) errors.push(`${row.alias}: skip cannot mix with Relation rows`);
  }
  return { errors, decisions, model };
}

async function saveOptional(checkpoint, checkpointPath, inputPath, root) {
  assertPrimaryComplete(checkpoint);
  if (checkpoint.merged) throw new Error('cannot save optional links after the Part has merged');
  if (checkpoint.optional_review_complete === true) throw new Error('optional-link review is already complete');
  const links = remainingOptionalLinks(checkpoint);
  if (links.length === 0) throw new Error('there are no optional links to save; use complete-optional');
  const digest = optionalDigest(checkpoint, links);
  let raw;
  try { raw = await readFile(resolveRootPath(root, inputPath), 'utf8'); }
  catch (error) { throw new Error(`cannot read optional-link decisions: ${error.message}`); }
  const parsed = parseOptionalDecisions(raw, checkpoint, links, digest);
  if (parsed.errors.length) throw new Error(`optional links not saved, checkpoint unchanged: ${parsed.errors.length} problem(s)\n${parsed.errors.join('\n')}`);
  for (const row of parsed.model.candidates) {
    const decision = parsed.decisions.get(row.alias);
    row.candidate.additional_relations.push(...decision.relations);
  }
  checkpoint.optional_review_digest = digest;
  checkpoint.optional_review_complete = true;
  checkpoint.optional_review_state_sha256 = stableDigest(optionalReviewState(checkpoint));
  await writeJsonAtomically(checkpointPath, checkpoint);
  return { optional_review_complete: true, optional_links_saved: [...parsed.decisions.values()].reduce((sum, value) => sum + value.relations.length, 0),
    optional_candidates: parsed.decisions.size, checkpoint: checkpointPath };
}

async function cancelRevision(checkpoint, checkpointPath, chunkId) {
  if (!chunkId) throw new Error('cancel-revision requires --chunk-id');
  if (checkpoint.merged || !checkpoint.pending_chunk || checkpoint.pending_chunk.revision !== true
      || checkpoint.pending_chunk.chunk_id !== chunkId) {
    throw new Error(`cannot cancel revision ${chunkId}: it must exactly match an active unmerged revision chunk`);
  }
  checkpoint.pending_chunk = null;
  await writeJsonAtomically(checkpointPath, checkpoint);
  return { canceled: chunkId, next_chunk_number: checkpoint.next_chunk_number, checkpoint: checkpointPath };
}

async function readChunk(checkpoint, checkpointPath, maxCandidates, out, root, sourceSenseId = null, candidateText = null, format = 'json',
                          optional = false, page = 1, pageSize = INSPECT_PAGE_SIZE) {
  if (optional) return readOptional(checkpoint, out, root, format, page, pageSize);
  await assertNoOpenTaskPlan(checkpointPath);
  let pending = checkpoint.pending_chunk;
  if (format === 'compact' && pending?.revision === true) throw new Error(`active chunk ${pending.chunk_id} is a revision; read it as JSON`);
  if (sourceSenseId !== null) {
    if (checkpoint.merged) throw new Error('cannot revise a decision after the Part checkpoint has merged');
    if (pending) {
      const item = checkpoint.items.find((entry) => entry.sense_id === sourceSenseId);
      const candidateIndex = item?.candidates.findIndex((candidate) => candidate.text === candidateText) ?? -1;
      if (pending.revision !== true || pending.slices.length !== 1
          || pending.slices[0].sense_id !== sourceSenseId || pending.slices[0].start !== candidateIndex) {
        throw new Error(`checkpoint already has an active chunk ${pending.chunk_id}; save it before opening a revision`);
      }
    } else {
      const item = checkpoint.items.find((entry) => entry.sense_id === sourceSenseId);
      const candidateIndex = item?.candidates.findIndex((candidate) => candidate.text === candidateText) ?? -1;
      if (!item || candidateIndex < 0) throw new Error(`checkpoint has no candidate ${sourceSenseId}/${candidateText}`);
      const candidate = item.candidates[candidateIndex];
      if (candidate.decision === null) throw new Error(`${sourceSenseId}/${candidateText} has no saved decision to revise`);
      const chunkNumber = String(checkpoint.next_chunk_number).padStart(3, '0');
      pending = {
        chunk_id: `${checkpoint.shard}-${checkpoint.batch}-${checkpoint.part}-${chunkNumber}`,
        candidate_count: 1,
        revision: true,
        slices: [{ sense_id: sourceSenseId, start: candidateIndex, end: candidateIndex + 1 }],
      };
      checkpoint.pending_chunk = pending;
      await writeJsonAtomically(checkpointPath, checkpoint);
    }
  }
  if (!pending) {
    let remaining = maxCandidates;
    const slices = [];
    for (const item of checkpoint.items) {
      const start = item.candidates.findIndex((candidate) => candidate.decision === null);
      if (start === -1) continue;
      const unresolvedCount = item.candidates.length - start;
      if (unresolvedCount > remaining) {
        if (slices.length > 0) break;
        if (unresolvedCount > maxCandidates) {
          slices.push({ sense_id: item.sense_id, start, end: start + maxCandidates });
          remaining = 0;
          break;
        }
      }
      slices.push({ sense_id: item.sense_id, start, end: item.candidates.length });
      remaining -= unresolvedCount;
      if (remaining <= 0) break;
    }
    if (slices.length === 0) {
      const optionalLinks = checkpoint.merged ? [] : checkpoint.items.flatMap((item) => item.candidates
        .filter((candidate) => candidate.already_accounted === true && candidate.decision.disposition === 'existing')
        .map((candidate) => {
          const additionalTargetSenseIds = new Set(candidate.additional_relations.map((relation) => relation.target_sense_id));
          return {
            source_sense_id: item.sense_id,
            candidate: candidate.text,
            existing_target_sense_ids: candidate.existing_target_sense_ids,
            unlinked_target_sense_ids: candidate.unlinked_target_sense_ids.filter((senseId) => !additionalTargetSenseIds.has(senseId)),
          };
        })
        .filter((candidate) => candidate.unlinked_target_sense_ids.length > 0));
      const complete = { complete: true, shard: checkpoint.shard, batch: checkpoint.batch, part: checkpoint.part, ...checkpointProgressPayload(checkpoint), optional_links: optionalLinks, items: [] };
      if (format === 'compact') {
        // optional_links stay a JSON finalize-phase concern; the compact view only says no primary chunk remains.
        const text = `# complete: no primary chunk remains (${complete.decided}/${complete.total} decided)\n`;
        if (out) await writeTextAtomically(resolveRootPath(root, out), text);
        else console.log(text.trimEnd());
        return { ...complete, text };
      }
      if (out) await writeJsonAtomically(resolveRootPath(root, out), complete);
      else console.log(JSON.stringify(complete));
      return complete;
    }
    const candidateCount = slices.reduce((sum, slice) => sum + slice.end - slice.start, 0);
    const chunkNumber = String(checkpoint.next_chunk_number).padStart(3, '0');
    pending = { chunk_id: `${checkpoint.shard}-${checkpoint.batch}-${checkpoint.part}-${chunkNumber}`, candidate_count: candidateCount, slices };
    checkpoint.pending_chunk = pending;
    await writeJsonAtomically(checkpointPath, checkpoint);
  }
  if (format === 'compact') {
    const text = renderCompactChunk(checkpoint, pending);
    if (out) await writeTextAtomically(resolveRootPath(root, out), text);
    else console.log(text.trimEnd());
    return { chunk_id: pending.chunk_id, candidate_count: pending.candidate_count, text };
  }
  const payload = pendingChunkPayload(checkpoint, pending);
  if (out) await writeJsonAtomically(resolveRootPath(root, out), payload);
  else console.log(JSON.stringify(payload));
  return payload;
}

/** Parse, normalize and validate one chunk's decisions without touching the checkpoint; throws the official diagnostic. */
async function evaluateChunkDecisions(checkpoint, pending, inputPath, root, format, supervisorFallbackRequested) {
  const problems = [];
  let input;
  let model = null;
  let supervisorFallback = null;
  try {
    const raw = await readFile(resolveRootPath(root, inputPath), 'utf8');
    if (format === 'compact') {
      const parsed = parseCompactDecisions(raw, checkpoint, pending);
      model = parsed.model;
      problems.push(...parsed.errors);
      input = { chunk_id: pending.chunk_id, decisions: parsed.decisions };
    } else input = JSON.parse(raw);
  } catch (error) { throw new Error(`cannot read chunk decisions: ${error.message}`); }
  if (supervisorFallbackRequested) {
    if (format !== 'compact') throw new Error('Supervisor technical fallback is only valid with --format compact');
    try {
      const supervisorState = await supervisorStateDirectory(root);
      await assertSupervisorFallbackProcess(supervisorState);
      supervisorFallback = JSON.parse(await readFile(path.join(supervisorState, 's2-technical-fallback.json'), 'utf8'));
      if (!isPlainObject(supervisorFallback)) throw new Error('Supervisor fallback evidence must be an object');
    } catch (error) { throw new Error(`cannot read Supervisor fallback evidence: ${error.message}`); }
  }
  if (!isPlainObject(input) || keysOf(input) !== 'chunk_id,decisions' || input.chunk_id !== pending.chunk_id || !Array.isArray(input.decisions)) {
    throw new Error(`decision file must contain the active chunk_id ${pending.chunk_id} and a decisions array`);
  }
  const expected = new Map();
  for (const slice of pending.slices) {
    const item = checkpoint.items.find((entry) => entry.sense_id === slice.sense_id);
    for (const candidate of item.candidates.slice(slice.start, slice.end)) expected.set(`${item.sense_id}\u0000${candidate.text}`, { item, candidate });
  }
  const rowByKey = new Map((model?.candidates ?? []).map((row) => [`${row.item.sense_id}\u0000${row.candidate.text}`, row]));
  let fallbackKey = null;
  if (supervisorFallback !== null) {
    const fallbackKeys = 'alias,candidate,chunk_id,failure_reason,record_id,retry_count,sense_id';
    if (!isPlainObject(supervisorFallback) || keysOf(supervisorFallback) !== fallbackKeys
        || supervisorFallback.chunk_id !== pending.chunk_id || !/^c\d+$/u.test(supervisorFallback.alias)
        || supervisorFallback.retry_count !== 1 || typeof supervisorFallback.failure_reason !== 'string'
        || !supervisorFallback.failure_reason.trim()) {
      throw new Error('Supervisor fallback evidence is malformed or does not prove exactly one correction attempt');
    }
    const row = model?.candidates.find((candidate) => candidate.alias === supervisorFallback.alias);
    if (!row || row.item.record_id !== supervisorFallback.record_id
        || row.item.sense_id !== supervisorFallback.sense_id || row.candidate.text !== supervisorFallback.candidate) {
      throw new Error('Supervisor fallback evidence does not bind to the exact active chunk candidate');
    }
    const diagnosticLines = supervisorFallback.failure_reason.split(/\r?\n/u);
    const diagnosticPrefix = `chunk ${pending.chunk_id} not saved, checkpoint unchanged: `;
    const diagnosticHeader = diagnosticLines[0] ?? '';
    const diagnosticCount = diagnosticHeader.startsWith(diagnosticPrefix) && diagnosticHeader.endsWith(' problem(s)')
      ? Number(diagnosticHeader.slice(diagnosticPrefix.length, -' problem(s)'.length)) : NaN;
    const problemLines = diagnosticLines.slice(1).map((line) => line.trim()).filter((line) => line && !line.startsWith('types:'));
    const errorAliases = problemLines.map((line) => /^(c\d+)\b/u.exec(line)?.[1] ?? null);
    if (!Number.isInteger(diagnosticCount) || diagnosticCount !== problemLines.length
        || problemLines.length === 0 || errorAliases.some((alias) => alias !== supervisorFallback.alias)
        || !problemLines.some((line) => line.startsWith(`${supervisorFallback.alias} ${supervisorFallback.candidate}:`))) {
      throw new Error('Supervisor fallback requires a current save-chunk diagnostic for this one exact candidate');
    }
    fallbackKey = `${row.item.sense_id}\u0000${row.candidate.text}`;
    if (input.decisions.some((decision) => decision.source_sense_id === row.item.sense_id
        && decision.candidate === row.candidate.text)) {
      throw new Error('Supervisor fallback candidate must be omitted from model decisions');
    }
    const fallbackDecision = {
      source_sense_id: row.item.sense_id, candidate: row.candidate.text,
      disposition: 'drop', reason: 'f',
    };
    try { validateDecision(row.item, row.candidate, fallbackDecision, true); }
    catch (error) { throw new Error(`Supervisor fallback is invalid: ${error.message}`); }
    input.decisions.push(fallbackDecision);
  }
  const labelOf = (key) => rowByKey.get(key)?.alias ?? key.replace('\u0000', '/');
  const failed = new Set(problems.map((problem) => problem.alias).filter((alias) => alias !== null));
  const failedKeys = new Set([...rowByKey].filter(([, row]) => failed.has(row.alias)).map(([key]) => key));
  const problem = (key, message) => {
    failedKeys.add(key);
    const row = rowByKey.get(key);
    problems.push({ alias: row?.alias ?? null, label: row ? undefined : key.replace('\u0000', '/'), message: message.replace(`${key.replace('\u0000', '/')}: `, '') });
  };
  const received = new Map();
  for (const decision of input.decisions) {
    if (!isPlainObject(decision) || typeof decision.source_sense_id !== 'string' || typeof decision.candidate !== 'string') {
      problems.push({ alias: null, message: 'each decision needs source_sense_id and candidate' });
      continue;
    }
    const key = `${decision.source_sense_id}\u0000${decision.candidate}`;
    if (received.has(key)) { problem(key, `chunk repeats decision ${decision.source_sense_id}/${decision.candidate}`); continue; }
    const source = expected.get(key);
    if (!source) { problems.push({ alias: null, message: `decision ${decision.source_sense_id}/${decision.candidate} is outside the active chunk` }); continue; }
    try {
      const normalizedDecision = normalizeInputDecision(checkpoint, decision, source.candidate);
      validateDecision(source.item, source.candidate, normalizedDecision, key === fallbackKey);
      received.set(key, normalizedDecision);
    } catch (error) { problem(key, error.message); }
  }
  for (const key of expected.keys()) {
    if (!received.has(key) && !failedKeys.has(key)) problem(key, `chunk has missing decisions: ${labelOf(key)}`);
  }
  if (problems.length) {
    const lines = problems.map((entry) => {
      const row = entry.alias === null ? null : model?.candidates.find((candidate) => candidate.alias === entry.alias);
      const head = entry.alias ?? entry.label ?? '-';
      return `${head}${row ? ` ${row.candidate.text}` : ''}: ${entry.message}${row ? `  ->  ${compactHint(row, checkpoint)}` : ''}`;
    });
    throw new Error(`chunk ${pending.chunk_id} not saved, checkpoint unchanged: ${problems.length} problem(s)\n${lines.join('\n')}\ntypes: ${ADMISSION_TYPES.join('/')}; tier: one digit 1..9`);
  }
  return { received, expected };
}

function applyChunkDecisions(received, expected) {
  for (const [key, decision] of received) {
    const { candidate } = expected.get(key);
    if (candidate.already_accounted === true) candidate.additional_relations.push(decision);
    else candidate.decision = decision;
  }
}

async function saveChunk(checkpoint, checkpointPath, inputPath, root, format = 'json', supervisorFallbackRequested = false) {
  await assertNoOpenTaskPlan(checkpointPath);
  const pending = checkpoint.pending_chunk;
  if (!pending) throw new Error('checkpoint has no unread or unsaved chunk');
  const { received, expected } = await evaluateChunkDecisions(checkpoint, pending, inputPath, root, format, supervisorFallbackRequested);
  applyChunkDecisions(received, expected);
  checkpoint.pending_chunk = null;
  checkpoint.next_chunk_number += 1;
  await writeJsonAtomically(checkpointPath, checkpoint);
  const result = { saved: received.size, ...checkpointProgressPayload(checkpoint), checkpoint: checkpointPath };
  console.log(`Saved ${received.size} decisions: ${result.decided}/${result.total} -> ${checkpointPath}`);
  return result;
}

const TASK_PLAN_VERSION = 1;

/** Plan ownership lives beside the checkpoint, never in it, so planning leaves the checkpoint file untouched. */
const taskPlanStatePath = (checkpointPath) => `${checkpointPath}.task-plan.json`;

async function readTaskPlanState(checkpointPath) {
  let state;
  try { state = JSON.parse(await readFile(taskPlanStatePath(checkpointPath), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`cannot read task plan state: ${error.message}`); }
  if (!isPlainObject(state) || keysOf(state) !== 'closed,plan_digest' || typeof state.closed !== 'boolean'
      || !/^[a-f0-9]{64}$/u.test(state.plan_digest ?? '')) throw new Error('task plan state is malformed');
  return state;
}

/** While a task plan is open the checkpoint belongs to its tasks; legacy pending/revision chunks wait for close-plan. */
async function assertNoOpenTaskPlan(checkpointPath) {
  if ((await readTaskPlanState(checkpointPath))?.closed === false) {
    throw new Error('checkpoint has an open task plan; use --task, or close-plan once every task is saved');
  }
}
const TASK_PLAN_KEYS = 'base_items_digest,batch,part,plan_digest,shard,target,tasks,version';

/** Digest of the immutable Part context; saved decisions and optional links are excluded so saving never invalidates a plan. */
function baseItemsDigest(checkpoint) {
  return stableDigest({
    shard: checkpoint.shard, batch: checkpoint.batch, part: checkpoint.part, type_tier_policy: checkpoint.type_tier_policy ?? null,
    items: checkpoint.items.map((item) => ({
      ...item,
      candidates: item.candidates.map(({ decision, additional_relations: additional, ...context }) => context),
    })),
  });
}

function firstUndecidedIndex(item) {
  const index = item.candidates.findIndex((candidate) => candidate.decision === null);
  return index === -1 ? item.candidates.length : index;
}

/**
 * A fixed, deterministic split of the still-undecided candidates into tasks of about `target` candidates.
 * Small Senses are balanced across tasks (LPT); a Sense larger than `target` becomes an ordered, dependent chain.
 */
function buildTaskPlan(checkpoint, target) {
  const units = [];
  checkpoint.items.forEach((item, order) => {
    const start = firstUndecidedIndex(item);
    if (start < item.candidates.length) units.push({ order, senseId: item.sense_id, start, count: item.candidates.length - start });
  });
  const drafts = [];
  const small = [];
  for (const unit of units) {
    if (unit.count <= target) { small.push(unit); continue; }
    const pieces = Math.ceil(unit.count / target);
    let start = unit.start;
    for (let piece = 0; piece < pieces; piece += 1) {
      const size = Math.floor(unit.count / pieces) + (piece < unit.count % pieces ? 1 : 0);
      drafts.push({ order: unit.order, piece, chain: unit.senseId, slices: [{ sense_id: unit.senseId, start, end: start + size }] });
      start += size;
    }
  }
  const bins = Array.from({ length: Math.ceil(small.reduce((sum, unit) => sum + unit.count, 0) / target) }, () => ({ load: 0, units: [] }));
  for (const unit of [...small].sort((left, right) => right.count - left.count || left.order - right.order)) {
    const bin = bins.reduce((least, entry) => (entry.load < least.load ? entry : least));
    bin.load += unit.count;
    bin.units.push(unit);
  }
  for (const bin of bins) {
    const ordered = bin.units.sort((left, right) => left.order - right.order);
    drafts.push({ order: ordered[0].order, piece: 0, chain: null,
      slices: ordered.map((unit) => ({ sense_id: unit.senseId, start: unit.start, end: unit.start + unit.count })) });
  }
  drafts.sort((left, right) => left.order - right.order || left.piece - right.piece);
  const prefix = `${checkpoint.shard}-${checkpoint.batch}-${checkpoint.part}`;
  const idOf = (index) => `${prefix}-t${String(index + 1).padStart(2, '0')}`;
  const tasks = drafts.map((draft, index) => ({
    id: idOf(index), chunk_id: idOf(index), slices: draft.slices,
    candidate_count: draft.slices.reduce((sum, slice) => sum + slice.end - slice.start, 0),
    depends_on: draft.chain !== null && draft.piece > 0 ? [idOf(index - 1)] : [],
  }));
  const plan = { version: TASK_PLAN_VERSION, shard: checkpoint.shard, batch: checkpoint.batch, part: checkpoint.part, target,
    base_items_digest: baseItemsDigest(checkpoint), tasks };
  return { ...plan, plan_digest: stableDigest(plan) };
}

function assertTaskPlanFor(checkpoint, plan) {
  const { plan_digest: digest, ...body } = isPlainObject(plan) ? plan : {};
  if (!isPlainObject(plan) || keysOf(plan) !== TASK_PLAN_KEYS || plan.version !== TASK_PLAN_VERSION
      || !Array.isArray(plan.tasks) || digest !== stableDigest(body)) throw new Error('task plan is malformed or was modified');
  if (plan.shard !== checkpoint.shard || plan.batch !== checkpoint.batch || plan.part !== checkpoint.part
      || plan.base_items_digest !== baseItemsDigest(checkpoint)) {
    throw new Error(`task plan does not belong to Part ${checkpoint.shard}/${checkpoint.batch}/${checkpoint.part} of this checkpoint`);
  }
}

async function readTaskPlan(checkpoint, planPath, root) {
  let plan;
  try { plan = JSON.parse(await readFile(resolveRootPath(root, planPath), 'utf8')); }
  catch (error) { throw new Error(`cannot read task plan: ${error.message}`); }
  assertTaskPlanFor(checkpoint, plan);
  return plan;
}

async function planChunks(checkpoint, checkpointPath, target, out, root) {
  if (checkpoint.merged) throw new Error('cannot plan chunks for a merged Part checkpoint');
  if (checkpoint.pending_chunk) throw new Error(`save the active chunk ${checkpoint.pending_chunk.chunk_id} before planning tasks`);
  const state = await readTaskPlanState(checkpointPath);
  if (state?.closed === true) throw new Error('this Part\'s task plan is closed; it is not planned again');
  const planPath = resolveRootPath(root, out);
  let plan = null;
  if (existsSync(planPath)) {
    // An existing plan for this Part is reused as is, never rewritten.
    try { plan = JSON.parse(await readFile(planPath, 'utf8')); } catch (error) { throw new Error(`cannot read existing task plan: ${error.message}`); }
    assertTaskPlanFor(checkpoint, plan);
  } else if (state) throw new Error('checkpoint has an open task plan whose file is missing; refusing to plan again');
  const reused = plan !== null;
  plan ??= buildTaskPlan(checkpoint, target);
  if (!reused) await writeJsonAtomically(planPath, plan);
  if (!state) await writeJsonAtomically(taskPlanStatePath(checkpointPath), { plan_digest: plan.plan_digest, closed: false });
  else if (state.plan_digest !== plan.plan_digest) throw new Error('task plan is not the plan this checkpoint registered');
  const result = { version: 1, ok: true, plan: planPath, reused, target: plan.target, tasks: plan.tasks.length,
    candidates: plan.tasks.reduce((sum, task) => sum + task.candidate_count, 0), plan_digest: plan.plan_digest };
  console.log(JSON.stringify(result));
  return result;
}

async function closeTaskPlan(checkpoint, checkpointPath, plan) {
  const state = await readTaskPlanState(checkpointPath);
  if (state?.plan_digest !== plan.plan_digest) throw new Error('task plan is not the plan this checkpoint registered');
  if (!state.closed) {
    const unsaved = plan.tasks.filter((task) => taskState(checkpoint, task) !== 'saved');
    if (unsaved.length) throw new Error(`cannot close the task plan: unsaved task(s) ${unsaved.map((task) => task.id).join(', ')}`);
    await writeJsonAtomically(taskPlanStatePath(checkpointPath), { ...state, closed: true });
  }
  const result = { version: 1, ok: true, closed: true, plan_digest: plan.plan_digest };
  console.log(JSON.stringify(result));
  return result;
}

/** ready: every slice starts at its Sense's first undecided candidate; saved: every slice is decided; blocked: waits for an earlier task. */
function taskState(checkpoint, task) {
  const states = new Set(task.slices.map((slice) => {
    const item = checkpoint.items.find((entry) => entry.sense_id === slice.sense_id);
    const first = firstUndecidedIndex(item);
    if (first === slice.start) return 'ready';
    if (first >= slice.end) return 'saved';
    return first < slice.start ? 'blocked' : 'partial';
  }));
  if (states.size === 1 && !states.has('partial')) return [...states][0];
  return states.has('partial') || states.has('saved') ? 'partial' : 'blocked';
}

async function taskContext(checkpoint, checkpointPath, plan, taskId) {
  if (checkpoint.merged) throw new Error('cannot use a task of a merged Part checkpoint');
  const registered = await readTaskPlanState(checkpointPath);
  if (registered?.plan_digest !== plan.plan_digest || registered.closed !== false) {
    throw new Error('task plan is not the open plan registered in this checkpoint');
  }
  if (checkpoint.pending_chunk) throw new Error(`checkpoint has an active chunk ${checkpoint.pending_chunk.chunk_id}; tasks and pending chunks cannot be mixed`);
  const task = plan.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error(`task plan has no task ${taskId}`);
  return { task, pending: { chunk_id: task.chunk_id, candidate_count: task.candidate_count, slices: task.slices }, state: taskState(checkpoint, task) };
}

const assertTaskNotBlocked = (task, state) => {
  if (state === 'blocked') throw new Error(`task ${task.id} waits for unsaved earlier task(s) ${task.depends_on.join(', ') || '(none listed)'}`);
  if (state === 'partial') throw new Error(`task ${task.id} is only partly saved; refusing to continue it`);
};

async function readTaskChunk(checkpoint, checkpointPath, plan, taskId, out, root) {
  const { task, pending, state } = await taskContext(checkpoint, checkpointPath, plan, taskId);
  assertTaskNotBlocked(task, state);
  if (state === 'saved') throw new Error(`task ${task.id} is already saved`);
  const text = renderCompactChunk(checkpoint, pending);
  const result = { task: task.id, chunk_id: pending.chunk_id, candidate_count: pending.candidate_count, view_sha256: sha256(Buffer.from(text, 'utf8')) };
  if (out) {
    await writeTextAtomically(resolveRootPath(root, out), text);
    console.log(JSON.stringify(result));
  } else console.log(text.trimEnd());
  return { ...result, text };
}

async function saveTaskChunk(checkpoint, checkpointPath, plan, taskId, inputPath, root, expectViewSha256, supervisorFallbackRequested) {
  const { task, pending, state } = await taskContext(checkpoint, checkpointPath, plan, taskId);
  assertTaskNotBlocked(task, state);
  const viewSha256 = sha256(Buffer.from(renderCompactChunk(checkpoint, pending), 'utf8'));
  if (viewSha256 !== expectViewSha256) throw new Error(`task ${task.id} view changed since it was launched; not saved`);
  const { received, expected } = await evaluateChunkDecisions(checkpoint, pending, inputPath, root, 'compact', supervisorFallbackRequested);
  let alreadySaved = false;
  if (state === 'saved') {
    for (const [key, decision] of received) {
      if (!isDeepStrictEqual(expected.get(key).candidate.decision, decision)) {
        throw new Error(`task ${task.id} is already saved with a different result; refusing to overwrite it`);
      }
    }
    alreadySaved = true;
  } else {
    applyChunkDecisions(received, expected);
    checkpoint.next_chunk_number += 1;
    await writeJsonAtomically(checkpointPath, checkpoint);
  }
  const result = { task: task.id, saved: received.size, already_saved: alreadySaved, ...checkpointProgressPayload(checkpoint), checkpoint: checkpointPath };
  console.log(JSON.stringify(result));
  return result;
}

async function supervisorStateDirectory(root) {
  const dotGit = path.join(root, '.git');
  let gitDirectory;
  try {
    const pointer = await readFile(dotGit, 'utf8');
    const match = /^gitdir:\s*(.+)\s*$/mu.exec(pointer);
    if (!match) throw new Error('worktree Git directory pointer is malformed');
    gitDirectory = path.resolve(root, match[1]);
  } catch (error) {
    if (error.code !== 'EISDIR') throw new Error('active Supervisor lock is unavailable');
    gitDirectory = dotGit;
  }
  let commonDirectory = gitDirectory;
  try {
    commonDirectory = path.resolve(gitDirectory, (await readFile(path.join(gitDirectory, 'commondir'), 'utf8')).trim());
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('active Supervisor lock is unavailable');
  }
  return path.join(commonDirectory, 'typewriter-supervisor');
}

async function assertSupervisorFallbackProcess(supervisorState) {
  const lockPath = path.join(supervisorState, 'supervisor-owner.lock');
  const probe = [
    'import fcntl, os, struct, sys',
    'lock = open(sys.argv[1], "rb")',
    'darwin = sys.platform == "darwin"',
    'fmt = "@qqihh4x" if darwin else "@hhqqi4x"',
    'request = struct.pack(fmt, 0, 0, 0, fcntl.F_WRLCK, os.SEEK_SET) if darwin else struct.pack(fmt, fcntl.F_WRLCK, os.SEEK_SET, 0, 0, 0)',
    'result = fcntl.fcntl(lock, fcntl.F_GETLK, request)',
    'fields = struct.unpack(fmt, result)',
    'print(fields[2] if darwin else fields[4])',
  ].join('\n');
  const owner = spawnSync('python3', ['-c', probe, lockPath], { encoding: 'utf8', timeout: 5000 });
  const lockOwnerPid = Number(owner.stdout?.trim());
  if (owner.status !== 0 || !Number.isSafeInteger(lockOwnerPid) || lockOwnerPid !== process.ppid) {
    throw new Error('technical Drop fallback requires the CLI parent to own the active Supervisor lock');
  }
}

function premergeSnapshotPaths(checkpoint, checkpointPath) {
  const prefix = `relation-admission-${checkpoint.shard}-${checkpoint.batch}-${checkpoint.part}.premerge-`;
  const directory = path.dirname(checkpointPath);
  return {
    relations: path.join(directory, `${prefix}relations.jsonl`),
    drops: path.join(directory, `${prefix}drops.jsonl`),
  };
}

function stateManifest(state) {
  return { exists: state.exists, sha256: state.exists ? sha256(state.bytes) : null };
}

function parseJsonlState(state, family) {
  if (!state.exists || state.bytes.length === 0) return [];
  try {
    const contents = state.bytes.toString('utf8');
    return family === 'Relation'
      ? parseRelationJsonl(contents, `premerge ${family} snapshot`)
      : parseDropJsonl(contents, `premerge ${family} snapshot`);
  } catch (error) { throw new Error(`cannot parse premerge ${family} snapshot: ${error.message}`); }
}

function serializedJsonlState(rows, baseline, family) {
  if (rows.length === 0 && !baseline.exists) return { exists: false, bytes: Buffer.alloc(0), sha256: null };
  const text = family === 'Relation' ? serializeRelationJsonl(rows) : serializeDropJsonl(rows);
  const bytes = Buffer.from(text, 'utf8');
  return { exists: true, bytes, sha256: sha256(bytes) };
}

async function snapshotState(file, expected, current, status, family) {
  let snapshot;
  try {
    const bytes = await readFile(file);
    snapshot = { exists: true, bytes, sha256: sha256(bytes) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    snapshot = { exists: false, bytes: Buffer.alloc(0), sha256: null };
  }
  if (!expected.exists) {
    if (snapshot.exists) throw new Error(`unexpected premerge ${family} snapshot exists although the source file was absent`);
    return snapshot;
  }
  if (snapshot.exists) {
    if (snapshot.sha256 !== expected.sha256) throw new Error(`premerge ${family} snapshot hash does not match checkpoint metadata`);
    return snapshot;
  }
  if (status !== 'preparing' || !current.exists || current.sha256 !== expected.sha256) {
    throw new Error(`premerge ${family} snapshot is missing; refusing to recapture it`);
  }
  await writeTextAtomically(file, current.bytes);
  return { ...current, bytes: Buffer.from(current.bytes) };
}

function normalizeRelationDiff(diffFrom, diffTo) {
  if (diffFrom === null && diffTo === null) return null;
  if (![diffFrom, diffTo].every((sha) => /^[a-f0-9]{40}$/u.test(sha ?? ''))) {
    throw new Error('premerge Relation diff requires both valid --diff-from and --diff-to commits');
  }
  return { from: diffFrom, to: diffTo };
}

async function ensurePremerge(checkpoint, checkpointPath, root, { diffFrom = null, diffTo = null, refresh = false } = {}) {
  const relationFile = shardRelationPath(checkpoint.shard, root);
  const dropFile = shardDropPath(checkpoint.shard, root);
  const snapshots = premergeSnapshotPaths(checkpoint, checkpointPath);
  const relationDiff = diffFrom === null && diffTo === null
    ? checkpoint.premerge?.relation_diff ?? null : normalizeRelationDiff(diffFrom, diffTo);
  if (relationDiff) assertRelationDiffRange(relationDiff.from, relationDiff.to, root);
  if (refresh) {
    if (checkpoint.merged) throw new Error('cannot refresh a merged Part premerge snapshot');
    const [relations, drops] = await Promise.all([readFileState(relationFile), readFileState(dropFile)]);
    const writeSnapshot = async (file, state) => {
      if (state.exists) await writeTextAtomically(file, state.bytes.toString('utf8'));
      else { try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    };
    await Promise.all([writeSnapshot(snapshots.relations, relations), writeSnapshot(snapshots.drops, drops)]);
    checkpoint.premerge = {
      status: 'ready', identity: `${checkpoint.shard}/${checkpoint.batch}/${checkpoint.part}`,
      relations: stateManifest(relations), drops: stateManifest(drops), relation_diff: relationDiff,
    };
    await writeJsonAtomically(checkpointPath, checkpoint);
    return { relations, drops, relationFile, dropFile, relation_diff: relationDiff };
  }
  let manifest = checkpoint.premerge;
  if (!manifest) {
    if (checkpoint.merged) throw new Error('merged checkpoint has no premerge snapshot; it cannot be amended or rematerialized');
    for (const file of Object.values(snapshots)) {
      try { await readFile(file); throw new Error(`untrusted preexisting snapshot file ${file}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const [relations, drops] = await Promise.all([readFileState(relationFile), readFileState(dropFile)]);
    manifest = {
      status: 'preparing',
      identity: `${checkpoint.shard}/${checkpoint.batch}/${checkpoint.part}`,
      relations: stateManifest(relations),
      drops: stateManifest(drops),
      relation_diff: relationDiff,
    };
    checkpoint.premerge = manifest;
    await writeJsonAtomically(checkpointPath, checkpoint);
  }
  if (JSON.stringify(manifest.relation_diff ?? null) !== JSON.stringify(relationDiff)) {
    throw new Error('premerge Relation diff changed after snapshot preparation');
  }
  const [currentRelations, currentDrops] = await Promise.all([readFileState(relationFile), readFileState(dropFile)]);
  if (manifest.status === 'preparing') {
    if (currentRelations.exists !== manifest.relations.exists || currentRelations.sha256 !== manifest.relations.sha256
        || currentDrops.exists !== manifest.drops.exists || currentDrops.sha256 !== manifest.drops.sha256) {
      throw new Error('Relation/Drop outputs changed while premerge snapshots were being prepared');
    }
  }
  const [relations, drops] = await Promise.all([
    snapshotState(snapshots.relations, manifest.relations, currentRelations, manifest.status, 'Relation'),
    snapshotState(snapshots.drops, manifest.drops, currentDrops, manifest.status, 'Drop'),
  ]);
  if (manifest.status === 'preparing') {
    checkpoint.premerge = { ...manifest, status: 'ready', relation_diff: relationDiff };
    await writeJsonAtomically(checkpointPath, checkpoint);
  }
  return { relations, drops, relationFile, dropFile, relation_diff: relationDiff };
}

async function readReadyPremerge(checkpoint, checkpointPath) {
  const manifest = checkpoint.premerge;
  if (!manifest || manifest.status !== 'ready' || manifest.identity !== `${checkpoint.shard}/${checkpoint.batch}/${checkpoint.part}`) {
    throw new Error('Part has no trusted, complete premerge snapshot');
  }
  const files = premergeSnapshotPaths(checkpoint, checkpointPath);
  const [relations, drops] = await Promise.all([
    snapshotState(files.relations, manifest.relations, { exists: false, bytes: Buffer.alloc(0), sha256: null }, 'ready', 'Relation'),
    snapshotState(files.drops, manifest.drops, { exists: false, bytes: Buffer.alloc(0), sha256: null }, 'ready', 'Drop'),
  ]);
  return { relations, drops, relation_diff: manifest.relation_diff ?? null };
}

async function materializePart(checkpoint, root, baseline, preparedCandidateMerge = null, timing = null, foreign = null) {
  timing?.start('baseline_parse');
  assertPrimaryComplete(checkpoint);
  assertOptionalComplete(checkpoint);
  validateCheckpointDecisions(checkpoint);
  const existingRelations = parseJsonlState(baseline.relations, 'Relation');
  const existingDrops = parseJsonlState(baseline.drops, 'Drop');
  timing?.end();
  timing?.start('other_relations_load');
  const others = foreign ? foreign.flatMap(({ rows }) => rows)
    : await loadApprovedRelations(root, { exceptShard: checkpoint.shard });
  timing?.end();
  timing?.start('shard_reload');
  const loaded = await loadShard(checkpoint.shard, root, { batch: checkpoint.batch });
  timing?.end();
  timing?.start('baseline_validate');
  const finalShardSenseIds = new Set(loaded.canonicalRows.flatMap((record) => record.senses.map((sense) => sense.id)));
  validateRelationRows({ relationRows: existingRelations, dropRows: existingDrops, index: loaded.index,
    shardSenseIds: finalShardSenseIds, otherRelationRows: others });
  timing?.end();
  timing?.start('candidate_merge');
  const scoped = partScope(loaded.canonicalRows, loaded.candidateFiles, checkpoint.batch, checkpoint.part, checkpoint.shard);
  const candidateMerge = preparedCandidateMerge ?? mergeCandidates(loaded.canonicalRows, scoped.files, {
    canonicalLemmaForms: new Set([...loaded.index.byLemma.keys()].map(normalizeCandidate)),
  });
  const { relations: newRelations, relationCandidates, drops: newDrops } = decisionRows(checkpoint);
  timing?.end();
  timing?.start('all_drops_load');
  const allDrops = await loadAllApprovedDrops(root, { exceptShard: checkpoint.shard });
  timing?.end();
  timing?.start('reverse_lookup');
  const reverseCandidates = createReverseCandidateFormLookup({
    relationRows: [...others, ...existingRelations],
    dropRows: [...allDrops, ...existingDrops, ...newDrops],
    index: loaded.index,
    candidateMerge,
  });
  for (const relation of newRelations) {
    if ('text' in relation) continue;
    const source = loaded.index.byId.get(relation.source_record_id);
    if (source) relation.reverse_candidate_forms = reverseCandidates.available(source, relation.target_sense_id);
    reverseCandidates.addRelation(relation);
  }
  timing?.end();
  timing?.start('merge_conflicts');
  const merged = collectMergeConflicts(checkpoint, existingRelations, existingDrops, newRelations, relationCandidates, newDrops,
    loaded.index, others, { mergeOtherReciprocals: Boolean(foreign) });
  if (merged.conflicts.length) throw new Error(merged.conflicts[0].message);
  timing?.end();
  timing?.start('orphan_drops');
  const removedRelationRows = baseline.relation_diff
    ? deletedIdRelationRowsBetween(baseline.relation_diff.from, baseline.relation_diff.to, root) : [];
  const editDrops = orphanedCandidateDrops({
    canonicalRows: loaded.canonicalRows,
    candidateFiles: scoped.files,
    scopeRows: scoped.scopeRows,
    removedRelationRows,
    relationRows: [...others, ...merged.relations],
    dropRows: [...allDrops, ...merged.drops],
    index: loaded.index,
    candidateMerge,
  });
  merged.drops.push(...editDrops);
  timing?.end();
  timing?.start('final_validation');
  validateRelationRows({ relationRows: merged.relations, dropRows: merged.drops, index: loaded.index,
    shardSenseIds: finalShardSenseIds, otherRelationRows: others });
  timing?.end();
  timing?.start('final_accounting');
  verifyAccounting({ canonicalRows: loaded.canonicalRows, candidateFiles: scoped.files, relationRows: merged.relations,
    dropRows: merged.drops, otherRelationRows: others, index: loaded.index, scopeRows: scoped.scopeRows, candidateMerge });
  timing?.end();
  timing?.start('serialization');
  const relations = sameRows(merged.relations, existingRelations)
    ? baseline.relations : serializedJsonlState(merged.relations, baseline.relations, 'Relation');
  const drops = sameRows(merged.drops, existingDrops)
    ? baseline.drops : serializedJsonlState(merged.drops, baseline.drops, 'Drop');
  timing?.end();
  return { relations, drops, merged, existingRelations, existingDrops };
}

async function reconcileScope({ shard, batch = null, part = null, diffFrom, diffTo, dryRun = false, root }) {
  const loaded = await loadShard(shard, root, { batch });
  const scope = part ? partScope(loaded.canonicalRows, loaded.candidateFiles, batch, part, shard)
    : batch ? batchScope(loaded.canonicalRows, loaded.candidateFiles, batch)
      : { scopeRows: loaded.canonicalRows, files: loaded.candidateFiles };
  const inventory = batch ? candidateInventory(scope.files.map((file) => file.name), { batches: [batch] }) : loaded.inventory;
  requireComplete(inventory, false);
  const relationFile = shardRelationPath(shard, root);
  const dropFile = shardDropPath(shard, root);
  const [ownRelations, ownDrops, others, allDrops] = await Promise.all([
    loadOptionalRelationJsonl(relationFile),
    loadOptionalDropJsonl(dropFile),
    loadApprovedRelations(root, { exceptShard: shard }),
    loadAllApprovedDrops(root),
  ]);
  const removedRelationRows = deletedIdRelationRowsBetween(diffFrom, diffTo, root);
  const shardSenseIds = new Set(loaded.canonicalRows.flatMap((record) => record.senses.map((sense) => sense.id)));
  const editDrops = orphanedCandidateDrops({ canonicalRows: loaded.canonicalRows, candidateFiles: scope.files,
    scopeRows: scope.scopeRows, removedRelationRows, relationRows: [...others, ...ownRelations], dropRows: allDrops, index: loaded.index });
  const nextDrops = [...ownDrops, ...editDrops];
  validateRelationRows({ relationRows: ownRelations, dropRows: nextDrops, index: loaded.index,
    shardSenseIds, otherRelationRows: others });
  verifyAccounting({ canonicalRows: loaded.canonicalRows, candidateFiles: scope.files, relationRows: ownRelations,
    dropRows: nextDrops, otherRelationRows: others, index: loaded.index, scopeRows: scope.scopeRows });
  if (!dryRun && editDrops.length > 0) {
    const current = await readFileState(dropFile);
    const next = serializedJsonlState(nextDrops, current, 'Drop');
    await writeFileStateAtomically(dropFile, next);
  }
  return { version: 1, ok: true, shard, ...(batch ? { batch } : {}), ...(part ? { part } : {}),
    added: editDrops.length, dry_run: dryRun,
    candidates: editDrops.map(({ source_sense_id, candidate }) => ({ source_sense_id, candidate })) };
}

function hydrateRelation(row, index) {
  const source = index.senses.get(row.source_sense_id);
  const targetId = row.target_sense_id;
  const target = targetId ? index.senses.get(targetId) : null;
  const describe = (entry, senseId) => entry ? {
    record_id: entry.record.id,
    sense_id: senseId,
    lemma: entry.record.lemma,
    pos: entry.sense.pos,
    gloss: entry.sense.gloss,
  } : { sense_id: senseId };
  return { ...row, source: describe(source, row.source_sense_id), ...(targetId ? { target: describe(target, targetId) } : {}) };
}

function candidateKeyParts(key) {
  const at = key.indexOf('\u0000');
  return at < 0 ? [key, ''] : [key.slice(0, at), key.slice(at + 1)];
}

async function preflightCheckpoint(checkpoint, checkpointPath, root, limit = 20, offset = 0, fileOutput = false) {
  assertPrimaryComplete(checkpoint);
  assertOptionalComplete(checkpoint);
  validateCheckpointDecisions(checkpoint);
  if (checkpoint.merged) throw new Error('preflight only applies before Part merge');
  const baseline = await readReadyPremerge(checkpoint, checkpointPath);
  const [actualRelations, actualDrops] = await Promise.all([
    readFileState(shardRelationPath(checkpoint.shard, root)),
    readFileState(shardDropPath(checkpoint.shard, root)),
  ]);
  if (!sameFileState(actualRelations, baseline.relations) || !sameFileState(actualDrops, baseline.drops)) {
    throw new Error('Relation/Drop outputs differ from the trusted premerge snapshot; refusing automatic semantic repair');
  }
  const existingRelations = parseJsonlState(baseline.relations, 'Relation');
  const existingDrops = parseJsonlState(baseline.drops, 'Drop');
  const others = await loadApprovedRelations(root, { exceptShard: checkpoint.shard });
  const loaded = await loadShard(checkpoint.shard, root, { batch: checkpoint.batch });
  const scoped = partScope(loaded.canonicalRows, loaded.candidateFiles, checkpoint.batch, checkpoint.part, checkpoint.shard);
  const candidateMerge = mergeCandidates(loaded.canonicalRows, scoped.files, {
    canonicalLemmaForms: new Set([...loaded.index.byLemma.keys()].map(normalizeCandidate)),
  });
  const finalShardSenseIds = new Set(loaded.canonicalRows.flatMap((record) => record.senses.map((sense) => sense.id)));
  try {
    validateRelationRows({ relationRows: existingRelations, dropRows: existingDrops, index: loaded.index,
      shardSenseIds: finalShardSenseIds, otherRelationRows: others });
  } catch (error) {
    throw new Error(`existing Relation/Drop baseline is invalid; no checkpoint repair is safe: ${error.message}`);
  }
  const generated = decisionRows(checkpoint);
  const allDrops = await loadAllApprovedDrops(root, { exceptShard: checkpoint.shard });
  const reverseCandidates = createReverseCandidateFormLookup({
    relationRows: [...others, ...existingRelations],
    dropRows: [...allDrops, ...existingDrops, ...generated.drops],
    index: loaded.index,
    candidateMerge,
  });
  for (const relation of generated.relations) {
    if ('text' in relation) continue;
    const source = loaded.index.byId.get(relation.source_record_id);
    if (source) relation.reverse_candidate_forms = reverseCandidates.available(source, relation.target_sense_id);
    reverseCandidates.addRelation(relation);
  }
  const collected = collectMergeConflicts(checkpoint, existingRelations, existingDrops, generated.relations,
    generated.relationCandidates, generated.drops, loaded.index, others);
  const unclassified = [];
  const byKey = new Map(checkpoint.items.flatMap((item) => item.candidates.map((candidate) =>
    [`${item.sense_id}\u0000${candidate.text}`, { item, candidate }])));
  const parent = new Map([...byKey.keys()].map((key) => [key, key]));
  const find = (key) => {
    const value = parent.get(key);
    if (value === undefined) return null;
    if (value === key) return key;
    const rootKey = find(value);
    parent.set(key, rootKey);
    return rootKey;
  };
  const join = (keys) => {
    const known = keys.filter((key) => parent.has(key));
    if (known.length < 2) return;
    const rootKey = find(known[0]);
    for (const key of known.slice(1)) parent.set(find(key), rootKey);
  };
  for (const conflict of collected.conflicts) {
    if (!['id-pair-conflict', 'candidate-already-decided'].includes(conflict.code)
        || conflict.candidate_keys.some((key) => !byKey.has(key))) {
      unclassified.push(conflict.message);
    }
    join(conflict.candidate_keys);
  }
  const localDrops = existingDrops.concat(generated.drops).filter((row) =>
    scoped.scopeRows.some((record) => record.senses.some((sense) => sense.id === row.source_sense_id)));
  const glossProblems = findGlossNamedDrops({ dropRows: localDrops, scopeRows: scoped.scopeRows, index: loaded.index });
  for (const entry of glossProblems) {
    if (!byKey.has(`${entry.source_sense_id}\u0000${entry.candidate}`)) unclassified.push(entry.message);
  }
  const groups = new Map();
  const groupFor = (key) => {
    const rootKey = find(key) ?? key;
    if (!groups.has(rootKey)) groups.set(rootKey, { candidate_keys: [], conflicts: [], drop_gloss: [] });
    const group = groups.get(rootKey);
    if (!group.candidate_keys.includes(key)) group.candidate_keys.push(key);
    return group;
  };
  for (const conflict of collected.conflicts) {
    if (conflict.candidate_keys.some((key) => !byKey.has(key))) continue;
    const group = groupFor(conflict.candidate_keys[0]);
    group.conflicts.push({
      code: conflict.code,
      message: conflict.message,
      relations: conflict.relations.map((row) => hydrateRelation(row, loaded.index)),
    });
    for (const key of conflict.candidate_keys.slice(1)) groupFor(key);
  }
  for (const entry of glossProblems) {
    const key = `${entry.source_sense_id}\u0000${entry.candidate}`;
    if (byKey.has(key)) groupFor(key).drop_gloss.push(entry.message);
  }
  const problems = [...groups.values()].map((group) => {
    group.candidate_keys.sort();
    const affectedTypes = new Set(group.conflicts.flatMap((conflict) => conflict.relations.map((row) => row.type).filter(Boolean)));
    group.candidates = group.candidate_keys.map((key) => {
      const [sourceSenseId, candidateText] = candidateKeyParts(key);
      const { item, candidate } = byKey.get(key);
      const allTargets = candidate.same_spelling_targets.flatMap((target) => target.senses.map((sense) => ({
        record_id: target.record_id, lemma: target.lemma, sense_id: sense.sense_id, pos: sense.pos, gloss: sense.gloss,
      })));
      const peers = item.candidates.filter((peer) => peer.text !== candidate.text && peer.decision?.disposition === 'relation')
        .map((peer) => ({ source_sense_id: item.sense_id, candidate: peer.text, decision: presentedDecision(checkpoint, peer.decision),
          affected_type: affectedTypes.has(peer.decision.type) }));
      return {
        source_sense_id: sourceSenseId,
        source_record_id: item.record_id,
        source_lemma: item.lemma,
        source_pos: item.pos,
        source_gloss: item.gloss,
        ...(item.reference_gloss === undefined ? {} : { reference_gloss: item.reference_gloss }),
        candidate: candidateText,
        decision: presentedDecision(checkpoint, candidate.decision),
        additional_relations: candidate.additional_relations?.map((decision) => presentedDecision(checkpoint, decision)) ?? null,
        already_accounted: candidate.already_accounted === true,
        target_senses: allTargets,
        approved_peers: item.approved_peers ?? [],
        same_group_peers: peers,
        drop_gloss: group.drop_gloss.filter((message) => message.includes(`${sourceSenseId}`) && message.includes(JSON.stringify(candidateText))),
      };
    });
    return group;
  }).sort((left, right) => left.candidate_keys[0].localeCompare(right.candidate_keys[0]));

  const fingerprint = stableDigest({
    identity: [checkpoint.shard, checkpoint.batch, checkpoint.part],
    ...(checkpoint.type_tier_policy ? { type_tier_policy: checkpoint.type_tier_policy } : {}),
    problems: problems.map((group) => ({ candidate_keys: group.candidate_keys, conflicts: group.conflicts, drop_gloss: group.drop_gloss })),
  });
  let ok = false;
  let repairable = problems.length > 0 && unclassified.length === 0;
  let materialization = collected.conflicts.length ? 'deferred-until-conflicts-are-fixed' : 'passed';
  if (collected.conflicts.length === 0) {
    try {
      await materializePart(checkpoint, root, baseline, candidateMerge);
      ok = glossProblems.length === 0 && unclassified.length === 0;
      repairable = !ok && unclassified.length === 0 && glossProblems.length > 0;
    } catch (error) {
      materialization = 'failed';
      if (error instanceof AdmissionVerifyError && error.family === 'accounting') {
        const expected = new Set(glossProblems.map((entry) => entry.message));
        const unexplained = error.errors.filter((message) => !expected.has(message));
        unclassified.push(...unexplained);
        repairable = error.errors.length > 0 && unexplained.length === 0 && glossProblems.length > 0;
      } else unclassified.push(`${error.name}: ${error.message}`);
      ok = false;
    }
  }
  const total = problems.length;
  const page = problems.slice(offset, offset + limit);
  const payload = {
    version: 1,
    type_tier_policy: checkpoint.type_tier_policy ?? 'legacy-independent',
    ok,
    repairable,
    shard: checkpoint.shard,
    batch: checkpoint.batch,
    part: checkpoint.part,
    fingerprint,
    total,
    candidate_total: problems.reduce((sum, group) => sum + group.candidate_keys.length, 0),
    offset,
    limit,
    next_offset: offset + page.length < total ? offset + page.length : null,
    coverage: {
      merge_conflicts: 'complete',
      drop_gloss: 'complete',
      materialization,
      accounting: collected.conflicts.length ? 'deferred-until-conflicts-are-fixed' : materialization,
    },
    unclassified: [...new Set(unclassified)].sort(),
    problems: page,
  };
  const text = JSON.stringify(payload);
  if (!fileOutput && (Buffer.byteLength(text, 'utf8') > INSPECT_PAGE_MAX_BYTES || text.length > INSPECT_PAGE_MAX_CHARS)) {
    throw new Error(`preflight page exceeds its output limit (${Buffer.byteLength(text, 'utf8')} bytes, ${text.length} characters); retry with a smaller --limit`);
  }
  return payload;
}

function sameJson(left, right) {
  return isDeepStrictEqual(left, right);
}

const REPAIR_FALLBACK_DROP = (row) => ({ source_sense_id: row.source_sense_id, candidate: row.candidate, disposition: 'drop', reason: 'f' });
const repairKey = (row) => `${row.source_sense_id}\u0000${row.candidate}`;
const isProblemId = (problem) => isPlainObject(problem) && keysOf(problem) === 'condition,field_path'
  && typeof problem.field_path === 'string' && typeof problem.condition === 'string';

/** Normalize one input decision and report structured problems; a refused normalization is a problem, not a throw. */
function checkOneDecision(checkpoint, item, candidate, decision, pathPrefix, normalizedLog, options = {}) {
  const notes = [];
  let normalizedDecision = decision;
  const refused = [];
  try { normalizedDecision = normalizeInputDecision(checkpoint, decision, candidate, notes); }
  catch (error) {
    refused.push({ field_path: `${pathPrefix}.reverse_type`, condition: 'forbidden', message: `${item.sense_id}/${candidate.text}: ${error.message}` });
  }
  const { problems, unevaluated } = decisionProblems(item, options.validationCandidate ?? candidate, normalizedDecision,
    { allowSupervisorFailureDrop: options.allowSupervisorFailureDrop === true, pathPrefix });
  if (normalizedDecision?.disposition === 'drop' && normalizedDecision.reason === 'x' && options.glossContext) {
    const matches = findGlossNamedDrops({
      dropRows: [{ source_sense_id: item.sense_id, candidate: candidate.text, reason: 'x' }],
      ...options.glossContext,
    });
    if (matches.length) problems.push({ field_path: `${pathPrefix}.reason`, condition: 'gloss_named', message: matches[0].message });
  }
  for (const note of notes) {
    normalizedLog.push({ candidate_key: `${item.sense_id}\u0000${candidate.text}`, field_path: `${pathPrefix}.${note.field}`, rule: note.rule });
  }
  return { decision: normalizedDecision, problems: [...refused, ...problems], unevaluated };
}

/**
 * The single, pure Stage 2 repair check: input shape → existing receipt → premerge baseline → per-row
 * normalization and structured validation. Local (per-candidate) problems are returned; global problems throw.
 */
function checkRepair(checkpoint, input, baseline, { requireNonce = true } = {}) {
  const allowed = ['decisions', 'fingerprint', 'supervisor_fallback', 'supervisor_nonce', 'version'];
  if (!isPlainObject(input) || Object.keys(input).some((key) => !allowed.includes(key))
      || input.version !== 1 || !/^[a-f0-9]{64}$/u.test(input.fingerprint ?? '')
      || (input.supervisor_nonce === undefined ? requireNonce : !/^[a-f0-9]{64}$/u.test(input.supervisor_nonce))
      || !Array.isArray(input.decisions) || input.decisions.length === 0) {
    throw new Error('repair input must contain version 1, a fingerprint, a Supervisor nonce and non-empty decisions');
  }
  if (input.decisions.some((row) => !isPlainObject(row) || typeof row.source_sense_id !== 'string' || typeof row.candidate !== 'string')) {
    throw new Error('repair decisions need unique exact candidate keys and current/new decision fields');
  }
  const rows = [...input.decisions].sort((left, right) => repairKey(left).localeCompare(repairKey(right)));
  if (rows.some((row, index) => keysOf(row) !== 'additional_relations,candidate,decision,expected_additional_relations,expected_decision,source_sense_id'
      || (index > 0 && repairKey(rows[index - 1]) === repairKey(row)))) {
    throw new Error('repair decisions need unique exact candidate keys and current/new decision fields');
  }
  const requestId = stableDigest({ fingerprint: input.fingerprint, decisions: rows });
  const receipts = checkpoint.repair_receipts ?? [];
  const prior = receipts.find((receipt) => receipt.request_id === requestId);
  if (prior && input.supervisor_nonce !== undefined && prior.supervisor_nonce !== input.supervisor_nonce) {
    throw new Error('repair receipt is bound to another Supervisor apply intent; refusing replay');
  }
  const selected = rows.map((row) => {
    const item = checkpoint.items.find((entry) => entry.sense_id === row.source_sense_id);
    const candidate = item?.candidates.find((entry) => entry.text === row.candidate);
    if (!item || !candidate) throw new Error(`repair target is outside this Part: ${row.source_sense_id}/${row.candidate}`);
    return { row, item, candidate };
  });
  const fallbackRows = input.supervisor_fallback ?? [];
  if (!Array.isArray(fallbackRows)) throw new Error('supervisor_fallback must be an array');
  const fallbackKeys = new Set();
  for (const entry of fallbackRows) {
    const selectedRow = isPlainObject(entry) ? selected.find(({ row }) => repairKey(row) === repairKey(entry)) : null;
    if (!isPlainObject(entry) || keysOf(entry) !== 'candidate,evidence,source_sense_id' || !selectedRow
        || fallbackKeys.has(repairKey(entry))) {
      throw new Error('supervisor_fallback needs one exact repair row per candidate with its evidence');
    }
    fallbackKeys.add(repairKey(entry));
    const { row, item, candidate } = selectedRow;
    if (candidate.already_accounted === true) throw new Error(`${row.source_sense_id}/${row.candidate}: technical fallback applies only to ordinary candidates`);
    if (!sameJson(row.decision, REPAIR_FALLBACK_DROP(row)) || row.additional_relations !== null) {
      throw new Error(`${row.source_sense_id}/${row.candidate}: a fallback row must carry exactly the technical Drop f decision`);
    }
    const evidence = entry.evidence;
    const prior_request = evidence?.prior_request;
    if (!isPlainObject(evidence) || keysOf(evidence) !== 'current_row,prior_request' || !isPlainObject(prior_request)
        || keysOf(prior_request) !== 'attempt,problem,response_sha256,run_id' || !isProblemId(prior_request.problem)
        || !Number.isInteger(prior_request.attempt) || !Number.isInteger(prior_request.run_id)
        || !/^[a-f0-9]{64}$/u.test(prior_request.response_sha256)) {
      throw new Error(`${row.source_sense_id}/${row.candidate}: fallback evidence is malformed`);
    }
    if (evidence.current_row === null) {
      if (prior_request.problem.field_path !== 'row' || prior_request.problem.condition !== 'required') {
        throw new Error(`${row.source_sense_id}/${row.candidate}: an omitted row is a recurrence only of a requested row-required problem`);
      }
    } else {
      const current = evidence.current_row;
      if (!isPlainObject(current) || current.source_sense_id !== row.source_sense_id || current.candidate !== row.candidate
          || !isPlainObject(current.decision)) {
        throw new Error(`${row.source_sense_id}/${row.candidate}: fallback current_row does not bind to this candidate`);
      }
      const { problems } = checkOneDecision(checkpoint, item, candidate, current.decision, 'decision', [], { glossContext: baseline.glossContext });
      if (!problems.some((problem) => problem.field_path === prior_request.problem.field_path
          && problem.condition === prior_request.problem.condition)) {
        throw new Error(`${row.source_sense_id}/${row.candidate}: the requested problem ${prior_request.problem.field_path} [${prior_request.problem.condition}] does not currently exist`);
      }
    }
  }
  if (prior) {
    // A legacy receipt proves the write, not that a subsequently strengthened local check passes.
    // Re-check x against the current source gloss before treating a read-only probe as successful.
    if (!requireNonce) {
      const invalid = selected.flatMap(({ row, item, candidate }) => {
        const checked = checkOneDecision(checkpoint, item, candidate, row.decision, 'decision', [],
          { glossContext: baseline.glossContext });
        const problems = checked.problems.filter((problem) => problem.condition === 'gloss_named');
        return problems.length ? [{ candidate_key: repairKey(row), problems, unevaluated: [] }] : [];
      });
      if (invalid.length) return { ok: false, already_applied: true, repaired: 0, request_id: requestId,
        supervisor_nonce: prior.supervisor_nonce, candidate_keys: prior.candidate_keys, normalized: [], invalid_candidates: invalid };
    }
    const expectedKeys = selected.map(({ row }) => repairKey(row)).sort();
    if (!sameJson(prior.candidate_keys, expectedKeys)) {
      throw new Error('repair receipt exists but its candidate set does not match; refusing replay');
    }
    for (const { row, candidate } of selected) {
      const expectedNewDecision = candidate.already_accounted === true ? candidate.decision
        : fallbackKeys.has(repairKey(row)) ? row.decision : normalizeInputDecision(checkpoint, row.decision, candidate);
      const expectedNewRelations = candidate.already_accounted === true
        ? row.additional_relations.map((relation) => normalizeInputDecision(checkpoint, relation, candidate)) : null;
      if (!sameJson(candidate.decision, expectedNewDecision)
          || !sameJson(candidate.additional_relations ?? null, expectedNewRelations)) {
        throw new Error('repair receipt exists but its candidate state no longer matches; refusing replay');
      }
    }
    return { ok: true, already_applied: true, repaired: 0, request_id: requestId, supervisor_nonce: prior.supervisor_nonce,
      candidate_keys: prior.candidate_keys, normalized: [], invalid_candidates: [] };
  }
  if (!sameFileState(baseline.actualRelations, baseline.relations) || !sameFileState(baseline.actualDrops, baseline.drops)) {
    throw new Error('Relation/Drop outputs differ from the trusted premerge snapshot; refusing repair');
  }
  const next = JSON.parse(JSON.stringify(checkpoint));
  const nextByKey = new Map(next.items.flatMap((item) => item.candidates.map((candidate) =>
    [`${item.sense_id}\u0000${candidate.text}`, { item, candidate }])));
  const normalizedLog = [];
  const invalid = [];
  for (const { row, item, candidate } of selected) {
    const expectedOptional = candidate.already_accounted === true
      ? (candidate.additional_relations ?? []).map((relation) => presentedDecision(checkpoint, relation)) : null;
    if (!sameJson(presentedDecision(checkpoint, candidate.decision), row.expected_decision)
        || !sameJson(expectedOptional, row.expected_additional_relations)) {
      throw new Error(`stale repair target: ${row.source_sense_id}/${row.candidate}`);
    }
    const current = nextByKey.get(`${item.sense_id}\u0000${candidate.text}`).candidate;
    const problems = [];
    const unevaluated = [];
    if (candidate.already_accounted === true) {
      if (row.decision !== null || !Array.isArray(row.additional_relations)) {
        throw new Error(`${row.source_sense_id}/${row.candidate}: existing coverage may only replace optional links`);
      }
      if (row.additional_relations.length > candidate.unlinked_target_sense_ids.length) {
        throw new Error(`${row.source_sense_id}/${row.candidate}: optional links exceed the supplied not-yet-linked target senses`);
      }
      const checked = [];
      row.additional_relations.forEach((relation, index) => {
        const result = checkOneDecision(checkpoint, item, candidate, relation, `additional_relations[${index}]`, normalizedLog,
          { validationCandidate: { ...candidate, additional_relations: checked } });
        problems.push(...result.problems);
        unevaluated.push(...result.unevaluated);
        if (checked.some((saved) => saved.target_sense_id === result.decision?.target_sense_id)) {
          problems.push({ field_path: `additional_relations[${index}].target_sense_id`, condition: 'duplicate',
            message: `${row.source_sense_id}/${row.candidate}: repeated optional target ${result.decision.target_sense_id}` });
        }
        checked.push(result.decision);
      });
      current.additional_relations = checked;
    } else {
      if (row.additional_relations !== null) throw new Error(`${row.source_sense_id}/${row.candidate}: regular candidate cannot contain optional links`);
      const result = checkOneDecision(checkpoint, item, candidate, row.decision, 'decision', normalizedLog,
        { allowSupervisorFailureDrop: fallbackKeys.has(repairKey(row)), glossContext: baseline.glossContext });
      problems.push(...result.problems);
      unevaluated.push(...result.unevaluated);
      current.decision = result.decision;
    }
    if (problems.length) invalid.push({ candidate_key: repairKey(row), problems, unevaluated });
  }
  const candidateKeys = selected.map(({ row }) => repairKey(row)).sort();
  const base = { already_applied: false, request_id: requestId, supervisor_nonce: input.supervisor_nonce ?? null,
    candidate_keys: candidateKeys, normalized: normalizedLog, invalid_candidates: invalid };
  if (invalid.length) return { ok: false, repaired: 0, ...base };
  next.repair_receipts = [...receipts, {
    request_id: requestId,
    fingerprint: input.fingerprint,
    supervisor_nonce: input.supervisor_nonce ?? '0'.repeat(64),
    candidate_keys: candidateKeys,
  }];
  if (next.optional_review_complete === true) next.optional_review_state_sha256 = stableDigest(optionalReviewState(next));
  validateCheckpoint(next);
  validateCheckpointDecisions(next);
  return { ok: true, repaired: selected.length, ...base, next };
}

async function applyRepair(checkpoint, checkpointPath, inputPath, root, { check = false } = {}) {
  assertPrimaryComplete(checkpoint);
  assertOptionalComplete(checkpoint);
  validateCheckpointDecisions(checkpoint);
  if (checkpoint.merged) throw new Error('repair cannot change a merged checkpoint');
  if (!checkpoint.premerge || checkpoint.premerge.status !== 'ready') throw new Error('repair requires the trusted premerge snapshot');
  const [raw, ready] = await Promise.all([
    readFile(resolveRootPath(root, inputPath), 'utf8'),
    readReadyPremerge(checkpoint, checkpointPath),
  ]);
  let input;
  try { input = JSON.parse(raw); } catch (error) { throw new Error(`cannot parse repair input: ${error.message}`); }
  const [actualRelations, actualDrops] = await Promise.all([
    readFileState(shardRelationPath(checkpoint.shard, root)), readFileState(shardDropPath(checkpoint.shard, root))]);
  if (Array.isArray(input?.supervisor_fallback) && input.supervisor_fallback.length) {
    await assertSupervisorFallbackProcess(await supervisorStateDirectory(root));
  }
  // Use the same source-bound gloss check as preflight, including orthographic aliases. Only
  // x decisions (or fallback evidence for one) need the canonical index.
  const needsGloss = (Array.isArray(input?.decisions) && input.decisions.some((row) => row?.decision?.disposition === 'drop' && row.decision.reason === 'x'))
    || (Array.isArray(input?.supervisor_fallback) && input.supervisor_fallback.some((row) => row?.evidence?.current_row?.decision?.disposition === 'drop'
      && row.evidence.current_row.decision.reason === 'x'));
  let glossContext;
  if (needsGloss) {
    const loaded = await loadShard(checkpoint.shard, root, { batch: checkpoint.batch });
    const scoped = partScope(loaded.canonicalRows, loaded.candidateFiles, checkpoint.batch, checkpoint.part, checkpoint.shard);
    glossContext = { scopeRows: scoped.scopeRows, index: loaded.index };
  }
  const { next, ...result } = checkRepair(checkpoint, input, { ...ready, actualRelations, actualDrops, glossContext }, { requireNonce: !check });
  if (!result.ok || check || result.already_applied) return result;
  await writeJsonAtomically(checkpointPath, next);
  return result;
}

function assertOldOrNew(actual, oldState, newState, family) {
  if (!sameFileState(actual, oldState) && !sameFileState(actual, newState)) {
    throw new Error(`${family} output matches neither its trusted premerge snapshot nor the deterministic Part result`);
  }
}

async function mergeCheckpoint(checkpoint, checkpointPath, root) {
  if (checkpoint.merged && !checkpoint.premerge) {
    return { merged: true, legacy_snapshot_unavailable: true, checkpoint: checkpointPath };
  }
  assertPrimaryComplete(checkpoint);
  assertOptionalComplete(checkpoint);
  validateCheckpointDecisions(checkpoint);
  const baseline = await ensurePremerge(checkpoint, checkpointPath, root);
  const expected = await materializePart(checkpoint, root, baseline);
  const actualRelations = await readFileState(baseline.relationFile);
  const actualDrops = await readFileState(baseline.dropFile);
  assertOldOrNew(actualRelations, baseline.relations, expected.relations, 'Relation');
  assertOldOrNew(actualDrops, baseline.drops, expected.drops, 'Drop');
  if (checkpoint.merged) {
    if (!sameFileState(actualRelations, expected.relations) || !sameFileState(actualDrops, expected.drops)) {
      throw new Error('merged checkpoint outputs do not match deterministic materialization');
    }
    return { merged: true, relations_added: 0, drops_added: 0, already_merged: true, checkpoint: checkpointPath };
  }
  if (!sameFileState(actualRelations, expected.relations)) await writeFileStateAtomically(baseline.relationFile, expected.relations);
  if (!sameFileState(actualDrops, expected.drops)) await writeFileStateAtomically(baseline.dropFile, expected.drops);
  checkpoint.merged = true;
  await writeJsonAtomically(checkpointPath, checkpoint);
  const result = {
    merged: true,
    relations_added: expected.merged.relations.length - expected.existingRelations.length,
    drops_added: expected.merged.drops.length - expected.existingDrops.length,
    checkpoint: checkpointPath,
  };
  console.log(`Merged ${result.relations_added} Relations and ${result.drops_added} Drops for ${checkpoint.shard}/${checkpoint.batch}/${checkpoint.part}`);
  return result;
}

function parseAmendDecision(line, row, targets, selectedOptional = [], checkpoint) {
  const fields = line.split(/\s+/u);
  const alias = fields[0];
  const kind = fields[1];
  if (kind === 'skip' && fields.length === 2 && row.candidate.already_accounted === true) {
    return { optional: true, skip: true, relations: [] };
  }
  if (kind === 'D') {
    if (row.candidate.already_accounted === true) throw new Error('existing coverage can only add or skip optional links');
    const reason = line.slice(alias.length).trim().slice(kind.length).trim();
    const decision = { source_sense_id: row.item.sense_id, candidate: row.candidate.text, disposition: 'drop', reason };
    validateDecision(row.item, row.candidate, decision);
    return { optional: false, decision };
  }
  if (kind !== 'R' || fields.length < 4) throw new Error('use R <type> <tier> with a valid target form, or D x|e');
  const type = fields[2];
  const relevance = compactTier(fields[3], alias);
  const rest = fields.slice(4);
  const relation = { source_sense_id: row.item.sense_id, candidate: row.candidate.text,
    disposition: 'relation', type, relevance };
  if (rest.length === 0) {
    if (row.candidate.same_spelling_targets.length || row.candidate.already_accounted === true) {
      throw new Error('target senses exist; choose T<k> or list every checked target after none');
    }
    validateDecision(row.item, row.candidate, relation);
    return { optional: false, decision: relation };
  }
  if (rest.length === 2 && rest[0] === 'none') {
    if (row.candidate.already_accounted === true) throw new Error('optional links require an exact target sense');
    const aliases = rest[1].split(',');
    const targetByAlias = new Map([...targets.values()].map((target) => [target.alias, target]));
    const checked = aliases.map((name) => {
      const target = targetByAlias.get(name);
      if (!target || !row.targetAliases.includes(name)) throw new Error('unknown or unrelated target alias ' + name);
      return target.sense_id;
    });
    const decision = { ...relation, target_resolution: 'no_exact_match', checked_target_sense_ids: checked };
    validateDecision(row.item, row.candidate, decision);
    return { optional: false, decision };
  }
  const mirrorPolicy = usesSourceMirrorTypeTier(checkpoint);
  if (mirrorPolicy ? rest.length !== 1 : rest.length !== 3) {
    throw new Error(mirrorPolicy
      ? 'exact ID amendment uses T<k>; the CLI derives reverse type/Tier'
      : 'Relation syntax needs T<k> reverse-type reverse-tier or none T<a>,T<b>,...');
  }
  const [targetName, reverseType, reverseTierText] = rest;
  const target = [...targets.values()].find((entry) => entry.alias === targetName);
  if (!target || !row.targetAliases.includes(targetName)) throw new Error('unknown or unrelated target alias ' + targetName);
  const decision = normalizeInputDecision(checkpoint, {
    ...relation, target_resolution: 'exact', target_record_id: target.record_id, target_sense_id: target.sense_id,
    ...(!mirrorPolicy ? { reverse_type: reverseType, reverse_relevance: compactTier(reverseTierText, alias + ' reverse') } : {}),
  });
  if (row.candidate.already_accounted !== true) {
    validateDecision(row.item, row.candidate, decision);
    return { optional: false, decision };
  }
  const validationCandidate = { ...row.candidate, additional_relations: selectedOptional };
  validateDecision(row.item, validationCandidate, decision);
  if (selectedOptional.some((saved) => saved.target_sense_id === target.sense_id)) {
    throw new Error('repeats target ' + target.sense_id);
  }
  if (!row.candidate.unlinked_target_sense_ids.includes(target.sense_id)) {
    throw new Error('target ' + target.sense_id + ' is not an optional same-spelling sense');
  }
  return { optional: true, relation: decision };
}

function parseAmendInput(raw, checkpoint) {
  const meaningful = raw.replace(/\r\n/gu, '\n').split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const header = (meaningful.shift() || '').split(/\s+/u);
  if (header.length !== 3 || header[0] !== 'amend' || !/^@[a-f0-9]{64}$/u.test(header[2])) {
    throw new Error('amend input must start with "amend <sorted-sense-ids> @<inspect-digest>"');
  }
  const senseIds = header[1].split(',');
  if (senseIds.some((id) => !id) || new Set(senseIds).size !== senseIds.length
      || JSON.stringify(senseIds) !== JSON.stringify([...senseIds].sort())) {
    throw new Error('amend header sense IDs must be unique and sorted');
  }
  const selected = requestedCheckpointCandidates(checkpoint, senseIds);
  const digest = inspectDigest(checkpoint, selected);
  if (header[2] !== '@' + digest) throw new Error('stale inspect digest: expected @' + digest);
  const model = inspectModel(selected);
  const byAlias = new Map(model.candidates.map((row) => [row.alias, row]));
  const changes = new Map();
  const errors = [];
  for (const line of meaningful) {
    const alias = line.split(/\s+/u)[0];
    const row = byAlias.get(alias);
    if (!row) { errors.push(alias + ': names no candidate in the inspected source senses'); continue; }
    const change = changes.get(alias) || { optional: row.candidate.already_accounted === true, relations: [] };
    try {
      const parsed = parseAmendDecision(line, { ...row, optionalRelations: change.relations }, model.targets, change.relations, checkpoint);
      if (parsed.optional) {
        if (!change.optional) throw new Error('candidate has more than one replacement decision');
        if (parsed.skip) {
          if (change.skip || change.relations.length) throw new Error('skip cannot repeat or mix with Relation rows');
          change.skip = true;
        } else if (parsed.relation) {
          if (change.skip) throw new Error('skip cannot mix with Relation rows');
          change.relations.push(parsed.relation);
        }
      } else {
        if (change.decision || change.relations.length || change.skip) throw new Error('candidate has more than one replacement decision');
        change.decision = parsed.decision;
      }
      changes.set(alias, change);
    } catch (error) { errors.push(alias + ': ' + error.message); }
  }
  if (!meaningful.length) errors.push('amend needs at least one sparse decision row');
  if (errors.length) throw new Error('invalid amend input: ' + errors.length + ' problem(s)\n' + errors.join('\n'));
  return { digest, senseIds, changes, model };
}

function applyAmendChanges(checkpoint, parsed) {
  const next = JSON.parse(JSON.stringify(checkpoint));
  const rows = new Map(parsed.model.candidates.map((row) => [row.alias, row]));
  let changed = 0;
  for (const [alias, replacement] of parsed.changes) {
    const row = rows.get(alias);
    const item = next.items.find((entry) => entry.sense_id === row.item.sense_id);
    const candidate = item.candidates.find((entry) => entry.text === row.candidate.text);
    if (candidate.already_accounted === true) {
      const relations = replacement.skip ? [] : replacement.relations;
      if (JSON.stringify(candidate.additional_relations) !== JSON.stringify(relations)) changed += 1;
      candidate.additional_relations = relations;
    } else {
      if (JSON.stringify(candidate.decision) !== JSON.stringify(replacement.decision)) changed += 1;
      candidate.decision = replacement.decision;
    }
  }
  if (!changed) return { checkpoint: next, changed: 0 };
  next.amend_revision = (next.amend_revision || 0) + 1;
  if (next.optional_review_complete === true) next.optional_review_state_sha256 = stableDigest(optionalReviewState(next));
  validateCheckpoint(next);
  validateCheckpointDecisions(next);
  return { checkpoint: next, changed };
}

function bytesState(bytes) {
  return { exists: true, bytes, sha256: sha256(bytes) };
}

function classifyAmendState(actual, oldStates, newStates) {
  const oldCheckpoint = sameFileState(actual.checkpoint, oldStates.checkpoint);
  const newCheckpoint = sameFileState(actual.checkpoint, newStates.checkpoint);
  const oldRelations = sameFileState(actual.relations, oldStates.relations);
  const newRelations = sameFileState(actual.relations, newStates.relations);
  const oldDrops = sameFileState(actual.drops, oldStates.drops);
  const newDrops = sameFileState(actual.drops, newStates.drops);
  if (newCheckpoint && newRelations && newDrops) return 4;
  if (oldCheckpoint && newRelations && newDrops) return 3;
  if (oldCheckpoint && newRelations && oldDrops) return 2;
  if (oldCheckpoint && oldRelations && oldDrops) return 1;
  return 0;
}

function checkpointBytes(checkpoint) {
  return Buffer.from(JSON.stringify(checkpoint) + '\n', 'utf8');
}

async function readAmendJournal(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
  if (!isPlainObject(value) || ![1, 2].includes(value.version) || typeof value.request_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.request_sha256)
        || typeof value.old_checkpoint_b64 !== 'string' || typeof value.new_checkpoint_b64 !== 'string') {
      throw new Error('malformed amend recovery journal');
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('cannot read amend recovery journal: ' + error.message);
  }
}

function checkpointFromJournal(encoded) {
  return validateCheckpoint(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));
}

function encodeFileState(state) {
  return { exists: state.exists, bytes: state.bytes.toString('base64') };
}

function decodeFileState(value) {
  if (!isPlainObject(value) || typeof value.exists !== 'boolean' || typeof value.bytes !== 'string'
      || (!value.exists && value.bytes !== '')) throw new Error('malformed foreign Relation state');
  const bytes = Buffer.from(value.bytes, 'base64');
  if (bytes.toString('base64') !== value.bytes) throw new Error('malformed foreign Relation state');
  return { exists: value.exists, bytes, sha256: value.exists ? sha256(bytes) : null };
}

async function foreignRelationFiles(root, shard, baselines = {}) {
  const directory = path.join(root, 'data/relations');
  const names = (await readdir(directory)).filter((name) => /^relation-\d{3}\.jsonl$/u.test(name)
    && name !== `relation-${shard}.jsonl`).sort();
  if (Object.keys(baselines).some((name) => !names.includes(name))) throw new Error('foreign Relation baseline file is missing');
  const files = [];
  for (const name of names) {
    const actual = await readFileState(path.join(directory, name));
    const baseline = baselines[name] ? decodeFileState(baselines[name]) : actual;
    files.push({ name, actual, baseline, rows: parseJsonlState(baseline, 'Relation') });
  }
  return files;
}

function foreignResults(files) {
  return Object.fromEntries(files.map(({ name, baseline, rows }) => [name,
    sameRows(rows, parseJsonlState(baseline, 'Relation')) ? baseline : serializedJsonlState(rows, baseline, 'Relation')]));
}

async function materializeWithForeign(checkpoint, root, baseline, baselines) {
  const files = await foreignRelationFiles(root, checkpoint.shard, baselines);
  const result = await materializePart(checkpoint, root, baseline, null, null, files);
  return { ...result, files, foreign: foreignResults(files) };
}

async function applyForeignAmendJournal(journal, checkpointPath, root, { checkOnly = false } = {}) {
  if (!isPlainObject(journal.foreign) || Object.keys(journal.foreign).some((name) => !/^relation-\d{3}\.jsonl$/u.test(name))) {
    throw new Error('malformed foreign Relation journal');
  }
  const oldCheckpoint = checkpointFromJournal(journal.old_checkpoint_b64);
  const newCheckpoint = checkpointFromJournal(journal.new_checkpoint_b64);
  if (oldCheckpoint.shard !== newCheckpoint.shard || oldCheckpoint.batch !== newCheckpoint.batch
      || oldCheckpoint.part !== newCheckpoint.part || newCheckpoint.amend_revision !== (oldCheckpoint.amend_revision || 0) + 1) {
    throw new Error('foreign Relation journal checkpoint identity mismatch');
  }
  const baseline = await readReadyPremerge(oldCheckpoint, checkpointPath);
  const baselines = Object.fromEntries(Object.entries(journal.foreign).map(([name, entry]) => [name, entry.baseline]));
  const oldResult = await materializeWithForeign(oldCheckpoint, root, baseline, baselines);
  const newResult = await materializeWithForeign(newCheckpoint, root, baseline, baselines);
  for (const file of oldResult.files) {
    if (!Object.hasOwn(journal.foreign, file.name) && (!sameFileState(oldResult.foreign[file.name], file.actual)
        || !sameFileState(newResult.foreign[file.name], file.actual))) {
      throw new Error('foreign Relation journal omits a changed file');
    }
  }
  const entries = [];
  for (const name of Object.keys(journal.foreign).sort()) {
    const entry = journal.foreign[name];
    const oldState = decodeFileState(entry.old);
    const newState = decodeFileState(entry.new);
    if (!oldResult.foreign[name] || !sameFileState(oldResult.foreign[name], oldState)
        || !sameFileState(newResult.foreign[name], newState)) throw new Error('foreign Relation journal does not reproduce its results');
    entries.push({ file: path.join(root, 'data/relations', name), oldState, newState });
  }
  entries.push(
    { file: shardRelationPath(oldCheckpoint.shard, root), oldState: oldResult.relations, newState: newResult.relations },
    { file: shardDropPath(oldCheckpoint.shard, root), oldState: oldResult.drops, newState: newResult.drops },
    { file: checkpointPath, oldState: bytesState(checkpointBytes(oldCheckpoint)), newState: bytesState(checkpointBytes(newCheckpoint)) },
  );
  let pending = false;
  for (const entry of entries) {
    const actual = await readFileState(entry.file);
    const oldMatch = sameFileState(actual, entry.oldState);
    const newMatch = sameFileState(actual, entry.newState);
    if (!oldMatch && !newMatch) throw new Error('amend outputs/checkpoint are in an unrecognized state; preserving all files');
    if (!newMatch) pending = true;
    else if (pending && !oldMatch) throw new Error('amend outputs/checkpoint are in an unrecognized state; preserving all files');
  }
  if (!pending) return { amended: true, already_applied: true, checkpoint: checkpointPath };
  if (checkOnly) throw new Error('another amend is incomplete; rerun its exact input before starting a different request');
  for (const entry of entries) {
    if (!sameFileState(await readFileState(entry.file), entry.newState)) await writeFileStateAtomically(entry.file, entry.newState);
  }
  return { amended: true, checkpoint: checkpointPath };
}

async function applyAmendJournalState(checkpoint, checkpointPath, root, oldCheckpoint, newCheckpoint, requestHash, journalPath) {
  const baseline = await readReadyPremerge(checkpoint, checkpointPath);
  const oldResult = await materializePart(oldCheckpoint, root, baseline);
  const newResult = await materializePart(newCheckpoint, root, baseline);
  const relationFile = shardRelationPath(checkpoint.shard, root);
  const dropFile = shardDropPath(checkpoint.shard, root);
  const oldStates = { checkpoint: bytesState(checkpointBytes(oldCheckpoint)), relations: oldResult.relations, drops: oldResult.drops };
  const newStates = { checkpoint: bytesState(checkpointBytes(newCheckpoint)), relations: newResult.relations, drops: newResult.drops };
  const actual = { checkpoint: await readFileState(checkpointPath), relations: await readFileState(relationFile), drops: await readFileState(dropFile) };
  const state = classifyAmendState(actual, oldStates, newStates);
  if (!state) throw new Error('amend outputs/checkpoint are in an unrecognized state; preserving all files');
  if (state === 4) return { amended: true, already_applied: true, checkpoint: checkpointPath };
  await writeJsonAtomically(journalPath, {
    version: 1,
    request_sha256: requestHash,
    old_checkpoint_b64: checkpointBytes(oldCheckpoint).toString('base64'),
    new_checkpoint_b64: checkpointBytes(newCheckpoint).toString('base64'),
  });
  // The sequence is not a transaction: each rename is atomic and retry accepts only the four specified states.
  if (!sameFileState(actual.relations, newStates.relations)) await writeFileStateAtomically(relationFile, newStates.relations);
  if (!sameFileState(actual.drops, newStates.drops)) await writeFileStateAtomically(dropFile, newStates.drops);
  if (!sameFileState(actual.checkpoint, newStates.checkpoint)) await writeFileStateAtomically(checkpointPath, newStates.checkpoint);
  return { amended: true, changed_candidates: newResult.changed || undefined, checkpoint: checkpointPath };
}

async function amendCheckpointLocked(checkpoint, checkpointPath, inputPath, root) {
  if (!checkpoint.merged) throw new Error('amend requires checkpoint.merged=true in the current Part worktree');
  if (!checkpoint.premerge) throw new Error('this merged checkpoint has no premerge snapshot and cannot be amended');
  assertOptionalComplete(checkpoint);
  const baseline = await readReadyPremerge(checkpoint, checkpointPath);
  const relationFile = shardRelationPath(checkpoint.shard, root);
  const dropFile = shardDropPath(checkpoint.shard, root);
  const journalPath = checkpointPath.replace(/\.json$/u, '.amend-state.json');
  const [raw, journal] = await Promise.all([
    readFile(resolveRootPath(root, inputPath), 'utf8'),
    readAmendJournal(journalPath),
  ]);
  const requestHash = sha256(Buffer.from(raw, 'utf8'));
  const current = { checkpoint: await readFileState(checkpointPath), relations: await readFileState(relationFile), drops: await readFileState(dropFile) };
  if (journal?.version === 2) {
    const oldCheckpoint = checkpointFromJournal(journal.old_checkpoint_b64);
    if (journal.request_sha256 === requestHash) {
      const parsed = parseAmendInput(raw, oldCheckpoint);
      const replay = applyAmendChanges(oldCheckpoint, parsed);
      if (!replay.changed || JSON.stringify(replay.checkpoint) !== JSON.stringify(checkpointFromJournal(journal.new_checkpoint_b64))) {
        throw new Error('same amend input does not reproduce its recorded new checkpoint');
      }
      return applyForeignAmendJournal(journal, checkpointPath, root);
    }
    await applyForeignAmendJournal(journal, checkpointPath, root, { checkOnly: true });
  } else if (journal) {
    const oldCheckpoint = checkpointFromJournal(journal.old_checkpoint_b64);
    const newCheckpoint = checkpointFromJournal(journal.new_checkpoint_b64);
    const oldResult = await materializePart(oldCheckpoint, root, baseline);
    const newResult = await materializePart(newCheckpoint, root, baseline);
    const oldStates = { checkpoint: bytesState(checkpointBytes(oldCheckpoint)), relations: oldResult.relations, drops: oldResult.drops };
    const newStates = { checkpoint: bytesState(checkpointBytes(newCheckpoint)), relations: newResult.relations, drops: newResult.drops };
    const state = classifyAmendState(current, oldStates, newStates);
    if (!state) throw new Error('amend recovery found an unrecognized checkpoint/Relation/Drop combination; preserving all files');
    if (journal.request_sha256 === requestHash) {
      const parsed = parseAmendInput(raw, oldCheckpoint);
      const replay = applyAmendChanges(oldCheckpoint, parsed);
      if (!replay.changed || JSON.stringify(replay.checkpoint) !== JSON.stringify(newCheckpoint)) {
        throw new Error('same amend input does not reproduce its recorded new checkpoint');
      }
      if (state === 4) return { amended: true, already_applied: true, checkpoint: checkpointPath };
      return applyAmendJournalState(checkpoint, checkpointPath, root, oldCheckpoint, newCheckpoint, requestHash, journalPath);
    }
    if (state !== 4) throw new Error('another amend is incomplete; rerun its exact input before starting a different request');
  }
  const foreignBaselines = journal?.version === 2
    ? Object.fromEntries(Object.entries(journal.foreign).map(([name, entry]) => [name, entry.baseline])) : {};
  const currentExpected = await materializeWithForeign(checkpoint, root, baseline, foreignBaselines);
  if (!sameFileState(current.relations, currentExpected.relations) || !sameFileState(current.drops, currentExpected.drops)) {
    throw new Error('current merged outputs do not match materialize(premerge, checkpoint); refusing to amend drifted files');
  }
  for (const file of currentExpected.files) {
    if (!sameFileState(file.actual, currentExpected.foreign[file.name])) {
      throw new Error('foreign Relation output does not match materialize(premerge, checkpoint); refusing to amend drifted files');
    }
  }
  const parsed = parseAmendInput(raw, checkpoint);
  const applied = applyAmendChanges(checkpoint, parsed);
  if (!applied.changed) return { amended: true, changed_candidates: 0, unchanged: true, checkpoint: checkpointPath };
  const next = await materializeWithForeign(applied.checkpoint, root, baseline, foreignBaselines);
  const foreign = {};
  for (const file of currentExpected.files) {
    const oldState = currentExpected.foreign[file.name];
    const newState = next.foreign[file.name];
    if (Object.hasOwn(foreignBaselines, file.name) || !sameFileState(oldState, newState)) {
      foreign[file.name] = { baseline: encodeFileState(file.baseline), old: encodeFileState(oldState), new: encodeFileState(newState) };
    }
  }
  if (!Object.keys(foreign).length) return applyAmendJournalState(checkpoint, checkpointPath, root, checkpoint, applied.checkpoint, requestHash, journalPath);
  const nextJournal = { version: 2, request_sha256: requestHash,
    old_checkpoint_b64: checkpointBytes(checkpoint).toString('base64'),
    new_checkpoint_b64: checkpointBytes(applied.checkpoint).toString('base64'), foreign };
  await writeJsonAtomically(journalPath, nextJournal);
  return applyForeignAmendJournal(nextJournal, checkpointPath, root);
}

async function amendCheckpoint(checkpoint, checkpointPath, inputPath, root) {
  const lockPath = `${checkpointPath}.amend-lock`;
  const token = `${process.pid}:${randomUUID()}`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  try {
    await writeFile(lockPath, token, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner = '';
    try { owner = await readFile(lockPath, 'utf8'); } catch (readError) {
      if (readError.code !== 'ENOENT') throw readError;
    }
    const ownerPid = Number(owner.split(':', 1)[0]);
    let alive = Number.isInteger(ownerPid) && ownerPid > 0;
    if (alive) {
      try { process.kill(ownerPid, 0); } catch (probeError) { alive = probeError.code === 'EPERM'; }
    }
    if (alive) throw new Error(`another amend is active for this checkpoint (pid ${ownerPid}); preserving all files`);
    try { await unlink(lockPath); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
    await writeFile(lockPath, token, { flag: 'wx' });
  }
  try {
    return await amendCheckpointLocked(checkpoint, checkpointPath, inputPath, root);
  } finally {
    try {
      if ((await readFile(lockPath, 'utf8')) === token) await unlink(lockPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function assertCheckpointMerged(checkpoint, relationRows, dropRows) {
  if (!checkpoint.merged) throw new Error('Part checkpoint is not marked merged');
  const dropSet = new Set(dropRows.map(stableRow));
  const expected = decisionRows(checkpoint);
  const orthographicCoalesced = coalesceOrthographicAliasRelations(checkpoint, expected.relations, expected.relationCandidates);
  const coalesced = coalesceIdenticalSensePairRelations(orthographicCoalesced.relations, orthographicCoalesced.relationCandidates);
  // Index approved rows once instead of scanning all of them per expected row (O(N×M) on a growing shard file).
  // A text row can only match an identical text row; an ID row only an ID row on the same or reversed sense pair.
  const approvedText = new Set();
  const approvedIdByPair = new Map();
  for (const approved of relationRows) {
    if ('text' in approved) { approvedText.add(stableRow(approved)); continue; }
    const key = idPairKey(approved.source_sense_id, approved.target_sense_id);
    const bucket = approvedIdByPair.get(key);
    if (bucket) bucket.push(approved); else approvedIdByPair.set(key, [approved]);
  }
  for (const row of coalesced.relations) {
    const pairRows = 'text' in row ? [] : [
      ...(approvedIdByPair.get(idPairKey(row.source_sense_id, row.target_sense_id)) ?? []),
      ...(approvedIdByPair.get(idPairKey(row.target_sense_id, row.source_sense_id)) ?? []),
    ];
    const merged = 'text' in row ? approvedText.has(stableRow(row)) : pairRows.some((approved) => {
      const hasForms = (actual, wanted) => Array.isArray(actual) && wanted.every((form) => actual.includes(form));
      const sameOrientation = approved.source_record_id === row.source_record_id
        && approved.source_sense_id === row.source_sense_id
        && approved.target_record_id === row.target_record_id
        && approved.target_sense_id === row.target_sense_id;
      if (sameOrientation) {
        return approved.type === row.type && approved.relevance === row.relevance
          && approved.reverse_type === row.reverse_type && approved.reverse_relevance === row.reverse_relevance
          && [0, 1].includes(approved.candidate_assignment_version) && hasForms(approved.candidate_forms, row.candidate_forms);
      }
      return isConsistentReciprocalIdRelation(approved, row)
        && [0, 1].includes(approved.candidate_assignment_version)
        && hasForms(approved.reverse_candidate_forms, row.candidate_forms);
    });
    if (!merged) {
      throw new Error(`merged Part relation is missing: ${stableRow(row)}`);
    }
  }
  for (const row of expected.drops) if (!dropSet.has(stableRow(row))) throw new Error(`merged Part Drop is missing: ${stableRow(row)}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const argv = process.argv.slice(2);
  run(argv).then((result) => {
    if (argv[0] === 'preflight' && result?.ok !== true) process.exitCode = result?.repairable ? 2 : 1;
    if (argv[0] === 'repair' && result?.ok !== true) process.exitCode = 2;
  }).catch((error) => {
    // `verify --json`: only a deterministic rows/accounting failure is machine-classifiable (exit 2, one JSON line).
    if (argv[0] === 'verify' && argv.includes('--json') && error instanceof AdmissionVerifyError) {
      console.log(JSON.stringify({ version: 1, ok: false, family: error.family, errors: error.errors, total: error.total }));
      process.exitCode = 2;
      return;
    }
    console.error(error.message);
    process.exitCode = 1;
  });
}
