import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Manual audit-coverage regression. Run directly with:
// node --test scripts/meaning/issue-764-c17-residual-audit.test.mjs
// This checks evidence coverage and source binding; it does not automate lexical judgments.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const meaningDir = path.join(root, 'data/meanings');
const canonicalDir = path.join(root, 'data/canonical');
const meaningFiles = readdirSync(meaningDir).filter((file) => /^c17_\d+\.jsonl$/u.test(file)).sort();
const rows = meaningFiles.flatMap((file) => readFileSync(path.join(meaningDir, file), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line)));
const rowsByLemma = new Map();
for (const row of rows) {
  const list = rowsByLemma.get(row.lemma) ?? [];
  list.push(row);
  rowsByLemma.set(row.lemma, list);
}
const residualByLemma = new Map([...rowsByLemma].filter(([, list]) => list.length > 1));
const expectedSenseIds = new Set([...residualByLemma.values()].flatMap((list) => list.flatMap((row) => row.sense_ids)));
const sourceGlossBySense = new Map();
for (const file of readdirSync(canonicalDir).filter((name) => name.startsWith('stdict-') && name.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(path.join(canonicalDir, file), 'utf8').split('\n')) {
    if (!line) continue;
    const entry = JSON.parse(line);
    for (const sense of entry.senses ?? []) {
      if (expectedSenseIds.has(sense.id)) sourceGlossBySense.set(sense.id, sense.gloss);
    }
  }
}

const auditPath = path.join(root, 'scripts/meaning/issue-764-c17-residual-audit.md');
const audit = readFileSync(auditPath, 'utf8');
const auditRows = audit.split('\n## 후보 검토 후 하나의 Meaning으로 유지한 기존 다중-sense 항목')[0];
const short = (value, max) => {
  const text = String(value).replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const senseIdsIn = (text) => [...text.matchAll(/`(w\d+-s\d+)`/gu)].map((match) => match[1]);
const meaningIdsIn = (text) => [...text.matchAll(/`(m\d+(?:_\d+)?)`/gu)].map((match) => match[1]);

test('C17 residual audit covers every retained Meaning with complete bound-source reasons', () => {
  assert.equal(sourceGlossBySense.size, expectedSenseIds.size, 'every residual source sense must resolve in canonical');
  const expectedLemmas = [...residualByLemma.keys()].sort((a, b) => a.localeCompare(b, 'ko'));
  const headings = [...auditRows.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(headings, expectedLemmas, 'audit must list every and only residual multi-Meaning lemma');
  assert.match(audit, new RegExp(`최종적으로 여러 Meaning을 유지한 ${residualByLemma.size.toLocaleString('en-US')}개 lemma`));

  const seenMeaningIds = [];
  for (let index = 0; index < headings.length; index += 1) {
    const lemma = headings[index];
    const start = auditRows.indexOf(`## ${lemma}\n`);
    const nextHeading = index + 1 < headings.length ? auditRows.indexOf(`## ${headings[index + 1]}\n`, start + 1) : auditRows.length;
    const section = auditRows.slice(start, nextHeading);
    const expectedRows = residualByLemma.get(lemma);
    const entryLines = [...section.matchAll(/^- `(m\d+(?:_\d+)?)` \(([^)]*)\)$/gmu)];
    assert.equal(entryLines.length, expectedRows.length, `${lemma}: every output Meaning needs one audit row`);
    assert.match(section, /^근거 기준: 주 에이전트 source-bound 자체 점검 — .+$/mu, `${lemma}: group-level boundary rationale`);

    const boundTextBySense = new Map();
    const parsedReasons = [];
    for (let rowIndex = 0; rowIndex < expectedRows.length; rowIndex += 1) {
      const row = expectedRows[rowIndex];
      const entry = entryLines[rowIndex];
      const [fullLine, meaningId, renderedSenseIds] = entry;
      seenMeaningIds.push(meaningId);
      assert.equal(meaningId, row.id, `${lemma}: Meaning row order and ID`);
      assert.deepEqual(renderedSenseIds.split(', '), row.sense_ids, `${lemma}/${meaningId}: rendered bound sense IDs`);

      const lineStart = section.indexOf(fullLine);
      const followingLine = section.slice(lineStart + fullLine.length).split('\n')[1];
      assert.ok(followingLine?.startsWith('  - 근거: bound — '), `${lemma}/${meaningId}: reason must immediately follow its Meaning row`);
      const boundMarker = '  - 근거: bound — ';
      const compareMarker = '; compare — ';
      const conclusionMarker = '; conclusion — ';
      const compareAt = followingLine.indexOf(compareMarker);
      const conclusionAt = followingLine.indexOf(conclusionMarker);
      assert.ok(compareAt > boundMarker.length && conclusionAt > compareAt, `${lemma}/${meaningId}: reason needs bound, compare, and conclusion sections`);
      const boundEvidence = followingLine.slice(boundMarker.length, compareAt);
      const compareEvidence = followingLine.slice(compareAt + compareMarker.length, conclusionAt);
      const conclusion = followingLine.slice(conclusionAt + conclusionMarker.length).trim();
      assert.ok(conclusion.length > 0, `${lemma}/${meaningId}: row-specific disposition is required`);

      assert.deepEqual(senseIdsIn(boundEvidence), row.sense_ids, `${lemma}/${meaningId}: own bound sources must be complete and ordered`);
      for (const senseId of row.sense_ids) {
        assert.ok(boundEvidence.includes(short(sourceGlossBySense.get(senseId), 90)), `${lemma}/${meaningId}: bound source gloss ${senseId}`);
        boundTextBySense.set(senseId, boundEvidence);
      }

      const otherRows = expectedRows.filter((other) => other.id !== row.id);
      assert.deepEqual(meaningIdsIn(compareEvidence), otherRows.map((other) => other.id), `${lemma}/${meaningId}: every competing Meaning must be compared`);
      assert.deepEqual(senseIdsIn(compareEvidence), otherRows.flatMap((other) => other.sense_ids), `${lemma}/${meaningId}: every competing source sense must be compared`);
      parsedReasons.push({ meaningId, otherRows, compareEvidence });
    }
    for (const { meaningId, otherRows, compareEvidence } of parsedReasons) {
      for (const senseId of otherRows.flatMap((other) => other.sense_ids)) {
        assert.ok(boundTextBySense.has(senseId), `${lemma}/${meaningId}: comparison source ${senseId} needs its own bound row`);
        assert.ok(boundTextBySense.get(senseId).includes(short(sourceGlossBySense.get(senseId), 90)), `${lemma}/${meaningId}: comparison source gloss ${senseId}`);
        assert.ok(compareEvidence.includes(`\`${senseId}\``), `${lemma}/${meaningId}: comparison cites source ID ${senseId}`);
      }
    }
  }
  assert.equal(new Set(seenMeaningIds).size, seenMeaningIds.length, 'a retained Meaning must appear only once');
  assert.deepEqual(seenMeaningIds.sort(), [...residualByLemma.values()].flat().map((row) => row.id).sort(), 'audit/output Meaning ID sets');
});
