const BOUNDARY_TOKEN_SUFFIX_PATTERN = /(?:으로|에서|에게|부터|까지|보다|처럼|만큼|은|는|이|가|을|를|의|에|로|와|과|도|만)$/u;

function boundaryTokens(gloss) {
  if (typeof gloss !== 'string') return [];
  return gloss
    .normalize('NFC')
    .replace(/[.,!?·:;()\[\]{}"“”‘’]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean)
    .map((token) => token.replace(BOUNDARY_TOKEN_SUFFIX_PATTERN, ''))
    .filter((token) => token.length > 0);
}

function compactGloss(gloss) {
  return typeof gloss === 'string'
    ? gloss.normalize('NFC').replace(/[\s.,!?·:;()\[\]{}"“”‘’]/gu, '')
    : '';
}

/**
 * Inspect sense pairs using the gloss content itself. This is deliberately
 * independent of the number of senses currently stored on a record: a
 * duplicate or nested pair remains a finding even when a review claims that
 * the existing sense set is already correct.
 */
export function inspectSenseBoundaryPairs(record) {
  const senses = Array.isArray(record?.senses) ? record.senses : [];
  const pairs = [];
  for (let leftIndex = 0; leftIndex < senses.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < senses.length; rightIndex += 1) {
      const left = senses[leftIndex];
      const right = senses[rightIndex];
      const leftTokens = boundaryTokens(left.gloss);
      const rightTokens = boundaryTokens(right.gloss);
      const leftSet = new Set(leftTokens);
      const rightSet = new Set(rightTokens);
      const sharedTokens = [...leftSet].filter((token) => rightSet.has(token)).sort();
      const leftDistinctiveTokens = [...leftSet].filter((token) => !rightSet.has(token)).sort();
      const rightDistinctiveTokens = [...rightSet].filter((token) => !leftSet.has(token)).sort();
      let relationship = 'distinct';
      if (compactGloss(left.gloss) === compactGloss(right.gloss)) {
        relationship = 'duplicate';
      } else {
        const smallerSize = Math.min(leftSet.size, rightSet.size);
        if (smallerSize >= 2 && sharedTokens.length === smallerSize) relationship = 'nested';
      }
      pairs.push({
        left_sense_id: left.id,
        right_sense_id: right.id,
        relationship,
        shared_tokens: sharedTokens,
        left_distinctive_tokens: leftDistinctiveTokens,
        right_distinctive_tokens: rightDistinctiveTokens,
      });
    }
  }
  return pairs;
}
