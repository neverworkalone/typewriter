// Shared editorial boundary for `direct`/`antonym`, carried by every producer that asks for source-bound relation
// QA (the Stage 2 author hand-off and the Stage D backfill packet). It is guidance for an editorial judgment, not a
// mechanical synonym validator: the classes name the question a reviewer must answer for the actual bound senses.
export const DIRECT_BOUNDARY_CLASSES = [
  {
    id: 'scope-only',
    verdict: 'direct',
    rule: 'The bound senses differ only in scope, facet, register or intensity but remain close alternatives in a recurring natural context.',
  },
  {
    id: 'action-vs-agent',
    verdict: 'not-direct',
    rule: 'An action, ability or result and the person or thing that performs or bears it are different kinds of thing; keep them near/association (an antonym needs the same axis).',
  },
  {
    id: 'different-body-part',
    verdict: 'not-direct',
    rule: 'Actions of different body parts, or of a whole body part and a specific sub-part, are neighbouring texture, not close alternatives.',
  },
];

export const DIRECT_BOUNDARY_INSTRUCTION = [
  'Before typing a relation direct or antonym, state for the actual bound source and target senses (id, POS, gloss) which kind of thing each names.',
  ...DIRECT_BOUNDARY_CLASSES.map(({ id, rule }) => `${id}: ${rule}`),
  'See docs/relation-editorial-policy.md; subjective lexical judgment stays editorial, and no mechanical synonym validator is implied.',
].join(' ');
