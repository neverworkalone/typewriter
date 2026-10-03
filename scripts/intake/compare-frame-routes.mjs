// Local comparison of the handwritten frame rule (frameUsesLemma) against the
// shared Kiwi route on labelled cases plus real verb/adjective frames mined
// from reviewed batch decisions. Requires a local kiwipiepy (TYPEWRITER_PYTHON).
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { frameUsesLemma } from '../batch/semantic-self-check.mjs';
import { analyzeFrames } from './frame-analysis.mjs';
import { createKiwiAnalyzer } from './kiwi-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function minedFrames() {
  const directory = path.join(ROOT, 'data/batches');
  const items = [];
  for (const name of (await readdir(directory)).filter((file) => file.endsWith('semantic-decisions.json')).sort()) {
    const document = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
    const records = new Map(document.candidate_records.map((record) => [record.id, record]));
    for (const decision of document.decisions) {
      const record = records.get(decision.candidate_record_id);
      const pos = record?.senses?.[0]?.pos;
      if (!record || !['verb', 'adjective'].includes(pos) || !record.lemma.endsWith('다')) continue;
      for (const review of decision.sense_reviews ?? []) {
        for (const observation of review.single_sense_boundary_review?.frame_observations ?? []) {
          items.push({ frame: observation.sentence_frame, lemma: record.lemma, pos, source: name });
        }
      }
    }
  }
  return items;
}

const labelled = JSON.parse(await readFile(path.join(ROOT, 'tests/fixtures/intake-frame-cases.json'), 'utf8'));
const analyzer = createKiwiAnalyzer();
const labelledResults = await analyzeFrames(analyzer, labelled);
const matrix = { regexAccepts: { validKept: 0, invalidAccepted: 0, validRejected: 0, invalidRejected: 0 }, kiwi: { validKept: 0, invalidAccepted: 0, validRejected: 0, invalidRejected: 0, validAmbiguous: 0, invalidAmbiguous: 0 } };
const disagreements = [];
for (const item of labelledResults) {
  const regex = frameUsesLemma(item.frame, item.lemma, item.pos);
  const key = (accepted) => (item.valid ? (accepted ? 'validKept' : 'validRejected') : accepted ? 'invalidAccepted' : 'invalidRejected');
  matrix.regexAccepts[key(regex)] += 1;
  if (item.verdict === 'ambiguous') matrix.kiwi[item.valid ? 'validAmbiguous' : 'invalidAmbiguous'] += 1;
  else matrix.kiwi[key(item.verdict === 'uses')] += 1;
  if (regex !== (item.verdict === 'uses')) disagreements.push({ frame: item.frame, lemma: item.lemma, valid: item.valid, regex, kiwi: item.verdict });
}

const mined = await minedFrames();
const minedResults = await analyzeFrames(analyzer, mined);
const minedCounts = { total: mined.length, regexAcceptKiwiUses: 0, regexAcceptKiwiOther: {}, regexRejectKiwiUses: 0 };
const minedDisagreements = [];
const regexRejected = [];
for (const item of minedResults) {
  const regex = frameUsesLemma(item.frame, item.lemma, item.pos);
  if (regex && item.verdict === 'uses') minedCounts.regexAcceptKiwiUses += 1;
  else if (regex) {
    minedCounts.regexAcceptKiwiOther[item.verdict] = (minedCounts.regexAcceptKiwiOther[item.verdict] ?? 0) + 1;
    minedDisagreements.push({ frame: item.frame, lemma: item.lemma, kiwi: item.verdict });
  } else if (item.verdict === 'uses') {
    minedCounts.regexRejectKiwiUses += 1;
    regexRejected.push({ frame: item.frame, lemma: item.lemma });
  }
}
console.log(JSON.stringify({ labelledTotal: labelled.length, matrix, disagreements, minedCounts, minedDisagreements: minedDisagreements.slice(0, 40), regexRejected }, null, 2));
