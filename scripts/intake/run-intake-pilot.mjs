// Local pilot for issue #249: CorpusAdapter → common intake → real Kiwi, and a
// corpus-disabled synthetic path through the same stages. Output goes to an
// ignored local directory; nothing here is committed or admitted.
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { corpusAdapter } from './adapters/corpus-adapter.mjs';
import { syntheticAdapter } from './adapters/synthetic-adapter.mjs';
import { createKiwiAnalyzer } from './kiwi-client.mjs';
import { runIntake, verifyAnalysisBinding } from './pipeline.mjs';
import { assertWithinDirectory, resolveTypewriterCachePaths } from '../typewriter-cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE_PATHS = resolveTypewriterCachePaths();
const OUTPUT = path.join(CACHE_PATHS.runs, 'issue-249-pilot');
const PILOT_INVENTORY = path.join(CACHE_PATHS.runs, 'issue-201-pilot', 'pilot-inventory.json');

assertWithinDirectory(CACHE_PATHS.root, OUTPUT, { label: 'Intake pilot output' });
await mkdir(path.dirname(OUTPUT), { recursive: true });
try {
  await lstat(OUTPUT);
  throw new Error(`Intake pilot output already exists: ${OUTPUT}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

async function canonicalLemmas() {
  const directory = path.join(ROOT, 'data/canonical');
  const lemmas = new Set();
  for (const name of (await readdir(directory)).filter((file) => file.endsWith('.jsonl'))) {
    for (const line of (await readFile(path.join(directory, name), 'utf8')).split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.lemma) lemmas.add(record.lemma.normalize('NFC'));
    }
  }
  return lemmas;
}

function summarize(run, elapsedMs) {
  const counts = {};
  for (const decision of run.decisions) {
    const key = decision.decision === 'hold' ? `hold:${decision.holds.join('+')}` : decision.decision;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { total: run.decisions.length, counts, elapsedMs, analyzerDigest: run.analyzerDigest };
}

const analyzer = createKiwiAnalyzer();
const coveredLemmas = await canonicalLemmas();
const report = {};

const selection = JSON.parse(await readFile(PILOT_INVENTORY, 'utf8'));
let started = performance.now();
const corpusRun = await runIntake({ candidates: corpusAdapter(selection), analyzer, coveredLemmas });
report.corpusPath = summarize(corpusRun, Math.round(performance.now() - started));
for (const decision of corpusRun.decisions.filter((entry) => entry.decision === 'semantic_qa')) {
  verifyAnalysisBinding(decision, corpusRun.metadata);
}
// Disagreements with the pilot's own one-best proposal are the interesting cases.
const proposed = new Map(selection.candidates.map((candidate) => [candidate.proposed_lemma, candidate.proposed_pos]));
report.corpusPath.posDisagreements = corpusRun.decisions
  .filter((decision) => decision.holds?.includes('pos_mismatch'))
  .map((decision) => ({ lemma: decision.input, pilotPos: proposed.get(decision.input), kiwiPos: decision.proposedPos }));

// Compare with the pilot's own one-best triage for the same candidates.
const pilotState = new Map(selection.candidates.map((candidate) => [candidate.proposed_lemma, `${candidate.decision_state}/${candidate.ambiguity_status}`]));
report.corpusPath.pilotTriageVsShared = {};
for (const decision of corpusRun.decisions) {
  const key = `${pilotState.get(decision.input)} -> ${decision.decision === 'hold' ? `hold:${decision.holds.join('+')}` : decision.decision}`;
  report.corpusPath.pilotTriageVsShared[key] = (report.corpusPath.pilotTriageVsShared[key] ?? 0) + 1;
}

const SYNTHETIC = [
  '푸르다', '덥다', '걷다', '돕다', '가볍다', '깨닫다', '시원하다', '망각하다', '바람', '눈', '하늘',
  '물결무늬', '쌀쌀맞다', '낯설다', '없는말', '샅샅이', '아', '푸르러',
  { word: '바람', pos: 'verb' }, { word: '눈', pos: 'noun' }, { word: '살다', pos: 'verb' }, { word: '사다', pos: 'verb' },
];
started = performance.now();
const syntheticRun = await runIntake({ candidates: syntheticAdapter(SYNTHETIC), analyzer, coveredLemmas: new Set() });
report.syntheticCorpusDisabledPath = {
  ...summarize(syntheticRun, Math.round(performance.now() - started)),
  decisions: syntheticRun.decisions.map(({ key, adapterIds, analysisBinding, ...rest }) => rest),
};

await mkdir(OUTPUT);
try {
  await writeFile(path.join(OUTPUT, 'pilot-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
} catch (error) {
  await rm(OUTPUT, { recursive: true, force: true });
  throw error;
}
console.log(JSON.stringify(report, null, 2));
