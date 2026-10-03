import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { findRecordsBySearchTerm } from '../scripts/build/query.mjs';
import { syntheticAdapter } from '../scripts/intake/adapters/synthetic-adapter.mjs';
import { analysisInputDigest, runIntake, verifyAnalysisBinding } from '../scripts/intake/pipeline.mjs';

const METADATA = { service_version: '1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0', top_n: 3 };
const P = (lemma, pos) => ({ lemma, pos, form: lemma });
const TABLE = {
  푸르다: { status: 'ok', analyses: [[P('푸르다', 'adjective')], []] },
  바람: { status: 'ok', analyses: [[P('바람', 'noun')], []] },
  물결무늬: { status: 'ok', analyses: [[P('물결', 'noun'), P('무늬', 'noun')]] },
};
const analyzer = async (requests) => ({
  metadata: METADATA,
  results: requests.map(({ id, text }) => ({ ...(TABLE[text] ?? { status: 'unsupported', analyses: [] }), id, input_digest: analysisInputDigest(text) })),
});
// Test-fixture glosses stand in for the separate, source-bound semantic QA step.
// A hand-off without an authored fixture entry is never admitted.
const AUTHORED = {
  푸르다: '풀이나 맑은 하늘처럼 선명하게 맑은 초록이나 파랑을 띠다.',
  바람: '공기가 움직여 느껴지는 흐름.',
};

async function admitAndSearch(run, query) {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-intake-'));
  const directory = path.join(root, 'canonical');
  try {
    await mkdir(directory);
    const lines = [];
    for (const handoff of run.decisions.filter((entry) => entry.decision === 'semantic_qa')) {
      verifyAnalysisBinding(handoff, run.metadata);
      const gloss = AUTHORED[handoff.lemma];
      if (!gloss) continue;
      const id = `w9${String(lines.length + 1).padStart(4, '0')}`;
      lines.push(JSON.stringify({ id, record_type: 'entry', role: 'start', candidate_id: id, lemma: handoff.lemma, search_forms: [handoff.lemma], senses: [{ id: `${id}-s1`, pos: handoff.pos, gloss }] }));
    }
    await writeFile(path.join(directory, 'fixture.jsonl'), `${lines.join('\n')}\n`);
    const outputPath = path.join(root, 'dictionary.sqlite');
    const summary = await buildDictionary({ inputDirectory: directory, outputPath, allowDirty: true });
    const database = new DatabaseSync(outputPath, { readOnly: true });
    try {
      return { summary, found: findRecordsBySearchTerm(database, query).matches.map((match) => match.lemma) };
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('synthetic adapter reaches search with no corpus module in the import graph', async () => {
  const source = await readFile(new URL('../scripts/intake/adapters/synthetic-adapter.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /corpus/i);
  const run = await runIntake({ candidates: syntheticAdapter(['푸르다', '바람', '물결무늬']), analyzer });
  const { summary, found } = await admitAndSearch(run, '바람');
  assert.equal(summary.recordCount, 2);
  assert.deepEqual(found, ['바람']);
});

