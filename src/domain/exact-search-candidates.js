export function expandExactSearchCandidates(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('Exact search records must be an array.');
  }

  return records.flatMap((record) => {
    if (!record || typeof record.id !== 'string') {
      throw new TypeError('Each exact search record must have an ID.');
    }
    const senses = Array.isArray(record.senses) ? record.senses : [];
    if (senses.length > 1) {
      const moreSenseIds = new Set(record.moreSenseIds ?? []);
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
      isMore: false,
    }];
  });
}
