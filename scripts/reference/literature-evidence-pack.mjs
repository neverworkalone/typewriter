import path from 'node:path';

import { assertLiteraturePermission, DEFAULT_FULL_LITERATURE_INDEX_PATH } from './literature-index.mjs';
import { writeEvidencePack } from './literature-evidence.mjs';
import { evidenceForCandidate, loadEvidenceContext } from './literature-evidence-run.mjs';

const USAGE = 'Usage: node scripts/reference/literature-evidence-pack.mjs [--index <path>] [--max-contexts <1–10; default 8>] [--max-per-work <1–3; default 1>] <batch id> <candidate id>';

try {
  const options = { databasePath: DEFAULT_FULL_LITERATURE_INDEX_PATH };
  const positional = [];
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--help') { options.help = true; continue; }
    if (['--index', '--max-contexts', '--max-per-work'].includes(flag)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(flag + ' requires a value.');
      if (flag === '--index') options.databasePath = path.resolve(value);
      if (flag === '--max-contexts') options.maxContexts = Number(value);
      if (flag === '--max-per-work') options.maxPerWork = Number(value);
      index += 1;
      continue;
    }
    positional.push(flag);
  }
  if (options.help) {
    console.log(USAGE);
  } else {
    if (positional.length !== 2) throw new Error(USAGE);
    const [batchId, candidateId] = positional;
    await assertLiteraturePermission();
    const result = await evidenceForCandidate(await loadEvidenceContext(), {
      batchId, candidateId, databasePath: options.databasePath, maxContexts: options.maxContexts, maxPerWork: options.maxPerWork,
    });
    const files = await writeEvidencePack(result);
    console.log(JSON.stringify({ summary: result.summary, files }, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
