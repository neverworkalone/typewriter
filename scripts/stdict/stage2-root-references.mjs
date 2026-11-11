import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flattenSenses, readStdictItems, recordIdFor } from './convert.mjs';
import { loadAllCanonical } from '../relation/admission.mjs';

// Project only exact STDICT sense-code chains: Canonical arrow -> excluded root -> Canonical derivative.
// The target root and its source definition are licensed STDICT projections, not a raw source dump.
export function projectRootReferences(canonical, sourceSenses) {
  const canonicalSenses = new Map(canonical.flatMap((record) => record.senses.map((sense) => [sense.id, sense])));
  const byCode = new Map(sourceSenses.map((row) => [row.code, row]));
  const result = [];
  for (const source of sourceSenses) {
    const current = canonicalSenses.get(source.id);
    const arrow = /^→\s*<sense_no>(\d+)<\/sense_no>/u.exec(source.original ?? '');
    if (!current || !arrow || current.gloss !== source.definition) continue;
    const root = byCode.get(Number(arrow[1]));
    if (!root || canonicalSenses.has(root.id)) continue;
    const derivativeRef = /^‘<sense_no>(\d+)<\/sense_no>[^<]+’의 어근\.$/u.exec(root.original ?? '');
    const derivative = derivativeRef && byCode.get(Number(derivativeRef[1]));
    const canonicalDerivative = derivative && canonicalSenses.get(derivative.id);
    if (!canonicalDerivative || canonicalDerivative.gloss !== derivative.definition || canonicalDerivative.gloss.startsWith('→')) continue;
    result.push({ source_sense_id: source.id, source_gloss: current.gloss, source_code: source.code,
      root_sense_id: root.id, root_code: root.code, root_word: root.word, root_gloss: root.definition,
      derivative_sense_id: derivative.id, derivative_code: derivative.code, derivative_gloss: canonicalDerivative.gloss });
  }
  return result.sort((a, b) => a.source_sense_id.localeCompare(b.source_sense_id, 'en'));
}

async function main() {
  const sourceDir = process.argv[2];
  if (!sourceDir) throw new Error('usage: node scripts/stdict/stage2-root-references.mjs <trusted-stdict-directory> [--verify]');
  const inventory = JSON.parse(await readFile('data/provenance/stdict-source-inventory.json', 'utf8'));
  const rows = [];
  await readStdictItems(sourceDir, (item) => flattenSenses(item).forEach(({ sense }, i) => rows.push({
    id: `${recordIdFor(item.target_code)}-s${i + 1}`, code: Number(sense.sense_code), word: item.word_info.word,
    definition: sense.definition, original: sense.definition_original,
  })), { inventory });
  const text = `${JSON.stringify(projectRootReferences(await loadAllCanonical(), rows), null, 2)}\n`;
  const output = 'data/provenance/stage2-root-references.json';
  if (process.argv.includes('--verify')) {
    if (await readFile(output, 'utf8') !== text) throw new Error('Stage 2 root reference projection differs from trusted source');
  } else await writeFile(output, text);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
