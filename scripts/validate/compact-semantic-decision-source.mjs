import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
  compactSemanticDecisionSource,
  isCompactSemanticDecisionSource,
  serializeSemanticDecisionSource,
} from './semantic-audit.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export async function compactDecisionSourceFile(
  inputPath = DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
  { sourceBytes } = {},
) {
  const bytes = sourceBytes ?? await readFile(inputPath);
  const source = JSON.parse(bytes.toString('utf8'));
  const compacted = compactSemanticDecisionSource(source);
  await writeFile(inputPath, serializeSemanticDecisionSource(compacted));
  return {
    inputPath,
    beforeBytes: bytes.byteLength,
    afterBytes: Buffer.byteLength(JSON.stringify(compacted, null, 2) + '\n', 'utf8'),
    alreadyCompact: isCompactSemanticDecisionSource(source),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fromCommit = process.argv.find((argument) => argument.startsWith('--from-commit='))
    ?.slice('--from-commit='.length);
  const inputArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
  const inputPath = path.resolve(
    SCRIPT_DIRECTORY,
    inputArgument ?? '../../data/validation/canonical-semantic-decision-source.json',
  );
  const sourceBytes = fromCommit
    ? execFileSync('git', [
      'show',
      `${fromCommit}:data/validation/canonical-semantic-decision-source.json`,
    ], { maxBuffer: 40 * 1024 * 1024 })
    : undefined;
  const result = await compactDecisionSourceFile(inputPath, { sourceBytes });
  console.log(JSON.stringify(result));
}
