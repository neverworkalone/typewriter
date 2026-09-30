import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import Ajv from 'ajv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const TARGET_RECORD_COUNT = 7500;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (relativePath) => JSON.parse((await readFile(path.join(ROOT, relativePath))).toString('utf8'));

function renderMarkdown(report) {
  const [historical, corpus] = report.batches;
  return [
    '# Issue #222 — M9-D scale coverage checkpoint',
    '',
    `State: **${report.state}**. The approximately ${report.target.searchable_record_count.toLocaleString('en-US')} record target is still open.`,
    '',
    '## Progress',
    '',
    `The issue started from ${report.baseline.directly_searchable_record_count.toLocaleString('en-US')} directly searchable canonical records at ${report.baseline.commit}. The current canonical set has ${report.current.directly_searchable_record_count.toLocaleString('en-US')} directly searchable records, leaving ${report.remaining.records_to_target.toLocaleString('en-US')} to the target. The change admits ${report.aggregate.admitted_count} records from two bounded source classes.`,
    '',
    '| Source class | Reviewed | Admitted | Held | Rejected |',
    '| --- | ---: | ---: | ---: | ---: |',
    `| Historical recovery inventory | ${historical.candidate_count} | ${historical.admitted_count} | ${historical.held_count} | ${historical.rejected_count} |`,
    `| Local Written Corpus proposals | ${corpus.candidate_count} | ${corpus.admitted_count} | ${corpus.held_count} | ${corpus.rejected_count} |`,
    `| Total | ${report.aggregate.reviewed_count} | ${report.aggregate.admitted_count} | ${report.aggregate.held_count} | ${report.aggregate.rejected_count} |`,
    '',
    'Admission used the ordinary source-bound lexical producer, semantic audit, and exact-search checks. There was no admission quota. The authored decisions are marked as agent-authored and not human-reviewed.',
    '',
    '## Corpus evidence',
    '',
    `The local snapshot contains ${report.corpus_inventory.paragraph_count.toLocaleString('en-US')} paragraphs across ${report.corpus_inventory.document_count.toLocaleString('en-US')} documents. The bounded sample reviewed ${report.corpus_inventory.sample_paragraph_count.toLocaleString('en-US')} paragraphs (${(report.corpus_inventory.sample_fraction * 100).toFixed(2)}%). Extraction found ${report.corpus_inventory.unique_lemma_candidate_count.toLocaleString('en-US')} distinct lemma proposals before coverage checks; this is a retrieval pool, not an admission pool. The first 20 reviewed candidates yielded ${corpus.admitted_count} admissions and ${corpus.held_count} holds. No extrapolation is made from this single batch.`,
    '',
    'Raw paragraph text remains in ignored local reference data. Tracked evidence includes bounded paragraph identifiers and source digests only.',
    '',
    '## Reproducibility',
    '',
    `Run \`npm run batch:issue-222:check\` to validate both frozen source bindings, all candidate dispositions, shared production and semantic coverage, exact direct search, and two identical logical SQLite builds. Run \`npm run batch:issue-222:report\` to regenerate this Markdown and the machine report.`,
    '',
    `The checkpoint validates ${report.validation.directly_searchable_new_records} new records under exact search with ${report.validation.shared_admission_blocking_findings} shared admission blockers. Logical database builds compared: ${report.validation.logical_builds_compared}; identical: ${report.validation.deterministic_logical_contents}.`,
    '',
    '## Remaining work',
    '',
    `Continue bounded historical and corpus review batches, each capped at 20 candidates. The current evidence does not show an external or source-policy blocker; the scale target remains incomplete because only these two batches have been reviewed. Keep the target gap visible and do not use a quota or estimated yield to admit records.`,
    '',
  ].join('\n');
}

async function main() {
  const validation = await validateIssue222();
  const [candidateReviewBytes, corpusSemanticBytes, historicalCandidateBytes, historicalSemanticBytes,
    historicalBaseBytes, candidateReview, corpusSemantic, historicalCandidate, historicalSemantic,
    historicalBaseInventory, inventory, canonical] = await Promise.all([
    readFile(path.join(ROOT, 'data/batches/issue-222-m9-d-corpus-batch-01-candidate-review.json')),
    readFile(path.join(ROOT, 'data/batches/issue-222-m9-d-corpus-batch-01-semantic-decisions.json')),
    readFile(path.join(ROOT, 'data/batches/issue-222-m9-d-historical-candidate-source.json')),
    readFile(path.join(ROOT, 'data/batches/issue-222-m9-d-historical-semantic-decisions.json')),
    readFile(path.join(ROOT, 'data/batches/issue-222-m9-d-historical-base-recovery-inventory.json')),
    readJson('data/batches/issue-222-m9-d-corpus-batch-01-candidate-review.json'),
    readJson('data/batches/issue-222-m9-d-corpus-batch-01-semantic-decisions.json'),
    readJson('data/batches/issue-222-m9-d-historical-candidate-source.json'),
    readJson('data/batches/issue-222-m9-d-historical-semantic-decisions.json'),
    readJson('data/batches/issue-222-m9-d-historical-base-recovery-inventory.json'),
    readJson('data/inventory/issue-210-recovery-inventory.json'),
    readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY),
  ]);
  const corpusDecisions = candidateReview.decisions;
  const historicalDecisions = historicalSemantic.decisions;
  const count = (rows, decision) => rows.filter((row) => row.editorial_judgment?.disposition === decision
    || row.decision === decision).length;
  const canonicalDigest = canonicalRecordsSha256(canonical.records);
  const currentRecordCount = inventory.search_coverage.canonical_record_count;
  const directSearchCount = inventory.search_coverage.directly_searchable_record_count;
  assert.equal(currentRecordCount, canonical.records.length);
  assert.equal(directSearchCount, currentRecordCount);
  assert.equal(currentRecordCount, 5133, 'Issue #222 checkpoint is bound to the current 5,133-record canonical snapshot');
  assert.equal(validation.candidate_count, 40);
  assert.equal(validation.admitted_count, 28);
  assert.equal(validation.held_count, 12);
  assert.equal(candidateReview.source.source_text_committed, false);
  assert.equal(historicalBaseInventory.search_coverage.canonical_record_count, 5105);

  const report = {
    schema_version: 1,
    report_id: 'issue-222-m9-d-scale-coverage-report-v1',
    issue: 222,
    parent_issue: 218,
    state: 'in_progress',
    baseline: {
      commit: BASELINE_COMMIT,
      canonical_revision: BASELINE_CANONICAL_REVISION,
      canonical_record_count: 5105,
      directly_searchable_record_count: 5105,
    },
    target: {
      searchable_record_count: TARGET_RECORD_COUNT,
    },
    current: {
      canonical_revision: inventory.generated_from.current_canonical_revision,
      canonical_records_sha256: canonicalDigest,
      canonical_record_count: currentRecordCount,
      directly_searchable_record_count: directSearchCount,
      exact_search_key_count: inventory.search_coverage.exact_search_key_count,
      non_searchable_record_count: inventory.search_coverage.current_non_searchable_lexical_record_count,
    },
    batches: [
      {
        batch_id: historicalSemantic.batch_id,
        source_class: 'historical-recovery-inventory',
        candidate_count: historicalCandidate.candidates.length,
        admitted_count: count(historicalDecisions, 'included') + count(historicalDecisions, 'corrected'),
        held_count: count(historicalDecisions, 'held'),
        rejected_count: count(historicalDecisions, 'rejected'),
        candidate_source_sha256: sha256(historicalCandidateBytes),
        semantic_source_sha256: sha256(historicalSemanticBytes),
        canonical_import_record_count: 20,
      },
      {
        batch_id: candidateReview.batch_id,
        source_class: 'local-written-corpus',
        candidate_count: corpusDecisions.length,
        admitted_count: count(corpusDecisions, 'admit'),
        held_count: count(corpusDecisions, 'hold'),
        rejected_count: count(corpusDecisions, 'reject'),
        candidate_review_sha256: sha256(candidateReviewBytes),
        semantic_source_sha256: sha256(corpusSemanticBytes),
        canonical_import_record_count: 8,
      },
    ],
    aggregate: {
      reviewed_count: validation.candidate_count,
      admitted_count: validation.admitted_count,
      held_count: validation.held_count,
      rejected_count: validation.rejected_count,
      canonical_records_added: currentRecordCount - historicalBaseInventory.search_coverage.canonical_record_count,
      admission_quota_applied: false,
    },
    corpus_inventory: {
      source_count: candidateReview.source.index.source_count,
      document_count: candidateReview.source.index.document_count,
      paragraph_count: candidateReview.source.index.paragraph_count,
      sample_paragraph_count: candidateReview.source.index.sample_paragraph_count,
      sample_fraction: candidateReview.source.index.sample_fraction,
      unique_lemma_candidate_count: candidateReview.yield.unique_lemma_candidates_before_coverage,
      exact_canonical_lemma_candidate_count: candidateReview.yield.exact_canonical_lemma_candidates,
      uncovered_candidate_count: candidateReview.yield.coverage_status_counts_by_distinct_lemma.uncovered,
      surface_collision_candidate_count: candidateReview.yield.total_surface_collision_lemma_candidates,
      ambiguous_candidate_count: candidateReview.yield.ambiguous_lemma_candidates_before_coverage,
      oov_candidate_count: candidateReview.yield.oov_lemma_candidates_before_coverage,
      excluded_prior_lemma_count: candidateReview.yield.excluded_candidate_lemma_count,
      permission_record_sha256: candidateReview.source.permission_record_sha256,
      input_manifest_sha256: candidateReview.source.index.input_manifest_sha256,
      logical_rows_sha256: candidateReview.source.index.logical_rows_sha256,
      source_text_committed: candidateReview.source.source_text_committed,
      candidate_evidence_sha256: candidateReview.source_artifacts.candidate_evidence_sha256,
      candidate_selection_sha256: candidateReview.source_artifacts.candidate_selection_sha256,
    },
    validation: {
      command: 'npm run batch:issue-222:check',
      directly_searchable_new_records: validation.admitted_lemmas_directly_searchable,
      shared_admission_blocking_findings: validation.shared_admission_blocking_findings,
      semantic_coverage_complete: validation.semantic_coverage_complete,
      logical_builds_compared: validation.logical_builds_compared,
      deterministic_logical_contents: validation.deterministic_logical_contents,
      historical_base_inventory_sha256: sha256(historicalBaseBytes),
      corpus_review_human_reviewed: candidateReview.human_reviewed,
      historical_review_human_reviewed: historicalCandidate.human_reviewed,
    },
    remaining: {
      records_to_target: Math.max(0, TARGET_RECORD_COUNT - directSearchCount),
      documented_blocker: null,
      next_step: 'Continue bounded historical and corpus review batches, each limited to 20 candidates, until the target is reached or a source/quality blocker is documented.',
    },
  };
  const schema = await readJson('schema/issue-222-m9-d-scale-coverage-report.schema.json');
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  assert.equal(validate(report), true, `Issue #222 checkpoint report schema: ${ajv.errorsText(validate.errors)}`);
  await Promise.all([
    writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`),
    writeFile(REPORT_DOC_PATH, renderMarkdown(report)),
  ]);
  console.log(JSON.stringify({
    report_id: report.report_id,
    state: report.state,
    current_directly_searchable_record_count: report.current.directly_searchable_record_count,
    target_record_count: report.target.searchable_record_count,
    remaining_records: report.remaining.records_to_target,
    reviewed_count: report.aggregate.reviewed_count,
    admitted_count: report.aggregate.admitted_count,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.code ? `${error.code}: ${error.message}` : error.message);
  process.exitCode = 1;
});
