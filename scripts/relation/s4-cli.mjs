// Stage 4 CLI (#9928): selective whole-shard Polish — the Refinement Engine core with the keyed Stage 4 rule, whose
// data changes go through the Polish write path. `lookup` and `verify` are the two Stage-specific read-only commands.
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { run as admissionRun } from './admission-cli.mjs';
import { AdmissionVerifyError, assertShard } from './admission.mjs';
import { createRefineCli, fail, gitHead, REPOSITORY_DIRECTORY, RefineInputError, runAsScript } from './refine/core.mjs';
import * as stage4 from './refine/rules/s4.mjs';

const refine = createRefineCli(stage4);

function option(argv, flag) {
  const position = argv.indexOf(flag);
  const value = position >= 0 ? argv[position + 1] : null;
  return value && !value.startsWith('--') ? value : null;
}

export async function run(argv, { root = REPOSITORY_DIRECTORY, fullOtherRows = false } = {}) {
  if (argv[0] === 'lookup') {
    const text = option(argv, '--text');
    if (argv.length !== 3 || !text) fail(`lookup requires --text <form>[,<form>...]\n${stage4.usage}`);
    const output = await stage4.lookup(text.split(',').map((form) => form.trim()).filter(Boolean), root);
    process.stdout.write(output);
    return output;
  }
  if (argv[0] === 'verify') {
    // The official whole-shard admission verify, over every shard this PR's edits affect, in one run.
    const shard = option(argv, '--shard');
    const base = option(argv, '--base');
    if (argv.length !== 5 || !shard || !/^[a-f0-9]{40}$/u.test(base ?? '')) fail(`verify requires --shard SSS --base <sha>\n${stage4.usage}`);
    assertShard(shard);
    const shards = await stage4.verifyShards({ shard, root, base, head: gitHead(root) });
    // One output line: the combined success, or (thrown) the first failing shard's `--json` failure.
    const log = console.log;
    console.log = () => {};
    let results;
    try { results = await admissionRun(['verify', '--shard', shards.join(','), '--json'], { root }); }
    finally { console.log = log; }
    const payload = { version: 1, ok: true, shards, counts: Object.fromEntries(shards.map((name, index) =>
      [name, (Array.isArray(results) ? results[index] : results)?.counts ?? null])) };
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
