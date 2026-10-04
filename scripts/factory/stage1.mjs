import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { HOLD_REASONS, POS_VALUES, normalizeText } from '../intake/candidate-contract.mjs';
import { analysisInputDigest, analyzerDigest, assertPinnedAnalyzer, PINNED_ANALYZER } from '../intake/pipeline.mjs';
import {
  CANDIDATE_MANIFEST_CONTRACT,
  MAX_EVIDENCE_REFERENCES,
  candidateIdFor,
  isBatchId,
  sha256Hex,
  validateCandidateBatch,
} from './contract.mjs';
import { buildCanonicalIndex, classifyAgainstCanonical } from './identity-adapter.mjs';

// Factory Stage 1 producer library (issue #264; design docs/lexical-production-factory.md §2).
// It turns text-free corpus evidence into one immutable candidate batch. It never writes review
// rows, glosses, canonical records or paragraph text, and it does not touch the legacy
// candidateKey/dedupeCandidates/coveredLemmas path.

export const CORPUS_EVIDENCE_CONTRACT = 'm9-corpus-candidate-evidence-v1';
export const CORPUS_SOURCE_ADAPTER = 'corpus-adapter';
export const DEFAULT_MAX_CANDIDATES = 500;
export const HARD_MAX_CANDIDATES = 1000;

// Exactly the fields `safeEvidenceHit` of the extractor may emit; anything else (a context,
// paragraph form or text) is raw corpus text that must never reach Git.
const SAFE_HIT_FIELDS = new Set(['source_path', 'corpus_id', 'document_id', 'document_ordinal', 'paragraph_id',
  'paragraph_ordinal', 'source_category', 'source_year', 'matched_surface_form', 'matched_morpheme_span_surface']);
const KOREAN_WORD = /^[가-힣]+$/u;

export class Stage1Error extends Error {
  constructor(errors) {
    super(`Stage 1 producer: ${errors.join('; ')}`);
    this.name = 'Stage1Error';
    this.errors = errors;
  }
}

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

// Holds the extractor itself recorded (mirrors scripts/intake/adapters/corpus-adapter.mjs, whose
// `decision_state` is not part of the text-free evidence).
function extractorHolds(candidate) {
  const holds = [];
  if (String(candidate.ambiguity_status ?? '').startsWith('held_')) holds.push('analysis_ambiguous');
  if (!['uncovered', 'exact_canonical_lemma', undefined].includes(candidate.coverage_status)) holds.push('coverage_collision');
  return holds;
}

// Text-free extractor evidence → usage observations (one per bounded paragraph hit).
export function observationsFromCorpusEvidence(evidence) {
  const errors = [];
  if (evidence?.contract_version !== CORPUS_EVIDENCE_CONTRACT) errors.push(`evidence contract_version must be ${CORPUS_EVIDENCE_CONTRACT}`);
  if (!Array.isArray(evidence?.candidates) || evidence.candidates.length === 0) errors.push('evidence has no candidates');
  const manifestDigest = evidence?.index?.input_manifest_sha256;
  const rowsDigest = evidence?.index?.logical_rows_sha256;
  if (!/^[0-9a-f]{64}$/u.test(String(manifestDigest)) || !/^[0-9a-f]{64}$/u.test(String(rowsDigest))) errors.push('evidence must record the pinned corpus index digests');
  if (typeof evidence?.extractor?.extractor_version !== 'string' || !evidence.extractor.extractor_version) errors.push('evidence must record extractor_version');
  for (const [key, expected] of [['kiwipiepy_version', PINNED_ANALYZER.kiwipiepy_version], ['kiwipiepy_model_version', PINNED_ANALYZER.kiwipiepy_model_version]]) {
    if (evidence?.extractor?.[key] !== expected) errors.push(`extractor ${key} ${evidence?.extractor?.[key] ?? 'missing'} is not the pinned ${expected}`);
  }
  if (errors.length) throw new Stage1Error(errors);

  const observations = [];
  evidence.candidates.forEach((candidate, index) => {
    const at = `evidence candidate ${index + 1}`;
    const input = normalizeText(candidate.proposed_lemma);
    const pos = candidate.proposed_pos ?? null;
    if (!KOREAN_WORD.test(input)) errors.push(`${at}: proposed_lemma must be a Korean word`);
    if (pos !== null && !POS_VALUES.includes(pos)) errors.push(`${at}: proposed_pos is not supported`);
    const hits = candidate.evidence?.representative_hits;
    if (!Array.isArray(hits)) { errors.push(`${at}: representative_hits missing`); return; }
    for (const hit of hits) {
      const unsafe = Object.keys(hit).filter((key) => !SAFE_HIT_FIELDS.has(key));
      if (unsafe.length) errors.push(`${at}: raw corpus text field(s) not allowed: ${unsafe.join(', ')}`);
      if (!hit.document_id || !hit.paragraph_id) errors.push(`${at}: hit needs document_id and paragraph_id`);
    }
    const holds = extractorHolds(candidate);
    const forms = [...new Set((candidate.observed_surface_forms ?? []).map((form) => normalizeText(form.surface)).filter(Boolean))].sort(compare);
    const base = { hint: { input, pos }, holds };
    if (hits.length === 0) {
      // No located paragraph: keep the candidate visible, explicitly held, never fabricate a reference.
      const surface = forms[0] ?? input;
      observations.push({ ...base, surface, holds: [...holds, 'no_evidence'], ref: { kind: 'corpus-surface', ref: surface } });
      return;
    }
    for (const hit of hits) {
      const surface = normalizeText(hit.matched_surface_form) || forms[0] || input;
      observations.push({ ...base, surface, ref: { kind: 'corpus-paragraph', ref: `${hit.document_id}#${hit.paragraph_id}` } });
    }
  });
  if (errors.length) throw new Stage1Error(errors);
  return {
    observations,
    source: {
      source_snapshot: `corpus:${manifestDigest}:${rowsDigest}`,
      extractor_version: evidence.extractor.extractor_version,
    },
  };
}

// Dictionary-form lemma/POS for one inflected observed form, from the pinned Kiwi analysis.
// Anything not explained by exactly one reading becomes an explicit hold, never a guess.
export function resolveSurface(surface, hint, outcome) {
  if (!outcome) return { holds: ['analysis_missing'], lemma: hint?.input, pos: hint?.pos };
  if (outcome.input_digest !== analysisInputDigest(surface)) return { holds: ['analysis_stale'], lemma: hint?.input, pos: hint?.pos };
  if (outcome.status === 'error') return { holds: ['analysis_error'], lemma: hint?.input, pos: hint?.pos };
  if (outcome.status !== 'ok' || !outcome.analyses?.length) return { holds: ['analysis_unsupported'], lemma: hint?.input, pos: hint?.pos };
  const [best, ...alternatives] = outcome.analyses;
  if (!best.length) return { holds: ['analysis_unsupported'], lemma: hint?.input, pos: hint?.pos };
  const hinted = best.find((item) => item.lemma === hint?.input && (!hint.pos || item.pos === hint.pos))
    ?? best.find((item) => item.lemma === hint?.input);
  const chosen = hinted ?? (best.length === 1 ? best[0] : null);
  if (!chosen) return { holds: ['analysis_ambiguous'], lemma: hint?.input ?? best[0].lemma, pos: hint?.pos ?? best[0].pos };
  const holds = [];
  if (hint?.input && chosen.lemma !== hint.input) holds.push('lemma_mismatch');
  else if (hint?.pos && chosen.pos !== hint.pos) holds.push('pos_mismatch');
  // A competing reading: another ranked path that explains the form without the chosen lemma/POS
  // using no more content morphemes, or the same lemma with a different POS.
  const rival = alternatives.some((analysis) => analysis.length > 0
    && !analysis.some((item) => item.lemma === chosen.lemma && item.pos === chosen.pos)
    && (analysis.some((item) => item.lemma === chosen.lemma) || analysis.length <= best.length));
  if (rival) holds.push('analysis_ambiguous');
  return { holds, lemma: chosen.lemma, pos: chosen.pos };
}

const keyOf = (usage) => `${usage.input}\u0000${usage.pos}\u0000${usage.ref.kind}\u0000${usage.ref.ref}`;

// Groups observations into distinguishable usages. Only an identical (lemma, POS, evidence
// reference) is a repeat and merges; same lemma/POS at another reference stays a separate row.
export async function buildUsages({ observations, analyzer }) {
  const surfaces = [...new Set(observations.map((observation) => observation.surface))].sort(compare);
  const analysis = await analyzer(surfaces.map((surface) => ({ id: surface, text: surface })));
  assertPinnedAnalyzer(analysis.metadata);
  const outcomes = new Map(analysis.results.map((outcome) => [outcome.id, outcome]));
  const usages = new Map();
  for (const observation of observations) {
    const resolved = resolveSurface(observation.surface, observation.hint, outcomes.get(observation.surface));
    if (!KOREAN_WORD.test(resolved.lemma ?? '') || !POS_VALUES.includes(resolved.pos)) {
      throw new Stage1Error([`cannot represent ${observation.surface}: no dictionary-form lemma/POS from analysis or extractor hint`]);
    }
    const draft = { input: resolved.lemma, pos: resolved.pos, ref: observation.ref };
    const usage = usages.get(keyOf(draft)) ?? { ...draft, forms: new Set(), holds: new Set(), repeats: 0 };
    usage.repeats += 1;
    usage.forms.add(observation.surface);
    for (const hold of [...observation.holds, ...resolved.holds]) usage.holds.add(hold);
    usages.set(keyOf(draft), usage);
  }
  return { usages: [...usages.values()], metadata: analysis.metadata };
}

// One factory row per usage; ids follow the sorted order so replay is byte-identical.
export function buildCandidateRows({ usages, batchId, maxCandidates = DEFAULT_MAX_CANDIDATES }) {
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > HARD_MAX_CANDIDATES) {
    throw new Stage1Error([`max candidates must be an integer from 1 to ${HARD_MAX_CANDIDATES}`]);
  }
  const ordered = [...usages].sort((a, b) => compare(a.input, b.input) || compare(a.pos, b.pos) || compare(a.ref.kind, b.ref.kind) || compare(a.ref.ref, b.ref.ref));
  // Whole lemma groups only, so a lemma's usages never split across batches.
  const groups = new Map();
  for (const usage of ordered) groups.set(usage.input, [...(groups.get(usage.input) ?? []), usage]);
  const selected = [];
  const deferredLemmas = [];
  for (const [lemma, group] of groups) {
    if (group.length > maxCandidates) throw new Stage1Error([`lemma ${lemma} alone has ${group.length} usages, above the batch bound ${maxCandidates}`]);
    if (deferredLemmas.length === 0 && selected.length + group.length <= maxCandidates) selected.push(...group);
    else deferredLemmas.push(lemma);
  }
  const rows = selected.map((usage, index) => {
    const forms = [...usage.forms].sort(compare);
    return {
      candidate_id: candidateIdFor(batchId, index + 1),
      input: usage.input,
      pos: usage.pos,
      usage_hint: `provisional: ${usage.pos} usage observed as ${forms.join('/')}; sense undecided (Stage 2)`,
      observedForms: forms,
      evidence: [usage.ref, ...forms.slice(0, MAX_EVIDENCE_REFERENCES - 1)
        .map((form) => ({ kind: 'corpus-surface', ref: form })).filter((entry) => entry.ref !== usage.ref.ref)].slice(0, MAX_EVIDENCE_REFERENCES),
      holds: [...usage.holds].filter((hold) => HOLD_REASONS.includes(hold)).sort(compare),
    };
  });
  return { rows, deferredLemmas, repeatsMerged: selected.reduce((sum, usage) => sum + usage.repeats - 1, 0) };
}

export const serializeCandidates = (rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

// Digest of the whole canonical revision Stage 1 compared against (file names + byte digests).
export async function canonicalSnapshotDigest(root) {
  const directory = path.join(root, 'data/canonical');
  let names = [];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort(compare);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const parts = [];
  for (const name of names) parts.push([name, sha256Hex(await readFile(path.join(directory, name)))]);
  return sha256Hex(JSON.stringify(parts));
}

// Next serial batch id over every id known locally and on the merged base (fail closed upstream).
export function allocateBatchId(knownIds) {
  const numbers = knownIds.filter(isBatchId).map((id) => Number(id.slice(1)));
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  if (next > 999999) throw new Stage1Error(['batch id space exhausted']);
  return `C${String(next).padStart(6, '0')}`;
}

export const routeCounts = (rows, canonicalEntries) => {
  const index = buildCanonicalIndex(canonicalEntries);
  const counts = { new_entry: 0, new_pos_on_existing_lemma: 0, new_sense_on_existing_entry: 0, held: 0 };
  for (const row of rows) {
    counts[classifyAgainstCanonical(row, index).route] += 1;
    if (row.holds.length) counts.held += 1;
  }
  return counts;
};

// Pure producer: evidence + analyzer + canonical → manifest and candidates.jsonl text.
export async function produceCandidateBatch({
  evidence, analyzer, canonicalEntries, canonicalDigest, batchId, taskId, maxCandidates = DEFAULT_MAX_CANDIDATES,
}) {
  if (!isBatchId(batchId)) throw new Stage1Error(['batchId must match C000000']);
  if (!/^T\d{6}$/u.test(String(taskId))) throw new Stage1Error(['taskId must match T000000']);
  const { observations, source } = observationsFromCorpusEvidence(evidence);
  const { usages, metadata } = await buildUsages({ observations, analyzer });
  const { rows, deferredLemmas, repeatsMerged } = buildCandidateRows({ usages, batchId, maxCandidates });
  const candidatesText = serializeCandidates(rows);
  const manifest = {
    contract: CANDIDATE_MANIFEST_CONTRACT,
    task_id: taskId,
    batch_id: batchId,
    candidate_count: rows.length,
    source_adapter: CORPUS_SOURCE_ADAPTER,
    source_snapshot: source.source_snapshot,
    canonical_snapshot_digest: canonicalDigest,
    extractor_version: source.extractor_version,
    analyzer_version: `kiwipiepy==${metadata.kiwipiepy_version}`,
    analyzer_digest: analyzerDigest(metadata),
    source_evidence_sha256: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
    candidates_sha256: sha256Hex(candidatesText),
    status: 'created',
  };
  const errors = validateCandidateBatch({ manifest, candidatesText });
  if (errors.length) throw new Stage1Error(errors);
  return {
    manifest,
    candidatesText,
    rows,
    summary: { candidates: rows.length, deferredLemmas, repeatsMerged, routes: routeCounts(rows, canonicalEntries) },
  };
}
