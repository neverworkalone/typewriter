import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import Ajv from 'ajv';
import {
  buildIssue222NextStep,
  summarizeCandidateDecisions,
  summarizeCanonicalAudit,
} from '../scripts/batch/issue-222-report-audit.mjs';
import {
  buildIssue222NormalCiEvidence,
  renderMarkdown,
} from '../scripts/batch/report-issue-222.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const REPORT_PATH = path.join(ROOT, 'data/validation/issue-222-m9-d-scale-coverage-report.json');
const REPORT_DOC_PATH = path.join(ROOT, 'docs/issue-222-m9-d-scale-coverage.md');
const REPORT_SCHEMA_PATH = path.join(ROOT, 'schema/issue-222-m9-d-scale-coverage-report.schema.json');

test('summarizes searchable canonical records, senses, relations, POS, and exact keys', () => {
  const records = [
    { record: {
      id: 'w1', record_type: 'entry', role: 'start', lemma: '가', search_forms: ['가', '가는'],
      senses: [{ pos: 'noun', relations: [{ target: 'w2' }] }],
    } },
    { record: {
      id: 'w2', record_type: 'expression', role: 'reference-only', lemma: '마음속', search_forms: ['마음속'],
      senses: [{ pos: 'expression' }],
    } },
  ];
  const summary = summarizeCanonicalAudit(records, {
    canonical_record_count: 2,
    directly_searchable_record_count: 2,
    current_non_searchable_lexical_record_count: 0,
    current_non_searchable_lexical_records: [],
    exact_search_key_count: 3,
    missing_expected_key_owners: [],
    unexpected_key_owners: [],
    cross_record_key_collision_count: 0,
  });

  assert.deepEqual(summary.record_type_counts, { entry: 1, expression: 1 });
  assert.deepEqual(summary.role_counts, { 'reference-only': 1, start: 1 });
  assert.deepEqual(summary.sense_pos_counts, { expression: 1, noun: 1 });
  assert.equal(summary.sense_count, 2);
  assert.equal(summary.relation_count, 1);
  assert.equal(summary.canonical_search_form_count, 3);
  assert.equal(summary.relation_empty_searchable_record_count, 1);
  assert.equal(summary.exact_search_coverage.expected_lemma_count, 2);
  assert.equal(summary.exact_search_coverage.covered_form_owner_key_count, 3);
});

test('summarizes candidate hold and rejection reasons without dropping correction evidence', () => {
  const summary = summarizeCandidateDecisions([
    { editorial_judgment: { disposition: 'hold', disposition_basis: 'unresolved-sense' } },
    { editorial_judgment: { disposition: 'reject', disposition_basis: 'unsupported-scope' } },
    { editorial_judgment: { disposition: 'admit', disposition_basis: 'valid-in-scope-lexical-entry', pos_correction: {} } },
  ]);

  assert.deepEqual(summary.disposition_counts, { admit: 1, hold: 1, reject: 1 });
  assert.deepEqual(summary.hold_reason_counts, { 'unresolved-sense': 1 });
  assert.deepEqual(summary.reject_reason_counts, { 'unsupported-scope': 1 });
  assert.equal(summary.pos_correction_count, 1);
});

test('a completed M9-D report hands continuation to M9-E', () => {
  const nextStep = buildIssue222NextStep({ state: 'complete', targetRecordCount: 7500, currentRecordCount: 7521 });
  assert.match(nextStep, /M9-E \(#223\)/u);
  assert.match(nextStep, /10,000/u);
  assert.doesNotMatch(nextStep, /continue.*7,500/u);
});

test('normal CI evidence delegates to the exact-head PR check without caching a prior result', async () => {
  const report = JSON.parse(await readFile(REPORT_PATH, 'utf8'));

  assert.deepEqual(
    buildIssue222NormalCiEvidence(report.current.canonical_records_sha256),
    {
      command: 'npm run ci:normal',
      check_name: 'Validate and test Typewriter',
      status_source: 'external-exact-head-pr-check',
      canonical_sha256: report.current.canonical_records_sha256,
    },
  );
  assert.equal(Object.hasOwn(report.normal_ci, 'result'), false);
});

test('checkpoint JSON conforms to schema and its Markdown is regenerated from that JSON', async () => {
  const [reportBytes, document, schemaBytes] = await Promise.all([
    readFile(REPORT_PATH, 'utf8'),
    readFile(REPORT_DOC_PATH, 'utf8'),
    readFile(REPORT_SCHEMA_PATH, 'utf8'),
  ]);
  const report = JSON.parse(reportBytes);
  const schema = JSON.parse(schemaBytes);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  assert.equal(validate(report), true, ajv.errorsText(validate.errors));
  assert.equal(document, renderMarkdown(report));
  assert.equal(report.validation.command, 'npm run batch:issue-222:report:check');
  assert.equal(report.validation.local_corpus_evidence_command, 'npm run batch:issue-222:check');
  assert.equal(report.current.non_searchable_record_count, 0);
  assert.equal(report.current.directly_searchable_record_count, report.current.canonical_record_count);
  assert.equal(report.current.relation_empty_searchable_record_count <= report.current.directly_searchable_record_count, true);
  assert.equal(report.runtime_package_impact.baseline_dictionary_record_count, 5105);
  assert.equal(report.runtime_package_impact.current_dictionary_record_count, report.current.canonical_record_count);
  assert.equal(report.runtime_package_impact.dictionary_record_delta, report.current.canonical_record_count - 5105);
  assert.equal(report.runtime_package_impact.dictionary_package_bytes_measured, false);
  assert.equal(report.runtime_package_impact.runtime_contract_changed, false);
  assert.equal(report.remaining.records_to_target, 0);
  assert.match(report.remaining.next_step, /M9-E \(#223\)/u);
  assert.equal(report.production_audit.correction_rate_status, 'NOT_MEASURED_NO_HUMAN_REVIEW');
});
