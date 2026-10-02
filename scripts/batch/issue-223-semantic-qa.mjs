import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { sha256Json } from '../validate/semantic-audit.mjs';

const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const batchNumberOf = (batchId) => batchId.match(/corpus-batch-(\d{2})-\d{8}$/u)?.[1] ?? null;
const recordKey = (batchId, canonicalId) => `${batchId}:${canonicalId}`;
const countRows = (rows, predicate) => rows.filter(predicate).length;

function assertDigest(value, label) {
  assert.ok(isDigest(value), `${label} must be a SHA-256 digest`);
}

function assertNoPrivatePaths(value, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivatePaths(item, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') {
      assert.equal(/(?:^|\s)(?:\/Users\/|\/private\/|\/tmp\/)/u.test(value), false,
        `${label} must not expose a local filesystem path`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert.equal(['paragraph_text', 'context_text', 'excerpt', 'raw_response', 'raw_output', 'local_path', 'account', 'auth', 'usage'].includes(key), false,
      `${label}.${key} is outside the tracked QA schema`);
    assertNoPrivatePaths(child, `${label}.${key}`);
  }
}

function assertCheckedContexts(indices, contextIds, storedContexts, label) {
  assert.ok(Array.isArray(indices) && indices.length > 0, `${label} must cite checked bounded contexts`);
  assert.ok(indices.every((index) => Number.isInteger(index) && index >= 0 && index < contextIds.length),
    `${label} cites a context outside its candidate's bounded evidence`);
  assert.equal(new Set(indices).size, indices.length, `${label} cites a bounded context more than once`);
  assert.deepEqual(storedContexts, indices.map((index) => ({ index, paragraph_id: contextIds[index] })),
    `${label} paragraph IDs must match the source-bound context indices`);
}

/**
 * Validate the preserved B01-B04 legacy outputs and the new AI self-checks
 * against the already validated tracked batch sources. The self-check lane is
 * retrospective QA only; it is not an admission or independent-review pass.
 */
export function validateIssue223SemanticQaArtifact(artifact, validatedBatches) {
  assert.equal(artifact.schema_version, '1', 'Issue #223 semantic QA schema version');
  assert.equal(artifact.contract_version, 'issue-223-b01-b04-semantic-qa-v1', 'Issue #223 semantic QA contract version');
  assert.equal(artifact.kind, 'issue-223-retrospective-semantic-qa', 'Issue #223 semantic QA artifact kind');
  assert.equal(artifact.issue, 223, 'Issue #223 semantic QA issue binding');
  assert.equal(artifact.parent_issue, 218, 'Issue #223 semantic QA parent issue binding');
  assert.match(artifact.policy, /AI self-check/u, 'Issue #223 semantic QA must identify the self-check policy');
  assert.match(artifact.policy, /preserve completed legacy review results/u, 'Issue #223 semantic QA must preserve completed legacy results');
  assert.deepEqual(Object.keys(artifact).sort(), [
    'ai_self_checks', 'contract_version', 'coverage', 'historical_overlap', 'issue', 'kind', 'legacy_review_results',
    'legacy_runs', 'parent_issue', 'policy', 'recorded_on', 'schema_version', 'source_batches',
  ].sort(), 'Issue #223 semantic QA top-level schema');
  assertNoPrivatePaths(artifact, 'Issue #223 semantic QA');

  const sourceBatches = validatedBatches
    .filter((batch) => Number(batchNumberOf(batch.batch_id)) <= 4)
    .sort((left, right) => batchNumberOf(left.batch_id).localeCompare(batchNumberOf(right.batch_id)));
  assert.equal(sourceBatches.length, 4, 'Issue #223 semantic QA binds exactly B01-B04');

  const canonicalByKey = new Map();
  const candidateByKey = new Map();
  const canonicalIdsByBatch = new Map();
  const expectedSourceRows = [];
  for (const batch of sourceBatches) {
    const batchNumber = batchNumberOf(batch.batch_id);
    assert.ok(batchNumber, `${batch.batch_id} must use the Issue #223 batch ID contract`);
    const candidateById = new Map(batch.candidateReview.decisions
      .filter((row) => row.editorial_judgment.candidate_record_id)
      .map((row) => [row.editorial_judgment.candidate_record_id, row]));
    assert.equal(candidateById.size, batch.importRecords.length, `${batch.batch_id} canonical imports bind to candidate decisions`);

    for (const record of batch.importRecords) {
      const key = recordKey(batch.batch_id, record.id);
      assert.equal(canonicalByKey.has(key), false, `${key} is unique across source imports`);
      const candidate = candidateById.get(record.id);
      assert.ok(candidate, `${key} has a tracked candidate-review row`);
      assert.equal(candidate.editorial_judgment.candidate_record_id, record.id, `${key} candidate ID binding`);
      assert.equal(candidate.morphology_proposal.lemma, record.lemma, `${key} lemma binding`);
      assert.equal(record.senses?.length, 1, `${key} preserves the existing single-sense canonical boundary`);
      assert.equal(candidate.morphology_proposal.pos, record.senses[0].pos, `${key} POS binding`);
      canonicalByKey.set(key, record);
      candidateByKey.set(key, candidate);
      if (!canonicalIdsByBatch.has(batch.batch_id)) canonicalIdsByBatch.set(batch.batch_id, []);
      canonicalIdsByBatch.get(batch.batch_id).push(record.id);
    }

    expectedSourceRows.push({
      batch_id: batch.batch_id,
      candidate_count: batch.candidateReview.decisions.length,
      canonical_record_count: batch.importRecords.length,
      candidate_review_sha256: sha256Bytes(batch.candidateReviewBytes),
      semantic_decisions_sha256: sha256Bytes(batch.semanticSourceBytes),
      canonical_import_sha256: sha256Bytes(batch.canonicalImportBytes),
      canonical_ids_sha256: sha256Json(batch.importRecords.map(({ id }) => id)),
    });
  }
  assert.deepEqual(artifact.source_batches, expectedSourceRows, 'Issue #223 semantic QA source digests and counts');

  assert.ok(Array.isArray(artifact.legacy_runs) && artifact.legacy_runs.length > 0, 'Issue #223 semantic QA preserves legacy run metadata');
  assert.ok(Array.isArray(artifact.legacy_review_results) && artifact.legacy_review_results.length > 0,
    'Issue #223 semantic QA preserves completed legacy result events');
  assert.ok(Array.isArray(artifact.ai_self_checks), 'Issue #223 semantic QA needs an AI self-check array');

  const runById = new Map();
  const allowedRunsets = new Set([artifact.historical_overlap.earlier_runset_id, artifact.historical_overlap.later_runset_id]);
  assert.equal(allowedRunsets.size, 2, 'historical legacy runsets are distinct');
  for (const run of artifact.legacy_runs) {
    const expectedRunKeys = [
      'run_id', 'runset_id', 'source_artifact_id', 'batch_id', 'reviewer_label_as_recorded', 'model_label_as_recorded',
      'identity_provenance', 'reviewer_identity_authenticated', 'human_reviewed', 'run_number', 'target_count', 'result_count',
      'pass_count', 'hold_count', 'packet_sha256', 'response_sha256', 'supplemental_note_revision_digests',
      ...(run.raw_response_sha256 === undefined ? [] : ['raw_response_sha256']),
    ];
    assert.deepEqual(Object.keys(run).sort(), expectedRunKeys.sort(), 'legacy run metadata schema');
    assert.ok(typeof run.run_id === 'string' && run.run_id.length > 0, 'legacy run needs a stable ID');
    assert.equal(runById.has(run.run_id), false, `${run.run_id} is unique`);
    assert.ok(allowedRunsets.has(run.runset_id), `${run.run_id} belongs to a declared historical runset`);
    assert.equal(run.identity_provenance, 'self-reported-legacy-metadata', `${run.run_id} identity provenance is explicit`);
    assert.equal(run.reviewer_identity_authenticated, false, `${run.run_id} must not claim authenticated reviewer identity`);
    assert.equal(run.human_reviewed, false, `${run.run_id} must not claim human review`);
    assert.ok(typeof run.reviewer_label_as_recorded === 'string' && run.reviewer_label_as_recorded.length > 0,
      `${run.run_id} preserves its recorded reviewer label`);
    assert.ok(typeof run.model_label_as_recorded === 'string' && run.model_label_as_recorded.length > 0,
      `${run.run_id} preserves its recorded model label`);
    assert.equal(run.source_artifact_id, `${run.runset_id}/${run.run_id.slice(run.runset_id.length + 1)}`,
      `${run.run_id} has a stable source artifact ID`);
    assert.ok(Number.isInteger(run.target_count) && run.target_count > 0, `${run.run_id} target count`);
    assert.ok(Number.isInteger(run.result_count) && run.result_count > 0, `${run.run_id} result count`);
    assert.equal(run.target_count, run.result_count, `${run.run_id} retains a complete structured result set`);
    assert.ok(Number.isInteger(run.run_number) && run.run_number > 0, `${run.run_id} run number`);
    assertDigest(run.packet_sha256, `${run.run_id} packet`);
    assertDigest(run.response_sha256, `${run.run_id} response`);
    if (run.raw_response_sha256 !== undefined) assertDigest(run.raw_response_sha256, `${run.run_id} raw response`);
    assert.ok(Array.isArray(run.supplemental_note_revision_digests), `${run.run_id} supplemental note revisions`);
    for (const noteRevision of run.supplemental_note_revision_digests) {
      assert.ok(typeof noteRevision.artifact_id === 'string' && noteRevision.artifact_id.length > 0,
        `${run.run_id} supplemental note revision has a stable artifact ID`);
      assertDigest(noteRevision.sha256, `${run.run_id} supplemental note revision`);
    }
    runById.set(run.run_id, run);
  }

  const legacyByRun = new Map();
  const legacyByRunsetAndRecord = new Map();
  const legacyEventIds = new Set();
  for (const row of artifact.legacy_review_results) {
    assert.deepEqual(Object.keys(row).sort(), [
      'source_event_id', 'runset_id', 'run_id', 'batch_id', 'candidate_review_ordinal', 'canonical_id', 'lemma', 'verdict',
      'identity', 'pos', 'gloss', 'sense_boundary', 'hold_basis', 'checked_context_indices', 'checked_source_contexts',
      'structured_result_sha256',
    ].sort(), 'legacy review result schema');
    const run = runById.get(row.run_id);
    assert.ok(run, `${row.source_event_id} is bound to a preserved run`);
    assert.equal(row.runset_id, run.runset_id, `${row.source_event_id} runset binding`);
    assert.equal(row.batch_id, run.batch_id, `${row.source_event_id} batch binding`);
    assert.equal(Number(batchNumberOf(row.batch_id)) <= 3, true, `${row.source_event_id} belongs to a batch with preserved legacy outputs`);
    const eventPrefix = `${row.run_id}:result-`;
    assert.ok(row.source_event_id.startsWith(eventPrefix), `${row.source_event_id} has a stable sequential event ID`);
    const eventOrdinal = row.source_event_id.slice(eventPrefix.length);
    assert.match(eventOrdinal, /^\d{3,}$/u, `${row.source_event_id} event ordinal`);
    assert.equal(legacyEventIds.has(row.source_event_id), false, `${row.source_event_id} is unique`);
    legacyEventIds.add(row.source_event_id);

    const key = recordKey(row.batch_id, row.canonical_id);
    const record = canonicalByKey.get(key);
    const candidate = candidateByKey.get(key);
    assert.ok(record && candidate, `${row.source_event_id} binds to a B01-B03 canonical record`);
    assert.equal(row.lemma, record.lemma, `${row.source_event_id} lemma binding`);
    assert.equal(row.candidate_review_ordinal, candidate.candidate_ordinal, `${row.source_event_id} candidate review ordinal binding`);
    const hits = candidate.bounded_provenance.representative_hits;
    assertCheckedContexts(row.checked_context_indices, hits.map(({ paragraph_id }) => paragraph_id), row.checked_source_contexts,
      row.source_event_id);
    assert.ok(['pass', 'hold'].includes(row.verdict), `${row.source_event_id} legacy verdict`);
    assert.ok(['ok', 'unresolved'].includes(row.identity), `${row.source_event_id} identity axis`);
    assert.ok(['ok', 'mismatch'].includes(row.pos), `${row.source_event_id} POS axis`);
    assert.ok(['fit', 'misfit', 'n/a'].includes(row.gloss), `${row.source_event_id} gloss axis`);
    assert.ok(['single', 'multiple'].includes(row.sense_boundary), `${row.source_event_id} sense-boundary axis`);
    assert.ok(['none', 'unresolved-sense', 'unresolved-identity'].includes(row.hold_basis), `${row.source_event_id} hold basis`);
    if (row.verdict === 'pass') {
      assert.deepEqual([row.identity, row.pos, row.gloss, row.sense_boundary, row.hold_basis],
        ['ok', 'ok', 'fit', 'single', 'none'], `${row.source_event_id} pass-axis consistency`);
    } else {
      assert.notDeepEqual([row.identity, row.pos, row.gloss, row.sense_boundary], ['ok', 'ok', 'fit', 'single'],
        `${row.source_event_id} hold has a recorded blocker`);
      assert.notEqual(row.hold_basis, 'none', `${row.source_event_id} hold has a basis`);
    }
    assertDigest(row.structured_result_sha256, `${row.source_event_id} structured result`);

    if (!legacyByRun.has(row.run_id)) legacyByRun.set(row.run_id, []);
    legacyByRun.get(row.run_id).push(row);
    const runsetKey = `${row.runset_id}:${key}`;
    assert.equal(legacyByRunsetAndRecord.has(runsetKey), false, `${runsetKey} occurs once in its runset`);
    legacyByRunsetAndRecord.set(runsetKey, row);
  }

  for (const run of artifact.legacy_runs) {
    const rows = legacyByRun.get(run.run_id) ?? [];
    assert.equal(rows.length, run.result_count, `${run.run_id} result count matches preserved events`);
    const sequence = rows.map((row) => Number(row.source_event_id.slice(`${run.run_id}:result-`.length))).sort((a, b) => a - b);
    assert.deepEqual(sequence, Array.from({ length: run.result_count }, (_, index) => index + 1),
      `${run.run_id} preserves every sequential result event`);
    assert.equal(run.pass_count, countRows(rows, ({ verdict }) => verdict === 'pass'), `${run.run_id} pass count`);
    assert.equal(run.hold_count, countRows(rows, ({ verdict }) => verdict === 'hold'), `${run.run_id} hold count`);
  }

  const earlierRunsetId = artifact.historical_overlap.earlier_runset_id;
  const laterRunsetId = artifact.historical_overlap.later_runset_id;
  const earlierRows = artifact.legacy_review_results.filter((row) => row.runset_id === earlierRunsetId);
  const laterRows = artifact.legacy_review_results.filter((row) => row.runset_id === laterRunsetId);
  const earlierByRecord = new Map(earlierRows.map((row) => [recordKey(row.batch_id, row.canonical_id), row]));
  const laterByRecord = new Map(laterRows.map((row) => [recordKey(row.batch_id, row.canonical_id), row]));
  assert.equal(earlierByRecord.size, earlierRows.length, 'earlier legacy runset has one preserved outcome per record');
  assert.equal(laterByRecord.size, laterRows.length, 'later legacy runset has one preserved outcome per record');
  const overlap = [...earlierByRecord.entries()].filter(([key]) => laterByRecord.has(key));
  assert.equal(overlap.length, earlierByRecord.size, 'all completed earlier outcomes remain present in the later runset');
  const verdictConflicts = countRows(overlap, ([key, earlier]) => earlier.verdict !== laterByRecord.get(key).verdict);
  const axisConflicts = countRows(overlap, ([key, earlier]) => ['identity', 'pos', 'gloss', 'sense_boundary']
    .some((axis) => earlier[axis] !== laterByRecord.get(key)[axis]));
  assert.deepEqual(artifact.historical_overlap, {
    policy: 'preserve both complete legacy outputs and their conflicting outcomes; do not rewrite or reconcile the historical results in this audit',
    earlier_runset_id: earlierRunsetId,
    later_runset_id: laterRunsetId,
    legacy_overlap_record_count: overlap.length,
    legacy_overlap_verdict_conflict_count: verdictConflicts,
    legacy_overlap_axis_conflict_count: axisConflicts,
  }, 'historical legacy results and disagreements remain visible');

  const expectedSelfCheckKeys = new Set([...canonicalByKey.keys()].filter((key) => !laterByRecord.has(key)));
  const selfCheckByKey = new Map();
  const selfCheckRationales = new Set();
  for (const row of artifact.ai_self_checks) {
    assert.deepEqual(Object.keys(row).sort(), [
      'batch_id', 'canonical_import_ordinal', 'candidate_review_ordinal', 'canonical_id', 'lemma', 'pos',
      'reviewed_gloss_sha256', 'reviewed_canonical_record_sha256', 'review_mode', 'reviewer', 'verdict', 'identity',
      'pos_check', 'gloss_check', 'sense_boundary', 'checked_context_indices', 'checked_source_contexts', 'rationale',
    ].sort(), 'AI self-check result schema');
    const key = recordKey(row.batch_id, row.canonical_id);
    assert.equal(selfCheckByKey.has(key), false, `${key} has one AI self-check`);
    assert.ok(expectedSelfCheckKeys.has(key), `${key} was not already completed in the preserved legacy runset`);
    const record = canonicalByKey.get(key);
    const candidate = candidateByKey.get(key);
    const batch = sourceBatches.find(({ batch_id }) => batch_id === row.batch_id);
    assert.ok(record && candidate && batch, `${key} binds to a source batch`);
    assert.ok(['03', '04'].includes(batchNumberOf(row.batch_id)), `${key} is in the previously uncovered B03/B04 scope`);
    const importOrdinal = batch.importRecords.findIndex(({ id }) => id === row.canonical_id) + 1;
    assert.equal(row.canonical_import_ordinal, importOrdinal, `${key} canonical import ordinal`);
    assert.equal(row.candidate_review_ordinal, candidate.candidate_ordinal, `${key} candidate-review ordinal`);
    assert.equal(row.lemma, record.lemma, `${key} lemma binding`);
    assert.equal(row.pos, record.senses[0].pos, `${key} POS binding`);
    assert.equal(row.reviewed_gloss_sha256, sha256Json(record.senses[0].gloss), `${key} reviewed gloss digest`);
    assert.equal(row.reviewed_canonical_record_sha256, sha256Json(record), `${key} reviewed canonical record digest`);
    assert.equal(row.review_mode, 'ai-self-check', `${key} review mode`);
    assert.equal(row.reviewer, 'codex-agent', `${key} self-check attribution`);
    assert.ok(['pass', 'hold'].includes(row.verdict), `${key} AI self-check verdict`);
    assert.ok(['ok', 'unresolved'].includes(row.identity), `${key} AI self-check identity axis`);
    assert.ok(['ok', 'unresolved'].includes(row.pos_check), `${key} AI self-check POS axis`);
    assert.ok(['fit', 'misfit', 'unresolved'].includes(row.gloss_check), `${key} AI self-check gloss axis`);
    assert.ok(['single', 'multiple', 'unresolved'].includes(row.sense_boundary), `${key} AI self-check sense boundary`);
    if (row.verdict === 'pass') {
      assert.deepEqual([row.identity, row.pos_check, row.gloss_check, row.sense_boundary], ['ok', 'ok', 'fit', 'single'],
        `${key} AI self-check pass-axis consistency`);
    } else {
      assert.notDeepEqual([row.identity, row.pos_check, row.gloss_check, row.sense_boundary], ['ok', 'ok', 'fit', 'single'],
        `${key} AI self-check hold has a recorded blocker`);
    }
    assertCheckedContexts(row.checked_context_indices,
      candidate.bounded_provenance.representative_hits.map(({ paragraph_id }) => paragraph_id),
      row.checked_source_contexts, `${key} AI self-check`);
    assert.ok(typeof row.rationale === 'string' && row.rationale.trim().length >= 20,
      `${key} AI self-check requires a candidate-specific rationale`);
    assert.equal(selfCheckRationales.has(row.rationale.trim()), false, `${key} AI self-check rationale is not a repeated template`);
    selfCheckRationales.add(row.rationale.trim());
    selfCheckByKey.set(key, row);
  }
  assert.deepEqual(new Set(selfCheckByKey.keys()), expectedSelfCheckKeys,
    'AI self-checks cover exactly the previously uncovered canonical records');

  const latestKeys = new Set(laterRows.map((row) => recordKey(row.batch_id, row.canonical_id)));
  const allOutcomeKeys = new Set([...latestKeys, ...selfCheckByKey.keys()]);
  assert.equal(allOutcomeKeys.size, latestKeys.size + selfCheckByKey.size, 'legacy results and AI self-checks do not overlap');
  assert.deepEqual(allOutcomeKeys, new Set(canonicalByKey.keys()), 'every B01-B04 canonical ID has one current QA outcome');

  const expectedBatchCoverage = {};
  for (const batch of sourceBatches) {
    const batchNumber = batchNumberOf(batch.batch_id);
    const latest = laterRows.filter((row) => row.batch_id === batch.batch_id);
    const selfChecks = [...selfCheckByKey.values()].filter((row) => row.batch_id === batch.batch_id);
    expectedBatchCoverage[`B${batchNumber}`] = {
      canonical_records: batch.importRecords.length,
      legacy_result_records: latest.length,
      legacy_pass: countRows(latest, ({ verdict }) => verdict === 'pass'),
      legacy_hold: countRows(latest, ({ verdict }) => verdict === 'hold'),
      ai_self_check_records: selfChecks.length,
      ai_self_check_pass: countRows(selfChecks, ({ verdict }) => verdict === 'pass'),
      ai_self_check_hold: countRows(selfChecks, ({ verdict }) => verdict === 'hold'),
    };
  }
  const expectedCoverage = {
    canonical_record_count: canonicalByKey.size,
    latest_legacy_unique_record_count: laterByRecord.size,
    latest_legacy_result_event_count: laterRows.length,
    latest_legacy_pass_count: countRows(laterRows, ({ verdict }) => verdict === 'pass'),
    latest_legacy_hold_count: countRows(laterRows, ({ verdict }) => verdict === 'hold'),
    earlier_legacy_unique_record_count: earlierByRecord.size,
    earlier_legacy_result_event_count: earlierRows.length,
    earlier_legacy_pass_count: countRows(earlierRows, ({ verdict }) => verdict === 'pass'),
    earlier_legacy_hold_count: countRows(earlierRows, ({ verdict }) => verdict === 'hold'),
    preserved_legacy_review_event_count: artifact.legacy_review_results.length,
    preserved_legacy_unique_record_count: laterByRecord.size,
    legacy_overlap_record_count: overlap.length,
    legacy_overlap_verdict_conflict_count: verdictConflicts,
    legacy_overlap_axis_conflict_count: axisConflicts,
    ai_self_check_record_count: selfCheckByKey.size,
    ai_self_check_pass_count: countRows([...selfCheckByKey.values()], ({ verdict }) => verdict === 'pass'),
    ai_self_check_hold_count: countRows([...selfCheckByKey.values()], ({ verdict }) => verdict === 'hold'),
    records_with_an_outcome_count: allOutcomeKeys.size,
    records_with_pass_outcome_count: countRows(laterRows, ({ verdict }) => verdict === 'pass')
      + countRows([...selfCheckByKey.values()], ({ verdict }) => verdict === 'pass'),
    records_with_hold_outcome_count: countRows(laterRows, ({ verdict }) => verdict === 'hold')
      + countRows([...selfCheckByKey.values()], ({ verdict }) => verdict === 'hold'),
    canonical_records_changed: 0,
    batches: expectedBatchCoverage,
  };
  assert.deepEqual(artifact.coverage, expectedCoverage, 'Issue #223 semantic QA coverage is derived from bound results');
  return expectedCoverage;
}
