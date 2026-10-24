import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ArtifactPolicyError,
  classifyTrackedArtifacts,
  readArtifactPolicy,
  validateArtifactPolicy,
} from '../scripts/validate/artifact-policy.mjs';
import { parseJsonWithUniqueKeys } from '../scripts/validate/unique-json.mjs';

test('artifact policy classifies current projections and durable inputs', async () => {
  const generatedAudit = 'data/validation/canonical-semantic-audit.json';
  const policy = await readArtifactPolicy();
  const options = {
    deterministicProjectionPatterns: policy.deterministic_projection_patterns,
    relocatableProjectionPatterns: policy.relocatable_projection_patterns,
    durableProjectionPatterns: policy.durable_projection_patterns,
    durableTrackedPatterns: policy.durable_tracked_patterns,
    protectedRoots: policy.protected_roots,
  };

  assert.deepEqual(
    classifyTrackedArtifacts([generatedAudit], options),
    {
      generated: [generatedAudit],
      unclassified: [],
    },
  );
  assert.deepEqual(
    classifyTrackedArtifacts(['data/validation/m6-2-inflection-exceptions.json'], options),
    { generated: [], unclassified: [] },
  );
  assert.deepEqual(
    classifyTrackedArtifacts(['data/relation-candidates/001/001_01_b_codex.jsonl'], options),
    { generated: [], unclassified: [] },
  );
  assert.deepEqual(
    classifyTrackedArtifacts(['data/relations/relation-001.jsonl', 'data/relation-drops/drop-001.jsonl'], options),
    { generated: [], unclassified: [] },
  );
  assert.deepEqual(
    classifyTrackedArtifacts(['data/relations/relation-099.jsonl', 'data/relation-drops/drop-100.jsonl'], options),
    { generated: [], unclassified: [] },
  );
  const historicalStage2Backups = [
    'data/relations/relation-001-backup.jsonl',
    'data/relations/relation-002-backup.jsonl',
    'data/relation-drops/drop-001-backup.jsonl',
    'data/relation-drops/drop-002-backup.jsonl',
  ];
  assert.deepEqual(
    classifyTrackedArtifacts(historicalStage2Backups, options),
    { generated: [], unclassified: [] },
  );
  const wrongNames = [
    'data/relations/notes.jsonl', 'data/relation-drops/other.jsonl',
    'data/relations/relation-notes.jsonl', 'data/relation-drops/drop-notes.jsonl',
    'data/relations/relation-01.jsonl', 'data/relation-drops/drop-0001.jsonl',
    'data/relations/relation-001.json', 'data/relations/relation-00a.jsonl',
    'data/relations/relation-003-backup.jsonl', 'data/relations/relation-001-backup.bak',
    'data/relation-drops/drop-003-backup.jsonl', 'data/relation-drops/drop-002-backup.jsonl.bak',
    'data/relations/sub/relation-001.jsonl', 'data/relation-drops/drop-001.jsonl.bak',
  ];
  assert.deepEqual(
    classifyTrackedArtifacts(wrongNames, options),
    { generated: [], unclassified: wrongNames },
  );
  assert.deepEqual(
    classifyTrackedArtifacts(['data/validation/future-derived-envelope.json'], options),
    {
      generated: [],
      unclassified: ['data/validation/future-derived-envelope.json'],
    },
  );

  await assert.doesNotReject(validateArtifactPolicy());
  await assert.rejects(
    validateArtifactPolicy({ tracked: [generatedAudit] }),
    (error) => error instanceof ArtifactPolicyError && error.code === 'GENERATED_PROJECTION_TRACKED',
  );
});

test('JSON loading rejects duplicate keys before data validation', () => {
  assert.deepEqual(
    parseJsonWithUniqueKeys('{"outer":{"key":1},"items":[{"key":2}]}', 'fixture'),
    { outer: { key: 1 }, items: [{ key: 2 }] },
  );
  assert.throws(
    () => parseJsonWithUniqueKeys('{"key":1,"key":2}', 'fixture'),
    (error) => error.code === 'DUPLICATE_JSON_KEY' && error.message.includes('"key"'),
  );
  assert.throws(
    () => parseJsonWithUniqueKeys('{"outer":{"key":1,"key":2}}', 'fixture'),
    (error) => error.code === 'DUPLICATE_JSON_KEY' && error.message.includes('$.outer'),
  );
});
