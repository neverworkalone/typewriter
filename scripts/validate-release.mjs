import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { withStagedReleaseCandidate } from './build/stage-release-candidate.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const DIST_DIRECTORY = path.join(PROJECT_ROOT, 'dist');

function parseOptions(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const equalsIndex = argument.indexOf('=');
    if (equalsIndex > 2) {
      options.set(argument.slice(2, equalsIndex), argument.slice(equalsIndex + 1));
    } else {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`--${argument.slice(2)} requires a value.`);
      options.set(argument.slice(2), value);
      index += 1;
    }
  }
  for (const key of options.keys()) {
    if (!['chrome', 'output-dir'].includes(key)) throw new Error(`Unsupported option: --${key}`);
  }
  return options;
}

function requireCleanWorktree() {
  const changes = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  }).trim();
  if (changes) {
    throw new Error('Release validation requires a clean checkout. Commit or remove tracked and untracked changes first.');
  }
}

function sourceRevision() {
  return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  }).trim();
}

function runPnpm(args, environment) {
  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(executable, args, {
    cwd: PROJECT_ROOT,
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} failed with exit status ${result.status ?? 'unknown'}.`);
  }
}

function cleanBuildEnvironment(zipDirectory = undefined) {
  const environment = { ...process.env };
  for (const key of [
    'TYPEWRITER_ALLOW_DIRTY',
    'TYPEWRITER_BUILD_OUTPUT_DIRECTORY',
    'TYPEWRITER_SHARED_DICTIONARY_PATH',
    'TYPEWRITER_CANONICAL_DIRECTORY',
    'TYPEWRITER_BUILD_MINIFY',
    'TYPEWRITER_ZIP_DIR',
  ]) {
    delete environment[key];
  }
  if (zipDirectory) environment.TYPEWRITER_ZIP_DIR = zipDirectory;
  return environment;
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function relativeToProject(candidate) {
  const relative = path.relative(realpathSync(PROJECT_ROOT), realpathSync(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathIsInsideProject(candidate) {
  const relative = path.relative(realpathSync(PROJECT_ROOT), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const chromePath = path.resolve(options.get('chrome') ?? '');
  const outputDirectory = path.resolve(options.get('output-dir') ?? '');
  if (!options.has('chrome')) throw new Error('Pass --chrome=/path/to/Chrome-for-Testing.');
  if (!options.has('output-dir')) throw new Error('Pass --output-dir=/path/outside/the/repository.');
  if (!existsSync(chromePath) || !statSync(chromePath).isFile()) {
    throw new Error(`Chrome for Testing executable does not exist: ${chromePath}`);
  }
  accessSync(chromePath, constants.X_OK);

  requireCleanWorktree();
  const revision = sourceRevision();
  if (pathIsInsideProject(outputDirectory)) {
    throw new Error('The package output directory must be outside the repository.');
  }
  mkdirSync(outputDirectory, { recursive: true });
  const resolvedOutputDirectory = realpathSync(outputDirectory);
  if (relativeToProject(resolvedOutputDirectory)) {
    throw new Error('The package output directory must be outside the repository.');
  }

  const manifest = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'public/manifest.json'), 'utf8'));
  const packageMetadata = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const packageName = `${path.basename(PROJECT_ROOT)}_${manifest.version}.zip`;
  let validatedReleaseInfo;
  let validatedPackageHash;
  const packagePath = withStagedReleaseCandidate({
    outputDirectory: resolvedOutputDirectory,
    packageName,
    validateCandidate: ({
      candidateDirectory,
      candidatePackagePath,
      repeatedDirectory,
      repeatedPackagePath,
    }) => {
      console.log(`Release source: ${revision}`);
      console.log('Running the normal CI gate on the clean checkout.');
      runPnpm(['run', 'ci:normal'], cleanBuildEnvironment());
      requireCleanWorktree();

      console.log('Building and validating the production package twice.');
      runPnpm(['run', 'package'], cleanBuildEnvironment(candidateDirectory));
      runPnpm(['run', 'package'], cleanBuildEnvironment(repeatedDirectory));
      if (sha256File(candidatePackagePath) !== sha256File(repeatedPackagePath)) {
        throw new Error('Two production package builds from the same clean checkout produced different ZIP bytes.');
      }

      const releaseInfo = JSON.parse(readFileSync(path.join(DIST_DIRECTORY, 'release-info.json'), 'utf8'));
      if (releaseInfo.source.revision !== revision
        || releaseInfo.source.revision_verified !== true
        || releaseInfo.source.worktree_state !== 'clean'
        || releaseInfo.dictionary.canonical_source_revision !== revision) {
        throw new Error('The package release identity is not bound to this clean, verified source revision.');
      }

      console.log('Checking the exact ZIP and unpacked package in Chrome for Testing.');
      runPnpm([
        'run',
        'test:mv3:package',
        '--',
        `--chrome=${chromePath}`,
        `--extension=${DIST_DIRECTORY}`,
        `--zip=${candidatePackagePath}`,
      ], cleanBuildEnvironment());
      requireCleanWorktree();
      validatedReleaseInfo = releaseInfo;
      validatedPackageHash = sha256File(candidatePackagePath);
    },
  });

  console.log(`Release package: ${packagePath}`);
  console.log(`SHA-256: ${validatedPackageHash}`);
  console.log(`Application version: ${packageMetadata.version}`);
  console.log(`Extension version: ${manifest.version}`);
  console.log(`Dictionary version: ${validatedReleaseInfo.dictionary.version}`);
  console.log(`SQLite schema version: ${validatedReleaseInfo.dictionary.schema_version}`);
  console.log(`Canonical/source revision: ${revision}`);
  console.log('This command validates an RC package; it does not clear the corpus redistribution hold in DATA-LICENSE.md.');
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
