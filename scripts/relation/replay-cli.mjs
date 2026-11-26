/**
 * Relation delta replay (#8784 PR-2): re-apply one PR's approved Relation/Drop delta onto newer approved data.
 *
 *   node scripts/relation/replay-cli.mjs --base <rev> --ours <rev> --theirs <rev> [--path <data file>]... [--relations-only] [--dry-run]
 *
 * `base` is the data the PR started from (normally the merge base), `ours` the PR result and `theirs` the latest
 * approved data (for example the latest master). Each shard Relation/Drop file the PR changed (or each named `--path`)
 * is rebuilt by the relation-key 3-way merge of `relation-delta.mjs` and written to the working tree. Files only the
 * latest data changed are left to Git. Before anything is written, the shared row validator runs for every rebuilt
 * shard and its Candidate accounting must show no problem the latest data did not already have. The PR's own judgments
 * are replayed key by key; nothing is re-judged, and an unchanged result is a no-op.
 *
 * `--relations-only` replays a Relation-only Stage PR (Stage 4 onward, #9929): only Relation files are rebuilt and they
 * pass the shared row validator; no Candidate or Drop file is read and no Candidate accounting runs. A Drop file the PR
 * changed (base -> ours) or named with `--path` is a scope error before anything is written. Drop changes only the
 * latest data made are left to Git, like any file the PR did not change.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  AdmissionVerifyError, loadShardCandidateFiles, mergeCandidates, normalizeCandidate, relationTouchesSenses,
  validateRelationRows, verifyAccounting,
} from './admission.mjs';
import { loadCanonical, scanTouching } from './polish-cli.mjs';
import { parseDropExclusionJsonl, parseDropJsonl, parseRelationJsonl } from './persisted-jsonl.mjs';
import {
  dataFileFamily, deltaKeyText, keptRelationExclusions, mergeJsonl, removeKeys, supersededDrops,
} from './relation-delta.mjs';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RELATION_FILE = (shard) => `data/relations/relation-${shard}.jsonl`;
const DROP_FILE = (shard) => `data/relation-drops/drop-${shard}.jsonl`;

export class ReplayInputError extends Error {}

function git(root, args, { allowMissing = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (allowMissing) return null;
    throw new Error(`git ${args.join(' ')} failed: ${String(error.stderr || error.message).trim()}`);
  }
}

function commit(root, revision, flag) {
  const sha = git(root, ['rev-parse', '--verify', `${revision}^{commit}`], { allowMissing: true })?.trim();
  if (!sha) throw new ReplayInputError(`${flag} ${revision} is not a commit in this repository`);
  return sha;
}

const blob = (root, revision, relative) => git(root, ['show', `${revision}:${relative}`], { allowMissing: true });
const changedData = (root, from, to) => new Set(git(root, ['diff', '--name-only', '--no-renames', from, to, '--',
  'data/relations', 'data/relation-drops']).split('\n').filter((relative) => dataFileFamily(relative)));

async function writeTexts(root, texts) {
  const staged = [];
  try {
    for (const [relative, text] of texts) {
      const target = path.join(root, relative);
      if (text === null) { staged.push({ target, temporary: null }); continue; }
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
      staged.push({ target, temporary });
    }
    for (const { target, temporary } of staged) {
      if (temporary) await rename(temporary, target);
      else await rm(target, { force: true });
    }
  } catch (error) {
    await Promise.all(staged.filter(({ temporary }) => temporary).map(({ temporary }) => rm(temporary, { force: true })));
    throw error;
  }
}

function accounting(args) {
  try { verifyAccounting(args); return { problems: [], error: null }; } catch (error) {
    if (!(error instanceof AdmissionVerifyError)) throw error;
    return { problems: error.errors.map((message) => message.replace(/^(?:relation|drop):\d+: /u, '')), error };
  }
}

/**
 * Row validation of each rebuilt shard, and no Candidate accounting problem the latest data did not already have. A
 * replayed Candidate Drop whose Candidate the latest data already answers is left out (latest wins) and reported.
 */
/** Relation-only check (#9929): each rebuilt Relation file through the shared row validator; no Candidate or Drop. */
async function checkRelationShards(root, shards, after) {
  const { index, rowsByShard } = await loadCanonical(root);
  const shardSenses = new Set([...shards].flatMap((shard) => (rowsByShard.get(shard) ?? [])
    .flatMap((record) => record.senses.map((sense) => sense.id))));
  const afterAll = await scanTouching(root, shardSenses, after, { relationsOnly: true });
  for (const shard of [...shards].sort()) {
    const canonicalRows = rowsByShard.get(shard);
    if (!canonicalRows) throw new ReplayInputError(`shard ${shard} has no Canonical file`);
    const senseIds = new Set(canonicalRows.flatMap((record) => record.senses.map((sense) => sense.id)));
    const relationText = after.has(RELATION_FILE(shard)) ? after.get(RELATION_FILE(shard))
      : existsSync(path.join(root, RELATION_FILE(shard))) ? await readFile(path.join(root, RELATION_FILE(shard)), 'utf8') : null;
    validateRelationRows({ relationRows: relationText ? parseRelationJsonl(relationText, RELATION_FILE(shard)) : [], index,
      shardSenseIds: senseIds, otherRelationRows: afterAll.relations.filter((entry) => entry.file !== RELATION_FILE(shard)
        && relationTouchesSenses(entry.row, senseIds)).map(({ row }) => row) });
  }
}

async function checkShards(root, shards, before, after, report) {
  const { index, rowsByShard } = await loadCanonical(root);
  const lemmaForms = new Set([...index.byLemma.keys()].map(normalizeCandidate));
  const shardSenses = new Set([...shards].flatMap((shard) => (rowsByShard.get(shard) ?? [])
    .flatMap((record) => record.senses.map((sense) => sense.id))));
  const [beforeAll, afterAll] = await Promise.all([scanTouching(root, shardSenses, before), scanTouching(root, shardSenses, after)]);
  const textOf = async (texts, relative) => (texts.has(relative) ? texts.get(relative)
    : existsSync(path.join(root, relative)) ? readFile(path.join(root, relative), 'utf8') : null);
  for (const shard of [...shards].sort()) {
    const canonicalRows = rowsByShard.get(shard);
    if (!canonicalRows) throw new ReplayInputError(`shard ${shard} has no Canonical file`);
    const senseIds = new Set(canonicalRows.flatMap((record) => record.senses.map((sense) => sense.id)));
    const state = async (texts, scanned) => {
      const relationText = await textOf(texts, RELATION_FILE(shard));
      const dropText = await textOf(texts, DROP_FILE(shard));
      return {
        relationRows: relationText ? parseRelationJsonl(relationText, RELATION_FILE(shard)) : [],
        dropRows: dropText ? parseDropJsonl(dropText, DROP_FILE(shard)) : [],
        exclusionRows: dropText ? parseDropExclusionJsonl(dropText, DROP_FILE(shard)) : [],
        otherRelationRows: scanned.relations.filter((entry) => entry.file !== RELATION_FILE(shard)
          && relationTouchesSenses(entry.row, senseIds)).map(({ row }) => row),
      };
    };
    const { files } = await loadShardCandidateFiles(shard, root);
    const common = files.length ? { canonicalRows, candidateFiles: files, index,
      candidateMerge: mergeCandidates(canonicalRows, files, { canonicalLemmaForms: lemmaForms }) } : null;
    const previous = common ? await state(before, beforeAll) : null;
    const old = common ? new Set(accounting({ ...common, relationRows: previous.relationRows, dropRows: previous.dropRows,
      otherRelationRows: previous.otherRelationRows }).problems) : null;
    const dropReport = report.get(DROP_FILE(shard));
    // Rows left out return the file to the latest state; a file the latest data does not have stays absent.
    const dropWithout = (keys) => {
      const text = removeKeys(after.get(DROP_FILE(shard)), 'Drop', keys);
      after.set(DROP_FILE(shard), text === '' && before.get(DROP_FILE(shard)) === null ? null : text);
    };
    if (dropReport) {
      const stale = keptRelationExclusions(await textOf(after, RELATION_FILE(shard)), dropReport.applied);
      if (stale.size) {
        dropWithout(stale);
        for (const key of stale) { dropReport.applied.delete(key); dropReport.conflicts.push(key); }
      }
    }
    for (;;) {
      const next = await state(after, afterAll);
      validateRelationRows({ relationRows: next.relationRows, dropRows: next.dropRows, exclusionRows: next.exclusionRows,
        index, shardSenseIds: senseIds, otherRelationRows: next.otherRelationRows });
      if (!common) break;
      const result = accounting({ ...common, relationRows: next.relationRows, dropRows: next.dropRows,
        otherRelationRows: next.otherRelationRows });
      const introduced = result.problems.filter((problem) => !old.has(problem));
      if (!introduced.length) break;
      const superseded = dropReport ? supersededDrops(result.error, dropReport.applied) : new Set();
      if (!superseded.size) {
        throw new Error(`replay would introduce Candidate accounting problems in shard ${shard}; nothing was written:\n`
          + introduced.slice(0, 20).map((problem) => `- ${problem}`).join('\n'));
      }
      dropWithout(superseded);
      for (const key of superseded) { dropReport.applied.delete(key); dropReport.conflicts.push(key); }
    }
  }
}

export async function replay({ base, ours, theirs, paths = [], dryRun = false, relationsOnly = false }, root = REPOSITORY_DIRECTORY) {
  const [baseSha, ourSha, theirSha] = [commit(root, base, '--base'), commit(root, ours, '--ours'), commit(root, theirs, '--theirs')];
  for (const relative of paths) if (!dataFileFamily(relative)) throw new ReplayInputError(`--path ${relative} is not a shard Relation/Drop file`);
  const ourChanges = changedData(root, baseSha, ourSha);
  if (relationsOnly) {
    // Paths only: a Relation-only replay never reads a Drop file, and never silently drops part of the PR.
    const drops = [...new Set([...paths, ...ourChanges])].filter((relative) => dataFileFamily(relative) !== 'Relation').sort();
    if (drops.length) throw new ReplayInputError(`--relations-only replay cannot rebuild Drop files: ${drops.slice(0, 10).join(', ')}`);
  }
  // Every data file the PR changed is rebuilt and checked, so its other-shard side effects (for example a reverse `z`)
  // are re-validated against the latest data too; files only the latest data changed stay as they are.
  const selected = paths.length ? [...new Set(paths)].sort() : [...ourChanges].sort();
  const before = new Map();
  const after = new Map();
  const report = new Map();
  for (const relative of selected) {
    const family = dataFileFamily(relative);
    const [baseText, ourText, theirText] = [blob(root, baseSha, relative), blob(root, ourSha, relative), blob(root, theirSha, relative)];
    const merged = mergeJsonl({ base: baseText, ours: ourText, theirs: theirText, family, label: relative });
    before.set(relative, theirText);
    after.set(relative, merged.text);
    report.set(relative, { applied: new Set(merged.applied), conflicts: merged.conflicts });
  }
  const shards = new Set(selected.map((relative) => /-(\d{3})\.jsonl$/u.exec(relative)[1]));
  if (shards.size) await (relationsOnly ? checkRelationShards(root, shards, after) : checkShards(root, shards, before, after, report));
  if (!dryRun && after.size) await writeTexts(root, after);
  const files = [...report].map(([relative, { applied, conflicts }]) => ({ path: relative, applied: applied.size,
    conflicts: conflicts.map(deltaKeyText) }));
  return { version: 1, ok: true, dry_run: dryRun, base: baseSha, ours: ourSha, theirs: theirSha,
    status: files.length ? (dryRun ? 'planned' : 'replayed') : 'no-op', files };
}

function parseArgs(argv) {
  const options = { base: null, ours: null, theirs: null, paths: [], dryRun: false, relationsOnly: false };
  for (let position = 0; position < argv.length; position += 1) {
    const flag = argv[position];
    if (flag === '--dry-run') { options.dryRun = true; continue; }
    if (flag === '--relations-only') { options.relationsOnly = true; continue; }
    const value = argv[position + 1];
    if (value === undefined || value.startsWith('--')) throw new ReplayInputError(`${flag} needs a value`);
    position += 1;
    if (flag === '--base') options.base = value;
    else if (flag === '--ours') options.ours = value;
    else if (flag === '--theirs') options.theirs = value;
    else if (flag === '--path') options.paths.push(value);
    else throw new ReplayInputError(`unknown option ${flag}`);
  }
  if (!options.base || !options.ours || !options.theirs) {
    throw new ReplayInputError('usage: replay-cli.mjs --base <rev> --ours <rev> --theirs <rev> [--path <data file>]... [--relations-only] [--dry-run]');
  }
  return options;
}

export async function run(argv, { root = REPOSITORY_DIRECTORY } = {}) {
  const result = await replay(parseArgs(argv), root);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof ReplayInputError ? 2 : 1;
  });
}
