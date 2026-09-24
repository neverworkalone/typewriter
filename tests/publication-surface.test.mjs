import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findPrivateAbsolutePaths,
  scanTrackedFiles,
} from '../scripts/validate/publication-surface.mjs';

test('personal home paths are detected without printing their values', () => {
  const macOSPath = ['', ['Us', 'ers'].join(''), 'sample-user', 'project', 'config.json'].join('/');
  const linuxPath = ['', 'home', 'sample-user', 'project', 'secret.env'].join('/');
  const windowsPath = ['C:', 'Users', 'sample-user', 'project', 'secret.env'].join('\\');

  assert.deepEqual(findPrivateAbsolutePaths(`${macOSPath}\n${linuxPath}\n${windowsPath}`), [
    'macOS user-home path',
    'Unix user-home path',
    'Windows user-home path',
  ]);
});

test('temporary test fixture paths do not look like personal home paths', () => {
  const temporaryPath = ['', 'tmp', 'typewriter', 'fixture.json'].join('/');
  assert.deepEqual(findPrivateAbsolutePaths(temporaryPath), []);
});

test('tracked-file scan reports relative filenames and never returns matched path values', () => {
  const privatePath = ['', ['Us', 'ers'].join(''), 'sample-user', 'project', 'settings.json'].join('/');
  const findings = scanTrackedFiles({
    files: ['docs/example.md', 'docs/safe.md'],
    readFile: (file) => Buffer.from(file.endsWith('example.md') ? privatePath : 'safe content'),
  });

  assert.deepEqual(findings, [{
    file: 'docs/example.md',
    categories: ['macOS user-home path'],
  }]);
  assert.equal(JSON.stringify(findings).includes('sample-user'), false);
});
