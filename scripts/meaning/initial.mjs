import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { meaningId, planShards, writeMeanings } from './contract.mjs';

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const canonical = path.join(root, 'data/canonical');
  const meanings = path.join(root, 'data/meanings');
  if (process.argv.includes('--check')) {
    const problems = diffInitialShards(canonical, meanings);
    if (problems.length) { console.error(problems.slice(0, 50).join('\n')); process.exit(1); }
    console.log('data/meanings matches the initial canonical projection');
  } else {
    const rows = projectInitialMeanings(readCanonicalEntries(canonical));
    const files = writeMeanings(meanings, rows);
    console.log(`wrote ${rows.length} meanings into ${files.length} shards`);
  }
}
