import assert from 'node:assert/strict';
import test from 'node:test';

import { logicalDatabaseContentSnapshot } from '../scripts/batch/validate-issue-219.mjs';
import { sha256Json } from '../scripts/validate/semantic-audit.mjs';

function snapshot({ lemma = '컨테이너 야드', nodeVersion = 'v24.0.0', sqliteVersion = '3.48.0', revision = 'a'.repeat(40) } = {}) {
  return {
    schema: [{ type: 'table', name: 'records', tbl_name: 'records', sql: 'CREATE TABLE records (id TEXT, lemma TEXT)' }],
    indexes: [],
    rows: {
      metadata: [
        { key: 'dictionary_version', value: '1' },
        { key: 'source_revision', value: revision },
        { key: 'source_revision_source', value: 'git-head' },
        { key: 'source_revision_verified', value: 'true' },
        { key: 'worktree_state', value: 'clean' },
        { key: 'node_version', value: nodeVersion },
        { key: 'sqlite_module', value: 'node:sqlite' },
        { key: 'sqlite_version', value: sqliteVersion },
      ],
      records: [{ id: 'w4701', lemma }],
      search_forms: [{ record_id: 'w4701', position: 0, form: lemma }],
      senses: [{ id: 'w4701-s1', record_id: 'w4701', position: 0, pos: 'expression', gloss: '물류 컨테이너를 두는 구역.' }],
      relations: [],
      generated_surface_forms: [],
    },
  };
}

test('Issue #219 content digest ignores build and execution environment metadata but binds logical rows', () => {
  const first = snapshot();
  const otherEnvironment = snapshot({
    nodeVersion: 'v25.1.0',
    sqliteVersion: '3.49.1',
    revision: 'b'.repeat(40),
  });
  const firstContent = logicalDatabaseContentSnapshot(first);
  const otherContent = logicalDatabaseContentSnapshot(otherEnvironment);

  assert.deepEqual(firstContent, otherContent);
  assert.equal(sha256Json(firstContent), sha256Json(otherContent));

  const changedLogicalContent = logicalDatabaseContentSnapshot(snapshot({ lemma: '철도 차량기지' }));
  assert.notEqual(sha256Json(firstContent), sha256Json(changedLogicalContent));
  assert.equal(first.rows.metadata.some(({ key }) => key === 'sqlite_version'), true, 'the raw reproducibility snapshot retains environment evidence');
});
