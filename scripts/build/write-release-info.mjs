import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPackageReleaseInfo } from './release-info.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');
const packageDirectory = path.resolve(process.argv[2] ?? path.join(PROJECT_ROOT, 'dist'));
const releaseInfo = createPackageReleaseInfo({
  projectRoot: PROJECT_ROOT,
  packageDirectory,
});

writeFileSync(
  path.join(packageDirectory, 'release-info.json'),
  `${JSON.stringify(releaseInfo, null, 2)}\n`,
  { mode: 0o644 },
);
console.log(`Wrote release identity for ${releaseInfo.source.revision}.`);
