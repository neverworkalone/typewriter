import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalRecordsSha256,
  sha256Json,
} from '../validate/semantic-audit.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import {
  findAmbiguousParticleFragments,
  inspectGlossConnectors,
  inspectWriterDomainEvidence,
} from '../validate/lexical-quality.mjs';
import { validateAuthoredSemanticDecisionSource } from './authored-semantic-decision-source.mjs';
import {
  authorSemanticReviewBinding,
  compactAuthoredSemanticDecisionRow,
} from '../validate/semantic-decision-row.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');
const PUBLICATION_STATE = 'local_reference_only_pending_owner_publication_confirmation';
const WRITER_USE_BY_AXIS = Object.freeze({
  A: '사람이나 대상의 행동과 변화를 구체화할 때 출발점으로 쓴다.',
  C: '장면의 장소·시간·범위를 분명하게 그릴 때 출발점으로 쓴다.',
  E: '사람 사이의 관계나 정서를 정확히 붙잡을 때 출발점으로 쓴다.',
  O: '장면에 놓인 물체나 몸의 구체적인 모습을 찾을 때 출발점으로 쓴다.',
  Q: '상태나 성질의 차이를 선명하게 표현할 때 출발점으로 쓴다.',
  S: '감각으로 떠올릴 수 있는 장면이나 인상을 표현할 때 출발점으로 쓴다.',
  X: '생각이나 관계의 결을 구체적인 말로 잡을 때 출발점으로 쓴다.',
});
const SCOPE_METHOD = 'Review each bounded proposal against morphology, current canonical and surface coverage, source-bound paragraph identifiers, and local contexts. Admit only a resolved in-scope lexical identity, POS, and one bounded Typewriter-authored meaning; hold evidenced identity, POS, sense, or collision uncertainty. Analyzer counts and writer usefulness do not determine lexical eligibility.';
const AUTHORING_NOTE = 'Local corpus and pinned morphology establish bounded lexical candidate evidence only. Each included lemma, POS, gloss, and one-sense boundary was separately reviewed. Diagnostic frames are Typewriter-authored examples, not corpus quotations or measured writer outcomes. No relation quota is applied; empty relation lists are valid.';

const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const prettyBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const relative = (absolutePath) => path.relative(ROOT, absolutePath).split(path.sep).join('/');

const BATCH_ID_PATTERN = /^issue-223-m9-e-corpus-batch-([0-9]{2})-(20[0-9]{2})([0-9]{2})([0-9]{2})$/u;
const REVIEW_FILE_PATTERN = /^issue-223-m9-e-corpus-batch-([0-9]{2})-candidate-review\.json$/u;

export function parseIssue223BatchId(batchId) {
  const match = BATCH_ID_PATTERN.exec(batchId);
  assert.ok(match, `invalid Issue #223 batch id ${batchId}`);
  const [, ordinalText, year, month, day] = match;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  assert.ok(
    calendar.getUTCFullYear() === Number(year)
      && calendar.getUTCMonth() === Number(month) - 1
      && calendar.getUTCDate() === Number(day),
    `batch id ${batchId} carries an invalid calendar date`,
  );
  return {
    ordinal: Number(ordinalText),
    ordinalText,
    date: `${year}${month}${day}`,
    stem: batchId.slice(0, -9),
  };
}

export function issue223CorrectionPassId(batchId) {
  const { ordinalText, date } = parseIssue223BatchId(batchId);
  return `issue-223-m9-e-corpus-batch-${ordinalText}-correction-${date}-r1`;
}

// Inventory and canonical IDs continue only from earlier batches, so rebuilding
// an earlier batch never shifts into identities reserved by later ones.
export function selectPredecessorReviewFiles(names, batchId) {
  const { ordinal } = parseIssue223BatchId(batchId);
  return names
    .filter((name) => {
      const match = REVIEW_FILE_PATTERN.exec(name);
      return match && Number(match[1]) < ordinal;
    })
    .sort();
}

function textFreeHits(hits) {
  return hits.map((hit) => ({
    source_path: hit.source_path,
    corpus_id: hit.corpus_id,
    document_id: hit.document_id,
    document_ordinal: hit.document_ordinal,
    paragraph_id: hit.paragraph_id,
    paragraph_ordinal: hit.paragraph_ordinal,
    source_category: hit.source_category,
    source_year: hit.source_year,
    ...(typeof hit.matched_surface_form === 'string'
      ? { matched_surface_form: hit.matched_surface_form }
      : {}),
    ...(typeof hit.matched_morpheme_span_surface === 'string'
      ? { matched_morpheme_span_surface: hit.matched_morpheme_span_surface }
      : {}),
  }));
}

export function bindAuthoredParagraphReferences(hitRefs, references) {
  if (references === undefined) return hitRefs.map(({ paragraph_id: paragraphId }) => paragraphId);
  assert.ok(Array.isArray(references), 'authored paragraph references must be an array');
  return references.map((reference) => {
    if (!Number.isInteger(reference)) return reference;
    assert.ok(reference >= 0 && reference < hitRefs.length, `authored paragraph hit index ${reference} is outside the bounded evidence`);
    return hitRefs[reference].paragraph_id;
  });
}

function candidateReviewRow(candidate, textFreeCandidate, editorial, ordinal, inventoryId, canonicalId, batchId, sampleParagraphCount) {
  const hitRefs = textFreeHits(textFreeCandidate.evidence.representative_hits);
  const proposalPos = editorial.corrected_pos ?? candidate.proposed_pos;
  const judgment = editorial.disposition === 'admit'
    ? {
      disposition: 'admit',
      rationale: `${candidate.proposed_lemma}: reviewed bounded contexts support this in-scope lexical identity and ${proposalPos} part of speech. The gloss is limited to one resolved meaning; analyzer counts, commonness, writer usefulness, and relation availability do not determine admission.`,
      reviewer: 'codex-agent',
      human_reviewed: false,
      candidate_record_id: canonicalId,
      disposition_basis: 'valid-in-scope-lexical-entry',
      writer_use_axis: editorial.axis,
      writer_gloss: editorial.gloss,
      writer_use: WRITER_USE_BY_AXIS[editorial.axis],
      admitted_sense_count: 1,
      ...(editorial.corrected_pos ? {
        pos_correction: {
          evidence_type: 'reviewed-bounded-contexts-support-corrected-pos',
          analyzer_pos: candidate.analyzer_pos,
          analyzer_mapped_pos: candidate.proposed_pos,
          corrected_pos: editorial.corrected_pos,
          paragraph_ids: editorial.pos_correction_hit_indices.map((hitIndex) => hitRefs[hitIndex].paragraph_id),
          rationale: editorial.pos_correction_rationale,
        },
      } : {}),
    }
    : {
      disposition: 'hold',
      rationale: editorial.rationale,
      reviewer: 'codex-agent',
      human_reviewed: false,
      candidate_record_id: null,
      disposition_basis: editorial.basis,
      ...(editorial.basis === 'unresolved-identity'
        ? {
          identity_evidence: editorial.identity_evidence ?? {
          evidence_type: 'reviewed-bounded-contexts-undermine-standalone-lemma',
          rationale: editorial.rationale,
          paragraph_ids: bindAuthoredParagraphReferences(hitRefs, editorial.paragraph_ids),
        },
        }
        : {}),
      ...(editorial.basis === 'unresolved-sense'
        ? {
          sense_boundary_evidence: {
            evidence_type: 'distinct-sense-directions-in-reviewed-bounded-contexts',
            directions: editorial.directions.map((direction) => ({
              label: direction.label,
              paragraph_ids: direction.hit_indices.map((hitIndex) => hitRefs[hitIndex].paragraph_id),
            })),
          },
        }
        : {}),
    };

  return {
    candidate_ordinal: ordinal,
    inventory_id: inventoryId,
    candidate_id: `${batchId}-candidate-${String(ordinal).padStart(4, '0')}`,
    morphology_proposal: {
      lemma: candidate.proposed_lemma,
      pos: proposalPos,
      analyzer_pos: candidate.analyzer_pos,
      ambiguity_status: candidate.ambiguity_status,
      analyzer_confidence: candidate.analyzer_confidence,
      pos_interpretation_count_in_sample: candidate.pos_interpretation_count_in_sample,
      ambiguous_observed_surface_count_in_sample: candidate.ambiguous_observed_surface_count_in_sample,
      oov_morpheme_occurrences_in_sample: candidate.oov_morpheme_occurrences_in_sample,
    },
    corpus_evidence: {
      kiwi_morpheme_occurrences_in_sample: candidate.kiwi_morpheme_occurrences_in_sample,
      paragraph_hits_in_sample: candidate.paragraph_hits_in_sample,
      distinct_documents_in_sample: candidate.distinct_documents_in_sample,
      distinct_sources_in_sample: candidate.distinct_sources_in_sample,
      source_concentration_ratio_in_sample: candidate.source_concentration_ratio_in_sample,
      sample_paragraph_count: sampleParagraphCount,
      sample_fraction: textFreeCandidate.evidence.sample_fraction,
      coverage_status: candidate.coverage_status,
      literal_match_query: candidate.evidence.literal_match_query,
      literal_match_count: candidate.evidence.literal_match_count,
      literal_match_count_semantics: 'literal substring paragraph count; not lemma frequency',
      search_mode: candidate.evidence.search_mode,
    },
    coverage_status: candidate.coverage_status,
    typewriter_surface_matches: candidate.typewriter_surface_matches,
    observed_surface_forms: candidate.observed_surface_forms,
    observed_morpheme_spans: candidate.observed_morpheme_spans,
    bounded_provenance: {
      evidence_type: textFreeCandidate.evidence.evidence_type,
      ...(textFreeCandidate.evidence.representative_context_match_method
        ? { representative_context_match_method: textFreeCandidate.evidence.representative_context_match_method }
        : {}),
      ...(textFreeCandidate.evidence.representative_surface_search_limit !== undefined
        ? { representative_surface_search_limit: textFreeCandidate.evidence.representative_surface_search_limit }
        : {}),
      representative_hit_limit: textFreeCandidate.evidence.representative_hit_limit,
      representative_hit_count: hitRefs.length,
      representative_hits: hitRefs,
    },
    editorial_judgment: judgment,
  };
}

function makeCanonicalRecord(row) {
  const judgment = row.editorial_judgment;
  return {
    id: judgment.candidate_record_id,
    record_type: 'entry',
    role: 'start',
    candidate_id: judgment.candidate_record_id,
    lemma: row.morphology_proposal.lemma,
    search_forms: [row.morphology_proposal.lemma],
    senses: [{
      id: `${judgment.candidate_record_id}-s1`,
      pos: row.morphology_proposal.pos,
      gloss: judgment.writer_gloss,
    }],
  };
}

function glossFrameSpans(gloss) {
  const connectorObservations = inspectGlossConnectors(gloss).sort((left, right) => left.index - right.index);
  let frameStart = 0;
  const frameSpans = [];
  for (const observation of connectorObservations) {
    const excerpt = gloss.slice(frameStart, observation.index);
    const trimmedExcerpt = excerpt.trim();
    if (trimmedExcerpt) {
      frameSpans.push({
        gloss_excerpt: trimmedExcerpt,
        gloss_start: frameStart + excerpt.indexOf(trimmedExcerpt),
      });
    }
    frameStart = observation.index + observation.connector.length;
  }
  const trailingExcerpt = gloss.slice(frameStart);
  const trimmedTrailingExcerpt = trailingExcerpt.trim();
  if (trimmedTrailingExcerpt) {
    frameSpans.push({
      gloss_excerpt: trimmedTrailingExcerpt,
      gloss_start: frameStart + trailingExcerpt.indexOf(trimmedTrailingExcerpt),
    });
  }
  if (frameSpans.length === 0) frameSpans.push({ gloss_excerpt: gloss, gloss_start: 0 });
  return frameSpans;
}

export function assertSemanticReviewEnvelope(input, batchId) {
  assert.equal(input.schema_version, '1', 'semantic review input has an unsupported schema version');
  assert.equal(input.contract_version, 'authored-semantic-review-input-v1', 'semantic review input has an unregistered contract version');
  assert.equal(input.kind, 'authored-semantic-review-input', 'semantic review input has the wrong kind');
  assert.equal(input.batch_id, batchId, 'semantic review input is bound to a different batch');
  assert.ok(nonEmpty(input.reviewer), 'semantic review input needs a named reviewer');
  assert.equal(input.review_status, 'complete', 'semantic review input must be a completed review');
  assert.ok(Array.isArray(input.reviews), 'semantic review input needs a reviews array');
}

const RELATION_TYPES = ['direct', 'near', 'mood', 'scene', 'sensory', 'action', 'association'];
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

function assertAuthoredSemanticReview(review, candidate, glossDigest) {
  const label = `${candidate.lemma} semantic review`;
  assert.equal(review.lemma, candidate.lemma, `${label} is bound to its lemma`);
  assert.equal(review.gloss_sha256, glossDigest, `${label} must bind the exact reviewed gloss`);
  assert.equal(review.gloss_judgment, 'fit', `${label} gloss judgment must be an explicit fit`);
  assert.equal(review.boundary_action, 'retain', `${label} must explicitly retain a single sense`);
  assert.equal(review.boundary_classification, 'atomic', `${label} must classify the sense boundary`);
  for (const field of [
    'boundary_rationale', 'semantic_rationale', 'no_relation_rationale',
    'decision_rationale', 'frame_rationale',
  ]) assert.ok(nonEmpty(review[field]), `${label} requires authored ${field}`);
  assert.ok(Array.isArray(review.frames) && review.frames.length > 0, `${label} requires authored frames`);
  for (const frame of review.frames) {
    assert.ok(nonEmpty(frame.sentence_frame) && frame.sentence_frame.includes(candidate.lemma),
      `${label} frames must use the lemma`);
    assert.ok(RELATION_TYPES.includes(frame.relation_type), `${label} frame needs a supported relation type`);
    assert.ok(nonEmpty(frame.target_class), `${label} frame needs a route target class`);
  }
  assert.equal(review.single_sense_boundary_status, 'pass', `${label} requires an explicit authored single-sense boundary outcome`);
  if (findAmbiguousParticleFragments(candidate.senses[0].gloss).length > 0) {
    const topic = review.topic_analysis;
    assert.ok(topic && topic.status === 'pass' && ['noun-topic', 'adnominal'].includes(topic.state) && nonEmpty(topic.rationale),
      `${label} requires an explicit authored topic outcome (status, state, rationale)`);
  }
  const spans = glossFrameSpans(candidate.senses[0].gloss);
  assert.equal(review.frames.length, spans.length,
    `${label} must author exactly one frame per gloss span (${spans.length}), got ${review.frames.length}`);
}

// The builder only binds an independently authored semantic review to the
// canonical record. It never supplies judgment fields itself; missing or
// mismatched authored review input fails closed.
export function makeSemanticDecision(row, candidate, rank, passId, sourceId, authoredReview) {
  const sense = candidate.senses[0];
  assert.ok(authoredReview, `${candidate.lemma}: admitted candidate requires an independently authored semantic review`);
  const domainAxes = inspectWriterDomainEvidence(sense.gloss).axes;
  const glossDigest = sha256Json(sense.gloss);
  assertAuthoredSemanticReview(authoredReview, candidate, glossDigest);
  const boundaryDecision = domainAxes.length > 1 ? 'coordinated' : 'atomic';
  const topicFragments = findAmbiguousParticleFragments(sense.gloss);
  const topicAnalysisFor = (fragment) => ({
    status: authoredReview.topic_analysis.status,
    state: authoredReview.topic_analysis.state,
    topic: fragment.topic,
    particle: fragment.particle,
    predicate: fragment.predicate,
    token_index: fragment.token_index,
    gloss_sha256: glossDigest,
    decision_source_id: sourceId,
    rationale: `${candidate.id} ${sense.id}: ${authoredReview.topic_analysis.rationale}`,
  });
  const frameSpans = glossFrameSpans(sense.gloss);
  const senseReview = {
    sense_id: sense.id,
    boundary_action: authoredReview.boundary_action,
    boundary_classification: authoredReview.boundary_classification,
    boundary_decision: boundaryDecision,
    boundary_rationale: `${row.inventory_id} ${candidate.id} ${sense.id}: ${authoredReview.boundary_rationale} Reviewed gloss SHA-256 ${glossDigest}.`,
    semantic_rationale: `${candidate.id} ${sense.id}: ${authoredReview.semantic_rationale}`,
    relation_decision: 'no-relations',
    relation_count: 0,
    relation_ids: [],
    no_relation_rationale: `${row.inventory_id} ${candidate.id}-${sense.id}: ${authoredReview.no_relation_rationale}`,
    ...(topicFragments.length > 0 ? {
      review_basis: {
        ...(topicFragments.length === 1
          ? { topic_analysis: topicAnalysisFor(topicFragments[0]) }
          : { topic_analyses: topicFragments.map(topicAnalysisFor) }),
      },
    } : {}),
    single_sense_boundary_review: {
      status: authoredReview.single_sense_boundary_status,
      sense_id: sense.id,
      gloss_sha256: glossDigest,
      decision_source_id: sourceId,
      decision: authoredReview.boundary_action,
      frame_observations: frameSpans.map((span, index) => ({
        ...span,
        sentence_frame: authoredReview.frames[index].sentence_frame,
        writer_route: {
          relation_type: authoredReview.frames[index].relation_type,
          target_class: authoredReview.frames[index].target_class,
        },
      })),
      rationale: `${candidate.id} ${sense.id}: ${authoredReview.frame_rationale}`,
    },
  };
  const decision = {
    candidate_record_id: candidate.id,
    inventory_id: row.inventory_id,
    candidate_record_sha256: sha256Json(candidate),
    decision: 'included',
    rank,
    decision_rationale: `${row.inventory_id} ${candidate.id}: ${authoredReview.decision_rationale}`,
    review_pass_id: passId,
    gloss_judgment: authoredReview.gloss_judgment,
    sense_reviews: [senseReview],
    selection_axis: row.editorial_judgment.writer_use_axis,
  };
  decision.review_binding = authorSemanticReviewBinding(decision, candidate);
  return decision;
}

function semanticArtifactDigest(source) {
  const withoutDigest = structuredClone(source);
  delete withoutDigest.artifact_sha256;
  withoutDigest.decisions = withoutDigest.decisions.map(compactAuthoredSemanticDecisionRow);
  return sha256Json(withoutDigest);
}

function requireArgs(args) {
  const values = Object.fromEntries(args.map((arg) => {
    const match = /^--([^=]+)=(.*)$/u.exec(arg);
    if (!match) throw new Error(`invalid argument ${arg}; use --key=value`);
    return [match[1], match[2]];
  }));
  for (const key of ['batch-id', 'analysis-directory', 'authored-decisions']) {
    if (!values[key]) throw new Error(`usage: node scripts/batch/build-issue-223-corpus-batch.mjs --batch-id=... --analysis-directory=data/reference/... --authored-decisions=data/batches/...json [--semantic-reviews=...json]`);
  }
  return { ...values, 'review-only': values['review-only'] === 'true' };
}

export async function buildIssue223CorpusBatch({
  batchId, analysisDirectory, authoredDecisionsPath, semanticReviewsPath, reviewOnly = false,
}) {
  const absoluteAnalysis = path.resolve(ROOT, analysisDirectory);
  const absoluteReviewInput = path.resolve(ROOT, authoredDecisionsPath);
  const { ordinal: batchOrdinal, ordinalText: batchNumber, date: batchDate, stem: batchStem } = parseIssue223BatchId(batchId);
  if (reviewOnly) assert.equal(batchOrdinal, 5, 'only B05 is an owner-directed review-only batch');
  assert.equal(path.resolve(ROOT, analysisDirectory), absoluteAnalysis);
  const inventoryPath = path.join(absoluteAnalysis, 'candidate-inventory.json');
  const evidencePath = path.join(absoluteAnalysis, 'candidate-evidence.json');
  const selectionPath = path.join(absoluteAnalysis, 'candidate-selection.json');
  const [inventoryBytes, evidenceBytes, selectionBytes, inputBytes] = await Promise.all([
    readFile(inventoryPath), readFile(evidencePath), readFile(selectionPath), readFile(absoluteReviewInput),
  ]);
  const inventory = JSON.parse(inventoryBytes.toString('utf8'));
  const evidence = JSON.parse(evidenceBytes.toString('utf8'));
  const selectionArtifact = JSON.parse(selectionBytes.toString('utf8'));
  const authored = JSON.parse(inputBytes.toString('utf8'));
  const authoredDecisionRows = authored.decisions ?? [
    ...(authored.admissions ?? []).map(([lemma, axis, gloss]) => ({ lemma, disposition: 'admit', axis, gloss })),
    ...(authored.holds ?? []).map((row) => ({ ...row, disposition: 'hold' })),
  ];
  assert.equal(inventory.selection.selected_candidate_count, inventory.candidates.length);
  assert.equal(evidence.candidates.length, inventory.candidates.length);

  const reviewFiles = selectPredecessorReviewFiles(await readdir(path.join(ROOT, 'data/batches')), batchId);
  const previous = await Promise.all(reviewFiles.map(async (name) => (
    JSON.parse(await readFile(path.join(ROOT, 'data/batches', name), 'utf8'))
  )));
  const priorCandidateCount = previous.reduce((sum, review) => sum + review.decisions.length, 0);
  const priorAdmitCount = previous.reduce((sum, review) => sum + review.decision_counts.admit, 0);
  const firstInventoryNumber = 12286 + priorCandidateCount;
  let canonicalNumber = 7858 + priorAdmitCount;
  const decisionMap = new Map(authoredDecisionRows.map((row) => {
    const candidateIndex = inventory.candidates.findIndex((candidate) => candidate.proposed_lemma === row.lemma);
    assert.ok(candidateIndex >= 0, `authored lemma ${row.lemma} is outside the selected candidate inventory`);
    return [candidateIndex + 1, { ...row, candidate_ordinal: candidateIndex + 1 }];
  }));
  assert.equal(decisionMap.size, inventory.candidates.length);

  const rows = inventory.candidates.map((candidate, index) => {
    const ordinal = index + 1;
    const editorial = decisionMap.get(ordinal);
    assert.ok(editorial, `missing disposition for candidate ${ordinal}`);
    assert.equal(editorial.lemma, candidate.proposed_lemma, `candidate ${ordinal} decision is bound to its lemma`);
    const inventoryId = `m5-${firstInventoryNumber + index}`;
    const canonicalId = editorial.disposition === 'admit'
      ? `w${String(canonicalNumber++).padStart(4, '0')}`
      : null;
    if (editorial.disposition === 'admit') {
      assert.ok(WRITER_USE_BY_AXIS[editorial.axis], `candidate ${ordinal} needs a supported writer axis`);
      assert.equal(typeof editorial.gloss, 'string');
      assert.ok(editorial.gloss.trim().length > 0);
      if (editorial.corrected_pos !== undefined) {
        assert.ok(['noun', 'verb', 'adjective', 'adverb'].includes(editorial.corrected_pos));
        assert.notEqual(editorial.corrected_pos, candidate.proposed_pos);
        assert.equal(typeof editorial.pos_correction_rationale, 'string');
        assert.ok(editorial.pos_correction_rationale.trim());
        assert.ok(Array.isArray(editorial.pos_correction_hit_indices) && editorial.pos_correction_hit_indices.length > 0);
        assert.ok(editorial.pos_correction_hit_indices.every((hitIndex) => Number.isInteger(hitIndex)
          && hitIndex >= 0
          && hitIndex < evidence.candidates[index].evidence.representative_hits.length));
      }
    } else {
      assert.equal(editorial.disposition, 'hold');
      assert.ok(['unresolved-identity', 'unresolved-sense'].includes(editorial.basis));
      assert.ok(typeof editorial.rationale === 'string' && editorial.rationale.trim());
      if (editorial.basis === 'unresolved-sense') {
        assert.ok(Array.isArray(editorial.directions) && editorial.directions.length >= 2);
        assert.ok(editorial.directions.every((direction) => direction.hit_indices.length > 0
          && direction.hit_indices.every((hitIndex) => Number.isInteger(hitIndex)
            && hitIndex >= 0
            && hitIndex < evidence.candidates[index].evidence.representative_hits.length)));
      }
    }
    return candidateReviewRow(
      candidate,
      evidence.candidates[index],
      editorial,
      ordinal,
      inventoryId,
      canonicalId,
      batchId,
      inventory.index.sample_paragraph_count,
    );
  });

  const admittedRows = rows.filter(({ editorial_judgment: judgment }) => judgment.disposition === 'admit');
  const sourceTemplate = previous.at(-1);
  assert.ok(sourceTemplate, 'Issue #223 corpus batch 01 must exist before generation');
  const selection = {
    ...selectionArtifact.selection,
    candidate_selection_sha256: sha256Bytes(selectionBytes),
    selection_rationale: 'The deterministic corpus-evidence order sets a bounded review queue only; each disposition follows separate lexical identity, POS, sense, and current surface coverage review.',
  };
  const source = {
    ...structuredClone(sourceTemplate.source),
    index: inventory.index,
    typewriter_surface: inventory.typewriter_surface,
  };
  const sourceArtifacts = {
    candidate_evidence_path: relative(evidencePath),
    candidate_evidence_sha256: sha256Bytes(evidenceBytes),
    candidate_selection_path: relative(selectionPath),
    candidate_selection_sha256: sha256Bytes(selectionBytes),
    candidate_inventory_path: relative(inventoryPath),
    candidate_inventory_sha256: sha256Bytes(inventoryBytes),
    exclusion_manifest_sha256: selection.exclusion_sha256,
    exclusion_source_artifacts: selection.exclusion_source_artifacts,
  };
  const generationPassId = authored.generation_pass_id;
  const candidatePassId = authored.candidate_review_pass_id;
  const semanticPassId = authored.semantic_verification_pass_id;
  const candidateSourceId = `issue-223-m9-e-corpus-candidate-review-${batchDate}-batch-${batchNumber}-r1`;
  const review = {
    schema_version: '1',
    contract_version: 'm9-corpus-candidate-review-v1',
    kind: 'bounded-corpus-candidate-review-source',
    source_id: candidateSourceId,
    issue: 223,
    parent_issue: 218,
    batch_id: batchId,
    authoring_mode: 'agent-authored-decision',
    reviewer: 'codex-agent',
    human_reviewed: false,
    publication_state: PUBLICATION_STATE,
    provenance: {
      generation_pass_id: generationPassId,
      review_pass_id: candidatePassId,
      generator_version: inventory.extractor.extractor_version === '2' ? 'm9-corpus-lemma-extractor-v2' : inventory.extractor.extractor_version,
      method: SCOPE_METHOD,
    },
    source,
    selection,
    source_artifacts: sourceArtifacts,
    yield: {
      ...inventory.yield,
      excluded_candidate_lemma_count: inventory.selection.excluded_candidate_lemma_count,
    },
    decision_counts: {
      admit: rows.filter(({ editorial_judgment: judgment }) => judgment.disposition === 'admit').length,
      hold: rows.filter(({ editorial_judgment: judgment }) => judgment.disposition === 'hold').length,
      reject: 0,
    },
    decisions: rows,
  };
  if (reviewOnly) {
    review.canonical_import_status = 'owner-deferred-review-only';
    review.canonical_import_count = 0;
    review.canonical_import_deferred_count = admittedRows.length;
    review.canonical_import_deferred_reason = 'Owner requested this checkpoint PR include B05 candidate dispositions only and keep canonical imports at B04.';
  }
  review.artifact_sha256 = sha256Json(review);
  const reviewBytes = prettyBytes(review);
  const reviewSha = sha256Bytes(reviewBytes);

  const batchDirectory = path.join(ROOT, 'data/batches');
  const canonicalDirectory = path.join(ROOT, 'data/canonical');
  const reviewPath = path.join(batchDirectory, `${batchStem}-candidate-review.json`);
  const semanticPath = path.join(batchDirectory, `${batchStem}-semantic-decisions.json`);
  const semanticInputPath = path.join(batchDirectory, `${batchStem}-semantic-review-input.json`);
  const importPath = path.join(canonicalDirectory, `${batchStem}.jsonl`);
  if (reviewOnly) {
    for (const sidecarPath of [semanticPath, importPath]) {
      try {
        await access(sidecarPath);
        throw new Error(`review-only batch must not leave a semantic source or canonical import: ${relative(sidecarPath)}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await writeFile(reviewPath, reviewBytes);
    return {
      batch_id: batchId,
      candidate_review_path: relative(reviewPath),
      candidate_count: rows.length,
      candidate_admit_count: admittedRows.length,
      held_count: rows.length - admittedRows.length,
      canonical_import_count: 0,
      canonical_import_status: review.canonical_import_status,
    };
  }

  const records = admittedRows.map(makeCanonicalRecord);
  const identities = admittedRows.map((row, index) => ({
    catalog_index: index,
    slot_id: `${batchId}-slot-${String(index + 1).padStart(4, '0')}`,
    inventory_id: row.inventory_id,
    candidate_record_id: row.editorial_judgment.candidate_record_id,
    lemma: row.morphology_proposal.lemma,
    axis: row.editorial_judgment.writer_use_axis,
    record_type: 'entry',
    pos: row.morphology_proposal.pos,
  }));
  const semanticSourceId = `${batchId}-semantic-decisions-${batchDate}-r1`;
  assert.ok(semanticReviewsPath, 'admitted records require --semantic-reviews: the builder cannot mint semantic pass evidence');
  const semanticInputBytes = await readFile(path.resolve(ROOT, semanticReviewsPath));
  const semanticInput = JSON.parse(semanticInputBytes.toString('utf8'));
  assertSemanticReviewEnvelope(semanticInput, batchId);
  const semanticReviewByLemma = new Map(semanticInput.reviews.map((entry) => [entry.lemma, entry]));
  assert.equal(semanticReviewByLemma.size, semanticInput.reviews.length, 'semantic review input has duplicate lemmas');
  assert.equal(semanticReviewByLemma.size, admittedRows.length, 'semantic review input must cover exactly the admitted records');
  const semanticDecisions = admittedRows.map((row, index) => makeSemanticDecision(
    row,
    records[index],
    index + 1,
    semanticPassId,
    semanticSourceId,
    semanticReviewByLemma.get(row.morphology_proposal.lemma),
  ));
  const semanticSource = {
    schema_version: '1',
    contract_version: 'lexical-semantic-decision-source-v4',
    review_binding_contract_version: 'source-bound-semantic-review-v2',
    kind: 'separately-authored-semantic-decision-source',
    source_id: semanticSourceId,
    issue: 223,
    parent_issue: 218,
    batch_id: batchId,
    authoring_mode: 'agent-authored-decision',
    source_basis: {
      candidate_review_sha256: reviewSha,
      candidate_selection_sha256: sourceArtifacts.candidate_selection_sha256,
      candidate_evidence_sha256: sourceArtifacts.candidate_evidence_sha256,
      exclusion_manifest_sha256: sourceArtifacts.exclusion_manifest_sha256,
      source_manifest_sha256: inventory.index.input_manifest_sha256,
      logical_rows_sha256: inventory.index.logical_rows_sha256,
      permission_record_sha256: source.permission_record_sha256,
      semantic_review_input_sha256: sha256Bytes(semanticInputBytes),
    },
    provenance: {
      generator: 'codex',
      generator_version: 'issue-223-authored-semantic-review-v1',
      generation_pass_id: generationPassId,
      verification_pass_id: semanticPassId,
      human_reviewed: false,
      authoring_note: AUTHORING_NOTE,
    },
    review: {
      review_pass_id: semanticPassId,
      reviewer: semanticInput.reviewer,
      status: semanticInput.review_status,
      candidate_count: admittedRows.length,
      reviewed_candidate_count: admittedRows.length,
      method: 'Separately verify each admitted source-bound identity, POS, current surface ownership, concise Typewriter-authored gloss, and single-sense boundary using two authored diagnostic frames; apply the ordinary shared semantic admission contract. Candidate order and writer-use metadata do not determine lexical eligibility.',
      criteria: [
        'exact source-bound observed candidate and POS; corrected analyzer POS requires bounded paragraph identifiers',
        'no canonical lemma, curated search-form, or generated-surface collision',
        'bounded in-scope lexical meaning and complete single-sense boundary review',
        'Typewriter-authored gloss; diagnostic frames are not corpus evidence',
        'zero relations when no candidate-specific relation is separately supported',
        'no admission by corpus frequency, usefulness, generality, vividness, or relation count',
      ],
      decision_counts: { included: admittedRows.length, corrected: 0, held: 0, rejected: 0, deferred: 0 },
      prior_generator_replaced: true,
      prior_generator_verification_pass_id: generationPassId,
      counts: { included: admittedRows.length, corrected: 0, held: 0, rejected: 0, deferred: 0 },
      correction_passes: [],
      expression_lexical_unit_review_contract_version: 'm9-expression-lexical-unit-review-v1',
    },
    candidate_source: {
      source_id: candidateSourceId,
      identity_sha256: sha256Json(identities),
      identity_count: identities.length,
    },
    selection: {
      policy: 'shared-authored-axis-coverage-selection-v6',
      capacity: admittedRows.length,
      imported: admittedRows.length,
      reserve: 0,
      coverage_field: 'selection_axis',
      coverage_basis: ['source-bound Typewriter lexical identity after independent semantic eligibility'],
      selection_rationale: 'Every independently reviewed, admitted lexical identity proceeds through ordinary shared admission. The bounded candidate queue does not set an admission quota; unresolved identities, POS, senses, and collisions remain held.',
    },
    candidate_records: records,
    candidate_records_sha256: sha256Json(records),
    decisions: semanticDecisions,
  };
  semanticSource.artifact_sha256 = semanticArtifactDigest(semanticSource);
  const semanticBytes = prettyBytes(semanticSource);
  const semanticArtifactSha = semanticSource.artifact_sha256;
  const importBytes = Buffer.from(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');

  validateAuthoredSemanticDecisionSource({
    source: semanticSource,
    sourceBytes: semanticBytes,
    identities,
    candidateRecords: records,
    config: {
      label: `Issue #223 ${batchId}`,
      errorPrefix: 'ISSUE_223',
      sourcePath: `data/batches/${batchStem}-semantic-decisions.json`,
      sourceId: semanticSourceId,
      candidateSourceId,
      batchId,
      issue: 223,
      parentIssue: 218,
      generationPassId,
      verificationPassId: semanticPassId,
      correctionPassId: issue223CorrectionPassId(batchId),
      reviewer: semanticInput.reviewer,
      semanticReviewVersion: 'issue-223-authored-semantic-review-v1',
      selectionPolicy: 'shared-authored-axis-coverage-selection-v6',
      selectionCount: admittedRows.length,
      importCountFromDecisions: true,
      noAdmissionQuota: true,
      reserveCount: 0,
      requireSingleSenseBoundaryReview: true,
      expressionLexicalUnitReviewContractVersion: 'm9-expression-lexical-unit-review-v1',
    },
  });

  await Promise.all([
    writeFile(reviewPath, reviewBytes),
    writeFile(semanticPath, semanticBytes),
    writeFile(semanticInputPath, semanticInputBytes),
    writeFile(importPath, importBytes),
  ]);

  const promotionRows = semanticDecisions.map((decision) => ({
    schema_version: '1',
    batch_id: batchId,
    inventory_id: decision.inventory_id,
    canonical_id: decision.candidate_record_id,
    decision: 'included',
    record_sha256: decision.candidate_record_sha256,
    decision_source_id: semanticSourceId,
    decision_source_sha256: semanticArtifactSha,
    decision_row_sha256: sha256Json(compactAuthoredSemanticDecisionRow(decision)),
    reason_codes: [decision.selection_axis],
    flags: [],
    decision_note: `${decision.inventory_id} ${decision.candidate_record_id}: bounded corpus proposal received a source-bound Typewriter identity, POS, gloss, and single-sense review. It passed ordinary shared admission; zero relations are valid. Corpus counts and writer usefulness did not authorize admission.`,
  }));
  const promotionPath = path.join(ROOT, 'data/inventory/m5-target-promotions.jsonl');
  const existingPromotions = (await readFile(promotionPath, 'utf8'))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.batch_id !== batchId);
  await writeFile(
    promotionPath,
    [...existingPromotions, ...promotionRows].map((row) => JSON.stringify(row)).join('\n') + '\n',
    'utf8',
  );

  const semanticHistoryPath = path.join(ROOT, 'data/validation/canonical-semantic-decision-source.json');
  const semanticHistory = JSON.parse(await readFile(semanticHistoryPath, 'utf8'));
  const authoredRowsByRecordId = new Map(semanticHistory.authored_review.records.map((row) => [row.record_id, row]));
  for (const decision of semanticDecisions) {
    const record = records.find(({ id }) => id === decision.candidate_record_id);
    authoredRowsByRecordId.set(record.id, {
      record_id: record.id,
      record_sha256: sha256Json(record),
      authored_batch_decision: {
        source_id: semanticSourceId,
        source_sha256: sha256Bytes(semanticBytes),
        artifact_sha256: semanticArtifactSha,
        decision_row_sha256: sha256Json(compactAuthoredSemanticDecisionRow(decision)),
        candidate_record_id: record.id,
        candidate_record_sha256: sha256Json(record),
        decision: 'included',
        selection_rank: decision.rank,
        selection_axis: decision.selection_axis,
        reviewed_record_sha256: sha256Json(record),
      },
    });
  }
  semanticHistory.authored_review.records = [...authoredRowsByRecordId.values()];
  const allCanonical = await readCanonicalRecords(path.join(ROOT, 'data/canonical'));
  const canonicalIds = new Set(allCanonical.records.map((recordInfo) => (
    (recordInfo?.record ?? recordInfo).id
  )));
  semanticHistory.authored_review.records = semanticHistory.authored_review.records
    .filter((row) => canonicalIds.has(row.record_id));
  const canonicalDigest = canonicalRecordsSha256(allCanonical.records);
  semanticHistory.source.canonical_records_sha256 = canonicalDigest;
  semanticHistory.authored_review.source.canonical_records_sha256 = canonicalDigest;
  semanticHistory.authored_review_sha256 = sha256Json(semanticHistory.authored_review);
  await writeFile(semanticHistoryPath, prettyBytes(semanticHistory));

  return {
    batch_id: batchId,
    candidate_count: rows.length,
    decision_counts: review.decision_counts,
    canonical_import_count: records.length,
    candidate_review_path: relative(reviewPath),
    semantic_decision_path: relative(semanticPath),
    semantic_review_input_path: relative(semanticInputPath),
    canonical_import_path: relative(importPath),
    semantic_review_sha256: sha256Bytes(semanticBytes),
    semantic_review_artifact_sha256: semanticArtifactSha,
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = requireArgs(process.argv.slice(2));
  buildIssue223CorpusBatch({
    batchId: args['batch-id'],
    analysisDirectory: args['analysis-directory'],
    authoredDecisionsPath: args['authored-decisions'],
    semanticReviewsPath: args['semantic-reviews'],
    reviewOnly: args['review-only'],
  }).then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  }).catch((error) => {
    console.error(error.code ? `${error.code}: ${error.message}` : error.stack ?? error.message);
    process.exitCode = 1;
  });
}
