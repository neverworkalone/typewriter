import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateContractRepairs, sha256Hex } from '../scripts/factory/contract.mjs';
import { checkFactoryFreshness, pullRequestHead } from '../scripts/factory/freshness.mjs';
import { validateLinkedTransition, validateReviewTransition } from '../scripts/factory/transitions.mjs';

const HEX = (label) => sha256Hex(label);

function repository() {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-freshness-'));
  const run = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  run('init', '-q', '-b', 'master');
  run('config', 'user.email', 't@example.test');
  run('config', 'user.name', 'T');
  const commit = (files, message) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), content);
    }
    run('add', '-A');
    run('commit', '-q', '-m', message);
    return run('rev-parse', 'HEAD');
  };
  return { root, run, commit };
}

test('a factory result branched before a shared contract change on master is refused until re-synchronised', () => {
  const { root, run, commit } = repository();
  commit({ 'scripts/factory/validate.mjs': 'v1', 'README.md': 'x' }, 'base');
  run('checkout', '-q', '-b', 'result');
  const head = commit({ 'data/reviews/C000009/manifest.json': '{}' }, 'stage 2 result');
  run('checkout', '-q', 'master');
  const check = () => checkFactoryFreshness({ root, base: 'master', head });

  assert.deepEqual(check(), [], 'a current branch passes');

  // Sibling data merges and unrelated changes do not require a re-sync.
  commit({ 'data/reviews/C000008/manifest.json': '{}', 'docs/a.md': 'd' }, 'sibling result and docs');
  assert.deepEqual(check(), []);

  // The shared contract changes on master: the stale result must be refused.
  commit({ 'scripts/validate/rule.mjs': 'new required field' }, 'shared contract change');
  const [error] = check();
  assert.match(error, /branched before master changed the shared factory contract \(scripts\/validate\/rule\.mjs\)/u);

  // Merging master into the result branch makes the next validation run against the new contract.
  run('checkout', '-q', 'result');
  run('merge', '-q', '--no-edit', 'master');
  assert.deepEqual(checkFactoryFreshness({ root, base: 'master', head: run('rev-parse', 'HEAD') }), []);
});

test('a change that touches no factory data is never blocked by the freshness gate', () => {
  const { root, run, commit } = repository();
  commit({ 'scripts/factory/a.mjs': '1' }, 'base');
  run('checkout', '-q', '-b', 'code');
  const head = commit({ 'src/app.js': 'x' }, 'unrelated');
  run('checkout', '-q', 'master');
  commit({ 'schema/s.json': '{}' }, 'contract');
  assert.deepEqual(checkFactoryFreshness({ root, base: 'master', head }), []);
});

test('freshness fails closed when the refs cannot be resolved and uses the PR head, not the merge commit', () => {
  const { root, commit } = repository();
  commit({ 'a.txt': '1' }, 'base');
  assert.match(checkFactoryFreshness({ root, base: 'origin/master', head: 'HEAD' })[0], /cannot resolve/u);
  assert.equal(pullRequestHead({ FACTORY_FRESHNESS_HEAD: 'abc' }), 'abc');
  const event = path.join(root, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { head: { sha: 'deadbeef' } } }));
  assert.equal(pullRequestHead({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event }), 'deadbeef');
  assert.equal(pullRequestHead({}), 'HEAD');
});

const semantic = (extra = {}, binding = 'b1') => JSON.stringify({
  schema_version: '1',
  decisions: [{ source_candidate_id: 'C000009-0001', decision_rationale: 'r', sense_reviews: [{ sense_id: 's1', semantic_rationale: 'q', ...extra }], review_binding: { digest: binding } }],
});

function ready(text) {
  return {
    contract: 'lexical-factory-review-manifest-v1',
    batch_id: 'C000009',
    candidates_sha256: HEX('c'),
    canonical_snapshot_digest: HEX('s'),
    decisions_sha256: HEX('d'),
    semantic_decisions_sha256: sha256Hex(text),
    handoff_sha256: HEX('h'),
    attempt: 1,
    status: 'ready',
    history: [],
  };
}

test('a ready review is re-bound in place only by adding the required contract field', () => {
  const before = semantic();
  const after = semantic({ scope_declaration: { admitted_observation_ids: [], excluded_observation_ids: [], excluded_terms: [] } }, 'b2');
  const oldManifest = ready(before);
  const repaired = {
    ...oldManifest,
    semantic_decisions_sha256: sha256Hex(after),
    contract_repairs: [{ contract: 'scope_declaration', previous_semantic_decisions_sha256: oldManifest.semantic_decisions_sha256, semantic_decisions_sha256: sha256Hex(after) }],
  };
  const evidence = { semanticBefore: before, semanticAfter: after };
  const has = (errors, fragment) => assert.ok(errors.some((error) => error.includes(fragment)), `${fragment}: ${errors}`);

  assert.deepEqual(validateReviewTransition(oldManifest, repaired, evidence), []);
  assert.deepEqual(validateContractRepairs(repaired), []);
  const complete = { contract: 'lexical-factory-candidate-manifest-v1', status: 'complete' };
  assert.deepEqual(validateLinkedTransition({ candidateBefore: complete, candidateAfter: complete, reviewBefore: oldManifest, reviewAfter: repaired, evidence }), []);

  // Without proof, with a changed rationale, or with any other manifest change, the repair is refused.
  has(validateReviewTransition(oldManifest, repaired), 'requires the merged and the new semantic-decisions.json');
  const rewritten = after.replace('"q"', '"edited"');
  has(validateReviewTransition(oldManifest, { ...repaired, semantic_decisions_sha256: sha256Hex(rewritten), contract_repairs: [{ ...repaired.contract_repairs[0], semantic_decisions_sha256: sha256Hex(rewritten) }] }, { semanticBefore: before, semanticAfter: rewritten }), 'no other authored semantic decision may change');
  has(validateReviewTransition(oldManifest, { ...repaired, decisions_sha256: HEX('d2') }, evidence), 'may change only semantic_decisions_sha256');
  has(validateReviewTransition(oldManifest, { ...repaired, attempt: 2 }, evidence), 'must not change attempt or history');
  has(validateReviewTransition(oldManifest, { ...repaired, contract_repairs: [{ ...repaired.contract_repairs[0], contract: 'other' }] }, evidence), 'unknown contract repair');
  has(validateReviewTransition(oldManifest, { ...repaired, contract_repairs: [{ ...repaired.contract_repairs[0], previous_semantic_decisions_sha256: HEX('x') }] }, evidence), 'link the previous');
  has(validateReviewTransition(oldManifest, { ...oldManifest }, evidence), 'illegal review transition ready → ready');
  has(validateContractRepairs({ ...repaired, semantic_decisions_sha256: HEX('other') }), 'last contract repair');
  has(validateContractRepairs({ ...repaired, contract_repairs: [] }), 'non-empty');

  // An existing declaration is an authored judgment: changing it is not a repair, adding the missing one is.
  const declared = (terms) => semantic({ scope_declaration: { admitted_observation_ids: ['o1'], excluded_observation_ids: ['o2'], excluded_terms: terms } }, 'b3');
  const previous = declared(['가']);
  const changed = declared(['나']);
  const base = ready(previous);
  const rebound = (text) => ({ ...base, semantic_decisions_sha256: sha256Hex(text), contract_repairs: [{ contract: 'scope_declaration', previous_semantic_decisions_sha256: base.semantic_decisions_sha256, semantic_decisions_sha256: sha256Hex(text) }] });
  has(validateReviewTransition(base, rebound(changed), { semanticBefore: previous, semanticAfter: changed }), 'no other authored semantic decision may change');
  assert.deepEqual(validateReviewTransition(base, rebound(declared(['가']).replace('b3', 'b4')), { semanticBefore: previous, semanticAfter: declared(['가']).replace('b3', 'b4') }), []);

  // The repair chain is provenance: it cannot be invented, dropped or rewritten by any other transition.
  const chain = repaired.contract_repairs;
  has(validateReviewTransition(null, { ...repaired, attempt: 1 }), 'cannot carry contract_repairs');
  const done = { ...repaired, status: 'complete', admission: { contract: 'lexical-factory-admission-v1' } };
  assert.deepEqual(validateReviewTransition(repaired, done), []);
  const { contract_repairs: dropped, ...withoutChain } = done;
  has(validateReviewTransition(repaired, withoutChain), 'must be preserved exactly');
  has(validateReviewTransition(repaired, { ...done, contract_repairs: [{ ...chain[0], previous_semantic_decisions_sha256: HEX('forged') }] }), 'must be preserved exactly');
  const rejected = { ...repaired, status: 'rejected', rejected_pr: 5, history: [{ attempt: 1, rejected_pr: 5 }] };
  assert.deepEqual(validateReviewTransition(repaired, rejected), []);
  has(validateReviewTransition(repaired, { ...rejected, contract_repairs: undefined }), 'must be preserved exactly');
  const rework = { ...rejected, status: 'ready', attempt: 2, rejected_pr: undefined, decisions_sha256: HEX('d2'), semantic_decisions_sha256: HEX('s2'), contract_repairs: undefined };
  assert.deepEqual(validateReviewTransition(rejected, rework), []);
  has(validateReviewTransition(rejected, { ...rework, contract_repairs: chain }), 'must not carry contract_repairs');
});
