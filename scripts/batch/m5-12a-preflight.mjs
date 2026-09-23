import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  buildDictionary,
} from '../build/dictionary.mjs';
import {
  getMetadata,
  readLogicalDatabaseSnapshot,
} from '../build/query.mjs';
import { CI_CATEGORIES } from '../ci/registry.mjs';
import { runChecks } from '../ci/run-category.mjs';
import {
  validatePackage,
} from '../validate-package.mjs';
import {
  validateArtifactPolicy,
} from '../validate/artifact-policy.mjs';

const execFileAsync = promisify(execFile);
const REPOSITORY_DIRECTORY = path.resolve(new URL('../..', import.meta.url).pathname);
const VITE_PATH = path.join(REPOSITORY_DIRECTORY, 'node_modules/.bin/vite');
const PREFLIGHT_CACHE = new Map();

export class M512APreflightError extends Error {
  constructor(message, code = 'M5_12A_PREFLIGHT_ERROR') {
    super(message);
    this.name = 'M512APreflightError';
    this.code = code;
  }
}

function fail(message, code = 'M5_12A_PREFLIGHT_ERROR') {
  throw new M512APreflightError(message, code);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function chmodFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return chmodFiles(filePath);
    if (entry.isFile()) await chmod(filePath, 0o644);
    return undefined;
  }));
}

function closeDatabase(database) {
  try {
    database?.close();
  } catch {
    // A failed preflight must not hide its source failure behind cleanup.
  }
}

function compareLogicalDatabaseSnapshots(first, second) {
  return JSON.stringify(first) === JSON.stringify(second);
}

async function runProspectiveProductChecks({ canonicalDirectory, outputDirectory, databasePath }) {
  const environment = {
    TYPEWRITER_ALLOW_DIRTY: 'true',
    TYPEWRITER_BUILD_MINIFY: 'false',
    TYPEWRITER_CANONICAL_DIRECTORY: canonicalDirectory,
    TYPEWRITER_BUILD_OUTPUT_DIRECTORY: outputDirectory,
    TYPEWRITER_SEARCH_REGRESSION_DATABASE: databasePath,
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    await runChecks(CI_CATEGORIES.product.checks, {
      sharedDictionaryPath: databasePath,
    });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runM512APreflightOnce({
  prospectiveCanonicalDirectory,
  prospectiveCanonicalDigest,
  expectedSummary,
  candidateSourceDigest,
  expectedCandidateSourceDigest,
  generationPassId,
  verificationPassId,
  humanReviewClaimed,
  expectedMetadata,
} = {}) {
  if (!prospectiveCanonicalDirectory || !prospectiveCanonicalDigest || !expectedSummary) {
    fail('M5-12A preflight requires the complete prospective canonical input and digest', 'M5_12A_PREFLIGHT_INPUT_REQUIRED');
  }
  if (candidateSourceDigest !== expectedCandidateSourceDigest) {
    fail('M5-12A candidate source digest does not match the authoritative identity source', 'M5_12A_PREFLIGHT_SOURCE_FAILED');
  }
  if (!generationPassId || !verificationPassId || generationPassId === verificationPassId) {
    fail('M5-12A generation and verification passes are not separated', 'M5_12A_PREFLIGHT_PROVENANCE_FAILED');
  }
  if (humanReviewClaimed !== false) {
    fail('M5-12A preflight cannot claim human review for agent-authored decisions', 'M5_12A_PREFLIGHT_PROVENANCE_FAILED');
  }
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-12a-preflight-'));
  const outputDirectory = path.join(temporaryDirectory, 'dist');
  const sharedProductDatabasePath = path.join(temporaryDirectory, 'dictionary-shared.sqlite');
  const secondDatabasePath = path.join(temporaryDirectory, 'dictionary-second.sqlite');
  const zipPath = path.join(temporaryDirectory, `${path.basename(temporaryDirectory)}_1.0.zip`);
  let firstDatabase;
  let secondDatabase;
  try {
    await mkdir(outputDirectory, { recursive: true });
    await execFileAsync(VITE_PATH, ['build', '--config', path.join(REPOSITORY_DIRECTORY, 'vite.config.js')], {
      cwd: REPOSITORY_DIRECTORY,
      env: {
        ...process.env,
        TYPEWRITER_ALLOW_DIRTY: 'true',
        TYPEWRITER_BUILD_MINIFY: 'false',
        TYPEWRITER_CANONICAL_DIRECTORY: prospectiveCanonicalDirectory,
        TYPEWRITER_BUILD_OUTPUT_DIRECTORY: outputDirectory,
      },
      maxBuffer: 20 * 1024 * 1024,
    });

    const productDatabasePath = path.join(outputDirectory, 'dictionary.sqlite');
    await copyFile(productDatabasePath, sharedProductDatabasePath);
    await runProspectiveProductChecks({
      canonicalDirectory: prospectiveCanonicalDirectory,
      outputDirectory,
      databasePath: sharedProductDatabasePath,
    });
    for (const fileName of ['favicon.ico', 'icon.png']) {
      await rm(path.join(outputDirectory, fileName), { force: true });
    }
    await Promise.all([
      cp(path.join(REPOSITORY_DIRECTORY, 'Apache-2.0.txt'), path.join(outputDirectory, 'Apache-2.0.txt')),
      cp(path.join(REPOSITORY_DIRECTORY, 'THIRD-PARTY-NOTICES.txt'), path.join(outputDirectory, 'THIRD-PARTY-NOTICES.txt')),
    ]);
    await chmodFiles(outputDirectory);
    await execFileAsync('zip', ['-qr', zipPath, '.'], { cwd: outputDirectory });

    const packageResult = validatePackage({
      projectRoot: REPOSITORY_DIRECTORY,
      packageDir: outputDirectory,
      zipPath,
      expectedMetadata,
    });
    if (packageResult.errors.length > 0) {
      fail(`prospective package validation failed: ${packageResult.errors.join('; ')}`, 'M5_12A_PREFLIGHT_PACKAGE_FAILED');
    }

    firstDatabase = new DatabaseSync(productDatabasePath, { readOnly: true });
    const firstSnapshot = readLogicalDatabaseSnapshot(firstDatabase);
    const firstMetadata = getMetadata(firstDatabase);
    if (firstMetadata.record_count !== String(expectedSummary.record_count)
      || firstMetadata.start_count !== String(expectedSummary.start_count)
      || firstMetadata.reference_only_count !== String(expectedSummary.reference_only_count)
      || firstMetadata.sense_count !== String(expectedSummary.sense_count)
      || firstMetadata.relation_count !== String(expectedSummary.relation_count)
      || firstMetadata.expression_count !== String(expectedSummary.expression_count)) {
      fail('prospective SQLite metadata does not match the fixed M5-12A canonical summary', 'M5_12A_PREFLIGHT_SQLITE_FAILED');
    }
    const productDatabaseBytes = await readFile(productDatabasePath);

    const secondSummary = await buildDictionary({
      inputDirectory: prospectiveCanonicalDirectory,
      outputPath: secondDatabasePath,
      checkPilotCompleteness: true,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      allowDirty: true,
    });
    secondDatabase = new DatabaseSync(secondDatabasePath, { readOnly: true });
    const secondSnapshot = readLogicalDatabaseSnapshot(secondDatabase);
    if (!compareLogicalDatabaseSnapshots(firstSnapshot, secondSnapshot)) {
      fail('prospective SQLite rebuild is not logically deterministic', 'M5_12A_PREFLIGHT_SQLITE_FAILED');
    }

    const artifactPolicy = await validateArtifactPolicy({
      repositoryDirectory: REPOSITORY_DIRECTORY,
      checkClean: true,
    });
    closeDatabase(firstDatabase);
    closeDatabase(secondDatabase);
    firstDatabase = undefined;
    secondDatabase = undefined;

    return {
      status: 'complete',
      input_canonical_directory_sha256: prospectiveCanonicalDigest,
      checks: {
        candidate_source_digest: {
          status: candidateSourceDigest === expectedCandidateSourceDigest ? 'pass' : 'fail',
          input_canonical_directory_sha256: prospectiveCanonicalDigest,
          candidate_source_sha256: candidateSourceDigest,
        },
        generation_verification_separated: {
          status: generationPassId !== verificationPassId ? 'pass' : 'fail',
          input_canonical_directory_sha256: prospectiveCanonicalDigest,
          generation_pass_id: generationPassId,
          verification_pass_id: verificationPassId,
        },
        truthful_agent_provenance: {
          status: humanReviewClaimed === false ? 'pass' : 'fail',
          input_canonical_directory_sha256: prospectiveCanonicalDigest,
          human_review_claimed: humanReviewClaimed,
        },
        deterministic_sqlite: {
          status: 'pass',
          input_canonical_directory_sha256: prospectiveCanonicalDigest,
          product_dictionary_sha256: sha256(productDatabaseBytes),
          rebuilt_logical_snapshot: true,
          summary: secondSummary,
        },
        search_product_regression: {
          status: 'pass',
          input_canonical_directory_sha256: prospectiveCanonicalDigest,
          ci_category: 'product',
          check_labels: CI_CATEGORIES.product.checks.map(({ label }) => label),
          database_sha256: sha256(productDatabaseBytes),
        },
        extension_build: {
          status: 'pass',
          input_canonical_directory_sha256: prospectiveCanonicalDigest,
          package_file_count: packageResult.actualFiles.length,
        },
        package_validation: {
          status: 'pass',
          input_canonical_directory_sha256: prospectiveCanonicalDigest,
          package_file_count: packageResult.actualFiles.length,
          zip_file_count: packageResult.zipFiles.length,
        },
        artifact_policy_clean_checkout: {
          status: 'pass',
          input_canonical_directory_sha256: prospectiveCanonicalDigest,
          tracked_artifact_count: artifactPolicy.trackedArtifactCount,
          generated_projection_count: artifactPolicy.generatedProjectionCount,
          unclassified_artifact_count: artifactPolicy.unclassifiedArtifactCount,
          working_tree_clean: artifactPolicy.workingTreeClean,
        },
      },
    };
  } catch (error) {
    if (error instanceof M512APreflightError) throw error;
    fail(error.message, 'M5_12A_PREFLIGHT_EXECUTION_FAILED');
  } finally {
    closeDatabase(firstDatabase);
    closeDatabase(secondDatabase);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function preflightCacheKey(options) {
  return JSON.stringify({
    prospectiveCanonicalDigest: options.prospectiveCanonicalDigest,
    expectedSummary: options.expectedSummary,
    candidateSourceDigest: options.candidateSourceDigest,
    expectedCandidateSourceDigest: options.expectedCandidateSourceDigest,
    generationPassId: options.generationPassId,
    verificationPassId: options.verificationPassId,
    humanReviewClaimed: options.humanReviewClaimed,
    expectedMetadata: options.expectedMetadata,
  });
}

export async function runM512APreflight(options = {}) {
  const key = preflightCacheKey(options);
  let resultPromise = PREFLIGHT_CACHE.get(key);
  if (!resultPromise) {
    resultPromise = runM512APreflightOnce(options);
    PREFLIGHT_CACHE.set(key, resultPromise);
    try {
      await resultPromise;
    } catch (error) {
      PREFLIGHT_CACHE.delete(key);
      throw error;
    }
  }
  return structuredClone(await resultPromise);
}
