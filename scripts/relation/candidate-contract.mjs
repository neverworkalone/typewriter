import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CANDIDATE_BATCH_SIZE = 500;
const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Candidate comparison form shared by Stage 1 validation and Stage 2 admission: NFC, trimmed, internal whitespace
 * collapsed. Exact-duplicate and source-lemma checks must use it so a candidate that Stage 2 would treat as the same
 * string can never pass Stage 1 as a different one.
 */
export const normalizeCandidate = (text) => text.normalize('NFC').trim().replace(/\s+/gu, ' ');

function fail(message) {
  throw new Error(message);
}

/**
 * True when a candidate is only a piece of a digit group the source gloss writes with a thousands comma
 * ("7,460미터" cut into "7" and "460미터"). It is a fragment when every occurrence of the candidate in the gloss sits
 * on a `digit,digit` boundary; a candidate that also appears intact elsewhere is not treated as a fragment.
 */
export function isThousandsCommaFragment(candidate, gloss) {
  if (typeof gloss !== 'string' || !/\d,\d/u.test(gloss) || !/^\d|\d$/u.test(candidate)) return false;
  let occurrences = 0;
  let fragments = 0;
  for (let at = gloss.indexOf(candidate); at !== -1; at = gloss.indexOf(candidate, at + 1)) {
    occurrences += 1;
    const end = at + candidate.length;
    const cutBefore = /^\d/u.test(candidate) && /\d,$/u.test(gloss.slice(Math.max(0, at - 2), at));
    const cutAfter = /\d$/u.test(candidate) && /^,\d{3}/u.test(gloss.slice(end, end + 4));
    if (cutBefore || cutAfter) fragments += 1;
  }
  return occurrences > 0 && fragments === occurrences;
}

function hasExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

/** Validate one Candidate JSONL batch against its complete Canonical shard. */
export function validateCandidateBatch(canonicalRows, candidateRows, { batch, sourceName = 'Canonical', candidateName = 'Candidate' } = {}) {
  const batchNumber = Number(batch);
  if (!Number.isInteger(batchNumber) || ![1, 2].includes(batchNumber)) {
    fail('batch must be 01 or 02');
  }
  if (!Array.isArray(canonicalRows) || !Array.isArray(candidateRows)) {
    fail('Canonical and Candidate rows must be arrays');
  }

  const offset = (batchNumber - 1) * CANDIDATE_BATCH_SIZE;
  const expectedRows = canonicalRows.slice(offset, offset + CANDIDATE_BATCH_SIZE);
  if (expectedRows.length === 0) fail(`${sourceName} has no records for batch ${String(batchNumber).padStart(2, '0')}`);
  if (candidateRows.length !== expectedRows.length) {
    fail(`${candidateName} has ${candidateRows.length} records; expected ${expectedRows.length} from ${sourceName} batch ${String(batchNumber).padStart(2, '0')}`);
  }

  let senseCount = 0;
  let candidateCount = 0;
  let emptySenseCount = 0;

  for (const [index, source] of expectedRows.entries()) {
    const row = candidateRows[index];
    const line = index + 1;
    if (!hasExactKeys(row, ['record_id', 'senses'])) {
      fail(`${candidateName}:${line} must contain only record_id and senses`);
    }
    if (row.record_id !== source.id) {
      fail(`${candidateName}:${line} record_id ${JSON.stringify(row.record_id)} does not match ${sourceName} batch record ${JSON.stringify(source.id)}`);
    }
    if (!Array.isArray(row.senses) || row.senses.length !== source.senses.length) {
      fail(`${candidateName}:${line} must preserve all ${source.senses.length} senses of ${source.id}`);
    }

    for (const [senseIndex, sourceSense] of source.senses.entries()) {
      const candidateSense = row.senses[senseIndex];
      const senseLine = `${candidateName}:${line}:${senseIndex + 1}`;
      if (!hasExactKeys(candidateSense, ['sense_id', 'candidates'])) {
        fail(`${senseLine} must contain only sense_id and candidates`);
      }
      if (candidateSense.sense_id !== sourceSense.id) {
        fail(`${senseLine} sense_id does not match ${source.id} source sense ${sourceSense.id}`);
      }
      if (!Array.isArray(candidateSense.candidates)) {
        fail(`${senseLine} candidates must be an array`);
      }

      const seen = new Set();
      const normalizedLemma = normalizeCandidate(source.lemma ?? '');
      for (const candidate of candidateSense.candidates) {
        if (typeof candidate !== 'string' || candidate.length === 0 || candidate.trim() !== candidate) {
          fail(`${senseLine} candidates must be non-empty trimmed strings`);
        }
        const normalized = normalizeCandidate(candidate);
        if (seen.has(normalized)) fail(`${senseLine} contains duplicate candidate ${JSON.stringify(candidate)}`);
        if (normalized === normalizedLemma) {
          fail(`${senseLine} candidate repeats source lemma ${JSON.stringify(source.lemma)}`);
        }
        if (isThousandsCommaFragment(candidate, sourceSense.gloss)) {
          fail(`${senseLine} candidate ${JSON.stringify(candidate)} is a fragment of a number written with a thousands comma in the source gloss`);
        }
        seen.add(normalized);
      }

      senseCount += 1;
      candidateCount += candidateSense.candidates.length;
      if (candidateSense.candidates.length === 0) emptySenseCount += 1;
    }
  }

  return {
    recordCount: expectedRows.length,
    senseCount,
    candidateCount,
    emptySenseCount,
  };
}

export function parseCandidateJsonl(contents, filePath = 'Candidate') {
  if (typeof contents !== 'string') fail(`${filePath} contents must be text`);
  return contents.split(/\r?\n/u).filter((line) => line.length > 0).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${filePath}:${index + 1} is not valid JSON: ${error.message}`);
    }
  });
}

async function readJsonl(filePath) {
  return parseCandidateJsonl(await readFile(filePath, 'utf8'), filePath);
}

export function validateCandidatePaths(canonicalPath, candidatePath, { repositoryDirectory = REPOSITORY_DIRECTORY } = {}) {
  const candidateName = path.basename(candidatePath);
  const match = /^(\d{3})_(01|02)_[a-d]_[a-z0-9_-]+\.jsonl$/u.exec(candidateName);
  if (!match) fail(`${candidateName} does not follow the Candidate v1 filename contract`);
  const [, shard, batch] = match;
  const canonicalShard = shard.padStart(4, '0');
  const expectedCanonicalPath = path.resolve(repositoryDirectory, 'data/canonical', `stdict-${canonicalShard}.jsonl`);
  if (path.resolve(canonicalPath) !== expectedCanonicalPath) {
    fail(`${candidateName} must be checked against ${path.relative(repositoryDirectory, expectedCanonicalPath)}`);
  }
  const expectedCandidatePath = path.resolve(repositoryDirectory, 'data/relation-candidates', shard, candidateName);
  if (path.resolve(candidatePath) !== expectedCandidatePath) {
    fail(`${candidateName} must be stored at ${path.relative(repositoryDirectory, expectedCandidatePath)}`);
  }
  return { shard, batch };
}

export async function validateCandidateFiles(canonicalPath, candidatePath, options = {}) {
  const { batch } = validateCandidatePaths(canonicalPath, candidatePath, options);
  const [canonicalRows, candidateRows] = await Promise.all([
    readJsonl(canonicalPath),
    readJsonl(candidatePath),
  ]);
  return validateCandidateBatch(canonicalRows, candidateRows, {
    batch,
    sourceName: canonicalPath,
    candidateName: candidatePath,
  });
}

async function main() {
  const [, , canonicalPath, candidatePath, ...extra] = process.argv;
  if (!canonicalPath || !candidatePath || extra.length > 0) {
    fail('usage: node scripts/relation/candidate-contract.mjs <canonical-shard.jsonl> <candidate-batch.jsonl>');
  }
  const result = await validateCandidateFiles(canonicalPath, candidatePath);
  console.log(`Candidate v1 valid: ${result.recordCount} records, ${result.senseCount} senses, ${result.candidateCount} candidates, ${result.emptySenseCount} empty senses, 0 source-lemma candidates.`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

