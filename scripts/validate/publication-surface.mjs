import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_DIRECTORY = path.resolve(path.dirname(SCRIPT_PATH), '../..');

const UNIX_HOME_PATH_PATTERN = /(?<![\p{L}\p{N}_])\/(Users|home)\/[^\s/"'<>`]+(?:\/[^\s"'<>`]*)?/gu;
const WINDOWS_HOME_PATH_PATTERN = /(?<![\p{L}\p{N}_])[A-Z]:\\Users\\[^\\\s"'<>`]+(?:\\[^\s"'<>`]*)?/giu;

export function findPrivateAbsolutePaths(value) {
  return [
    ...[...value.matchAll(UNIX_HOME_PATH_PATTERN)].map((match) => (
      match[1] === 'Users' ? 'macOS user-home path' : 'Unix user-home path'
    )),
    ...[...value.matchAll(WINDOWS_HOME_PATH_PATTERN)].map(() => 'Windows user-home path'),
  ];
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: REPOSITORY_DIRECTORY,
    encoding: 'buffer',
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

export function scanTrackedFiles({
  files = trackedFiles(),
  readFile = (relativePath) => readFileSync(path.join(REPOSITORY_DIRECTORY, relativePath)),
} = {}) {
  const findings = [];
  for (const file of files) {
    let bytes;
    try {
      bytes = readFile(file);
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    if (bytes.includes(0)) {
      continue;
    }

    const contents = bytes.toString('utf8');
    const categories = findPrivateAbsolutePaths(contents);
    if (categories.length > 0) {
      findings.push({ file, categories });
    }
  }
  return findings;
}

export function validatePublicationSurface(options) {
  const files = options?.files ?? trackedFiles();
  const findings = scanTrackedFiles({ ...options, files });
  if (findings.length > 0) {
    const summary = findings
      .map(({ file, categories }) => `${file}: ${categories.length} private absolute path(s)`)
      .join('\n');
    throw new Error(`Public-surface path check failed:\n${summary}`);
  }
  return { scannedFileCount: files.length };
}

function main() {
  const { scannedFileCount } = validatePublicationSurface();
  console.log(`Public-surface path check passed: ${scannedFileCount} tracked files scanned.`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
