import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';

export const TYPEWRITER_CACHE_ROOT_ENV = 'TYPEWRITER_CACHE_ROOT';

export const TYPEWRITER_CACHE_AREAS = Object.freeze(['root', 'corpus', 'literature', 'indexes', 'evidence', 'runs']);

export function resolveTypewriterCachePaths({ env = process.env, homeDirectory = os.homedir() } = {}) {
  const configuredRoot = env[TYPEWRITER_CACHE_ROOT_ENV];
  const expandedRoot = configuredRoot === '~'
    ? homeDirectory
    : configuredRoot?.startsWith(`~${path.sep}`)
      ? path.join(homeDirectory, configuredRoot.slice(2))
      : configuredRoot;
  if (configuredRoot?.startsWith('~') && configuredRoot !== '~' && !configuredRoot.startsWith(`~${path.sep}`)) {
    throw new TypeError(`${TYPEWRITER_CACHE_ROOT_ENV} only supports ~ or ~/... home expansion`);
  }
  if (expandedRoot && !path.isAbsolute(expandedRoot)) {
    throw new TypeError(`${TYPEWRITER_CACHE_ROOT_ENV} must be an absolute path so all worktrees share it`);
  }
  const root = realpathWithMissingSuffix(path.resolve(expandedRoot || path.join(homeDirectory, '.cache', 'typewriter')));
  return Object.freeze({
    root,
    corpus: path.join(root, 'corpus'),
    literature: path.join(root, 'literature'),
    indexes: path.join(root, 'indexes'),
    evidence: path.join(root, 'evidence'),
    runs: path.join(root, 'runs'),
  });
}

export function isWithinDirectory(directory, candidate, { allowRoot = true } = {}) {
  const absoluteDirectory = path.resolve(directory);
  const absoluteCandidate = path.resolve(candidate);
  const relative = path.relative(absoluteDirectory, absoluteCandidate);
  if (relative === '') return allowRoot;
  return !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`);
}

function realpathWithMissingSuffix(candidate) {
  let current = path.resolve(candidate);
  const missing = [];
  while (true) {
    try {
      return path.join(realpathSync(current), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function assertWithinDirectory(directory, candidate, { allowRoot = false, label = 'Local artifact' } = {}) {
  const absolute = path.resolve(candidate);
  const absoluteDirectory = path.resolve(directory);
  if (!isWithinDirectory(absoluteDirectory, absolute, { allowRoot })) {
    throw new Error(`${label} must be ${allowRoot ? 'inside' : 'below'} ${path.resolve(directory)}: ${absolute}`);
  }
  const realDirectory = realpathWithMissingSuffix(absoluteDirectory);
  const realCandidate = realpathWithMissingSuffix(absolute);
  if (!isWithinDirectory(realDirectory, realCandidate, { allowRoot })) {
    throw new Error(`${label} resolves outside ${absoluteDirectory} through a symlink: ${absolute}`);
  }
  return absolute;
}

export function cacheAreaPath(area, ...parts) {
  const paths = resolveTypewriterCachePaths();
  if (!TYPEWRITER_CACHE_AREAS.includes(area)) throw new TypeError(`unknown Typewriter cache area: ${area}`);
  const candidate = path.resolve(paths[area], ...parts);
  return assertWithinDirectory(paths[area], candidate, { allowRoot: parts.length === 0, label: 'Cache path' });
}

const LEGACY_AREA_MAP = Object.freeze({
  corpus: ['corpus'],
  'public-domain': ['literature'],
  indexes: ['indexes'],
  'literature-evidence': ['evidence'],
  production: ['runs'],
  timing: ['runs', 'timing'],
});

export function mapLegacyReferencePath(relativePath) {
  const normalized = String(relativePath).replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '');
  const prefix = 'data/reference/';
  if (!normalized.startsWith(prefix)) throw new TypeError('legacy reference path must start with data/reference/');
  const remainder = normalized.slice(prefix.length);
  const [legacyArea, ...rest] = remainder.split('/').filter(Boolean);
  if (!legacyArea || legacyArea === '.' || legacyArea === '..' || rest.some((part) => part === '.' || part === '..')) {
    throw new TypeError('legacy reference path must not contain traversal segments');
  }
  let mapped;
  if (legacyArea === 'benchmark-274') mapped = ['runs', legacyArea, ...rest];
  else if (legacyArea === 'literature-evidence' && rest.length >= 2) {
    const [batchId, ...artifactPath] = rest;
    const match = artifactPath.length === 1
      ? /^([A-Z]\d{6}-\d{4})(\.pack\.json|\.summary\.json|\.md)$/u.exec(artifactPath[0])
      : null;
    if (match) {
      const file = match[2] === '.pack.json' ? 'pack.json'
        : match[2] === '.summary.json' ? 'summary.json' : 'evidence.md';
      mapped = ['evidence', batchId, match[1], file];
    } else mapped = ['evidence', batchId, 'legacy', ...artifactPath];
  }
  else if (legacyArea === 'pilots') {
    if (rest.length === 0) mapped = ['runs', 'legacy', 'pilots'];
    else mapped = ['runs', `${rest[0]}-pilot`, ...rest.slice(1)];
  }
  else if (Object.hasOwn(LEGACY_AREA_MAP, legacyArea)) mapped = [...LEGACY_AREA_MAP[legacyArea], ...rest];
  else mapped = ['runs', 'legacy', legacyArea, ...rest];
  return path.join(...mapped);
}

export function resolveLegacyReferencePath(relativePath, { paths = resolveTypewriterCachePaths() } = {}) {
  return path.join(paths.root, mapLegacyReferencePath(relativePath));
}

export function resolveCacheArtifactPath(value, {
  paths = resolveTypewriterCachePaths(),
  areas = ['corpus', 'literature', 'indexes', 'evidence', 'runs'],
  label = 'Local artifact',
} = {}) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} path must be a non-empty string`);
  const normalized = value.replaceAll('\\', '/');
  const candidate = path.isAbsolute(value)
    ? path.resolve(value)
    : normalized.startsWith('data/reference/')
      ? resolveLegacyReferencePath(value, { paths })
      : path.resolve(paths.root, value);
  const allowed = areas
    .filter((area) => TYPEWRITER_CACHE_AREAS.includes(area) && area !== 'root')
    .map((area) => paths[area]);
  const matchedArea = allowed.find((directory) => isWithinDirectory(directory, candidate));
  if (!matchedArea) {
    throw new Error(`${label} must be inside ${allowed.join(' or ')}: ${candidate}`);
  }
  const cacheRoot = realpathWithMissingSuffix(paths.root);
  const area = realpathWithMissingSuffix(matchedArea);
  if (!isWithinDirectory(cacheRoot, area)) {
    throw new Error(`${label} cache area resolves outside ${paths.root} through a symlink: ${matchedArea}`);
  }
  return assertWithinDirectory(matchedArea, candidate, { allowRoot: false, label });
}
