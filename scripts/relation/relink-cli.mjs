import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  AdmissionVerifyError,
  assertShard,
  buildCanonicalIndex,
  createReverseCandidateFormLookup,
  loadAllApprovedDrops,
  loadOptionalDropJsonl,
  loadShardCandidateFiles,
  shardDropPath,
  shardRelationPath,
  validateRelationRows,
  verifyAccounting,
} from './admission.mjs';
import { parseCandidateJsonl } from './candidate-contract.mjs';
import { deserializeRelationRow, parseRelationJsonl, serializeRelationJsonl, serializeRelationRow } from './persisted-jsonl.mjs';

// Mis-binding correction (#2754): `pnpm run relation:relink -- --in <corrections.json> [--dry-run]`.
// Rule it guarantees: a correction replaces exactly one persisted, fully matching ID Relation of one shard with either
// an ID Relation to another exact Canonical target Sense or the text-only Relations of its original candidate forms, and
// writes nothing unless the whole batch passes the ordinary Relation/accounting validators for every affected shard.
// It never discovers Relations, changes Type/Tier, drops candidates, or edits Canonical/Candidate data.
//
// Input: { "shard": "002", "corrections": [{ "expected": <complete persisted ID row>,
//          "to": { "tid": "...", "tsid": "..." } | { "text_only": true } }] }

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const USAGE = 'Usage: node scripts/relation/relink-cli.mjs --in <corrections.json> [--dry-run]';
const EXPECTED_KEYS = 'fm,id,rfm,rv,sid,tid,tp,tsid,ver';
const ORDERED_KEYS = ['id', 'sid', 'tid', 'tsid', 'tp', 'rv', 'ver', 'fm', 'rfm'];
const sortedKeys = (value) => Object.keys(value).sort().join(',');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const rowIdentity = (compact) => JSON.stringify(ORDERED_KEYS.map((key) => compact[key]));
const shardOfFile = (name, pattern) => pattern.exec(name)?.[1];

function fail(errors) {
  const list = Array.isArray(errors) ? errors : [errors];
  throw new Error(`Relink rejected; no files were written:\n${list.map((error) => `- ${error}`).join('\n')}`);
}

/** Strictly parse the correction list; every structural defect is reported together. */
export function parseCorrections(text) {
  let input;
  try { input = JSON.parse(text); } catch (error) { fail(`correction list is not valid JSON: ${error.message}`); }
  const errors = [];
  if (!isPlainObject(input) || sortedKeys(input) !== 'corrections,shard') fail('correction list must be an object with exactly shard and corrections');
  try { assertShard(input.shard); } catch (error) { fail(error.message); }
  if (!Array.isArray(input.corrections) || input.corrections.length === 0) fail('corrections must be a non-empty array');
  const seen = new Set();
  const corrections = input.corrections.map((item, position) => {
    const at = `correction:${position + 1}`;
    if (!isPlainObject(item) || sortedKeys(item) !== 'expected,to') { errors.push(`${at}: must have exactly expected and to`); return null; }
    if (!isPlainObject(item.expected) || sortedKeys(item.expected) !== EXPECTED_KEYS
        || !Array.isArray(item.expected.fm) || item.expected.fm.length === 0 || !Number.isInteger(item.expected.ver)) {
      errors.push(`${at}: expected must be the complete persisted ID Relation row (${EXPECTED_KEYS}) with non-empty fm`);
      return null;
    }
    let destination;
    if (isPlainObject(item.to) && sortedKeys(item.to) === 'text_only' && item.to.text_only === true) destination = { textOnly: true };
    else if (isPlainObject(item.to) && sortedKeys(item.to) === 'tid,tsid' && isText(item.to.tid) && isText(item.to.tsid)) {
      destination = { tid: item.to.tid, tsid: item.to.tsid };
      if (destination.tsid === item.expected.tsid) errors.push(`${at}: new target equals the current target ${destination.tsid}`);
    } else { errors.push(`${at}: to must be { tid, tsid } or { text_only: true }`); return null; }
    const identity = rowIdentity(item.expected);
    if (seen.has(identity)) errors.push(`${at}: repeats an expected row already corrected in this input`);
    seen.add(identity);
    return { at, expected: item.expected, destination };
  });
  if (errors.length > 0) fail(errors);
  return { shard: input.shard, corrections };
}

async function loadRepository(root) {
  const directory = path.join(root, 'data/canonical');
  const canonicalByShard = new Map();
  for (const name of (await readdir(directory)).filter((item) => /^stdict-\d{4}\.jsonl$/u.test(item)).sort()) {
    const shard = String(Number(shardOfFile(name, /^stdict-(\d{4})\.jsonl$/u))).padStart(3, '0');
    canonicalByShard.set(shard, parseCandidateJsonl(await readFile(path.join(directory, name), 'utf8'), name));
  }
  const shardOfSense = new Map();
  for (const [shard, rows] of canonicalByShard) for (const record of rows) for (const sense of record.senses) shardOfSense.set(sense.id, shard);
  const relationsByShard = new Map();
  const relationDirectory = path.join(root, 'data/relations');
  if (existsSync(relationDirectory)) {
    for (const name of (await readdir(relationDirectory)).filter((item) => /^relation-\d{3}\.jsonl$/u.test(item)).sort()) {
      relationsByShard.set(shardOfFile(name, /^relation-(\d{3})\.jsonl$/u), parseRelationJsonl(await readFile(path.join(relationDirectory, name), 'utf8'), name));
    }
  }
  return {
    canonicalByShard,
    shardOfSense,
    relationsByShard,
    index: buildCanonicalIndex([...canonicalByShard.values()].flat()),
  };
}

const flatten = (relationsByShard, except) => [...relationsByShard].filter(([shard]) => shard !== except).flatMap(([, rows]) => rows);

/** Accounting errors of one shard. Throws only on non-accounting failures; accounting errors are returned. */
async function accountingErrors({ shard, repository, relationsByShard, allDrops, root }) {
  const { files } = await loadShardCandidateFiles(shard, root);
  try {
    verifyAccounting({
      canonicalRows: repository.canonicalByShard.get(shard) ?? [], candidateFiles: files,
      relationRows: relationsByShard.get(shard) ?? [], dropRows: allDrops,
      otherRelationRows: flatten(relationsByShard, shard), index: repository.index,
    });
    return [];
  } catch (error) {
    if (error instanceof AdmissionVerifyError && error.family === 'accounting') return error.errors;
    throw error;
  }
}

async function writeAtomically(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function relink({ shard, corrections }, { root = REPOSITORY_DIRECTORY, dryRun = false } = {}) {
  const repository = await loadRepository(root);
  const { index, shardOfSense } = repository;
  const sourceRows = repository.canonicalByShard.get(shard);
  if (!sourceRows) fail(`Canonical shard ${shard} does not exist`);
  const { files: candidateFiles, inventory } = await loadShardCandidateFiles(shard, root);
  if (inventory.missing.length > 0) fail(`shard ${shard} Stage 1 inputs are incomplete: ${inventory.missing.join(', ')}`);

  const relationFile = shardRelationPath(shard, root);
  const originalText = existsSync(relationFile) ? await readFile(relationFile, 'utf8') : '';
  const lines = originalText.split(/\r?\n/u).filter((line) => line.trim());
  const ownRows = lines.map((line, position) => deserializeRelationRow(JSON.parse(line), `${path.basename(relationFile)}:${position + 1}`));
  const ownDrops = await loadOptionalDropJsonl(shardDropPath(shard, root));
  const allDrops = await loadAllApprovedDrops(root);
  const otherRelations = flatten(repository.relationsByShard, shard);
  const shardSenseIds = new Set(sourceRows.flatMap((record) => record.senses.map((sense) => sense.id)));

  // 1. Match every expected row against the complete persisted row; stale or ambiguous input rejects the whole batch.
  const errors = [];
  const compactRows = ownRows.map((row) => ('text' in row ? null : serializeRowForCompare(row)));
  const targets = new Map();
  for (const correction of corrections) {
    const matches = compactRows.flatMap((compact, position) => compact !== null && rowIdentity(compact) === rowIdentity(correction.expected) ? [position] : []);
    if (matches.length === 0) errors.push(`${correction.at}: expected row ${correction.expected.sid} -> ${correction.expected.tsid} does not match any persisted row of shard ${shard} (stale or not an ID row)`);
    else if (matches.length > 1) errors.push(`${correction.at}: expected row matches ${matches.length} persisted rows; the target is ambiguous`);
    else targets.set(matches[0], correction);
  }
  if (errors.length > 0) fail(errors);

  // 2. Reverse candidate availability is rebuilt without every row being replaced, then corrected rows are added in order.
  const survivors = ownRows.filter((row, position) => !targets.has(position));
  const lookup = createReverseCandidateFormLookup({ relationRows: [...otherRelations, ...survivors], dropRows: allDrops, index });
  const replacement = new Map();
  const report = [];
  for (const [position, correction] of [...targets].sort((left, right) => left[0] - right[0])) {
    const original = ownRows[position];
    const { destination, expected } = correction;
    let rows;
    if (destination.textOnly) {
      rows = expected.fm.map((text) => ({ source_record_id: original.source_record_id, source_sense_id: original.source_sense_id,
        text, type: original.type, relevance: original.relevance }));
    } else {
      const target = index.senses.get(destination.tsid);
      if (!target || target.record.id !== destination.tid) {
        errors.push(`${correction.at}: ${destination.tsid} is not a Canonical sense of ${destination.tid}`);
        continue;
      }
      const sourceRecord = index.byId.get(original.source_record_id);
      rows = [{
        source_record_id: original.source_record_id, source_sense_id: original.source_sense_id,
        target_record_id: destination.tid, target_sense_id: destination.tsid,
        type: original.type, relevance: original.relevance, reverse_type: original.type, reverse_relevance: original.relevance,
        candidate_assignment_version: original.candidate_assignment_version, candidate_forms: original.candidate_forms,
        reverse_candidate_forms: lookup.available(sourceRecord, destination.tsid),
      }];
    }
    for (const row of rows) lookup.addRelation(row);
    replacement.set(position, rows);
    report.push({
      row: position + 1,
      before: expected,
      after: rows.map((row) => serializeRelationRow(row)),
      split_candidates: destination.textOnly ? rows.length : 0,
      rfm: destination.textOnly ? { before: expected.rfm, after: [] } : { before: expected.rfm, after: rows[0].reverse_candidate_forms },
      old_target_shard: shardOfSense.get(expected.tsid) ?? null,
      new_target_shard: destination.textOnly ? null : shardOfSense.get(destination.tsid) ?? null,
    });
  }
  if (errors.length > 0) fail(errors);

  const afterRows = ownRows.flatMap((row, position) => replacement.get(position) ?? [row]);
  const afterLines = lines.flatMap((line, position) => replacement.has(position)
    ? serializeRelationJsonl(replacement.get(position)).trimEnd().split('\n') : [line]);

  // 3. Ordinary validators over the corrected source shard, then no-new-error accounting for every other affected shard.
  try {
    validateRelationRows({ relationRows: afterRows, dropRows: ownDrops, index, shardSenseIds, otherRelationRows: otherRelations });
    verifyAccounting({ canonicalRows: sourceRows, candidateFiles, relationRows: afterRows, dropRows: allDrops,
      otherRelationRows: otherRelations, index });
  } catch (error) {
    if (error instanceof AdmissionVerifyError) fail([`shard ${shard}: ${error.errors.slice(0, 20).join('\n  ')}`]);
    throw error;
  }
  const affected = new Set([shard]);
  for (const item of report) for (const key of [item.old_target_shard, item.new_target_shard]) if (key) affected.add(key);
  const afterByShard = new Map(repository.relationsByShard).set(shard, afterRows);
  for (const other of [...affected].filter((item) => item !== shard).sort()) {
    const [before, after] = await Promise.all([
      accountingErrors({ shard: other, repository, relationsByShard: repository.relationsByShard, allDrops, root }),
      accountingErrors({ shard: other, repository, relationsByShard: afterByShard, allDrops, root }),
    ]);
    const known = new Set(before);
    for (const error of after) if (!known.has(error)) errors.push(`shard ${other}: ${error}`);
  }
  if (errors.length > 0) fail(errors);

  if (!dryRun) {
    const afterText = `${afterLines.join('\n')}\n`;
    if ((existsSync(relationFile) ? await readFile(relationFile, 'utf8') : '') !== originalText) fail(`shard ${shard} Relation file changed during the run`);
    await writeAtomically(relationFile, afterText);
  }
  return {
    shard,
    status: dryRun ? 'dry-run' : 'applied',
    corrected: report.length,
    relation_count: { before: ownRows.length, after: afterRows.length },
    affected_shards: { source: shard, old_target: unique(report.map((item) => item.old_target_shard)), new_target: unique(report.map((item) => item.new_target_shard)) },
    recommended_verify: [...affected].sort().map((item) => `node scripts/relation/admission-cli.mjs verify --shard ${item}`),
    corrections: report,
  };
}

const unique = (values) => [...new Set(values.filter(Boolean))].sort();
const serializeRowForCompare = (row) => serializeRelationRow(row);

function parseArgs(argv) {
  const options = { input: null, dryRun: false };
  for (let position = 0; position < argv.length; position += 1) {
    const argument = argv[position];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--in' && argv[position + 1]) options.input = argv[++position];
    else throw new Error(USAGE);
  }
  if (!options.input) throw new Error(USAGE);
  return options;
}

export async function run(argv, { root = REPOSITORY_DIRECTORY } = {}) {
  const options = parseArgs(argv);
  const input = parseCorrections(await readFile(path.resolve(options.input), 'utf8'));
  const result = await relink(input, { root, dryRun: options.dryRun });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  });
}
