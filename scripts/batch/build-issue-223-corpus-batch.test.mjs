import assert from 'node:assert/strict';
import test from 'node:test';

import { bindAuthoredParagraphReferences } from './build-issue-223-corpus-batch.mjs';

test('Issue #223 authored paragraph hit indexes bind to source paragraph IDs', () => {
  const hits = [
    { paragraph_id: 'document.1' },
    { paragraph_id: 'document.2' },
    { paragraph_id: 'document.3' },
  ];

  assert.deepEqual(bindAuthoredParagraphReferences(hits, [2, 0]), ['document.3', 'document.1']);
  assert.deepEqual(bindAuthoredParagraphReferences(hits, ['document.2']), ['document.2']);
  assert.deepEqual(bindAuthoredParagraphReferences(hits), ['document.1', 'document.2', 'document.3']);
});

test('Issue #223 authored paragraph hit indexes must stay within bounded evidence', () => {
  assert.throws(() => bindAuthoredParagraphReferences([{ paragraph_id: 'document.1' }], [1]));
  assert.throws(() => bindAuthoredParagraphReferences([{ paragraph_id: 'document.1' }], [-1]));
});
