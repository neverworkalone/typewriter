export function expandExactSearchCandidates(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('Exact search records must be an array.');
  }

  return records.flatMap((record) => {
    if (!record || typeof record.id !== 'string') {
      throw new TypeError('Each exact search record must have an ID.');
    }
    const senses = Array.isArray(record.senses) ? record.senses : [];
    // 더보기 is decided once for the whole search (see projection `moreSenseIds`), also for single-meaning records.
    const moreSenseIds = new Set(record.moreSenseIds ?? []);
    if (senses.length > 1) {
      return senses.map((sense, senseIndex) => ({
        isMore: moreSenseIds.has(sense.id),
        key: `${record.id}:${sense.id}`,
        recordId: record.id,
        senseId: sense.id,
        record,
        sense,
        senseIndex,
        isSenseChoice: true,
      }));
    }

    const sense = senses[0] ?? null;
    return [{
      key: `${record.id}:${sense?.id || 'record'}`,
      recordId: record.id,
      senseId: sense?.id ?? null,
      record,
      sense,
      senseIndex: 0,
      isSenseChoice: false,
      isMore: sense !== null && moreSenseIds.has(sense.id),
    }];
  });
}

/** The candidate selected first: the first default-view candidate, else the first candidate. */
export function defaultExactSearchCandidate(records) {
  const candidates = expandExactSearchCandidates(records);
  return candidates.find(({ isMore }) => !isMore) ?? candidates[0] ?? null;
}
