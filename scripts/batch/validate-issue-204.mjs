import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SOURCE_BOUND_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
  AUTHORED_SEMANTIC_REVIEW_BINDING_CONTRACT_VERSION,
} from '../validate/semantic-decision-row.mjs';
import {
  DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
  buildSemanticAuditFromDecisionSource,
  canonicalRecordsSha256,
  readAuthoredBatchDecisionSources,
  readSemanticDecisionSourceArtifact,
  serializeSemanticAuditArtifact,
  sha256Json,
} from '../validate/semantic-audit.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import {
  inspectGlossConnectors,
  inspectWriterDomainEvidence,
} from '../validate/lexical-quality.mjs';
import {
  validateAuthoredSemanticDecisionSource,
  authoredSemanticDecisionRowDigest,
} from './authored-semantic-decision-source.mjs';
import { validateLexicalProduction } from './lexical-production.mjs';
import { productionBytesSha256, productionSourceBytes } from './lexical-production-state.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const PILOT_DECISION_PATH = path.join(REPOSITORY_DIRECTORY, 'data/batches/issue-204-pilot-decisions.json');
const SEMANTIC_DECISION_PATH = path.join(REPOSITORY_DIRECTORY, 'data/batches/issue-204-semantic-decisions.json');
const CANONICAL_IMPORT_PATH = path.join(REPOSITORY_DIRECTORY, 'data/canonical/issue-204-corpus-pilot.jsonl');
const BATCH_ID = 'issue-204-corpus-pilot-20260928';
const DECISION_SOURCE_ID = 'issue-204-authored-semantic-decisions-20260928-r1';
const CANDIDATE_SOURCE_ID = 'issue-204-corpus-candidates-20260928-r1';
const GENERATION_PASS_ID = 'issue-204-candidate-draft-20260928-r1';
const VERIFICATION_PASS_ID = 'issue-204-agent-editorial-review-20260928-r1';
const SEMANTIC_REVIEW_VERSION = 'issue-204-authored-semantic-review-v1';
const DECISIONS = [
  'admit',
  'hold',
  'reject',
  'already-covered',
  'invalid-lemma',
  'wrong-pos',
  'needs-sense-split',
  'search-surface-collision',
];

function fail(message) {
  throw new Error('Issue #204 validation failed: ' + message);
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function jsonlBytes(records) {
  return Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
}

function recordOf(recordInfo) {
  return recordInfo?.record ?? recordInfo;
}

function hasExactKeys(value, expectedKeys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort());
}

function hasAllowedKeys(value, requiredKeys, allowedKeys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && requiredKeys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowedKeys.includes(key));
}

function validateDispositionLedger(ledger, ledgerBytes) {
  if (ledger.schema_version !== 'issue-204-pilot-review-v1'
    || ledger.issue !== 204
    || ledger.parent_issue !== 201
    || ledger.authoring_mode !== 'agent-authored-decision'
    || ledger.reviewer !== 'codex-agent'
    || ledger.human_reviewed !== false
    || ledger.publication_state !== 'local_reference_only_pending_owner_publication_confirmation') {
    fail('review ledger identity or provenance is incorrect');
  }
  if (ledger.source_artifacts?.candidate_count !== 100
    || ledger.source_artifacts?.source_text_committed !== false
    || !/^[0-9a-f]{64}$/u.test(ledger.source_artifacts?.candidate_selection_sha256 ?? '')
    || !/^[0-9a-f]{64}$/u.test(ledger.source_artifacts?.pilot_inventory_sha256 ?? '')
    || !/^[0-9a-f]{64}$/u.test(ledger.source_artifacts?.canonical_revision_before ?? '')) {
    fail('review ledger does not bind the exact #203 artifacts and canonical base');
  }
  if (!Array.isArray(ledger.decisions) || ledger.decisions.length !== 100) {
    fail('review ledger must cover exactly 100 candidates');
  }
  const observedCounts = Object.fromEntries(DECISIONS.map((decision) => [decision, 0]));
  const ordinals = new Set();
  const inventoryIds = new Set();
  for (const row of ledger.decisions) {
    const editorial = row?.editorial_judgment;
    if (!hasExactKeys(row, [
      'candidate_ordinal',
      'inventory_id',
      'corpus_evidence',
      'morphology_proposal',
      'editorial_judgment',
    ]) || !hasExactKeys(row.morphology_proposal, [
      'lemma',
      'pos',
      'analyzer_pos',
      'ambiguity_status',
      'analyzer_interpretation_count',
      'ambiguous_observed_surface_count',
    ]) || !hasExactKeys(row.corpus_evidence, [
      'paragraph_hits_in_sample',
      'distinct_documents_in_sample',
      'distinct_sources_in_sample',
      'source_concentration_ratio_in_sample',
      'sample_fraction',
    ]) || !hasAllowedKeys(editorial, [
      'disposition',
      'rationale',
      'reviewer',
      'human_reviewed',
      'corrected_lemma',
      'corrected_pos',
      'writer_use_axis',
      'canonical_record_ids',
      'admitted_sense_count',
    ], [
      'disposition',
      'rationale',
      'reviewer',
      'human_reviewed',
      'corrected_lemma',
      'corrected_pos',
      'writer_use_axis',
      'canonical_record_ids',
      'admitted_sense_count',
      'writer_usefulness_rejection_class',
      'writer_usefulness_rejection_class_label',
      'competing_canonical_matches',
    ])) {
      fail('review rows must keep corpus evidence aggregate-only and match the closed decision shape');
    }
    if (!Number.isInteger(row?.candidate_ordinal)
      || row.candidate_ordinal < 1
      || row.candidate_ordinal > 100
      || ordinals.has(row.candidate_ordinal)) {
      fail('candidate ordinals must cover the source pool once each');
    }
    ordinals.add(row.candidate_ordinal);
    if (typeof row.inventory_id !== 'string' || inventoryIds.has(row.inventory_id)) {
      fail('pilot inventory identities must be unique');
    }
    inventoryIds.add(row.inventory_id);
    if (!DECISIONS.includes(editorial?.disposition)
      || typeof editorial?.rationale !== 'string'
      || editorial.rationale.trim().length === 0
      || editorial.reviewer !== 'codex-agent'
      || editorial.human_reviewed !== false) {
      fail('every candidate requires an explicit agent-authored editorial disposition');
    }
    if (typeof row.morphology_proposal.lemma !== 'string'
      || row.morphology_proposal.lemma.trim().length === 0
      || row.morphology_proposal.lemma !== row.morphology_proposal.lemma.normalize('NFC')
      || typeof row.morphology_proposal?.pos !== 'string'
      || row.morphology_proposal.pos.trim().length === 0
      || typeof row.morphology_proposal?.analyzer_pos !== 'string'
      || typeof row.morphology_proposal?.ambiguity_status !== 'string'
      || !Number.isSafeInteger(row.morphology_proposal?.analyzer_interpretation_count)
      || row.morphology_proposal.analyzer_interpretation_count < 0
      || !Number.isSafeInteger(row.morphology_proposal?.ambiguous_observed_surface_count)
      || row.morphology_proposal.ambiguous_observed_surface_count < 0
      || typeof row.corpus_evidence?.paragraph_hits_in_sample !== 'number'
      || !Number.isSafeInteger(row.corpus_evidence.paragraph_hits_in_sample)
      || row.corpus_evidence.paragraph_hits_in_sample < 0
      || !Number.isSafeInteger(row.corpus_evidence.distinct_documents_in_sample)
      || row.corpus_evidence.distinct_documents_in_sample < 0
      || !Number.isSafeInteger(row.corpus_evidence.distinct_sources_in_sample)
      || row.corpus_evidence.distinct_sources_in_sample < 0
      || !Number.isFinite(row.corpus_evidence.source_concentration_ratio_in_sample)
      || row.corpus_evidence.source_concentration_ratio_in_sample < 0
      || row.corpus_evidence.source_concentration_ratio_in_sample > 1
      || typeof row.corpus_evidence?.distinct_sources_in_sample !== 'number'
      || typeof row.corpus_evidence?.sample_fraction !== 'number'
      || !Number.isFinite(row.corpus_evidence.sample_fraction)
      || row.corpus_evidence.sample_fraction < 0
      || row.corpus_evidence.sample_fraction > 1) {
      fail('candidate morphology and aggregate corpus evidence are incomplete');
    }
    if (editorial.corrected_lemma !== null || editorial.corrected_pos !== null) {
      fail('the authored pilot unexpectedly claims a lemma or POS correction');
    }
    const hasRejectionClass = Object.hasOwn(editorial, 'writer_usefulness_rejection_class')
      && Object.hasOwn(editorial, 'writer_usefulness_rejection_class_label');
    if ((editorial.disposition === 'reject') !== hasRejectionClass
      || (Object.hasOwn(editorial, 'competing_canonical_matches')
        && (!Array.isArray(editorial.competing_canonical_matches)
          || editorial.competing_canonical_matches.length === 0))) {
      fail('optional editorial details do not match the candidate disposition');
    }
    observedCounts[editorial.disposition] += 1;
  }
  const sortedOrdinals = [...ordinals].sort((left, right) => left - right);
  if (sortedOrdinals.some((ordinal, index) => ordinal !== index + 1)) {
    fail('review ledger omits a candidate ordinal');
  }
  if (JSON.stringify(observedCounts) !== JSON.stringify(ledger.decision_counts)) {
    fail('review ledger decision totals do not match its 100 rows');
  }
  const expectedCounts = {
    admit: 10,
    hold: 39,
    reject: 25,
    'already-covered': 0,
    'invalid-lemma': 0,
    'wrong-pos': 0,
    'needs-sense-split': 25,
    'search-surface-collision': 1,
  };
  for (const [decision, count] of Object.entries(expectedCounts)) {
    if (observedCounts[decision] !== count) {
      fail('unexpected disposition count for ' + decision);
    }
  }
  if (sha256Bytes(ledgerBytes) !== ledger.source_artifacts.ledger_sha256
    && ledger.source_artifacts.ledger_sha256 !== undefined) {
    fail('review ledger self-digest is inconsistent');
  }
  return observedCounts;
}

function issue204DecisionConfig(source) {
  return {
    label: 'Issue #204',
    errorPrefix: 'ISSUE_204',
    sourceId: DECISION_SOURCE_ID,
    candidateSourceId: CANDIDATE_SOURCE_ID,
    batchId: BATCH_ID,
    issue: 204,
    parentIssue: 201,
    generationPassId: GENERATION_PASS_ID,
    verificationPassId: VERIFICATION_PASS_ID,
    correctionPassId: 'issue-204-agent-correction-20260928-r1',
    semanticReviewVersion: SEMANTIC_REVIEW_VERSION,
    selectionPolicy: source.selection?.policy,
    selectionCount: 10,
    importCount: 10,
    reserveCount: 0,
  };
}

function makeSemanticReview(record, identity, decisionRow, decisionSource) {
  const sourceId = decisionSource.source.source_id;
  const senseReviews = decisionRow.sense_reviews;
  const senseReviewById = new Map(senseReviews.map((row) => [row.sense_id, row]));
  const semanticEvidenceForSense = (sense) => {
    const senseReview = senseReviewById.get(sense.id);
    const domains = inspectWriterDomainEvidence(sense.gloss);
    return {
      status: 'pass',
      gloss_sha256: sha256Json(sense.gloss),
      observed_domain_axes: domains.axes,
      domain_evidence: domains.matches,
      connector_observations: inspectGlossConnectors(sense.gloss),
      rationale: senseReview.semantic_rationale,
      boundary_decision: senseReview.boundary_decision,
      decision_source_id: sourceId,
      ...(senseReview.review_basis?.topic_analysis
        ? { topic_analysis: { ...structuredClone(senseReview.review_basis.topic_analysis), decision_source_id: sourceId } }
        : {}),
      ...(Array.isArray(senseReview.review_basis?.topic_analyses)
        ? { topic_analyses: senseReview.review_basis.topic_analyses.map((analysis) => ({
          ...structuredClone(analysis),
          decision_source_id: sourceId,
        })) }
        : {}),
    };
  };
  const reviewedRecordSha256 = sha256Json(record);
  return {
    status: 'complete',
    decision_source: {
      kind: 'separately-authored-semantic-decision-source',
      contract_version: 'lexical-semantic-decision-source-v1',
      source_id: sourceId,
      path: 'data/batches/issue-204-semantic-decisions.json',
      authoring_mode: 'agent-authored-decision',
      source_sha256: decisionSource.sourceSha256,
      artifact_sha256: decisionSource.artifactSha256,
    },
    authored_decision: {
      source_sha256: decisionSource.sourceSha256,
      decision_source_id: sourceId,
      candidate_record_id: record.id,
      candidate_record_sha256: decisionRow.candidate_record_sha256,
      reviewed_record_sha256: reviewedRecordSha256,
      decision: decisionRow.decision,
      selection_rank: decisionRow.rank,
      selection_axis: decisionRow.selection_axis,
      rationale: decisionRow.decision_rationale,
      sense_evidence: record.senses.map((sense) => ({
        sense_id: sense.id,
        gloss_sha256: sha256Json(sense.gloss),
        basis: senseReviewById.get(sense.id).semantic_rationale,
      })),
      relation_evidence: record.senses.map((sense) => ({
        sense_id: sense.id,
        relation_count: 0,
        relation_ids: [],
        decision: 'no-relations',
        basis: senseReviewById.get(sense.id).no_relation_rationale,
      })),
    },
    sense_boundary: {
      status: 'pass',
      decision_source_id: sourceId,
      review_id: VERIFICATION_PASS_ID + ':canonical:' + record.id + ':boundary',
      method: 'gloss-and-usage-pairwise-v2',
      independence: {
        independent_of_sense_count: true,
        source: 'separate-agent-verification-pass',
        decision_source_id: sourceId,
        decision_source_version: 'lexical-semantic-boundary-decisions-v1',
      },
      findings: record.senses.map((sense) => {
        const senseReview = senseReviewById.get(sense.id);
        return {
          sense_id: sense.id,
          action: senseReview.boundary_action,
          classification: senseReview.boundary_classification,
          rationale: senseReview.boundary_rationale,
          semantic_evidence: semanticEvidenceForSense(sense),
        };
      }),
      pairwise: (decisionRow.boundary_pairs ?? []).map((pair) => ({
        ...structuredClone(pair),
        decision_source_id: sourceId,
      })),
      rationale: senseReviews[0].boundary_rationale,
    },
    pos: {
      status: 'pass',
      decision: 'verified',
      observed_pos: record.senses.map(({ pos }) => pos),
      decision_source_id: sourceId,
      rationale: identity.inventory_id + ' POS was verified in ' + VERIFICATION_PASS_ID + '.',
    },
    expression: {
      status: 'pass',
      decision: 'verified',
      expected_record_type: record.record_type,
      observed_record_type: record.record_type,
      decision_source_id: sourceId,
      rationale: identity.inventory_id + ' record type was verified in ' + VERIFICATION_PASS_ID + '.',
    },
    relation: {
      status: 'pass',
      decision_source_id: sourceId,
      per_sense: record.senses.map((sense) => ({
        sense_id: sense.id,
        decision: 'no-relations',
        decision_source_id: sourceId,
        relation_count: 0,
        relation_ids: [],
        no_relation_rationale: senseReviewById.get(sense.id).no_relation_rationale,
      })),
    },
    selection: {
      status: 'selected',
      rank: decisionRow.rank,
      axis: decisionRow.selection_axis,
      rationale: identity.inventory_id + ': selected after semantic verification with source-bound writer-axis coverage.',
    },
  };
}

function makeReviewRows(identities, candidateRecords, decisionSource) {
  return identities.map((identity, index) => {
    const candidate = candidateRecords[index];
    const decisionRow = decisionSource.byCandidateId.get(candidate.id);
    if (!decisionRow) fail('admitted candidate has no authored semantic decision');
    return {
      slot_id: BATCH_ID + '-slot-' + String(index + 1).padStart(4, '0'),
      inventory_id: identity.inventory_id,
      candidate_identity_id: identity.inventory_id,
      candidate_id: candidate.id,
      candidate_lemma: identity.lemma,
      generation_pass_id: GENERATION_PASS_ID,
      verification_pass_id: VERIFICATION_PASS_ID,
      decision: decisionRow.decision,
      final_decision: decisionRow.decision,
      selection_status: 'selected',
      expected_record_type: 'entry',
      semantic_review: makeSemanticReview(candidate, identity, decisionRow, decisionSource),
      reviewed_record: structuredClone(candidate),
    };
  });
}

function buildProductionStageEvidence({ pilotBytes, decisionBytes, prospectiveRecords, semanticAudit }) {
  const prospectiveBytes = jsonlBytes(prospectiveRecords.map(recordOf));
  const auditBytes = serializeSemanticAuditArtifact(semanticAudit);
  const authorizationBytes = productionSourceBytes({
    issue: 204,
    batch_id: BATCH_ID,
    generation_pass_id: GENERATION_PASS_ID,
    verification_pass_id: VERIFICATION_PASS_ID,
    decision: 'admit',
  });
  const admissionBytes = jsonBytes({
    artifact_id: 'issue-204-admission-stage',
    issue: 204,
    batch_id: BATCH_ID,
    authorization_sha256: productionBytesSha256(authorizationBytes),
  });
  return {
    candidate_intake: {
      status: 'complete',
      source_path: 'data/batches/issue-204-pilot-decisions.json',
      source_bytes: pilotBytes,
      source_sha256: sha256Bytes(pilotBytes),
    },
    semantic_review: {
      status: 'complete',
      source_path: 'data/batches/issue-204-semantic-decisions.json',
      source_bytes: decisionBytes,
      source_sha256: sha256Bytes(decisionBytes),
    },
    selection: {
      status: 'complete',
      source_path: 'data/batches/issue-204-semantic-decisions.json',
      source_bytes: decisionBytes,
      source_sha256: sha256Bytes(decisionBytes),
      policy: 'writer-usefulness-and-sense-boundary-reviewed-candidates',
    },
    prospective_canonical: {
      status: 'complete',
      source_path: 'external:issue-204-prospective-canonical',
      source_bytes: prospectiveBytes,
      source_sha256: sha256Bytes(prospectiveBytes),
    },
    audit: {
      status: 'complete',
      source_path: 'external:issue-204-complete-semantic-audit',
      source_bytes: auditBytes,
      source_sha256: sha256Bytes(auditBytes),
    },
    admission: {
      status: 'complete',
      source_path: 'external:issue-204-admission',
      source_bytes: admissionBytes,
      source_sha256: sha256Bytes(admissionBytes),
      authorization_bytes: authorizationBytes,
      authorization_ref: 'issue-204-agent-authored-admission',
      decision: 'admit',
    },
  };
}

export async function validateIssue204() {
  const [pilotBytes, decisionBytes, importBytes] = await Promise.all([
    readFile(PILOT_DECISION_PATH),
    readFile(SEMANTIC_DECISION_PATH),
    readFile(CANONICAL_IMPORT_PATH),
  ]);
  const ledger = JSON.parse(pilotBytes.toString('utf8'));
  const dispositionCounts = validateDispositionLedger(ledger, pilotBytes);
  const source = JSON.parse(decisionBytes.toString('utf8'));
  const importedRecords = importBytes.toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  const admittedRows = ledger.decisions.filter((row) => row.editorial_judgment.disposition === 'admit');
  const expectedOrdinals = admittedRows.map((row) => row.candidate_ordinal);
  if (source.source_basis?.pilot_decision_ledger_sha256 !== sha256Bytes(pilotBytes)
    || source.source_basis?.candidate_selection_sha256 !== ledger.source_artifacts.candidate_selection_sha256
    || JSON.stringify(source.source_basis?.admitted_candidate_ordinals) !== JSON.stringify(expectedOrdinals)) {
    fail('admission decision source does not bind the 100-row review and selected ordinals');
  }
  if (importedRecords.length !== 10 || source.candidate_records.length !== 10) {
    fail('canonical import and semantic source must each contain ten admitted starts');
  }
  if (JSON.stringify(importedRecords) !== JSON.stringify(source.candidate_records)) {
    fail('canonical import differs from its authored candidate records');
  }
  const identities = admittedRows.map((row, index) => {
    const record = importedRecords[index];
    if (record.id !== 'w' + String(5349 + index)
      || record.lemma !== row.morphology_proposal.lemma
      || record.senses[0]?.pos !== row.morphology_proposal.pos
      || row.editorial_judgment.canonical_record_ids?.[0] !== record.id
      || row.editorial_judgment.admitted_sense_count !== record.senses.length) {
      fail('admitted canonical record is not bound to its reviewed pilot candidate');
    }
    return {
      catalog_index: index,
      inventory_id: row.inventory_id,
      candidate_record_id: record.id,
      lemma: record.lemma,
      axis: row.editorial_judgment.writer_use_axis,
      record_type: record.record_type,
      pos: record.senses[0].pos,
      pilot_candidate_ordinal: row.candidate_ordinal,
    };
  });
  const candidateRecords = source.candidate_records;
  const config = issue204DecisionConfig(source);
  const semanticDecisionSource = validateAuthoredSemanticDecisionSource({
    source,
    sourceBytes: decisionBytes,
    identities,
    candidateRecords,
    config,
  });
  const canonical = await readCanonicalRecords(path.join(REPOSITORY_DIRECTORY, 'data/canonical'));
  const importedIds = new Set(importedRecords.map(({ id }) => id));
  const baseRecords = canonical.records.filter((recordInfo) => !importedIds.has(recordOf(recordInfo).id));
  if (canonical.records.length !== baseRecords.length + importedRecords.length) {
    fail('canonical data does not contain exactly one copy of each issue #204 record');
  }
  for (const record of importedRecords) {
    const stored = canonical.records.find((recordInfo) => recordOf(recordInfo).id === record.id);
    if (!stored || JSON.stringify(recordOf(stored)) !== JSON.stringify(record)) {
      fail('canonical directory does not contain the reviewed record ' + record.id);
    }
  }
  const rootDecisionSource = await readSemanticDecisionSourceArtifact(DEFAULT_SEMANTIC_DECISION_SOURCE_PATH);
  const prospectiveDigest = canonicalRecordsSha256(canonical.records);
  if (rootDecisionSource.source.canonical_records_sha256 !== prospectiveDigest) {
    fail('complete canonical decision source is not bound to the current canonical records');
  }
  const batchDecisionSources = await readAuthoredBatchDecisionSources();
  const semanticAudit = buildSemanticAuditFromDecisionSource(canonical.records, rootDecisionSource, {
    artifactId: 'issue-204-complete-canonical-semantic-audit',
    baseRecords,
    batchDecisionSources,
  });
  const reviewRows = makeReviewRows(identities, candidateRecords, semanticDecisionSource);
  const production = validateLexicalProduction({
    batchId: BATCH_ID,
    candidateRecords,
    reviews: reviewRows,
    baseRecords,
    prospectiveRecords: canonical.records,
    semanticAudit,
    stageEvidence: buildProductionStageEvidence({
      pilotBytes,
      decisionBytes,
      prospectiveRecords: canonical.records,
      semanticAudit,
    }),
    catalogCount: 10,
    expectedSelectedCount: 10,
    candidateLabel: 'Issue #204 admitted pilot candidates',
    reviewedLabel: 'Issue #204 source-bound editorial decisions',
    prospectiveLabel: 'Issue #204 complete prospective canonical records',
  });
  if (production.admission?.audit?.blocking_finding_count !== 0
    || production.admission?.semantic_audit?.coverage_complete !== true) {
    fail('ordinary lexical admission did not complete all canonical audits');
  }
  return {
    reviewed_count: ledger.decisions.length,
    disposition_counts: dispositionCounts,
    admitted_start_count: importedRecords.length,
    admitted_sense_count: importedRecords.reduce((count, record) => count + record.senses.length, 0),
    canonical_record_count: canonical.records.length,
    canonical_digest: prospectiveDigest,
    live_production: production.pipeline_version,
    admission: production.admission.audit.blocking_finding_count === 0 ? 'pass' : 'fail',
  };
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  validateIssue204()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? error.code + ': ' + error.message : error.message);
      process.exitCode = 1;
    });
}
