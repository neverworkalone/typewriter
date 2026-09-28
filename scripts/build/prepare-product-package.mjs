import { chmod, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPackageReleaseInfo } from './release-info.mjs';

const REPOSITORY_DIRECTORY = path.resolve(new URL('../..', import.meta.url).pathname);
const DEVELOPMENT_ONLY_FILES = Object.freeze([
  'favicon.ico',
  'icon.png',
  'LICENSE.md',
  'DATA-LICENSE.md',
  'BRAND.md',
  'PRIVACY.md',
]);

async function removeFinderMetadata(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.name === '.DS_Store') {
      await rm(filePath, { force: true });
    } else if (entry.isDirectory()) {
      await removeFinderMetadata(filePath);
    }
  }));
}

async function setPackageFileModes(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await setPackageFileModes(filePath);
    } else if (entry.isFile()) {
      await chmod(filePath, 0o644);
    }
  }));
}

export async function prepareProductPackageDirectory({
  projectRoot = REPOSITORY_DIRECTORY,
  packageDirectory = path.join(projectRoot, 'dist'),
} = {}) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedPackageDirectory = path.resolve(packageDirectory);
  await mkdir(resolvedPackageDirectory, { recursive: true });
  await Promise.all(DEVELOPMENT_ONLY_FILES.map((fileName) => (
    rm(path.join(resolvedPackageDirectory, fileName), { force: true, recursive: true })
  )));
  await removeFinderMetadata(resolvedPackageDirectory);
  await Promise.all([
    cp(path.join(resolvedProjectRoot, 'Apache-2.0.txt'), path.join(resolvedPackageDirectory, 'Apache-2.0.txt')),
    cp(path.join(resolvedProjectRoot, 'THIRD-PARTY-NOTICES.txt'), path.join(resolvedPackageDirectory, 'THIRD-PARTY-NOTICES.txt')),
  ]);
  const releaseInfo = createPackageReleaseInfo({
    projectRoot: resolvedProjectRoot,
    packageDirectory: resolvedPackageDirectory,
  });
  await writeFile(
    path.join(resolvedPackageDirectory, 'release-info.json'),
    `${JSON.stringify(releaseInfo, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o644 },
  );
  await setPackageFileModes(resolvedPackageDirectory);
  return releaseInfo;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const packageDirectory = path.resolve(process.argv[2] ?? path.join(REPOSITORY_DIRECTORY, 'dist'));
  const releaseInfo = await prepareProductPackageDirectory({
    projectRoot: REPOSITORY_DIRECTORY,
    packageDirectory,
  });
  console.log(`Prepared product package for ${releaseInfo.source.revision}.`);
}
