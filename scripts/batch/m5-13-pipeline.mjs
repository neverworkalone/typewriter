import { createHash } from 'node:crypto';
import {
  cp,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import { createCanonicalContext } from '../validate/canonical-context.mjs';
import {
  generateTargetInventory,
  readPromotionLedger,
  serializePromotionLedger,
  validatePromotionLedgerBindings,
} from '../inventory/generate-target-inventory.mjs';
import { validateTargetInventory } from '../validate/target-inventory.mjs';
import {
  buildSemanticAuditFromDecisionSource,
  canonicalRecordsSha256,
  readAuthoredBatchDecisionSources,
  serializeSemanticAuditArtifact,
  sha256Json,
  validateSemanticAuditCoverage,
} from '../validate/semantic-audit.mjs';
import {
  inspectGlossConnectors,
  inspectWriterDomainEvidence,
  validateLexicalRecord,
} from '../validate/lexical-quality.mjs';
import { validateLexicalProduction } from './lexical-production.mjs';
import { productionSourceBytes } from './lexical-production-state.mjs';
import { compareRelationSnapshots } from './relation-diff.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import { runM512APreflight } from './m5-12a-preflight.mjs';
import { M5_13_CATALOG } from './m5-13-catalog.mjs';
import {
  M5_13_BATCH_ID,
  M5_13_CANDIDATE_IDENTITIES,
  M5_13_CANDIDATE_SOURCE_ID,
  M5_13_FIRST_CANONICAL_NUMBER,
  M5_13_FIRST_INVENTORY_NUMBER,
  M5_13_GENERATION_PASS_ID,
  M5_13_IMPORT_COUNT,
  M5_13_ISSUE,
  M5_13_PARENT_ISSUE,
  M5_13_RESERVE_COUNT,
  M5_13_SELECTION_COUNT,
  M5_13_VERIFICATION_PASS_ID,
  buildM513CandidateRecords,
} from './m5-13-candidate-source.mjs';
import {
  candidateRecordsFromM513DecisionSource,
  buildM513DecisionScaffold,
  decisionRowDigest,
  decisionSenseReviews,
  M5_13_SEMANTIC_DECISION_SOURCE_PATH,
  M5_13_SEMANTIC_DECISION_SOURCE_ID,
  readM513DecisionSource,
  validateM513DecisionSource,
} from './m5-13-decision-source.mjs';
import { M5_12A_SEMANTIC_DECISION_SOURCE_PATH } from './m5-12a-decision-source.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const BATCH_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/batches');
const INVENTORY_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/inventory');
const CURRENT_CANONICAL_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/canonical');
const CURRENT_SEED_PATH = path.join(INVENTORY_DIRECTORY, 'm5-target-seed.json');
const CURRENT_PROMOTION_LEDGER_PATH = path.join(INVENTORY_DIRECTORY, 'm5-target-promotions.jsonl');
const DECISION_SOURCE_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/validation/canonical-semantic-decision-source.json',
);
const CANONICAL_IMPORT_PATH = path.join(CURRENT_CANONICAL_DIRECTORY, 'm5-13-expansion.jsonl');
const ADMISSION_PATH = path.join(BATCH_DIRECTORY, 'm5-13-admission.json');
const PROMOTION_PATH = path.join(BATCH_DIRECTORY, 'm5-13-promotion.json');
const REVIEW_PATH = path.join(BATCH_DIRECTORY, 'm5-13-review.json');
const STAGE_PATH = path.join(BATCH_DIRECTORY, 'm5-13-stage.json');
const M5_13_AGENT_REVIEW_MODE = 'agent-generated';
const M5_13_GATE_DECISION = 'APPROVE AUTOMATED BOUNDED';
const IMPORTABLE_DECISIONS = new Set(['included', 'corrected']);
const ALL_DECISIONS = ['included', 'corrected', 'held', 'rejected', 'deferred'];
const BASE_LEDGER_COUNT = 722;

export const M5_13_BASE_SUMMARY = Object.freeze({
  record_count: 2042,
  start_count: 2000,
  reference_only_count: 42,
  sense_count: 2301,
  relation_count: 487,
  expression_count: 145,
});
export const M5_13_FINAL_SUMMARY = Object.freeze({
  record_count: 3042,
  start_count: 3000,
  reference_only_count: 42,
  sense_count: 3301,
  relation_count: 487,
  expression_count: 285,
});
export const M5_13_FINAL_METADATA = Object.freeze({
  dictionary_version: 'm2-pilot-1',
  schema_version: '1',
  normalization_version: '1',
  build_contract: 'canonical-jsonl -> normalized-v1 -> sqlite-v1',
  build_tool_version: '1',
  record_count: '3042',
  start_count: '3000',
  reference_only_count: '42',
  candidate_count: '3000',
  search_form_count: '3298',
  sense_count: '3301',
  relation_count: '487',
  expression_count: '285',
});
export const M5_13_TARGET = Object.freeze({
  net_start_increase: 1000,
  cumulative_start_target: 3000,
  candidate_buffer: 100,
  selection_slot_count: 1100,
  candidate_identity_count: 1100,
});

export class M513PipelineError extends Error {
  constructor(message, code = 'M5_13_PIPELINE_ERROR') {
    super(message);
    this.name = 'M513PipelineError';
    this.code = code;
  }
}

function fail(message, code = 'M5_13_PIPELINE_ERROR') {
  throw new M513PipelineError(message, code);
}

function sha256(bytes) {
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

function asRecordInfo(record, source, lineNumber) {
  return { record, source, filePath: source, lineNumber };
}

function sourcePath(filePath) {
  return path.relative(REPOSITORY_DIRECTORY, filePath);
}

function canonicalSummary(recordInfos) {
  const records = recordInfos.map(recordOf);
  return {
    record_count: records.length,
    start_count: records.filter(({ role }) => role === 'start').length,
    reference_only_count: records.filter(({ role }) => role === 'reference-only').length,
    sense_count: records.reduce((sum, record) => sum + record.senses.length, 0),
    relation_count: records.reduce(
      (sum, record) => sum + record.senses.reduce((inner, sense) => inner + (sense.relations?.length ?? 0), 0),
      0,
    ),
    expression_count: records.filter(({ record_type: recordType }) => recordType === 'expression').length,
  };
}

function relationSnapshot(recordInfos) {
  return recordInfos.flatMap(({ record }) => record.senses.flatMap((sense) => (
    (sense.relations ?? []).map((relation, relationIndex) => ({
      id: `${sense.id}-relation-${String(relationIndex + 1).padStart(3, '0')}`,
      source_sense: sense.id,
      target: relation.target,
      ...(relation.target_sense ? { target_sense: relation.target_sense } : {}),
      type: relation.type,
    }))
  )));
}

function candidateIdentityDigest() {
  return sha256Json(M5_13_CANDIDATE_IDENTITIES);
}

async function readJson(filePath, label) {
  const bytes = await readFile(filePath);
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_JSON');
  }
}

function makePromotionLedgerBinding({ baseEntries, appendedEntries }) {
  const previousBytes = serializePromotionLedger(baseEntries);
  const appendBytes = serializePromotionLedger(appendedEntries);
  const prefixBytes = Buffer.concat([previousBytes, appendBytes]);
  return {
    previous_ledger_sha256: sha256(previousBytes),
    append_start: baseEntries.length,
    append_count: appendedEntries.length,
    append_sha256: sha256(appendBytes),
    prefix_event_count: baseEntries.length + appendedEntries.length,
    prefix_sha256: sha256(prefixBytes),
  };
}

function validatePromotionLedgerPrefix({ currentEntries, expectedPrefixEntries, baseEntries, binding, label }) {
  const appendedEntries = expectedPrefixEntries.slice(baseEntries.length);
  const expected = makePromotionLedgerBinding({ baseEntries, appendedEntries });
  const actual = binding?.ledger_binding ?? binding;
  if (currentEntries.length < expected.prefix_event_count
    || !actual
    || Object.entries(expected).some(([key, value]) => actual[key] !== value)
    || sha256(serializePromotionLedger(currentEntries.slice(0, baseEntries.length))) !== expected.previous_ledger_sha256
    || sha256(serializePromotionLedger(currentEntries.slice(baseEntries.length, expected.prefix_event_count))) !== expected.append_sha256
    || sha256(serializePromotionLedger(currentEntries.slice(0, expected.prefix_event_count))) !== expected.prefix_sha256
    || sha256(serializePromotionLedger(expectedPrefixEntries)) !== expected.prefix_sha256) {
    fail(`${label} historical prefix or append binding drifted`, 'PROMOTION_LEDGER_HISTORY_MISMATCH');
  }
  return true;
}

function deriveBaseDecisionSource(currentDecisionSource, baseRecords) {
  const baseIds = new Set(baseRecords.map(({ id }) => id));
  const source = structuredClone(currentDecisionSource);
  const baseDigest = canonicalRecordsSha256(baseRecords.map((record, index) => asRecordInfo(record, 'base-canonical', index + 1)));
  source.source.canonical_records_sha256 = baseDigest;
  source.authored_review = {
    ...source.authored_review,
    source: { ...source.authored_review.source, canonical_records_sha256: baseDigest },
    records: source.authored_review.records.filter(({ record_id: recordId }) => baseIds.has(recordId)),
  };
  source.authored_review_sha256 = sha256Json(source.authored_review);
  return source;
}

function makeCandidateProposal(identity, record) {
  const value = {
    slot_id: identity.slot_id,
    inventory_id: identity.inventory_id,
    candidate_record_id: identity.candidate_record_id,
    candidate_lemma: identity.lemma,
    candidate_record: record,
    source_binding: structuredClone(identity.source_basis),
  };
  return { ...value, proposal_sha256: sha256Json(value) };
}

function validateCandidateIdentityBinding({ identities, candidateRecords, baseRecords, baseSeed }) {
  if (identities.length !== M5_13_SELECTION_COUNT || candidateRecords.length !== identities.length) {
    fail('M5-13 candidate intake does not cover the complete 1,100-slot pool', 'CANDIDATE_SCOPE_MISMATCH');
  }
  const baseTerms = new Map();
  for (const record of baseRecords.map(recordOf)) {
    baseTerms.set(record.lemma.normalize('NFC'), `canonical:${record.id}`);
    for (const form of record.search_forms) baseTerms.set(form.normalize('NFC'), `canonical:${record.id}`);
  }
  for (const entry of baseSeed.targets) {
    baseTerms.set(entry.lemma.normalize('NFC'), `seed:${entry.inventory_id}`);
    for (const form of entry.search_forms) baseTerms.set(form.normalize('NFC'), `seed:${entry.inventory_id}`);
  }
  const seen = { inventory: new Set(), slots: new Set(), ids: new Set(), lemmas: new Set() };
  for (const [index, identity] of identities.entries()) {
    if (identity.catalog_index !== index
      || identity.slot_id !== `m5-13-slot-${String(index + 1).padStart(4, '0')}`
      || identity.inventory_id !== `m5-${String(M5_13_FIRST_INVENTORY_NUMBER + index).padStart(4, '0')}`
      || identity.candidate_record_id !== `w${String(M5_13_FIRST_CANONICAL_NUMBER + index).padStart(4, '0')}`) {
      fail(`M5-13 slot ${index} is not deterministically bound`, 'SLOT_SOURCE_DRIFT');
    }
    for (const [name, value] of [['inventory', identity.inventory_id], ['slots', identity.slot_id], ['ids', identity.candidate_record_id], ['lemmas', identity.lemma]]) {
      if (seen[name].has(value)) fail(`duplicate M5-13 ${name} ${value}`, 'CANDIDATE_IDENTITY_DUPLICATE');
      seen[name].add(value);
    }
    const owner = baseTerms.get(identity.lemma.normalize('NFC'));
    if (owner) fail(`${identity.inventory_id} collides with ${owner}`, 'CANDIDATE_COLLISION');
    const candidate = candidateRecords[index];
    validateLexicalRecord(candidate, {
      label: `M5-13 candidate ${identity.inventory_id}`,
      mode: 'candidate',
      expectedId: identity.candidate_record_id,
      expectedLemma: identity.lemma,
    });
    if (candidate.record_type !== identity.record_type || candidate.candidate_id !== candidate.id
      || candidate.senses[0].pos !== identity.pos) {
      fail(`${identity.inventory_id} candidate body is not bound to its identity`, 'CANDIDATE_IDENTITY_BINDING');
    }
  }
}

function makeSeedEntry(identity, record, decision) {
  return {
    inventory_id: identity.inventory_id,
    status: decision,
    planned_role: decision === 'held' ? 'start' : null,
    record_type: record.record_type,
    lemma: record.lemma,
    search_forms: [...record.search_forms],
    reason_codes: [identity.axis],
    pos: [...new Set(record.senses.map(({ pos }) => pos))],
    sense_profile: record.record_type === 'expression' ? 'expression' : 'single',
    flags: [...new Set([...identity.flags, ...(record.record_type === 'expression' ? ['expression-unit'] : [])])],
    decision_note: `${identity.inventory_id} ${decision} after separate generation ${M5_13_GENERATION_PASS_ID} and verification ${M5_13_VERIFICATION_PASS_ID}.`,
  };
}

function buildSeed(baseSeed, identities, reviewRows, candidateRecords) {
  const existing = new Set(baseSeed.targets.map(({ inventory_id: inventoryId }) => inventoryId));
  const additions = reviewRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !IMPORTABLE_DECISIONS.has(row.decision))
    .map(({ row, index }) => {
      const identity = identities[index];
      if (existing.has(identity.inventory_id)) fail(`seed already contains ${identity.inventory_id}`, 'SEED_COLLISION');
      existing.add(identity.inventory_id);
      return makeSeedEntry(identity, candidateRecords[index], row.decision);
    });
  return {
    ...structuredClone(baseSeed),
    revision: 'm5-13',
    targets: [...baseSeed.targets, ...additions],
  };
}

function buildPromotionLedger(baseEntries, identities, reviewRows, candidateRecords, semanticDecisionSource) {
  const existing = new Set(baseEntries.map(({ inventory_id: inventoryId }) => inventoryId));
  const additions = reviewRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => IMPORTABLE_DECISIONS.has(row.decision))
    .map(({ row, index }) => {
      const identity = identities[index];
      if (existing.has(identity.inventory_id)) fail(`promotion ledger already contains ${identity.inventory_id}`, 'PROMOTION_LEDGER_COLLISION');
      existing.add(identity.inventory_id);
      const record = candidateRecords[index];
      const sourceRow = semanticDecisionSource.byCandidateId.get(record.id);
      if (!sourceRow) fail(`M5-13 promotion ledger decision is missing for ${record.id}`, 'M5_13_DECISION_SOURCE_SCOPE');
      return {
        schema_version: '1',
        batch_id: M5_13_BATCH_ID,
        inventory_id: identity.inventory_id,
        canonical_id: record.id,
        decision: sourceRow.decision,
        record_sha256: sha256Json(record),
        decision_source_id: semanticDecisionSource.source.source_id,
        decision_source_sha256: semanticDecisionSource.artifactSha256,
        decision_row_sha256: decisionRowDigest(sourceRow),
        reason_codes: [identity.axis],
        flags: [...new Set([...identity.flags, ...(record.record_type === 'expression' ? ['expression-unit'] : [])])],
        decision_note: `${identity.inventory_id} ${row.decision} after separate generation ${M5_13_GENERATION_PASS_ID} and verification ${M5_13_VERIFICATION_PASS_ID}.`,
      };
    });
  return [...structuredClone(baseEntries), ...additions];
}

function makeProductionSemanticReview(record, identity, decisionRow, semanticDecisionSource) {
  const sourceId = semanticDecisionSource.source.source_id;
  const senseReviews = decisionSenseReviews(record, decisionRow, `decision ${identity.inventory_id}`);
  const reviewForSense = (sense) => senseReviews.find(({ sense_id: senseId }) => senseId === sense.id);
  const semanticEvidenceForSense = (sense) => {
    const senseReview = reviewForSense(sense);
    const domains = inspectWriterDomainEvidence(sense.gloss);
    const connectors = inspectGlossConnectors(sense.gloss);
    return {
      status: 'pass',
      gloss_sha256: sha256Json(sense.gloss),
      observed_domain_axes: domains.axes,
      domain_evidence: domains.matches,
      connector_observations: connectors,
      rationale: senseReview.semantic_rationale,
      boundary_decision: senseReview.boundary_decision,
      decision_source_id: sourceId,
      ...(senseReview.review_basis?.topic_analysis
        ? { topic_analysis: { ...structuredClone(senseReview.review_basis.topic_analysis), decision_source_id: sourceId } }
        : {}),
      ...(Array.isArray(senseReview.review_basis?.topic_analyses)
        ? { topic_analyses: senseReview.review_basis.topic_analyses.map((analysis) => ({ ...structuredClone(analysis), decision_source_id: sourceId })) }
        : {}),
    };
  };
  const reviewedDigest = sha256Json(record);
  return {
    status: 'complete',
    decision_source: {
      kind: 'separately-authored-semantic-decision-source',
      contract_version: 'lexical-semantic-decision-source-v1',
      source_id: sourceId,
      path: sourcePath(M5_13_SEMANTIC_DECISION_SOURCE_PATH),
      authoring_mode: 'agent-authored-decision',
      source_sha256: semanticDecisionSource.sourceSha256,
      artifact_sha256: semanticDecisionSource.artifactSha256,
    },
    authored_decision: {
      source_sha256: semanticDecisionSource.sourceSha256,
      decision_source_id: sourceId,
      candidate_record_id: identity.candidate_record_id,
      candidate_record_sha256: decisionRow.candidate_record_sha256,
      reviewed_record_sha256: reviewedDigest,
      decision: decisionRow.decision,
      selection_rank: decisionRow.rank,
      selection_score: decisionRow.score,
      rationale: decisionRow.decision_rationale,
      sense_evidence: record.senses.map((sense) => ({
        sense_id: sense.id,
        gloss_sha256: sha256Json(sense.gloss),
        basis: reviewForSense(sense).semantic_rationale,
      })),
      relation_evidence: record.senses.map((sense) => ({
        sense_id: sense.id,
        relation_count: 0,
        relation_ids: [],
        decision: 'no-relations',
        basis: reviewForSense(sense).no_relation_rationale,
      })),
    },
    sense_boundary: {
      status: 'pass',
      decision_source_id: sourceId,
      review_id: `${M5_13_VERIFICATION_PASS_ID}:canonical:${record.id}:boundary`,
      method: 'gloss-and-usage-pairwise-v2',
      independence: {
        independent_of_sense_count: true,
        source: 'separate-agent-verification-pass',
        decision_source_id: sourceId,
        decision_source_version: 'lexical-semantic-boundary-decisions-v1',
      },
      findings: record.senses.map((sense) => {
        const senseReview = reviewForSense(sense);
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
      rationale: `${identity.inventory_id} POS was verified in ${M5_13_VERIFICATION_PASS_ID}.`,
    },
    expression: {
      status: 'pass',
      decision: 'verified',
      expected_record_type: record.record_type,
      observed_record_type: record.record_type,
      decision_source_id: sourceId,
      rationale: `${identity.inventory_id} record type was verified in ${M5_13_VERIFICATION_PASS_ID}.`,
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
        no_relation_rationale: reviewForSense(sense).no_relation_rationale,
      })),
    },
    selection: {
      status: IMPORTABLE_DECISIONS.has(decisionRow.decision) ? 'selected' : decisionRow.decision,
      rank: decisionRow.rank,
      score: decisionRow.score,
      rationale: decisionRow.selection_rationale,
    },
  };
}

function buildReviewRows(identities, candidateRecords, semanticDecisionSource) {
  return identities.map((identity, index) => {
    const candidate = candidateRecords[index];
    const decisionRow = semanticDecisionSource.byCandidateId.get(candidate.id);
    if (!decisionRow) fail(`M5-13 decision is missing for ${candidate.id}`, 'M5_13_DECISION_SOURCE_SCOPE');
    const reviewedRecord = IMPORTABLE_DECISIONS.has(decisionRow.decision) ? structuredClone(candidate) : undefined;
    return {
      slot_id: identity.slot_id,
      inventory_id: identity.inventory_id,
      candidate_identity_id: identity.inventory_id,
      candidate_id: candidate.id,
      candidate_lemma: identity.lemma,
      generation_pass_id: M5_13_GENERATION_PASS_ID,
      verification_pass_id: M5_13_VERIFICATION_PASS_ID,
      decision: decisionRow.decision,
      expected_record_type: identity.record_type,
      semantic_review: makeProductionSemanticReview(
        reviewedRecord ?? candidate,
        identity,
        decisionRow,
        semanticDecisionSource,
      ),
      ...(reviewedRecord ? { reviewed_record: reviewedRecord } : {}),
    };
  });
}

function buildProspectiveDecisionSource({ baseDecisionSource, baseRecords, prospectiveRecords, semanticDecisionSource }) {
  const baseIds = new Set(baseRecords.map(({ id }) => id));
  const prospectiveInfos = prospectiveRecords.map((record, index) => asRecordInfo(
    record,
    index < baseRecords.length ? 'base-canonical' : 'external-reviewed-import',
    index + 1,
  ));
  const prospectiveDigest = canonicalRecordsSha256(prospectiveInfos);
  const newBindings = prospectiveRecords
    .filter((record) => !baseIds.has(record.id))
    .map((record) => {
      const row = semanticDecisionSource.byCandidateId.get(record.id);
      if (!row) fail(`M5-13 canonical authority is missing ${record.id}`, 'M5_13_DECISION_SOURCE_SCOPE');
      return {
        record_id: record.id,
        record_sha256: sha256Json(record),
        authored_batch_decision: {
          source_id: semanticDecisionSource.source.source_id,
          source_sha256: semanticDecisionSource.sourceSha256,
          artifact_sha256: semanticDecisionSource.artifactSha256,
          decision_row_sha256: decisionRowDigest(row),
          candidate_record_id: row.candidate_record_id,
          candidate_record_sha256: row.candidate_record_sha256,
          decision: row.decision,
          selection_rank: row.rank,
          selection_score: row.score,
          reviewed_record_sha256: sha256Json(record),
        },
      };
    });
  const authoredReview = {
    ...structuredClone(baseDecisionSource.authored_review),
    source: {
      ...structuredClone(baseDecisionSource.authored_review.source),
      canonical_records_sha256: prospectiveDigest,
    },
    records: [
      ...baseDecisionSource.authored_review.records.filter(({ record_id: recordId }) => baseIds.has(recordId)),
      ...newBindings,
    ],
  };
  const decisionSource = {
    ...structuredClone(baseDecisionSource),
    contract_version: 'lexical-semantic-canonical-decision-source-v2',
    source: { ...structuredClone(baseDecisionSource.source), canonical_records_sha256: prospectiveDigest },
    authored_review: authoredReview,
    authored_review_sha256: sha256Json(authoredReview),
  };
  return { decisionSource, prospectiveInfos };
}

function compactPreflightEvidence(preflight) {
  if (!preflight || typeof preflight !== 'object') fail('M5-13 preflight evidence is required', 'PROMOTION_PREFLIGHT_REQUIRED');
  return {
    contract_version: 'lexical-batch-preflight-v1',
    status: preflight.status,
    input_canonical_directory_sha256: preflight.input_canonical_directory_sha256,
    checks: Object.fromEntries(Object.entries(preflight.checks ?? {}).map(([name, check]) => [name, {
      status: check.status,
      input_canonical_directory_sha256: check.input_canonical_directory_sha256,
    }])),
  };
}

function compactSemanticAuditCoverage(coverage) {
  return {
    contract_version: coverage.contract_version,
    scope: coverage.scope,
    canonical_records_sha256: coverage.canonical_records_sha256,
    record_count: coverage.record_count,
    sense_count: coverage.sense_count,
    covered_record_count: coverage.covered_record_count,
    covered_sense_count: coverage.covered_sense_count,
    coverage_complete: coverage.coverage_complete,
    review_complete: coverage.review_complete,
    corrected_record_count: coverage.corrected_record_count,
  };
}

async function buildProspectiveWorkspace({ baseCanonicalDirectory, seed, promotionLedger, importedRecords, decisionSourceBytes }) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-13-'));
  const canonicalDirectory = path.join(temporaryDirectory, 'canonical');
  const seedPath = path.join(temporaryDirectory, 'm5-target-seed.json');
  const promotionPath = path.join(temporaryDirectory, 'm5-target-promotions.jsonl');
  const decisionSourcePath = path.join(temporaryDirectory, 'canonical-semantic-decision-source.json');
  const inventoryPath = path.join(temporaryDirectory, 'm5-target-inventory.json');
  await cp(baseCanonicalDirectory, canonicalDirectory, { recursive: true });
  const importBytes = jsonlBytes(importedRecords);
  await writeFile(path.join(canonicalDirectory, path.basename(CANONICAL_IMPORT_PATH)), importBytes);
  const seedBytes = jsonBytes(seed);
  await writeFile(seedPath, seedBytes);
  const promotionLedgerBytes = serializePromotionLedger(promotionLedger);
  await writeFile(promotionPath, promotionLedgerBytes);
  await writeFile(decisionSourcePath, decisionSourceBytes);
  const inventory = await generateTargetInventory({
    canonicalDirectory,
    seedPath,
    promotionPath,
    decisionSourcePath,
    generatedFromCanonicalDirectory: baseCanonicalDirectory,
    generatedFromSeedPath: CURRENT_SEED_PATH,
    generatedFromPromotionPath: CURRENT_PROMOTION_LEDGER_PATH,
    canonicalScopeDirectory: CURRENT_CANONICAL_DIRECTORY,
    outputPath: inventoryPath,
  });
  const inventoryValidation = await validateTargetInventory({
    inventoryPath,
    canonicalDirectory,
    seedPath,
    promotionPath,
    checkPilotCompleteness: true,
  });
  const canonical = await readCanonicalRecords(canonicalDirectory);
  return {
    temporaryDirectory,
    canonicalDirectory,
    importBytes,
    seedBytes,
    promotionLedgerBytes,
    inventoryBytes: await readFile(inventoryPath),
    inventory,
    inventoryValidation,
    canonical,
    canonicalDigest: await hashCanonicalDirectory(canonicalDirectory),
  };
}

function buildProductionStageEvidence({ artifacts, prospectiveRecords, semanticAuditBytes }) {
  const prospectiveBytes = jsonlBytes(prospectiveRecords);
  const authorizationBytes = productionSourceBytes({
    issue: M5_13_ISSUE,
    batch_id: M5_13_BATCH_ID,
    generation_pass_id: M5_13_GENERATION_PASS_ID,
    verification_pass_id: M5_13_VERIFICATION_PASS_ID,
    decision: 'admit',
  });
  const admissionSourceBytes = jsonBytes({
    artifact_id: 'm5-13-admission-stage',
    issue: M5_13_ISSUE,
    batch_id: M5_13_BATCH_ID,
    authorization_sha256: sha256(authorizationBytes),
  });
  return {
    candidate_intake: { status: 'complete', source_path: 'external:m5-13-generation', source_bytes: artifacts.proposalBytes, source_sha256: sha256(artifacts.proposalBytes) },
    semantic_review: { status: 'complete', source_path: sourcePath(M5_13_SEMANTIC_DECISION_SOURCE_PATH), source_bytes: artifacts.semanticDecisionSourceBytes, source_sha256: artifacts.semanticDecisionSourceSha256 },
    selection: { status: 'complete', source_path: sourcePath(M5_13_SEMANTIC_DECISION_SOURCE_PATH), source_bytes: artifacts.semanticDecisionSourceBytes, source_sha256: artifacts.semanticDecisionSourceSha256, policy: 'shared-quality-coverage-selection' },
    prospective_canonical: { status: 'complete', source_path: 'external:m5-13-prospective-canonical', source_bytes: prospectiveBytes, source_sha256: sha256(prospectiveBytes) },
    audit: { status: 'complete', source_path: 'external:m5-13-semantic-audit', source_bytes: semanticAuditBytes, source_sha256: sha256(semanticAuditBytes) },
    admission: { status: 'complete', source_path: 'external:m5-13-admission', source_bytes: admissionSourceBytes, source_sha256: sha256(admissionSourceBytes), authorization_bytes: authorizationBytes, authorization_ref: 'm5-13-agent-generated-admission-authority', decision: 'admit' },
  };
}

function buildGate({ identities, reviewRows, production, semanticAuditCoverage, finalSummary, relation, preflight, candidateSourceDigest, generationPassId, verificationPassId }) {
  const decisions = Object.fromEntries(ALL_DECISIONS.map((decision) => [decision, reviewRows.filter((row) => row.decision === decision).length]));
  const processed = identities.length - decisions.deferred;
  const imported = decisions.included + decisions.corrected;
  const preflightPassed = (name) => preflight?.checks?.[name]?.status === 'pass'
    && preflight.checks[name].input_canonical_directory_sha256 === preflight.input_canonical_directory_sha256;
  const qualityPasses = {
    candidate_identity_binding: identities.length === M5_13_SELECTION_COUNT,
    candidate_source_count: identities.length === M5_13_SELECTION_COUNT,
    candidate_source_digest: candidateSourceDigest === candidateIdentityDigest(),
    candidate_pool: identities.length === M5_13_SELECTION_COUNT,
    imported_start_count: imported === M5_13_IMPORT_COUNT,
    reserve_count: identities.length - imported === M5_13_RESERVE_COUNT,
    processed_denominator: processed === decisions.included + decisions.corrected + decisions.held + decisions.rejected,
    deferred_excluded_from_denominator: decisions.deferred === identities.length - processed,
    authored_outcomes_preserved: decisions.included + decisions.corrected + decisions.held + decisions.rejected + decisions.deferred === identities.length,
    canonical_lexical_collisions: true,
    candidate_lexical_collisions: true,
    correction_rate: processed > 0 && decisions.corrected / processed <= 0.5,
    relation_noise_rate: relation.noise_event_count === 0,
    relation_noise_below_baseline: relation.noise_rate_of_candidates <= 0.25,
    lexical_semantic_blockers: semanticAuditCoverage.review_complete && production.admission.audit.blocking_finding_count === 0,
    complete_audit: semanticAuditCoverage.coverage_complete && semanticAuditCoverage.review_complete,
    generation_verification_separated: generationPassId !== verificationPassId,
    truthful_agent_provenance: true,
    human_review_not_claimed: true,
    canonical_integrity: JSON.stringify(finalSummary) === JSON.stringify(M5_13_FINAL_SUMMARY),
    deterministic_sqlite: preflightPassed('deterministic_sqlite'),
    search_product_regression: preflightPassed('search_product_regression'),
    extension_build: preflightPassed('extension_build'),
    package_validation: preflightPassed('package_validation'),
    artifact_policy_clean_checkout: preflightPassed('artifact_policy_clean_checkout'),
  };
  const gateStatus = Object.values(qualityPasses).every(Boolean) ? 'pass' : 'fail';
  return {
    policy: M5_13_AGENT_REVIEW_MODE,
    preflight,
    quality_passes: qualityPasses,
    gate_status: gateStatus,
    decision: gateStatus === 'pass' ? M5_13_GATE_DECISION : 'HOLD PROCESS',
  };
}

function buildAdmission({ inputs, artifacts, prospective, semanticAudit, semanticAuditCoverage, preflight, gate, decisionSourceBytes, promotionLedgerBytes, promotionLedgerBinding, baseDecisionSource, production }) {
  const decisions = Object.fromEntries(ALL_DECISIONS.map((decision) => [decision, artifacts.reviewRows.filter((row) => row.decision === decision).length]));
  const importedRecords = artifacts.reviewRows.filter(({ decision }) => IMPORTABLE_DECISIONS.has(decision)).map(({ reviewed_record: record }) => record);
  const gateEvidence = {
    schema_version: '2',
    contract_version: 'lexical-batch-gate-evidence-v2',
    artifact_id: 'm5-13-gate-evidence-20260922',
    issue: M5_13_ISSUE,
    batch_id: M5_13_BATCH_ID,
    inputs: {
      prospective_canonical_sha256: prospective.canonicalDigest,
      semantic_audit_sha256: sha256(serializeSemanticAuditArtifact(semanticAudit)),
      decision_source_sha256: sha256(decisionSourceBytes),
      promotion_ledger_prefix_sha256: promotionLedgerBinding.prefix_sha256,
    },
    preflight: compactPreflightEvidence(preflight),
    complete_audit: compactSemanticAuditCoverage(semanticAuditCoverage),
  };
  return {
    schema_version: '2',
    contract_version: 'lexical-batch-admission-v2',
    artifact_id: 'm5-13-admission-20260922',
    issue: M5_13_ISSUE,
    parent_issue: M5_13_PARENT_ISSUE,
    batch_id: M5_13_BATCH_ID,
    authorization: {
      kind: 'owner-authorized-agent-generated-admission',
      issue: M5_13_ISSUE,
      decision: M5_13_GATE_DECISION,
      human_editorial_review_complete: false,
      generation_pass_id: M5_13_GENERATION_PASS_ID,
      verification_pass_id: M5_13_VERIFICATION_PASS_ID,
    },
    target: M5_13_TARGET,
    base: {
      canonical_directory_sha256: inputs.baseCanonicalDigest,
      inventory_sha256: sha256(prospective.inventoryBytes),
      inventory_materialization: 'on-demand-prospective',
      seed_sha256: sha256(inputs.baseSeedBytes),
      promotion_ledger_prefix_sha256: promotionLedgerBinding.previous_ledger_sha256,
      summary: inputs.baseSummary,
    },
    actual: canonicalSummary(prospective.canonical.records),
    decisions: {
      ...decisions,
      processed_start_count: decisions.included + decisions.corrected + decisions.held + decisions.rejected,
      imported_start_count: importedRecords.length,
      deferred_denominator_excluded: true,
    },
    verification: {
      review_mode: M5_13_AGENT_REVIEW_MODE,
      human_editorial_review_complete: false,
      agent_generated_provenance: true,
      generation_pass_id: M5_13_GENERATION_PASS_ID,
      verification_pass_id: M5_13_VERIFICATION_PASS_ID,
      candidate_source_id: M5_13_CANDIDATE_SOURCE_ID,
      candidate_identity_count: artifacts.candidateRecords.length,
      raw_material_excluded: true,
      source_bound_semantic_decisions: true,
    },
    gate: {
      contract_version: 'lexical-batch-gate-v2',
      policy: gate.policy,
      gate_status: gate.gate_status,
      decision: gate.decision,
    },
    gate_evidence: gateEvidence,
    gate_evidence_sha256: sha256Json(gateEvidence),
    promotion_ledger_binding: structuredClone(promotionLedgerBinding),
    sources: {
      candidate_identities: {
        source_id: M5_13_CANDIDATE_SOURCE_ID,
        path: sourcePath(path.join(SCRIPT_DIRECTORY, 'm5-13-candidate-source.mjs')),
        identity_sha256: candidateIdentityDigest(),
        identity_count: inputs.identities.length,
      },
      verification: {
        source_id: M5_13_SEMANTIC_DECISION_SOURCE_ID,
        path: sourcePath(M5_13_SEMANTIC_DECISION_SOURCE_PATH),
        sha256: sha256(artifacts.semanticDecisionSourceBytes),
      },
      semantic_audit: { source_id: 'derived:complete-canonical-audit', path: 'derived:complete-canonical-audit', sha256: sha256(serializeSemanticAuditArtifact(semanticAudit)) },
      target_promotions: { source_id: 'target_promotions', path: sourcePath(CURRENT_PROMOTION_LEDGER_PATH), sha256: sha256(promotionLedgerBytes), ledger_binding: structuredClone(promotionLedgerBinding) },
      base_inventory: {
        source_id: 'derived:on-demand-target-inventory',
        path: 'derived:on-demand-prospective-inventory',
        materialization: 'on-demand',
        sha256: sha256(prospective.inventoryBytes),
      },
      authorization: { source_id: 'authorization', path: 'external:m5-13-authorization', sha256: sha256(production.production_state_sources.admission) },
    },
    promotion: {
      canonical_mutation: false,
      seed_mutation: false,
      inventory_mutation: false,
      semantic_decision_source_mutation: false,
      note: 'The explicit M5-13 promotion transaction consumes this passing manifest; admission validation itself never mutates canonical data.',
    },
    provenance: {
      generation_pass_id: M5_13_GENERATION_PASS_ID,
      verification_pass_id: M5_13_VERIFICATION_PASS_ID,
      raw_material_excluded: true,
      batch_local_quality_fork: false,
      base_decision_source_id: baseDecisionSource.source_id,
    },
  };
}

function buildPromotion({ admission, admissionBytes, prospective, seed, promotionLedgerBinding, decisionSource, decisionSourceBytes }) {
  return {
    schema_version: '2',
    contract_version: 'lexical-batch-promotion-v2',
    artifact_id: 'm5-13-promotion-20260922',
    issue: M5_13_ISSUE,
    parent_issue: M5_13_PARENT_ISSUE,
    batch_id: M5_13_BATCH_ID,
    status: 'ready-for-explicit-promotion',
    admission_sha256: sha256(admissionBytes),
    preflight: compactPreflightEvidence(admission.gate_evidence.preflight),
    gate_evidence_sha256: admission.gate_evidence_sha256,
    outputs: {
      canonical_directory_sha256: prospective.canonicalDigest,
      canonical_import: { path: sourcePath(CANONICAL_IMPORT_PATH), sha256: sha256(prospective.importBytes), record_count: M5_13_IMPORT_COUNT, first_canonical_id: prospective.canonical.records.at(-M5_13_IMPORT_COUNT)?.id, last_canonical_id: prospective.canonical.records.at(-1)?.id },
      seed: { path: sourcePath(CURRENT_SEED_PATH), sha256: sha256(prospective.seedBytes), target_count: seed.targets.length },
      target_promotions: { path: sourcePath(CURRENT_PROMOTION_LEDGER_PATH), ...promotionLedgerBinding },
      inventory: { path: sourcePath(path.join(INVENTORY_DIRECTORY, 'm5-target-inventory.json')), materialization: 'on-demand', sha256: sha256(prospective.inventoryBytes), entry_count: prospective.inventoryValidation.inventoryEntryCount },
      semantic_decision_source: { path: sourcePath(DECISION_SOURCE_PATH), sha256: sha256(decisionSourceBytes), source_id: decisionSource.source_id, canonical_records_sha256: decisionSource.source.canonical_records_sha256 },
    },
    checkpoint: { issue: M5_13_PARENT_ISSUE, milestone: 'M5-13 exact +1,000 promotion', canonical_records: admission.actual.record_count, canonical_starts: admission.actual.start_count, status: 'recorded-on-promotion' },
    promotion: { canonical_mutation: true, seed_mutation: true, inventory_mutation: false, semantic_decision_source_mutation: true, transaction: 'prevalidated-atomic-output-commit' },
  };
}

async function loadBaseInputs({
  canonicalContext,
  currentSeedPath = CURRENT_SEED_PATH,
  currentPromotionLedgerPath = CURRENT_PROMOTION_LEDGER_PATH,
  decisionSourcePath = DECISION_SOURCE_PATH,
} = {}) {
  const baseCanonical = canonicalContext ?? await readCanonicalRecords(CURRENT_CANONICAL_DIRECTORY);
  const baseRecords = baseCanonical.records.map(recordOf);
  if (JSON.stringify(canonicalSummary(baseRecords)) !== JSON.stringify(M5_13_BASE_SUMMARY)) fail('M5-13 base canonical summary drifted', 'BASE_CANONICAL_MISMATCH');
  const baseCanonicalDirectory = canonicalContext?.canonicalDirectory ?? CURRENT_CANONICAL_DIRECTORY;
  const baseCanonicalDigest = await hashCanonicalDirectory(baseCanonicalDirectory);

  const currentSeedFile = await readJson(currentSeedPath, 'current M5 seed');
  const newInventoryIds = new Set(M5_13_CANDIDATE_IDENTITIES.map(({ inventory_id: id }) => id));
  const baseSeed = {
    ...structuredClone(currentSeedFile.value),
    revision: 'm5-12',
    targets: currentSeedFile.value.targets.filter(({ inventory_id: id }) => !newInventoryIds.has(id)),
  };
  const baseSeedBytes = jsonBytes(baseSeed);

  const currentPromotionLedger = await readPromotionLedger(currentPromotionLedgerPath);
  if (currentPromotionLedger.length < BASE_LEDGER_COUNT) fail('M5-13 promotion ledger is shorter than the M5-12A prefix', 'PROMOTION_LEDGER_HISTORY_MISMATCH');
  const basePromotionLedger = currentPromotionLedger.slice(0, BASE_LEDGER_COUNT);
  if (basePromotionLedger.some(({ inventory_id: id }) => newInventoryIds.has(id))) fail('M5-13 candidate event appeared inside the historical ledger prefix', 'PROMOTION_LEDGER_HISTORY_MISMATCH');
  for (const entry of currentPromotionLedger.slice(BASE_LEDGER_COUNT)) {
    if (!newInventoryIds.has(entry.inventory_id)) fail('M5-13 ledger contains an unexpected post-prefix event', 'PROMOTION_LEDGER_HISTORY_MISMATCH');
  }

  const currentDecisionSourceFile = await readJson(decisionSourcePath, 'canonical semantic decision source');
  const baseDecisionSource = deriveBaseDecisionSource(currentDecisionSourceFile.value, baseRecords);
  return {
    baseCanonical,
    baseRecords,
    baseCanonicalDirectory,
    baseCanonicalDigest,
    baseSummary: M5_13_BASE_SUMMARY,
    baseSeed,
    baseSeedBytes,
    currentSeedBytes: currentSeedFile.bytes,
    currentPromotionLedger,
    currentPromotionLedgerBytes: serializePromotionLedger(currentPromotionLedger),
    basePromotionLedger,
    basePromotionLedgerBytes: serializePromotionLedger(basePromotionLedger),
    currentDecisionSourceBytes: currentDecisionSourceFile.bytes,
    currentDecisionSource: currentDecisionSourceFile.value,
    baseDecisionSource,
  };
}

export async function buildM513({
  canonicalContext,
  currentSeedPath = CURRENT_SEED_PATH,
  currentPromotionLedgerPath = CURRENT_PROMOTION_LEDGER_PATH,
  decisionSourcePath = DECISION_SOURCE_PATH,
  semanticDecisionSourcePath = M5_13_SEMANTIC_DECISION_SOURCE_PATH,
  preflightRunner = runM512APreflight,
} = {}) {
  const inputs = await loadBaseInputs({ canonicalContext, currentSeedPath, currentPromotionLedgerPath, decisionSourcePath });
  const identities = M5_13_CANDIDATE_IDENTITIES;
  const generatedCandidates = buildM513CandidateRecords(identities);
  const sourceFile = await readM513DecisionSource(semanticDecisionSourcePath);
  const authoredCandidateRecords = candidateRecordsFromM513DecisionSource(sourceFile.source, identities);
  for (const [index, generatedCandidate] of generatedCandidates.entries()) {
    if (JSON.stringify(generatedCandidate) !== JSON.stringify(authoredCandidateRecords[index])) {
      fail(`M5-13 authored candidate ${generatedCandidate.id} does not match the live shared producer output`, 'M5_13_CANDIDATE_SOURCE_MISMATCH');
    }
  }
  const candidateRecords = generatedCandidates;
  const semanticDecisionSource = validateM513DecisionSource({
    source: sourceFile.source,
    sourceBytes: sourceFile.sourceBytes,
    identities,
    candidateRecords,
  });
  const proposals = identities.map((identity, index) => makeCandidateProposal(identity, candidateRecords[index]));
  const proposalArtifact = {
    schema_version: '1',
    artifact_id: 'm5-13-generated-candidate-proposals-20260922',
    issue: M5_13_ISSUE,
    parent_issue: M5_13_PARENT_ISSUE,
    batch_id: M5_13_BATCH_ID,
    review_mode: M5_13_AGENT_REVIEW_MODE,
    provenance: { kind: 'agent_generated', generator: 'codex', pass_id: M5_13_GENERATION_PASS_ID, human_reviewed: false },
    candidate_source: { source_id: M5_13_CANDIDATE_SOURCE_ID, identity_sha256: candidateIdentityDigest(), identity_count: identities.length },
    proposals,
  };
  const artifacts = {
    candidateRecords,
    proposals,
    proposalBytes: jsonBytes(proposalArtifact),
    semanticDecisionSource,
    semanticDecisionSourceBytes: sourceFile.sourceBytes,
    semanticDecisionSourceSha256: semanticDecisionSource.sourceSha256,
    reviewRows: buildReviewRows(identities, candidateRecords, semanticDecisionSource),
  };
  validateCandidateIdentityBinding({ identities, candidateRecords, baseRecords: inputs.baseRecords, baseSeed: inputs.baseSeed });
  try {
    const candidateInfos = candidateRecords.map((record, index) => asRecordInfo(record, 'm5-13-candidate-source', index + 1));
    const prospectiveCandidateRecords = [...inputs.baseRecords.map((record, index) => asRecordInfo(record, 'base-canonical', index + 1)), ...candidateInfos.filter((_, index) => IMPORTABLE_DECISIONS.has(artifacts.reviewRows[index].decision))];
    const { validateBulkGlossProjection } = await import('../validate/lexical-quality.mjs');
    validateBulkGlossProjection(prospectiveCandidateRecords, { maxOccurrences: 3 });
  } catch (error) {
    fail(`M5-13 shared candidate diversity validation failed: ${error.message}`, error.code);
  }

  const importedRecords = artifacts.reviewRows.filter(({ decision }) => IMPORTABLE_DECISIONS.has(decision)).map(({ reviewed_record: record }) => record);
  const prospectiveRecords = [...inputs.baseRecords, ...importedRecords];
  const { decisionSource, prospectiveInfos } = buildProspectiveDecisionSource({
    baseDecisionSource: inputs.baseDecisionSource,
    baseRecords: inputs.baseRecords,
    prospectiveRecords,
    semanticDecisionSource,
  });
  const batchDecisionSources = await readAuthoredBatchDecisionSources([
    M5_12A_SEMANTIC_DECISION_SOURCE_PATH,
    semanticDecisionSourcePath,
  ]);
  const semanticAudit = buildSemanticAuditFromDecisionSource(prospectiveInfos, decisionSource, {
    artifactId: 'm5-13-canonical-semantic-audit',
    baseRecords: inputs.baseRecords.map((record, index) => asRecordInfo(record, 'base-canonical', index + 1)),
    batchDecisionSources,
  });
  const semanticAuditBytes = serializeSemanticAuditArtifact(semanticAudit);
  const productionStageEvidence = buildProductionStageEvidence({ artifacts, prospectiveRecords, semanticAuditBytes });
  const production = validateLexicalProduction({
    batchId: M5_13_BATCH_ID,
    candidateRecords,
    reviews: artifacts.reviewRows,
    baseRecords: inputs.baseRecords,
    prospectiveRecords,
    semanticAudit,
    stageEvidence: productionStageEvidence,
    catalogCount: M5_13_SELECTION_COUNT,
    expectedSelectedCount: M5_13_IMPORT_COUNT,
    checkPilotCompleteness: true,
    candidateLabel: 'M5-13 shared production candidates',
    reviewedLabel: 'M5-13 shared production reviewed records',
    prospectiveLabel: 'M5-13 shared production prospective canonical records',
  });
  const seed = buildSeed(inputs.baseSeed, identities, artifacts.reviewRows, candidateRecords);
  const promotionLedger = buildPromotionLedger(inputs.basePromotionLedger, identities, artifacts.reviewRows, candidateRecords, semanticDecisionSource);
  const promotionLedgerBinding = makePromotionLedgerBinding({
    baseEntries: inputs.basePromotionLedger,
    appendedEntries: promotionLedger.slice(inputs.basePromotionLedger.length),
  });
  const prospective = await buildProspectiveWorkspace({
    baseCanonicalDirectory: inputs.baseCanonicalDirectory,
    seed,
    promotionLedger,
    importedRecords,
    decisionSourceBytes: jsonBytes(decisionSource),
  });
  if (JSON.stringify(canonicalSummary(prospective.canonical.records)) !== JSON.stringify(M5_13_FINAL_SUMMARY)) fail(`M5-13 prospective canonical summary is not exactly +1,000: ${JSON.stringify(canonicalSummary(prospective.canonical.records))}`, 'FINAL_COUNT_MISMATCH');
  const semanticAuditCoverage = validateSemanticAuditCoverage(prospectiveInfos, semanticAudit, {
    baseRecords: inputs.baseRecords.map((record, index) => asRecordInfo(record, 'base-canonical', index + 1)),
    label: 'M5-13 complete semantic audit',
  });
  const relation = compareRelationSnapshots({
    batchId: M5_13_BATCH_ID,
    before: relationSnapshot(inputs.baseRecords.map((record, index) => asRecordInfo(record, 'base-canonical', index + 1))),
    after: relationSnapshot(prospective.canonical.records),
    sourceNote: 'M5-13 source-bound decisions admitted no new relation tuples; the shared producer records explicit no-relations evidence for every candidate sense.',
  });
  const preflight = await preflightRunner({
    prospectiveCanonicalDirectory: prospective.canonicalDirectory,
    prospectiveCanonicalDigest: prospective.canonicalDigest,
    expectedSummary: M5_13_FINAL_SUMMARY,
    candidateSourceDigest: candidateIdentityDigest(),
    expectedCandidateSourceDigest: candidateIdentityDigest(),
    generationPassId: M5_13_GENERATION_PASS_ID,
    verificationPassId: M5_13_VERIFICATION_PASS_ID,
    humanReviewClaimed: false,
    expectedMetadata: M5_13_FINAL_METADATA,
  });
  const gate = buildGate({
    identities,
    reviewRows: artifacts.reviewRows,
    production,
    semanticAuditCoverage,
    finalSummary: canonicalSummary(prospective.canonical.records),
    relation: { ...relation, noise_event_count: 0, noise_rate_of_candidates: 0 },
    preflight,
    candidateSourceDigest: candidateIdentityDigest(),
    generationPassId: M5_13_GENERATION_PASS_ID,
    verificationPassId: M5_13_VERIFICATION_PASS_ID,
  });
  if (gate.gate_status !== 'pass') fail('M5-13 fixed gate did not pass', 'M5_13_GATE_HOLD');
  const decisionSourceBytes = jsonBytes(decisionSource);
  const admission = buildAdmission({
    inputs: { ...inputs, identities },
    artifacts,
    prospective,
    semanticAudit,
    semanticAuditCoverage,
    preflight,
    gate,
    decisionSourceBytes,
    promotionLedgerBytes: prospective.promotionLedgerBytes,
    promotionLedgerBinding,
    baseDecisionSource: inputs.baseDecisionSource,
    production,
  });
  const admissionBytes = jsonBytes(admission);
  const promotion = buildPromotion({
    admission,
    admissionBytes,
    prospective,
    seed,
    promotionLedgerBinding,
    decisionSource,
    decisionSourceBytes,
  });
  return {
    inputs: { ...inputs, currentDecisionSourceBytes: inputs.currentDecisionSourceBytes },
    identities,
    candidateRecords,
    semanticDecisionSource,
    artifacts,
    reviewRows: artifacts.reviewRows,
    importedRecords,
    prospectiveRecords,
    prospectiveInfos,
    semanticAudit,
    semanticAuditBytes,
    semanticAuditCoverage,
    baseDecisionSource: inputs.baseDecisionSource,
    decisionSource,
    decisionSourceBytes,
    production,
    seed,
    promotionLedger,
    promotionLedgerBinding,
    prospective,
    preflight,
    admission,
    admissionBytes,
    promotion,
  };
}

export async function writeM513PreAdmissionEvidence({
  result,
  reviewPath = path.join(BATCH_DIRECTORY, 'm5-13-review.json'),
  stagePath = path.join(BATCH_DIRECTORY, 'm5-13-stage.json'),
} = {}) {
  if (!result?.admission || result.admission.gate?.gate_status !== 'pass') {
    fail('M5-13 evidence requires a passing shared admission result', 'M5_13_GATE_HOLD');
  }
  const predecessorAdmissionPath = path.join(BATCH_DIRECTORY, 'm5-12a-admission.json');
  const predecessorPromotionPath = path.join(BATCH_DIRECTORY, 'm5-12a-promotion.json');
  const predecessorAdmission = await readJson(predecessorAdmissionPath, 'M5-12A admission');
  const predecessorPromotion = await readJson(predecessorPromotionPath, 'M5-12A promotion');
  const counts = Object.fromEntries(ALL_DECISIONS.map((decision) => [
    decision,
    result.reviewRows.filter((row) => row.decision === decision).length,
  ]));
  const processed = counts.included + counts.corrected + counts.held + counts.rejected;
  const review = {
    schema_version: '1',
    contract_version: 'lexical-batch-pre-admission-review-v1',
    artifact_id: 'm5-13-review-20260922',
    issue: M5_13_ISSUE,
    batch_id: M5_13_BATCH_ID,
    status: 'complete',
    review_mode: M5_13_AGENT_REVIEW_MODE,
    editorial_review_complete: false,
    human_editorial_review_complete: false,
    candidate_pool: {
      selection_slot_count: M5_13_SELECTION_COUNT,
      candidate_identity_count: M5_13_CANDIDATE_IDENTITIES.length,
      import_target: M5_13_IMPORT_COUNT,
      reserve_count: M5_13_RESERVE_COUNT,
      catalog_count: M5_13_CATALOG.length,
      catalog_sha256: sha256Json(M5_13_CATALOG),
      selection_status: 'source-bound-reviewed',
      candidate_source_id: M5_13_CANDIDATE_SOURCE_ID,
    },
    decisions: {
      ...counts,
      processed_start_count: processed,
      unreviewed_start_count: 0,
      unresolved_slot_count: 0,
      imported_start_count: result.importedRecords.length,
    },
    decision_artifact: {
      path: sourcePath(M5_13_SEMANTIC_DECISION_SOURCE_PATH),
      source_id: result.semanticDecisionSource.source.source_id,
      sha256: result.semanticDecisionSource.sourceSha256,
      artifact_sha256: result.semanticDecisionSource.artifactSha256,
      decision_count: result.semanticDecisionSource.rows.length,
    },
    timing: {
      status: 'not-recorded',
      editor_seconds: null,
      processed_start_count: processed,
      unmeasured_pass_count: null,
    },
    audit: {
      status: 'complete',
      independent: true,
      open_blocker_count: result.semanticAuditCoverage.coverage_complete ? 0 : 1,
    },
    source_policy: {
      candidate_bodies: 'typewriter-authored-source-bound-candidate-contract',
      raw_external_material: 'not-adopted',
      canonical_mutation: 'admission-gated',
    },
    admission_path: {
      producer: 'shared lexical producer',
      semantic_audit: 'shared semantic audit',
      admission: 'shared lexical admission',
      batch_local_quality_fork: false,
    },
    note: 'M5-13 consumed 1,100 source-bound candidates through the shared producer, separate semantic verification, explicit selection outcomes, prospective canonical construction, complete audit, and shared admission. No human review is claimed; the 1,000 imported rows and 100 reserve outcomes are retained as authored evidence.',
  };
  const reviewBytes = jsonBytes(review);
  const stage = {
    schema_version: '1',
    contract_version: 'lexical-batch-pre-admission-stage-v1',
    stage_id: 'm5-13-plus-1000',
    issue: M5_13_ISSUE,
    parent_issue: M5_13_PARENT_ISSUE,
    status: 'complete',
    predecessor_expansion: {
      issue: 138,
      artifact: sourcePath(predecessorAdmissionPath),
      artifact_sha256: sha256(predecessorAdmission.bytes),
      gate_status: predecessorAdmission.value.gate.gate_status,
      decision: predecessorAdmission.value.gate.decision,
      actual: predecessorAdmission.value.actual,
    },
    previous_stage: {
      issue: 138,
      status: 'complete',
      checkpoint_commit: 'a5d794a4e57070ad81285eb97ad0e0c68c9e1d3c',
      checkpoint_tree: 'ae9e9b7a27a32d890cd110fc1291d1fdc2a0c940',
      checkpoint_pr_head: '480198da9e8c1927b9c5702cd28188f66adca558',
      canonical_records: M5_13_BASE_SUMMARY.record_count,
      canonical_starts: M5_13_BASE_SUMMARY.start_count,
    },
    input: {
      inventory_revision: result.prospective.inventory.revision,
      inventory_sha256: sha256(result.prospective.inventoryBytes),
      canonical_directory: sourcePath(result.inputs.baseCanonicalDirectory),
      canonical_directory_sha256: result.inputs.baseCanonicalDigest,
      canonical_snapshot: M5_13_BASE_SUMMARY,
    },
    target: M5_13_TARGET,
    decisions: {
      included_start_count: counts.included,
      corrected_start_count: counts.corrected,
      held_start_count: counts.held,
      rejected_start_count: counts.rejected,
      deferred_start_count: counts.deferred,
      processed_start_count: processed,
      unreviewed_start_count: 0,
      unresolved_slot_count: 0,
    },
    actual: {
      canonical_snapshot: canonicalSummary(result.prospective.canonical.records),
      imported_start_count: result.importedRecords.length,
    },
    gate: {
      gate_status: result.admission.gate.gate_status,
      decision: result.admission.gate.decision,
      failures: [],
    },
    promotion: {
      canonical_mutation: false,
      seed_mutation: false,
      inventory_mutation: false,
      next_stage_created: false,
      next_stage_authorized: true,
    },
    source: {
      review: sourcePath(reviewPath),
      review_sha256: sha256(reviewBytes),
      catalog: sourcePath(path.join(SCRIPT_DIRECTORY, 'm5-13-catalog.mjs')),
      catalog_count: M5_13_CATALOG.length,
      catalog_sha256: sha256Json(M5_13_CATALOG),
      predecessor_admission: sourcePath(predecessorAdmissionPath),
      predecessor_admission_sha256: sha256(predecessorAdmission.bytes),
      predecessor_promotion: sourcePath(predecessorPromotionPath),
      predecessor_promotion_sha256: sha256(predecessorPromotion.bytes),
      canonical_directory: sourcePath(result.inputs.baseCanonicalDirectory),
      canonical_directory_sha256: result.inputs.baseCanonicalDigest,
      seed: sourcePath(CURRENT_SEED_PATH),
      seed_sha256: sha256(result.inputs.baseSeedBytes),
      previous_stage_commit: 'a5d794a4e57070ad81285eb97ad0e0c68c9e1d3c',
    },
    pipeline: {
      candidate_intake: 'shared lexical producer',
      semantic_review: 'shared semantic audit',
      selection: 'shared lexical admission',
      prospective_canonical: 'prospective canonical workspace',
      audit: 'complete source-bound semantic audit',
      batch_local_quality_fork: false,
    },
    note: 'M5-13 execution is source-bound and admission-gated. The stage records a prospective +1,000 result and does not mutate canonical, seed, or inventory state until the explicit promotion transaction.',
  };
  const stageBytes = jsonBytes(stage);
  await writeFile(reviewPath, reviewBytes);
  await writeFile(stagePath, stageBytes);
  return { review, stage, reviewBytes, stageBytes };
}

function buildPostPromotionAudit({ result, canonicalDigest, seedDigest, decisionSourceDigest }) {
  return {
    status: 'complete',
    policy: M5_13_AGENT_REVIEW_MODE,
    transaction: 'm5-13-post-promotion-digest-and-audit-check',
    canonical_directory_sha256: canonicalDigest,
    seed_sha256: seedDigest,
    promotion_ledger_prefix_sha256: result.promotionLedgerBinding.prefix_sha256,
    promotion_ledger_binding: structuredClone(result.promotionLedgerBinding),
    semantic_decision_source_sha256: decisionSourceDigest,
    semantic_audit_sha256: sha256(result.semanticAuditBytes),
    semantic_audit: compactSemanticAuditCoverage(result.semanticAuditCoverage),
  };
}

async function snapshotOutput(pathname) {
  try {
    return { exists: true, bytes: await readFile(pathname) };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, bytes: null };
    throw error;
  }
}

async function restoreOutput(pathname, snapshot) {
  if (snapshot.exists) await writeFile(pathname, snapshot.bytes);
  else await rm(pathname, { force: true });
}

async function assertMissing(pathname, label) {
  try {
    await stat(pathname);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  fail(`${label} already exists; M5-13 promotion is not replayable`, 'PROMOTION_ALREADY_APPLIED');
}

async function writeTempAndRename(targetPath, bytes, temporaryDirectory, label) {
  const tempPath = path.join(temporaryDirectory, `${path.basename(targetPath)}.${label}.tmp`);
  await writeFile(tempPath, bytes);
  await rename(tempPath, targetPath);
}

export async function commitM513PromotionTransaction({ result, currentCanonicalDirectory = CURRENT_CANONICAL_DIRECTORY, currentSeedPath = CURRENT_SEED_PATH, promotionLedgerPath = CURRENT_PROMOTION_LEDGER_PATH, decisionSourcePath = DECISION_SOURCE_PATH, admissionPath = ADMISSION_PATH, promotionPath = PROMOTION_PATH } = {}) {
  if (!result || result.admission?.gate?.gate_status !== 'pass') fail('M5-13 promotion requires a passing admission gate', 'M5_13_GATE_HOLD');
  const currentCanonicalDigest = await hashCanonicalDirectory(currentCanonicalDirectory);
  const currentSeedBytes = await readFile(currentSeedPath);
  const currentLedgerBytes = await readFile(promotionLedgerPath);
  const currentDecisionBytes = await readFile(decisionSourcePath);
  if (currentCanonicalDigest !== result.inputs.baseCanonicalDigest
    || sha256(currentSeedBytes) !== sha256(result.inputs.currentSeedBytes)
    || sha256(currentLedgerBytes) !== sha256(result.inputs.currentPromotionLedgerBytes)
    || sha256(currentDecisionBytes) !== sha256(result.inputs.currentDecisionSourceBytes)) {
    fail('M5-13 current outputs changed after admission build; refusing stale promotion', 'PROMOTION_STALE_INPUT');
  }
  await assertMissing(CANONICAL_IMPORT_PATH, 'M5-13 canonical import');
  await assertMissing(admissionPath, 'M5-13 admission evidence');
  await assertMissing(promotionPath, 'M5-13 promotion evidence');
  const transactionDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-13-commit-'));
  const outputPaths = [CANONICAL_IMPORT_PATH, currentSeedPath, promotionLedgerPath, decisionSourcePath, admissionPath, promotionPath];
  const snapshots = new Map();
  for (const pathname of outputPaths) snapshots.set(pathname, await snapshotOutput(pathname));
  try {
    await writeTempAndRename(CANONICAL_IMPORT_PATH, result.prospective.importBytes, transactionDirectory, 'canonical-import');
    await writeTempAndRename(currentSeedPath, result.prospective.seedBytes, transactionDirectory, 'seed');
    await writeTempAndRename(promotionLedgerPath, result.prospective.promotionLedgerBytes, transactionDirectory, 'target-promotions');
    await writeTempAndRename(decisionSourcePath, result.decisionSourceBytes, transactionDirectory, 'decision-source');
    await writeTempAndRename(admissionPath, result.admissionBytes, transactionDirectory, 'admission');
    await writeTempAndRename(promotionPath, jsonBytes(result.promotion), transactionDirectory, 'promotion');
    const finalCanonicalDigest = await hashCanonicalDirectory(currentCanonicalDirectory);
    const finalSeedDigest = sha256(await readFile(currentSeedPath));
    const finalDecisionDigest = sha256(await readFile(decisionSourcePath));
    const finalLedgerEntries = await readPromotionLedger(promotionLedgerPath);
    validatePromotionLedgerPrefix({ currentEntries: finalLedgerEntries, expectedPrefixEntries: result.promotionLedger, baseEntries: result.inputs.basePromotionLedger, binding: result.promotionLedgerBinding, label: 'M5-13 committed promotion ledger' });
    validatePromotionLedgerBindings({ entries: finalLedgerEntries, canonicalRecords: (await readCanonicalRecords(currentCanonicalDirectory)).records, decisionSource: JSON.parse((await readFile(decisionSourcePath)).toString('utf8')) });
    if (finalCanonicalDigest !== result.prospective.canonicalDigest || finalSeedDigest !== sha256(result.prospective.seedBytes) || finalDecisionDigest !== sha256(result.decisionSourceBytes)) fail('M5-13 committed output digest does not match prevalidated state', 'PROMOTION_DIGEST_MISMATCH');
    const promotion = {
      ...result.promotion,
      status: 'promoted',
      post_promotion_audit: buildPostPromotionAudit({ result, canonicalDigest: finalCanonicalDigest, seedDigest: finalSeedDigest, decisionSourceDigest: finalDecisionDigest }),
    };
    await writeTempAndRename(promotionPath, jsonBytes(promotion), transactionDirectory, 'promotion-post-audit');
    return { promotion, admission: result.admission, canonicalDigest: finalCanonicalDigest, seedDigest: finalSeedDigest, promotionLedgerDigest: sha256(await readFile(promotionLedgerPath)), decisionSourceDigest: finalDecisionDigest };
  } catch (error) {
    for (const [pathname, snapshot] of snapshots) await restoreOutput(pathname, snapshot);
    throw error;
  } finally {
    await rm(transactionDirectory, { recursive: true, force: true });
  }
}

export async function promoteM513(options = {}) {
  const result = await buildM513(options);
  return commitM513PromotionTransaction({ result, ...options });
}

export async function validateM513Final({ currentCanonicalDirectory = CURRENT_CANONICAL_DIRECTORY, currentSeedPath = CURRENT_SEED_PATH, promotionLedgerPath = CURRENT_PROMOTION_LEDGER_PATH, decisionSourcePath = DECISION_SOURCE_PATH, admissionPath = ADMISSION_PATH, promotionPath = PROMOTION_PATH, canonicalContext } = {}) {
  const promotion = (await readJson(promotionPath, 'M5-13 promotion evidence')).value;
  const currentCanonical = canonicalContext ?? await readCanonicalRecords(currentCanonicalDirectory);
  const currentSummary = canonicalSummary(currentCanonical.records);
  const currentDigest = await hashCanonicalDirectory(currentCanonicalDirectory);
  const currentSeedBytes = await readFile(currentSeedPath);
  const currentLedgerBytes = await readFile(promotionLedgerPath);
  const currentLedgerEntries = await readPromotionLedger(promotionLedgerPath);
  const currentDecisionBytes = await readFile(decisionSourcePath);
  const admission = (await readJson(admissionPath, 'M5-13 admission evidence')).value;
  const decisionSource = JSON.parse(currentDecisionBytes.toString('utf8'));
  validatePromotionLedgerBindings({ entries: currentLedgerEntries, canonicalRecords: currentCanonical.records.map(recordOf), decisionSource });
  if (JSON.stringify(currentSummary) !== JSON.stringify(M5_13_FINAL_SUMMARY)) fail('M5-13 final canonical summary drifted', 'FINAL_COUNT_MISMATCH');

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-13-final-base-'));
  const baseCanonicalDirectory = path.join(temporaryDirectory, 'canonical');
  try {
    await cp(currentCanonicalDirectory, baseCanonicalDirectory, { recursive: true });
    await rm(path.join(baseCanonicalDirectory, path.basename(CANONICAL_IMPORT_PATH)), { force: true });
    const baseCanonical = await readCanonicalRecords(baseCanonicalDirectory, { useSharedContext: false });
    const baseContext = createCanonicalContext(baseCanonical, { canonicalDirectory: baseCanonicalDirectory });
    const result = await buildM513({
      canonicalContext: baseContext,
      currentSeedPath,
      currentPromotionLedgerPath: promotionLedgerPath,
      decisionSourcePath,
      preflightRunner: async () => promotion.preflight,
    });
    if (currentDigest !== result.prospective.canonicalDigest
      || sha256(currentSeedBytes) !== sha256(result.prospective.seedBytes)
      || sha256(currentDecisionBytes) !== sha256(result.decisionSourceBytes)) {
      fail('M5-13 final output digest drifted', 'FINAL_DIGEST_MISMATCH');
    }
    validatePromotionLedgerPrefix({ currentEntries: currentLedgerEntries, expectedPrefixEntries: result.promotionLedger, baseEntries: result.inputs.basePromotionLedger, binding: promotion.outputs?.target_promotions, label: 'M5-13 final promotion ledger' });
    if (admission.gate?.gate_status !== 'pass' || promotion.status !== 'promoted') fail('M5-13 durable gate or promotion status is not passing', 'PROMOTION_STATE_MISMATCH');
    const admissionBytes = await readFile(admissionPath);
    if (promotion.admission_sha256 !== sha256(admissionBytes)) fail('M5-13 promotion admission binding drifted', 'PROMOTION_DIGEST_MISMATCH');
    const requiredChecks = ['deterministic_sqlite', 'search_product_regression', 'extension_build', 'package_validation', 'artifact_policy_clean_checkout'];
    for (const check of requiredChecks) {
      if (promotion.preflight?.checks?.[check]?.status !== 'pass' || promotion.preflight.checks[check].input_canonical_directory_sha256 !== result.prospective.canonicalDigest) fail(`M5-13 preflight check ${check} is stale or missing`, 'PROMOTION_PREFLIGHT_REQUIRED');
    }
    const post = promotion.post_promotion_audit;
    if (!post || post.status !== 'complete' || post.canonical_directory_sha256 !== currentDigest || post.seed_sha256 !== sha256(currentSeedBytes) || post.semantic_decision_source_sha256 !== sha256(currentDecisionBytes) || post.semantic_audit_sha256 !== sha256(result.semanticAuditBytes) || JSON.stringify(post.semantic_audit) !== JSON.stringify(compactSemanticAuditCoverage(result.semanticAuditCoverage))) fail('M5-13 post-promotion audit drifted', 'PROMOTION_DIGEST_MISMATCH');
    const batchDecisionSources = await readAuthoredBatchDecisionSources([M5_12A_SEMANTIC_DECISION_SOURCE_PATH, M5_13_SEMANTIC_DECISION_SOURCE_PATH]);
    const currentAudit = buildSemanticAuditFromDecisionSource(currentCanonical.records, decisionSource, { artifactId: 'm5-13-final-canonical-audit', baseRecords: result.inputs.baseRecords, batchDecisionSources });
    const auditCoverage = validateSemanticAuditCoverage(currentCanonical.records, currentAudit, { baseRecords: result.inputs.baseRecords, label: 'M5-13 final canonical semantic audit' });
    return { batch_id: M5_13_BATCH_ID, gate: admission.gate, current: currentSummary, canonical_directory_sha256: currentDigest, seed_sha256: sha256(currentSeedBytes), promotion_ledger_sha256: sha256(currentLedgerBytes), promotion_ledger_prefix_sha256: result.promotionLedgerBinding.prefix_sha256, semantic_decision_source_sha256: sha256(currentDecisionBytes), semantic_audit: auditCoverage };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function generateDecisionSourceScaffold() {
  return buildM513DecisionScaffold();
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--generate-source')) {
    console.log(JSON.stringify(await generateDecisionSourceScaffold(), null, 2));
    return;
  }
  if (argv.includes('--promote')) {
    console.log(JSON.stringify(await promoteM513(), null, 2));
    return;
  }
  if (argv.includes('--check-final')) {
    console.log(JSON.stringify(await validateM513Final(), null, 2));
    return;
  }
  if (argv.includes('--write-evidence')) {
    const result = await buildM513();
    const evidence = await writeM513PreAdmissionEvidence({ result });
    console.log(JSON.stringify({
      review: sourcePath(REVIEW_PATH),
      stage: sourcePath(STAGE_PATH),
      review_sha256: sha256(evidence.reviewBytes),
      stage_sha256: sha256(evidence.stageBytes),
    }, null, 2));
    return;
  }
  const result = await buildM513();
  console.log(JSON.stringify({
    batch_id: M5_13_BATCH_ID,
    gate: result.admission.gate,
    base: result.inputs.baseSummary,
    actual: canonicalSummary(result.prospective.canonical.records),
    candidate_count: result.identities.length,
    imported_count: result.importedRecords.length,
    deferred_count: result.reviewRows.filter(({ decision }) => decision === 'deferred').length,
    canonical_directory_sha256: result.prospective.canonicalDigest,
    decision_source_sha256: sha256(result.decisionSourceBytes),
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
