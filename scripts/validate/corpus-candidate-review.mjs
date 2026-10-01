const SUPPORTED_POS = new Set(['noun', 'verb', 'adjective', 'adverb']);
const ANALYZER_POS = Object.freeze({ NNG: 'noun', VV: 'verb', VA: 'adjective' });
const TYPEWRITER_SCOPE_POS = new Set(['noun', 'verb', 'adjective', 'adverb', 'expression']);
const COLLISION_STATUSES = new Set([
  'search_form_collision',
  'generated_surface_collision',
  'search_and_generated_surface_collision',
]);
const MORPHOLOGY_BLOCKING_STATUSES = new Set([
  'held_surface_has_multiple_analyzer_interpretations',
  'held_lemma_has_multiple_pos_interpretations',
  'held_oov_morphology',
]);
const VALID_DISPOSITIONS = new Set(['admit', 'hold', 'reject']);
const HOLD_BASES = new Set(['unresolved-identity', 'unresolved-sense', 'search-collision']);
const REJECTION_BASES = new Set(['duplicate-identity', 'not-a-lexical-unit', 'unsupported-scope']);

function fail(label, message, suffix = 'DISPOSITION') {
  const error = new Error(`${label} ${message}`);
  error.code = `CORPUS_CANDIDATE_REVIEW_${suffix}`;
  throw error;
}

export function hasMorphologyBlocker(proposal) {
  return MORPHOLOGY_BLOCKING_STATUSES.has(proposal?.ambiguity_status)
    || proposal?.ambiguous_observed_surface_count_in_sample > 0
    || proposal?.pos_interpretation_count_in_sample > 1
    || proposal?.oov_morpheme_occurrences_in_sample > 0;
}

function hasCoverageCollision(row) {
  return COLLISION_STATUSES.has(row?.coverage_status)
    && Array.isArray(row?.typewriter_surface_matches)
    && row.typewriter_surface_matches.length > 0;
}

function hasExactCanonicalDuplicate(row) {
  return row?.coverage_status === 'exact_canonical_lemma'
    && Array.isArray(row?.typewriter_surface_matches)
    && row.typewriter_surface_matches.some((match) => (
      match?.match_kind === 'canonical_lemma'
      && match.canonical_lemma === row.morphology_proposal.lemma
    ));
}

function validateSenseBoundaryEvidence(row, label) {
  const evidence = row.editorial_judgment.sense_boundary_evidence;
  const hits = row.bounded_provenance?.representative_hits;
  if (evidence?.evidence_type !== 'distinct-sense-directions-in-reviewed-bounded-contexts'
    || !Array.isArray(evidence.directions)
    || evidence.directions.length < 2
    || !Array.isArray(hits)) {
    fail(label, 'needs source-bound evidence for at least two distinct unresolved sense directions', 'SENSE_EVIDENCE');
  }

  const availableParagraphIds = new Set(hits.map(({ paragraph_id: id }) => id).filter((id) => typeof id === 'string'));
  const assignedParagraphIds = new Set();
  for (const [index, direction] of evidence.directions.entries()) {
    if (typeof direction?.label !== 'string' || direction.label.trim() === ''
      || !Array.isArray(direction.paragraph_ids) || direction.paragraph_ids.length === 0) {
      fail(`${label}.sense_boundary_evidence.directions[${index}]`, 'needs a label and reviewed paragraph IDs', 'SENSE_EVIDENCE');
    }
    for (const paragraphId of direction.paragraph_ids) {
      if (!availableParagraphIds.has(paragraphId) || assignedParagraphIds.has(paragraphId)) {
        fail(`${label}.sense_boundary_evidence.directions[${index}]`, 'must cite distinct IDs from its bounded representative contexts', 'SENSE_EVIDENCE');
      }
      assignedParagraphIds.add(paragraphId);
    }
  }
}

function validateLexicalUnitRejectionEvidence(row, label) {
  const evidence = row.editorial_judgment.lexical_unit_evidence;
  const hits = row.bounded_provenance?.representative_hits;
  const availableParagraphIds = new Set((Array.isArray(hits) ? hits : [])
    .map(({ paragraph_id: id }) => id).filter((id) => typeof id === 'string'));
  if (evidence?.evidence_type !== 'reviewed-bounded-contexts-show-nonlexical-unit'
    || !Array.isArray(evidence.paragraph_ids)
    || evidence.paragraph_ids.length === 0
    || evidence.paragraph_ids.some((id) => !availableParagraphIds.has(id))) {
    fail(label, 'needs cited bounded-context evidence that the proposal is not a lexical unit', 'LEXICAL_UNIT_EVIDENCE');
  }
}

function validatePosCorrectionEvidence(row, label) {
  const proposal = row.morphology_proposal;
  const correction = row.editorial_judgment.pos_correction;
  const analyzerPos = ANALYZER_POS[proposal.analyzer_pos];
  const hits = row.bounded_provenance?.representative_hits;
  const availableParagraphIds = new Set((Array.isArray(hits) ? hits : [])
    .map(({ paragraph_id: id }) => id).filter((id) => typeof id === 'string'));
  if (!analyzerPos || proposal.pos === analyzerPos
    || correction?.evidence_type !== 'reviewed-bounded-contexts-support-corrected-pos'
    || correction.analyzer_pos !== proposal.analyzer_pos
    || correction.analyzer_mapped_pos !== analyzerPos
    || correction.corrected_pos !== proposal.pos
    || typeof correction.rationale !== 'string'
    || correction.rationale.trim() === ''
    || !Array.isArray(correction.paragraph_ids)
    || correction.paragraph_ids.length === 0
    || new Set(correction.paragraph_ids).size !== correction.paragraph_ids.length
    || correction.paragraph_ids.some((id) => !availableParagraphIds.has(id))) {
    fail(label, 'a corrected analyzer POS must bind the original analysis and reviewed bounded paragraph IDs', 'POS_CORRECTION_EVIDENCE');
  }
}

function validateIdentityEvidence(row, label) {
  const evidence = row.editorial_judgment.identity_evidence;
  const hits = row.bounded_provenance?.representative_hits;
  if (evidence?.evidence_type === 'reviewed-analyzed-forms-show-component-only-usage') {
    const lemma = row.morphology_proposal?.lemma;
    const observedForms = row.observed_surface_forms;
    const observedSpans = row.observed_morpheme_spans;
    const forms = Array.isArray(observedForms)
      ? observedForms.map(({ surface }) => surface)
      : [];
    const citedForms = evidence.observed_surface_forms;
    if (typeof evidence.rationale !== 'string'
      || evidence.rationale.trim() === ''
      || typeof evidence.candidate_morpheme_span_surface !== 'string'
      || evidence.candidate_morpheme_span_surface !== lemma
      || !Array.isArray(observedSpans)
      || !observedSpans.some(({ surface }) => surface === lemma)
      || !Array.isArray(citedForms)
      || citedForms.length === 0
      || JSON.stringify(citedForms) !== JSON.stringify(forms)
      || new Set(forms).size !== forms.length
      || !Array.isArray(hits)
      || hits.length !== 0
      || forms.some((surface) => typeof surface !== 'string'
        || !surface.includes(lemma)
        || surface.startsWith(lemma))) {
      fail(label, 'component-only identity holds must bind every analyzed full form and have no exact-start representative context', 'IDENTITY_EVIDENCE');
    }
    return;
  }

  const availableParagraphIds = new Set((Array.isArray(hits) ? hits : [])
    .map(({ paragraph_id: id }) => id).filter((id) => typeof id === 'string'));
  if (evidence?.evidence_type !== 'reviewed-bounded-contexts-undermine-standalone-lemma'
    || typeof evidence.rationale !== 'string'
    || evidence.rationale.trim() === ''
    || !Array.isArray(evidence.paragraph_ids)
    || evidence.paragraph_ids.length === 0
    || new Set(evidence.paragraph_ids).size !== evidence.paragraph_ids.length
    || evidence.paragraph_ids.some((id) => !availableParagraphIds.has(id))) {
    fail(label, 'a clear analyzer proposal may be held for identity only when reviewed bounded contexts support the boundary concern', 'IDENTITY_EVIDENCE');
  }
}

/**
 * Validate the lexical basis for every M9 corpus candidate disposition.
 * Writer-use metadata and relation counts are deliberately not consulted:
 * they can guide enrichment or review priority, never lexical eligibility.
 */
export function validateCorpusCandidateReviewDispositions(decisions, { label = 'corpus candidate review' } = {}) {
  if (!Array.isArray(decisions)) fail(label, 'decisions must be an array', 'SHAPE');
  const counts = { admit: 0, hold: 0, reject: 0 };

  for (const [index, row] of decisions.entries()) {
    const rowLabel = `${label}.decisions[${index}]${row?.inventory_id ? ` (${row.inventory_id})` : ''}`;
    const judgment = row?.editorial_judgment;
    const proposal = row?.morphology_proposal;
    if (!VALID_DISPOSITIONS.has(judgment?.disposition)) {
      fail(rowLabel, 'must have an explicit admit, hold, or reject disposition', 'SHAPE');
    }
    counts[judgment.disposition] += 1;
    if (typeof proposal?.lemma !== 'string' || proposal.lemma.length === 0) {
      fail(rowLabel, 'must bind a proposed lexical identity', 'IDENTITY');
    }

    if (judgment.disposition === 'admit') {
      if (judgment.disposition_basis !== 'valid-in-scope-lexical-entry'
        || !SUPPORTED_POS.has(proposal.pos)
        || row.coverage_status !== 'uncovered'
        || hasMorphologyBlocker(proposal)
        || typeof judgment.candidate_record_id !== 'string'
        || judgment.candidate_record_id.length === 0) {
        fail(rowLabel, 'admission requires an in-scope lexical identity, clear morphology and coverage, and a canonical candidate ID', 'ADMISSION_BASIS');
      }
      if (proposal.pos !== ANALYZER_POS[proposal.analyzer_pos]) validatePosCorrectionEvidence(row, rowLabel);
      continue;
    }

    if (judgment.candidate_record_id !== null) {
      fail(rowLabel, 'held or rejected candidates cannot have a canonical candidate ID', 'CANDIDATE_ID');
    }

    if (judgment.disposition === 'hold') {
      if (!HOLD_BASES.has(judgment.disposition_basis)) {
        fail(rowLabel, 'hold needs a lexical identity, sense-boundary, or search-collision basis', 'HOLD_BASIS');
      }
      if (judgment.disposition_basis === 'unresolved-identity') {
        if (hasMorphologyBlocker(proposal)) {
          if (judgment.identity_evidence !== undefined) validateIdentityEvidence(row, rowLabel);
        } else {
          validateIdentityEvidence(row, rowLabel);
        }
      }
      if (judgment.disposition_basis === 'unresolved-sense') validateSenseBoundaryEvidence(row, rowLabel);
      if (judgment.disposition_basis === 'search-collision' && !hasCoverageCollision(row)) {
        fail(rowLabel, 'needs a recorded canonical search-surface collision', 'COLLISION_EVIDENCE');
      }
      continue;
    }

    if (!REJECTION_BASES.has(judgment.disposition_basis)) {
      fail(rowLabel, 'rejection needs duplicate, nonlexical-unit, or unsupported-scope evidence', 'REJECTION_BASIS');
    }
    if (judgment.disposition_basis === 'duplicate-identity' && !hasExactCanonicalDuplicate(row)) {
      fail(rowLabel, 'duplicate rejection needs an exact canonical-lemma match', 'COLLISION_EVIDENCE');
    }
    if (judgment.disposition_basis === 'not-a-lexical-unit') validateLexicalUnitRejectionEvidence(row, rowLabel);
    if (judgment.disposition_basis === 'unsupported-scope'
      && (typeof proposal.pos !== 'string' || proposal.pos.trim() === '' || TYPEWRITER_SCOPE_POS.has(proposal.pos))) {
      fail(rowLabel, 'unsupported-scope rejection needs an explicit out-of-scope part of speech', 'SCOPE_EVIDENCE');
    }
  }

  return counts;
}
