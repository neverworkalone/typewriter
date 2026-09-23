// Batch-neutral selection after semantic review.
//
// Semantic review decides whether a candidate is eligible for admission.  This
// module owns the separate capacity decision.  It must never infer semantic
// quality from a preassigned rank or make a rank boundary an admission rule.

const IMPORTABLE_DECISIONS = new Set(['included', 'corrected']);
const DECISIONS = new Set(['included', 'corrected', 'held', 'rejected', 'deferred']);

export class LexicalSelectionError extends Error {
  constructor(message, code = 'LEXICAL_SELECTION_ERROR') {
    super(message);
    this.name = 'LexicalSelectionError';
    this.code = code;
  }
}

function fail(message, code = 'LEXICAL_SELECTION_ERROR') {
  throw new LexicalSelectionError(message, code);
}

function requireInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`, 'LEXICAL_SELECTION_VALUE');
  return value;
}

/**
 * Select reviewed candidates by semantic eligibility and score.
 *
 * `rows` contain semantic outcomes only.  `rank` is retained as evidence from
 * the verification pass and is used only as a deterministic tie-breaker; it
 * cannot make an ineligible row eligible or disqualify an eligible row.  A
 * qualified reserve row may therefore replace a rejected top-ranked row.
 */
export function selectReviewedCandidates(
  rows,
  {
    capacity,
    idField = 'candidate_record_id',
    decisionField = 'decision',
    scoreField = 'score',
    rankField = 'rank',
    coverageField,
    eligibilityField,
    eligibilityValue,
  } = {},
) {
  if (!Array.isArray(rows)) fail('selection rows must be an array', 'LEXICAL_SELECTION_SHAPE');
  requireInteger(capacity, 'selection capacity');
  if (eligibilityField !== undefined
    && (typeof eligibilityField !== 'string' || eligibilityField.trim().length === 0
      || typeof eligibilityValue !== 'string' || eligibilityValue.trim().length === 0)) {
    fail('selection eligibility field and value must be non-empty strings', 'LEXICAL_SELECTION_VALUE');
  }
  const isEligible = (row) => eligibilityField === undefined
    ? IMPORTABLE_DECISIONS.has(row?.[decisionField])
    : row?.[eligibilityField] === eligibilityValue;
  if (capacity > rows.length) {
    return {
      status: 'hold',
      reason: 'insufficient-qualified-candidates',
      required_count: capacity,
      qualified_count: rows.filter(isEligible).length,
      selected: [],
      reserve: [],
      excluded: rows.map((row) => row?.[idField]),
    };
  }

  const seenIds = new Set();
  const qualified = [];
  const excluded = [];
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      fail(`selection row ${index} must be an object`, 'LEXICAL_SELECTION_SHAPE');
    }
    const id = row[idField];
    if (typeof id !== 'string' || id.length === 0) fail(`selection row ${index} has no identity`, 'LEXICAL_SELECTION_BINDING');
    if (seenIds.has(id)) fail(`selection contains duplicate identity ${id}`, 'LEXICAL_SELECTION_BINDING');
    seenIds.add(id);
    if (!DECISIONS.has(row[decisionField])) fail(`selection row ${id} has an unsupported semantic decision`, 'LEXICAL_SELECTION_VALUE');
    if (coverageField !== undefined
      && (typeof row[coverageField] !== 'string' || row[coverageField].trim().length === 0)) {
      fail(`selection row ${id} has no source-bound coverage value`, 'LEXICAL_SELECTION_VALUE');
    }
    if (isEligible(row)) {
      if (coverageField === undefined && !Number.isFinite(row[scoreField])) {
        fail(`selection row ${id} has no finite semantic score`, 'LEXICAL_SELECTION_VALUE');
      }
      qualified.push({ row, index });
    } else {
      excluded.push(id);
    }
  }

  if (qualified.length < capacity) {
    return {
      status: 'hold',
      reason: 'insufficient-qualified-candidates',
      required_count: capacity,
      qualified_count: qualified.length,
      selected: [],
      reserve: qualified.map(({ row }) => row[idField]),
      excluded,
    };
  }

  if (coverageField !== undefined) {
    const groups = new Map();
    for (const entry of qualified) {
      const key = entry.row[coverageField];
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    const allocations = [...groups.entries()].map(([key, entries]) => {
      const exact = (capacity * entries.length) / qualified.length;
      return {
        key,
        entries,
        selectedCount: Math.floor(exact),
        remainder: exact - Math.floor(exact),
      };
    });
    let remaining = capacity - allocations.reduce((sum, item) => sum + item.selectedCount, 0);
    for (const allocation of [...allocations].sort((left, right) => (
      right.remainder - left.remainder || left.key.localeCompare(right.key)
    ))) {
      if (remaining === 0) break;
      if (allocation.selectedCount < allocation.entries.length) {
        allocation.selectedCount += 1;
        remaining -= 1;
      }
    }
    if (remaining !== 0) fail('coverage allocation could not fill the requested capacity', 'LEXICAL_SELECTION_VALUE');

    const byRank = (left, right) => (
      (Number.isFinite(left.row[rankField]) ? left.row[rankField] : Number.MAX_SAFE_INTEGER)
        - (Number.isFinite(right.row[rankField]) ? right.row[rankField] : Number.MAX_SAFE_INTEGER)
      || left.row[idField].localeCompare(right.row[idField])
    );
    const selectedEntries = [];
    const selectedIds = new Set();
    for (const allocation of allocations) {
      allocation.entries.sort(byRank);
      for (const entry of allocation.entries.slice(0, allocation.selectedCount)) {
        selectedEntries.push(entry);
        selectedIds.add(entry.row[idField]);
      }
    }
    selectedEntries.sort(byRank);
    const reserveEntries = qualified.filter(({ row }) => !selectedIds.has(row[idField])).sort(byRank);
    return {
      status: 'pass',
      reason: 'capacity-filled-from-qualified-axis-coverage',
      required_count: capacity,
      qualified_count: qualified.length,
      selected: selectedEntries.map(({ row }) => row),
      reserve: reserveEntries.map(({ row }) => row),
      excluded,
      coverage_allocation: allocations
        .sort((left, right) => left.key.localeCompare(right.key))
        .map(({ key, entries, selectedCount }) => ({
          value: key,
          qualified_count: entries.length,
          selected_count: selectedCount,
          reserve_count: entries.length - selectedCount,
        })),
    };
  }

  qualified.sort((left, right) => (
    right.row[scoreField] - left.row[scoreField]
    || (Number.isFinite(left.row[rankField]) ? left.row[rankField] : Number.MAX_SAFE_INTEGER)
      - (Number.isFinite(right.row[rankField]) ? right.row[rankField] : Number.MAX_SAFE_INTEGER)
    || left.row[idField].localeCompare(right.row[idField])
  ));
  const selected = qualified.slice(0, capacity).map(({ row }) => row);
  const reserve = qualified.slice(capacity).map(({ row }) => row);
  return {
    status: 'pass',
    reason: 'capacity-filled-from-qualified-review-results',
    required_count: capacity,
    qualified_count: qualified.length,
    selected,
    reserve,
    excluded,
  };
}

export function selectionOutcomeById(selection, idField = 'candidate_record_id') {
  if (!selection || selection.status !== 'pass') return new Map();
  return new Map([
    ...selection.selected.map((row) => [row[idField], 'selected']),
    ...selection.reserve.map((row) => [row[idField], 'reserve']),
    ...selection.excluded.map((id) => [id, 'excluded']),
  ]);
}
