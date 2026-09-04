import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  ValidationError,
  validateCanonicalDirectory,
} from '../scripts/validate/canonical-jsonl.mjs';

const FIXTURE_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/validator',
);
const REPOSITORY_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const VALIDATOR_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'scripts/validate/canonical-jsonl.mjs',
);
const execFile = promisify(execFileCallback);
const MALFORMED_SECOND_ROW = Buffer.concat([
  Buffer.from('{"lemma":"첫 행"}\n'),
  Buffer.from([
    0x7b,
    0x22,
    0x6c,
    0x65,
    0x6d,
    0x6d,
    0x61,
    0x22,
    0x3a,
    0x22,
    0xec,
    0x28,
    0x22,
    0x7d,
  ]),
]);
const PREEXISTING_CANONICAL = Buffer.from('{"lemma":"기존"}\n');

test('validates JSONL syntax and accepts one final newline', async () => {
  const summary = await validateCanonicalDirectory(
    path.join(FIXTURE_DIRECTORY, 'valid'),
  );

  assert.deepEqual(summary, { fileCount: 1, recordCount: 2 });
});

test('reports the file and 1-based line for JSON syntax errors after valid rows', async () => {
  await assert.rejects(
    validateCanonicalDirectory(
      path.join(FIXTURE_DIRECTORY, 'invalid-syntax'),
    ),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.code, 'INVALID_JSON');
      assert.match(error.message, /syntax-after-valid\.jsonl:2: invalid JSON/);
      return true;
    },
  );
});

test('rejects blank rows with their 1-based line number', async () => {
  await assert.rejects(
    validateCanonicalDirectory(
      path.join(FIXTURE_DIRECTORY, 'invalid-empty'),
    ),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.code, 'EMPTY_LINE');
      assert.match(error.message, /empty-row\.jsonl:2: empty lines/);
      return true;
    },
  );
});

test('rejects invalid UTF-8 with the file path and line number', async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), 'typewriter-validator-'),
  );
  const fixturePath = path.join(temporaryDirectory, 'invalid-utf8.jsonl');

  try {
    await writeFile(fixturePath, MALFORMED_SECOND_ROW);

    await assert.rejects(
      validateCanonicalDirectory(temporaryDirectory),
      (error) => {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.code, 'INVALID_UTF8');
        assert.match(
          error.message,
          /invalid-utf8\.jsonl:2: invalid UTF-8 encoding/,
        );
        return true;
      },
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('real CLI preserves pre-existing canonical data on success and failure', async () => {
  const passingRepository = await createDisposableCliRepository({
    'preexisting.jsonl': PREEXISTING_CANONICAL,
  });
  const failingRepository = await createDisposableCliRepository({
    'preexisting.jsonl': PREEXISTING_CANONICAL,
    'invalid-utf8.jsonl': MALFORMED_SECOND_ROW,
  });

  try {
    const passingResult = await execFile(
      process.execPath,
      [passingRepository.validatorPath],
      { cwd: passingRepository.repositoryPath },
    );
    assert.match(passingResult.stdout, /Validated 1 canonical JSONL file/);
    assert.deepEqual(
      await readFile(passingRepository.preexistingPath),
      PREEXISTING_CANONICAL,
    );

    await assert.rejects(
      execFile(
        process.execPath,
        [failingRepository.validatorPath],
        { cwd: failingRepository.repositoryPath },
      ),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(
          error.stderr,
          /data\/canonical\/invalid-utf8\.jsonl:2: invalid UTF-8 encoding/,
        );
        return true;
      },
    );
    assert.deepEqual(
      await readFile(failingRepository.preexistingPath),
      PREEXISTING_CANONICAL,
    );
  } finally {
    await rm(passingRepository.repositoryPath, {
      recursive: true,
      force: true,
    });
    await rm(failingRepository.repositoryPath, {
      recursive: true,
      force: true,
    });
  }
});

test('reports an initial empty canonical directory without claiming completeness', async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), 'typewriter-validator-'),
  );
  const emptyDirectory = path.join(temporaryDirectory, 'canonical');

  try {
    await mkdir(emptyDirectory);
    assert.deepEqual(await validateCanonicalDirectory(emptyDirectory), {
      fileCount: 0,
      recordCount: 0,
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

async function createDisposableCliRepository(files) {
  const repositoryPath = await mkdtemp(
    path.join(tmpdir(), 'typewriter-cli-'),
  );
  const validatorPath = path.join(
    repositoryPath,
    'scripts/validate/canonical-jsonl.mjs',
  );
  const canonicalDirectory = path.join(repositoryPath, 'data/canonical');

  try {
    await mkdir(path.dirname(validatorPath), { recursive: true });
    await mkdir(canonicalDirectory, { recursive: true });
    await copyFile(VALIDATOR_PATH, validatorPath);

    for (const [filename, contents] of Object.entries(files)) {
      await writeFile(path.join(canonicalDirectory, filename), contents);
    }

    return {
      repositoryPath,
      validatorPath,
      preexistingPath: path.join(canonicalDirectory, 'preexisting.jsonl'),
    };
  } catch (error) {
    await rm(repositoryPath, { recursive: true, force: true });
    throw error;
  }
}
