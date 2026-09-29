import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCorpusCandidateReviewDispositions } from '../validate/corpus-candidate-review.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT_VERSION = 'm9-corpus-candidate-review-v1';

function repositoryRelativePath(repositoryRoot, filePath) {
  const root = path.resolve(repositoryRoot);
  const absolutePath = path.resolve(root, filePath);
  const relativeToRoot = path.relative(root, absolutePath);
  if (!relativeToRoot || relativeToRoot.startsWith(`..${path.sep}`)
    || relativeToRoot === '..' || path.isAbsolute(relativeToRoot)) {
    throw new Error('candidate review must be stored inside this repository');
  }
  return { absolutePath, relativeToRoot };
}

function validateReview(review, label) {
  if (review?.contract_version !== CONTRACT_VERSION || !Array.isArray(review.decisions)) {
    throw new Error(`${label} must use ${CONTRACT_VERSION} and include decisions`);
  }
  return {
    path: label,
    batch_id: review.batch_id,
    ...validateCorpusCandidateReviewDispositions(review.decisions, { label }),
  };
}

export async function validateCorpusCandidateReviewFile(relativePath, {
  repositoryRoot = ROOT,
} = {}) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('usage: node scripts/reference/validate-corpus-candidate-review.mjs <repository-relative-review.json>');
  }
  const { absolutePath, relativeToRoot } = repositoryRelativePath(repositoryRoot, relativePath);
  const review = JSON.parse(await readFile(absolutePath, 'utf8'));
  return validateReview(review, relativeToRoot);
}

async function listJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJsonFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(entryPath);
    }
  }
  return files;
}

function isCandidateReviewFilename(filePath) {
  return path.basename(filePath).toLowerCase().includes('corpus-candidate-review');
}

/**
 * Discover M9 corpus candidate-review artifacts by their contract version,
 * independent of issue or batch IDs, then run the shared disposition gate.
 */
export async function validateCorpusCandidateReviewArtifacts({ repositoryRoot = ROOT } = {}) {
  const root = path.resolve(repositoryRoot);
  const batchesDirectory = path.join(root, 'data/batches');
  const files = (await listJsonFiles(batchesDirectory)).sort();
  const artifacts = [];

  for (const filePath of files) {
    const relativeToRoot = path.relative(root, filePath);
    let review;
    try {
      review = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      if (isCandidateReviewFilename(filePath)) {
        throw new Error(`${relativeToRoot} is not valid JSON: ${error.message}`);
      }
      continue;
    }

    const hasContract = review?.contract_version === CONTRACT_VERSION;
    const hasCandidateReviewName = isCandidateReviewFilename(filePath);
    if (!hasContract && !hasCandidateReviewName) continue;
    artifacts.push(validateReview(review, relativeToRoot));
  }

  return {
    contract_version: CONTRACT_VERSION,
    artifact_count: artifacts.length,
    artifacts,
  };
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const args = process.argv.slice(2);
  const validation = args.length === 0
    ? validateCorpusCandidateReviewArtifacts()
    : args.length === 1
      ? validateCorpusCandidateReviewFile(args[0])
      : Promise.reject(new Error('usage: node scripts/reference/validate-corpus-candidate-review.mjs [repository-relative-review.json]'));
  validation
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}
