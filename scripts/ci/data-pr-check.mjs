import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { classifyChangedPathDiff } from './changed-files.mjs';
import { GIT_MAX_BUFFER } from './git-limits.mjs';
import { normalizeCandidate, parseCandidateJsonl, validateCandidateBatch, validateCandidatePaths } from '../relation/candidate-contract.mjs';
import {
  dropRowFieldErrors, parseDropJsonl, parseRelationJsonl, relationPairKey, relationRowFieldErrors, relationTextKey,
} from '../relation/persisted-jsonl.mjs';

/*
 * Lightweight required check for pure production data PRs (#5807). It validates only the changed Candidate or
 * Relation/Drop files and the one Canonical shard each file is bound to. It is storage-contract and change-scope
 * evidence, not a semantic or global-integrity proof: exact target Senses, cross-shard conflicts and accounting stay
 * with the official production CLI, the independent PR review and Deep CI.
 */

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_DIRECTORY = path.resolve(path.dirname(SCRIPT_PATH), '../..');
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SCHEMA_PATH = 'schema/canonical-record.schema.json';
const RELATION_PATH = /^data\/relations\/relation-(\d{3})\.jsonl$/u;
const DROP_PATH = /^data\/relation-drops\/drop-(\d{3})\.jsonl$/u;

function defaultRunGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'buffer', maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
}

const canonicalShardPath = (shard) => `data/canonical/stdict-${shard.padStart(4, '0')}.jsonl`;

/** Validate the exact changed data files of a pure data PR; throws with every row-level problem found. */
export function checkDataPr(changeBaseSha, changeHeadSha, validationHeadSha, {
  cwd = REPOSITORY_DIRECTORY,
  runGit = (args) => defaultRunGit(args, cwd),
} = {}) {
  for (const [name, sha] of Object.entries({ changeBaseSha, changeHeadSha, validationHeadSha })) {
    if (!SHA_PATTERN.test(sha ?? '')) throw new TypeError(`${name} must be a full lowercase 40-character Git SHA`);
  }
  const classification = classifyChangedPathDiff(changeBaseSha, changeHeadSha, { runGit });
  if (classification.runLevel !== 'data') {
    throw new Error(`changed paths are not a pure production data PR (classification: ${classification.runLevel})`);
  }

  let bytesRead = 0;
  const filesRead = new Set();
  const readText = (filePath, label = filePath) => {
    let bytes;
    try { bytes = runGit(['show', `${validationHeadSha}:${filePath}`]); }
    catch { throw new Error(`${label} is missing at validation head ${validationHeadSha}`); }
    bytesRead += bytes.length;
    filesRead.add(filePath);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error(`${filePath} is not valid UTF-8`); }
  };
  const canonicalShards = new Map();
  const canonicalRows = (shard) => {
    if (!canonicalShards.has(shard)) canonicalShards.set(shard, parseCandidateJsonl(readText(canonicalShardPath(shard)), canonicalShardPath(shard)));
    return canonicalShards.get(shard);
  };

  const results = [];
  const errors = [];
  if (classification.dataLane === 'candidate') {
    for (const filePath of classification.changedPaths) {
      try {
        const root = path.resolve('/typewriter');
        const shard = /^(\d{3})_/u.exec(path.posix.basename(filePath))?.[1] ?? '000';
        const { batch } = validateCandidatePaths(path.join(root, canonicalShardPath(shard)), path.join(root, filePath), { repositoryDirectory: root });
        const counts = validateCandidateBatch(canonicalRows(shard), parseCandidateJsonl(readText(filePath), filePath), {
          batch, sourceName: canonicalShardPath(shard), candidateName: filePath,
        });
        results.push({ path: filePath, ...counts });
      } catch (error) {
        errors.push(error.message);
      }
    }
  } else {
    const schema = JSON.parse(readText(SCHEMA_PATH));
    const recordId = new RegExp(schema.properties.id.pattern, 'u');
    const senseId = new RegExp(schema.$defs.sense.properties.id.pattern, 'u');
    for (const filePath of classification.changedPaths) {
      const match = RELATION_PATH.exec(filePath) ?? DROP_PATH.exec(filePath);
      if (!match) { errors.push(`${filePath} does not follow the relation-SSS.jsonl / drop-SSS.jsonl filename contract`); continue; }
      const shard = match[1];
      const isRelation = RELATION_PATH.test(filePath);
      try {
        const rows = (isRelation ? parseRelationJsonl : parseDropJsonl)(readText(filePath), filePath);
        const senses = new Map();
        for (const record of canonicalRows(shard)) {
          for (const sense of record.senses ?? []) senses.set(sense.id, record);
        }
        const fileErrors = [];
        const seen = new Set();
        rows.forEach((row, position) => {
          const at = `${filePath}:${position + 1}`;
          const rowErrors = isRelation ? relationRowFieldErrors(row, at) : dropRowFieldErrors(row, at);
          const ids = [['source_record_id', recordId], ['source_sense_id', senseId]];
          if (isRelation && !('text' in row)) ids.push(['target_record_id', recordId], ['target_sense_id', senseId]);
          for (const [field, pattern] of ids) {
            if (typeof row[field] === 'string' && !pattern.test(row[field])) rowErrors.push(`${at}: ${field} ${JSON.stringify(row[field])} is not a Canonical ID`);
          }
          const source = senses.get(row.source_sense_id);
          if (!source) rowErrors.push(`${at}: source sense ${row.source_sense_id} is not in Canonical shard ${shard}`);
          else if (source.id !== row.source_record_id) rowErrors.push(`${at}: source_sense_id ${row.source_sense_id} is not a sense of ${row.source_record_id}`);
          if (rowErrors.length === 0) {
            const keys = !isRelation
              ? [`drop\u0000${relationTextKey(row.source_sense_id, row.candidate)}`]
              : 'text' in row
                ? [`text\u0000${relationTextKey(row.source_sense_id, row.text)}`]
                : [relationPairKey(row.source_sense_id, row.target_record_id, row.target_sense_id)];
            if (isRelation && 'text' in row && row.text === normalizeCandidate(source.lemma)) rowErrors.push(`${at}: text repeats the source lemma`);
            if (isRelation && !('text' in row) && row.target_record_id === row.source_record_id) rowErrors.push(`${at}: relation targets its own record`);
            if (seen.has(keys[0])) rowErrors.push(`${at}: duplicate ${isRelation ? ('text' in row ? 'text relation' : 'or reverse-duplicate ID relation') : 'drop'} in this file`);
            seen.add(keys[0]);
            if (isRelation && !('text' in row)) seen.add(relationPairKey(row.target_sense_id, row.source_record_id, row.source_sense_id));
          }
          fileErrors.push(...rowErrors);
        });
        errors.push(...fileErrors);
        const [added = '0', removed = '0'] = new TextDecoder().decode(runGit([
          'diff', '--numstat', '--no-renames', `${changeBaseSha}...${changeHeadSha}`, '--', filePath,
        ])).trim().split('\t');
        results.push({ path: filePath, rows: rows.length, added: Number(added), removed: Number(removed) });
      } catch (error) {
        errors.push(error.message);
      }
    }
  }

  if (errors.length > 0) {
    const shown = errors.slice(0, 200);
    throw new Error(`Data PR contract check failed (${errors.length} problem(s)):\n${shown.map((line) => `- ${line}`).join('\n')}${errors.length > shown.length ? `\n- … ${errors.length - shown.length} more` : ''}`);
  }
  return { lane: classification.dataLane, results, filesRead: filesRead.size, bytesRead };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3) throw new TypeError('usage: node scripts/ci/data-pr-check.mjs <change-base-sha> <change-head-sha> <validation-head-sha>');
  const started = process.hrtime.bigint();
  const result = checkDataPr(...args);
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const lines = [
    `## Data PR contract check (${result.lane})`,
    ...result.results.map((item) => (result.lane === 'candidate'
      ? `- \`${item.path}\`: ${item.recordCount} records, ${item.senseCount} senses, ${item.candidateCount} candidates`
      : `- \`${item.path}\`: ${item.rows} rows (+${item.added} / -${item.removed} lines)`)),
    `- Read ${result.filesRead} file(s), ${result.bytesRead} bytes in ${seconds.toFixed(2)} s.`,
    '- Evidence scope: storage format and change scope only. This is not a semantic or global-integrity proof; exact Senses, cross-shard conflicts and accounting are owned by the production CLI, PR review and Deep CI.',
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`, 'utf8');
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
