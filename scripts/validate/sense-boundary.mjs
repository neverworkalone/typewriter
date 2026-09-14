const BOUNDARY_TOKEN_SUFFIX_PATTERN = /(?:으로|에서|에게|부터|까지|보다|처럼|만큼|은|는|이|가|을|를|의|에|로|와|과|도|만)$/u;
const FRAME_PARTICLE_PATTERN = /(?:을|를|에서)$/u;
const TOOL_HEAD_PATTERN = /(?:도구|농기구|쇠붙이|그릇)$/u;
const WRITING_CONTEXT_PATTERN = /^(?:글|말|대화|문장|이야기|발화)$/u;
const PARAPHRASE_TAIL_PATTERN = /(?:함께|같이|서로)?\s*(?:느끼는|이해하는)\s+일$/u;

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

function glossWords(gloss) {
  if (typeof gloss !== 'string') return [];
  return gloss
    .normalize('NFC')
    .replace(/[.,!?·:;()\[\]{}"“”‘’]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);
}

function frameForGloss(gloss) {
  const words = glossWords(gloss);
  const boundaryIndex = words.findIndex((word) => FRAME_PARTICLE_PATTERN.test(word));
  if (boundaryIndex < 0) return undefined;
  const boundaryWord = words[boundaryIndex];
  const marker = boundaryWord.match(FRAME_PARTICLE_PATTERN)?.[0];
  return {
    marker,
    argument: boundaryWord.slice(0, -marker.length),
    prefix: words.slice(0, boundaryIndex).join(' '),
    tail: words.slice(boundaryIndex + 1).join(' '),
    words,
  };
}

function actionStems(text) {
  return glossWords(text)
    .map((word) => word.replace(/(?:는|ㄴ|은|인|게)$/u, ''))
    .filter((word) => word.length >= 2);
}

function sharedActionStem(leftTail, rightTail) {
  const rightStems = new Set(actionStems(rightTail));
  return actionStems(leftTail).find((stem) => rightStems.has(stem));
}

function highConfidenceRelationship(leftGloss, rightGloss) {
  const leftFrame = frameForGloss(leftGloss);
  const rightFrame = frameForGloss(rightGloss);
  if (!leftFrame || !rightFrame || leftFrame.argument === rightFrame.argument) return undefined;

  const sameTail = leftFrame.tail === rightFrame.tail && leftFrame.tail.length > 0;
  const leftTool = TOOL_HEAD_PATTERN.test(leftFrame.tail);
  const rightTool = TOOL_HEAD_PATTERN.test(rightFrame.tail);
  if ((sameTail && leftTool && rightTool)
    || (leftTool && rightTool && sharedActionStem(leftFrame.tail, rightFrame.tail))) {
    return {
      relationship: 'usage-variant',
      reason: 'shared-tool-frame',
    };
  }

  const writingContexts = [leftFrame.argument, rightFrame.argument];
  if (leftFrame.marker === '에서'
    && rightFrame.marker === '에서'
    && sameTail
    && writingContexts.every((context) => WRITING_CONTEXT_PATTERN.test(context))) {
    return {
      relationship: 'usage-variant',
      reason: 'writing-context-only-frame',
    };
  }

  if (['을', '를'].includes(leftFrame.marker)
    && ['을', '를'].includes(rightFrame.marker)
    && sameTail
    && PARAPHRASE_TAIL_PATTERN.test(leftFrame.tail)) {
    return {
      relationship: 'overlapping',
      reason: 'shared-paraphrase-frame',
    };
  }

  return undefined;
}

/**
 * Inspect sense pairs using the gloss content itself. This is deliberately
 * independent of the number of senses currently stored on a record: a
 * duplicate, nested, high-confidence usage-only, or high-confidence
 * paraphrase-overlap pair remains a finding even when a review claims that
 * the existing sense set is already correct. The frame checks are intentionally
 * narrow: they protect clear lexical reuse without pretending to solve all
 * Korean semantic similarity mechanically.
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
      let reason;
      if (compactGloss(left.gloss) === compactGloss(right.gloss)) {
        relationship = 'duplicate';
      } else {
        const smallerSize = Math.min(leftSet.size, rightSet.size);
        if (smallerSize >= 2 && sharedTokens.length === smallerSize) relationship = 'nested';
      }
      if (relationship === 'distinct') {
        const highConfidence = highConfidenceRelationship(left.gloss, right.gloss);
        if (highConfidence) {
          relationship = highConfidence.relationship;
          reason = highConfidence.reason;
        }
      }
      pairs.push({
        left_sense_id: left.id,
        right_sense_id: right.id,
        relationship,
        ...(reason ? { mechanical_reason: reason } : {}),
        shared_tokens: sharedTokens,
        left_distinctive_tokens: leftDistinctiveTokens,
        right_distinctive_tokens: rightDistinctiveTokens,
      });
    }
  }
  return pairs;
}
