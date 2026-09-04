import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ValidationError,
  validateCanonicalDirectory,
} from '../scripts/validate/canonical-jsonl.mjs';

const FIXTURE_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/validator',
);

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

test('rejects invalid UTF-8 with the file path', async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), 'typewriter-validator-'),
  );
  const fixturePath = path.join(temporaryDirectory, 'invalid-utf8.jsonl');

  try {
    await writeFile(
      fixturePath,
      Buffer.from([0x7b, 0x22, 0x6c, 0x65, 0x6d, 0x6d, 0x61, 0x22, 0x3a, 0xc3, 0x28, 0x7d]),
    );

    await assert.rejects(
      validateCanonicalDirectory(temporaryDirectory),
      (error) => {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.code, 'INVALID_UTF8');
        assert.match(error.message, /invalid-utf8\.jsonl: invalid UTF-8 encoding/);
        return true;
      },
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
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
