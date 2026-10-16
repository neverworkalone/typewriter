import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { MEANING_INTEGRITY_QUERIES } from '../src/runtime/dictionary-contract.js';
import { compareMeaningRank } from '../src/runtime/meaning-ranking.js';

// The build orders meanings with compareMeaningRank; the shared SQLite validator must accept exactly that order.
const BIG = '9'.repeat(30);
const CASES = {
  'leading zeros m09 vs m9': ['m09', 'm9'],
  'ordinal beyond a packed key m1_1000001 vs m2': ['m1_1000001', 'm2'],
  'ordinary m9 vs m10': ['m9', 'm10'],
  'beyond 2^53 m99.. vs m100..': [`m${BIG}`, `m1${'0'.repeat(30)}`],
  'ordinal vs lone and zero padding': ['m007', 'm07_1', 'm7_2', 'm7', 'm0007'],
  'unbounded ordinals': ['m5_9', `m5_1${'0'.repeat(25)}`, 'm5_10'],
};

function rankViolations(rows) {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`CREATE TABLE meanings (
      id TEXT PRIMARY KEY, lexical_relation_count INTEGER, exploratory_relation_count INTEGER, display_rank INTEGER UNIQUE)`);
    const insert = database.prepare('INSERT INTO meanings VALUES (?, ?, ?, ?)');
    rows.forEach((row, index) => insert.run(row.id, row.lexical_relation_count, row.exploratory_relation_count, index + 1));
    return Number(Object.values(database.prepare(MEANING_INTEGRITY_QUERIES.meaning_rank_order_violation).get())[0]);
  } finally {
    database.close();
  }
}

for (const [name, ids] of Object.entries(CASES)) {
  test(`meaning rank order: producer and SQLite validator agree (${name})`, () => {
    const meanings = ids.map((id) => ({ id, lexical_relation_count: 0, exploratory_relation_count: 0 }));
    const forward = [...meanings].sort(compareMeaningRank);
    const reverse = [...meanings].reverse().sort(compareMeaningRank);
    // Deterministic regardless of input order, and accepted by the validator.
    assert.deepEqual(forward.map(({ id }) => id), reverse.map(({ id }) => id));
    assert.equal(rankViolations(forward), 0);
    // Any adjacent swap breaks the total order and is rejected (every pair of distinct IDs is strictly ordered).
    for (let index = 0; index + 1 < forward.length; index += 1) {
      const swapped = [...forward];
      [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
      assert.ok(rankViolations(swapped) > 0, `${name}: swap at ${index}`);
    }
  });
}

test('meaning rank order: counts still dominate the ID and wrong counts are rejected', () => {
  const rows = [
    { id: 'm9', lexical_relation_count: 1, exploratory_relation_count: 0 },
    { id: 'm1', lexical_relation_count: 0, exploratory_relation_count: 3 },
    { id: 'm2', lexical_relation_count: 0, exploratory_relation_count: 3 },
    { id: 'm3', lexical_relation_count: 0, exploratory_relation_count: 0 },
  ];
  assert.deepEqual([...rows].reverse().sort(compareMeaningRank).map(({ id }) => id), ['m9', 'm1', 'm2', 'm3']);
  assert.equal(rankViolations(rows), 0);
  assert.ok(rankViolations([rows[1], rows[0], rows[2], rows[3]]) > 0);
  assert.ok(rankViolations([rows[0], rows[2], rows[1], rows[3]]) > 0);
});
