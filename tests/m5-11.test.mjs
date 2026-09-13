import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildM511 } from '../scripts/batch/build-m5-11-expansion.mjs';
import { M5_11_CATALOG } from '../scripts/batch/m5-11-catalog.mjs';
import {
  sha256Json,
  sha256ProposalRow,
  validateM511EditorialDecisions,
} from '../scripts/batch/m5-11-editorial.mjs';
import { resolveRepositoryPath, validateM511 } from '../scripts/batch/validate-m5-11.mjs';

const BOUNDARY_IDS = [
  'physical-figurative',
  'homonym-pos',
  'sensory-emotion-state-action',
  'directional-symmetry',
  'compound-spaced-phrase',
  'word-idiom',
];

function makeBoundaryChecks(inventoryId, senseIds) {
  return Object.fromEntries(BOUNDARY_IDS.map((id) => [id, {
    status: 'checked',
    rationale: `${inventoryId} ${id} reviewed ${senseIds.join(' ')}`,
    contrast: `${id} contrast for ${inventoryId}`,
    sense_ids: [...senseIds],
  }]));
}

function makeAdmittedDecision({ inventoryId, canonicalId, candidateLemma, correctedLemma }) {
  const lemma = correctedLemma ?? candidateLemma;
  const senseId = `${canonicalId}-s1`;
  return {
    inventory_id: inventoryId,
    decision: correctedLemma === undefined ? 'included' : 'corrected',
    candidate_lemma: candidateLemma,
    ...(correctedLemma === undefined ? {} : { corrected_lemma: correctedLemma }),
    canonical_record: {
      id: canonicalId,
      role: 'start',
      candidate_id: canonicalId,
      lemma,
      search_forms: [lemma],
      senses: [{ id: senseId, pos: 'noun', gloss: `${lemma} reviewed sense` }],
    },
    sense_review: {
      status: 'complete',
      observed_sense_count: 1,
      observed_sense_ids: [senseId],
      observed_pos: ['noun'],
      note: `${inventoryId} reviewed ${senseId} as the admitted sense`,
      boundary_checks: makeBoundaryChecks(inventoryId, [senseId]),
    },
  };
}

function makeProposalSource(catalog, rows = []) {
  const proposals = catalog.map((entry, index) => {
    const row = rows[index] ?? {};
    const candidateLemma = row.candidateLemma ?? `후보-${entry.inventory_id}`;
    const candidateRecord = row.candidateRecord ?? {
      id: `proposal-${entry.inventory_id}`,
      role: 'start',
      candidate_id: `proposal-${entry.inventory_id}`,
      lemma: candidateLemma,
      search_forms: [candidateLemma],
      senses: [{
        id: `proposal-${entry.inventory_id}-s1`,
        pos: 'noun',
        gloss: 'external proposal body',
      }],
    };
    const proposalRow = {
      inventory_id: entry.inventory_id,
      candidate_lemma: candidateLemma,
      candidate_record: candidateRecord,
    };
    return {
      ...proposalRow,
      proposal_sha256: sha256ProposalRow(proposalRow),
    };
  });
  return {
    schema_version: '1',
    issue: 97,
    batch_id: 'm5-11-expansion-20260913',
    catalog_sha256: sha256Json(catalog),
    catalog_count: catalog.length,
    proposals,
  };
}

function bindArtifactToProposal(artifact, proposal) {
  artifact.proposal_sha256 = sha256Json(proposal);
  artifact.proposal_count = proposal.proposals.length;
  const proposalsById = new Map(proposal.proposals.map((row) => [row.inventory_id, row]));
  for (const decision of artifact.decisions) {
    const proposalRow = proposalsById.get(decision.inventory_id);
    decision.candidate_lemma = proposalRow.candidate_lemma;
    decision.candidate_proposal_sha256 = proposalRow.proposal_sha256;
  }
  return artifact;
}

test('M5-11 remains HOLD before a separately supplied editorial decision artifact', async () => {
  const result = await validateM511();

  assert.deepEqual(result.canonical, {
    record_count: 820,
    start_count: 778,
    reference_only_count: 42,
    sense_count: 966,
    relation_count: 473,
    expression_count: 63,
  });
  assert.equal(result.gate_status, 'fail');
  assert.equal(result.promotion.canonical_mutation, false);
  assert.equal(result.decisions.unreviewed, 550);
  assert.ok(result.gate_failures.includes('editorial_decision_artifact'));
});

test('M5-11 producer cannot manufacture a canonical import without external editorial decisions', async () => {
  await assert.rejects(
    buildM511(),
    /requires --editorial=<external decision artifact>/u,
  );
  await assert.rejects(
    buildM511({
      editorialDecisionPath: '/tmp/m5-11-missing-editorial.json',
      outputPath: 'data/batches/m5-11-reviewed-import.jsonl',
    }),
    /must remain outside the repository/u,
  );
  await assert.rejects(
    buildM511({
      editorialDecisionPath: '/tmp/m5-11-missing-editorial.json',
      outputPath: '/tmp/m5-11-reviewed-import.jsonl',
    }),
    /requires --proposal=<external frozen proposal artifact>/u,
  );
});

test('mixed-sense candidates require concrete boundary evidence before admission', () => {
  const catalog = [
    {
      inventory_id: 'm5-535',
      axis: 'X',
      flags: ['direct-boundary'],
    },
    {
      inventory_id: 'm5-536',
      axis: 'X',
      flags: ['direct-boundary'],
    },
  ];
  const artifact = {
    schema_version: '1',
    issue: 97,
    batch_id: 'm5-11-expansion-20260913',
    catalog_sha256: sha256Json(catalog),
    catalog_count: catalog.length,
    human_editorial_review_complete: true,
    gate_decision: 'APPROVE BOUNDED',
    decisions: [
      {
        inventory_id: 'm5-535',
        decision: 'included',
        candidate_lemma: '다독이다',
        canonical_record: {
          id: 'w779',
          role: 'start',
          candidate_id: 'w779',
          lemma: '다독이다',
          search_forms: ['다독이다'],
          senses: [
            { id: 'w779-s1', pos: 'verb', gloss: '살살 두드리다' },
            { id: 'w779-s2', pos: 'verb', gloss: '마음을 달래다' },
          ],
        },
        sense_review: {
          status: 'complete',
          observed_sense_count: 2,
          observed_sense_ids: ['w779-s1', 'w779-s2'],
          observed_pos: ['verb', 'verb'],
          note: 'm5-535 reviewed w779-s1 and w779-s2 as separate senses',
          boundary_checks: Object.fromEntries([
            'physical-figurative',
            'homonym-pos',
            'sensory-emotion-state-action',
            'directional-symmetry',
            'compound-spaced-phrase',
            'word-idiom',
          ].map((id) => [id, {
            status: 'checked',
            rationale: `m5-535 ${id} reviewed w779-s1 and w779-s2`,
            sense_ids: ['w779-s1', 'w779-s2'],
          }])),
        },
      },
      {
        inventory_id: 'm5-536',
        decision: 'deferred',
      },
    ],
  };
  const proposal = makeProposalSource(catalog, [
    { candidateLemma: '다독이다', candidateRecord: artifact.decisions[0].canonical_record },
    { candidateLemma: '예비표현' },
  ]);
  bindArtifactToProposal(artifact, proposal);

  assert.throws(
    () => validateM511EditorialDecisions(artifact, {
      catalog,
      proposal,
      expectedImportedCount: 1,
    }),
    /contrast/u,
  );

  const completeArtifact = structuredClone(artifact);
  completeArtifact.decisions[0].decision = 'corrected';
  completeArtifact.decisions[0].corrected_lemma = '다독이다';
  for (const check of Object.values(completeArtifact.decisions[0].sense_review.boundary_checks)) {
    check.contrast = 'physical and figurative senses are separately retained';
  }
  assert.equal(
    validateM511EditorialDecisions(completeArtifact, {
      catalog,
      proposal,
      expectedImportedCount: 1,
    }).importedRecords[0].senses.length,
    2,
  );

  completeArtifact.decisions[0].canonical_record.senses.pop();
  for (const check of Object.values(completeArtifact.decisions[0].sense_review.boundary_checks)) {
    check.sense_ids = ['w779-s1'];
  }
  assert.throws(
    () => validateM511EditorialDecisions(completeArtifact, {
      catalog,
      proposal,
      expectedImportedCount: 1,
    }),
    /observed_sense_count/u,
  );

  const allNotApplicable = structuredClone(completeArtifact);
  for (const check of Object.values(allNotApplicable.decisions[0].sense_review.boundary_checks)) {
    check.status = 'not-applicable';
    check.sense_ids = [];
  }
  assert.throws(
    () => validateM511EditorialDecisions(allNotApplicable, {
      catalog,
      proposal,
      expectedImportedCount: 1,
    }),
    /at least one checked sense boundary/u,
  );

  const checkedWithoutSense = structuredClone(completeArtifact);
  checkedWithoutSense.decisions[0].sense_review.boundary_checks['physical-figurative'].sense_ids = [];
  assert.throws(
    () => validateM511EditorialDecisions(checkedWithoutSense, {
      catalog,
      proposal,
      expectedImportedCount: 1,
    }),
    /checked evidence must cite at least one sense/u,
  );

  const notApplicableWithSense = structuredClone(completeArtifact);
  notApplicableWithSense.decisions[0].sense_review.boundary_checks['physical-figurative'].status = 'not-applicable';
  assert.throws(
    () => validateM511EditorialDecisions(notApplicableWithSense, {
      catalog,
      proposal,
      expectedImportedCount: 1,
    }),
    /not-applicable evidence must not cite senses/u,
  );

  const unlistedMixedSense = structuredClone(completeArtifact);
  unlistedMixedSense.catalog_sha256 = sha256Json([catalog[0]]);
  unlistedMixedSense.catalog_count = 1;
  unlistedMixedSense.decisions = [structuredClone(completeArtifact.decisions[0])];
  unlistedMixedSense.decisions[0].candidate_lemma = '깜빡이다';
  unlistedMixedSense.decisions[0].decision = 'corrected';
  unlistedMixedSense.decisions[0].corrected_lemma = '깜빡이다';
  unlistedMixedSense.decisions[0].canonical_record.lemma = '깜빡이다';
  unlistedMixedSense.decisions[0].canonical_record.senses = [
    { id: 'w779-s1', pos: 'verb', gloss: '눈을 잠깐 감았다 뜨다' },
  ];
  unlistedMixedSense.decisions[0].sense_review.observed_sense_count = 2;
  unlistedMixedSense.decisions[0].sense_review.observed_sense_ids = ['w779-s1', 'w779-s2'];
  unlistedMixedSense.decisions[0].sense_review.observed_pos = ['verb', 'verb'];
  unlistedMixedSense.decisions[0].sense_review.note = 'm5-535 reviewed w779-s1 and w779-s2 before admission';
  for (const check of Object.values(unlistedMixedSense.decisions[0].sense_review.boundary_checks)) {
    check.sense_ids = ['w779-s1'];
    check.rationale = 'm5-535 boundary reviewed w779-s1';
  }
  const unlistedProposal = makeProposalSource([catalog[0]], [{
    candidateLemma: '깜빡이다',
    candidateRecord: {
      id: 'proposal-m5-535',
      role: 'start',
      candidate_id: 'proposal-m5-535',
      lemma: '깜빡이다',
      search_forms: ['깜빡이다'],
      senses: [
        { id: 'proposal-m5-535-s1', pos: 'verb', gloss: '눈을 잠깐 감았다 뜨다' },
        { id: 'proposal-m5-535-s2', pos: 'verb', gloss: '빛이 잠깐 나타났다 사라지다' },
      ],
    },
  }]);
  bindArtifactToProposal(unlistedMixedSense, unlistedProposal);
  assert.throws(
    () => validateM511EditorialDecisions(unlistedMixedSense, {
      catalog: [catalog[0]],
      proposal: unlistedProposal,
      expectedImportedCount: 1,
    }),
    /observed_sense_count/u,
  );

  const substitutedCandidate = structuredClone(completeArtifact);
  substitutedCandidate.decisions[0].candidate_lemma = '다른 후보';
  assert.throws(
    () => validateM511EditorialDecisions(substitutedCandidate, {
      catalog,
      proposal,
      expectedImportedCount: 1,
    }),
    /candidate_lemma does not match the frozen proposal/u,
  );

  const substitutedBody = structuredClone(artifact);
  substitutedBody.decisions[0].canonical_record.senses[0].gloss = 'substituted body';
  assert.throws(
    () => validateM511EditorialDecisions(substitutedBody, {
      catalog,
      proposal,
      expectedImportedCount: 1,
    }),
    /canonical_record does not match the frozen proposal body/u,
  );

  const substitutedProposal = structuredClone(proposal);
  substitutedProposal.proposals[0].candidate_record.senses[0].gloss = 'substituted external proposal';
  assert.throws(
    () => validateM511EditorialDecisions(completeArtifact, {
      catalog,
      proposal: substitutedProposal,
      expectedImportedCount: 1,
    }),
    /proposal_sha256 does not bind the proposal body/u,
  );
});

test('M5-11 tracked catalog contains selection metadata, not unreviewed proposal bodies', () => {
  assert.equal(M5_11_CATALOG.length, 550);
  for (const entry of M5_11_CATALOG) {
    assert.deepEqual(Object.keys(entry).sort(), ['axis', 'catalog_index', 'flags', 'inventory_id']);
    assert.equal(Object.hasOwn(entry, 'lemma'), false);
    assert.equal(Object.hasOwn(entry, 'pos'), false);
    assert.equal(Object.hasOwn(entry, 'gloss'), false);
  }
});

test('M5-11 reserve arithmetic allows held and rejected rows before later admissions', () => {
  const catalog = [0, 1, 2, 3].map((index) => ({
    inventory_id: `m5-${String(535 + index).padStart(3, '0')}`,
    axis: 'A',
    flags: ['action-direction'],
  }));
  const included = makeAdmittedDecision({
    inventoryId: 'm5-537',
    canonicalId: 'w779',
    candidateLemma: '후보셋',
  });
  const corrected = makeAdmittedDecision({
    inventoryId: 'm5-538',
    canonicalId: 'w780',
    candidateLemma: '후보넷',
    correctedLemma: '후보넷수정',
  });
  const correctedProposalRecord = structuredClone(corrected.canonical_record);
  correctedProposalRecord.lemma = '후보넷';
  correctedProposalRecord.search_forms = ['후보넷'];
  const artifact = {
    schema_version: '1',
    issue: 97,
    batch_id: 'm5-11-expansion-20260913',
    catalog_sha256: sha256Json(catalog),
    catalog_count: catalog.length,
    human_editorial_review_complete: true,
    gate_decision: 'APPROVE BOUNDED',
    decisions: [
      { inventory_id: 'm5-535', decision: 'held' },
      { inventory_id: 'm5-536', decision: 'rejected' },
      included,
      corrected,
    ],
  };
  const proposal = makeProposalSource(catalog, [
    { candidateLemma: '보류 후보' },
    { candidateLemma: '거절 후보' },
    { candidateLemma: '후보셋', candidateRecord: included.canonical_record },
    { candidateLemma: '후보넷', candidateRecord: correctedProposalRecord },
  ]);
  bindArtifactToProposal(artifact, proposal);

  const result = validateM511EditorialDecisions(artifact, {
    catalog,
    proposal,
    expectedImportedCount: 2,
  });
  assert.equal(result.importedRecords.length, 2);
  assert.deepEqual(result.decisionCounts, {
    included: 1,
    corrected: 1,
    held: 1,
    rejected: 1,
    deferred: 0,
  });
});

test('M5-11 source bindings reject path and digest substitution', async () => {
  assert.throws(
    () => resolveRepositoryPath('../outside', 'source.path'),
    /escapes the repository/u,
  );

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-11-'));
  const stagePath = path.join(tempDirectory, 'stage.json');
  try {
    const stage = JSON.parse(await readFile('data/batches/m5-11-stage.json', 'utf8'));
    stage.source.catalog = '../outside';
    await writeFile(stagePath, `${JSON.stringify(stage)}\n`, 'utf8');
    await assert.rejects(
      validateM511({ stagePath }),
      /catalog path binding/u,
    );

    stage.source.catalog = 'scripts/batch/m5-11-catalog.mjs';
    stage.source.catalog_sha256 = '0'.repeat(64);
    await writeFile(stagePath, `${JSON.stringify(stage)}\n`, 'utf8');
    await assert.rejects(
      validateM511({ stagePath }),
      /catalog digest binding/u,
    );

    stage.source.catalog_sha256 = sha256Json(M5_11_CATALOG);
    stage.input.base_inventory_sha256 = '0'.repeat(64);
    await writeFile(stagePath, `${JSON.stringify(stage)}\n`, 'utf8');
    await assert.rejects(
      validateM511({ stagePath }),
      /stage base inventory digest/u,
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
