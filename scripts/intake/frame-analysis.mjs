import { createHash } from 'node:crypto';

import { analysisInputDigest, analyzerDigest } from './pipeline.mjs';

// Kiwi-backed "does this frame use lemma/pos" verdict, bound to the exact
// frame text, lemma, POS and analyzer digest. Kiwi stays a proposal source:
// a lemma found only in a non-best analysis is 'ambiguous', never a pass.
export function frameVerdict(outcome, { lemma, pos }) {
  if (!outcome || outcome.status === 'error') return 'error';
  if (outcome.status !== 'ok') return 'unsupported';
  const has = (analysis) => analysis.some((item) => item.lemma === lemma && item.pos === pos);
  const [best = [], ...alternatives] = outcome.analyses;
  if (has(best)) return 'uses';
  return alternatives.some(has) ? 'ambiguous' : 'absent';
}

export function frameBinding({ frame, lemma, pos, metadata }) {
  return createHash('sha256')
    .update(JSON.stringify(['frame-binding', analysisInputDigest(frame), lemma, pos, analyzerDigest(metadata)]))
    .digest('hex');
}

// items: [{ frame, lemma, pos }] → [{ ...item, verdict, binding }], order preserved.
export async function analyzeFrames(analyzer, items) {
  const { metadata, results } = await analyzer(items.map((item, index) => ({ id: String(index), text: item.frame })));
  const byId = new Map(results.map((outcome) => [outcome.id, outcome]));
  return items.map((item, index) => {
    const outcome = byId.get(String(index));
    const stale = outcome && outcome.input_digest !== analysisInputDigest(item.frame);
    return {
      ...item,
      verdict: stale ? 'stale' : frameVerdict(outcome, item),
      binding: frameBinding({ ...item, metadata }),
    };
  });
}

// Single shared disposition for a frame. The strict form rule (frameUsesLemma)
// is the only accept gate: Kiwi normalizes misconjugations (듣어서, 가볍었다),
// so it can corroborate but never admit. Kiwi disagreement with an accepted
// frame is an explicit manual check, not a silent pass or a rejection.
export function frameDisposition(formRuleAccepts, verdict) {
  if (!formRuleAccepts) return 'rejected';
  if (verdict === 'uses') return 'confirmed';
  return 'manual_check';
}
