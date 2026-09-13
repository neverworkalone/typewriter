import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildM511 } from '../scripts/batch/build-m5-11-expansion.mjs';
import { M5_11_CATALOG } from '../scripts/batch/m5-11-catalog.mjs';
import {
  sha256Json,
  validateM511EditorialDecisions,
} from '../scripts/batch/m5-11-editorial.mjs';
import { resolveRepositoryPath, validateM511 } from '../scripts/batch/validate-m5-11.mjs';

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
});

test('mixed-sense candidates require concrete boundary evidence before admission', () => {
  const catalog = [
    {
      lemma: '다독이다',
      pos: 'verb',
      gloss: '살살 두드리거나 마음을 달래다',
      axis: 'X',
      flags: ['direct-boundary', 'mixed-sense-review'],
    },
    {
      lemma: '예비표현',
      pos: 'noun',
      gloss: '검수 전 예비 후보',
      axis: 'X',
      flags: ['direct-boundary'],
    },
  ];
  const artifact = {
    schema_version: '1',
    issue: 97,
    batch_id: 'm5-11-expansion-20260913',
    catalog_sha256: sha256Json(catalog),
    human_editorial_review_complete: true,
    gate_decision: 'APPROVE BOUNDED',
    decisions: [
      {
        inventory_id: 'm5-535',
        decision: 'included',
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
          boundary_checks: Object.fromEntries([
            'physical-figurative',
            'homonym-pos',
            'sensory-emotion-state-action',
            'directional-symmetry',
            'compound-spaced-phrase',
            'word-idiom',
          ].map((id) => [id, {
            status: 'checked',
            rationale: `reviewed ${id}`,
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

  assert.throws(
    () => validateM511EditorialDecisions(artifact, {
      catalog,
      expectedImportedCount: 1,
      expectedDeferredCount: 1,
    }),
    /contrast/u,
  );

  const completeArtifact = structuredClone(artifact);
  for (const check of Object.values(completeArtifact.decisions[0].sense_review.boundary_checks)) {
    check.contrast = 'physical and figurative senses are separately retained';
  }
  assert.equal(
    validateM511EditorialDecisions(completeArtifact, {
      catalog,
      expectedImportedCount: 1,
      expectedDeferredCount: 1,
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
      expectedImportedCount: 1,
      expectedDeferredCount: 1,
    }),
    /mixed-sense candidate boundary/u,
  );
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
