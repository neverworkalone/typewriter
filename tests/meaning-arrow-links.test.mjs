import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  auditMeaningArrowLinks,
  findMeaningGlossReferences,
  readArrowLinkExceptions,
} from '../scripts/validate/meaning-arrow-links.mjs';
import { readCompletedGlossNumberScopes } from '../scripts/validate/meaning-gloss-numbers.mjs';

const headwordsOf = (gloss) => findMeaningGlossReferences(gloss).map((found) => found.headword);

test('extracts the referenced headword from a source dictionary `→` clue', () => {
  // Issue #797 calibration: the number (`까치발02`), source sense marker (`「1」`) and trailing underscore are clues,
  // never part of the user-facing target.
  assert.deepEqual(headwordsOf('→ 까치발02.'), ['까치발']);
  assert.deepEqual(headwordsOf('→ 꽃봉오리01「1」.'), ['꽃봉오리']);
  assert.deepEqual(headwordsOf('→ 꼭뒤잡이「2」.'), ['꼭뒤잡이']);
  assert.deepEqual(headwordsOf('→ 할머니_.'), ['할머니']);
  assert.deepEqual(headwordsOf('→ 깨다03.'), ['깨다']);
  assert.deepEqual(headwordsOf('배가 조금 쓰리면서 아픈 모양. ‘슬슬’보다 센 느낌을 준다.'), []);
});

test('the scope registry stays machine-readable and its link exceptions are empty or well shaped', () => {
  const registry = readCompletedGlossNumberScopes();
  assert.equal(registry.version, 1);
  assert.ok(registry.completed_scopes.length > 0);
  // The registry is shared by the number check and the arrow link check, so a malformed exception must fail closed.
  assert.doesNotThrow(() => readArrowLinkExceptions());
  for (const exception of readArrowLinkExceptions()) {
    assert.ok(registry.completed_scopes.includes(exception.scope));
  }
});

test('the whole stored corpus is scanned and completed #797 scopes link every `→` reference', () => {
  const { completed_scopes: completedScopes } = readCompletedGlossNumberScopes();
  const audit = auditMeaningArrowLinks({ completedScopes });
  assert.ok(audit.scopeCount >= 19, `expected every 초성 scope, saw ${audit.scopeCount}`);
  assert.deepEqual(audit.errors, []);
  assert.deepEqual(audit.unknownCompletedScopes, []);
  assert.deepEqual(audit.violations, []);
  // The audit is corpus-wide, not an example-only check, and a completed scope is fully linked.
  const completed = new Set(completedScopes);
  assert.ok(audit.occurrences.length > audit.occurrences.filter((item) => completed.has(item.scope)).length);
  assert.ok((audit.byScope.get('c02')?.references ?? 0) > 0);
  assert.equal(audit.byScope.get('c02')?.unlinked ?? 0, 0);
  // Pending scopes keep reporting their backlog instead of being silently skipped.
  for (const scope of audit.pendingScopes) assert.ok((audit.byScope.get(scope)?.unlinked ?? 0) > 0, `${scope} must still have unlinked references`);
  // Number removal must not hide a source distinction. The corpus currently has exactly one collapsed display,
  // the `깨이다` pair the Issue #797 review retracted: both Meanings already resolve to the single target Meaning
  // `깨다` (#764/#772 normalization), so it is reported as tolerated rather than as a lost distinction.
  assert.deepEqual(audit.collapseViolations, []);
  assert.deepEqual(
    audit.collapses.map((collapse) => ({ lemma: collapse.lemma, meaning_ids: collapse.meaning_ids, tolerated: collapse.tolerated })),
    [{ lemma: '깨이다', meaning_ids: ['m53954', 'm53955'], tolerated: true }],
  );
});

test('number removal that collapses distinct source meanings fails a completed scope (old fails / new passes)', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'typewriter-display-collapse-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canonicalDirectory = path.join(root, 'data/canonical');
  const meaningsDirectory = path.join(root, 'data/meanings');
  const adjudicationDirectory = path.join(root, 'data/adjudication');
  for (const directory of [canonicalDirectory, meaningsDirectory, adjudicationDirectory]) mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(canonicalDirectory, 'stdict-0001.jsonl'), [
    // The `뀌다` shape the review blocked: the two source records differ only by the homonym number in the quoted
    // headword, so removing the number alone makes both Meanings display one identical gloss.
    { id: 'w1', lemma: '뀌다', senses: [{ id: 'w1-s1', pos: 'verb', gloss: '‘꾸이다01’의 준말.' }] },
    { id: 'w2', lemma: '뀌다', senses: [{ id: 'w2-s1', pos: 'verb', gloss: '‘꾸이다02’의 준말.' }] },
    // The `깨이다` shape: the two source references differ, but their referenced senses were consolidated into one
    // Meaning, so both Meanings point at the same target.
    { id: 'w3', lemma: '깨이다', senses: [{ id: 'w3-s1', pos: 'verb', gloss: '→ 깨다03.' }] },
    { id: 'w4', lemma: '깨이다', senses: [{ id: 'w4-s1', pos: 'verb', gloss: '→ 깨다05.' }] },
    { id: 'w5', lemma: '깨다', senses: [{ id: 'w5-s1', pos: 'verb', gloss: '잠에서 벗어나게 하다.' }] },
  ].map((row) => `${JSON.stringify(row)}\n`).join(''));
  const store = (...rows) => writeFileSync(
    path.join(meaningsDirectory, 'c02_001.jsonl'),
    rows.map((row) => `${JSON.stringify(row)}\n`).join(''),
  );
  const audit = () => auditMeaningArrowLinks({
    meaningsDirectory, canonicalDirectory, adjudicationDirectory, completedScopes: ['c02'], exceptions: [],
  });
  const link = [{ type: 'direct', target: 'm5', note: '표준국어대사전 참조 표제어' }];

  // Same display, different source meanings, no shared target: the distinction is no longer visible.
  store(
    { id: 'm1', lemma: '뀌다', gloss: '‘꾸이다’의 준말.', sense_ids: ['w1-s1'] },
    { id: 'm2', lemma: '뀌다', gloss: '‘꾸이다’의 준말.', sense_ids: ['w2-s1'] },
  );
  const collapsed = audit();
  assert.deepEqual(collapsed.collapseViolations.map((item) => item.meaning_ids), [['m1', 'm2']]);
  assert.deepEqual(collapsed.violations, []);

  // The same display with one shared target Meaning is the pre-existing normalization case, not a lost distinction.
  store(
    { id: 'm3', lemma: '깨이다', gloss: '→ 깨다.', sense_ids: ['w3-s1'], relations: link },
    { id: 'm4', lemma: '깨이다', gloss: '→ 깨다.', sense_ids: ['w4-s1'], relations: link },
    { id: 'm5', lemma: '깨다', gloss: '잠에서 벗어나게 하다.', sense_ids: ['w5-s1'] },
  );
  const tolerated = audit();
  assert.deepEqual(tolerated.collapseViolations, []);
  assert.deepEqual(tolerated.violations, []);
  assert.deepEqual(tolerated.collapses.map((item) => ({ meaning_ids: item.meaning_ids, tolerated: item.tolerated })), [
    { meaning_ids: ['m3', 'm4'], tolerated: true },
  ]);

  // An authored gloss that is not the source gloss minus its numbers is an editorial rewrite, not a collapse.
  store(
    { id: 'm1', lemma: '뀌다', gloss: '남에게 다음에 받기로 하고 돈이나 물건 따위를 빌려주다. ‘꾸이다’의 준말.', sense_ids: ['w1-s1'] },
    { id: 'm2', lemma: '뀌다', gloss: '꿈이 보이다. ‘꾸이다’의 준말.', sense_ids: ['w2-s1'] },
  );
  assert.deepEqual(audit().collapseViolations, []);
});

test('an unlinked `→` reference fails a completed scope; authoring the relation or an exception passes (old fails / new passes)', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'typewriter-arrow-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canonicalDirectory = path.join(root, 'data/canonical');
  const meaningsDirectory = path.join(root, 'data/meanings');
  const adjudicationDirectory = path.join(root, 'data/adjudication');
  for (const directory of [canonicalDirectory, meaningsDirectory, adjudicationDirectory]) mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(canonicalDirectory, 'stdict-0001.jsonl'), [
    { id: 'w1', lemma: '깨이다', senses: [{ id: 'w1-s1', pos: 'verb', gloss: '→ 깨다03.' }] },
    { id: 'w2', lemma: '깨다', senses: [{ id: 'w2-s1', pos: 'verb', gloss: '잠에서 벗어나게 하다.' }] },
  ].map((row) => `${JSON.stringify(row)}\n`).join(''));
  const store = (...rows) => writeFileSync(
    path.join(meaningsDirectory, 'c02_001.jsonl'),
    rows.map((row) => `${JSON.stringify(row)}\n`).join(''),
  );
  const reference = { id: 'm1', lemma: '깨이다', gloss: '→ 깨다.', sense_ids: ['w1-s1'] };
  const target = { id: 'm2', lemma: '깨다', gloss: '잠에서 벗어나게 하다.', sense_ids: ['w2-s1'] };
  const audit = (exceptions = []) => auditMeaningArrowLinks({
    meaningsDirectory, canonicalDirectory, adjudicationDirectory, completedScopes: ['c02'], exceptions,
  });

  store(reference, target);
  const unlinked = audit();
  assert.equal(unlinked.violations.length, 1);
  assert.equal(unlinked.violations[0].meaning_id, 'm1');
  assert.equal(unlinked.violations[0].reference, '깨다');

  // A relation whose target carries a different lemma does not satisfy the reference.
  store({ ...reference, relations: [{ type: 'direct', target: 'm2', note: 'n' }] }, { ...target, lemma: '깨닫다' });
  assert.equal(audit().violations.length, 1);

  store({ ...reference, relations: [{ type: 'direct', target: 'm2', note: '표준국어대사전 참조 표제어' }] }, target);
  const linked = audit();
  assert.deepEqual(linked.violations, []);
  assert.equal(linked.occurrences.length, 1);
  assert.deepEqual(linked.occurrences[0].targets, ['m2']);

  // A registered exception keeps a genuinely unresolved reference visible without weakening the gate.
  store(reference, target);
  const excepted = audit([{ scope: 'c02', meaning_id: 'm1', reference: '깨다', reason: 'original number resolves to a record with several Meanings and no source clue' }]);
  assert.deepEqual(excepted.violations, []);
});