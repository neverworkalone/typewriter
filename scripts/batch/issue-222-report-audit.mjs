function sortedCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right, 'en')),
  );
}

function countBy(items, keyOf) {
  const counts = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return sortedCounts(counts);
}

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function summarizeCanonicalAudit(records, searchCoverage) {
  const canonicalRecords = records.map(({ record }) => record);
  const recordTypeCounts = countBy(canonicalRecords, ({ record_type: type }) => type);
  const roleCounts = countBy(canonicalRecords, ({ role }) => role);
  const sensePosCounts = {};
  const searchKeysByOwner = new Map();
  const distinctSearchForms = new Set();
  let canonicalSearchFormCount = 0;
  let senseCount = 0;
  let relationCount = 0;
  let relationEmptySearchableRecordCount = 0;

  const nonSearchableRecords = searchCoverage.current_non_searchable_lexical_records ?? [];
  const nonSearchableIds = new Set(nonSearchableRecords.map((record) => (
    record.record_id ?? record.canonical_id ?? record.id
  )).filter(Boolean));

  for (const { record } of records) {
    const recordSearchForms = record.search_forms ?? [];
    canonicalSearchFormCount += recordSearchForms.length;
    for (const form of recordSearchForms) {
      distinctSearchForms.add(form);
    }

    for (const key of new Set([record.lemma, ...recordSearchForms])) {
      const owners = searchKeysByOwner.get(key) ?? new Set();
      owners.add(record.id);
      searchKeysByOwner.set(key, owners);
    }

    for (const sense of record.senses ?? []) {
      senseCount += 1;
      increment(sensePosCounts, sense.pos);
      const count = (sense.relations ?? []).length;
      relationCount += count;
    }

    const searchable = !nonSearchableIds.has(record.id);
    if (searchable && (record.senses ?? []).every((sense) => (sense.relations ?? []).length === 0)) {
      relationEmptySearchableRecordCount += 1;
    }
  }

  const expectedLemmaCount = new Set(records.map(({ record }) => record.lemma)).size;
  const expectedFormOwnerKeys = searchKeysByOwner.size;
  const computedCrossRecordCollisions = [...searchKeysByOwner.values()]
    .filter((owners) => owners.size > 1).length;
  const missingOwners = searchCoverage.missing_expected_key_owners ?? [];
  const unexpectedOwners = searchCoverage.unexpected_key_owners ?? [];
  const directlySearchableRecordCount = searchCoverage.directly_searchable_record_count;

  return {
    record_type_counts: recordTypeCounts,
    role_counts: roleCounts,
    sense_pos_counts: sortedCounts(sensePosCounts),
    sense_count: senseCount,
    relation_count: relationCount,
    canonical_search_form_count: canonicalSearchFormCount,
    relation_empty_searchable_record_count: relationEmptySearchableRecordCount,
    exact_search_coverage: {
      expected_lemma_count: expectedLemmaCount,
      covered_lemma_count: directlySearchableRecordCount,
      non_searchable_record_count: searchCoverage.current_non_searchable_lexical_record_count,
      non_searchable_records: nonSearchableRecords,
      distinct_search_form_count: distinctSearchForms.size,
      expected_form_owner_key_count: expectedFormOwnerKeys,
      covered_form_owner_key_count: Math.max(0, expectedFormOwnerKeys - missingOwners.length),
      missing_form_owner_key_count: missingOwners.length,
      unexpected_form_owner_key_count: unexpectedOwners.length,
      cross_record_collision_key_count: Math.max(
        computedCrossRecordCollisions,
        searchCoverage.cross_record_key_collision_count ?? 0,
      ),
    },
  };
}

export function summarizeCandidateDecisions(decisions) {
  const dispositionCounts = {};
  const holdReasonCounts = {};
  const rejectReasonCounts = {};

  for (const row of decisions) {
    const judgment = row.editorial_judgment ?? {};
    const disposition = judgment.disposition ?? row.decision ?? 'unspecified';
    increment(dispositionCounts, disposition);
    if (disposition === 'hold') {
      increment(holdReasonCounts, judgment.disposition_basis ?? 'unspecified');
    } else if (disposition === 'reject') {
      increment(rejectReasonCounts, judgment.disposition_basis ?? 'unspecified');
    }
  }

  return {
    disposition_counts: sortedCounts(dispositionCounts),
    hold_reason_counts: sortedCounts(holdReasonCounts),
    reject_reason_counts: sortedCounts(rejectReasonCounts),
    pos_correction_count: decisions.filter(({ editorial_judgment: judgment }) => judgment?.pos_correction).length,
  };
}

export function buildIssue222NextStep({ state, targetRecordCount, currentRecordCount }) {
  if (state === 'complete' && currentRecordCount >= targetRecordCount) {
    return `Issue #222 has reached the ${targetRecordCount.toLocaleString('en-US')} directly searchable record checkpoint. Continue the next expansion stage under M9-E (#223) toward 10,000 reviewed canonical records, preserving source-bound admission and the shared search invariants.`;
  }
  if (state === 'blocked') {
    return 'Resolve the documented systemic, product-model, or licensing blocker before continuing Issue #222 production.';
  }
  return `Continue unseen source-bound historical or corpus review batches until the ${targetRecordCount.toLocaleString('en-US')} directly searchable record checkpoint or a documented source, product-model, or licensing blocker.`;
}
