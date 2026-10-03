import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../build/dictionary.mjs';
import { assertCompleteRevisionChecksReused, createSharedAdmissionContext } from './shared-admission-context.mjs';
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
} from './validate-issue-211.mjs';
import { EXACT_SEARCH_ROWS_SQL } from '../../src/runtime/sqlite-query.js';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');
const BATCH_ID = 'issue-222-m9-d-corpus-batch-01-20260930';
const CANDIDATE_REVIEW_PATH = path.join(ROOT, 'data/batches/issue-222-m9-d-corpus-batch-01-candidate-review.json');
const SEMANTIC_SOURCE_PATH = path.join(ROOT, 'data/batches/issue-222-m9-d-corpus-batch-01-semantic-decisions.json');
const CANONICAL_IMPORT_PATH = path.join(ROOT, 'data/canonical/issue-222-m9-d-corpus-batch-01.jsonl');
const HISTORICAL_CANDIDATE_SOURCE_PATH = path.join(ROOT, 'data/batches/issue-222-m9-d-historical-candidate-source.json');
const HISTORICAL_SEMANTIC_SOURCE_PATH = path.join(ROOT, 'data/batches/issue-222-m9-d-historical-semantic-decisions.json');
const HISTORICAL_CANONICAL_IMPORT_PATH = path.join(ROOT, 'data/canonical/issue-222-m9-d-historical-batch-01.jsonl');
const HISTORICAL_BASE_INVENTORY_PATH = path.join(ROOT, 'data/batches/issue-222-m9-d-historical-base-recovery-inventory.json');
const HISTORICAL_BASE_SEED_PATH = path.join(ROOT, 'data/batches/issue-222-m9-d-historical-base-m5-target-seed.json');
const M5_TARGET_SEED_PATH = path.join(ROOT, 'data/inventory/m5-target-seed.json');
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

function semanticDecisionConfig(candidateReview, semanticSource, {
  sourcePath = 'data/batches/issue-222-m9-d-corpus-batch-01-semantic-decisions.json',
  correctionPassId = 'issue-222-m9-d-corpus-batch-01-agent-correction-20260930-r1',
} = {}) {
  return {
    label: 'Issue #222',
    errorPrefix: 'ISSUE_222',
    sourcePath,
    sourceId: semanticSource.source_id,
    candidateSourceId: candidateReview.source_id,
    batchId: semanticSource.batch_id,
    issue: 222,
    parentIssue: 218,
    generationPassId: candidateReview.provenance.generation_pass_id,
    verificationPassId: semanticSource.provenance.verification_pass_id,
    correctionPassId,
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

function historicalSemanticDecisionConfig(candidateSource, semanticSource) {
  return {
    label: 'Issue #222 M9-D historical batch 01',
    errorPrefix: 'ISSUE_222',
    sourcePath: 'data/batches/issue-222-m9-d-historical-semantic-decisions.json',
    sourceId: semanticSource.source_id,
    candidateSourceId: candidateSource.source_id,
    batchId: semanticSource.batch_id,
    issue: 222,
    parentIssue: 218,
    generationPassId: semanticSource.provenance.generation_pass_id,
    verificationPassId: semanticSource.provenance.verification_pass_id,
    correctionPassId: 'issue-222-m9-d-historical-agent-correction-20260930-r1',
    semanticReviewVersion: semanticSource.provenance.generator_version,
    selectionPolicy: 'shared-authored-axis-coverage-selection-v6',
    selectionCount: candidateSource.candidate_source_identities.length,
    importCountFromDecisions: true,
    noAdmissionQuota: true,
    reserveCount: 0,
    requireSingleSenseBoundaryReview: true,
    expressionLexicalUnitReviewContractVersion: M9_EXPRESSION_LEXICAL_UNIT_REVIEW_CONTRACT_VERSION,
  };
}

function sourceDigestExistsInGitHistory(relativePath, expectedDigest) {
  let commits;
  try {
    commits = execFileSync('git', ['rev-list', '--all', '--', relativePath], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split(/\s+/u).filter(Boolean);
  } catch {
    return false;
  }
  return commits.some((commit) => {
    try {
      const bytes = execFileSync('git', ['show', `${commit}:${relativePath}`], {
        cwd: ROOT,
        maxBuffer: 2 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return sha256Bytes(bytes) === expectedDigest;
    } catch {
      return false;
    }
  });
}

async function assertPinnedSourceDigest(relativePath, expectedDigest, label) {
  const currentDigest = sha256Bytes(await readFile(path.join(ROOT, relativePath)));
  assert.ok(
    currentDigest === expectedDigest || sourceDigestExistsInGitHistory(relativePath, expectedDigest),
    `${label} source digest must match the current source or a source version retained in Git history`,
  );
}

async function validateAdditionalCorpusBatches(currentCanonical, { verifyLocalCorpusEvidence = true } = {}) {
  const batchDirectory = path.join(ROOT, 'data/batches');
  const candidateReviewNames = (await readdir(batchDirectory))
    .filter((name) => /^issue-222-m9-d-corpus-batch-\d+-candidate-review\.json$/u.test(name))
    .filter((name) => name !== 'issue-222-m9-d-corpus-batch-01-candidate-review.json')
    .sort((left, right) => left.localeCompare(right, 'en'));
  const referenceRoot = path.join(ROOT, 'data/reference');
  const referenceArtifactPath = (relativePath, label) => {
    const absolutePath = repositoryArtifactPath(relativePath, label);
    const relativeToReference = path.relative(referenceRoot, absolutePath);
    assert.ok(relativeToReference && !relativeToReference.startsWith(`..${path.sep}`)
      && relativeToReference !== '..' && !path.isAbsolute(relativeToReference), `${label} must stay under ignored data/reference`);
    return absolutePath;
  };
  const batches = [];

  for (const candidateReviewName of candidateReviewNames) {
    const batchStem = candidateReviewName.replace(/-candidate-review\.json$/u, '');
    const candidateReviewPath = path.join(batchDirectory, candidateReviewName);
    const semanticSourcePath = path.join(batchDirectory, `${batchStem}-semantic-decisions.json`);
    const canonicalImportPath = path.join(ROOT, 'data/canonical', `${batchStem}.jsonl`);
    const [candidateReviewBytes, semanticSourceBytes, importBytes] = await Promise.all([
      readFile(candidateReviewPath),
      readFile(semanticSourcePath),
      readFile(canonicalImportPath),
    ]);
    const candidateReview = JSON.parse(candidateReviewBytes.toString('utf8'));
    const semanticSource = JSON.parse(semanticSourceBytes.toString('utf8'));
    const candidateLabel = `Issue #222 ${candidateReview.batch_id}`;
    assert.equal(candidateReview.schema_version, '1');
    assert.equal(candidateReview.contract_version, 'm9-corpus-candidate-review-v1');
    assert.equal(candidateReview.issue, 222);
    assert.equal(candidateReview.parent_issue, 218);
    assert.equal(candidateReview.authoring_mode, 'agent-authored-decision');
    assert.equal(candidateReview.human_reviewed, false);
    assert.equal(candidateReview.publication_state, 'local_reference_only_pending_owner_publication_confirmation');
    assert.ok(candidateReview.batch_id.startsWith(`${batchStem}-`), `${candidateLabel} ID must match its artifact path`);
    assert.ok(candidateReview.selection.candidate_limit >= 1 && candidateReview.selection.candidate_limit <= 500);
    assert.equal(candidateReview.decisions.length, candidateReview.selection.selected_candidate_count);
    const dispositionCounts = validateCorpusCandidateReviewDispositions(candidateReview.decisions, {
      label: `${candidateLabel} candidate review`,
    });
    assert.deepEqual(dispositionCounts, candidateReview.decision_counts);
    assertTextFreeArtifact(candidateReview, `${candidateLabel} candidate review`);
    const reviewWithoutDigest = structuredClone(candidateReview);
    delete reviewWithoutDigest.artifact_sha256;
    assert.equal(candidateReview.artifact_sha256, sha256Json(reviewWithoutDigest));
    assert.equal(candidateReview.source_artifacts.candidate_selection_sha256, candidateReview.selection.candidate_selection_sha256);
    assert.equal(candidateReview.source_artifacts.exclusion_manifest_sha256, candidateReview.selection.exclusion_sha256);
    assert.deepEqual(candidateReview.source_artifacts.exclusion_source_artifacts, candidateReview.selection.exclusion_source_artifacts);

    if (verifyLocalCorpusEvidence) {
      const candidateEvidencePath = referenceArtifactPath(candidateReview.source_artifacts.candidate_evidence_path, 'candidate evidence');
      const candidateSelectionPath = referenceArtifactPath(candidateReview.source_artifacts.candidate_selection_path, 'candidate selection');
      const [candidateEvidenceBytes, candidateSelectionBytes] = await Promise.all([
        readFile(candidateEvidencePath),
        readFile(candidateSelectionPath),
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
        assert.deepEqual(candidateReview.selection[field], candidateSelection.selection[field], `${candidateLabel} selection.${field} is source-bound`);
      }
      assert.equal(candidateReview.yield.excluded_candidate_lemma_count, candidateSelection.selection.excluded_candidate_lemma_count);
      for (const field of Object.keys(candidateEvidence.yield)) {
        assert.deepEqual(candidateReview.yield[field], candidateEvidence.yield[field], `${candidateLabel} yield.${field} is source-bound`);
      }
      assertTextFreeArtifact(candidateEvidence, `${candidateLabel} local corpus candidate evidence`);
      assertTextFreeArtifact(candidateSelection, `${candidateLabel} local corpus candidate selection`);
      assert.equal(candidateEvidence.publication_state, candidateReview.publication_state);
      assert.equal(candidateEvidence.permission_record_sha256, candidateReview.source.permission_record_sha256);
      assert.deepEqual(candidateEvidence.index, candidateReview.source.index);
      assert.deepEqual(candidateEvidence.typewriter_surface, candidateReview.source.typewriter_surface);
      const permissionBytes = await readFile(repositoryArtifactPath(candidateReview.source.permission_record_path, 'permission record'));
      assert.equal(sha256Bytes(permissionBytes), candidateReview.source.permission_record_sha256);
      for (const [label, relativePath, expectedDigest] of [
        ['extractor', 'scripts/reference/corpus_lemma_pilot.py', candidateReview.source.tools.extractor_script_sha256],
        ['orchestrator', 'scripts/reference/run-corpus-lemma-pilot.mjs', candidateReview.source.tools.orchestrator_script_sha256],
      ]) {
        await assertPinnedSourceDigest(relativePath, expectedDigest, `${candidateLabel} ${label}`);
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
      assert.equal(candidateEvidence.orchestration.batch_id, candidateReview.batch_id);
      assert.equal(candidateEvidence.orchestration.candidate_selection_sha256, candidateReview.selection.candidate_selection_sha256);
      assert.equal(candidateSelection.candidates.length, candidateReview.decisions.length);
      assert.equal(candidateEvidence.candidates.length, candidateReview.decisions.length);

      for (const [index, row] of candidateReview.decisions.entries()) {
        const selected = candidateSelection.candidates[index];
        const evidence = candidateEvidence.candidates.find(({ proposed_lemma: lemma, proposed_pos: pos }) => (
          lemma === row.morphology_proposal.lemma && pos === selected?.proposed_pos
        ));
        assert.ok(selected && evidence, `${candidateLabel} ${row.inventory_id} must bind a local selected evidence row`);
        const selectedWithoutState = structuredClone(selected);
        delete selectedWithoutState.decision_state;
        const evidenceWithoutHits = structuredClone(evidence);
        delete evidenceWithoutHits.evidence;
        assert.deepEqual(selectedWithoutState, evidenceWithoutHits, `${candidateLabel} ${row.inventory_id} selection matches text-free evidence`);
        const morphologyHeld = row.morphology_proposal.ambiguity_status !== 'single_observed_analysis_unverified'
          || row.morphology_proposal.pos_interpretation_count_in_sample > 1
          || row.morphology_proposal.ambiguous_observed_surface_count_in_sample > 0
          || row.morphology_proposal.oov_morpheme_occurrences_in_sample > 0;
        const coverageHeld = [
          'search_form_collision',
          'generated_surface_collision',
          'search_and_generated_surface_collision',
        ].includes(row.coverage_status) && row.typewriter_surface_matches.length > 0;
        const expectedExtractionState = morphologyHeld || coverageHeld ? 'held' : 'candidate';
        assert.equal(selected.decision_state, expectedExtractionState, `${candidateLabel} ${row.inventory_id} extractor ambiguity disposition`);
        assert.equal(row.morphology_proposal.lemma, selected.proposed_lemma);
        const analyzerMappedPos = { NNG: 'noun', VV: 'verb', VA: 'adjective' }[selected.analyzer_pos];
        if (row.morphology_proposal.pos === selected.proposed_pos) {
          assert.equal(row.editorial_judgment.pos_correction, undefined, `${candidateLabel} ${row.inventory_id} has no unsupported POS correction`);
          assert.equal(analyzerMappedPos, row.morphology_proposal.pos);
        } else {
          const correction = row.editorial_judgment.pos_correction;
          assert.equal(row.editorial_judgment.disposition, 'admit');
          assert.equal(correction.evidence_type, 'reviewed-bounded-contexts-support-corrected-pos');
          assert.equal(correction.analyzer_pos, selected.analyzer_pos);
          assert.equal(correction.analyzer_mapped_pos, selected.proposed_pos);
          assert.equal(correction.corrected_pos, row.morphology_proposal.pos);
          assert.ok(correction.paragraph_ids.length > 0);
          const availableParagraphIds = new Set(row.bounded_provenance.representative_hits.map(({ paragraph_id }) => paragraph_id));
          assert.ok(correction.paragraph_ids.every((id) => availableParagraphIds.has(id)));
        }
        assert.equal(row.morphology_proposal.analyzer_pos, selected.analyzer_pos);
        assert.equal(row.morphology_proposal.ambiguity_status, selected.ambiguity_status);
        assert.equal(row.morphology_proposal.analyzer_confidence, selected.analyzer_confidence);
        assert.equal(row.morphology_proposal.pos_interpretation_count_in_sample, selected.pos_interpretation_count_in_sample);
        assert.equal(row.morphology_proposal.ambiguous_observed_surface_count_in_sample, selected.ambiguous_observed_surface_count_in_sample);
        assert.equal(row.morphology_proposal.oov_morpheme_occurrences_in_sample, selected.oov_morpheme_occurrences_in_sample);
        if (['VV', 'VA'].includes(row.morphology_proposal.analyzer_pos)) {
          assert.equal(row.morphology_proposal.lemma.endsWith('다'), true, `${candidateLabel} ${row.inventory_id} predicate proposal uses its citation form`);
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
        if (row.editorial_judgment.disposition === 'admit') {
          assert.equal(row.coverage_status, 'uncovered');
          assert.equal(row.morphology_proposal.ambiguity_status, 'single_observed_analysis_unverified');
          assert.ok(row.editorial_judgment.candidate_record_id);
          assert.ok(row.editorial_judgment.writer_gloss);
        } else {
          assert.equal(row.editorial_judgment.candidate_record_id, null);
        }
      }

    }
    for (const artifact of candidateReview.selection.exclusion_source_artifacts) {
      await assertPinnedSourceDigest(
        artifact.path,
        artifact.sha256,
        `${candidateLabel} ${artifact.path} exclusion-source digest`,
      );
    }
    const admittedRows = candidateReview.decisions.filter(({ editorial_judgment: judgment }) => judgment.disposition === 'admit');
    const identities = admittedRows.map((row, index) => ({
      catalog_index: index,
      slot_id: `${candidateReview.batch_id}-slot-${String(index + 1).padStart(4, '0')}`,
      inventory_id: row.inventory_id,
      candidate_record_id: row.editorial_judgment.candidate_record_id,
      lemma: row.morphology_proposal.lemma,
      axis: row.editorial_judgment.writer_use_axis,
      record_type: 'entry',
      pos: row.morphology_proposal.pos,
    }));
    assert.equal(semanticSource.batch_id, candidateReview.batch_id);
    assert.equal(semanticSource.issue, 222);
    assert.equal(semanticSource.parent_issue, 218);
    assert.equal(semanticSource.source_basis.candidate_review_sha256, sha256Bytes(candidateReviewBytes));
    assert.equal(semanticSource.source_basis.candidate_selection_sha256, candidateReview.selection.candidate_selection_sha256);
    assert.equal(semanticSource.source_basis.candidate_evidence_sha256, candidateReview.source_artifacts.candidate_evidence_sha256);
    assert.equal(semanticSource.source_basis.exclusion_manifest_sha256, candidateReview.source_artifacts.exclusion_manifest_sha256);
    const correctionPassId = semanticSource.review.correction_passes[0]?.review_pass_id ?? 'no-correction-pass';
    const config = semanticDecisionConfig(candidateReview, semanticSource, {
      sourcePath: `data/batches/${path.basename(semanticSourcePath)}`,
      correctionPassId,
    });
    const semanticDecisionSource = validateAuthoredSemanticDecisionSource({
      source: semanticSource,
      sourceBytes: semanticSourceBytes,
      identities,
      candidateRecords: semanticSource.candidate_records,
      config,
    });
    assert.equal(semanticSource.candidate_records_sha256, sha256Json(semanticSource.candidate_records));
    const includedIds = new Set(semanticDecisionSource.selection.selected.map(({ candidate_record_id: id }) => id));
    const expectedImportRecords = semanticSource.candidate_records.filter(({ id }) => includedIds.has(id));
    const importRecords = readJsonl(importBytes, `${candidateLabel} canonical import`);
    assert.deepEqual(importRecords, expectedImportRecords, `${candidateLabel} canonical import contains only source-bound admissions`);
    assert.equal(importRecords.length, admittedRows.length);
    for (const record of importRecords) {
      const stored = currentCanonical.records.find((recordInfo) => recordOf(recordInfo).id === record.id);
      assert.ok(stored, `${candidateLabel} ${record.id} is present in complete canonical data`);
      assert.deepEqual(recordOf(stored), record, `${candidateLabel} ${record.id} exactly matches its reviewed record`);
    }
    batches.push({
      batch_id: candidateReview.batch_id,
      candidateReview,
      candidateReviewBytes,
      semanticSource,
      semanticSourceBytes,
      semanticDecisionSource,
      identities,
      importRecords,
      candidateCount: candidateReview.decisions.length,
      admittedCount: importRecords.length,
      heldCount: dispositionCounts.hold,
      rejectedCount: dispositionCounts.reject,
      sourcePath: `data/batches/${candidateReviewName}`,
      semanticPath: `data/batches/${path.basename(semanticSourcePath)}`,
    });
  }

  return batches;
}

async function validateDeterministicBuild(admittedRecords) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-issue-222-determinism-'));
  try {
    const snapshots = [];
    let directlySearchable = 0;
    for (const name of ['first', 'second']) {
      const outputPath = path.join(temporaryDirectory, `${name}.sqlite`);
      await buildDictionary({
        inputDirectory: DEFAULT_CANONICAL_DIRECTORY,
        outputPath,
        allowDirty: true,
        repositoryDirectory: ROOT,
      });
      const database = new DatabaseSync(outputPath, { readOnly: true });
      try {
        snapshots.push(stripVolatileDatabaseMetadata(readLogicalDatabaseSnapshot(database)));
        if (name === 'first') {
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
    assert.deepEqual(snapshots[0], snapshots[1], 'two SQLite builds must have identical logical contents');
    return {
      logical_builds_compared: 2,
      deterministic_logical_contents: true,
      admitted_lemmas_directly_searchable: directlySearchable,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function validateIssue222({ verifyLocalCorpusEvidence = true } = {}) {
  const [candidateReviewBytes, semanticSourceBytes, importBytes,
    historicalCandidateSourceBytes, historicalSemanticSourceBytes, historicalImportBytes,
    historicalBaseInventoryBytes, historicalBaseSeedBytes, seedBytes] = await Promise.all([
    readFile(CANDIDATE_REVIEW_PATH),
    readFile(SEMANTIC_SOURCE_PATH),
    readFile(CANONICAL_IMPORT_PATH),
    readFile(HISTORICAL_CANDIDATE_SOURCE_PATH),
    readFile(HISTORICAL_SEMANTIC_SOURCE_PATH),
    readFile(HISTORICAL_CANONICAL_IMPORT_PATH),
    readFile(HISTORICAL_BASE_INVENTORY_PATH),
    readFile(HISTORICAL_BASE_SEED_PATH),
    readFile(M5_TARGET_SEED_PATH),
  ]);
  const candidateReview = JSON.parse(candidateReviewBytes.toString('utf8'));
  const semanticSource = JSON.parse(semanticSourceBytes.toString('utf8'));
  assert.equal(candidateReview.schema_version, '1');
  assert.equal(candidateReview.contract_version, 'm9-corpus-candidate-review-v1');
  assert.equal(candidateReview.issue, 222);
  assert.equal(candidateReview.parent_issue, 218);
  assert.equal(candidateReview.authoring_mode, 'agent-authored-decision');
  assert.equal(candidateReview.human_reviewed, false);
  assert.equal(candidateReview.publication_state, 'local_reference_only_pending_owner_publication_confirmation');
  assert.equal(candidateReview.batch_id, BATCH_ID);
  assert.ok(Array.isArray(candidateReview.decisions));
  assert.equal(candidateReview.decisions.length, candidateReview.selection.selected_candidate_count);
  const validatedDispositionCounts = validateCorpusCandidateReviewDispositions(candidateReview.decisions, {
    label: 'Issue #222 corpus candidate review',
  });
  assert.deepEqual(validatedDispositionCounts, candidateReview.decision_counts);
  assertTextFreeArtifact(candidateReview, 'Issue #222 corpus candidate review');
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
  assert.equal(candidateReview.source_artifacts.candidate_selection_sha256, candidateReview.selection.candidate_selection_sha256);
  assert.equal(candidateReview.source_artifacts.exclusion_manifest_sha256, candidateReview.selection.exclusion_sha256);
  assert.deepEqual(candidateReview.source_artifacts.exclusion_source_artifacts, candidateReview.selection.exclusion_source_artifacts);
  if (verifyLocalCorpusEvidence) {
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
    assertTextFreeArtifact(candidateEvidence, 'Issue #222 local corpus candidate evidence');
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
      await assertPinnedSourceDigest(relativePath, expectedDigest, `Issue #222 batch 01 ${label}`);
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
        lemma === row.morphology_proposal.lemma && pos === selected?.proposed_pos
      ));
      assert.ok(selected && evidence, `${row.inventory_id} must bind a local selected evidence row`);
      const selectedWithoutState = structuredClone(selected);
      delete selectedWithoutState.decision_state;
      const evidenceWithoutHits = structuredClone(evidence);
      delete evidenceWithoutHits.evidence;
      assert.deepEqual(selectedWithoutState, evidenceWithoutHits, `${row.inventory_id} selection matches text-free evidence`);
      const morphologyHeld = row.morphology_proposal.ambiguity_status !== 'single_observed_analysis_unverified'
        || row.morphology_proposal.pos_interpretation_count_in_sample > 1
        || row.morphology_proposal.ambiguous_observed_surface_count_in_sample > 0
        || row.morphology_proposal.oov_morpheme_occurrences_in_sample > 0;
      const coverageHeld = [
        'search_form_collision',
        'generated_surface_collision',
        'search_and_generated_surface_collision',
      ].includes(row.coverage_status) && row.typewriter_surface_matches.length > 0;
      const expectedExtractionState = morphologyHeld || coverageHeld ? 'held' : 'candidate';
      assert.equal(selected.decision_state, expectedExtractionState, `${row.inventory_id} extractor ambiguity disposition`);
      assert.equal(row.morphology_proposal.lemma, selected.proposed_lemma);
      const analyzerMappedPos = { NNG: 'noun', VV: 'verb', VA: 'adjective' }[selected.analyzer_pos];
      if (row.morphology_proposal.pos === selected.proposed_pos) {
        assert.equal(row.editorial_judgment.pos_correction, undefined, `${row.inventory_id} has no unsupported POS correction`);
        assert.equal(analyzerMappedPos, row.morphology_proposal.pos);
      } else {
        const correction = row.editorial_judgment.pos_correction;
        assert.equal(row.editorial_judgment.disposition, 'admit', `${row.inventory_id} POS correction is used only after a complete review`);
        assert.equal(correction.evidence_type, 'reviewed-bounded-contexts-support-corrected-pos');
        assert.equal(correction.analyzer_pos, selected.analyzer_pos);
        assert.equal(correction.analyzer_mapped_pos, selected.proposed_pos);
        assert.equal(correction.corrected_pos, row.morphology_proposal.pos);
        assert.ok(correction.paragraph_ids.length > 0);
        const availableParagraphIds = new Set(row.bounded_provenance.representative_hits.map(({ paragraph_id }) => paragraph_id));
        assert.ok(correction.paragraph_ids.every((id) => availableParagraphIds.has(id)));
      }
      assert.equal(row.morphology_proposal.analyzer_pos, selected.analyzer_pos);
      assert.equal(row.morphology_proposal.ambiguity_status, selected.ambiguity_status);
      assert.equal(row.morphology_proposal.analyzer_confidence, selected.analyzer_confidence);
      assert.equal(row.morphology_proposal.pos_interpretation_count_in_sample, selected.pos_interpretation_count_in_sample);
      assert.equal(row.morphology_proposal.ambiguous_observed_surface_count_in_sample, selected.ambiguous_observed_surface_count_in_sample);
      assert.equal(row.morphology_proposal.oov_morpheme_occurrences_in_sample, selected.oov_morpheme_occurrences_in_sample);
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
  }
  assert.equal(candidateReview.source.index.input_manifest_sha256, '50dd0c6c4ecb9250e75c11dde9e854e1b39de14e12d7a7087d2da041d75ef211');
  assert.equal(candidateReview.source.index.logical_rows_sha256, 'c3b2befa1480804bf6c005cb4a43eb7b2e82d6ad7d77790af4dc82b76f4bd1dd');
  assert.equal(candidateReview.source.source_text_committed, false);
  assert.equal(candidateReview.source.tools.kiwipiepy_version, '0.24.0');
  for (const artifact of candidateReview.selection.exclusion_source_artifacts) {
    const absolutePath = repositoryArtifactPath(artifact.path, 'exclusion source');
    assert.equal(sha256Bytes(await readFile(absolutePath)), artifact.sha256, `${artifact.path} exclusion-source digest`);
  }
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
  assert.equal(semanticSource.issue, 222);
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
  const importRecords = readJsonl(importBytes, 'Issue #222 canonical import');
  assert.deepEqual(importRecords, expectedImportRecords, 'canonical import contains only source-bound admitted candidates');
  assert.equal(importRecords.length, admittedRows.length);

  const historicalCandidateSource = JSON.parse(historicalCandidateSourceBytes.toString('utf8'));
  const historicalSemanticSource = JSON.parse(historicalSemanticSourceBytes.toString('utf8'));
  const historicalBaseInventory = JSON.parse(historicalBaseInventoryBytes.toString('utf8'));
  const seed = JSON.parse(seedBytes.toString('utf8'));
  const historicalBaseSeed = JSON.parse(historicalBaseSeedBytes.toString('utf8'));
  assert.equal(historicalCandidateSource.contract_version, 'm9-d-historical-candidate-source-v1');
  assert.equal(historicalCandidateSource.kind, 'bounded-historical-candidate-source');
  assert.equal(historicalCandidateSource.issue, 222);
  assert.equal(historicalCandidateSource.parent_issue, 218);
  assert.equal(historicalCandidateSource.human_reviewed, false);
  assert.equal(historicalCandidateSource.source_class, 'historical-recovery-inventory');
  assert.equal(historicalCandidateSource.selection.candidate_limit, 20, 'historical batch remains within the bounded review limit');
  assert.equal(historicalCandidateSource.selection.selected_candidate_count, 20);
  const candidateSourceWithoutDigest = structuredClone(historicalCandidateSource);
  delete candidateSourceWithoutDigest.artifact_sha256;
  assert.equal(historicalCandidateSource.artifact_sha256, sha256Json(candidateSourceWithoutDigest));
  const historicalBaseInventoryDigest = sha256Bytes(historicalBaseInventoryBytes);
  const seedDigest = sha256Bytes(historicalBaseSeedBytes);
  assert.deepEqual(historicalCandidateSource.base_sources, [
    { path: 'data/batches/issue-222-m9-d-historical-base-recovery-inventory.json', sha256: historicalBaseInventoryDigest },
    { path: 'data/batches/issue-222-m9-d-historical-base-m5-target-seed.json', sha256: seedDigest },
  ], 'historical candidate source is bound to frozen recovery-inventory and M5 seed snapshots');
  assert.equal(historicalSemanticSource.source_basis.base_inventory_sha256, historicalBaseInventoryDigest);
  assert.equal(historicalSemanticSource.source_basis.base_seed_sha256, seedDigest);
  assert.equal(historicalSemanticSource.source_basis.candidate_source_sha256, sha256Bytes(historicalCandidateSourceBytes));
  assert.equal(historicalSemanticSource.source_basis.candidate_source_artifact_sha256, historicalCandidateSource.artifact_sha256);
  assert.equal(historicalSemanticSource.source_basis.candidate_records_sha256, sha256Json(historicalSemanticSource.candidate_records));
  assert.equal(historicalSemanticSource.candidate_records_sha256, sha256Json(historicalSemanticSource.candidate_records));
  const historicalIdentities = historicalCandidateSource.candidate_source_identities;
  assert.equal(historicalIdentities.length, 20);
  assert.equal(historicalCandidateSource.candidates.length, 20);
  assert.equal(historicalCandidateSource.selection.candidate_limit, historicalCandidateSource.candidates.length);
  assert.equal(historicalCandidateSource.candidates.length, historicalCandidateSource.selection.selected_candidate_count);
  const baseInventoryById = new Map(historicalBaseInventory.recovery_candidates.map((row) => [row.source_inventory_id, row]));
  const seedById = new Map(historicalBaseSeed.targets.map((row) => [row.inventory_id, row]));
  const currentSeedById = new Map(seed.targets.map((row) => [row.inventory_id, row]));
  const candidateById = new Map(historicalCandidateSource.candidates.map((row) => [row.inventory_id, row]));
  const historicalRecordsById = new Map(historicalSemanticSource.candidate_records.map((row) => [row.id, row]));
  const candidateIdentities = historicalCandidateSource.candidates.map(({ inventory_id: inventoryId, candidate_record_id: recordId, lemma, axis, record_type: recordType, pos }) => ({
    catalog_index: historicalIdentities.find(({ inventory_id: id }) => id === inventoryId)?.catalog_index,
    slot_id: historicalIdentities.find(({ inventory_id: id }) => id === inventoryId)?.slot_id,
    inventory_id: inventoryId,
    candidate_record_id: recordId,
    lemma,
    axis,
    record_type: recordType,
    pos,
  }));
  assert.deepEqual(candidateIdentities, historicalIdentities, 'historical selection identities match the source-bound candidate rows');
  for (const candidate of historicalCandidateSource.candidates) {
    const prior = baseInventoryById.get(candidate.inventory_id);
    const target = seedById.get(candidate.inventory_id);
    assert.ok(prior && target, `${candidate.inventory_id} exists in the frozen inventory and M5 seed`);
    assert.equal(candidate.source_inventory_row_sha256, sha256Json(prior), `${candidate.inventory_id} inventory row digest`);
    assert.equal(candidate.seed_row_sha256, sha256Json(target), `${candidate.inventory_id} M5 seed row digest`);
    assert.equal(prior.new_review_state, 'admit-candidate', `${candidate.inventory_id} was a historical reserve candidate`);
    assert.equal(prior.record_type, 'entry', `${candidate.inventory_id} is an in-scope entry`);
    assert.equal(prior.proposed_pos.length, 1, `${candidate.inventory_id} had one prior POS proposal`);
    assert.equal(candidate.lemma, prior.lemma);
    assert.equal(candidate.pos, prior.proposed_pos[0]);
    const record = historicalRecordsById.get(candidate.candidate_record_id);
    assert.ok(record, `${candidate.candidate_record_id} exists in the authored semantic candidate set`);
    assert.equal(record.lemma, candidate.lemma);
    assert.deepEqual(record.search_forms, candidate.search_forms);
    assert.equal(record.senses.length, 1);
    assert.equal(record.senses[0].pos, candidate.pos);
    assert.equal(record.senses[0].gloss, candidate.writer_gloss);
    const currentSeedRow = currentSeedById.get(candidate.inventory_id);
    assert.ok(currentSeedRow, `${candidate.inventory_id} remains in the current M5 seed history`);
    assert.equal(currentSeedRow.status, 'promoted', `${candidate.inventory_id} current M5 seed disposition`);
    assert.equal(currentSeedRow.canonical_id, candidate.candidate_record_id, `${candidate.inventory_id} current canonical binding`);
  }
  assert.equal(historicalSemanticSource.batch_id, historicalCandidateSource.batch_id);
  assert.equal(historicalSemanticSource.issue, 222);
  assert.equal(historicalSemanticSource.parent_issue, 218);
  const historicalSemanticDecisionSource = validateAuthoredSemanticDecisionSource({
    source: historicalSemanticSource,
    sourceBytes: historicalSemanticSourceBytes,
    identities: historicalIdentities,
    candidateRecords: historicalSemanticSource.candidate_records,
    config: historicalSemanticDecisionConfig(historicalCandidateSource, historicalSemanticSource),
  });
  const historicalIncludedIds = new Set(historicalSemanticDecisionSource.selection.selected.map(({ candidate_record_id: id }) => id));
  const expectedHistoricalImportRecords = historicalSemanticSource.candidate_records.filter(({ id }) => historicalIncludedIds.has(id));
  const historicalImportRecords = readJsonl(historicalImportBytes, 'Issue #222 historical canonical import');
  assert.deepEqual(historicalImportRecords, expectedHistoricalImportRecords, 'historical canonical import contains only source-bound admitted candidates');
  assert.equal(historicalImportRecords.length, 20);

  const currentCanonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const additionalCorpusBatches = await validateAdditionalCorpusBatches(currentCanonical, { verifyLocalCorpusEvidence });
  const allCorpusImportRecords = [
    ...importRecords,
    ...additionalCorpusBatches.flatMap(({ importRecords: records }) => records),
  ];
  const allImportRecords = [...allCorpusImportRecords, ...historicalImportRecords];
  const importIds = new Set(allImportRecords.map(({ id }) => id));
  assert.equal(importIds.size, allImportRecords.length, 'Issue #222 canonical import record IDs are unique across source classes');
  const corpusLemmaOwners = new Map();
  for (const record of allCorpusImportRecords) {
    const prior = corpusLemmaOwners.get(record.lemma);
    assert.equal(prior, undefined, `Issue #222 corpus batches must not admit the same exact lemma twice (${prior ?? ''}, ${record.id})`);
    corpusLemmaOwners.set(record.lemma, record.id);
  }
  for (const record of allImportRecords) {
    const stored = currentCanonical.records.find((recordInfo) => recordOf(recordInfo).id === record.id);
    assert.ok(stored, `${record.id} is present in complete canonical data`);
    assert.deepEqual(recordOf(stored), record, `${record.id} exactly matches its admitted source-bound record`);
  }
  const allIssue222ImportIds = new Set(allImportRecords.map(({ id }) => id));
  const allIssue222BaseRecords = currentCanonical.records.filter((recordInfo) => !allIssue222ImportIds.has(recordOf(recordInfo).id));
  const corpusBatch01ImportIds = new Set(importRecords.map(({ id }) => id));
  const corpusBatch01BaseRecords = currentCanonical.records.filter((recordInfo) => !corpusBatch01ImportIds.has(recordOf(recordInfo).id));
  const historicalImportIds = new Set(historicalImportRecords.map(({ id }) => id));
  const historicalBaseRecords = currentCanonical.records.filter((recordInfo) => !historicalImportIds.has(recordOf(recordInfo).id));
  assert.equal(allIssue222BaseRecords.length + allImportRecords.length, currentCanonical.records.length);

  const rootDecisionSource = await readSemanticDecisionSourceArtifact(ROOT_SEMANTIC_SOURCE_PATH);
  const currentDigest = canonicalRecordsSha256(currentCanonical.records);
  assert.equal(rootDecisionSource.source.canonical_records_sha256, currentDigest, 'complete canonical semantic source digest');
  const batchDecisionSources = await readAuthoredBatchDecisionSources();
  const semanticAudit = buildSemanticAuditFromDecisionSource(currentCanonical.records, rootDecisionSource, {
    artifactId: 'issue-222-complete-canonical-semantic-audit',
    baseRecords: allIssue222BaseRecords,
    batchDecisionSources,
  });
  const admissionContext = createSharedAdmissionContext(currentCanonical, semanticAudit, {
    canonicalDirectory: DEFAULT_CANONICAL_DIRECTORY,
  });
  const reviewRows = productionReviewRows(identities, semanticSource.candidate_records, semanticDecisionSource, {
    semanticReviewSourcePath: 'data/batches/issue-222-m9-d-corpus-batch-01-semantic-decisions.json',
    verificationPassId: semanticSource.provenance.verification_pass_id,
  });
  const production = validateLexicalProduction({
    batchId: BATCH_ID,
    candidateRecords: semanticSource.candidate_records,
    reviews: reviewRows,
    baseRecords: corpusBatch01BaseRecords,
    prospectiveRecords: currentCanonical.records,
    semanticAudit,
    canonicalContext: admissionContext,
    stageEvidence: productionStageEvidence({
      candidateSourceBytes: candidateReviewBytes,
      semanticSourceBytes,
      prospectiveRecords: currentCanonical.records,
      semanticAudit,
      issue: 222,
      batchId: BATCH_ID,
      generationPassId: candidateReview.provenance.generation_pass_id,
      verificationPassId: semanticSource.provenance.verification_pass_id,
      candidateSourcePath: 'data/batches/issue-222-m9-d-corpus-batch-01-candidate-review.json',
      semanticSourcePath: 'data/batches/issue-222-m9-d-corpus-batch-01-semantic-decisions.json',
    }),
    catalogCount: semanticSource.candidate_records.length,
    expectedSelectedCount: importRecords.length,
    candidateLabel: 'Issue #222 bounded corpus-backed lexical candidates',
    reviewedLabel: 'Issue #222 source-bound semantic decisions',
    prospectiveLabel: 'Issue #222 complete prospective canonical records',
  });
  assert.equal(production.admission?.audit?.blocking_finding_count, 0, 'ordinary shared lexical admission blockers');
  assert.equal(production.admission?.semantic_audit?.coverage_complete, true, 'complete prospective semantic coverage');

  const additionalCorpusProductions = additionalCorpusBatches.map((batch) => {
    const batchImportIds = new Set(batch.importRecords.map(({ id }) => id));
    const batchBaseRecords = currentCanonical.records.filter((recordInfo) => !batchImportIds.has(recordOf(recordInfo).id));
    const result = validateLexicalProduction({
      batchId: batch.batch_id,
      candidateRecords: batch.semanticSource.candidate_records,
      reviews: productionReviewRows(batch.identities, batch.semanticSource.candidate_records, batch.semanticDecisionSource, {
        semanticReviewSourcePath: batch.semanticPath,
        verificationPassId: batch.semanticSource.provenance.verification_pass_id,
      }),
      baseRecords: batchBaseRecords,
      prospectiveRecords: currentCanonical.records,
      semanticAudit,
      canonicalContext: admissionContext,
      stageEvidence: productionStageEvidence({
        candidateSourceBytes: batch.candidateReviewBytes,
        semanticSourceBytes: batch.semanticSourceBytes,
        prospectiveRecords: currentCanonical.records,
        semanticAudit,
        issue: 222,
        batchId: batch.batch_id,
        generationPassId: batch.candidateReview.provenance.generation_pass_id,
        verificationPassId: batch.semanticSource.provenance.verification_pass_id,
        candidateSourcePath: batch.sourcePath,
        semanticSourcePath: batch.semanticPath,
      }),
      catalogCount: batch.semanticSource.candidate_records.length,
      expectedSelectedCount: batch.importRecords.length,
      candidateLabel: `Issue #222 ${batch.batch_id} corpus candidates`,
      reviewedLabel: `Issue #222 ${batch.batch_id} source-bound semantic decisions`,
      prospectiveLabel: 'Issue #222 complete prospective canonical records',
    });
    assert.equal(result.admission?.audit?.blocking_finding_count, 0, `${batch.batch_id} shared lexical admission blockers`);
    assert.equal(result.admission?.semantic_audit?.coverage_complete, true, `${batch.batch_id} complete prospective semantic coverage`);
    return result;
  });

  const historicalProduction = validateLexicalProduction({
    batchId: historicalSemanticSource.batch_id,
    candidateRecords: historicalSemanticSource.candidate_records,
    reviews: productionReviewRows(historicalIdentities, historicalSemanticSource.candidate_records, historicalSemanticDecisionSource, {
      semanticReviewSourcePath: 'data/batches/issue-222-m9-d-historical-semantic-decisions.json',
      verificationPassId: historicalSemanticSource.provenance.verification_pass_id,
    }),
    baseRecords: historicalBaseRecords,
    prospectiveRecords: currentCanonical.records,
    semanticAudit,
    canonicalContext: admissionContext,
    stageEvidence: productionStageEvidence({
      candidateSourceBytes: historicalCandidateSourceBytes,
      semanticSourceBytes: historicalSemanticSourceBytes,
      prospectiveRecords: currentCanonical.records,
      semanticAudit,
      issue: 222,
      batchId: historicalSemanticSource.batch_id,
      generationPassId: historicalSemanticSource.provenance.generation_pass_id,
      verificationPassId: historicalSemanticSource.provenance.verification_pass_id,
      candidateSourcePath: 'data/batches/issue-222-m9-d-historical-candidate-source.json',
      semanticSourcePath: 'data/batches/issue-222-m9-d-historical-semantic-decisions.json',
    }),
    catalogCount: historicalSemanticSource.candidate_records.length,
    expectedSelectedCount: historicalImportRecords.length,
    candidateLabel: 'Issue #222 bounded historical recovery candidates',
    reviewedLabel: 'Issue #222 source-bound historical semantic decisions',
    prospectiveLabel: 'Issue #222 complete prospective canonical records',
  });
  assert.equal(historicalProduction.admission?.audit?.blocking_finding_count, 0, 'ordinary shared historical lexical admission blockers');
  assert.equal(historicalProduction.admission?.semantic_audit?.coverage_complete, true, 'historical batch has complete prospective semantic coverage');

  assertCompleteRevisionChecksReused(admissionContext, 2 + additionalCorpusProductions.length);
  const deterministicBuild = await validateDeterministicBuild(allImportRecords);
  return {
    issue: 222,
    source_classes: {
      corpus_candidates: candidateReview.decisions.length + additionalCorpusBatches.reduce((sum, batch) => sum + batch.candidateCount, 0),
      historical_candidates: historicalCandidateSource.candidates.length,
    },
    corpus_batches: [
      {
        batch_id: candidateReview.batch_id,
        candidate_count: candidateReview.decisions.length,
        admitted_count: importRecords.length,
        held_count: candidateReview.decision_counts.hold,
        rejected_count: candidateReview.decision_counts.reject,
      },
      ...additionalCorpusBatches.map(({ batch_id: batchId, candidateCount, admittedCount, heldCount, rejectedCount }) => ({
        batch_id: batchId,
        candidate_count: candidateCount,
        admitted_count: admittedCount,
        held_count: heldCount,
        rejected_count: rejectedCount,
      })),
    ],
    candidate_count: candidateReview.decisions.length
      + additionalCorpusBatches.reduce((sum, batch) => sum + batch.candidateCount, 0)
      + historicalCandidateSource.candidates.length,
    admitted_count: allImportRecords.length,
    held_count: candidateReview.decision_counts.hold
      + additionalCorpusBatches.reduce((sum, batch) => sum + batch.heldCount, 0),
    rejected_count: candidateReview.decision_counts.reject
      + additionalCorpusBatches.reduce((sum, batch) => sum + batch.rejectedCount, 0)
      + historicalSemanticDecisionSource.counts.rejected,
    corpus_admitted_count: allCorpusImportRecords.length,
    historical_admitted_count: historicalImportRecords.length,
    corpus_paragraph_text_committed: false,
    shared_admission_blocking_findings: production.admission.audit.blocking_finding_count,
    semantic_coverage_complete: production.admission.semantic_audit.coverage_complete,
    additional_corpus_batches_semantic_coverage_complete: additionalCorpusProductions.every(({ admission }) => admission?.semantic_audit?.coverage_complete),
    ...deterministicBuild,
  };
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  validateIssue222()
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}
