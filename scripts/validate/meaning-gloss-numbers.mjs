import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseShardFileName } from '../meaning/contract.mjs';

/**
 * Issue #797 shared check: user-facing Meaning glosses must not expose the source dictionary's homonym
 * disambiguation numbers. `data/canonical/` keeps the STDICT reference forms unchanged; only the edited
 * `data/meanings/` gloss projection removes the source identifier.
 *
 * The detector is deliberately narrow: it only flags two ASCII digits written directly after a Korean
 * headword and followed by a reference boundary (quote, bracket, bracket marker, dot, comma or the end of
 * the gloss). Real numbers keep their usual surroundings - `60~90cm`, `9월`, `1.5cm`, `제20대`, `제16회`,
 * `제25품(品)` - so a number followed by a counter, unit or another letter is never matched. Ambiguous
 * candidates are left to editorial judgment instead of a broad string replacement.
 */

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_MEANINGS_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/meanings');

export const COMPLETED_SCOPE_REGISTRY_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'scripts/validate/meaning-gloss-number-scopes.json',
);

export const MEANING_GLOSS_HOMONYM_NUMBER_PATTERN =
  /(?<![0-9])([가-힣]+)([0-9]{2})(?![0-9])(?=[’」)\]\[「\s.,]|$)/gu;

/** Returns every STDICT homonym number reference found in one user-facing gloss. */
export function findMeaningGlossHomonymNumbers(gloss) {
  const found = [];
  if (typeof gloss !== 'string') return found;
  for (const match of gloss.matchAll(MEANING_GLOSS_HOMONYM_NUMBER_PATTERN)) {
    found.push({ headword: match[1], number: match[2], token: match[0], index: match.index });
  }
  return found;
}

/** Reads the completed-scope registry that gates the check (Issue #797 progress). */
export function readCompletedGlossNumberScopes(registryPath = COMPLETED_SCOPE_REGISTRY_PATH) {
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (
    registry?.version !== 1
    || !Array.isArray(registry.completed_scopes)
    || registry.completed_scopes.some((scope) => !/^c\d{2}$/u.test(scope))
    || new Set(registry.completed_scopes).size !== registry.completed_scopes.length
  ) {
    throw new TypeError('Meaning gloss number scope registry has an unsupported shape.');
  }
  return registry;
}

/** Scans every stored Meaning shard and reports the remaining homonym number references. */
export function scanMeaningGlossHomonymNumbers({
  meaningsDirectory = DEFAULT_MEANINGS_DIRECTORY,
} = {}) {
  const occurrences = [];
  const byScope = new Map();
  const shardsByScope = new Map();
  const files = readdirSync(meaningsDirectory)
    .filter((file) => parseShardFileName(file))
    .sort();
  for (const file of files) {
    const { code } = parseShardFileName(file);
    shardsByScope.set(code, (shardsByScope.get(code) ?? 0) + 1);
    for (const line of readFileSync(path.join(meaningsDirectory, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      for (const found of findMeaningGlossHomonymNumbers(row.gloss)) {
        occurrences.push({
          scope: code,
          shard: file,
          meaning_id: row.id,
          lemma: row.lemma,
          ...found,
        });
        byScope.set(code, (byScope.get(code) ?? 0) + 1);
      }
    }
  }
  return { occurrences, byScope, shardsByScope };
}

/**
 * Whole-corpus audit plus enforcement for the scopes whose Issue #797 cleanup is merged: every completed
 * scope must be clean, while the remaining scopes are reported as an informational backlog. A completed
 * scope with no shard fails closed so a mistyped code cannot silently disable the gate.
 */
export function auditMeaningGlossHomonymNumbers({
  meaningsDirectory = DEFAULT_MEANINGS_DIRECTORY,
  completedScopes = readCompletedGlossNumberScopes().completed_scopes,
} = {}) {
  const scan = scanMeaningGlossHomonymNumbers({ meaningsDirectory });
  const completed = new Set(completedScopes);
  const violations = scan.occurrences.filter((occurrence) => completed.has(occurrence.scope));
  const pendingScopes = [...scan.byScope.keys()].filter((scope) => !completed.has(scope)).sort();
  const unknownCompletedScopes = [...completed]
    .filter((scope) => !scan.shardsByScope.has(scope))
    .sort();
  return {
    ...scan,
    completedScopes: [...completed].sort(),
    scopeCount: scan.shardsByScope.size,
    shardCount: [...scan.shardsByScope.values()].reduce((total, count) => total + count, 0),
    violations,
    pendingScopes,
    unknownCompletedScopes,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const audit = auditMeaningGlossHomonymNumbers();
  console.log(JSON.stringify({
    protected_contract: 'User-facing Meaning glosses in a completed #797 scope expose no source homonym number',
    completed_scopes: audit.completedScopes,
    shards: audit.shardCount,
    scopes: audit.scopeCount,
    remaining_occurrences: audit.occurrences.length,
    remaining_by_scope: Object.fromEntries([...audit.byScope].sort()),
    pending_scopes: audit.pendingScopes,
    completed_scope_violations: audit.violations.length,
  }, null, 2));
  if (audit.unknownCompletedScopes.length > 0) {
    console.error(`Completed #797 scope(s) have no stored shard: ${audit.unknownCompletedScopes.join(', ')}`);
    process.exit(1);
  }
  if (audit.violations.length > 0) {
    console.error(`${audit.violations.length} source homonym number(s) remain in completed #797 scope(s):`);
    for (const violation of audit.violations.slice(0, 50)) {
      console.error(`  ${violation.shard} ${violation.meaning_id} (${violation.lemma}): ${violation.token}`);
    }
    process.exit(1);
  }
}
