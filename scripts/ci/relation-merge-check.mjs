import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_DIRECTORY = path.resolve(path.dirname(SCRIPT_PATH), '../..');
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${command} ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = result.stderr.toString('utf8').trim();
    throw new Error(`${command} ${args[0]} failed (status=${result.status})${stderr ? `: ${stderr}` : ''}`);
  }
  return result.stdout;
}

function changedRelationShards(base, candidate, cwd) {
  const output = run('git', [
    'diff', '--no-renames', '--name-only', '-z', `${base}...${candidate}`, '--', 'data/relations',
  ], cwd);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(output);
  if (text && !text.endsWith('\0')) throw new Error('Git changed-path output was not NUL-terminated.');
  const shards = new Set();
  for (const file of text ? text.slice(0, -1).split('\0') : []) {
    const match = /^data\/relations\/relation-(\d{3})\.jsonl$/u.exec(file);
    if (match) shards.add(match[1]);
  }
  return [...shards].sort();
}

export function checkRelationMerge(base, candidate, cwd = REPOSITORY_DIRECTORY) {
  if (!SHA_PATTERN.test(base ?? '') || !SHA_PATTERN.test(candidate ?? '')) {
    throw new TypeError('base and candidate must be full lowercase 40-character Git SHAs.');
  }
  const shards = changedRelationShards(base, candidate, cwd);
  if (shards.length === 0) {
    console.log('No approved Relation shards changed; cross-shard merge check skipped.');
    return { checked: [], skipped: true };
  }
  for (const shard of shards) {
    const result = spawnSync(process.execPath, [
      path.join(REPOSITORY_DIRECTORY, 'scripts/relation/admission-cli.mjs'),
      'verify', '--shard', shard, '--relations-only', '--json',
    ], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error) throw new Error(`Relation integrity check for shard ${shard} failed: ${result.error.message}`);
    if (result.status !== 0) {
      const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
      throw new Error(`Relation integrity check for shard ${shard} failed (status=${result.status}).${detail ? `\n${detail}` : ''}`);
    }
    let payload;
    try { payload = JSON.parse(result.stdout); }
    catch { throw new Error(`Relation integrity check for shard ${shard} returned invalid JSON.`); }
    if (payload.ok !== true || payload.scope !== 'relation-integrity' || payload.shard !== shard) {
      throw new Error(`Relation integrity check for shard ${shard} returned an unexpected result.`);
    }
    console.log(`Relation integrity passed for shard ${shard}: ${payload.counts.relations} relations, ${payload.counts.drops} drops.`);
  }
  return { checked: shards, skipped: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const [, , base, candidate] = process.argv;
    if (process.argv.length !== 4) throw new TypeError('usage: node scripts/ci/relation-merge-check.mjs <base-sha> <candidate-sha>');
    checkRelationMerge(base, candidate);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
