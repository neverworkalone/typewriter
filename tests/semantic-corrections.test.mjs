import assert from 'node:assert/strict';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyCorrections } from '../scripts/validate/apply-semantic-corrections.mjs';
import {
  canonicalRecordsSha256,
  readSemanticAuditArtifact,
} from '../scripts/validate/semantic-audit.mjs';
import { readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';

const REPOSITORY_DIRECTORY = path.resolve('.');
const CANONICAL_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/canonical');
const CORRECTION_MANIFEST_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/validation/canonical-semantic-correction-manifest.json',
);
const DECISION_SOURCE_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/validation/canonical-semantic-decision-source.json',
);
const BOUNDARY_DECISIONS_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/validation/canonical-semantic-boundary-decisions.json',
);
const REVIEW_PATH = path.join(REPOSITORY_DIRECTORY, 'data/validation/canonical-semantic-review.json');
const COVERAGE_PATH = path.join(REPOSITORY_DIRECTORY, 'data/validation/canonical-semantic-coverage.json');
const AUDIT_PATH = path.join(REPOSITORY_DIRECTORY, 'data/validation/canonical-semantic-audit.json');

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function copyEvidence(root) {
  const paths = {
    decisionSourcePath: path.join(root, 'decision-source.json'),
    boundaryDecisionsPath: path.join(root, 'boundary-decisions.json'),
    reviewOutputPath: path.join(root, 'review.json'),
    coverageOutputPath: path.join(root, 'coverage.json'),
    auditOutputPath: path.join(root, 'audit.json'),
  };
  await Promise.all([
    cp(DECISION_SOURCE_PATH, paths.decisionSourcePath),
    cp(BOUNDARY_DECISIONS_PATH, paths.boundaryDecisionsPath),
    cp(REVIEW_PATH, paths.reviewOutputPath),
    cp(COVERAGE_PATH, paths.coverageOutputPath),
    cp(AUDIT_PATH, paths.auditOutputPath),
  ]);
  return paths;
}

async function rewriteCanonicalWithRecords(canonicalDirectory, replacements) {
  const canonical = await readCanonicalRecords(canonicalDirectory);
  const byFile = new Map();
  for (const recordInfo of canonical.records) {
    const records = byFile.get(recordInfo.filePath) ?? [];
    records.push(replacements.get(recordInfo.record.id) ?? recordInfo.record);
    byFile.set(recordInfo.filePath, records);
  }
  await Promise.all([...byFile.entries()].map(([filePath, records]) => (
    writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
  )));
}

async function makeBaseCanonical(root, manifest) {
  const canonicalDirectory = path.join(root, 'canonical');
  await cp(CANONICAL_DIRECTORY, canonicalDirectory, { recursive: true });
  const replacements = new Map(manifest.corrections.map((correction) => [
    correction.record_id,
    correction.before_record,
  ]));
  await rewriteCanonicalWithRecords(canonicalDirectory, replacements);
  return canonicalDirectory;
}

async function snapshotFiles(paths) {
  const targets = [
    paths.decisionSourcePath,
    paths.boundaryDecisionsPath,
    paths.reviewOutputPath,
    paths.coverageOutputPath,
    paths.auditOutputPath,
  ];
  const canonical = await readCanonicalRecords(paths.canonicalDirectory);
  targets.push(...new Set(canonical.records.map(({ filePath }) => filePath)));
  return Promise.all(targets.map(async (filePath) => [filePath, await readFile(filePath)]));
}

test('semantic correction promotion reconstructs prospective canonical from the bound base', async () => {
  const manifest = await readJson(CORRECTION_MANIFEST_PATH);
  const root = await mkdtemp(path.join(os.tmpdir(), 'typewriter-semantic-correction-test-'));
  try {
    const canonicalDirectory = await makeBaseCanonical(root, manifest);
    const evidence = await copyEvidence(root);
    const result = await applyCorrections({
      canonicalDirectory,
      correctionManifestPath: CORRECTION_MANIFEST_PATH,
      ...evidence,
      amendExisting: true,
    });
    const prospective = await readCanonicalRecords(canonicalDirectory);
    assert.equal(result.inputRevision, 'base');
    assert.equal(result.admissionStatus, 'admitted');
    assert.equal(result.canonicalRecordsSha256, manifest.prospective_canonical_records_sha256);
    assert.equal(canonicalRecordsSha256(prospective.records), manifest.prospective_canonical_records_sha256);
    const audit = await readSemanticAuditArtifact(evidence.auditOutputPath);
    assert.equal(audit.source.canonical_records_sha256, manifest.prospective_canonical_records_sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed semantic correction promotion does not mutate canonical or evidence files', async () => {
  const manifest = await readJson(CORRECTION_MANIFEST_PATH);
  const invalidManifest = structuredClone(manifest);
  invalidManifest.corrections[0].semantic_review.boundary.rationale = 'unbound failure';
  const root = await mkdtemp(path.join(os.tmpdir(), 'typewriter-semantic-correction-failure-'));
  try {
    const canonicalDirectory = path.join(root, 'canonical');
    await cp(CANONICAL_DIRECTORY, canonicalDirectory, { recursive: true });
    const evidence = await copyEvidence(root);
    const correctionManifestPath = path.join(root, 'invalid-manifest.json');
    await writeFile(correctionManifestPath, `${JSON.stringify(invalidManifest, null, 2)}\n`, 'utf8');
    const paths = { canonicalDirectory, ...evidence };
    const before = await snapshotFiles(paths);
    await assert.rejects(applyCorrections({
      canonicalDirectory,
      correctionManifestPath,
      ...evidence,
      amendExisting: true,
    }));
    const after = await snapshotFiles(paths);
    assert.deepEqual(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
