import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { prepareCurrentRevisionDatabases } from '../ci/current-revision-database.mjs';
import { readLogicalDatabaseSnapshot } from '../build/query.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';
import {
  buildSemanticAuditFromDecisionSource,
  canonicalRecordsSha256,
  readAuthoredBatchDecisionSources,
  readSemanticDecisionSourceArtifact,
  sha256Json,
} from '../validate/semantic-audit.mjs';
import {
  M9_EXPRESSION_LEXICAL_UNIT_REVIEW_CONTRACT_VERSION,
  validateAuthoredSemanticDecisionSource,
} from './authored-semantic-decision-source.mjs';
import { validateLexicalProduction } from './lexical-production.mjs';
import { validateCorpusCandidateReviewDispositions } from '../validate/corpus-candidate-review.mjs';
import {
  productionReviewRows,
  productionStageEvidence,
  projectDecisionSourceToCanonical,
} from './validate-issue-211.mjs';
import { loadCanonicalBeforeFactoryAdmissions, restoreImportRecordsBeforeFactoryAdmissions } from '../validate/semantic-audit.mjs';
import { EXACT_SEARCH_ROWS_SQL } from '../../src/runtime/sqlite-query.js';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');
const BATCH_ID = 'issue-221-m9-c-batch-01-20260929';
const CANDIDATE_REVIEW_PATH = path.join(ROOT, 'data/batches/issue-221-corpus-candidate-review.json');
const SEMANTIC_SOURCE_PATH = path.join(ROOT, 'data/batches/issue-221-corpus-semantic-decisions.json');
const CANONICAL_IMPORT_PATH = path.join(ROOT, 'data/canonical/issue-221-corpus-production.jsonl');
const ROOT_SEMANTIC_SOURCE_PATH = path.join(ROOT, 'data/validation/canonical-semantic-decision-source.json');
const VOLATILE_DATABASE_METADATA = new Set([
  'source_revision',
  'source_revision_source',
  'source_revision_verified',
  'worktree_state',
  'node_version',
  'sqlite_module',
  'sqlite_version',
]);

const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const recordOf = (recordInfo) => recordInfo?.record ?? recordInfo;

function repositoryArtifactPath(relativePath, label) {
  assert.equal(typeof relativePath, 'string', `${label} path is required`);
  const absolutePath = path.resolve(ROOT, relativePath);
  const relativeToRoot = path.relative(ROOT, absolutePath);
  assert.ok(relativeToRoot && !relativeToRoot.startsWith(`..${path.sep}`)
    && relativeToRoot !== '..' && !path.isAbsolute(relativeToRoot), `${label} must stay inside the repository`);
  return absolutePath;
}

function readJsonl(bytes, label) {
  return bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is invalid JSON: ${error.message}`);
    }
  });
}

function stripVolatileDatabaseMetadata(snapshot) {
  return {
    ...snapshot,
    rows: {
      ...snapshot.rows,
      metadata: snapshot.rows.metadata.filter(({ key }) => !VOLATILE_DATABASE_METADATA.has(key)),
    },
  };
}

function assertTextFreeArtifact(value, label) {
  const forbiddenKeys = new Set(['context', 'paragraph_text', 'paragraph_form', 'excerpt', 'sentence_excerpt']);
  const visit = (node, location) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      assert.equal(forbiddenKeys.has(key), false, `${label} must omit ${location}.${key}`);
      visit(child, `${location}.${key}`);
    }
  };
  visit(value, label);
}

function semanticDecisionConfig(candidateReview, semanticSource) {
  return {
    label: 'Issue #221',
    errorPrefix: 'ISSUE_221',
    sourcePath: 'data/batches/issue-221-corpus-semantic-decisions.json',
    sourceId: semanticSource.source_id,
    candidateSourceId: candidateReview.source_id,
    batchId: semanticSource.batch_id,
    issue: 221,
    parentIssue: 218,
    generationPassId: candidateReview.provenance.generation_pass_id,
    verificationPassId: semanticSource.provenance.verification_pass_id,
    correctionPassId: 'issue-221-agent-correction-20260929-r1',
    semanticReviewVersion: semanticSource.provenance.generator_version,
    selectionPolicy: 'shared-authored-axis-coverage-selection-v6',
    selectionCount: candidateReview.decision_counts.admit,
    importCountFromDecisions: true,
    noAdmissionQuota: true,
    reserveCount: 0,
    requireSingleSenseBoundaryReview: true,
    expressionLexicalUnitReviewContractVersion: M9_EXPRESSION_LEXICAL_UNIT_REVIEW_CONTRACT_VERSION,
  };
}

async function validateDeterministicBuild(admittedRecords, canonicalRevision) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-issue-221-determinism-'));
  try {
    const snapshots = [];
    let directlySearchable = 0;
    const { databasePaths, reusedSharedArtifact } = await prepareCurrentRevisionDatabases({
      canonicalRevision,
      temporaryDirectory,
      repositoryDirectory: ROOT,
    });
    for (const [databaseIndex, databasePath] of databasePaths.entries()) {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        snapshots.push(stripVolatileDatabaseMetadata(readLogicalDatabaseSnapshot(database)));
        if (databaseIndex === 0) {
          const query = database.prepare(EXACT_SEARCH_ROWS_SQL);
          for (const record of admittedRecords) {
            const ids = new Set(query.all(record.lemma, record.lemma).map(({ id }) => id));
            assert.equal(ids.has(record.id), true, `${record.id} must be reachable by exact direct search`);
            directlySearchable += 1;
          }
        }
      } finally {
        database.close();
      }
    }
    if (!reusedSharedArtifact) {
      assert.deepEqual(snapshots[0], snapshots[1], 'two SQLite builds must have identical logical contents');
    }
    return {
      logical_builds_compared: snapshots.length,
      ...(reusedSharedArtifact ? { independent_build_proof: 'deferred-to-deep' } : { deterministic_logical_contents: true }),
      admitted_lemmas_directly_searchable: directlySearchable,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function validateIssue221() {
  const [candidateReviewBytes, semanticSourceBytes, importBytes] = await Promise.all([
    readFile(CANDIDATE_REVIEW_PATH),
    readFile(SEMANTIC_SOURCE_PATH),
    readFile(CANONICAL_IMPORT_PATH),
  ]);
  const candidateReview = JSON.parse(candidateReviewBytes.toString('utf8'));
  const semanticSource = JSON.parse(semanticSourceBytes.toString('utf8'));
  assert.equal(candidateReview.schema_version, '1');
  assert.equal(candidateReview.contract_version, 'm9-corpus-candidate-review-v1');
  assert.equal(candidateReview.issue, 221);
  assert.equal(candidateReview.parent_issue, 218);
  assert.equal(candidateReview.authoring_mode, 'agent-authored-decision');
  assert.equal(candidateReview.human_reviewed, false);
  assert.equal(candidateReview.publication_state, 'local_reference_only_pending_owner_publication_confirmation');
  assert.equal(candidateReview.batch_id, BATCH_ID);
  assert.ok(Array.isArray(candidateReview.decisions));
  assert.equal(candidateReview.decisions.length, candidateReview.selection.selected_candidate_count);
  const validatedDispositionCounts = validateCorpusCandidateReviewDispositions(candidateReview.decisions, {
    label: 'Issue #221 corpus candidate review',
  });
  assert.deepEqual(validatedDispositionCounts, candidateReview.decision_counts);
  assertTextFreeArtifact(candidateReview, 'Issue #221 corpus candidate review');
  const reviewWithoutDigest = structuredClone(candidateReview);
  delete reviewWithoutDigest.artifact_sha256;
  assert.equal(candidateReview.artifact_sha256, sha256Json(reviewWithoutDigest));

  const referenceRoot = path.join(ROOT, 'data/reference');
  const referenceArtifactPath = (relativePath, label) => {
    const absolutePath = repositoryArtifactPath(relativePath, label);
    const relativeToReference = path.relative(referenceRoot, absolutePath);
    assert.ok(relativeToReference && !relativeToReference.startsWith(`..${path.sep}`)
      && relativeToReference !== '..' && !path.isAbsolute(relativeToReference), `${label} must stay under ignored data/reference`);
    return absolutePath;
  };
  const [candidateEvidenceBytes, candidateSelectionBytes] = await Promise.all([
    readFile(referenceArtifactPath(candidateReview.source_artifacts.candidate_evidence_path, 'candidate evidence')),
    readFile(referenceArtifactPath(candidateReview.source_artifacts.candidate_selection_path, 'candidate selection')),
  ]);
  const candidateEvidence = JSON.parse(candidateEvidenceBytes.toString('utf8'));
  const candidateSelection = JSON.parse(candidateSelectionBytes.toString('utf8'));
  assert.equal(sha256Bytes(candidateEvidenceBytes), candidateReview.source_artifacts.candidate_evidence_sha256);
  assert.equal(sha256Bytes(candidateSelectionBytes), candidateReview.source_artifacts.candidate_selection_sha256);
  assert.equal(candidateReview.source_artifacts.candidate_selection_sha256, candidateReview.selection.candidate_selection_sha256);
  assert.equal(candidateReview.source_artifacts.exclusion_manifest_sha256, candidateReview.selection.exclusion_sha256);
  assert.deepEqual(candidateReview.source_artifacts.exclusion_source_artifacts, candidateReview.selection.exclusion_source_artifacts);
  for (const field of [
    'contract_version',
    'candidate_limit',
    'selected_candidate_count',
    'ordering',
    'exclusion_sha256',
    'exclusion_source_artifacts',
  ]) {
    assert.deepEqual(candidateReview.selection[field], candidateSelection.selection[field], `selection.${field} is source-bound`);
  }
  assert.equal(candidateReview.yield.excluded_candidate_lemma_count, candidateSelection.selection.excluded_candidate_lemma_count);
  for (const field of Object.keys(candidateEvidence.yield)) {
    assert.deepEqual(candidateReview.yield[field], candidateEvidence.yield[field], `yield.${field} is source-bound`);
  }
  assertTextFreeArtifact(candidateEvidence, 'Issue #221 local corpus candidate evidence');
  assert.equal(candidateEvidence.publication_state, 'local_reference_only_pending_owner_publication_confirmation');
  assert.equal(candidateEvidence.permission_record_sha256, candidateReview.source.permission_record_sha256);
  assert.deepEqual(candidateEvidence.index, candidateReview.source.index);
  assert.deepEqual(candidateEvidence.typewriter_surface, candidateReview.source.typewriter_surface);
  const permissionBytes = await readFile(repositoryArtifactPath(candidateReview.source.permission_record_path, 'permission record'));
  assert.equal(sha256Bytes(permissionBytes), candidateReview.source.permission_record_sha256);
  for (const [label, relativePath, expectedDigest] of [
    ['extractor', 'scripts/reference/corpus_lemma_pilot.py', candidateReview.source.tools.extractor_script_sha256],
    ['orchestrator', 'scripts/reference/run-corpus-lemma-pilot.mjs', candidateReview.source.tools.orchestrator_script_sha256],
  ]) {
    assert.equal(sha256Bytes(await readFile(path.join(ROOT, relativePath))), expectedDigest, `${label} source digest`);
  }
  assert.equal(candidateEvidence.extractor.extractor_version, candidateReview.source.tools.extractor_version);
  assert.equal(candidateEvidence.extractor.python_version, candidateReview.source.tools.python_version);
  assert.equal(candidateEvidence.extractor.kiwipiepy_version, candidateReview.source.tools.kiwipiepy_version);
  assert.equal(candidateEvidence.extractor.kiwipiepy_model_version, candidateReview.source.tools.kiwipiepy_model_version);
  assert.equal(candidateEvidence.extractor.script_sha256, candidateReview.source.tools.extractor_script_sha256);
  assert.deepEqual(candidateEvidence.extractor.tag_to_typewriter_pos, { NNG: 'noun', VV: 'verb', VA: 'adjective' });
  assert.equal(candidateEvidence.extractor.predicate_lemma_rule, 'VV and VA morpheme forms receive the citation ending 다; NNG forms remain unchanged');
  assert.equal(candidateEvidence.orchestration.node_version, candidateReview.source.tools.node_version);
  assert.equal(candidateEvidence.orchestration.node_sqlite_version, candidateReview.source.tools.node_sqlite_version);
  assert.equal(candidateEvidence.orchestration.orchestrator_script_sha256, candidateReview.source.tools.orchestrator_script_sha256);
  assert.equal(candidateEvidence.orchestration.batch_id, BATCH_ID);
  assert.equal(candidateEvidence.orchestration.candidate_selection_sha256, candidateReview.selection.candidate_selection_sha256);
  assert.equal(candidateSelection.candidates.length, candidateReview.decisions.length);
  assert.equal(candidateEvidence.candidates.length, candidateReview.decisions.length);
  for (const [index, row] of candidateReview.decisions.entries()) {
    const selected = candidateSelection.candidates[index];
    const evidence = candidateEvidence.candidates.find(({ proposed_lemma: lemma, proposed_pos: pos }) => (
      lemma === row.morphology_proposal.lemma && pos === row.morphology_proposal.pos
    ));
    assert.ok(selected && evidence, `${row.inventory_id} must bind a local selected evidence row`);
    const selectedWithoutState = structuredClone(selected);
    delete selectedWithoutState.decision_state;
    const evidenceWithoutHits = structuredClone(evidence);
    delete evidenceWithoutHits.evidence;
    assert.deepEqual(selectedWithoutState, evidenceWithoutHits, `${row.inventory_id} selection matches text-free evidence`);
    const expectedExtractionState = row.morphology_proposal.ambiguity_status === 'single_observed_analysis_unverified'
      ? 'candidate'
      : 'held';
    assert.equal(selected.decision_state, expectedExtractionState, `${row.inventory_id} extractor ambiguity disposition`);
    assert.equal(row.morphology_proposal.lemma, selected.proposed_lemma);
    assert.equal(row.morphology_proposal.pos, selected.proposed_pos);
    assert.equal(row.morphology_proposal.analyzer_pos, selected.analyzer_pos);
    assert.equal(row.morphology_proposal.ambiguity_status, selected.ambiguity_status);
    assert.equal(row.morphology_proposal.analyzer_confidence, selected.analyzer_confidence);
    assert.equal(row.morphology_proposal.pos_interpretation_count_in_sample, selected.pos_interpretation_count_in_sample);
    assert.equal(row.morphology_proposal.ambiguous_observed_surface_count_in_sample, selected.ambiguous_observed_surface_count_in_sample);
    assert.equal(row.morphology_proposal.oov_morpheme_occurrences_in_sample, selected.oov_morpheme_occurrences_in_sample);
    assert.equal({ NNG: 'noun', VV: 'verb', VA: 'adjective' }[row.morphology_proposal.analyzer_pos], row.morphology_proposal.pos);
    if (['VV', 'VA'].includes(row.morphology_proposal.analyzer_pos)) {
      assert.equal(row.morphology_proposal.lemma.endsWith('다'), true, `${row.inventory_id} predicate proposal uses the reviewed citation form`);
    }
    assert.equal(row.coverage_status, selected.coverage_status);
    assert.deepEqual(row.typewriter_surface_matches, selected.typewriter_surface_matches);
    assert.deepEqual(row.observed_surface_forms, selected.observed_surface_forms);
    assert.deepEqual(row.observed_morpheme_spans, selected.observed_morpheme_spans);
    assert.equal(row.corpus_evidence.kiwi_morpheme_occurrences_in_sample, selected.kiwi_morpheme_occurrences_in_sample);
    assert.equal(row.corpus_evidence.paragraph_hits_in_sample, selected.paragraph_hits_in_sample);
    assert.equal(row.corpus_evidence.distinct_documents_in_sample, selected.distinct_documents_in_sample);
    assert.equal(row.corpus_evidence.distinct_sources_in_sample, selected.distinct_sources_in_sample);
    assert.equal(row.bounded_provenance.representative_hit_count, evidence.evidence.representative_hit_count);
    assert.equal(row.bounded_provenance.representative_hit_limit, evidence.evidence.representative_hits_limit);
    assert.deepEqual(row.bounded_provenance.representative_hits, evidence.evidence.representative_hits);
  }
  assert.equal(candidateReview.source.index.input_manifest_sha256, '50dd0c6c4ecb9250e75c11dde9e854e1b39de14e12d7a7087d2da041d75ef211');
  assert.equal(candidateReview.source.index.logical_rows_sha256, 'c3b2befa1480804bf6c005cb4a43eb7b2e82d6ad7d77790af4dc82b76f4bd1dd');
  assert.equal(candidateReview.source.source_text_committed, false);
  assert.equal(candidateReview.source.tools.kiwipiepy_version, '0.24.0');
  for (const artifact of candidateReview.selection.exclusion_source_artifacts) {
    const absolutePath = repositoryArtifactPath(artifact.path, 'exclusion source');
    assert.equal(sha256Bytes(await readFile(absolutePath)), artifact.sha256, `${artifact.path} exclusion-source digest`);
  }
  assert.equal(candidateReview.selection.candidate_selection_sha256, candidateEvidence.orchestration.candidate_selection_sha256);
  assert.equal(candidateReview.selection.exclusion_sha256, candidateReview.source_artifacts.exclusion_manifest_sha256);

  const ordinals = new Set();
  const inventoryIds = new Set();
  for (const row of candidateReview.decisions) {
    assert.ok(Number.isInteger(row.candidate_ordinal) && row.candidate_ordinal > 0);
    assert.equal(ordinals.has(row.candidate_ordinal), false, 'candidate ordinals are unique');
    ordinals.add(row.candidate_ordinal);
    assert.equal(inventoryIds.has(row.inventory_id), false, 'inventory identities are unique');
    inventoryIds.add(row.inventory_id);
    assert.equal(row.corpus_evidence.coverage_status, row.coverage_status);
    assert.ok(row.morphology_proposal.lemma);
    assert.ok(row.morphology_proposal.pos);
    assert.ok(Array.isArray(row.observed_surface_forms) && row.observed_surface_forms.length > 0);
    assert.ok(Array.isArray(row.observed_morpheme_spans) && row.observed_morpheme_spans.length > 0);
    assert.ok(row.bounded_provenance.representative_hits.length <= 3);
    assert.equal(row.bounded_provenance.representative_hits.length, row.bounded_provenance.representative_hit_count);
    if (row.editorial_judgment.disposition === 'admit') {
      assert.equal(row.coverage_status, 'uncovered', `${row.inventory_id} must have no canonical or surface collision`);
      assert.equal(row.morphology_proposal.ambiguity_status, 'single_observed_analysis_unverified', `${row.inventory_id} morphology must be unambiguous in the sample`);
      assert.ok(row.editorial_judgment.candidate_record_id);
      assert.ok(row.editorial_judgment.writer_gloss);
    } else {
      assert.equal(row.editorial_judgment.candidate_record_id, null);
    }
  }
  const candidateDecisionCounts = Object.fromEntries(['admit', 'hold', 'reject'].map((disposition) => [
    disposition,
    candidateReview.decisions.filter(({ editorial_judgment: judgment }) => judgment.disposition === disposition).length,
  ]));
  assert.deepEqual(candidateReview.decision_counts, candidateDecisionCounts);
  assert.deepEqual([...ordinals].sort((a, b) => a - b), Array.from({ length: ordinals.size }, (_, index) => index + 1));

  const admittedRows = candidateReview.decisions.filter(({ editorial_judgment: judgment }) => judgment.disposition === 'admit');
  assert.ok(admittedRows.length > 0, 'the bounded corpus batch must include an admitted pilot candidate');
  const identities = admittedRows.map((row, index) => ({
    catalog_index: index,
    slot_id: `${BATCH_ID}-slot-${String(index + 1).padStart(4, '0')}`,
    inventory_id: row.inventory_id,
    candidate_record_id: row.editorial_judgment.candidate_record_id,
    lemma: row.morphology_proposal.lemma,
    axis: row.editorial_judgment.writer_use_axis,
    record_type: 'entry',
    pos: row.morphology_proposal.pos,
  }));
  assert.equal(semanticSource.batch_id, BATCH_ID);
  assert.equal(semanticSource.issue, 221);
  assert.equal(semanticSource.parent_issue, 218);
  assert.equal(semanticSource.source_basis.candidate_review_sha256, sha256Bytes(candidateReviewBytes));
  assert.equal(semanticSource.source_basis.candidate_selection_sha256, candidateReview.selection.candidate_selection_sha256);
  const config = semanticDecisionConfig(candidateReview, semanticSource);
  const semanticDecisionSource = validateAuthoredSemanticDecisionSource({
    source: semanticSource,
    sourceBytes: semanticSourceBytes,
    identities,
    candidateRecords: semanticSource.candidate_records,
    config,
  });
  const includedIds = new Set(semanticDecisionSource.selection.selected.map(({ candidate_record_id: id }) => id));
  const expectedImportRecords = semanticSource.candidate_records.filter(({ id }) => includedIds.has(id));
  // Batch admissions are validated against the canonical as of their own time: later factory admissions
  // may append senses to their records, so the live canonical is rewound through the bound ledger.
  const liveCanonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const currentCanonical = { ...liveCanonical, records: await loadCanonicalBeforeFactoryAdmissions(liveCanonical.records) };
  const importRecords = await restoreImportRecordsBeforeFactoryAdmissions(readJsonl(importBytes, 'Issue #221 canonical import'), liveCanonical.records);
  assert.deepEqual(importRecords, expectedImportRecords, 'canonical import contains only source-bound admitted candidates');
  assert.equal(importRecords.length, admittedRows.length);

  const importIds = new Set(importRecords.map(({ id }) => id));
  assert.equal(importIds.size, importRecords.length, 'canonical import record IDs are unique');
  for (const record of importRecords) {
    const stored = currentCanonical.records.find((recordInfo) => recordOf(recordInfo).id === record.id);
    assert.ok(stored, `${record.id} is present in complete canonical data`);
    assert.deepEqual(recordOf(stored), record, `${record.id} exactly matches its admitted source-bound record`);
  }
  const baseRecords = currentCanonical.records.filter((recordInfo) => !importIds.has(recordOf(recordInfo).id));
  assert.equal(baseRecords.length + importRecords.length, currentCanonical.records.length);

  const rootDecisionSource = projectDecisionSourceToCanonical(await readSemanticDecisionSourceArtifact(ROOT_SEMANTIC_SOURCE_PATH), currentCanonical.records);
  const currentDigest = canonicalRecordsSha256(currentCanonical.records);
  assert.equal(rootDecisionSource.source.canonical_records_sha256, currentDigest, 'complete canonical semantic source digest');
  const batchDecisionSources = await readAuthoredBatchDecisionSources();
  const semanticAudit = buildSemanticAuditFromDecisionSource(currentCanonical.records, rootDecisionSource, {
    artifactId: 'issue-221-complete-canonical-semantic-audit',
    baseRecords,
    batchDecisionSources,
  });
  const reviewRows = productionReviewRows(identities, semanticSource.candidate_records, semanticDecisionSource, {
    semanticReviewSourcePath: 'data/batches/issue-221-corpus-semantic-decisions.json',
    verificationPassId: semanticSource.provenance.verification_pass_id,
  });
  const production = validateLexicalProduction({
    batchId: BATCH_ID,
    candidateRecords: semanticSource.candidate_records,
    reviews: reviewRows,
    baseRecords,
    prospectiveRecords: currentCanonical.records,
    semanticAudit,
    stageEvidence: productionStageEvidence({
      candidateSourceBytes: candidateReviewBytes,
      semanticSourceBytes,
      prospectiveRecords: currentCanonical.records,
      semanticAudit,
      issue: 221,
      batchId: BATCH_ID,
      generationPassId: candidateReview.provenance.generation_pass_id,
      verificationPassId: semanticSource.provenance.verification_pass_id,
      candidateSourcePath: 'data/batches/issue-221-corpus-candidate-review.json',
      semanticSourcePath: 'data/batches/issue-221-corpus-semantic-decisions.json',
    }),
    catalogCount: semanticSource.candidate_records.length,
    expectedSelectedCount: importRecords.length,
    candidateLabel: 'Issue #221 bounded corpus-backed lexical candidates',
    reviewedLabel: 'Issue #221 source-bound semantic decisions',
    prospectiveLabel: 'Issue #221 complete prospective canonical records',
  });
  assert.equal(production.admission?.audit?.blocking_finding_count, 0, 'ordinary shared lexical admission blockers');
  assert.equal(production.admission?.semantic_audit?.coverage_complete, true, 'complete prospective semantic coverage');

  const deterministicBuild = await validateDeterministicBuild(importRecords, currentCanonical.canonicalRevision);
  return {
    issue: 221,
    candidate_count: candidateReview.decisions.length,
    admitted_count: importRecords.length,
    held_count: candidateReview.decisions.filter(({ editorial_judgment: judgment }) => judgment.disposition === 'hold').length,
    rejected_count: candidateReview.decisions.filter(({ editorial_judgment: judgment }) => judgment.disposition === 'reject').length,
    corpus_paragraph_text_committed: false,
    shared_admission_blocking_findings: production.admission.audit.blocking_finding_count,
    semantic_coverage_complete: production.admission.semantic_audit.coverage_complete,
    ...deterministicBuild,
  };
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  validateIssue221()
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}
