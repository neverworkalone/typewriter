import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const FORBIDDEN_PACKAGE_PATHS = [
  /^(src|tests|node_modules|\.git)(\/|$)/,
  /(^|\/)(package\.json|package-lock\.json|vite\.config\.js|pack\.sh|pack\.py)$/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)favicon\.ico$/,
  /\.map$/,
];

const LEGAL_FILES = new Set([
  'Apache-2.0.txt',
  'THIRD-PARTY-NOTICES.txt',
]);

const EXPECTED_FILE_MODE = 0o644;

const REQUIRED_PRODUCT_FILES = Object.freeze([
  'dictionary.sqlite',
  'logo.png',
  'runtime/dictionary-worker.mjs',
  'runtime/protocol.js',
  'runtime/query-adapter.js',
  'runtime/search-query.js',
  'runtime/vendor/sqlite3.mjs',
  'runtime/vendor/sqlite3.wasm',
  'Apache-2.0.txt',
  'THIRD-PARTY-NOTICES.txt',
]);

const EXPECTED_METADATA = Object.freeze({
  dictionary_version: 'm2-pilot-1',
  schema_version: '1',
  normalization_version: '1',
  build_contract: 'canonical-jsonl -> normalized-v1 -> sqlite-v1',
  build_tool_version: '1',
  record_count: '432',
  start_count: '390',
  reference_only_count: '42',
  candidate_count: '390',
  search_form_count: '497',
  sense_count: '514',
  relation_count: '442',
  expression_count: '20',
});

const CODE_FILE_PATTERN = /\.(?:css|html|js|json|mjs)$/i;
const FULL_REVISION_PATTERN = /^[0-9a-f]{40}$/i;
const REMOTE_CODE_PATTERNS = [
  /(?:import|export)\s*(?:[^'"\n]+from\s*)?['"]https?:\/\//i,
  /(?:fetch|importScripts|sharedWorker|worker|new\s+URL)\s*\(\s*['"`]https?:\/\//i,
  /<(?:script|iframe|link)\b[^>]+(?:src|href)=["']https?:\/\//i,
  /url\(\s*["']?https?:\/\//i,
];

export function normalizeEntry(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '');
}

function hasUnsafePath(value) {
  const normalized = normalizeEntry(value);
  return normalized.startsWith('/')
    || normalized.split('/').includes('..')
    || normalized.includes('\0');
}

function addManifestPath(paths, value) {
  if (typeof value === 'string' && value && !value.includes('*')) {
    paths.add(normalizeEntry(value));
  }
}

export function collectManifestFiles(manifest) {
  const files = new Set(['manifest.json']);

  Object.values(manifest.icons || {}).forEach((value) => addManifestPath(files, value));
  addManifestPath(files, manifest.options_page);
  addManifestPath(files, manifest.options_ui?.page);
  addManifestPath(files, manifest.action?.default_popup);
  addManifestPath(files, manifest.background?.service_worker);

  for (const contentScript of manifest.content_scripts || []) {
    for (const file of contentScript.js || []) addManifestPath(files, file);
    for (const file of contentScript.css || []) addManifestPath(files, file);
  }

  for (const ruleResource of manifest.declarative_net_request?.rule_resources || []) {
    addManifestPath(files, ruleResource.path);
  }

  for (const resourceGroup of manifest.web_accessible_resources || []) {
    for (const file of resourceGroup.resources || []) addManifestPath(files, file);
  }

  return files;
}

function listFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, absolutePath));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(normalizeEntry(path.relative(root, absolutePath)));
    }
  }
  return files;
}

function missingAndExtra(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    missing: [...expectedSet].filter((file) => !actualSet.has(file)).sort(),
    extra: [...actualSet].filter((file) => !expectedSet.has(file)).sort(),
  };
}

function packageForbiddenFiles(files) {
  return files
    .filter((file) => FORBIDDEN_PACKAGE_PATHS.some((pattern) => pattern.test(file)))
    .sort();
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function validateProductVersion(projectRoot, manifest) {
  const errors = [];
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    errors.push('Project package.json is missing; product/package version cannot be verified.');
    return errors;
  }
  try {
    const packageVersion = readJson(packageJsonPath).version;
    if (packageVersion !== manifest.version) {
      errors.push(
        `Product/package version must match manifest version ${JSON.stringify(manifest.version)}, received ${JSON.stringify(packageVersion)}.`,
      );
    }
  } catch (error) {
    errors.push(`Project package.json is not valid JSON: ${error.message}`);
  }
  return errors;
}

function collectBuildReferences(packageDir, actualFiles) {
  const references = new Set();
  const buildPathPattern = /(?:^|[/'"`])((?:assets|chunks|_locales)\/[A-Za-z0-9._/-]+)/g;
  for (const file of actualFiles) {
    if (!CODE_FILE_PATTERN.test(file)) continue;
    const source = readFileSync(path.join(packageDir, file), 'utf8');
    for (const match of source.matchAll(buildPathPattern)) {
      references.add(normalizeEntry(match[1]));
    }
  }
  return references;
}

function addBuildFiles(files, packageDir, actualFiles) {
  for (const file of collectBuildReferences(packageDir, actualFiles)) {
    files.add(file);
  }
}

function validateManifest(manifest) {
  const errors = [];
  if (manifest.manifest_version !== 3) {
    errors.push(`manifest_version must be 3, received ${JSON.stringify(manifest.manifest_version)}.`);
  }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(manifest.version)) {
    errors.push(`Manifest version is invalid: ${JSON.stringify(manifest.version)}.`);
  }
  if (JSON.stringify(manifest.permissions) !== JSON.stringify(['storage'])) {
    errors.push('Product permissions must be exactly ["storage"].');
  }
  if (Array.isArray(manifest.host_permissions) && manifest.host_permissions.length > 0) {
    errors.push('Host permissions are not allowed in the product package.');
  }
  if (Array.isArray(manifest.optional_permissions) && manifest.optional_permissions.length > 0) {
    errors.push('Optional permissions are not allowed in the product package.');
  }
  if (Array.isArray(manifest.web_accessible_resources) && manifest.web_accessible_resources.length > 0) {
    errors.push('web_accessible_resources must not expose product files.');
  }
  if (manifest.action?.default_popup !== 'popup.html') {
    errors.push('The action popup must be popup.html.');
  }
  if (manifest.options_ui?.page !== 'options.html') {
    errors.push('The options page must be options.html.');
  }
  if (manifest.content_security_policy?.extension_pages
    !== "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'") {
    errors.push('The extension-pages CSP must allow only local code and SQLite WASM evaluation.');
  }
  return errors;
}

function validateRemoteCode(packageDir, files) {
  const errors = [];
  for (const file of files) {
    if (!CODE_FILE_PATTERN.test(file) || LEGAL_FILES.has(file)) continue;
    try {
      const source = readFileSync(path.join(packageDir, file), 'utf8');
      if (REMOTE_CODE_PATTERNS.some((pattern) => pattern.test(source))) {
        errors.push(`Remote code or CDN reference found in executable package file: ${file}`);
      }
    } catch (error) {
      errors.push(`Package file could not be read as UTF-8: ${file} (${error.message})`);
    }
  }
  return errors;
}

function validateFileModes(packageDir, files) {
  const errors = [];
  for (const file of files) {
    const filePath = path.join(packageDir, file);
    try {
      const stats = lstatSync(filePath);
      const mode = stats.mode & 0o777;
      if (!stats.isFile() || stats.isSymbolicLink() || mode !== EXPECTED_FILE_MODE) {
        errors.push(
          `Package file must be a regular 0644 file: ${file} (received ${stats.isSymbolicLink() ? 'symbolic link' : mode.toString(8)}).`,
        );
      }
    } catch (error) {
      errors.push(`Package file mode could not be read: ${file} (${error.message})`);
    }
  }
  return errors;
}

function validateRuntimeAssets(packageDir, files) {
  const errors = [];
  for (const file of REQUIRED_PRODUCT_FILES) {
    if (!files.includes(file)) continue;
    try {
      const contents = readFileSync(path.join(packageDir, file));
      if (contents.length === 0) {
        errors.push(`Packaged runtime asset is empty: ${file}`);
      }
      if (file === 'runtime/vendor/sqlite3.wasm'
        && !contents.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) {
        errors.push('runtime/vendor/sqlite3.wasm is not a WebAssembly binary.');
      }
    } catch (error) {
      errors.push(`Packaged runtime asset could not be read: ${file} (${error.message})`);
    }
  }
  return errors;
}

function readCurrentHead(projectRoot) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function validateDictionaryMetadata({ packageDir, projectRoot }) {
  const errors = [];
  const databasePath = path.join(packageDir, 'dictionary.sqlite');
  if (!existsSync(databasePath)) return errors;

  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const metadata = Object.fromEntries(
      database.prepare('SELECT key, value FROM metadata ORDER BY key').all()
        .map(({ key, value }) => [key, value]),
    );

    for (const [key, expected] of Object.entries(EXPECTED_METADATA)) {
      if (metadata[key] !== expected) {
        errors.push(`Dictionary metadata ${key} must be ${JSON.stringify(expected)}, received ${JSON.stringify(metadata[key])}.`);
      }
    }
    if (!FULL_REVISION_PATTERN.test(metadata.source_revision || '')) {
      errors.push(`Dictionary source_revision is not a full Git SHA: ${JSON.stringify(metadata.source_revision)}.`);
    }
    if (metadata.source_revision_source !== 'git-head' || metadata.source_revision_verified !== 'true') {
      errors.push('Dictionary source revision must be verified from the current Git HEAD.');
    }
    if (!['clean', 'dirty-allowed'].includes(metadata.worktree_state)) {
      errors.push(`Dictionary worktree_state is invalid: ${JSON.stringify(metadata.worktree_state)}.`);
    }
    if (!/^v?\d+\.\d+\.\d+/.test(metadata.node_version || '')) {
      errors.push(`Dictionary node_version is invalid: ${JSON.stringify(metadata.node_version)}.`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(metadata.sqlite_version || '')) {
      errors.push(`Dictionary sqlite_version is invalid: ${JSON.stringify(metadata.sqlite_version)}.`);
    }

    const currentHead = readCurrentHead(projectRoot);
    if (currentHead && metadata.source_revision !== currentHead) {
      errors.push(`Dictionary source_revision ${metadata.source_revision} does not match current Git HEAD ${currentHead}.`);
    }

    const userVersion = database.prepare('PRAGMA user_version').get()?.user_version;
    if (userVersion !== 1) {
      errors.push(`Dictionary SQLite user_version must be 1, received ${JSON.stringify(userVersion)}.`);
    }
    const integrity = database.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (integrity !== 'ok') {
      errors.push(`Dictionary SQLite integrity_check failed: ${JSON.stringify(integrity)}.`);
    }
  } catch (error) {
    errors.push(`Packaged dictionary could not be read: ${error.message}`);
  } finally {
    database?.close();
  }

  return errors;
}

function validateLegalFiles(packageDir, files) {
  const errors = [];
  if (!files.includes('Apache-2.0.txt') || !files.includes('THIRD-PARTY-NOTICES.txt')) {
    return errors;
  }
  const license = readFileSync(path.join(packageDir, 'Apache-2.0.txt'), 'utf8');
  const notice = readFileSync(path.join(packageDir, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  if (!license.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION')) {
    errors.push('Apache-2.0.txt does not contain the full Apache license text.');
  }
  if (!notice.includes('@sqlite.org/sqlite-wasm 3.53.0-build1') || !notice.includes('Apache-2.0.txt')) {
    errors.push('THIRD-PARTY-NOTICES.txt does not describe the packaged SQLite WASM dependency.');
  }
  return errors;
}

export function validatePackageDirectory({ packageDir, projectRoot = path.resolve(packageDir, '..') }) {
  const errors = [];
  const actualFiles = existsSync(packageDir) ? listFiles(packageDir) : [];
  const manifestPath = path.join(packageDir, 'manifest.json');

  if (!existsSync(manifestPath)) {
    return {
      errors: [`Missing ${path.relative(packageDir, manifestPath)}.`],
      actualFiles,
      expectedFiles: [],
    };
  }

  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    return {
      errors: [`Manifest is not valid JSON: ${error.message}`],
      actualFiles,
      expectedFiles: [],
    };
  }

  errors.push(...validateManifest(manifest));
  errors.push(...validateProductVersion(projectRoot, manifest));
  errors.push(...validateRemoteCode(packageDir, actualFiles));
  errors.push(...validateFileModes(packageDir, actualFiles));
  errors.push(...validateRuntimeAssets(packageDir, actualFiles));
  errors.push(...validateDictionaryMetadata({ packageDir, projectRoot }));
  errors.push(...validateLegalFiles(packageDir, actualFiles));

  const expectedFiles = new Set(REQUIRED_PRODUCT_FILES);
  expectedFiles.add('manifest.json');
  expectedFiles.add('popup.html');
  expectedFiles.add('options.html');
  for (const file of collectManifestFiles(manifest)) expectedFiles.add(file);
  addBuildFiles(expectedFiles, packageDir, actualFiles);

  const differences = missingAndExtra(expectedFiles, actualFiles);
  if (differences.missing.length > 0) {
    errors.push(`Manifest/build files missing from package: ${differences.missing.join(', ')}`);
  }
  if (differences.extra.length > 0) {
    errors.push(`Unexpected files found in package: ${differences.extra.join(', ')}`);
  }

  const unsafe = actualFiles.filter(hasUnsafePath);
  if (unsafe.length > 0) {
    errors.push(`Unsafe package paths found: ${unsafe.join(', ')}`);
  }
  const forbidden = packageForbiddenFiles(actualFiles);
  if (forbidden.length > 0) {
    errors.push(`Development or unnecessary files found in package: ${forbidden.join(', ')}`);
  }

  return {
    errors,
    actualFiles,
    expectedFiles: [...expectedFiles].sort(),
    manifest,
  };
}

function listZipFiles(zipPath) {
  execFileSync('unzip', ['-t', zipPath], { stdio: 'ignore' });
  return execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map(normalizeEntry)
    .filter((file) => file && !file.endsWith('/'));
}

export function validatePackageZip({ packageDir, zipPath, packageFiles, manifestVersion }) {
  const errors = [];
  let zipFiles;
  try {
    zipFiles = listZipFiles(zipPath);
  } catch (error) {
    return { errors: [`ZIP could not be read or tested: ${error.message}`], zipFiles: [] };
  }

  const differences = missingAndExtra(packageFiles, zipFiles);
  if (differences.missing.length > 0) {
    errors.push(`ZIP is missing files from the unpacked build: ${differences.missing.join(', ')}`);
  }
  if (differences.extra.length > 0) {
    errors.push(`ZIP has files not present in the unpacked build: ${differences.extra.join(', ')}`);
  }
  const unsafe = zipFiles.filter(hasUnsafePath);
  if (unsafe.length > 0) {
    errors.push(`Unsafe ZIP paths found: ${unsafe.join(', ')}`);
  }
  const duplicateFiles = zipFiles.filter((file, index) => zipFiles.indexOf(file) !== index);
  if (duplicateFiles.length > 0) {
    errors.push(`Duplicate files found in ZIP: ${[...new Set(duplicateFiles)].sort().join(', ')}`);
  }
  const forbidden = packageForbiddenFiles(zipFiles);
  if (forbidden.length > 0) {
    errors.push(`Development or unnecessary files found in ZIP: ${forbidden.join(', ')}`);
  }

  const expectedName = `${path.basename(path.dirname(path.resolve(packageDir)))}_${manifestVersion}.zip`;
  if (path.basename(zipPath) !== expectedName) {
    errors.push(`ZIP name mismatch: expected ${expectedName}, received ${path.basename(zipPath)}.`);
  }

  return { errors, zipFiles };
}

export function validatePackage({ projectRoot, packageDir, zipPath = null }) {
  const directoryResult = validatePackageDirectory({ packageDir, projectRoot });
  const errors = [...directoryResult.errors];
  let zipResult = { errors: [], zipFiles: [] };

  if (zipPath && directoryResult.errors.length === 0) {
    zipResult = validatePackageZip({
      packageDir,
      zipPath,
      packageFiles: directoryResult.actualFiles,
      manifestVersion: directoryResult.manifest.version,
    });
    errors.push(...zipResult.errors);
  }

  return { ...directoryResult, ...zipResult, errors };
}

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

export function main(args = process.argv.slice(2)) {
  const projectRoot = path.resolve(optionValue(args, '--project-root', process.cwd()));
  const packageDir = path.resolve(optionValue(args, '--dir', path.join(projectRoot, 'dist')));
  const zipOption = optionValue(args, '--zip', '');
  const result = validatePackage({
    projectRoot,
    packageDir,
    zipPath: zipOption ? path.resolve(zipOption) : null,
  });

  if (result.errors.length > 0) {
    console.error(result.errors.map((error) => `- ${error}`).join('\n'));
    process.exitCode = 1;
    return result;
  }

  const zipSummary = zipOption ? ` and ZIP (${result.zipFiles.length} files)` : '';
  console.log(`Package validation passed: ${result.actualFiles.length} unpacked files${zipSummary}.`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
