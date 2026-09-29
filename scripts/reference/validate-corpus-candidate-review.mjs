import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCorpusCandidateReviewDispositions } from '../validate/corpus-candidate-review.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function validateCorpusCandidateReviewFile(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('usage: node scripts/reference/validate-corpus-candidate-review.mjs <repository-relative-review.json>');
  }
  const filePath = path.resolve(ROOT, relativePath);
  const relativeToRoot = path.relative(ROOT, filePath);
  if (!relativeToRoot || relativeToRoot.startsWith(`..${path.sep}`) || relativeToRoot === '..' || path.isAbsolute(relativeToRoot)) {
    throw new Error('candidate review must be stored inside this repository');
  }
  const review = JSON.parse(await readFile(filePath, 'utf8'));
  if (review.contract_version !== 'm9-corpus-candidate-review-v1' || !Array.isArray(review.decisions)) {
    throw new Error('candidate review must use m9-corpus-candidate-review-v1');
  }
  return {
    batch_id: review.batch_id,
    ...validateCorpusCandidateReviewDispositions(review.decisions, { label: relativeToRoot }),
  };
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  validateCorpusCandidateReviewFile(process.argv[2])
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}
