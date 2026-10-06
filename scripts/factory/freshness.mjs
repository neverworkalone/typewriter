import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { SHARED_FACTORY_CONTRACT_PATHS } from './contract.mjs';

// Concurrent Stage 2 result PRs each pass CI against the master they branched from. When one of
// them changes a shared factory contract (validator, schema, producer) and merges first, a sibling
// that was authored against the old contract is still green but makes master invalid on merge.
// This gate fails such a PR until it is re-synchronised with master, so CI re-runs the complete
// factory validation against the new contract. It is deterministic, offline and ref-based.

const REVIEWED_DATA = ['data/candidates/', 'data/reviews/'];
const startsWithAny = (file, prefixes) => prefixes.some((prefix) => file.startsWith(prefix));

const git = (args, root) => execFileSync('git', args, {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
}).trim();

const lines = (text) => text.split('\n').filter(Boolean);

// `head` must be the pull-request head, not the synthetic merge commit CI checks out: the merge
// commit always contains the newest master and would hide exactly the staleness being detected.
export function checkFactoryFreshness({ root, base, head }) {
  let baseTip;
  let headTip;
  let mergeBase;
  try {
    baseTip = git(['rev-parse', '--verify', `${base}^{commit}`], root);
    headTip = git(['rev-parse', '--verify', `${head}^{commit}`], root);
    mergeBase = git(['merge-base', baseTip, headTip], root);
  } catch {
    return [`cannot resolve ${base} and ${head}; fetch the complete history of master (fetch-depth 0) before the freshness check`];
  }
  const touched = lines(git(['diff', '--no-renames', '--name-only', `${mergeBase}..${headTip}`], root));
  if (!touched.some((file) => startsWithAny(file, REVIEWED_DATA))) return [];
  if (mergeBase === baseTip) return [];
  const newer = lines(git(['diff', '--no-renames', '--name-only', `${mergeBase}..${baseTip}`], root))
    .filter((file) => startsWithAny(file, SHARED_FACTORY_CONTRACT_PATHS));
  if (newer.length === 0) return [];
  const shown = newer.slice(0, 5).join(', ') + (newer.length > 5 ? `, … (${newer.length} files)` : '');
  return [`this factory result branched before master changed the shared factory contract (${shown}); merge ${base} into the branch and re-run the factory validation before merging`];
}

export function pullRequestHead(env = process.env) {
  if (env.FACTORY_FRESHNESS_HEAD) return env.FACTORY_FRESHNESS_HEAD;
  if (env.GITHUB_EVENT_NAME === 'pull_request' && env.GITHUB_EVENT_PATH) {
    try {
      const sha = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).pull_request?.head?.sha;
      if (sha) return sha;
    } catch { /* fall through to HEAD */ }
  }
  return 'HEAD';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.env.FACTORY_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const errors = checkFactoryFreshness({ root, base: process.env.FACTORY_BASE_REF ?? 'origin/master', head: pullRequestHead() });
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('Factory result is current with the shared factory contract on master.');
}
