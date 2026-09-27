import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function withStagedReleaseCandidate({
  outputDirectory,
  packageName,
  validateCandidate,
}) {
  if (!path.isAbsolute(outputDirectory)) {
    throw new Error('The release output directory must be absolute.');
  }
  if (!packageName || path.basename(packageName) !== packageName) {
    throw new Error('The release package name must be a filename.');
  }
  if (typeof validateCandidate !== 'function') {
    throw new Error('A release candidate validator is required.');
  }

  mkdirSync(outputDirectory, { recursive: true });
  const finalPackagePath = path.join(outputDirectory, packageName);
  if (existsSync(finalPackagePath)) {
    throw new Error(`Refusing to overwrite an existing release package: ${finalPackagePath}`);
  }

  const stagingDirectory = mkdtempSync(path.join(outputDirectory, '.typewriter-release-'));
  const candidateDirectory = path.join(stagingDirectory, 'candidate');
  const repeatedDirectory = path.join(stagingDirectory, 'repeat');
  mkdirSync(candidateDirectory);
  mkdirSync(repeatedDirectory);
  const candidatePackagePath = path.join(candidateDirectory, packageName);
  const repeatedPackagePath = path.join(repeatedDirectory, packageName);

  let publicationTempPath;
  try {
    validateCandidate({
      candidateDirectory,
      candidatePackagePath,
      repeatedDirectory,
      repeatedPackagePath,
    });

    if (!existsSync(candidatePackagePath) || !existsSync(repeatedPackagePath)) {
      throw new Error('Both staged release builds must exist before candidate publication.');
    }
    if (existsSync(finalPackagePath)) {
      throw new Error(`Refusing to overwrite an existing release package: ${finalPackagePath}`);
    }

    publicationTempPath = path.join(
      outputDirectory,
      `.${packageName}.${randomUUID()}.tmp`,
    );
    renameSync(candidatePackagePath, publicationTempPath);
    rmSync(stagingDirectory, { recursive: true, force: true });
    if (existsSync(finalPackagePath)) {
      throw new Error(`Refusing to overwrite an existing release package: ${finalPackagePath}`);
    }
    renameSync(publicationTempPath, finalPackagePath);
    return finalPackagePath;
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    if (publicationTempPath) rmSync(publicationTempPath, { force: true });
    throw error;
  }
}
