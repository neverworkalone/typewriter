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
    id: 'same-movement',
    verdict: 'direct',
    rule: 'Actions that name overlapping parts of the same movement (reaching out arm and hand to grasp or touch) remain close alternatives; a difference of body part alone is not a reason to demote.',
  },
  {
    id: 'different-movement',
    verdict: 'not-direct',
    rule: 'Actions whose bound movements differ (extending a leg vs reaching out to grasp) are neighbouring texture, not close alternatives; judge the actual movement and its natural context, not the body-part word.',
  },
  {
    id: 'narrative-contrast',
    verdict: 'not-direct',
    rule: 'A state and the act that destroys it, or a rise and a later exit in a career, are a causal or narrative contrast, not opposition on one axis; keep them association (an antonym needs the same axis).',
  },
];

export const DIRECT_BOUNDARY_INSTRUCTION = [
  'Before typing a relation direct or antonym, state for the actual bound source and target senses (id, POS, gloss) which kind of thing each names.',
  ...DIRECT_BOUNDARY_CLASSES.map(({ id, rule }) => `${id}: ${rule}`),
  'See docs/relation-editorial-policy.md; subjective lexical judgment stays editorial, and no mechanical synonym validator is implied.',
].join(' ');
