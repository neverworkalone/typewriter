import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const DEFAULT_BASELINE = 'a5d794a';

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

async function main() {
  const baseline = process.argv.find((argument) => argument.startsWith('--baseline='))?.slice('--baseline='.length)
    ?? DEFAULT_BASELINE;
  const files = await Promise.all(ARTIFACTS.map(readArtifact));
  const source = files.find(({ path: filePath }) => filePath.endsWith('m5-12a-semantic-decisions.json')).value;
  const canonicalAuthority = files.find(({ path: filePath }) => filePath.endsWith('canonical-semantic-decision-source.json')).value;
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
    payload_accounting: payloadAccounting(payloadUnits),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
