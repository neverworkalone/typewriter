import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseShardFileName, readAdjudications, readMeanings } from '../meaning/contract.mjs';
import { projectMeaningRelations } from '../meaning/project.mjs';
import { MEANING_GLOSS_HOMONYM_NUMBER_PATTERN, readCompletedGlossNumberScopes } from './meaning-gloss-numbers.mjs';

/**
 * Issue #797 shared check: a `→` reference in a user-facing Meaning gloss must be linked to the correct target
 * Meaning through an existing synonym (`direct`) relation, in committed data, so the product shows a working synonym
 * target instead of a source dictionary identifier.
 *
 * The reference is the STDICT lookup clue (`→ 까치발02.`, `→ 꽃봉오리「1」.`); the number and the arrow are editorial
 * detail. The check verifies the mechanical part of the contract on the whole corpus: a completed 초성 scope must have
 * a `direct` relation from the referencing Meaning to a Meaning whose lemma is the referenced headword. Links may be
 * authored (`data/meanings/` `relations`, projected with `origin = typewriter-authored`) or projected from an
 * untouched canonical source relation; which of several homonyms a reference resolves to is source-bound editorial
 * judgment and is recorded in the Issue #797 audit, not guessed here. References that could not be resolved are
 * registered with a reason in the scope registry instead of being linked to an invented target.
 *
 * The same check audits the second half of the number-removal contract (Issue #797 review, 2026-10-17): removing the
 * number must not collapse independently bound Meanings into one identical display. It groups stored Meanings by
 * lemma and exact gloss and flags a group whose members bind to different canonical source glosses, whose display is
 * exactly the source gloss with the homonym numbers removed, and whose reference resolution differs. The `깨이다`
 * type - several Meanings that already resolve to a single target Meaning - is the #764/#772 normalization case and is
 * reported as tolerated instead of failing; the `뀌다` type, where the collapsed display hid two different source
 * meanings, is a violation until the glosses carry the distinction.
 */

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_MEANINGS_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/meanings');
const DEFAULT_CANONICAL_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/canonical');
const DEFAULT_ADJUDICATION_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/adjudication');

export const COMPLETED_SCOPE_REGISTRY_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'scripts/validate/meaning-gloss-number-scopes.json',
);

// `→ 까치발02.`, `→ 까치발「2」.`, `→ 꽃봉오리01「1」.`, `→ 할머니_.`: the headword is the Hangul run; a homonym number,
// a source sense marker and a trailing underscore are the source's disambiguation detail, not part of the lemma.
export const MEANING_GLOSS_REFERENCE_PATTERN = /→\s*([가-힣]+)(?:[0-9]{2})?\s*(?:「[0-9]+」)?/gu;

/** Returns every `→` reference headword found in one user-facing gloss. */
export function findMeaningGlossReferences(gloss) {
  const found = [];
  if (typeof gloss !== 'string') return found;
  for (const match of gloss.matchAll(MEANING_GLOSS_REFERENCE_PATTERN)) {
    found.push({ headword: match[1], token: match[0].trim(), index: match.index });
  }
  return found;
}

/** Validated manual exceptions for references that genuinely cannot be resolved (Issue #797 §예외). */
export function readArrowLinkExceptions(registryPath = COMPLETED_SCOPE_REGISTRY_PATH) {
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const exceptions = registry?.link_exceptions ?? [];
  if (!Array.isArray(exceptions)) throw new TypeError('Meaning arrow link exceptions must be an array.');
  for (const exception of exceptions) {
    if (
      !exception || typeof exception !== 'object'
      || !/^c\d{2}$/u.test(exception.scope ?? '')
      || !/^m\d+(?:_\d+)?$/u.test(exception.meaning_id ?? '')
      || typeof exception.reference !== 'string' || exception.reference.trim() === ''
      || typeof exception.reason !== 'string' || exception.reason.trim() === ''
    ) {
      throw new TypeError(`Meaning arrow link exception has an unsupported shape: ${JSON.stringify(exception)}`);
    }
  }
  return exceptions;
}

function readCanonicalRecords(canonicalDirectory) {
  const records = [];
  for (const file of readdirSync(canonicalDirectory).filter((name) => name.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(path.join(canonicalDirectory, file), 'utf8').split('\n')) {
      if (line) records.push(JSON.parse(line));
    }
  }
  return records;
}

/** Canonical source gloss of every stored sense, so a collapsed display can be traced back to its source rows. */
function canonicalGlossesBySense(records) {
  const glosses = new Map();
  for (const record of records) {
    for (const sense of record.senses ?? []) {
      if (typeof sense.id === 'string') glosses.set(sense.id, sense.gloss ?? '');
    }
  }
  return glosses;
}

/** The gloss a Meaning would display if Issue #797 did nothing but remove the source homonym numbers. */
export function stripMeaningGlossHomonymNumbers(gloss) {
  if (typeof gloss !== 'string') return gloss;
  return gloss.replace(MEANING_GLOSS_HOMONYM_NUMBER_PATTERN, '$1');
}

/** Scope code of every stored Meaning shard, plus the shard name of every meaning id. */
function shardsByScope(meaningsDirectory) {
  const scopes = new Map();
  const shardByMeaning = new Map();
  for (const file of readdirSync(meaningsDirectory).filter((name) => parseShardFileName(name)).sort()) {
    const { code } = parseShardFileName(file);
    scopes.set(code, (scopes.get(code) ?? 0) + 1);
    for (const line of readFileSync(path.join(meaningsDirectory, file), 'utf8').split('\n')) {
      if (line.trim()) shardByMeaning.set(JSON.parse(line).id, file);
    }
  }
  return { scopes, shardByMeaning };
}

/**
 * Whole-corpus audit of `→` references against the final meaning relation graph (authored + projected). Every
 * completed 초성 scope must be fully linked; the remaining scopes are reported as an informational backlog. A
 * completed scope with no stored shard fails closed so a mistyped code cannot silently disable the gate.
 */
export function auditMeaningArrowLinks({
  meaningsDirectory = DEFAULT_MEANINGS_DIRECTORY,
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  adjudicationDirectory = DEFAULT_ADJUDICATION_DIRECTORY,
  completedScopes = readCompletedGlossNumberScopes().completed_scopes,
  exceptions = readArrowLinkExceptions(),
  records = null,
} = {}) {
  const loaded = readMeanings(meaningsDirectory);
  const adjudications = readAdjudications(adjudicationDirectory);
  const canonical = records ?? readCanonicalRecords(canonicalDirectory);
  const { relations } = projectMeaningRelations({
    records: canonical,
    meanings: loaded.rows,
    adjudications: adjudications.rows,
  });
  const { scopes, shardByMeaning } = shardsByScope(meaningsDirectory);
  const lemmaById = new Map(loaded.rows.map((row) => [row.id, row.lemma]));
  const directTargets = new Map();
  for (const relation of relations) {
    if (relation.type !== 'direct') continue;
    const list = directTargets.get(relation.source_meaning_id) ?? [];
    list.push(relation.target_meaning_id);
    directTargets.set(relation.source_meaning_id, list);
  }
  const exceptionKeys = new Set(exceptions.map((exception) => `${exception.meaning_id}\u0000${exception.reference}`));

  const occurrences = [];
  for (const row of loaded.rows) {
    for (const reference of findMeaningGlossReferences(row.gloss)) {
      const targets = directTargets.get(row.id) ?? [];
      // The linked target must carry the referenced headword, so a `→` cannot be satisfied by an unrelated synonym.
      const linkedTargets = targets.filter((target) => lemmaById.get(target) === reference.headword);
      occurrences.push({
        scope: parseShardFileName(shardByMeaning.get(row.id) ?? '')?.code ?? null,
        shard: shardByMeaning.get(row.id) ?? null,
        meaning_id: row.id,
        lemma: row.lemma,
        reference: reference.headword,
        token: reference.token,
        linked: linkedTargets.length > 0,
        targets: linkedTargets,
      });
    }
  }

  const completed = new Set(completedScopes);
  const violations = occurrences.filter((occurrence) => (
    completed.has(occurrence.scope)
    && !occurrence.linked
    && !exceptionKeys.has(`${occurrence.meaning_id}\u0000${occurrence.reference}`)
  ));

  // Issue #797 display-collapse audit: the number removal must not make independently bound Meanings display the
  // same reference. Only a display that is literally the source gloss minus its homonym numbers is this contract;
  // an editorial gloss rewrite is a separate decision and is not re-judged here.
  const canonicalGlossBySense = canonicalGlossesBySense(canonical);
  const glossGroups = new Map();
  for (const row of loaded.rows) {
    const key = `${row.lemma}\u0000${row.gloss}`;
    const group = glossGroups.get(key) ?? [];
    group.push(row);
    glossGroups.set(key, group);
  }
  const collapses = [];
  for (const group of glossGroups.values()) {
    if (group.length < 2) continue;
    const sourceGlosses = (row) => row.sense_ids.map((id) => canonicalGlossBySense.get(id) ?? null);
    // The source did not distinguish these Meanings, so an identical display loses no distinction.
    if (new Set(group.map((row) => JSON.stringify(sourceGlosses(row)))).size < 2) continue;
    const collapsed = group.every((row) => sourceGlosses(row).some((gloss) => (
      typeof gloss === 'string' && stripMeaningGlossHomonymNumbers(gloss) === row.gloss
    )));
    if (!collapsed) continue;
    const targets = [...new Set(group.flatMap((row) => directTargets.get(row.id) ?? []))].sort();
    const targetSetByRow = group.map((row) => [...(directTargets.get(row.id) ?? [])].sort().join('\u0000'));
    collapses.push({
      scope: parseShardFileName(shardByMeaning.get(group[0].id) ?? '')?.code ?? null,
      shard: shardByMeaning.get(group[0].id) ?? null,
      lemma: group[0].lemma,
      gloss: group[0].gloss,
      meaning_ids: group.map((row) => row.id),
      source_glosses: group.map((row) => sourceGlosses(row)),
      targets,
      // Every member already resolves to one shared target Meaning: the #764/#772 normalization case, where the
      // referenced source senses were consolidated into that one Meaning. It is a duplicate display, not a lost
      // distinction, so it is recorded as tolerated instead of failing the completed scope.
      tolerated: targets.length > 0 && new Set(targetSetByRow).size === 1,
    });
  }
  const collapseViolations = collapses.filter((collapse) => completed.has(collapse.scope) && !collapse.tolerated);

  const byScope = new Map();
  for (const occurrence of occurrences) {
    const counts = byScope.get(occurrence.scope) ?? { references: 0, unlinked: 0 };
    counts.references += 1;
    if (!occurrence.linked) counts.unlinked += 1;
    byScope.set(occurrence.scope, counts);
  }
  const pendingScopes = [...byScope.keys()].filter((scope) => !completed.has(scope)).sort();
  const unknownCompletedScopes = [...completed].filter((scope) => !scopes.has(scope)).sort();
  return {
    scopeCount: scopes.size,
    shardCount: [...scopes.values()].reduce((total, count) => total + count, 0),
    completedScopes: [...completed].sort(),
    occurrences,
    byScope,
    violations,
    collapses,
    collapseViolations,
    pendingScopes,
    unknownCompletedScopes,
    exceptionCount: exceptions.length,
    errors: [...loaded.errors, ...adjudications.errors],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const audit = auditMeaningArrowLinks();
  console.log(JSON.stringify({
    protected_contract: 'User-facing Meaning glosses in a completed #797 scope link every `→` reference to a target Meaning with the referenced lemma through a synonym relation and never collapse distinct source meanings into one display',
    completed_scopes: audit.completedScopes,
    shards: audit.shardCount,
    scopes: audit.scopeCount,
    references: audit.occurrences.length,
    unlinked_references: audit.occurrences.filter((occurrence) => !occurrence.linked).length,
    references_by_scope: Object.fromEntries([...audit.byScope].sort()),
    display_collapses: audit.collapses.length,
    display_collapses_tolerated: audit.collapses.filter((collapse) => collapse.tolerated).length,
    pending_scopes: audit.pendingScopes,
    exceptions: audit.exceptionCount,
    completed_scope_violations: audit.violations.length,
    completed_scope_collapse_violations: audit.collapseViolations.length,
  }, null, 2));
  if (audit.errors.length > 0) {
    console.error(`Meaning layer is invalid:\n${audit.errors.slice(0, 20).join('\n')}`);
    process.exit(1);
  }
  if (audit.unknownCompletedScopes.length > 0) {
    console.error(`Completed #797 scope(s) have no stored shard: ${audit.unknownCompletedScopes.join(', ')}`);
    process.exit(1);
  }
  if (audit.violations.length > 0) {
    console.error(`${audit.violations.length} unlinked \`→\` reference(s) remain in completed #797 scope(s):`);
    for (const violation of audit.violations.slice(0, 50)) {
      console.error(`  ${violation.shard} ${violation.meaning_id} (${violation.lemma}): ${violation.token}`);
    }
    process.exit(1);
  }
  if (audit.collapseViolations.length > 0) {
    console.error(`${audit.collapseViolations.length} number-removal display collapse(s) lose a source distinction in completed #797 scope(s):`);
    for (const violation of audit.collapseViolations.slice(0, 50)) {
      console.error(`  ${violation.shard} ${violation.meaning_ids.join(', ')} (${violation.lemma}) display "${violation.gloss}"`);
    }
    process.exit(1);
  }
}
