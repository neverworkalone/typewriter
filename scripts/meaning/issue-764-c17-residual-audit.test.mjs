import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Manual audit-coverage regression. Run directly with:
// node --test scripts/meaning/issue-764-c17-residual-audit.test.mjs
// This checks evidence coverage and selected source-bound boundary regressions; it does not infer lexical identity.
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
const senseIdsIn = (text) => [...text.matchAll(/`(w\d+-s\d+)`/gu)].map((match) => match[1]);
const auditPath = path.join(root, 'scripts/meaning/issue-764-c17-residual-audit.md');
const audit = readFileSync(auditPath, 'utf8');
const auditRows = audit.split('\n## 후보 검토 후 하나의 Meaning으로 유지한 기존 다중-sense 항목')[0];
const targetSenseIds = new Set([...auditRows.matchAll(/; resolved — ([^;\n]+); compare — /gu)]
  .flatMap(([, evidence]) => senseIdsIn(evidence)));
const expectedEvidenceIds = new Set([...expectedSenseIds, ...targetSenseIds]);
const identityRegressionSenseIds = new Set([
  'w335349-s1', 'w335633-s1', 'w335634-s1', 'w335635-s1', 'w335636-s1',
  'w335637-s1', 'w342818-s1', 'w489651-s1', 'w489652-s1', 'w489653-s1',
  'w343081-s1', 'w343082-s1', 'w343083-s1', 'w495379-s1', 'w496287-s1', 'w496488-s1',
  'w350459-s1', 'w350460-s1', 'w494494-s1', 'w342772-s1', 'w342772-s2',
  'w345843-s1', 'w345844-s1', 'w345845-s1', 'w349212-s1', 'w349742-s1', 'w495184-s1',
  'w497369-s1', 'w497369-s2',
]);
const sourceGlossBySense = new Map();
const identitySourceGlossBySense = new Map();
for (const file of readdirSync(canonicalDir).filter((name) => name.startsWith('stdict-') && name.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(path.join(canonicalDir, file), 'utf8').split('\n')) {
    if (!line) continue;
    const entry = JSON.parse(line);
    for (const sense of entry.senses ?? []) {
      if (expectedEvidenceIds.has(sense.id)) sourceGlossBySense.set(sense.id, sense.gloss);
      if (identityRegressionSenseIds.has(sense.id)) identitySourceGlossBySense.set(sense.id, sense.gloss);
    }
  }
}
const expectedReferenceMeaningCount = [...residualByLemma.values()].flat()
  .filter((row) => row.sense_ids.some((senseId) => sourceGlossBySense.get(senseId)?.includes('→'))).length;

const short = (value, max) => {
  const text = String(value).replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const meaningIdsIn = (text) => [...text.matchAll(/`(m\d+(?:_\d+)?)`/gu)].map((match) => match[1]);

test('C17 residual audit covers every retained Meaning with complete bound-source reasons', () => {
  assert.equal(sourceGlossBySense.size, expectedEvidenceIds.size, 'every bound and referenced target sense must resolve in canonical');
  const expectedLemmas = [...residualByLemma.keys()].sort((a, b) => a.localeCompare(b, 'ko'));
  const headings = [...auditRows.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(headings, expectedLemmas, 'audit must list every and only residual multi-Meaning lemma');
  assert.match(audit, new RegExp(`최종적으로 여러 Meaning을 유지한 ${residualByLemma.size.toLocaleString('en-US')}개 lemma`));

  const seenMeaningIds = [];
  const referencedMeaningIds = [];
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
      const resolvedMarker = '; resolved — ';
      const compareMarker = '; compare — ';
      const conclusionMarker = '; conclusion — ';
      const compareAt = followingLine.indexOf(compareMarker);
      const conclusionAt = followingLine.indexOf(conclusionMarker);
      assert.ok(compareAt > boundMarker.length && conclusionAt > compareAt, `${lemma}/${meaningId}: reason needs bound, compare, and conclusion sections`);
      const resolvedAt = followingLine.indexOf(resolvedMarker);
      const boundEnd = resolvedAt >= 0 ? resolvedAt : compareAt;
      const boundEvidence = followingLine.slice(boundMarker.length, boundEnd);
      const resolvedEvidence = resolvedAt >= 0 ? followingLine.slice(resolvedAt + resolvedMarker.length, compareAt) : '';
      const compareEvidence = followingLine.slice(compareAt + compareMarker.length, conclusionAt);
      const conclusion = followingLine.slice(conclusionAt + conclusionMarker.length).trim();
      assert.ok(conclusion.length > 0, `${lemma}/${meaningId}: row-specific disposition is required`);

      assert.deepEqual(senseIdsIn(boundEvidence), row.sense_ids, `${lemma}/${meaningId}: own bound sources must be complete and ordered`);
      const hasReferenceGloss = row.sense_ids.some((senseId) => sourceGlossBySense.get(senseId).includes('→'));
      if (hasReferenceGloss) {
        referencedMeaningIds.push(meaningId);
        const resolvedSenseIds = senseIdsIn(resolvedEvidence);
        assert.ok(resolvedSenseIds.length > 0, `${lemma}/${meaningId}: reference gloss needs resolved canonical target sense evidence`);
        assert.equal(new Set(resolvedSenseIds).size, resolvedSenseIds.length, `${lemma}/${meaningId}: target senses must not repeat`);
        for (const senseId of resolvedSenseIds) {
          const targetGloss = sourceGlossBySense.get(senseId);
          assert.ok(targetGloss, `${lemma}/${meaningId}: resolved target ${senseId} must exist in canonical`);
          assert.ok(resolvedEvidence.includes(short(targetGloss, 90)), `${lemma}/${meaningId}: resolved target gloss ${senseId}`);
        }
      } else {
        assert.equal(resolvedAt, -1, `${lemma}/${meaningId}: direct source gloss must not have a reference resolution`);
      }
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
  assert.equal(referencedMeaningIds.length, expectedReferenceMeaningCount, 'every reference-bound Meaning must have resolved target evidence');
  assert.deepEqual(seenMeaningIds.sort(), [...residualByLemma.values()].flat().map((row) => row.id).sort(), 'audit/output Meaning ID sets');
});

test('C17 keeps distinct named identities separate while retaining the one-letter positive control', () => {
  const identityCases = [
    { lemma: '태조', groups: [['w335349-s1'], ['w335633-s1'], ['w335634-s1'], ['w335635-s1'], ['w335636-s1'], ['w335637-s1'], ['w342818-s1'], ['w489651-s1'], ['w489652-s1'], ['w489653-s1']] },
    { lemma: '태종', groups: [['w343081-s1'], ['w343082-s1'], ['w343083-s1'], ['w495379-s1'], ['w496287-s1'], ['w496488-s1']] },
    { lemma: '테티스', groups: [['w350459-s1'], ['w350460-s1'], ['w494494-s1']] },
    { lemma: '통고', groups: [['w342772-s1'], ['w342772-s2'], ['w345843-s1'], ['w345844-s1'], ['w345845-s1']] },
    { lemma: '트리톤', groups: [['w349212-s1'], ['w349742-s1'], ['w495184-s1']] },
  ];

  for (const { lemma, groups } of identityCases) {
    const meanings = rowsByLemma.get(lemma) ?? [];
    assert.equal(meanings.length, groups.length, `${lemma}: preserve the source-bound identity groups`);
    assert.deepEqual(meanings.map((row) => row.sense_ids).sort((a, b) => a[0].localeCompare(b[0])),
      groups.map((group) => [...group].sort()).sort((a, b) => a[0].localeCompare(b[0])), `${lemma}: exact source-sense grouping`);
    for (const group of groups) {
      const meaning = meanings.find((row) => row.sense_ids.includes(group[0]));
      assert.ok(meaning, `${lemma}/${group.join(',')}: expected Meaning exists`);
      for (const senseId of group) {
        assert.equal(identitySourceGlossBySense.has(senseId), true, `${lemma}/${senseId}: canonical source gloss exists`);
        assert.ok(meaning.sense_ids.includes(senseId), `${lemma}/${senseId}: source sense remains bound`);
      }
      if (group.length === 1) {
        assert.equal(meaning.gloss, identitySourceGlossBySense.get(group[0]), `${lemma}/${group[0]}: source gloss is reproduced exactly`);
      }
    }
  }

  const letterMeaning = (rowsByLemma.get('ㅌ') ?? []).find((row) => row.sense_ids.includes('w497369-s1'));
  assert.ok(letterMeaning, 'the Hangul letter positive control remains represented');
  assert.deepEqual(letterMeaning.sense_ids, ['w497369-s1', 'w497369-s2'], 'the letter and its sound are one lexical identity');
  assert.equal(identitySourceGlossBySense.has('w497369-s1') && identitySourceGlossBySense.has('w497369-s2'), true, 'positive-control source senses exist');
});
