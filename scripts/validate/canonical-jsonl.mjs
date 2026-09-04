import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CANONICAL_DIRECTORY = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/canonical',
);

export class ValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

function displayPath(filePath) {
  const relativePath = path.relative(process.cwd(), filePath);
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return filePath;
}

async function collectJsonlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectJsonlFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }

  return files;
}

async function validateJsonlFile(filePath) {
  const bytes = await readFile(filePath);
  let contents;

  try {
    contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ValidationError(
      `${displayPath(filePath)}: invalid UTF-8 encoding (${error.message})`,
      'INVALID_UTF8',
    );
  }

  // An empty file is allowed while the canonical dataset is being bootstrapped.
  // A blank row inside a non-empty file is rejected as a formatting error.
  if (contents.length === 0) {
    return 0;
  }

  const lines = contents.split('\n');
  // A single final newline terminates the last JSON value; it is not an extra row.
  if (contents.endsWith('\n')) {
    lines.pop();
  }

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line.trim().length === 0) {
      throw new ValidationError(
        `${displayPath(filePath)}:${lineNumber}: empty lines are not allowed in canonical JSONL`,
        'EMPTY_LINE',
      );
    }

    try {
      JSON.parse(line);
    } catch (error) {
      throw new ValidationError(
        `${displayPath(filePath)}:${lineNumber}: invalid JSON (${error.message})`,
        'INVALID_JSON',
      );
    }
  }

  return lines.length;
}

export async function validateCanonicalDirectory(directory = DEFAULT_CANONICAL_DIRECTORY) {
  let files;

  try {
    files = await collectJsonlFiles(directory);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { fileCount: 0, recordCount: 0 };
    }

    if (error.code === 'ENOTDIR') {
      throw new ValidationError(
        `${displayPath(directory)}: canonical input path is not a directory`,
        'INVALID_ROOT',
      );
    }

    throw error;
  }

  files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  let recordCount = 0;
  for (const filePath of files) {
    recordCount += await validateJsonlFile(filePath);
  }

  return { fileCount: files.length, recordCount };
}

export async function main() {
  const summary = await validateCanonicalDirectory();

  if (summary.fileCount === 0) {
    console.log(
      'No canonical JSONL files found. Validated 0 files / 0 records. This does not indicate that dictionary data is complete.',
    );
    return;
  }

  console.log(
    `Validated ${summary.fileCount} canonical JSONL file(s) / ${summary.recordCount} record(s).`,
  );
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
