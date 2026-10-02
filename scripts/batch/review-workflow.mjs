/**
 * Reusable glue between the candidate authors, the independent reviewers, and
 * the shared batch builder (Issue #240, M10-A).
 *
 * Earlier M9 batches assembled these steps with untracked, one-off scripts.
 * This module makes them repeatable and testable:
 *
 *   merge-authors     authored/author-NN.json  -> authored-decisions.generator.json
 *   reviewer-packets  generator proposals      -> review-packets/review-packet-NN.json
 *   assemble          reviewed/review-NN.json  -> reviewer-raw-outputs.json (ignored),
 *                                                 authored-decisions.json (ignored),
 *                                                 tracked semantic-review-input + run record
 *
 * Every function validates its input and refuses to fill in anything a worker
 * did not write: a missing, duplicated, or malformed worker verdict is an
 * error, never a default. Worker outputs and packets carry corpus-derived
 * text and stay under ignored `data/reference/`.
 *
 *   node scripts/batch/review-workflow.mjs merge-authors --batch-id=ID --directory=DIR
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { glossFrameSpans } from './build-issue-223-corpus-batch.mjs';
import { findAmbiguousParticleFragments, validateLexicalRecord } from '../validate/lexical-quality.mjs';
import { sha256Json } from '../validate/semantic-audit.mjs';
import { packetCandidate, shardRanges } from './make-review-packets.mjs';
import { assertLegacyReviewWorkflowAllowed, SELF_CHECK_PROVENANCE } from './semantic-self-check.mjs';
import {
  admissionGateFor,
  outcomeFromRaw,
  reviewFromRaw,
  runRecordFromRaw,
  RAW_OUTPUTS_CONTRACT_VERSION,
  RAW_OUTPUTS_KIND,
} from './reviewer-raw-outputs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const AUTHOR_NAME = 'claude-sonnet-5-5';
export const REVIEWER_NAME = 'claude-sonnet-5-5-independent-reviewer';
const AXES = ['A', 'C', 'E', 'O', 'Q', 'S', 'X'];
const POS = ['noun', 'verb', 'adjective', 'adverb'];
const HOLD_BASES = ['unresolved-identity', 'unresolved-sense', 'search-collision'];
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pretty = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

export function passIdsFor(batchId) {
  const match = /^(.*-batch-[0-9]{2})-([0-9]{8})$/u.exec(batchId);
  assert.ok(match, `unsupported batch id ${batchId}`);
  const [, stem, date] = match;
  return {
    generation_pass_id: `${stem}-authored-generation-${date}-r1`,
    candidate_review_pass_id: `${stem}-lexical-review-${date}-r1`,
    semantic_verification_pass_id: `${stem}-semantic-verification-${date}-r1`,
  };
}

/** Run every check and report all failures together, so one rework round fixes them all. */
export function collectFailures(items, check) {
  const failures = [];
  items.forEach((item, index) => {
    try {
      check(item, index);
    } catch (error) {
      failures.push(error.message);
    }
  });
  if (failures.length > 0) {
    const shown = failures.slice(0, 60).map((message) => `  - ${message}`).join('\n');
    throw new Error(`${failures.length} worker output(s) failed validation:\n${shown}${failures.length > 60 ? '\n  ...' : ''}`);
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function numberedFiles(directory, prefix) {
  const pattern = new RegExp(`^${prefix}-([0-9]{2})\\.json$`, 'u');
  return (await readdir(directory))
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter(({ match }) => match)
    .map(({ name, match }) => ({ name, shard: Number(match[1]) }))
    .sort((left, right) => left.shard - right.shard);
}

function assertHitIndices(indices, hitCount, label, { allowEmpty = false } = {}) {
  assert.ok(Array.isArray(indices), `${label}: hit indices must be an array`);
  assert.ok(allowEmpty || indices.length > 0, `${label}: must cite at least one context`);
  assert.ok(indices.every((index) => Number.isInteger(index) && index >= 0 && index < hitCount),
    `${label}: cites a context outside the ${hitCount} bounded contexts`);
  assert.equal(new Set(indices).size, indices.length, `${label}: cites a context twice`);
}

/** Validate one author decision against its candidate; returns the clean row. */
export function validateAuthorDecision(decision, candidate, ordinal) {
  const label = `author decision ${ordinal} (${candidate.proposed_lemma})`;
  assert.equal(decision?.ordinal, ordinal, `${label}: ordinal mismatch`);
  assert.equal(decision.lemma, candidate.proposed_lemma, `${label}: bound to a different lemma`);
  const hitCount = candidate.evidence.representative_hits.length;
  if (decision.disposition === 'admit') {
    assert.ok(AXES.includes(decision.axis), `${label}: unsupported axis`);
    assert.ok(nonEmpty(decision.gloss), `${label}: an admission needs a gloss`);
    assert.ok(decision.gloss.trim().endsWith('.'), `${label}: gloss must be one sentence ending in a period`);
    const row = { candidate_ordinal: ordinal, lemma: decision.lemma, disposition: 'admit', axis: decision.axis, gloss: decision.gloss.trim() };
    if (decision.corrected_pos !== undefined) {
      assert.ok(POS.includes(decision.corrected_pos) && decision.corrected_pos !== candidate.proposed_pos, `${label}: invalid corrected POS`);
      assert.ok(nonEmpty(decision.pos_correction_rationale), `${label}: a POS correction needs a rationale`);
      assertHitIndices(decision.pos_correction_hit_indices, hitCount, `${label} POS correction`);
      row.corrected_pos = decision.corrected_pos;
      row.pos_correction_rationale = decision.pos_correction_rationale;
      row.pos_correction_hit_indices = decision.pos_correction_hit_indices;
    }
    return row;
  }
  assert.equal(decision.disposition, 'hold', `${label}: disposition must be admit or hold`);
  assert.ok(HOLD_BASES.includes(decision.basis), `${label}: unsupported hold basis`);
  assert.ok(nonEmpty(decision.rationale), `${label}: a hold needs a rationale`);
  const row = { candidate_ordinal: ordinal, lemma: decision.lemma, disposition: 'hold', basis: decision.basis, rationale: decision.rationale };
  if (decision.basis === 'unresolved-sense') {
    assert.ok(Array.isArray(decision.directions) && decision.directions.length >= 2, `${label}: a sense hold needs at least two directions`);
    row.directions = decision.directions.map((direction, index) => {
      assert.ok(nonEmpty(direction?.label), `${label}: direction ${index} needs a label`);
      assertHitIndices(direction.hit_indices, hitCount, `${label} direction ${index}`);
      return { label: direction.label, hit_indices: direction.hit_indices };
    });
  }
  return row;
}

/**
 * The shared lexical intake the builder applies to every admitted record, run
 * on a proposal before any reviewer sees it, so an unadmittable gloss costs no
 * review round.
 */
export function assertSharedIntake(row, candidate) {
  if (row.disposition !== 'admit') return;
  const id = 'w0000';
  validateLexicalRecord({
    id,
    record_type: 'entry',
    role: 'start',
    candidate_id: id,
    lemma: row.lemma,
    search_forms: [row.lemma],
    senses: [{ id: `${id}-s1`, pos: row.corrected_pos ?? candidate.proposed_pos, gloss: row.gloss }],
  }, { label: `intake ${row.lemma}`, mode: 'candidate', expectedId: id, expectedLemma: row.lemma });
}

export async function mergeAuthors({ batchId, directory }) {
  const absolute = path.resolve(ROOT, directory);
  const inventory = await readJson(path.join(absolute, 'candidate-inventory.json'));
  const files = await numberedFiles(path.join(absolute, 'authored'), 'author');
  const decisions = [];
  for (const { name } of files) {
    const rows = await readJson(path.join(absolute, 'authored', name));
    assert.ok(Array.isArray(rows), `${name} must be a JSON array`);
    assert.ok(decisions.length + rows.length <= inventory.candidates.length, `${name} lists more candidates than the inventory`);
    const base = decisions.length;
    collectFailures(rows, (row, index) => {
      const clean = validateAuthorDecision(row, inventory.candidates[base + index], base + index + 1);
      try {
        assertSharedIntake(clean, inventory.candidates[base + index]);
      } catch (error) {
        throw new Error(`author decision ${base + index + 1} (${clean.lemma}) fails the shared lexical intake: ${error.message}`);
      }
      decisions[base + index] = clean;
    });
  }
  assert.equal(decisions.length, inventory.candidates.length, 'author outputs must cover every candidate exactly once');
  const generator = { decisions, ...passIdsFor(batchId) };
  await writeFile(path.join(absolute, 'authored-decisions.generator.json'), pretty(generator));
  return {
    candidates: decisions.length,
    admit: decisions.filter((row) => row.disposition === 'admit').length,
    hold: decisions.filter((row) => row.disposition === 'hold').length,
  };
}

/** The reviewer sees evidence plus the exact proposal: never the author's rationale. */
export function reviewerPacketCandidate(packetCandidate, decision, candidateRow) {
  const out = {
    ...packetCandidate,
    proposal: decision.disposition === 'admit'
      ? { disposition: 'admit', gloss: decision.gloss, axis: decision.axis, ...(decision.corrected_pos ? { corrected_pos: decision.corrected_pos } : {}) }
      : { disposition: 'hold', hold_basis: decision.basis },
  };
  if (decision.disposition === 'admit') {
    out.gloss_spans = glossFrameSpans(decision.gloss).map((span) => span.gloss_excerpt);
    out.frames_required = out.gloss_spans.length;
    out.topic_spans_requiring_verdict = findAmbiguousParticleFragments(decision.gloss).map((fragment) => ({
      token_index: fragment.token_index,
      topic: fragment.topic,
      particle: fragment.particle,
      predicate: fragment.predicate,
    }));
  }
  const gate = admissionGateFor(candidateRow);
  if (gate) out.admission_gate_note = `the shared admission gate holds this candidate (${gate}) regardless of meaning; still judge identity, POS, gloss and sense honestly`;
  return out;
}

export async function makeReviewerPackets({ directory, shards }) {
  const absolute = path.resolve(ROOT, directory);
  const inventory = await readJson(path.join(absolute, 'candidate-inventory.json'));
  const evidence = await readJson(path.join(absolute, 'candidate-evidence.json'));
  const generator = await readJson(path.join(absolute, 'authored-decisions.generator.json'));
  const evidencePackets = [];
  for (const { name } of await numberedFiles(path.join(absolute, 'packets'), 'packet')) {
    evidencePackets.push(...(await readJson(path.join(absolute, 'packets', name))).candidates);
  }
  assert.equal(evidencePackets.length, generator.decisions.length, 'packets and proposals must cover the same candidates');
  const outputDirectory = path.join(absolute, 'review-packets');
  await mkdir(outputDirectory, { recursive: true });
  const manifest = [];
  for (const range of shardRanges(evidencePackets.length, shards)) {
    const candidates = [];
    for (let ordinal = range.first_ordinal; ordinal <= range.last_ordinal; ordinal += 1) {
      const row = { ...inventory.candidates[ordinal - 1], ...evidence.candidates[ordinal - 1] };
      candidates.push(reviewerPacketCandidate(evidencePackets[ordinal - 1], generator.decisions[ordinal - 1], row));
    }
    const packet = { kind: 'reviewer-evidence-packet', shard: range.shard, first_ordinal: range.first_ordinal, last_ordinal: range.last_ordinal, candidates };
    const bytes = Buffer.from(`${JSON.stringify(packet, null, 1)}\n`, 'utf8');
    const name = `review-packet-${String(range.shard).padStart(2, '0')}.json`;
    await writeFile(path.join(outputDirectory, name), bytes);
    manifest.push({ ...range, file: `review-packets/${name}`, packet_sha256: sha256Bytes(bytes), candidate_count: candidates.length });
  }
  await writeFile(path.join(outputDirectory, 'review-packet-manifest.json'), pretty(manifest));
  return manifest;
}

/**
 * After a proposal is revised (a gloss fixed) the revised candidate is reviewed
 * in its own single-candidate run. The shard's other rows keep the run, packet
 * and digest the reviewer actually saw; the run record lists the three
 * contiguous ranges, so no run claims to have reviewed a proposal it did not.
 * The shard's reviewed file is split verbatim and the later shards renumbered.
 */
export async function splitRunForAmendment({ directory, shard, ordinal }) {
  const absolute = path.resolve(ROOT, directory);
  const manifestPath = path.join(absolute, 'review-packets/review-packet-manifest.json');
  const manifest = await readJson(manifestPath);
  const entry = manifest.find((candidate) => candidate.shard === shard);
  assert.ok(entry && ordinal >= entry.first_ordinal && ordinal <= entry.last_ordinal, 'ordinal is outside the shard');
  const generator = await readJson(path.join(absolute, 'authored-decisions.generator.json'));
  const inventory = await readJson(path.join(absolute, 'candidate-inventory.json'));
  const evidence = await readJson(path.join(absolute, 'candidate-evidence.json'));
  const reviewedPath = (number) => path.join(absolute, 'reviewed', `review-${String(number).padStart(2, '0')}.json`);
  const reviewed = await readJson(reviewedPath(shard));
  const pieces = [
    { first_ordinal: entry.first_ordinal, last_ordinal: ordinal - 1, packet_sha256: entry.packet_sha256, file: entry.file },
    { first_ordinal: ordinal, last_ordinal: ordinal, amendment: true },
    { first_ordinal: ordinal + 1, last_ordinal: entry.last_ordinal, packet_sha256: entry.packet_sha256, file: entry.file },
  ].filter((piece) => piece.last_ordinal >= piece.first_ordinal);
  const row = { ...inventory.candidates[ordinal - 1], ...evidence.candidates[ordinal - 1] };
  const evidencePacket = packetCandidate(inventory.candidates[ordinal - 1], ordinal);
  const amended = reviewerPacketCandidate(evidencePacket, generator.decisions[ordinal - 1], row);
  const packet = { kind: 'reviewer-evidence-packet', amendment_of_shard: shard, first_ordinal: ordinal, last_ordinal: ordinal, candidates: [amended] };
  const bytes = Buffer.from(`${JSON.stringify(packet, null, 1)}\n`, 'utf8');
  const amendFile = `review-packets/review-packet-amend-${String(ordinal).padStart(3, '0')}.json`;
  await writeFile(path.join(absolute, amendFile), bytes);
  const later = manifest.filter((candidate) => candidate.shard > shard).sort((left, right) => right.shard - left.shard);
  const shift = pieces.length - 1;
  // Renumber from the last shard backwards so no file is overwritten before it moves.
  for (const candidate of later) {
    await writeFile(reviewedPath(candidate.shard + shift), `${JSON.stringify(await readJson(reviewedPath(candidate.shard)))}\n`);
  }
  const rebuilt = [...manifest.filter((candidate) => candidate.shard < shard)];
  let number = shard;
  for (const piece of pieces) {
    const count = piece.last_ordinal - piece.first_ordinal + 1;
    if (piece.amendment) {
      rebuilt.push({ shard: number, first_ordinal: piece.first_ordinal, last_ordinal: piece.last_ordinal, file: amendFile, packet_sha256: sha256Bytes(bytes), candidate_count: count });
    } else {
      rebuilt.push({ shard: number, first_ordinal: piece.first_ordinal, last_ordinal: piece.last_ordinal, file: piece.file, packet_sha256: piece.packet_sha256, candidate_count: count });
      await writeFile(reviewedPath(number), `${JSON.stringify(reviewed.slice(piece.first_ordinal - entry.first_ordinal, piece.last_ordinal - entry.first_ordinal + 1))}\n`);
    }
    number += 1;
  }
  for (const candidate of [...later].reverse()) {
    rebuilt.push({ ...candidate, shard: candidate.shard + shift });
  }
  await writeFile(manifestPath, pretty(rebuilt));
  return { amendment_packet: amendFile, amendment_output: `reviewed/review-${String(pieces.findIndex((piece) => piece.amendment) + shard).padStart(2, '0')}.json`, shards: rebuilt.length };
}

const IDENTITY = ['ok', 'unresolved'];
const POS_CHECK = ['ok', 'mismatch'];
const GLOSS_CHECK = ['fit', 'misfit', 'n/a'];
const SENSE = ['single', 'multiple'];

/** Validate one reviewer output row; returns it unchanged when well formed. */
export function validateReviewerOutput(output, proposal, candidate, ordinal) {
  const label = `reviewer output ${ordinal} (${candidate.proposed_lemma})`;
  const hitCount = candidate.evidence.representative_hits.length;
  assert.equal(output?.ordinal, ordinal, `${label}: ordinal mismatch`);
  assert.equal(output.lemma, candidate.proposed_lemma, `${label}: bound to a different lemma`);
  assert.ok(IDENTITY.includes(output.identity), `${label}: identity verdict`);
  assert.ok(POS_CHECK.includes(output.pos), `${label}: pos verdict`);
  assert.ok(GLOSS_CHECK.includes(output.gloss), `${label}: gloss verdict`);
  assert.ok(SENSE.includes(output.sense_boundary), `${label}: sense_boundary verdict`);
  assert.ok(['agree', 'disagree'].includes(output.generator_agreement), `${label}: generator_agreement`);
  if (output.verdict === 'pass') {
    assert.equal(proposal.disposition, 'admit', `${label}: a reviewer cannot pass a proposed hold`);
    assert.deepEqual([output.identity, output.pos, output.gloss, output.sense_boundary], ['ok', 'ok', 'fit', 'single'], `${label}: a pass needs every axis to pass`);
    assert.ok(nonEmpty(output.sense_note) && nonEmpty(output.use_note), `${label}: a pass needs sense_note and use_note`);
    assertHitIndices(output.note_hit_checked, hitCount, `${label} checked contexts`);
    const spans = glossFrameSpans(proposal.gloss);
    assert.ok(Array.isArray(output.frames) && output.frames.length === spans.length,
      `${label}: needs exactly ${spans.length} frame(s), one per gloss span`);
    for (const frame of output.frames) {
      assert.ok(nonEmpty(frame) && frame.includes(candidate.proposed_lemma),
        `${label}: every frame must be a sentence that contains the lemma in citation form`);
    }
  } else {
    assert.equal(output.verdict, 'hold', `${label}: verdict must be pass or hold`);
    assert.ok(nonEmpty(output.hold_rationale), `${label}: a hold needs hold_rationale`);
    if (output.hold_basis === 'no-gloss-proposed') {
      assert.equal(proposal.disposition, 'hold', `${label}: only a proposed hold can lack a proposed gloss`);
      assert.equal(output.generator_agreement, 'disagree', `${label}: a no-gloss hold records that no lexical blocker was found`);
      assert.deepEqual([output.identity, output.pos, output.gloss, output.sense_boundary], ['ok', 'ok', 'n/a', 'single'],
        `${label}: a no-gloss hold must not record a lexical blocker`);
      return output;
    }
    assert.ok(['unresolved-identity', 'unresolved-sense'].includes(output.hold_basis), `${label}: hold_basis`);
    if (proposal.disposition === 'hold') {
      assert.equal(output.gloss, 'n/a', `${label}: a proposed hold carries no gloss to judge`);
    } else {
      assert.equal(output.generator_agreement, 'disagree', `${label}: changing an admit to a hold is a disagreement`);
    }
    if (output.hold_basis === 'unresolved-identity') {
      assert.ok(output.identity === 'unresolved' || output.pos === 'mismatch' || proposal.disposition === 'admit',
        `${label}: an identity hold needs an unresolved identity or POS axis`);
    } else {
      assert.ok(output.sense_boundary === 'multiple' || proposal.disposition === 'admit',
        `${label}: a sense hold needs the multiple-sense axis`);
      assert.ok(Array.isArray(output.directions) && output.directions.length >= 2, `${label}: a sense hold needs directions`);
      output.directions.forEach((direction, index) => {
        assert.ok(nonEmpty(direction?.label), `${label}: direction ${index} label`);
        assertHitIndices(direction.hit_indices, hitCount, `${label} direction ${index}`);
      });
    }
  }
  return output;
}

/** A reviewer-changed proposal becomes a hold row built from the reviewer's own words. */
export function finalDecisionRow(proposalRow, output) {
  if (output.verdict === 'pass') return proposalRow;
  if (proposalRow.disposition === 'hold') return proposalRow;
  return {
    candidate_ordinal: proposalRow.candidate_ordinal,
    lemma: proposalRow.lemma,
    disposition: 'hold',
    basis: output.hold_basis,
    rationale: output.hold_rationale,
    ...(output.hold_basis === 'unresolved-sense' ? { directions: output.directions } : {}),
  };
}

export async function assembleReviewed({ batchId, directory, batchDirectory = 'data/batches', writeTracked = true }) {
  assertLegacyReviewWorkflowAllowed(batchId);
  const absolute = path.resolve(ROOT, directory);
  const inventory = await readJson(path.join(absolute, 'candidate-inventory.json'));
  const evidence = await readJson(path.join(absolute, 'candidate-evidence.json'));
  const generator = await readJson(path.join(absolute, 'authored-decisions.generator.json'));
  const manifest = await readJson(path.join(absolute, 'review-packets/review-packet-manifest.json'));
  const files = await numberedFiles(path.join(absolute, 'reviewed'), 'review');
  assert.equal(files.length, manifest.length, 'every reviewer packet needs its review output');

  const proposals = generator.decisions.map((row) => (row.disposition === 'admit'
    ? { ordinal: row.candidate_ordinal, lemma: row.lemma, disposition: 'admit', gloss: row.gloss }
    : { ordinal: row.candidate_ordinal, lemma: row.lemma, disposition: 'hold', hold_basis: row.basis }));

  const runs = [];
  const flat = [];
  for (const { name, shard } of files) {
    const range = manifest.find((entry) => entry.shard === shard);
    assert.ok(range, `${name} has no matching reviewer packet`);
    const outputs = await readJson(path.join(absolute, 'reviewed', name));
    assert.ok(Array.isArray(outputs) && outputs.length === range.candidate_count, `${name} must review exactly ${range.candidate_count} candidates`);
    collectFailures(outputs, (output, index) => {
      const ordinal = range.first_ordinal + index;
      validateReviewerOutput(output, proposals[ordinal - 1], inventory.candidates[ordinal - 1], ordinal);
    });
    flat.push(...outputs);
    runs.push({
      run: runs.length + 1,
      context: 'isolated-subagent',
      model: AUTHOR_NAME,
      first_ordinal: range.first_ordinal,
      last_ordinal: range.last_ordinal,
      candidate_count: range.candidate_count,
      packet_sha256: range.packet_sha256,
      raw_output_sha256: sha256Json(outputs),
      outputs,
    });
  }
  assert.equal(flat.length, proposals.length, 'reviewer outputs must cover every candidate');

  const rawArtifact = {
    schema_version: 1,
    contract_version: RAW_OUTPUTS_CONTRACT_VERSION,
    kind: RAW_OUTPUTS_KIND,
    batch_id: batchId,
    reviewer: REVIEWER_NAME,
    reviewed_proposals: proposals,
    runs,
  };
  const runRecord = runRecordFromRaw(rawArtifact);
  const runRecordBytes = pretty(runRecord);

  const finalDecisions = generator.decisions.map((row, index) => finalDecisionRow(row, flat[index]));
  const reviews = [];
  const outcomes = [];
  generator.decisions.forEach((row, index) => {
    const raw = flat[index];
    const gate = admissionGateFor({ ...inventory.candidates[index], ...evidence.candidates[index] });
    outcomes.push(outcomeFromRaw(row.disposition, raw, raw.verdict === 'pass' ? gate : null));
    if (raw.verdict === 'pass' && !gate) reviews.push(reviewFromRaw({ lemma: row.lemma, gloss: row.gloss, raw }));
  });
  const input = {
    schema_version: '1',
    contract_version: 'authored-semantic-review-input-v1',
    kind: 'authored-semantic-review-input',
    batch_id: batchId,
    reviewer: REVIEWER_NAME,
    review_status: 'complete',
    generator_proposal_sha256: sha256Json(runRecord.reviewed_proposals),
    run_record_sha256: sha256Bytes(runRecordBytes),
    review_runs: runRecord.runs,
    reviews,
    candidate_outcomes: outcomes,
  };

  await writeFile(path.join(absolute, 'reviewer-raw-outputs.json'), pretty(rawArtifact));
  await writeFile(path.join(absolute, 'authored-decisions.json'), pretty({
    decisions: finalDecisions,
    reviewer: AUTHOR_NAME,
    generator: AUTHOR_NAME,
    ...passIdsFor(batchId),
  }));
  if (writeTracked) {
    const stem = batchId.replace(/-[0-9]{8}$/u, '');
    await writeFile(path.join(ROOT, batchDirectory, `${stem}-reviewer-run-record.json`), runRecordBytes);
    await writeFile(path.join(ROOT, batchDirectory, `${stem}-semantic-review-input.json`), pretty(input));
  }
  const changed = finalDecisions.filter((row, index) => row !== generator.decisions[index]).length;
  return {
    candidates: proposals.length,
    admit: finalDecisions.filter((row) => row.disposition === 'admit').length,
    hold: finalDecisions.filter((row) => row.disposition === 'hold').length,
    reviewer_changed_admit_to_hold: changed,
    review_rows: reviews.length,
    artifacts: { input, runRecord, finalDecisions },
  };
}

/**
 * Compact text view of a candidate range for the checking agent, so the
 * evidence is read once with the least overhead. Trims each context window
 * around the observed form.
 */
export async function selfCheckView({ directory, first, last, width = 110 }) {
  const absolute = path.resolve(ROOT, directory);
  const manifest = await readJson(path.join(absolute, 'review-packets/review-packet-manifest.json'));
  const lines = [];
  for (const entry of manifest) {
    if (entry.last_ordinal < first || entry.first_ordinal > last) continue;
    const packet = await readJson(path.join(absolute, entry.file));
    for (const candidate of packet.candidates) {
      if (candidate.ordinal < first || candidate.ordinal > last) continue;
      const proposal = candidate.proposal.disposition === 'admit'
        ? `ADMIT ${candidate.proposal.corrected_pos ?? ''} axis=${candidate.proposal.axis} gloss=「${candidate.proposal.gloss}」 frames=${candidate.frames_required}${candidate.topic_spans_requiring_verdict.length ? ` topics=${JSON.stringify(candidate.topic_spans_requiring_verdict)}` : ''}`
        : `HOLD ${candidate.proposal.hold_basis}`;
      const gate = candidate.admission_gate_note ? ` GATE` : '';
      lines.push(`#${candidate.ordinal} ${candidate.lemma} (${candidate.proposed_pos}) forms=${candidate.observed_forms.map((form) => `${form.surface}:${form.count}`).join(',')}${gate} :: ${proposal}`);
      for (const context of candidate.contexts) {
        const at = context.observed_form ? context.text.indexOf(context.observed_form) : -1;
        const text = at < 0 ? context.text.slice(0, width * 2) : context.text.slice(Math.max(0, at - width), at + (context.observed_form?.length ?? 0) + width);
        lines.push(`  ${context.index}: ${text}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Assemble a batch whose semantic check was done by the producing agent itself
 * (owner decision 2026-10-02). Rows use the same per-candidate verdict shape a
 * reviewer used, but the tracked input records `agent-self-check`,
 * `independent_review: false`, and carries no runs, run record, or digests of a
 * separate review.
 */
export async function assembleSelfChecked({ batchId, directory, batchDirectory = 'data/batches', writeTracked = true }) {
  const absolute = path.resolve(ROOT, directory);
  const inventory = await readJson(path.join(absolute, 'candidate-inventory.json'));
  const evidence = await readJson(path.join(absolute, 'candidate-evidence.json'));
  const generator = await readJson(path.join(absolute, 'authored-decisions.generator.json'));
  const files = await numberedFiles(path.join(absolute, 'selfcheck'), 'selfcheck');
  const proposals = generator.decisions.map((row) => (row.disposition === 'admit'
    ? { ordinal: row.candidate_ordinal, lemma: row.lemma, disposition: 'admit', gloss: row.gloss }
    : { ordinal: row.candidate_ordinal, lemma: row.lemma, disposition: 'hold', hold_basis: row.basis }));
  const flat = [];
  for (const { name } of files) {
    const rows = await readJson(path.join(absolute, 'selfcheck', name));
    assert.ok(Array.isArray(rows), `${name} must be a JSON array`);
    const base = flat.length;
    collectFailures(rows, (output, index) => {
      const ordinal = base + index + 1;
      assert.ok(proposals[ordinal - 1], `${name} lists more candidates than the batch`);
      validateReviewerOutput(output, proposals[ordinal - 1], inventory.candidates[ordinal - 1], ordinal);
    });
    flat.push(...rows);
  }
  assert.equal(flat.length, proposals.length, 'the self-check must cover every candidate exactly once');

  const finalDecisions = generator.decisions.map((row, index) => finalDecisionRow(row, flat[index]));
  const reviews = [];
  const outcomes = [];
  generator.decisions.forEach((row, index) => {
    const raw = flat[index];
    const gate = admissionGateFor({ ...inventory.candidates[index], ...evidence.candidates[index] });
    outcomes.push(outcomeFromRaw(row.disposition, raw, raw.verdict === 'pass' ? gate : null));
    if (raw.verdict === 'pass' && !gate) reviews.push(reviewFromRaw({ lemma: row.lemma, gloss: row.gloss, raw }));
  });
  const input = {
    schema_version: '1',
    contract_version: 'authored-semantic-review-input-v1',
    kind: 'authored-semantic-review-input',
    batch_id: batchId,
    reviewer: AUTHOR_NAME,
    review_status: 'complete',
    review_provenance: SELF_CHECK_PROVENANCE,
    independent_review: false,
    reviews,
    candidate_outcomes: outcomes,
  };
  await writeFile(path.join(absolute, 'authored-decisions.json'), pretty({
    decisions: finalDecisions,
    reviewer: AUTHOR_NAME,
    generator: AUTHOR_NAME,
    ...passIdsFor(batchId),
  }));
  if (writeTracked) {
    const stem = batchId.replace(/-[0-9]{8}$/u, '');
    await writeFile(path.join(ROOT, batchDirectory, `${stem}-semantic-review-input.json`), pretty(input));
  }
  return {
    candidates: proposals.length,
    admit: finalDecisions.filter((row) => row.disposition === 'admit').length,
    hold: finalDecisions.filter((row) => row.disposition === 'hold').length,
    changed_admit_to_hold: finalDecisions.filter((row, index) => row !== generator.decisions[index]).length,
    review_rows: reviews.length,
    artifacts: { input, finalDecisions },
  };
}

async function main(argv) {
  const [command, ...rest] = argv;
  const options = Object.fromEntries(rest.map((argument) => {
    const match = /^--([a-z-]+)=(.*)$/u.exec(argument);
    assert.ok(match, `invalid argument ${argument}; use --name=value`);
    return [match[1], match[2]];
  }));
  assert.ok(options.directory, '--directory is required');
  if (command === 'merge-authors') return mergeAuthors({ batchId: options['batch-id'], directory: options.directory });
  if (command === 'reviewer-packets') return makeReviewerPackets({ directory: options.directory, shards: Number(options.shards ?? 5) });
  if (command === 'split-run') return splitRunForAmendment({ directory: options.directory, shard: Number(options.shard), ordinal: Number(options.ordinal) });
  if (command === 'self-check-assemble') return assembleSelfChecked({ batchId: options['batch-id'], directory: options.directory });
  if (command === 'self-check-view') { console.log(await selfCheckView({ directory: options.directory, first: Number(options.first), last: Number(options.last), width: Number(options.width ?? 110) })); return { artifacts: null }; }
  if (command === 'assemble') return assembleReviewed({ batchId: options['batch-id'], directory: options.directory });
  throw new Error('usage: review-workflow.mjs merge-authors|reviewer-packets|assemble --batch-id=ID --directory=DIR');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { artifacts, ...summary } = await main(process.argv.slice(2));
  console.log(JSON.stringify(summary, null, 2));
}
