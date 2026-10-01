import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  REGISTRY_PATH,
  REVIEW_INPUT_PATH_PATTERN,
  evaluateReviewerTrust,
} from '../validate/reviewer-trust.mjs';

// Runs from the protected base checkout. The head checkout is read as data
// only (JSON); no head code is executed.

async function readOptional(filePath) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readOptionalJson(filePath) {
  const bytes = await readOptional(filePath);
  return bytes === null ? null : JSON.parse(bytes.toString('utf8'));
}

export async function runReviewerTrustGate({ baseDirectory, headDirectory }) {
  const batchDirectory = path.join(headDirectory, 'data/batches');
  let names = [];
  try {
    names = await readdir(batchDirectory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const changedInputs = [];
  for (const name of names.sort()) {
    const relativePath = `data/batches/${name}`;
    const match = REVIEW_INPUT_PATH_PATTERN.exec(relativePath);
    if (!match) continue;
    const headBytes = await readFile(path.join(headDirectory, relativePath));
    const baseBytes = await readOptional(path.join(baseDirectory, relativePath));
    if (baseBytes !== null && Buffer.compare(baseBytes, headBytes) === 0) continue;
    const candidateReview = await readOptionalJson(
      path.join(headDirectory, 'data/batches', `${match[1]}-candidate-review.json`),
    );
    changedInputs.push({
      path: relativePath,
      input: JSON.parse(headBytes.toString('utf8')),
      candidateAuthor: candidateReview?.reviewer,
    });
  }
  return {
    ...evaluateReviewerTrust({
      baseRegistry: await readOptionalJson(path.join(baseDirectory, REGISTRY_PATH)),
      headRegistry: await readOptionalJson(path.join(headDirectory, REGISTRY_PATH)),
      changedInputs,
    }),
    evaluated_input_count: changedInputs.length,
  };
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseDirectory = argumentValue('--base');
  const headDirectory = argumentValue('--head');
  if (!baseDirectory || !headDirectory) {
    console.error('Usage: node scripts/ci/reviewer-trust-gate.mjs --base <base checkout> --head <head checkout>');
    process.exit(2);
  }
  runReviewerTrustGate({ baseDirectory, headDirectory }).then((result) => {
    if (result.ok) {
      console.log(`Reviewer trust gate passed (${result.evaluated_input_count} changed review input(s) evaluated).`);
    } else {
      console.error(`Reviewer trust gate failed:\n- ${result.failures.join('\n- ')}`);
      process.exitCode = 1;
    }
  }).catch((error) => {
    console.error(`Reviewer trust gate error: ${error.message}`);
    process.exitCode = 1;
  });
}
