import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { reviewedRelationId } from '../batch/authored-semantic-decision-source.mjs';
import { applyBackfill } from './backfill-apply.mjs';
import { newQueueState } from './backfill-queue.mjs';
import { buildRelationIndex } from './candidate-retrieval.mjs';
import { loadCanonicalContext } from '../validate/canonical-context.mjs';
import { sha256Json } from '../validate/semantic-audit.mjs';

// Historical Issue #211/#220 admission validators through their real entry points: a legal relation-only backfill of
// an admitted record must pass them, and a rewrite of the admitted record must still be rejected. The scratch copy of
// the repository is the only thing written; the repository itself is never touched.

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMPORTS = {
  211: 'data/canonical/issue-211-bounded-recovery.jsonl',
  220: 'data/canonical/issue-220-m9-b-batch-01.jsonl',
};
const VALIDATORS = { 211: 'scripts/batch/validate-issue-211.mjs', 220: 'scripts/batch/validate-issue-220.mjs' };

async function scratchRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'historical-enrichment-'));
  for (const dir of ['data', 'scripts', 'docs', 'schema', 'src']) {
    await cp(path.join(REPO, dir), path.join(root, dir), { recursive: true, mode: constants.COPYFILE_FICLONE });
  }
  await cp(path.join(REPO, 'package.json'), path.join(root, 'package.json'));
  await symlink(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'));
  // The validators bind the source revision, so the copy needs a Git HEAD (its content stays untracked).
  const git = (...args) => run('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: root });
  await git('init', '-q');
  await git('commit', '-q', '--allow-empty', '-m', 'scratch');
  return root;
}

const firstRecord = async (root, issue) => JSON.parse((await readFile(path.join(root, IMPORTS[issue]), 'utf8')).split('\n').find(Boolean));

// The validators check the committed reports against the current canonical, so each run rewrites them in the scratch copy.
const validate = (root, issue) => run(process.execPath, [VALIDATORS[issue], '--write-report'], { cwd: root, maxBuffer: 1 << 26 });

function approval(index, source, target) {
  const relation = { target: target.record_id, target_sense: target.sense_id, type: 'association', note: '회귀 시험용 연상이다.', relevance: 5 };
  return {
    outcome: 'relations-reviewed', gloss_sha256: sha256Json(source.gloss), rationale: 'x', relation_count: 1,
    approved_relations: [{ relation_id: reviewedRelationId(source.sense_id, relation), relation, rationale: `${source.record_id} ${source.sense_id}: 회귀 시험용 근거.` }],
    reviewed_candidates: [{ id: target.sense_id, meaning_sha256: sha256Json([target.lemma, target.gloss]) }],
  };
}

test('relation-only backfills of admitted Issue #211 and #220 records pass the historical validators, and a rewrite of the admission does not', { timeout: 1_800_000 }, async () => {
  const canonical = await loadCanonicalContext();
  const index = buildRelationIndex(canonical);
  const root = await scratchRepository();
  try {
    const state = newQueueState(canonical.canonicalRevision);
    const admitted = [];
    for (const issue of [211, 220]) {
      const record = await firstRecord(root, issue);
      assert.deepEqual(record.senses.flatMap((sense) => sense.relations ?? []), [], `the Issue #${issue} admission carries no relations`);
      const source = index.senses.find((sense) => sense.record_id === record.id);
      const target = index.senses.find((sense) => sense.record_id !== record.id && !source.relations.some((relation) => relation.target_sense === sense.sense_id));
      state.done[source.sense_id] = approval(index, source, target);
      admitted.push({ issue, record });
    }
    assert.equal((await applyBackfill({ root, state, index, refreshReports: false })).status, 'applied');
    for (const { issue, record } of admitted) {
      const enriched = await firstRecord(root, issue);
      assert.equal(enriched.id, record.id);
      assert.ok(enriched.senses.some((sense) => (sense.relations ?? []).length > 0), `the backfill reached the Issue #${issue} import`);
      await validate(root, issue);
    }

    // The admitted gloss is bound: rewriting it is not a relation-only enrichment, whatever else was appended.
    const importPath = path.join(root, IMPORTS[220]);
    const lines = (await readFile(importPath, 'utf8')).split('\n');
    const tampered = JSON.parse(lines[0]);
    tampered.senses[0].gloss = `${tampered.senses[0].gloss} 변조`;
    lines[0] = JSON.stringify(tampered);
    await writeFile(importPath, lines.join('\n'));
    await assert.rejects(validate(root, 220));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
