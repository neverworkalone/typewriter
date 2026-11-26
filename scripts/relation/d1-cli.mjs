// D1 CLI (#10171): whole Drop of confirmed Skip Senses — the Refinement Engine core with the keyed D1 rule. The model
// judges each `s` Sense's category; the Relation-only Polish write path (#9929) drops every approved Relation touching
// a `D` Sense. `verify` checks the PR's relation-key diff against those judgments (no Candidate or Drop file is read).
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { AdmissionVerifyError, assertShard } from './admission.mjs';
import { createRefineCli, fail, gitHead, REPOSITORY_DIRECTORY, RefineInputError, runAsScript } from './refine/core.mjs';
import * as d1 from './refine/rules/d1.mjs';

const refine = createRefineCli(d1);

function option(argv, flag) {
  const position = argv.indexOf(flag);
  const value = position >= 0 ? argv[position + 1] : null;
  return value && !value.startsWith('--') ? value : null;
}

export async function run(argv, { root = REPOSITORY_DIRECTORY, fullOtherRows = false } = {}) {
  if (argv[0] === 'verify') {
    // The PR against its kept judgments (#10171): every Relation of a D Sense dropped, nothing else changed. The
    // judgments are read from `--judgments <worktree>` (the batch worktree) or this checkout.
    const shard = option(argv, '--shard');
    const base = option(argv, '--base');
    const judgments = option(argv, '--judgments');
    if (![5, 7].includes(argv.length) || !shard || !/^[a-f0-9]{40}$/u.test(base ?? '') || (argv.length === 7) !== Boolean(judgments)) {
      fail(`verify requires --shard SSS --base <sha> [--judgments <worktree>]\n${d1.usage}`);
    }
    assertShard(shard);
    const payload = await d1.verifyDecisions({ shard, root, base, head: gitHead(root),
      saved: refine.savedDecisions(shard, judgments ? path.resolve(judgments) : root) });
    console.log(JSON.stringify(payload));
    return payload;
  }
  return refine.run(argv, { root, fullOtherRows });
}

const isScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isScript && process.argv[2] === 'verify') {
  run(process.argv.slice(2)).catch((error) => {
    if (error instanceof AdmissionVerifyError) {
      console.log(JSON.stringify({ version: 1, ok: false, family: error.family, errors: error.errors, total: error.total }));
      process.exitCode = 2;
      return;
    }
    console.error(error?.message ?? String(error));
    process.exitCode = error instanceof RefineInputError ? 2 : 1;
  });
} else {
  runAsScript(import.meta.url, run);
}
