import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../build/dictionary.mjs';
import { readLogicalDatabaseSnapshot } from '../build/query.mjs';
import { EXACT_SEARCH_ROWS_SQL } from '../../src/runtime/sqlite-query.js';
import {
  assertIndependentSemanticReviewer,
  assertReviewerChecks,
  assertReviewerOutcomes,
  bindHitCounts,
  assertSemanticReviewEnvelope,
  REVIEWER_CHECK_FIRST_BATCH,
  issue223CorrectionPassId,
  loadSemanticReviewerRegistry,
  makeSemanticDecision,
  parseIssue223BatchId,
} from './build-issue-223-corpus-batch.mjs';
import { assertSelfCheckBinding, assertReviewContractForBatch, assertDecisionClaimsTruthful,
  assertSelfCheckEnvelope, assertSourceClaimsTruthful, isSelfCheckInput } from './semantic-self-check.mjs';
import { assertInputBoundToRunRecord, assertInputDerivedFromRaw } from './reviewer-raw-outputs.mjs';
import { validateIssue222 } from './validate-issue-222.mjs';
import { validateAuthoredSemanticDecisionSource, M9_EXPRESSION_LEXICAL_UNIT_REVIEW_CONTRACT_VERSION } from './authored-semantic-decision-source.mjs';
import { validateIssue223SemanticQaArtifact } from './issue-223-semantic-qa.mjs';
import { validateLexicalProduction } from './lexical-production.mjs';
import { productionReviewRows, productionStageEvidence } from './validate-issue-211.mjs';
import { hasMorphologyBlocker, validateCorpusCandidateReviewDispositions } from '../validate/corpus-candidate-review.mjs';
import { DEFAULT_CANONICAL_DIRECTORY, readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import { assertCompleteRevisionChecksReused, createSharedAdmissionContext } from './shared-admission-context.mjs';
import {
  buildSemanticAuditFromDecisionSource,
  canonicalRecordsSha256,
  readAuthoredBatchDecisionSources,
  readSemanticDecisionSourceArtifact,
  sha256Json,
} from '../validate/semantic-audit.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');
const BATCH_DIRECTORY = path.join(ROOT, 'data/batches');
const REFERENCE_DIRECTORY = path.join(ROOT, 'data/reference');
const ROOT_SEMANTIC_SOURCE_PATH = path.join(ROOT, 'data/validation/canonical-semantic-decision-source.json');
const MAX_CANDIDATE_LIMIT = 500;
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
const parseJsonl = (bytes, label) => bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map((line, index) => {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`${label} line ${index + 1} is invalid JSON: ${error.message}`);
  }
});

function assertTextFree(value, label) {
  const forbidden = new Set(['context', 'paragraph_text', 'paragraph_form', 'excerpt', 'sentence_excerpt']);
  const visit = (node, location) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      assert.equal(forbidden.has(key), false, `${label} must omit ${location}.${key}`);
      visit(child, `${location}.${key}`);
    }
  };
  visit(value, label);
}

function hasExactObservedEojeol(context, surface) {
  return context.split(/\s+/u).some((token) => token.replace(/^\p{P}+|\p{P}+$/gu, '') === surface);
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
    `${label} source digest must match the current source or a version retained in Git history`,
  );
}

// Admissions (and sense holds) need at least one morphology-bound paragraph
// context. An identity hold claims no lexical entry, so it may rest on a
// component-only analysis or on the analyzer's own morphology blocker.
export function candidateRequiresBoundedContext(reviewRow) {
  const judgment = reviewRow.editorial_judgment;
  if (judgment.disposition !== 'hold' || judgment.disposition_basis !== 'unresolved-identity') return true;
  const zeroContextEvidence = ['reviewed-analyzed-forms-show-component-only-usage', 'no-exact-start-context-available']
    .includes(judgment.identity_evidence?.evidence_type);
  return !(zeroContextEvidence || hasMorphologyBlocker(reviewRow.morphology_proposal));
}

// B01-B04 predate the bound semantic-review input contract (owner override,
// see docs/issue-223-m9-e-scale-coverage.md). The exception is pinned to the
// exact historical batch IDs and artifact bytes, so a new-dated batch with the
// same ordinal, or any change to these artifacts, must carry a bound review.
export const LEGACY_UNBOUND_SEMANTIC_BATCHES = Object.freeze({
  'issue-223-m9-e-corpus-batch-01-20261001': { candidate_review: 'ea7c5bfed57959141a9ed5bdda4405ed6221b83296e61b2aee8070ce3bd59097', semantic_decisions: '7ae7e5205e81feee6d5386050662b2a95ff6c68fba498e9abca00c478d618809', canonical_import: '4c87f580ee1188e8396da9a05ba2a5dc8ff4ee4bff4b02f3cdc4be2a6122b373' },
  'issue-223-m9-e-corpus-batch-02-20261001': { candidate_review: 'f3f2d30a2e74b64cfb9cb41858ba6e30f14951ef2130fe817f467fc8413d4a0c', semantic_decisions: '361232221c2ba28131bcf147e64ae0301bd093a515d300a40d38f323b9a3e464', canonical_import: '571c113e2426b2c2f6864f4969ebfbc4dfed32ae4c30452759d6202246d9f176' },
  'issue-223-m9-e-corpus-batch-03-20261001': { candidate_review: 'ec94648428e3e79380e0a328133b5b5c64803d010cb24c457070288118c0649f', semantic_decisions: '64ef0a15da969ffb007ba2b84d4fc74d580739785e16163c9b90a0129df132a0', canonical_import: 'e758b145f0dce4118765239fb02fd7d6f10764e1f84ab3ff7883a37022df76b2' },
  'issue-223-m9-e-corpus-batch-04-20261001': { candidate_review: '6f56a388cd0e4d2291e6b9263554574969ceeea2895186d71c2e054f1bfb52d6', semantic_decisions: '44f5fc819ecea2be29111cbec0c7bc8030a74f2322536c978923cc44e861ea08', canonical_import: '026d99944fc28e2bfced64f17e59a23d20109850c179f6d97444fd4430112935' },
});

export function validateSemanticReviewInputBinding({
  semanticSource, inputBytes, runRecordBytes, rawArtifact, batchId, admittedRows, candidateRows, candidateAuthor, registry, legacyArtifactBytes,
}) {
  const { ordinal } = parseIssue223BatchId(batchId);
  const digest = semanticSource.source_basis.semantic_review_input_sha256;
  if (digest === undefined) {
    const pinned = LEGACY_UNBOUND_SEMANTIC_BATCHES[batchId];
    assert.ok(pinned, `${batchId} semantic source must bind its authored semantic review input`);
    for (const [name, bytes] of Object.entries(legacyArtifactBytes ?? {})) {
      assert.equal(sha256Bytes(bytes), pinned[name], `${batchId} legacy ${name} no longer matches the pinned historical artifact`);
    }
    assert.deepEqual(Object.keys(legacyArtifactBytes ?? {}).sort(), Object.keys(pinned).sort(),
      `${batchId} legacy exception needs every pinned artifact`);
    assert.equal(inputBytes ?? null, null, `${batchId} legacy semantic source must not carry a review input`);
    return null;
  }
  assert.ok(inputBytes, `${batchId} semantic review input artifact is missing`);
  assert.equal(sha256Bytes(inputBytes), digest, `${batchId} semantic review input does not match its bound digest`);
  const input = JSON.parse(inputBytes.toString('utf8'));
  assertSemanticReviewEnvelope(input, batchId);
  const selfCheck = isSelfCheckInput(input);
  assertReviewContractForBatch(ordinal, selfCheck);
  assertSourceClaimsTruthful(semanticSource, { selfCheck });
  if (selfCheck) {
    assertSelfCheckEnvelope(input, { ordinal, candidateAuthor });
    assertDecisionClaimsTruthful({ reviews: input.reviews, decisions: semanticSource.decisions, outcomes: input.candidate_outcomes });
    // No separate review run took place, so no run record or staged reviewer
    // output may exist to suggest one.
    assert.equal(runRecordBytes ?? null, null, `${batchId} a self-check batch must not carry a reviewer run record`);
    assert.equal(rawArtifact ?? null, null, `${batchId} a self-check batch has no staged reviewer outputs`);
  } else {
    assertIndependentSemanticReviewer({ reviewer: input.reviewer, candidateAuthor, registry });
  }
  assertReviewerChecks(input.reviews, {
    required: ordinal >= REVIEWER_CHECK_FIRST_BATCH,
    hitCountByLemma: bindHitCounts(candidateRows ?? admittedRows),
  });
  if (selfCheck) {
    assertReviewerOutcomes(input.candidate_outcomes, candidateRows);
    const glossByLemma = new Map(semanticSource.candidate_records.map((record) => [record.lemma, record.senses[0].gloss]));
    assertSelfCheckBinding({ input, candidateRows, glossByLemma });
  } else if (ordinal >= REVIEWER_CHECK_FIRST_BATCH) {
    assertReviewerOutcomes(input.candidate_outcomes, candidateRows);
    // The tracked run record (metadata and digests only) binds the input to the
    // runs, the reviewed proposals, and the exact reviewed glosses.
    assert.ok(runRecordBytes, `${batchId} reviewer run record is missing`);
    const runRecord = JSON.parse(runRecordBytes.toString('utf8'));
    const glossByLemma = new Map(semanticSource.candidate_records.map((record) => [record.lemma, record.senses[0].gloss]));
    assertInputBoundToRunRecord({ input, runRecord, runRecordBytes, candidateRows, glossByLemma, sha256Bytes });
    // Where the raw outputs are staged locally, re-derive the record and input.
    if (rawArtifact) assertInputDerivedFromRaw({ input, runRecord, rawArtifact, candidateRows, glossByLemma });
  }
  const admittedLemmas = admittedRows.map((row) => row.morphology_proposal.lemma);
  assert.deepEqual(
    input.reviews.map(({ lemma }) => lemma).sort(),
    [...admittedLemmas].sort(),
    `${batchId} semantic review input must cover exactly the admitted lemmas`,
  );
  // Every emitted decision must be exactly what the preserved authored review
  // yields, so changing an outcome, rationale, or frame in the output (even
  // with a recomputed artifact digest) fails against the stored input.
  assert.equal(semanticSource.decisions.length, admittedRows.length, `${batchId} decision count must match admitted rows`);
  const reviewByLemma = new Map(input.reviews.map((entry) => [entry.lemma, entry]));
  admittedRows.forEach((row, index) => {
    const lemma = row.morphology_proposal.lemma;
    const record = semanticSource.candidate_records[index];
    assert.equal(record.lemma, lemma, `${batchId} candidate record ${index + 1} is bound to ${lemma}`);
    const expected = makeSemanticDecision(
      row,
      record,
      index + 1,
      semanticSource.review.review_pass_id,
      semanticSource.source_id,
      reviewByLemma.get(lemma),
    );
    assert.deepEqual(semanticSource.decisions[index], expected,
      `${batchId} ${lemma} decision does not match its bound authored semantic review`);
  });
  assert.equal(semanticSource.review.reviewer, input.reviewer, `${batchId} semantic output reviewer must match its bound input`);
  return input;
}

export function semanticDecisionConfig(candidateReview, semanticSource, sourcePath, reviewer) {
  return {
    label: `Issue #223 ${candidateReview.batch_id}`,
    errorPrefix: 'ISSUE_223',
    sourcePath,
    sourceId: semanticSource.source_id,
    candidateSourceId: candidateReview.source_id,
    batchId: candidateReview.batch_id,
    issue: 223,
    parentIssue: 218,
    generationPassId: candidateReview.provenance.generation_pass_id,
    verificationPassId: semanticSource.provenance.verification_pass_id,
    correctionPassId: issue223CorrectionPassId(candidateReview.batch_id),
    ...(reviewer ? { reviewer } : {}),
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

export function validateReviewOnlyCanonicalImportBoundary({
  candidateReview,
  semanticSourceExists,
  canonicalImportExists,
  currentCanonicalRecords,
}) {
  const admitted = candidateReview.decisions.filter(({ editorial_judgment: judgment }) => judgment.disposition === 'admit');
  assert.equal(candidateReview.canonical_import_status, 'owner-deferred-review-only');
  assert.equal(candidateReview.canonical_import_count, 0);
  assert.equal(candidateReview.canonical_import_deferred_count, admitted.length);
  assert.ok(typeof candidateReview.canonical_import_deferred_reason === 'string'
    && candidateReview.canonical_import_deferred_reason.trim());
  assert.equal(candidateReview.decision_counts.admit, admitted.length);
  assert.equal(semanticSourceExists, false, `${candidateReview.batch_id} review-only checkpoint must not have semantic decisions`);
  assert.equal(canonicalImportExists, false, `${candidateReview.batch_id} review-only checkpoint must not have a canonical import`);

  const currentRecords = currentCanonicalRecords.map(recordOf);
  const currentIds = new Set(currentRecords.map(({ id }) => id));
  const currentLemmas = new Set(currentRecords.map(({ lemma }) => lemma));
  for (const row of admitted) {
    assert.equal(currentIds.has(row.editorial_judgment.candidate_record_id), false,
      `${row.editorial_judgment.candidate_record_id} is deferred and must not already be canonical`);
    assert.equal(currentLemmas.has(row.morphology_proposal.lemma), false,
      `${row.morphology_proposal.lemma} is deferred and must not already be canonical`);
  }
  return admitted.length;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
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

async function validateCorpusBatches(currentCanonical, { verifyLocalCorpusEvidence }) {
  const reviewerRegistry = await loadSemanticReviewerRegistry();
  const names = (await readdir(BATCH_DIRECTORY))
    .filter((name) => /^issue-223-m9-e-corpus-batch-\d+-candidate-review\.json$/u.test(name))
    .sort((left, right) => Number(/batch-(\d+)/u.exec(left)?.[1]) - Number(/batch-(\d+)/u.exec(right)?.[1]));
  assert.ok(names.length > 0, 'Issue #223 needs at least one corpus candidate review');
  const batches = [];
  const seenInventoryIds = new Set();
  const seenCandidateIds = new Set();
  const seenCanonicalIds = new Set();
  const seenLemmas = new Set();
  let nextInventoryNumber = 12286;
  let nextCanonicalNumber = 7858;

  for (const candidateName of names) {
    const stem = candidateName.replace(/-candidate-review\.json$/u, '');
    const candidatePath = path.join(BATCH_DIRECTORY, candidateName);
    const semanticPath = path.join(BATCH_DIRECTORY, `${stem}-semantic-decisions.json`);
    const importPath = path.join(ROOT, 'data/canonical', `${stem}.jsonl`);
    const candidateBytes = await readFile(candidatePath);
    const candidateReview = JSON.parse(candidateBytes.toString('utf8'));
    const reviewOnly = candidateReview.canonical_import_status === 'owner-deferred-review-only';
    assert.ok(candidateReview.canonical_import_status === undefined || reviewOnly,
      `${candidateReview.batch_id} has an unsupported canonical import status`);
    const [semanticBytes, importBytes] = reviewOnly
      ? [null, null]
      : await Promise.all([readFile(semanticPath), readFile(importPath)]);
    const semanticSource = semanticBytes ? JSON.parse(semanticBytes.toString('utf8')) : null;
    const candidateLabel = `Issue #223 ${candidateReview.batch_id}`;
    assert.equal(candidateReview.schema_version, '1');
    assert.equal(candidateReview.contract_version, 'm9-corpus-candidate-review-v1');
    assert.equal(candidateReview.issue, 223);
    assert.equal(candidateReview.parent_issue, 218);
    assert.equal(candidateReview.authoring_mode, 'agent-authored-decision');
    assert.equal(candidateReview.human_reviewed, false);
    assert.equal(candidateReview.publication_state, 'local_reference_only_pending_owner_publication_confirmation');
    assert.ok(candidateReview.batch_id.startsWith(`${stem}-`), `${candidateLabel} ID must match its artifact path`);
    assert.ok(candidateReview.selection.candidate_limit >= 1 && candidateReview.selection.candidate_limit <= MAX_CANDIDATE_LIMIT);
    assert.equal(candidateReview.decisions.length, candidateReview.selection.selected_candidate_count);
    const dispositionCounts = validateCorpusCandidateReviewDispositions(candidateReview.decisions, { label: `${candidateLabel} candidate review` });
    assert.deepEqual(dispositionCounts, candidateReview.decision_counts);
    assertTextFree(candidateReview, `${candidateLabel} candidate review`);
    const reviewWithoutDigest = structuredClone(candidateReview);
    delete reviewWithoutDigest.artifact_sha256;
    assert.equal(candidateReview.artifact_sha256, sha256Json(reviewWithoutDigest));
    assert.equal(candidateReview.source_artifacts.candidate_selection_sha256, candidateReview.selection.candidate_selection_sha256);
    assert.equal(candidateReview.source_artifacts.exclusion_manifest_sha256, candidateReview.selection.exclusion_sha256);
    assert.deepEqual(candidateReview.source_artifacts.exclusion_source_artifacts, candidateReview.selection.exclusion_source_artifacts);

    for (const decision of candidateReview.decisions) {
      assert.equal(seenInventoryIds.has(decision.inventory_id), false, `${decision.inventory_id} is unique across Issue #223 batches`);
      assert.equal(seenCandidateIds.has(decision.candidate_id), false, `${decision.candidate_id} is unique across Issue #223 batches`);
      seenInventoryIds.add(decision.inventory_id);
      seenCandidateIds.add(decision.candidate_id);
      if (decision.editorial_judgment.disposition === 'admit') {
        const recordId = decision.editorial_judgment.candidate_record_id;
        assert.equal(recordId, `w${String(nextCanonicalNumber).padStart(4, '0')}`, `${candidateReview.batch_id} canonical ID allocation is sequential`);
        nextCanonicalNumber += 1;
        assert.equal(seenCanonicalIds.has(recordId), false, `${recordId} is unique across Issue #223 batches`);
        assert.equal(seenLemmas.has(decision.morphology_proposal.lemma), false, `${decision.morphology_proposal.lemma} is unique across Issue #223 batches`);
        seenCanonicalIds.add(recordId);
        seenLemmas.add(decision.morphology_proposal.lemma);
      }
    }

    if (verifyLocalCorpusEvidence) {
      const pathUnderReference = (relativePath, label) => {
        const absolute = path.resolve(ROOT, relativePath);
        const relative = path.relative(REFERENCE_DIRECTORY, absolute);
        assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${label} must stay under ignored data/reference`);
        return absolute;
      };
      const [evidenceBytes, selectionBytes, inventoryBytes] = await Promise.all([
        readFile(pathUnderReference(candidateReview.source_artifacts.candidate_evidence_path, 'candidate evidence')),
        readFile(pathUnderReference(candidateReview.source_artifacts.candidate_selection_path, 'candidate selection')),
        readFile(pathUnderReference(candidateReview.source_artifacts.candidate_inventory_path, 'candidate inventory')),
      ]);
      const evidence = JSON.parse(evidenceBytes.toString('utf8'));
      const selection = JSON.parse(selectionBytes.toString('utf8'));
      const inventory = JSON.parse(inventoryBytes.toString('utf8'));
      assert.equal(sha256Bytes(evidenceBytes), candidateReview.source_artifacts.candidate_evidence_sha256);
      assert.equal(sha256Bytes(selectionBytes), candidateReview.source_artifacts.candidate_selection_sha256);
      assert.equal(sha256Bytes(inventoryBytes), candidateReview.source_artifacts.candidate_inventory_sha256);
      assert.equal(selection.selection.exclusion_sha256, candidateReview.selection.exclusion_sha256);
      assert.deepEqual(selection.selection.exclusion_source_artifacts, candidateReview.selection.exclusion_source_artifacts);
      for (const field of ['contract_version', 'candidate_limit', 'selected_candidate_count', 'ordering', 'exclusion_sha256', 'exclusion_source_artifacts']) {
        assert.deepEqual(candidateReview.selection[field], selection.selection[field], `${candidateLabel} selection.${field} is source-bound`);
      }
      if (candidateReview.yield.excluded_candidate_lemma_count !== undefined) {
        assert.equal(candidateReview.yield.excluded_candidate_lemma_count, selection.selection.excluded_candidate_lemma_count);
      }
      for (const field of Object.keys(evidence.yield)) assert.deepEqual(candidateReview.yield[field], evidence.yield[field], `${candidateLabel} yield.${field} is source-bound`);
      assertTextFree(evidence, `${candidateLabel} candidate evidence`);
      assert.equal(evidence.permission_record_sha256, candidateReview.source.permission_record_sha256);
      assert.deepEqual(evidence.index, candidateReview.source.index);
      assert.deepEqual(evidence.typewriter_surface, candidateReview.source.typewriter_surface);
      assert.equal(inventory.candidates.length, evidence.candidates.length, `${candidateLabel} local inventory size matches its text-free evidence`);
      assert.equal(inventory.orchestration.orchestrator_script_sha256, evidence.orchestration.orchestrator_script_sha256);
      await assertPinnedSourceDigest(
        'scripts/reference/run-corpus-lemma-pilot.mjs',
        evidence.orchestration.orchestrator_script_sha256,
        `${candidateLabel} evidence orchestrator`,
      );
      const permissionBytes = await readFile(path.join(ROOT, candidateReview.source.permission_record_path));
      assert.equal(sha256Bytes(permissionBytes), candidateReview.source.permission_record_sha256);
      for (const artifact of candidateReview.selection.exclusion_source_artifacts) {
        await assertPinnedSourceDigest(artifact.path, artifact.sha256, `${candidateLabel} exclusion source ${artifact.path}`);
      }
      assert.equal(evidence.candidates.length, candidateReview.decisions.length);
      for (const [index, reviewRow] of candidateReview.decisions.entries()) {
        const selected = evidence.candidates[index];
        const localCandidate = inventory.candidates[index];
        assert.equal(reviewRow.candidate_ordinal, index + 1);
        assert.equal(reviewRow.morphology_proposal.lemma, selected.proposed_lemma);
        assert.equal(reviewRow.morphology_proposal.analyzer_pos, selected.analyzer_pos);
        const correction = reviewRow.editorial_judgment.pos_correction;
        if (correction === undefined) {
          assert.equal(reviewRow.morphology_proposal.pos, selected.proposed_pos, `${candidateLabel} ${reviewRow.inventory_id} uses the selected POS`);
        } else {
          assert.equal(reviewRow.editorial_judgment.disposition, 'admit', `${candidateLabel} ${reviewRow.inventory_id} POS correction is admitted`);
          assert.notEqual(reviewRow.morphology_proposal.pos, selected.proposed_pos, `${candidateLabel} ${reviewRow.inventory_id} POS correction changes the selected mapping`);
          assert.equal(correction.evidence_type, 'reviewed-bounded-contexts-support-corrected-pos');
          assert.equal(correction.analyzer_pos, selected.analyzer_pos);
          assert.equal(correction.analyzer_mapped_pos, selected.proposed_pos);
          assert.equal(correction.corrected_pos, reviewRow.morphology_proposal.pos);
          assert.equal(typeof correction.rationale, 'string');
          assert.ok(correction.rationale.trim());
          const availableParagraphIds = new Set(selected.evidence.representative_hits.map(({ paragraph_id }) => paragraph_id));
          assert.ok(correction.paragraph_ids.length > 0);
          assert.equal(new Set(correction.paragraph_ids).size, correction.paragraph_ids.length);
          assert.ok(correction.paragraph_ids.every((id) => availableParagraphIds.has(id)));
        }
        assert.equal(reviewRow.morphology_proposal.ambiguity_status, selected.ambiguity_status);
        assert.equal(reviewRow.coverage_status, selected.coverage_status);
        assert.deepEqual(reviewRow.typewriter_surface_matches, selected.typewriter_surface_matches);
        assert.deepEqual(reviewRow.observed_surface_forms, selected.observed_surface_forms);
        assert.deepEqual(reviewRow.observed_morpheme_spans, selected.observed_morpheme_spans);
        if (selected.evidence.evidence_type === 'observed_surface_form_contexts_and_literal_text_match_count'
          || selected.evidence.evidence_type === 'candidate_morpheme_rooted_eojeol_contexts_and_literal_text_match_count') {
          assert.equal(selected.proposed_lemma, localCandidate.proposed_lemma);
          if (candidateRequiresBoundedContext(reviewRow)) {
            assert.ok(selected.evidence.representative_hits.length > 0, `${candidateLabel} ${reviewRow.inventory_id} needs at least one morphology-bound paragraph context`);
          } else if (['reviewed-analyzed-forms-show-component-only-usage', 'no-exact-start-context-available']
            .includes(reviewRow.editorial_judgment.identity_evidence?.evidence_type)) {
            assert.equal(selected.evidence.representative_hits.length, 0);
          }
          const localHitsById = new Map(localCandidate.evidence.representative_hits.map((hit) => [hit.paragraph_id, hit]));
          const observedForms = new Set(selected.observed_surface_forms.map(({ surface }) => surface));
          for (const hit of selected.evidence.representative_hits) {
            assert.ok(observedForms.has(hit.matched_surface_form), `${candidateLabel} ${reviewRow.inventory_id} evidence names an observed surface form`);
            const localHit = localHitsById.get(hit.paragraph_id);
            assert.ok(localHit, `${candidateLabel} ${reviewRow.inventory_id} text-free evidence matches its local inventory`);
            assert.equal(localHit.matched_surface_form, hit.matched_surface_form);
            if (selected.evidence.evidence_type === 'candidate_morpheme_rooted_eojeol_contexts_and_literal_text_match_count') {
              const observedMorphemeSpans = new Set(selected.observed_morpheme_spans.map(({ surface }) => surface));
              assert.ok(observedMorphemeSpans.has(hit.matched_morpheme_span_surface), `${candidateLabel} ${reviewRow.inventory_id} hit binds an analyzed morpheme span`);
              assert.ok(hit.matched_surface_form.startsWith(hit.matched_morpheme_span_surface), `${candidateLabel} ${reviewRow.inventory_id} eojeol begins with its candidate morpheme span`);
              assert.equal(localHit.matched_morpheme_span_surface, hit.matched_morpheme_span_surface);
            }
            assert.ok(hasExactObservedEojeol(localHit.context, hit.matched_surface_form), `${candidateLabel} ${reviewRow.inventory_id} context contains an exact observed eojeol`);
          }
        }
        assert.deepEqual(reviewRow.bounded_provenance.representative_hits.map(({ paragraph_id }) => paragraph_id), selected.evidence.representative_hits.map(({ paragraph_id }) => paragraph_id));
        assert.deepEqual(reviewRow.bounded_provenance.representative_hits, selected.evidence.representative_hits);
        for (const field of ['representative_context_match_method', 'representative_surface_search_limit']) {
          if (selected.evidence[field] !== undefined) {
            assert.equal(reviewRow.bounded_provenance[field], selected.evidence[field], `${candidateLabel} ${field} is source-bound`);
          }
        }
        assert.equal(reviewRow.inventory_id, `m5-${nextInventoryNumber + index}`, `${candidateLabel} inventory allocation is sequential`);
      }
    }
    nextInventoryNumber += candidateReview.decisions.length;

    if (reviewOnly) {
      const deferredAdmitCount = validateReviewOnlyCanonicalImportBoundary({
        candidateReview,
        semanticSourceExists: await fileExists(semanticPath),
        canonicalImportExists: await fileExists(importPath),
        currentCanonicalRecords: currentCanonical.records,
      });
      batches.push({
        batch_id: candidateReview.batch_id,
        candidateReview,
        candidateReviewBytes: candidateBytes,
        semanticSource: null,
        semanticSourceBytes: null,
        validatedSource: null,
        identities: [],
        importRecords: [],
        candidateCount: candidateReview.decisions.length,
        admittedCount: 0,
        deferredAdmitCount,
        heldCount: dispositionCounts.hold,
        rejectedCount: dispositionCounts.reject,
        reviewOnly: true,
        sourcePath: `data/batches/${candidateName}`,
        semanticPath: `data/batches/${path.basename(semanticPath)}`,
      });
      continue;
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
    assert.equal(semanticSource.issue, 223);
    assert.equal(semanticSource.parent_issue, 218);
    assert.ok(
      [sha256Bytes(candidateBytes), candidateReview.artifact_sha256].includes(semanticSource.source_basis.candidate_review_sha256),
      `${candidateLabel} semantic source binds the exact candidate-review artifact`,
    );
    assert.equal(semanticSource.source_basis.candidate_selection_sha256, candidateReview.selection.candidate_selection_sha256);
    assert.equal(semanticSource.source_basis.candidate_evidence_sha256, candidateReview.source_artifacts.candidate_evidence_sha256);
    assert.equal(semanticSource.source_basis.exclusion_manifest_sha256, candidateReview.source_artifacts.exclusion_manifest_sha256);
    assert.equal(semanticSource.candidate_records_sha256, sha256Json(semanticSource.candidate_records));
    const semanticInputPath = path.join(BATCH_DIRECTORY, `${stem}-semantic-review-input.json`);
    const reviewerRunRecordPath = path.join(BATCH_DIRECTORY, `${stem}-reviewer-run-record.json`);
    const semanticInputBytes = await fileExists(semanticInputPath) ? await readFile(semanticInputPath) : null;
    const selfCheckBatch = semanticInputBytes !== null && isSelfCheckInput(JSON.parse(semanticInputBytes.toString('utf8')));
    const boundInput = validateSemanticReviewInputBinding({
      semanticSource,
      inputBytes: semanticInputBytes,
      runRecordBytes: await fileExists(reviewerRunRecordPath) ? await readFile(reviewerRunRecordPath) : null,
      rawArtifact: await stagedRawArtifact(candidateReview, verifyLocalCorpusEvidence, selfCheckBatch),
      batchId: candidateReview.batch_id,
      admittedRows,
      candidateRows: candidateReview.decisions,
      candidateAuthor: candidateReview.reviewer,
      registry: reviewerRegistry,
      legacyArtifactBytes: { candidate_review: candidateBytes, semantic_decisions: semanticBytes, canonical_import: importBytes },
    });
    const validatedSource = validateAuthoredSemanticDecisionSource({
      source: semanticSource,
      sourceBytes: semanticBytes,
      identities,
      candidateRecords: semanticSource.candidate_records,
      config: semanticDecisionConfig(candidateReview, semanticSource, `data/batches/${path.basename(semanticPath)}`, boundInput?.reviewer),
    });
    const includedIds = new Set(validatedSource.selection.selected.map(({ candidate_record_id: id }) => id));
    const expectedImports = semanticSource.candidate_records.filter(({ id }) => includedIds.has(id));
    const importRecords = parseJsonl(importBytes, `${candidateLabel} canonical import`);
    assert.deepEqual(importRecords, expectedImports, `${candidateLabel} import matches its source-bound selection`);
    assert.equal(importRecords.length, admittedRows.length);
    for (const record of importRecords) {
      const stored = currentCanonical.records.find((info) => recordOf(info).id === record.id);
      assert.ok(stored, `${candidateLabel} ${record.id} exists in canonical data`);
      assert.deepEqual(recordOf(stored), record, `${candidateLabel} ${record.id} matches its reviewed canonical record`);
    }
    batches.push({
      batch_id: candidateReview.batch_id,
      candidateReview,
      candidateReviewBytes: candidateBytes,
      semanticSource,
      semanticSourceBytes: semanticBytes,
      canonicalImportBytes: importBytes,
      validatedSource,
      identities,
      importRecords,
      candidateCount: candidateReview.decisions.length,
      admittedCount: importRecords.length,
      deferredAdmitCount: 0,
      heldCount: dispositionCounts.hold,
      rejectedCount: dispositionCounts.reject,
      reviewOnly: false,
      sourcePath: `data/batches/${candidateName}`,
      semanticPath: `data/batches/${path.basename(semanticPath)}`,
    });
  }
  return batches;
}

async function validateDeterministicBuild(admittedRecords, { compareSecondBuild = true } = {}) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-issue-223-determinism-'));
  try {
    const snapshots = [];
    let directlySearchable = 0;
    for (const name of compareSecondBuild ? ['first', 'second'] : ['first']) {
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
    // Independent two-build reproducibility is a deep/manual validation path
    // (REVIEW.md); normal CI builds once and checks direct search.
    if (compareSecondBuild) assert.deepEqual(snapshots[0], snapshots[1], 'two SQLite builds must have identical logical contents');
    return {
      logical_builds_compared: snapshots.length,
      ...(compareSecondBuild ? { deterministic_logical_contents: true } : {}),
      issue_223_records_directly_searchable: directlySearchable,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

// The reviewers' raw outputs are staged next to the candidate inventory under
// ignored data/reference. Only batches that require reviewer checks (B06 on)
// have them, and the local-evidence mode requires them to be present.
async function stagedRawArtifact(candidateReview, verifyLocalCorpusEvidence, selfCheck = false) {
  if (!verifyLocalCorpusEvidence) return null;
  const { ordinal } = parseIssue223BatchId(candidateReview.batch_id);
  if (ordinal < REVIEWER_CHECK_FIRST_BATCH) return null;
  if (selfCheck) return null;
  const inventoryPath = path.resolve(ROOT, candidateReview.source_artifacts.candidate_inventory_path);
  const stagedPath = path.join(path.dirname(inventoryPath), 'reviewer-raw-outputs.json');
  assert.ok(await fileExists(stagedPath), `${candidateReview.batch_id} staged reviewer raw outputs are missing: ${path.relative(ROOT, stagedPath)}`);
  return JSON.parse(await readFile(stagedPath, 'utf8'));
}

export async function validateIssue223({ verifyLocalCorpusEvidence = true, validatePreviousIssue = true, compareSecondBuild = true, rebuildDatabase = true } = {}) {
  const currentCanonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const batches = await validateCorpusBatches(currentCanonical, { verifyLocalCorpusEvidence });
  const semanticQaArtifactPath = path.join(BATCH_DIRECTORY, 'issue-223-b01-b04-semantic-qa.json');
  const semanticQaArtifact = JSON.parse(await readFile(semanticQaArtifactPath, 'utf8'));
  const semanticQaCoverage = validateIssue223SemanticQaArtifact(semanticQaArtifact, batches);
  const issue223Imports = batches.flatMap(({ importRecords }) => importRecords);
  const issue223ImportIds = new Set(issue223Imports.map(({ id }) => id));
  assert.equal(issue223ImportIds.size, issue223Imports.length, 'Issue #223 canonical record IDs are unique');
  const rootDecisionSource = await readSemanticDecisionSourceArtifact(ROOT_SEMANTIC_SOURCE_PATH);
  const currentDigest = canonicalRecordsSha256(currentCanonical.records);
  assert.equal(rootDecisionSource.source.canonical_records_sha256, currentDigest, 'complete canonical semantic decision source digest');
  const batchDecisionSources = await readAuthoredBatchDecisionSources();
  const issue223BaseRecords = currentCanonical.records.filter((recordInfo) => !issue223ImportIds.has(recordOf(recordInfo).id));
  const semanticAudit = buildSemanticAuditFromDecisionSource(currentCanonical.records, rootDecisionSource, {
    artifactId: 'issue-223-complete-canonical-semantic-audit',
    baseRecords: issue223BaseRecords,
    batchDecisionSources,
  });
  const admissionContext = createSharedAdmissionContext(currentCanonical, semanticAudit, {
    canonicalDirectory: DEFAULT_CANONICAL_DIRECTORY,
  });
  assert.equal(semanticAudit.record_count, currentCanonical.records.length, 'Issue #223 semantic audit covers every canonical record');
  assert.equal(semanticAudit.coverage.record_count, semanticAudit.record_count, 'Issue #223 semantic coverage record count is complete');
  assert.equal(semanticAudit.coverage.sense_count, semanticAudit.sense_count, 'Issue #223 semantic coverage sense count is complete');

  const productionResults = batches.filter((batch) => !batch.reviewOnly).map((batch) => {
    const batchImportIds = new Set(batch.importRecords.map(({ id }) => id));
    const baseRecords = currentCanonical.records.filter((recordInfo) => !batchImportIds.has(recordOf(recordInfo).id));
    const production = validateLexicalProduction({
      batchId: batch.batch_id,
      candidateRecords: batch.semanticSource.candidate_records,
      reviews: productionReviewRows(batch.identities, batch.semanticSource.candidate_records, batch.validatedSource, {
        semanticReviewSourcePath: batch.semanticPath,
        verificationPassId: batch.semanticSource.provenance.verification_pass_id,
      }),
      baseRecords,
      prospectiveRecords: currentCanonical.records,
      semanticAudit,
      canonicalContext: admissionContext,
      stageEvidence: productionStageEvidence({
        candidateSourceBytes: batch.candidateReviewBytes,
        semanticSourceBytes: batch.semanticSourceBytes,
        prospectiveRecords: currentCanonical.records,
        semanticAudit,
        issue: 223,
        batchId: batch.batch_id,
        generationPassId: batch.candidateReview.provenance.generation_pass_id,
        verificationPassId: batch.semanticSource.provenance.verification_pass_id,
        candidateSourcePath: batch.sourcePath,
        semanticSourcePath: batch.semanticPath,
      }),
      catalogCount: batch.semanticSource.candidate_records.length,
      expectedSelectedCount: batch.importRecords.length,
      candidateLabel: `Issue #223 ${batch.batch_id} corpus candidates`,
      reviewedLabel: `Issue #223 ${batch.batch_id} source-bound decisions`,
      prospectiveLabel: 'Issue #223 complete prospective canonical records',
    });
    assert.equal(production.admission?.audit?.blocking_finding_count, 0, `${batch.batch_id} shared lexical admission blockers`);
    assert.equal(production.admission?.semantic_audit?.coverage_complete, true, `${batch.batch_id} semantic coverage`);
    return { batch_id: batch.batch_id, blocking_findings: production.admission.audit.blocking_finding_count, semantic_coverage_complete: production.admission.semantic_audit.coverage_complete };
  });

  assertCompleteRevisionChecksReused(admissionContext, productionResults.length);

  const currentRecords = currentCanonical.records.map(recordOf);
  const duplicateLemmas = new Map();
  for (const record of currentRecords) {
    const existing = duplicateLemmas.get(record.lemma);
    assert.equal(existing, undefined, `Canonical lemma ${record.lemma} must not have duplicate records (${existing ?? ''}, ${record.id})`);
    duplicateLemmas.set(record.lemma, record.id);
  }
  // Normal CI already builds and validates the shared SQLite artifact once;
  // rebuilding here is a manual/deep path (REVIEW.md).
  const deterministicBuild = rebuildDatabase ? await validateDeterministicBuild(issue223Imports, { compareSecondBuild }) : {};
  const previousIssue = validatePreviousIssue ? await validateIssue222({ verifyLocalCorpusEvidence }) : undefined;
  return {
    issue: 223,
    current_canonical_count: currentCanonical.records.length,
    current_canonical_sha256: currentDigest,
    issue_223_corpus_candidates: batches.reduce((sum, batch) => sum + batch.candidateCount, 0),
    issue_223_corpus_admitted: issue223Imports.length,
    issue_223_corpus_admit_decisions: batches.reduce((sum, batch) => sum + batch.candidateReview.decision_counts.admit, 0),
    issue_223_corpus_admit_deferred: batches.reduce((sum, batch) => sum + batch.deferredAdmitCount, 0),
    issue_223_corpus_held: batches.reduce((sum, batch) => sum + batch.heldCount, 0),
    issue_223_corpus_rejected: batches.reduce((sum, batch) => sum + batch.rejectedCount, 0),
    corpus_batches: batches.map(({ batch_id, candidateCount, candidateReview, admittedCount, deferredAdmitCount, heldCount, rejectedCount, reviewOnly }) => ({
      batch_id,
      candidate_count: candidateCount,
      candidate_admit_count: candidateReview.decision_counts.admit,
      admitted_count: admittedCount,
      deferred_admit_count: deferredAdmitCount,
      held_count: heldCount,
      rejected_count: rejectedCount,
      review_only: reviewOnly,
    })),
    historical_semantic_qa: semanticQaCoverage,
    semantic_coverage_complete: true,
    shared_admission: productionResults,
    duplicate_canonical_lemma_count: 0,
    ...deterministicBuild,
    previous_issue_222: previousIssue ? {
      admitted_count: previousIssue.admitted_count,
      directly_searchable_count: previousIssue.admitted_lemmas_directly_searchable,
      deterministic_logical_contents: previousIssue.deterministic_logical_contents,
    } : undefined,
  };
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  const verifyLocalCorpusEvidence = !process.argv.includes('--no-local-corpus-evidence');
  const validatePreviousIssue = !process.argv.includes('--skip-issue-222');
  const compareSecondBuild = true;
  const rebuildDatabase = !process.argv.includes('--no-build');
  validateIssue223({ verifyLocalCorpusEvidence, validatePreviousIssue, compareSecondBuild, rebuildDatabase })
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}
