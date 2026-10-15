import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { meaningId, parseShardFileName, planShards, readAdjudications, readMeanings, writeMeanings } from './contract.mjs';

/**
 * Initial meaning projection (Issue #714): every canonical sense becomes its own meaning with the canonical gloss.
 * No MERGE/DROP and no canonical edits. A record with one sense maps `wNNN -> mNNN`; several senses map
 * `wNNN-sK -> mNNN_K` (K is the sense's own number, so the id is stable and deterministic).
 */
export function projectInitialMeanings(entries) {
  const rows = [];
  for (const entry of entries) {
    const senses = entry.senses ?? [];
    for (const sense of senses) {
      const ordinal = senses.length === 1 ? null : Number(/-s(\d+)$/u.exec(sense.id)[1]);
      rows.push({ id: meaningId(entry.id, ordinal), lemma: entry.lemma, gloss: sense.gloss, sense_ids: [sense.id] });
    }
  }
  return rows;
}

export function readCanonicalEntries(directory) {
  const entries = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(path.join(directory, file), 'utf8').split('\n')) if (line) entries.push(JSON.parse(line));
  }
  return entries;
}

/** Planned shards for the canonical directory as `Map<file, text>` (no writes). */
export function planInitialShards(canonicalDirectory) {
  const plan = planShards(projectInitialMeanings(readCanonicalEntries(canonicalDirectory)), 'meaning');
  return new Map([...plan].map(([file, rows]) => [file, rows.map((row) => `${JSON.stringify(row)}\n`).join('')]));
}

/** Differences between the planned initial projection and `meaningsDirectory` (empty when identical). */
export function diffInitialShards(canonicalDirectory, meaningsDirectory) {
  const plan = planInitialShards(canonicalDirectory);
  const problems = [];
  const present = existsSync(meaningsDirectory) ? readdirSync(meaningsDirectory).filter((name) => name.endsWith('.jsonl')) : [];
  for (const file of present) if (!plan.has(file)) problems.push(`${file}: not part of the initial projection`);
  for (const [file, text] of plan) {
    if (!present.includes(file)) problems.push(`${file}: missing`);
    else if (readFileSync(path.join(meaningsDirectory, file), 'utf8') !== text) problems.push(`${file}: differs from the initial projection`);
  }
  return problems;
}

/**
 * Why `meaningsDirectory`/`adjudicationDirectory` must not be regenerated (empty when they are safe to write).
 * Safe means: no meaning shards and no adjudication shards yet (pre-generation), or meanings already identical to the
 * initial projection with no adjudication. Anything else is treated as editing having started (fail-closed).
 */
export function editingStartedReasons(canonicalDirectory, meaningsDirectory, adjudicationDirectory) {
  const shardFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => !name.startsWith('.') && (parseShardFileName(name) || name.endsWith('.jsonl'))) : []);
  const reasons = [];
  const adjudications = shardFiles(adjudicationDirectory);
  if (adjudications.length) {
    const { rows } = readAdjudications(adjudicationDirectory);
    reasons.push(`adjudication data exists (${rows.length} rows in ${adjudications.length} shards)`);
  }
  if (!shardFiles(meaningsDirectory).length) return reasons;
  const problems = diffInitialShards(canonicalDirectory, meaningsDirectory);
  if (!problems.length) return reasons;
  const { rows } = readMeanings(meaningsDirectory);
  const merged = rows.filter((row) => row.sense_ids?.length > 1).length;
  if (merged) reasons.push(`${merged} meanings reference several sense_ids (MERGE)`);
  reasons.push(`meanings differ from the initial projection (${problems.length} shard problems, e.g. ${problems[0]})`);
  return reasons;
}

/** Default initial generation: refuses before any write when editing has started. `force` is for explicit recovery only. */
export function generateInitialMeanings({ canonicalDirectory, meaningsDirectory, adjudicationDirectory, force = false }) {
  const reasons = editingStartedReasons(canonicalDirectory, meaningsDirectory, adjudicationDirectory);
  const rows = projectInitialMeanings(readCanonicalEntries(canonicalDirectory));
  if (reasons.length && !force) {
    throw new Error(`refusing to overwrite ${meaningsDirectory}: editing has started (${reasons.join('; ')}); use --check to inspect or --force-reset-initial to deliberately reset`);
  }
  if (!reasons.length && !diffInitialShards(canonicalDirectory, meaningsDirectory).length) return { rows: rows.length, files: [], written: false };
  const files = writeMeanings(meaningsDirectory, rows);
  return { rows: rows.length, files, written: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const canonical = path.join(root, 'data/canonical');
  const meanings = path.join(root, 'data/meanings');
  if (process.argv.includes('--check')) {
    const problems = diffInitialShards(canonical, meanings);
    if (problems.length) { console.error(problems.slice(0, 50).join('\n')); process.exit(1); }
    console.log('data/meanings matches the initial canonical projection');
  } else {
    try {
      const result = generateInitialMeanings({
        canonicalDirectory: canonical,
        meaningsDirectory: meanings,
        adjudicationDirectory: path.join(root, 'data/adjudication'),
        force: process.argv.includes('--force-reset-initial'),
      });
      console.log(result.written ? `wrote ${result.rows} meanings into ${result.files.length} shards` : `data/meanings already matches the initial projection (${result.rows} meanings); nothing written`);
    } catch (error) { console.error(error.message); process.exit(1); }
  }
}
