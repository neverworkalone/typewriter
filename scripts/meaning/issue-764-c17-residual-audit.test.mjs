import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { projectMeaningRelations } from './project.mjs';

// Manual audit-coverage regression. Run directly with:
// node --test scripts/meaning/issue-764-c17-residual-audit.test.mjs
// This checks evidence coverage and selected source-bound boundary regressions; it does not infer lexical identity.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const meaningDir = path.join(root, 'data/meanings');
const canonicalDir = path.join(root, 'data/canonical');
const reviewCases = [
  { lemma: '태즈메이니아', before: [['w343346-s1'], ['w343346-s2']], groups: [['w343346-s1', 'w343346-s2']] },
  { lemma: '탐라', before: [['w345436-s1'], ['w345436-s2']], groups: [['w345436-s1', 'w345436-s2']] },
  { lemma: '터놓다', before: [['w496506-s1'], ['w496506-s2'], ['w496506-s3']], groups: [['w496506-s1', 'w496506-s2', 'w496506-s3']] },
  { lemma: '타살', before: [['w335985-s1', 'w336289-s1'], ['w336289-s2']], groups: [['w335985-s1'], ['w336289-s1', 'w336289-s2']] },
  { lemma: '타상', before: [['w340436-s1'], ['w340437-s1'], ['w497650-s1']], groups: [['w340436-s1'], ['w340437-s1'], ['w497650-s1']] },
  { lemma: '타점', before: [['w345148-s1'], ['w345148-s2'], ['w345149-s1'], ['w497740-s1'], ['w497740-s2']], groups: [['w345148-s1'], ['w345148-s2'], ['w345149-s1'], ['w497740-s1'], ['w497740-s2']] },
  { lemma: '탁발하다', before: [['w342605-s1'], ['w345543-s1'], ['w345545-s1']], groups: [['w342605-s1'], ['w345543-s1'], ['w345545-s1']] },
  { lemma: '탁성', before: [['w343446-s1'], ['w343447-s1']], groups: [['w343446-s1'], ['w343447-s1']] },
  { lemma: '탁탁하다', before: [['w346159-s1'], ['w346159-s2'], ['w346159-s3'], ['w346162-s1'], ['w492779-s1'], ['w492779-s2'], ['w492779-s3']], groups: [['w346159-s1', 'w346159-s2', 'w346159-s3'], ['w346162-s1'], ['w492779-s1', 'w492779-s2', 'w492779-s3']] },
  { lemma: '탈선', before: [['w342133-s1'], ['w493147-s1'], ['w493147-s2'], ['w493147-s3']], groups: [['w342133-s1'], ['w493147-s1', 'w493147-s2', 'w493147-s3']] },
  { lemma: '탈선하다', before: [['w342134-s1'], ['w492562-s1'], ['w492562-s2'], ['w492562-s3']], groups: [['w342134-s1'], ['w492562-s1', 'w492562-s2', 'w492562-s3']] },
  { lemma: '태감', before: [['w338297-s1'], ['w338297-s2'], ['w338300-s1'], ['w496708-s1']], groups: [['w338297-s1'], ['w338297-s2'], ['w338300-s1'], ['w496708-s1']] },
  { lemma: '태반', before: [['w342388-s1'], ['w342389-s1'], ['w342390-s1'], ['w496869-s1']], groups: [['w342388-s1'], ['w342389-s1'], ['w342390-s1'], ['w496869-s1']] },
  { lemma: '택지', before: [['w342560-s1'], ['w342561-s1']], groups: [['w342560-s1'], ['w342561-s1']] },
  { lemma: '토가', before: [['w342756-s1'], ['w342757-s1'], ['w343012-s1']], groups: [['w342756-s1'], ['w342757-s1'], ['w343012-s1']] },
  { lemma: '토향', before: [['w344418-s1'], ['w344419-s1']], groups: [['w344418-s1'], ['w344419-s1']] },
  { lemma: '톳', before: [['w346759-s1'], ['w346982-s1']], groups: [['w346759-s1'], ['w346982-s1']] },
  { lemma: '통발', before: [['w344144-s1'], ['w344145-s1'], ['w492619-s1']], groups: [['w344144-s1'], ['w344145-s1', 'w492619-s1']] },
  { lemma: '통신선', before: [['w349666-s1'], ['w349667-s1']], groups: [['w349666-s1'], ['w349667-s1']] },
  { lemma: '통행권', before: [['w350643-s1'], ['w350643-s2'], ['w350644-s1'], ['w350644-s2']], groups: [['w350643-s1', 'w350643-s2', 'w350644-s1', 'w350644-s2']] },
  { lemma: '투구', before: [['w348609-s1'], ['w348611-s1'], ['w348612-s1'], ['w348612-s2'], ['w348614-s1'], ['w495016-s1']], groups: [['w348609-s1'], ['w348611-s1'], ['w348612-s1'], ['w348612-s2'], ['w348614-s1'], ['w495016-s1']] },
  { lemma: '투전', before: [['w350021-s1'], ['w350261-s1'], ['w350263-s1']], groups: [['w350021-s1'], ['w350261-s1'], ['w350263-s1']] },
  { lemma: '티', before: [['w353023-s1'], ['w353023-s2'], ['w353026-s1'], ['w353027-s1'], ['w495437-s1'], ['w495437-s2'], ['w495451-s1'], ['w515511-s1']], groups: [['w353023-s1', 'w353023-s2'], ['w353026-s1'], ['w353027-s1'], ['w495437-s1', 'w495437-s2'], ['w495451-s1'], ['w515511-s1']] },
];
const reviewSenseIds = new Set(reviewCases.flatMap(({ groups }) => groups.flat()));
const projectionProbeSenseIds = new Set([
  'w335985-s1', 'w340436-s1', 'w342605-s1', 'w343447-s1', 'w342388-s1', 'w346982-s1',
  'w350643-s1', 'w350644-s1', 'w348611-s1', 'w495016-s1', 'w350261-s1', 'w515511-s1', 'w344145-s1', 'w492619-s1',
]);
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
  'w497369-s1', 'w497369-s2', 'w343346-s1', 'w343346-s2', 'w345436-s1', 'w345436-s2',
  'w496506-s1', 'w496506-s2', 'w496506-s3', 'w497715-s1', 'w296689-s1', 'w347855-s1', 'w347855-s9',
  'w353163-s1', 'w353164-s1',
  ...reviewSenseIds,
]);
const meaningIdBySense = new Map(rows.flatMap((row) => row.sense_ids.map((senseId) => [senseId, row.id])));
let sameRecordSplitRecordCount = 0;
const sameRecordSplitLemmas = new Set();
const sourceGlossBySense = new Map();
const identitySourceGlossBySense = new Map();
let tamnaSourceRecord = null;
const projectionSourceRecords = new Map();
const projectionTargetSenseIds = new Set();
for (const file of readdirSync(canonicalDir).filter((name) => name.startsWith('stdict-') && name.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(path.join(canonicalDir, file), 'utf8').split('\n')) {
    if (!line) continue;
    const entry = JSON.parse(line);
    if (entry.id === 'w345436') tamnaSourceRecord = entry;
    if ((entry.senses ?? []).some((sense) => projectionProbeSenseIds.has(sense.id))) {
      projectionSourceRecords.set(entry.id, entry);
      for (const sense of entry.senses ?? []) {
        if (!projectionProbeSenseIds.has(sense.id)) continue;
        for (const relation of sense.relations ?? []) if (relation.target_sense) projectionTargetSenseIds.add(relation.target_sense);
      }
    }
    const splitMeaningIds = new Set((entry.senses ?? []).map((sense) => meaningIdBySense.get(sense.id)).filter(Boolean));
    if (splitMeaningIds.size > 1) {
      sameRecordSplitRecordCount += 1;
      sameRecordSplitLemmas.add(entry.lemma);
    }
    for (const sense of entry.senses ?? []) {
      if (expectedEvidenceIds.has(sense.id)) sourceGlossBySense.set(sense.id, sense.gloss);
      if (identityRegressionSenseIds.has(sense.id)) identitySourceGlossBySense.set(sense.id, sense.gloss);
    }
  }
}
const projectionTargetRows = new Map();
for (const file of readdirSync(meaningDir).filter((name) => /\.jsonl$/u.test(name)).sort()) {
  for (const line of readFileSync(path.join(meaningDir, file), 'utf8').split('\n')) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (row.sense_ids.some((senseId) => projectionTargetSenseIds.has(senseId))) projectionTargetRows.set(row.id, row);
  }
}
const projectionMeanings = [...rows, ...[...projectionTargetRows.values()].filter((row) => !rows.some((c17Row) => c17Row.id === row.id))];
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

test('C17 applies naming-principle and distinct-identity boundaries with a one-letter positive control', () => {
  const identityCases = [
    { lemma: '태조', groups: [['w335349-s1', 'w335633-s1', 'w335634-s1', 'w335635-s1', 'w335636-s1', 'w335637-s1', 'w342818-s1', 'w489651-s1', 'w489652-s1', 'w489653-s1']] },
    { lemma: '태종', groups: [['w343081-s1', 'w343082-s1', 'w495379-s1', 'w496287-s1', 'w496488-s1'], ['w343083-s1']] },
    { lemma: '테티스', groups: [['w350459-s1'], ['w350460-s1'], ['w494494-s1']] },
    { lemma: '통고', groups: [['w342772-s1'], ['w342772-s2'], ['w345843-s1'], ['w345844-s1'], ['w345845-s1']] },
    { lemma: '트리톤', groups: [['w349212-s1'], ['w349742-s1'], ['w495184-s1']] },
    { lemma: '티보', groups: [['w353163-s1'], ['w353164-s1']] },
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
      } else {
        assert.equal(meaning.gloss, group.map((senseId) => identitySourceGlossBySense.get(senseId)).join(' '), `${lemma}/${group.join(',')}: all source glosses are preserved in the shared Meaning`);
      }
    }
  }

  const letterMeaning = (rowsByLemma.get('ㅌ') ?? []).find((row) => row.sense_ids.includes('w497369-s1'));
  assert.ok(letterMeaning, 'the Hangul letter positive control remains represented');
  assert.deepEqual(letterMeaning.sense_ids, ['w497369-s1', 'w497369-s2'], 'the letter and its sound are one lexical identity');
  assert.equal(identitySourceGlossBySense.has('w497369-s1') && identitySourceGlossBySense.has('w497369-s2'), true, 'positive-control source senses exist');

  const spec = JSON.parse(readFileSync(path.join(root, 'scripts/meaning/issue-764-c17.json'), 'utf8'));
  for (const { lemma, before, groups } of reviewCases) {
    const edit = spec.repartitions.find((item) => item.lemma === lemma);
    assert.ok(edit, `${lemma}: the source-bound boundary must replay from the execution spec`);
    assert.deepEqual(edit.before.map((row) => row.sense_ids), before, `${lemma}: record the old split for the regression`);
    assert.deepEqual(edit.groups.map((row) => row.senses), groups, `${lemma}: the revised spec has the expected source-bound groups`);
    const result = rowsByLemma.get(lemma) ?? [];
    assert.deepEqual(result.map((row) => row.sense_ids), groups, `${lemma}: final projection has the reviewed groups`);
    for (const [index, group] of groups.entries()) {
      assert.equal(result[index].gloss, edit.groups[index].gloss, `${lemma}: emitted gloss matches the recorded execution edit`);
      for (const senseId of group) assert.ok(identitySourceGlossBySense.has(senseId), `${lemma}/${senseId}: canonical source exists`);
    }
  }

  const through = (rowsByLemma.get('통하다') ?? []).find((row) => row.sense_ids.includes('w347855-s1'));
  assert.ok(through?.sense_ids.includes('w347855-s9'), 'the physical-through / communication positive control stays in one Meaning');
  const tamnaMeaning = (rowsByLemma.get('탐라') ?? []).find((row) => row.sense_ids.includes('w345436-s1'));
  const tamnaCountryMeaning = (rowsByLemma.get('탐라국') ?? []).find((row) => row.sense_ids.includes('w497715-s1'));
  assert.ok(tamnaSourceRecord && tamnaMeaning && tamnaCountryMeaning, 'the bound Tamna relation endpoints exist');
  assert.equal(identitySourceGlossBySense.get('w345436-s2'), '‘제주도01’의 옛 이름.', 'the canonical reference gloss stays source-bound');
  assert.ok(tamnaMeaning.gloss.includes(identitySourceGlossBySense.get('w296689-s1')), 'the merged gloss preserves the canonical reference target gloss');
  const projection = projectMeaningRelations({
    records: [tamnaSourceRecord],
    meanings: [tamnaMeaning, tamnaCountryMeaning],
  });
  assert.deepEqual(projection.relations.map((relation) => [relation.source_meaning_id, relation.target_meaning_id, relation.type]), [
    [tamnaMeaning.id, tamnaCountryMeaning.id, 'direct'],
  ], 'the canonical Tamna synonym relation still projects after regrouping');
  assert.deepEqual(projection.relations[0].sources, [{
    source_sense_id: 'w345436-s1', source_position: 0, source_redirected: 0, target_redirected: 0,
  }], 'the projected relation retains its canonical source-sense provenance');

  const relationCases = [
    { lemma: '타살', source: 'w335985-s1', other: 'w336289-s1', target: 'w38107-s1' },
    { lemma: '타상', source: 'w340436-s1', other: 'w497650-s1', target: 'w494681-s1' },
    { lemma: '탁발하다', source: 'w342605-s1', other: 'w345545-s1', target: 'w141693-s1' },
    { lemma: '탁성', source: 'w343447-s1', other: 'w343446-s1', target: 'w288209-s1' },
    { lemma: '태반', source: 'w342388-s1', other: 'w342389-s1', target: 'w80394-s1' },
    { lemma: '톳', source: 'w346982-s1', other: 'w346759-s1', target: 'w67215-s1' },
    { lemma: '투구', source: 'w348611-s1', other: 'w495016-s1', target: 'w91494-s1' },
    { lemma: '투구', source: 'w495016-s1', other: 'w348611-s1', target: 'w349836-s1' },
    { lemma: '투전', source: 'w350261-s1', other: 'w350263-s1', target: 'w413289-s1' },
    { lemma: '티', source: 'w515511-s1', other: 'w353026-s1', target: 'w353719-s1' },
  ];
  for (const { lemma, source, other, target } of relationCases) {
    const sourceMeaningId = meaningIdBySense.get(source);
    const otherMeaningId = meaningIdBySense.get(other);
    const targetMeaningId = [...projectionTargetRows.values()].find((row) => row.sense_ids.includes(target))?.id
      ?? meaningIdBySense.get(target);
    const sourceRecord = projectionSourceRecords.get(source.split('-')[0]);
    assert.ok(sourceMeaningId && otherMeaningId && targetMeaningId && sourceRecord, `${lemma}: relation probe endpoints are present`);
    assert.notEqual(sourceMeaningId, otherMeaningId, `${lemma}: relation-bearing source is separate from the unlike competing sense`);
    const result = projectMeaningRelations({ records: [sourceRecord], meanings: projectionMeanings });
    const matching = result.relations.filter((relation) => relation.type === 'direct'
      && relation.source_meaning_id === sourceMeaningId && relation.target_meaning_id === targetMeaningId
      && relation.sources.some((item) => item.source_sense_id === source));
    assert.equal(matching.length, 1, `${lemma}/${source}: source-bound direct relation remains projected`);
    assert.equal(matching[0].sources[0].source_sense_id, source, `${lemma}/${source}: projection provenance stays on its canonical sense`);
    assert.ok(!result.relations.some((relation) => relation.source_meaning_id === otherMeaningId
      && relation.target_meaning_id === targetMeaningId), `${lemma}/${other}: unrelated meaning does not inherit the source relation`);
  }

  for (const { lemma, source, coGrouped, target } of [
    { lemma: '통발', source: 'w344145-s1', coGrouped: 'w492619-s1', target: 'w228082-s1' },
    { lemma: '통행권', source: 'w350643-s1', coGrouped: 'w350644-s1', target: 'w350651-s1' },
  ]) {
    const sourceMeaningId = meaningIdBySense.get(source);
    const coGroupedMeaningId = meaningIdBySense.get(coGrouped);
    const targetMeaningId = [...projectionTargetRows.values()].find((row) => row.sense_ids.includes(target))?.id
      ?? meaningIdBySense.get(target);
    const sourceRecord = projectionSourceRecords.get(source.split('-')[0]);
    const coGroupedRecord = projectionSourceRecords.get(coGrouped.split('-')[0]);
    assert.ok(sourceMeaningId && coGroupedMeaningId && targetMeaningId && sourceRecord && coGroupedRecord,
      `${lemma}: merged relation endpoints are present`);
    assert.equal(sourceMeaningId, coGroupedMeaningId, `${lemma}: the naturally extended senses share one Meaning`);
    const result = projectMeaningRelations({ records: [sourceRecord, coGroupedRecord], meanings: projectionMeanings });
    const matching = result.relations.filter((relation) => relation.type === 'direct'
      && relation.source_meaning_id === sourceMeaningId && relation.target_meaning_id === targetMeaningId);
    assert.equal(matching.length, 1, `${lemma}/${source}: canonical direct relation still projects after merging`);
    assert.deepEqual(matching[0].sources.map((item) => item.source_sense_id), [source],
      `${lemma}/${source}: the direct relation keeps only its original canonical sense provenance`);
  }
});

test('C17 tracks the same-record split risk cohort after source-bound corrections', () => {
  // The pre-follow-up baseline had 332 split records across 316 lemmas; this is a candidate count, not an error count.
  assert.equal(sameRecordSplitRecordCount, 330);
  assert.equal(sameRecordSplitLemmas.size, 313);
  for (const senseId of ['w343346-s1', 'w345436-s1', 'w496506-s1', 'w345148-s1', 'w345148-s2']) {
    assert.ok(meaningIdBySense.has(senseId), `${senseId}: reviewed same-record source sense remains in C17`);
  }
});
