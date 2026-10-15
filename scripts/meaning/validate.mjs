import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMeaningData } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function validateMeaningFiles({ canonical = true, senses = null } = {}) {
  return loadMeaningData({
    meaningsDirectory: path.join(root, 'data/meanings'),
    adjudicationDirectory: path.join(root, 'data/adjudication'),
    canonicalDirectory: canonical ? path.join(root, 'data/canonical') : null,
    senses,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { meanings, adjudications, errors } = validateMeaningFiles();
  if (errors.length) {
    console.error(errors.slice(0, 50).join('\n'));
    process.exit(1);
  }
  console.log(`meaning data valid: ${meanings.length} meanings, ${adjudications.length} adjudications`);
}
