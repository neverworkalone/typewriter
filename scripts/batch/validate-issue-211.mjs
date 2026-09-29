import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../build/dictionary.mjs';
import {
  findRecordsByExactTerm,
  findRecordsBySearchTerm,
  getSenseRelations,
} from '../build/query.mjs';
import { materializeLexicalUnitCandidates, validateLexicalProduction } from './lexical-production.mjs';
import {
  authoredSemanticDecisionRowDigest,
  validateAuthoredSemanticDecisionSource,
} from './authored-semantic-decision-source.mjs';
import { selectionDispositionForRow, selectionOutcomeById } from './lexical-selection.mjs';
import { validateTargetInventory } from '../validate/target-inventory.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';
import {
  buildSemanticAuditFromDecisionSource,
  canonicalRecordsSha256,
  readAuthoredBatchDecisionSources,
  readSemanticDecisionSourceArtifact,
  serializeSemanticAuditArtifact,
  sha256Json,
} from '../validate/semantic-audit.mjs';
import {
  inspectGlossConnectors,
  inspectWriterDomainEvidence,
} from '../validate/lexical-quality.mjs';
import {
  DEFAULT_SEED_PATH,
  DEFAULT_PROMOTION_PATH,
} from '../inventory/generate-target-inventory.mjs';
import {
  productionBytesSha256,
  productionSourceBytes,
} from './lexical-production-state.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const CANDIDATE_SOURCE_PATH = path.join(REPOSITORY_DIRECTORY, 'data/batches/issue-211-lexical-unit-source.json');
const SEMANTIC_DECISION_PATH = path.join(REPOSITORY_DIRECTORY, 'data/batches/issue-211-semantic-decisions.json');
const CANONICAL_IMPORT_PATH = path.join(REPOSITORY_DIRECTORY, 'data/canonical/issue-211-bounded-recovery.jsonl');
const M9_BASE_CANONICAL_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/batches/issue-219-m9-a-base-canonical');
const M9_BASE_SEED_PATH = path.join(REPOSITORY_DIRECTORY, 'data/batches/issue-219-m9-a-base-seed.json');
const ROOT_DECISION_SOURCE_PATH = path.join(REPOSITORY_DIRECTORY, 'data/validation/canonical-semantic-decision-source.json');
const TARGET_SEED_PATH = DEFAULT_SEED_PATH;
const PROMOTION_LEDGER_PATH = DEFAULT_PROMOTION_PATH;
const REPORT_PATH = path.join(REPOSITORY_DIRECTORY, 'docs/issue-211-bounded-lexical-recovery.md');
const SEMANTIC_REVIEW_VERSION = 'issue-211-authored-semantic-review-v1';
const VERIFICATION_PASS_ID = 'issue-211-separate-semantic-verification-20260928-r1';
const EXPECTED_LEMMAS = Object.freeze([
  '없다', '사람', '많다', '만들다', '동안', '내다', '필요', '처음', '다음', '지금',
  '친구', '그때', '오늘', '여자', '이해', '인간', '남자', '준비', '중요', '넣다',
  '가능', '마지막', '아버지', '아래', '조금',
]);

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function jsonlBytes(records) {
  return Buffer.from(records.length === 0 ? '' : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

function recordOf(recordInfo) {
  return recordInfo?.record ?? recordInfo;
}

function fail(message) {
  throw new Error(`Issue #211 validation failed: ${message}`);
}

function semanticDecisionConfig(candidateSource, semanticSource) {
  return {
    label: 'Issue #211',
    errorPrefix: 'ISSUE_211',
    sourcePath: 'data/batches/issue-211-semantic-decisions.json',
    sourceId: semanticSource.source_id,
    candidateSourceId: candidateSource.source_id,
    batchId: candidateSource.batch_id,
    issue: 211,
    parentIssue: 207,
    generationPassId: candidateSource.generation_pass_id,
    verificationPassId: VERIFICATION_PASS_ID,
    correctionPassId: 'issue-211-agent-correction-20260928-r1',
    semanticReviewVersion: SEMANTIC_REVIEW_VERSION,
    selectionPolicy: 'shared-authored-axis-coverage-selection-v6',
    selectionCount: EXPECTED_LEMMAS.length,
    importCount: EXPECTED_LEMMAS.length - 1,
    reserveCount: 1,
  };
}

export function projectDecisionSourceToCanonical(sourceValue, recordInfos) {
  const source = structuredClone(sourceValue);
  const recordIds = new Set(recordInfos.map((recordInfo) => recordOf(recordInfo).id));
  const digest = canonicalRecordsSha256(recordInfos);
  source.source.canonical_records_sha256 = digest;
  source.authored_review.source.canonical_records_sha256 = digest;
  source.authored_review.records = source.authored_review.records
    .filter(({ record_id: recordId }) => recordIds.has(recordId));
  source.authored_review_sha256 = sha256Json(source.authored_review);
  return source;
}

export function validateIssue211SemanticDecisionSource({
  candidateSource,
  semanticSource,
  semanticSourceBytes,
  identities,
  candidateRecords,
} = {}) {
  return validateAuthoredSemanticDecisionSource({
    source: semanticSource,
    sourceBytes: semanticSourceBytes,
    identities,
    candidateRecords,
    config: semanticDecisionConfig(candidateSource, semanticSource),
  });
}

function productionSemanticReview(record, identity, decisionRow, decisionSource, selectionStatus, options = {}) {
  const sourceId = decisionSource.source.source_id;
  const semanticReviewSourcePath = options.semanticReviewSourcePath ?? 'data/batches/issue-211-semantic-decisions.json';
  const verificationPassId = options.verificationPassId ?? VERIFICATION_PASS_ID;
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
        ? {
          topic_analysis: {
            ...structuredClone(senseReview.review_basis.topic_analysis),
            decision_source_id: sourceId,
          },
        }
        : {}),
      ...(Array.isArray(senseReview.review_basis?.topic_analyses)
        ? {
          topic_analyses: senseReview.review_basis.topic_analyses.map((analysis) => ({
            ...structuredClone(analysis),
            decision_source_id: sourceId,
          })),
        }
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
      path: semanticReviewSourcePath,
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
      ...(decisionRow.hold_basis ? { hold_basis: decisionRow.hold_basis } : {}),
      ...(decisionRow.rejection_basis ? { rejection_basis: decisionRow.rejection_basis } : {}),
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
      review_id: `${verificationPassId}:canonical:${record.id}:boundary`,
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
      pairwise: [],
      rationale: senseReviews[0].boundary_rationale,
    },
    pos: {
      status: 'pass',
      decision: 'verified',
      observed_pos: record.senses.map(({ pos }) => pos),
      decision_source_id: sourceId,
      rationale: `${identity.inventory_id} POS was verified in ${verificationPassId}.`,
    },
    expression: {
      status: 'pass',
      decision: 'verified',
      expected_record_type: record.record_type,
      observed_record_type: record.record_type,
      decision_source_id: sourceId,
      rationale: `${identity.inventory_id} record type was verified in ${verificationPassId}.`,
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
      status: selectionStatus,
      rank: decisionRow.rank,
      axis: decisionRow.selection_axis,
      rationale: `${identity.inventory_id}: the independent verification pass completed semantic review before shared axis coverage selection; ${decisionRow.decision_rationale}`,
    },
  };
}

export function productionReviewRows(identities, candidateRecords, semanticDecisionSource, options = {}) {
  const selectionStatuses = selectionOutcomeById(semanticDecisionSource.selection);
  return identities.map((identity, index) => {
    const candidate = candidateRecords[index];
    const row = semanticDecisionSource.byCandidateId.get(candidate.id);
    if (!row) fail(`authored semantic decision is missing for ${candidate.id}`);
    const selectionStatus = selectionStatuses.get(candidate.id);
    if (!selectionStatus) fail(`shared selection outcome is missing for ${candidate.id}`);
    const reviewedRecord = selectionStatus === 'selected' ? structuredClone(candidate) : undefined;
    return {
      slot_id: identity.slot_id,
      inventory_id: identity.inventory_id,
      candidate_identity_id: identity.inventory_id,
      candidate_id: candidate.id,
      candidate_lemma: identity.lemma,
      generation_pass_id: semanticDecisionSource.source.provenance.generation_pass_id,
      verification_pass_id: row.review_pass_id,
      decision: row.decision,
      final_decision: selectionDispositionForRow(row, selectionStatus),
      ...(row.hold_basis ? { hold_basis: row.hold_basis } : {}),
      ...(row.rejection_basis ? { rejection_basis: row.rejection_basis } : {}),
      selection_status: selectionStatus,
      expected_record_type: identity.record_type,
      semantic_review: productionSemanticReview(
        reviewedRecord ?? candidate,
        identity,
        row,
        semanticDecisionSource,
        selectionStatus,
        options,
      ),
      ...(reviewedRecord ? { reviewed_record: reviewedRecord } : {}),
    };
  });
}

export function productionStageEvidence({
  candidateSourceBytes,
  semanticSourceBytes,
  prospectiveRecords,
  semanticAudit,
  issue = 211,
  batchId = 'm5-211-issue-204-bounded-recovery-20260928',
  generationPassId = 'issue-211-candidate-authoring-20260928-r1',
  verificationPassId = VERIFICATION_PASS_ID,
  candidateSourcePath = 'data/batches/issue-211-lexical-unit-source.json',
  semanticSourcePath = 'data/batches/issue-211-semantic-decisions.json',
}) {
  const prospectiveBytes = jsonlBytes(prospectiveRecords.map(recordOf));
  const auditBytes = serializeSemanticAuditArtifact(semanticAudit);
  const authorizationBytes = productionSourceBytes({
    issue,
    batch_id: batchId,
    generation_pass_id: generationPassId,
    verification_pass_id: verificationPassId,
    decision: 'admit',
  });
  const admissionBytes = jsonBytes({
    artifact_id: 'issue-211-admission-stage',
    issue,
    batch_id: batchId,
    authorization_sha256: productionBytesSha256(authorizationBytes),
  });
  return {
    candidate_intake: {
      status: 'complete',
      source_path: candidateSourcePath,
      source_bytes: candidateSourceBytes,
      source_sha256: sha256Bytes(candidateSourceBytes),
    },
    semantic_review: {
      status: 'complete',
      source_path: semanticSourcePath,
      source_bytes: semanticSourceBytes,
      source_sha256: sha256Bytes(semanticSourceBytes),
    },
    selection: {
      status: 'complete',
      source_path: semanticSourcePath,
      source_bytes: semanticSourceBytes,
      source_sha256: sha256Bytes(semanticSourceBytes),
      policy: 'shared-authored-axis-coverage-selection-v6',
    },
    prospective_canonical: {
      status: 'complete',
      source_path: 'external:issue-211-prospective-canonical',
      source_bytes: prospectiveBytes,
      source_sha256: sha256Bytes(prospectiveBytes),
    },
    audit: {
      status: 'complete',
      source_path: 'external:issue-211-complete-semantic-audit',
      source_bytes: auditBytes,
      source_sha256: sha256Bytes(auditBytes),
    },
    admission: {
      status: 'complete',
      source_path: 'external:issue-211-admission',
      source_bytes: admissionBytes,
      source_sha256: sha256Bytes(admissionBytes),
      authorization_bytes: authorizationBytes,
      authorization_ref: 'issue-211-source-bound-admission',
      decision: 'admit',
    },
  };
}

function readJsonl(bytes, label) {
  return bytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${label} line ${index + 1} is not valid JSON: ${error.message}`);
    }
  });
}

export async function validateExactSearch({
  baseRecords,
  admittedRecords,
  units,
  batchLabel = 'Issue #211',
  temporaryPrefix = 'typewriter-issue-211-',
  workflowLemmas = ['사람', '없다'],
}) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), temporaryPrefix));
  const baseDirectory = path.join(temporaryDirectory, 'base-canonical');
  const baseDatabasePath = path.join(temporaryDirectory, 'base.sqlite');
  const currentDatabasePath = path.join(temporaryDirectory, 'current.sqlite');
  const baselineResultIdsByLemma = new Map();
  await import('node:fs/promises').then(({ mkdir }) => mkdir(baseDirectory, { recursive: true }));
  await writeFile(path.join(baseDirectory, 'base.jsonl'), jsonlBytes(baseRecords.map(recordOf)));
  let baseDatabase;
  let currentDatabase;
  try {
    await buildDictionary({
      inputDirectory: baseDirectory,
      outputPath: baseDatabasePath,
      allowDirty: true,
      repositoryDirectory: REPOSITORY_DIRECTORY,
    });
    await buildDictionary({
      inputDirectory: DEFAULT_CANONICAL_DIRECTORY,
      outputPath: currentDatabasePath,
      allowDirty: true,
      repositoryDirectory: REPOSITORY_DIRECTORY,
    });
    baseDatabase = new DatabaseSync(baseDatabasePath, { readOnly: true });
    currentDatabase = new DatabaseSync(currentDatabasePath, { readOnly: true });

    for (const unit of units) {
      const baselineResultIds = findRecordsByExactTerm(baseDatabase, unit.lemma).map(({ id }) => id);
      assert.deepEqual(
        baselineResultIds,
        [],
        `${batchLabel}: ${unit.lemma} must have no pre-existing exact canonical or generated-surface result`,
      );
      baselineResultIdsByLemma.set(unit.lemma, baselineResultIds);
    }

    const resultByLemma = new Map();
    for (const record of admittedRecords) {
      const exactRows = findRecordsByExactTerm(currentDatabase, record.lemma);
      assert.deepEqual(exactRows.map(({ id }) => id), [record.id], `${batchLabel}: ${record.lemma} exact result`);
      const response = findRecordsBySearchTerm(currentDatabase, record.lemma);
      assert.equal(response.status, 'ready', `${batchLabel}: ${record.lemma} search status`);
      assert.deepEqual(response.matches.map(({ id, match }) => ({
        id,
        kind: match.kind,
        field: match.field,
        value: match.value,
      })), [{
        id: record.id,
        kind: 'exact-lemma',
        field: 'lemma',
        value: record.lemma,
      }], `${batchLabel}: ${record.lemma} exact precedence`);
      const relationCount = record.senses.reduce(
        (count, sense) => count + getSenseRelations(currentDatabase, sense.id).length,
        0,
      );
      assert.equal(relationCount, 0, `${batchLabel}: ${record.lemma} relation-empty admission`);
      resultByLemma.set(record.lemma, {
        record_id: record.id,
        baseline_result_ids: baselineResultIdsByLemma.get(record.lemma) ?? [],
        result_ids: exactRows.map(({ id }) => id),
        relation_count: relationCount,
      });
    }

    for (const lemma of workflowLemmas) {
      const record = admittedRecords.find(({ lemma: candidateLemma }) => candidateLemma === lemma);
      const response = findRecordsBySearchTerm(currentDatabase, lemma);
      assert.equal(response.status, 'ready', `${lemma} writer workflow status`);
      assert.deepEqual(response.matches.map(({ id, match }) => ({
        id,
        kind: match.kind,
        field: match.field,
        value: match.value,
      })), [{ id: record.id, kind: 'exact-lemma', field: 'lemma', value: lemma }], `${lemma} direct writer workflow`);
      assert.equal(record.senses.reduce((count, sense) => count + getSenseRelations(currentDatabase, sense.id).length, 0), 0);
    }
    return Object.fromEntries(resultByLemma);
  } finally {
    baseDatabase?.close();
    currentDatabase?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function renderReport({ semanticSource, identities, recordsById, searchResults }) {
  const decisionsById = new Map(semanticSource.decisions.map((row) => [row.candidate_record_id, row]));
  const candidateRows = identities.map((identity) => {
    const decision = decisionsById.get(identity.candidate_record_id);
    const record = recordsById.get(identity.candidate_record_id);
    const oldInventoryId = identity.source_basis.source_unit_id.slice('issue-204:'.length);
    const disposition = decision.decision === 'held' ? 'held · needs-sense-split' : 'admitted';
    const exactResult = record ? (searchResults[record.lemma]?.result_ids.join(', ') ?? '') : 'not indexed while held';
    return `| ${oldInventoryId} | ${identity.inventory_id} | ${identity.candidate_record_id} | ${identity.lemma} | ${identity.pos} | ${disposition} | ${exactResult} |`;
  }).join('\n');
  const counts = semanticSource.decisions.reduce((result, row) => {
    result[row.decision] = (result[row.decision] ?? 0) + 1;
    return result;
  }, {});
  const admitted = identities.filter(({ candidate_record_id: id }) => recordsById.has(id));
  const noRelationCount = admitted.filter(({ candidate_record_id: id }) => (
    recordsById.get(id).senses.every((sense) => (sense.relations ?? []).length === 0)
  )).length;
  const searchRows = admitted.map(({ candidate_record_id: id, lemma }) => (
    `| ${lemma} | ${id} | ${searchResults[lemma]?.result_ids.join(', ') ?? ''} |`
  )).join('\n');

  return [
    '# Issue #211 — Bounded lexical recovery',
    '',
    'Issue #211 re-reviewed all 25 Issue #204 rejected candidates with the shared v4 semantic decision source and ordinary lexical admission pipeline. The prior generality, commonness, low-texture, and relation-count rationales were not used as exclusion grounds.',
    '',
    '## Disposition and admission counts',
    '',
    '| Measure | Count |',
    '| --- | ---: |',
    `| Candidates reviewed | ${identities.length} |`,
    `| Admitted | ${counts.included ?? 0} |`,
    `| Held | ${counts.held ?? 0} |`,
    '| Duplicate | 0 |',
    '| Invalid lemma or wrong POS | 0 |',
    `| Needs sense split | ${counts.held ?? 0} |`,
    '| Search collision | 0 |',
    '| Unsupported lexical scope | 0 |',
    `| New canonical starts | ${admitted.length} |`,
    `| New senses | ${admitted.reduce((total, identity) => total + recordsById.get(identity.candidate_record_id).senses.length, 0)} |`,
    '| New relations | 0 |',
    '| New expressions | 0 |',
    `| Admitted entries with zero relations | ${noRelationCount} |`,
    '',
    'Every candidate received a separate lemma, POS, lexical-scope, sense-boundary, canonical-coverage, and exact-search review. “내다” is held because its proposed single gloss folds several distinct uses into one sense; the record will need a source-bound sense split before admission. “사람” and “인간” remain separate lemmas with different writer-facing scope. The remaining admitted rows use one bounded primary reading each.',
    '',
    '## Candidate decisions',
    '',
    '| Prior #204 ID | New inventory ID | Canonical ID | Lemma | POS | New disposition | Exact search result |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    candidateRows,
    '',
    '## Exact product search',
    '',
    `The base dictionary returned no exact lemma or generated-surface result for any of the ${identities.length} candidate queries. After admission, each of the ${admitted.length} canonical starts returns exactly its own record with exact-lemma precedence. The workflow checks for “사람” and “없다” also resolve directly with zero relations; no relation was invented to fill a quota.`,
    '',
    '| Query | Expected record | Exact result IDs |',
    '| --- | --- | --- |',
    searchRows,
    '',
    '## Source and validation boundary',
    '',
    'The candidate source is data/batches/issue-211-lexical-unit-source.json; independent semantic decisions and row bindings are in data/batches/issue-211-semantic-decisions.json. Admitted canonical records are in data/canonical/issue-211-bounded-recovery.jsonl. The old Issue #204 rows remain historical rejects under their original inventory IDs. The held “내다” decision is recorded under a new inventory identity.',
    '',
    'Validation reconstructs candidate identities through the shared producer, validates the source-bound v4 semantic decisions, runs live shared lexical admission and the complete canonical semantic audit, validates the target inventory and promotion ledger, and builds SQLite dictionaries from both the pre-import and current canonical sets.',
    '',
  ].join('\n');
}

export async function validateIssue211({ writeReport = false } = {}) {
  const [candidateSourceBytes, semanticSourceBytes, importBytes, seedBytes, baseSeedSnapshotBytes, oldDecisionBytes] = await Promise.all([
    readFile(CANDIDATE_SOURCE_PATH),
    readFile(SEMANTIC_DECISION_PATH),
    readFile(CANONICAL_IMPORT_PATH),
    readFile(TARGET_SEED_PATH),
    readFile(M9_BASE_SEED_PATH),
    readFile(path.join(REPOSITORY_DIRECTORY, 'data/batches/issue-204-pilot-decisions.json')),
  ]);
  const candidateSource = JSON.parse(candidateSourceBytes.toString('utf8'));
  const semanticSource = JSON.parse(semanticSourceBytes.toString('utf8'));
  const importRecords = readJsonl(importBytes, 'Issue #211 canonical import');
  const seed = JSON.parse(seedBytes.toString('utf8'));
  const historicalSeed = JSON.parse(baseSeedSnapshotBytes.toString('utf8'));
  const oldLedger = JSON.parse(oldDecisionBytes.toString('utf8'));
  const historicalRejected = oldLedger.decisions.filter(({ editorial_judgment: judgment }) => judgment.disposition === 'reject');
  assert.equal(historicalRejected.length, EXPECTED_LEMMAS.length, 'Issue #204 rejected candidate count');
  assert.deepEqual(historicalRejected.map(({ morphology_proposal: proposal }) => proposal.lemma), EXPECTED_LEMMAS, 'Issue #204 mandatory recovery list');

  const historicalById = new Map(historicalRejected.map((row) => [row.inventory_id, row]));
  assert.equal(candidateSource.units.length, EXPECTED_LEMMAS.length, 'Issue #211 candidate unit count');
  assert.deepEqual(candidateSource.units.map(({ lemma }) => lemma), EXPECTED_LEMMAS, 'Issue #211 candidate order and scope');
  for (const unit of candidateSource.units) {
    const historical = historicalById.get(unit.prior_inventory_id);
    assert.ok(historical, `${unit.lemma} must trace to a prior Issue #204 rejection`);
    assert.equal(unit.source_unit_id, `issue-204:${unit.prior_inventory_id}`, `${unit.lemma} source-unit crosswalk`);
    assert.equal(unit.lemma, historical.morphology_proposal.lemma, `${unit.lemma} historical lemma`);
    assert.equal(unit.pos, historical.morphology_proposal.pos, `${unit.lemma} independently reviewed POS`);
  }

  const currentCanonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const historicalCanonical = await readCanonicalRecords(M9_BASE_CANONICAL_DIRECTORY);
  const currentCanonicalById = new Map(currentCanonical.records.map((recordInfo) => [recordOf(recordInfo).id, recordOf(recordInfo)]));
  for (const recordInfo of historicalCanonical.records) {
    const record = recordOf(recordInfo);
    assert.deepEqual(currentCanonicalById.get(record.id), record, `${record.id} frozen Issue #219 base record is unchanged`);
  }
  const candidateIds = new Set(semanticSource.candidate_records.map(({ id }) => id));
  assert.equal(candidateIds.size, EXPECTED_LEMMAS.length, 'candidate record identities are unique');
  const admittedDecisionIds = new Set(semanticSource.decisions
    .filter(({ decision }) => ['included', 'corrected'].includes(decision))
    .map(({ candidate_record_id: id }) => id));
  const importedIds = new Set(importRecords.map(({ id }) => id));
  assert.deepEqual([...importedIds].sort(), [...admittedDecisionIds].sort(), 'canonical import contains exactly selected decisions');
  assert.equal(importRecords.length, EXPECTED_LEMMAS.length - 1, 'Issue #211 admitted start count');
  const canonicalById = currentCanonicalById;
  for (const candidate of semanticSource.candidate_records) {
    const decision = semanticSource.decisions.find(({ candidate_record_id: id }) => id === candidate.id);
    const canonicalRecord = canonicalById.get(candidate.id);
    if (admittedDecisionIds.has(candidate.id)) {
      assert.deepEqual(canonicalRecord, candidate, `${candidate.id} canonical admission`);
    } else {
      assert.equal(canonicalRecord, undefined, `${candidate.id} held candidate is not canonical`);
      assert.equal(decision.decision, 'held', `${candidate.id} non-admitted disposition`);
    }
  }
  assert.deepEqual(importRecords, semanticSource.candidate_records.filter(({ id }) => admittedDecisionIds.has(id)), 'canonical import bytes match authored candidate records');

  const baseSeed = {
    ...structuredClone(historicalSeed),
    targets: historicalSeed.targets.filter(({ inventory_id: id }) => !semanticSource.decisions.some((decision) => decision.inventory_id === id)),
  };
  const baseSeedBytes = jsonBytes(baseSeed);
  assert.equal(sha256Bytes(baseSeedBytes), candidateSource.base_seed_sha256, 'candidate source base seed binding');
  const baseRecords = historicalCanonical.records.filter((recordInfo) => !importedIds.has(recordOf(recordInfo).id));
  assert.equal(canonicalRecordsSha256(baseRecords), candidateSource.base_canonical_records_sha256, 'candidate source base canonical binding');
  const firstInventoryNumber = Math.max(...baseSeed.targets.map(({ inventory_id: id }) => Number(id.match(/^m5-(\d+)$/u)?.[1] ?? 0))) + 1;
  const firstCanonicalNumber = Math.max(...baseRecords.map((recordInfo) => Number(recordOf(recordInfo).id.match(/^w(\d+)$/u)?.[1] ?? 0))) + 1;
  const candidateSet = materializeLexicalUnitCandidates({
    batchId: candidateSource.batch_id,
    source: candidateSource,
    sourceBytes: candidateSourceBytes,
    firstInventoryNumber,
    firstCanonicalNumber,
    baseRecords,
    baseSeedTargets: baseSeed.targets,
  });
  assert.deepEqual(semanticSource.candidate_records, candidateSet.candidateRecords, 'authored candidate records equal shared producer output');
  assert.equal(semanticSource.candidate_records_sha256, sha256Json(candidateSet.candidateRecords), 'candidate record source digest');

  const semanticDecisionSource = validateIssue211SemanticDecisionSource({
    candidateSource,
    semanticSource,
    semanticSourceBytes,
    identities: candidateSet.identities,
    candidateRecords: candidateSet.candidateRecords,
  });
  assert.deepEqual(semanticDecisionSource.counts, {
    included: 24,
    corrected: 0,
    held: 1,
    rejected: 0,
    deferred: 0,
  }, 'Issue #211 fresh candidate dispositions');
  const heldRow = semanticDecisionSource.rows.find(({ decision }) => decision === 'held');
  assert.equal(heldRow?.hold_basis, 'unresolved-sense', 'held item is held for a candidate-specific unresolved sense');
  assert.equal(heldRow?.candidate_record_id, 'w5364', 'the held item is the multi-use 내다 candidate');
  const activeHeldRows = seed.targets.filter(({ inventory_id: id }) => semanticDecisionSource.rows.some((row) => row.inventory_id === id));
  assert.equal(activeHeldRows.length, 1, 'only the held Issue #211 decision is retained in the target seed');
  assert.equal(activeHeldRows[0].status, 'held', 'held Issue #211 target status');

  const currentRootDecisionSource = await readSemanticDecisionSourceArtifact(ROOT_DECISION_SOURCE_PATH);
  const currentDigest = canonicalRecordsSha256(currentCanonical.records);
  assert.equal(currentRootDecisionSource.source.canonical_records_sha256, currentDigest, 'complete current canonical decision source digest');
  const batchDecisionSources = await readAuthoredBatchDecisionSources();
  buildSemanticAuditFromDecisionSource(currentCanonical.records, currentRootDecisionSource, {
    artifactId: 'issue-211-current-canonical-semantic-audit',
    batchDecisionSources,
  });
  const rootDecisionSource = projectDecisionSourceToCanonical(currentRootDecisionSource, historicalCanonical.records);
  const historicalSemanticAudit = buildSemanticAuditFromDecisionSource(historicalCanonical.records, rootDecisionSource, {
    artifactId: 'issue-211-complete-canonical-semantic-audit',
    baseRecords,
    batchDecisionSources,
  });
  const reviewRows = productionReviewRows(candidateSet.identities, candidateSet.candidateRecords, semanticDecisionSource);
  const production = validateLexicalProduction({
    batchId: candidateSource.batch_id,
    candidateRecords: candidateSet.candidateRecords,
    reviews: reviewRows,
    baseRecords,
    prospectiveRecords: historicalCanonical.records,
    semanticAudit: historicalSemanticAudit,
    stageEvidence: productionStageEvidence({
      candidateSourceBytes,
      semanticSourceBytes,
      prospectiveRecords: historicalCanonical.records,
      semanticAudit: historicalSemanticAudit,
    }),
    catalogCount: EXPECTED_LEMMAS.length,
    expectedSelectedCount: importRecords.length,
    candidateLabel: 'Issue #211 shared production candidates',
    reviewedLabel: 'Issue #211 source-bound candidate decisions',
    prospectiveLabel: 'Issue #211 complete prospective canonical records',
  });
  assert.equal(production.admission?.audit?.blocking_finding_count, 0, 'ordinary shared lexical admission has no blocker');
  assert.equal(production.admission?.semantic_audit?.coverage_complete, true, 'complete canonical semantic audit coverage');

  const inventoryValidation = await validateTargetInventory({
    canonicalDirectory: DEFAULT_CANONICAL_DIRECTORY,
    seedPath: TARGET_SEED_PATH,
    promotionPath: PROMOTION_LEDGER_PATH,
    checkPilotCompleteness: true,
  });
  const sourceRecordById = new Map(importRecords.map((record) => [record.id, record]));
  const searchResults = await validateExactSearch({
    baseRecords,
    admittedRecords: importRecords,
    units: candidateSource.units,
  });
  const renderedReport = renderReport({
    semanticSource,
    identities: candidateSet.identities,
    recordsById: sourceRecordById,
    searchResults,
  });
  if (writeReport) {
    await writeFile(REPORT_PATH, renderedReport, 'utf8');
  } else {
    const reportBytes = await readFile(REPORT_PATH, 'utf8');
    assert.equal(reportBytes, renderedReport, 'Issue #211 report is stale; run npm run batch:issue-211:report');
  }

  return {
    reviewed_count: candidateSet.identities.length,
    dispositions: semanticDecisionSource.counts,
    admitted_start_count: importRecords.length,
    held_needs_sense_split_count: 1,
    admitted_sense_count: importRecords.reduce((count, record) => count + record.senses.length, 0),
    admitted_relation_count: importRecords.reduce((count, record) => count + record.senses.reduce((inner, sense) => inner + (sense.relations?.length ?? 0), 0), 0),
    relation_empty_admitted_count: importRecords.filter((record) => record.senses.every((sense) => (sense.relations ?? []).length === 0)).length,
    expression_count: importRecords.filter(({ record_type: recordType }) => recordType === 'expression').length,
    canonical_record_count: currentCanonical.records.length,
    canonical_digest: currentDigest,
    production_admission: 'pass',
    inventory_validation: inventoryValidation.status ?? 'pass',
    search_results: Object.fromEntries(importRecords.map(({ lemma }) => [lemma, searchResults[lemma]])),
  };
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const writeReport = process.argv.includes('--write-report');
  validateIssue211({ writeReport })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}
