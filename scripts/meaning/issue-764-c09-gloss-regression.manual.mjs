import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyEdits } from './apply-edits.mjs';
import { validateMeaningDataset } from './contract.mjs';
import { projectInitialMeanings, readCanonicalEntries } from './initial.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'scripts/meaning/issue-764-c09.json'), 'utf8'));
const entries = readCanonicalEntries(path.join(root, 'data/canonical'));
const senseSource = new Map(entries.flatMap((entry) => (entry.senses ?? []).map((sense) => [
  sense.id,
  { lemma: entry.lemma, gloss: sense.gloss },
])));
const scopeSenseIds = spec.repartitions.flatMap((item) => item.before.flatMap((row) => row.sense_ids));
const scopeSenseSet = new Set(scopeSenseIds);
const scopeSenses = new Map([...scopeSenseSet].map((id) => [id, { lemma: senseSource.get(id)?.lemma }]));
const sourceRows = spec.repartitions.flatMap((item) => item.before.map((row) => ({ ...row, lemma: item.lemma })));
const initialMeaningIds = new Map(projectInitialMeanings(entries).flatMap((row) => row.sense_ids.map((id) => [id, row.id])));

const sourceBoundSignals = [
  {
    name: 'slang register',
    source: /속되게/u,
    output: /속되게/u,
    strip: /속되게/gu,
  },
  {
    name: 'derogatory register',
    source: /낮잡아/u,
    output: /낮잡아/u,
    strip: /낮잡아/gu,
  },
  {
    name: 'teasing register',
    source: /놀림조로/u,
    output: /놀림조/u,
    strip: /놀림조로|놀림조/gu,
  },
  {
    name: 'everyday register',
    source: /일상적으로/u,
    output: /일상적으로/u,
    strip: /일상적으로/gu,
  },
  {
    name: 'mocking facial action',
    source: /비웃거나/u,
    output: /비웃/u,
    strip: /비웃\w*/gu,
  },
  {
    name: 'displeased facial action',
    source: /언짢거나/u,
    output: /언짢/u,
    strip: /언짢\w*/gu,
  },
  {
    name: 'tearful facial action',
    source: /울려고/u,
    output: /울려|울려고/u,
    strip: /울려|울려고/gu,
  },
  {
    name: 'figurative usage',
    source: /비유적으로/u,
    output: /비유적|빗대어/u,
    strip: /비유적으로|비유적|빗대어/gu,
  },
  {
    name: 'disapproving auxiliary use',
    source: /앞말이 뜻하는 성질이나 상태가 아주 심한 것을 못마땅하게 여김/u,
    output: /앞말이 뜻하는[^.]{0,100}못마땅하게 여기/u,
    strip: /앞말이 뜻하는|못마땅하게 여기\w*/gu,
  },
  {
    name: 'emphasized source usages',
    source: /강조하여 이르는 말/u,
    output: /강조(?:하여|해) 이르는 말/u,
    strip: /강조(?:하여|해) 이르는 말/gu,
  },
  {
    name: 'being deceived',
    source: /그럴듯한 말이나 꾐에 속아 넘어가다/u,
    output: /그럴듯한 말이나 꾐에 속아 넘어가/u,
    strip: /그럴듯한 말이나 꾐에 속아 넘어가/gu,
  },
  {
    name: 'being absorbed and unable to get free',
    source: /정신이 아주 쏠리어 헤어나지 못하다/u,
    output: /정신이 아주 쏠려 헤어나지 못하/u,
    strip: /정신이 아주 쏠려 헤어나지 못하/gu,
  },
];

function missingSignals(meanings) {
  const missing = [];
  for (const meaning of meanings) {
    if (meaning.sense_ids.length < 2) continue;
    const sources = meaning.sense_ids.map((id) => senseSource.get(id)).filter(Boolean);
    for (const signal of sourceBoundSignals) {
      const matching = sources.filter((source) => signal.source.test(source.gloss));
      if (matching.length && !signal.output.test(meaning.gloss)) {
        missing.push({ meaningId: meaning.id, sourceIds: meaning.sense_ids, signal: signal.name });
      }
    }
  }
  return missing;
}

test('C09 exact edit replay preserves source-bound semantic features and detects a lossy output', () => {
  assert.equal(scopeSenseSet.size, 3081, 'the edit spec must cover all C09 canonical senses');
  assert.equal(scopeSenseIds.length, scopeSenseSet.size, 'the exact before snapshots must not duplicate senses');
  assert.ok([...scopeSenseSet].every((id) => senseSource.has(id)), 'every C09 source sense must resolve');

  const replayed = applyEdits({ meanings: sourceRows, adjudications: [], initialMeaningIds }, spec);
  assert.deepEqual(validateMeaningDataset({
    meanings: replayed.meanings,
    adjudications: [],
    senses: scopeSenses,
    complete: true,
  }), []);

  const committedRows = ['c09_001.jsonl', 'c09_002.jsonl', 'c09_003.jsonl', 'c09_004.jsonl']
    .flatMap((file) => fs.readFileSync(path.join(root, 'data/meanings', file), 'utf8')
      .trimEnd().split('\n').map((line) => JSON.parse(line)));
  const byId = (rows) => rows.map((row) => [row.id, row.lemma, row.gloss, row.sense_ids]);
  assert.deepEqual(
    byId(replayed.meanings).sort(([a], [b]) => a.localeCompare(b)),
    byId(committedRows).sort(([a], [b]) => a.localeCompare(b)),
    'the production edit replay must reproduce the four committed C09 shards',
  );

  assert.deepEqual(missingSignals(replayed.meanings), [], 'source-bound register, affect, figurative and lexical-use signals must survive the merge gloss');

  const degraded = replayed.meanings.map((meaning) => {
    const matchingSources = meaning.sense_ids.map((id) => senseSource.get(id)).filter(Boolean);
    const signalsToRemove = sourceBoundSignals.filter((signal) => matchingSources.some((source) => signal.source.test(source.gloss)));
    return signalsToRemove.length
      ? { ...meaning, gloss: signalsToRemove.reduce((gloss, signal) => gloss.replace(signal.strip, ''), meaning.gloss) }
      : meaning;
  });
  assert.ok(missingSignals(degraded).length > 0, 'the negative control must detect dropped source-bound semantic information');
});
