import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
  sha256Json,
} from '../scripts/validate/semantic-audit.mjs';
import { readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';
import { findAmbiguousParticleFragments } from '../scripts/validate/lexical-quality.mjs';
import { promisify } from 'node:util';

const REPOSITORY_DIRECTORY = path.resolve('.');
const execFileAsync = promisify(execFile);
const BASE_DECISION_SOURCE_COMMIT = '1b1b50d2d5f10a55ddd416b54d45732dabd3fe89';
// The correction manifest is bound to the pre-M5-12A 1,320-record snapshot;
// keep this regression on that immutable historical input after promotion.
const CANONICAL_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/batches/m5-12-base-canonical');
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
  const { stdout: historicalDecisionSource } = await execFileAsync(
    'git',
    ['show', `${BASE_DECISION_SOURCE_COMMIT}:${path.relative(REPOSITORY_DIRECTORY, DECISION_SOURCE_PATH)}`],
    { cwd: REPOSITORY_DIRECTORY, maxBuffer: 10 * 1024 * 1024 },
  );
  const historicalSource = JSON.parse(historicalDecisionSource);
  const historicalCanonical = await readCanonicalRecords(CANONICAL_DIRECTORY);
  const senseById = new Map(
    historicalCanonical.records.flatMap(({ record }) => record.senses.map((sense) => [sense.id, sense])),
  );
  for (const reviewedRecord of historicalSource.authored_review.records) {
    for (const senseReview of reviewedRecord.sense_reviews) {
      if (senseReview.review_basis.topic_analysis !== undefined) continue;
      const sense = senseById.get(senseReview.sense_id);
      const fragment = findAmbiguousParticleFragments(sense?.gloss)[0];
      if (!fragment) continue;
      senseReview.review_basis.topic_analysis = {
        status: 'pass',
        state: fragment.kind === 'adnominal' ? 'adnominal' : 'ambiguous',
        topic: fragment.topic,
        particle: fragment.particle,
        predicate: fragment.predicate,
        gloss_sha256: sha256Json(sense.gloss),
        decision_source_id: historicalSource.source_id,
        rationale: `${reviewedRecord.record_id} ${sense.id} historical correction fixture binds the shared particle span.`,
      };
    }
  }
  historicalSource.authored_review_sha256 = sha256Json(historicalSource.authored_review);
  await Promise.all([
    writeFile(paths.decisionSourcePath, `${JSON.stringify(historicalSource, null, 2)}\n`, 'utf8'),
    cp(BOUNDARY_DECISIONS_PATH, paths.boundaryDecisionsPath),
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
