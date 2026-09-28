import assert from 'node:assert/strict';
import test from 'node:test';

import { validateDistinctSenseSemanticRationales } from '../scripts/batch/authored-semantic-decision-source.mjs';
import { validateIssue204MorphologyEvidence } from '../scripts/batch/issue-204-review-contract.mjs';

test('Issue #204 hold evidence names POS and ambiguous-surface counts separately', () => {
  const proposal = {
    ambiguity_status: 'held_surface_has_multiple_analyzer_interpretations',
    analyzer_pos_interpretation_count: 3,
    ambiguous_observed_surface_count: 1,
  };
  const rationale = '되다: analyzer_pos_interpretation_count=3; ambiguous_observed_surface_count=1. The first count summarizes candidate POS interpretations; the second counts sampled forms with multiple analyses.';

  assert.equal(validateIssue204MorphologyEvidence({
    proposal,
    disposition: 'hold',
    rationale,
    label: 'm5-test',
  }), true);
  assert.throws(() => validateIssue204MorphologyEvidence({
    proposal,
    disposition: 'hold',
    rationale: '되다: Kiwi returned 3 analyzer interpretations for sampled surface forms.',
    label: 'm5-test',
  }), /identify the POS interpretation count and ambiguous observed-surface count separately/u);
  assert.throws(() => validateIssue204MorphologyEvidence({
    proposal: { ...proposal, ambiguous_observed_surface_count: 0 },
    disposition: 'hold',
    rationale,
    label: 'm5-test',
  }), /must be held and report a positive surface count/u);
});

test('shared authored semantic intake rejects one rationale reused for distinct glosses', () => {
  const candidate = {
    senses: [
      { id: 'w-test-s1', gloss: '사건이나 경험을 엮어 전하는 내용.' },
      { id: 'w-test-s2', gloss: '대화에서 주고받는 말의 내용.' },
    ],
  };
  const duplicated = [
    { semantic_rationale: '사건이나 경험을 엮은 서사 내용을 가리킨다.' },
    { semantic_rationale: '사건이나 경험을 엮은 서사 내용을 가리킨다.' },
  ];

  assert.throws(
    () => validateDistinctSenseSemanticRationales(candidate, duplicated),
    /identical semantic rationale cannot support distinct sense glosses/u,
  );
  assert.equal(validateDistinctSenseSemanticRationales(candidate, [
    { semantic_rationale: '사건이나 경험을 엮어 전하는 서사 내용이다.' },
    { semantic_rationale: '대화에서 서로 주고받는 발화 내용이다.' },
  ]), true);
});
