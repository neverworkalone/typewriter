import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runReviewerTrustGate } from '../scripts/ci/reviewer-trust-gate.mjs';
import { evaluateReviewerTrust, parseReviewerRegistry } from '../scripts/validate/reviewer-trust.mjs';

const registry = (...ids) => ({ schema_version: 1, reviewers: ids.map((id) => ({ id, kind: 'agent' })) });
const input = (path_, reviewer, candidateAuthor = 'author-x') => ({
  path: path_, input: { reviewer }, candidateAuthor,
});

test('a producer-added reviewer alias cannot be used by the change that adds it', () => {
  // The producer adds a new reviewer entry and a review input naming it, with
  // two distinct self-declared identities. Trust comes from the base only.
  const result = evaluateReviewerTrust({
    baseRegistry: registry('trusted-a'),
    headRegistry: registry('trusted-a', 'producer-alias'),
    changedInputs: [input('data/batches/x-semantic-review-input.json', 'producer-alias', 'producer')],
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /not trusted on the base branch \(added to the registry by this same change\)/u);
});

test('a reviewer already trusted on the base passes and may differ from the candidate author', () => {
  const result = evaluateReviewerTrust({
    baseRegistry: registry('trusted-a'),
    headRegistry: registry('trusted-a', 'added-for-later'),
    changedInputs: [input('data/batches/x-semantic-review-input.json', 'trusted-a')],
  });
  assert.deepEqual(result, { ok: true, failures: [] });
});

test('self-review fails even for a trusted reviewer, regardless of case and spacing', () => {
  for (const author of ['trusted-a', ' Trusted-A ']) {
    const result = evaluateReviewerTrust({
      baseRegistry: registry('trusted-a'),
      headRegistry: registry('trusted-a'),
      changedInputs: [input('data/batches/x-semantic-review-input.json', 'trusted-a', author)],
    });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /self-review/u);
  }
});

test('base reviewers are immutable: removal, rewrite, and registry deletion fail', () => {
  const base = registry('trusted-a', 'trusted-b');
  assert.match(evaluateReviewerTrust({ baseRegistry: base, headRegistry: registry('trusted-a'), changedInputs: [] }).failures.join(), /removes trusted reviewer trusted-b/u);
  const rewritten = { schema_version: 1, reviewers: [{ id: 'trusted-a', kind: 'human' }, { id: 'trusted-b', kind: 'agent' }] };
  assert.match(evaluateReviewerTrust({ baseRegistry: base, headRegistry: rewritten, changedInputs: [] }).failures.join(), /rewrites trusted reviewer trusted-a/u);
  assert.match(evaluateReviewerTrust({ baseRegistry: base, headRegistry: null, changedInputs: [] }).failures.join(), /deletes the reviewer registry/u);
});

test('bootstrapping the registry is allowed only when no review input uses it', () => {
  assert.equal(evaluateReviewerTrust({ baseRegistry: null, headRegistry: registry('trusted-a'), changedInputs: [] }).ok, true);
  const used = evaluateReviewerTrust({
    baseRegistry: null,
    headRegistry: registry('trusted-a'),
    changedInputs: [input('data/batches/x-semantic-review-input.json', 'trusted-a')],
  });
  assert.equal(used.ok, false);
  assert.match(used.failures.join(), /base branch has no reviewer registry/u);
});

test('malformed registries and inputs fail closed', () => {
  assert.throws(() => parseReviewerRegistry({ schema_version: 2, reviewers: [{ id: 'a' }] }));
  assert.throws(() => parseReviewerRegistry({ schema_version: 1, reviewers: [] }));
  assert.throws(() => parseReviewerRegistry({ schema_version: 1, reviewers: [{ id: 'a' }, { id: 'A' }] }));
  assert.throws(() => parseReviewerRegistry({ schema_version: 1, reviewers: [{ id: '' }] }));
  const nameless = evaluateReviewerTrust({
    baseRegistry: registry('a'), headRegistry: registry('a'),
    changedInputs: [{ path: 'data/batches/x-semantic-review-input.json', input: {}, candidateAuthor: 'p' }],
  });
  assert.match(nameless.failures.join(), /names no reviewer/u);
  const noAuthor = evaluateReviewerTrust({
    baseRegistry: registry('a'), headRegistry: registry('a'),
    changedInputs: [{ path: 'data/batches/x-semantic-review-input.json', input: { reviewer: 'a' }, candidateAuthor: undefined }],
  });
  assert.match(noAuthor.failures.join(), /no candidate-review author/u);
});

async function writeTree(root, { registryJson, files = {} }) {
  await mkdir(path.join(root, 'config'), { recursive: true });
  await mkdir(path.join(root, 'data/batches'), { recursive: true });
  if (registryJson !== undefined) await writeFile(path.join(root, 'config/semantic-reviewers.json'), JSON.stringify(registryJson));
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(root, 'data/batches', name), JSON.stringify(value));
  }
}

test('gate reads the head as data, skips unchanged inputs, and judges changed ones from the base registry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-trust-'));
  try {
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    const oldInput = { reviewer: 'trusted-a' };
    const oldCandidate = { reviewer: 'author-x' };
    await writeTree(base, {
      registryJson: registry('trusted-a'),
      files: { 'old-semantic-review-input.json': oldInput, 'old-candidate-review.json': oldCandidate },
    });

    // Producer adds its own alias and a batch that uses it.
    await writeTree(head, {
      registryJson: registry('trusted-a', 'producer-alias'),
      files: {
        'old-semantic-review-input.json': oldInput,
        'old-candidate-review.json': oldCandidate,
        'new-semantic-review-input.json': { reviewer: 'producer-alias' },
        'new-candidate-review.json': { reviewer: 'producer' },
      },
    });
    const forged = await runReviewerTrustGate({ baseDirectory: base, headDirectory: head });
    assert.equal(forged.ok, false);
    assert.equal(forged.evaluated_input_count, 1);
    assert.match(forged.failures.join(), /producer-alias/u);

    // The same batch with an already-trusted reviewer passes.
    await writeTree(head, {
      registryJson: registry('trusted-a'),
      files: {
        'old-semantic-review-input.json': oldInput,
        'old-candidate-review.json': oldCandidate,
        'new-semantic-review-input.json': { reviewer: 'trusted-a' },
        'new-candidate-review.json': { reviewer: 'producer' },
      },
    });
    const honest = await runReviewerTrustGate({ baseDirectory: base, headDirectory: head });
    assert.deepEqual({ ok: honest.ok, count: honest.evaluated_input_count }, { ok: true, count: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
