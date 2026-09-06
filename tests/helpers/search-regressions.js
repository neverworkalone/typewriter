export function casesByEvaluation(corpus, evaluation) {
  return corpus.cases.filter((searchCase) => searchCase.evaluation === evaluation);
}

export function casesByInputClass(corpus, inputClass) {
  return corpus.cases.filter((searchCase) => searchCase.input_class === inputClass);
}

export function caseById(corpus, id) {
  const searchCase = corpus.cases.find((candidate) => candidate.id === id);
  if (!searchCase) {
    throw new Error(`Unknown search regression case: ${id}`);
  }
  return searchCase;
}

export function resultIds(rows) {
  return rows.map(({ id }) => id);
}

export function recordAssertions(searchCase) {
  return searchCase.assertions.filter(({ kind }) => kind === 'record');
}

export function relationAssertions(searchCase) {
  return searchCase.assertions.filter(({ kind }) => kind === 'relation');
}

export function relationSignature(relation) {
  return [
    relation.source_sense_id,
    relation.target_record_id,
    relation.target_sense_id,
    relation.type,
  ].join(':');
}

export function expectedBrowserQueries(corpus) {
  return casesByEvaluation(corpus, 'baseline')
    .filter(({ input_class }) => input_class === 'exact-lemma' || input_class === 'exact-search-form')
    .map(({ query, actual }) => ({
      query,
      result_ids: [...actual.result_ids],
    }));
}
