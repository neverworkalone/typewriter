import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const DEFAULT_BASELINE = 'a5d794a';
const CANONICAL_SOURCE_COMPACTION_BASELINE = 'ed276b0';

const ARTIFACTS = [
  'data/batches/m5-12a-semantic-decisions.json',
  'data/validation/canonical-semantic-decision-source.json',
  'data/inventory/m5-target-seed.json',
  'data/inventory/m5-target-promotions.jsonl',
  'data/batches/m5-12a-admission.json',
  'data/batches/m5-12a-promotion.json',
];

function lineCount(bytes) {
  return bytes.length === 0 ? 0 : bytes.toString('utf8').split('\n').length - 1;
}

function byteCount(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function pickFields(value, fields) {
  return Object.fromEntries(fields
    .filter((field) => Object.hasOwn(value ?? {}, field))
    .map((field) => [field, value[field]]));
}

function payloadDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function semanticPayloadUnits(source, canonicalAuthority, promotionLedger) {
  const units = [];
  const add = (category, values) => {
    for (const [index, value] of values.entries()) {
      units.push({
        category,
        index,
        bytes: byteCount(value),
        digest: payloadDigest(value),
      });
    }
  };

  add('candidate_records', source.candidate_records);
  add('decisions', source.decisions);
  add(
    'canonical_review',
    canonicalAuthority.authored_review.records.map(({ authored_batch_decision: ignored, ...record }) => record),
  );
  add(
    'canonical_bindings',
    canonicalAuthority.authored_review.records
      .map(({ authored_batch_decision: binding }) => binding)
      .filter(Boolean),
  );
  add('promotion_ledger', promotionLedger);
  return units;
}

function payloadAccounting(units) {
  const firstByDigest = new Map();
  let uniqueBytes = 0;
  let duplicatedBytes = 0;
  let duplicateUnitCount = 0;
  for (const unit of units) {
    if (!firstByDigest.has(unit.digest)) {
      firstByDigest.set(unit.digest, unit);
      uniqueBytes += unit.bytes;
    } else {
      duplicatedBytes += unit.bytes;
      duplicateUnitCount += 1;
    }
  }
  const categoryUnits = Object.fromEntries(
    [...new Set(units.map(({ category }) => category))].map((category) => [
      category,
      {
        count: units.filter((unit) => unit.category === category).length,
        bytes: units
          .filter((unit) => unit.category === category)
          .reduce((total, unit) => total + unit.bytes, 0),
      },
    ]),
  );
  const currentCorpusCategories = new Set(['canonical_review']);
  const batchSizeCategories = new Set([
    'candidate_records',
    'decisions',
    'canonical_bindings',
    'promotion_ledger',
  ]);
  return {
    methodology: 'UTF-8 bytes of canonical JSON semantic payload units; exact digest repeats count as duplicated bytes after the first occurrence.',
    unit_count: units.length,
    unique_unit_count: firstByDigest.size,
    duplicate_unit_count: duplicateUnitCount,
    unique_semantic_payload_bytes: uniqueBytes,
    duplicated_payload_bytes: duplicatedBytes,
    total_semantic_payload_bytes: uniqueBytes + duplicatedBytes,
    current_corpus_dependent_bytes: units
      .filter(({ category }) => currentCorpusCategories.has(category))
      .reduce((total, unit) => total + unit.bytes, 0),
    batch_size_dependent_bytes: units
      .filter(({ category }) => batchSizeCategories.has(category))
      .reduce((total, unit) => total + unit.bytes, 0),
    category_units: categoryUnits,
  };
}

const TRACKED_OWNERSHIP_BUCKETS = {
  current_corpus_authority: [
    'data/validation/canonical-semantic-decision-source.json',
  ],
  batch_size_authority: [
    'data/batches/m5-12a-semantic-decisions.json',
    'data/inventory/m5-target-promotions.jsonl',
    'data/batches/m5-12a-admission.json',
    'data/batches/m5-12a-promotion.json',
  ],
  active_inventory_state: [
    'data/inventory/m5-target-seed.json',
  ],
};

function trackedFootprintAccounting(files) {
  const bytesByPath = new Map(files.map(({ path: filePath, bytes }) => [filePath, bytes]));
  const ownershipBuckets = Object.fromEntries(
    Object.entries(TRACKED_OWNERSHIP_BUCKETS).map(([name, paths]) => [
      name,
      {
        paths,
        bytes: paths.reduce((total, filePath) => total + (bytesByPath.get(filePath) ?? 0), 0),
      },
    ]),
  );
  const trackedArtifactBytes = files.reduce((total, { bytes }) => total + bytes, 0);
  const ownershipBucketSumBytes = Object.values(ownershipBuckets)
    .reduce((total, { bytes }) => total + bytes, 0);
  const assignedPaths = Object.values(TRACKED_OWNERSHIP_BUCKETS).flat();
  const unassignedPaths = ARTIFACTS.filter((filePath) => !assignedPaths.includes(filePath));
  const duplicateAssignments = assignedPaths.filter((filePath, index) => assignedPaths.indexOf(filePath) !== index);
  return {
    methodology: 'Each tracked evidence artifact is assigned exactly once to a durable ownership bucket; full UTF-8 file bytes are summed without subtracting semantic overlap.',
    tracked_artifact_bytes: trackedArtifactBytes,
    ownership_buckets: ownershipBuckets,
    ownership_bucket_sum_bytes: ownershipBucketSumBytes,
    ownership_bucket_sum_matches_tracked: ownershipBucketSumBytes === trackedArtifactBytes
      && unassignedPaths.length === 0
      && duplicateAssignments.length === 0,
    unassigned_paths: unassignedPaths,
    duplicate_assignments: [...new Set(duplicateAssignments)],
    current_corpus_dependent_bytes: ownershipBuckets.current_corpus_authority.bytes,
    batch_size_dependent_bytes: ownershipBuckets.batch_size_authority.bytes,
    non_semantic_active_state_bytes: ownershipBuckets.active_inventory_state.bytes,
  };
}

function indexedBy(values, key) {
  return new Map(values.filter((value) => value?.[key] !== undefined).map((value) => [value[key], value]));
}

function semanticFieldOverlap(source, canonicalAuthority, promotionLedger) {
  const decisionsByCandidateId = indexedBy(source.decisions, 'candidate_record_id');
  const bindings = canonicalAuthority.authored_review.records
    .map(({ authored_batch_decision: binding }) => binding)
    .filter(Boolean);
  const bindingsByCandidateId = indexedBy(bindings, 'candidate_record_id');
  const ledgerByCanonicalId = indexedBy(promotionLedger, 'canonical_id');
  const relationships = [
    {
      name: 'semantic_decision_to_canonical_binding',
      primary_label: 'semantic decisions',
      secondary_label: 'canonical bindings',
      rows: bindings.map((binding) => ({
        primary: decisionsByCandidateId.get(binding.candidate_record_id),
        secondary: binding,
      })),
      fields: [
        ['candidate_record_id', 'candidate_record_id'],
        ['candidate_record_sha256', 'candidate_record_sha256'],
        ['decision', 'decision'],
        ['rank', 'selection_rank'],
        ['score', 'selection_score'],
      ],
    },
    {
      name: 'canonical_binding_to_promotion_ledger',
      primary_label: 'canonical bindings',
      secondary_label: 'promotion ledger',
      rows: bindings.map((binding) => ({
        primary: binding,
        secondary: ledgerByCanonicalId.get(binding.candidate_record_id),
      })),
      fields: [
        ['candidate_record_id', 'canonical_id'],
        ['decision', 'decision'],
        ['reviewed_record_sha256', 'record_sha256'],
        ['source_id', 'decision_source_id'],
        ['decision_row_sha256', 'decision_row_sha256'],
      ],
    },
  ];
  const groups = Object.fromEntries(relationships.map((relationship) => {
    const fieldResults = relationship.fields.map(([primaryField, secondaryField]) => {
      const comparedRows = relationship.rows.filter(({ primary, secondary }) => (
        primary?.[primaryField] !== undefined && secondary?.[secondaryField] !== undefined
      ));
      const matchedRows = comparedRows.filter(({ primary, secondary }) => (
        primary[primaryField] === secondary[secondaryField]
      ));
      return {
        primary_field: primaryField,
        secondary_field: secondaryField,
        compared_count: comparedRows.length,
        matched_count: matchedRows.length,
        mismatch_count: comparedRows.length - matchedRows.length,
        secondary_copy_bytes: matchedRows.reduce(
          (total, { secondary }) => total + byteCount({ [secondaryField]: secondary[secondaryField] }),
          0,
        ),
      };
    });
    return [relationship.name, {
      primary: relationship.primary_label,
      secondary: relationship.secondary_label,
      row_count: relationship.rows.length,
      fields: fieldResults,
      compared_field_count: fieldResults.reduce((total, field) => total + field.compared_count, 0),
      matched_field_count: fieldResults.reduce((total, field) => total + field.matched_count, 0),
      mismatch_field_count: fieldResults.reduce((total, field) => total + field.mismatch_count, 0),
      secondary_copy_bytes: fieldResults.reduce((total, field) => total + field.secondary_copy_bytes, 0),
    }];
  }));
  return {
    methodology: 'Known semantic facts are compared across distinct durable representations. Secondary JSON field/value bytes are reported as explanatory overlap; they are not subtracted from the mutually exclusive tracked ownership buckets.',
    exact_field_groups: groups,
    compared_field_count: Object.values(groups).reduce((total, group) => total + group.compared_field_count, 0),
    matched_field_count: Object.values(groups).reduce((total, group) => total + group.matched_field_count, 0),
    mismatch_field_count: Object.values(groups).reduce((total, group) => total + group.mismatch_field_count, 0),
    known_semantic_overlap_bytes: Object.values(groups)
      .reduce((total, group) => total + group.secondary_copy_bytes, 0),
  };
}

function narrativeOccurrences(source) {
  const occurrences = [];
  const add = (value, kind) => {
    if (typeof value === 'string' && value.length > 0) occurrences.push({ value, kind });
  };
  for (const record of source.authored_review?.records ?? []) {
    if (record.authored_batch_decision) continue;
    add(record.boundary_review?.rationale, 'boundary_rationale');
    for (const evidence of record.boundary_review?.evidence ?? []) {
      add(evidence.evidence_basis, 'boundary_evidence_basis');
      add(evidence.rationale, 'boundary_evidence_rationale');
    }
    for (const pair of record.boundary_review?.pairwise ?? []) {
      add(pair.evidence_basis, 'pairwise_evidence_basis');
      add(pair.distinguishing_feature, 'pairwise_distinguishing_feature');
      add(pair.rationale, 'pairwise_rationale');
    }
    for (const sense of record.sense_reviews ?? []) {
      add(sense.semantic_rationale, 'semantic_rationale');
      add(sense.boundary_rationale, 'sense_boundary_rationale');
      add(sense.relation_rationale, 'relation_rationale');
      add(sense.no_relation_rationale, 'no_relation_rationale');
    }
  }
  return occurrences;
}

function narrativeTemplateKey(value) {
  return value
    .replace(/\bw\d+-s\d+\b/gu, '{sense_id}')
    .replace(/\bw\d+\b/gu, '{record_id}')
    .replace(/\b[a-f0-9]{12,64}\b/gu, '{digest}');
}

function narrativeStorageAccounting(before, after) {
  const stats = (source) => {
    const values = narrativeOccurrences(source);
    const groups = new Map();
    for (const occurrence of values) {
      const key = narrativeTemplateKey(occurrence.value);
      const group = groups.get(key) ?? [];
      group.push(occurrence);
      groups.set(key, group);
    }
    const duplicateValueBytes = [...groups.values()]
      .flatMap((group) => group.slice(1))
      .reduce((total, occurrence) => total + Buffer.byteLength(occurrence.value, 'utf8'), 0);
    const inlineBytes = values.reduce((total, occurrence) => total + Buffer.byteLength(occurrence.value, 'utf8'), 0);
    const codeReferences = [];
    for (const record of source.authored_review?.records ?? []) {
      if (record.authored_batch_decision) continue;
      const collectCodes = (value) => {
        for (const [field, fieldValue] of Object.entries(value ?? {})) {
          if (field.endsWith('_code') && typeof fieldValue === 'string') codeReferences.push(fieldValue);
        }
      };
      collectCodes(record.boundary_review);
      for (const item of record.boundary_review?.evidence ?? []) collectCodes(item);
      for (const item of record.boundary_review?.pairwise ?? []) collectCodes(item);
      for (const item of record.sense_reviews ?? []) collectCodes(item);
    }
    const templateDefinitions = (source.authored_review?.rationale_templates ?? [])
      .filter((entry) => typeof entry?.template === 'string');
    return {
      narrative_occurrence_count: values.length,
      inline_string_value_bytes: inlineBytes,
      normalized_template_count: groups.size,
      normalized_duplicate_value_bytes: duplicateValueBytes,
      reason_code_reference_count: codeReferences.length,
      reason_code_reference_bytes: codeReferences
        .reduce((total, code) => total + Buffer.byteLength(code, 'utf8'), 0),
      template_definition_count: templateDefinitions.length,
      template_definition_bytes: templateDefinitions
        .reduce((total, entry) => total + Buffer.byteLength(entry.template, 'utf8'), 0),
      compact_value_bytes: values.reduce(
        (total, occurrence) => total + Buffer.byteLength(occurrence.value, 'utf8'),
        0,
      )
        + codeReferences.reduce((total, code) => total + Buffer.byteLength(code, 'utf8'), 0)
        + templateDefinitions.reduce((total, entry) => total + Buffer.byteLength(entry.template, 'utf8'), 0),
    };
  };
  const beforeStats = stats(before);
  const afterStats = stats(after);
  return {
    methodology: 'Narrative field values are normalized by replacing record/sense IDs and gloss digests with placeholders. Repeated templates are counted as duplicate value bytes before compaction; after compaction, one source-level template definition plus per-occurrence reason-code references are counted.',
    before: beforeStats,
    after: afterStats,
    transition: {
      removed_normalized_duplicate_value_bytes:
        beforeStats.normalized_duplicate_value_bytes - afterStats.normalized_duplicate_value_bytes,
      removed_inline_string_value_bytes:
        beforeStats.inline_string_value_bytes - afterStats.inline_string_value_bytes,
      retained_template_definition_bytes: afterStats.template_definition_bytes,
      retained_reason_code_reference_bytes: afterStats.reason_code_reference_bytes,
    },
  };
}

function canonicalBatchNarrativeOverlap(batchSource, canonicalBefore, canonicalAfter) {
  const beforeById = indexedBy(canonicalBefore.authored_review?.records ?? [], 'record_id');
  const afterById = indexedBy(canonicalAfter.authored_review?.records ?? [], 'record_id');
  const groups = [
    {
      name: 'semantic_rationale_to_boundary_evidence_basis',
      getBatch: (row, sense) => sense.semantic_rationale,
      getCanonical: (record, sense) => record.boundary_review?.evidence?.find((item) => item.sense_id === sense.sense_id)?.evidence_basis,
    },
    {
      name: 'boundary_rationale_to_boundary_evidence',
      getBatch: (row, sense) => sense.boundary_rationale,
      getCanonical: (record, sense) => record.boundary_review?.evidence?.find((item) => item.sense_id === sense.sense_id)?.rationale,
    },
    {
      name: 'boundary_rationale_to_record_boundary',
      getBatch: (row, sense) => sense.boundary_rationale,
      getCanonical: (record) => record.boundary_review?.rationale,
    },
    {
      name: 'no_relation_rationale_to_canonical_sense',
      getBatch: (row, sense) => sense.no_relation_rationale,
      getCanonical: (record, sense) => {
        const canonicalSense = record.sense_reviews?.find((item) => item.sense_id === sense.sense_id);
        return canonicalSense?.no_relation_rationale ?? canonicalSense?.relation?.no_relation_rationale;
      },
    },
  ];
  const results = groups.map((group) => {
    let compared = 0;
    let beforeMatches = 0;
    let afterMatches = 0;
    let beforeCopyBytes = 0;
    let afterCopyBytes = 0;
    for (const row of batchSource.decisions ?? []) {
      const beforeRecord = beforeById.get(row.candidate_record_id);
      const afterRecord = afterById.get(row.candidate_record_id);
      if (!beforeRecord || !afterRecord) continue;
      for (const sense of row.sense_reviews ?? []) {
        const batchValue = group.getBatch(row, sense);
        if (typeof batchValue !== 'string') continue;
        compared += 1;
        if (batchValue === group.getCanonical(beforeRecord, sense)) {
          beforeMatches += 1;
          beforeCopyBytes += Buffer.byteLength(batchValue, 'utf8');
        }
        if (batchValue === group.getCanonical(afterRecord, sense)) {
          afterMatches += 1;
          afterCopyBytes += Buffer.byteLength(batchValue, 'utf8');
        }
      }
    }
    return {
      group: group.name,
      compared_count: compared,
      before_exact_match_count: beforeMatches,
      after_exact_match_count: afterMatches,
      before_secondary_copy_bytes: beforeCopyBytes,
      after_secondary_copy_bytes: afterCopyBytes,
      removed_secondary_copy_bytes: beforeCopyBytes - afterCopyBytes,
    };
  });
  return {
    methodology: 'M5-12A authored narrative values are compared against the pre-compaction and current canonical authority by candidate/sense identity. A match is a copied narrative value, not merely a shared record ID or digest.',
    groups: results,
    before_exact_copy_count: results.reduce((total, group) => total + group.before_exact_match_count, 0),
    after_exact_copy_count: results.reduce((total, group) => total + group.after_exact_match_count, 0),
    before_secondary_copy_bytes: results.reduce((total, group) => total + group.before_secondary_copy_bytes, 0),
    after_secondary_copy_bytes: results.reduce((total, group) => total + group.after_secondary_copy_bytes, 0),
    removed_secondary_copy_bytes: results.reduce((total, group) => total + group.removed_secondary_copy_bytes, 0),
  };
}

function baselineDiff(baseline, files) {
  const output = execFileSync(
    'git',
    ['diff', '--numstat', `${baseline}^1`, baseline, '--', ...files],
    { cwd: REPOSITORY_DIRECTORY, encoding: 'utf8' },
  );
  return Object.fromEntries(output.trim().split('\n').filter(Boolean).map((line) => {
    const [additions, deletions, file] = line.split('\t');
    return [file, { additions: Number(additions), deletions: Number(deletions) }];
  }));
}

async function readArtifact(relativePath) {
  const bytes = await readFile(path.join(REPOSITORY_DIRECTORY, relativePath));
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    if (relativePath.endsWith('.jsonl')) {
      value = bytes.toString('utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
    }
  }
  return {
    path: relativePath,
    bytes: bytes.length,
    lines: lineCount(bytes),
    value,
  };
}

function sourceFieldBreakdown(source) {
  const candidateBytes = byteCount(source.candidate_records);
  const decisionBytes = byteCount(source.decisions);
  const envelope = { ...source };
  delete envelope.candidate_records;
  delete envelope.decisions;
  return {
    candidate_records: {
      count: source.candidate_records.length,
      bytes: candidateBytes,
      average_bytes: Math.round(candidateBytes / source.candidate_records.length),
    },
    decisions: {
      count: source.decisions.length,
      bytes: decisionBytes,
      average_bytes: Math.round(decisionBytes / source.decisions.length),
    },
    envelope_bytes: byteCount(envelope),
  };
}

function canonicalBindingBreakdown(source) {
  const bindings = source.authored_review.records
    .map(({ authored_batch_decision: binding }) => binding)
    .filter(Boolean);
  const bytes = byteCount(bindings);
  return {
    count: bindings.length,
    bytes,
    average_bytes: bindings.length === 0 ? 0 : Math.round(bytes / bindings.length),
  };
}

function reviewCounts(source, { batchSource } = {}) {
  const records = source.authored_review?.records ?? [];
  const batchDecisionsByCandidateId = new Map(
    (batchSource?.decisions ?? []).map((decision) => [decision.candidate_record_id, decision]),
  );
  const retainedSenseCount = records.reduce((sum, record) => sum + (record.sense_reviews?.length ?? 0), 0);
  const dereferencedBatchSenseCount = records.reduce((sum, record) => {
    if (!record.authored_batch_decision || (record.sense_reviews?.length ?? 0) > 0) return sum;
    return sum + (batchDecisionsByCandidateId.get(record.authored_batch_decision.candidate_record_id)?.sense_reviews?.length ?? 0);
  }, 0);
  return {
    record_count: records.length,
    sense_count: retainedSenseCount + dereferencedBatchSenseCount,
  };
}

function recordBindings(source) {
  return (source.authored_review?.records ?? []).map((record) => pickFields(record, [
    'record_id',
    'record_sha256',
  ]));
}

function authoredBatchBindings(source) {
  return (source.authored_review?.records ?? [])
    .map(({ authored_batch_decision: binding }) => binding)
    .filter(Boolean);
}

function boundaryJudgments(source) {
  return (source.authored_review?.records ?? []).map((record) => {
    const boundary = record.boundary_review ?? {};
    return {
      record_id: record.record_id,
      boundary_review: {
        ...pickFields(boundary, ['review_id', 'decision', 'classification', 'rationale']),
        evidence: (boundary.evidence ?? []).map((item) => pickFields(item, [
          'sense_id',
          'evidence_basis',
          'rationale',
        ])),
        pairwise: (boundary.pairwise ?? []).map((item) => pickFields(item, [
          'left_sense_id',
          'right_sense_id',
          'relationship',
          'decision',
          'evidence_basis',
          'distinguishing_feature',
          'rationale',
        ])),
      },
    };
  });
}

function senseJudgments(source) {
  return (source.authored_review?.records ?? []).map((record) => ({
    record_id: record.record_id,
    sense_reviews: (record.sense_reviews ?? []).map((senseReview) => pickFields(senseReview, [
      'sense_id',
      'semantic_rationale',
      'boundary_rationale',
      'no_relation_rationale',
      'review_basis',
    ])),
  }));
}

function reviewProvenance(source) {
  const review = source.authored_review ?? {};
  return {
    review: pickFields(review, [
      'schema_version',
      'contract_version',
      'artifact_id',
      'scope',
      'review_mode',
      'source',
      'decision_source',
      'changes',
    ]),
    review_pass: pickFields(review.review_pass, [
      'id',
      'status',
      'reviewer',
      'review_mode',
      'method',
      'ruleset_version',
      'boundary_ruleset_version',
      'boundary_decision_source_version',
      'correction_history',
      'boundary_decision_history',
      'correction_source',
    ]),
  };
}

function derivedBoundaryProjection(source) {
  const projections = [];
  for (const record of source.authored_review?.records ?? []) {
    const boundary = record.boundary_review ?? {};
    const envelope = pickFields(boundary, ['status', 'method', 'independence', 'reviewed_sense_ids']);
    if (Object.keys(envelope).length > 0) projections.push(envelope);
    for (const item of boundary.evidence ?? []) {
      const value = pickFields(item, ['gloss_sha256', 'decision_source_id']);
      if (Object.keys(value).length > 0) projections.push(value);
    }
    for (const item of boundary.pairwise ?? []) {
      const value = pickFields(item, ['left_gloss_sha256', 'right_gloss_sha256', 'decision_source_id']);
      if (Object.keys(value).length > 0) projections.push(value);
    }
  }
  return projections;
}

function derivedSenseProjection(source) {
  const retainedFields = new Set([
    'sense_id',
    'semantic_rationale',
    'boundary_rationale',
    'no_relation_rationale',
    'review_basis',
  ]);
  return (source.authored_review?.records ?? [])
    .flatMap((record) => (record.sense_reviews ?? []).map((senseReview) => Object.fromEntries(
      Object.entries(senseReview).filter(([field]) => !retainedFields.has(field)),
    )))
    .filter((value) => Object.keys(value).length > 0);
}

function derivedReviewEnvelope(source) {
  const review = source.authored_review ?? {};
  return [
    pickFields(review, ['record_count', 'sense_count']),
    pickFields(review.review_pass, [
      'record_count',
      'sense_count',
      'open_finding_count',
      'correction_count',
    ]),
  ].filter((value) => Object.keys(value).length > 0);
}

function repeatedDecisionSourceIds(source) {
  const ids = [];
  for (const record of source.authored_review?.records ?? []) {
    const boundary = record.boundary_review ?? {};
    ids.push(boundary.independence?.decision_source_id);
    for (const evidence of boundary.evidence ?? []) ids.push(evidence.decision_source_id);
    for (const pair of boundary.pairwise ?? []) ids.push(pair.decision_source_id);
    for (const senseReview of record.sense_reviews ?? []) {
      ids.push(senseReview.sense_boundary?.decision_source_id);
      ids.push(senseReview.pos?.decision_source_id);
      ids.push(senseReview.expression?.decision_source_id);
      ids.push(senseReview.relation?.decision_source_id);
      ids.push(senseReview.review_basis?.decision_source_id);
    }
  }
  return ids.filter((value) => value !== undefined).map((value) => ({ decision_source_id: value }));
}

function fieldGroupStats(beforeValue, afterValue, count) {
  const beforeBytes = byteCount(beforeValue);
  const afterBytes = byteCount(afterValue);
  return {
    before_bytes: beforeBytes,
    after_bytes: afterBytes,
    removed_bytes: beforeBytes - afterBytes,
    before_average_bytes: count === 0 ? 0 : Math.round(beforeBytes / count),
    after_average_bytes: count === 0 ? 0 : Math.round(afterBytes / count),
  };
}

function canonicalAuthorityFieldAccounting(before, after, beforeArtifact, afterArtifact, batchSource) {
  const beforeCounts = reviewCounts(before);
  const afterCounts = reviewCounts(after, { batchSource });
  const retainedDefinitions = [
    {
      name: 'record_binding',
      storage_paths: ['authored_review.records[].record_id', 'authored_review.records[].record_sha256'],
      authority: 'canonical semantic decision source',
      consumers: ['semantic-audit.mjs', 'generate-target-inventory.mjs'],
      necessity: 'joins authored review rows to immutable canonical record content',
      value: [recordBindings(before), recordBindings(after)],
      count: afterCounts.record_count,
    },
    {
      name: 'canonical_authored_batch_binding',
      storage_paths: ['authored_review.records[].authored_batch_decision'],
      authority: 'M5-12A authored batch decision source',
      consumers: ['M5-12A admission', 'target inventory and promotion-ledger validators'],
      necessity: 'binds each promoted canonical row to its source, decision row, and reviewed record digest',
      value: [authoredBatchBindings(before), authoredBatchBindings(after)],
      count: afterCounts.record_count,
    },
    {
      name: 'boundary_authored_judgment',
      storage_paths: ['authored_review.records[].boundary_review'],
      authority: 'separately authored semantic review',
      consumers: ['semantic-audit.mjs', 'apply-semantic-corrections.mjs'],
      necessity: 'preserves record-level classification, pairwise decisions, and writer-facing rationale that cannot be reconstructed',
      value: [boundaryJudgments(before), boundaryJudgments(after)],
      count: afterCounts.record_count,
    },
    {
      name: 'sense_authored_judgment',
      storage_paths: ['authored_review.records[].sense_reviews[]'],
      authority: 'separately authored semantic review',
      consumers: ['semantic-audit.mjs', 'apply-semantic-corrections.mjs'],
      necessity: 'preserves per-sense no-relation, boundary, semantic, and topic judgments that are not derivable from canonical content',
      value: [senseJudgments(before), senseJudgments(after)],
      count: afterCounts.sense_count,
    },
    {
      name: 'review_provenance_and_correction_history',
      storage_paths: ['authored_review.decision_source', 'authored_review.review_pass', 'authored_review.changes'],
      authority: 'separately authored review and correction history',
      consumers: ['semantic-audit.mjs', 'semantic-corrections replay'],
      necessity: 'binds the review contract and preserves historical correction decisions',
      value: [reviewProvenance(before), reviewProvenance(after)],
      count: 1,
    },
  ];
  const removedDefinitions = [
    {
      name: 'record_level_boundary_projection',
      storage_paths: ['boundary_review.status', 'method', 'independence', 'reviewed_sense_ids', 'evidence[].gloss_sha256', 'pairwise[].*_gloss_sha256', '*.decision_source_id'],
      producer: 'materializeSemanticReviewArtifact()',
      consumers: ['semantic-audit validation only'],
      necessity: 'fully recomputable from canonical glosses, sense IDs, and the retained authored boundary judgment',
      value: [derivedBoundaryProjection(before), derivedBoundaryProjection(after)],
      count: afterCounts.record_count,
    },
    {
      name: 'sense_content_and_relation_projection',
      storage_paths: ['sense_sha256', 'sense_boundary', 'pos', 'expression', 'relation', 'review_basis identity/gloss/domain/POS/type/count', 'coverage_gloss_sha256'],
      producer: 'materializeSemanticReviewArtifact()',
      consumers: ['semantic-audit validation only'],
      necessity: 'fully recomputable from the current canonical record and sense values',
      value: [derivedSenseProjection(before), derivedSenseProjection(after)],
      count: afterCounts.sense_count,
    },
    {
      name: 'repeated_review_counts_and_pass_envelope',
      storage_paths: ['authored_review.record_count', 'authored_review.sense_count', 'review_pass.record_count', 'review_pass.sense_count', 'review_pass.open_finding_count', 'review_pass.correction_count'],
      producer: 'materializeSemanticReviewArtifact()',
      consumers: ['semantic-audit validation only'],
      necessity: 'recomputed from canonical records and retained correction history',
      value: [derivedReviewEnvelope(before), derivedReviewEnvelope(after)],
      count: 1,
    },
    {
      name: 'repeated_decision_source_ids',
      storage_paths: ['boundary_review.*.decision_source_id', 'sense_reviews[].*.decision_source_id'],
      producer: 'materializeSemanticReviewArtifact()',
      consumers: ['semantic-audit validation only'],
      necessity: 'replaced by one source-level decision_source binding and in-memory materialization',
      value: [repeatedDecisionSourceIds(before), repeatedDecisionSourceIds(after)],
      count: Math.max(repeatedDecisionSourceIds(before).length, repeatedDecisionSourceIds(after).length),
    },
  ];
  const stats = (definition) => ({
    field_family: definition.name,
    storage_paths: definition.storage_paths,
    ...(definition.authority ? {
      authority: definition.authority,
      consumers: definition.consumers,
      necessity: definition.necessity,
    } : {
      producer: definition.producer,
      consumers: definition.consumers,
      necessity: definition.necessity,
    }),
    ...fieldGroupStats(definition.value[0], definition.value[1], definition.count),
  });
  const beforeBytes = beforeArtifact.bytes;
  const afterBytes = afterArtifact.bytes;
  const beforeLines = beforeArtifact.lines;
  const afterLines = afterArtifact.lines;
  return {
    methodology: 'Field-family values are measured as compact JSON projections for an exact pre-compaction source and the current compact source. Whole-file bytes and lines are measured from UTF-8 artifacts; per-record and per-sense costs use the complete authored review counts.',
    before_commit: CANONICAL_SOURCE_COMPACTION_BASELINE,
    before: {
      bytes: beforeBytes,
      lines: beforeLines,
      record_count: beforeCounts.record_count,
      sense_count: beforeCounts.sense_count,
      bytes_per_record: beforeCounts.record_count === 0 ? 0 : beforeBytes / beforeCounts.record_count,
      bytes_per_sense: beforeCounts.sense_count === 0 ? 0 : beforeBytes / beforeCounts.sense_count,
    },
    after: {
      bytes: afterBytes,
      lines: afterLines,
      record_count: afterCounts.record_count,
      sense_count: afterCounts.sense_count,
      bytes_per_record: afterCounts.record_count === 0 ? 0 : afterBytes / afterCounts.record_count,
      bytes_per_sense: afterCounts.sense_count === 0 ? 0 : afterBytes / afterCounts.sense_count,
    },
    reduction: {
      bytes: beforeBytes - afterBytes,
      lines: beforeLines - afterLines,
      byte_percent: beforeBytes === 0 ? 0 : Number((((beforeBytes - afterBytes) / beforeBytes) * 100).toFixed(2)),
      line_percent: beforeLines === 0 ? 0 : Number((((beforeLines - afterLines) / beforeLines) * 100).toFixed(2)),
    },
    retained_field_groups: retainedDefinitions.map(stats),
    recomputed_derived_field_groups: removedDefinitions.map(stats),
  };
}

function readGitArtifact(commit, relativePath) {
  const bytes = execFileSync('git', ['show', `${commit}:${relativePath}`], {
    cwd: REPOSITORY_DIRECTORY,
    maxBuffer: 40 * 1024 * 1024,
  });
  return {
    path: relativePath,
    bytes: bytes.length,
    lines: lineCount(bytes),
    value: JSON.parse(bytes.toString('utf8')),
  };
}

async function main() {
  const baseline = process.argv.find((argument) => argument.startsWith('--baseline='))?.slice('--baseline='.length)
    ?? DEFAULT_BASELINE;
  const files = await Promise.all(ARTIFACTS.map(readArtifact));
  const source = files.find(({ path: filePath }) => filePath.endsWith('m5-12a-semantic-decisions.json')).value;
  const canonicalAuthority = files.find(({ path: filePath }) => filePath.endsWith('canonical-semantic-decision-source.json')).value;
  const canonicalAuthorityArtifact = files.find(({ path: filePath }) => filePath.endsWith('canonical-semantic-decision-source.json'));
  const canonicalAuthorityBefore = readGitArtifact(
    CANONICAL_SOURCE_COMPACTION_BASELINE,
    'data/validation/canonical-semantic-decision-source.json',
  );
  const ledger = files.find(({ path: filePath }) => filePath.endsWith('m5-target-promotions.jsonl'));
  const promotionLedger = ledger.value ?? [];
  const ledgerCount = promotionLedger.length;
  const payloadUnits = semanticPayloadUnits(source, canonicalAuthority, promotionLedger);
  console.log(JSON.stringify({
    baseline_commit: baseline,
    baseline_diff: baselineDiff(baseline, ARTIFACTS),
    current: files.map(({ path: filePath, bytes, lines }) => ({ path: filePath, bytes, lines })),
    field_breakdown: {
      semantic_decision_source: sourceFieldBreakdown(source),
      canonical_authored_batch_binding: canonicalBindingBreakdown(canonicalAuthority),
      promotion_ledger: {
        count: ledgerCount,
        bytes: ledger.bytes,
        average_bytes: ledgerCount === 0 ? 0 : Math.round(ledger.bytes / ledgerCount),
      },
    },
    tracked_footprint_accounting: trackedFootprintAccounting(files),
    semantic_field_overlap: semanticFieldOverlap(source, canonicalAuthority, promotionLedger),
    canonical_authority_accounting: canonicalAuthorityFieldAccounting(
      canonicalAuthorityBefore.value,
      canonicalAuthority,
      canonicalAuthorityBefore,
      canonicalAuthorityArtifact,
      source,
    ),
    canonical_narrative_accounting: {
      batch_authority_overlap: canonicalBatchNarrativeOverlap(
        source,
        canonicalAuthorityBefore.value,
        canonicalAuthority,
      ),
      retained_template_storage: narrativeStorageAccounting(
        canonicalAuthorityBefore.value,
        canonicalAuthority,
      ),
    },
    payload_accounting: payloadAccounting(payloadUnits),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
