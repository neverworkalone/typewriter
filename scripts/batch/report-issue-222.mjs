import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import Ajv from 'ajv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildM9ProductionProgress } from './m9-production-progress.mjs';
import {
  buildIssue222NextStep,
  summarizeCandidateDecisions,
  summarizeCanonicalAudit,
} from './issue-222-report-audit.mjs';
import { readCanonicalRecords, DEFAULT_CANONICAL_DIRECTORY } from '../validate/canonical-jsonl.mjs';
import { canonicalRecordsSha256 } from '../validate/semantic-audit.mjs';
import { validateIssue222 } from './validate-issue-222.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');
const REPORT_PATH = path.join(ROOT, 'data/validation/issue-222-m9-d-scale-coverage-report.json');
const REPORT_SCHEMA_PATH = path.join(ROOT, 'schema/issue-222-m9-d-scale-coverage-report.schema.json');
const REPORT_DOC_PATH = path.join(ROOT, 'docs/issue-222-m9-d-scale-coverage.md');
const BASELINE_COMMIT = '77f52ae7ae8040146c25b75b2dcdf29f7b4f5e42';
const BASELINE_CANONICAL_REVISION = '56772da538d68d17fb1e04146f451b3868c9d5520fffd000585d6755e4561a2a';
const BASELINE_RECORD_COUNT = 5105;
const TARGET_RECORD_COUNT = 7500;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (relativePath) => JSON.parse((await readFile(path.join(ROOT, relativePath))).toString('utf8'));

export function buildIssue222NormalCiEvidence(canonicalSha256) {
  return {
    command: 'npm run ci:normal',
    check_name: 'Validate and test Typewriter',
    status_source: 'external-exact-head-pr-check',
    canonical_sha256: canonicalSha256,
  };
}

function parseJsonl(bytes, label) {
  return bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is invalid JSON: ${error.message}`);
    }
  });
}

function count(rows, decision) {
  return rows.filter((row) => row.editorial_judgment?.disposition === decision
    || row.decision === decision).length;
}

function compareBatchNames(left, right) {
  const leftNumber = Number(/corpus-batch-(\d+)/u.exec(left)?.[1]);
  const rightNumber = Number(/corpus-batch-(\d+)/u.exec(right)?.[1]);
  return leftNumber - rightNumber || left.localeCompare(right, 'en');
}

function countBy(rows, keyOf) {
  return rows.reduce((counts, row) => {
    const key = keyOf(row);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function mergeCounts(...sources) {
  const merged = {};
  for (const counts of sources) {
    for (const [key, value] of Object.entries(counts ?? {})) {
      merged[key] = (merged[key] ?? 0) + value;
    }
  }
  return Object.fromEntries(Object.entries(merged).sort(([left], [right]) => left.localeCompare(right, 'en')));
}

export function renderMarkdown(report) {
  const historical = report.batches.find(({ source_class: sourceClass }) => sourceClass === 'historical-recovery-inventory');
  const corpusBatches = report.batches.filter(({ source_class: sourceClass }) => sourceClass === 'local-written-corpus');
  const rows = [
    `| Historical recovery inventory | ${historical.candidate_count} | ${historical.admitted_count} | ${historical.held_count} | ${historical.rejected_count} |`,
    ...corpusBatches.map((batch) => (
      `| Local Written Corpus ${batch.batch_id} | ${batch.candidate_count} | ${batch.admitted_count} | ${batch.held_count} | ${batch.rejected_count} |`
    )),
    `| Total | ${report.aggregate.reviewed_count} | ${report.aggregate.admitted_count} | ${report.aggregate.held_count} | ${report.aggregate.rejected_count} |`,
  ];
  const corpusTotals = corpusBatches.reduce((totals, batch) => ({
    reviewed: totals.reviewed + batch.candidate_count,
    admitted: totals.admitted + batch.admitted_count,
    held: totals.held + batch.held_count,
    rejected: totals.rejected + batch.rejected_count,
  }), { reviewed: 0, admitted: 0, held: 0, rejected: 0 });
  const batchReviewRows = corpusBatches.map((batch) => (
    `| ${batch.batch_id} | ${batch.candidate_limit} | ${batch.candidate_count} | ${batch.admitted_count} | ${batch.held_count} | ${batch.rejected_count} |`
  ));
  const holdReasons = Object.entries(report.production_audit.hold_reason_counts)
    .map(([reason, count]) => `${reason}: ${count}`).join('; ') || 'none';
  const rejectReasons = Object.entries(report.production_audit.reject_reason_counts)
    .map(([reason, count]) => `${reason}: ${count}`).join('; ') || 'none';
  const historicalRemainingRows = report.historical_pool.remaining_counts_by_disposition
    .map(({ disposition, count }) => `| ${disposition} | ${count} |`);
  const unresolvedReviewRows = report.production_audit.unresolved_review_inventory
    .map(({ source, finding_class: findingClass, count }) => `| ${source} | ${findingClass} | ${count} |`);
  const recordTypeRows = Object.entries(report.current.record_type_counts)
    .map(([recordType, count]) => `| ${recordType} | ${count} |`);
  const posRows = Object.entries(report.current.sense_pos_counts)
    .map(([pos, count]) => `| ${pos} | ${count} |`);
  return [
    '# Issue #222 — M9-D scale coverage checkpoint',
    '',
    `State: **${report.state}**. The ${report.target.searchable_record_count.toLocaleString('en-US')} record target remains ${report.state === 'complete' ? 'reached' : 'open'}.`,
    '',
    '## Progress',
    '',
    `The issue started from ${report.baseline.directly_searchable_record_count.toLocaleString('en-US')} directly searchable canonical records at ${report.baseline.commit}. The current canonical set has ${report.current.directly_searchable_record_count.toLocaleString('en-US')} directly searchable records, leaving ${report.remaining.records_to_target.toLocaleString('en-US')} to the target. The historical recovery batch and ${corpusBatches.length} bounded corpus batches reviewed ${report.aggregate.reviewed_count} candidates and admitted ${report.aggregate.canonical_records_added} records.`,
    '',
    '| Source class | Reviewed | Admitted | Held | Rejected |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
    'Admission used the ordinary source-bound lexical producer, semantic audit, and exact-search checks. There was no admission quota. Each authored batch is marked as agent-authored and not human-reviewed.',
    '',
    '## Corpus evidence',
    '',
    `The local snapshot contains ${report.corpus_inventory.paragraph_count.toLocaleString('en-US')} paragraphs across ${report.corpus_inventory.document_count.toLocaleString('en-US')} documents. Each selection reviewed the same ${report.corpus_inventory.sample_paragraph_count.toLocaleString('en-US')}-paragraph bounded sample (${(report.corpus_inventory.sample_fraction * 100).toFixed(2)}%). The retrieval pool contained ${report.corpus_inventory.unique_lemma_candidate_count.toLocaleString('en-US')} distinct lemma proposals before coverage checks. That pool sets review order only; it does not authorize admission.`,
    '',
    '| Corpus batch | Candidate limit | Reviewed | Admitted | Held | Rejected |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...batchReviewRows,
    `| Total | — | ${corpusTotals.reviewed} | ${corpusTotals.admitted} | ${corpusTotals.held} | ${corpusTotals.rejected} |`,
    '',
    'Raw paragraph text remains in ignored local reference data. Tracked evidence includes bounded paragraph identifiers and source digests only.',
    '',
    '## Reproducibility',
    '',
    `Run \`npm run batch:issue-222:report:check\` to validate the checkpoint from tracked candidate reviews, semantic decisions, imports, inventories, and current canonical data, including shared admission, semantic coverage, exact direct search, and two identical logical SQLite builds. Run \`npm run batch:issue-222:check\` locally for the additional permission-bound corpus evidence checks that read ignored \`data/reference/\` artifacts.`,
    '',
    `The checkpoint validates ${report.validation.directly_searchable_new_records} records added since the baseline under exact search with ${report.validation.shared_admission_blocking_findings} shared admission blockers. Logical database builds compared: ${report.validation.logical_builds_compared}; identical: ${report.validation.deterministic_logical_contents}.`,
    '',
    '## Checkpoint audit',
    '',
    `Current canonical inventory: ${report.current.canonical_record_count} records, ${report.current.directly_searchable_record_count} directly searchable, ${report.current.non_searchable_record_count} non-searchable, ${report.current.sense_count} senses, and ${report.current.relation_count} relations. Relation-empty searchable records: ${report.current.relation_empty_searchable_record_count}.`,
    '',
    '| Record type | Records |',
    '| --- | ---: |',
    ...recordTypeRows,
    '',
    '| Sense POS | Senses |',
    '| --- | ---: |',
    ...posRows,
    '',
    `Exact lemma coverage: ${report.current.exact_search_coverage.covered_lemma_count}/${report.current.exact_search_coverage.expected_lemma_count}; exact search-form owner keys: ${report.current.exact_search_coverage.covered_form_owner_key_count}/${report.current.exact_search_coverage.expected_form_owner_key_count}; missing owners: ${report.current.exact_search_coverage.missing_form_owner_key_count}; unexpected owners: ${report.current.exact_search_coverage.unexpected_form_owner_key_count}; cross-record collisions: ${report.current.exact_search_coverage.cross_record_collision_key_count}.`,
    '',
    '### Candidate yield and disposition',
    '',
    `The initial corpus candidate pool had ${report.production_audit.initial_candidate_pool.unique_lemma_candidate_count} distinct lemma proposals. ${report.production_audit.initial_candidate_pool.exact_canonical_lemma_count} were already exact-lemma covered and ${report.production_audit.initial_candidate_pool.surface_collision_candidate_count} had search-surface collisions; covered or colliding proposals were ${(report.production_audit.initial_candidate_pool.covered_or_colliding_rate * 100).toFixed(2)}% of that pool.`,
    `Across reviewed batches, hold reasons were ${holdReasons}; rejection reasons were ${rejectReasons}.`,
    '',
    '| Historical recovery remaining disposition | Count |',
    '| --- | ---: |',
    ...historicalRemainingRows,
    `| Historical rows recovered | ${report.historical_pool.recovered_count} |`,
    `| Potentially recoverable rows remaining | ${report.historical_pool.potentially_recoverable_after_count} |`,
    '',
    '### Unresolved review inventory',
    '',
    '| Source | Finding class | Count |',
    '| --- | --- | ---: |',
    ...unresolvedReviewRows,
    '',
    '### Batch and system correction history',
    '',
    '| Batch | POS corrections | Semantic corrections | Correction passes |',
    '| --- | ---: | ---: | ---: |',
    ...report.batches.map((batch) => `| ${batch.batch_id} | ${batch.candidate_pos_correction_count} | ${batch.semantic_corrected_count} | ${batch.correction_pass_count} |`),
    '',
    `Correction rate: **${report.production_audit.correction_rate_status}**. Writer review burden: **${report.production_audit.writer_review_burden_status}**. Systemic defect classes: ${report.production_audit.systemic_defect_classes.length}; shared system fixes recorded: ${report.production_audit.system_fixes.length}.`,
    '',
    `Normal CI status: read the exact-head GitHub PR check **${report.normal_ci.check_name}** (\`${report.normal_ci.command}\`); this report stores no pass/fail result and never reuses an earlier report's status. Canonical digest: \`${report.normal_ci.canonical_sha256}\`.`,
    `Runtime/package impact: **${report.runtime_package_impact.status}**. The packaged dictionary grew from ${report.runtime_package_impact.baseline_dictionary_record_count.toLocaleString('en-US')} to ${report.runtime_package_impact.current_dictionary_record_count.toLocaleString('en-US')} records (+${report.runtime_package_impact.dictionary_record_delta.toLocaleString('en-US')}; ${(report.runtime_package_impact.dictionary_record_growth_rate * 100).toFixed(2)}%). Runtime contract changed: ${report.runtime_package_impact.runtime_contract_changed}; package bytes measured: ${report.runtime_package_impact.dictionary_package_bytes_measured}. ${report.runtime_package_impact.rationale} Targeted validation: ${report.runtime_package_impact.targeted_validation}.`,
    '',
    '## Continuation',
    '',
    `The M9 production ledger processed ${report.continuation.batches_processed} review batches from ${report.continuation.canonical_count_at_start.toLocaleString('en-US')} to ${report.continuation.canonical_count_now.toLocaleString('en-US')} directly searchable records. ${report.continuation.remaining_to_checkpoint.toLocaleString('en-US')} remain to the checkpoint; continuation required: **${report.continuation.continuation_required}**. ${report.state === 'complete' ? 'The completed M9-D checkpoint hands continued expansion to M9-E (#223).' : 'Clean batches continue while unseen in-scope candidates remain.'}`,
    '',
    '## Remaining work',
    '',
    report.remaining.next_step,
    '',
    report.remaining.documented_blocker ? `Documented blocker: ${report.remaining.documented_blocker}` : 'No product-model, licensing, or source-exhaustion blocker is currently documented.',
    '',
  ].join('\n');
}

async function buildReport() {
  const validation = await validateIssue222({ verifyLocalCorpusEvidence: false });
  const batchDirectory = path.join(ROOT, 'data/batches');
  const corpusReviewNames = (await readdir(batchDirectory))
    .filter((name) => /^issue-222-m9-d-corpus-batch-\d+-candidate-review\.json$/u.test(name))
    .sort(compareBatchNames);
  assert.ok(corpusReviewNames.length > 0, 'Issue #222 needs at least one bounded corpus review batch');
  const corpusBatches = await Promise.all(corpusReviewNames.map(async (reviewName) => {
    const stem = reviewName.replace(/-candidate-review\.json$/u, '');
    const [candidateReviewBytes, semanticSourceBytes, importBytes] = await Promise.all([
      readFile(path.join(batchDirectory, reviewName)),
      readFile(path.join(batchDirectory, `${stem}-semantic-decisions.json`)),
      readFile(path.join(ROOT, 'data/canonical', `${stem}.jsonl`)),
    ]);
    const candidateReview = JSON.parse(candidateReviewBytes.toString('utf8'));
    const semanticSource = JSON.parse(semanticSourceBytes.toString('utf8'));
    const importedRecords = parseJsonl(importBytes, `${stem} canonical import`);
    const decisions = candidateReview.decisions;
    const candidateSummary = summarizeCandidateDecisions(decisions);
    const semanticCounts = semanticSource.review?.counts ?? {};
    return {
      batch_id: candidateReview.batch_id,
      source_class: 'local-written-corpus',
      candidate_limit: candidateReview.selection.candidate_limit,
      candidate_count: decisions.length,
      admitted_count: count(decisions, 'admit'),
      held_count: count(decisions, 'hold'),
      rejected_count: count(decisions, 'reject'),
      hold_reason_counts: candidateSummary.hold_reason_counts,
      reject_reason_counts: candidateSummary.reject_reason_counts,
      candidate_pos_correction_count: candidateSummary.pos_correction_count,
      semantic_corrected_count: semanticCounts.corrected ?? 0,
      correction_pass_count: semanticSource.review?.correction_passes?.length ?? 0,
      correction_rate_status: candidateReview.yield.correction_rate,
      writer_review_burden_status: candidateReview.yield.editorial_workload,
      candidate_review_sha256: sha256(candidateReviewBytes),
      candidate_evidence_sha256: candidateReview.source_artifacts.candidate_evidence_sha256,
      candidate_selection_sha256: candidateReview.source_artifacts.candidate_selection_sha256,
      semantic_source_sha256: sha256(semanticSourceBytes),
      canonical_import_record_count: importedRecords.length,
      prior_lemma_exclusion_count: candidateReview.yield.excluded_candidate_lemma_count,
      human_reviewed: candidateReview.human_reviewed,
      corpus_snapshot_binding: {
        permission_record_sha256: candidateReview.source.permission_record_sha256,
        input_manifest_sha256: candidateReview.source.index.input_manifest_sha256,
        logical_rows_sha256: candidateReview.source.index.logical_rows_sha256,
      },
      candidate_review: candidateReview,
      semantic_source: semanticSource,
    };
  }));
  const [historicalCandidateBytes, historicalSemanticBytes, historicalBaseBytes,
    historicalCandidate, historicalSemantic, historicalBaseInventory, inventory,
    canonical] = await Promise.all([
    readFile(path.join(ROOT, 'data/batches/issue-222-m9-d-historical-candidate-source.json')),
    readFile(path.join(ROOT, 'data/batches/issue-222-m9-d-historical-semantic-decisions.json')),
    readFile(path.join(ROOT, 'data/batches/issue-222-m9-d-historical-base-recovery-inventory.json')),
    readJson('data/batches/issue-222-m9-d-historical-candidate-source.json'),
    readJson('data/batches/issue-222-m9-d-historical-semantic-decisions.json'),
    readJson('data/batches/issue-222-m9-d-historical-base-recovery-inventory.json'),
    readJson('data/inventory/issue-210-recovery-inventory.json'),
    readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY),
  ]);
  const historicalDecisions = historicalSemantic.decisions;
  const historicalAdmitted = count(historicalDecisions, 'included') + count(historicalDecisions, 'corrected');
  const historicalBatch = {
    batch_id: historicalSemantic.batch_id,
    source_class: 'historical-recovery-inventory',
    candidate_count: historicalCandidate.candidates.length,
    admitted_count: historicalAdmitted,
    held_count: count(historicalDecisions, 'held'),
    rejected_count: count(historicalDecisions, 'rejected'),
    hold_reason_counts: {},
    reject_reason_counts: {},
    candidate_pos_correction_count: 0,
    semantic_corrected_count: historicalSemantic.review?.counts?.corrected ?? 0,
    correction_pass_count: historicalSemantic.review?.correction_passes?.length ?? 0,
    correction_rate_status: 'NOT_MEASURED_NO_HUMAN_REVIEW',
    writer_review_burden_status: 'NOT_MEASURED_NO_WRITER_REVIEW',
    candidate_source_sha256: sha256(historicalCandidateBytes),
    semantic_source_sha256: sha256(historicalSemanticBytes),
    canonical_import_record_count: 20,
  };
  const allBatches = [historicalBatch, ...corpusBatches];
  const corpusBatchTotals = corpusBatches.reduce((totals, batch) => ({
    candidates: totals.candidates + batch.candidate_count,
    admitted: totals.admitted + batch.admitted_count,
    held: totals.held + batch.held_count,
    rejected: totals.rejected + batch.rejected_count,
  }), { candidates: 0, admitted: 0, held: 0, rejected: 0 });
  const canonicalDigest = canonicalRecordsSha256(canonical.records);
  const currentRecordCount = inventory.search_coverage.canonical_record_count;
  const directSearchCount = inventory.search_coverage.directly_searchable_record_count;
  assert.equal(currentRecordCount, canonical.records.length);
  assert.equal(directSearchCount, currentRecordCount);
  assert.equal(currentRecordCount, validation.admitted_lemmas_directly_searchable + BASELINE_RECORD_COUNT,
    'Issue #222 canonical total is the baseline plus directly searchable additions');
  assert.equal(validation.candidate_count, historicalBatch.candidate_count + corpusBatchTotals.candidates);
  assert.equal(validation.admitted_count, historicalAdmitted + corpusBatchTotals.admitted);
  assert.equal(validation.held_count, historicalBatch.held_count + corpusBatchTotals.held);
  assert.equal(validation.rejected_count, historicalBatch.rejected_count + corpusBatchTotals.rejected);
  assert.equal(corpusBatches.every(({ human_reviewed: humanReviewed }) => humanReviewed === false), true);
  assert.equal(historicalBaseInventory.search_coverage.canonical_record_count, BASELINE_RECORD_COUNT);
  const canonicalAudit = summarizeCanonicalAudit(canonical.records, inventory.search_coverage);
  const corpusDecisionAudit = summarizeCandidateDecisions(
    corpusBatches.flatMap(({ candidate_review: candidateReview }) => candidateReview.decisions),
  );
  const firstCorpusReview = corpusBatches[0].candidate_review;
  const corpusSnapshot = firstCorpusReview.source.index;
  for (const batch of corpusBatches) {
    assert.deepEqual(batch.corpus_snapshot_binding, corpusBatches[0].corpus_snapshot_binding,
      `${batch.batch_id} must retain the same permission-bound corpus snapshot`);
    assert.equal(batch.candidate_review.source.source_text_committed, false);
  }
  const progress = buildM9ProductionProgress({
    checkpoint_target: TARGET_RECORD_COUNT,
    canonical_count_at_start: BASELINE_RECORD_COUNT,
    canonical_count_now: directSearchCount,
    batches_processed: allBatches.length,
    candidate_yield: {
      selected_count: validation.candidate_count,
      admitted_count: validation.admitted_count,
      held_count: validation.held_count,
      rejected_count: validation.rejected_count,
    },
    defect_classes: [],
    source_exhausted: false,
    blocker: null,
  });
  const initialCandidatePool = firstCorpusReview.yield;
  const coveredOrCollidingCandidateCount = initialCandidatePool.exact_canonical_lemma_candidates
    + initialCandidatePool.total_surface_collision_lemma_candidates;
  const currentHistoricalDispositionCounts = countBy(
    inventory.recovery_candidates,
    ({ new_review_state: state }) => state,
  );
  const currentHistoricalRecoverableCount = inventory.recovery_candidates.filter(({ new_review_state: state }) => (
    ['admit-candidate', 'hold', 'needs-sense-split'].includes(state)
  )).length;
  const baselineHistoricalRecoverableCount = historicalBaseInventory.recovery_candidates.filter(({ new_review_state: state }) => (
    ['admit-candidate', 'hold', 'needs-sense-split'].includes(state)
  )).length;
  const historicalRemainingByDisposition = Object.entries(currentHistoricalDispositionCounts)
    .filter(([disposition]) => disposition !== 'recovered')
    .map(([disposition, dispositionCount]) => ({ disposition, count: dispositionCount }));
  const issue222CorpusHoldReasons = Object.entries(corpusDecisionAudit.hold_reason_counts)
    .map(([findingClass, count]) => ({ source: 'issue-222-corpus-reviews', finding_class: findingClass, count }));
  const unresolvedReviewInventory = [
    {
      source: 'current-canonical-exact-search-audit',
      finding_class: 'non-searchable-canonical-records',
      count: canonicalAudit.exact_search_coverage.non_searchable_record_count,
    },
    {
      source: 'current-canonical-exact-search-audit',
      finding_class: 'cross-record-search-collisions',
      count: canonicalAudit.exact_search_coverage.cross_record_collision_key_count,
    },
    {
      source: 'issue-210-historical-recovery-pool',
      finding_class: 'unresolved-sense-pos-or-context-cases',
      count: inventory.summary.unresolved_sense_pos_or_context_case_count,
    },
    {
      source: 'issue-210-historical-recovery-pool',
      finding_class: 'search-surface-collisions',
      count: inventory.summary.search_collision_count,
    },
    {
      source: 'issue-210-historical-recovery-pool',
      finding_class: 'true-duplicates',
      count: inventory.summary.true_duplicate_count,
    },
    ...issue222CorpusHoldReasons,
  ];
  const correctionRateStatuses = new Set(corpusBatches.map(({ correction_rate_status: status }) => status));
  const writerReviewBurdenStatuses = new Set(corpusBatches.map(({ writer_review_burden_status: status }) => status));
  assert.equal(
    Object.values(currentHistoricalDispositionCounts).reduce((total, count) => total + count, 0),
    inventory.recovery_candidates.length,
    'historical disposition counts must account for every recovery candidate',
  );
  assert.deepEqual(currentHistoricalDispositionCounts, inventory.summary.review_state_counts,
    'historical recovery disposition counts must match the inventory summary');
  assert.equal(canonicalAudit.exact_search_coverage.expected_form_owner_key_count, inventory.search_coverage.exact_search_key_count);
  const report = {
    schema_version: 1,
    report_id: 'issue-222-m9-d-scale-coverage-report-v1',
    issue: 222,
    parent_issue: 218,
    state: directSearchCount >= TARGET_RECORD_COUNT ? 'complete' : 'in_progress',
    baseline: {
      commit: BASELINE_COMMIT,
      canonical_revision: BASELINE_CANONICAL_REVISION,
      canonical_record_count: BASELINE_RECORD_COUNT,
      directly_searchable_record_count: BASELINE_RECORD_COUNT,
    },
    target: { searchable_record_count: TARGET_RECORD_COUNT },
    current: {
      canonical_revision: inventory.generated_from.current_canonical_revision,
      canonical_records_sha256: canonicalDigest,
      canonical_record_count: currentRecordCount,
      directly_searchable_record_count: directSearchCount,
      exact_search_key_count: inventory.search_coverage.exact_search_key_count,
      non_searchable_record_count: inventory.search_coverage.current_non_searchable_lexical_record_count,
      record_type_counts: canonicalAudit.record_type_counts,
      role_counts: canonicalAudit.role_counts,
      sense_pos_counts: canonicalAudit.sense_pos_counts,
      sense_count: canonicalAudit.sense_count,
      relation_count: canonicalAudit.relation_count,
      canonical_search_form_count: canonicalAudit.canonical_search_form_count,
      relation_empty_searchable_record_count: canonicalAudit.relation_empty_searchable_record_count,
      exact_search_coverage: canonicalAudit.exact_search_coverage,
    },
    batches: allBatches.map(({ candidate_review: ignoredReview, semantic_source: ignoredSource,
      corpus_snapshot_binding: ignoredBinding, candidate_limit: ignoredLimit,
      prior_lemma_exclusion_count: ignoredExclusions, human_reviewed: ignoredHumanReview,
      candidate_evidence_sha256: ignoredEvidence, candidate_selection_sha256: ignoredSelection, ...batch }) => ({
      ...batch,
      ...(corpusBatches.some(({ batch_id: batchId }) => batchId === batch.batch_id)
        ? {
          candidate_limit: corpusBatches.find(({ batch_id: batchId }) => batchId === batch.batch_id).candidate_limit,
          candidate_evidence_sha256: corpusBatches.find(({ batch_id: batchId }) => batchId === batch.batch_id).candidate_evidence_sha256,
          candidate_selection_sha256: corpusBatches.find(({ batch_id: batchId }) => batchId === batch.batch_id).candidate_selection_sha256,
          prior_lemma_exclusion_count: corpusBatches.find(({ batch_id: batchId }) => batchId === batch.batch_id).prior_lemma_exclusion_count,
          human_reviewed: corpusBatches.find(({ batch_id: batchId }) => batchId === batch.batch_id).human_reviewed,
        }
        : {}),
    })),
    aggregate: {
      reviewed_count: validation.candidate_count,
      admitted_count: validation.admitted_count,
      held_count: validation.held_count,
      rejected_count: validation.rejected_count,
      canonical_records_added: currentRecordCount - BASELINE_RECORD_COUNT,
      admission_quota_applied: false,
    },
    historical_pool: {
      candidate_count: inventory.recovery_candidates.length,
      recovered_before_count: historicalBaseInventory.summary.review_state_counts.recovered ?? 0,
      recovered_count: currentHistoricalDispositionCounts.recovered ?? 0,
      recovered_in_issue_222_count: inventory.summary.issue_222_historical_admitted_count,
      potentially_recoverable_before_count: baselineHistoricalRecoverableCount,
      potentially_recoverable_after_count: currentHistoricalRecoverableCount,
      recovery_ceiling: directSearchCount + currentHistoricalRecoverableCount,
      remaining_count: inventory.recovery_candidates.length - (currentHistoricalDispositionCounts.recovered ?? 0),
      remaining_counts_by_disposition: historicalRemainingByDisposition,
      unresolved_sense_pos_or_context_case_count: inventory.summary.unresolved_sense_pos_or_context_case_count,
      search_collision_count: inventory.summary.search_collision_count,
      true_duplicate_count: inventory.summary.true_duplicate_count,
    },
    corpus_inventory: {
      source_count: firstCorpusReview.source.index.source_count,
      document_count: firstCorpusReview.source.index.document_count,
      paragraph_count: firstCorpusReview.source.index.paragraph_count,
      sample_paragraph_count: firstCorpusReview.source.index.sample_paragraph_count,
      sample_fraction: firstCorpusReview.source.index.sample_fraction,
      unique_lemma_candidate_count: firstCorpusReview.yield.unique_lemma_candidates_before_coverage,
      exact_canonical_lemma_candidate_count: firstCorpusReview.yield.exact_canonical_lemma_candidates,
      uncovered_candidate_count: firstCorpusReview.yield.coverage_status_counts_by_distinct_lemma.uncovered,
      surface_collision_candidate_count: firstCorpusReview.yield.total_surface_collision_lemma_candidates,
      ambiguous_candidate_count: firstCorpusReview.yield.ambiguous_lemma_candidates_before_coverage,
      oov_candidate_count: firstCorpusReview.yield.oov_lemma_candidates_before_coverage,
      prior_lemma_exclusion_count_first_batch: corpusBatches[0].prior_lemma_exclusion_count,
      prior_lemma_exclusion_count_latest_batch: corpusBatches.at(-1).prior_lemma_exclusion_count,
      reviewed_batch_count: corpusBatches.length,
      reviewed_candidate_count: corpusBatchTotals.candidates,
      permission_record_sha256: firstCorpusReview.source.permission_record_sha256,
      input_manifest_sha256: corpusSnapshot.input_manifest_sha256,
      logical_rows_sha256: corpusSnapshot.logical_rows_sha256,
      source_text_committed: firstCorpusReview.source.source_text_committed,
      initial_covered_or_colliding_candidate_count: coveredOrCollidingCandidateCount,
      initial_covered_or_colliding_candidate_rate: initialCandidatePool.unique_lemma_candidates_before_coverage === 0
        ? 0
        : coveredOrCollidingCandidateCount / initialCandidatePool.unique_lemma_candidates_before_coverage,
    },
    production_audit: {
      hold_reason_counts: corpusDecisionAudit.hold_reason_counts,
      reject_reason_counts: corpusDecisionAudit.reject_reason_counts,
      initial_candidate_pool: {
        unique_lemma_candidate_count: initialCandidatePool.unique_lemma_candidates_before_coverage,
        exact_canonical_lemma_count: initialCandidatePool.exact_canonical_lemma_candidates,
        surface_collision_candidate_count: initialCandidatePool.total_surface_collision_lemma_candidates,
        covered_or_colliding_candidate_count: coveredOrCollidingCandidateCount,
        uncovered_candidate_count: initialCandidatePool.coverage_status_counts_by_distinct_lemma.uncovered,
        covered_or_colliding_rate: initialCandidatePool.unique_lemma_candidates_before_coverage === 0
          ? 0
          : coveredOrCollidingCandidateCount / initialCandidatePool.unique_lemma_candidates_before_coverage,
        prior_lemma_exclusion_count_latest_batch: corpusBatches.at(-1).prior_lemma_exclusion_count,
      },
      unresolved_review_inventory: unresolvedReviewInventory,
      correction_rate_status: correctionRateStatuses.size === 1
        ? [...correctionRateStatuses][0]
        : 'MIXED_REVIEW_STATUS',
      writer_review_burden_status: writerReviewBurdenStatuses.size === 1
        ? [...writerReviewBurdenStatuses][0]
        : 'MIXED_REVIEW_STATUS',
      candidate_pos_correction_count: allBatches.reduce((total, batch) => total + batch.candidate_pos_correction_count, 0),
      semantic_corrected_count: allBatches.reduce((total, batch) => total + batch.semantic_corrected_count, 0),
      correction_pass_count: allBatches.reduce((total, batch) => total + batch.correction_pass_count, 0),
      systemic_defect_classes: progress.defect_classes,
      system_fixes: [],
    },
    validation: {
      command: 'npm run batch:issue-222:report:check',
      local_corpus_evidence_command: 'npm run batch:issue-222:check',
      directly_searchable_new_records: validation.admitted_lemmas_directly_searchable,
      shared_admission_blocking_findings: validation.shared_admission_blocking_findings,
      semantic_coverage_complete: validation.semantic_coverage_complete,
      additional_corpus_batch_semantic_coverage_complete: validation.additional_corpus_batches_semantic_coverage_complete,
      logical_builds_compared: validation.logical_builds_compared,
      deterministic_logical_contents: validation.deterministic_logical_contents,
      historical_base_inventory_sha256: sha256(historicalBaseBytes),
      corpus_reviews_human_reviewed: false,
      historical_review_human_reviewed: historicalCandidate.human_reviewed,
    },
    normal_ci: buildIssue222NormalCiEvidence(canonicalDigest),
    runtime_package_impact: {
      status: 'dictionary-record-count-growth-runtime-contract-unchanged-package-bytes-not-measured',
      baseline_dictionary_record_count: BASELINE_RECORD_COUNT,
      current_dictionary_record_count: currentRecordCount,
      dictionary_record_delta: currentRecordCount - BASELINE_RECORD_COUNT,
      dictionary_record_growth_rate: (currentRecordCount - BASELINE_RECORD_COUNT) / BASELINE_RECORD_COUNT,
      dictionary_package_bytes_measured: false,
      runtime_contract_changed: false,
      rationale: 'Issue #222 adds canonical data without changing dictionary schema, search algorithm, or runtime/package code. Normal CI builds the current Extension and Web outputs and validates their product-output contracts; the dictionary record-count growth is measured here, while the package-byte delta was not measured separately.',
      targeted_validation: 'normal-ci-product-build-and-output-contract',
    },
    continuation: progress,
    remaining: {
      records_to_target: Math.max(0, TARGET_RECORD_COUNT - directSearchCount),
      documented_blocker: null,
      next_step: buildIssue222NextStep({
        state: directSearchCount >= TARGET_RECORD_COUNT ? 'complete' : 'in_progress',
        targetRecordCount: TARGET_RECORD_COUNT,
        currentRecordCount: directSearchCount,
      }),
    },
  };
  const schema = await readJson('schema/issue-222-m9-d-scale-coverage-report.schema.json');
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  assert.equal(validate(report), true, `Issue #222 checkpoint report schema: ${ajv.errorsText(validate.errors)}`);
  return { report, markdown: renderMarkdown(report) };
}

export async function main() {
  const checkMode = process.argv.includes('--check');
  const { report, markdown } = await buildReport();
  const machineReport = `${JSON.stringify(report, null, 2)}\n`;
  if (checkMode) {
    const [storedMachineReport, storedMarkdown] = await Promise.all([
      readFile(REPORT_PATH, 'utf8'),
      readFile(REPORT_DOC_PATH, 'utf8'),
    ]);
    assert.equal(storedMachineReport, machineReport,
      'Issue #222 machine checkpoint report is stale; run npm run batch:issue-222:report');
    assert.equal(storedMarkdown, markdown,
      'Issue #222 Markdown checkpoint report is stale; run npm run batch:issue-222:report');
  } else {
    await Promise.all([
      writeFile(REPORT_PATH, machineReport),
      writeFile(REPORT_DOC_PATH, markdown),
    ]);
  }
  console.log(JSON.stringify({
    report_id: report.report_id,
    state: report.state,
    current_directly_searchable_record_count: report.current.directly_searchable_record_count,
    target_record_count: report.target.searchable_record_count,
    remaining_records: report.remaining.records_to_target,
    reviewed_count: report.aggregate.reviewed_count,
    admitted_count: report.aggregate.admitted_count,
    corpus_batch_count: report.corpus_inventory.reviewed_batch_count,
    continuation_required: report.continuation.continuation_required,
  }, null, 2));
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.code ? `${error.code}: ${error.message}` : error.message);
    process.exitCode = 1;
  });
}
